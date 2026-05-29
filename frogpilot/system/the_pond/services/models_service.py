#!/usr/bin/env python3
from dataclasses import asdict, dataclass

# Import a frogpilot module that already loads system.sentry before frogpilot_variables: a cold import of
# frogpilot_variables (directly or transitively via model_manager) raises unless sentry is loaded first, so
# this import must lead (CONVENTIONS §0, matches services/recordings_service.py importing frogpilot_utilities).
from openpilot.frogpilot.common.frogpilot_utilities import delete_file, run_thread_with_lock
from openpilot.frogpilot.common.frogpilot_variables import (
  DEFAULT_MODEL,
  MODELS_PATH,
  TINYGRAD_FILES,
  params,
  params_default,
  params_memory,
  update_frogpilot_toggles,
)
from openpilot.frogpilot.assets.model_manager import (
  CANCEL_DOWNLOAD_PARAM,
  DOWNLOAD_PROGRESS_PARAM,
  MODEL_DOWNLOAD_ALL_PARAM,
  MODEL_DOWNLOAD_PARAM,
  ModelManager,
)
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError

# The lock names run_thread_with_lock pre-declares for the two model downloads; any other name raises
# KeyError, so the dispatch must use exactly these (catalog "Models (B14)").
DOWNLOAD_ALL_LOCK = "download_all_models"
DOWNLOAD_MODEL_LOCK = "download_model"

# The boolean preferences the model panel persists to the user params backend. Stored as "0"/"1" strings
# the way every FrogPilot toggle is; the panel reads them with getBool (frogpilot/ui/qt/offroad/model_settings.cc:53,56).
BOOLEAN_PREFERENCE_KEYS = ("AutomaticallyDownloadModels", "ModelRandomizer")

# The persistent param holding the user's selected model key. The running stack stores it with a "_default"
# suffix while it is still the shipped default, so it is stripped for display/comparison exactly as
# normalizeModelKey does (model_settings.cc:19-25, model_manager.py:71).
SELECTED_MODEL_KEY = "Model"


@dataclass(frozen=True)
class Model:
  installed: bool
  is_default: bool
  is_selected: bool
  key: str
  name: str
  version: str


def catalog():
  return [asdict(model) for model in catalog_models()]


def cancel():
  # The download threads poll CancelModelDownload between files and unwind cleanly when it is set
  # (model_manager.py:168, 203). Setting the flag is the whole action; the response returns immediately.
  params_memory.put_bool(CANCEL_DOWNLOAD_PARAM, True)


def delete(key):
  model_key = require_catalog_key(key)

  if model_key == selected_model_key():
    raise ApiError("Cannot delete the model that is currently selected", 409)

  if model_key == default_model_key():
    raise ApiError("Cannot delete the default model", 409)

  removed = remove_model_files(model_key)
  if not removed:
    raise ApiError("Model is not downloaded", 404)


def download(key):
  model_key = require_catalog_key(key)
  if is_downloaded(model_key):
    raise ApiError("Model is already downloaded", 409)

  # Mirror the panel's trigger order: stamp the request key and the initial progress text the status
  # poller surfaces, then hand the blocking download to its pre-declared lock so the request never blocks
  # on network I/O (model_settings.cc:149-150, catalog "Models (B14)").
  params_memory.put(MODEL_DOWNLOAD_PARAM, model_key)
  params_memory.put(DOWNLOAD_PROGRESS_PARAM, "Downloading...")
  params_memory.put_bool(CANCEL_DOWNLOAD_PARAM, False)

  run_thread_with_lock(DOWNLOAD_MODEL_LOCK, manager().download_model, args=(model_key,))


def download_all():
  if all_downloaded():
    raise ApiError("All models are already downloaded", 409)

  # download_all_models reads DownloadAllModels/ModelDownloadProgress and clears DownloadAllModels when it
  # finishes (model_manager.py:159-185); set them up front the way the panel does (model_settings.cc:167-168).
  params_memory.put_bool(MODEL_DOWNLOAD_ALL_PARAM, True)
  params_memory.put(DOWNLOAD_PROGRESS_PARAM, "Downloading...")
  params_memory.put_bool(CANCEL_DOWNLOAD_PARAM, False)

  run_thread_with_lock(DOWNLOAD_ALL_LOCK, manager().download_all_models)


def installed():
  return [asdict(model) for model in catalog_models() if model.installed]


