#!/usr/bin/env python3
import json

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path

# Import sentry first to break the latent frogpilot_variables -> car_helpers -> sentry cycle, matching
# stats_service.py and lib/onroad.py: a cold import of frogpilot_variables raises unless sentry leads.
import openpilot.system.sentry as sentry  # noqa: F401

from openpilot.common.conversions import Conversions as CV

import openpilot.frogpilot.system.the_pond.services.routes_service as routes_service

# Per-route stats are reconstructed from the footage the device still has on disk and cached so the
# heavy qlog parse runs once per route (REWRITE_PLAN §12.3 caching posture, mirrors lib/video_cache).
# The on-device GPS logs carry no usable fix on this build, so there is deliberately no route path /
# from-to here: those fields were dropped from the dashboard rather than faked.
DRIVE_STATS_CACHE_PATH = Path("/data/drive_stats_cache")

# How many of the most recent drives the dashboard feed shows, and how many days "this week" spans.
RECENT_DRIVES_LIMIT = 8
WEEK_DAYS = 7

# Integrating vEgo over the qlog's own timestamps reconstructs distance; cap the gap between two samples
# so a logging hiccup (or the seam between segments) cannot inflate the integral. qlog carState lands at
# ~10-20Hz, so a one-second cap never clips a real sample step.
MAX_SAMPLE_GAP_SECONDS = 1.0
NANOS_PER_SECOND = 1e9

# A segment still being written holds this lock; parsing it would race the recorder, so it is skipped
# (same guard routes_service uses before serving a clip).
RECORDING_LOCK_NAME = "rlog.lock"


@dataclass(frozen=True)
class RouteStats:
  date: str | None
  distance_m: float
  duration_s: float
  enabled_samples: int
  epoch: float | None
  name: str
  segments: int
  total_samples: int

  @property
  def engagement(self):
    return (100.0 * self.enabled_samples / self.total_samples) if self.total_samples else 0.0

  @property
  def avg_speed_ms(self):
    return (self.distance_m / self.duration_s) if self.duration_s else 0.0


def drive_history(now=None):
  # The whole dashboard "driving" payload, assembled from retained footage. Everything degrades to an
  # empty list / None when there is no footage, so the frontend simply shows its empty states.
  now = now or datetime.now()
  is_metric = metric()

  all_stats = sorted(every_route_stats(), key=lambda stats: stats.epoch or 0)

  return {
    "lastDrive": last_drive(all_stats, is_metric),
    "records": records(all_stats, is_metric),
    "recentDrives": recent_drives(all_stats, is_metric),
    "thisWeek": this_week(all_stats, is_metric, now),
  }


def every_route_stats():
  cache = DriveStatsCache()
  stats = []
  for name, segment_dirs in routes_service.grouped_segments().items():
    try:
      stats.append(cache.stats_for(name, segment_dirs))
    except OSError as error:
      print(f"Skipping unreadable route {name}: {error}")

  return stats


# --- assembly (pure: turns RouteStats into the frontend's shapes) -----------------------------------

def last_drive(all_stats, is_metric):
  if not all_stats:
    return None

  stats = all_stats[-1]
  return {
    "avgSpeed": round(speed_value(stats.avg_speed_ms, is_metric), 0),
    "distance": round(distance_value(stats.distance_m, is_metric), 1),
    "distanceUnit": distance_unit(is_metric),
    "durationMin": round(stats.duration_s / 60),
    "engagement": round(stats.engagement),
    "segments": stats.segments,
    "speedUnit": speed_unit(is_metric),
    "when": friendly_when(stats),
  }


def recent_drives(all_stats, is_metric):
  drives = []
  for stats in reversed(all_stats[-RECENT_DRIVES_LIMIT:]):
    drives.append({
      "distance": round(distance_value(stats.distance_m, is_metric), 1),
      "distanceUnit": distance_unit(is_metric),
      "duration": format_duration(stats.duration_s),
      "engagement": round(stats.engagement),
      "id": stats.name,
      "segments": stats.segments,
      "when": friendly_when(stats),
    })

  return drives


