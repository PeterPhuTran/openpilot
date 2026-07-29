#!/usr/bin/env python3
import time

import numpy as np

from msgq.visionipc import VisionIpcClient, VisionStreamType

from openpilot.common.params import Params
from openpilot.common.realtime import Priority, config_realtime_process
from openpilot.common.swaglog import cloudlog

# VisionBSMZones format: {"left": [x0, y0, x1, y1], "right": [x0, y0, x1, y1]}
# with corners normalized to 0..1 of the driver camera frame

BACKGROUND_ALPHA = 0.1
BRIGHT_FRACTION_THRESHOLD = 0.10
BRIGHT_VALUE = 210
DEVIATION_THRESHOLD = 0.15
DOWNSAMPLE = 4
FRAME_SKIP = 4
HEARTBEAT_FRAMES = 5
HOLD_TIME = 1.0
RAISE_FRAMES = 3
RECONNECT_TIMEOUT = 50
TOGGLE_CHECK_TIME = 5.0


class ZoneState:
  def __init__(self):
    self.background = None
    self.positive_streak = 0
    self.last_positive = -HOLD_TIME

  def update(self, crop, now):
    zone = crop[::DOWNSAMPLE, ::DOWNSAMPLE].astype(np.float32)
    if zone.size == 0:
      return False

    detected = False
    if self.background is not None and self.background.shape == zone.shape:
      deviation = float(np.mean(np.abs(zone - self.background))) / (float(np.mean(self.background)) + 1.0)
      bright_fraction = float(np.mean(zone > BRIGHT_VALUE))
      detected = deviation > DEVIATION_THRESHOLD or bright_fraction > BRIGHT_FRACTION_THRESHOLD
      self.background = (1 - BACKGROUND_ALPHA) * self.background + BACKGROUND_ALPHA * zone
    else:
      self.background = zone

    self.positive_streak = self.positive_streak + 1 if detected else 0
    if self.positive_streak >= RAISE_FRAMES:
      self.last_positive = now
    return now - self.last_positive < HOLD_TIME


def parse_zones(zones):
  try:
    parsed = {}
    for side in ("left", "right"):
      x0, y0, x1, y1 = (float(value) for value in zones[side])
      if not 0 <= x0 < x1 <= 1 or not 0 <= y0 < y1 <= 1:
        return None
      parsed[side] = (x0, y0, x1, y1)
    return parsed
  except (KeyError, TypeError, ValueError):
    return None


def crop_zone(y_plane, zone):
  height, width = y_plane.shape
  x0, y0, x1, y1 = zone
  return y_plane[int(y0 * height):int(y1 * height), int(x0 * width):int(x1 * width)]


def publish_state(params_memory, left, right):
  params_memory.put("VisionBSMState", {"left": left, "right": right, "ts": time.clock_gettime(time.CLOCK_BOOTTIME)})


def vision_bsm_thread():
  config_realtime_process(5, Priority.CTRL_LOW)

  params = Params()
  params_memory = Params(memory=True)

  client = VisionIpcClient("camerad", VisionStreamType.VISION_STREAM_DRIVER, True)
  states = {"left": ZoneState(), "right": ZoneState()}
  connected = False
  zones = None
  frame_count = 0
  missed_frames = 0
  last_toggle_check = -TOGGLE_CHECK_TIME
  published = None

  while True:
    now = time.monotonic()
    if now - last_toggle_check > TOGGLE_CHECK_TIME:
      zones = parse_zones(params.get("VisionBSMZones")) if params.get_bool("VisionBSM") else None
      last_toggle_check = now

    if zones is None:
      if published != (False, False):
        publish_state(params_memory, False, False)
        published = (False, False)
      time.sleep(TOGGLE_CHECK_TIME)
      continue

    if not connected:
      if not client.connect(False):
        time.sleep(1)
        continue
      connected = True

    buf = client.recv()
    if buf is None:
      missed_frames += 1
      if missed_frames > RECONNECT_TIMEOUT:
        client = VisionIpcClient("camerad", VisionStreamType.VISION_STREAM_DRIVER, True)
        connected = False
        missed_frames = 0
      continue
    missed_frames = 0

    frame_count += 1
    if frame_count % FRAME_SKIP != 0:
      continue

    y_plane = np.frombuffer(buf.data[:buf.uv_offset], dtype=np.uint8).reshape((-1, buf.stride))[:buf.height, :buf.width]
    left = states["left"].update(crop_zone(y_plane, zones["left"]), now)
    right = states["right"].update(crop_zone(y_plane, zones["right"]), now)

    if (left, right) != published or frame_count % (FRAME_SKIP * HEARTBEAT_FRAMES) == 0:
      publish_state(params_memory, left, right)
      published = (left, right)


def main():
  while True:
    try:
      vision_bsm_thread()
    except Exception:
      cloudlog.exception("vision_bsm crashed")
      time.sleep(5)


if __name__ == "__main__":
  main()
