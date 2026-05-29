#!/usr/bin/env python3
import json
import math
import re
import unicodedata

import requests

from collections import deque
from datetime import datetime, timedelta, UTC

from cereal import messaging

from openpilot.common.conversions import Conversions as CV
from openpilot.selfdrive.navd.helpers import Coordinate, minimum_distance

from openpilot.frogpilot.common.frogpilot_utilities import calculate_distance_to_point, is_url_pingable
from openpilot.frogpilot.common.frogpilot_variables import params, params_memory

OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"

MAX_SPEED_LIMITS = 1_000_000
VETTING_INTERVAL_DAYS = 7

BBOX_PAD = 0.001
BEARING_TOLERANCE = 40
GRID_SIZE = 0.01
NAME_MATCH_BONUS = 8
SNAP_DISTANCE = 30

DRIVABLE_HIGHWAYS = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service"


def bearing_difference(first, second):
  difference = abs(first - second) % 180
  return min(difference, 180 - difference)


def has_stacked_conflict(latitude, longitude, snapped, ways):
  snapped_name = normalize_name(snapped.get("tags", {}).get("name") or snapped.get("tags", {}).get("ref") or "")
  if not snapped_name:
    return False

  snapped_layer = snapped.get("tags", {}).get("layer") or "0"
  point = Coordinate(latitude, longitude)
  for way in ways:
    tags = way.get("tags", {})

    if way.get("id") == snapped.get("id") or (tags.get("layer") or "0") == snapped_layer:
      continue

    if normalize_name(tags.get("name") or tags.get("ref") or "") != snapped_name:
      continue

    coordinates = (way.get("geometry") or {}).get("coordinates", [])
    if not near_point(latitude, longitude, coordinates, SNAP_DISTANCE / 111000 + 0.0005):
      continue
    for start, end in zip(coordinates, coordinates[1:]):
      try:
        if minimum_distance(Coordinate(start[1], start[0]), Coordinate(end[1], end[0]), point) <= SNAP_DISTANCE:
          return True
      except (IndexError, TypeError):
        continue
  return False


def heading_difference(bearing, start, end, oneway):
  heading = segment_bearing(start, end)
  if oneway == "-1":
    heading = (heading + 180) % 360
  if oneway in ("-1", "1", "true", "yes"):
    difference = abs(bearing - heading) % 360
    return min(difference, 360 - difference)
  return bearing_difference(bearing, heading)


def near_point(latitude, longitude, coordinates, pad):
  longitudes = [coordinate[0] for coordinate in coordinates if len(coordinate) >= 2]
  latitudes = [coordinate[1] for coordinate in coordinates if len(coordinate) >= 2]
  if not longitudes:
    return False
  return min(longitudes) - pad <= longitude <= max(longitudes) + pad and min(latitudes) - pad <= latitude <= max(latitudes) + pad


def normalize_name(name):
  name = unicodedata.normalize("NFKC", name).casefold().replace("-", " ").replace("/", " ")
  name = "".join(character for character in name if character not in ".,'")

  words = name.split()
  if words and words[0] == "the":
    words = words[1:]
  if words and words[-1] == "the":
    words = words[:-1]

  return " ".join(words)


def parse_osm_maxspeed(maxspeed):
  if maxspeed is None:
    return 0

  if not isinstance(maxspeed, str):
    return None

  value = maxspeed.split(";")[0].strip().lower()
  if not value:
    return 0

  match = re.match(r"^(\d+(?:\.\d+)?)\s*(mph|km/?h|kph)?$", value)
  if not match:
    return None

  speed = float(match.group(1))
  if match.group(2) == "mph":
    return speed * CV.MPH_TO_MS
  return speed * CV.KPH_TO_MS


def segment_bearing(start, end):
  longitude1, latitude1, longitude2, latitude2 = map(math.radians, (start[0], start[1], end[0], end[1]))
  delta_longitude = longitude2 - longitude1
  y = math.sin(delta_longitude) * math.cos(latitude2)
  x = math.cos(latitude1) * math.sin(latitude2) - math.sin(latitude1) * math.cos(latitude2) * math.cos(delta_longitude)
  return math.degrees(math.atan2(y, x)) % 360


