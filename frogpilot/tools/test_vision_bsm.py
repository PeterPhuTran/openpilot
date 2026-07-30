#!/usr/bin/env python3
"""Feeds synthetic scenarios through the real vision_bsm detection classes.

Usage: test_vision_bsm.py <vision_bsm.py> <zones.json> <driver_cam_frame.jpg>

Frames are generated at the daemon's effective processing rate (5 Hz) and run
through vision_bsm.Detector, the same object the daemon's main loop uses.
"""
import importlib.util
import json
import sys
import types

import numpy as np
from PIL import Image

DT = 0.2  # seconds per processed frame (daemon: 20 fps / FRAME_SKIP 4)


def stub(name, **attrs):
  mod = types.ModuleType(name)
  for key, value in attrs.items():
    setattr(mod, key, value)
  sys.modules[name] = mod
  return mod


stub("msgq")
stub("msgq.visionipc", VisionIpcClient=object,
     VisionStreamType=types.SimpleNamespace(VISION_STREAM_DRIVER=1))
stub("openpilot")
stub("openpilot.common")
stub("openpilot.common.params", Params=object)
stub("openpilot.common.realtime", Priority=types.SimpleNamespace(CTRL_LOW=0),
     config_realtime_process=lambda *a, **k: None)
stub("openpilot.common.swaglog", cloudlog=types.SimpleNamespace(exception=lambda *a, **k: None))

spec = importlib.util.spec_from_file_location("vision_bsm", sys.argv[1])
vb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vb)

with open(sys.argv[2]) as f:
  zones = vb.parse_zones(json.load(f))
assert zones is not None, "zones failed to parse"

day_base = np.array(Image.open(sys.argv[3]).convert("L"), dtype=np.uint8)
H, W = day_base.shape
night_base = (day_base * 0.12).astype(np.uint8)
bright_base = np.clip(day_base.astype(np.float32) * 1.6, 0, 255).astype(np.uint8)

yy, xx = np.mgrid[0:H, 0:W]


def blob(frame, cx, cy, rx, ry, value):
  mask = ((xx - cx * W) / (rx * W)) ** 2 + ((yy - cy * H) / (ry * H)) ** 2 <= 1
  out = frame.copy()
  out[mask] = value
  return out


def run_scenario(name, base_fn, events, n_frames, expectations):
  detector = vb.Detector(zones)
  timeline = []
  for i in range(n_frames):
    t = i * DT
    frame = base_fn(t) if callable(base_fn) else base_fn
    for (t0, t1, path, value, rx, ry) in events:
      if t0 <= t < t1:
        p = (t - t0) / (t1 - t0)
        cx = path[0][0] + (path[1][0] - path[0][0]) * p
        cy = path[0][1] + (path[1][1] - path[0][1]) * p
        frame = blob(frame, cx, cy, rx, ry, value)
    left, right = detector.process(frame, t)
    timeline.append((t, left, right))

  print(f"=== {name} ===")
  prev = (False, False)
  for (t, left, right) in timeline:
    if (left, right) != prev:
      print(f"  t={t:5.1f}s  left={'ON ' if left else 'off'}  right={'ON ' if right else 'off'}")
      prev = (left, right)

  ok = True
  for (t0, t1, side, expected, label) in expectations:
    window = [fr for fr in timeline if t0 <= fr[0] < t1]
    active = any((fr[1] if side == "left" else fr[2]) for fr in window)
    status = "PASS" if active == expected else "FAIL"
    if active != expected:
      ok = False
    print(f"  [{status}] {label}: {side} expected {'active' if expected else 'quiet'} in {t0}-{t1}s, got {'active' if active else 'quiet'}")
  return ok


all_ok = True

# --- Scenario 1: daylight ---
day_events = [
  (10.0, 12.6, [(0.94, 0.46), (0.70, 0.40)], 40, 0.05, 0.07),
  (20.0, 22.6, [(0.40, 0.75), (0.60, 0.75)], 40, 0.05, 0.07),
]
day_expect = [
  (2.0, 10.0, "left", False, "daylight static, driver side quiet"),
  (2.0, 10.0, "right", False, "daylight static, passenger side quiet (bright garage!)"),
  (10.4, 13.6, "left", True, "passing car detected in driver zone"),
  (15.0, 20.0, "left", False, "released after car gone"),
  (20.0, 23.6, "left", False, "out-of-zone motion ignored (left)"),
  (20.0, 23.6, "right", False, "out-of-zone motion ignored (right)"),
]
all_ok &= run_scenario("DAYLIGHT", day_base, day_events, 120, day_expect)

# --- Scenario 2: night ---
night_events = [
  (10.0, 12.5, [(0.92, 0.47), (0.72, 0.42)], 250, 0.04, 0.05),
]
night_expect = [
  (2.0, 10.0, "left", False, "night static quiet"),
  (10.4, 13.5, "left", True, "headlights detected in driver zone"),
  (15.0, 18.0, "left", False, "released after headlights gone"),
]
all_ok &= run_scenario("NIGHT", night_base, night_events, 90, night_expect)

# --- Scenario 3: global exposure step (camera auto-exposure, tunnel, dawn) ---
exposure_events = [
  (15.0, 17.6, [(0.94, 0.46), (0.70, 0.40)], 40, 0.05, 0.07),
]
exposure_expect = [
  (2.0, 10.0, "left", False, "pre-step static quiet"),
  (10.0, 14.0, "left", False, "no latch after exposure step (left)"),
  (10.0, 14.0, "right", False, "no latch after exposure step (right)"),
  (15.4, 18.6, "left", True, "car still detected after rebase recovery"),
  (20.0, 25.0, "left", False, "released"),
]
all_ok &= run_scenario("EXPOSURE STEP", lambda t: day_base if t < 10.0 else bright_base,
                       exposure_events, 125, exposure_expect)

print("RESULT:", "ALL PASS" if all_ok else "FAILURES PRESENT")
sys.exit(0 if all_ok else 1)
