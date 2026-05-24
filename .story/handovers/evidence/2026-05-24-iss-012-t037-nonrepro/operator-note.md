# T-037 — ISS-012 Repro Pass (Post-ISS-015-Fix)

**Date:** 2026-05-24
**Session:** pw-session-0000-1855423-1779658237942
**Source:** Monitor, Wayland portal, XR24 SHM fallback, 4K (3840×2160)
**Replay window (buffer setting):** 0.5 min (30s) — the duration captured per export
**Session duration at first save:** ~1.5 min; at last save: ~15 min

T-037 qualifying condition is `>5 min session duration` (not replay window size).
Save 1 (14:32:08, ~1.5 min session) is below the >5 min threshold.
Saves 2–7 (13–15 min session) meet the qualifying condition.
All 9 post-fix saves (T-044: 2 + T-037 this pass: 7) are included in the 1/10+ cumulative rate.

## Save Matrix — 7 Attempts, 0 ISS-012 Reproductions

| # | Time (PDT) | snap ID (suffix) | exp ID (suffix) | Progress | export.completed | Post-state | ISS-012? |
|---|------------|-----------------|-----------------|----------|-----------------|------------|----------|
| 1 | 14:32:08 | -0004 | -0005 | — | 14:32:36 | RECORDING | No |
| 2 | 14:43:28 | -0006 | -0007 | 99.999% | 14:43:47 | RECORDING | No |
| 3 | 14:43:48 | -0008 | -0009 | 100 | 14:44:07 | RECORDING | No |
| 4 | 14:44:07 | -0010 | -0011 | 100 | 14:44:07 | RECORDING | No |
| 5 | 14:44:08 | -0012 | -0013 | 99.999% | 14:44:27 | RECORDING | No |
| 6 | 14:44:28 | -0014 | -0015 | 99.999% | 14:44:46 | RECORDING | No |
| 7 | 14:45:15 | -0016 | -0017 | 100 | 14:45:28 | RECORDING | No |

All 7 saves completed: SAVING → EXPORTING → export.completed → RECORDING.
No stuck-EXPORTING state observed.

## Export Files on Disk

| File | Size |
|------|------|
| exp-...-0005.mp4 | 12.1M |
| exp-...-0007.mp4 | 29.5M |
| exp-...-0009.mp4 | 16.6M |
| exp-...-0011.mp4 | 16.6M |
| exp-...-0013.mp4 | 12.2M |
| exp-...-0015.mp4 | 12.2M |
| exp-...-0017.mp4 | 11.8M |

All exports landed on disk. ISS-012 did not fire on any attempt.

## Notable: "v2SaveReplay no snapshot_id" Warn (NOT ISS-012)

Saves 4 and 5 fired:
```
warn [export lifecycle] v2SaveReplay no snapshot_id: hasResult=true snapshot_id=<id> v2State=EXPORTING
```

Despite the warn name, snapshot_id IS populated in state (shown in same log line).
This is a renderer timing artifact on rapid-fire saves: the button's `finally` block runs
while the FSM transitions to EXPORTING, before the snapshot state is readable at the
expected check point. Both saves completed successfully. This is NOT ISS-012.

Recommend creating a minor ISS for this warn to avoid future confusion.

## Classification: Non-Repro (Branch D analog)

ISS-012 conditions (valid MP4 + stuck EXPORTING) not observed in any attempt.
Qualifying saves (session >5 min): 6/7 (saves 2–7). All qualifying saves: clean.
ISS-012 repro rate: 1 historical + 9 post-fix clean saves = 1/10+ cumulative.

## Cumulative T-037 Repro State

| Pass | Date | Attempts | Result |
|------|------|----------|--------|
| T-035 | 2026-05-23 | 2 | ISS-015 intercept (pre-fix) |
| T-037 run-01, run-02 | 2026-05-23 | 5 | ISS-015 intercept (pre-fix) |
| T-044 validation | 2026-05-24 | 2 | Clean (ISS-015 fixed) |
| T-037 this pass | 2026-05-24 | 7 | Clean — ISS-012 non-repro |
| **Total clean (post-fix)** | | **9** | **0 ISS-012 reproductions — 1/10+ cumulative** |

## Next Repro Conditions to Try

Original ISS-012 discovery context (VAL-CAP-006):
- Mixed-motion scene (not static-screen dedup-heavy)
- Exact session parameters unknown — check evidence at
  `.story/handovers/evidence/2026-05-22-iss-011-val-cap-006-standalone-retry-2/`
- May require non-dedup-heavy content to change export timing
- May require longer session soak (>10 min continuous)
