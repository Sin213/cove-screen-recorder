# T-010c — ISS-020 Instrumented Build Run: INCONCLUSIVE — Harness Stderr Gap

**Date:** 2026-05-25
**Ticket:** T-010c (inprogress)
**Issue:** ISS-020

## Session Goal

Run VAL-CAP-004 on instrumented build (`dad2eae` — NVENC conversion timing `warn!` in `push_frame`) to capture XR24/AR24→NV12 timing evidence and classify conversion-over-budget hypothesis.

## HEAD at Execution

`dad2eae` — Add ISS-020 conversion cost instrumentation to NVENC push_frame

Instrumentation adds per-GOP XR24/AR24→NV12 conversion timing to `EncodeSession`, emits `warn!` summary log at GOP boundary via `tracing` structured logger.

## Build

Rebuilt `dist-validation/runner.js` at 13:26 (dad2eae committed 13:23). Build clean.

## Environment

| Check | Result |
|---|---|
| baloo | suspended via `balooctl6 suspend` |
| Firefox | running (6.5% CPU) — noted; env contamination already ruled out by prior controlled rerun |
| Display DP-4 | 1920x1080@60.00* (mode 11, confirmed active pre-run) |
| GPU pre-run | RTX 4080 SUPER, 47°C, 2% util, 2283 MiB used |
| GPU post-run | RTX 4080 SUPER, 47°C, 2% util, 2293 MiB used |
| cove/ffmpeg | none |

## Execution

**Command:** `node dist-validation/runner.js row VAL-CAP-004`
**Report:** `validation-artifacts/smoke/2026-05-25T20-26-42-911Z/report.json`
**Evidence dir:** `validation-artifacts/smoke/2026-05-25T20-26-42-911Z/VAL-CAP-004/`

## Result

**VAL-CAP-004: FAIL** — consistent with prior runs

| Threshold | Observed | Required | Pass |
|---|---|---|---|
| capture cell (1920x1080) | 1920x1080 | 1920x1080 | ✓ |
| drop rate <= 0 | **0.7696 (76.96%)** | <= 0 | ✗ |
| encoder | nvenc | nvenc | ✓ |
| capture format (fourcc) | XR24 | — | noted |
| samples | 57 effective (1 warmup excluded) | >= 1 | ✓ |

**Drop detail:**
- totalDropped: 2398 / effectiveProduced: 3116
- effectiveSamples: 57, drops per sample: ~42/sec sustained

## Conversion Timing Evidence: NOT CAPTURED

**Root cause of gap:** `helper-lifecycle.ts` spawns the helper with `stdio: ["ignore", "pipe", "pipe"]`. The helper emits JSON tracing to stderr (`--log-level info` default, WARN ≥ INFO). The stderr pipe is **never read or saved** in `driveValCap004`.

The `warn!` lines from `dad2eae` were generated during the run (conversion path confirmed: XR24 format + NVENC encoder active), but piped to an unread Node.js stream and discarded.

**Stop condition triggered:** "instrumentation logs do not appear"

## Hypothesis Classification

**INCONCLUSIVE** — Conversion path confirmed executing (XR24→NV12 with NVENC). Drop rate confirmed at ~77% (3rd consistent measurement). But conversion timing values were not captured, so the 16.7ms/frame threshold comparison cannot be made.

## Harness Gap

To capture conversion timing on the next run, one of:

1. **Option A (preferred):** Add `--log-dir <evidenceDir>` to `spawnHelper(socketPath)` call in `driveValCap004`. Helper writes `engine.log` to evidence dir. Captures all tracing output including `[iss-020]` warn lines.

2. **Option B:** Attach stderr listener in `spawnHelper` or driver, write to `<evidenceDir>/helper-stderr.log`.

Both require modifying `validation/drivers.ts` — cannot be done in this session (forbidden by session constraints). This is a separate ticket scope.

## Evidence Artifacts

| Artifact | Path |
|---|---|
| Report | `validation-artifacts/smoke/2026-05-25T20-26-42-911Z/report.json` |
| Thresholds | `validation-artifacts/smoke/2026-05-25T20-26-42-911Z/VAL-CAP-004/thresholds.json` |
| Capture diagnostics | `validation-artifacts/smoke/2026-05-25T20-26-42-911Z/VAL-CAP-004/capture-diagnostics.json` |
| Drop warmup | `validation-artifacts/smoke/2026-05-25T20-26-42-911Z/VAL-CAP-004/drop-warmup.json` |
| Conversion timing logs | **ABSENT** — harness stderr capture gap |

## Source Modifications

None. `git diff -- src/ helper/ electron/ validation/` is empty.

## Cross-Run Drop Rate Summary

| Run | Environment | Drop rate |
|---|---|---|
| 2026-05-22T02:21 (T-021 rerun-27) | baseline | 0.000 (PASS) |
| 2026-05-25T08:56 (T-010c original) | baloo 7.3%, firefox 8.5%, kwin 9.5% | 0.7711 |
| 2026-05-25T18:28 (controlled rerun) | baloo suspended, no firefox | 0.7647 |
| 2026-05-25T20:26 (this run, instrumented) | baloo suspended, firefox running | **0.7696** |

Drop rate is stable at ~77% regardless of environmental load. Confirmed NOT environmental.

## Next Actions

1. **Harness fix (new ticket required):** Add `--log-dir` pass-through to `driveValCap004`'s `spawnHelper` call, pointing to the row evidence directory. This captures the `[iss-020]` timing warn! lines.
2. After harness fix: re-run VAL-CAP-004 on `dad2eae` build and classify conversion hypothesis from captured timing.
3. Do NOT continue §22 smoke rows 5-18 until ISS-020 resolved.
4. T-010c remains inprogress pending ISS-020 resolution.
