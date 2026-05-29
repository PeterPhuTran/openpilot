#!/usr/bin/env python3
from flask import Blueprint, request

import openpilot.frogpilot.system.the_pond.services.update_service as update_service

from openpilot.frogpilot.system.the_pond.lib.capabilities import require_device
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.responses import message, ok

update = Blueprint("update", __name__)


@update.route("/api/update/branches", methods=["GET"])
def list_branches():
  return ok({"branches": update_service.available_branches(), "current": update_service.current_branch()})


@update.route("/api/update/fast", methods=["POST"])
def start_fast_update():
  # Device-only: the update reboots the device, so it cannot run in PC/debug mode. require_device() and the
  # global onroad gate guard it; the service dispatches the reboot-bound updater on a background thread, so
  # this response is returned before any side effect runs (REWRITE_PLAN §13, CONVENTIONS §5).
  require_device()
  update_service.start_fast_update()
  return message("Update started")


@update.route("/api/update/fast/status", methods=["GET"])
def read_fast_status():
  return ok(update_service.fast_status())


@update.route("/api/update/branch", methods=["POST"])
def start_branch_switch():
  require_device()

  body = request.get_json(silent=True) or {}
  branch = body.get("branch")
  if not branch:
    raise ApiError("A branch name is required", 400)

  # The destructive part (download + reboot onto the new branch) runs on a background thread the service
  # dispatches, so the response returns before the side effect, exactly like the fast update.
  update_service.start_branch_switch(branch)
  return message("Branch switch started")
