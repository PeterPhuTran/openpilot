#!/usr/bin/env python3
import openpilot.system.sentry as sentry

from openpilot.frogpilot.common.frogpilot_variables import params


def is_onroad():
  # Fail closed: if IsOnroad cannot be read we assume the car is moving and lock the app, so a params
  # backend hiccup can never expose the heavy features at speed (REWRITE_PLAN §6, §13). A value that
  # reads back cleanly as False is genuinely offroad, so a no-device PC stays unlocked (§7.9).
  try:
    return params.get_bool("IsOnroad")
  except Exception as exception:
    sentry.capture_exception(exception)
    return True
