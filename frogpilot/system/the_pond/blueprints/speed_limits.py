#!/usr/bin/env python3
import io

from flask import Blueprint, send_file

import openpilot.frogpilot.system.the_pond.services.speed_limits_service as speed_limits

speed_limits_bp = Blueprint("speed_limits", __name__)


@speed_limits_bp.route("/api/speed_limits", methods=["GET"])
def download_speed_limits():
  # The dataset is a param string, not a file on disk, so it is streamed from an in-memory buffer with
  # the same attachment shape the B3 download uses (Content-Disposition: attachment; speed_limits.json).
  payload = speed_limits.speed_limits_download()
  return send_file(io.BytesIO(payload), mimetype="application/json", as_attachment=True, download_name="speed_limits.json")
