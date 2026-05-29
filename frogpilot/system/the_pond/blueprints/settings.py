#!/usr/bin/env python3
from flask import Blueprint, request

import openpilot.frogpilot.system.the_pond.services.settings_service as settings

from openpilot.frogpilot.system.the_pond.lib.responses import message, ok

settings_blueprint = Blueprint("settings", __name__)


@settings_blueprint.route("/api/settings/schema", methods=["GET"])
def settings_schema():
  return ok(settings.build_schema())


@settings_blueprint.route("/api/params/all", methods=["GET"])
def params_all():
  return ok(settings.current_values())


@settings_blueprint.route("/api/params/defaults", methods=["GET"])
def params_defaults():
  return ok(settings.default_values())


@settings_blueprint.route("/api/params", methods=["PUT"])
def put_param():
  body = request.get_json(silent=True) or {}
  settings.put_value(body.get("key"), body.get("value"))
  return message("Setting saved")
