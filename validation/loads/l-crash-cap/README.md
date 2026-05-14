# L-CRASH-CAP — Helper Crash During Capture

Sends SIGKILL to cove-replay-engine while a capture session is active.

## Validation context

No canonical smoke-suite row targets helper crash during capture directly.
(`VAL-PROC-001` is "no leftover processes after IDLE shutdown", not crash
recovery.) This load is operator supporting evidence: use it to verify the app
detects IPC disconnect and surfaces an error within a reasonable timeout.

## Operator procedure

1. Start cove-screen-recorder and begin a capture session using any load (e.g., L-MOTION-60).
2. Wait at least 10 seconds for a stable capture state.
3. In a separate terminal, run:
   ```bash
   ./crash.sh
   ```
4. Observe the app UI within 5 seconds.

## Expected outcome

- cove-replay-engine is killed (SIGKILL; no signal handler).
- The app detects the IPC disconnect within a reasonable timeout (≤5s).
- The app surfaces an error state in the UI — not a hang, not a silent failure.
- The app does not itself crash.
- Any partial segments written before the crash remain on disk (they may be incomplete/corrupt — that is expected).

## Notes

- `crash.sh` only targets processes owned by the current user (`pgrep -u $UID`).
- No root required.
- If the helper is not running, the script exits with an error rather than crashing a random process.
