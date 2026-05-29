#!/usr/bin/env python3
import base64
import io
import json
import re
import shutil
import subprocess
import zipfile

from dataclasses import asdict, dataclass
from pathlib import Path
from tempfile import mkdtemp
from uuid import uuid4

from PIL import Image
from pydub import AudioSegment

import openpilot.system.sentry as sentry

from openpilot.frogpilot.assets.theme_manager import HOLIDAY_THEME_PATH, THEME_COMPONENT_PARAMS, ThemeManager
from openpilot.frogpilot.common.frogpilot_utilities import delete_file, run_thread_with_lock
from openpilot.frogpilot.common.frogpilot_variables import (
  ACTIVE_THEME_PATH,
  FROGPILOT_API,
  THEME_SAVE_PATH,
  get_frogpilot_toggles,
  params,
  params_memory,
  update_frogpilot_toggles,
)
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.ffmpeg import run_ffmpeg
from openpilot.frogpilot.system.the_pond.lib.paths import safe_join, safe_name

# Theme constants live in this service, not the shared config.py: themes are the only consumer (the B3
# video extensions are shared, these are not). The wav format mirrors utilities.covert_audio exactly so
# the runtime can play each alert (frogpilot/ui/qt/offroad/sounds_settings.cc:5).
AUDIO_TARGET_CHANNELS = 1
AUDIO_TARGET_CODEC = "pcm_s16le"
AUDIO_TARGET_SAMPLE_RATE = 48000

# The 7 color keys the runtime parser reads from colors.json (frogpilot/ui/qt/widgets/frogpilot_controls.cc
# loadThemeColors callers); a colors.json is written with exactly these keys so an unknown picker value
# can never reach the renderer.
COLOR_KEYS = ("LaneLines", "LeadMarker", "Path", "PathEdge", "Sidebar1", "Sidebar2", "Sidebar3")

DISTANCE_ICON_NAMES = ("aggressive", "relaxed", "standard", "traffic")

# fps for the GIF palettegen+paletteuse resize, carried over from utilities.create_theme (REWRITE_PLAN §12.1).
GIF_PALETTE_FPS = 20

# Target pixel dimensions per icon, from REWRITE_PLAN §12.1: home button 250x250, settings button 169x104.
ICON_DIMENSIONS = {
  "homeButton": (250, 250),
  "settingsButton": (169, 104),
}

# Real-byte upload cap (the old content_length check was broken; we measure the actual stream length).
MAX_THEME_FILE_BYTES = 5 * 1024 * 1024

SOUND_NAMES = ("disengage", "engage", "prompt", "startup")
STEERING_WHEEL_DIMENSIONS = (250, 250)

THEME_DOWNLOAD_PROGRESS_PARAM = "ThemeDownloadProgress"

# Ceiling per FrogPilot API call during submit, so a slow/hung endpoint releases the worker thread
# (CONVENTIONS §6). The zips are small (a single theme component), so this only trips on a stuck server.
THEME_SUBMIT_TIMEOUT_SECONDS = 30

TURN_SIGNAL_LENGTH_MAX_MS = 1000
TURN_SIGNAL_LENGTH_MIN_MS = 25
TURN_SIGNAL_STYLES = ("Static", "Traditional")

USER_CREATED_SUFFIX = "-user_created"

# The active theme's own assets, addressed by this sentinel instead of a theme name so the editor can
# fetch them back through the same asset route used for stored themes (REWRITE_PLAN §12.1).
ACTIVE_THEME_NAME = "__active__"

# The Manage modal's tab names differ from the THEME_COMPONENT_PARAMS keys for two components, so the
# download request maps the tab to the on-disk component before looking up its params_memory key.
TAB_TO_COMPONENT = {
  "steering_wheel": "steering_wheels",
  "turn_signals": "signals",
}

# Non-GIF uploads are coerced to PNG so the runtime always finds a decodable still under ACTIVE_THEME_PATH.
PNG_SUFFIX = ".png"

# requests is imported lazily inside submit_theme so the import cost never touches the editor/apply paths,
# which are the common case and do not reach the network.


@dataclass(frozen=True)
class ThemeSummary:
  has_colors: bool
  has_distance_icons: bool
  has_icons: bool
  has_sounds: bool
  has_steering_wheel: bool
  has_turn_signals: bool
  is_user_created: bool
  name: str
  path: str
  type: str


