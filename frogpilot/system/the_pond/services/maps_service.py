#!/usr/bin/env python3
import json
import subprocess

from datetime import datetime

import openpilot.system.sentry as sentry

from openpilot.frogpilot.common.frogpilot_utilities import delete_file, run_thread_with_lock, update_maps
from openpilot.frogpilot.common.frogpilot_variables import MAPS_PATH, params, params_memory
from openpilot.frogpilot.system.the_pond.lib.capabilities import require_device
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError

# The OSM catalog the on-device maps panel offers, copied verbatim from FrogPilot's own source so the
# Pond covers exactly the same countries and U.S. states as the C++ panel (the QMap tables in
# frogpilot/ui/qt/widgets/navigation_functions.h; grouped into the panels assembled in
# frogpilot/ui/qt/offroad/maps_settings.cc). Group order matches the C++ panels; each region's entries are
# sorted by name the way Qt's QMap orders by key — but the Pond exposes them name-sorted for the picker,
# which is what the UI shows. Codes are the ISO-3166 keys mapd downloads by; names are the labels shown.
COUNTRY_GROUPS = (
  (
    "Africa",
    {
      "DZ": "Algeria",
      "AO": "Angola",
      "BJ": "Benin",
      "BW": "Botswana",
      "BF": "Burkina Faso",
      "BI": "Burundi",
      "CM": "Cameroon",
      "CF": "Central African Republic",
      "TD": "Chad",
      "KM": "Comoros",
      "CG": "Congo (Brazzaville)",
      "CD": "Congo (Kinshasa)",
      "DJ": "Djibouti",
      "EG": "Egypt",
      "GQ": "Equatorial Guinea",
      "ER": "Eritrea",
      "ET": "Ethiopia",
      "GA": "Gabon",
      "GM": "Gambia",
      "GH": "Ghana",
      "GN": "Guinea",
      "GW": "Guinea-Bissau",
      "CI": "Ivory Coast",
      "KE": "Kenya",
      "LS": "Lesotho",
      "LR": "Liberia",
      "LY": "Libya",
      "MG": "Madagascar",
      "MW": "Malawi",
      "ML": "Mali",
      "MR": "Mauritania",
      "MA": "Morocco",
      "MZ": "Mozambique",
      "NA": "Namibia",
      "NE": "Niger",
      "NG": "Nigeria",
      "RW": "Rwanda",
      "SN": "Senegal",
      "SL": "Sierra Leone",
      "SO": "Somalia",
      "ZA": "South Africa",
      "SS": "South Sudan",
      "SD": "Sudan",
      "SZ": "Swaziland",
      "TZ": "Tanzania",
      "TG": "Togo",
      "TN": "Tunisia",
      "UG": "Uganda",
      "ZM": "Zambia",
      "ZW": "Zimbabwe",
    },
  ),
  (
    "Antarctica",
    {"AQ": "Antarctica"},
  ),
  (
    "Asia",
    {
      "AF": "Afghanistan",
      "AM": "Armenia",
      "AZ": "Azerbaijan",
      "BH": "Bahrain",
      "BD": "Bangladesh",
      "BT": "Bhutan",
      "BN": "Brunei",
      "KH": "Cambodia",
      "CN": "China",
      "CY": "Cyprus",
      "TL": "East Timor",
      "HK": "Hong Kong",
      "IN": "India",
      "ID": "Indonesia",
      "IR": "Iran",
      "IQ": "Iraq",
      "IL": "Israel",
      "JP": "Japan",
      "JO": "Jordan",
      "KZ": "Kazakhstan",
      "KW": "Kuwait",
      "KG": "Kyrgyzstan",
      "LA": "Laos",
      "LB": "Lebanon",
      "MY": "Malaysia",
      "MV": "Maldives",
      "MO": "Macao",
      "MN": "Mongolia",
      "MM": "Myanmar",
      "NP": "Nepal",
      "KP": "North Korea",
      "OM": "Oman",
      "PK": "Pakistan",
      "PS": "Palestine",
      "PH": "Philippines",
      "QA": "Qatar",
      "RU": "Russia",
      "SA": "Saudi Arabia",
      "SG": "Singapore",
      "KR": "South Korea",
      "LK": "Sri Lanka",
      "SY": "Syria",
      "TW": "Taiwan",
      "TJ": "Tajikistan",
      "TH": "Thailand",
      "TR": "Turkey",
      "TM": "Turkmenistan",
      "AE": "United Arab Emirates",
      "UZ": "Uzbekistan",
      "VN": "Vietnam",
      "YE": "Yemen",
    },
  ),
  (
    "Europe",
    {
      "AL": "Albania",
      "AT": "Austria",
      "BY": "Belarus",
      "BE": "Belgium",
      "BA": "Bosnia and Herzegovina",
      "BG": "Bulgaria",
      "HR": "Croatia",
      "CZ": "Czech Republic",
      "DK": "Denmark",
      "EE": "Estonia",
      "FI": "Finland",
      "FR": "France",
      "GE": "Georgia",
      "DE": "Germany",
      "GR": "Greece",
      "HU": "Hungary",
      "IS": "Iceland",
      "IE": "Ireland",
      "IT": "Italy",
      "KZ": "Kazakhstan",
      "LV": "Latvia",
      "LT": "Lithuania",
      "LU": "Luxembourg",
      "MK": "Macedonia",
      "MD": "Moldova",
      "ME": "Montenegro",
      "NL": "Netherlands",
      "NO": "Norway",
      "PL": "Poland",
      "PT": "Portugal",
      "RO": "Romania",
      "RS": "Serbia",
      "SK": "Slovakia",
      "SI": "Slovenia",
      "ES": "Spain",
      "SE": "Sweden",
      "CH": "Switzerland",
      "TR": "Turkey",
      "UA": "Ukraine",
      "GB": "United Kingdom",
    },
  ),
  (
    "North America",
    {
      "BS": "Bahamas",
      "BZ": "Belize",
      "CA": "Canada",
      "CR": "Costa Rica",
      "CU": "Cuba",
      "DO": "Dominican Republic",
      "SV": "El Salvador",
      "GL": "Greenland",
      "GD": "Grenada",
      "GT": "Guatemala",
      "HT": "Haiti",
      "HN": "Honduras",
      "JM": "Jamaica",
      "MX": "Mexico",
      "NI": "Nicaragua",
      "PA": "Panama",
      "TT": "Trinidad and Tobago",
      "US": "United States",
    },
  ),
  (
    "Oceania",
    {
      "AU": "Australia",
      "FJ": "Fiji",
      "TF": "French Southern Territories",
      "NC": "New Caledonia",
      "NZ": "New Zealand",
      "PG": "Papua New Guinea",
      "SB": "Solomon Islands",
      "VU": "Vanuatu",
    },
  ),
  (
    "South America",
    {
      "AR": "Argentina",
      "BO": "Bolivia",
      "BR": "Brazil",
      "CL": "Chile",
      "CO": "Colombia",
      "EC": "Ecuador",
      "FK": "Falkland Islands",
      "GY": "Guyana",
      "PY": "Paraguay",
      "PE": "Peru",
      "SR": "Suriname",
      "UY": "Uruguay",
      "VE": "Venezuela",
    },
  ),
)

