# T-021 VAL-CAP-004 Cadence Warmup Scope Fix

**Date:** 2026-05-20
**Issue:** VAL-CAP-004 cadence statistics computed from all samples including warmup sample
**Basis:** Rerun 12 evidence (commit 1551587)
**Branch:** main

---

## What was done

Fixed `validation/drivers.ts` so that cadence statistics (`meanFps`, `spreadFps`,
`sampleCount`) are computed from the effective post-warmup sample slice — the same
slice already used by the drop-rate gate — rather than from all samples including
the startup warmup sample.

### Root cause (from rerun 12)

`driveValCap004` computed `fpsValues = samples.map(s => s.observedFps)` from all
60 samples. The warmup sample (sample 0) had observedFps=61 due to the NVENC startup
burst. Including this sample:
- Raised all-sample spread to 7 fps (61-54=7), failing the ≤ 6.0 gate
- Raised all-sample mean to 54.983 fps (slightly above post-warmup mean 54.881)

The `dropWarmupSamples=1` configuration already correctly excluded sample 0 from the
drop-rate gate via `computeDropRateWithWarmup`. This fix applies the same exclusion
consistently to cadence statistics.

---

## Changes

### `validation/drivers.ts`

**Added `buildCadenceFpsStats` export (before `DriverContext` interface):**
```typescript
export function buildCadenceFpsStats(
  samples: ReadonlyArray<{ observedFps: number }>,
  dropWarmupSamples: number,
): { meanFps: number; spreadFps: number; sampleCount: number }
```
- Slices `samples.slice(warmup)` for cadence inputs
- Returns `{meanFps, spreadFps, sampleCount}` from effective slice
- Fail-closed: empty effective slice → `{0, 0, 0}`

**Changed in `driveValCap004` (call site, ~line 1427 post-edit):**
```typescript
// Before (bug):
const fpsValues = samples.map((s) => s.observedFps);
const meanFps = fpsValues.reduce(...) / fpsValues.length;
const spreadFps = Math.max(...fpsValues) - Math.min(...fpsValues);
const cadenceResults = evaluateCadenceThresholds({
  meanFps, spreadFps, sampleCount: samples.length, ...

// After (fix):
const cadenceStats = buildCadenceFpsStats(samples, dropWarmupSamplesCfg);
const { meanFps, spreadFps } = cadenceStats;
const cadenceResults = evaluateCadenceThresholds({
  meanFps, spreadFps, sampleCount: cadenceStats.sampleCount, ...
```

### `validation/drivers.cadence-policy.test.ts`

Updated import to add `buildCadenceFpsStats`. Added 5 new tests (total: 10):
1. `buildCadenceFpsStats: rerun-12-shaped samples with warmup=1 gives post-warmup spread of 2 fps`
2. `buildCadenceFpsStats: rerun-12-shaped samples with warmup=0 gives all-sample spread of 7 fps`
3. `buildCadenceFpsStats: bursty post-warmup samples still fail spread gate with warmup=1`
4. `buildCadenceFpsStats: negotiated strict path — warmup exclusion applies to mean and spread`
5. `buildCadenceFpsStats: informational strict cadence uses the same effective post-warmup mean`

### `validation/drivers.drop-warmup.test.ts`

Updated stale comment that described the old behavior ("driver site continues to mean
over the unfiltered samples array") to reference the new `buildCadenceFpsStats` contract.

---

## Proof: Constants Unchanged

`validation/assertions.ts` not touched:
- `variableRateCadenceMinFracOfNominal = 0.85` — unchanged
- `variableRateCadenceMaxFracOfNominal = 1.02` — unchanged
- `variableRateCadenceMaxSpreadFps = 6.0` — unchanged
- `cadenceMeanToleranceFrac = 0.005` — unchanged

## Proof: Policy Shape Unchanged

`evaluateCadenceThresholds` signature and behavior unchanged. The same thresholds are
produced: variable-rate mean gate, variable-rate spread gate, informational strict gate.
Only the INPUT values `meanFps`, `spreadFps`, `sampleCount` now reflect the effective
post-warmup samples.

## Proof: helper/capture/NVENC Untouched

- `helper/**` — not touched
- `electron/**` — not touched
- `src/**` — not touched
- `packaging/**` — not touched
- `.github/**` — not touched
- `package.json`, `Cargo.toml`, `Cargo.lock` — not touched

---

## Expected Impact on Rerun 12 Diagnostics

| Stat | Before fix | After fix |
|---|---|---|
| sampleCount (cadence) | 60 (all) | 59 (effective) |
| meanFps | 54.983 (all-sample) | 54.881 (post-warmup) |
| spreadFps | 7.000 fps (all-sample) | 2.000 fps (post-warmup) |
| Mean gate [51..61.2] | PASS | PASS |
| Spread gate ≤ 6.0 | **FAIL** | **PASS** |
| VAL-CAP-004 verdict | FAIL | Expected PASS |

---

## Verification Results

```
npm run typecheck          # pass
npm run validate:build     # pass
node --test dist-validation/drivers.drop-warmup.test.js    # 7/7 pass
node --test dist-validation/drivers.cadence-policy.test.js # 10/10 pass (was 5/5)
npm run build              # pass
git diff --check           # exit 0
```

Modified tracked files:
- `M validation/drivers.ts`
- `M validation/drivers.cadence-policy.test.ts`
- `M validation/drivers.drop-warmup.test.ts`

---

## Not done

- Smoke rerun 13 — not run; awaiting Codex review of this patch
- Commit — not made; awaiting review

---

## Next Step

1. Codex reviews this patch
2. If approved: commit all pending validation patches together
3. Run T-021 MVP smoke rerun 13
4. If VAL-CAP-004 passes: close T-021, proceed to T-010c
