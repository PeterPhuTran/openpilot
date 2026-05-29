#!/usr/bin/env python3
from flask import Blueprint

import openpilot.frogpilot.system.the_pond.services.tailscale_service as tailscale

from openpilot.frogpilot.system.the_pond.lib.responses import ok

tailscale_bp = Blueprint("tailscale", __name__)


@tailscale_bp.route("/api/tailscale/installed", methods=["GET"])
def installed():
  return ok(tailscale.installed_status())


@tailscale_bp.route("/api/tailscale/setup", methods=["POST"])
def setup():
  return ok(tailscale.setup())


@tailscale_bp.route("/api/tailscale/uninstall", methods=["POST"])
def uninstall():
  tailscale.uninstall()
  return ok({"installed": False})