def preferences():
  return {
    **{key: params.get_bool(key) for key in BOOLEAN_PREFERENCE_KEYS},
    "selected_model": selected_model_key(),
  }


def refresh_manifest():
  # update_models re-fetches model_names_v17.json and rewrites the AvailableModels* params; every request
  # inside it is bounded by a 10s timeout (model_manager.py:325,338,364), so it runs inline and returns the
  # freshly-stored catalog rather than dispatching to a lock that does not exist for a manifest refresh.
  manager().update_models(boot_run=False)

  return catalog()


def status():
  return {
    "download_all_active": params_memory.get_bool(MODEL_DOWNLOAD_ALL_PARAM),
    "downloading_model": (params_memory.get(MODEL_DOWNLOAD_PARAM, encoding="utf-8") or "") or None,
    "progress": (params_memory.get(DOWNLOAD_PROGRESS_PARAM, encoding="utf-8") or "") or None,
  }


def update_preferences(values):
  if not isinstance(values, dict) or not values:
    raise ApiError("No preferences provided", 400)

  # Validate every key before writing any, so a malformed key in a mixed body never leaves a partial write.
  for key, value in values.items():
    if key in BOOLEAN_PREFERENCE_KEYS:
      if not isinstance(value, bool):
        raise ApiError(f"'{key}' must be a boolean", 400)
    elif key == "selected_model":
      validate_model_selection(value)
    else:
      raise ApiError(f"Unknown preference '{key}'", 400)

  for key, value in values.items():
    if key == "selected_model":
      params.put(SELECTED_MODEL_KEY, value)
    else:
      params.put_bool(key, value)

  # The running stack only recomputes its toggle snapshot when this flag flips, so a written preference is
  # otherwise ignored until the next boot (catalog: call update_frogpilot_toggles after a change).
  update_frogpilot_toggles()

  return preferences()


def all_downloaded():
  # An empty manifest counts as "nothing left to download" so download_all never arms a bulk download with
  # no model to fetch; all() is already vacuously True for [], so no separate empty guard is needed.
  return all(model.installed for model in catalog_models())


def catalog_models():
  keys = csv_param("AvailableModels")
  names = csv_param("AvailableModelNames")
  versions = csv_param("ModelVersions")

  selected = selected_model_key()
  default = default_model_key()

  models = []
  for index, key in enumerate(keys):
    if not key:
      continue

    models.append(
      Model(
        installed=is_downloaded(key),
        is_default=key == default,
        is_selected=key == selected,
        key=key,
        name=names[index] if index < len(names) else key,
        version=versions[index] if index < len(versions) else "",
      )
    )

  return models


def csv_param(name):
  raw = params.get(name, encoding="utf-8") or ""
  return [part for part in raw.split(",") if part]


def default_model_key():
  return normalize_model_key(params_default.get(SELECTED_MODEL_KEY, encoding="utf-8") or DEFAULT_MODEL)


def is_downloaded(key):
  # A model is downloaded when its single compiled file exists or when every tinygrad part file does,
  # matching the panel's hasAllTinygradFiles / "{key}.thneed" check (model_settings.cc:3-17,141).
  if (MODELS_PATH / f"{key}.thneed").is_file():
    return True

  return all((MODELS_PATH / f"{key}_{filename}").is_file() for filename, _ in TINYGRAD_FILES)


def manager():
  return ModelManager()


def normalize_model_key(key):
  return key.lower().removesuffix("_default")


def remove_model_files(key):
  removed = False

  single = MODELS_PATH / f"{key}.thneed"
  if single.is_file():
    delete_file(str(single))
    removed = True

  for filename, _ in TINYGRAD_FILES:
    part = MODELS_PATH / f"{key}_{filename}"
    if part.is_file():
      delete_file(str(part))
      removed = True

  return removed


def require_catalog_key(key):
  if not key:
    raise ApiError("A model key is required", 400)

  if key not in {model.key for model in catalog_models()}:
    raise ApiError("Unknown model", 404)

  return key


def validate_model_selection(key):
  if not isinstance(key, str) or not key:
    raise ApiError("'selected_model' must be a model key", 400)

  model_key = require_catalog_key(key)
  if model_key != default_model_key() and not is_downloaded(model_key):
    raise ApiError("Model must be downloaded before it can be selected", 409)


def selected_model_key():
  return normalize_model_key(params.get(SELECTED_MODEL_KEY, encoding="utf-8") or DEFAULT_MODEL)
