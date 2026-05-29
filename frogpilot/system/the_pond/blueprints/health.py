#!/usr/bin/env python3
from flask import Blueprint

from openpilot.frogpilot.system.the_pond.lib.onroad import is_onroad
from openpilot.frogpilot.system.the_pond.lib.responses import ok

health = Blueprint("health", __name__)


@health.route("/api/health", methods=["GET"])
def read_status():
  # Exempt from the onroad gate so the shell can always reach it to learn whether to show the lockout
  # and to react when the car parks (REWRITE_PLAN §6).
  return ok({"onroad": is_onroad()})
