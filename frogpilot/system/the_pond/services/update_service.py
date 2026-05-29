#!/usr/bin/env python3
# Import sentry first to break the latent frogpilot_variables -> car_helpers -> sentry -> frogpilot_variables
# cycle: a cold import of frogpilot_variables (directly or via the utilities below) raises unless sentry is
# loaded first, so this side-effect import must lead (CONVENTIONS §0, matches lib/onroad.py).
import openpilot.system.sentry as sentry  # noqa: F401

from openpilot.system.version import get_build_metadata

from openpilot.frogpilot.common.frogpilot_utilities import run_thread_with_lock, update_openpilot
from openpilot.frogpilot.common.frogpilot_variables import params, params_memory
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError

# The updater (system/updated/updated.py) is the single source of truth for the branch/update param
# contract; every key below is one the updater itself reads or writes, never invented here.

# The persistent param the updater writes the comma-separated list of remote branches it discovered into
# (updated.py Updater.set_params -> params.put("UpdaterAvailableBranches", ",".join(...)); declared
# PERSISTENT in common/params.cc:206). An unpopulated device (updater has not checked yet) reports none.
AVAILABLE_BRANCHES_KEY = "UpdaterAvailableBranches"

# Human-readable descriptions of the installed build and the staged update, written by the updater
# (updated.py Updater.set_params -> params.put("UpdaterCurrentDescription"/"UpdaterNewDescription", ...);
# both CLEAR_ON_MANAGER_START in common/params.cc:207/210). Surfaced read-only so the UI can show what is
# installed now and what an install would switch to.
CURRENT_DESCRIPTION_KEY = "UpdaterCurrentDescription"
NEW_DESCRIPTION_KEY = "UpdaterNewDescription"

# The volatile flag the on-device panel raises alongside the update signal so the updater's main loop
# actually fetches rather than only checking (updated.py:454/486/492 gate the fetch on
# "ManualUpdateInitiated" OR automatic_updates). The reused update_openpilot() sends the wake signals but
# does not raise this flag, so a manual action must raise it first to match the panel's flow
# (software_settings.cc:47/92).
MANUAL_UPDATE_KEY = "ManualUpdateInitiated"

# The branch the updater targets on its next check/fetch. Writing this is the verified branch-switch
# mechanism: the on-device software panel sets it the exact same way before triggering an update
# (software_settings.cc:84 params.put("UpdaterTargetBranch", ...)). updated.py Updater.target_branch reads
# it and falls back to the current branch when unset (updated.py:246-250).
TARGET_BRANCH_KEY = "UpdaterTargetBranch"

# The updater's progress-state param (updated.py writes "idle"/"checking..."/"downloading..."/"finalizing
# update..."; CLEAR_ON_MANAGER_START in common/params.cc:212). It only sits at "idle" when no check,
# download, or finalize is running, so a new action is only safe to start from idle — mirroring the
# on-device panel, which disables its buttons for any non-idle state (software_settings.cc:173).
UPDATER_STATE_KEY = "UpdaterState"
UPDATER_IDLE_STATE = "idle"


def available_branches():
  raw = params.get(AVAILABLE_BRANCHES_KEY, encoding="utf-8")
  if not raw:
    return []

  # De-duplicate while preserving the updater's order, dropping blanks from a trailing/empty comma so a
  # malformed value never yields phantom branches.
  branches = []
  for branch in raw.split(","):
    name = branch.strip()
    if name and name not in branches:
      branches.append(name)

  return branches


def current_branch():
  return get_build_metadata().channel


def fast_status():
  build_metadata = get_build_metadata()
  openpilot_metadata = build_metadata.openpilot

  return {
    "commitDate": openpilot_metadata.git_commit_date,
    "commitHash": openpilot_metadata.git_commit,
    "currentBranch": build_metadata.channel,
    "currentDescription": params.get(CURRENT_DESCRIPTION_KEY, encoding="utf-8") or "",
    "fetchAvailable": params.get_bool("UpdaterFetchAvailable"),
    "newDescription": params.get(NEW_DESCRIPTION_KEY, encoding="utf-8") or "",
    "targetBranch": params.get(TARGET_BRANCH_KEY, encoding="utf-8") or build_metadata.channel,
    "updateAvailable": params.get_bool("UpdateAvailable"),
    "updaterState": params.get(UPDATER_STATE_KEY, encoding="utf-8") or UPDATER_IDLE_STATE,
    "version": openpilot_metadata.version,
  }


def require_idle_updater():
  state = params.get(UPDATER_STATE_KEY, encoding="utf-8")

  # Treat an unread/empty state as idle: the param is CLEAR_ON_MANAGER_START (common/params.cc:212) so it is
  # genuinely empty right after boot before the updater writes "idle", and blocking then would wedge the UI.
  if state and state != UPDATER_IDLE_STATE:
    raise ApiError("An update is already in progress", 409)


def start_branch_switch(branch):
  # Switching to a different branch is the same verified flow the on-device software panel runs: write the
  # target branch, raise the manual-update flag, then let the proven update_openpilot() send the updater's
  # wake signals, wait for the download to finalize, and reboot onto the target (software_settings.cc:81-94;
  # update_openpilot reuses the SIGUSR1/SIGHUP signals + UpdaterState/UpdateAvailable polling). No git op is
  # hand-rolled here; the updater performs every fetch/checkout/finalize step.
  target = validated_branch(branch)

  # Reject a no-op switch (already on the target) before the busy check, so a request to "switch" to the
  # current branch always gets the clearer message rather than racing the updater's state.
  if target == current_branch():
    raise ApiError("Already on that branch", 409)

  require_idle_updater()

  params.put(TARGET_BRANCH_KEY, target)
  params_memory.put_bool(MANUAL_UPDATE_KEY, True)

  run_thread_with_lock("update_openpilot", update_openpilot)


def start_fast_update():
  # Reuse the proven updater path rather than any ad-hoc git operation (REWRITE_PLAN §13): update_openpilot
  # checks for an update on the current target branch, downloads it offroad, and reboots when it finalizes.
  # It is dispatched on the pre-declared "update_openpilot" lock so a second request never spawns a
  # competing updater run, and the blueprint returns its response before this thread does any work.
  require_idle_updater()

  params_memory.put_bool(MANUAL_UPDATE_KEY, True)

  run_thread_with_lock("update_openpilot", update_openpilot)


def validated_branch(branch):
  name = (branch or "").strip()
  if not name:
    raise ApiError("A branch name is required", 400)

  # Only branches the updater itself published are switchable: an arbitrary name would make the updater
  # fetch a ref that does not exist and fail mid-flow. This bounds the action to verified, real branches.
  if name not in available_branches():
    raise ApiError("Unknown branch", 400)

  return name
