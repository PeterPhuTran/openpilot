#!/usr/bin/env python3
from flask import Blueprint, request

import openpilot.frogpilot.system.the_pond.services.models_service as models_service

from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.responses import message, ok

models = Blueprint("models", __name__)


@models.route("/api/models/installed", methods=["GET"])
def list_installed_models():
  return ok(models_service.installed())


@models.route("/api/models/catalog", methods=["GET"])
def list_catalog_models():
  return ok(models_service.catalog())


@models.route("/api/models/preferences", methods=["GET"])
def read_model_preferences():
  return ok(models_service.preferences())


@models.route("/api/models/preferences", methods=["PUT"])
def write_model_preferences():
  body = request.get_json(silent=True) or {}
  return ok(models_service.update_preferences(body))


@models.route("/api/models/status", methods=["GET"])
def read_download_status():
  return ok(models_service.status())


@models.route("/api/models/refresh_manifest", methods=["POST"])
def refresh_model_manifest():
  return ok(models_service.refresh_manifest())


@models.route("/api/models/download", methods=["POST"])
def download_model():
  body = request.get_json(silent=True) or {}
  key = body.get("key")
  if not key:
    raise ApiError("A model key is required", 400)

  models_service.download(key)
  return message("Model download started")


@models.route("/api/models/download_all", methods=["POST"])
def download_all_models():
  models_service.download_all()
  return message("Downloading all models")


@models.route("/api/models/cancel", methods=["POST"])
def cancel_model_download():
  models_service.cancel()
  return message("Download cancelled")


@models.route("/api/models/delete", methods=["POST"])
def delete_model():
  body = request.get_json(silent=True) or {}
  key = body.get("key")
  if not key:
    raise ApiError("A model key is required", 400)

  models_service.delete(key)
  return message("Model deleted")
