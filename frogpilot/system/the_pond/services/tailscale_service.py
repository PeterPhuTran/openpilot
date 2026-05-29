#!/usr/bin/env python3
import hashlib
import json
import shutil
import subprocess
import tarfile

from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from urllib.request import urlopen

from openpilot.frogpilot.common.frogpilot_utilities import is_url_pingable, run_cmd
from openpilot.frogpilot.system.the_pond.lib.capabilities import require_device
from openpilot.frogpilot.system.the_pond.lib.errors import ApiError

# Pinned, known-good Tailscale static build (REWRITE_PLAN §2: never "latest" — an upstream release is
# the exact thing that breaks the device). The static tarball ships the tailscale + tailscaled binaries
# and a systemd/tailscaled.service unit, verified at pkgs.tailscale.com/stable. comma3 is aarch64, so
# the arm64 build is the one that runs.
TAILSCALE_VERSION = "1.98.4"
TAILSCALE_ARCHITECTURE = "arm64"
TAILSCALE_PACKAGE_URL = f"https://pkgs.tailscale.com/stable/tailscale_{TAILSCALE_VERSION}_{TAILSCALE_ARCHITECTURE}.tgz"
TAILSCALE_PACKAGE_SHA256 = "3cb068eb1368b6bb218d0ef0aa0a7a679a7156b7c979e2279cc2c2321b5f05c7"
TAILSCALE_PACKAGE_ROOT = f"tailscale_{TAILSCALE_VERSION}_{TAILSCALE_ARCHITECTURE}"
SERVICE_UNIT_NAME = "tailscaled.service"
TAILSCALED_DEFAULTS_PACKAGE_NAME = "tailscaled.defaults"
TAILSCALE_REQUIRED_PACKAGE_FILES = frozenset(
  {
    f"{TAILSCALE_PACKAGE_ROOT}/tailscale",
    f"{TAILSCALE_PACKAGE_ROOT}/tailscaled",
    f"{TAILSCALE_PACKAGE_ROOT}/systemd/{SERVICE_UNIT_NAME}",
    f"{TAILSCALE_PACKAGE_ROOT}/systemd/{TAILSCALED_DEFAULTS_PACKAGE_NAME}",
  }
)
TAILSCALE_ALLOWED_PACKAGE_DIRECTORIES = frozenset({TAILSCALE_PACKAGE_ROOT, f"{TAILSCALE_PACKAGE_ROOT}/systemd"})
TAILSCALE_ALLOWED_PACKAGE_FILES = frozenset(
  {
    *TAILSCALE_REQUIRED_PACKAGE_FILES,
    f"{TAILSCALE_PACKAGE_ROOT}/systemd/tailscale-online.target",
    f"{TAILSCALE_PACKAGE_ROOT}/systemd/tailscale-wait-online.service",
  }
)

# The static binary lives on the read-only root, so the install has to remount / read-write and put it
# back exactly the way it was (the FrogPilot boot-logo swap uses this same findmnt/remount idiom).
BINARY_INSTALL_DIR = Path("/usr/bin")
DAEMON_INSTALL_DIR = Path("/usr/sbin")
DEFAULTS_INSTALL_DIR = Path("/etc/default")
SERVICE_INSTALL_DIR = Path("/etc/systemd/system")
TAILSCALE_BINARY = BINARY_INSTALL_DIR / "tailscale"
TAILSCALED_BINARY = DAEMON_INSTALL_DIR / "tailscaled"
TAILSCALED_DEFAULTS = DEFAULTS_INSTALL_DIR / "tailscaled"

# Bounds for the privileged steps. The download/extract and systemd actions terminate quickly; the
# login step is the one that would otherwise block forever, so it is capped and the auth URL is read off
# the daemon's first status frame rather than waiting for the browser handshake (REWRITE_PLAN §7.7).
DOWNLOAD_TIMEOUT_SECONDS = 60
LOGIN_TIMEOUT_SECONDS = 30


def installed_status():
  # A pure read so the status check works in PC/debug mode too: the binary either exists on disk or it
  # does not. Nothing here shells out or touches systemd.
  return {"installed": is_installed()}


def setup():
  require_device()

  if is_installed():
    # Idempotent: a second setup must not reinstall, but the user still needs a fresh login link, so we
    # re-run the bounded `tailscale up` to hand back the current auth URL.
    return {"auth_url": login_auth_url()}

  if not is_url_pingable(TAILSCALE_PACKAGE_URL):
    raise ApiError("Could not reach the Tailscale download server. Check the device's internet connection and try again.", 502)

  install_tailscale()

  if not is_installed():
    raise ApiError("Tailscale installation failed. Check the device logs for details.", 500)

  return {"auth_url": login_auth_url()}


