# T-042 — ISS-015 B4 Repro Evidence

**Date:** 2026-05-24
**Session:** pw-session-0000-1789984-1779655516013
**Source:** Monitor (Wayland portal, XR24 SHM fallback, 4K 3840×2160)
**Helper binary:** target/debug/cove-replay-engine built 2026-05-24T11:06 (T-040/T-041 instrumented)
**Engine log:** `~/.config/Cove Screen Recorder/logs/engine.log` lines 4560–4577

---

## Classification: **Branch B — Eviction Empties Ring**

`segments_evicted == segments_committed` at both save attempts. Both > 0. `is_closing=false`. Trigger=age.

---

## Session Timeline

| UTC Time       | Event                                              | Key Fields                                                    |
|----------------|----------------------------------------------------|---------------------------------------------------------------|
| 20:45:16       | Portal established, PW stream ready (XR24 SHM)    | session_id=pw-session-0000-1789984-1779655516013              |
| 20:45:55 (+39s)| **Eviction 1** (T-041 warn)                        | segments_committed=1, segments_evicted→1, trigger=age, age_90k=3408728 (37.87s), committed_len_after=0 |
| 20:46:34 (+78s)| **Eviction 2** (T-041 warn)                        | segments_committed=2, segments_evicted→2, trigger=age, age_90k=3476757 (38.63s), committed_len_after=0 |
| 20:46:56 (+100s)| **Save attempt 1 — T-040 FIRES**                  | segments_committed=2, segments_evicted=2, committed_len=0, is_closing=false |
| 20:47:13 (+117s)| **Eviction 3** (T-041 warn)                       | segments_committed=3, segments_evicted→3, trigger=age, age_90k=3495003 (38.83s), committed_len_after=0 |
| 20:47:52 (+156s)| **Eviction 4** (T-041 warn)                       | segments_committed=4, segments_evicted→4, trigger=age, age_90k=3475113 (38.61s), committed_len_after=0 |
| 20:47:54 (+158s)| **Save attempt 2 — T-040 FIRES** (qualifying)     | segments_committed=4, segments_evicted=4, committed_len=0, is_closing=false |

---

## T-041 Eviction Fields (first qualifying — Eviction 1)

```json
{
  "message": "evict_eligible: evicting segments",
  "session_id": "pw-session-0000-1789984-1779655516013",
  "to_evict": 1,
  "committed_len_before": 1,
  "segments_committed": 1,
  "segments_evicted": 0,
  "bytes_on_disk": 11712678,
  "now_pts": 3413765,
  "window_duration_90k": 2700000,
  "disk_cap_bytes": 4294967296
}
{
  "message": "evict_eligible: segment evicted",
  "index": 0,
  "pts_start_90k": 5037,
  "pts_end_90k": 3413765,
  "age_90k": 3408728,
  "trigger": "age",
  "byte_size": 11712678,
  "committed_len_after": 0,
  "segments_evicted": 1,
  "bytes_on_disk_after": 0
}
```

## T-040 Pin-Boundary Fields (qualifying save — Save attempt 2)

```json
{
  "message": "pin_snapshot: committed ring empty at save time",
  "session_id": "pw-session-0000-1789984-1779655516013",
  "committed_len": 0,
  "segments_committed": 4,
  "segments_evicted": 4,
  "pinned_count": 0,
  "next_index": 4,
  "bytes_on_disk": 0,
  "window_duration_90k": 2700000,
  "disk_cap_bytes": 4294967296,
  "requested_duration_90k": 2700000
}
{
  "message": "replay.save: pin_snapshot None — no committed segments available",
  "duration_s": 30.0,
  "duration_90k": 2700000,
  "is_closing": false
}
```

---

## Root Cause Analysis

**Segment age at commit time exceeds the window duration.**

Each committed segment spans approximately 38.6s of PTS time:
- Segment 0: pts_start=5037 (0.056s), pts_end=3413765 (37.93s) → duration=37.87s
- Segment 1: pts_start=3439674 (38.22s), pts_end=6916431 (76.85s) → duration=38.63s
- Segment 2: pts_start=6944956 (77.17s), pts_end=10439959 (116.0s) → duration=38.83s
- Segment 3: pts_start=10466348 (116.3s), pts_end=13941461 (154.9s) → duration=38.61s

**Window duration = 30s (2,700,000 at 90kHz)**

The eviction policy checks: `now_pts - segment.pts_start > window_duration_90k`

Since `segment.pts_end ≈ now_pts` at commit time, and `pts_end - pts_start ≈ 38.6s > 30s window`, the segment's start is already outside the window at the moment it's evaluated. Every segment is evicted immediately upon commit.

**Conclusion:** PTS-domain age-based eviction fires because segment duration exceeds the window, not because the segment is stale. Under normal conditions (non-dedup), segments would be short (a few seconds) and would not exceed the window. Under dedup-heavy 4K SHM capture with a static screen, segments accumulate large PTS spans before committing, causing them to immediately fail the age check.

**Branch classification:**
- NOT A (session swap) — segments_committed > 0
- **B (eviction emptied ring)** — segments_evicted == segments_committed at save time ✓
- NOT C (accounting inconsistency) — counts match exactly
- NOT D (never populated) — segments_committed=4
- NOT E (closing race) — is_closing=false

---

## Eviction Cycle Pattern

| Eviction | Wall time | Segment age (PTS) | Window | Result |
|----------|-----------|-------------------|--------|--------|
| 1        | +39s      | 37.87s            | 30s    | EVICTED |
| 2        | +78s      | 38.63s            | 30s    | EVICTED |
| 3        | +117s     | 38.83s            | 30s    | EVICTED |
| 4        | +156s     | 38.61s            | 30s    | EVICTED |

Eviction fires every ~38-39s (matches segment commit cadence).

---

## Stop Condition Met

- One qualifying T-040 warn! fired (save attempt 1 at +100s, confirmed at save attempt 2 at +158s)
- Branch B classified with full field evidence
- No remediation performed
