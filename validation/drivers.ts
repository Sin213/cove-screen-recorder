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
import { THRESHOLDS } from "./assertions";
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

export function driveNotImplemented(
  row: SmokeRow,
  reason: string,
): RowReport {
  return makeReport(row, "skip", {
    skipReason: "not-implemented",
    message: reason,
  });
}

const EXPORT_STUB_MSG =
  "Requires replay/export APIs (replay.save/export_start) which are helper stubs";
const ELECTRON_MSG =
  "Requires Electron renderer observation — not available in standalone helper mode";

export const NOT_IMPLEMENTED_REASONS: Record<string, string> = {
  "VAL-ENC-001":
    "Requires active capture to trigger encoder.probeResult — capture APIs are helper stubs",
  "VAL-SEG-001":
    "Requires active capture producing segments — capture APIs are helper stubs",
  "VAL-SEG-003": EXPORT_STUB_MSG,
  "VAL-EXP-001": EXPORT_STUB_MSG,
  "VAL-EXP-010":
    "Depends on VAL-EXP-001 output which cannot be produced — export APIs are helper stubs",
  "VAL-EXP-012":
    "Requires concurrent capture + export — both API sets are helper stubs",
  "VAL-UI-003": ELECTRON_MSG,
  "VAL-REG-002":
    "Depends on VAL-EXP-001 output which cannot be produced — export APIs are helper stubs",
};
