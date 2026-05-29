#!/usr/bin/env python3
from dataclasses import asdict, dataclass
from pathlib import Path

# Import sentry first to break the latent frogpilot_variables -> car_helpers -> sentry -> frogpilot_variables
# cycle: a cold import of frogpilot_variables (directly or via loggerd.deleter below) raises unless sentry
# is loaded first, so this side-effect import must lead (CONVENTIONS §0, matches lib/onroad.py).
import openpilot.system.sentry as sentry  # noqa: F401

from openpilot.system.loggerd.config import get_available_bytes, get_available_percent
from openpilot.system.loggerd.deleter import MIN_BYTES, MIN_PERCENT

from openpilot.frogpilot.common.frogpilot_utilities import delete_file
from openpilot.frogpilot.common.frogpilot_variables import ERROR_LOGS_PATH, params
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError

# Bytes in a gibibyte, matching loggerd's own GB framing (MIN_BYTES is 5 * 1024**3); reused for the
# low-disk detail so the threshold and the free-space readout share one divisor (mirrors stats_service).
BYTES_PER_GB = 1024**3

# The file the crash handler saves the tail of a process crash to (the last 10 traceback lines), written
# by sentry.save_exception alongside the timestamped .log and cleared by frogpilot_process on the next
# boot (frogpilot/frogpilot_process.py:65-67). Its presence means a process crashed since the last clean
# boot, so it is the strongest "something went wrong" signal the device exposes (system/sentry.py:98-109).
CRASH_SUMMARY_NAME = "error.txt"

# The extension the crash handler names each full traceback log with, mirrored from the B11 error-logs
# service. Counting these is how the UI shows "N crash logs" without parsing each file.
ERROR_LOG_EXTENSION = ".log"

# How many characters of the crash summary to surface as the issue detail. error.txt is already only the
# last 10 lines of a traceback, so the first non-empty line is a concise, honest description of the crash
# without dumping the whole stack into the listing.
CRASH_DETAIL_LIMIT = 200


@dataclass(frozen=True)
class Issue:
  detail: str
  id: str
  severity: str
  title: str


def crash_issue():
  # error.txt is the saved tail of the most recent process crash. Surface the first non-empty line as the
  # detail so the user sees what failed without the full stack; an unreadable file still reports the crash.
  summary = error_logs_dir() / CRASH_SUMMARY_NAME
  if not summary.is_file():
    return None

  try:
    detail = next((line.strip() for line in summary.read_text().splitlines() if line.strip()), "A process crashed and saved a crash report.")
  except OSError as error:
    print(f"Could not read crash summary {summary}: {error}")
    detail = "A process crashed and saved a crash report."

  return Issue(detail=detail[:CRASH_DETAIL_LIMIT], id="crash", severity="error", title="A process crashed")


def detect_issues():
  candidates = [crash_issue(), error_logs_issue(), low_disk_issue(), update_failed_issue()]

  return [issue for issue in candidates if issue is not None]


def error_logs_dir():
  directory = Path(ERROR_LOGS_PATH)
  directory.mkdir(parents=True, exist_ok=True)
  return directory


def error_logs_issue():
  # The timestamped crash logs accumulate every traceback the crash handler captured. Their count is a
  # real, honest signal that is independent of error.txt (which only holds the most recent one).
  count = len(error_log_files())
  if not count:
    return None

  plural = "s" if count != 1 else ""
  return Issue(detail=f"{count} crash log{plural} saved on the device.", id="error_logs", severity="warning", title="Crash logs present")


def error_log_files():
  return list(error_logs_dir().glob(f"*{ERROR_LOG_EXTENSION}"))


def low_disk_issue():
  # Mirror loggerd's own out-of-space test (system/loggerd/deleter.py:49-50): free space is low when it
  # drops below either the byte floor or the percentage floor, the exact point at which the device starts
  # deleting old footage. The defaults keep a transient statvfs failure from reporting a false low-disk.
  free_bytes = get_available_bytes(default=MIN_BYTES + 1)
  free_percent = get_available_percent(default=MIN_PERCENT + 1)
  if free_bytes >= MIN_BYTES and free_percent >= MIN_PERCENT:
    return None

  free_gb = free_bytes / BYTES_PER_GB
  return Issue(
    detail=f"{free_gb:.1f} GB free ({free_percent:.0f}%). The device deletes old footage below {MIN_BYTES // BYTES_PER_GB} GB or {MIN_PERCENT}%.",
    id="low_disk",
    severity="warning",
    title="Low free storage",
  )


def reset():
  # Honest reset: it clears only the crash/error-log state the device itself clears on a clean boot
  # (frogpilot_process.py:65-67) and that the error-logs view deletes — error.txt plus the timestamped
  # crash logs. It deliberately does NOT touch the low-disk or failed-update signals: freeing disk would
  # mean deleting the user's footage, and clearing the updater's UpdateFailedCount/LastUpdateException
  # would hide a real failure the updater owns without fixing it (root-cause band-aid ban). The reset
  # reports exactly which issues it cleared so the UI never implies it fixed more than it did.
  cleared = []

  summary = error_logs_dir() / CRASH_SUMMARY_NAME
  if summary.is_file():
    delete_file(str(summary))
    cleared.append("crash")

  log_files = error_log_files()
  if log_files:
    for log_path in log_files:
      delete_file(str(log_path))
    cleared.append("error_logs")

  if not cleared:
    raise ApiError("Nothing to reset", 404)

  return {"cleared": cleared, "message": "Cleared the saved crash and error logs"}


def troubleshoot():
  return {"issues": [asdict(issue) for issue in detect_issues()]}


def update_failed_issue():
  # UpdateFailedCount is the consecutive failed-update-check counter the updater writes; the on-device UI
  # treats any positive value as a failed update (selfdrive/ui/qt/offroad/software_settings.cc:172). The
  # exact exception text lives in LastUpdateException, both owned by system/updated/updated.py:set_params.
  if failed_update_count() <= 0:
    return None

  detail = params.get("LastUpdateException", encoding="utf-8") or "The last update check failed."
  return Issue(detail=detail[:CRASH_DETAIL_LIMIT], id="update_failed", severity="warning", title="Update failed")


def failed_update_count():
  raw = params.get("UpdateFailedCount", encoding="utf-8")
  if not raw:
    return 0

  try:
    return int(raw)
  except ValueError:
    # A non-numeric value is corrupt rather than a real failure count; treat it as zero so a bad write
    # never fabricates a failed-update issue.
    print(f"Ignoring non-numeric UpdateFailedCount {raw!r}")
    return 0