def apply_theme(form, files):
  # Build the selected components into a persistent applied-theme directory, then repoint
  # ACTIVE_THEME_PATH at them by symlink. The runtime reads colors/distance_icons/icons/sounds/signals/
  # steering_wheel straight out of ACTIVE_THEME_PATH (frogpilot/ui/qt/widgets/frogpilot_controls.cc:77,
  # .../frogpilot_buttons.cc:29-32, .../frogpilot_annotated_camera.cc:58), so the symlink swap is what
  # makes a theme take effect. The build dir must persist (the active symlinks point into it), so it
  # lives under THEME_SAVE_PATH and is rebuilt each apply rather than in a temp dir (REWRITE_PLAN §12.1).
  checklist = parse_checklist(form)
  if not any(checklist.values()):
    raise ApiError("Select at least one component to apply", 400)

  build_root = applied_theme_dir()
  theme_path = build_theme(form, files, build_root, checklist, persist_steering_wheel=False)
  if theme_path is None:
    raise ApiError("No theme components were built", 400)

  for component in ("colors", "distance_icons", "icons", "signals", "sounds", "steering_wheel"):
    source = theme_path / component
    if checklist.get(checklist_key(component)) and source.is_dir():
      relink_active_component(component, source)

  params.put_bool("PersonalizeOpenpilot", True)
  params_memory.put_bool("UseActiveTheme", True)
  update_frogpilot_toggles()


def asset_file(theme, relative_path, theme_type):
  base = asset_base_dir(theme, theme_type)

  target = safe_join(base, relative_path)
  if not target.is_file():
    raise ApiError("Asset not found", 404)

  return target


def asset_base_dir(theme, theme_type):
  if theme == ACTIVE_THEME_NAME:
    return Path(ACTIVE_THEME_PATH)

  if theme_type == "holiday":
    return holiday_theme_dir(theme)

  if theme_type == "steering_wheel":
    return THEME_SAVE_PATH / "steering_wheels"

  return THEME_SAVE_PATH / "theme_packs" / safe_name(theme)


def build_theme(form, files, base_root, checklist, persist_steering_wheel):
  # Returns the assembled theme directory, or None when nothing was selected. Mirrors
  # utilities.create_theme's section-by-section assembly (REWRITE_PLAN §12.1) but writes into base_root.
  # persist_steering_wheel=True is the Save path: the wheel is stored under THEME_SAVE_PATH/steering_wheels
  # keyed by the theme name. False (apply/download/submit) keeps the wheel inside the built theme dir.
  theme_name = (form.get("themeName") or "").strip()
  needs_pack = any(checklist.get(key) for key in ("colors", "distance_icons", "icons", "sounds", "turn_signals"))
  needs_wheel_in_pack = bool(checklist.get("steering_wheel")) and not persist_steering_wheel

  sane_name = safe_name(theme_name.replace(" ", "_")) if theme_name else f"theme_{uuid4().hex[:8]}"

  theme_path = (base_root / f"{sane_name}{USER_CREATED_SUFFIX}") if (needs_pack or needs_wheel_in_pack) else None
  if theme_path is not None:
    theme_path.mkdir(parents=True, exist_ok=True)

  if checklist.get("colors") and theme_path is not None:
    write_colors(theme_path, form.get("colors"))

  if checklist.get("turn_signals") and theme_path is not None:
    write_turn_signals(theme_path, form, files)

  if checklist.get("icons") and theme_path is not None:
    write_icons(theme_path, files)

  if checklist.get("distance_icons") and theme_path is not None:
    write_distance_icons(theme_path, files)

  if checklist.get("sounds") and theme_path is not None:
    write_sounds(theme_path, files)

  if checklist.get("steering_wheel"):
    write_steering_wheel(sane_name, files, theme_path, persist=persist_steering_wheel)

  return theme_path


def build_theme_summaries():
  summaries = {}

  packs_dir = THEME_SAVE_PATH / "theme_packs"
  if packs_dir.is_dir():
    for pack in sorted(packs_dir.iterdir()):
      if not pack.is_dir():
        continue
      summaries[pack.name] = pack_summary(pack)

  wheels_dir = THEME_SAVE_PATH / "steering_wheels"
  if wheels_dir.is_dir():
    for wheel in sorted(wheels_dir.iterdir()):
      if not wheel.is_file():
        continue
      key = f"steering_wheel:{wheel.stem}"
      summaries[key] = wheel_summary(wheel)

  if Path(HOLIDAY_THEME_PATH).is_dir():
    for holiday in sorted(Path(HOLIDAY_THEME_PATH).iterdir()):
      if not holiday.is_dir():
        continue
      summaries[f"holiday:{holiday.name}"] = holiday_summary(holiday)

  return [asdict(summary) for summary in summaries.values()]


def checklist_key(component):
  return "turn_signals" if component == "signals" else component


