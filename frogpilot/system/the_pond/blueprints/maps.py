#!/usr/bin/env python3
from flask import Blueprint, request

import openpilot.frogpilot.system.the_pond.services.maps_service as maps_service

from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.responses import message, ok

maps = Blueprint("maps", __name__)


@maps.route("/api/maps/catalog", methods=["GET"])
def maps_catalog():
  return ok(maps_service.catalog())


@maps.route("/api/maps/status", methods=["GET"])
def maps_status():
  return ok(maps_service.maps_status())


@maps.route("/api/maps/selection", methods=["POST"])
def set_maps_selection():
  body = request.get_json(silent=True)
  if not isinstance(body, dict):
    raise ApiError("Selection must be an object with 'nations' and 'states' arrays", 400)

  return ok(maps_service.store_selection(body))


@maps.route("/api/maps/schedule", methods=["POST"])
def set_maps_schedule():
  body = request.get_json(silent=True) or {}
  schedule = body.get("schedule")
  if not isinstance(schedule, int) or isinstance(schedule, bool):
    raise ApiError("'schedule' must be an integer", 400)

  maps_service.set_schedule(schedule)
  return message("Schedule updated")


@maps.route("/api/maps/download", methods=["POST"])
def download_maps():
  maps_service.start_download()
  return message("Map download started")


@maps.route("/api/maps/cancel", methods=["POST"])
def cancel_maps_download():
  maps_service.cancel_download()
  return message("Map download cancelled")


@maps.route("/api/maps/remove", methods=["POST"])
def remove_maps():
  maps_service.remove_maps()
  return message("Downloaded maps removed")
