import { spawn } from "child_process";

/**
 * N-008 §20 ffprobe / mediainfo canonical recipe strings.
 * These are spec-level command templates; $f is the file path placeholder.
 * Actual execution is wired in T-010c — this file holds the contract.
 */
export const FFPROBE_RECIPES = {
  /** N-008 §20 — compare to requested window per §6.2 */
  duration: `ffprobe -v error -show_entries format=duration -of csv=p=0 "$f"`,

  /** N-008 §20 — parse num/den to get declared fps */
  declaredFps: `ffprobe -v error -select_streams v -show_entries stream=r_frame_rate -of csv=p=0 "$f"`,

  /** N-008 §20 — compare to round(duration × declared_fps) per §6.1 */
  frameCount: `ffprobe -v error -select_streams v -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$f"`,

  /**
   * N-008 §20 — walk pkt_dts / best_effort_timestamp;
   * consecutive identical timestamps within ½ frame duration = violation.
   * Also used for cadence (mean / 95p / 99p inter-frame interval).
   */
  framesJson: `ffprobe -v error -select_streams v -show_frames -of json "$f"`,

  /** N-008 §20 — h264 for v2.0.0 video paths */
  codec: `ffprobe -v error -select_streams v -show_entries stream=codec_name -of csv=p=0 "$f"`,
} as const;

export const MEDIAINFO_RECIPES = {
  /** N-008 §20 — should return "Yes" for faststart; cross-check moov-before-mdat */
  faststart: `mediainfo --Output=JSON "$f" | jq -r '.media.track[0].IsStreamable'`,

  /** N-008 §20 — confirm fMP4 fragmenting on segment files; check GOP structure */
  gopFragment: `mediainfo --Output=JSON "$f"`,
} as const;

/**
 * N-008 §6 universal pass/fail thresholds as typed constants.
 * Predicates below consume these values; T-010c executes them against observed data.
 */
export const THRESHOLDS = {
  /** §6.1 — capture frame drop rates by resolution × encoder (fractional, e.g. 0.001 = 0.1%). */
  captureDropRate: {
    "1080p60-nvenc": 0,
    "1080p60-vaapi": 0,
    "1080p60-qsv": 0,
    "1440p60-nvenc": 0,
    "1440p60-vaapi": 0,
    "1440p60-qsv": 0,
    "4k60-nvenc": 0.001,
    "4k60-vaapi": 0.001,
    "4k60-qsv": 0.005,
    "4k60-libx264": 0.02,
  },

  /** §6.1 — encoder drop rates by resolution × encoder. */
  encoderDropRate: {
    "1080p-hw": 0,
    "1440p-hw": 0,
    "4k60-nvenc": 0.001,
    "4k60-vaapi": 0.001,
  },

  /** §6.1 — allow at most 1 duplicated-PTS pair per 60 s of content. */
  duplicatedPtsPerMinute: 1,

  /** §6.1 — mean inter-frame PTS interval tolerance, fractional (0.005 = ±0.5%). */
  cadenceMeanToleranceFrac: 0.005,

  /** §6.1 — 95th-percentile inter-frame PTS tolerance, fractional (0.02 = ±2%). */
  cadenceP95ToleranceFrac: 0.02,

  /** §6.1 — 99th-percentile inter-frame PTS tolerance, fractional (0.05 = ±5%). */
  cadenceP99ToleranceFrac: 0.05,

  /** §6.2 — duration tolerance by window size (seconds), keyed by window bucket. */
  durationToleranceMs: {
    "30s": (1 / 60) * 1_000,
    "60s": (1 / 60) * 1_000,
    "5min": 50,
    "10min": 200,
    "soak-15min+": 500,
  },

  /** §6.3 — save latency: 250 ms + worst-case 2 s GOP = 2 250 ms. */
  saveLatencyMaxMs: 2_250,

  /** §6.3 — HUD must receive ≥ 1 capture.diagnostics event per second during SAVING. */
  hudMinHz: 1,

  /** §6.4 — exactly one terminal event (completed | failed | cancelled | rejected) per exportId. */
  exportTerminalEventsPerExportId: 1,

  /** §6.5 — encoder.fallbackEngaged at most once per session. */
  encoderFallbackMaxPerSession: 1,

  /** §6.6 — pgrep must return zero rows this many seconds after engine.shutdown. */
  processCleanupAfterShutdownS: 5,

  /** §6.8 — restart loop bound: ≤ 3 restarts in 60 s, then sticky engine.unavailable. */
  restartLoopMaxIn60s: 3,
} as const;

