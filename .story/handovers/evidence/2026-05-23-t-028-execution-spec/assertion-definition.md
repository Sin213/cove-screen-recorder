# VAL-CAP-006b — Assertion definition (T-028 execution spec)

> Define-only. No adjudication occurs in this pass. No NVIDIA/KDE evidence may be reclassified here.

## What VAL-CAP-006b asserts
On a **confirmed working zero-copy (DMA-BUF) capture path**, the exported MP4 contains the declared frame count within the strict N-008 §6.1 tolerance. This is ISS-011 leg 1 — the leg that failed under SHM fallback and could not be adjudicated on the M1 NVIDIA/KDE host (no working zero-copy baseline exists there). Source survival / HUD-timer / playable-output is **VAL-CAP-006a** (N-008 §26.6) and is out of scope here.

## The threshold (strict, unchanged)
N-008 §6.1 (note line 104; verification at §20 line 419 / §6.1 line 434):

```
expected_frames = round(duration_s × declared_fps)
PASS iff |actual_frames − expected_frames| ≤ 1
```

- **declared_fps = 60** for the ISS-011 lineage (UI preset's declared 60 fps; the same preset under which ISS-011 measured 1200 frames over 27.856 s, expected 1671).
- Tolerance is **±1 frame** — not a percentage band.
- Measurement: `ffprobe` decoded-frame count vs `round(duration_s × 60)`.
  - `actual_frames` = `nb_read_frames` (equivalently `nb_read_packets` for this single-stream h264 output — ISS-011 confirmed both equal at 1200).
  - Canonical N-008 §6.1 count command (line 419): `ffprobe -v error -select_streams v -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$f"`.
  - `duration_s` from `ffprobe -show_entries format=duration` of the same file.

## Excluded: the variable-rate band
VAL-CAP-006b **does NOT use** `checkFrameCountVariableRate` and **does NOT use** the `[0.85 × nominal .. 1.02 × nominal]` cadence band (`validation/assertions.ts:140-141`: `variableRateCadenceMinFracOfNominal: 0.85`, `variableRateCadenceMaxFracOfNominal: 1.02`; frame-count window `[floor(duration·nominal·0.85) .. ceil(duration·nominal·1.02)]`). That relaxed envelope is wired only into the VAL-CAP-004 variable-rate cadence policy (`validation/drivers.ts:3722`), not into this manual row.

VAL-CAP-006b uses the **strict** `checkFrameCount` semantics (`validation/assertions.ts:151`, §6.1, ±1).

### Why the variable-rate relaxation would weaken 006b
006b exists to prove capture+encoder hold the *declared* cadence on a working zero-copy path — it is the "no fake-60fps / no fake duplicated frames" guarantee (N-008 §6.1 line 104, the load-bearing v1.1.0 regression check). The `0.85` floor admits a mean as low as ~51 fps for a 60 fps preset (~15% under declared) without failing. Adjudicating 006b through that band would let a real sub-declared cadence deficit read as "green," defeating the exact criterion ISS-011 raised. The strict ±1 is what makes a persistent deficit on a *confirmed* zero-copy path a real **fail** (capture/encoder defect) rather than a tolerated variance.

## Source of truth
- Threshold text: N-008 §6.1 / §20 / §22 (frozen; not edited by T-028).
- Assertion code (read-only reference): `validation/assertions.ts` — strict `checkFrameCount` (§6.1) used; `checkFrameCountVariableRate` + `0.85/1.02` band excluded.