def records(all_stats, is_metric):
  driven = [stats for stats in all_stats if stats.distance_m > 0 and stats.epoch]
  if not driven:
    return {}

  by_day = group_by_day(driven)
  by_week = group_by_week(driven)

  longest = max(driven, key=lambda stats: stats.distance_m)
  most_engaged = max(by_day.values(), key=lambda day: day_engagement(day))
  best_week = max(by_week.values(), key=lambda week: sum(stats.distance_m for stats in week))

  unit = distance_unit(is_metric)
  return {
    "bestWeek": {
      "value": f"{round(distance_value(sum(stats.distance_m for stats in best_week), is_metric))} {unit}",
      "detail": week_label(best_week[0].epoch),
    },
    "highestStreak": {
      "value": streak_label(highest_streak(by_day)),
      "detail": None,
    },
    "longestDrive": {
      "value": f"{round(distance_value(longest.distance_m, is_metric), 1)} {unit}",
      "detail": day_label(longest.epoch),
    },
    "mostEngagedDay": {
      "value": f"{round(day_engagement(most_engaged))}%",
      "detail": day_label(most_engaged[0].epoch),
    },
  }


def this_week(all_stats, is_metric, now):
  start = (now - timedelta(days=WEEK_DAYS - 1)).date()
  week_stats = [stats for stats in all_stats if stats.epoch and datetime.fromtimestamp(stats.epoch).date() >= start]

  per_day = []
  today = now.date()
  for offset in range(WEEK_DAYS):
    day = start + timedelta(days=offset)
    day_stats = [stats for stats in week_stats if datetime.fromtimestamp(stats.epoch).date() == day]
    per_day.append({
      "label": day.strftime("%a"),
      "miles": round(distance_value(sum(stats.distance_m for stats in day_stats), is_metric), 1),
      "today": day == today,
    })

  if not week_stats:
    return {"perDay": per_day, "engagement": 0, "totals": None}

  total_samples = sum(stats.total_samples for stats in week_stats)
  enabled_samples = sum(stats.enabled_samples for stats in week_stats)
  return {
    "engagement": round(100.0 * enabled_samples / total_samples) if total_samples else 0,
    "perDay": per_day,
    "totals": {
      "distance": round(distance_value(sum(stats.distance_m for stats in week_stats), is_metric), 1),
      "distanceUnit": distance_unit(is_metric),
      "drives": len(week_stats),
      "hours": round(sum(stats.duration_s for stats in week_stats) / 3600, 1),
    },
  }


# --- per-route reconstruction (the heavy, cached half) ----------------------------------------------

class DriveStatsCache:
  def __init__(self):
    self.cache_path = DRIVE_STATS_CACHE_PATH
    self.cache_path.mkdir(parents=True, exist_ok=True)

  def stats_for(self, name, segment_dirs):
    source_mtime = max((segment_dir.stat().st_mtime for segment_dir in segment_dirs), default=0)
    cached = self.read(name, source_mtime)
    if cached is not None:
      return cached

    stats = reconstruct_route_stats(name, segment_dirs)
    self.write(name, stats)
    return stats

  def path_for(self, name):
    return self.cache_path / f"{name}.json"

  def read(self, name, source_mtime):
    path = self.path_for(name)
    if not path.is_file() or path.stat().st_mtime < source_mtime:
      return None

    try:
      return RouteStats(**json.loads(path.read_text()))
    except (TypeError, ValueError):
      # A cache file written by an older shape (or a partial write) is simply recomputed.
      return None

  def write(self, name, stats):
    self.path_for(name).write_text(json.dumps(asdict(stats)))


def reconstruct_route_stats(name, segment_dirs):
  # Distance and engagement come from one qlog pass per segment; duration comes from the qcamera track
  # via routes_service (the same probe the routes page uses), because qlog logMonoTime is cumulative over
  # the whole drive, not per-segment, so a min/max span over it would over-count badly. Segments are
  # tolerated individually: a partial or message-sparse qlog contributes whatever it has rather than
  # failing the route (verified on-device: some segments log no carState at all).
  distance_m = duration_s = 0.0
  enabled_samples = total_samples = 0

  for segment_dir in segment_dirs:
    if (segment_dir / RECORDING_LOCK_NAME).exists():
      continue

    duration_s += routes_service.segment_duration(segment_dir)
    segment = parse_segment_qlog(segment_dir / "qlog")
    distance_m += segment["distance_m"]
    enabled_samples += segment["enabled_samples"]
    total_samples += segment["total_samples"]

  return RouteStats(
    date=routes_service.route_date(segment_dirs[0]),
    distance_m=distance_m,
    duration_s=duration_s,
    enabled_samples=enabled_samples,
    epoch=route_epoch(segment_dirs[0]),
    name=name,
    segments=len(segment_dirs),
    total_samples=total_samples,
  )


