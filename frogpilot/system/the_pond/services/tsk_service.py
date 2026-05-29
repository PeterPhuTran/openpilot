#!/usr/bin/env python3
import capnp
import json

# Import sentry first to break the latent frogpilot_variables -> car_helpers -> sentry -> frogpilot_variables
# cycle: a cold import of frogpilot_variables raises unless sentry is loaded first (CONVENTIONS §0, matches
# lib/onroad.py and services/stats_service.py). sentry.capture_exception also reports a corrupt blob below.
import openpilot.system.sentry as sentry

from cereal import car

from openpilot.frogpilot.common.frogpilot_variables import params
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError

# The persistent param the Toyota SecOC manager stores its saved key list in, as a JSON array of
# {"name", "value"} objects (common/params.cc:492, PERSISTENT | DONT_LOG). SECOC_KEY is the single
# active key card.py loads at boot (common/params.cc:197); applying a saved key copies its value here.
SECOC_KEYS_KEY = "SecOCKeys"
SECOC_KEY_KEY = "SecOCKey"

# The last car's CarParams, readable offroad (common/params.cc:110, PERSISTENT). The volatile "CarParams"
# is cleared on the onroad transition, so the offroad-only Pond reads the persistent copy to decide
# availability — the same source the old Pond re-parsed per call (REWRITE_PLAN §3.2 the_pond.py:1472-1477).
CAR_PARAMS_PERSISTENT_KEY = "CarParamsPersistent"

# A valid SecOC key is 16 bytes of hex (card.py:85-86 does bytes.fromhex(...) and requires len == 16),
# i.e. exactly 32 hex characters. The old frontend only checked length >= 10 (tsk_manager.js:52), which
# accepted keys the device then rejected as invalid; the server enforces the device-true rule instead.
SECOC_KEY_LENGTH = 32


def tsk_available():
  # Toyota that requires SecOC message authentication to operate (car.capnp:508 secOcRequired). The car
  # params only exist once a supported car has been seen, so an absent/unparseable param simply means
  # "not available" rather than an error.
  raw = params.get(CAR_PARAMS_PERSISTENT_KEY)
  if not raw:
    return False

  try:
    with car.CarParams.from_bytes(raw) as car_params:
      return car_params.carName == "toyota" and bool(car_params.secOcRequired)
  except (capnp.KjException, ValueError) as error:
    # A truncated or stale CarParams blob should degrade to "unavailable", not surface a 500: this only
    # gates whether the nav item appears, so report it once (capnp raises KjException on a bad blob) and
    # hide the feature rather than swallowing the failure silently.
    sentry.capture_exception(error)
    return False


def list_keys():
  # Standardize on the `params.get(...) or "[]"` idiom: the old get_secoc_keys passed "[]" as the second
  # positional arg to Params.get, which is `block`, not a default (REWRITE_PLAN §3.2 the_pond.py:1489), so
  # it never defaulted as intended. An empty or never-set param is a normal first-run state -> empty list.
  return public_keys(load_keys())


def load_keys():
  return parse_keys(params.get(SECOC_KEYS_KEY) or "[]")


def parse_keys(raw):
  try:
    keys = json.loads(raw)
  except json.JSONDecodeError as error:
    raise ApiError("Saved keys are corrupt", 500) from error

  if not isinstance(keys, list):
    raise ApiError("Saved keys are corrupt", 500)

  # Normalize to exactly {"name", "value"} string pairs for internal use and drop anything that does not
  # fit the shape. Browser-facing routes call public_keys() so saved values are never returned.
  normalized = []
  for entry in keys:
    if isinstance(entry, dict) and isinstance(entry.get("name"), str) and isinstance(entry.get("value"), str):
      normalized.append({"name": entry["name"], "value": entry["value"]})

  return normalized


def public_keys(keys):
  return [{"name": key["name"], "saved": True} for key in keys]


def save_key(name, value):
  clean_name = validate_name(name)
  clean_value = validate_value(value)

  keys = load_keys()

  # Editing a key replaces the entry that shares its name; a brand-new name is appended. A second key may
  # not reuse an existing name (mirrors the old isDuplicateName guard, tsk_manager.js:41-46).
  remaining = [key for key in keys if key["name"] != clean_name]
  remaining.append({"name": clean_name, "value": clean_value})

  store_keys(remaining)

  return public_keys(remaining)


def delete_key(name):
  if not name:
    raise ApiError("A key name is required", 400)

  keys = load_keys()

  remaining = [key for key in keys if key["name"] != name]
  if len(remaining) == len(keys):
    raise ApiError("Key not found", 404)

  store_keys(remaining)

  return public_keys(remaining)


def apply_key(name):
  # Applying a key writes it to the single active SECOC_KEY param card.py reads at boot to authenticate
  # CAN messages (card.py:83-90). The browser only supplies the saved key name; the value stays server-side.
  clean_name = validate_name(name)

  saved = next((key for key in load_keys() if key["name"] == clean_name), None)
  if saved is None:
    raise ApiError("Key not found", 404)

  params.put(SECOC_KEY_KEY, validate_value(saved["value"]))


def store_keys(keys):
  params.put(SECOC_KEYS_KEY, json.dumps(keys))


def validate_name(name):
  clean = (name or "").strip()
  if not clean:
    raise ApiError("A key name is required", 400)

  if any(character.isspace() for character in clean):
    raise ApiError("Key name cannot contain spaces", 400)

  return clean


def validate_value(value):
  clean = (value or "").strip()
  if len(clean) != SECOC_KEY_LENGTH:
    raise ApiError(f"Key value must be {SECOC_KEY_LENGTH} hexadecimal characters", 400)

  try:
    bytes.fromhex(clean)
  except ValueError as error:
    raise ApiError("Key value must be hexadecimal", 400) from error

  return clean