STATE_GROUPS = (
  (
    "United States - Midwest",
    {
      "IL": "Illinois",
      "IN": "Indiana",
      "IA": "Iowa",
      "KS": "Kansas",
      "MI": "Michigan",
      "MN": "Minnesota",
      "MO": "Missouri",
      "NE": "Nebraska",
      "ND": "North Dakota",
      "OH": "Ohio",
      "SD": "South Dakota",
      "WI": "Wisconsin",
    },
  ),
  (
    "United States - Northeast",
    {
      "CT": "Connecticut",
      "ME": "Maine",
      "MA": "Massachusetts",
      "NH": "New Hampshire",
      "NJ": "New Jersey",
      "NY": "New York",
      "PA": "Pennsylvania",
      "RI": "Rhode Island",
      "VT": "Vermont",
    },
  ),
  (
    "United States - South",
    {
      "AL": "Alabama",
      "AR": "Arkansas",
      "DE": "Delaware",
      "DC": "District of Columbia",
      "FL": "Florida",
      "GA": "Georgia",
      "KY": "Kentucky",
      "LA": "Louisiana",
      "MD": "Maryland",
      "MS": "Mississippi",
      "NC": "North Carolina",
      "OK": "Oklahoma",
      "SC": "South Carolina",
      "TN": "Tennessee",
      "TX": "Texas",
      "VA": "Virginia",
      "WV": "West Virginia",
    },
  ),
  (
    "United States - West",
    {
      "AK": "Alaska",
      "AZ": "Arizona",
      "CA": "California",
      "CO": "Colorado",
      "HI": "Hawaii",
      "ID": "Idaho",
      "MT": "Montana",
      "NV": "Nevada",
      "NM": "New Mexico",
      "OR": "Oregon",
      "UT": "Utah",
      "WA": "Washington",
      "WY": "Wyoming",
    },
  ),
  (
    "United States - Territories",
    {
      "AS": "American Samoa",
      "GU": "Guam",
      "MP": "Northern Mariana Islands",
      "PR": "Puerto Rico",
      "VI": "Virgin Islands",
    },
  ),
)

