#!/usr/bin/env python3
import traceback

from ipaddress import ip_address
from urllib.parse import urlsplit

from flask import Flask, abort, render_template, request
from werkzeug.exceptions import HTTPException

import openpilot.system.sentry as sentry

from openpilot.frogpilot.system.the_pond.blueprints.doors import doors_blueprint
from openpilot.frogpilot.system.the_pond.blueprints.error_logs import error_logs
from openpilot.frogpilot.system.the_pond.blueprints.health import health
from openpilot.frogpilot.system.the_pond.blueprints.maps import maps
from openpilot.frogpilot.system.the_pond.blueprints.models import models
from openpilot.frogpilot.system.the_pond.blueprints.navigation import navigation
from openpilot.frogpilot.system.the_pond.blueprints.recordings import screen_recordings
from openpilot.frogpilot.system.the_pond.blueprints.routes import routes
from openpilot.frogpilot.system.the_pond.blueprints.settings import settings_blueprint
from openpilot.frogpilot.system.the_pond.blueprints.speed_limits import speed_limits_bp
from openpilot.frogpilot.system.the_pond.blueprints.stats import stats
from openpilot.frogpilot.system.the_pond.blueprints.tailscale import tailscale_bp
from openpilot.frogpilot.system.the_pond.blueprints.themes import themes
from openpilot.frogpilot.system.the_pond.blueprints.tmux import tmux
from openpilot.frogpilot.system.the_pond.blueprints.toggles import toggles
from openpilot.frogpilot.system.the_pond.blueprints.troubleshoot import troubleshoot
from openpilot.frogpilot.system.the_pond.blueprints.tsk import tsk_bp
from openpilot.frogpilot.system.the_pond.blueprints.update import update
from openpilot.frogpilot.system.the_pond.blueprints.vehicle import vehicle_bp
from openpilot.frogpilot.system.the_pond.config import ESSENTIAL_ENDPOINTS
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError
from openpilot.frogpilot.system.the_pond.lib.onroad import is_onroad
from openpilot.frogpilot.system.the_pond.lib.responses import error

CSRF_HEADER = "X-The-Pond-CSRF"
FORM_CONTENT_TYPES = frozenset({"application/x-www-form-urlencoded", "multipart/form-data", "text/plain"})
LOCAL_HOSTNAMES = frozenset({"0.0.0.0", "127.0.0.1", "::1", "comma", "localhost"})
UNSAFE_METHODS = frozenset({"DELETE", "OPTIONS", "PATCH", "POST", "PUT"})


def create_app():
  app = Flask(__name__, static_folder="assets", static_url_path="/assets", template_folder="templates")

  register_blueprints(app)
  register_error_handlers(app)
  register_onroad_gate(app)
  register_access_boundary(app)
  register_security_headers(app)

  @app.route("/")
  @app.route("/<path:path>")
  def index(path=""):
    # Single-page-app shell: client routes resolve to index.html so a deep-link refresh still loads,
    # while an unmatched API path falls through to the JSON 404 handler instead of the shell.
    if path.startswith("api/"):
      abort(404)

    return render_template("index.html")

  return app


def register_blueprints(app):
  app.register_blueprint(doors_blueprint)
  app.register_blueprint(error_logs)
  app.register_blueprint(health)
  app.register_blueprint(maps)
  app.register_blueprint(models)
  app.register_blueprint(navigation)
  app.register_blueprint(routes)
  app.register_blueprint(screen_recordings)
  app.register_blueprint(settings_blueprint)
  app.register_blueprint(speed_limits_bp)
  app.register_blueprint(stats)
  app.register_blueprint(tailscale_bp)
  app.register_blueprint(themes)
  app.register_blueprint(tmux)
  app.register_blueprint(toggles)
  app.register_blueprint(troubleshoot)
  app.register_blueprint(tsk_bp)
  app.register_blueprint(update)
  app.register_blueprint(vehicle_bp)


def register_error_handlers(app):
  # One place turns exceptions into the uniform {"error": ...} envelope (REWRITE_PLAN §5.1): known
  # failures keep their status, and anything unexpected is logged and reported as a 500 rather than
  # leaking a stack trace or HTML to the client.
  @app.errorhandler(ApiError)
  def handle_api_error(exception):
    return error(exception.message, exception.status_code)

  @app.errorhandler(HTTPException)
  def handle_http_error(exception):
    return error(exception.description or exception.name, exception.code)

  @app.errorhandler(Exception)
  def handle_unexpected_error(exception):
    print(traceback.format_exc())
    sentry.capture_exception(exception)

    return error("Internal server error", 500)


def register_onroad_gate(app):
  # One gate, not a per-route check (REWRITE_PLAN §5.1, §6): every non-essential endpoint is rejected
  # with 423 while the car is onroad, so heavy work never contends with the driving stack and hitting
  # the API directly is blocked too.
  @app.before_request
  def enforce_onroad_lockout():
    if request.endpoint in ESSENTIAL_ENDPOINTS:
      return None

    if is_onroad():
      return error("The Pond is unavailable while you're driving. Please safely pull over and park to use it!", 423)

    return None


def register_access_boundary(app):
  @app.before_request
  def enforce_access_boundary():
    if not host_allowed(request.host):
      return error("Host is not allowed", 403)

    if request.method not in UNSAFE_METHODS:
      return None

    fetch_site = (request.headers.get("Sec-Fetch-Site") or "").lower()
    if fetch_site == "cross-site":
      return error("Cross-site requests are not allowed", 403)

    origin = request.headers.get("Origin")
    if origin and not same_origin(origin, request.host, request.scheme):
      return error("Cross-site requests are not allowed", 403)

    if request.path.startswith("/api/") and request.headers.get(CSRF_HEADER) != "1":
      if form_content_type(request.content_type):
        return error("Form submissions are not accepted", 415)

      return error("Missing request verification header", 403)

    return None


def register_security_headers(app):
  @app.after_request
  def add_security_headers(response):
    response.headers.setdefault("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    response.headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    if request.path.startswith("/api/"):
      response.headers.setdefault("Cache-Control", "no-store")
      response.headers.setdefault("Pragma", "no-cache")
    return response


def form_content_type(content_type):
  media_type = (content_type or "").split(";", 1)[0].strip().lower()
  return media_type in FORM_CONTENT_TYPES


def host_allowed(host):
  hostname, _ = host_port(host)
  if not hostname:
    return False

  if hostname in LOCAL_HOSTNAMES or hostname.endswith(".local"):
    return True

  try:
    return not ip_address(hostname).is_global
  except ValueError:
    return False


def same_origin(origin, host, scheme):
  parsed = urlsplit(origin)
  if parsed.scheme not in ("http", "https") or not parsed.netloc:
    return False

  if parsed.scheme != scheme:
    return False

  origin_host, origin_port = host_port(parsed.netloc, default_port(parsed.scheme))
  request_host, request_port = host_port(host, default_port(scheme))
  return origin_host == request_host and origin_port == request_port


def host_port(netloc, default=None):
  parsed = urlsplit(f"//{netloc}")
  hostname = (parsed.hostname or "").lower()
  try:
    port = parsed.port
  except ValueError:
    return "", None

  return hostname, port or default


def default_port(scheme):
  return 443 if scheme == "https" else 80
