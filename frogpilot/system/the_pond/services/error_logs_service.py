#!/usr/bin/env python3
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

from openpilot.frogpilot.common.frogpilot_utilities import delete_file
from openpilot.frogpilot.common.frogpilot_variables import ERROR_LOGS_PATH
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.paths import safe_join

# The on-disk extension the crash handler writes each log with. Kept local to this service rather than
# in the shared config because error logs are the only consumer (the B3 video extensions are shared).
ERROR_LOG_EXTENSION = ".log"

# The local timestamp the crash handler names each log with, e.g. "2026-05-28--15-30-45.log". The
# old Pond parsed this client-side to show a friendly date + age (assets/js/utils.js); we parse it on
# the server so a malformed name is skipped once here instead of throwing in the browser (REWRITE_PLAN
# §4.2, §14 B11). Anything that does not parse back is not a recorder-named log, so it is left out of
# the list rather than reformatted.
TIMESTAMP_NAME_FORMAT = "%Y-%m-%d--%H-%M-%S"


@dataclass(frozen=True)
class ErrorLog:
  created_at: float
  name: str


def build_error_log(log_path):
  # created_at comes from the filename timestamp, not the file mtime: the name is what the crash
  # handler stamped at capture time and is what the UI shows the age against.
  timestamp = datetime.strptime(log_path.stem, TIMESTAMP_NAME_FORMAT)

  return ErrorLog(created_at=timestamp.timestamp(), name=log_path.name)


def delete(filename):
  delete_file(str(error_log_file(filename)))


def delete_all():
  for log_path in error_logs_dir().glob(f"*{ERROR_LOG_EXTENSION}"):
    delete_file(str(log_path))


def error_log_file(filename):
  log_path = safe_join(error_logs_dir(), filename)
  if not log_path.is_file():
    raise ApiError("Error log not found", 404)

  return log_path


def error_logs_dir():
  directory = Path(ERROR_LOGS_PATH)
  directory.mkdir(parents=True, exist_ok=True)
  return directory


def list_error_logs():
  logs = []
  for log_path in error_logs_dir().glob(f"*{ERROR_LOG_EXTENSION}"):
    try:
      logs.append(build_error_log(log_path))
    except ValueError as error:
      # A name that does not match the timestamp format was renamed by hand or written by something
      # else; skip it so one bad filename never kills the whole list (REWRITE_PLAN §14 B11).
      print(f"Skipping error log with unparseable name {log_path.name}: {error}")
      continue

  logs.sort(key=lambda log: log.created_at, reverse=True)

  return [asdict(log) for log in logs]
