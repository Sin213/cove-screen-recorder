# L-SOURCE-REMOVE — Capture Source Removed During Session

Tests removal of the capture source while a capture session is active.

## Validation context

No canonical smoke-suite row targets source-window removal during capture directly.
(`VAL-CAP-004` is the 1080p60 L-MOTION-60 NVENC monitor-capture row, not a
source-removal test.) This load is operator supporting evidence: use it to verify
the app detects portal source loss and surfaces an error without crashing.

## Operator procedure (manual — preferred)

1. Start cove-screen-recorder with L-STATIC or L-MOTION-60 as the source window.
2. Begin a capture session.
3. Wait 10 seconds.
4. **Close the source window** using Alt+F4, the compositor window button, or `kill <browser-pid>`.
5. Observe the app UI within 5 seconds.

## Scripted fallback (wmctrl)

If the source window can be identified by title, use `close.sh`:

```bash
./close.sh "L-STATIC — Cove Validation Load"
./close.sh "L-MOTION-60 — Cove Validation Load"
```

Requires `wmctrl`:
```bash
sudo apt install wmctrl     # Debian/Ubuntu
sudo pacman -S wmctrl       # Arch
sudo dnf install wmctrl     # Fedora
```

Note: `wmctrl` uses `_NET_CLOSE_WINDOW` which sends a SIGTERM-equivalent request
to the window manager, not a direct process kill. If the browser ignores it,
fall back to manual close or `kill $(pgrep -u $UID chromium | head -1)`.

## Expected outcome

- The app detects that the source is gone (IPC disconnect or portal event).
- The app surfaces a source-lost error in the UI.
- The app does not crash or hang.
- The capture session stops cleanly; any segments written before the loss are preserved.
