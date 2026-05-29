#!/usr/bin/env python3
from flask import Blueprint, request, send_file

import openpilot.frogpilot.system.the_pond.services.themes_service as themes_service

from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.responses import message, ok

themes = Blueprint("themes", __name__)


@themes.route("/api/themes/list", methods=["GET"])
def list_themes():
  return ok({"themes": themes_service.build_theme_summaries()})


@themes.route("/api/themes/default", methods=["GET"])
def default_theme():
  return ok(themes_service.default_theme())


@themes.route("/api/themes/load/<path:path>", methods=["GET"])
def load_theme(path):
  theme_type = request.args.get("type", "user")
  return ok(themes_service.load_theme(path, theme_type))


@themes.route("/api/themes/asset/<theme>/<path:path>", methods=["GET"])
def serve_theme_asset(theme, path):
  # send_file streams the asset (Range-aware), and the service routes both the theme and the relative
  # path through safe_join so a traversal attempt is rejected before any read (REWRITE_PLAN §3.3).
  theme_type = request.args.get("type", "user")
  return send_file(themes_service.asset_file(theme, path, theme_type))


@themes.route("/api/themes", methods=["POST"])
def save_theme():
  themes_service.save_theme(request.form, request.files)
  return message("Theme saved")


@themes.route("/api/themes/apply", methods=["POST"])
def apply_theme():
  themes_service.apply_theme(request.form, request.files)
  return message("Theme applied")


@themes.route("/api/themes/download", methods=["POST"])
def download_theme():
  archive, download_name = themes_service.download_theme_zip(request.form, request.files)
  return send_file(archive, mimetype="application/zip", as_attachment=True, download_name=download_name)


@themes.route("/api/themes/download_asset", methods=["POST"])
def download_asset():
  body = request.get_json(silent=True) or {}
  component = body.get("component")
  name = body.get("name")
  if not component or not name:
    raise ApiError("Both 'component' and 'name' are required", 400)

  themes_service.download_asset(component, name)
  return message("Download started")


@themes.route("/api/themes/submit", methods=["POST"])
def submit_theme():
  themes_service.submit_theme(request.form, request.files)
  return message("Theme submitted")


@themes.route("/api/themes/delete/<path:path>", methods=["DELETE"])
def delete_theme(path):
  theme_type = request.args.get("type", "user")
  component = request.args.get("component") or None
  themes_service.delete_theme(path, theme_type, component)
  return message("Theme deleted")
