#!/usr/bin/env bash
# L-SOURCE-REMOVE scripted fallback: close the capture source window via wmctrl.
# Use this when the source is a window that can be identified by title.
# Prefer manual close (Alt+F4 or compositor window button) per README.md.
#
# Usage: ./close.sh "Window Title Substring"
# Requires: wmctrl
set -euo pipefail

TITLE="${1:-}"

if [[ -z "$TITLE" ]]; then
  echo "Usage: ./close.sh \"Window Title Substring\"" >&2
  exit 1
fi

if ! command -v wmctrl &>/dev/null; then
  echo "ERROR: wmctrl not installed. Install with: sudo apt install wmctrl" >&2
  exit 1
fi

echo "[L-SOURCE-REMOVE] Closing window matching: $TITLE"
wmctrl -c "$TITLE"
echo "[L-SOURCE-REMOVE] Done. Verify the capture source disappeared in the app."
