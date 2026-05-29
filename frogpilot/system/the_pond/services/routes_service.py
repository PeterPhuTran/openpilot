#!/usr/bin/env python3
import hashlib
import os
import re
import subprocess

from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

from openpilot.system.hardware.hw import Paths
from openpilot.system.loggerd.deleter import PRESERVE_ATTR_NAME, PRESERVE_ATTR_VALUE
from openpilot.system.loggerd.uploader import listdir_by_creation
from openpilot.tools.lib.route import SegmentName

from openpilot.frogpilot.common.frogpilot_utilities import delete_file
from openpilot.frogpilot.common.frogpilot_variables import HD_LOGS_PATH, KONIK_LOGS_PATH
from openpilot.frogpilot.system.the_pond.config import CAMERA_FILES, GIF_EXTENSION, THUMBNAIL_EXTENSION
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.ffmpeg import available_cameras, generate_preview_gif, generate_thumbnail, probe_duration, run_ffmpeg
from openpilot.frogpilot.system.the_pond.lib.paths import safe_join
from openpilot.frogpilot.system.the_pond.lib.sse import sse_message
from openpilot.frogpilot.system.the_pond.lib.video_cache import VideoCache

# A segment directory is named "<route>--<segment>", e.g. "0000a1b2--c3d4e5f6a7--0"; the route id the
# API speaks is the leading "<8hex>--<10hex>" timestamp shared by every segment of one drive
# (utilities.py SEGMENT_RE). Anything that does not match is not a route segment and is skipped.
SEGMENT_RE = re.compile(r"^[0-9a-fA-F]{8}--[0-9a-fA-F]{10}--\d+$")

# The fake 16-char dongle id the footage was always parsed under, so SegmentName can split a bare
# on-disk segment name into its route + segment parts (utilities.py:612-614). The footage never carries
# a real dongle id, so this is the canonical placeholder the rest of the Pond and the on-device tools
# agree on; keep it byte-for-byte.
SEGMENT_DONGLE_ID = "FakeDongleID1337"

# The low-res preview track each segment records alongside the per-camera hevc files; the still frame
# and the hover gif are derived from it because it is small and already h264, keeping the listing's
# ffmpeg work light (REWRITE_PLAN §12.3).
PREVIEW_SOURCE = "qcamera.ts"
PREVIEW_GIF_NAME = f"preview{GIF_EXTENSION}"
PREVIEW_PNG_NAME = f"preview{THUMBNAIL_EXTENSION}"

# The default camera a segment plays back as when the client does not pick one; matches the old
# overlay, which opened on the forward road camera.
DEFAULT_CAMERA = "forward"

# A full-route concat re-encode (the libx264 fallback) over many segments is the one ffmpeg job that
# can legitimately outrun lib/ffmpeg's single-clip ceiling, so the route transcodes pass their own,
# larger timeout (lib/ffmpeg.run_ffmpeg accepts it). It still bounds the spawn so a stuck encode can
# never wedge a worker thread forever on the shared SoC (CONVENTIONS §6, REWRITE_PLAN §12.3).
ROUTE_FFMPEG_TIMEOUT_SECONDS = 600

# When a segment's rlog cannot be probed for a real duration, fall back to the nominal one-minute
# segment length rather than zero, so a route's total time stays sane (utilities.py:515-523).
DEFAULT_SEGMENT_DURATION = 60.0

# A segment that is still being written holds this lock file; wrapping it would race the recorder, so
# the video routes reject it as not-yet-playable (utilities.py:389-391).
RECORDING_LOCK_NAME = "rlog.lock"

# Files inside a segment dir that are media or logs; the route's custom name is stored as the one
# sentinel file that is neither (REWRITE_PLAN §4.3, utilities.py:552-557). Reproduced exactly so the
# on-device UI and other tools keep reading the same scheme.
# ".mp4" is included so the transient preview.<uuid>.spedup.mp4 the lazy hover-gif build writes into a
# segment dir is treated as media, never mistaken for the route's custom-name sentinel under threaded=True.
MEDIA_SUFFIXES = (".gif", ".hevc", ".mp4", ".png", ".ts")
LOG_NAMES = frozenset({"qlog", "qlog.bz2", "raw_log.bz2", "rlog", "rlog.bz2"})


@dataclass(frozen=True)
class Route:
  date: str | None
  gif: str
  is_preserved: bool
  name: str
  png: str


