#!/usr/bin/env python3
from datetime import datetime

import openpilot.frogpilot.system.the_pond.services.drive_history_service as dh

from openpilot.frogpilot.system.the_pond.services.drive_history_service import RouteStats

# Imperial throughout so the asserted distances read in miles; the metric path is the same code with a
# different multiplier.
IS_METRIC = False


def route(name, day, hour=12, distance_m=1609.34, duration_s=600.0, enabled=50, total=100, custom_name=None):
  moment = datetime(2026, 6, day, hour)
  return RouteStats(
    date=custom_name or moment.isoformat(),
    distance_m=distance_m,
    duration_s=duration_s,
    enabled_samples=enabled,
    epoch=moment.timestamp(),
    name=name,
    segments=max(1, round(duration_s / 60)),
    total_samples=total,
  )


def test_format_duration_rounds_to_nearest_minute():
  assert dh.format_duration(0) == "0m"
  assert dh.format_duration(59) == "1m"
  assert dh.format_duration(90) == "2m"
  assert dh.format_duration(3690) == "1h 02m"


def test_friendly_when_formats_timestamp_without_iso():
  when = dh.friendly_when(route("a", 2, hour=15))
  assert "T" not in when and ":" in when and "Jun" in when


def test_friendly_when_prefers_custom_name():
  assert dh.friendly_when(route("a", 2, custom_name="Trip to the lake")) == "Trip to the lake"


def test_recent_drives_newest_first_and_capped():
  stats = sorted((route(f"r{i}", 1, hour=i) for i in range(dh.RECENT_DRIVES_LIMIT + 4)), key=lambda s: s.epoch)
  drives = dh.recent_drives(stats, IS_METRIC)
  assert len(drives) == dh.RECENT_DRIVES_LIMIT
  assert drives[0]["id"] == stats[-1].name


def test_last_drive_is_most_recent_with_engagement():
  last = dh.last_drive([route("old", 1), route("new", 3)], IS_METRIC)
  assert last["engagement"] == 50
  assert "T" not in last["when"]


def test_this_week_buckets_today():
  week = dh.this_week([route("today", 2, hour=3, distance_m=2 * 1609.34)], IS_METRIC, datetime(2026, 6, 2, 18))
  assert len(week["perDay"]) == dh.WEEK_DAYS
  assert week["perDay"][-1]["today"] is True
  assert week["perDay"][-1]["miles"] > 0
  assert week["totals"]["drives"] == 1


def test_records_streak_and_longest():
  stats = [route("d1", 1, distance_m=1000), route("d2", 2, distance_m=5000), route("d3", 3, distance_m=2000)]
  records = dh.records(stats, IS_METRIC)
  assert records["highestStreak"]["value"] == "3 days"
  assert records["longestDrive"]["value"].startswith("3.1")


def test_empty_inputs_degrade_to_empty_states():
  assert dh.last_drive([], IS_METRIC) is None
  assert dh.recent_drives([], IS_METRIC) == []
  assert dh.records([], IS_METRIC) == {}
  assert dh.this_week([], IS_METRIC, datetime(2026, 6, 2, 18))["totals"] is None
