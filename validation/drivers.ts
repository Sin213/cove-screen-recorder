import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { RowReport, RowStatus, ThresholdResult, SkipReason } from "./types";
import { SmokeRow } from "./rows";
import { RpcClient, RpcNotification } from "./rpc-client";
import {
  spawnHelper,
  shutdownHelper,
  pgrepCheck,
  getDescendantProcessNames,
  runnerOwnedSocketPath,
  sigtermSpawned,
  SpawnedHelper,
} from "./helper-lifecycle";
import {
  createRowEvidenceDir,
  writeJsonEvidence,
  writeEvidence,
} from "./evidence";
import {
  THRESHOLDS,
  VARIABLE_RATE_CADENCE,
  FfprobeError,
  runFfprobe,
  extractVideoPts,
  analyzePtsCadence,
  checkFrameCount,
  checkFrameCountVariableRate,
  checkHudHz,
} from "./assertions";
import { probeEnvironment, hasDisplayServer } from "./env-probe";
import { launchMotion60, LoadScriptMissingError, LaunchedLoad } from "./loads";
import {
  enforceDisplayMode,
  restoreDisplayMode,
  ModesetResult,
} from "./display-mode";

// ---------------------------------------------------------------------------
// ISS-001 VAL-CAP-004: variable-rate cadence policy exports.
// Pure functions / types — no I/O; unit-tested in drivers.cadence-policy.test.ts
// ---------------------------------------------------------------------------

export type CadenceNominalSource = "negotiated" | "row-config" | "missing";

export interface CadenceEvalContext {
  meanFps: number;
  /** max(observedFps) - min(observedFps) across all samples in the window. */
  spreadFps: number;
  sampleCount: number;
  nominalFps: number | null;
  nominalSource: CadenceNominalSource;
  /** captureFormat was present and had fps_num === 0 (KDE PipeWire variable-rate). */
  isVariableRate: boolean;
}

/**
 * Emit ThresholdResult[] for the cadence gate.  Two policies:
 *
 * variable-rate (isVariableRate && nominalSource==="row-config"):
 *   - gating: mean in [0.85×nominal .. 1.02×nominal]
 *   - gating: spread ≤ 20.0 fps
 *   - informational (gating=false): strict ±0.5% mean gate (evidence only)
 *
 * strict (all other cases with a known nominal):
 *   - gating: mean within ±cadenceMeanToleranceFrac of nominal
 *
 * Fail-closed paths (nominalFps===null or sampleCount<10) return a single
 * failed gating threshold — never a silent pass.
 */
export function evaluateCadenceThresholds(ctx: CadenceEvalContext): ThresholdResult[] {
  if (ctx.nominalFps === null) {
    return [
      {
        name: "cadence (no nominal fps available)",
        observed: `${ctx.meanFps.toFixed(3)} fps observed`,
        required: "row nominal fps or non-zero negotiated fps",
        passed: false,
      },
    ];
  }
  if (ctx.sampleCount < 10) {
    return [
      {
        name: "cadence (insufficient samples for mean check)",
        observed: String(ctx.sampleCount),
        required: ">= 10 diagnostics samples",
        passed: false,
      },
    ];
  }

  if (ctx.isVariableRate && ctx.nominalSource === "row-config") {
    const minFps = ctx.nominalFps * VARIABLE_RATE_CADENCE.variableRateCadenceMinFracOfNominal;
    const maxFps = ctx.nominalFps * VARIABLE_RATE_CADENCE.variableRateCadenceMaxFracOfNominal;
    const tol = THRESHOLDS.cadenceMeanToleranceFrac;
    return [
      {
        name: `cadence mean in variable-rate range [${minFps.toFixed(2)}..${maxFps.toFixed(2)}] fps (nominal source=${ctx.nominalSource})`,
        observed: ctx.meanFps.toFixed(3),
        required: `${minFps.toFixed(2)}..${maxFps.toFixed(2)}`,
        passed: ctx.meanFps >= minFps && ctx.meanFps <= maxFps,
      },
      {
        name: `cadence spread ≤ ${VARIABLE_RATE_CADENCE.variableRateCadenceMaxSpreadFps.toFixed(1)} fps (variable-rate compositor variance)`,
        observed: ctx.spreadFps.toFixed(3),
        required: `≤ ${VARIABLE_RATE_CADENCE.variableRateCadenceMaxSpreadFps.toFixed(1)}`,
        passed: ctx.spreadFps <= VARIABLE_RATE_CADENCE.variableRateCadenceMaxSpreadFps,
      },
      {
        name: `cadence mean within ±${(tol * 100).toFixed(1)}% of ${ctx.nominalFps.toFixed(2)} fps (nominal source=${ctx.nominalSource}, informational)`,
        observed: ctx.meanFps.toFixed(3),
        required: `${(ctx.nominalFps * (1 - tol)).toFixed(2)}..${(ctx.nominalFps * (1 + tol)).toFixed(2)}`,
        passed: Math.abs(ctx.meanFps - ctx.nominalFps) / ctx.nominalFps <= tol,
        gating: false,
      },
    ];
  }

  const tol = THRESHOLDS.cadenceMeanToleranceFrac;
  return [
    {
      name: `cadence mean within ±${(tol * 100).toFixed(1)}% of ${ctx.nominalFps.toFixed(2)} fps (nominal source=${ctx.nominalSource})`,
      observed: ctx.meanFps.toFixed(3),
      required: `${(ctx.nominalFps * (1 - tol)).toFixed(2)}..${(ctx.nominalFps * (1 + tol)).toFixed(2)}`,
      passed: Math.abs(ctx.meanFps - ctx.nominalFps) / ctx.nominalFps <= tol,
    },
  ];
}

/**
 * Compute cadence statistics (mean, spread, effective sample count) from a
 * diagnostics sample array, applying the same startup-warmup exclusion used
 * by the drop-rate gate.  The first `dropWarmupSamples` samples are excluded,
 * mirroring `computeDropRateWithWarmup`.
 */
export function buildCadenceFpsStats(
  samples: ReadonlyArray<{ observedFps: number }>,
  dropWarmupSamples: number,
): { meanFps: number; spreadFps: number; sampleCount: number } {
  const warmup = Math.min(Math.max(0, dropWarmupSamples), samples.length);
  const effective = samples.slice(warmup);
  if (effective.length === 0) {
    return { meanFps: 0, spreadFps: 0, sampleCount: 0 };
  }
  const fps = effective.map((s) => s.observedFps);
  const mean = fps.reduce((a, b) => a + b, 0) / fps.length;
  const spread = Math.max(...fps) - Math.min(...fps);
  return { meanFps: mean, spreadFps: spread, sampleCount: effective.length };
}

// ---------------------------------------------------------------------------
// VAL-UI-003 fast-export policy (drivers.ui003-policy.test.ts).
// Pure threshold-builder for the EXPORTING-window HUD-Hz row. Branches on the
// already-computed window length so a healthy fast stream-copy export does
// not fail the legacy >=3s window assumption while preserving strict freeze /
// lifecycle regression coverage for slow exports.
// ---------------------------------------------------------------------------

export type Ui003Policy = "fast-export" | "slow-export";

export interface Ui003PolicyEvalInput {
  /** Floor(windowDurationMs / 1000). */
  windowS: number;
  /** Number of capture.diagnostics arrivals observed inside the window. */
  diagCount: number;
  /** THRESHOLDS.hudMinHz at the time of the run. */
  hudMinHz: number;
  /** "export.completed" | "export.failed" | "export.cancelled". */
  terminalMethod: string;
  /** checkHudHz(...).passed for the observed window. */
  hudPassed: boolean;
  /** checkHudHz(...).missedSeconds (only used for evidence string). */
  hudMissedSeconds: number[];
  appClockAssertionPassed: boolean;
  appClockAssertionMsg: string;
  clocksRafAssertionPassed: boolean;
  clocksRafAssertionMsg: string;
}

export interface Ui003PolicyEvalResult {
  thresholds: ThresholdResult[];
  policy: Ui003Policy;
}

/**
 * Build the VAL-UI-003 ThresholdResult[] using the fast/slow-export branch
 * policy. windowS >= 3 keeps the legacy strict gates; windowS < 3 demotes
 * the two dynamic window/HUD-Hz thresholds to gating:false (informational)
 * and adds a single gating threshold proving export.completed in the
 * fast-export branch. Static assertions and the export-completed terminal
 * gate remain strict in both branches.
 */
export function evaluateUi003PolicyThresholds(
  input: Ui003PolicyEvalInput,
): Ui003PolicyEvalResult {
  const policy: Ui003Policy = input.windowS < 3 ? "fast-export" : "slow-export";
  const thresholds: ThresholdResult[] = [];

  thresholds.push({
    name: "export completed successfully (not failed or cancelled)",
    observed: input.terminalMethod,
    required: "export.completed",
    passed: input.terminalMethod === "export.completed",
  });

  const hudObserved = input.hudPassed
    ? `passed (${input.diagCount} samples over ${input.windowS}s)`
    : `missed seconds: [${input.hudMissedSeconds.join(", ")}]`;

  if (policy === "slow-export") {
    thresholds.push({
      name: "EXPORTING window >= 3 seconds",
      observed: input.windowS,
      required: ">= 3",
      passed: input.windowS >= 3,
    });

    thresholds.push({
      name: `HUD diagnostics at >= ${input.hudMinHz} Hz during EXPORTING window`,
      observed: hudObserved,
      required: `>= ${input.hudMinHz} capture.diagnostics event per second`,
      passed: input.hudPassed,
    });
  } else {
    thresholds.push({
      name: "EXPORTING window >= 3 seconds (fast-export informational)",
      observed: input.windowS,
      required: ">= 3",
      passed: input.windowS >= 3,
      gating: false,
    });

    thresholds.push({
      name: `HUD diagnostics at >= ${input.hudMinHz} Hz during EXPORTING window (fast-export informational)`,
      observed: hudObserved,
      required: `>= ${input.hudMinHz} capture.diagnostics event per second`,
      passed: input.hudPassed,
      gating: false,
    });

    thresholds.push({
      name: 'fast-export branch active (windowS < 3): EXPORTING state observed; HUD/freeze regression covered by static assertions',
      observed: JSON.stringify({
        windowS: input.windowS,
        diagCount: input.diagCount,
        terminalMethod: input.terminalMethod,
      }),
      required: 'windowS < 3 AND terminalMethod === "export.completed"',
      passed:
        input.terminalMethod === "export.completed" && input.windowS < 3,
    });
  }

  thresholds.push({
    name: "App.tsx: v2 clock active for RECORDING/SAVING/EXPORTING with v2SessionReadyMs guard",
    observed: input.appClockAssertionPassed
      ? "assertion matched"
      : input.appClockAssertionMsg,
    required:
      "v2 active-state array includes RECORDING/SAVING/EXPORTING AND v2SessionReadyMs null check present",
    passed: input.appClockAssertionPassed,
  });

  thresholds.push({
    name: "src/v2/clocks.ts: useV2ElapsedMs is rAF-driven",
    observed: input.clocksRafAssertionPassed
      ? "requestAnimationFrame found"
      : input.clocksRafAssertionMsg,
    required: "useV2ElapsedMs uses requestAnimationFrame",
    passed: input.clocksRafAssertionPassed,
  });

  return { thresholds, policy };
}

export interface DriverContext {
  rpc: RpcClient | null;
  socketPath: string;
}

