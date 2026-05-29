#!/usr/bin/env python3


# Raised anywhere in a service or blueprint to short-circuit a request with a known failure and HTTP
# status. The app's error handler renders it into the uniform error envelope, so handlers never build
# error responses by hand (REWRITE_PLAN §5.1). Defined without Flask so services stay HTTP-free.
class ApiError(Exception):
  def __init__(self, message, status_code=400):
    super().__init__(message)

    self.status_code = status_code
    self.message = message