def applied_theme_dir():
  # A unique persistent build dir per Apply, under THEME_SAVE_PATH so it survives reboots like the rest of
  # the theme store. A fresh dir each time (mirroring the old create_theme(temporary=True) token_hex dir)
  # is what lets a partial apply work: components the user did NOT re-apply keep their existing valid
  # symlink into an earlier build dir, while the re-applied ones repoint into this one. Older build dirs
  # are pruned so the store does not grow unbounded.
  applied_root = THEME_SAVE_PATH / "the_pond_applied"
  applied_root.mkdir(parents=True, exist_ok=True)

  prune_applied_dirs(applied_root)

  directory = applied_root / uuid4().hex
  directory.mkdir(parents=True, exist_ok=True)
  return directory


def prune_applied_dirs(applied_root):
  # Keep only build dirs still referenced by an ACTIVE_THEME_PATH component symlink; the rest are from
  # superseded applies and are safe to delete. A referenced build dir is identified by the first path
  # segment of the symlink target relative to applied_root.
  applied_root = applied_root.resolve()

  referenced = set()
  active = Path(ACTIVE_THEME_PATH)
  if active.is_dir():
    for component in active.iterdir():
      if not component.is_symlink():
        continue
      try:
        target = component.resolve()
      except OSError:
        continue
      if target.is_relative_to(applied_root):
        referenced.add(applied_root / target.relative_to(applied_root).parts[0])

  for build_dir in applied_root.iterdir():
    if build_dir.is_dir() and build_dir.resolve() not in referenced:
      delete_file(str(build_dir))


def colors_to_payload(colors_path):
  # The on-disk colors.json maps each key to {red, green, blue, alpha} ints (the shape the C++ reader at
  # frogpilot/ui/qt/widgets/frogpilot_controls.cc:94-100 parses). The editor wants the same shape, so it
  # is returned verbatim after a parse check.
  try:
    data = json.loads(colors_path.read_text())
  except (OSError, json.JSONDecodeError) as error:
    print(f"Skipping unreadable colors.json {colors_path}: {error}")
    return None

  return data if isinstance(data, dict) else None


def convert_audio(input_path):
  # Reproduce utilities.covert_audio exactly: 48 kHz, mono, pcm_s16le wav. The runtime plays each alert
  # from ACTIVE_THEME_PATH/sounds/<name>.wav (frogpilot/ui/qt/offroad/sounds_settings.cc:5), so the format
  # must match (REWRITE_PLAN §12.1).
  sound = AudioSegment.from_file(input_path)
  sound = sound.set_frame_rate(AUDIO_TARGET_SAMPLE_RATE)
  sound = sound.set_channels(AUDIO_TARGET_CHANNELS)

  output_path = input_path.with_suffix(".wav")
  sound.export(output_path, format="wav", parameters=["-acodec", AUDIO_TARGET_CODEC])

  if input_path != output_path:
    input_path.unlink(missing_ok=True)

  return output_path


def default_theme():
  # Describe the currently active theme so the editor can pre-load it. The active assets live as symlinks
  # under ACTIVE_THEME_PATH; we report which components are present and the colors, plus the relative asset
  # paths the editor fetches back through asset_file (REWRITE_PLAN §12.1).
  active = Path(ACTIVE_THEME_PATH)

  payload = {"colors": None, "images": {}, "sounds": {}, "theme_names": {}}

  colors_path = active / "colors" / "colors.json"
  if colors_path.is_file():
    payload["colors"] = colors_to_payload(colors_path)

  icons_dir = active / "icons"
  if icons_dir.is_dir():
    home = first_named_asset(icons_dir, "button_home")
    settings = first_named_asset(icons_dir, "button_settings")
    if home:
      payload["images"]["homeButton"] = home.name
    if settings:
      payload["images"]["settingsButton"] = settings.name

  distance_dir = active / "distance_icons"
  if distance_dir.is_dir():
    distance_icons = {}
    for name in DISTANCE_ICON_NAMES:
      asset = first_named_asset(distance_dir, name)
      if asset:
        distance_icons[name] = asset.name
    if distance_icons:
      payload["images"]["distanceIcons"] = distance_icons

  wheel_dir = active / "steering_wheel"
  if wheel_dir.is_dir():
    wheel = first_named_asset(wheel_dir, "wheel")
    if wheel:
      payload["images"]["steeringWheel"] = wheel.name

  signals_dir = active / "signals"
  if signals_dir.is_dir():
    populate_signal_payload(payload, signals_dir)

  return payload


