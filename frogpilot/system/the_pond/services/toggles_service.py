#!/usr/bin/env python3
import json
import threading
import time

# Import sentry first to break the latent frogpilot_variables -> car_helpers -> sentry -> frogpilot_variables
# cycle: a cold import of frogpilot_variables raises unless sentry is loaded first, so this side-effect
# import must lead (CONVENTIONS §0, matches lib/onroad.py and services/stats_service.py).
import openpilot.system.sentry as sentry  # noqa: F401

from openpilot.system.hardware import HARDWARE

from openpilot.frogpilot.common.frogpilot_variables import EXCLUDED_KEYS, frogpilot_default_params, params, update_frogpilot_toggles
from openpilot.frogpilot.system.the_pond.lib.capabilities import require_device
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError

# A reset rewrites every managed toggle and then reboots so the running stack picks up the new values.
# The reboot is deferred by this many seconds so the HTTP response is fully flushed to the browser
# before the process is torn down — the old reset_toggle_values/reset_toggle_values_to_stock returned
# None and rebooted under the request, leaving the client with no response (REWRITE_PLAN §3.2, §13).
REBOOT_DELAY_SECONDS = 2.0

# The download filename the backup attachment carries, matching what the old toggles view saved
# (assets/components/tools/toggles.js used "toggle-backup.json").
BACKUP_FILENAME = "toggle-backup.json"


def allowed_keys():
  # Only the keys FrogPilot manages as toggles are eligible for backup/restore/reset; EXCLUDED_KEYS holds
  # device-identity, cache, and dataset params that must never be carried between devices or reset
  # (e.g. CarParamsPersistent, SpeedLimits). Filtering here keeps every operation on the same key set.
  return [key for key, _, _, _ in frogpilot_default_params if key not in EXCLUDED_KEYS]


def as_param_value(value):
  # Params.put accepts str or bytes; frogpilot_default_params is annotated str | bytes and an uploaded
  # JSON value can be a number/bool, so a bytes value passes through and everything else is coerced to its
  # text form. str(bytes) would emit the b'...' repr, so bytes are returned unchanged rather than stringified.
  return value if isinstance(value, (bytes, str)) else str(value)


def backup():
  # Snapshot the current persistent value of every managed toggle as a JSON object. A key with no stored
  # value (never set on this device) is omitted rather than written as null, so a restore only ever
  # reapplies values that genuinely existed. A value that is not valid UTF-8 is skipped for the same
  # reason a params dump skips it — the toggles this view manages are all text params.
  snapshot = {}
  for key in allowed_keys():
    try:
      value = params.get(key, encoding="utf-8")
    except UnicodeDecodeError:
      continue

    if value is not None:
      snapshot[key] = value

  return json.dumps(snapshot, indent=2, sort_keys=True).encode("utf-8")


def reset_default():
  # Reset every managed toggle to its FrogPilot default (index 1 of each frogpilot_default_params tuple),
  # then reboot after the response is sent.
  reset_to(1)


def reset_stock():
  # Reset every managed toggle to its stock-openpilot default (index 3 of each frogpilot_default_params
  # tuple — the base_default), then reboot after the response is sent.
  reset_to(3)


def restore(payload):
  # Apply an uploaded backup, writing only managed keys and ignoring everything else, so a hand-edited or
  # foreign file can never set an excluded/identity param. The count of applied keys lets the UI report
  # how much was restored.
  if not isinstance(payload, dict):
    raise ApiError("Backup must be a JSON object of toggle values", 400)

  allowed = set(allowed_keys())
  applied = 0
  for key, value in payload.items():
    if key not in allowed:
      continue

    params.put(key, as_param_value(value))
    applied += 1

  if applied == 0:
    raise ApiError("No valid toggles found in the uploaded file", 400)

  update_frogpilot_toggles()

  return applied


def schedule_reboot():
  # Defer the reboot to a daemon thread so the request handler can return its response first; the short
  # delay lets the response flush before HARDWARE.reboot() tears the process down (REWRITE_PLAN §3.2, §13).
  def reboot_after_delay():
    time.sleep(REBOOT_DELAY_SECONDS)
    HARDWARE.reboot()

  threading.Thread(target=reboot_after_delay, daemon=True).start()


def reset_to(default_index):
  require_device()

  for entry in frogpilot_default_params:
    key = entry[0]
    if key in EXCLUDED_KEYS:
      continue

    params.put(key, as_param_value(entry[default_index]))

  update_frogpilot_toggles()
  schedule_reboot()
