// VAL-UI-003 fast/slow-export policy tests.
//
// Self-contained: uses Node's built-in `node:test` runner (Node 18+), matching
// drivers.drop-warmup.test.ts. Compiled by `npm run validate:build`; run via:
//
//   node --test dist-validation/drivers.ui003-policy.test.js
//
// Contract:
//   1. Fast export (windowS < 3) with terminalMethod=export.completed and
//      passing static assertions => row PASS. The two dynamic window/HUD-Hz
//      thresholds are emitted as gating:false (informational), and a new
//      gating threshold records EXPORTING-state observation.
//   2. Slow export (windowS >= 3) with missed HUD seconds => row FAIL via
//      the strict HUD-Hz dynamic gate.
//   3. Slow export (windowS >= 3) with clean HUD Hz and passing statics =>
//      row PASS.
//
// The helper is a pure ThresholdResult[] builder; the caller (driveValUi003)
// derives the row verdict from `thresholds.every((t) => t.gating === false || t.passed)`.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  evaluateUi003PolicyThresholds,
  Ui003PolicyEvalInput,
} from "./drivers";
import { ThresholdResult } from "./types";

function rowPasses(thresholds: ThresholdResult[]): boolean {
  return thresholds.every((t) => t.gating === false || t.passed);
}

function findByName(
  thresholds: ThresholdResult[],
  needle: string,
): ThresholdResult | undefined {
  return thresholds.find((t) => t.name.includes(needle));
}

const happyStatics = {
  appClockAssertionPassed: true,
  appClockAssertionMsg: "",
  clocksRafAssertionPassed: true,
  clocksRafAssertionMsg: "",
};

test("fast export (windowS < 3) PASSes when export.completed and statics pass", () => {
  const input: Ui003PolicyEvalInput = {
    windowS: 0,
    diagCount: 0,
    hudMinHz: 1,
    terminalMethod: "export.completed",
    hudPassed: false,
    hudMissedSeconds: [0, 1, 2],
    ...happyStatics,
  };
  const { thresholds, policy } = evaluateUi003PolicyThresholds(input);
  assert.equal(policy, "fast-export");
  assert.ok(rowPasses(thresholds), "row must pass under fast-export policy");

  const win = findByName(thresholds, "EXPORTING window >= 3 seconds");
  assert.ok(win, "window threshold present");
  assert.equal(win!.gating, false, "window threshold demoted to informational");
  assert.equal(win!.passed, false);

  const hud = findByName(thresholds, "HUD diagnostics at >= 1 Hz");
  assert.ok(hud, "HUD-Hz threshold present");
  assert.equal(hud!.gating, false, "HUD-Hz demoted to informational");

  const fastGate = findByName(thresholds, "fast-export branch active");
  assert.ok(fastGate, "fast-export gating threshold present");
  assert.notEqual(
    fastGate!.gating,
    false,
    "fast-export branch threshold must remain gating",
  );
  assert.equal(fastGate!.passed, true);

  const exportGate = findByName(
    thresholds,
    "export completed successfully (not failed or cancelled)",
  );
  assert.ok(exportGate);
  assert.equal(exportGate!.passed, true);
});

test("fast export (windowS < 3) FAILs when terminal is not export.completed", () => {
  const input: Ui003PolicyEvalInput = {
    windowS: 1,
    diagCount: 0,
    hudMinHz: 1,
    terminalMethod: "export.failed",
    hudPassed: false,
    hudMissedSeconds: [],
    ...happyStatics,
  };
  const { thresholds, policy } = evaluateUi003PolicyThresholds(input);
  assert.equal(policy, "fast-export");
  assert.equal(rowPasses(thresholds), false);

  const exportGate = findByName(
    thresholds,
    "export completed successfully (not failed or cancelled)",
  );
  assert.ok(exportGate);
  assert.equal(exportGate!.passed, false);

  const fastGate = findByName(thresholds, "fast-export branch active");
  assert.ok(fastGate);
  assert.equal(fastGate!.passed, false);
});

test("slow export (windowS >= 3) FAILs on missed HUD seconds", () => {
  const input: Ui003PolicyEvalInput = {
    windowS: 5,
    diagCount: 3,
    hudMinHz: 1,
    terminalMethod: "export.completed",
    hudPassed: false,
    hudMissedSeconds: [1, 3],
    ...happyStatics,
  };
  const { thresholds, policy } = evaluateUi003PolicyThresholds(input);
  assert.equal(policy, "slow-export");
  assert.equal(rowPasses(thresholds), false);

  const hud = findByName(thresholds, "HUD diagnostics at >= 1 Hz");
  assert.ok(hud);
  assert.notEqual(
    hud!.gating,
    false,
    "slow-export HUD-Hz must remain a gating check",
  );
  assert.equal(hud!.passed, false);

  const win = findByName(thresholds, "EXPORTING window >= 3 seconds");
  assert.ok(win);
  assert.notEqual(
    win!.gating,
    false,
    "slow-export window check must remain a gating check",
  );
});

test("slow export (windowS >= 3) PASSes on clean HUD Hz and passing statics", () => {
  const input: Ui003PolicyEvalInput = {
    windowS: 5,
    diagCount: 5,
    hudMinHz: 1,
    terminalMethod: "export.completed",
    hudPassed: true,
    hudMissedSeconds: [],
    ...happyStatics,
  };
  const { thresholds, policy } = evaluateUi003PolicyThresholds(input);
  assert.equal(policy, "slow-export");
  assert.ok(rowPasses(thresholds));

  // No fast-export-branch gating threshold should appear in the slow path.
  const fastGate = findByName(thresholds, "fast-export branch active");
  assert.equal(
    fastGate,
    undefined,
    "fast-export gate must not appear on slow-export branch",
  );
});

test("slow export still FAILs when static assertions fail", () => {
  const input: Ui003PolicyEvalInput = {
    windowS: 6,
    diagCount: 6,
    hudMinHz: 1,
    terminalMethod: "export.completed",
    hudPassed: true,
    hudMissedSeconds: [],
    appClockAssertionPassed: false,
    appClockAssertionMsg: "missing EXPORTING state",
    clocksRafAssertionPassed: true,
    clocksRafAssertionMsg: "",
  };
  const { thresholds } = evaluateUi003PolicyThresholds(input);
  assert.equal(rowPasses(thresholds), false);

  const appAssert = findByName(thresholds, "App.tsx: v2 clock active");
  assert.ok(appAssert);
  assert.notEqual(
    appAssert!.gating,
    false,
    "static App.tsx assertion must remain strict",
  );
});

test("fast export still FAILs when static assertions fail", () => {
  const input: Ui003PolicyEvalInput = {
    windowS: 0,
    diagCount: 0,
    hudMinHz: 1,
    terminalMethod: "export.completed",
    hudPassed: false,
    hudMissedSeconds: [],
    appClockAssertionPassed: true,
    appClockAssertionMsg: "",
    clocksRafAssertionPassed: false,
    clocksRafAssertionMsg: "rAF missing",
  };
  const { thresholds, policy } = evaluateUi003PolicyThresholds(input);
  assert.equal(policy, "fast-export");
  assert.equal(rowPasses(thresholds), false);

  const rafAssert = findByName(thresholds, "src/v2/clocks.ts");
  assert.ok(rafAssert);
  assert.notEqual(
    rafAssert!.gating,
    false,
    "static rAF assertion must remain strict in fast-export branch",
  );
});