def delete_theme(path, theme_type, component):
  # Holiday themes ship with the app and are not user-owned, so they are read-only (REWRITE_PLAN §12.1).
  if theme_type == "holiday":
    raise ApiError("Holiday themes are built in and cannot be deleted", 403)

  if theme_type == "steering_wheel":
    wheels_dir = THEME_SAVE_PATH / "steering_wheels"
    stem = safe_name(path)
    matches = [wheel for wheel in wheels_dir.glob(f"{stem}.*") if wheel.is_file()]
    if not matches:
      raise ApiError("Steering wheel not found", 404)
    for wheel in matches:
      # Confirm the resolved path stays inside the wheels dir before deleting (defense in depth alongside
      # safe_name) so a crafted name can never reach a sibling directory.
      delete_file(str(safe_join(wheels_dir, wheel.name)))
    return

  pack = safe_join(THEME_SAVE_PATH / "theme_packs", safe_name(path))
  if not pack.is_dir():
    raise ApiError("Theme not found", 404)

  if component:
    target = pack / component
    if not target.is_dir():
      raise ApiError("Component not found", 404)
    delete_file(str(target))
    if not any(pack.iterdir()):
      delete_file(str(pack))
    return

  delete_file(str(pack))


def download_asset(tab, name):
  # Mirror the C++ downloadThemeAsset signaling (frogpilot/ui/qt/offroad/theme_settings.cc:68-81): write
  # the component's request key into params_memory + set ThemeDownloadProgress, then kick the shared
  # ThemeManager.download_theme on the pre-declared "download_theme" lock so the request returns at once
  # and the frontend polls ThemeDownloadProgress (REWRITE_PLAN §12.1).
  component = TAB_TO_COMPONENT.get(tab, tab)
  asset_param = THEME_COMPONENT_PARAMS.get(component)
  if asset_param is None:
    raise ApiError("Unknown theme component", 400)

  if not name:
    raise ApiError("A theme name is required", 400)

  download_name = normalize_download_name(name)

  params_memory.put(asset_param, download_name)
  params_memory.put(THEME_DOWNLOAD_PROGRESS_PARAM, "Downloading...")

  toggles = get_frogpilot_toggles()
  run_thread_with_lock("download_theme", run_theme_download, args=(component, download_name, asset_param, toggles))


def download_theme_zip(form, files):
  checklist = parse_checklist(form)
  if not any(checklist.values()):
    raise ApiError("Select at least one component to download", 400)

  temp_root = Path(mkdtemp(prefix="pond_theme_dl_"))
  try:
    theme_path = build_theme(form, files, temp_root, checklist, persist_steering_wheel=False)
    if theme_path is None or not any(theme_path.iterdir()):
      raise ApiError("No theme components were built", 400)

    archive = zip_directory(theme_path)
    download_name = f"{theme_path.name}.zip"
    return archive, download_name
  finally:
    delete_temp_root(temp_root)


def delete_temp_root(temp_root):
  # download/submit build into an OS temp dir this process owns and never symlink into it, so the whole
  # tree is removed after the response is produced. (Apply uses applied_theme_dir, not this.)
  shutil.rmtree(temp_root, ignore_errors=True)


def first_named_asset(directory, stem):
  matches = sorted(directory.glob(f"{stem}.*"))
  return matches[0] if matches else None


def holiday_summary(holiday_dir):
  display = ThemeManager.format_name(holiday_dir.name, "theme_packs")
  return ThemeSummary(
    has_colors=(holiday_dir / "colors" / "colors.json").is_file(),
    has_distance_icons=dir_has_files(holiday_dir / "distance_icons"),
    has_icons=dir_has_files(holiday_dir / "icons"),
    has_sounds=dir_has_files(holiday_dir / "sounds"),
    has_steering_wheel=dir_has_files(holiday_dir / "steering_wheel"),
    has_turn_signals=dir_has_files(holiday_dir / "signals"),
    is_user_created=False,
    name=display,
    path=holiday_dir.name,
    type="holiday",
  )


def holiday_theme_dir(theme):
  candidate = safe_join(Path(HOLIDAY_THEME_PATH), safe_name(theme))
  if not candidate.is_dir():
    raise ApiError("Holiday theme not found", 404)
  return candidate


def dir_has_files(directory):
  return directory.is_dir() and any(directory.iterdir())


