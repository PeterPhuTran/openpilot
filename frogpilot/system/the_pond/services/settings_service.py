#!/usr/bin/env python3
import math

from dataclasses import asdict

import openpilot.system.sentry as sentry  # noqa: F401

from openpilot.frogpilot.common.frogpilot_variables import frogpilot_default_params, params, params_default, update_frogpilot_toggles
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.ui.layouts.settings import toggle_metadata

# The on-device FrogPilot panel: 6 categories, each opening sub-panels, mirrored from
# frogpilot_settings.cc:79-95 (the live UI). Each sub-panel pairs its display name with the *_TOGGLES
# group in toggle_metadata.py that backs it. Sub-panels the C++ shows that have no toggle group there
# (Map Data, Data) are surfaced by other Pond views, so they are not part of the settings schema
# (TOGGLE_PARITY_REPORT §A/§G). Order matches the C++ panelInfo/panelButtons ordering, not alphabetical.
SETTINGS_CATEGORIES = (
  ("Alerts and Sounds", (("Manage", "ALERTS_AND_SOUNDS_TOGGLES"),)),
  ("Driving Controls", (("Driving Model", "DRIVING_MODEL_TOGGLES"), ("Gas / Brake", "GAS_BRAKE_TOGGLES"), ("Steering", "STEERING_TOGGLES"))),
  ("Navigation", (("Navigation", "NAVIGATION_TOGGLES"),)),
  ("System Settings", (("Device Controls", "DEVICE_CONTROLS_TOGGLES"), ("Utilities", "UTILITIES_TOGGLES"))),
  ("Theme and Appearance", (("Appearance", "APPEARANCE_TOGGLES"), ("Theme", "THEME_TOGGLES"))),
  ("Vehicle Settings", (("Vehicle Settings", "VEHICLE_SETTINGS_TOGGLES"), ("Wheel Controls", "WHEEL_CONTROLS_TOGGLES"))),
)

# Toggle types whose stored value is a number constrained by min/max (and any value_map sentinels).
NUMERIC_TOGGLE_TYPES = frozenset(
  {
    toggle_metadata.ToggleType.NUMERIC.value,
    toggle_metadata.ToggleType.NUMERIC_WITH_BUTTON.value,
  }
)

# Toggle types this endpoint can write a value for: booleans (toggle_type None) and manage toggles store
# "0"/"1"; numeric and button_param have their own validators; multi_button and button_toggle carry a
# free string (provider, index, or JSON selection). Plain buttons (actions) and labels (read-only) are
# excluded, so a PUT against them is rejected rather than storing a meaningless value.
WRITABLE_TOGGLE_TYPES = frozenset(
  {
    None,
    toggle_metadata.ToggleType.BOOLEAN.value,
    toggle_metadata.ToggleType.BUTTON_PARAM.value,
    toggle_metadata.ToggleType.BUTTON_TOGGLE.value,
    toggle_metadata.ToggleType.MANAGE.value,
    toggle_metadata.ToggleType.MULTI_BUTTON.value,
    toggle_metadata.ToggleType.NUMERIC.value,
    toggle_metadata.ToggleType.NUMERIC_WITH_BUTTON.value,
  }
)

# Provider keys are managed by the dedicated Navigation API Keys workflow. The generic settings schema
# must not render or mutate them, and current/default value reads must not expose raw key material.
SENSITIVE_SETTING_PARAMS = frozenset({"AMapKey1", "AMapKey2", "MapboxPublicKey", "MapboxSecretKey"})

# Some legacy toggle dependencies still key off the underlying Mapbox secret param. Keep a sanitized
# "1"/"0" availability flag in the current-values envelope so dependent rows can remain accurate without
# leaking the secret or rendering the key as a generic settings control.
SENSITIVE_DEPENDENCY_PARAMS = frozenset({"MapboxSecretKey"})


