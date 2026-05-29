#!/usr/bin/env python3
from flask import Blueprint, request

import openpilot.frogpilot.system.the_pond.services.vehicle_service as vehicle

from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.responses import message, ok

vehicle_bp = Blueprint("vehicle", __name__)


@vehicle_bp.route("/api/car_features_check", methods=["GET"])
def car_features_check():
  return ok(vehicle.car_features_check())


@vehicle_bp.route("/api/fingerprints/makes", methods=["GET"])
def fingerprint_makes():
  return ok(vehicle.fingerprint_makes())


@vehicle_bp.route("/api/fingerprints/models", methods=["GET"])
def fingerprint_models():
  return ok(vehicle.fingerprint_models(request.args.get("make", "")))


@vehicle_bp.route("/api/fingerprints", methods=["POST"])
def set_fingerprint():
  body = request.get_json(silent=True) or {}
  make = body.get("make")
  model = body.get("model")
  name = body.get("name")
  if not make or not model or not name:
    raise ApiError("'make', 'model', and 'name' are required", 400)

  vehicle.set_fingerprint(make, model, name)
  return message("Fingerprint forced")


@vehicle_bp.route("/api/fingerprints", methods=["DELETE"])
def clear_fingerprint():
  vehicle.clear_fingerprint()
  return message("Fingerprint cleared")