// ---------------------------------------------------------------------------
// Pure predicate functions — no I/O, no subprocess calls.
// T-010c wires these against observed ffprobe / IPC output.
// ---------------------------------------------------------------------------

/**
 * §6.1 — checks the decoded frame count against round(duration × declared_fps) ± 1.
 */
export function checkFrameCount(
  actualCount: number,
  durationS: number,
  declaredFps: number,
): { passed: boolean; expected: number; delta: number } {
  const expected = Math.round(durationS * declaredFps);
  const delta = Math.abs(actualCount - expected);
  return { passed: delta <= 1, expected, delta };
}

/**
 * §6.1 — counts consecutive identical pkt_dts values within ½ frame duration.
 * pts is an array of numeric packet timestamps (same unit as frame duration).
 */
export function countDuplicatedPts(pts: number[], nominalFrameDurationMs: number): number {
  let violations = 0;
  const halfFrame = nominalFrameDurationMs / 2;
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs((pts[i] ?? 0) - (pts[i - 1] ?? 0)) < halfFrame) {
      violations++;
    }
  }
  return violations;
}

/**
 * §6.2 — checks output duration against the requested window.
 * toleranceMs is looked up from THRESHOLDS.durationToleranceMs by the caller.
 */
export function checkDuration(
  actualDurationS: number,
  expectedDurationS: number,
  toleranceMs: number,
): { passed: boolean; deltaMs: number } {
  const deltaMs = Math.abs(actualDurationS - expectedDurationS) * 1_000;
  return { passed: deltaMs <= toleranceMs, deltaMs };
}

/**
 * §6.3 — checks whether the HUD fired at least once per second across the SAVING window.
 * eventTimestampsMs is an array of capture.diagnostics event arrival times (epoch ms).
 * windowStartMs / windowEndMs bound the SAVING state window.
 */
export function checkHudHz(
  eventTimestampsMs: number[],
  windowStartMs: number,
  windowEndMs: number,
): { passed: boolean; missedSeconds: number[] } {
  const windowS = Math.floor((windowEndMs - windowStartMs) / 1_000);
  const missedSeconds: number[] = [];
  for (let s = 0; s < windowS; s++) {
    const bucketStart = windowStartMs + s * 1_000;
    const bucketEnd = bucketStart + 1_000;
    const hit = eventTimestampsMs.some((t) => t >= bucketStart && t < bucketEnd);
    if (!hit) missedSeconds.push(s);
  }
  return { passed: missedSeconds.length === 0, missedSeconds };
}

// ---------------------------------------------------------------------------
// ffprobe subprocess wrapper + PTS analysis (T-010a Slice 6).
//
// Used by VAL-EXP-010 (no fake duplicated frames) and VAL-REG-002 (regression
// gate re-run on VAL-EXP-001 output). The contract is binary:
//   - missing ffprobe binary  →  FfprobeError("ffprobe-not-found")  (caller → skip)
//   - nonzero exit            →  FfprobeError("ffprobe-nonzero")    (caller → error)
//   - unparseable stdout      →  FfprobeError("ffprobe-parse")      (caller → error)
// JSON-parse / spawn failures must NEVER silently degrade to a "pass" — that
// would falsify the no-fake-duplicated-frames invariant.
// ---------------------------------------------------------------------------

export type FfprobeErrorCode =
  | "ffprobe-not-found"
  | "ffprobe-nonzero"
  | "ffprobe-parse"
  | "ffprobe-timeout";

