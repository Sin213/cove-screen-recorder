# Run-01 Operator Note

- **App session PID:** 1523242 (VITE_COVE_V2_UI=1 npm run dev)
- **Portal session:** pw-session-0000-1523385-1779583964285
- **Start time:** 17:52:44 local (01:15:02 UTC = PW stream ready)

Wait — this is session 1:
- **Portal connect:** 00:52:44Z (17:52:44 local PDT = UTC-7)
- **Save trigger:** 17:53:05 local (button press)
- **SAVING duration:** ~17 seconds (17:53:05 → 17:53:22)
- **Result:** RECORDING resumed — v2SnapshotId=null, v2ExportId=null (no snapshot created)
- **MP4 valid:** N — no file created
- **export.queued:** N — no export lifecycle events after baseline
- **Rolling buffer:** 1 segment (index=2), 57 fragments, 12.9MB, 18.24s content
  - manifest: `pts_start=6815738 pts_end=8457149 duration=(1641411/90k)=18.24s`
- **Helper frames logged:** seq=1 only (frame_count=0)
- **Classification:** Branch A (no valid file, no export.failed) — NOT ISS-012
- **Note:** SAVING state held for ~17s then returned to RECORDING. Exactly matches
  segment duration (18.24s). Snapshot IPC returned no ID despite segments present.
  v2State then transitioned to IDLE at 17:54:19.
