#!/usr/bin/env bash
# L-DISK-FULL setup: mount a 200 MiB tmpfs as the segment directory
# so it fills quickly during a capture session.
#
# Requires: root (sudo).
# Works on Linux. NOT supported on macOS or Windows.
#
# Usage: sudo ./setup.sh
#
# The actual mountpoint is created inside a private root-owned temp directory
# and printed at the end — configure cove-screen-recorder to use that path.
# Run teardown.sh when done.
set -euo pipefail

STATE_FILE="/run/cove-disk-full.state"

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: This script must be run as root (sudo ./setup.sh)." >&2
  exit 1
fi

if [[ -z "${SUDO_UID:-}" || -z "${SUDO_GID:-}" ]]; then
  echo "ERROR: SUDO_UID/SUDO_GID not set — run as 'sudo ./setup.sh', not 'su' or direct root." >&2
  exit 1
fi

if [[ -e "$STATE_FILE" ]]; then
  echo "ERROR: $STATE_FILE exists — a prior session may still be active." >&2
  echo "Run 'sudo ./teardown.sh' first, or remove the state file if stale." >&2
  exit 1
fi

# Private temp dir — random suffix, mode 700.
# Owned by the invoking user (SUDO_UID:SUDO_GID) so the non-root desktop app
# can traverse it.  Mode 700 keeps other local users out entirely.
WORK_DIR=$(mktemp -d -t cove_full.XXXXXXXXXX)
chown "$SUDO_UID:$SUDO_GID" "$WORK_DIR"
chmod 700 "$WORK_DIR"

MOUNT_DIR="$WORK_DIR/mount"
mkdir -m 755 "$MOUNT_DIR"

cleanup() {
  local ec=$?
  set +e  # Best-effort cleanup
  mountpoint -q "$MOUNT_DIR" 2>/dev/null && umount "$MOUNT_DIR" 2>/dev/null
  [[ -n "$WORK_DIR" && "$WORK_DIR" != "/" ]] && rm -rf "$WORK_DIR" 2>/dev/null
  rm -f "$STATE_FILE" 2>/dev/null
  if [[ $ec -ne 0 ]]; then
    echo "[L-DISK-FULL] Setup failed — partial resources cleaned up." >&2
  fi
  exit "$ec"
}
trap cleanup EXIT

mount -t tmpfs -o size=200m tmpfs "$MOUNT_DIR"
chown "$SUDO_UID:$SUDO_GID" "$MOUNT_DIR"
chmod 700 "$MOUNT_DIR"

# Persist state — WORK_DIR encodes the mountpoint (always $WORK_DIR/mount).
# /run is root-writable only; non-root cannot pre-place a symlink here.
printf '%s\n' "$WORK_DIR" > "$STATE_FILE"
chmod 600 "$STATE_FILE"

# Setup complete — disable the EXIT trap; teardown.sh owns cleanup from here.
trap - EXIT

echo "[L-DISK-FULL] 200 MiB tmpfs mounted"
echo "[L-DISK-FULL] Configure cove-screen-recorder to write segments to: $MOUNT_DIR"
echo "[L-DISK-FULL] Available space: $(df -h "$MOUNT_DIR" | tail -1 | awk '{print $4}')"
echo "[L-DISK-FULL] State: $STATE_FILE  Backing dir: $WORK_DIR"
echo "[L-DISK-FULL] Run teardown.sh (as root) when done."
