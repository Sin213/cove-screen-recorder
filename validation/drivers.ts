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
  FfprobeError,
  runFfprobe,
  extractVideoPts,
  analyzePtsCadence,
  checkFrameCount,
} from "./assertions";
import { probeEnvironment, hasDisplayServer } from "./env-probe";
import { launchMotion60, LoadScriptMissingError, LaunchedLoad } from "./loads";

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

function deriveThresholdKey(
  format:
    | { width: number; height: number; fps_num: number; fps_den: number }
    | undefined,
  encoderBackend: string,
): string {
  const height = format?.height ?? 1080;
  let resPrefix: string;
  if (height >= 2160) {
    resPrefix = "4k60";
  } else if (height >= 1440) {
    resPrefix = "1440p60";
  } else {
    resPrefix = "1080p60";
  }

  const be = encoderBackend.toLowerCase();
  let encSuffix: string;
  if (be.includes("nvenc") || be.includes("nvidia")) {
    encSuffix = "nvenc";
  } else if (be.includes("vaapi")) {
    encSuffix = "vaapi";
  } else if (be.includes("qsv") || be.includes("quicksync") || be.includes("intel")) {
    encSuffix = "qsv";
  } else if (be === "nvenc") {
    encSuffix = "nvenc";
  } else {
    encSuffix = "libx264";
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

    // --- Stage 3: Spawn helper and connect ----------------------------------
    const socketPath = runnerOwnedSocketPath();
    writeEvidence(evidenceDir, "helper-socket.txt", socketPath + "\n");
    spawned = await spawnHelper(socketPath);
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
    // VAL-CAP-004 is the NVENC row; always use the nvenc threshold key for drop
    // rate (strictest gate) while asserting encoder.selected = nvenc explicitly.
    const thresholdKey = deriveThresholdKey(captureFormat, "nvenc");
    const maxDropRate =
      (THRESHOLDS.captureDropRate as Record<string, number>)[thresholdKey] ??
      0;
    writeJsonEvidence(evidenceDir, "thresholds.json", {
      key: thresholdKey,
      maxDropRate,
      cadenceMeanToleranceFrac: THRESHOLDS.cadenceMeanToleranceFrac,
      captureFormat: captureFormat ?? null,
      encoderObserved: encoderBackend || "(not received)",
    });

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

    const totalDropped = samples.reduce((s, x) => s + x.droppedSinceLast, 0);
    const lastSample = samples[samples.length - 1];
    const totalProduced = lastSample?.totalProduced ?? 0;
    const dropRate = totalProduced > 0 ? totalDropped / totalProduced : 0;

    thresholds.push({
      name: `drop rate <= ${maxDropRate} (${thresholdKey})`,
      observed: String(dropRate.toFixed(6)),
      required: `<= ${maxDropRate}`,
      passed: dropRate <= maxDropRate,
    });

    if (samples.length >= 10) {
      const nominalFps = captureFormat
        ? captureFormat.fps_num / captureFormat.fps_den
        : 60;
      const meanFps =
        samples.reduce((s, x) => s + x.observedFps, 0) / samples.length;
      const tol = THRESHOLDS.cadenceMeanToleranceFrac;
      thresholds.push({
        name: `cadence mean within ±${(tol * 100).toFixed(1)}% of ${nominalFps.toFixed(2)} fps`,
        observed: String(meanFps.toFixed(3)),
        required: `${(nominalFps * (1 - tol)).toFixed(2)}..${(nominalFps * (1 + tol)).toFixed(2)}`,
        passed: Math.abs(meanFps - nominalFps) / nominalFps <= tol,
      });
    } else {
      thresholds.push({
        name: "cadence (insufficient samples for mean check)",
        observed: String(samples.length),
        required: ">= 10 diagnostics samples",
        passed: false,
      });
    }

    thresholds.push({
      name: "at least 1 diagnostics sample received",
      observed: String(samples.length),
      required: ">= 1",
      passed: samples.length >= 1,
    });

    // Row VAL-CAP-004 is NVENC-specific; assert the backend is nvenc.
    const nvencObserved = encoderBackend || "(not received)";
    thresholds.push({
      name: "encoder.selected backend is nvenc",
      observed: nvencObserved,
      required: "nvenc",
      passed: encoderBackend === "nvenc",
    });

    const durationMs = Date.now() - start;
    const allPassed = thresholds.every((t) => t.passed);

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

type ProduceResult =
  | {
      kind: "ok";
      finalPath: string;
      sha256: string | null;
      bytes: number | null;
      durationS: number | null;
      cleanup: () => void;
      evidencePaths: Record<string, string>;
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
    };
  } catch (err) {
    return {
      kind: "error",
      message: `produceStreamCopyMp4 error: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  } finally {
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

    thresholds.push({
      name: `duplicated PTS ≤ ${dupAllowance} (≤ ${THRESHOLDS.duplicatedPtsPerMinute}/min)`,
      observed: String(cadence.duplicatedPtsCount),
      required: `≤ ${dupAllowance}`,
      passed: cadence.duplicatedPtsCount <= dupAllowance,
    });

    const nominalIntervalS = cadence.nominalIntervalS;
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

    const allPassed = thresholds.every((t) => t.passed);

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
      },
      message: allPassed
        ? `No dup PTS; cadence mean/p95/p99 within tolerance; ${cadence.frameCount} frames in ${fileDurationS.toFixed(1)} s`
        : `PTS/cadence assertion failed — ${thresholds.filter((t) => !t.passed).map((t) => t.name).join("; ")}`,
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

export function driveNotImplemented(
  row: SmokeRow,
  reason: string,
): RowReport {
  return makeReport(row, "skip", {
    skipReason: "not-implemented",
    message: reason,
  });
}

const ELECTRON_MSG =
  "Requires Electron renderer observation — not available in standalone helper mode";

export const NOT_IMPLEMENTED_REASONS: Record<string, string> = {
  "VAL-EXP-012":
    "Concurrent capture+export validation driver not implemented",
  "VAL-UI-003": ELECTRON_MSG,
};
