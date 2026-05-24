# T-037 Run-01 Operator Note

**Date:** 2026-05-24 (22:xx PDT = 05:xx UTC)
**App version:** HEAD 4e5640e (T-036 renderer logging active)

## Session 1: pw-session-0000-1598561-1779600144509

**Portal established:** 22:22:24 (3840×2160, XR24 SHM fallback, path=convert)
**Rolling buffer:** 1 segment (index=1), 9.7MB, 24.4s content
**On-disk segments:** 1 file (00000001.mp4)

### Save attempt 1 (22:22:56)
- Recording elapsed: ~32s
- v2SnapshotId=null, v2ExportId=null at save start
- SAVING→RECORDING in ~6s
- v2SnapshotId=null, v2ExportId=null at return
- Branch 5: ISS-015

### Save attempt 2 (22:23:20)
- Recording elapsed: ~56s
- v2SnapshotId=null, v2ExportId=null
- SAVING→RECORDING in ~1s
- Branch 5: ISS-015

**Session 1 ended:** 22:23:27 (v2State=IDLE)

## Session 2: pw-session-0000-1598561-1779600276513

**Portal established:** 22:24:36 (3840×2160, XR24 SHM fallback, path=convert)
**On-disk segments:** NONE (manifest.json shows segments=[])
**UI bitrate shown:** ~16 Mbps (encoder running but no disk segments)
**Source shown in UI:** Screen (monitor)

### Save attempt 3 (22:28:57)
- Recording elapsed: **4 minutes 21 seconds** (22:24:36→22:28:57)
- v2SnapshotId=null, v2ExportId=null at save start
- SAVING→RECORDING in ~7s
- v2SnapshotId=null, v2ExportId=null at return
- Branch 5: ISS-015

**Key anomaly:** 4m21s of recording at ~16 Mbps, zero on-disk segments for session 2.
Rolling buffer data not persisted → snapshot creation fails → no export.queued.

## Verdict

**Branch 5: ISS-015 interception**
- Save NEVER reaches EXPORTING
- SAVING→RECORDING with null snapshot_id and null export_id
- No valid MP4 produced
- ISS-012 NOT reproduced (3/3 attempts → ISS-015)

## Critical finding: session 2 segment anomaly

Session 1 DID write segments (24.4s, 9.7MB).
Session 2 did NOT write segments despite 4m21s of recording.
This suggests a session initialization failure for session 2's rolling buffer writer.
The encoder is running (16 Mbps bitrate visible in UI) but frames are not being persisted.
This could be the root cause of ISS-015 in this session.