def load_theme(path, theme_type):
  # Describe one theme's assets so the editor can pull them in (the same payload shape as default_theme).
  base = asset_base_dir(path, theme_type)
  if theme_type == "steering_wheel":
    return load_steering_wheel(base, path)

  if not base.is_dir():
    raise ApiError("Theme not found", 404)

  payload = {"colors": None, "images": {}, "sounds": {}}

  colors_path = base / "colors" / "colors.json"
  if colors_path.is_file():
    payload["colors"] = colors_to_payload(colors_path)

  icons_dir = base / "icons"
  if icons_dir.is_dir():
    home = first_named_asset(icons_dir, "button_home")
    settings = first_named_asset(icons_dir, "button_settings")
    if home:
      payload["images"]["homeButton"] = {"path": f"icons/{home.name}", "filename": home.name}
    if settings:
      payload["images"]["settingsButton"] = {"path": f"icons/{settings.name}", "filename": settings.name}

  distance_dir = base / "distance_icons"
  if distance_dir.is_dir():
    distance_icons = {}
    for name in DISTANCE_ICON_NAMES:
      asset = first_named_asset(distance_dir, name)
      if asset:
        distance_icons[name] = {"path": f"distance_icons/{asset.name}", "filename": asset.name}
    if distance_icons:
      payload["images"]["distanceIcons"] = distance_icons

  signals_dir = base / "signals"
  if signals_dir.is_dir():
    populate_signal_payload(payload, signals_dir, with_paths=True)

  sounds_dir = base / "sounds"
  if sounds_dir.is_dir():
    for name in SOUND_NAMES:
      asset = first_named_asset(sounds_dir, name)
      if asset:
        payload["sounds"][name] = {"path": f"sounds/{asset.name}", "filename": asset.name}

  return payload


def load_steering_wheel(wheels_dir, path):
  wheel = first_named_asset(wheels_dir, safe_name(path))
  if wheel is None:
    raise ApiError("Steering wheel not found", 404)

  return {"colors": None, "images": {"steeringWheel": {"path": wheel.name, "filename": wheel.name}}, "sounds": {}}


def normalize_download_name(name):
  # Reproduce the C++ downloadThemeAsset name mangling (theme_settings.cc:68-81): a display name like
  # "Frog (Animated)" becomes the on-disk slug ThemeManager.download_theme expects. The space replacement
  # keys off whether the ORIGINAL input had parentheses (a parenthesised name uses "-", e.g.
  # "frog-animated"; otherwise "_"), matching the C++ `input.contains("(")` branch.
  output = name.replace(" - by: ", "~")
  if "~" in output:
    head, tail = output.split("~", 1)
    output = f"{head.lower()}~{tail}"
  else:
    output = output.lower()

  separator = "-" if "(" in name else "_"
  output = output.replace("(", "").replace(")", "")
  return output.replace(" ", separator)


def pack_summary(pack):
  display = ThemeManager.format_name(pack.name, "theme_packs")
  return ThemeSummary(
    has_colors=(pack / "colors" / "colors.json").is_file(),
    has_distance_icons=dir_has_files(pack / "distance_icons"),
    has_icons=dir_has_files(pack / "icons"),
    has_sounds=dir_has_files(pack / "sounds"),
    has_steering_wheel=False,
    has_turn_signals=dir_has_files(pack / "signals"),
    is_user_created=pack.name.endswith(USER_CREATED_SUFFIX),
    name=display,
    path=pack.name,
    type="user",
  )


def parse_checklist(form):
  raw = form.get("saveChecklist", "{}")
  try:
    checklist = json.loads(raw)
  except json.JSONDecodeError as error:
    raise ApiError("Invalid component selection", 400) from error

  if not isinstance(checklist, dict):
    raise ApiError("Invalid component selection", 400)

  return {key: bool(value) for key, value in checklist.items()}


def populate_signal_payload(payload, signals_dir, with_paths=False):
  sentinel = next((item for item in signals_dir.iterdir() if signal_sentinel(item.name)), None)
  if sentinel is not None:
    style, length = signal_sentinel(sentinel.name)
    payload["turnSignalStyle"] = style
    payload["turnSignalLength"] = length

  sequential = sorted(
    (item for item in signals_dir.glob("turn_signal_*") if item.stem.rsplit("_", 1)[-1].isdigit()),
    key=lambda item: int(item.stem.rsplit("_", 1)[-1]),
  )
  if sequential:
    payload["turnSignalType"] = "Sequential"
    payload["sequentialImages"] = [item.name for item in sequential]
  else:
    payload["turnSignalType"] = "Single Image"

  main = first_named_asset(signals_dir, "turn_signal")
  blindspot = first_named_asset(signals_dir, "turn_signal_blindspot")
  if main is not None:
    payload["images"]["turnSignal"] = {"path": f"signals/{main.name}", "filename": main.name} if with_paths else main.name
  if blindspot is not None:
    payload["images"]["turnSignalBlindspot"] = {"path": f"signals/{blindspot.name}", "filename": blindspot.name} if with_paths else blindspot.name


