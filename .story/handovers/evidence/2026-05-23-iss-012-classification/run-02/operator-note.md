# Run-02 Operator Note

- **App session PID:** 1523242 (same process, re-armed recording)
- **Portal session:** pw-session-0000-1523385-1779585302277
- **Portal connect:** 01:15:02Z (18:15:02 local PDT = UTC-7)
- **Save trigger:** 18:15:34 local (button press) — 32 seconds after portal connected
- **SAVING duration:** ~5 seconds (18:15:34 → 18:15:39)
- **Result:** RECORDING resumed — v2SnapshotId=null, v2ExportId=null (no snapshot created)
- **MP4 valid:** N — no file created
- **export.queued:** N — no export lifecycle events
- **Rolling buffer:** 1 segment (index=2), 16 fragments, 2.6MB, 5.01s content
  - manifest: `pts_start=6856630 pts_end=7307511 duration=(450881/90k)=5.01s`
- **Helper frames logged:** seq=1 only (frame_count=0)
- **Classification:** Branch A (no valid file, no export.failed) — NOT ISS-012
- **Note:** User noted "the timer keeps going though" — UI shows recording state
  but label stays "Ready". SAVING duration (~5s) matches segment content exactly.
  Snapshot IPC returned no ID despite segments present. Same failure mode as run-01.
