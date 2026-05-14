# L-CRASH-EXP — Helper Crash During Export

Sends SIGKILL to cove-replay-engine while an export operation is in progress.

## Validation context

No canonical smoke-suite row targets helper crash during export directly.
(`VAL-EXP-012` is "export runs concurrently with RECORDING without capture
frame loss", not crash-during-export.) This load is operator supporting
evidence: use it to verify the app surfaces an export-failed error and does not
produce a corrupt partial output file when the helper is killed mid-export.

## Operator procedure

1. Capture a clip of at least 30 seconds.
2. Trigger an export operation.
3. **Within 2–5 seconds of export starting**, in a separate terminal, run:
   ```bash
   ./crash.sh
   ```
4. Observe the app UI.

## Expected outcome

- cove-replay-engine is killed mid-export.
- The app detects the IPC disconnect.
- The app surfaces an export-failed error — not a hang.
- The partial output file (if any) is either cleaned up or clearly marked as incomplete.
- The app does not itself crash.

## Notes

- Timing matters: the helper must be killed while it is actively writing the output file. If the script is run before export starts or after it completes, it will find no helper process and exit with an error.
- No root required.