def relink_active_component(component, source):
  destination = Path(ACTIVE_THEME_PATH) / component

  # Remove whatever ACTIVE_THEME_PATH currently holds for this component (a dir copied by the manager, a
  # symlink to another theme, or a stale file) before relinking, so the runtime reads exactly the freshly
  # applied component. The replace semantics are load-bearing (REWRITE_PLAN §12.1).
  if destination.is_symlink() or destination.is_file():
    destination.unlink(missing_ok=True)
  elif destination.is_dir():
    delete_file(str(destination))

  destination.parent.mkdir(parents=True, exist_ok=True)
  destination.symlink_to(source, target_is_directory=True)


def run_theme_download(component, download_name, asset_param, toggles):
  manager = ThemeManager()
  manager.download_theme(component, download_name, asset_param, toggles)


def save_theme(form, files):
  checklist = parse_checklist(form)
  if not any(checklist.values()):
    raise ApiError("Select at least one component to save", 400)

  theme_name = (form.get("themeName") or "").strip()
  if not theme_name:
    raise ApiError("Theme name is required", 400)

  theme_path = build_theme(form, files, theme_packs_dir(), checklist, persist_steering_wheel=True)

  return theme_path.name if theme_path is not None else None


def signal_sentinel(filename):
  # The {style}_{length} sentinel encodes the turn-signal style + length on disk (REWRITE_PLAN §12.1), e.g.
  # "static_250" or "traditional_1000". Returns (Style, length_ms) or None when the name is not a sentinel.
  match = re.fullmatch(r"([a-z]+)_(\d+)", filename)
  if match is None:
    return None

  style = match.group(1).capitalize()
  if style not in TURN_SIGNAL_STYLES:
    return None

  return style, int(match.group(2))


def submit_theme(form, files):
  # External coupling: zip each built asset folder, base64 it, POST to the FrogPilot API gitlab/commit
  # branches + a discord/theme notification. Isolated with timeouts and non-200 handling so a flaky API
  # never wedges the worker or 500s the request (REWRITE_PLAN §12.1, CONVENTIONS §6).
  import requests

  checklist = parse_checklist(form)
  if not any(checklist.values()):
    raise ApiError("Select at least one component to submit", 400)

  theme_name = (form.get("themeName") or "").strip()
  if not theme_name:
    raise ApiError("Theme name is required", 400)

  discord_username = (form.get("discordUsername") or "").strip()
  if not discord_username:
    raise ApiError("A Discord username is required to submit a theme", 400)

  temp_root = Path(mkdtemp(prefix="pond_theme_submit_"))
  try:
    theme_path = build_theme(form, files, temp_root, checklist, persist_steering_wheel=False)
    if theme_path is None or not any(theme_path.iterdir()):
      raise ApiError("No theme components were built", 400)

    commits = build_submission_commits(theme_path, theme_name)
    if not commits:
      raise ApiError("No theme components were built", 400)

    try:
      for branch, payload in commits:
        response = requests.post(f"{FROGPILOT_API}/gitlab/commit", json={"branch": branch, **payload}, timeout=THEME_SUBMIT_TIMEOUT_SECONDS)
        if response.status_code != 200:
          raise ApiError("The theme service is unavailable right now. Please try again later.", 502)

      notify = requests.post(
        f"{FROGPILOT_API}/discord/theme",
        json={"discord_username": discord_username, "theme_name": theme_name},
        timeout=THEME_SUBMIT_TIMEOUT_SECONDS,
      )
      if notify.status_code != 200:
        raise ApiError("The theme service is unavailable right now. Please try again later.", 502)
    except requests.exceptions.RequestException as error:
      sentry.capture_exception(error)
      raise ApiError("Could not reach the theme service. Check your connection and try again.", 502) from error
  finally:
    delete_temp_root(temp_root)


def build_submission_commits(theme_path, theme_name):
  # Each branch carries a base64-zipped folder. Distance-Icons and Steering-Wheels are their own branches;
  # everything else goes to the Themes branch under the theme name (REWRITE_PLAN §12.1).
  commits = []

  distance = theme_path / "distance_icons"
  if distance.is_dir() and any(distance.iterdir()):
    commits.append(("Distance-Icons", {"name": theme_name, "archive": encode_directory(distance)}))

  wheel = theme_path / "steering_wheel"
  if wheel.is_dir() and any(wheel.iterdir()):
    commits.append(("Steering-Wheels", {"name": theme_name, "archive": encode_directory(wheel)}))

  theme_components = {}
  for component in ("colors", "icons", "signals", "sounds"):
    component_dir = theme_path / component
    if component_dir.is_dir() and any(component_dir.iterdir()):
      theme_components[component] = encode_directory(component_dir)
  if theme_components:
    commits.append(("Themes", {"name": theme_name, "components": theme_components}))

  return commits


def encode_directory(directory):
  return base64.b64encode(zip_directory(directory).getvalue()).decode("utf-8")


