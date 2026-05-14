#!/usr/bin/env bash
# L-DISK-SLOW teardown: unmount and remove the dm-delay throttled device.
# Must be run as root after the capture session completes.
#
# Usage: sudo ./teardown.sh
set -euo pipefail

DEVICE_NAME="cove_slow"
STATE_FILE="/run/cove-disk-slow.state"

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

LOOP_FILE="$WORK_DIR/backing.img"
MOUNT_DIR="$WORK_DIR/mount"

echo "[L-DISK-SLOW] Tearing down throttled device (backing dir: $WORK_DIR)..."

if mountpoint -q "$MOUNT_DIR" 2>/dev/null; then
  umount "$MOUNT_DIR"
  echo "[L-DISK-SLOW] Unmounted $MOUNT_DIR"
fi

if dmsetup info "$DEVICE_NAME" &>/dev/null; then
  dmsetup remove "$DEVICE_NAME"
  echo "[L-DISK-SLOW] Removed /dev/mapper/$DEVICE_NAME"
fi

if [[ -f "$LOOP_FILE" ]]; then
  LOOP_DEV=$(losetup -j "$LOOP_FILE" 2>/dev/null | awk -F: '{print $1}' | head -1 || true)
  if [[ -n "$LOOP_DEV" ]]; then
    losetup -d "$LOOP_DEV"
    echo "[L-DISK-SLOW] Detached $LOOP_DEV"
  fi
fi

rm -rf "$WORK_DIR"
echo "[L-DISK-SLOW] Removed backing dir $WORK_DIR"

rm -f "$STATE_FILE"
echo "[L-DISK-SLOW] Removed state file $STATE_FILE"

echo "[L-DISK-SLOW] Teardown complete."