def build_schema():
  # Mirror the on-device FrogPilot panel structure (Tuning Level + 6 categories -> sub-panels), serving
  # the orphaned toggle_metadata.py module as the single schema source (REWRITE_PLAN §4.2, §9-B7). The
  # category -> sub-panel -> *_TOGGLES mapping comes from frogpilot_settings.cc:79-95; sub-panels with no
  # toggle group there (Map Data, Data) are handled by other Pond views, so they are not settings panels.
  categories = []
  for category_name, sub_panels in SETTINGS_CATEGORIES:
    serialized_panels = []
    for panel_name, section_name in sub_panels:
      toggles = [serialize_toggle(toggle) for toggle in getattr(toggle_metadata, section_name) if is_visible_settings_toggle(toggle)]
      serialized_panels.append({"name": panel_name, "toggles": toggles})

    categories.append({"name": category_name, "sub_panels": serialized_panels})

  return {"tuning_level": serialize_toggle(toggle_metadata.TUNING_LEVEL_TOGGLE), "categories": categories}


def current_values():
  # Raw current value of every schema param so the frontend can populate its controls. params.get returns
  # the persisted string, or None when the key was never written; we surface None rather than guessing a
  # default (the defaults endpoint is the separate source for that).
  values = {}
  for param in schema_params():
    values[param] = sensitive_dependency_value(param) if param in SENSITIVE_DEPENDENCY_PARAMS else read_param(param)

  return values


def default_values():
  # The default each schema param falls back to, taken from frogpilot_default_params (the same source
  # FrogPilotVariables seeds params_default from). Read params_default first so a running device reflects
  # any computed-at-import defaults, falling back to the static registry value off-device.
  registry = registry_defaults()

  defaults = {}
  for param in schema_params():
    if param in SENSITIVE_DEPENDENCY_PARAMS:
      defaults[param] = "0"
    else:
      stored_default = read_default(param)
      defaults[param] = stored_default if stored_default is not None else registry.get(param)

  return defaults


def put_value(key, value):
  if not key:
    raise ApiError("A param 'key' is required", 400)

  toggle = schema_toggles().get(key)
  if toggle is None:
    # Hide unknown/unmapped params instead of guessing how to validate or store them (REWRITE_PLAN §13).
    raise ApiError("Unknown setting", 404)

  stored_value = validate_value(toggle, value)
  previous_value = read_param(key)

  params.put(key, stored_value)

  # Signal the running system to recompute its live toggles now that a persisted param changed.
  try:
    update_frogpilot_toggles()
  except Exception as error:
    rollback_param(key, previous_value)
    raise ApiError("Couldn't apply setting change; the previous value was restored", 500) from error


def rollback_param(key, previous_value):
  try:
    if previous_value is None:
      params.remove(key)
    else:
      params.put(key, previous_value)
  except Exception as error:
    print(f"Could not roll back setting {key}: {error}")


def read_default(param):
  try:
    return params_default.get(param, encoding="utf-8")
  except Exception as error:
    print(f"Skipping unreadable default for {param}: {error}")
    return None


def read_param(param):
  try:
    return params.get(param, encoding="utf-8")
  except Exception as error:
    print(f"Skipping unreadable param {param}: {error}")
    return None


def registry_defaults():
  return {key: decode_default(default_value) for key, default_value, _, _ in frogpilot_default_params}


def decode_default(default_value):
  return default_value.decode("utf-8") if isinstance(default_value, bytes) else default_value


def schema_params():
  return list(schema_toggles().keys()) + sorted(param for param in SENSITIVE_DEPENDENCY_PARAMS if param not in schema_toggles())


def schema_toggles():
  # Every toggle the schema exposes, keyed by param. Built from the same sections build_schema() serves,
  # so the value/default/write endpoints stay in lock-step with the served structure.
  toggles = {}
  for _, sub_panels in SETTINGS_CATEGORIES:
    for _, section_name in sub_panels:
      for toggle in getattr(toggle_metadata, section_name):
        if is_visible_settings_toggle(toggle):
          toggles[toggle.param] = toggle

  toggles[toggle_metadata.TUNING_LEVEL_TOGGLE.param] = toggle_metadata.TUNING_LEVEL_TOGGLE

  return toggles


def is_visible_settings_toggle(toggle):
  return toggle.param not in SENSITIVE_SETTING_PARAMS


