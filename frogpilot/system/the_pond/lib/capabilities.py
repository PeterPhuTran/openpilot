#!/usr/bin/env python3
from openpilot.system.hardware import PC

from openpilot.frogpilot.system.the_pond.lib.errors import ApiError


def require_device():
  # Device-only operations (CAN, reboot, systemd, Panda) have no hardware to act on in PC/debug mode,
  # so they fail cleanly instead of crashing (REWRITE_PLAN §5.1, §3.2).
  if PC:
    raise ApiError("This action is only available on the device", 503)
