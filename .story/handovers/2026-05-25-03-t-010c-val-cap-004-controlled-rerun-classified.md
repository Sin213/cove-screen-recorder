# T-010c — VAL-CAP-004 Controlled Rerun: ISS-020 Classified NOT Environmental

**Date:** 2026-05-25
**Ticket:** T-010c (inprogress)
**Issue updated:** ISS-020

## Session Goal

Single controlled-environment rerun of VAL-CAP-004 to classify ISS-020 as environmental contamination or real regression. No source changes. No investigation. No exploratory runs.

## HEAD at Execution

`70c8a9e` — Add display mode enforcement to VAL-CAP-004 driver (ISS-021)

ISS-021 fix committed and in canonical harness. Source tree clean (only `.story/` and `.rtk/` untracked).

## Environment Preparation

| Check | Result |
|---|---|
| baloo_file | suspended (state: S sleeping, `balooctl6 status` → index not openable) |
| Firefox | closed |
| Active cove/ffmpeg processes | none (engine process PID 2237710 killed pre-run) |
| Display DP-4 mode | 1920x1080@60.00* (mode 11, confirmed active) |
| GPU pre-run | RTX 4080 SUPER, 44°C, 1% util, 0% mem util |
| GPU post-run | RTX 4080 SUPER, 45°C, 1% util, 0% mem util |
| kwin_wayland CPU | 8.3% (resident compositor load, cannot be eliminated) |

## Harness Rebuild

`npm run validate:build` — PASS (tsc clean, no errors). Built against 70c8a9e canonical baseline including ISS-021 display mode enforcement.

## Execution

**Command:** `node dist-validation/runner.js row VAL-CAP-004`
**Report:** `validation-artifacts/smoke/2026-05-25T18-28-18-655Z/report.json`
**Evidence dir:** `validation-artifacts/smoke/2026-05-25T18-28-18-655Z/VAL-CAP-004/`

## Result

**VAL-CAP-004: FAIL**

| Threshold | Observed | Required | Pass |
|---|---|---|---|
| capture cell (1920x1080) | 1920x1080 | 1920x1080 | ✓ |
| drop rate <= 0 | **0.7647 (76.5%)** | <= 0 | ✗ |
| samples | 56 (1 warmup excluded) | >= 1 | ✓ |
| encoder | nvenc | nvenc | ✓ |

**Drop detail (drop-warmup.json):**
- totalDropped: 2304 / effectiveProduced: 3013
- effectiveSamples: 55, warmupExcluded: 1
- drops per sample: first sample = 48 dropped of 61 produced

## Classification

| Run | Environment | Drop rate |
|---|---|---|
| 2026-05-22T02:21 (T-021 rerun-27) | unknown | 0.000000 (PASS) |
| 2026-05-25T08:56 (T-010c original) | baloo 7.3%, firefox 8.5%, kwin 9.5% | 0.7711 (77.1%) |
| 2026-05-25T18:28 (this rerun) | baloo suspended, no firefox, kwin 8.3% | **0.7647 (76.5%)** |

**Clean environment produced IDENTICAL drop rate to contaminated environment.**

**ISS-020 classification: NOT environmental. Likely code regression or persistent hardware-state issue.**

Environmental contamination ruled out. Suspects for regression:
- `1f558ae` — segment/buffer.rs overlap eviction (back-pressure path through encoder → capture)
- `927bf0d` — export/mod.rs watchdog (possible timer/scheduler interference)
- `pipewire.rs` unchanged since `6371f46` (pre-T-021 rerun-27, pre all suspects)

## ISS-020 Updated

Status: open (classification: NOT environmental, investigation required).

## §22 Smoke Status

Unchanged: PARTIAL RED. Smoke blocked at VAL-CAP-004. Rows 5-18 NOT-ATTEMPTED.

## Evidence Artifacts

| Artifact | Path |
|---|---|
| Report | `validation-artifacts/smoke/2026-05-25T18-28-18-655Z/report.json` |
| Thresholds | `validation-artifacts/smoke/2026-05-25T18-28-18-655Z/VAL-CAP-004/thresholds.json` |
| Capture diagnostics | `validation-artifacts/smoke/2026-05-25T18-28-18-655Z/VAL-CAP-004/capture-diagnostics.json` |
| Drop warmup | `validation-artifacts/smoke/2026-05-25T18-28-18-655Z/VAL-CAP-004/drop-warmup.json` |

## Source Modifications

None. `git diff -- src/ helper/ electron/ validation/` is empty.

## Next Actions

1. Investigate ISS-020 regression path: diff capture/encode/segment pipeline between `6371f46` (last-good) and `1f558ae`/`927bf0d` (suspects). Focus on `segment/buffer.rs` and `export/mod.rs` — check for back-pressure propagation to PipeWire capture.
2. Do NOT continue §22 smoke rows 5-18 until ISS-020 resolved.
3. T-010c remains inprogress pending ISS-020 resolution.
