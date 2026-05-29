#!/usr/bin/env python3
import numpy as np

from openpilot.selfdrive.controls.lib.longitudinal_mpc_lib.long_mpc import LEAD_DANGER_FACTOR

TRAFFIC_FOLLOW_BP = [0.0,  20.0]
TRAFFIC_FOLLOW =    [0.60, 1.00]

TRAFFIC_DANGER_FACTOR = 0.90
TRAFFIC_DANGER_JERK = 2.4


class FrogPilotTraffic:
  def __init__(self):
    self.reset()

  def reset(self):
    self.active = False

    self.acceleration_jerk = 1.0
    self.danger_factor = TRAFFIC_DANGER_FACTOR
    self.danger_jerk = TRAFFIC_DANGER_JERK
    self.speed_jerk = 1.0
    self.t_follow = 1.0

    self.danger_factor = LEAD_DANGER_FACTOR

  def update(self, v_ego):
    self.active = True

    self.t_follow = float(np.interp(v_ego, TRAFFIC_FOLLOW_BP, TRAFFIC_FOLLOW))
