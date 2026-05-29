#!/usr/bin/env python3
import time

from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

from openpilot.frogpilot.common.frogpilot_utilities import delete_file, run_cmd
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.paths import safe_join, safe_name
from openpilot.frogpilot.system.the_pond.lib.sse import sse_message

# The launch script writes the boot tmux scrollback here and the manager appends to it, so it is the
# single live console the device logs to (verified launch_chffrplus.sh:83, "tmux capture-pane -pq
# -S-1000 > /tmp/launch_log"). The live stream tails this file rather than spawning tmux per frame.
LIVE_LOG_PATH = Path("/tmp/launch_log")

# Saved captures live alongside the recordings/error logs under /data so they survive a reboot, unlike
# /tmp/launch_log which AGNOS clears on boot. The directory is created on demand so the view never 500s
# on a fresh device (mirrors B3 recordings_dir / B11 error_logs_dir).
TMUX_LOGS_PATH = Path("/data/tmux_logs")

# The extension every saved capture is written with. Kept local to this service rather than in the
# shared config because tmux logs are the only consumer (the B3 video extensions are shared). The old
# Pond saved captures as ".json" but the content is plain console text, so a ".log" extension matches
# what is actually on disk and the B11 error-log convention.
TMUX_LOG_EXTENSION = ".log"

# The local timestamp a capture is named with when the user does not supply a name, e.g.
# "May_28_2026-03-15PM". Mirrors the B3 screen-recorder naming so the UI can show the same friendly
# date and flag a hand-renamed file via is_custom_name.
TIMESTAMP_NAME_FORMAT = "%B_%d_%Y-%I-%M%p"

# How many lines of scrollback a capture keeps. -1000 carries over the launch script's "-S-1000" so a
# manual capture matches the depth the boot capture already wrote (verified launch_chffrplus.sh:83).
CAPTURE_HISTORY_LINES = 1000

# Live-stream bounds. The generator yields at most LIVE_STREAM_MAX_FRAMES frames, sleeping
# LIVE_STREAM_INTERVAL_SECONDS between reads, so it is finite (never an unbounded while-True like the
# old stream_tmux_log, REWRITE_PLAN §3.2) and stops at the next yield when the client disconnects. The
# product is a multi-minute window after which the client re-opens the stream, which tears the old one
# down deterministically (REWRITE_PLAN §3.4).
LIVE_STREAM_INTERVAL_SECONDS = 1.0
LIVE_STREAM_MAX_FRAMES = 600


@dataclass(frozen=True)
class TmuxLog:
  created_at: float
  is_custom_name: bool
  name: str
  size_bytes: int


def build_tmux_log(log_path):
  return TmuxLog(
    created_at=log_path.stat().st_mtime,
    is_custom_name=is_custom_name(log_path.stem),
    name=log_path.stem,
    size_bytes=log_path.stat().st_size,
  )


def capture():
  # Reuse the shared run_cmd primitive for the spawn (no shell, captures stdout, reports a failure to
  # sentry) instead of writing a second subprocess wrapper. The launch script redirects the same
  # command to a file with a shell; here run_cmd hands back stdout and the service writes it, so no
  # shell redirect is needed (verified launch_chffrplus.sh:83).
  output = run_cmd(
    ["tmux", "capture-pane", "-p", "-q", "-S", f"-{CAPTURE_HISTORY_LINES}"],
    "Captured tmux buffer",
    "Failed to capture tmux buffer",
  )
  if output is None:
    raise ApiError("Could not capture the tmux session", 500)

  log_path = safe_join(tmux_logs_dir(), f"{datetime.now().strftime(TIMESTAMP_NAME_FORMAT)}{TMUX_LOG_EXTENSION}")
  log_path.write_text(output, encoding="utf-8")

  return asdict(build_tmux_log(log_path))


def delete(name):
  delete_file(str(tmux_log_file(name)))


def delete_all():
  for log_path in tmux_logs_dir().glob(f"*{TMUX_LOG_EXTENSION}"):
    delete_file(str(log_path))


def is_custom_name(name):
  try:
    datetime.strptime(name, TIMESTAMP_NAME_FORMAT)
    return False
  except ValueError:
    return True


def list_logs():
  logs = sorted(
    (build_tmux_log(log_path) for log_path in tmux_logs_dir().glob(f"*{TMUX_LOG_EXTENSION}")),
    key=lambda log: log.created_at,
    reverse=True,
  )

  return [asdict(log) for log in logs]


def live_stream():
  # Bounded and disconnect-aware: the file is read and framed BEFORE each yield, so a client that
  # navigates away closes the generator at the next yield and no further reads happen (REWRITE_PLAN
  # §3.2, §3.4; mirrors B3 list_recordings_stream). The first frame carries the full current buffer so
  # a freshly-mounted view is not blank; subsequent frames only carry the text when it changed, so a
  # paused/idle console does not stream redundant frames.
  yield sse_message({"event": "start"})

  previous = None
  for _ in range(LIVE_STREAM_MAX_FRAMES):
    content = read_live_log()
    if content != previous:
      previous = content
      yield sse_message({"event": "log", "content": content})

    time.sleep(LIVE_STREAM_INTERVAL_SECONDS)

  yield sse_message({"event": "done"})


def read_live_log():
  try:
    return LIVE_LOG_PATH.read_text(encoding="utf-8", errors="replace")
  except FileNotFoundError:
    # The launch log only exists after a boot through the launch script; on a fresh/dev boot there is
    # nothing to tail yet, so the stream reports an empty console instead of erroring.
    return ""


def rename(old_name, new_name):
  source = tmux_log_file(old_name)

  target_stem = safe_name(new_name)
  target = source.parent / f"{target_stem}{TMUX_LOG_EXTENSION}"
  if target.exists():
    raise ApiError("A log with that name already exists", 409)

  source.rename(target)

  return asdict(build_tmux_log(target))


def tmux_log_file(name):
  log_path = safe_join(tmux_logs_dir(), f"{name}{TMUX_LOG_EXTENSION}")
  if not log_path.is_file():
    raise ApiError("Log not found", 404)

  return log_path


def tmux_logs_dir():
  TMUX_LOGS_PATH.mkdir(parents=True, exist_ok=True)
  return TMUX_LOGS_PATH
