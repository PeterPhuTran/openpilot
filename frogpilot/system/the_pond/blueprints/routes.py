#!/usr/bin/env python3
from flask import Blueprint, Response, request, send_file

import openpilot.frogpilot.system.the_pond.services.routes_service as routes_service

from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.responses import message, ok
from openpilot.frogpilot.system.the_pond.lib.sse import SSE_MIMETYPE

routes = Blueprint("routes", __name__)


@routes.route("/api/routes", methods=["GET"])
def list_routes():
  return Response(routes_service.list_routes_stream(), headers={"Cache-Control": "no-cache"}, mimetype=SSE_MIMETYPE)


@routes.route("/api/routes/delete_all", methods=["DELETE"])
def delete_all_routes():
  routes_service.delete_all()
  return message("All routes deleted")


@routes.route("/api/routes/rename", methods=["POST"])
def rename_route():
  body = request.get_json(silent=True) or {}
  name = body.get("name")
  new_name = body.get("new")
  if not name or not new_name:
    raise ApiError("Both 'name' and 'new' names are required", 400)

  date = routes_service.rename(name, new_name)
  return ok({"date": date})


@routes.route("/api/routes/clear_name", methods=["POST"])
def clear_route_name():
  body = request.get_json(silent=True) or {}
  name = body.get("name")
  if not name:
    raise ApiError("A route name is required", 400)

  date = routes_service.clear_name(name)
  return ok({"date": date})


@routes.route("/api/routes/<name>/preserve", methods=["POST"])
def preserve_route(name):
  routes_service.preserve(name)
  return message("Route preserved")


@routes.route("/api/routes/<name>/preserve", methods=["DELETE"])
def unpreserve_route(name):
  routes_service.unpreserve(name)
  return message("Route no longer preserved")


@routes.route("/api/routes/<name>", methods=["GET"])
def get_route(name):
  return ok(routes_service.get_route(name))


@routes.route("/api/routes/<name>", methods=["DELETE"])
def delete_route(name):
  routes_service.delete(name)
  return message("Route deleted")


@routes.route("/video/<name>/combined", methods=["GET"])
def serve_combined_video(name):
  # Streamed via send_file (Range-aware) so a full-route playback or download is never read whole into
  # memory the way the old handler did (REWRITE_PLAN §3.2, §12.3).
  video_path = routes_service.combined_video(name, request.args.get("camera"))
  return send_file(video_path)


@routes.route("/video/<path:path>", methods=["GET"])
def serve_video(path):
  video_path = routes_service.wrapped_video(path, request.args.get("camera"))
  return send_file(video_path)


@routes.route("/thumbnails/<path:filename>", methods=["GET"])
def serve_thumbnail(filename):
  return send_file(routes_service.thumbnail_path(filename))