def theme_packs_dir():
  directory = THEME_SAVE_PATH / "theme_packs"
  directory.mkdir(parents=True, exist_ok=True)
  return directory


def validate_upload(upload):
  # The old content_length check was broken (it is unreliable/zero for multipart parts); measure the real
  # byte size by seeking to the end of the stream and resetting it (REWRITE_PLAN §12.1). Returns the byte
  # count so callers can avoid re-measuring.
  stream = upload.stream
  stream.seek(0, io.SEEK_END)
  size = stream.tell()
  stream.seek(0)

  if size > MAX_THEME_FILE_BYTES:
    raise ApiError(f"{upload.filename} is larger than the 5MB limit", 400)

  return size


def wheel_summary(wheel):
  display = ThemeManager.format_name(wheel.name, "steering_wheels")
  return ThemeSummary(
    has_colors=False,
    has_distance_icons=False,
    has_icons=False,
    has_sounds=False,
    has_steering_wheel=True,
    has_turn_signals=False,
    is_user_created=wheel.stem.endswith(USER_CREATED_SUFFIX),
    name=display,
    path=wheel.stem,
    type="steering_wheel",
  )


def write_colors(theme_path, colors_raw):
  if not colors_raw:
    return

  try:
    colors = json.loads(colors_raw)
  except json.JSONDecodeError as error:
    raise ApiError("Invalid colors payload", 400) from error

  if not isinstance(colors, dict):
    raise ApiError("Invalid colors payload", 400)

  # Keep only the known color keys with integer RGBA channels, so a malformed picker value can never write
  # a colors.json the runtime parser chokes on (frogpilot/ui/qt/widgets/frogpilot_controls.cc:94-100).
  cleaned = {}
  for key in COLOR_KEYS:
    channels = colors.get(key)
    if isinstance(channels, dict):
      cleaned[key] = {channel: int(channels.get(channel, 255)) for channel in ("red", "green", "blue", "alpha")}

  if not cleaned:
    raise ApiError("Invalid colors payload", 400)

  colors_dir = theme_path / "colors"
  colors_dir.mkdir(exist_ok=True)
  (colors_dir / "colors.json").write_text(json.dumps(cleaned, indent=2))


def write_distance_icons(theme_path, files):
  distance_dir = theme_path / "distance_icons"
  distance_dir.mkdir(exist_ok=True)

  for name in DISTANCE_ICON_NAMES:
    upload = files.get(f"distanceIcons_{name}")
    if upload and upload.filename:
      save_image(upload, distance_dir, name, STEERING_WHEEL_DIMENSIONS)


def write_icons(theme_path, files):
  icons_dir = theme_path / "icons"
  icons_dir.mkdir(exist_ok=True)

  for field, base_name in (("homeButton", "button_home"), ("settingsButton", "button_settings")):
    upload = files.get(field)
    if upload and upload.filename:
      save_image(upload, icons_dir, base_name, ICON_DIMENSIONS[field])


def write_sounds(theme_path, files):
  sounds_dir = theme_path / "sounds"
  sounds_dir.mkdir(exist_ok=True)

  for name in SOUND_NAMES:
    upload = files.get(name)
    if upload and upload.filename:
      validate_upload(upload)
      destination = sounds_dir / f"{name}{Path(upload.filename).suffix}"
      upload.save(destination)
      convert_audio(destination)


def write_steering_wheel(sane_name, files, theme_path, persist):
  upload = files.get("steeringWheel")
  if not upload or not upload.filename:
    return

  if persist:
    if not sane_name:
      raise ApiError("Theme name is required to save a steering wheel", 400)
    wheels_dir = THEME_SAVE_PATH / "steering_wheels"
    wheels_dir.mkdir(parents=True, exist_ok=True)
    for existing in wheels_dir.glob(f"{sane_name}{USER_CREATED_SUFFIX}.*"):
      delete_file(str(existing))
    save_image(upload, wheels_dir, f"{sane_name}{USER_CREATED_SUFFIX}", STEERING_WHEEL_DIMENSIONS)
    return

  if theme_path is None:
    return
  wheel_dir = theme_path / "steering_wheel"
  wheel_dir.mkdir(parents=True, exist_ok=True)
  save_image(upload, wheel_dir, "wheel", STEERING_WHEEL_DIMENSIONS)


def write_turn_signals(theme_path, form, files):
  signals_dir = theme_path / "signals"
  signals_dir.mkdir(exist_ok=True)

  length = parse_turn_signal_length(form.get("turnSignalLength"))
  style = form.get("turnSignalStyle", "Static")
  if style not in TURN_SIGNAL_STYLES:
    raise ApiError("Invalid turn signal style", 400)
  (signals_dir / f"{style.lower()}_{length}").touch()

  signal_type = (form.get("turnSignalType") or "Single Image").lower()
  if signal_type == "sequential":
    write_sequential_signals(signals_dir, files)
  else:
    write_single_signals(signals_dir, files)