def parse_segment_qlog(qlog_path):
  # Distance is the integral of vEgo over the gaps between consecutive carState samples (each ~0.1s,
  # capped so a logging hiccup cannot inflate it); engagement is the fraction of controlsState samples
  # that were enabled. Duration is NOT taken here — see reconstruct_route_stats.
  empty = {"distance_m": 0.0, "enabled_samples": 0, "total_samples": 0}
  if not qlog_path.is_file():
    return empty

  # Imported lazily so the rest of the module (and its assembly half) does not pull in capnp until a
  # real parse happens.
  from openpilot.tools.lib.logreader import LogReader

  distance_m = 0.0
  enabled_samples = total_samples = 0
  previous_mono = None

  try:
    for message in LogReader(str(qlog_path)):
      which = message.which()
      if which == "carState":
        mono = message.logMonoTime
        if previous_mono is not None:
          gap = min((mono - previous_mono) / NANOS_PER_SECOND, MAX_SAMPLE_GAP_SECONDS)
          distance_m += max(message.carState.vEgo, 0.0) * max(gap, 0.0)
        previous_mono = mono
      elif which == "controlsState":
        total_samples += 1
        if message.controlsState.enabled:
          enabled_samples += 1
  except Exception as error:
    # A truncated/corrupt qlog yields what was read before the failure rather than sinking the route.
    print(f"Partial qlog {qlog_path}: {error}")

  return {"distance_m": distance_m, "enabled_samples": enabled_samples, "total_samples": total_samples}


# --- small helpers ----------------------------------------------------------------------------------

def day_engagement(day_stats):
  total = sum(stats.total_samples for stats in day_stats)
  return (100.0 * sum(stats.enabled_samples for stats in day_stats) / total) if total else 0.0


def day_key(epoch):
  return datetime.fromtimestamp(epoch).date()


def day_label(epoch):
  if not epoch:
    return None

  # Built without strftime's "%-d" because that flag is glibc-only and raises on the PC/debug host.
  moment = datetime.fromtimestamp(epoch)
  return f"{moment.strftime('%b')} {moment.day}"


def distance_unit(is_metric):
  return "kilometers" if is_metric else "miles"


def distance_value(meters, is_metric):
  return meters * (0.001 if is_metric else CV.METER_TO_MILE)


def format_duration(seconds):
  # Rounded to the nearest minute so it agrees with last_drive's durationMin for the same route.
  minutes = round(seconds / 60)
  if minutes < 60:
    return f"{minutes}m"

  return f"{minutes // 60}h {minutes % 60:02d}m"


def friendly_when(stats):
  # A user-set custom route name wins; otherwise the recorded start time in a short, locale-free form
  # ("%-I"/"%-d" are glibc-only and raise on the PC/debug host, so the 12-hour clock is built by hand).
  if stats.epoch is None:
    return stats.date

  moment = datetime.fromtimestamp(stats.epoch)
  if stats.date and stats.date != moment.isoformat():
    return stats.date

  hour = moment.hour % 12 or 12
  return f"{moment.strftime('%b')} {moment.day}, {hour}:{moment.minute:02d} {moment.strftime('%p')}"


def group_by_day(driven):
  days = {}
  for stats in driven:
    days.setdefault(day_key(stats.epoch), []).append(stats)

  return days


def group_by_week(driven):
  weeks = {}
  for stats in driven:
    iso = datetime.fromtimestamp(stats.epoch).isocalendar()
    weeks.setdefault((iso[0], iso[1]), []).append(stats)

  return weeks


def highest_streak(by_day):
  # Longest run of consecutive calendar days that each have at least one drive, over retained footage.
  days = sorted(by_day)
  best = run = 0
  previous = None
  for day in days:
    run = run + 1 if previous is not None and (day - previous).days == 1 else 1
    best = max(best, run)
    previous = day

  return best


def metric():
  from openpilot.frogpilot.common.frogpilot_variables import params
  try:
    return params.get_bool("IsMetric")
  except Exception:
    return False


def route_epoch(segment_dir):
  rlog_path = segment_dir / "rlog"
  if rlog_path.exists():
    return rlog_path.stat().st_ctime

  return None


def speed_unit(is_metric):
  return "km/h" if is_metric else "mph"


def speed_value(speed_ms, is_metric):
  return speed_ms * (CV.MS_TO_KPH if is_metric else CV.MS_TO_MPH)


def streak_label(days):
  return f"{days} day" if days == 1 else f"{days} days"


def week_label(epoch):
  if not epoch:
    return None

  start = day_key(epoch) - timedelta(days=datetime.fromtimestamp(epoch).weekday())
  return f"week of {start.strftime('%b')} {start.day}"