def uninstall():
  require_device()

  # Stop and disable the daemon before the binaries go, so systemd is not left pointing at a unit whose
  # ExecStart no longer exists. Each step shells out through run_cmd, which reports a failure to sentry
  # and returns None rather than raising, so a partial state (e.g. unit already gone) never wedges.
  run_cmd(["sudo", "systemctl", "disable", "--now", SERVICE_UNIT_NAME], "Stopped and disabled tailscaled", "Failed to stop tailscaled")

  stock_mount_options = capture_mount_options()
  remount_read_write()
  try:
    for path in (SERVICE_INSTALL_DIR / SERVICE_UNIT_NAME, TAILSCALE_BINARY, TAILSCALED_BINARY, TAILSCALED_DEFAULTS):
      run_cmd(["sudo", "rm", "-f", str(path)], f"Removed {path}", f"Failed to remove {path}")
  finally:
    restore_mount_options(stock_mount_options)

  run_cmd(["sudo", "systemctl", "daemon-reload"], "Reloaded systemd", "Failed to reload systemd")


def install_tailscale():
  # The whole sequence runs inside a single read-write window: capture the stock mount options, remount /
  # read-write, copy the binaries + unit into place, then restore the original (read-only) options in a
  # finally so a failure mid-copy can never leave / writable (REWRITE_PLAN §7.7, §13).
  with TemporaryDirectory() as workspace:
    binary_dir = download_and_extract(Path(workspace))

    stock_mount_options = capture_mount_options()
    remount_read_write()
    try:
      run_cmd(["sudo", "cp", str(binary_dir / "tailscale"), str(TAILSCALE_BINARY)], "Installed tailscale binary", "Failed to install tailscale binary")
      run_cmd(["sudo", "cp", str(binary_dir / "tailscaled"), str(TAILSCALED_BINARY)], "Installed tailscaled binary", "Failed to install tailscaled binary")
      run_cmd(
        ["sudo", "cp", str(binary_dir / "systemd" / TAILSCALED_DEFAULTS_PACKAGE_NAME), str(TAILSCALED_DEFAULTS)],
        "Installed tailscaled defaults",
        "Failed to install tailscaled defaults",
      )
      run_cmd(
        ["sudo", "cp", str(binary_dir / "systemd" / SERVICE_UNIT_NAME), str(SERVICE_INSTALL_DIR / SERVICE_UNIT_NAME)],
        "Installed tailscaled service unit",
        "Failed to install tailscaled service unit",
      )
    finally:
      restore_mount_options(stock_mount_options)

  run_cmd(["sudo", "systemctl", "daemon-reload"], "Reloaded systemd", "Failed to reload systemd")
  run_cmd(["sudo", "systemctl", "enable", "--now", SERVICE_UNIT_NAME], "Enabled and started tailscaled", "Failed to enable tailscaled")


