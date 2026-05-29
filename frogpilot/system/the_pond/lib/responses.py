#!/usr/bin/env python3
from flask import jsonify


# The one success/error envelope every endpoint returns (REWRITE_PLAN §5.1): success is the payload
# (or {"message": ...}); failure is {"error": ...} with the right status. Blueprints call these
# instead of hand-rolling tuples, so the contract stays uniform across every domain.
def error(message, status_code):
  return jsonify({"error": message}), status_code


def message(text, status_code=200):
  return jsonify({"message": text}), status_code


def ok(data=None, status_code=200):
  return jsonify(data if data is not None else {}), status_code
