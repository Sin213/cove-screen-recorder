#!/usr/bin/env bash
# L-DISK-FULL teardown: unmount the tmpfs segment directory.
# Usage: sudo ./teardown.sh
set -euo pipefail

STATE_FILE="/run/cove-disk-full.state"

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: This script must be run as root (sudo ./teardown.sh)." >&2
  exit 1
fi

# Locate the private working directory written by setup.sh.
# STATE_FILE is in /run (root-writable only) so reading it is safe.
if [[ ! -f "$STATE_FILE" ]]; then
  echo "ERROR: State file $STATE_FILE not found — was setup.sh run?" >&2
  exit 1
fi

WORK_DIR=$(cat "$STATE_FILE")

if [[ -z "$WORK_DIR" || "$WORK_DIR" == "/" ]]; then
  echo "ERROR: State file contained an unsafe WORK_DIR value: '$WORK_DIR'" >&2
  exit 1
fi

MOUNT_DIR="$WORK_DIR/mount"

if mountpoint -q "$MOUNT_DIR" 2>/dev/null; then
  umount "$MOUNT_DIR"
  echo "[L-DISK-FULL] Unmounted $MOUNT_DIR"
else
  echo "[L-DISK-FULL] $MOUNT_DIR is not mounted — skipping unmount."
fi

rm -rf "$WORK_DIR"
echo "[L-DISK-FULL] Removed working directory $WORK_DIR"

rm -f "$STATE_FILE"
echo "[L-DISK-FULL] Removed state file $STATE_FILE"

echo "[L-DISK-FULL] Teardown complete."
