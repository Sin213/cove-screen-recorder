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
