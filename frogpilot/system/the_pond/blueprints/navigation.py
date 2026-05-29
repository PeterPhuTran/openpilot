#!/usr/bin/env python3
from flask import Blueprint, request, send_file

import openpilot.frogpilot.system.the_pond.services.navigation_service as navigation_service

from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.responses import message, ok

navigation = Blueprint("navigation", __name__)


@navigation.route("/api/navigation", methods=["GET"])
def read_navigation():
  return ok(navigation_service.navigation_state())


@navigation.route("/api/navigation", methods=["POST"])
def set_navigation():
  body = request.get_json(silent=True) or {}
  navigation_service.set_destination(body)
  return message("Navigation set")


@navigation.route("/api/navigation", methods=["DELETE"])
def clear_navigation():
  navigation_service.clear_destination()
  return message("Navigation cleared")


@navigation.route("/api/navigation/favorite", methods=["GET"])
def list_favorites():
  return ok({"favorites": navigation_service.list_favorites()})


@navigation.route("/api/navigation/favorite", methods=["POST"])
def add_favorite():
  body = request.get_json(silent=True) or {}
  return message(navigation_service.add_favorite(body))


@navigation.route("/api/navigation/favorite", methods=["DELETE"])
def remove_favorite():
  body = request.get_json(silent=True) or {}
  return message(navigation_service.remove_favorite(body))


@navigation.route("/api/navigation/favorite/rename", methods=["POST"])
def rename_favorite():
  body = request.get_json(silent=True) or {}
  return message(navigation_service.rename_favorite(body))


@navigation.route("/api/navigation_key", methods=["POST"])
def save_navigation_key():
  body = request.get_json(silent=True) or {}
  return message(navigation_service.save_key(body))


@navigation.route("/api/navigation_keys", methods=["GET"])
def read_navigation_keys():
  return ok(navigation_service.navigation_key_state())


@navigation.route("/api/navigation_key", methods=["DELETE"])
def delete_navigation_key():
  kind = request.args.get("type")
  if not kind:
    raise ApiError("Missing key type", 400)

  return message(navigation_service.delete_key(kind))


@navigation.route("/mapbox-help/<path:filename>", methods=["GET"])
def serve_mapbox_help(filename):
  # send_file streams the setup screenshot; the service routes the name through safe_join so a traversal
  # attempt is rejected before any read (CONVENTIONS §3).
  return send_file(navigation_service.mapbox_help_image(filename))