def asset_path(filename):
  # Serves a route's preview still or hover gif from one of its segment dirs. The still is normally built
  # during the listing stream, but it is rebuilt here too if missing so a direct request still resolves;
  # the gif is the one preview that is ONLY built lazily — on first hover rather than during the listing
  # stream, keeping the heavy second ffmpeg pass off the hot path (REWRITE_PLAN §7.5, §12.3).
  segment_dir, file_name = locate_segment_asset(filename)

  if file_name == PREVIEW_GIF_NAME and not (segment_dir / PREVIEW_GIF_NAME).is_file():
    return ensure_preview_gif(segment_dir)

  if file_name == PREVIEW_PNG_NAME and not (segment_dir / PREVIEW_PNG_NAME).is_file():
    ensure_preview_png(segment_dir)

  target = safe_join(segment_dir, file_name)
  if not target.is_file():
    raise ApiError("File not found", 404)

  return target


def clear_name(name):
  # Remove the sentinel custom-name file from the route's first segment so the route falls back to its
  # recorded timestamp again (REWRITE_PLAN §4.3).
  segment_dir = first_segment_dir(name)

  sentinel = sentinel_name(segment_dir)
  if sentinel is not None:
    delete_file(str(segment_dir / sentinel))

  return route_date(segment_dir)


def combined_video(name, camera):
  # Concatenate every segment of one camera into a single mp4 backing full-route playback and download.
  # Cached by a name+camera hash; a longer ffmpeg timeout is passed because a multi-segment concat is
  # the one job that can legitimately outlast the single-clip ceiling (REWRITE_PLAN §12.3).
  camera_file = camera_file_for(camera)
  segment_dirs = route_segment_dirs(name)

  sources = [segment_dir / camera_file for segment_dir in segment_dirs if (segment_dir / camera_file).is_file()]
  if not sources:
    raise ApiError("No footage for that camera", 404)

  for source in sources:
    reject_unplayable(source)

  cache = VideoCache()
  key = hashlib.md5(f"{name}|{camera}".encode()).hexdigest()
  newest_mtime = max(source.stat().st_mtime for source in sources)

  if not cache.is_fresh(key, newest_mtime):
    transcode_concat(cache, key, sources)

  return cache.path_for(key)


def delete(name):
  for segment_dir in route_segment_dirs(name):
    delete_file(str(segment_dir))


def delete_all():
  for segment_dir in all_segment_dirs():
    delete_file(str(segment_dir))


def ensure_preview_gif(segment_dir):
  gif_path = segment_dir / PREVIEW_GIF_NAME
  if not gif_path.is_file():
    generate_preview_gif(segment_dir / PREVIEW_SOURCE, gif_path)

  if not gif_path.is_file():
    raise ApiError("Could not build preview", 500)

  return gif_path


def ensure_preview_png(segment_dir):
  png_path = segment_dir / PREVIEW_PNG_NAME
  if not png_path.is_file():
    generate_thumbnail(segment_dir / PREVIEW_SOURCE, png_path)


def get_route(name):
  segment_dirs = route_segment_dirs(name)

  segment_urls = [f"/video/{segment_dir.name}" for segment_dir in segment_dirs]
  total_duration = sum(segment_duration(segment_dir) for segment_dir in segment_dirs)

  return {
    "available_cameras": available_cameras(segment_dirs[0]),
    "date": route_date(segment_dirs[0]),
    "name": name,
    "segment_urls": segment_urls,
    "total_duration": round(total_duration, 1),
  }


def list_routes_stream():
  routes_by_name = grouped_segments()

  yield sse_message({"event": "start", "total": len(routes_by_name)})

  # Build each route's still and read its preserve flag one at a time, doing the work before the yield
  # so a client that navigates away closes the generator at the next yield and no further ffmpeg runs
  # (CONVENTIONS §6, REWRITE_PLAN §7.5). The hover gif stays lazy (built on first request).
  count = 0
  for name in sorted(routes_by_name, reverse=True):
    segment_dirs = routes_by_name[name]

    try:
      route = build_route(name, segment_dirs[0])
    except OSError as error:
      print(f"Skipping unreadable route {name}: {error}")
      continue

    count += 1
    yield sse_message({"event": "route", "route": asdict(route)})

  yield sse_message({"event": "done", "count": count})


def preserve(name):
  segment_dir = first_segment_dir(name)
  try:
    os.setxattr(str(segment_dir), PRESERVE_ATTR_NAME, PRESERVE_ATTR_VALUE)
  except OSError as error:
    raise ApiError("Could not preserve route", 500) from error


