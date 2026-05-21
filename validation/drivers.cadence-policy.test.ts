// T-021 ISS-001 VAL-CAP-004 variable-rate cadence policy tests.
//
// Self-contained: uses Node's built-in `node:test` runner (Node 18+).
// Compiled by `npm run validate:build`; run via:
//
//   node --test dist-validation/drivers.cadence-policy.test.js
//
// Covers five policy contracts:
//   1. rerun-11-shaped fps_num=0 samples pass variable-rate gate; strict
//      threshold fails but is informational (gating=false) -> row passes
//   2. degenerate 5 fps mean fails variable-rate gate (below 0.85×nominal)
//   3. bursty spread > 20.0 fps fails spread gate (gating threshold)
//   4. fps_num>0 (nominalSource="negotiated") still uses strict ±0.5% gate
//   5. missing nominal (nominalFps=null) fails closed
//
// Also covers VAL-CAP-004 cadence warmup-scope fix (buildCadenceFpsStats):
//   6. rerun-12-shaped samples with warmup=1: post-warmup spread 2 fps passes
//   7. rerun-12-shaped samples with warmup=0: all-sample spread 7 fps fails
//   8. bursty post-warmup samples still fail spread with warmup exclusion
//   9. negotiated strict path: warmup exclusion applies to mean/spread
//  10. informational strict cadence uses the same effective post-warmup mean

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { evaluateCadenceThresholds, buildCadenceFpsStats } from "./drivers";
import type { CadenceEvalContext } from "./drivers";

function gatePassed(results: ReturnType<typeof evaluateCadenceThresholds>): boolean {
  return results.every((t) => t.gating === false || t.passed);
}

test("rerun-11-shaped fps_num=0: variable-rate gate passes; strict informational fails (row passes)", () => {
  const ctx: CadenceEvalContext = {
    meanFps: 55.45,
    spreadFps: 0.5,
    sampleCount: 60,
    nominalFps: 60,
    nominalSource: "row-config",
    isVariableRate: true,
  };
  const results = evaluateCadenceThresholds(ctx);

  // Three entries: mean range, spread, strict-informational.
  assert.equal(results.length, 3);

  // Entry 0: variable-rate mean range [51..61.2] — 55.45 is in range.
  assert.equal(results[0]!.passed, true);
  assert.equal(results[0]!.gating === false, false, "mean range must be gating");

  // Entry 1: spread ≤ 20.0 fps — 0.5 passes.
  assert.equal(results[1]!.passed, true);
  assert.equal(results[1]!.gating === false, false, "spread must be gating");

  // Entry 2: strict ±0.5% — |55.45-60|/60 ≈ 7.6% > 0.5% — fails, but informational.
  assert.equal(results[2]!.passed, false);
  assert.equal(results[2]!.gating, false);

  // Row-level gate: only gating thresholds count.
  assert.equal(gatePassed(results), true);
});

test("degenerate 5 fps mean fails variable-rate gate (below 0.85×60=51 fps)", () => {
  const ctx: CadenceEvalContext = {
    meanFps: 5,
    spreadFps: 0.1,
    sampleCount: 60,
    nominalFps: 60,
    nominalSource: "row-config",
    isVariableRate: true,
  };
  const results = evaluateCadenceThresholds(ctx);

  // The mean-range entry must fail.
  const meanEntry = results.find((t) => t.name.includes("variable-rate range"));
  assert.ok(meanEntry, "variable-rate range entry must be present");
  assert.equal(meanEntry!.passed, false);
  assert.equal(gatePassed(results), false);
});

test("bursty spread > 20.0 fps fails spread gate", () => {
  const ctx: CadenceEvalContext = {
    meanFps: 55,
    spreadFps: 21.0,
    sampleCount: 60,
    nominalFps: 60,
    nominalSource: "row-config",
    isVariableRate: true,
  };
  const results = evaluateCadenceThresholds(ctx);

  // Mean range passes (55 ∈ [51..61.2]).
  const meanEntry = results.find((t) => t.name.includes("variable-rate range"));
  assert.ok(meanEntry, "variable-rate range entry must be present");
  assert.equal(meanEntry!.passed, true);

  // Spread gate fails (21.0 > 20.0).
  const spreadEntry = results.find((t) => t.name.includes("spread"));
  assert.ok(spreadEntry, "spread entry must be present");
  assert.equal(spreadEntry!.passed, false);
  assert.equal(spreadEntry!.gating === false, false, "spread must be gating");

  assert.equal(gatePassed(results), false);
});

test("fps_num>0 (nominalSource='negotiated') uses strict ±0.5% gate and passes", () => {
  // 59.9 fps is within ±0.5% of 60 fps (|59.9-60|/60 = 0.167% < 0.5%).
  const ctx: CadenceEvalContext = {
    meanFps: 59.9,
    spreadFps: 0.2,
    sampleCount: 60,
    nominalFps: 60,
    nominalSource: "negotiated",
    isVariableRate: false,
  };
  const results = evaluateCadenceThresholds(ctx);

  // Strict path: exactly one entry, no gating=false.
  assert.equal(results.length, 1);
  assert.equal(results[0]!.passed, true);
  assert.equal(results[0]!.gating, undefined, "strict entry must not set gating=false");
  assert.equal(gatePassed(results), true);
});

