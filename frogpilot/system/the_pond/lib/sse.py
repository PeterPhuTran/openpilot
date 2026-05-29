#!/usr/bin/env python3
import json

SSE_MIMETYPE = "text/event-stream"


def sse_message(payload):
  # One frame of a Server-Sent Events stream: a single `data:` line holding compact JSON, terminated
  # by the blank line that marks the end of the event (REWRITE_PLAN §5.1). Kept pure so both sides of
  # the protocol can be unit tested without Flask.
  return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"
