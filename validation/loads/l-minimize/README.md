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
4. **Minimize** the source window (click the minimize button or press the compositor shortcut).
5. Wait 5 seconds in minimized state.
6. **Restore** the source window.
7. Wait 5 seconds.
8. Repeat minimize/restore cycle twice more.
9. Stop capture and export.

## Expected outcome

- Capture does not crash or hang during minimize/restore.
- The app handles the "no frame" period while the window is minimized (freeze last frame, or emit blank frames — implementation-defined).
- No segment write error is surfaced.
- Export produces a valid MP4.
