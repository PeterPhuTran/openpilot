#!/usr/bin/env python3
import io

from flask import Blueprint, request, send_file

import openpilot.frogpilot.system.the_pond.services.toggles_service as toggles_service

from openpilot.frogpilot.system.the_pond.lib.responses import message

toggles = Blueprint("toggles", __name__)


@toggles.route("/api/toggles/backup", methods=["POST"])
def backup_toggles():
  # The backup is a JSON snapshot built from params, not a file on disk, so it is streamed from an
  # in-memory buffer with the same attachment shape the B3 download uses.
  payload = toggles_service.backup()
  return send_file(io.BytesIO(payload), mimetype="application/json", as_attachment=True, download_name=toggles_service.BACKUP_FILENAME)


@toggles.route("/api/toggles/reset_default", methods=["POST"])
def reset_toggles_default():
  # The response is returned first; the service schedules the reboot on a short-delay thread so the
  # client sees the confirmation before the process restarts (REWRITE_PLAN §3.2, §13).
  toggles_service.reset_default()
  return message("Resetting toggles to their default values. The device will reboot.")


@toggles.route("/api/toggles/reset_stock", methods=["POST"])
def reset_toggles_stock():
  toggles_service.reset_stock()
  return message("Resetting toggles to stock openpilot values. The device will reboot.")


@toggles.route("/api/toggles/restore", methods=["POST"])
def restore_toggles():
  payload = request.get_json(silent=True)
  applied = toggles_service.restore(payload)
  return message(f"Restored {applied} toggles")
