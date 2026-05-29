#!/usr/bin/env python3
from openpilot.frogpilot.common.frogpilot_variables import params


def speed_limits_download():
  # Serve the processed dataset (SpeedLimitsFiltered) speed_limit_filler produces as the speed_limits.json the
  # external SpeedLimitFiller tool ingests. An unset/empty param streams "[]" so the download always succeeds.
  return (params.get("SpeedLimitsFiltered", encoding="utf-8") or "[]").encode("utf-8")
