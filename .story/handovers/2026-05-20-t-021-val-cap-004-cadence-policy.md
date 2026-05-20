# Handover: T-021 ISS-001 VAL-CAP-004 Variable-Rate Cadence Policy

**Date:** 2026-05-20
**Branch:** main
**Status:** patch complete, not committed, awaiting Codex review

---

## What was done

Implemented ISS-001 / VAL-CAP-004 variable-rate cadence policy to allow VAL-CAP-004
to pass on KDE PipeWire hosts that deliver ~55.45 fps under a 60-fps nominal (fps_num=0).

### Root cause

KDE PipeWire compositor reports `negotiatedCaptureFormat.fps_num=0, fps_den=1` and
delivers a variable-rate stream at ~55.45 fps.  The prior strict ±0.5% gate
(59.70–60.30 fps) correctly rejects this — but it is compositor behaviour, not a
capture or encoder regression.  Evidence basis: reruns 8/10/11 all show the same
pattern; drop gate passes with dropWarmupSamples=1.

### Changes

**`validation/types.ts`**
- Added `gating?: boolean` to `ThresholdResult`.
  Omitted/true = gating (row fails if this threshold fails).
  `false` = informational — included in evidence but excluded from row pass/fail.

**`validation/assertions.ts`**
- Added `VARIABLE_RATE_CADENCE` export with three constants:
  - `variableRateCadenceMinFracOfNominal = 0.85`  (51 fps floor at 60fps nominal)
  - `variableRateCadenceMaxFracOfNominal = 1.02`  (61.2 fps ceiling)
  - `variableRateCadenceMaxSpreadFps = 6.0`       (compositor jitter tolerance)
  - Inline justification: reruns 8/10/11 showed ~55.45 fps sustained (0.924×nominal);
    0.85 floor rejects 5-fps degeneracy; 6.0 fps spread allows compositor variance.

**`validation/drivers.ts`**
- Exported `CadenceNominalSource` type (moved from local scope inside driveValCap004).
- Added `CadenceEvalContext` interface export.
- Added `evaluateCadenceThresholds(ctx)` pure function export.
  - variable-rate path (isVariableRate && nominalSource==="row-config"):
    gating: mean in [0.85×nom .. 1.02×nom], gating: spread ≤ 6.0 fps,
    informational (gating=false): strict ±0.5% threshold
  - strict path: single gating threshold at ±0.5%
  - fail-closed: nominalFps===null → failed gating threshold; sampleCount<10 → failed gating threshold
- In `driveValCap004`:
  - Removed local `type CadenceNominalSource` re-declaration.
  - Added `isVariableRate` and `cadencePolicy` derivation after nominalSource resolution.
  - Replaced hand-coded cadence if/else block with `evaluateCadenceThresholds()` call.
  - Computed `spreadFps` from samples before the call.
  - Updated `allPassed` to `thresholds.every((t) => t.gating === false || t.passed)`.
  - Extended `thresholds.json` write with `cadencePolicy` and (when variable-rate)
    `variableRateCadenceConstants`.

**`validation/drivers.cadence-policy.test.ts`** (new file)
- 5 tests covering all policy branches; all pass.

### Unchanged

- `THRESHOLDS.cadenceMeanToleranceFrac = 0.005` — untouched.
- All other 12 `allPassed` sites in drivers.ts — untouched.
- No changes to helper/capture, PipeWire, NVENC/encoder, Electron/renderer,
  packaging, release, or GitHub Actions.

---

## Verification

```
npm run typecheck           # pass
npm run validate:build      # pass
node --test dist-validation/drivers.drop-warmup.test.js     # 7/7 pass
node --test dist-validation/drivers.cadence-policy.test.js  # 5/5 pass
npm run build               # pass
git diff --check            # exit 0
```

---

## Not done

- T-010c (ffprobe PTS cadence assertions on output MP4) — explicitly out of scope.
- Smoke rerun with the policy applied — row should now pass.
- Commit — patch is intentionally uncommitted pending Codex review.
