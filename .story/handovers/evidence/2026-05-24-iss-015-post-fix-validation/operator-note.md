# T-044 — ISS-015 Post-Fix Validation Operator Notes

**Date:** 2026-05-24
**Session:** pw-session-0000-1855423-1779657979540
**Helper binary:** target/debug/cove-replay-engine (T-043 overlap fix applied)
**Source:** Monitor, Wayland portal, XR24 SHM fallback, 4K (3840×2160)
**Buffer:** 0.5 min (30s), Quality — 1440p · 60fps · 20 Mbps (UI setting)

## Timeline

| Time (PDT) | Event |
|------------|-------|
| 14:25:03 | Engine started (v2State=BOOTING) |
| 14:26:15 | Recovery discarded (1 prior session) |
| 14:26:19 | RECORDING started, session established |
| 14:26:39 | First fragment + first keyframe received |
| 14:27:18 | First segment committed |
| 14:28:41 | **Save Replay 1** (button click) |
| 14:28:55 | EXPORTING: snap-1779658121866025406-0000, exp-1779658135736303403-0001 |
| 14:28:57 | Export 1 COMPLETE → RECORDING resumed |
| 14:29:36 | Duration became eligible |
| 14:29:59 | **Save Replay 2** (button click) |
| 14:30:14 | EXPORTING: snap-1779658199348544550-0002, exp-1779658214667035343-0003 |
| 14:30:15 | Export 2 COMPLETE → RECORDING resumed |
| 14:30:18 | IDLE (user stopped) |
| 14:30:37 | New recording session started: pw-session-0000-1855423-1779658237942 |

## Classification: Branch A — FIX CONFIRMED

All Branch A conditions met:

- [x] Both saves reached EXPORTING (not short-circuited to RECORDING)
- [x] Committed ring retained at save time (committed_len_after=1 on all evictions)
- [x] Both replay exports completed successfully (100%)
- [x] No T-040 "pin_snapshot: committed ring empty at save time" warning emitted
- [x] Both MP4 outputs valid (ffprobe: h264, 3840×2160, ~38-39s duration)

## Eviction Behavior (T-043 Fix Verified)

Engine log shows eviction firing every ~39s as before, but `committed_len_after=1` on every
eviction — the newest segment is always retained within the window.

| Eviction# | Evicted seg pts_end (s) | cutoff (s) | committed_len_after |
|-----------|------------------------|------------|---------------------|
| 1 | 3438707/90k = 38.2s | (6973409-2700000)/90k = 47.5s → WAIT: 38.2 < 47.5 → evict | 1 |
| 2 | 6973409/90k = 77.5s | (10485177-2700000)/90k = 86.5s → 77.5 < 86.5 → evict | 1 |
| 3 | 10485177/90k = 116.5s | (14002544-2700000)/90k = 126.6s → evict | 1 |
| 4 | 14002544/90k = 155.6s | (17564506-2700000)/90k = 165.2s → evict | 1 |
| 5 | 17564506/90k = 195.2s | (21132952-2700000)/90k = 204.8s → evict | 1 |

At save time (14:28:41): committed_len=2, ring non-empty → pin_snapshot succeeds.

## Export Verification

| File | Duration | Size | Codec | Resolution | Frames |
|------|----------|------|-------|------------|--------|
| exp-1779658135736303403-0001.mp4 | 38.72s | 11.1MB | h264 | 3840×2160 | 120 |
| exp-1779658214667035343-0003.mp4 | 39.28s | 12.8MB | h264 | 3840×2160 | 120 |

Low FPS (3fps) reflects static-screen frame deduplication — expected behavior.

## Prior Failure Comparison (T-042)

Under the old start-age predicate:
- `committed_len_after=0` — ring always emptied on commit
- `pin_snapshot: committed ring empty at save time` fired on every save
- All saves returned to RECORDING without snapshot_id

Under the overlap predicate (T-043):
- `committed_len_after=1` — newest segment always retained
- No `committed ring empty` warning
- Both saves completed full EXPORTING cycle

## ISS-012 Status

ISS-012 (stuck EXPORTING) did NOT reproduce during this validation run.
Both exports transitioned cleanly: EXPORTING → RECORDING → (user stop) → IDLE.
ISS-012 remains open for separate investigation.

## Screenshots

See: Image provided in session — "Exporting replay... 100%" visible in UI.
