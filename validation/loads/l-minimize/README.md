# L-MINIMIZE — Window Minimize During Capture

Manual operator procedure. No script.

## Validation rows served

| Row ID       | Description |
|--------------|-------------|
| VAL-CAP-006  | Minimised window captures 60 s without frame loss — Issue #3 proof |

## Operator procedure

1. Start cove-screen-recorder with a window source.
2. Begin a capture session using L-STATIC or L-MOTION-60 in the source window.
3. Wait 5 seconds.
4. **Minimize** the source window using the compositor-specific method below.
5. Wait 5 seconds in minimized state.
6. **Restore** the source window using the compositor-specific method below.
7. Wait 5 seconds.
8. Repeat minimize/restore cycle twice more.
9. Stop capture and export.

## Compositor-specific minimize/restore

### KDE Plasma (Wayland) — M1, M3

- **Minimize:** Click the minimize button in the title bar, or press `Meta+Down`.
- **Restore:** Click the taskbar entry, or press `Meta+Down` again.

### GNOME (Wayland) — M2

GNOME 40+ hides the minimize button by default. Options:
- Enable the button via GNOME Tweaks → Windows → Titlebar Buttons → Minimize.
- Or use the Window Menu: right-click the title bar → Minimize.
- Restore by clicking the window in the Activities overview or the taskbar (if using a dock extension).

```bash
# Scripted minimize on XWayland (GNOME, if running a Chromium --ozone-platform=x11 window):
xdotool windowminimize "$(xdotool search --name 'L-MOTION-60' | head -1)"
# Restore:
xdotool windowactivate "$(xdotool search --name 'L-MOTION-60' | head -1)"
```

### Sway / wlroots — M4

Sway does not have a native minimize; the equivalent is scratchpad (window is hidden from the workspace).

```bash
# Hide (minimize equivalent):
swaymsg '[title="L-MOTION-60"] move scratchpad'
# Restore:
swaymsg 'scratchpad show'
```

Replace `L-MOTION-60` with the actual window title if using L-STATIC.

## Expected outcome

- Capture does not crash or hang during minimize/restore.
- The app handles the "no frame" period while the window is minimized (freeze last frame, or emit blank frames — implementation-defined).
- No segment write error is surfaced.
- Export produces a valid MP4.
