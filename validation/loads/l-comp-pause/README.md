# L-COMP-PAUSE — Compositor Compositing Paused

Manual operator procedure. No script.

## Validation context

No canonical smoke-suite row targets compositor pause/resume directly.
(`VAL-CAP-004` is the 1080p60 L-MOTION-60 NVENC monitor-capture row, not a
compositor-toggle test.) This load is operator supporting evidence: use it to
verify the app does not crash or lose the session when compositor frame delivery
halts and resumes.

## Purpose

Tests that cove-screen-recorder tolerates a temporary halt in the compositor's
frame delivery — the condition that occurs when compositing is toggled off, the
desktop locks, or the session is switched to a VT.

## Operator procedure

The procedure differs by compositor.

### KDE Plasma (Wayland)

1. Start a capture session.
2. Open **System Settings → Display and Monitor → Compositor**.
3. Click **Suspend Compositor** (or press Alt+Shift+F12).
4. Wait 5 seconds.
5. Re-enable compositing (same shortcut/button).
6. Wait 5 seconds and verify capture resumes.

### GNOME (Wayland)

GNOME does not expose a compositing toggle. Simulate the pause by:
1. Locking the screen (`Super+L` or `loginctl lock-session`).
2. Waiting 5 seconds.
3. Unlocking the screen.

The compositor suspends frame delivery to portal consumers while locked.

### Sway

1. In a separate terminal, run:
   ```bash
   swaymsg output <OUTPUT_NAME> dpms off
   ```
   Replace `<OUTPUT_NAME>` with the output name from `swaymsg -t get_outputs`.
2. Wait 5 seconds.
3. Re-enable:
   ```bash
   swaymsg output <OUTPUT_NAME> dpms on
   ```

## Expected outcome

- During the compositor pause, cove-replay-engine stops receiving frames.
- The app does not crash or lose the session.
- When compositing resumes, frame delivery restarts and the capture continues.
- No segment write error or encoder error is surfaced during the pause period.
