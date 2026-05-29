#!/usr/bin/env python3
from pathlib import Path

from werkzeug.utils import secure_filename

from openpilot.frogpilot.system.the_pond.lib.errors import ApiError


# Resolve a user-supplied path under base and reject anything that escapes it. Every endpoint that
# touches a caller-controlled filename routes through here so traversal is blocked in one place
# (REWRITE_PLAN §5.1, §3.3). Auth is intentionally off, so this is robustness, not a security wall.
def safe_join(base, *parts):
  base_path = Path(base).resolve()

  target = base_path.joinpath(*parts).resolve()

  if not target.is_relative_to(base_path):
    raise ApiError("Invalid path", 400)

  return target


def safe_name(name):
  cleaned = secure_filename(name or "")
  if not cleaned:
    raise ApiError("Invalid filename", 400)

  return cleaned
