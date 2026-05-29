#!/usr/bin/env python3
from flask import Blueprint

import openpilot.frogpilot.system.the_pond.services.troubleshoot_service as troubleshoot_service

from openpilot.frogpilot.system.the_pond.lib.responses import ok

troubleshoot = Blueprint("troubleshoot", __name__)


@troubleshoot.route("/api/troubleshoot", methods=["GET"])
def list_issues():
  return ok(troubleshoot_service.troubleshoot())


@troubleshoot.route("/api/troubleshoot/reset", methods=["POST"])
def reset_issues():
  return ok(troubleshoot_service.reset())
