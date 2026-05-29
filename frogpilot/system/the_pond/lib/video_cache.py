#!/usr/bin/env python3
from pathlib import Path

from openpilot.system.loggerd.config import get_available_bytes

from openpilot.frogpilot.common.frogpilot_utilities import delete_file
from openpilot.frogpilot.common.frogpilot_variables import VIDEO_CACHE_PATH

# Headroom to leave for the rest of the system on the shared SoC. When a new transcode would eat into
# it, evict the least-recently-used cache files rather than wiping the whole cache the moment free
# space dips, which is the old §3.2 bug (REWRITE_PLAN §3.2, §12.3).
MIN_FREE_BYTES = 500 * 1024 * 1024


def evictions_for(entries, available_bytes, required_bytes):
  # entries is an oldest-first list of (path, size_bytes). Returns the prefix to delete so that, once
  # those bytes are freed, the disk clears MIN_FREE_BYTES plus the incoming file. Pure, so the
  # eviction policy is unit tested without touching the disk.
  freed = 0
  victims = []
  for path, size_bytes in entries:
    if available_bytes + freed >= MIN_FREE_BYTES + required_bytes:
      break

    freed += size_bytes
    victims.append(path)

  return victims


class VideoCache:
  def __init__(self):
    self.cache_path = Path(VIDEO_CACHE_PATH)
    self.cache_path.mkdir(parents=True, exist_ok=True)

  def is_fresh(self, key, source_mtime):
    cached_path = self.path_for(key)
    return cached_path.is_file() and cached_path.stat().st_mtime >= source_mtime

  def make_room(self, required_bytes):
    cached_files = sorted(self.cache_path.glob("*.mp4"), key=lambda path: path.stat().st_mtime)
    entries = [(path, path.stat().st_size) for path in cached_files]

    # Treat an unreadable free-space figure as zero so a disk-stat failure evicts (fails toward making
    # room) rather than crashing on None + int — get_available_bytes returns its default on OSError.
    for path in evictions_for(entries, get_available_bytes(0), required_bytes):
      delete_file(str(path))

  def path_for(self, key):
    return self.cache_path / f"{key}.mp4"