def snap_to_way(latitude, longitude, ways, bearing, road_name):
  point = Coordinate(latitude, longitude)
  target_name = normalize_name(road_name)

  pad = SNAP_DISTANCE / 111000 + 0.0005

  closest_score = SNAP_DISTANCE
  closest_way = None

  for way in ways:
    coordinates = (way.get("geometry") or {}).get("coordinates", [])
    if not near_point(latitude, longitude, coordinates, pad):
      continue

    tags = way.get("tags", {})
    oneway = tags.get("oneway")
    way_name = normalize_name(tags.get("name") or tags.get("ref") or "")

    for start, end in zip(coordinates, coordinates[1:]):
      try:
        if bearing is not None and heading_difference(bearing, start, end, oneway) > BEARING_TOLERANCE:
          continue

        distance = minimum_distance(Coordinate(start[1], start[0]), Coordinate(end[1], end[0]), point)
      except (IndexError, TypeError):
        continue

      if distance > SNAP_DISTANCE:
        continue

      score = distance - (NAME_MATCH_BONUS if target_name and way_name == target_name else 0)
      if score < closest_score:
        closest_score = score
        closest_way = way

  return closest_way


def vetting_keep(entry, osm_speed_limit):
  if entry["incorrect_limit"]:
    return osm_speed_limit is None or osm_speed_limit < 1 or abs(osm_speed_limit - entry["speed_limit"]) >= 1
  return osm_speed_limit is None or osm_speed_limit < 1


