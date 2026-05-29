#!/usr/bin/env python3
import json
import math
import os
import re

from pathlib import Path


# Import sentry first to break the latent frogpilot_variables -> car_helpers -> sentry -> frogpilot_variables
# cycle: a cold import of frogpilot_variables (directly or via loggerd.uploader below) raises unless sentry
# is loaded first, so this side-effect import must lead (CONVENTIONS §0, matches lib/onroad.py).
import openpilot.system.sentry as sentry

from openpilot.common.conversions import Conversions as CV
from openpilot.system.hardware.hw import Paths
from openpilot.system.loggerd.config import get_available_bytes, get_used_bytes
from openpilot.system.loggerd.uploader import listdir_by_creation
from openpilot.system.version import get_build_metadata

from openpilot.frogpilot.common.frogpilot_variables import EXCLUDED_KEYS, params, params_memory

import openpilot.frogpilot.system.the_pond.services.drive_history_service as drive_history_service

from openpilot.frogpilot.system.the_pond.lib.onroad import is_onroad



# The directory names loggerd creates per recorded drive segment ("<route>--<segment>"). The firehose
# segment count is the number of these across every footage root, so a renamed/custom directory is not
# miscounted as an uploadable segment (mirrors the old utilities.SEGMENT_RE listing path).
SEGMENT_NAME_PATTERN = re.compile(r"^[0-9a-fA-F]{8}--[0-9a-fA-F]{10}--\d+$")

# Bytes in a gibibyte, matching the old get_disk_usage GB formatting (used // 2**30).
BYTES_PER_GB = 2**30

# deviceState.networkType enumerants -> a human label for the vitals card; an unmapped value (the "none"
# offline state, or anything new) drops the row rather than guessing.
NETWORK_LABELS = {
  "cell2G": "Cellular",
  "cell3G": "Cellular",
  "cell4G": "Cellular",
  "cell5G": "Cellular",
  "ethernet": "Ethernet",
  "wifi": "Wi-Fi",
}

# Param-key substrings that mark a value as a credential rather than a setting; the read-only param
# dumps drop any key containing one of these (case-insensitive) on top of EXCLUDED_KEYS so a dump can
# never leak a token, key, password, or secret to the browser (REWRITE_PLAN §6, §11.1).
SECRET_KEY_MARKERS = ("dongleid", "key", "password", "secret", "token")
SENSITIVE_LOCATION_KEYS = frozenset({"ApiCache_NavDestinations", "FavoriteDestinations", "LastGPSPosition", "NavDestination"})
SENSITIVE_LOCATION_MARKERS = ("destination", "gps", "location")


def disk_usage():
  free = get_available_bytes(default=0) or 0
  used = get_used_bytes(default=0) or 0
  total = used + free

  # statvfs can momentarily report a zero total; guard the percentage so a transient read never raises
  # (the old get_disk_usage divided unconditionally — REWRITE_PLAN §3.2 disk gotcha).
  used_percentage = (used / total * 100) if total else 0.0

  return [
    {
      "free": gigabytes(free),
      "size": gigabytes(total),
      "used": gigabytes(used),
      "usedPercentage": f"{used_percentage:.2f}%",
    }
  ]


def drive_stats():
  cached = json_object_param("ApiCache_DriveStats")
  frogpilot = json_object_param("FrogPilotStats")

  is_metric = params.get_bool("IsMetric")
  unit = "kilometers" if is_metric else "miles"

  return {
    "all": comma_timeframe(cached.get("all", {}), is_metric, unit),
    "frogpilot": frogpilot_timeframe(frogpilot, is_metric, unit),
    "week": comma_timeframe(cached.get("week", {}), is_metric, unit),
  }


def comma_timeframe(data, is_metric, unit):
  data = data if isinstance(data, dict) else {}
  # ApiCache_DriveStats stores distance in MILES and duration in minutes (verified against the on-device
  # DriveStats widget, frogpilot/ui/qt/widgets/drive_stats.cc:85: distance * (isMetric ? MILE_TO_KM : 1)).
  # Metric users get miles -> km; imperial keeps the stored miles. CV has no MILE_TO_KM, so derive it from
  # MILE_TO_METER (meters per mile) over 1000 meters per km.
  return {
    "distance": finite_number(data.get("distance")) * (CV.MILE_TO_METER / 1000 if is_metric else 1),
    "drives": finite_number(data.get("routes")),
    "hours": finite_number(data.get("minutes")) / 60,
    "unit": unit,
  }


def firehose_segments():
  return {"segments": sum(count_segments(footage_root) for footage_root in footage_roots())}


def footage_disk_usage():
  return [{"label": footage_root_label(footage_root), "path": footage_root, "segments": count_segments(footage_root)} for footage_root in footage_roots()]


def count_segments(footage_root):
  # listdir_by_creation returns [] for a missing/unreadable root, so a device without HD/Konik footage
  # simply reports zero segments for that root instead of raising.
  return sum(1 for entry in listdir_by_creation(footage_root) if SEGMENT_NAME_PATTERN.fullmatch(entry))


def footage_roots():
  # The three footage roots loggerd writes to: the default realdata plus the HD and Konik variants
  # (verified: Paths.log_root honors the HD/konik flags, frogpilot/ui/qt/offroad/data_settings.cc deletes
  # the same three). De-duplicated because on a PC all three resolve to the one comma-home realdata dir.
  roots = [Paths.log_root(), Paths.log_root(HD=True), Paths.log_root(konik=True)]

  seen = []
  for root in roots:
    if root not in seen:
      seen.append(root)

  return seen


