# T-010c — ISS-020 Hypothesis CONFIRMED: XR24→NV12 Conversion is the Bottleneck

**Date:** 2026-05-25
**Ticket:** T-010c (inprogress)
**Issue:** ISS-020 (status: inprogress)

## Session Goal

Single controlled VAL-CAP-004 execution with working helper log capture (`--log-dir` fix from prior session) to classify XR24→NV12 conversion hypothesis conclusively.

## HEAD at Execution

`dad2eae` — Add ISS-020 conversion cost instrumentation to NVENC push_frame

`validation/drivers.ts` modified (unstaged): passes `--log-dir <evidenceDir>` to `spawnHelper` in `driveValCap004`.

## Harness

Rebuilt `dist-validation/runner.js` at ~13:50 from modified `validation/drivers.ts`. Build clean.

## Environment

| Check | Result |
|---|---|
| baloo | suspended |
| Firefox | running (env contamination already ruled out) |
| Display DP-4 | 1920x1080@60.00* (mode 11, confirmed active) |
| GPU pre-run | RTX 4080 SUPER, 48°C, 19% util, 2253 MiB |
| GPU post-run | RTX 4080 SUPER, 48°C, 1% util, 2250 MiB |
| cove/ffmpeg | none |

## Execution

**Command:** `node dist-validation/runner.js row VAL-CAP-004`
**Report:** `validation-artifacts/smoke/2026-05-25T20-51-11-667Z/report.json`
**Evidence dir:** `validation-artifacts/smoke/2026-05-25T20-51-11-667Z/VAL-CAP-004/`

## Result

**VAL-CAP-004: FAIL** — drop rate 76.94%

| Threshold | Observed | Required | Pass |
|---|---|---|---|
| capture cell | 1920x1080 | 1920x1080 | ✓ |
| drop rate <= 0 | **0.7694 (76.94%)** | <= 0 | ✗ |
| encoder | nvenc | nvenc | ✓ |
| samples | 56 effective | >= 1 | ✓ |

Drop detail: totalDropped 2362 / effectiveProduced 3070, 56 effective samples.

## Conversion Timing Evidence — engine.log

**engine.log captured successfully (7.6K).** 6 GOP-level `[iss-020]` WARN entries, 120 frames each:

| Timestamp | mean_us | max_us | frames | format | resolution |
|-----------|---------|--------|--------|--------|------------|
| 20:51:25 | 75,077 | 83,842 | 120 | XR24 | 1920×1080 |
| 20:51:35 | 73,777 | 79,223 | 120 | XR24 | 1920×1080 |
| 20:51:44 | 73,497 | 76,797 | 120 | XR24 | 1920×1080 |
| 20:51:54 | 74,318 | 79,310 | 120 | XR24 | 1920×1080 |
| 20:52:03 | 73,860 | 82,301 | 120 | XR24 | 1920×1080 |
| 20:52:13 | 73,751 | 78,688 | 120 | XR24 | 1920×1080 |

**Mean across GOPs: 74,380 μs = 74.4 ms/frame**
**Frame budget at 60fps: 16.7 ms/frame**
**Over-budget factor: 4.46×**

## Hypothesis Classification: CONFIRMED

XR24→NV12 software conversion (`convert_packed_bgra_to_nv12` in `helper/src/encoder/backends/nvenc/mod.rs`) averages **74.4 ms per frame** against a 16.7 ms budget. This is 4.46× the available frame time. The NVENC encoder queue is starved — the CPU cannot convert XR24 frames fast enough to feed the encoder at 60fps, causing ~77% of frames to be dropped.

The timing is extremely stable across all 6 GOPs (σ < 1ms mean), ruling out any transient spike hypothesis. This is a sustained throughput bottleneck.

## Root Cause

`convert_packed_bgra_to_nv12` is a pure-CPU software conversion for a 1920×1080 BGRA frame → NV12. At 1920×1080×4 bytes = ~8.3 MB per frame, the conversion is memory-bandwidth and CPU-bound. The function takes ~74ms on this CPU, but the frame budget at 60fps is 16.7ms.

This regression appeared between `6371f46` (last known-good, 0% drops) and `dad2eae`. However, `pipewire.rs` and `nvenc/mod.rs` conversion paths were unchanged in this interval — the regression may be in how the encoder session processes frames (back-pressure from `1f558ae` segment buffer changes?), or this bottleneck existed at `6371f46` but was masked by different scheduling conditions.

## Next Investigation Step

The conversion path itself cannot be "fixed" without one of:
1. **NVENC NV12 input**: configure NVENC to accept NV12 directly from a hardware path, bypassing software conversion
2. **CUDA/VAAPI conversion**: replace `convert_packed_bgra_to_nv12` with a GPU-accelerated implementation
3. **Format negotiation**: request NV12 from PipeWire at negotiation time to avoid conversion entirely

Bisect question: was the conversion always this slow (74ms) at `6371f46`, or did something change? Check if conversion timing also appeared in `6371f46` era runs (no instrumentation then).

## Evidence Artifacts

| Artifact | Path |
|---|---|
| engine.log (conversion timing) | `validation-artifacts/smoke/2026-05-25T20-51-11-667Z/VAL-CAP-004/engine.log` |
| Report | `validation-artifacts/smoke/2026-05-25T20-51-11-667Z/report.json` |
| Thresholds | `validation-artifacts/smoke/2026-05-25T20-51-11-667Z/VAL-CAP-004/thresholds.json` |
| Capture diagnostics | `validation-artifacts/smoke/2026-05-25T20-51-11-667Z/VAL-CAP-004/capture-diagnostics.json` |
| Drop warmup | `validation-artifacts/smoke/2026-05-25T20-51-11-667Z/VAL-CAP-004/drop-warmup.json` |

## Source Modifications

`validation/drivers.ts` modified (unstaged) — `--log-dir evidenceDir` added to `spawnHelper` call in `driveValCap004`. No helper/src, electron, or spec files modified.

## §22 Smoke Status

Unchanged: PARTIAL RED at VAL-CAP-004. Rows 5-18 NOT-ATTEMPTED. Blocked pending ISS-020 resolution.
