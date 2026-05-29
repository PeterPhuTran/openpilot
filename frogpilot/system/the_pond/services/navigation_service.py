#!/usr/bin/env python3
import hashlib
import json
import threading

from pathlib import Path

# Import sentry first to break the latent frogpilot_variables -> car_helpers -> sentry -> frogpilot_variables
# cycle: a cold import of frogpilot_variables raises unless sentry is loaded first, so this side-effect
# import must lead (CONVENTIONS §0, matches lib/onroad.py and stats_service.py). It is also used directly
# below to report a corrupt favorites/GPS param without failing the whole read.
import openpilot.system.sentry as sentry

from openpilot.common.basedir import BASEDIR

from openpilot.frogpilot.common.frogpilot_variables import params, params_memory
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.paths import safe_join

# Persistent param keys the on-device navigation stack reads (verified against common/params.cc and the
# FrogPilot/openpilot navigation consumers). The Pond is the offroad editor for the same params the car
# uses while driving, so the key names must match exactly or the device ignores the write.
AMAP_KEY_ONE = "AMapKey1"
AMAP_KEY_TWO = "AMapKey2"
FAVORITE_DESTINATIONS_KEY = "FavoriteDestinations"
IS_METRIC_KEY = "IsMetric"
LAST_GPS_POSITION_KEY = "LastGPSPosition"
MAPBOX_PUBLIC_KEY = "MapboxPublicKey"
MAPBOX_SECRET_KEY = "MapboxSecretKey"
NAV_DESTINATIONS_CACHE_KEY = "ApiCache_NavDestinations"
NAV_DESTINATION_KEY = "NavDestination"

# The four Mapbox setup screenshots the old Qt panel showed (frogpilot/ui/qt/offroad/navigation_settings.cc:395-401);
# the Manage Keys view serves them through /mapbox-help/<name>. They are tracked assets shipped with the
# repo, so the directory is resolved from BASEDIR rather than a device-only /data path.
MAPBOX_HELP_DIR = Path(BASEDIR) / "frogpilot" / "navigation" / "navigation_training"

# Per-key validation the old Qt panel enforced before storing a key (navigation_settings.cc:55-62,102-109,316-326).
# Mapbox keys carry a "pk."/"sk." prefix and are long; AMap keys have no prefix and a shorter minimum. The
# minimum length is checked against the prefixed value, matching createKeyControl/navigation_keys.js:67-70.
KEY_SPECS = {
  "amap1": {"min_length": 39, "param": AMAP_KEY_ONE, "prefix": ""},
  "amap2": {"min_length": 39, "param": AMAP_KEY_TWO, "prefix": ""},
  "public": {"min_length": 80, "param": MAPBOX_PUBLIC_KEY, "prefix": "pk."},
  "secret": {"min_length": 80, "param": MAPBOX_SECRET_KEY, "prefix": "sk."},
}

# The browser POSTs the key under a body field named after the kind (navigation_keys.js:66-71); DELETE
# passes the kind in the ?type= query (navigation_keys.js:179). Both resolve through KEY_SPECS.
KEY_BODY_FIELDS = tuple(KEY_SPECS)

# How long to wait between clearing NavDestination and writing the new one. navd only acts on a value it
# sees change, so clearing first then re-setting forces it to treat an identical re-selection as new; the
# old Pond used a 1s gap and it is preserved here (REWRITE_PLAN §12.2). Dispatched off-thread so the HTTP
# response returns immediately rather than holding the worker for a second (CONVENTIONS §6).
SET_DESTINATION_DELAY_SECONDS = 1.0

_pending_destination_generation = 0
_pending_destination_lock = threading.Lock()
_pending_destination_timer = None


def add_favorite(body):
  name = require_string(body, "name")
  latitude = require_number(body, "latitude")
  longitude = require_number(body, "longitude")

  favorites = load_favorites()

  favorite_id = favorite_identifier(latitude, longitude)
  if any(favorite["id"] == favorite_id for favorite in favorites):
    raise ApiError("That location is already a favorite", 409)

  favorites.append(
    {
      "id": favorite_id,
      "is_home": False,
      "is_work": False,
      "latitude": latitude,
      "longitude": longitude,
      "name": name,
      "routeId": body.get("routeId"),
    }
  )
  store_favorites(favorites)

  return "Added to favorites!"


def clear_destination():
  timer = invalidate_pending_destination_write(remove_destination=True)
  cancel_timer(timer)


def delete_key(kind):
  spec = key_spec(kind)
  params.remove(spec["param"])

  return f"{kind} key deleted"