export class FfprobeError extends Error {
  readonly code: FfprobeErrorCode;
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(
    code: FfprobeErrorCode,
    message: string,
    stderr: string,
    exitCode: number | null,
  ) {
    super(message);
    this.name = "FfprobeError";
    this.code = code;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/**
 * Spawn ffprobe with the supplied argv tail and return the parsed JSON stdout.
 * Argv-style spawn — never shell — to keep file path inputs safe. The caller
 * supplies the trailing argv (typically the recipe args plus the input file
 * absolute path). ffprobe is invoked with explicit `-print_format json` /
 * `-of json` by the caller's argv.
 */
export function runFfprobe(
  ffprobeArgs: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; parsed: unknown }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ffprobeArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        finish(() =>
          reject(
            new FfprobeError(
              "ffprobe-not-found",
              "ffprobe binary not found on PATH",
              stderr,
              null,
            ),
          ),
        );
        return;
      }
      finish(() =>
        reject(
          new FfprobeError(
            "ffprobe-nonzero",
            `ffprobe spawn error: ${String(err)}`,
            stderr,
            null,
          ),
        ),
      );
    });

    child.on("close", (exitCode: number | null) => {
      clearTimeout(timer);

      if (timedOut) {
        finish(() =>
          reject(
            new FfprobeError(
              "ffprobe-timeout",
              `ffprobe exceeded ${timeoutMs}ms`,
              stderr,
              exitCode,
            ),
          ),
        );
        return;
      }

      if (exitCode !== 0) {
        finish(() =>
          reject(
            new FfprobeError(
              "ffprobe-nonzero",
              `ffprobe exited with code ${exitCode}`,
              stderr,
              exitCode,
            ),
          ),
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        finish(() =>
          reject(
            new FfprobeError(
              "ffprobe-parse",
              `ffprobe stdout JSON parse failed: ${String(e)}`,
              stderr,
              exitCode,
            ),
          ),
        );
        return;
      }
      finish(() => resolve({ stdout, parsed }));
    });
  });
}

interface FfprobeFrame {
  media_type?: string;
  pkt_dts_time?: string;
  dts_time?: string;
  pkt_pts_time?: string;
  pts_time?: string;
  best_effort_timestamp_time?: string;
}

/**
 * Pull monotonically-ordered video PTS (seconds) from an ffprobe -show_frames
 * JSON payload. Prefers pkt_dts_time, falls back to pkt_pts_time, then
 * best_effort_timestamp_time. Drops frames where no timestamp field is present.
 * Caller must reject the row (error, not pass) if the returned array is empty.
 */
export function extractVideoPts(framesJson: unknown): number[] {
  const obj = framesJson as { frames?: FfprobeFrame[] } | null;
  if (!obj || !Array.isArray(obj.frames)) return [];
  const pts: number[] = [];
  for (const f of obj.frames) {
    if (f.media_type && f.media_type !== "video") continue;
    const raw =
      f.pkt_dts_time ??
      f.dts_time ??
      f.pkt_pts_time ??
      f.pts_time ??
      f.best_effort_timestamp_time ??
      null;
    if (raw == null) continue;
    const v = parseFloat(raw);
    if (Number.isFinite(v)) pts.push(v);
  }
  return pts;
}

/**
 * §6.1 cadence + dup-PTS analysis on seconds-domain PTS values.
 * - dup count: consecutive PTS deltas < ½ nominal frame interval.
 * - cadence: mean / 95p / 99p of inter-frame intervals.
 */
export function analyzePtsCadence(
  ptsSeconds: number[],
  nominalFps: number,
): {
  frameCount: number;
  meanIntervalS: number;
  p95IntervalS: number;
  p99IntervalS: number;
  duplicatedPtsCount: number;
  nominalIntervalS: number;
} {
  const nominalIntervalS = nominalFps > 0 ? 1 / nominalFps : 0;
  const halfFrameS = nominalIntervalS / 2;

  let dupCount = 0;
  const intervals: number[] = [];
  for (let i = 1; i < ptsSeconds.length; i++) {
    const delta = (ptsSeconds[i] ?? 0) - (ptsSeconds[i - 1] ?? 0);
    if (Math.abs(delta) < halfFrameS) dupCount++;
    if (delta > 0) intervals.push(delta);
  }

  const sorted = [...intervals].sort((a, b) => a - b);
  const pct = (p: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(
      sorted.length - 1,
      Math.floor((p / 100) * sorted.length),
    );
    return sorted[idx] ?? 0;
  };
  const mean =
    intervals.length === 0
      ? 0
      : intervals.reduce((a, b) => a + b, 0) / intervals.length;

  return {
    frameCount: ptsSeconds.length,
    meanIntervalS: mean,
    p95IntervalS: pct(95),
    p99IntervalS: pct(99),
    duplicatedPtsCount: dupCount,
    nominalIntervalS,
  };
}
