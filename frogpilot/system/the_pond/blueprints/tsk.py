#!/usr/bin/env python3
from flask import Blueprint, request

import openpilot.frogpilot.system.the_pond.services.tsk_service as tsk

from openpilot.frogpilot.system.the_pond.lib.responses import message, ok

tsk_bp = Blueprint("tsk", __name__)


@tsk_bp.route("/api/tsk_available", methods=["GET"])
def tsk_available():
  return ok({"result": tsk.tsk_available()})


@tsk_bp.route("/api/tsk_keys", methods=["GET"])
def list_keys():
  return ok(tsk.list_keys())


@tsk_bp.route("/api/tsk_keys", methods=["POST"])
def save_key():
  body = request.get_json(silent=True) or {}
  return ok(tsk.save_key(body.get("name"), body.get("value")))


@tsk_bp.route("/api/tsk_keys", methods=["DELETE"])
def delete_key():
  # The service owns the empty-name 400 (like save_key/apply_key validate inside the service); the
  # blueprint just forwards the query-string name, which may be None for a missing ?name=.
  return ok(tsk.delete_key(request.args.get("name")))


@tsk_bp.route("/api/tsk_key_set", methods=["POST"])
def apply_key():
  body = request.get_json(silent=True) or {}
  tsk.apply_key(body.get("name"))
  return message("Key applied")