def write_sequential_signals(signals_dir, files):
  for stale in signals_dir.glob("turn_signal*"):
    stale.unlink(missing_ok=True)

  blindspot = files.get("turnSignalBlindspot")
  if blindspot and blindspot.filename:
    save_signal_frame(blindspot, signals_dir / f"turn_signal_blindspot{Path(blindspot.filename).suffix.lower()}")

  ordered_keys = sorted(
    (key for key in files if re.fullmatch(r"turn_signal_\d+", key)),
    key=lambda key: int(key.rsplit("_", 1)[-1]),
  )
  for key in ordered_keys:
    upload = files.get(key)
    if upload and upload.filename:
      index = key.rsplit("_", 1)[-1]
      save_signal_frame(upload, signals_dir / f"turn_signal_{index}{Path(upload.filename).suffix.lower()}")


def write_single_signals(signals_dir, files):
  for stale in signals_dir.glob("turn_signal.*"):
    stale.unlink(missing_ok=True)
  for stale in signals_dir.glob("turn_signal_blindspot.*"):
    stale.unlink(missing_ok=True)

  main = files.get("turnSignal")
  if main and main.filename:
    save_signal_frame(main, signals_dir / f"turn_signal{Path(main.filename).suffix.lower()}")

  blindspot = files.get("turnSignalBlindspot")
  if blindspot and blindspot.filename:
    save_signal_frame(blindspot, signals_dir / f"turn_signal_blindspot{Path(blindspot.filename).suffix.lower()}")


def save_signal_frame(upload, destination):
  # Turn-signal frames are stored as-uploaded (the renderer scales them at draw time); only the size cap
  # applies, mirroring utilities.create_theme which saved signal images without resizing.
  validate_upload(upload)
  upload.save(destination)


def parse_turn_signal_length(raw):
  try:
    length = int(raw)
  except (TypeError, ValueError) as error:
    raise ApiError("Turn signal length must be a number", 400) from error

  if not TURN_SIGNAL_LENGTH_MIN_MS <= length <= TURN_SIGNAL_LENGTH_MAX_MS:
    raise ApiError(f"Turn signal length must be between {TURN_SIGNAL_LENGTH_MIN_MS} and {TURN_SIGNAL_LENGTH_MAX_MS} ms", 400)

  return length


def save_image(upload, directory, base_name, dimensions):
  # GIFs keep animation: resize via ffmpeg palettegen+paletteuse at the target dims (the proven pipeline
  # from utilities.create_theme). Non-GIFs are resized with PIL LANCZOS and coerced to PNG so the runtime
  # always finds a decodable still (REWRITE_PLAN §12.1).
  validate_upload(upload)

  for stale in directory.glob(f"{base_name}.*"):
    stale.unlink(missing_ok=True)

  suffix = Path(upload.filename).suffix.lower()
  if suffix == ".gif":
    destination = directory / f"{base_name}.gif"
    upload.save(destination)
    resize_gif(destination, dimensions)
    return destination

  destination = directory / f"{base_name}{PNG_SUFFIX}"
  with Image.open(upload.stream) as image:
    resized = image.resize(dimensions, Image.Resampling.LANCZOS)
    resized.save(destination, "PNG")

  return destination


def resize_gif(gif_path, dimensions):
  width, height = dimensions
  palette_path = gif_path.with_name(f"{gif_path.stem}.{uuid4().hex}.palette.png")
  staged_path = gif_path.with_name(f"{gif_path.stem}.{uuid4().hex}.resized.gif")

  paletteuse = f"fps={GIF_PALETTE_FPS},scale={width}:{height}:flags=lanczos[x];[x][1:v]paletteuse"

  try:
    run_ffmpeg(["-i", str(gif_path), "-vf", "palettegen", str(palette_path)])
    run_ffmpeg(["-i", str(gif_path), "-i", str(palette_path), "-lavfi", paletteuse, str(staged_path)])
    staged_path.replace(gif_path)
  except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
    sentry.capture_exception(error)
    raise ApiError("Could not process the uploaded GIF", 400) from error
  finally:
    palette_path.unlink(missing_ok=True)
    staged_path.unlink(missing_ok=True)


def zip_directory(directory):
  buffer = io.BytesIO()
  with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(directory.rglob("*")):
      if path.is_file():
        archive.write(path, path.relative_to(directory).as_posix())

  buffer.seek(0)
  return buffer