def favorite_identifier(latitude, longitude):
  # A favorite is identified by its coordinates, so the same place always hashes to the same id across
  # reads and the browser can target it for delete/rename without the backend persisting a counter. sha1
  # of the normalized "lon,lat" string keeps the id stable and opaque (REWRITE_PLAN §12.2).
  digest_source = f"{longitude},{latitude}"
  return hashlib.sha1(digest_source.encode("utf-8")).hexdigest()


def favorites():
  return {"favorites": load_favorites()}


def key_spec(kind):
  spec = KEY_SPECS.get(kind)
  if spec is None:
    raise ApiError("Unknown key type", 400)

  return spec


def list_favorites():
  return load_favorites()


def load_favorites():
  raw = params.get(FAVORITE_DESTINATIONS_KEY, encoding="utf-8")
  if not raw:
    return []

  try:
    stored = json.loads(raw)
  except json.JSONDecodeError as error:
    # A hand-corrupted favorites param must not take down the whole view; report it once and present an
    # empty list, the same graceful-degradation the listing endpoints use elsewhere (CONVENTIONS §2).
    sentry.capture_exception(error)
    return []

  if not isinstance(stored, list):
    return []

  favorites_list = []
  for entry in stored:
    if not isinstance(entry, dict) or "latitude" not in entry or "longitude" not in entry:
      continue

    favorites_list.append(normalize_favorite(entry))

  return favorites_list


def navigation_state():
  return {
    "destination": params.get(NAV_DESTINATION_KEY, encoding="utf-8") or "",
    "hasAmap1Key": has_param_value(AMAP_KEY_ONE),
    "hasAmap2Key": has_param_value(AMAP_KEY_TWO),
    "hasMapboxSecret": has_param_value(MAPBOX_SECRET_KEY),
    "isMetric": params.get_bool(IS_METRIC_KEY),
    "lastPositionAvailable": bool(last_position()),
    "mapboxPublic": params.get(MAPBOX_PUBLIC_KEY, encoding="utf-8") or "",
    "previousDestinations": params.get(NAV_DESTINATIONS_CACHE_KEY, encoding="utf-8") or "[]",
  }


def navigation_key_state():
  return {
    "hasAmap1Key": has_param_value(AMAP_KEY_ONE),
    "hasAmap2Key": has_param_value(AMAP_KEY_TWO),
    "hasMapboxSecret": has_param_value(MAPBOX_SECRET_KEY),
    "mapboxPublic": params.get(MAPBOX_PUBLIC_KEY, encoding="utf-8") or "",
  }


def has_param_value(key):
  return bool(params.get(key, encoding="utf-8"))


def invalidate_pending_destination_write(remove_destination=False):
  global _pending_destination_generation, _pending_destination_timer

  with _pending_destination_lock:
    _pending_destination_generation += 1
    timer = _pending_destination_timer
    _pending_destination_timer = None
    if remove_destination:
      params.remove(NAV_DESTINATION_KEY)

  return timer


def last_position():
  # The planner writes LastGPSPosition to the volatile params_memory store every frame it has a fix
  # (frogpilot/controls/frogpilot_planner.py:81); locationd also mirrors it into persistent params once a
  # minute. Prefer the live volatile value and fall back to the persistent one so a freshly-parked device
  # still has a center point. Returned as a parsed object the view reads .latitude/.longitude off of.
  raw = params_memory.get(LAST_GPS_POSITION_KEY, encoding="utf-8") or params.get(LAST_GPS_POSITION_KEY, encoding="utf-8")
  if not raw:
    return {}

  try:
    position = json.loads(raw)
  except json.JSONDecodeError:
    return {}

  if not isinstance(position, dict):
    return {}

  return position


def mapbox_help_image(filename):
  image_path = safe_join(MAPBOX_HELP_DIR, filename)
  if not image_path.is_file():
    raise ApiError("Help image not found", 404)

  return image_path


def normalize_favorite(entry):
  # The on-device favorites param stores {name, latitude, longitude, is_home, is_work, routeId}; the
  # browser additionally needs a stable id to target deletes/renames. Coerce the flags to bools and derive
  # the id from the coordinates so a favorite written by the car (which has no id) still round-trips.
  latitude = entry["latitude"]
  longitude = entry["longitude"]

  return {
    "id": favorite_identifier(latitude, longitude),
    "is_home": bool(entry.get("is_home")),
    "is_work": bool(entry.get("is_work")),
    "latitude": latitude,
    "longitude": longitude,
    "name": entry.get("name", ""),
    "routeId": entry.get("routeId"),
  }


def remove_favorite(body):
  favorite_id = resolve_favorite_id(body)

  favorites = load_favorites()
  remaining = [favorite for favorite in favorites if favorite["id"] != favorite_id]
  if len(remaining) == len(favorites):
    raise ApiError("Favorite not found", 404)

  store_favorites(remaining)

  return "Favorite removed!"