def serialize_toggle(toggle):
  # Drop unset fields so the payload only carries what a control actually needs, and lower the enum to its
  # string value so the frontend can switch on it directly.
  serialized = {field: value for field, value in asdict(toggle).items() if value is not None}

  toggle_type = serialized.get("toggle_type")
  if toggle_type is not None:
    serialized["toggle_type"] = toggle_type.value

  # value_map keys are ints; JSON object keys must be strings, so normalize while keeping insertion order.
  value_map = serialized.get("value_map")
  if value_map is not None:
    serialized["value_map"] = {str(key): label for key, label in value_map.items()}

  return serialized


def toggle_type_value(toggle):
  return toggle.toggle_type.value if toggle.toggle_type is not None else None


def validate_value(toggle, value):
  if value is None:
    raise ApiError("A 'value' is required", 400)

  toggle_type = toggle_type_value(toggle)

  if toggle_type in NUMERIC_TOGGLE_TYPES:
    return validate_numeric(toggle, value)

  if toggle_type == toggle_metadata.ToggleType.BUTTON_PARAM.value:
    return validate_button_param(toggle, value)

  if toggle_type not in WRITABLE_TOGGLE_TYPES:
    # Labels are read-only and plain action buttons have no stored value, so writing them is rejected
    # rather than silently storing a meaningless string (REWRITE_PLAN §13).
    raise ApiError("This setting is not directly writable", 400)

  if toggle_type is None or toggle_type in (
    toggle_metadata.ToggleType.BOOLEAN.value,
    toggle_metadata.ToggleType.MANAGE.value,
  ):
    return validate_boolean(value)

  # Compound controls (multi_button / button_toggle) carry provider, index, or JSON selection state that
  # the frontend builds; store the caller's string verbatim after confirming it is a string.
  return validate_string(value)


def validate_boolean(value):
  if isinstance(value, bool):
    return "1" if value else "0"

  if value in (0, 1):
    # Normalize via the matched int so a numeric 1 / 1.0 stores the canonical "1" (not "1.0"); on device
    # Params.getBool is get(key) == "1", so a "1.0" would read back as False (params.h:44).
    return "1" if value else "0"

  if value in ("0", "1"):
    return value

  raise ApiError("This setting expects a boolean value", 400)


def validate_button_param(toggle, value):
  options = toggle.button_options or []

  if isinstance(value, bool):
    raise ApiError("This setting expects an option index", 400)

  if isinstance(value, int):
    index = value
  elif isinstance(value, str) and value.strip().lstrip("-").isdigit():
    index = int(value)
  else:
    raise ApiError("This setting expects an option index", 400) from None

  if not 0 <= index < len(options):
    raise ApiError("Option index out of range", 400)

  return str(index)


def validate_numeric(toggle, value):
  try:
    numeric_value = float(value)
  except (TypeError, ValueError):
    raise ApiError("This setting expects a number", 400) from None

  if not math.isfinite(numeric_value):
    raise ApiError("This setting expects a finite number", 400)

  # value_map keys are discrete sentinels (e.g. "Auto", "Off") that may sit outside the slider range, so
  # they are accepted even when they fall beyond min/max.
  if toggle.value_map is not None and numeric_value in toggle.value_map:
    return format_numeric(numeric_value)

  if toggle.min_value is not None and numeric_value < toggle.min_value:
    raise ApiError("Value below the allowed minimum", 400)

  if toggle.max_value is not None and numeric_value > toggle.max_value:
    raise ApiError("Value above the allowed maximum", 400)

  return format_numeric(numeric_value)


def format_numeric(numeric_value):
  # Store whole numbers without a trailing ".0" to match how the params are seeded ("2", not "2.0"),
  # keeping a round-trip read of an unchanged value byte-identical.
  if numeric_value.is_integer():
    return str(int(numeric_value))

  return repr(numeric_value)


def validate_string(value):
  if not isinstance(value, str):
    raise ApiError("This setting expects a string value", 400)

  return value


def sensitive_dependency_value(param):
  return "1" if read_param(param) else "0"
