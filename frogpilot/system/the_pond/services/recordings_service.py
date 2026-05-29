#!/usr/bin/env python3
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

from openpilot.frogpilot.common.frogpilot_utilities import delete_file
from openpilot.frogpilot.common.frogpilot_variables import SCREEN_RECORDINGS_PATH, params_memory
from openpilot.frogpilot.system.the_pond.config import GIF_EXTENSION, THUMBNAIL_EXTENSION, VIDEO_EXTENSION
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.ffmpeg import generate_preview_gif, generate_thumbnail
from openpilot.frogpilot.system.the_pond.lib.paths import safe_join, safe_name
from openpilot.frogpilot.system.the_pond.lib.sse import sse_message

# The local timestamp the screen recorder names its files with; anything that does not parse back was
# renamed by the user, so the UI shows it verbatim instead of reformatting it (REWRITE_PLAN §4.2).
TIMESTAMP_NAME_FORMAT = "%B_%d_%Y-%I-%M%p"


@dataclass(frozen=True)
class Recording:
  created_at: float
  is_custom_name: bool
  name: str
  size_bytes: int


def asset_path(filename):
  target = safe_join(recordings_dir(), filename)

  # The hover gif is the one preview built lazily: it is generated on first request rather than for
  # every recording up front, keeping the heavy ffmpeg work off the listing path (REWRITE_PLAN §7.5).
  if target.suffix == GIF_EXTENSION and not target.is_file():
    return ensure_preview_gif(target.stem)

  if not target.is_file():
    raise ApiError("File not found", 404)

  return target


def build_recording(video_path):
  return Recording(
    created_at=video_path.stat().st_mtime,
    is_custom_name=is_custom_name(video_path.stem),
    name=video_path.stem,
    size_bytes=video_path.stat().st_size,
  )


def delete(name):
  remove_recording_files(recording_video(name))


def delete_all():
  for video_path in recordings_dir().glob(f"*{VIDEO_EXTENSION}"):
    remove_recording_files(video_path)


def ensure_preview_gif(name):
  video_path = recording_video(name)

  gif_path = video_path.with_suffix(GIF_EXTENSION)
  if not gif_path.is_file():
    generate_preview_gif(video_path, gif_path)

  if not gif_path.is_file():
    raise ApiError("Could not build preview", 500)

  return gif_path


def ensure_thumbnail(video_path):
  thumbnail_path = video_path.with_suffix(THUMBNAIL_EXTENSION)
  if not thumbnail_path.is_file():
    generate_thumbnail(video_path, thumbnail_path)


def is_custom_name(name):
  try:
    datetime.strptime(name, TIMESTAMP_NAME_FORMAT)
    return False
  except ValueError:
    return True


def list_recordings_stream():
  videos = sorted(recordings_dir().glob(f"*{VIDEO_EXTENSION}"), key=lambda path: path.stat().st_mtime, reverse=True)

  yield sse_message({"event": "start", "total": len(videos)})

  # Stream one recording at a time, building its still thumbnail only if missing. Generating serially
  # and yielding after each keeps CPU off a spike on the shared SoC, and a client that navigates away
  # closes the generator at the next yield so no further frames are produced (REWRITE_PLAN §7.4, §7.5).
  recordings = []
  for video_path in videos:
    try:
      recording = build_recording(video_path)
    except OSError as error:
      print(f"Skipping unreadable recording {video_path.name}: {error}")
      continue

    ensure_thumbnail(video_path)

    recordings.append(recording)
    yield sse_message({"event": "recording", "recording": asdict(recording)})

  params_memory.put("ScreenRecordingCount", str(len(recordings)))

  yield sse_message({"event": "done", "count": len(recordings)})


def recording_video(name):
  video_path = safe_join(recordings_dir(), f"{name}{VIDEO_EXTENSION}")
  if not video_path.is_file():
    raise ApiError("Recording not found", 404)

  return video_path


def recordings_dir():
  directory = Path(SCREEN_RECORDINGS_PATH)
  directory.mkdir(parents=True, exist_ok=True)
  return directory


def remove_recording_files(video_path):
  for extension in (GIF_EXTENSION, THUMBNAIL_EXTENSION, VIDEO_EXTENSION):
    sibling = video_path.with_suffix(extension)
    if sibling.is_file():
      delete_file(str(sibling))


def rename(old_name, new_name):
  source = recording_video(old_name)

  target_stem = safe_name(new_name)
  if (source.parent / f"{target_stem}{VIDEO_EXTENSION}").exists():
    raise ApiError("A recording with that name already exists", 409)

  for extension in (GIF_EXTENSION, THUMBNAIL_EXTENSION, VIDEO_EXTENSION):
    sibling = source.with_suffix(extension)
    if sibling.is_file():
      sibling.rename(source.parent / f"{target_stem}{extension}")
