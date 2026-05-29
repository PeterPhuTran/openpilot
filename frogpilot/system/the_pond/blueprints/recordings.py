#!/usr/bin/env python3
from flask import Blueprint, Response, request, send_file

import openpilot.frogpilot.system.the_pond.services.recordings_service as recordings

from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.responses import message
from openpilot.frogpilot.system.the_pond.lib.sse import SSE_MIMETYPE

screen_recordings = Blueprint("screen_recordings", __name__)


@screen_recordings.route("/api/screen_recordings/delete_all", methods=["DELETE"])
def delete_all_recordings():
  recordings.delete_all()
  return message("All recordings deleted")


@screen_recordings.route("/api/screen_recordings/delete/<name>", methods=["DELETE"])
def delete_recording(name):
  recordings.delete(name)
  return message("Recording deleted")


@screen_recordings.route("/api/screen_recordings/download/<name>", methods=["GET"])
def download_recording(name):
  video_path = recordings.recording_video(name)
  return send_file(video_path, as_attachment=True, download_name=video_path.name)


@screen_recordings.route("/api/screen_recordings/list", methods=["GET"])
def list_recordings():
  return Response(recordings.list_recordings_stream(), headers={"Cache-Control": "no-cache"}, mimetype=SSE_MIMETYPE)


@screen_recordings.route("/api/screen_recordings/rename", methods=["POST"])
def rename_recording():
  body = request.get_json(silent=True) or {}
  old_name = body.get("old")
  new_name = body.get("new")
  if not old_name or not new_name:
    raise ApiError("Both 'old' and 'new' names are required", 400)

  recordings.rename(old_name, new_name)
  return message("Recording renamed")


@screen_recordings.route("/screen_recordings/<path:filename>", methods=["GET"])
def serve_recording_asset(filename):
  # Streamed via send_file (Range-aware), so a played-back recording is never read whole into memory
  # the way the old /video handler did (REWRITE_PLAN §3.2, §7.5).
  return send_file(recordings.asset_path(filename))
