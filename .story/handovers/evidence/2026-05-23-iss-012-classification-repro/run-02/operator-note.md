# T-037 Run-02 Operator Note

**Date:** 2026-05-23 (23:xx PDT)
**App version:** Source built from 4e5640e (T-036 renderer logging). Repo HEAD at repro time was 4d8fd53 (evidence-only commits, no source changes since 4e5640e).
**Source note:** Window source unavailable for replay buffer on this system (Wayland portal offers only whole-screen or region for replay buffer path). Screen source used. Window-source qualifying condition NOT met.

## Session: pw-session-0000-1625344-1779603851364

**Portal established:** 23:24:11
**Source:** Screen (monitor) — window source unavailable for replay buffer path
**Engine_down/reconnect:** 23:22:48 helper-disconnected between regular recording and replay session; recovered automatically

### Save attempt 1 (23:33:05)
- Recording elapsed: **8 minutes 54 seconds** (23:24:11→23:33:05) — >60s ✓ but Screen source
- v2SnapshotId=null, v2ExportId=null at save start
- SAVING→RECORDING in 13s
- v2SnapshotId=null, v2ExportId=null at return
- Branch 5 pattern observed (ISS-015-style)

### Save attempt 2 (23:34:18)
- Recording elapsed: **10 minutes 7 seconds** (23:24:11→23:34:18) — >60s ✓ but Screen source
- v2SnapshotId=null, v2ExportId=null at save start
- SAVING→RECORDING in 1s
- v2SnapshotId=null, v2ExportId=null at return
- Branch 5 pattern observed (ISS-015-style)

## Result

NOT qualifying — window-source condition not met.
- Both attempts >60s elapsed ✓
- Portal session active ✓
- Source: Screen (window source unavailable on this system for replay buffer)
- SAVING→RECORDING with null snapshot_id and null export_id on both attempts
- No `export.completed received` in either attempt
- FSM never reached EXPORTING
- ISS-012 NOT confirmed blocked on ISS-015 — Screen source only, window-source gate not cleared
