#!/usr/bin/env bash
# L-DISK-SLOW setup: throttle the segment write directory to ~50 MB/s
# using the Linux dm-delay kernel module.
#
# Requires: root (sudo), dm-setup, Linux kernel with dm-delay.
# Tested on Arch/Ubuntu/Fedora/Debian. NOT supported on macOS or Windows.
#
# Usage:
#   sudo ./setup.sh
#
# The actual mountpoint is created inside a private root-owned temp directory
# and printed at the end — configure cove-screen-recorder to use that path.
# Run teardown.sh when done.
#
# See README.md for the full operator procedure.
set -euo pipefail

DEVICE_NAME="cove_slow"
SIZE_SECTORS=2097152   # 1 GiB in 512-byte sectors
DELAY_MS=20            # 20ms per I/O → ~50 MB/s effective write throughput

# State file in /run (root-writable only) so teardown can locate resources
# without relying on a predictable /tmp path.
STATE_FILE="/run/cove-disk-slow.state"

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

if ! modprobe dm-delay 2>/dev/null; then
  echo "ERROR: dm-delay kernel module not available. Check kernel config." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Resource tracking for partial-failure cleanup.
# Each variable is set after the corresponding resource is created so the
# EXIT trap knows exactly what to tear down if something goes wrong.
# ---------------------------------------------------------------------------
WORK_DIR=""
LOOP_DEV=""
DM_CREATED=0
MOUNTED=0

cleanup() {
  local ec=$?
  set +e  # Best-effort cleanup — never re-exit inside the trap
  if [[ "$MOUNTED" -eq 1 ]]; then
    umount "$WORK_DIR/mount" 2>/dev/null
  fi
  if [[ "$DM_CREATED" -eq 1 ]]; then
    dmsetup remove "$DEVICE_NAME" 2>/dev/null
  fi
  if [[ -n "$LOOP_DEV" ]]; then
    losetup -d "$LOOP_DEV" 2>/dev/null
  fi
  if [[ -n "$WORK_DIR" && "$WORK_DIR" != "/" ]]; then
    rm -rf "$WORK_DIR" 2>/dev/null
  fi
  rm -f "$STATE_FILE" 2>/dev/null
  if [[ $ec -ne 0 ]]; then
    echo "[L-DISK-SLOW] Setup failed — partial resources cleaned up." >&2
  fi
  exit "$ec"
}
trap cleanup EXIT

echo "[L-DISK-SLOW] Creating backing device and dm-delay target..."

# Private temp dir — random suffix, mode 700.
# Owned by the invoking user (SUDO_UID:SUDO_GID) so the non-root desktop app
# can traverse it.  Mode 700 keeps other local users out entirely.
WORK_DIR=$(mktemp -d -t cove_slow.XXXXXXXXXX)
chown "$SUDO_UID:$SUDO_GID" "$WORK_DIR"
chmod 700 "$WORK_DIR"

LOOP_FILE="$WORK_DIR/backing.img"
MOUNT_DIR="$WORK_DIR/mount"
mkdir -m 755 "$MOUNT_DIR"

dd if=/dev/zero of="$LOOP_FILE" bs=1M count=1024 status=none
chmod 600 "$LOOP_FILE"
LOOP_DEV=$(losetup -f --show "$LOOP_FILE")

echo "0 $SIZE_SECTORS delay $LOOP_DEV 0 $DELAY_MS" | dmsetup create "$DEVICE_NAME"
DM_CREATED=1

mkfs.ext4 -q "/dev/mapper/$DEVICE_NAME"
mount "/dev/mapper/$DEVICE_NAME" "$MOUNT_DIR"
MOUNTED=1
chown "$SUDO_UID:$SUDO_GID" "$MOUNT_DIR"
chmod 700 "$MOUNT_DIR"

# Persist state — WORK_DIR encodes the mountpoint (always $WORK_DIR/mount).
# /run is root-writable only; non-root cannot pre-place a symlink here.
printf '%s\n' "$WORK_DIR" > "$STATE_FILE"
chmod 600 "$STATE_FILE"

# Setup complete — disable the EXIT trap; teardown.sh owns cleanup from here.
trap - EXIT

echo "[L-DISK-SLOW] Throttled mount ready (~50 MB/s)"
echo "[L-DISK-SLOW] Configure cove-screen-recorder to write segments to: $MOUNT_DIR"
echo "[L-DISK-SLOW] Loop device: $LOOP_DEV  DM target: /dev/mapper/$DEVICE_NAME"
echo "[L-DISK-SLOW] State: $STATE_FILE  Backing dir: $WORK_DIR"
echo "[L-DISK-SLOW] Run teardown.sh (as root) when done."