# The persistent param the maps panel and update_maps both read/write the selection from: a JSON object
# with "nations" (country codes) and "states" (U.S. state codes) arrays (verified against
# MapSelectionControl in frogpilot/ui/qt/widgets/navigation_functions.cc and update_maps in
# frogpilot_utilities.py). The on-disk shape is the contract update_maps consumes, so the Pond persists
# the exact same {"nations": [...], "states": [...]} object.
LAST_MAPS_UPDATE_KEY = "LastMapsUpdate"
MAPS_SELECTED_KEY = "MapsSelected"
OSM_DOWNLOAD_LOCATIONS_KEY = "OSMDownloadLocations"
OSM_DOWNLOAD_PROGRESS_KEY = "OSMDownloadProgress"
PREFERRED_SCHEDULE_KEY = "PreferredSchedule"

# The two selection groups MapsSelected stores, mapped to the catalog they validate against.
SELECTION_FIELDS = {"nations": COUNTRY_GROUPS, "states": STATE_GROUPS}

# PreferredSchedule is one of three values update_maps branches on: 0 manual (never auto-update), 1 weekly
# (every Sunday), 2 monthly (the 1st). Anything else is rejected so a bad value never silently disables
# the schedule (frogpilot_utilities.update_maps reads get_int("PreferredSchedule")).
VALID_SCHEDULES = (0, 1, 2)

# pkill terminates the mapd downloader; the request thread must never wait on it indefinitely.
PKILL_TIMEOUT_SECONDS = 10


def catalog():
  return {
    "countries": [{"codes": as_options(codes), "label": label} for label, codes in COUNTRY_GROUPS],
    "states": [{"codes": as_options(codes), "label": label} for label, codes in STATE_GROUPS],
  }


def as_options(codes):
  return [{"code": code, "name": name} for code, name in sorted(codes.items(), key=lambda item: item[1])]


def cancel_download():
  # Mirror the panel's cancelDownload (maps_settings.cc): drop the trigger + progress params so update_maps'
  # poll loop exits, then kill the mapd process that is actually fetching tiles. Killing a device process is
  # hardware-only, so it is gated rather than crashing in PC/debug mode.
  require_device()

  params.remove(OSM_DOWNLOAD_PROGRESS_KEY)
  params_memory.remove(OSM_DOWNLOAD_LOCATIONS_KEY)

  try:
    subprocess.run(["pkill", "mapd"], timeout=PKILL_TIMEOUT_SECONDS, check=False)
  except subprocess.TimeoutExpired as error:
    raise ApiError("Timed out stopping the map downloader", 504) from error


def maps_status():
  raw_progress = params.get(OSM_DOWNLOAD_PROGRESS_KEY, encoding="utf-8")

  return {
    "downloaded": MAPS_PATH.exists(),
    "lastUpdated": params.get(LAST_MAPS_UPDATE_KEY, encoding="utf-8"),
    "progress": parse_progress(raw_progress),
    "schedule": params.get_int(PREFERRED_SCHEDULE_KEY),
    "selection": selected_locations(),
    "sizeBytes": maps_size_bytes(),
  }


def maps_size_bytes():
  if not MAPS_PATH.exists():
    return 0

  return sum(entry.stat().st_size for entry in MAPS_PATH.rglob("*") if entry.is_file())


