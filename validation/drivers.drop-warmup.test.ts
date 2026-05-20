// T-021 VAL-CAP-004 startup drop warmup tests.
//
// Self-contained: uses Node's built-in `node:test` runner (Node 18+), no
// jest/vitest/mocha. Compiled by `npm run validate:build`; run via:
//
//   node --test dist-validation/drivers.drop-warmup.test.js
//
// Tests cover four spec contracts:
//   1. warmup=1 on rerun-10-style samples (drops only in sample 1) -> 0
//   2. warmup=0 on the same samples -> the original failing drop rate
//   3. A drop in sample 2 or later still fails under warmup=1
//   4. Cadence calculation is unaffected by warmup
//
// The cadence assertion is by inspection of the public surface: the warmup
// helper does not consume `observedFps` at all and returns no cadence
// field — so by construction it cannot perturb cadence. The driver site in
// `drivers.ts` continues to mean over the unfiltered `samples` array.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { computeDropRateWithWarmup } from "./drivers";

interface FakeSample {
  t: number;
  droppedSinceLast: number;
  totalProduced: number;
  observedFps: number;
}

// Approximation of MVP smoke rerun 10 / rerun 8 shape:
// - 60 samples
// - sample 1 (index 0): startup, 19 drops, ~60 frames produced
// - samples 2..60: steady state, 0 drops, ~55 frames each
// - lastSample.totalProduced -> 3324 (matches rerun 10 evidence)
function rerun10LikeSamples(): FakeSample[] {
  const out: FakeSample[] = [];
  // Sample 1: 60 produced, 19 dropped (all drops here, per evidence).
  out.push({ t: 0, droppedSinceLast: 19, totalProduced: 60, observedFps: 60 });
  // Samples 2..60: 55 fps steady, 0 drops.
  let produced = 60;
  for (let i = 1; i < 60; i++) {
    produced += 55;
    out.push({
      t: i,
      droppedSinceLast: 0,
      totalProduced: produced,
      observedFps: 55,
    });
  }
  return out;
}

test("warmup=1 on rerun-10 shape drops sample 1 from drop-rate -> 0", () => {
  const samples = rerun10LikeSamples();
  const r = computeDropRateWithWarmup(samples, 1);

  assert.equal(r.valid, true);
  assert.equal(r.warmupSamples, 1);
  assert.equal(r.totalSamples, 60);
  assert.equal(r.effectiveSamples, 59);
  assert.equal(r.totalDropped, 0);
  assert.equal(r.dropWarmupExcludedDropped, 19);
  assert.equal(r.dropWarmupProduced, 60);
  // Last produced (60 + 59*55 = 3305) minus warmup produced (60) = 3245.
  assert.equal(r.dropEffectiveProduced, 3245);
  assert.equal(r.dropRate, 0);
});

test("warmup=0 preserves prior failing drop rate on the same samples", () => {
  const samples = rerun10LikeSamples();
  const r = computeDropRateWithWarmup(samples, 0);

  // Bit-identical to the prior calc: totalDropped / lastSample.totalProduced.
  const lastProduced = samples[samples.length - 1].totalProduced;
  const expected = 19 / lastProduced;

  assert.equal(r.valid, true);
  assert.equal(r.warmupSamples, 0);
  assert.equal(r.effectiveSamples, 60);
  assert.equal(r.totalDropped, 19);
  assert.equal(r.dropWarmupExcludedDropped, 0);
  assert.equal(r.dropWarmupProduced, 0);
  assert.equal(r.dropEffectiveProduced, lastProduced);
  assert.equal(r.dropRate, expected);
  assert.ok(r.dropRate > 0, "warmup=0 must reproduce the prior failing rate");
});

test("drops after sample 1 still fail under warmup=1", () => {
  // Same shape, but inject 5 drops at sample 10 (post-warmup).
  const samples = rerun10LikeSamples();
  samples[10] = { ...samples[10], droppedSinceLast: 5 };
  const r = computeDropRateWithWarmup(samples, 1);

  assert.equal(r.valid, true);
  assert.equal(r.dropWarmupExcludedDropped, 19);
  assert.equal(r.totalDropped, 5);
  assert.ok(r.dropRate > 0, "post-warmup drops must still produce a non-zero rate");
  // Strict gate (THRESHOLDS.captureDropRate["1080p60-nvenc"] = 0) would fail.
  assert.ok(r.dropRate > 0);
});

test("cadence input is independent of warmup", () => {
  // Cadence is mean(observedFps) over ALL samples; the warmup helper does
  // not return a cadence field and does not consume observedFps. Verifying
  // it directly: mean over unfiltered samples is identical regardless of
  // whether warmup is requested.
  const samples = rerun10LikeSamples();
  const cadenceUnfiltered =
    samples.reduce((s, x) => s + x.observedFps, 0) / samples.length;

  // Call with warmup=0 and warmup=1; neither call should alter the input.
  computeDropRateWithWarmup(samples, 0);
  computeDropRateWithWarmup(samples, 1);

  const cadenceAfter =
    samples.reduce((s, x) => s + x.observedFps, 0) / samples.length;
  assert.equal(cadenceAfter, cadenceUnfiltered);

  // Spot-check: ~55.08 fps for the rerun-10-like shape.
  assert.ok(cadenceAfter > 55 && cadenceAfter < 56);
});

test("warmup leaves no effective samples -> fail-closed (invalid)", () => {
  // Only 1 sample, warmup=1 -> effective is empty.
  const samples: FakeSample[] = [
    { t: 0, droppedSinceLast: 5, totalProduced: 60, observedFps: 60 },
  ];
  const r = computeDropRateWithWarmup(samples, 1);

  assert.equal(r.valid, false);
  assert.equal(r.effectiveSamples, 0);
});

test("warmup with non-positive produced delta -> fail-closed", () => {
  // Two samples with identical totalProduced (no forward progress after
  // warmup) -> denominator is 0 -> invalid.
  const samples: FakeSample[] = [
    { t: 0, droppedSinceLast: 19, totalProduced: 100, observedFps: 60 },
    { t: 1, droppedSinceLast: 0, totalProduced: 100, observedFps: 0 },
  ];
  const r = computeDropRateWithWarmup(samples, 1);

  assert.equal(r.valid, false);
  assert.equal(r.dropEffectiveProduced, 0);
});

test("warmup clamped to total samples does not crash", () => {
  // warmup > samples.length -> effective empty -> invalid, not a throw.
  const samples = rerun10LikeSamples();
  const r = computeDropRateWithWarmup(samples, 1000);
  assert.equal(r.valid, false);
  assert.equal(r.effectiveSamples, 0);
});