def download_and_extract(workspace):
  # Pull the pinned tarball over a bounded request, verify the exact known digest, then extract only the
  # package members we expect. This endpoint installs privileged binaries, so a changed or hostile tarball
  # must fail closed before anything is copied into system paths.
  archive_path = workspace / f"tailscale_{TAILSCALE_VERSION}_{TAILSCALE_ARCHITECTURE}.tgz"

  try:
    with urlopen(TAILSCALE_PACKAGE_URL, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
      archive_bytes = response.read()
      verify_package_digest(archive_bytes)
      archive_path.write_bytes(archive_bytes)
  except OSError as error:
    raise ApiError("Could not download Tailscale. Check the device's internet connection and try again.", 502) from error

  extract_tailscale_archive(archive_path, workspace)

  binary_dir = workspace / TAILSCALE_PACKAGE_ROOT
  if not all((workspace / member).is_file() for member in TAILSCALE_REQUIRED_PACKAGE_FILES):
    raise ApiError("The downloaded Tailscale package was not in the expected format.", 500)

  return binary_dir


def verify_package_digest(archive_bytes):
  digest = hashlib.sha256(archive_bytes).hexdigest()
  if digest != TAILSCALE_PACKAGE_SHA256:
    raise ApiError("The downloaded Tailscale package failed verification.", 500)


def extract_tailscale_archive(archive_path, workspace):
  try:
    with tarfile.open(archive_path, mode="r:gz") as archive:
      members = archive.getmembers()
      validate_package_members(members)
      validate_archive_service_unit(archive)
      for member in members:
        extract_package_member(archive, member, workspace)
  except (tarfile.TarError, OSError) as error:
    raise ApiError("The downloaded Tailscale package was not in the expected format.", 500) from error


def validate_package_members(members):
  seen = set()
  regular_files = set()
  for member in members:
    if member.name in seen or not package_member_allowed(member):
      raise ApiError("The downloaded Tailscale package was not in the expected format.", 500)

    seen.add(member.name)
    if member.isfile():
      regular_files.add(member.name)

  if not TAILSCALE_REQUIRED_PACKAGE_FILES.issubset(regular_files):
    raise ApiError("The downloaded Tailscale package was not in the expected format.", 500)


def validate_archive_service_unit(archive):
  try:
    source = archive.extractfile(f"{TAILSCALE_PACKAGE_ROOT}/systemd/{SERVICE_UNIT_NAME}")
    if source is None:
      raise ApiError("The downloaded Tailscale package was not in the expected format.", 500)

    with source:
      unit_text = source.read().decode("utf-8")
  except UnicodeDecodeError as error:
    raise ApiError("The downloaded Tailscale package was not in the expected format.", 500) from error

  validate_service_unit_text(unit_text)


def validate_service_unit_text(unit_text):
  expected_lines = {
    f"EnvironmentFile={TAILSCALED_DEFAULTS}",
    f"ExecStart={TAILSCALED_BINARY} --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock --port=${{PORT}} $FLAGS",
    f"ExecStopPost={TAILSCALED_BINARY} --cleanup",
  }
  actual_lines = {line.strip() for line in unit_text.splitlines()}
  if not expected_lines.issubset(actual_lines):
    raise ApiError("The downloaded Tailscale service unit does not match the installed paths.", 500)


def package_member_allowed(member):
  if not safe_package_member_name(member.name):
    return False

  if member.isdir():
    return member.name in TAILSCALE_ALLOWED_PACKAGE_DIRECTORIES

  if member.isfile():
    return member.name in TAILSCALE_ALLOWED_PACKAGE_FILES

  return False


def safe_package_member_name(name):
  if not name or "\\" in name:
    return False

  path = PurePosixPath(name)
  return not path.is_absolute() and all(part not in ("", ".", "..") for part in path.parts)


def extract_package_member(archive, member, workspace):
  relative_path = Path(*PurePosixPath(member.name).parts)
  target = workspace / relative_path
  if member.isdir():
    target.mkdir(parents=True, exist_ok=True)
    return

  source = archive.extractfile(member)
  if source is None:
    raise ApiError("The downloaded Tailscale package was not in the expected format.", 500)

  target.parent.mkdir(parents=True, exist_ok=True)
  with source, target.open("wb") as output:
    shutil.copyfileobj(source, output)
  target.chmod(member.mode & 0o777)


def login_auth_url():
  # `tailscale up` registers the login with the daemon and prints the auth URL, then blocks until the
  # browser handshake completes. We only want the URL: read the daemon's first JSON frame, cap the wait,
  # and kill the child rather than letting it hold a worker thread. The daemon keeps the login pending,
  # so the user finishes auth by visiting the URL after the request has already returned.
  try:
    process = subprocess.Popen(
      [str(TAILSCALE_BINARY), "up", "--json", f"--timeout={LOGIN_TIMEOUT_SECONDS}s"],
      stdout=subprocess.PIPE,
      stderr=subprocess.DEVNULL,
      text=True,
    )
  except OSError as error:
    raise ApiError("Could not start Tailscale login.", 500) from error

  try:
    auth_url = read_auth_url(process)
  finally:
    terminate(process)

  if not auth_url:
    raise ApiError("Tailscale did not return a login URL. Check the device logs and try again.", 502)

  return auth_url


def read_auth_url(process):
  # tailscale --json emits whole JSON objects, one per status transition; the first carrying an AuthURL
  # is the login link. Reading line by line lets us stop and return the moment it appears instead of
  # waiting for the (blocking) handshake frame that follows.
  if process.stdout is None:
    return None

  decoder = json.JSONDecoder()
  buffer = ""
  for line in process.stdout:
    buffer += line
    while buffer.strip():
      try:
        frame, end = decoder.raw_decode(buffer.strip())
      except json.JSONDecodeError:
        break

      auth_url = frame.get("AuthURL")
      if auth_url:
        trusted_url = trusted_login_url(auth_url)
        if trusted_url:
          return trusted_url

      buffer = buffer.strip()[end:]

  return None


def trusted_login_url(value):
  if not isinstance(value, str):
    return None

  parsed = urlsplit(value)
  if parsed.scheme != "https" or parsed.hostname != "login.tailscale.com":
    return None

  if parsed.username or parsed.password:
    return None

  return value


def terminate(process):
  if process.poll() is not None:
    return

  process.terminate()
  try:
    process.wait(timeout=LOGIN_TIMEOUT_SECONDS)
  except subprocess.TimeoutExpired:
    process.kill()
    process.wait(timeout=LOGIN_TIMEOUT_SECONDS)


def capture_mount_options():
  # Snapshot the live mount options for / so they can be restored verbatim; if findmnt is unreadable we
  # fall back to a plain read-only remount, which is the safe default for the device's root.
  try:
    options = subprocess.check_output(["findmnt", "-no", "OPTIONS", "/"], text=True, timeout=DOWNLOAD_TIMEOUT_SECONDS).strip()
  except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
    print(f"Could not read root mount options, will restore read-only: {error}")
    return "ro"

  return options or "ro"


def remount_read_write():
  run_cmd(["sudo", "mount", "-o", "remount,rw", "/"], "Remounted / as read-write", "Failed to remount / as read-write")


def restore_mount_options(stock_mount_options):
  run_cmd(["sudo", "mount", "-o", f"remount,{stock_mount_options}", "/"], "Restored / mount options", "Failed to restore / mount options")


def is_installed():
  return TAILSCALE_BINARY.is_file()
