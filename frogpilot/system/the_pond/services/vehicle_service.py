#!/usr/bin/env python3
# Import sentry first to break the latent frogpilot_variables -> car_helpers -> sentry -> frogpilot_variables
# cycle: a cold import of frogpilot_variables (directly or via the cereal/selfdrive car stack below) raises
# unless sentry is loaded first, so this side-effect import must lead (CONVENTIONS §0, matches lib/onroad.py).
import openpilot.system.sentry as sentry  # noqa: F401

from cereal import car, custom
from openpilot.selfdrive.car.values import PLATFORMS

from openpilot.frogpilot.common.frogpilot_variables import get_frogpilot_toggles, params, update_frogpilot_toggles
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError

# Brands that are not user-selectable vehicles: the comma body robot and the MOCK fingerprint used as the
# offroad fallback. They carry no CarDocs a driver would force, so they are excluded from the make/model
# lists (verified: selfdrive/car/values.py BRANDS includes BODY and MOCK alongside the real makes).
NON_VEHICLE_PLATFORM_PREFIXES = ("BODY", "MOCK")

# Makes (CarDocs.make, casefolded) that are not user-selectable vehicles. The platform-prefix filter above
# misses the comma body (platform COMMA_BODY, make "comma") and the mock fallback, so they are dropped by
# make as well — a driver can never force a non-vehicle brand.
NON_VEHICLE_MAKES = {"body", "comma", "mock"}


def car_features_check():
  # Render the same detected capabilities the on-device Vehicle panel shows, read from the persisted
  # CarParams the last drive wrote. With no CarParams yet (fresh install / never driven) every field is
  # reported as not-detected rather than erroring, matching the C++ panel's empty-blob branch
  # (frogpilot/ui/qt/offroad/frogpilot_settings.cc:289-290, vehicle_settings.cc:362-373).
  car_params = read_car_params()
  frogpilot_car_params = read_frogpilot_car_params()

  if car_params is None:
    return empty_features()

  car_make = car_params.carName
  car_fingerprint = car_params.carFingerprint
  safety_model = car_params.safetyConfigs[0].safetyModel if len(car_params.safetyConfigs) else None

  return {
    "blindSpotSupport": car_params.enableBsm,
    "carFingerprint": car_fingerprint,
    "carMake": car_make,
    "carModelName": params.get("CarModelName", encoding="utf-8") or "",
    "detectedHardware": detected_hardware(car_params, frogpilot_car_params),
    "openpilotLongitudinalSupport": car_params.openpilotLongitudinalControl,
    "pedalSupport": bool(frogpilot_car_params.canUsePedal) if frogpilot_car_params is not None else False,
    "radarSupport": not car_params.radarUnavailable,
    "sdsuSupport": bool(frogpilot_car_params.canUseSDSU) if frogpilot_car_params is not None else False,
    "stopAndGoSupport": car_params.autoResumeSng,
    # The make/safety facts the C++ panel uses to gate brand-specific features, surfaced so the view can
    # show which tuning tweaks apply without re-deriving the rules client-side.
    "isGM": car_make == "gm",
    "isHKG": car_make == "hyundai",
    "isHKGCanFd": car_make == "hyundai" and safety_model == car.CarParams.SafetyModel.hyundaiCanfd,
    "isHonda": car_make == "honda",
    "isHondaNidec": car_make == "honda" and safety_model == car.CarParams.SafetyModel.hondaNidec,
    "isSubaru": car_make == "subaru",
    "isToyota": car_make == "toyota",
    "isVolt": car_fingerprint == "CHEVROLET_VOLT",
  }


def clear_fingerprint():
  # Mirror the C++ "automatic detection on" state: turn the force flag off and clear the stored make/model
  # so the next drive re-fingerprints normally (frogpilot_variables.py:843 gates force_fingerprint on a set
  # car_model, so clearing CarModel alone already disables it; we clear all three for a clean slate).
  params.put_bool("ForceFingerprint", False)
  for key in ("CarMake", "CarModel", "CarModelName"):
    params.remove(key)

  update_frogpilot_toggles()


def detected_hardware(car_params, frogpilot_car_params):
  # The "3rd Party Hardware Detected" list from the C++ panel: comma pedal, SDSU, and ZSS
  # (vehicle_settings.cc:363-366). The pedal is a CarParams gas-interceptor flag; SDSU is a
  # FrogPilotCarParams capability; ZSS is only a FrogPilot fpFlag, decoded once into the live toggles
  # JSON (frogpilot_variables.py:617-619), so it is read from there via the cheap get_frogpilot_toggles path.
  hardware = []
  if car_params.enableGasInterceptor:
    hardware.append("comma Pedal")
  if frogpilot_car_params is not None and frogpilot_car_params.canUseSDSU:
    hardware.append("SDSU")
  if getattr(get_frogpilot_toggles(), "has_zss", False):
    hardware.append("ZSS")

  return hardware


