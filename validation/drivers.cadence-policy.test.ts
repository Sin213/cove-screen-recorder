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
//   3. bursty spread > 6.0 fps fails spread gate (gating threshold)
//   4. fps_num>0 (nominalSource="negotiated") still uses strict ±0.5% gate
//   5. missing nominal (nominalFps=null) fails closed

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { evaluateCadenceThresholds } from "./drivers";
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

  // Entry 1: spread ≤ 6.0 fps — 0.5 passes.
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

test("bursty spread > 6.0 fps fails spread gate", () => {
  const ctx: CadenceEvalContext = {
    meanFps: 55,
    spreadFps: 7.0,
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

  // Spread gate fails (7.0 > 6.0).
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