class SpeedLimitFiller:
  def __init__(self):
    self.session = requests.Session()

    self.started_previously = False
    self.startup_pending = True

    self.logged_position = None

    self.speed_limits = deque(maxlen=MAX_SPEED_LIMITS)

    self.sm = messaging.SubMaster(["deviceState", "frogpilotCarState", "frogpilotNavigation", "frogpilotPlan"])

  def filter_speed_limits(self, speed_limits):
    if not is_url_pingable(OVERPASS_ENDPOINT):
      return

    existing = json.loads(params.get("SpeedLimitsFiltered", encoding="utf-8") or "[]")
    if not speed_limits and not existing:
      return

    way_cache = {}

    def ways_for(latitude, longitude):
      cell = (round(latitude / GRID_SIZE), round(longitude / GRID_SIZE))
      if cell not in way_cache:
        self.sm.update(0)
        if self.sm["deviceState"].started:
          return None
        center_latitude, center_longitude = cell[0] * GRID_SIZE, cell[1] * GRID_SIZE
        bounding_box = (center_latitude - GRID_SIZE / 2 - BBOX_PAD, center_longitude - GRID_SIZE / 2 - BBOX_PAD,
                        center_latitude + GRID_SIZE / 2 + BBOX_PAD, center_longitude + GRID_SIZE / 2 + BBOX_PAD)
        way_cache[cell] = self.query_overpass(bounding_box)
      return way_cache[cell]

    now = datetime.now(UTC)

    filtered = deque(maxlen=MAX_SPEED_LIMITS)
    for entry in existing:
      last_vetted = entry.get("last_vetted")
      if last_vetted and now - datetime.fromisoformat(last_vetted) < timedelta(days=VETTING_INTERVAL_DAYS):
        filtered.append(entry)
        continue

      ways = ways_for(entry["latitude"], entry["longitude"])
      if not ways:
        filtered.append(entry)
        continue

      if vetting_keep(entry, self.segment_speed_limit(ways, entry.get("segment_id"))):
        entry["last_vetted"] = now.isoformat()
        filtered.append(entry)

    confirmed_segments = {entry.get("segment_id") for entry in filtered}
    deferred = []
    for entry in speed_limits:
      ways = ways_for(entry["latitude"], entry["longitude"])
      if not ways:
        deferred.append(entry)
        continue

      way = self.nearest_way(entry["latitude"], entry["longitude"], ways, entry.get("bearing"), entry.get("road_name", ""))
      if way is None:
        continue

      tags = way.get("tags", {})
      osm_name = normalize_name(tags.get("name") or tags.get("ref") or "")
      if osm_name and osm_name != normalize_name(entry.get("road_name", "")):
        deferred.append(entry)
        continue

      if has_stacked_conflict(entry["latitude"], entry["longitude"], way, ways):
        continue

      if way.get("id") in confirmed_segments:
        continue

      osm_speed_limit = parse_osm_maxspeed(tags.get("maxspeed"))
      if osm_speed_limit is None:
        continue

      if entry["incorrect_limit"]:
        if osm_speed_limit >= 1 and abs(osm_speed_limit - entry["speed_limit"]) >= 1:
          filtered.append(self.confirmed_record(entry, way, now))
          confirmed_segments.add(way.get("id"))
      elif osm_speed_limit < 1:
        filtered.append(self.confirmed_record(entry, way, now))
        confirmed_segments.add(way.get("id"))

    params.put("SpeedLimits", json.dumps(deferred))
    params.put("SpeedLimitsFiltered", json.dumps(list(filtered)))

  @staticmethod
  def confirmed_record(entry, way, now):
    return {
      "incorrect_limit": entry["incorrect_limit"],
      "last_vetted": now.isoformat(),
      "latitude": entry["latitude"],
      "longitude": entry["longitude"],
      "road_name": entry["road_name"],
      "segment_id": way.get("id"),
      "source": entry["source"],
      "speed_limit": entry["speed_limit"],
    }

  @staticmethod
  def segment_speed_limit(ways, segment_id):
    for way in ways:
      if way.get("id") == segment_id:
        return parse_osm_maxspeed(way.get("tags", {}).get("maxspeed"))
    return None

  def log_speed_limit(self):
    sources = (
      ("Dashboard", self.sm["frogpilotCarState"].dashboardSpeedLimit),
      ("Mapbox", self.sm["frogpilotPlan"].slcMapboxSpeedLimit),
      ("Navigation", self.sm["frogpilotNavigation"].navigationSpeedLimit),
    )
    source, reference_speed_limit = next(((name, limit) for name, limit in sources if limit >= 1), ("", 0))
    if reference_speed_limit < 1:
      return

    gps_position = json.loads(params_memory.get("LastGPSPosition", encoding="utf-8") or "{}")
    if not gps_position:
      return

    latitude, longitude = gps_position["latitude"], gps_position["longitude"]
    bearing = gps_position.get("bearing")
    if self.logged_position and calculate_distance_to_point(*self.logged_position, latitude, longitude) < 1:
      return

    road_name = params_memory.get("RoadName", encoding="utf-8") or ""
    if not road_name:
      return

    map_speed_limit = params_memory.get_float("MapSpeedLimit")
    if map_speed_limit >= 1:
      if abs(map_speed_limit - reference_speed_limit) < 1:
        return
      incorrect_limit = True
    else:
      incorrect_limit = False

    self.speed_limits.append(
      {
        "bearing": bearing,
        "incorrect_limit": incorrect_limit,
        "latitude": latitude,
        "longitude": longitude,
        "road_name": road_name,
        "source": source,
        "speed_limit": reference_speed_limit,
      }
    )
    self.logged_position = (latitude, longitude)

  def nearest_way(self, latitude, longitude, ways, bearing, road_name):
    way = snap_to_way(latitude, longitude, ways, bearing, road_name)
    if way is None and bearing is not None:
      way = snap_to_way(latitude, longitude, ways, None, road_name)
    return way

  def query_overpass(self, bounding_box):
    south, west, north, east = bounding_box
    query = f'[out:json][timeout:10];way["highway"~"^({DRIVABLE_HIGHWAYS})(_link)?$"]({south},{west},{north},{east});convert way ::id=id(),::geom=geom(),name=t["name"],ref=t["ref"],maxspeed=t["maxspeed"],oneway=t["oneway"],layer=t["layer"];out geom;'

    try:
      response = self.session.get(OVERPASS_ENDPOINT, params={"data": query}, headers={"User-Agent": "FrogPilot SpeedLimitFiller"}, timeout=10)
      response.raise_for_status()
      return response.json()["elements"]
    except (requests.RequestException, ValueError, KeyError) as error:
      print(f"Overpass query failed: {error}")
      return None

  def update(self):
    self.sm.update()

    started = self.sm["deviceState"].started

    if started and not self.started_previously:
      self.speed_limits = deque(maxlen=MAX_SPEED_LIMITS)

      self.logged_position = None
    elif not started and self.started_previously:
      merged = deque(json.loads(params.get("SpeedLimits", encoding="utf-8") or "[]"), maxlen=MAX_SPEED_LIMITS)
      if self.speed_limits:
        merged.extend(self.speed_limits)
        params.put("SpeedLimits", json.dumps(list(merged)))

      self.filter_speed_limits(merged)

      self.startup_pending = False
    elif started:
      self.log_speed_limit()
    elif self.startup_pending:
      self.filter_speed_limits(deque(json.loads(params.get("SpeedLimits", encoding="utf-8") or "[]"), maxlen=MAX_SPEED_LIMITS))

      self.startup_pending = False

    self.started_previously = started


def main():
  speed_limit_filler = SpeedLimitFiller()

  while True:
    speed_limit_filler.update()


if __name__ == "__main__":
  main()