test("missing nominal (nominalFps=null) fails closed", () => {
  const ctx: CadenceEvalContext = {
    meanFps: 55,
    spreadFps: 0.5,
    sampleCount: 60,
    nominalFps: null,
    nominalSource: "missing",
    isVariableRate: false,
  };
  const results = evaluateCadenceThresholds(ctx);

  assert.equal(results.length, 1);
  assert.equal(results[0]!.passed, false);
  assert.ok(results[0]!.name.includes("no nominal fps available"));
  assert.equal(gatePassed(results), false);
});

// ---------------------------------------------------------------------------
// buildCadenceFpsStats — cadence warmup-scope tests
// ---------------------------------------------------------------------------

// Approximates rerun-12 diagnostics: warmup sample at 61 fps, then 59
// samples at 54-56 fps.  All-sample spread = 7 fps; post-warmup spread = 2 fps.
function rerun12LikeSamples(): Array<{ observedFps: number }> {
  const out: Array<{ observedFps: number }> = [];
  out.push({ observedFps: 61 }); // warmup sample
  // 59 effective samples matching rerun-12 distribution
  const steady = [
    55, 55, 54, 55, 55, 55, 54, 55, 55, 55, 55, 55, 55, 55, 55,
    54, 55, 55, 55, 54, 55, 55, 55, 55, 55, 55, 55, 55, 55, 55,
    55, 55, 55, 54, 56, 55, 55, 55, 55, 55, 55, 55, 55, 55, 56,
    55, 54, 55, 54, 56, 55, 55, 55, 55, 54, 55, 54, 55, 54,
  ];
  for (const fps of steady) out.push({ observedFps: fps });
  return out;
}

test("buildCadenceFpsStats: rerun-12-shaped samples with warmup=1 gives post-warmup spread of 2 fps", () => {
  const samples = rerun12LikeSamples();
  const stats = buildCadenceFpsStats(samples, 1);

  // Effective samples exclude the 61-fps warmup sample
  assert.equal(stats.sampleCount, 59);
  // Post-warmup spread: max=56, min=54 -> 2 fps
  assert.equal(stats.spreadFps, 2);
  // Post-warmup mean is 54.88..., well below all-sample mean of 54.983
  assert.ok(stats.meanFps < 54.95, `mean ${stats.meanFps} should be < 54.95 (all-sample mean)`);
  assert.ok(stats.meanFps > 54.5, `mean ${stats.meanFps} should be > 54.5`);
});

test("buildCadenceFpsStats: rerun-12-shaped samples with warmup=0 gives all-sample spread of 7 fps", () => {
  const samples = rerun12LikeSamples();
  const stats = buildCadenceFpsStats(samples, 0);

  assert.equal(stats.sampleCount, 60);
  // All-sample spread: max=61, min=54 -> 7 fps
  assert.equal(stats.spreadFps, 7);
  // All-sample mean includes the 61-fps warmup -> 54.983
  assert.ok(stats.meanFps > 54.95, `mean ${stats.meanFps} should include the 61-fps warmup`);
});

test("buildCadenceFpsStats: bursty post-warmup samples still fail spread gate with warmup=1", () => {
  // warmup sample at 75 fps, then post-warmup samples spanning 21 fps (bursty)
  const samples = [
    { observedFps: 75 }, // warmup
    { observedFps: 48 }, // post-warmup min
    ...Array.from({ length: 57 }, () => ({ observedFps: 55 })),
    { observedFps: 69 }, // post-warmup max -> spread = 21 fps
  ];
  const stats = buildCadenceFpsStats(samples, 1);

  assert.equal(stats.sampleCount, 59);
  // Post-warmup spread = 69-48 = 21 fps -> exceeds 20.0 threshold
  assert.equal(stats.spreadFps, 21);
});

test("buildCadenceFpsStats: negotiated strict path — warmup exclusion applies to mean and spread", () => {
  // fps_num > 0 path: strict cadence, but warmup still excludes sample 0
  const samples = [
    { observedFps: 80 }, // warmup spike
    ...Array.from({ length: 59 }, () => ({ observedFps: 60 })),
  ];
  const stats = buildCadenceFpsStats(samples, 1);

  assert.equal(stats.sampleCount, 59);
  assert.equal(stats.meanFps, 60);
  assert.equal(stats.spreadFps, 0);
});

test("buildCadenceFpsStats: informational strict cadence uses the same effective post-warmup mean", () => {
  // Verify the mean used for the informational strict check reflects post-warmup samples
  const samples = rerun12LikeSamples();
  const withWarmup = buildCadenceFpsStats(samples, 1);
  const withoutWarmup = buildCadenceFpsStats(samples, 0);

  // Mean should differ: warmup=1 excludes the 61-fps sample -> lower mean
  assert.ok(withWarmup.meanFps < withoutWarmup.meanFps);
  // The informational check that would be emitted uses withWarmup.meanFps, not withoutWarmup.meanFps
  const infoCtx: CadenceEvalContext = {
    meanFps: withWarmup.meanFps,
    spreadFps: withWarmup.spreadFps,
    sampleCount: withWarmup.sampleCount,
    nominalFps: 60,
    nominalSource: "row-config",
    isVariableRate: true,
  };
  const results = evaluateCadenceThresholds(infoCtx);
  const infoResult = results.find((r) => r.gating === false);
  assert.ok(infoResult, "informational strict threshold must be present");
  // The observed mean in the informational row must be the post-warmup mean
  assert.ok(
    parseFloat(String(infoResult!.observed)) < 54.95,
    `informational observed ${infoResult!.observed} should reflect post-warmup mean (< 54.95)`,
  );
});
