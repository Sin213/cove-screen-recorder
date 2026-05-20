# T-021 VAL-CAP-004 — Startup Drop Warmup (Candidate A)

**Date:** 2026-05-19
**Repo:** /home/sin/Projects/cove-screen-recorder
**Branch:** main
**HEAD under implementation (uncommitted on top of):** a519115 (Record MVP smoke rerun 10 evidence)

## Scope

Candidate A only — separate VAL-CAP-004's startup transient drops from
steady-state drops via a narrow, per-row opt-in warmup exclusion that
affects the drop-rate calculation only. Cadence policy is intentionally
untouched in this pass and remains failing.

## Rationale (rerun 8 + rerun 10)

- Rerun 8 (commit 814034f): 60 samples, 3252 produced, **19 drops all in
  sample 1**, samples 2–60 had zero drops. Cadence mean 54.200 fps.
- Rerun 10 (commit 803e402, on top of the RetryShm legacy-permissive pod
  fix): 60 samples, 3324 produced, **19 drops all in sample 1**, samples
  2–60 had zero drops. Cadence mean ~55.4 fps. `capture.sessionReady`
  restored; the `no-acceptable-buffer-type` regression is closed.

Two consecutive controlled reruns confirm:

1. Steady-state PipeWire / NVENC drops are 0.
2. All drops are concentrated in the first diagnostics second (NVENC
   warmup transient).
3. Cadence is a separate, persistent ~54–55 fps PipeWire delivery issue
   that requires its own pass (later cadence policy planning).

Conflating both into the single `drop rate <= 0` threshold prevents
honest reporting: the threshold is correct for steady state but is
unsatisfiable across the startup second. Candidate A fixes the
arithmetic without weakening the threshold constant.

## Files changed

- `validation/rows.ts` — added `dropWarmupSamples?: number` to `SmokeRow`;
  set `dropWarmupSamples: 1` on VAL-CAP-004 only.
- `validation/drivers.ts` — added exported pure helper
  `computeDropRateWithWarmup` and `DropRateWithWarmup` type; rewired the
  drop-rate threshold and added a `drop-warmup.json` evidence sidecar in
  `driveValCap004`. Cadence calc untouched (still `mean(observedFps)`
  over unfiltered `samples`).
- `validation/drivers.drop-warmup.test.ts` — **new** Node built-in
  `node:test` suite proving the four spec contracts (see "Tests" below).
  Deviation noted: the handoff's Allowed Files said "existing validation
  test files only," but the Tests section required adding tests. There
  were zero existing test files in the repo, so a new file under
  `validation/` was the only path to satisfy the explicit Tests
  requirement. No new dependencies — uses Node 18+'s built-in test
  runner.

## `dropWarmupSamples` behaviour

