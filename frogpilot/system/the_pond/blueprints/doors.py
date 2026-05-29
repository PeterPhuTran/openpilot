#!/usr/bin/env python3
from flask import Blueprint

import openpilot.frogpilot.system.the_pond.services.doors_service as doors

from openpilot.frogpilot.system.the_pond.lib.capabilities import require_device
from openpilot.frogpilot.system.the_pond.lib.responses import message, ok

doors_blueprint = Blueprint("doors", __name__)


@doors_blueprint.route("/api/doors_available", methods=["GET"])
def doors_available():
  return ok({"result": doors.doors_available()})


@doors_blueprint.route("/api/doors/lock", methods=["POST"])
def lock_doors():
  # CAN access has no hardware to act on in PC/debug mode, so the device-only action fails cleanly with
  # a 503 there instead of crashing (CONVENTIONS §5). The global onroad gate already blocks it onroad.
  require_device()
  return message(doors.lock())


@doors_blueprint.route("/api/doors/unlock", methods=["POST"])
def unlock_doors():
  require_device()
  return message(doors.unlock())
