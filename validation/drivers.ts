import { RowReport, RowStatus, ThresholdResult, SkipReason } from "./types";
import { SmokeRow } from "./rows";
import { RpcClient } from "./rpc-client";
import {
  spawnHelper,
  shutdownHelper,
  pgrepCheck,
  getDescendantProcessNames,
  runnerOwnedSocketPath,
  SpawnedHelper,
} from "./helper-lifecycle";
import {
  createRowEvidenceDir,
  writeJsonEvidence,
  writeEvidence,
} from "./evidence";
import { THRESHOLDS } from "./assertions";

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

export function driveNotImplemented(
  row: SmokeRow,
  reason: string,
): RowReport {
  return makeReport(row, "skip", {
    skipReason: "not-implemented",
    message: reason,
  });
}

const CAPTURE_STUB_MSG =
  "Requires capture session APIs (capture.requestSession/startStream) which are helper stubs";
const EXPORT_STUB_MSG =
  "Requires replay/export APIs (replay.save/export_start) which are helper stubs";
const ELECTRON_MSG =
  "Requires Electron renderer observation — not available in standalone helper mode";

export const NOT_IMPLEMENTED_REASONS: Record<string, string> = {
  "VAL-CAP-004": CAPTURE_STUB_MSG,
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
  "VAL-PROC-002":
    "Requires active capture session to stop before quit — capture APIs are helper stubs",
  "VAL-PROC-003":
    "Requires Electron supervisor crash path — not available in standalone helper mode",
  "VAL-REG-002":
    "Depends on VAL-EXP-001 output which cannot be produced — export APIs are helper stubs",
};
