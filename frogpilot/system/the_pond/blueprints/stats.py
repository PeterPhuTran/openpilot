#!/usr/bin/env python3
from flask import Blueprint

import openpilot.frogpilot.system.the_pond.services.stats_service as stats_service

from openpilot.frogpilot.system.the_pond.lib.responses import ok

stats = Blueprint("stats", __name__)


@stats.route("/api/params", methods=["GET"])
def read_params():
  return ok(stats_service.params_dump())


@stats.route("/api/params_memory", methods=["GET"])
def read_params_memory():
  return ok(stats_service.params_memory_dump())


@stats.route("/api/stats", methods=["GET"])
def read_stats():
  return ok(stats_service.stats())
