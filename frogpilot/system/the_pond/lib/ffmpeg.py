#!/usr/bin/env python3
import subprocess

from pathlib import Path
from uuid import uuid4

import openpilot.system.sentry as sentry

from openpilot.frogpilot.system.the_pond.config import CAMERA_FILES, PREVIEW_GIF_SPEEDUP

# Ceilings, not expected durations: they bound a spawn so a stuck or zombie ffmpeg/ffprobe can never
# hold a worker thread forever on the shared SoC (CONVENTIONS §6). On expiry subprocess kills the child
# and raises TimeoutExpired. A probe is near-instant, so 30s only trips on a huge/corrupt file; a
# single-clip encode/gif fits well inside 120s, and a longer job (full-route concat) passes its own.
FFMPEG_TIMEOUT_SECONDS = 120
FFPROBE_TIMEOUT_SECONDS = 30


def available_cameras(segment_dir):
  segment_path = Path(segment_dir)
  return sorted(name for name, file_name in CAMERA_FILES.items() if (segment_path / file_name).is_file())


def generate_preview_gif(video_path, gif_path):
  video_path = Path(video_path)
  gif_path = Path(gif_path)

  # Two passes, mirroring the proven pipeline: speed the clip up into a temp mp4, then loop that into
  # the gif (REWRITE_PLAN §12.3). A unique temp per call lets concurrent generations coexist, and the
  # gif is only published with an atomic replace, so a hover never sees a half-written file. The temps
  # keep the real extension so ffmpeg can infer the output format.
  spedup_path = gif_path.with_name(f"{gif_path.stem}.{uuid4().hex}.spedup.mp4")
  staged_path = gif_path.with_name(f"{gif_path.stem}.{uuid4().hex}{gif_path.suffix}")

  try:
    run_ffmpeg(["-i", str(video_path), "-an", "-vf", f"setpts=PTS/{PREVIEW_GIF_SPEEDUP}", str(spedup_path)])
    run_ffmpeg(["-i", str(spedup_path), "-loop", "0", str(staged_path)])

    staged_path.replace(gif_path)
    return gif_path
  except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exception:
    sentry.capture_exception(exception)
    return None
  finally:
    spedup_path.unlink(missing_ok=True)
    staged_path.unlink(missing_ok=True)


def generate_thumbnail(video_path, thumbnail_path):
  video_path = Path(video_path)
  thumbnail_path = Path(thumbnail_path)

  # Grab a frame from the middle of the clip so the still is representative instead of a black opening
  # frame; an unreadable duration falls back to the very first frame (REWRITE_PLAN §12.3).
  midpoint = probe_duration(video_path) / 2
  staged_path = thumbnail_path.with_name(f"{thumbnail_path.stem}.{uuid4().hex}{thumbnail_path.suffix}")

  try:
    run_ffmpeg(["-ss", str(midpoint), "-i", str(video_path), "-frames:v", "1", str(staged_path)])

    staged_path.replace(thumbnail_path)
    return thumbnail_path
  except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exception:
    sentry.capture_exception(exception)
    return None
  finally:
    staged_path.unlink(missing_ok=True)


def probe_duration(video_path):
  try:
    output = subprocess.check_output(
      ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(video_path)],
      text=True,
      timeout=FFPROBE_TIMEOUT_SECONDS,
    )
    return round(float(output), 1)
  except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError) as error:
    print(f"Could not probe duration for {Path(video_path).name}: {error}")
    return 0.0


def run_ffmpeg(args, timeout=FFMPEG_TIMEOUT_SECONDS):
  # timeout bounds the spawn so a stuck encode never wedges a server thread; on expiry subprocess kills
  # the child and raises TimeoutExpired, which the generate_* callers handle like any other ffmpeg
  # failure. A caller that legitimately needs longer (a full-route concat) passes its own.
  subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], capture_output=True, check=True, text=True, timeout=timeout)
