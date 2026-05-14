# L-RESIZE — Window Resize During Capture

Manual operator procedure. No script.

## Validation context

No canonical smoke-suite row targets mid-session window resize directly.
(`VAL-CAP-004` is the 1080p60 L-MOTION-60 NVENC monitor-capture row, not a
resize test.) This load is operator supporting evidence for general capture
stability: use it to confirm the app does not crash or corrupt segments when
the source window changes resolution mid-capture.

## Operator procedure

1. Start cove-screen-recorder with a window source (not screen/monitor).
2. Begin a capture session.
3. Wait 5 seconds for stable capture.
4. **Manually resize** the source window: drag a corner to change both width and height significantly (e.g., 1280×720 → 800×600 → 1920×1080).
5. Resize at least 3 times over 15 seconds.
6. Stop capture and export.

## Expected outcome

- Capture does not crash or hang during resize.
- The exported MP4 reflects the final window size (or a stable intermediate size, depending on implementation).
- No codec or segment write error is surfaced.

## Notes

- Window resize tests the encoder's ability to handle a mid-stream resolution change.
- Behavior on resolution change is implementation-defined; the test passes as long as there is no crash, no hang, and no corrupted segment.
