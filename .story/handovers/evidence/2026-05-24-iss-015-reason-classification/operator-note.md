# Operator Note — T-038 Attempt-01

**Date:** 2026-05-24
**Ticket:** T-038
**Issue:** ISS-015

## Build State

- `src/v2/engine.ts` modified: T-038 additive logging deployed
- `npm run typecheck`: PASSED
- Forbidden-surface audit: CLEAN
- Diff: only `src/v2/engine.ts` (+10/-1)

## Session Details

- Portal session: `pw-session-0000-1651816-1779606815259`
- Source: monitor (Screen/Wayland portal)
- Recording started: 00:13:35 local
- Save triggered: 00:14:14 local (button)
- Recording elapsed: ~39 seconds

## Classification Result

**STOP CONDITION MET.**

The new T-038 warn log fired on the first save attempt:

```
warn [export lifecycle] v2SaveReplay RPC rejected: code=? message=no committed segments available to pin v2State=SAVING
```

Per task stop condition: `reason = "no committed segments available to pin"` →
**ISS-015 classified as rolling-buffer seal failure.**

The helper returned an RPC rejection with message `"no committed segments available to pin"`.
This means the rolling buffer writer sealed zero segments during the 39-second recording window.
The segment ring did not commit any data despite active encoding (portal session established,
stream ready as of engine.log).

## Sequence

1. Engine started 07:09:35 UTC, listening
2. App loaded, v2State=IDLE at 00:09:36 local
3. Portal session established, v2State=RECORDING at 00:13:35 local (~4 minutes from app start)
4. Save triggered via button at 00:14:14 local (~39s elapsed)
5. v2State: RECORDING → SAVING → RECORDING (6s SAVING window)
6. T-038 warn log: RPC rejected, reason = "no committed segments available to pin"
7. v2SnapshotId=null throughout, v2ExportId=null throughout

## Observation: else-branch vs catch-branch

The T-038 `catch (err)` branch fired (RPC rejected path), NOT the `else` branch (no-snapshot_id path).
The else branch would fire if the RPC succeeded but returned `snapshot_id=null`.
Here the helper threw/rejected the RPC entirely.

## Observation: else-branch false-positive edge case

The else branch also fires when `onSnapshotPinned` races ahead of the RPC response
(v2State already EXPORTING). In that case the log shows `hasResult=true snapshot_id=<real-id> v2State=EXPORTING`
which is distinguishable but the "no snapshot_id" prefix is misleading. Not a bug — per spec — but
worth flagging for future refinement.

## Evidence

- `render-snapshot.txt`: full LogPanel dump (useStore.getState().logs)
- engine.log: on disk at `/home/sin/.config/Cove Screen Recorder/logs/engine.log`
- export-lifecycle.log: on disk at `/home/sin/.config/Cove Screen Recorder/logs/export-lifecycle.log`