- Optional, defaults to `0`. Absent or zero ⇒ bit-identical to the prior
  calculation (sum droppedSinceLast over all samples; denominator is the
  last sample's `totalProduced`).
- `> 0`: exclude the first N samples from the drop-rate calc:
  - `effectiveSamples = samples.slice(warmup)`
  - `totalDropped = sum(effectiveSamples.droppedSinceLast)`
  - `dropEffectiveProduced = lastEffective.totalProduced - lastWarmup.totalProduced`
  - `dropRate = totalDropped / dropEffectiveProduced`
- Fail-closed cases: empty `effectiveSamples` (warmup ≥ totalSamples) or
  non-positive `dropEffectiveProduced` ⇒ helper returns `valid: false`
  and the driver records `passed: false` with an `invalid (...)` observed
  string.
- Only VAL-CAP-004 sets `dropWarmupSamples: 1`. All other rows use the
  default (`undefined`/`0`) and are unaffected.

## Cadence is unchanged

- The driver still computes
  `meanFps = samples.reduce((s,x)=>s+x.observedFps,0) / samples.length`
  over the **unfiltered** samples array (drivers.ts ~line 1307).
- `cadenceMeanToleranceFrac` remains `0.005` (assertions.ts:68).
- A comment at the drop-rate block records this explicitly.

## Thresholds and constants — confirmation

- `THRESHOLDS.captureDropRate["1080p60-nvenc"]` unchanged (`0`).
- `cadenceMeanToleranceFrac` unchanged (`0.005`).
- `expectedEncoderBackend` for VAL-CAP-004 unchanged (`nvenc`).
- `onCellMismatch` for VAL-CAP-004 unchanged (`fail`).

## Helper / capture / NVENC — confirmation

No files under `helper/`, `helper/src/capture/`, `helper/src/encoder/`,
`electron/`, `src/`, `packaging/`, `.github/`, `package.json`,
`package-lock.json`, `Cargo.toml`, or `Cargo.lock` were modified. See
`git status --short --untracked-files=all` output below.

## Evidence output additions

`driveValCap004` writes a new
`<evidenceDir>/VAL-CAP-004/drop-warmup.json` sidecar capturing:

- `rowDropWarmupSamples` (the row-config value as authored)
- `warmupSamples` (the clamped value actually applied)
- `totalSamples`, `effectiveSamples`
- `totalDropped` (sum over effective samples only)
- `dropWarmupExcludedDropped`, `dropWarmupProduced`
- `dropEffectiveProduced`, `dropRate`, `valid`
- `thresholdKey`, `maxDropRate`, `passed`

The threshold's `observed` string is also extended to include
`warmup=…, effectiveSamples=…, excludedDropped=…, dropEffectiveProduced=…`
so the report is self-describing without reading the sidecar.

The sidecar is written even when `warmup = 0` (with `excludedDropped = 0`),
so any future row that quietly toggles warmup is auditable from the same
file path.

## Tests

`validation/drivers.drop-warmup.test.ts`, run via:

```
node --test dist-validation/drivers.drop-warmup.test.js
```

Asserts:

1. `warmup=1` on rerun-10-shape samples (drops only in sample 1)
   ⇒ `dropRate = 0`, `excludedDropped = 19`, `effectiveSamples = 59`.
2. `warmup=0` on the same samples ⇒ original failing rate
   (`19 / lastProduced > 0`).
3. A drop injected at sample 10 with `warmup=1` still produces
   `dropRate > 0` (post-warmup drops still fail the strict gate).
4. Cadence input is independent of warmup — helper does not consume
   `observedFps`, the unfiltered mean is preserved across calls.
5. `warmup ≥ totalSamples` ⇒ fail-closed (`valid=false`).
6. Non-positive produced delta ⇒ fail-closed (`valid=false`).
7. `warmup > samples.length` does not crash (clamped, fail-closed).

All 7 tests pass.

## Verification

| Command | Result |
|---|---|
| `npm run typecheck` | OK (no output) |
| `npm run validate:build` | OK (no output) |
| `node --test dist-validation/drivers.drop-warmup.test.js` | 7 pass / 0 fail |
| `npm test -- validation` | n/a — no `test` script in package.json (expected; handoff used `|| true`) |
| `cargo build -p cove-replay-engine --release` | Finished release, pre-existing NVENC warnings only |
| `git diff --check` | clean |
| `git status --short --untracked-files=all` | see below |

```
 M validation/drivers.ts
 M validation/rows.ts
?? validation/drivers.drop-warmup.test.ts
```

## Expected rerun 11

- VAL-CAP-004 drop-rate threshold should **pass** (warmup excludes the
  startup-only 19 drops; steady-state remainder is 0 / 3245 ≈ 0).
- VAL-CAP-004 cadence threshold should **still fail** at ~55 fps —
  cadence policy is unchanged in this pass.
- Other rows are unaffected.

## Next recommended phase

1. T-021 MVP smoke rerun 11 on top of this change to confirm the drop
   gate flips green and the cadence gate stays red.
2. If only cadence remains red, plan a separate cadence-policy pass
   (T-016a follow-up / cadence tolerance / 60 fps stream-param work).
3. T-021 is **not** marked complete and T-010c is **not** started.

## Confirmations

- T-010c NOT started.
- T-021.json NOT modified.
- No packaging / release / GitHub Actions changes.
- No threshold constant or unrelated row touched.