def empty_features():
  return {
    "blindSpotSupport": False,
    "carFingerprint": "",
    "carMake": "",
    "carModelName": params.get("CarModelName", encoding="utf-8") or "",
    "detectedHardware": [],
    "openpilotLongitudinalSupport": False,
    "pedalSupport": False,
    "radarSupport": False,
    "sdsuSupport": False,
    "stopAndGoSupport": False,
    "isGM": False,
    "isHKG": False,
    "isHKGCanFd": False,
    "isHonda": False,
    "isHondaNidec": False,
    "isSubaru": False,
    "isToyota": False,
    "isVolt": False,
  }


def fingerprint_makes():
  # Every distinct vehicle make a driver can force, taken from the structured CarDocs in PLATFORMS rather
  # than regex-scraping values.py the way the C++ panel does (vehicle_settings.cc:38-77). CarDocs.make is
  # set in CarDocs.__post_init__ via split_name, so no heavy get_params call is needed to read it.
  makes = set()
  for platform in PLATFORMS.values():
    if is_non_vehicle_platform(platform):
      continue

    for car_docs in platform.config.car_docs:
      # Also exclude by make, not just platform prefix: the comma body's platform is not BODY-prefixed
      # (e.g. COMMA_BODY) yet its CarDocs.make is "comma", so a prefix-only filter let it leak into the
      # make list. The make is the user-visible brand, so a non-vehicle make can never be a real choice.
      if car_docs.make.casefold() in NON_VEHICLE_MAKES:
        continue

      makes.add(car_docs.make)

  return sorted(makes)


def fingerprint_models(make):
  # The models for one make: each entry pairs the human-readable name the UI shows with the platform key
  # that becomes CarModel. Mirrors the C++ make->model selection (vehicle_settings.cc:117-125), but keyed
  # off CarDocs.make so the match is exact rather than a first-word heuristic.
  normalized_make = make.strip()
  if not normalized_make:
    raise ApiError("A car make is required", 400)
  if normalized_make.casefold() in NON_VEHICLE_MAKES:
    raise ApiError("Unknown car make", 404)

  models = []
  seen_names = set()
  for platform in PLATFORMS.values():
    if is_non_vehicle_platform(platform):
      continue

    for car_docs in platform.config.car_docs:
      if car_docs.make.casefold() != normalized_make.casefold():
        continue
      if car_docs.name in seen_names:
        continue

      seen_names.add(car_docs.name)
      models.append({"name": car_docs.name, "platform": str(platform)})

  if not models:
    raise ApiError("Unknown car make", 404)

  models.sort(key=lambda model: model["name"].casefold())

  return models


def is_non_vehicle_platform(platform):
  return str(platform).startswith(NON_VEHICLE_PLATFORM_PREFIXES)


def read_car_params():
  raw = params.get("CarParamsPersistent")
  if not raw:
    return None

  with car.CarParams.from_bytes(raw) as car_params:
    return car_params.as_builder()


def read_frogpilot_car_params():
  raw = params.get("FrogPilotCarParamsPersistent")
  if not raw:
    return None

  with custom.FrogPilotCarParams.from_bytes(raw) as frogpilot_car_params:
    return frogpilot_car_params.as_builder()


def set_fingerprint(make, platform, name):
  # Force the selected fingerprint: persist the make/model the driver picked and flip ForceFingerprint on
  # so detection is locked to it (vehicle_settings.cc:111-129; frogpilot_variables.py:843 only honors the
  # force flag once CarModel is set). The platform key must be a real vehicle platform, never an arbitrary
  # string, so a typo cannot write a fingerprint the car stack will reject.
  normalized_make = make.strip()
  normalized_platform = platform.strip()
  normalized_name = name.strip()
  if not normalized_make or not normalized_platform or not normalized_name:
    raise ApiError("make, model, and name are required", 400)

  if normalized_platform not in PLATFORMS or is_non_vehicle_platform(PLATFORMS[normalized_platform]):
    raise ApiError("Unknown car model", 404)

  params.put("CarMake", normalized_make)
  params.put("CarModel", normalized_platform)
  params.put("CarModelName", normalized_name)
  params.put_bool("ForceFingerprint", True)

  update_frogpilot_toggles()