def parse_progress(raw_progress):
  # While a download is running mapd publishes OSMDownloadProgress as JSON carrying the file counts the
  # panel renders (maps_settings.cc updateDownloadLabels matches "total_files"/"downloaded_files"). An
  # empty/absent value means no download is in flight; a malformed value is reported but treated as
  # "running with unknown counts" rather than failing the whole status read.
  if not raw_progress:
    return None

  try:
    progress = json.loads(raw_progress)
  except json.JSONDecodeError as error:
    sentry.capture_exception(error)
    return {"downloadedFiles": None, "running": True, "totalFiles": None}

  return {
    "downloadedFiles": progress.get("downloaded_files"),
    "running": True,
    "totalFiles": progress.get("total_files"),
  }


def remove_maps():
  # Delete the downloaded offline OSM data to free storage (the panel's removeMapsButton). delete_file is
  # the sudo-backed remove the rest of the Pond uses; rglob deepest-first so files go before their dirs.
  if not MAPS_PATH.exists():
    return

  for entry in sorted(MAPS_PATH.rglob("*"), key=lambda path: len(path.parts), reverse=True):
    delete_file(str(entry))

  delete_file(str(MAPS_PATH))


def selected_locations():
  raw_selection = params.get(MAPS_SELECTED_KEY, encoding="utf-8")
  if not raw_selection:
    return {"nations": [], "states": []}

  try:
    selection = json.loads(raw_selection)
  except json.JSONDecodeError as error:
    sentry.capture_exception(error)
    return {"nations": [], "states": []}

  # update_maps tolerates a bare int here (a legacy value it clears); the Pond reports an empty selection
  # rather than a malformed object so the picker shows nothing checked.
  if not isinstance(selection, dict):
    return {"nations": [], "states": []}

  return {field: normalize_codes(selection.get(field)) for field in SELECTION_FIELDS}


def normalize_codes(value):
  if not isinstance(value, list):
    return []

  return [code for code in value if isinstance(code, str)]


def set_schedule(schedule):
  if schedule not in VALID_SCHEDULES:
    raise ApiError("Schedule must be 0 (manual), 1 (weekly), or 2 (monthly)", 400)

  params.put_int(PREFERRED_SCHEDULE_KEY, schedule)


def start_download():
  # Hand the persisted selection to update_maps via the trigger param it polls, exactly as the panel's
  # startDownload does, then run the blocking 60s-loop routine on its dedicated lock so the request never
  # waits on the download (catalog: run_thread_with_lock name must be the pre-declared "update_maps").
  selection = selected_locations()
  if not (selection["nations"] or selection["states"]):
    raise ApiError("Select at least one country or state before downloading", 400)

  params_memory.put(OSM_DOWNLOAD_LOCATIONS_KEY, params.get(MAPS_SELECTED_KEY, encoding="utf-8") or "{}")

  run_thread_with_lock("update_maps", update_maps, args=(datetime.now(),))


def store_selection(selection):
  # Persist the country/state picks to MapsSelected in the exact {"nations": [...], "states": [...]} shape
  # update_maps and the on-device panel consume. Every code is validated against the catalog so a typo or
  # an injected value can never reach mapd's download list.
  if not isinstance(selection, dict):
    raise ApiError("Selection must be an object with 'nations' and 'states' arrays", 400)

  cleaned = {}
  for field, groups in SELECTION_FIELDS.items():
    cleaned[field] = validate_codes(selection.get(field, []), field, valid_codes(groups))

  params.put(MAPS_SELECTED_KEY, json.dumps(cleaned))

  return {field: cleaned[field] for field in SELECTION_FIELDS}


def valid_codes(groups):
  codes = set()
  for _, group_codes in groups:
    codes.update(group_codes)

  return codes


def validate_codes(value, field, allowed):
  if not isinstance(value, list):
    raise ApiError(f"'{field}' must be an array of codes", 400)

  cleaned = []
  for code in value:
    if not isinstance(code, str) or code not in allowed:
      raise ApiError(f"Unknown {field} code: {code}", 400)
    if code not in cleaned:
      cleaned.append(code)

  return cleaned
