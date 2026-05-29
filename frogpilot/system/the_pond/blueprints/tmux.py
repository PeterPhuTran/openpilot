#!/usr/bin/env python3
from flask import Blueprint, Response, request, send_file

import openpilot.frogpilot.system.the_pond.services.tmux_service as tmux_service

from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.responses import message, ok
from openpilot.frogpilot.system.the_pond.lib.sse import SSE_MIMETYPE

tmux = Blueprint("tmux", __name__)


@tmux.route("/api/tmux_log/live", methods=["GET"])
def stream_live_log():
  # A bounded, disconnect-aware SSE generator tails the launch log; the client's openStream().close()
  # aborts it so it stops at the next yield (REWRITE_PLAN §3.2, §3.4).
  return Response(tmux_service.live_stream(), headers={"Cache-Control": "no-cache"}, mimetype=SSE_MIMETYPE)


@tmux.route("/api/tmux_log/capture", methods=["POST"])
def capture_log():
  return ok(tmux_service.capture())


@tmux.route("/api/tmux_log/list", methods=["GET"])
def list_logs():
  return ok(tmux_service.list_logs())


@tmux.route("/api/tmux_log/download/<name>", methods=["GET"])
def download_log(name):
  log_path = tmux_service.tmux_log_file(name)
  return send_file(log_path, as_attachment=True, download_name=log_path.name)


@tmux.route("/api/tmux_log/rename", methods=["POST"])
def rename_log():
  body = request.get_json(silent=True) or {}
  old_name = body.get("old")
  new_name = body.get("new")
  if not old_name or not new_name:
    raise ApiError("Both 'old' and 'new' names are required", 400)

  return ok(tmux_service.rename(old_name, new_name))


@tmux.route("/api/tmux_log/delete_all", methods=["DELETE"])
def delete_all_logs():
  tmux_service.delete_all()
  return message("All logs deleted")


@tmux.route("/api/tmux_log/delete/<name>", methods=["DELETE"])
def delete_log(name):
  tmux_service.delete(name)
  return message("Log deleted")