def frogpilot_timeframe(frogpilot, is_metric, unit):
  frogpilot = frogpilot if isinstance(frogpilot, dict) else {}
  # FrogPilotStats stores distance in meters and duration in seconds (verified against frogpilot_tracking.py
  # and the DriveStats widget); convert to km/miles and hours.
  return {
    "distance": finite_number(frogpilot.get("FrogPilotMeters")) * (0.001 if is_metric else CV.METER_TO_MILE),
    "drives": finite_number(frogpilot.get("FrogPilotDrives")),
    "hours": finite_number(frogpilot.get("FrogPilotSeconds")) / (60 * 60),
    "unit": unit,
  }


def finite_number(value):
  return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else 0


def gigabytes(byte_count):
  return f"{byte_count // BYTES_PER_GB} GB"


def json_object_param(key):
  try:
    parsed = json.loads(params.get(key, encoding="utf-8") or "{}")
  except (json.JSONDecodeError, TypeError):
    return {}

  return parsed if isinstance(parsed, dict) else {}


def footage_root_label(footage_root):
  root_name = os.path.basename(str(footage_root).rstrip("/\\")).lower()
  if root_name.endswith("_konik"):
    return "Konik footage"
  if root_name.endswith("_hd"):
    return "High-resolution footage"
  return "Dashcam footage"


def is_secret_key(key):
  lowered = key.lower()
  return key in EXCLUDED_KEYS or any(marker in lowered for marker in SECRET_KEY_MARKERS)


def is_sensitive_dump_key(key):
  lowered = key.lower()
  return is_secret_key(key) or key in SENSITIVE_LOCATION_KEYS or any(marker in lowered for marker in SENSITIVE_LOCATION_MARKERS)


def param_dump(store):
  # Read-only snapshot of a params store with secrets stripped. Keys are bytes from all_keys(); values
  # that are missing or not valid UTF-8 are reported as null rather than failing the whole dump.
  dump = {}
  for raw_key in store.all_keys():
    key = raw_key.decode("utf-8") if isinstance(raw_key, bytes) else raw_key
    if is_sensitive_dump_key(key):
      continue

    try:
      dump[key] = store.get(key, encoding="utf-8")
    except UnicodeDecodeError:
      dump[key] = None

  return dict(sorted(dump.items()))


def params_dump():
  return param_dump(params)


def params_memory_dump():
  return param_dump(params_memory)


def software_info():
  build_metadata = get_build_metadata()
  openpilot_metadata = build_metadata.openpilot

  return {
    "branchName": build_metadata.channel,
    "buildEnvironment": openpilot_metadata.build_style,
    "commitHash": openpilot_metadata.git_commit,
    "forkMaintainer": repo_owner(openpilot_metadata.git_normalized_origin),
    "updateAvailable": params.get_bool("UpdateAvailable"),
    "versionDate": openpilot_metadata.git_commit_date,
  }


def repo_owner(git_normalized_origin):
  # git_normalized_origin looks like "github.com/<owner>/<repo>"; the owner is the maintainer shown on
  # the dashboard (mirrors the old utilities.get_repo_owner).
  parts = git_normalized_origin.split("/")
  return parts[1] if len(parts) >= 2 else "unknown"


def stats():
  history = drive_history_service.drive_history()

  return {
    "diskUsage": disk_usage(),
    "driveStats": drive_stats(),
    "firehoseStats": firehose_segments(),
    "footageUsage": footage_disk_usage(),
    "lastDrive": history["lastDrive"],
    "records": history["records"],
    "recentDrives": history["recentDrives"],
    "softwareInfo": software_info(),
    "thisWeek": history["thisWeek"],
    "vitals": vitals(),
  }


def vitals():
  # status is always reachable (the app is gated to offroad, so it serves only while parked) and uptime
  # comes straight from /proc; cpuTemp and network are sampled from thermald's deviceState — the same
  # source the rest of openpilot reports temperature from (events.py uses max(cpuTempC)), not a hand-rolled
  # /sys read over a different set of zones. Any reading that is missing is omitted so the frontend hides
  # that row rather than showing a wrong one. No GPS row: the on-device logs carry no usable fix and
  # deviceState exposes no offroad fix flag to honour.
  vital = {"status": "Driving" if is_onroad() else "Parked", "uptime": uptime_text()}

  device = read_device_state()
  if device:
    if device["cpuTempC"]:
      vital["cpuTemp"] = f"{round(max(device['cpuTempC']))}°C"

    network = NETWORK_LABELS.get(device["networkType"])
    if network:
      vital["network"] = network

  return vital


def read_device_state():
  # One short, guarded sample of thermald's deviceState (published on- and off-road). Extracts the plain
  # values vitals needs WHILE the SubMaster is alive — never the capnp reader, which dangles once the
  # SubMaster is collected — and returns None if msgq cannot be sampled promptly so the dashboard never
  # blocks on it. A fresh SubMaster per call keeps it thread-safe under the threaded dev server.
  try:
    from cereal import messaging

    submaster = messaging.SubMaster(["deviceState"])
    for _ in range(10):
      submaster.update(100)
      if submaster.recv_frame["deviceState"] > 0:
        state = submaster["deviceState"]
        return {"cpuTempC": list(state.cpuTempC), "networkType": str(state.networkType)}
  except Exception as exception:
    sentry.capture_exception(exception)

  return None


def uptime_text():
  try:
    seconds = int(float(Path("/proc/uptime").read_text().split()[0]))
  except (OSError, ValueError, IndexError):
    return None

  days, seconds = divmod(seconds, 86400)
  hours, seconds = divmod(seconds, 3600)
  minutes = seconds // 60
  if days:
    return f"{days}d {hours}h"
  if hours:
    return f"{hours}h {minutes:02d}m"

  return f"{minutes}m"