def rename_favorite(body):
  # The Manage Destinations view toggles a favorite's home/work flag through this endpoint (it sends the
  # target favorite plus the new is_home/is_work). Home and work are mutually exclusive: setting one clears
  # the other on every favorite, and only one favorite may hold each flag (REWRITE_PLAN §12.2,
  # navigation_destination.js setSpecial). The old flow was a client delete-then-recreate; here it is a
  # single in-place flag update with rollback if the store write fails, so a half-applied state is
  # impossible.
  favorite_id = resolve_favorite_id(body)

  favorites = load_favorites()
  target = next((favorite for favorite in favorites if favorite["id"] == favorite_id), None)
  if target is None:
    raise ApiError("Favorite not found", 404)

  set_home = body.get("is_home")
  set_work = body.get("is_work")
  if set_home is None and set_work is None:
    raise ApiError("Nothing to update", 400)

  previous = json.dumps(favorites)

  for favorite in favorites:
    is_target = favorite["id"] == favorite_id
    if set_home is not None:
      favorite["is_home"] = bool(set_home) and is_target
    if set_work is not None:
      favorite["is_work"] = bool(set_work) and is_target

  # A favorite can never be both home and work; if turning on one flag, force the other off on the target.
  if bool(set_home):
    target["is_work"] = False
  if bool(set_work):
    target["is_home"] = False

  try:
    store_favorites(favorites)
  except Exception:
    params.put(FAVORITE_DESTINATIONS_KEY, previous)
    raise

  return "Favorite updated!"


def require_number(body, field):
  value = body.get(field)
  if isinstance(value, bool) or not isinstance(value, (int, float)):
    raise ApiError(f"'{field}' must be a number", 400)

  return value


def require_string(body, field):
  value = body.get(field)
  if not isinstance(value, str) or not value.strip():
    raise ApiError(f"'{field}' is required", 400)

  return value.strip()


def resolve_favorite_id(body):
  favorite_id = body.get("id")
  if isinstance(favorite_id, str) and favorite_id:
    return favorite_id

  # Older callers send the coordinates instead of an id; derive the same id from them so both shapes work.
  latitude = require_number(body, "latitude")
  longitude = require_number(body, "longitude")
  return favorite_identifier(latitude, longitude)


def save_key(body):
  kind = next((field for field in KEY_BODY_FIELDS if field in body), None)
  if kind is None:
    raise ApiError("No key provided", 400)

  spec = KEY_SPECS[kind]

  value = body.get(kind)
  if not isinstance(value, str):
    raise ApiError("Key must be a string", 400)

  cleaned = value.strip()
  if not cleaned:
    raise ApiError("Key cannot be empty", 400)

  prefixed = cleaned if cleaned.startswith(spec["prefix"]) else f"{spec['prefix']}{cleaned}"
  if len(prefixed) < spec["min_length"]:
    raise ApiError(f"Key must be at least {spec['min_length']} characters", 400)

  params.put(spec["param"], prefixed)

  return f"{kind} key saved"


def set_destination(body):
  name = require_string(body, "name")
  latitude = require_number(body, "latitude")
  longitude = require_number(body, "longitude")

  destination = json.dumps({"latitude": latitude, "longitude": longitude, "name": name})

  # Clear first so navd treats the re-set as a new destination even when it is identical to the current
  # one, then schedule the write after a short delay off the request thread (preserved from the old Pond,
  # REWRITE_PLAN §12.2). The pending write is generation-guarded so clear/newer-set operations win.
  schedule_destination_write(destination)


def schedule_destination_write(destination):
  global _pending_destination_generation, _pending_destination_timer

  with _pending_destination_lock:
    _pending_destination_generation += 1
    generation = _pending_destination_generation
    timer_to_cancel = _pending_destination_timer
    params.remove(NAV_DESTINATION_KEY)
    timer = threading.Timer(SET_DESTINATION_DELAY_SECONDS, write_destination_if_current, args=(generation, destination))
    _pending_destination_timer = timer

  timer.daemon = True
  cancel_timer(timer_to_cancel)
  timer.start()


def cancel_timer(timer):
  cancel = getattr(timer, "cancel", None)
  if cancel is not None:
    cancel()


def write_destination_if_current(generation, destination):
  global _pending_destination_timer

  with _pending_destination_lock:
    if generation != _pending_destination_generation:
      return

    _pending_destination_timer = None
    params.put(NAV_DESTINATION_KEY, destination)


def store_favorites(favorites):
  params.put(FAVORITE_DESTINATIONS_KEY, json.dumps(favorites))
