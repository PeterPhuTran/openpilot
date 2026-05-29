#!/usr/bin/env python3
from flask import Blueprint, send_file

import openpilot.frogpilot.system.the_pond.services.error_logs_service as error_logs_service

from openpilot.frogpilot.system.the_pond.lib.responses import message, ok

error_logs = Blueprint("error_logs", __name__)


@error_logs.route("/api/error_logs", methods=["GET"])
def list_error_logs():
  return ok(error_logs_service.list_error_logs())


@error_logs.route("/api/error_logs/delete_all", methods=["DELETE"])
def delete_all_error_logs():
  error_logs_service.delete_all()
  return message("All error logs deleted")


@error_logs.route("/api/error_logs/<filename>", methods=["GET"])
def view_error_log(filename):
  # send_file streams the log file rather than reading it whole, and the service routes the name
  # through safe_join so a traversal attempt is rejected before any read (REWRITE_PLAN §3.3).
  return send_file(error_logs_service.error_log_file(filename), mimetype="text/plain")


@error_logs.route("/api/error_logs/<filename>", methods=["DELETE"])
def delete_error_log(filename):
  error_logs_service.delete(filename)
  return message("Error log deleted")