function makeReport(
  row: SmokeRow,
  status: RowStatus,
  opts?: {
    message?: string;
    durationMs?: number;
    evidencePaths?: Record<string, string>;
    thresholds?: ThresholdResult[];
    skipReason?: SkipReason;
  },
): RowReport {
  return {
    id: row.id,
    title: row.title,
    classification: row.classification,
    tier: row.tier,
    ownerOnFail: row.ownerOnFail,
    linkedSourceCase: row.linkedSourceCase,
    status,
    ...(opts?.skipReason ? { skipReason: opts.skipReason } : {}),
    ...(opts?.message ? { message: opts.message } : {}),
    ...(opts?.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    ...(opts?.evidencePaths
      ? { evidencePaths: { extra: opts.evidencePaths } }
      : {}),
    ...(opts?.thresholds ? { thresholds: opts.thresholds } : {}),
  };
}

export async function driveValPkg001(
  row: SmokeRow,
  ctx: DriverContext,
): Promise<RowReport> {
  const start = Date.now();
  const evidenceDir = createRowEvidenceDir(row.id);

  if (!ctx.rpc) {
    return makeReport(row, "error", {
      message: "RPC client not available despite helper detected",
    });
  }

  try {
    const healthResp = await ctx.rpc.call(
      "engine.health",
      undefined,
      row.budgetMs,
    );
    const versionResp = await ctx.rpc.call("engine.version", undefined, 5_000);
    const durationMs = Date.now() - start;

    writeJsonEvidence(evidenceDir, "engine-health.json", healthResp);
    writeJsonEvidence(evidenceDir, "engine-version.json", versionResp);

    const thresholds: ThresholdResult[] = [];

    const healthOk = healthResp.result && !healthResp.error;
    thresholds.push({
      name: "engine.health responds without error",
      observed: healthOk ? "ok" : JSON.stringify(healthResp.error),
      required: "no error",
      passed: !!healthOk,
    });

    const versionOk = versionResp.result && !versionResp.error;
    thresholds.push({
      name: "engine.version responds without error",
      observed: versionOk ? "ok" : JSON.stringify(versionResp.error),
      required: "no error",
      passed: !!versionOk,
    });

    thresholds.push({
      name: "response within budget",
      observed: durationMs,
      required: `<= ${row.budgetMs} ms`,
      passed: durationMs <= row.budgetMs,
    });

    const healthResult = healthResp.result as
      | Record<string, unknown>
      | undefined;
    const stateOk = healthResult?.state === "ready";
    thresholds.push({
      name: "engine state is ready",
      observed: String(healthResult?.state ?? "unknown"),
      required: "ready",
      passed: stateOk,
    });

    const allPassed = thresholds.every((t) => t.passed);
    return makeReport(row, allPassed ? "pass" : "fail", {
      durationMs,
      thresholds,
      evidencePaths: {
        "engine-health": evidenceDir + "/engine-health.json",
        "engine-version": evidenceDir + "/engine-version.json",
      },
      message: allPassed
        ? "Helper readiness confirmed via engine.health + engine.version"
        : "One or more health/version checks failed",
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `RPC error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  }
}

export async function driveValProc001(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();
  let spawned: SpawnedHelper | null = null;

  try {
    const baseline = pgrepCheck();

    const socketPath = runnerOwnedSocketPath();
    spawned = await spawnHelper(socketPath);
    const rpc = await RpcClient.connect(socketPath, 5_000);

    const readyNotif = await rpc.waitNotification("engine.ready", 10_000);
    writeJsonEvidence(evidenceDir, "engine-ready.json", readyNotif);
    writeJsonEvidence(evidenceDir, "baseline_pgrep.json", baseline);

    const preCheck = pgrepCheck(baseline);
    writeJsonEvidence(evidenceDir, "pre_pgrep.json", preCheck);
    writeEvidence(
      evidenceDir,
      "pre_pgrep.txt",
      `baseline (excluded): engine=${baseline.coveReplayEngine.join(",") || "none"} ffmpeg=${baseline.ffmpeg.join(",") || "none"} pactl=${baseline.pactl.join(",") || "none"}\n` +
        `cove-replay-engine: ${preCheck.coveReplayEngine.join(",") || "none"}\n` +
        `ffmpeg: ${preCheck.ffmpeg.join(",") || "none"}\n` +
        `pactl: ${preCheck.pactl.join(",") || "none"}\n`,
    );

    const shutdownResp = await shutdownHelper(rpc);
    writeJsonEvidence(evidenceDir, "shutdown-response.json", shutdownResp);
    rpc.close();

    const cleanupDelayS = THRESHOLDS.processCleanupAfterShutdownS;
    await new Promise((r) => setTimeout(r, cleanupDelayS * 1_000));

    const postCheck = pgrepCheck(baseline);
    writeJsonEvidence(evidenceDir, "post_pgrep.json", postCheck);
    writeEvidence(
      evidenceDir,
      "post_pgrep.txt",
      `baseline (excluded): engine=${baseline.coveReplayEngine.join(",") || "none"} ffmpeg=${baseline.ffmpeg.join(",") || "none"} pactl=${baseline.pactl.join(",") || "none"}\n` +
        `cove-replay-engine: ${postCheck.coveReplayEngine.join(",") || "none"}\n` +
        `ffmpeg: ${postCheck.ffmpeg.join(",") || "none"}\n` +
        `pactl: ${postCheck.pactl.join(",") || "none"}\n`,
    );

    const thresholds: ThresholdResult[] = [];

    const noEngine = postCheck.coveReplayEngine.length === 0;
    thresholds.push({
      name: "no runner-owned cove-replay-engine after shutdown",
      observed: postCheck.coveReplayEngine.length,
      required: "0",
      passed: noEngine,
    });

    const noFfmpeg = postCheck.ffmpeg.length === 0;
    thresholds.push({
      name: "no ffmpeg after shutdown",
      observed: postCheck.ffmpeg.length,
      required: "0",
      passed: noFfmpeg,
    });

    const noPactl = postCheck.pactl.length === 0;
    thresholds.push({
      name: "no pactl after shutdown",
      observed: postCheck.pactl.length,
      required: "0",
      passed: noPactl,
    });

    const allPassed = thresholds.every((t) => t.passed);
    return makeReport(row, allPassed ? "pass" : "fail", {
      durationMs: Date.now() - start,
      thresholds,
      evidencePaths: {
        "pre_pgrep": evidenceDir + "/pre_pgrep.txt",
        "post_pgrep": evidenceDir + "/post_pgrep.txt",
      },
      message: allPassed
        ? `All processes cleaned up within ${cleanupDelayS}s after engine.shutdown`
        : "Leftover processes detected after shutdown",
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `Process cleanup test error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  } finally {
    if (spawned && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

export async function driveValProc007(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();
  let spawned: SpawnedHelper | null = null;

  try {
    const socketPath = runnerOwnedSocketPath();
    spawned = await spawnHelper(socketPath);
    const rpc = await RpcClient.connect(socketPath, 5_000);
    await rpc.waitNotification("engine.ready", 10_000);

    const children = getDescendantProcessNames(spawned.pid);
    writeEvidence(
      evidenceDir,
      "process-tree.txt",
      `helper PID: ${spawned.pid}\nchildren: ${children.length > 0 ? children.join(", ") : "none"}\n`,
    );
    writeJsonEvidence(evidenceDir, "process-tree.json", {
      helperPid: spawned.pid,
      children,
    });

    const hasPactl = children.some((c) => c.toLowerCase().includes("pactl"));

    const thresholds: ThresholdResult[] = [
      {
        name: "no pactl in helper process tree",
        observed: hasPactl
          ? children
              .filter((c) => c.toLowerCase().includes("pactl"))
              .join(", ")
          : "none",
        required: "no pactl",
        passed: !hasPactl,
      },
    ];

    const shutdownResp = await shutdownHelper(rpc);
    writeJsonEvidence(evidenceDir, "shutdown-response.json", shutdownResp);
    rpc.close();

    await new Promise((r) => setTimeout(r, 2_000));

    return makeReport(row, !hasPactl ? "pass" : "fail", {
      durationMs: Date.now() - start,
      thresholds,
      evidencePaths: {
        "process-tree": evidenceDir + "/process-tree.txt",
      },
      message: !hasPactl
        ? "No pactl found in helper process tree during idle"
        : "pactl found in helper process tree",
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `pactl absence check error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  } finally {
    if (spawned && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

export async function driveValCap003(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();
  let spawned: SpawnedHelper | null = null;

  try {
    const socketPath = runnerOwnedSocketPath();
    spawned = await spawnHelper(socketPath, [
      "--simulate",
      "--simulate-fail",
      "capture.startStream=portal-denied",
    ]);
    const rpc = await RpcClient.connect(socketPath, 5_000);
    await rpc.waitNotification("engine.ready", 10_000);

    const reqResp = await rpc.call(
      "capture.requestSession",
      { mode: "monitor", cursor_mode: "embedded", persist: "transient" },
      5_000,
    );
    writeJsonEvidence(evidenceDir, "requestSession-response.json", reqResp);

    const startResp = await rpc.call("capture.startStream", {}, 5_000);
    writeJsonEvidence(evidenceDir, "startStream-response.json", startResp);

    let sessionLostNotif: RpcNotification;
    try {
      sessionLostNotif = await rpc.waitNotification("capture.sessionLost", 10_000);
    } catch (e) {
      writeEvidence(evidenceDir, "sessionLost-error.txt", String(e));
      const shutdownResp = await shutdownHelper(rpc);
      writeJsonEvidence(evidenceDir, "shutdown-response.json", shutdownResp);
      rpc.close();
      return makeReport(row, "error", {
        message: `capture.sessionLost not received within timeout: ${String(e)}`,
        durationMs: Date.now() - start,
      });
    }
    writeJsonEvidence(evidenceDir, "sessionLost-notification.json", sessionLostNotif);

    const healthResp = await rpc.call("engine.health", undefined, 5_000);
    writeJsonEvidence(evidenceDir, "engine-health.json", healthResp);

    const shutdownResp = await shutdownHelper(rpc);
    writeJsonEvidence(evidenceDir, "shutdown-response.json", shutdownResp);
    rpc.close();

    const durationMs = Date.now() - start;
    const thresholds: ThresholdResult[] = [];

    thresholds.push({
      name: "capture.sessionLost notification received",
      observed: "received",
      required: "notification received",
      passed: true,
    });

    const params = sessionLostNotif.params as Record<string, unknown> | undefined;
    const notifReason = params?.reason;
    thresholds.push({
      name: "sessionLost reason is portal-denied",
      observed: String(notifReason ?? "(no notification)"),
      required: "portal-denied",
      passed: notifReason === "portal-denied",
    });

    const healthResult = healthResp.result as Record<string, unknown> | undefined;
    const helperIdle = healthResult?.state === "ready";
    thresholds.push({
      name: "helper state is ready (IDLE) after portal denial",
      observed: String(healthResult?.state ?? "unknown"),
      required: "ready",
      passed: helperIdle,
    });

    thresholds.push({
      name: "response within budget",
      observed: durationMs,
      required: `<= ${row.budgetMs} ms`,
      passed: durationMs <= row.budgetMs,
    });

    const allPassed = thresholds.every((t) => t.passed);
    return makeReport(row, allPassed ? "pass" : "fail", {
      durationMs,
      thresholds,
      evidencePaths: {
        "sessionLost": evidenceDir + "/sessionLost-notification.json",
        "engine-health": evidenceDir + "/engine-health.json",
      },
      message: allPassed
        ? "Portal denial emitted capture.sessionLost(portal-denied); helper returned to IDLE"
        : "Portal denial test failed — see thresholds",
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `Portal denial test error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  } finally {
    if (spawned && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

export async function driveValProc002(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();
  let spawned: SpawnedHelper | null = null;

  try {
    const baseline = pgrepCheck();
    writeJsonEvidence(evidenceDir, "baseline_pgrep.json", baseline);

    const socketPath = runnerOwnedSocketPath();
    spawned = await spawnHelper(socketPath, ["--simulate"]);
    const rpc = await RpcClient.connect(socketPath, 5_000);
    await rpc.waitNotification("engine.ready", 10_000);

    const reqResp = await rpc.call(
      "capture.requestSession",
      { mode: "monitor", cursor_mode: "embedded", persist: "transient" },
      5_000,
    );
    writeJsonEvidence(evidenceDir, "requestSession-response.json", reqResp);

    const startResp = await rpc.call("capture.startStream", {}, 5_000);
    writeJsonEvidence(evidenceDir, "startStream-response.json", startResp);

    const sessionReadyNotif = await rpc.waitNotification("capture.sessionReady", 10_000);
    writeJsonEvidence(evidenceDir, "sessionReady-notification.json", sessionReadyNotif);

    const preCheck = pgrepCheck(baseline);
    writeJsonEvidence(evidenceDir, "pre_pgrep.json", preCheck);
    writeEvidence(
      evidenceDir,
      "pre_pgrep.txt",
      `baseline (excluded): engine=${baseline.coveReplayEngine.join(",") || "none"} ffmpeg=${baseline.ffmpeg.join(",") || "none"} pactl=${baseline.pactl.join(",") || "none"}\n` +
        `cove-replay-engine: ${preCheck.coveReplayEngine.join(",") || "none"}\n` +
        `ffmpeg: ${preCheck.ffmpeg.join(",") || "none"}\n` +
        `pactl: ${preCheck.pactl.join(",") || "none"}\n`,
    );

    const stopResp = await rpc.call("capture.stopSession", {}, 10_000);
    writeJsonEvidence(evidenceDir, "stopSession-response.json", stopResp);

    if (stopResp.error) {
      const shutdownResp = await shutdownHelper(rpc);
      writeJsonEvidence(evidenceDir, "shutdown-response.json", shutdownResp);
      rpc.close();
      return makeReport(row, "error", {
        message: `capture.stopSession failed (code=${stopResp.error.code}): ${stopResp.error.message}`,
        durationMs: Date.now() - start,
      });
    }

    const shutdownResp = await shutdownHelper(rpc);
    writeJsonEvidence(evidenceDir, "shutdown-response.json", shutdownResp);
    rpc.close();

    const cleanupDelayS = THRESHOLDS.processCleanupAfterShutdownS;
    await new Promise((r) => setTimeout(r, cleanupDelayS * 1_000));

    const postCheck = pgrepCheck(baseline);
    writeJsonEvidence(evidenceDir, "post_pgrep.json", postCheck);
    writeEvidence(
      evidenceDir,
      "post_pgrep.txt",
      `baseline (excluded): engine=${baseline.coveReplayEngine.join(",") || "none"} ffmpeg=${baseline.ffmpeg.join(",") || "none"} pactl=${baseline.pactl.join(",") || "none"}\n` +
        `cove-replay-engine: ${postCheck.coveReplayEngine.join(",") || "none"}\n` +
        `ffmpeg: ${postCheck.ffmpeg.join(",") || "none"}\n` +
        `pactl: ${postCheck.pactl.join(",") || "none"}\n`,
    );

    const thresholds: ThresholdResult[] = [];

    const noEngine = postCheck.coveReplayEngine.length === 0;
    thresholds.push({
      name: "no cove-replay-engine after stopSession+shutdown",
      observed: postCheck.coveReplayEngine.length,
      required: "0",
      passed: noEngine,
    });

    const noFfmpeg = postCheck.ffmpeg.length === 0;
    thresholds.push({
      name: "no ffmpeg after stopSession+shutdown",
      observed: postCheck.ffmpeg.length,
      required: "0",
      passed: noFfmpeg,
    });

    const noPactl = postCheck.pactl.length === 0;
    thresholds.push({
      name: "no pactl after stopSession+shutdown",
      observed: postCheck.pactl.length,
      required: "0",
      passed: noPactl,
    });

    const allPassed = thresholds.every((t) => t.passed);
    return makeReport(row, allPassed ? "pass" : "fail", {
      durationMs: Date.now() - start,
      thresholds,
      evidencePaths: {
        "pre_pgrep": evidenceDir + "/pre_pgrep.txt",
        "post_pgrep": evidenceDir + "/post_pgrep.txt",
      },
      message: allPassed
        ? `All processes cleaned up within ${cleanupDelayS}s after stopSession+shutdown`
        : "Leftover processes detected after stopSession+shutdown",
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `Process cleanup (PROC-002) test error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  } finally {
    if (spawned && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

export async function driveValProc003(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();
  let spawned: SpawnedHelper | null = null;
  let rpc: RpcClient | null = null;

  try {
    const baseline = pgrepCheck();
    writeJsonEvidence(evidenceDir, "baseline_pgrep.json", baseline);

    const socketPath = runnerOwnedSocketPath();
    spawned = await spawnHelper(socketPath, ["--simulate"]);
    rpc = await RpcClient.connect(socketPath, 5_000);
    await rpc.waitNotification("engine.ready", 10_000);

    const reqResp = await rpc.call(
      "capture.requestSession",
      { mode: "monitor", cursor_mode: "embedded", persist: "transient" },
      5_000,
    );
    writeJsonEvidence(evidenceDir, "requestSession-response.json", reqResp);

    const startResp = await rpc.call("capture.startStream", {}, 5_000);
    writeJsonEvidence(evidenceDir, "startStream-response.json", startResp);

    const sessionReadyNotif = await rpc.waitNotification("capture.sessionReady", 10_000);
    writeJsonEvidence(evidenceDir, "sessionReady-notification.json", sessionReadyNotif);

    const preCheck = pgrepCheck(baseline);
    writeJsonEvidence(evidenceDir, "pre_pgrep.json", preCheck);
    writeEvidence(
      evidenceDir,
      "pre_pgrep.txt",
      `baseline (excluded): engine=${baseline.coveReplayEngine.join(",") || "none"} ffmpeg=${baseline.ffmpeg.join(",") || "none"} pactl=${baseline.pactl.join(",") || "none"}\n` +
        `cove-replay-engine: ${preCheck.coveReplayEngine.join(",") || "none"}\n` +
        `ffmpeg: ${preCheck.ffmpeg.join(",") || "none"}\n` +
        `pactl: ${preCheck.pactl.join(",") || "none"}\n`,
    );

    rpc.close();
    rpc = null;
    sigtermSpawned(spawned);

    let helperExited = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (spawned.exited) {
        helperExited = true;
        break;
      }
    }

    writeEvidence(
      evidenceDir,
      "sigterm-exit.txt",
      `helperExited: ${helperExited}\n`,
    );

    if (!helperExited) {
      return makeReport(row, "error", {
        message: "Helper did not exit within 5s after SIGTERM — cannot check process cleanup",
        durationMs: Date.now() - start,
      });
    }

    const cleanupDelayS = THRESHOLDS.processCleanupAfterShutdownS;
    await new Promise((r) => setTimeout(r, cleanupDelayS * 1_000));

    const postCheck = pgrepCheck(baseline);
    writeJsonEvidence(evidenceDir, "post_pgrep.json", postCheck);
    writeEvidence(
      evidenceDir,
      "post_pgrep.txt",
      `baseline (excluded): engine=${baseline.coveReplayEngine.join(",") || "none"} ffmpeg=${baseline.ffmpeg.join(",") || "none"} pactl=${baseline.pactl.join(",") || "none"}\n` +
        `cove-replay-engine: ${postCheck.coveReplayEngine.join(",") || "none"}\n` +
        `ffmpeg: ${postCheck.ffmpeg.join(",") || "none"}\n` +
        `pactl: ${postCheck.pactl.join(",") || "none"}\n`,
    );

    const thresholds: ThresholdResult[] = [];

    const noEngine = postCheck.coveReplayEngine.length === 0;
    thresholds.push({
      name: "no cove-replay-engine after SIGTERM (no stopSession)",
      observed: postCheck.coveReplayEngine.length,
      required: "0",
      passed: noEngine,
    });

    const noFfmpeg = postCheck.ffmpeg.length === 0;
    thresholds.push({
      name: "no ffmpeg after SIGTERM (no stopSession)",
      observed: postCheck.ffmpeg.length,
      required: "0",
      passed: noFfmpeg,
    });

    const noPactl = postCheck.pactl.length === 0;
    thresholds.push({
      name: "no pactl after SIGTERM (no stopSession)",
      observed: postCheck.pactl.length,
      required: "0",
      passed: noPactl,
    });

    const allPassed = thresholds.every((t) => t.passed);
    return makeReport(row, allPassed ? "pass" : "fail", {
      durationMs: Date.now() - start,
      thresholds,
      evidencePaths: {
        "pre_pgrep": evidenceDir + "/pre_pgrep.txt",
        "post_pgrep": evidenceDir + "/post_pgrep.txt",
        "sigterm-exit": evidenceDir + "/sigterm-exit.txt",
      },
      message: allPassed
        ? `All processes cleaned up within ${cleanupDelayS}s after SIGTERM (no explicit stopSession)`
        : "Leftover processes detected after SIGTERM",
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `Process cleanup (PROC-003) test error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  } finally {
    if (rpc) {
      rpc.close();
    }
    if (spawned && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

interface DiagSample {
  t: number;
  droppedSinceLast: number;
  totalProduced: number;
  observedFps: number;
}

/**
 * T-021 VAL-CAP-004 startup drop warmup: per-row, opt-in exclusion of the
 * first N diagnostics samples from the drop-rate calculation only.
 *
 * - `warmupSamples = 0`: behaviour is bit-identical to the prior calculation
 *   — sum droppedSinceLast across all samples; denominator is the last
 *   sample's totalProduced; dropRate is 0 when the denominator is 0.
 * - `warmupSamples > 0`: exclude the first `warmupSamples` samples; the
 *   denominator becomes the post-warmup produced delta
 *   (`lastEffective.totalProduced - lastWarmup.totalProduced`).
 *
 * `valid = false` is returned only when warmup > 0 leaves no effective
 * samples or the produced delta is non-positive — the caller must fail
 * closed in that case.
 *
 * This function does not consult cadence, observedFps, or thresholds; it
 * is the single source of truth for drop-rate arithmetic with warmup.
 */
export interface DropRateWithWarmup {
  warmupSamples: number;
  totalSamples: number;
  effectiveSamples: number;
  totalDropped: number;
  dropWarmupExcludedDropped: number;
  dropWarmupProduced: number;
  dropEffectiveProduced: number;
  dropRate: number;
  valid: boolean;
}

export function computeDropRateWithWarmup(
  samples: ReadonlyArray<DiagSample>,
  warmupSamples: number,
): DropRateWithWarmup {
  const warmup = Math.max(0, Math.floor(warmupSamples));
  const totalSamples = samples.length;
  const warmupSlice = samples.slice(0, Math.min(warmup, totalSamples));
  const effective = samples.slice(Math.min(warmup, totalSamples));

  const dropWarmupExcludedDropped = warmupSlice.reduce(
    (s, x) => s + x.droppedSinceLast,
    0,
  );
  const totalDroppedAll = samples.reduce(
    (s, x) => s + x.droppedSinceLast,
    0,
  );
  const totalDropped = effective.reduce(
    (s, x) => s + x.droppedSinceLast,
    0,
  );

  // Preserve current behaviour bit-identically when warmup === 0.
  if (warmup === 0) {
    const lastSample = samples[samples.length - 1];
    const denom = lastSample?.totalProduced ?? 0;
    return {
      warmupSamples: 0,
      totalSamples,
      effectiveSamples: totalSamples,
      totalDropped: totalDroppedAll,
      dropWarmupExcludedDropped: 0,
      dropWarmupProduced: 0,
      dropEffectiveProduced: denom,
      dropRate: denom > 0 ? totalDroppedAll / denom : 0,
      valid: true,
    };
  }

  if (effective.length === 0) {
    return {
      warmupSamples: warmup,
      totalSamples,
      effectiveSamples: 0,
      totalDropped: 0,
      dropWarmupExcludedDropped,
      dropWarmupProduced:
        warmupSlice[warmupSlice.length - 1]?.totalProduced ?? 0,
      dropEffectiveProduced: 0,
      dropRate: 0,
      valid: false,
    };
  }

  const lastWarmupProduced =
    warmupSlice[warmupSlice.length - 1]?.totalProduced ?? 0;
  const lastEffectiveProduced =
    effective[effective.length - 1]?.totalProduced ?? 0;
  const dropEffectiveProduced = lastEffectiveProduced - lastWarmupProduced;

  if (dropEffectiveProduced <= 0) {
    return {
      warmupSamples: warmup,
      totalSamples,
      effectiveSamples: effective.length,
      totalDropped,
      dropWarmupExcludedDropped,
      dropWarmupProduced: lastWarmupProduced,
      dropEffectiveProduced,
      dropRate: 0,
      valid: false,
    };
  }

  return {
    warmupSamples: warmup,
    totalSamples,
    effectiveSamples: effective.length,
    totalDropped,
    dropWarmupExcludedDropped,
    dropWarmupProduced: lastWarmupProduced,
    dropEffectiveProduced,
    dropRate: totalDropped / dropEffectiveProduced,
    valid: true,
  };
}

function deriveThresholdKey(
  negotiatedFormat:
    | { width: number; height: number; fps_num: number; fps_den: number }
    | undefined,
  fallbackEncoderBackend: string,
  // ISS-003 D3: when the row declares an expected capture cell, threshold-key
  // resolution prefers the declared height so the drop tier reflects row
  // intent (e.g. 1080p60-nvenc) rather than whatever the host happened to
  // deliver. The negotiated format is still recorded as evidence by the
  // caller; this only changes which height drives the tier lookup. When no
  // declared format is supplied the function preserves the previous
  // negotiated-format behaviour (height fallback chain unchanged).
  declaredFormat?: { width: number; height: number },
  // ISS-003 D3: when the row declares an expected encoder backend, the suffix
  // is taken from the declared value (no fallback heuristics). Otherwise the
  // existing string-matching fallback runs against the caller-supplied
  // backend hint, preserving prior behaviour for non-D3 callers.
  declaredEncoderBackend?: string,
): string {
  const height = declaredFormat?.height ?? negotiatedFormat?.height ?? 1080;
  let resPrefix: string;
  if (height >= 2160) {
    resPrefix = "4k60";
  } else if (height >= 1440) {
    resPrefix = "1440p60";
  } else {
    resPrefix = "1080p60";
  }

  let encSuffix: string;
  if (declaredEncoderBackend && declaredEncoderBackend.length > 0) {
    encSuffix = declaredEncoderBackend.toLowerCase();
  } else {
    const be = fallbackEncoderBackend.toLowerCase();
    if (be.includes("nvenc") || be.includes("nvidia")) {
      encSuffix = "nvenc";
    } else if (be.includes("vaapi")) {
      encSuffix = "vaapi";
    } else if (
      be.includes("qsv") ||
      be.includes("quicksync") ||
      be.includes("intel")
    ) {
      encSuffix = "qsv";
    } else if (be === "nvenc") {
      encSuffix = "nvenc";
    } else {
      encSuffix = "libx264";
    }
  }

  return `${resPrefix}-${encSuffix}`;
}

export async function driveValCap004(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();
  let load: LaunchedLoad | null = null;
  let spawned: SpawnedHelper | null = null;
  let rpc: RpcClient | null = null;
  let modesetResult: ModesetResult | null = null;

  try {
    // --- Stage 1: Environment probe ----------------------------------------
    const probe = probeEnvironment();
    writeJsonEvidence(evidenceDir, "env-probe.json", probe);

    if (!hasDisplayServer(probe)) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No display server (DISPLAY / WAYLAND_DISPLAY absent) — cannot open portal capture",
      });
    }

    if (!probe.xdgRuntimeDir) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "XDG_RUNTIME_DIR not set — xdg-desktop-portal unlikely to be accessible",
      });
    }

    if (!probe.portalRunning) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "xdg-desktop-portal not running — portal monitor capture not available",
      });
    }

    // --- Stage 2: L-MOTION-60 load ------------------------------------------
    let loadErr: unknown = null;
    try {
      load = await launchMotion60();
    } catch (err) {
      loadErr = err;
    }

    if (loadErr !== null) {
      if (loadErr instanceof LoadScriptMissingError) {
        return makeReport(row, "error", {
          message: `L-MOTION-60 load script missing: ${String(loadErr)}`,
          durationMs: Date.now() - start,
        });
      }
      throw loadErr;
    }

    if (load === null) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No Chromium-based browser found — cannot launch L-MOTION-60 load",
      });
    }

    writeJsonEvidence(evidenceDir, "load-launch.json", {
      name: load.name,
      pid: load.pid,
      argv: load.argv,
    });

    // Give the browser a moment to open before requesting capture
    await new Promise((r) => setTimeout(r, 3_000));

    if (load.exited) {
      return makeReport(row, "fail", {
        message:
          "L-MOTION-60 load process exited during startup — Wayland/X11 launch likely failed",
        durationMs: Date.now() - start,
      });
    }

    // --- Stage 2b: Display mode enforcement (ISS-021) -----------------------
    // KDE Plasma reverts kscreen-doctor mode changes when PipeWire screencast
    // sessions trigger compositor recomposition. Enforce the mode as late as
    // possible — right before spawning the helper — to minimise the revert
    // window. The modeset retries up to 3 times with verification.
    if (row.expectedCaptureFormat) {
      modesetResult = enforceDisplayMode(
        row.expectedCaptureFormat,
        row.nominalFps ?? 60,
      );
      writeJsonEvidence(evidenceDir, "display-modeset.json", modesetResult);

      if (!modesetResult.success) {
        return makeReport(row, "fail", {
          message: `ISS-021: display mode enforcement failed — target ${row.expectedCaptureFormat.width}x${row.expectedCaptureFormat.height}, got ${modesetResult.appliedMode ? `${modesetResult.appliedMode.width}x${modesetResult.appliedMode.height}` : "(unknown)"} after ${modesetResult.attempts} attempts`,
          durationMs: Date.now() - start,
          evidencePaths: {
            "env-probe": evidenceDir + "/env-probe.json",
            "display-modeset": evidenceDir + "/display-modeset.json",
          },
        });
      }
    }

    // --- Stage 3: Spawn helper and connect ----------------------------------
    const socketPath = runnerOwnedSocketPath();
    writeEvidence(evidenceDir, "helper-socket.txt", socketPath + "\n");
    spawned = await spawnHelper(socketPath, ["--log-dir", evidenceDir]);
    rpc = await RpcClient.connect(socketPath, 5_000);

    const readyNotif = await rpc.waitNotification("engine.ready", 10_000);
    writeJsonEvidence(evidenceDir, "engine-ready.json", readyNotif);

    // --- Stage 4: Capture session ------------------------------------------
    // requestSession runs the full XDG Screencast portal negotiation including
    // the user-facing picker UI; the response arrives only after the user
    // approves.  Budget 60 s for human interaction.  A timeout here means the
    // portal D-Bus path is inaccessible (background/non-interactive session).
    let reqResp;
    try {
      reqResp = await rpc.call(
        "capture.requestSession",
        { mode: "monitor", cursor_mode: "embedded", persist: "transient" },
        60_000,
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("timeout")) {
        return makeReport(row, "skip", {
          skipReason: "helper-not-available",
          message:
            "capture.requestSession timed out — portal D-Bus path inaccessible; run in an interactive user session",
        });
      }
      throw err;
    }
    writeJsonEvidence(evidenceDir, "requestSession-response.json", reqResp);
    if (reqResp.error) {
      return makeReport(row, "fail", {
        message: `capture.requestSession error: ${JSON.stringify(reqResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    // ISS-021: re-enforce display mode after portal picker completes.
    // The portal D-Bus round-trip can trigger KDE compositor recomposition
    // which reverts kscreen-doctor mode changes.
    if (row.expectedCaptureFormat && modesetResult?.success) {
      const recheck = enforceDisplayMode(
        row.expectedCaptureFormat,
        row.nominalFps ?? 60,
      );
      writeJsonEvidence(evidenceDir, "display-modeset-pre-stream.json", recheck);
      if (!recheck.success) {
        return makeReport(row, "fail", {
          message: `ISS-021: display mode reverted after portal picker — target ${row.expectedCaptureFormat.width}x${row.expectedCaptureFormat.height}, got ${recheck.appliedMode ? `${recheck.appliedMode.width}x${recheck.appliedMode.height}` : "(unknown)"}`,
          durationMs: Date.now() - start,
          evidencePaths: {
            "display-modeset": evidenceDir + "/display-modeset.json",
            "display-modeset-pre-stream":
              evidenceDir + "/display-modeset-pre-stream.json",
          },
        });
      }
    }

    const startResp = await rpc.call("capture.startStream", {}, 10_000);
    writeJsonEvidence(evidenceDir, "startStream-response.json", startResp);
    if (startResp.error) {
      return makeReport(row, "fail", {
        message: `capture.startStream error: ${JSON.stringify(startResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    // sessionReady fires after portal approval + PipeWire stream ready
    const sessionReadyNotif = await rpc.waitNotification(
      "capture.sessionReady",
      30_000,
    );
    writeJsonEvidence(
      evidenceDir,
      "sessionReady-notification.json",
      sessionReadyNotif,
    );

    const srParams = sessionReadyNotif.params as
      | Record<string, unknown>
      | undefined;
    const captureFormat = srParams?.format as
      | { width: number; height: number; fps_num: number; fps_den: number }
      | undefined;

    // ISS-001: resolve the cadence nominal target. PipeWire variable-rate
    // capture reports fps_num=0; using fps_num/fps_den as nominal in that
    // case produces a bogus 0fps target that no real capture can satisfy.
    // Resolution order:
    //   1. negotiated fps (fps_num>0 && fps_den>0) → source="negotiated"
    //   2. row-declared workload nominal (row.nominalFps>0) → source="row-config"
    //   3. neither available → source="missing"; cadence gate MUST fail honestly.
    // The cadence gate never silently passes when nominal is missing; the
    // tolerance constants are not loosened; the underlying ISS-003 workload
    // mismatch remains visible because captureFormat and observed cadence
    // are both still recorded in evidence.
    let nominalFps: number | null = null;
    let nominalSource: CadenceNominalSource = "missing";
    if (
      captureFormat &&
      captureFormat.fps_num > 0 &&
      captureFormat.fps_den > 0
    ) {
      nominalFps = captureFormat.fps_num / captureFormat.fps_den;
      nominalSource = "negotiated";
    } else if (typeof row.nominalFps === "number" && row.nominalFps > 0) {
      nominalFps = row.nominalFps;
      nominalSource = "row-config";
    }
    // ISS-001: explicit — only true when captureFormat was present but fps_num===0.
    // Undefined captureFormat (no sessionReady yet) is NOT treated as variable-rate.
    const isVariableRate = captureFormat !== undefined && captureFormat.fps_num === 0;
    const cadencePolicy: "variable-rate" | "strict" =
      isVariableRate && nominalSource === "row-config" ? "variable-rate" : "strict";

    // --- Stage 5: Drain encoder notifications buffered from startStream ----
    let encoderBackend = ""; // populated from encoder.selected if emitted
    const probeNotif = await rpc
      .waitNotification("encoder.probeResult", 2_000)
      .catch(() => null);
    if (probeNotif) {
      writeJsonEvidence(evidenceDir, "encoder-probe-result.json", probeNotif);
    }
    const selectedNotif = await rpc
      .waitNotification("encoder.selected", 2_000)
      .catch(() => null);
    if (selectedNotif) {
      writeJsonEvidence(evidenceDir, "encoder-selected.json", selectedNotif);
      const selParams = selectedNotif.params as
        | Record<string, unknown>
        | undefined;
      const backend = String(selParams?.backend ?? "");
      if (backend) encoderBackend = backend;
    }

    // --- Stage 6: 60 s diagnostics observation window ----------------------
    // ISS-003 D3: resolve declared cell + encoder backend from the row so the
    // threshold tier reflects row intent rather than whatever the host
    // happened to deliver. The negotiated capture format is still recorded
    // verbatim in thresholds.json so the underlying mismatch (when present)
    // remains visible as evidence — never overwritten or papered over.
    const declaredCaptureFormat = row.expectedCaptureFormat;
    const expectedEncoderBackend = row.expectedEncoderBackend ?? "nvenc";
    const cellsMatch =
      declaredCaptureFormat !== undefined &&
      captureFormat !== undefined &&
      captureFormat.width === declaredCaptureFormat.width &&
      captureFormat.height === declaredCaptureFormat.height;
    const cellMismatch =
      declaredCaptureFormat !== undefined && !cellsMatch;

    // VAL-CAP-004 is the NVENC row; the threshold key drives drop-rate tier.
    // Under ISS-003 D3 the key is keyed off the declared cell when present,
    // so a host that delivers 4K against a 1080p declaration still uses the
    // 1080p60-nvenc strictest tier (not the looser 4k60-nvenc tier).
    const thresholdKey = deriveThresholdKey(
      captureFormat,
      expectedEncoderBackend,
      declaredCaptureFormat,
      expectedEncoderBackend,
    );
    const maxDropRate =
      (THRESHOLDS.captureDropRate as Record<string, number>)[thresholdKey] ??
      0;
    writeJsonEvidence(evidenceDir, "thresholds.json", {
      key: thresholdKey,
      maxDropRate,
      cadenceMeanToleranceFrac: THRESHOLDS.cadenceMeanToleranceFrac,
      // ISS-003 D3: declared vs negotiated capture cell are both recorded
      // additively. `captureFormat` is the existing negotiated payload from
      // sessionReady (preserved verbatim — same key, same shape). The new
      // `declaredCaptureFormat`, `negotiatedCaptureFormat`, and `cellMismatch`
      // fields make the row's intent and any host gap readable without
      // cross-referencing rows.ts.
      captureFormat: captureFormat ?? null,
      declaredCaptureFormat: declaredCaptureFormat ?? null,
      negotiatedCaptureFormat: captureFormat ?? null,
      cellMismatch,
      expectedEncoderBackend,
      encoderObserved: encoderBackend || "(not received)",
      // ISS-001: surface the cadence nominal source and policy so the evidence
      // bundle makes the variable-rate (fps_num=0) case readable without
      // re-reading captureFormat. nominalFps is null when neither the
      // negotiated format nor the row config provides a target; in that case
      // the cadence gate is recorded as a failure — never a silent pass.
      nominalFps,
      nominalSource,
      cadencePolicy,
      ...(cadencePolicy === "variable-rate"
        ? { variableRateCadenceConstants: VARIABLE_RATE_CADENCE }
        : {}),
    });

    // ISS-003 D3: optional skip path. When the row opts in via
    // `onCellMismatch: "skip"` AND the host did not deliver the declared
    // cell, the row is recorded as an explicit skip whose message contains
    // the literal token `host-does-not-deliver-declared-cell` so the matrix
    // gate (N-008 §18) can route per-host coverage. Default policy ("fail"
    // or missing) skips this branch and continues; the cell-mismatch
    // ThresholdResult below then keeps the row at fail through the
    // threshold array — never a silent pass.
    if (cellMismatch && row.onCellMismatch === "skip") {
      const declaredStr = `${declaredCaptureFormat!.width}x${declaredCaptureFormat!.height}`;
      const negotiatedStr = captureFormat
        ? `${captureFormat.width}x${captureFormat.height}`
        : "(no sessionReady format)";

      // ISS-003 D3: the skip path must mirror the normal happy-path
      // shutdown — capture.stopSession + engine.shutdown — so the helper
      // tears down the PipeWire stream gracefully and emits its shutdown
      // evidence. Without this, cleanup would fall to the finally-block
      // SIGTERM, leaving resource-lifecycle behavior inconsistent with the
      // fail path. Cleanup errors are recorded as evidence but never
      // upgrade the skip into a fail — host-cell-mismatch remains the
      // operative reason.
      try {
        const stopResp = await rpc.call("capture.stopSession", {}, 10_000);
        writeJsonEvidence(evidenceDir, "stopSession-response.json", stopResp);
      } catch (err) {
        writeEvidence(
          evidenceDir,
          "stopSession-error.txt",
          String(err) + "\n",
        );
      }
      try {
        const shutdownResp = await shutdownHelper(rpc);
        writeJsonEvidence(evidenceDir, "shutdown-response.json", shutdownResp);
      } catch (err) {
        writeEvidence(
          evidenceDir,
          "shutdown-error.txt",
          String(err) + "\n",
        );
      }
      rpc.close();
      rpc = null;

      return makeReport(row, "skip", {
        skipReason: "host-cell-mismatch",
        message: `host-does-not-deliver-declared-cell: declared ${declaredStr}, negotiated ${negotiatedStr}`,
        durationMs: Date.now() - start,
        evidencePaths: {
          "env-probe": evidenceDir + "/env-probe.json",
          "sessionReady-notification":
            evidenceDir + "/sessionReady-notification.json",
          thresholds: evidenceDir + "/thresholds.json",
        },
      });
    }

    const samples: DiagSample[] = [];
    let sessionLostNotif: RpcNotification | null = null;
    const OBSERVATION_MS = 60_000;
    const observationEnd = Date.now() + OBSERVATION_MS;

    // Drain any buffered sessionLost before starting the loop
    const preLost = await rpc
      .waitNotification("capture.sessionLost", 50)
      .catch(() => null);
    if (preLost) {
      sessionLostNotif = preLost;
      writeJsonEvidence(evidenceDir, "session-lost.json", preLost);
    }

    while (Date.now() < observationEnd && !sessionLostNotif) {
      const remaining = observationEnd - Date.now();
      if (remaining <= 0) break;

      try {
        const diag = await rpc.waitNotification(
          "capture.diagnostics",
          Math.min(1_200, remaining),
        );
        const diagParams = diag.params as Record<string, unknown> | undefined;
        const bufs = diagParams?.buffers as Record<string, unknown> | undefined;
        const cadence = diagParams?.cadence as
          | Record<string, unknown>
          | undefined;
        samples.push({
          t: Date.now(),
          droppedSinceLast: Number(bufs?.dropped_since_last ?? 0),
          totalProduced: Number(bufs?.total_produced ?? 0),
          observedFps: Number(cadence?.observed_fps ?? 0),
        });
      } catch {
        // no diagnostics in this window; fall through to sessionLost check
      }

      const lost = await rpc
        .waitNotification("capture.sessionLost", 50)
        .catch(() => null);
      if (lost) {
        sessionLostNotif = lost;
        writeJsonEvidence(evidenceDir, "session-lost.json", lost);
      }
    }

    writeJsonEvidence(evidenceDir, "capture-diagnostics.json", samples);

    if (sessionLostNotif) {
      return makeReport(row, "fail", {
        message:
          "capture.sessionLost during observation window — session dropped unexpectedly",
        durationMs: Date.now() - start,
        evidencePaths: {
          "env-probe": evidenceDir + "/env-probe.json",
          "capture-diagnostics": evidenceDir + "/capture-diagnostics.json",
          "session-lost": evidenceDir + "/session-lost.json",
        },
      });
    }

    // --- Stage 7: Stop session and shutdown --------------------------------
    try {
      const stopResp = await rpc.call("capture.stopSession", {}, 10_000);
      writeJsonEvidence(evidenceDir, "stopSession-response.json", stopResp);
    } catch (err) {
      writeEvidence(evidenceDir, "stopSession-error.txt", String(err) + "\n");
    }

    const shutdownResp = await shutdownHelper(rpc);
    writeJsonEvidence(evidenceDir, "shutdown-response.json", shutdownResp);
    rpc.close();
    rpc = null;

    // --- Stage 8: Threshold evaluation -------------------------------------
    const thresholds: ThresholdResult[] = [];

    // ISS-003 D3: declared-cell gate runs before drop/cadence/backend gates
    // so the report leads with the workload-mismatch evidence when present.
    // Default policy ("fail" / missing) keeps the row at fail through this
    // ThresholdResult; the "skip" branch above has already short-circuited
    // when configured. Rows that do not declare an expectedCaptureFormat
    // skip this gate entirely — additive behaviour, no impact on other rows.
    if (declaredCaptureFormat !== undefined) {
      const declaredStr = `${declaredCaptureFormat.width}x${declaredCaptureFormat.height}`;
      const negotiatedStr = captureFormat
        ? `${captureFormat.width}x${captureFormat.height}`
        : "(no sessionReady format)";
      thresholds.push({
        name: `capture cell matches declared (${declaredStr})`,
        observed: negotiatedStr,
        required: declaredStr,
        passed: cellsMatch,
      });
    }

    // T-021: opt-in per-row startup drop warmup. Default (undefined / 0)
    // preserves the prior calculation bit-identically. Cadence (below) is
    // intentionally unchanged in this pass — it continues to consume the
    // unfiltered `samples` array.
    const dropWarmupSamplesCfg = row.dropWarmupSamples ?? 0;
    const dropCalc = computeDropRateWithWarmup(samples, dropWarmupSamplesCfg);
    const dropRate = dropCalc.dropRate;
    const dropPassed = dropCalc.valid && dropRate <= maxDropRate;

    thresholds.push({
      name: `drop rate <= ${maxDropRate} (${thresholdKey})`,
      observed: dropCalc.valid
        ? `${dropRate.toFixed(6)} (warmup=${dropCalc.warmupSamples}, effectiveSamples=${dropCalc.effectiveSamples}, excludedDropped=${dropCalc.dropWarmupExcludedDropped}, dropEffectiveProduced=${dropCalc.dropEffectiveProduced})`
        : `invalid (warmup=${dropCalc.warmupSamples}, effectiveSamples=${dropCalc.effectiveSamples}, dropEffectiveProduced=${dropCalc.dropEffectiveProduced})`,
      required: `<= ${maxDropRate}`,
      passed: dropPassed,
    });

    // T-021: honest evidence sidecar — record the warmup exclusion exactly,
    // even when warmup=0 (no exclusion). Drivers/CI gates and human readers
    // can verify whether startup samples were excluded without re-deriving.
    writeJsonEvidence(evidenceDir, "drop-warmup.json", {
      rowDropWarmupSamples: dropWarmupSamplesCfg,
      warmupSamples: dropCalc.warmupSamples,
      totalSamples: dropCalc.totalSamples,
      effectiveSamples: dropCalc.effectiveSamples,
      totalDropped: dropCalc.totalDropped,
      dropWarmupExcludedDropped: dropCalc.dropWarmupExcludedDropped,
      dropWarmupProduced: dropCalc.dropWarmupProduced,
      dropEffectiveProduced: dropCalc.dropEffectiveProduced,
      dropRate: dropCalc.dropRate,
      valid: dropCalc.valid,
      thresholdKey,
      maxDropRate,
      passed: dropPassed,
    });

    const cadenceStats = buildCadenceFpsStats(samples, dropWarmupSamplesCfg);
    const { meanFps, spreadFps } = cadenceStats;
    const cadenceResults = evaluateCadenceThresholds({
      meanFps,
      spreadFps,
      sampleCount: cadenceStats.sampleCount,
      nominalFps,
      nominalSource,
      isVariableRate,
    });
    thresholds.push(...cadenceResults);

    thresholds.push({
      name: "at least 1 diagnostics sample received",
      observed: String(samples.length),
      required: ">= 1",
      passed: samples.length >= 1,
    });

    // ISS-003 D3: encoder backend gate uses the row's declared
    // expectedEncoderBackend (default "nvenc" preserved when the row does not
    // declare one). The gate is still strict equality against the real
    // `encoder.selected` event — this code does NOT synthesise the event or
    // imply backend availability; ISS-002 still gates whether the helper
    // actually emits a backend selection (T-017a).
    const encoderObserved = encoderBackend || "(not received)";
    thresholds.push({
      name: `encoder.selected backend is ${expectedEncoderBackend}`,
      observed: encoderObserved,
      required: expectedEncoderBackend,
      passed: encoderBackend === expectedEncoderBackend,
    });

    const durationMs = Date.now() - start;
    const allPassed = thresholds.every((t) => t.gating === false || t.passed);

    return makeReport(row, allPassed ? "pass" : "fail", {
      durationMs,
      thresholds,
      evidencePaths: {
        "env-probe": evidenceDir + "/env-probe.json",
        "capture-diagnostics": evidenceDir + "/capture-diagnostics.json",
        thresholds: evidenceDir + "/thresholds.json",
      },
      message: allPassed
        ? `Monitor capture passed drop+cadence gates (${samples.length} samples, key=${thresholdKey})`
        : `Capture quality gates failed — see thresholds (key=${thresholdKey}, samples=${samples.length})`,
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `VAL-CAP-004 error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  } finally {
    if (rpc) rpc.close();
    if (spawned && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (load) {
      await load.teardown().catch(() => {});
    }
    if (modesetResult?.priorMode && modesetResult.attempts > 0) {
      restoreDisplayMode(modesetResult.priorMode, modesetResult.output);
    }
  }
}

// Returns true only when every backend is the known T-017 "not-implemented-yet"
// stub. Missing/malformed payloads and real all-backend failures both return
// false so the row proceeds and its thresholds catch the problem.
function isEncoderStubState(
  backends:
    | Array<{ backend: string; available: boolean; details?: unknown }>
    | undefined,
): boolean {
  if (!Array.isArray(backends) || backends.length === 0) return false;
  return backends.every((b) => {
    if (b.available !== false) return false;
    const det = b.details as Record<string, unknown> | undefined;
    return det?.reason === "not-implemented-yet";
  });
}

export async function driveValEnc001(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();
  let spawned: SpawnedHelper | null = null;
  let load: LaunchedLoad | null = null;
  let rpc: RpcClient | null = null;

  try {
    const probe = probeEnvironment();
    writeJsonEvidence(evidenceDir, "env-probe.json", probe);

    if (probe.gpuInfo == null || !probe.gpuInfo.startsWith("nvidia:")) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "no NVENC available — no NVIDIA GPU detected (nvidia-smi absent or failed)",
      });
    }

    if (!hasDisplayServer(probe)) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No DISPLAY or WAYLAND_DISPLAY — cannot open portal for requestSession",
      });
    }

    if (!probe.xdgRuntimeDir) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message: "XDG_RUNTIME_DIR not set — xdg-desktop-portal unreachable",
      });
    }

    if (!probe.portalRunning) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "xdg-desktop-portal not running — cannot negotiate screencast session",
      });
    }

    try {
      load = await launchMotion60();
    } catch (loadErr) {
      if (loadErr instanceof LoadScriptMissingError) {
        return makeReport(row, "error", {
          message: String(loadErr),
          durationMs: Date.now() - start,
        });
      }
      throw loadErr;
    }

    if (load === null) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No Chromium-based browser available — cannot launch L-MOTION-60",
      });
    }

    await new Promise((r) => setTimeout(r, 1_000));

    if (load.exited) {
      return makeReport(row, "fail", {
        message:
          "L-MOTION-60 load process exited during startup — Wayland/X11 launch likely failed",
        durationMs: Date.now() - start,
      });
    }

    const socketPath = runnerOwnedSocketPath();
    writeEvidence(evidenceDir, "helper-socket.txt", socketPath + "\n");
    spawned = await spawnHelper(socketPath);
    rpc = await RpcClient.connect(socketPath, 5_000);
    const readyNotif = await rpc.waitNotification("engine.ready", 10_000);
    writeJsonEvidence(evidenceDir, "engine-ready.json", readyNotif);

    // requestSession runs the full XDG Screencast portal negotiation including
    // the user-facing picker UI; response arrives only after the user approves.
    // Budget 60 s for human interaction. A timeout means portal is inaccessible
    // (background/non-interactive session) — treat as prerequisite skip, not error.
    let reqResp;
    try {
      reqResp = await rpc.call(
        "capture.requestSession",
        { mode: "monitor", cursor_mode: "embedded", persist: "transient" },
        60_000,
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("timeout")) {
        return makeReport(row, "skip", {
          skipReason: "helper-not-available",
          message:
            "capture.requestSession timed out — portal D-Bus path inaccessible; run in an interactive user session",
        });
      }
      throw err;
    }
    writeJsonEvidence(evidenceDir, "requestSession-response.json", reqResp);

    if (reqResp.error) {
      return makeReport(row, "fail", {
        message: `capture.requestSession error: ${JSON.stringify(reqResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const startResp = await rpc.call("capture.startStream", undefined, 5_000);
    writeJsonEvidence(evidenceDir, "startStream-response.json", startResp);

    if (startResp.error) {
      return makeReport(row, "error", {
        message: `capture.startStream failed: ${JSON.stringify(startResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const sessionReadyNotif = await rpc.waitNotification(
      "capture.sessionReady",
      15_000,
    );
    writeJsonEvidence(
      evidenceDir,
      "sessionReady-notification.json",
      sessionReadyNotif,
    );

    // encoder.probeResult may already be buffered (emitted before sessionReady)
    let probeNotif: RpcNotification | null = null;
    try {
      probeNotif = await rpc.waitNotification("encoder.probeResult", 10_000);
      writeJsonEvidence(evidenceDir, "encoder-probe-result.json", probeNotif);
    } catch {
      // not received within window — will fail threshold
    }

    const probeParams = probeNotif?.params as
      | Record<string, unknown>
      | undefined;
    const backends = probeParams?.backends as
      | Array<{ backend: string; available: boolean; details?: unknown }>
      | undefined;

    // Guard: only skip when all backends carry the known T-017 stub reason.
    // Missing/malformed payloads and real all-backend failures proceed so
    // the row's thresholds surface the problem.
    if (probeNotif !== null && isEncoderStubState(backends)) {
        await rpc.call("capture.stopSession", undefined, 10_000).catch(() => {});
        return makeReport(row, "skip", {
          skipReason: "helper-not-available",
          message:
            "encoder implementation not ready — all backends returned unavailable (T-017 in progress)",
        });
    }

    let selectedNotif: RpcNotification | null = null;
    try {
      selectedNotif = await rpc.waitNotification("encoder.selected", 5_000);
      writeJsonEvidence(evidenceDir, "encoder-selected.json", selectedNotif);
    } catch {
      // optional — absent does not fail the row
    }

    const stopResp = await rpc.call("capture.stopSession", undefined, 10_000);
    writeJsonEvidence(evidenceDir, "stopSession-response.json", stopResp);

    const durationMs = Date.now() - start;
    const thresholds: ThresholdResult[] = [];
    const nvencEntry = backends?.find(
      (b) => b.backend === "nvenc" || b.backend === "nvenc-h264",
    );
    const nvencAvailable = nvencEntry?.available === true;

    thresholds.push({
      name: "encoder.probeResult received",
      observed: probeNotif ? "received" : "not received",
      required: "notification received",
      passed: probeNotif !== null,
    });

    thresholds.push({
      name: "nvenc backend available in probeResult",
      observed: nvencEntry
        ? `${nvencEntry.backend} available=${String(nvencEntry.available)}`
        : "nvenc not in backends",
      required: "nvenc available=true",
      passed: nvencAvailable,
    });

    if (selectedNotif) {
      const selParams = selectedNotif.params as
        | Record<string, unknown>
        | undefined;
      const backend = String(selParams?.backend ?? "");
      thresholds.push({
        name: "encoder.selected backend is nvenc",
        observed: backend || "(empty)",
        required: "nvenc",
        passed: backend === "nvenc",
      });
    }

    const allPassed = thresholds.every((t) => t.passed);
    return makeReport(row, allPassed ? "pass" : "fail", {
      durationMs,
      thresholds,
      evidencePaths: {
        "env-probe": evidenceDir + "/env-probe.json",
        "encoder-probe-result": evidenceDir + "/encoder-probe-result.json",
        ...(selectedNotif
          ? { "encoder-selected": evidenceDir + "/encoder-selected.json" }
          : {}),
      },
      message: allPassed
        ? "NVENC probe confirmed available via encoder.probeResult"
        : "NVENC probe failed or notification not received",
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `driveValEnc001 error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  } finally {
    if (rpc) rpc.close();
    if (spawned && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (load) await load.teardown().catch(() => {});
  }
}

export async function driveValSeg001(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();
  let spawned: SpawnedHelper | null = null;
  let load: LaunchedLoad | null = null;
  let rpc: RpcClient | null = null;

  try {
    const probe = probeEnvironment();
    writeJsonEvidence(evidenceDir, "env-probe.json", probe);

    if (!hasDisplayServer(probe)) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No DISPLAY or WAYLAND_DISPLAY — cannot open portal for requestSession",
      });
    }

    if (!probe.xdgRuntimeDir) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message: "XDG_RUNTIME_DIR not set — xdg-desktop-portal unreachable",
      });
    }

    if (!probe.portalRunning) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "xdg-desktop-portal not running — cannot negotiate screencast session",
      });
    }

    try {
      load = await launchMotion60();
    } catch (loadErr) {
      if (loadErr instanceof LoadScriptMissingError) {
        return makeReport(row, "error", {
          message: String(loadErr),
          durationMs: Date.now() - start,
        });
      }
      throw loadErr;
    }

    if (load === null) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No Chromium-based browser available — cannot launch L-MOTION-60",
      });
    }

    await new Promise((r) => setTimeout(r, 1_000));

    if (load.exited) {
      return makeReport(row, "fail", {
        message:
          "L-MOTION-60 load process exited during startup — Wayland/X11 launch likely failed",
        durationMs: Date.now() - start,
      });
    }

    const socketPath = runnerOwnedSocketPath();
    writeEvidence(evidenceDir, "helper-socket.txt", socketPath + "\n");
    spawned = await spawnHelper(socketPath);
    rpc = await RpcClient.connect(socketPath, 5_000);
    const readyNotif = await rpc.waitNotification("engine.ready", 10_000);
    writeJsonEvidence(evidenceDir, "engine-ready.json", readyNotif);

    let reqResp;
    try {
      reqResp = await rpc.call(
        "capture.requestSession",
        { mode: "monitor", cursor_mode: "embedded", persist: "transient" },
        60_000,
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("timeout")) {
        return makeReport(row, "skip", {
          skipReason: "helper-not-available",
          message:
            "capture.requestSession timed out — portal D-Bus path inaccessible; run in an interactive user session",
        });
      }
      throw err;
    }
    writeJsonEvidence(evidenceDir, "requestSession-response.json", reqResp);

    if (reqResp.error) {
      return makeReport(row, "fail", {
        message: `capture.requestSession error: ${JSON.stringify(reqResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const startResp = await rpc.call("capture.startStream", undefined, 5_000);
    writeJsonEvidence(evidenceDir, "startStream-response.json", startResp);

    if (startResp.error) {
      return makeReport(row, "error", {
        message: `capture.startStream failed: ${JSON.stringify(startResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const sessionReadyNotif = await rpc.waitNotification(
      "capture.sessionReady",
      15_000,
    );
    writeJsonEvidence(
      evidenceDir,
      "sessionReady-notification.json",
      sessionReadyNotif,
    );

    // Encoder readiness guard: probeResult should already be buffered.
    // If all backends are unavailable (stubs), the segment buffer was never
    // created — skip rather than fail so the smoke suite is not gated on T-017.
    {
      let encProbeNotif: RpcNotification | null = null;
      try {
        encProbeNotif = await rpc.waitNotification("encoder.probeResult", 3_000);
        writeJsonEvidence(evidenceDir, "encoder-probe-result.json", encProbeNotif);
      } catch {
        // not buffered — proceed
      }
      if (encProbeNotif !== null) {
        const encBackends = (
          encProbeNotif.params as Record<string, unknown> | undefined
        )?.backends as
          | Array<{ backend: string; available: boolean; details?: unknown }>
          | undefined;
        if (isEncoderStubState(encBackends)) {
          await rpc
            .call("capture.stopSession", undefined, 10_000)
            .catch(() => {});
          return makeReport(row, "skip", {
            skipReason: "helper-not-available",
            message:
              "encoder implementation not ready — all backends unavailable, segment buffer not created (T-017 in progress)",
          });
        }
      }
    }

    // Collect replay.segmentDiagnostics events for ≥65 s to cover the full
    // 60-second rolling window (row title: "Rolling 60 s window")
    const OBSERVE_WINDOW_MS = 65_000;
    const diagnosticSamples: unknown[] = [];
    const observeStart = Date.now();
    const observeDeadline = observeStart + OBSERVE_WINDOW_MS;

    while (Date.now() < observeDeadline) {
      const remaining = observeDeadline - Date.now();
      if (remaining <= 0) break;
      try {
        const notif = await rpc.waitNotification(
          "replay.segmentDiagnostics",
          Math.min(remaining, 2_000),
        );
        diagnosticSamples.push(notif.params);
      } catch {
        // gap in notifications — keep looping until the full window elapses
      }
    }
    const observedMs = Date.now() - observeStart;

    writeEvidence(
      evidenceDir,
      "segment-diagnostics.jsonl",
      diagnosticSamples.map((s) => JSON.stringify(s)).join("\n") + "\n",
    );

    const stopResp = await rpc.call("capture.stopSession", undefined, 10_000);
    writeJsonEvidence(evidenceDir, "stopSession-response.json", stopResp);

    const durationMs = Date.now() - start;
    const thresholds: ThresholdResult[] = [];

    thresholds.push({
      name: "replay.segmentDiagnostics samples collected",
      observed: diagnosticSamples.length,
      required: ">= 1",
      passed: diagnosticSamples.length >= 1,
    });

    type DiagSample = {
      bytes_on_disk?: number;
      buffer_bytes_pct_of_cap?: number;
    };

    let allWithinBudget = true;
    let maxPct = 0;
    let invalidMetricCount = 0;

    for (const sample of diagnosticSamples) {
      const s = sample as DiagSample;
      if (
        s.buffer_bytes_pct_of_cap == null ||
        !Number.isFinite(s.buffer_bytes_pct_of_cap)
      ) {
        invalidMetricCount++;
        continue;
      }
      const pct = s.buffer_bytes_pct_of_cap;
      if (pct > maxPct) maxPct = pct;
      if (pct > 100) allWithinBudget = false;
    }

    thresholds.push({
      name: "full 65-second observation window elapsed",
      observed: `${Math.round(observedMs / 1_000)} s`,
      required: ">= 65 s",
      passed: observedMs >= 65_000,
    });

    thresholds.push({
      name: "buffer_bytes_pct_of_cap never exceeds 100%",
      observed:
        invalidMetricCount > 0
          ? `${invalidMetricCount} samples missing/invalid metric`
          : `${maxPct.toFixed(2)}%`,
      required: "<= 100% (no invalid samples)",
      passed:
        invalidMetricCount === 0 &&
        (diagnosticSamples.length === 0 || allWithinBudget),
    });

    const allPassed = thresholds.every((t) => t.passed);
    return makeReport(row, allPassed ? "pass" : "fail", {
      durationMs,
      thresholds,
      evidencePaths: {
        "env-probe": evidenceDir + "/env-probe.json",
        "segment-diagnostics": evidenceDir + "/segment-diagnostics.jsonl",
      },
      message: allPassed
        ? `Segment buffer stayed within disk budget over ${diagnosticSamples.length} samples (max ${maxPct.toFixed(2)}%)`
        : `Segment buffer exceeded disk budget (max ${maxPct.toFixed(2)}%)`,
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `driveValSeg001 error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  } finally {
    if (rpc) rpc.close();
    if (spawned && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (load) {
      await load.teardown().catch(() => {});
    }
  }
}

export async function driveValSeg003(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();
  let spawned: SpawnedHelper | null = null;
  let load: LaunchedLoad | null = null;
  let rpc: RpcClient | null = null;
  let snapshotId: string | null = null;

  try {
    const probe = probeEnvironment();
    writeJsonEvidence(evidenceDir, "env-probe.json", probe);

    if (!hasDisplayServer(probe)) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No DISPLAY or WAYLAND_DISPLAY — cannot open portal for requestSession",
      });
    }

    if (!probe.xdgRuntimeDir) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message: "XDG_RUNTIME_DIR not set — xdg-desktop-portal unreachable",
      });
    }

    if (!probe.portalRunning) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "xdg-desktop-portal not running — cannot negotiate screencast session",
      });
    }

    try {
      load = await launchMotion60();
    } catch (loadErr) {
      if (loadErr instanceof LoadScriptMissingError) {
        return makeReport(row, "error", {
          message: String(loadErr),
          durationMs: Date.now() - start,
        });
      }
      throw loadErr;
    }

    if (load === null) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No Chromium-based browser available — cannot launch L-MOTION-60",
      });
    }

    await new Promise((r) => setTimeout(r, 1_000));

    if (load.exited) {
      return makeReport(row, "fail", {
        message:
          "L-MOTION-60 load process exited during startup — Wayland/X11 launch likely failed",
        durationMs: Date.now() - start,
      });
    }

    const socketPath = runnerOwnedSocketPath();
    writeEvidence(evidenceDir, "helper-socket.txt", socketPath + "\n");
    spawned = await spawnHelper(socketPath);
    rpc = await RpcClient.connect(socketPath, 5_000);
    const readyNotif = await rpc.waitNotification("engine.ready", 10_000);
    writeJsonEvidence(evidenceDir, "engine-ready.json", readyNotif);

    let reqResp;
    try {
      reqResp = await rpc.call(
        "capture.requestSession",
        { mode: "monitor", cursor_mode: "embedded", persist: "transient" },
        60_000,
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("timeout")) {
        return makeReport(row, "skip", {
          skipReason: "helper-not-available",
          message:
            "capture.requestSession timed out — portal D-Bus path inaccessible; run in an interactive user session",
        });
      }
      throw err;
    }
    writeJsonEvidence(evidenceDir, "requestSession-response.json", reqResp);

    if (reqResp.error) {
      return makeReport(row, "fail", {
        message: `capture.requestSession error: ${JSON.stringify(reqResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const startResp = await rpc.call("capture.startStream", undefined, 5_000);
    writeJsonEvidence(evidenceDir, "startStream-response.json", startResp);

    if (startResp.error) {
      return makeReport(row, "error", {
        message: `capture.startStream failed: ${JSON.stringify(startResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const sessionReadyNotif = await rpc.waitNotification(
      "capture.sessionReady",
      15_000,
    );
    writeJsonEvidence(
      evidenceDir,
      "sessionReady-notification.json",
      sessionReadyNotif,
    );

    // Encoder readiness guard: probeResult should already be buffered.
    // If all backends are unavailable (stubs), replay.save returns "no active
    // capture session" because the segment buffer is never created. Skip rather
    // than fail so the smoke suite is not gated on T-017.
    {
      let encProbeNotif: RpcNotification | null = null;
      try {
        encProbeNotif = await rpc.waitNotification("encoder.probeResult", 3_000);
        writeJsonEvidence(evidenceDir, "encoder-probe-result.json", encProbeNotif);
      } catch {
        // not buffered — proceed
      }
      if (encProbeNotif !== null) {
        const encBackends = (
          encProbeNotif.params as Record<string, unknown> | undefined
        )?.backends as
          | Array<{ backend: string; available: boolean; details?: unknown }>
          | undefined;
        if (isEncoderStubState(encBackends)) {
          await rpc
            .call("capture.stopSession", undefined, 10_000)
            .catch(() => {});
          return makeReport(row, "skip", {
            skipReason: "helper-not-available",
            message:
              "encoder implementation not ready — all backends unavailable, segment buffer not created (T-017 in progress)",
          });
        }
      }
    }

    // Warm the rolling segment buffer for ~20 s before measuring save latency
    await new Promise((r) => setTimeout(r, 20_000));

    // Drain any segmentDiagnostics that arrived during the warm-up so the
    // post-save collection window only counts fresh notifications.
    while (true) {
      try {
        await rpc.waitNotification("replay.segmentDiagnostics", 100);
      } catch {
        break;
      }
    }

    // Measure replay.save latency using monotonic clock
    const t0 = process.hrtime.bigint();
    const saveResp = await rpc.call("replay.save", { duration_s: 30 }, 15_000);
    const t1 = process.hrtime.bigint();
    const latencyMs = Number(t1 - t0) / 1_000_000;

    writeJsonEvidence(evidenceDir, "save-response.json", saveResp);
    writeJsonEvidence(evidenceDir, "save-latency.json", {
      latencyMs,
      thresholdMs: THRESHOLDS.saveLatencyMaxMs,
    });

    // Drain any segmentDiagnostics buffered during the save call, then collect
    // for up to 3 s more.  At least one sample proves capture was not paused.
    const diagDuringSave: unknown[] = [];
    const diagDeadline = Date.now() + 3_000;
    while (Date.now() < diagDeadline) {
      const rem = diagDeadline - Date.now();
      if (rem <= 0) break;
      try {
        const s = await rpc.waitNotification(
          "replay.segmentDiagnostics",
          Math.min(rem, 1_500),
        );
        diagDuringSave.push(s.params);
      } catch {
        break;
      }
    }
    writeEvidence(
      evidenceDir,
      "diagnostics-during-save.jsonl",
      diagDuringSave.map((s) => JSON.stringify(s)).join("\n") + "\n",
    );

    let snapshotPinnedNotif: RpcNotification | null = null;
    try {
      snapshotPinnedNotif = await rpc.waitNotification(
        "replay.snapshotPinned",
        5_000,
      );
      writeJsonEvidence(
        evidenceDir,
        "snapshotPinned-notification.json",
        snapshotPinnedNotif,
      );
    } catch {
      // notification absent — threshold will capture the miss
    }

    // Resolve snapshot_id from result or pinned notification
    const saveResult = saveResp.result as Record<string, unknown> | undefined;
    snapshotId =
      typeof saveResult?.snapshot_id === "string"
        ? saveResult.snapshot_id
        : null;
    if (!snapshotId) {
      const pinnedParams = snapshotPinnedNotif?.params as
        | Record<string, unknown>
        | undefined;
      if (pinnedParams?.snapshot_id) {
        snapshotId = String(pinnedParams.snapshot_id);
      }
    }

    // Release the snapshot so no pinned entries leak
    if (snapshotId) {
      const releaseResp = await rpc.call(
        "replay.snapshot_release",
        { snapshot_id: snapshotId },
        5_000,
      );
      writeJsonEvidence(
        evidenceDir,
        "snapshot-release-response.json",
        releaseResp,
      );
      snapshotId = null;
    }

    // Verify active_snapshots drops to 0 after release
    const healthResp = await rpc.call("engine.health", undefined, 5_000);
    writeJsonEvidence(evidenceDir, "engine-health-post.json", healthResp);
    const healthResult = healthResp.result as Record<string, unknown> | undefined;
    const activeSnapshots = Number(healthResult?.active_snapshots ?? -1);

    const stopResp = await rpc.call("capture.stopSession", undefined, 10_000);
    writeJsonEvidence(evidenceDir, "stopSession-response.json", stopResp);

    const durationMs = Date.now() - start;
    const thresholds: ThresholdResult[] = [];

    thresholds.push({
      name: "replay.save completed without error",
      observed: saveResp.error ? JSON.stringify(saveResp.error) : "ok",
      required: "no error",
      passed: !saveResp.error,
    });

    thresholds.push({
      name: "replay.save latency within gate",
      observed: Math.round(latencyMs),
      required: `<= ${THRESHOLDS.saveLatencyMaxMs} ms`,
      passed: latencyMs <= THRESHOLDS.saveLatencyMaxMs,
    });

    thresholds.push({
      name: "replay.snapshotPinned notification received",
      observed: snapshotPinnedNotif ? "received" : "not received",
      required: "notification received",
      passed: snapshotPinnedNotif !== null,
    });

    thresholds.push({
      name: "capture diagnostics received during/after save (capture not paused)",
      observed: diagDuringSave.length,
      required: ">= 1",
      passed: diagDuringSave.length >= 1,
    });

    thresholds.push({
      name: "active_snapshots is 0 after release",
      observed: activeSnapshots,
      required: "0",
      passed: activeSnapshots === 0,
    });

    const allPassed = thresholds.every((t) => t.passed);
    return makeReport(row, allPassed ? "pass" : "fail", {
      durationMs,
      thresholds,
      evidencePaths: {
        "env-probe": evidenceDir + "/env-probe.json",
        "save-response": evidenceDir + "/save-response.json",
        "save-latency": evidenceDir + "/save-latency.json",
        "diagnostics-during-save":
          evidenceDir + "/diagnostics-during-save.jsonl",
        "engine-health-post": evidenceDir + "/engine-health-post.json",
      },
      message: allPassed
        ? `replay.save completed in ${Math.round(latencyMs)} ms (gate: ${THRESHOLDS.saveLatencyMaxMs} ms)`
        : "replay.save latency gate failed or snapshot not released cleanly",
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `driveValSeg003 error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  } finally {
    // Release any still-pinned snapshot on error paths
    if (snapshotId && rpc) {
      await rpc
        .call("replay.snapshot_release", { snapshot_id: snapshotId }, 3_000)
        .catch(() => {});
    }
    if (rpc) rpc.close();
    if (spawned && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (load) {
      await load.teardown().catch(() => {});
    }
  }
}

function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function driveValExp001(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();
  let spawned: SpawnedHelper | null = null;
  let load: LaunchedLoad | null = null;
  let rpc: RpcClient | null = null;
  let snapshotId: string | null = null;
  let exportId: string | null = null;
  let exportTmpDir: string | null = null;

  try {
    const baseline = pgrepCheck();
    writeJsonEvidence(evidenceDir, "baseline_pgrep.json", baseline);

    const probe = probeEnvironment();
    writeJsonEvidence(evidenceDir, "env-probe.json", probe);

    if (probe.gpuInfo == null || !probe.gpuInfo.startsWith("nvidia:")) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No NVIDIA GPU detected (nvidia-smi absent or failed) — NVENC required for stream-copy export",
      });
    }

    if (!hasDisplayServer(probe)) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No DISPLAY or WAYLAND_DISPLAY — cannot open portal for requestSession",
      });
    }

    if (!probe.xdgRuntimeDir) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message: "XDG_RUNTIME_DIR not set — xdg-desktop-portal unreachable",
      });
    }

    if (!probe.portalRunning) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "xdg-desktop-portal not running — cannot negotiate screencast session",
      });
    }

    try {
      load = await launchMotion60();
    } catch (loadErr) {
      if (loadErr instanceof LoadScriptMissingError) {
        return makeReport(row, "error", {
          message: String(loadErr),
          durationMs: Date.now() - start,
        });
      }
      throw loadErr;
    }

    if (load === null) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No Chromium-based browser available — cannot launch L-MOTION-60",
      });
    }

    await new Promise((r) => setTimeout(r, 1_000));

    if (load.exited) {
      return makeReport(row, "fail", {
        message:
          "L-MOTION-60 load process exited during startup — Wayland/X11 launch likely failed",
        durationMs: Date.now() - start,
      });
    }

    writeJsonEvidence(evidenceDir, "load-launch.json", {
      name: load.name,
      pid: load.pid,
      argv: load.argv,
    });

    const socketPath = runnerOwnedSocketPath();
    writeEvidence(evidenceDir, "helper-socket.txt", socketPath + "\n");
    spawned = await spawnHelper(socketPath);
    rpc = await RpcClient.connect(socketPath, 5_000);
    const readyNotif = await rpc.waitNotification("engine.ready", 10_000);
    writeJsonEvidence(evidenceDir, "engine-ready.json", readyNotif);

    let reqResp;
    try {
      reqResp = await rpc.call(
        "capture.requestSession",
        { mode: "monitor", cursor_mode: "embedded", persist: "transient" },
        60_000,
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("timeout")) {
        return makeReport(row, "skip", {
          skipReason: "helper-not-available",
          message:
            "capture.requestSession timed out — portal D-Bus path inaccessible; run in an interactive user session",
        });
      }
      throw err;
    }
    writeJsonEvidence(evidenceDir, "requestSession-response.json", reqResp);

    if (reqResp.error) {
      return makeReport(row, "fail", {
        message: `capture.requestSession error: ${JSON.stringify(reqResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const startResp = await rpc.call("capture.startStream", undefined, 5_000);
    writeJsonEvidence(evidenceDir, "startStream-response.json", startResp);

    if (startResp.error) {
      return makeReport(row, "error", {
        message: `capture.startStream failed: ${JSON.stringify(startResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const sessionReadyNotif = await rpc.waitNotification(
      "capture.sessionReady",
      15_000,
    );
    writeJsonEvidence(
      evidenceDir,
      "sessionReady-notification.json",
      sessionReadyNotif,
    );

    // Encoder stub guard: if all backends report not-implemented-yet, no segments
    // were ever written — skip rather than fail so smoke suite is not gated on T-017.
    {
      let encProbeNotif: RpcNotification | null = null;
      try {
        encProbeNotif = await rpc.waitNotification("encoder.probeResult", 3_000);
        writeJsonEvidence(evidenceDir, "encoder-probe-result.json", encProbeNotif);
      } catch {
        // not buffered — proceed
      }
      if (encProbeNotif !== null) {
        const encBackends = (
          encProbeNotif.params as Record<string, unknown> | undefined
        )?.backends as
          | Array<{ backend: string; available: boolean; details?: unknown }>
          | undefined;
        if (isEncoderStubState(encBackends)) {
          await rpc
            .call("capture.stopSession", undefined, 10_000)
            .catch(() => {});
          return makeReport(row, "skip", {
            skipReason: "helper-not-available",
            message:
              "encoder implementation not ready — all backends unavailable, segment buffer not created (T-017 in progress)",
          });
        }
      }
    }

    // Warm segment buffer for 65 s so replay.save can produce a full 60-second window
    await new Promise((r) => setTimeout(r, 65_000));

    const saveResp = await rpc.call("replay.save", { duration_s: 60 }, 20_000);
    writeJsonEvidence(evidenceDir, "save-response.json", saveResp);

    if (saveResp.error) {
      await rpc.call("capture.stopSession", undefined, 10_000).catch(() => {});
      return makeReport(row, "fail", {
        message: `replay.save error: ${JSON.stringify(saveResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    let snapshotPinnedNotif: RpcNotification | null = null;
    try {
      snapshotPinnedNotif = await rpc.waitNotification(
        "replay.snapshotPinned",
        5_000,
      );
      writeJsonEvidence(
        evidenceDir,
        "snapshotPinned-notification.json",
        snapshotPinnedNotif,
      );
    } catch {
      // absent — check result field below
    }

    const saveResult = saveResp.result as Record<string, unknown> | undefined;
    snapshotId =
      typeof saveResult?.snapshot_id === "string"
        ? saveResult.snapshot_id
        : null;
    if (!snapshotId) {
      const pinnedParams = snapshotPinnedNotif?.params as
        | Record<string, unknown>
        | undefined;
      if (pinnedParams?.snapshot_id) {
        snapshotId = String(pinnedParams.snapshot_id);
      }
    }

    if (!snapshotId) {
      await rpc.call("capture.stopSession", undefined, 10_000).catch(() => {});
      return makeReport(row, "fail", {
        message:
          "replay.save did not return a snapshot_id (checked result and snapshotPinned notification)",
        durationMs: Date.now() - start,
      });
    }

    // Build unique temp dir for the output file; do NOT pre-create the .mp4 file
    // itself — the helper uses renameat2(RENAME_NOREPLACE) and errors if dest exists.
    const rng = crypto.randomBytes(8).toString("hex");
    exportTmpDir = path.join(
      os.tmpdir(),
      `cove-val-exp001-${Date.now()}-${rng}`,
    );
    fs.mkdirSync(exportTmpDir, { recursive: true, mode: 0o700 });
    const outputPath = path.join(exportTmpDir, "export.mp4");

    const exportStartResp = await rpc.call(
      "replay.export_start",
      {
        snapshot: { snapshot_id: snapshotId },
        options: { output_path: outputPath },
      },
      15_000,
    );
    writeJsonEvidence(evidenceDir, "export-start-response.json", exportStartResp);

    if (exportStartResp.error) {
      return makeReport(row, "fail", {
        message: `replay.export_start error: ${JSON.stringify(exportStartResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const exportStartResult = exportStartResp.result as
      | Record<string, unknown>
      | undefined;
    exportId =
      typeof exportStartResult?.export_id === "string"
        ? exportStartResult.export_id
        : null;
    writeJsonEvidence(evidenceDir, "export-id.json", { export_id: exportId });

    // Poll for terminal export events in short slots.
    // Use Promise.allSettled (not Promise.race) so all three waiters fully settle
    // before the next slot registers new ones. Promise.race would reject on the
    // first timeout while the other two remain registered, creating stale waiters
    // that could consume the terminal event before the next slot's waiters see it.
    // The rpc-client buffers notifications that arrive while no waiter is registered
    // so no event is lost between settled slots.
    const EXPORT_BUDGET_MS = 180_000;
    const POLL_SLOT_MS = 5_000;
    type TerminalResult = { method: string; notif: RpcNotification };
    let terminalResult: TerminalResult | null = null;
    const exportDeadline = Date.now() + EXPORT_BUDGET_MS;

    while (Date.now() < exportDeadline && terminalResult === null) {
      const rem = exportDeadline - Date.now();
      if (rem <= 0) break;
      const slot = Math.min(POLL_SLOT_MS, rem);

      const r1 = rpc
        .waitNotification("export.completed", slot)
        .then((n): TerminalResult => ({ method: "export.completed", notif: n }));
      const r2 = rpc
        .waitNotification("export.failed", slot)
        .then((n): TerminalResult => ({ method: "export.failed", notif: n }));
      const r3 = rpc
        .waitNotification("export.cancelled", slot)
        .then((n): TerminalResult => ({ method: "export.cancelled", notif: n }));

      const settled = await Promise.allSettled([r1, r2, r3]);
      for (const s of settled) {
        if (s.status === "fulfilled") {
          terminalResult = s.value;
          break;
        }
      }
    }

    if (terminalResult === null) {
      throw new Error(
        `Export terminal event timeout after ${EXPORT_BUDGET_MS}ms`,
      );
    }

    const terminalMethod = terminalResult!.method;
    const terminalParams = terminalResult!.notif.params as
      | Record<string, unknown>
      | undefined;

    writeJsonEvidence(evidenceDir, "export-terminal-event.json", {
      method: terminalMethod,
      params: terminalParams,
    });

    // Copy ffmpeg diagnostics file into evidence dir when export failed.
    if (
      terminalMethod === "export.failed" &&
      typeof terminalParams?.diagnostics_path === "string" &&
      terminalParams.diagnostics_path.length > 0
    ) {
      try {
        const diagSrc = terminalParams.diagnostics_path as string;
        if (fs.existsSync(diagSrc)) {
          const diagDest = path.join(evidenceDir, "ffmpeg-diagnostics.txt");
          fs.copyFileSync(diagSrc, diagDest);
        }
      } catch {
        // best-effort; missing/unreadable diagnostics must not crash or change verdict
      }
    }

    // Export has terminated; clear exportId so the finally block does not attempt cancel.
    exportId = null;

    // Release snapshot after terminal event (helper blocks release while export is active).
    const releaseResp = await rpc
      .call("replay.snapshot_release", { snapshot_id: snapshotId }, 5_000)
      .catch((e: unknown) => ({
        error: { message: String(e) },
        result: undefined,
      }));
    writeJsonEvidence(
      evidenceDir,
      "snapshot-release-response.json",
      releaseResp,
    );
    if (!releaseResp.error) {
      snapshotId = null;
    } else {
      // Retry after brief delay: helper may still be settling active_exports
      // after the terminal event. Retry while rpc is still open and the helper
      // is still running, before shutdown.
      await new Promise((r) => setTimeout(r, 500));
      const retryRelease = await rpc
        .call(
          "replay.snapshot_release",
          { snapshot_id: snapshotId },
          5_000,
        )
        .catch((e: unknown) => ({
          error: { message: String(e) },
          result: undefined,
        }));
      writeJsonEvidence(
        evidenceDir,
        "snapshot-release-retry.json",
        retryRelease,
      );
      if (!retryRelease.error) {
        snapshotId = null;
      }
    }

    const helperSha256 =
      typeof terminalParams?.sha256 === "string" ? terminalParams.sha256 : null;
    const finalPath =
      typeof terminalParams?.final_path === "string"
        ? terminalParams.final_path
        : outputPath;
    const helperBytes =
      typeof terminalParams?.bytes === "number" ? terminalParams.bytes : null;
    const helperDurationS =
      typeof terminalParams?.duration_s === "number"
        ? terminalParams.duration_s
        : null;

    let fileExists = false;
    let fileSizeBytes = 0;
    try {
      const stat = fs.statSync(finalPath);
      fileExists = stat.isFile();
      fileSizeBytes = stat.size;
    } catch {
      fileExists = false;
    }

    let runnerSha256: string | null = null;
    if (fileExists) {
      try {
        runnerSha256 = await computeSha256(finalPath);
      } catch (e) {
        writeEvidence(evidenceDir, "sha256-error.txt", String(e) + "\n");
      }
    }

    writeJsonEvidence(evidenceDir, "sha256-check.json", {
      helperSha256,
      runnerSha256,
      match: helperSha256 !== null && helperSha256 === runnerSha256,
      finalPath,
      fileSizeBytes,
    });

    // Stop capture session then shutdown helper
    const stopResp = await rpc
      .call("capture.stopSession", undefined, 10_000)
      .catch(() => null);
    if (stopResp) writeJsonEvidence(evidenceDir, "stopSession-response.json", stopResp);

    const shutdownResp = await shutdownHelper(rpc);
    writeJsonEvidence(evidenceDir, "shutdown-response.json", shutdownResp);
    // Don't close rpc here — let the finally block close it after any final
    // snapshot release attempt (if the retry above still failed).

    await new Promise((r) =>
      setTimeout(r, THRESHOLDS.processCleanupAfterShutdownS * 1_000),
    );
    const postCheck = pgrepCheck(baseline);
    writeJsonEvidence(evidenceDir, "post_pgrep.json", postCheck);

    const durationMs = Date.now() - start;
    const thresholds: ThresholdResult[] = [];

    thresholds.push({
      name: "terminal event is export.completed",
      observed: terminalMethod,
      required: "export.completed",
      passed: terminalMethod === "export.completed",
    });

    thresholds.push({
      name: "export file exists at final_path",
      observed: fileExists ? `${fileSizeBytes} bytes` : "not found",
      required: "file exists",
      passed: fileExists,
    });

    const sha256Match =
      helperSha256 !== null &&
      runnerSha256 !== null &&
      helperSha256 === runnerSha256;
    thresholds.push({
      name: "runner SHA256 matches helper SHA256",
      observed: runnerSha256 ?? "(not computed)",
      required: helperSha256 ?? "(not provided)",
      passed: sha256Match,
    });

    // bytes field must be present — fail if absent to catch protocol regressions.
    thresholds.push({
      name: "export.completed includes bytes field",
      observed: helperBytes !== null ? String(helperBytes) : "(absent)",
      required: "non-null number",
      passed: helperBytes !== null,
    });
    if (helperBytes !== null && fileExists) {
      thresholds.push({
        name: "file size matches bytes field",
        observed: String(fileSizeBytes),
        required: String(helperBytes),
        passed: fileSizeBytes === helperBytes,
      });
    }

    if (helperDurationS !== null) {
      const toleranceMs = THRESHOLDS.durationToleranceMs["60s"];
      const diffMs = Math.abs(helperDurationS * 1_000 - 60_000);
      thresholds.push({
        name: `export duration within ±${toleranceMs.toFixed(1)} ms of 60 s (informational)`,
        observed: `${(helperDurationS * 1_000).toFixed(1)} ms`,
        required: `60000 ± ${toleranceMs.toFixed(1)} ms`,
        passed: diffMs <= toleranceMs,
      });
    }

    const noEnginePost = postCheck.coveReplayEngine.length === 0;
    thresholds.push({
      name: "no cove-replay-engine after shutdown",
      observed: String(postCheck.coveReplayEngine.length),
      required: "0",
      passed: noEnginePost,
    });

    const noFfmpegPost = postCheck.ffmpeg.length === 0;
    thresholds.push({
      name: "no ffmpeg after shutdown",
      observed: String(postCheck.ffmpeg.length),
      required: "0",
      passed: noFfmpegPost,
    });

    // Duration is informational — only the first three thresholds gate the verdict.
    const gatingThresholds = thresholds.filter(
      (t) => !t.name.startsWith("export duration within"),
    );
    const allGatingPassed = gatingThresholds.every((t) => t.passed);

    return makeReport(row, allGatingPassed ? "pass" : "fail", {
      durationMs,
      thresholds,
      evidencePaths: {
        "env-probe": evidenceDir + "/env-probe.json",
        "save-response": evidenceDir + "/save-response.json",
        "export-start-response": evidenceDir + "/export-start-response.json",
        "export-terminal-event": evidenceDir + "/export-terminal-event.json",
        "sha256-check": evidenceDir + "/sha256-check.json",
      },
      message: allGatingPassed
        ? `Export completed: ${fileSizeBytes} bytes, SHA256 verified, 60 s window` +
          (helperDurationS != null
            ? ` (${helperDurationS.toFixed(2)} s actual)`
            : "")
        : "Export validation failed — see thresholds",
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `driveValExp001 error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  } finally {
    // Cancel in-flight export before releasing snapshot (helper blocks release
    // while export is active).
    if (exportId && rpc) {
      await rpc
        .call("replay.export_cancel", { export_id: exportId }, 5_000)
        .catch(() => {});
    }
    if (snapshotId && rpc) {
      await rpc
        .call("replay.snapshot_release", { snapshot_id: snapshotId }, 3_000)
        .catch(() => {});
    }
    if (rpc) rpc.close();
    if (spawned && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (load) await load.teardown().catch(() => {});
    if (exportTmpDir) {
      try {
        fs.rmSync(exportTmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// produceStreamCopyMp4 — shared export orchestration for VAL-EXP-010 / VAL-REG-002
//
// Mirrors the driveValExp001 sequence verbatim but returns a typed result instead
// of a RowReport, and defers exportTmpDir cleanup to the caller so ffprobe can
// read the file after helper shutdown. The caller MUST call cleanup() on every
// non-skip/non-error terminal path.
// ---------------------------------------------------------------------------

// VAL-EXP-010 variable-rate export cadence policy: same payload shape used by
// VAL-CAP-004's negotiated `sessionReady.format`. fps_num=0 marks the KDE
// PipeWire variable-rate capture path; downstream export gates branch on it.
export interface CaptureFormat {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
}

type ProduceResult =
  | {
      kind: "ok";
      finalPath: string;
      sha256: string | null;
      bytes: number | null;
      durationS: number | null;
      cleanup: () => void;
      evidencePaths: Record<string, string>;
      // VAL-EXP-010 variable-rate policy: negotiated capture format from
      // `capture.sessionReady`. null when the notification omitted `format`
      // (variable-rate detection then falls back to row-config nominal).
      captureFormat: CaptureFormat | null;
    }
  | { kind: "skip"; skipReason: SkipReason; message: string }
  | { kind: "fail"; message: string; durationMs: number }
  | { kind: "error"; message: string; durationMs: number };

async function produceStreamCopyMp4(
  evidenceDir: string,
): Promise<ProduceResult> {
  const start = Date.now();
  let spawned: SpawnedHelper | null = null;
  let load: LaunchedLoad | null = null;
  let rpc: RpcClient | null = null;
  let snapshotId: string | null = null;
  let exportId: string | null = null;
  let exportTmpDir: string | null = null;
  let callerOwnsCleanup = false;
  let modesetResult: ModesetResult | null = null;

  const cleanup = () => {
    if (exportTmpDir) {
      try {
        fs.rmSync(exportTmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  };

  try {
    const baseline = pgrepCheck();
    writeJsonEvidence(evidenceDir, "baseline_pgrep.json", baseline);

    const probe = probeEnvironment();
    writeJsonEvidence(evidenceDir, "env-probe.json", probe);

    if (probe.gpuInfo == null || !probe.gpuInfo.startsWith("nvidia:")) {
      return {
        kind: "skip",
        skipReason: "helper-not-available",
        message:
          "No NVIDIA GPU detected (nvidia-smi absent or failed) — NVENC required for stream-copy export",
      };
    }

    if (!hasDisplayServer(probe)) {
      return {
        kind: "skip",
        skipReason: "helper-not-available",
        message:
          "No DISPLAY or WAYLAND_DISPLAY — cannot open portal for requestSession",
      };
    }

    if (!probe.xdgRuntimeDir) {
      return {
        kind: "skip",
        skipReason: "helper-not-available",
        message: "XDG_RUNTIME_DIR not set — xdg-desktop-portal unreachable",
      };
    }

    if (!probe.portalRunning) {
      return {
        kind: "skip",
        skipReason: "helper-not-available",
        message:
          "xdg-desktop-portal not running — cannot negotiate screencast session",
      };
    }

    try {
      load = await launchMotion60();
    } catch (loadErr) {
      if (loadErr instanceof LoadScriptMissingError) {
        return {
          kind: "error",
          message: String(loadErr),
          durationMs: Date.now() - start,
        };
      }
      throw loadErr;
    }

    if (load === null) {
      return {
        kind: "skip",
        skipReason: "helper-not-available",
        message:
          "No Chromium-based browser available — cannot launch L-MOTION-60",
      };
    }

    await new Promise((r) => setTimeout(r, 1_000));

    if (load.exited) {
      return {
        kind: "fail",
        message:
          "L-MOTION-60 load process exited during startup — Wayland/X11 launch likely failed",
        durationMs: Date.now() - start,
      };
    }

    writeJsonEvidence(evidenceDir, "load-launch.json", {
      name: load.name,
      pid: load.pid,
      argv: load.argv,
    });

    // ISS-022 Stage 1: enforce 1920x1080@60 before helper spawn so PipeWire
    // does not negotiate 4K variable-rate when the display is at native 4K.
    modesetResult = enforceDisplayMode({ width: 1920, height: 1080 }, 60);
    writeJsonEvidence(evidenceDir, "display-modeset.json", modesetResult);
    if (!modesetResult.success) {
      return {
        kind: "fail",
        message: `ISS-022: display mode enforcement failed — target 1920x1080@60, got ${modesetResult.appliedMode ? `${modesetResult.appliedMode.width}x${modesetResult.appliedMode.height}` : "(unknown)"} after ${modesetResult.attempts} attempts`,
        durationMs: Date.now() - start,
      };
    }

    const socketPath = runnerOwnedSocketPath();
    writeEvidence(evidenceDir, "helper-socket.txt", socketPath + "\n");
    spawned = await spawnHelper(socketPath);
    rpc = await RpcClient.connect(socketPath, 5_000);
    const readyNotif = await rpc.waitNotification("engine.ready", 10_000);
    writeJsonEvidence(evidenceDir, "engine-ready.json", readyNotif);

    let reqResp;
    try {
      reqResp = await rpc.call(
        "capture.requestSession",
        { mode: "monitor", cursor_mode: "embedded", persist: "transient" },
        60_000,
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("timeout")) {
        return {
          kind: "skip",
          skipReason: "helper-not-available",
          message:
            "capture.requestSession timed out — portal D-Bus path inaccessible; run in an interactive user session",
        };
      }
      throw err;
    }
    writeJsonEvidence(evidenceDir, "requestSession-response.json", reqResp);

    if (reqResp.error) {
      return {
        kind: "fail",
        message: `capture.requestSession error: ${JSON.stringify(reqResp.error)}`,
        durationMs: Date.now() - start,
      };
    }

    // ISS-022 Stage 2: re-enforce 1920x1080@60 after portal interaction.
    // The portal D-Bus round-trip can trigger KDE compositor recomposition
    // which reverts kscreen-doctor mode changes before PipeWire stream startup.
    const recheckModeset = enforceDisplayMode({ width: 1920, height: 1080 }, 60);
    writeJsonEvidence(evidenceDir, "display-modeset-pre-stream.json", recheckModeset);
    if (!recheckModeset.success) {
      return {
        kind: "fail",
        message: `ISS-022: display mode reverted after portal interaction — target 1920x1080@60, got ${recheckModeset.appliedMode ? `${recheckModeset.appliedMode.width}x${recheckModeset.appliedMode.height}` : "(unknown)"}`,
        durationMs: Date.now() - start,
      };
    }

    const startResp = await rpc.call("capture.startStream", undefined, 5_000);
    writeJsonEvidence(evidenceDir, "startStream-response.json", startResp);

    if (startResp.error) {
      return {
        kind: "error",
        message: `capture.startStream failed: ${JSON.stringify(startResp.error)}`,
        durationMs: Date.now() - start,
      };
    }

    const sessionReadyNotif = await rpc.waitNotification(
      "capture.sessionReady",
      15_000,
    );
    writeJsonEvidence(
      evidenceDir,
      "sessionReady-notification.json",
      sessionReadyNotif,
    );

    // VAL-EXP-010 variable-rate policy: pull the negotiated capture format
    // from sessionReady so the export-side driver can mirror VAL-CAP-004's
    // nominalFps + isVariableRate derivation. Missing/malformed payloads
    // collapse to null and the caller falls back to row-config nominal.
    const srParams = sessionReadyNotif.params as
      | Record<string, unknown>
      | undefined;
    const rawFormat = srParams?.format as
      | Partial<CaptureFormat>
      | undefined
      | null;
    let producedCaptureFormat: CaptureFormat | null = null;
    if (
      rawFormat &&
      typeof rawFormat.width === "number" &&
      typeof rawFormat.height === "number" &&
      typeof rawFormat.fps_num === "number" &&
      typeof rawFormat.fps_den === "number"
    ) {
      producedCaptureFormat = {
        width: rawFormat.width,
        height: rawFormat.height,
        fps_num: rawFormat.fps_num,
        fps_den: rawFormat.fps_den,
      };
    }

    {
      let encProbeNotif: RpcNotification | null = null;
      try {
        encProbeNotif = await rpc.waitNotification("encoder.probeResult", 3_000);
        writeJsonEvidence(
          evidenceDir,
          "encoder-probe-result.json",
          encProbeNotif,
        );
      } catch {
        // not buffered — proceed
      }
      if (encProbeNotif !== null) {
        const encBackends = (
          encProbeNotif.params as Record<string, unknown> | undefined
        )?.backends as
          | Array<{ backend: string; available: boolean; details?: unknown }>
          | undefined;
        if (isEncoderStubState(encBackends)) {
          await rpc
            .call("capture.stopSession", undefined, 10_000)
            .catch(() => {});
          return {
            kind: "skip",
            skipReason: "helper-not-available",
            message:
              "encoder implementation not ready — all backends unavailable, segment buffer not created (T-017 in progress)",
          };
        }
      }
    }

    await new Promise((r) => setTimeout(r, 65_000));

    const saveResp = await rpc.call("replay.save", { duration_s: 60 }, 20_000);
    writeJsonEvidence(evidenceDir, "save-response.json", saveResp);

    if (saveResp.error) {
      await rpc.call("capture.stopSession", undefined, 10_000).catch(() => {});
      return {
        kind: "fail",
        message: `replay.save error: ${JSON.stringify(saveResp.error)}`,
        durationMs: Date.now() - start,
      };
    }

    let snapshotPinnedNotif: RpcNotification | null = null;
    try {
      snapshotPinnedNotif = await rpc.waitNotification(
        "replay.snapshotPinned",
        5_000,
      );
      writeJsonEvidence(
        evidenceDir,
        "snapshotPinned-notification.json",
        snapshotPinnedNotif,
      );
    } catch {
      // absent — check result field below
    }

    const saveResult = saveResp.result as Record<string, unknown> | undefined;
    snapshotId =
      typeof saveResult?.snapshot_id === "string"
        ? saveResult.snapshot_id
        : null;
    if (!snapshotId) {
      const pinnedParams = snapshotPinnedNotif?.params as
        | Record<string, unknown>
        | undefined;
      if (pinnedParams?.snapshot_id) {
        snapshotId = String(pinnedParams.snapshot_id);
      }
    }

    if (!snapshotId) {
      await rpc.call("capture.stopSession", undefined, 10_000).catch(() => {});
      return {
        kind: "fail",
        message:
          "replay.save did not return a snapshot_id (checked result and snapshotPinned notification)",
        durationMs: Date.now() - start,
      };
    }

    const rng = crypto.randomBytes(8).toString("hex");
    exportTmpDir = path.join(
      os.tmpdir(),
      `cove-val-exp-pts-${Date.now()}-${rng}`,
    );
    fs.mkdirSync(exportTmpDir, { recursive: true, mode: 0o700 });
    const outputPath = path.join(exportTmpDir, "export.mp4");

    const exportStartResp = await rpc.call(
      "replay.export_start",
      {
        snapshot: { snapshot_id: snapshotId },
        options: { output_path: outputPath },
      },
      15_000,
    );
    writeJsonEvidence(
      evidenceDir,
      "export-start-response.json",
      exportStartResp,
    );

    if (exportStartResp.error) {
      return {
        kind: "fail",
        message: `replay.export_start error: ${JSON.stringify(exportStartResp.error)}`,
        durationMs: Date.now() - start,
      };
    }

    const exportStartResult = exportStartResp.result as
      | Record<string, unknown>
      | undefined;
    exportId =
      typeof exportStartResult?.export_id === "string"
        ? exportStartResult.export_id
        : null;
    writeJsonEvidence(evidenceDir, "export-id.json", { export_id: exportId });

    const EXPORT_BUDGET_MS = 180_000;
    const POLL_SLOT_MS = 5_000;
    type TerminalResult = { method: string; notif: RpcNotification };
    let terminalResult: TerminalResult | null = null;
    const exportDeadline = Date.now() + EXPORT_BUDGET_MS;

    while (Date.now() < exportDeadline && terminalResult === null) {
      const rem = exportDeadline - Date.now();
      if (rem <= 0) break;
      const slot = Math.min(POLL_SLOT_MS, rem);

      const r1 = rpc
        .waitNotification("export.completed", slot)
        .then((n): TerminalResult => ({ method: "export.completed", notif: n }));
      const r2 = rpc
        .waitNotification("export.failed", slot)
        .then((n): TerminalResult => ({ method: "export.failed", notif: n }));
      const r3 = rpc
        .waitNotification("export.cancelled", slot)
        .then((n): TerminalResult => ({
          method: "export.cancelled",
          notif: n,
        }));

      const settled = await Promise.allSettled([r1, r2, r3]);
      for (const s of settled) {
        if (s.status === "fulfilled") {
          terminalResult = s.value;
          break;
        }
      }
    }

    if (terminalResult === null) {
      throw new Error(
        `Export terminal event timeout after ${EXPORT_BUDGET_MS}ms`,
      );
    }

    const terminalMethod = terminalResult.method;
    const terminalParams = terminalResult.notif.params as
      | Record<string, unknown>
      | undefined;

    writeJsonEvidence(evidenceDir, "export-terminal-event.json", {
      method: terminalMethod,
      params: terminalParams,
    });

    exportId = null;

    const releaseResp = await rpc
      .call("replay.snapshot_release", { snapshot_id: snapshotId }, 5_000)
      .catch((e: unknown) => ({
        error: { message: String(e) },
        result: undefined,
      }));
    writeJsonEvidence(
      evidenceDir,
      "snapshot-release-response.json",
      releaseResp,
    );
    if (!releaseResp.error) {
      snapshotId = null;
    } else {
      await new Promise((r) => setTimeout(r, 500));
      const retryRelease = await rpc
        .call(
          "replay.snapshot_release",
          { snapshot_id: snapshotId },
          5_000,
        )
        .catch((e: unknown) => ({
          error: { message: String(e) },
          result: undefined,
        }));
      writeJsonEvidence(
        evidenceDir,
        "snapshot-release-retry.json",
        retryRelease,
      );
      if (!retryRelease.error) {
        snapshotId = null;
      }
    }

    const helperSha256 =
      typeof terminalParams?.sha256 === "string" ? terminalParams.sha256 : null;
    const finalPath =
      typeof terminalParams?.final_path === "string"
        ? terminalParams.final_path
        : outputPath;
    const helperBytes =
      typeof terminalParams?.bytes === "number" ? terminalParams.bytes : null;
    const helperDurationS =
      typeof terminalParams?.duration_s === "number"
        ? terminalParams.duration_s
        : null;

    let fileExists = false;
    let fileSizeBytes = 0;
    try {
      const stat = fs.statSync(finalPath);
      fileExists = stat.isFile();
      fileSizeBytes = stat.size;
    } catch {
      fileExists = false;
    }

    let runnerSha256: string | null = null;
    if (fileExists) {
      try {
        runnerSha256 = await computeSha256(finalPath);
      } catch {
        // non-fatal
      }
    }

    writeJsonEvidence(evidenceDir, "sha256-check.json", {
      helperSha256,
      runnerSha256,
      match: helperSha256 !== null && helperSha256 === runnerSha256,
      finalPath,
      fileSizeBytes,
    });

    const stopResp = await rpc
      .call("capture.stopSession", undefined, 10_000)
      .catch(() => null);
    if (stopResp)
      writeJsonEvidence(evidenceDir, "stopSession-response.json", stopResp);

    const shutdownResp = await shutdownHelper(rpc);
    writeJsonEvidence(evidenceDir, "shutdown-response.json", shutdownResp);

    if (terminalMethod !== "export.completed" || !fileExists) {
      return {
        kind: "fail",
        message:
          terminalMethod !== "export.completed"
            ? `Export terminated with ${terminalMethod} — cannot run ffprobe`
            : `Export file not found at ${finalPath}`,
        durationMs: Date.now() - start,
      };
    }

    callerOwnsCleanup = true;
    return {
      kind: "ok",
      finalPath,
      sha256: runnerSha256,
      bytes: helperBytes !== null ? helperBytes : fileSizeBytes,
      durationS: helperDurationS,
      cleanup,
      evidencePaths: {
        "env-probe": evidenceDir + "/env-probe.json",
        "save-response": evidenceDir + "/save-response.json",
        "export-start-response": evidenceDir + "/export-start-response.json",
        "export-terminal-event": evidenceDir + "/export-terminal-event.json",
        "sha256-check": evidenceDir + "/sha256-check.json",
      },
      captureFormat: producedCaptureFormat,
    };
  } catch (err) {
    return {
      kind: "error",
      message: `produceStreamCopyMp4 error: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  } finally {
    if (modesetResult?.priorMode && modesetResult.attempts > 0) {
      restoreDisplayMode(modesetResult.priorMode, modesetResult.output);
    }
    if (exportId && rpc) {
      await rpc
        .call("replay.export_cancel", { export_id: exportId }, 5_000)
        .catch(() => {});
    }
    if (snapshotId && rpc) {
      await rpc
        .call("replay.snapshot_release", { snapshot_id: snapshotId }, 3_000)
        .catch(() => {});
    }
    if (rpc) rpc.close();
    if (spawned && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (load) await load.teardown().catch(() => {});
    if (!callerOwnsCleanup && exportTmpDir) {
      try {
        fs.rmSync(exportTmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// VAL-EXP-010: No duplicated frames — ffprobe PTS walk on VAL-EXP-001 output
// ---------------------------------------------------------------------------

export async function driveValExp010(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();

  const produced = await produceStreamCopyMp4(evidenceDir);

  if (produced.kind === "skip") {
    return makeReport(row, "skip", {
      skipReason: produced.skipReason,
      message: produced.message,
    });
  }
  if (produced.kind === "fail") {
    return makeReport(row, "fail", {
      message: produced.message,
      durationMs: produced.durationMs,
    });
  }
  if (produced.kind === "error") {
    return makeReport(row, "error", {
      message: produced.message,
      durationMs: produced.durationMs,
    });
  }

  const { finalPath, cleanup, durationS, evidencePaths, captureFormat } = produced;

  try {
    let framesJson: unknown;
    try {
      const result = await runFfprobe(
        [
          "-v",
          "error",
          "-select_streams",
          "v",
          "-show_frames",
          "-of",
          "json",
          finalPath,
        ],
        30_000,
      );
      framesJson = result.parsed;
      writeJsonEvidence(evidenceDir, "ffprobe-frames.json", framesJson);
    } catch (err) {
      if (err instanceof FfprobeError && err.code === "ffprobe-not-found") {
        return makeReport(row, "skip", {
          skipReason: "helper-not-available",
          message:
            "ffprobe binary not found on PATH — install ffmpeg to enable PTS analysis",
        });
      }
      return makeReport(row, "error", {
        message: `ffprobe failed: ${err instanceof FfprobeError ? err.code : String(err)}`,
        durationMs: Date.now() - start,
      });
    }

    const ptsSeconds = extractVideoPts(framesJson);
    if (ptsSeconds.length === 0) {
      return makeReport(row, "error", {
        message:
          "ffprobe returned no video PTS values — empty frames array or non-video stream",
        durationMs: Date.now() - start,
      });
    }

    writeJsonEvidence(evidenceDir, "pts-summary.json", {
      ptsSampleCount: ptsSeconds.length,
      firstPts: ptsSeconds[0],
      lastPts: ptsSeconds[ptsSeconds.length - 1],
    });

    // VAL-EXP-010 variable-rate export cadence policy. Mirrors VAL-CAP-004:
    // nominal fps comes from the negotiated capture format when fps_num/fps_den
    // are both > 0; otherwise (fps_num=0 KDE PipeWire variable-rate path, or no
    // sessionReady format) it falls back to the row-config 60 fps target.
    // isVariableRate is true only when the helper actually delivered
    // captureFormat with fps_num=0 — missing captureFormat is NOT treated as
    // variable-rate, so old smoke runs (no produced.captureFormat) keep the
    // strict path.
    let nominalFps: number;
    let nominalSource: CadenceNominalSource;
    if (
      captureFormat &&
      captureFormat.fps_num > 0 &&
      captureFormat.fps_den > 0
    ) {
      nominalFps = captureFormat.fps_num / captureFormat.fps_den;
      nominalSource = "negotiated";
    } else {
      nominalFps = 60;
      nominalSource = "row-config";
    }
    const isVariableRate =
      captureFormat !== null && captureFormat.fps_num === 0;
    const cadencePolicy: "variable-rate" | "strict" =
      isVariableRate && nominalSource === "row-config" ? "variable-rate" : "strict";

    const cadence = analyzePtsCadence(ptsSeconds, nominalFps);
    writeJsonEvidence(evidenceDir, "cadence-analysis.json", cadence);

    const durationMs = Date.now() - start;
    const thresholds: ThresholdResult[] = [];

    const fileDurationS =
      durationS ??
      ((ptsSeconds[ptsSeconds.length - 1] ?? 0) - (ptsSeconds[0] ?? 0));
    const dupAllowance = Math.ceil(
      (fileDurationS / 60) * THRESHOLDS.duplicatedPtsPerMinute,
    );

    // duplicatedPtsCount remains a strict gate on both paths — the fake-60fps
    // regression invariant is independent of capture cadence policy.
    thresholds.push({
      name: `duplicated PTS ≤ ${dupAllowance} (≤ ${THRESHOLDS.duplicatedPtsPerMinute}/min)`,
      observed: String(cadence.duplicatedPtsCount),
      required: `≤ ${dupAllowance}`,
      passed: cadence.duplicatedPtsCount <= dupAllowance,
    });

    const nominalIntervalS = cadence.nominalIntervalS;
    const meanFps = cadence.meanIntervalS > 0 ? 1 / cadence.meanIntervalS : 0;

    if (cadencePolicy === "variable-rate") {
      // Variable-rate path: gate on mean fps + frame-count envelopes that
      // match the VAL-CAP-004 variable-rate constants. Strict mean/p95/p99
      // and strict frame-count remain in the evidence bundle but never gate.
      const minFps = nominalFps * VARIABLE_RATE_CADENCE.variableRateCadenceMinFracOfNominal;
      const maxFps = nominalFps * VARIABLE_RATE_CADENCE.variableRateCadenceMaxFracOfNominal;
      thresholds.push({
        name: `cadence mean in variable-rate range [${minFps.toFixed(2)}..${maxFps.toFixed(2)}] fps (nominal source=${nominalSource})`,
        observed: meanFps.toFixed(3),
        required: `${minFps.toFixed(2)}..${maxFps.toFixed(2)}`,
        passed: meanFps >= minFps && meanFps <= maxFps,
      });

      const fcVar = checkFrameCountVariableRate(
        cadence.frameCount,
        fileDurationS,
        nominalFps,
      );
      thresholds.push({
        name: `frame count in variable-rate envelope [${fcVar.lowExpected}..${fcVar.highExpected}] (durationS=${fileDurationS.toFixed(3)} × ${nominalFps.toFixed(2)} fps × [${VARIABLE_RATE_CADENCE.variableRateCadenceMinFracOfNominal}..${VARIABLE_RATE_CADENCE.variableRateCadenceMaxFracOfNominal}])`,
        observed: String(fcVar.actualCount),
        required: `${fcVar.lowExpected}..${fcVar.highExpected}`,
        passed: fcVar.passed,
      });

      const meanTolS = nominalIntervalS * THRESHOLDS.cadenceMeanToleranceFrac;
      thresholds.push({
        name: `cadence mean ±${(THRESHOLDS.cadenceMeanToleranceFrac * 100).toFixed(1)}% of nominal (variable-rate informational)`,
        observed: `${(cadence.meanIntervalS * 1000).toFixed(3)} ms`,
        required: `${((nominalIntervalS - meanTolS) * 1000).toFixed(3)}–${((nominalIntervalS + meanTolS) * 1000).toFixed(3)} ms`,
        passed: Math.abs(cadence.meanIntervalS - nominalIntervalS) <= meanTolS,
        gating: false,
      });

      const p95TolS = nominalIntervalS * THRESHOLDS.cadenceP95ToleranceFrac;
      thresholds.push({
        name: `cadence p95 ±${(THRESHOLDS.cadenceP95ToleranceFrac * 100).toFixed(1)}% of nominal (variable-rate informational)`,
        observed: `${(cadence.p95IntervalS * 1000).toFixed(3)} ms`,
        required: `${((nominalIntervalS - p95TolS) * 1000).toFixed(3)}–${((nominalIntervalS + p95TolS) * 1000).toFixed(3)} ms`,
        passed: Math.abs(cadence.p95IntervalS - nominalIntervalS) <= p95TolS,
        gating: false,
      });

      const p99TolS = nominalIntervalS * THRESHOLDS.cadenceP99ToleranceFrac;
      thresholds.push({
        name: `cadence p99 ±${(THRESHOLDS.cadenceP99ToleranceFrac * 100).toFixed(1)}% of nominal (variable-rate informational)`,
        observed: `${(cadence.p99IntervalS * 1000).toFixed(3)} ms`,
        required: `${((nominalIntervalS - p99TolS) * 1000).toFixed(3)}–${((nominalIntervalS + p99TolS) * 1000).toFixed(3)} ms`,
        passed: Math.abs(cadence.p99IntervalS - nominalIntervalS) <= p99TolS,
        gating: false,
      });

      const fcStrict = checkFrameCount(cadence.frameCount, fileDurationS, nominalFps);
      thresholds.push({
        name: "frame count within ±1 of round(duration × fps) (variable-rate informational)",
        observed: String(cadence.frameCount),
        required: `${fcStrict.expected} ± 1`,
        passed: fcStrict.passed,
        gating: false,
      });
    } else {
      // Strict path: behaviour identical to the pre-policy code, just keyed
      // off the (now possibly negotiated) nominalFps instead of a hardcoded 60.
      const meanTolS = nominalIntervalS * THRESHOLDS.cadenceMeanToleranceFrac;
      thresholds.push({
        name: `cadence mean ±${(THRESHOLDS.cadenceMeanToleranceFrac * 100).toFixed(1)}% of nominal`,
        observed: `${(cadence.meanIntervalS * 1000).toFixed(3)} ms`,
        required: `${((nominalIntervalS - meanTolS) * 1000).toFixed(3)}–${((nominalIntervalS + meanTolS) * 1000).toFixed(3)} ms`,
        passed: Math.abs(cadence.meanIntervalS - nominalIntervalS) <= meanTolS,
      });

      const p95TolS = nominalIntervalS * THRESHOLDS.cadenceP95ToleranceFrac;
      thresholds.push({
        name: `cadence p95 ±${(THRESHOLDS.cadenceP95ToleranceFrac * 100).toFixed(1)}% of nominal`,
        observed: `${(cadence.p95IntervalS * 1000).toFixed(3)} ms`,
        required: `${((nominalIntervalS - p95TolS) * 1000).toFixed(3)}–${((nominalIntervalS + p95TolS) * 1000).toFixed(3)} ms`,
        passed: Math.abs(cadence.p95IntervalS - nominalIntervalS) <= p95TolS,
      });

      const p99TolS = nominalIntervalS * THRESHOLDS.cadenceP99ToleranceFrac;
      thresholds.push({
        name: `cadence p99 ±${(THRESHOLDS.cadenceP99ToleranceFrac * 100).toFixed(1)}% of nominal`,
        observed: `${(cadence.p99IntervalS * 1000).toFixed(3)} ms`,
        required: `${((nominalIntervalS - p99TolS) * 1000).toFixed(3)}–${((nominalIntervalS + p99TolS) * 1000).toFixed(3)} ms`,
        passed: Math.abs(cadence.p99IntervalS - nominalIntervalS) <= p99TolS,
      });

      const fcResult = checkFrameCount(cadence.frameCount, fileDurationS, nominalFps);
      thresholds.push({
        name: "frame count within ±1 of round(duration × fps)",
        observed: String(cadence.frameCount),
        required: `${fcResult.expected} ± 1`,
        passed: fcResult.passed,
      });
    }

    writeJsonEvidence(evidenceDir, "exp-cadence-policy.json", {
      captureFormat: captureFormat ?? null,
      nominalFps,
      nominalSource,
      isVariableRate,
      cadencePolicy,
      meanFps,
      frameCount: cadence.frameCount,
      durationS: fileDurationS,
      ...(cadencePolicy === "variable-rate"
        ? { variableRateCadenceConstants: VARIABLE_RATE_CADENCE }
        : {}),
    });

    const allPassed = thresholds.every((t) => t.gating === false || t.passed);

    if (!allPassed && cadence.duplicatedPtsCount > dupAllowance) {
      writeEvidence(
        evidenceDir,
        "dup-pts-regression.txt",
        `VAL-EXP-010 FAIL: ${cadence.duplicatedPtsCount} duplicated PTS in ` +
          `${fileDurationS.toFixed(1)} s (allowance: ${dupAllowance}).\n` +
          `Product regression detected. Do NOT patch validation code.\n` +
          `Reopen the cove-replay-engine ticket tracking encoder/segment PTS invariant.\n`,
      );
    }

    return makeReport(row, allPassed ? "pass" : "fail", {
      durationMs,
      thresholds,
      evidencePaths: {
        ...evidencePaths,
        "ffprobe-frames": evidenceDir + "/ffprobe-frames.json",
        "cadence-analysis": evidenceDir + "/cadence-analysis.json",
        "exp-cadence-policy": evidenceDir + "/exp-cadence-policy.json",
      },
      message: allPassed
        ? `No dup PTS; cadence within ${cadencePolicy} policy; ${cadence.frameCount} frames in ${fileDurationS.toFixed(1)} s (nominal=${nominalFps.toFixed(2)} fps source=${nominalSource})`
        : `PTS/cadence assertion failed (policy=${cadencePolicy}, nominal source=${nominalSource}) — ${thresholds.filter((t) => t.gating !== false && !t.passed).map((t) => t.name).join("; ")}`,
    });
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// VAL-REG-002: Fake-60fps regression gate — only dup-PTS threshold gates verdict
// ---------------------------------------------------------------------------

export async function driveValReg002(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();

  const produced = await produceStreamCopyMp4(evidenceDir);

  if (produced.kind === "skip") {
    return makeReport(row, "skip", {
      skipReason: produced.skipReason,
      message: produced.message,
    });
  }
  if (produced.kind === "fail") {
    return makeReport(row, "fail", {
      message: produced.message,
      durationMs: produced.durationMs,
    });
  }
  if (produced.kind === "error") {
    return makeReport(row, "error", {
      message: produced.message,
      durationMs: produced.durationMs,
    });
  }

  const { finalPath, cleanup, durationS, evidencePaths } = produced;

  try {
    let framesJson: unknown;
    try {
      const result = await runFfprobe(
        [
          "-v",
          "error",
          "-select_streams",
          "v",
          "-show_frames",
          "-of",
          "json",
          finalPath,
        ],
        30_000,
      );
      framesJson = result.parsed;
      writeJsonEvidence(evidenceDir, "ffprobe-frames.json", framesJson);
    } catch (err) {
      if (err instanceof FfprobeError && err.code === "ffprobe-not-found") {
        return makeReport(row, "skip", {
          skipReason: "helper-not-available",
          message:
            "ffprobe binary not found on PATH — install ffmpeg to enable PTS regression check",
        });
      }
      return makeReport(row, "error", {
        message: `ffprobe failed: ${err instanceof FfprobeError ? err.code : String(err)}`,
        durationMs: Date.now() - start,
      });
    }

    const ptsSeconds = extractVideoPts(framesJson);
    if (ptsSeconds.length === 0) {
      return makeReport(row, "error", {
        message:
          "ffprobe returned no video PTS values — empty frames array or non-video stream",
        durationMs: Date.now() - start,
      });
    }

    writeJsonEvidence(evidenceDir, "pts-summary.json", {
      ptsSampleCount: ptsSeconds.length,
      firstPts: ptsSeconds[0],
      lastPts: ptsSeconds[ptsSeconds.length - 1],
    });

    const nominalFps = 60;
    const cadence = analyzePtsCadence(ptsSeconds, nominalFps);
    writeJsonEvidence(evidenceDir, "cadence-analysis.json", cadence);

    const durationMs = Date.now() - start;
    const thresholds: ThresholdResult[] = [];

    const fileDurationS =
      durationS ??
      ((ptsSeconds[ptsSeconds.length - 1] ?? 0) - (ptsSeconds[0] ?? 0));
    const dupAllowance = Math.ceil(
      (fileDurationS / 60) * THRESHOLDS.duplicatedPtsPerMinute,
    );

    // Only this threshold gates the verdict for VAL-REG-002.
    thresholds.push({
      name: `duplicated PTS ≤ ${dupAllowance} (≤ ${THRESHOLDS.duplicatedPtsPerMinute}/min)`,
      observed: String(cadence.duplicatedPtsCount),
      required: `≤ ${dupAllowance}`,
      passed: cadence.duplicatedPtsCount <= dupAllowance,
    });

    // Cadence stats are informational only — always marked passed so they never gate.
    const nominalIntervalS = cadence.nominalIntervalS;
    thresholds.push({
      name: "cadence stats (informational)",
      observed:
        `mean=${(cadence.meanIntervalS * 1000).toFixed(3)} ms` +
        ` p95=${(cadence.p95IntervalS * 1000).toFixed(3)} ms` +
        ` p99=${(cadence.p99IntervalS * 1000).toFixed(3)} ms`,
      required: `nominal=${(nominalIntervalS * 1000).toFixed(3)} ms`,
      passed: true,
    });

    const dupPassed = thresholds[0]!.passed;

    if (!dupPassed) {
      writeEvidence(
        evidenceDir,
        "dup-pts-regression.txt",
        `VAL-REG-002 FAIL: ${cadence.duplicatedPtsCount} duplicated PTS in ` +
          `${fileDurationS.toFixed(1)} s (allowance: ${dupAllowance}).\n` +
          `Fake-60fps regression confirmed. Do NOT patch validation code.\n` +
          `Reopen the cove-replay-engine ticket tracking encoder/segment PTS invariant.\n`,
      );
    }

    return makeReport(row, dupPassed ? "pass" : "fail", {
      durationMs,
      thresholds,
      evidencePaths: {
        ...evidencePaths,
        "ffprobe-frames": evidenceDir + "/ffprobe-frames.json",
        "cadence-analysis": evidenceDir + "/cadence-analysis.json",
      },
      message: dupPassed
        ? `No fake-60fps duplication: ${cadence.duplicatedPtsCount} dup PTS in ${fileDurationS.toFixed(1)} s`
        : `Fake-60fps regression: ${cadence.duplicatedPtsCount} dup PTS in ${fileDurationS.toFixed(1)} s — see dup-pts-regression.txt`,
    });
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// VAL-EXP-012: Export runs concurrently with RECORDING without capture frame loss
// ---------------------------------------------------------------------------

export async function driveValExp012(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();
  let spawned: SpawnedHelper | null = null;
  let load: LaunchedLoad | null = null;
  let rpc: RpcClient | null = null;
  let snapshotId: string | null = null;
  let exportId: string | null = null;
  let exportTmpDir: string | null = null;
  const BASELINE_MIN_SAMPLES = 5;
  const BASELINE_WINDOW_MS = 10_000;

  try {
    // --- Stage 1: Environment probes ----------------------------------------
    const probe = probeEnvironment();
    writeJsonEvidence(evidenceDir, "env-probe.json", probe);

    if (probe.gpuInfo == null || !probe.gpuInfo.startsWith("nvidia:")) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No NVIDIA GPU detected (nvidia-smi absent or failed) — NVENC required for concurrent export test",
      });
    }

    if (!hasDisplayServer(probe)) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No DISPLAY or WAYLAND_DISPLAY — cannot open portal for requestSession",
      });
    }

    if (!probe.xdgRuntimeDir) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message: "XDG_RUNTIME_DIR not set — xdg-desktop-portal unreachable",
      });
    }

    if (!probe.portalRunning) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "xdg-desktop-portal not running — cannot negotiate screencast session",
      });
    }

    // --- Stage 2: Launch L-MOTION-60 load -----------------------------------
    try {
      load = await launchMotion60();
    } catch (loadErr) {
      if (loadErr instanceof LoadScriptMissingError) {
        return makeReport(row, "error", {
          message: String(loadErr),
          durationMs: Date.now() - start,
        });
      }
      throw loadErr;
    }

    if (load === null) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No Chromium-based browser available — cannot launch L-MOTION-60",
      });
    }

    await new Promise((r) => setTimeout(r, 1_000));

    if (load.exited) {
      return makeReport(row, "fail", {
        message:
          "L-MOTION-60 load process exited during startup — Wayland/X11 launch likely failed",
        durationMs: Date.now() - start,
      });
    }

    writeJsonEvidence(evidenceDir, "load-launch.json", {
      name: load.name,
      pid: load.pid,
      argv: load.argv,
    });

    // --- Stage 3: Spawn runner-owned helper + connect RPC -------------------
    const socketPath = runnerOwnedSocketPath();
    writeEvidence(evidenceDir, "helper-socket.txt", socketPath + "\n");
    spawned = await spawnHelper(socketPath);
    rpc = await RpcClient.connect(socketPath, 5_000);
    const readyNotif = await rpc.waitNotification("engine.ready", 10_000);
    writeJsonEvidence(evidenceDir, "engine-ready.json", readyNotif);

    // --- Stage 4: Start capture session ------------------------------------
    let reqResp;
    try {
      reqResp = await rpc.call(
        "capture.requestSession",
        { mode: "monitor", cursor_mode: "embedded", persist: "transient" },
        60_000,
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("timeout")) {
        return makeReport(row, "skip", {
          skipReason: "helper-not-available",
          message:
            "capture.requestSession timed out — portal D-Bus path inaccessible; run in an interactive user session",
        });
      }
      throw err;
    }
    writeJsonEvidence(evidenceDir, "requestSession-response.json", reqResp);

    if (reqResp.error) {
      return makeReport(row, "fail", {
        message: `capture.requestSession error: ${JSON.stringify(reqResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const startResp = await rpc.call("capture.startStream", undefined, 5_000);
    writeJsonEvidence(evidenceDir, "startStream-response.json", startResp);

    if (startResp.error) {
      return makeReport(row, "error", {
        message: `capture.startStream failed: ${JSON.stringify(startResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const sessionReadyNotif = await rpc.waitNotification(
      "capture.sessionReady",
      30_000,
    );
    writeJsonEvidence(
      evidenceDir,
      "sessionReady-notification.json",
      sessionReadyNotif,
    );

    // Drain encoder notifications + encoder stub guard
    let encProbeNotif: RpcNotification | null = null;
    try {
      encProbeNotif = await rpc.waitNotification("encoder.probeResult", 3_000);
      writeJsonEvidence(
        evidenceDir,
        "encoder-probe-result.json",
        encProbeNotif,
      );
    } catch {
      // not buffered — proceed
    }
    if (encProbeNotif !== null) {
      const encBackends = (
        encProbeNotif.params as Record<string, unknown> | undefined
      )?.backends as
        | Array<{ backend: string; available: boolean; details?: unknown }>
        | undefined;
      if (isEncoderStubState(encBackends)) {
        return makeReport(row, "skip", {
          skipReason: "helper-not-available",
          message:
            "encoder implementation not ready — all backends unavailable, segment buffer not created (T-017 in progress)",
        });
      }
    }

    let encoderBackend = "";
    const selectedNotif = await rpc
      .waitNotification("encoder.selected", 2_000)
      .catch(() => null);
    if (selectedNotif) {
      writeJsonEvidence(evidenceDir, "encoder-selected.json", selectedNotif);
      const selParams = selectedNotif.params as
        | Record<string, unknown>
        | undefined;
      const backend = String(selParams?.backend ?? "");
      if (backend) encoderBackend = backend;
    }

    // --- Stage 5: 65 s warm-up (populate rolling buffer) -------------------
    await new Promise((r) => setTimeout(r, 65_000));

    // --- Stage 6: Baseline diagnostics (10 s window before snapshot) --------
    const baselineSamples: DiagSample[] = [];
    const baselineDeadline = Date.now() + BASELINE_WINDOW_MS;

    while (Date.now() < baselineDeadline) {
      const rem = baselineDeadline - Date.now();
      if (rem <= 0) break;
      try {
        const diag = await rpc.waitNotification(
          "capture.diagnostics",
          Math.min(2_000, rem),
        );
        const diagParams = diag.params as Record<string, unknown> | undefined;
        const bufs = diagParams?.buffers as Record<string, unknown> | undefined;
        const cadence = diagParams?.cadence as
          | Record<string, unknown>
          | undefined;
        baselineSamples.push({
          t: Date.now(),
          droppedSinceLast: Number(bufs?.dropped_since_last ?? 0),
          totalProduced: Number(bufs?.total_produced ?? 0),
          observedFps: Number(cadence?.observed_fps ?? 0),
        });
      } catch {
        // slot timed out — keep collecting until deadline
      }
    }
    writeJsonEvidence(evidenceDir, "diagnostics-baseline.json", baselineSamples);

    // --- Stage 7: Take snapshot while RECORDING is active ------------------
    const saveResp = await rpc.call("replay.save", { duration_s: 60 }, 20_000);
    writeJsonEvidence(evidenceDir, "save-response.json", saveResp);

    if (saveResp.error) {
      return makeReport(row, "fail", {
        message: `replay.save error: ${JSON.stringify(saveResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    let snapshotPinnedNotif: RpcNotification | null = null;
    try {
      snapshotPinnedNotif = await rpc.waitNotification(
        "replay.snapshotPinned",
        5_000,
      );
      writeJsonEvidence(
        evidenceDir,
        "snapshotPinned-notification.json",
        snapshotPinnedNotif,
      );
    } catch {
      // absent — check result field below
    }

    const saveResult = saveResp.result as Record<string, unknown> | undefined;
    snapshotId =
      typeof saveResult?.snapshot_id === "string"
        ? saveResult.snapshot_id
        : null;
    if (!snapshotId) {
      const pinnedParams = snapshotPinnedNotif?.params as
        | Record<string, unknown>
        | undefined;
      if (pinnedParams?.snapshot_id) {
        snapshotId = String(pinnedParams.snapshot_id);
      }
    }

    if (!snapshotId) {
      return makeReport(row, "fail", {
        message:
          "replay.save did not return a snapshot_id (checked result and snapshotPinned notification)",
        durationMs: Date.now() - start,
      });
    }

    // --- Stage 8: Create export output path --------------------------------
    const rng = crypto.randomBytes(8).toString("hex");
    exportTmpDir = path.join(
      os.tmpdir(),
      `cove-val-exp012-${Date.now()}-${rng}`,
    );
    fs.mkdirSync(exportTmpDir, { recursive: true, mode: 0o700 });
    const outputPath = path.join(exportTmpDir, "export.mp4");

    // Drain any capture.diagnostics that accumulated since the baseline window
    // ended (during save / snapshotPinned / tmpdir creation). These are
    // pre-export samples; consuming them here ensures Stage 10 only sees
    // diagnostics emitted while export was actually running.
    {
      let draining = true;
      while (draining) {
        try {
          await rpc.waitNotification("capture.diagnostics", 1);
        } catch {
          draining = false;
        }
      }
    }

    // --- Stage 9: Start export while RECORDING continues -------------------
    const exportStartResp = await rpc.call(
      "replay.export_start",
      {
        snapshot: { snapshot_id: snapshotId },
        options: { output_path: outputPath },
      },
      15_000,
    );
    writeJsonEvidence(
      evidenceDir,
      "export-start-response.json",
      exportStartResp,
    );

    if (exportStartResp.error) {
      return makeReport(row, "fail", {
        message: `replay.export_start error: ${JSON.stringify(exportStartResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const exportStartResult = exportStartResp.result as
      | Record<string, unknown>
      | undefined;
    exportId =
      typeof exportStartResult?.export_id === "string"
        ? exportStartResult.export_id
        : null;
    writeJsonEvidence(evidenceDir, "export-id.json", { export_id: exportId });

    // Wait for export.started as the concurrent-start anchor — proves export
    // began while RECORDING was still active. Terminal detection is left to
    // Stage 10 so no post-export diagnostics are buffered during this wait.
    // Invariant: helper always emits export.started before any terminal event
    // (helper/src/export/mod.rs:868), so a single started waiter is sufficient.
    type TerminalResult = { method: string; notif: RpcNotification };
    let terminalResult: TerminalResult | null = null;

    {
      let exportStartedNotif: RpcNotification | null = null;
      try {
        exportStartedNotif = await rpc.waitNotification(
          "export.started",
          15_000,
        );
      } catch {
        // 15s timeout — export.started did not arrive
      }
      writeJsonEvidence(
        evidenceDir,
        "export-started-notification.json",
        exportStartedNotif,
      );

      if (exportStartedNotif === null) {
        return makeReport(row, "fail", {
          message:
            "export.started notification did not arrive within 15 s — export may not have started while RECORDING was active",
          durationMs: Date.now() - start,
        });
      }
    }

    // --- Stage 10: During-export diagnostics + terminal event polling -------
    const duringExportSamples: DiagSample[] = [];
    const DIAG_SLOT_MS = 1_200;
    const TERMINAL_CHECK_MS = 500;
    const EXPORT_BUDGET_MS = 180_000;
    const exportDeadline = Date.now() + EXPORT_BUDGET_MS;

    while (Date.now() < exportDeadline && terminalResult === null) {
      const rem = exportDeadline - Date.now();
      if (rem <= 0) break;

      try {
        const diag = await rpc.waitNotification(
          "capture.diagnostics",
          Math.min(DIAG_SLOT_MS, rem),
        );
        const diagParams = diag.params as Record<string, unknown> | undefined;
        const bufs = diagParams?.buffers as Record<string, unknown> | undefined;
        const cadence = diagParams?.cadence as
          | Record<string, unknown>
          | undefined;
        duringExportSamples.push({
          t: Date.now(),
          droppedSinceLast: Number(bufs?.dropped_since_last ?? 0),
          totalProduced: Number(bufs?.total_produced ?? 0),
          observedFps: Number(cadence?.observed_fps ?? 0),
        });
      } catch {
        // slot timed out
      }

      if (terminalResult !== null) break;

      const termRem = Math.min(TERMINAL_CHECK_MS, exportDeadline - Date.now());
      if (termRem <= 0) break;

      const t1 = rpc
        .waitNotification("export.completed", termRem)
        .then((n): TerminalResult => ({ method: "export.completed", notif: n }));
      const t2 = rpc
        .waitNotification("export.failed", termRem)
        .then((n): TerminalResult => ({ method: "export.failed", notif: n }));
      const t3 = rpc
        .waitNotification("export.cancelled", termRem)
        .then((n): TerminalResult => ({
          method: "export.cancelled",
          notif: n,
        }));

      const settled = await Promise.allSettled([t1, t2, t3]);
      for (const s of settled) {
        if (s.status === "fulfilled") {
          terminalResult = s.value;
          break;
        }
      }
    }

    // Post-terminal drain: collect any capture.diagnostics buffered after the
    // last loop iteration. dropped_since_last is per-sample, so missing even
    // one sample that carried drops would falsely pass the zero-drop gate.
    {
      let draining = true;
      while (draining) {
        try {
          const diag = await rpc.waitNotification("capture.diagnostics", 1);
          const diagParams = diag.params as Record<string, unknown> | undefined;
          const bufs = diagParams?.buffers as
            | Record<string, unknown>
            | undefined;
          const cadence = diagParams?.cadence as
            | Record<string, unknown>
            | undefined;
          duringExportSamples.push({
            t: Date.now(),
            droppedSinceLast: Number(bufs?.dropped_since_last ?? 0),
            totalProduced: Number(bufs?.total_produced ?? 0),
            observedFps: Number(cadence?.observed_fps ?? 0),
          });
        } catch {
          draining = false;
        }
      }
    }

    // Drain any buffered capture.sessionLost that arrived during the export
    // window (before Stage 10, or between loop iterations). A session loss
    // means RECORDING stopped mid-export — the row must fail.
    let sessionLostDuringExport = false;
    try {
      await rpc.waitNotification("capture.sessionLost", 1);
      sessionLostDuringExport = true;
    } catch {
      // none buffered — expected on a healthy run
    }
    writeJsonEvidence(evidenceDir, "session-lost-check.json", {
      sessionLostDuringExport,
    });

    writeJsonEvidence(
      evidenceDir,
      "diagnostics-during-export.json",
      duringExportSamples,
    );

    if (terminalResult === null) {
      throw new Error(
        `Export terminal event timeout after ${EXPORT_BUDGET_MS} ms — concurrent export budget exhausted`,
      );
    }

    const terminalMethod = terminalResult.method;
    const terminalParams = terminalResult.notif.params as
      | Record<string, unknown>
      | undefined;
    exportId = null;

    writeJsonEvidence(evidenceDir, "export-terminal-event.json", {
      method: terminalMethod,
      params: terminalParams,
    });

    // --- Stage 11: Release snapshot ----------------------------------------
    const releaseResp = await rpc
      .call("replay.snapshot_release", { snapshot_id: snapshotId }, 5_000)
      .catch((e: unknown) => ({
        error: { message: String(e) },
        result: undefined,
      }));
    writeJsonEvidence(
      evidenceDir,
      "snapshot-release-response.json",
      releaseResp,
    );
    if (!releaseResp.error) {
      snapshotId = null;
    } else {
      await new Promise((r) => setTimeout(r, 500));
      const retryRelease = await rpc
        .call("replay.snapshot_release", { snapshot_id: snapshotId }, 5_000)
        .catch((e: unknown) => ({
          error: { message: String(e) },
          result: undefined,
        }));
      writeJsonEvidence(
        evidenceDir,
        "snapshot-release-retry.json",
        retryRelease,
      );
      if (!retryRelease.error) snapshotId = null;
    }

    // Check export file exists
    const finalPath =
      typeof terminalParams?.final_path === "string"
        ? terminalParams.final_path
        : outputPath;
    let fileExists = false;
    let fileSizeBytes = 0;
    try {
      const stat = fs.statSync(finalPath);
      fileExists = stat.isFile();
      fileSizeBytes = stat.size;
    } catch {
      fileExists = false;
    }
    writeJsonEvidence(evidenceDir, "export-file-check.json", {
      finalPath,
      fileExists,
      fileSizeBytes,
    });

    // Stop session and shutdown before threshold evaluation
    try {
      const stopResp = await rpc.call("capture.stopSession", undefined, 10_000);
      writeJsonEvidence(evidenceDir, "stopSession-response.json", stopResp);
    } catch (err) {
      writeEvidence(evidenceDir, "stopSession-error.txt", String(err) + "\n");
    }

    const shutdownResp = await shutdownHelper(rpc);
    writeJsonEvidence(evidenceDir, "shutdown-response.json", shutdownResp);
    rpc.close();
    rpc = null;

    // --- Stage 12: Threshold evaluation ------------------------------------
    const thresholds: ThresholdResult[] = [];

    thresholds.push({
      name: `baseline diagnostics samples >= ${BASELINE_MIN_SAMPLES}`,
      observed: String(baselineSamples.length),
      required: `>= ${BASELINE_MIN_SAMPLES}`,
      passed: baselineSamples.length >= BASELINE_MIN_SAMPLES,
    });

    thresholds.push({
      name: "during-export diagnostics samples >= 1",
      observed: String(duringExportSamples.length),
      required: ">= 1",
      passed: duringExportSamples.length >= 1,
    });

    thresholds.push({
      name: "export.completed (not failed/cancelled)",
      observed: terminalMethod,
      required: "export.completed",
      passed: terminalMethod === "export.completed",
    });

    thresholds.push({
      name: "export file exists on disk",
      observed: fileExists ? `yes (${fileSizeBytes} bytes)` : "no",
      required: "exists",
      passed: fileExists,
    });

    thresholds.push({
      name: "capture.sessionLost not received during export",
      observed: sessionLostDuringExport ? "session-lost" : "ok",
      required: "no session loss",
      passed: !sessionLostDuringExport,
    });

    // VAL-EXP-012 is NVENC-specific; assert the encoder actually selected is nvenc.
    const nvencSelected =
      encoderBackend.toLowerCase().includes("nvenc") ||
      encoderBackend.toLowerCase().includes("nvidia");
    thresholds.push({
      name: "encoder.selected backend is nvenc",
      observed: encoderBackend || "(not received)",
      required: "nvenc",
      passed: nvencSelected,
    });

    // During-export capture drop rate — VAL-EXP-012 requires zero drops regardless of resolution.
    // Do NOT use deriveThresholdKey here; that table allows 0.001 at 4k60-nvenc, which would
    // let frames drop during concurrent export and falsify the no-frame-loss invariant.
    const thresholdKey = "zero (VAL-EXP-012)";
    const maxDropRate = 0;

    const duringDropped = duringExportSamples.reduce(
      (s, x) => s + x.droppedSinceLast,
      0,
    );
    const baselineLastSample = baselineSamples[baselineSamples.length - 1];
    const duringLastSample =
      duringExportSamples[duringExportSamples.length - 1];
    const afterBaselineTotalProduced = baselineLastSample?.totalProduced ?? 0;
    const duringProducedCount =
      duringLastSample !== undefined &&
      duringLastSample.totalProduced > afterBaselineTotalProduced
        ? duringLastSample.totalProduced - afterBaselineTotalProduced
        : 0;
    const duringDropRate =
      duringProducedCount > 0
        ? duringDropped / duringProducedCount
        : duringDropped > 0
          ? 1.0
          : 0;

    writeJsonEvidence(evidenceDir, "drop-comparison.json", {
      baselineSampleCount: baselineSamples.length,
      baselineTotalDropped: baselineSamples.reduce(
        (s, x) => s + x.droppedSinceLast,
        0,
      ),
      afterBaselineTotalProduced,
      duringExportSampleCount: duringExportSamples.length,
      duringDropped,
      duringProducedCount,
      duringDropRate,
      thresholdKey,
      maxDropRate,
    });

    thresholds.push({
      name: `during-export capture drop rate <= ${maxDropRate} (${thresholdKey})`,
      observed: String(duringDropRate.toFixed(6)),
      required: `<= ${maxDropRate}`,
      passed: duringDropRate <= maxDropRate,
    });

    writeJsonEvidence(evidenceDir, "thresholds.json", thresholds);

    const durationMs = Date.now() - start;
    const passed = thresholds.every((t) => t.passed);
    const failedNames = thresholds
      .filter((t) => !t.passed)
      .map((t) => `${t.name}: got ${t.observed}`)
      .join("; ");

    return makeReport(row, passed ? "pass" : "fail", {
      durationMs,
      thresholds,
      message: passed
        ? `Concurrent export OK: during-export drops=${duringDropped}, export=${terminalMethod}`
        : failedNames,
      evidencePaths: {
        "env-probe": evidenceDir + "/env-probe.json",
        "diagnostics-baseline": evidenceDir + "/diagnostics-baseline.json",
        "diagnostics-during-export":
          evidenceDir + "/diagnostics-during-export.json",
        "drop-comparison": evidenceDir + "/drop-comparison.json",
        "export-terminal-event": evidenceDir + "/export-terminal-event.json",
        thresholds: evidenceDir + "/thresholds.json",
      },
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `driveValExp012 error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  } finally {
    if (exportId !== null && rpc !== null) {
      await rpc
        .call("replay.export_cancel", { export_id: exportId }, 5_000)
        .catch(() => {});
    }
    if (snapshotId !== null && rpc !== null) {
      await rpc
        .call("replay.snapshot_release", { snapshot_id: snapshotId }, 3_000)
        .catch(() => {});
    }
    if (rpc !== null) rpc.close();
    if (spawned !== null && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (load !== null) await load.teardown().catch(() => {});
    if (exportTmpDir !== null) {
      try {
        fs.rmSync(exportTmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

export async function driveValUi003(
  row: SmokeRow,
  _ctx: DriverContext,
): Promise<RowReport> {
  const evidenceDir = createRowEvidenceDir(row.id);
  const start = Date.now();
  let spawned: SpawnedHelper | null = null;
  let load: LaunchedLoad | null = null;
  let rpc: RpcClient | null = null;
  let snapshotId: string | null = null;
  let exportId: string | null = null;
  let exportTmpDir: string | null = null;

  try {
    const baseline = pgrepCheck();
    writeJsonEvidence(evidenceDir, "baseline_pgrep.json", baseline);

    const probe = probeEnvironment();
    writeJsonEvidence(evidenceDir, "env-probe.json", probe);

    if (!hasDisplayServer(probe)) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No DISPLAY or WAYLAND_DISPLAY — cannot open portal for requestSession",
      });
    }

    if (!probe.xdgRuntimeDir) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message: "XDG_RUNTIME_DIR not set — xdg-desktop-portal unreachable",
      });
    }

    if (!probe.portalRunning) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "xdg-desktop-portal not running — cannot negotiate screencast session",
      });
    }

    try {
      load = await launchMotion60();
    } catch (loadErr) {
      if (loadErr instanceof LoadScriptMissingError) {
        return makeReport(row, "error", {
          message: String(loadErr),
          durationMs: Date.now() - start,
        });
      }
      throw loadErr;
    }

    if (load === null) {
      return makeReport(row, "skip", {
        skipReason: "helper-not-available",
        message:
          "No Chromium-based browser available — cannot launch L-MOTION-60",
      });
    }

    await new Promise((r) => setTimeout(r, 1_000));

    if (load.exited) {
      return makeReport(row, "fail", {
        message:
          "L-MOTION-60 load process exited during startup — Wayland/X11 launch likely failed",
        durationMs: Date.now() - start,
      });
    }

    writeJsonEvidence(evidenceDir, "load-launch.json", {
      name: load.name,
      pid: load.pid,
      argv: load.argv,
    });

    const socketPath = runnerOwnedSocketPath();
    writeEvidence(evidenceDir, "helper-socket.txt", socketPath + "\n");
    spawned = await spawnHelper(socketPath);
    rpc = await RpcClient.connect(socketPath, 5_000);
    const readyNotif = await rpc.waitNotification("engine.ready", 10_000);
    writeJsonEvidence(evidenceDir, "engine-ready.json", readyNotif);

    let reqResp;
    try {
      reqResp = await rpc.call(
        "capture.requestSession",
        { mode: "monitor", cursor_mode: "embedded", persist: "transient" },
        60_000,
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("timeout")) {
        return makeReport(row, "skip", {
          skipReason: "helper-not-available",
          message:
            "capture.requestSession timed out — portal D-Bus path inaccessible; run in an interactive user session",
        });
      }
      throw err;
    }
    writeJsonEvidence(evidenceDir, "requestSession-response.json", reqResp);

    if (reqResp.error) {
      const errMsg = JSON.stringify(reqResp.error);
      if (
        errMsg.includes("denied") ||
        errMsg.includes("cancelled") ||
        errMsg.includes("portal")
      ) {
        return makeReport(row, "skip", {
          skipReason: "helper-not-available",
          message: `capture.requestSession portal denied/cancelled: ${errMsg}`,
        });
      }
      return makeReport(row, "fail", {
        message: `capture.requestSession error: ${errMsg}`,
        durationMs: Date.now() - start,
      });
    }

    const startResp = await rpc.call("capture.startStream", undefined, 5_000);
    writeJsonEvidence(evidenceDir, "startStream-response.json", startResp);

    if (startResp.error) {
      return makeReport(row, "error", {
        message: `capture.startStream failed: ${JSON.stringify(startResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const sessionReadyNotif = await rpc.waitNotification(
      "capture.sessionReady",
      15_000,
    );
    writeJsonEvidence(
      evidenceDir,
      "sessionReady-notification.json",
      sessionReadyNotif,
    );

    // Encoder stub guard — if all backends are not-implemented-yet, the segment
    // buffer is never created and replay.save fails. Skip rather than fail.
    {
      let encProbeNotif: RpcNotification | null = null;
      try {
        encProbeNotif = await rpc.waitNotification("encoder.probeResult", 3_000);
        writeJsonEvidence(evidenceDir, "encoder-probe-result.json", encProbeNotif);
      } catch {
        // not buffered — proceed
      }
      if (encProbeNotif !== null) {
        const encBackends = (
          encProbeNotif.params as Record<string, unknown> | undefined
        )?.backends as
          | Array<{ backend: string; available: boolean; details?: unknown }>
          | undefined;
        if (isEncoderStubState(encBackends)) {
          await rpc
            .call("capture.stopSession", undefined, 10_000)
            .catch(() => {});
          return makeReport(row, "skip", {
            skipReason: "helper-not-available",
            message:
              "encoder implementation not ready — all backends unavailable, segment buffer not created (T-017 in progress)",
          });
        }
      }
    }

    // Warm segment buffer for 15 s (sufficient for a 10-second save window)
    await new Promise((r) => setTimeout(r, 15_000));

    const saveResp = await rpc.call("replay.save", { duration_s: 10 }, 20_000);
    writeJsonEvidence(evidenceDir, "save-response.json", saveResp);

    if (saveResp.error) {
      await rpc.call("capture.stopSession", undefined, 10_000).catch(() => {});
      return makeReport(row, "fail", {
        message: `replay.save error: ${JSON.stringify(saveResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    let snapshotPinnedNotif: RpcNotification | null = null;
    try {
      snapshotPinnedNotif = await rpc.waitNotification(
        "replay.snapshotPinned",
        5_000,
      );
      writeJsonEvidence(
        evidenceDir,
        "snapshotPinned-notification.json",
        snapshotPinnedNotif,
      );
    } catch {
      // absent — check result field below
    }

    const saveResult = saveResp.result as Record<string, unknown> | undefined;
    snapshotId =
      typeof saveResult?.snapshot_id === "string"
        ? saveResult.snapshot_id
        : null;
    if (!snapshotId) {
      const pinnedParams = snapshotPinnedNotif?.params as
        | Record<string, unknown>
        | undefined;
      if (pinnedParams?.snapshot_id) {
        snapshotId = String(pinnedParams.snapshot_id);
      }
    }

    if (!snapshotId) {
      await rpc.call("capture.stopSession", undefined, 10_000).catch(() => {});
      return makeReport(row, "fail", {
        message:
          "replay.save did not return a snapshot_id (checked result and snapshotPinned notification)",
        durationMs: Date.now() - start,
      });
    }

    const rng = crypto.randomBytes(8).toString("hex");
    exportTmpDir = path.join(
      os.tmpdir(),
      `cove-val-ui003-${Date.now()}-${rng}`,
    );
    fs.mkdirSync(exportTmpDir, { recursive: true, mode: 0o700 });
    const outputPath = path.join(exportTmpDir, "export.mp4");

    const exportStartResp = await rpc.call(
      "replay.export_start",
      {
        snapshot: { snapshot_id: snapshotId },
        options: { output_path: outputPath },
      },
      15_000,
    );
    writeJsonEvidence(evidenceDir, "export-start-response.json", exportStartResp);

    if (exportStartResp.error) {
      await rpc.call("capture.stopSession", undefined, 10_000).catch(() => {});
      return makeReport(row, "fail", {
        message: `replay.export_start error: ${JSON.stringify(exportStartResp.error)}`,
        durationMs: Date.now() - start,
      });
    }

    const exportStartResult = exportStartResp.result as
      | Record<string, unknown>
      | undefined;
    exportId =
      typeof exportStartResult?.export_id === "string"
        ? exportStartResult.export_id
        : null;
    writeJsonEvidence(evidenceDir, "export-id.json", { export_id: exportId });

    // Wait for export.started — marks the EXPORTING window start for HUD Hz measurement.
    // The §6.3 "SAVING" label refers to the UI state; the measurable window is
    // export.started → terminal event (EXPORTING in the helper state machine).
    type TerminalResult = { method: string; notif: RpcNotification };
    let terminalResult: TerminalResult | null = null;
    let savingStartMs: number | null = null;

    {
      let exportStartedNotif: RpcNotification | null = null;
      try {
        exportStartedNotif = await rpc.waitNotification("export.started", 15_000);
      } catch {
        // 15s timeout
      }
      writeJsonEvidence(
        evidenceDir,
        "export-started-notification.json",
        exportStartedNotif,
      );

      if (exportStartedNotif === null) {
        await rpc.call("capture.stopSession", undefined, 10_000).catch(() => {});
        return makeReport(row, "fail", {
          message: "export.started notification did not arrive within 15 s",
          durationMs: Date.now() - start,
        });
      }

      // Drain any capture.diagnostics buffered before export.started arrives.
      // The RpcClient buffers all notifications; pre-export diagnostics from the
      // warmup/save window would get timestamped now and falsely appear within the
      // EXPORTING window, making the HUD Hz check a false positive.
      // Discard all buffered events before marking the window start.
      {
        let draining = true;
        while (draining) {
          try {
            await rpc.waitNotification("capture.diagnostics", 1);
          } catch {
            draining = false;
          }
        }
      }

      savingStartMs = Date.now();
    }

    // Collect capture.diagnostics arrival timestamps during the EXPORTING window.
    // These prove the helper emits diagnostics at >= 1 Hz during export.
    // Combined with static assertions on App.tsx + clocks.ts this forms the
    // hybrid proof required by §6.3: dynamic timing evidence + static renderer-clock proof.
    const diagTimestamps: number[] = [];
    const DIAG_SLOT_MS = 1_200;
    const EXPORT_BUDGET_MS = 60_000;
    const exportDeadline = Date.now() + EXPORT_BUDGET_MS;
    // savingEndMs is set when the terminal event is observed, bounding the
    // measurement window at [savingStartMs, savingEndMs]. Initialised here so
    // the timeout path also has a defined value.
    let savingEndMs: number = Date.now();

    // Race diagnostics and terminal events concurrently each slot so that a
    // terminal notification arriving in the same slot as a diagnostic always
    // takes precedence. Timestamps are captured inside each waiter's .then() so
    // they reflect actual notification arrival, not slot-end time.
    type DiagResult = { kind: "diag"; ts: number };
    type TermWithTs = { kind: "terminal"; result: TerminalResult; ts: number };

    while (Date.now() < exportDeadline && terminalResult === null) {
      const rem = exportDeadline - Date.now();
      if (rem <= 0) break;
      const slotMs = Math.min(DIAG_SLOT_MS, rem);

      const diagP = rpc
        .waitNotification("capture.diagnostics", slotMs)
        .then((): DiagResult => ({ kind: "diag", ts: Date.now() }))
        .catch(() => null);
      const t1P = rpc
        .waitNotification("export.completed", slotMs)
        .then((n): TermWithTs => ({
          kind: "terminal",
          result: { method: "export.completed", notif: n },
          ts: Date.now(),
        }))
        .catch(() => null);
      const t2P = rpc
        .waitNotification("export.failed", slotMs)
        .then((n): TermWithTs => ({
          kind: "terminal",
          result: { method: "export.failed", notif: n },
          ts: Date.now(),
        }))
        .catch(() => null);
      const t3P = rpc
        .waitNotification("export.cancelled", slotMs)
        .then((n): TermWithTs => ({
          kind: "terminal",
          result: { method: "export.cancelled", notif: n },
          ts: Date.now(),
        }))
        .catch(() => null);

      const [diagR, t1R, t2R, t3R] = await Promise.all([
        diagP,
        t1P,
        t2P,
        t3P,
      ]);

      // Terminal takes priority: if any terminal arrived in this slot, bind
      // savingEndMs at the arrival timestamp and exit without counting diagnostics.
      for (const r of [t1R, t2R, t3R]) {
        if (r !== null) {
          terminalResult = r.result;
          savingEndMs = r.ts;
          break;
        }
      }

      // Only record a diagnostic if no terminal was detected in this slot.
      if (terminalResult === null && diagR !== null) {
        diagTimestamps.push(diagR.ts);
      }
    }

    // Post-terminal cleanup drain: flush any capture.diagnostics buffered at the
    // terminal boundary. These are OUTSIDE the measurement window — do NOT add
    // to diagTimestamps. savingEndMs is already set above.
    {
      let draining = true;
      while (draining) {
        try {
          await rpc.waitNotification("capture.diagnostics", 1);
        } catch {
          draining = false;
        }
      }
    }

    writeJsonEvidence(evidenceDir, "diagnostics-timestamps.json", {
      timestamps: diagTimestamps,
      count: diagTimestamps.length,
      windowStartMs: savingStartMs,
      windowEndMs: savingEndMs,
    });

    if (terminalResult === null) {
      throw new Error(
        `Export terminal event timeout after ${EXPORT_BUDGET_MS} ms`,
      );
    }

    const terminalMethod = terminalResult.method;
    const terminalParams = terminalResult.notif.params as
      | Record<string, unknown>
      | undefined;
    exportId = null;

    writeJsonEvidence(evidenceDir, "export-terminal-event.json", {
      method: terminalMethod,
      params: terminalParams,
    });

    // Release snapshot; retry once on error
    const releaseResp = await rpc
      .call("replay.snapshot_release", { snapshot_id: snapshotId }, 5_000)
      .catch((e: unknown) => ({
        error: { message: String(e) },
        result: undefined,
      }));
    writeJsonEvidence(
      evidenceDir,
      "snapshot-release-response.json",
      releaseResp,
    );
    if (!releaseResp.error) {
      snapshotId = null;
    } else {
      await new Promise((r) => setTimeout(r, 500));
      const retryRelease = await rpc
        .call("replay.snapshot_release", { snapshot_id: snapshotId }, 5_000)
        .catch((e: unknown) => ({
          error: { message: String(e) },
          result: undefined,
        }));
      writeJsonEvidence(
        evidenceDir,
        "snapshot-release-retry.json",
        retryRelease,
      );
      if (!retryRelease.error) snapshotId = null;
    }

    const postPgrep = pgrepCheck();
    writeJsonEvidence(evidenceDir, "post_pgrep.json", postPgrep);

    // --- HUD Hz check ---
    const windowDurationMs = savingEndMs - savingStartMs!;
    const windowS = Math.floor(windowDurationMs / 1_000);
    const hudHz = checkHudHz(diagTimestamps, savingStartMs!, savingEndMs);
    writeJsonEvidence(evidenceDir, "hud-hz-check.json", {
      result: hudHz,
      windowDurationMs,
      windowS,
      diagCount: diagTimestamps.length,
    });

    // --- Static assertion helpers ---
    // Strip JS/TS line comments (//) and block comments (/* … */) before matching
    // so that commented-out code cannot satisfy the assertions.
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, "");

    // --- Static assertion #1: App.tsx v2 clock condition ---
    // Verify structural pattern: v2SessionReadyMs null-check AND the active-state
    // array contains RECORDING, SAVING, EXPORTING. Matches the variable by
    // structure, not by name, so a rename doesn't false-fail.
    let appClockAssertionPassed = false;
    let appClockAssertionMsg = "";
    const APP_TSX_PATH = path.resolve(__dirname, "../src/App.tsx");
    try {
      const appSourceRaw = fs.readFileSync(APP_TSX_PATH, "utf8");
      const appSource = stripComments(appSourceRaw);
      const hasAllActiveStates =
        appSource.includes('"RECORDING"') &&
        appSource.includes('"SAVING"') &&
        appSource.includes('"EXPORTING"');
      // Accept only a genuine null guard: !== null or != null (which covers null+undefined).
      // !== undefined alone does NOT guard against null and must not satisfy this check.
      const hasReadyMsCheck =
        appSource.includes("v2SessionReadyMs !== null") ||
        appSource.includes("v2SessionReadyMs != null");
      const clockConditionMatch = appSource.match(
        /v2SessionReadyMs[^;]{0,50}[\r\n]+\s*\[["']RECORDING["'][^;]{0,200}SAVING[^;]{0,100}EXPORTING/,
      );

      writeJsonEvidence(evidenceDir, "app-clock-assertion.json", {
        hasAllActiveStates,
        hasReadyMsCheck,
        clockConditionFound: clockConditionMatch !== null,
        matchedSnippet: clockConditionMatch?.[0]?.slice(0, 500) ?? null,
      });

      appClockAssertionPassed =
        hasAllActiveStates &&
        hasReadyMsCheck &&
        clockConditionMatch !== null;
      if (!appClockAssertionPassed) {
        appClockAssertionMsg = `App.tsx assertion failed: hasAllActiveStates=${hasAllActiveStates}, hasReadyMsCheck=${hasReadyMsCheck}, clockConditionFound=${clockConditionMatch !== null}`;
      }
    } catch (e) {
      writeJsonEvidence(evidenceDir, "app-clock-assertion.json", {
        error: String(e),
      });
      appClockAssertionPassed = false;
      appClockAssertionMsg = `Failed to read src/App.tsx: ${String(e)}`;
    }

    // --- Static assertion #2: src/v2/clocks.ts is rAF-driven ---
    let clocksRafAssertionPassed = false;
    let clocksRafAssertionMsg = "";
    const CLOCKS_TS_PATH = path.resolve(__dirname, "../src/v2/clocks.ts");
    try {
      const clocksSourceRaw = fs.readFileSync(CLOCKS_TS_PATH, "utf8");
      const clocksSource = stripComments(clocksSourceRaw);
      const hasRaf = clocksSource.includes("requestAnimationFrame");
      const rafMatch = clocksSource.match(/requestAnimationFrame[\s\S]{0,200}/);

      writeJsonEvidence(evidenceDir, "clocks-raf-assertion.json", {
        hasRequestAnimationFrame: hasRaf,
        matchedSnippet: rafMatch?.[0]?.slice(0, 300) ?? null,
      });

      clocksRafAssertionPassed = hasRaf;
      if (!clocksRafAssertionPassed) {
        clocksRafAssertionMsg =
          "src/v2/clocks.ts does not use requestAnimationFrame";
      }
    } catch (e) {
      writeJsonEvidence(evidenceDir, "clocks-raf-assertion.json", {
        error: String(e),
      });
      clocksRafAssertionPassed = false;
      clocksRafAssertionMsg = `Failed to read src/v2/clocks.ts: ${String(e)}`;
    }

    // --- Assemble thresholds ---
    const durationMs = Date.now() - start;
    const { thresholds, policy } = evaluateUi003PolicyThresholds({
      windowS,
      diagCount: diagTimestamps.length,
      hudMinHz: THRESHOLDS.hudMinHz,
      terminalMethod,
      hudPassed: hudHz.passed,
      hudMissedSeconds: hudHz.missedSeconds,
      appClockAssertionPassed,
      appClockAssertionMsg,
      clocksRafAssertionPassed,
      clocksRafAssertionMsg,
    });

    const allPassed = thresholds.every((t) => t.gating === false || t.passed);
    writeJsonEvidence(evidenceDir, "thresholds.json", thresholds);

    return makeReport(row, allPassed ? "pass" : "fail", {
      durationMs,
      thresholds,
      evidencePaths: {
        "env-probe": evidenceDir + "/env-probe.json",
        "diagnostics-timestamps": evidenceDir + "/diagnostics-timestamps.json",
        "hud-hz-check": evidenceDir + "/hud-hz-check.json",
        "app-clock-assertion": evidenceDir + "/app-clock-assertion.json",
        "clocks-raf-assertion": evidenceDir + "/clocks-raf-assertion.json",
        "export-terminal-event": evidenceDir + "/export-terminal-event.json",
        thresholds: evidenceDir + "/thresholds.json",
      },
      message: allPassed
        ? `HUD Hz validated (policy=${policy}): ${diagTimestamps.length} diagnostics over ${windowS}s export window; static assertions passed`
        : `policy=${policy}: ` +
          thresholds
            .filter((t) => t.gating !== false && !t.passed)
            .map((t) => t.name)
            .join("; "),
    });
  } catch (err) {
    return makeReport(row, "error", {
      message: `driveValUi003 error: ${String(err)}`,
      durationMs: Date.now() - start,
    });
  } finally {
    if (exportId !== null && rpc !== null) {
      await rpc
        .call("replay.export_cancel", { export_id: exportId }, 5_000)
        .catch(() => {});
    }
    if (snapshotId !== null && rpc !== null) {
      await rpc
        .call("replay.snapshot_release", { snapshot_id: snapshotId }, 3_000)
        .catch(() => {});
    }
    if (rpc !== null) rpc.close();
    if (spawned !== null && !spawned.exited) {
      spawned.cleanup();
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (load !== null) await load.teardown().catch(() => {});
    if (exportTmpDir !== null) {
      try {
        fs.rmSync(exportTmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

export function driveNotImplemented(
  row: SmokeRow,
  reason: string,
): RowReport {
  return makeReport(row, "skip", {
    skipReason: "not-implemented",
    message: reason,
  });
}

export const NOT_IMPLEMENTED_REASONS: Record<string, string> = {};