def sanitize_route_name(new_name):
  # Keep the label intact (spaces + ordinary punctuation) and only guard the filesystem: turn path
  # separators into spaces and drop surrounding whitespace/dots so the sentinel stays a single,
  # non-traversing segment. safe_join enforces containment when it is written, so this never escapes the
  # segment dir. REWRITE_PLAN §4.3: do NOT mangle beyond path-safety (secure_filename would collapse the
  # spaces the on-device readers preserve).
  cleaned = (new_name or "").replace("/", " ").replace("\\", " ").strip().strip(".").strip()
  if not cleaned:
    raise ApiError("Invalid route name", 400)

  return cleaned


def rename(name, new_name):
  # The route's custom name is a sentinel filename inside its first segment dir: a single file that is
  # neither media nor log (REWRITE_PLAN §4.3).
  segment_dir = first_segment_dir(name)
  sentinel = sanitize_route_name(new_name)

  existing = sentinel_name(segment_dir)
  if existing is not None:
    delete_file(str(segment_dir / existing))

  safe_join(segment_dir, sentinel).touch()

  return route_date(segment_dir)


def thumbnail_path(filename):
  segment_dir, file_name = locate_segment_asset(filename)
  if file_name not in (PREVIEW_GIF_NAME, PREVIEW_PNG_NAME):
    raise ApiError("Invalid path", 400)

  return asset_path(filename)


def unpreserve(name):
  segment_dir = first_segment_dir(name)
  try:
    os.removexattr(str(segment_dir), PRESERVE_ATTR_NAME)
  except FileNotFoundError:
    # The attribute was never set; the route is already not preserved, so there is nothing to clear.
    pass
  except OSError as error:
    raise ApiError("Could not update preserved state", 500) from error


def wrapped_video(path, camera):
  # Wrap one segment's hevc into a fragmented mp4 (faststart, libx264 fallback) and serve it Range-aware
  # from the cache, keyed by md5 of the source path. The blueprint streams it with send_file, so a large
  # clip is never read whole into memory the way the old handler did (REWRITE_PLAN §3.2, §12.3).
  camera_file = camera_file_for(camera)
  segment_dir = segment_dir_for_path(path)
  source = segment_dir / camera_file
  if not source.is_file():
    raise ApiError("Footage not found", 404)

  reject_unplayable(source)

  cache = VideoCache()
  key = hashlib.md5(str(source).encode()).hexdigest()

  if not cache.is_fresh(key, source.stat().st_mtime):
    transcode_wrap(cache, key, source)

  return cache.path_for(key)


def all_segment_dirs():
  for footage_dir in footage_dirs():
    for entry in listdir_by_creation(str(footage_dir)):
      if SEGMENT_RE.fullmatch(entry):
        yield footage_dir / entry


def build_route(name, segment_dir):
  # Build the still up front (the mid-frame ffmpeg pass) so the grid card has a thumbnail the moment the
  # route streams in; the hover gif stays lazy. Running it here, before the stream yields, keeps the work
  # serial and lets a client disconnect stop it at the next yield (REWRITE_PLAN §7.5, §12.3).
  ensure_preview_png(segment_dir)

  return Route(
    date=route_date(segment_dir),
    gif=f"/thumbnails/{segment_dir.name}/{PREVIEW_GIF_NAME}",
    is_preserved=is_preserved(segment_dir),
    name=name,
    png=f"/thumbnails/{segment_dir.name}/{PREVIEW_PNG_NAME}",
  )


def camera_file_for(camera):
  camera_file = CAMERA_FILES.get(camera or DEFAULT_CAMERA)
  if camera_file is None:
    raise ApiError("Unknown camera", 400)

  return camera_file


def first_segment_dir(name):
  return route_segment_dirs(name)[0]


def footage_dirs():
  return [Path(Paths.log_root()), HD_LOGS_PATH, KONIK_LOGS_PATH]


def grouped_segments():
  routes = {}
  for segment_dir in all_segment_dirs():
    routes.setdefault(route_name_of(segment_dir.name), []).append(segment_dir)

  for segment_dirs in routes.values():
    segment_dirs.sort(key=lambda segment_dir: segment_num_of(segment_dir.name))

  return routes


def is_preserved(segment_dir):
  try:
    return PRESERVE_ATTR_NAME in os.listxattr(str(segment_dir)) and os.getxattr(str(segment_dir), PRESERVE_ATTR_NAME) == PRESERVE_ATTR_VALUE
  except OSError:
    return False


