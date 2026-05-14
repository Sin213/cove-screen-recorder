#!/usr/bin/env bash
# L-MOTION-60 kiosk launcher — opens index.html in a fullscreen Chromium window.
# Requires: Chromium-based browser, Wayland compositor.
# Usage: ./launch.sh [--x11]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTML="file://$SCRIPT_DIR/index.html"
OZONE_PLATFORM="wayland"

if [[ "${1:-}" == "--x11" ]]; then
  OZONE_PLATFORM="x11"
fi

BROWSER=""
for BIN in chromium chromium-browser google-chrome-stable google-chrome; do
  if command -v "$BIN" &>/dev/null; then
    BROWSER="$BIN"
    break
  fi
done

if [[ -z "$BROWSER" ]]; then
  echo "ERROR: No Chromium-based browser found. Install chromium or google-chrome." >&2
  exit 1
fi

echo "Launching L-MOTION-60 with $BROWSER (ozone-platform=$OZONE_PLATFORM)..."
echo "Press Ctrl+C or close the window to stop."

PROFILE_DIR=$(mktemp -d)
BROWSER_PID=""
cleanup() {
  [[ -n "$BROWSER_PID" ]] && kill "$BROWSER_PID" 2>/dev/null || true
  rm -rf "$PROFILE_DIR"
}
trap cleanup EXIT INT TERM

"$BROWSER" \
  --user-data-dir="$PROFILE_DIR" \
  --kiosk \
  --ozone-platform="$OZONE_PLATFORM" \
  --no-first-run \
  --no-default-browser-check \
  --disable-infobars \
  --disable-notifications \
  --disable-translate \
  --disable-features=TranslateUI \
  --disable-background-networking \
  --disable-sync \
  "$HTML" &
BROWSER_PID=$!

wait "$BROWSER_PID"
