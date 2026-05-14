#!/usr/bin/env bash
# L-CRASH-EXP: Send SIGKILL to cove-replay-engine mid-export.
# Operator triggers this during an active export operation to validate
# that the app handles unexpected helper death gracefully.
#
# Usage: ./crash.sh
# No root required.
set -euo pipefail

HELPER_NAME="cove-replay-engine"

# Use -f (full command line) to match the binary path regardless of comm-name truncation.
# The anchored pattern avoids matching unrelated processes that contain the name as a substring.
# pgrep excludes its own PID automatically on Linux (procps).
PID=$(pgrep -u "$UID" -f '(^|/)cove-replay-engine([[:space:]]|$)' | head -1 || true)

if [[ -z "$PID" ]]; then
  echo "ERROR: $HELPER_NAME is not running (or not owned by $USER)." >&2
  echo "Start an export operation first, then run this script." >&2
  exit 1
fi

echo "[L-CRASH-EXP] Sending SIGKILL to $HELPER_NAME PID $PID..."
kill -KILL "$PID"
echo "[L-CRASH-EXP] Done. Check that the app shows an error state, not a hang or partial file."