def locate_segment_asset(filename):
  # filename is "<segment-dir>/<asset>", e.g. "0000a1b2--c3d4e5f6a7--0/preview.png"; resolve it to the
  # segment dir under one of the footage roots and reject anything that escapes (REWRITE_PLAN §3.3).
  parts = Path(filename).parts
  if len(parts) != 2 or not SEGMENT_RE.fullmatch(parts[0]):
    raise ApiError("Invalid path", 400)

  segment_name, file_name = parts
  segment_dir = existing_segment_dir(segment_name)

  return segment_dir, file_name


def existing_segment_dir(segment_name):
  for footage_dir in footage_dirs():
    candidate = safe_join(footage_dir, segment_name)
    if candidate.is_dir():
      return candidate

  raise ApiError("Segment not found", 404)


def reject_unplayable(source):
  if source.stat().st_size == 0:
    raise ApiError("Footage is empty", 422)

  if (source.parent / RECORDING_LOCK_NAME).exists():
    raise ApiError("Footage is still being recorded", 409)


def route_date(segment_dir):
  # Prefer the user's custom name (the sentinel file); otherwise the recorded start time, taken from the
  # segment's rlog creation time as an ISO timestamp the client formats (utilities.py:552-562).
  sentinel = sentinel_name(segment_dir)
  if sentinel is not None:
    return sentinel

  rlog_path = segment_dir / "rlog"
  if rlog_path.exists():
    return datetime.fromtimestamp(rlog_path.stat().st_ctime).isoformat()

  return None


def route_name_of(segment_name):
  return segment_name_for(segment_name).route_name.time_str


def route_segment_dirs(name):
  segment_dirs = grouped_segments().get(name)
  if not segment_dirs:
    raise ApiError("Route not found", 404)

  return segment_dirs


def segment_dir_for_path(path):
  parts = Path(path).parts
  if len(parts) != 1 or not SEGMENT_RE.fullmatch(parts[0]):
    raise ApiError("Invalid path", 400)

  return existing_segment_dir(parts[0])


def segment_duration(segment_dir):
  # Probe the small low-res preview track for the segment's real length; an unreadable or missing one
  # falls back to the nominal segment length so a route's total time stays sane (REWRITE_PLAN §12.3).
  duration = probe_duration(segment_dir / PREVIEW_SOURCE)
  return duration if duration > 0 else DEFAULT_SEGMENT_DURATION


def segment_name_for(segment_name):
  return SegmentName(f"{SEGMENT_DONGLE_ID}|{segment_name}")


def segment_num_of(segment_name):
  return segment_name_for(segment_name).segment_num


def sentinel_name(segment_dir):
  if not segment_dir.is_dir():
    return None

  for entry in os.listdir(segment_dir):
    if not entry.endswith(MEDIA_SUFFIXES) and entry not in LOG_NAMES:
      return entry

  return None


def transcode_concat(cache, key, sources):
  cache.make_room(sum(source.stat().st_size for source in sources))

  cache_path = cache.path_for(key)
  list_path = cache_path.with_suffix(".txt")
  list_path.write_text("".join(f"file '{source}'\n" for source in sources))

  try:
    concat_args = ["-f", "concat", "-safe", "0", "-i", str(list_path)]
    transcode(cache_path, [*concat_args, "-c", "copy", "-movflags", "faststart"], [*concat_args, "-c:v", "libx264", "-movflags", "faststart"])
  finally:
    list_path.unlink(missing_ok=True)


def transcode_wrap(cache, key, source):
  cache.make_room(source.stat().st_size)

  cache_path = cache.path_for(key)
  input_args = ["-i", str(source)]
  transcode(cache_path, [*input_args, "-c", "copy", "-movflags", "faststart"], [*input_args, "-c:v", "libx264", "-movflags", "faststart"])


def transcode(cache_path, copy_args, encode_args):
  # Try the cheap stream copy first; on failure re-encode with libx264. A longer timeout covers a
  # full-route concat, the one job that can outlast the single-clip ceiling (REWRITE_PLAN §12.3). A
  # partial output from the failed copy is removed so the fallback starts clean.
  try:
    run_ffmpeg([*copy_args, str(cache_path)], timeout=ROUTE_FFMPEG_TIMEOUT_SECONDS)
  except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
    cache_path.unlink(missing_ok=True)
    try:
      run_ffmpeg([*encode_args, str(cache_path)], timeout=ROUTE_FFMPEG_TIMEOUT_SECONDS)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
      cache_path.unlink(missing_ok=True)
      raise ApiError("Could not process video", 500) from error
