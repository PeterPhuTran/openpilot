#!/usr/bin/env python3
import threading
import time

from cereal import car, messaging
from opendbc.can.parser import CANParser
from openpilot.selfdrive.car.toyota.carcontroller import LOCK_CMD, UNLOCK_CMD

from openpilot.frogpilot.common.frogpilot_utilities import get_lock_status
from openpilot.frogpilot.common.frogpilot_variables import params
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError

# Toyota is the only make these CAN frames are valid for: LOCK_CMD/UNLOCK_CMD are sent on address 0x750
# of the Toyota body bus, and DOOR_LOCKS lives in the toyota_nodsu_pt_generated DBC (catalog Doors/CAN,
# carcontroller.py:47-48). A non-Toyota car must never be sent these bytes, so the action and its nav
# entry are gated on this make.
TOYOTA_MAKE = "toyota"

# 0x750 is the diagnostic address the Toyota body controller accepts the lock/unlock request on, bus 0
# (catalog Doors/CAN, frogpilot_utilities.lock_doors:257-259).
DOOR_LOCK_ADDRESS = 0x750

# get_lock_status reads DOOR_LOCKS/LOCK_STATUS off the CAN bus; 0 means the doors are locked, any other
# value means unlocked (catalog Doors/CAN, frogpilot_utilities.get_lock_status).
LOCKED_STATUS = 0

# The new bounded routine replaces the old lock_doors' unbounded `while True` (REWRITE_PLAN §3.2, §13):
# send the command, give the body controller a moment to act, re-read the lock status, and retry up to a
# fixed cap so a wrong car / quiet bus can never wedge the worker thread. The cap times the inter-attempt
# pause to a hard ceiling well under any HTTP client timeout.
DOOR_COMMAND_ATTEMPTS = 5
DOOR_COMMAND_INTERVAL_SECONDS = 1.0

# The app is served threaded=True (the_pond.py:19), so two concurrent door POSTs would each open a
# PubMaster on the single "sendcan" endpoint; the second bind raises MultiplePublishersError
# (msgq/ipc_pyx.pyx:227-234), which would escape as a generic 500 instead of the uniform envelope. A
# non-blocking guard rejects the overlapping request cleanly with a 409 instead.
_command_lock = threading.Lock()


def doors_available():
  # The doors action is Toyota-only, so the nav entry and the lock/unlock endpoints are gated on the
  # car make read from the persisted CarParams (verified mechanism: frogpilot_variables.py:581-607 reads
  # "CarParamsPersistent" and uses CP.carName). CarParamsPersistent survives offroad, which is the only
  # state the gate is reachable in, so it is the right source here.
  return car_make() == TOYOTA_MAKE


def car_make():
  car_params_bytes = params.get("CarParamsPersistent")
  if not car_params_bytes:
    return None

  with car.CarParams.from_bytes(car_params_bytes) as car_params:
    return car_params.carName


def lock():
  return run_door_command(LOCK_CMD, expect_locked=True, success_message="Doors locked", failure_message="Could not confirm the doors locked")


def unlock():
  return run_door_command(UNLOCK_CMD, expect_locked=False, success_message="Doors unlocked", failure_message="Could not confirm the doors unlocked")


def run_door_command(command, expect_locked, success_message, failure_message):
  if not doors_available():
    raise ApiError("Door control is only available on supported Toyota vehicles", 400)

  # Only one command may hold the "sendcan" endpoint at a time. acquire(blocking=False) rejects a
  # concurrent POST with a clean 409 instead of letting the second PubMaster bind raise
  # MultiplePublishersError → 500. try/finally guarantees the lock is released even on a 502/exception.
  if not _command_lock.acquire(blocking=False):
    raise ApiError("A door command is already in progress", 409)

  try:
    # One scoped CAN handle for the whole bounded routine — a single PubMaster, sub_sock and CANParser
    # are opened once and reused across the retries, instead of the old loop that reopened a handle every
    # pass (REWRITE_PLAN §3.2): pm publishes the command, can_sock + can_parser read the lock status.
    pm = messaging.PubMaster(["sendcan"])
    can_sock = messaging.sub_sock("can", timeout=100)
    can_parser = CANParser("toyota_nodsu_pt_generated", [("DOOR_LOCKS", 3)], bus=0)

    for _ in range(DOOR_COMMAND_ATTEMPTS):
      send_door_command(pm, command)

      # Let the body controller act on the frame before polling, so the status read reflects this attempt.
      time.sleep(DOOR_COMMAND_INTERVAL_SECONDS)

      if is_locked(can_parser, can_sock) == expect_locked:
        return success_message

    # Bounded exit: every attempt was sent and the doors never reported the requested state, so the
    # action failed cleanly with a 502 rather than blocking the request forever (REWRITE_PLAN §3.2, §5.1).
    raise ApiError(failure_message, 502)
  finally:
    _command_lock.release()


def send_door_command(pm, command):
  message = messaging.new_message("sendcan", 1)
  message.sendcan[0].address = DOOR_LOCK_ADDRESS
  message.sendcan[0].dat = command
  message.sendcan[0].src = 0
  pm.send("sendcan", message)


def is_locked(can_parser, can_sock):
  return get_lock_status(can_parser, can_sock) == LOCKED_STATUS
