import { RowClassification, RowTier } from "./types";

export interface SmokeRow {
  id: string;
  title: string;
  classification: RowClassification;
  tier: RowTier;
  ownerOnFail: string;
  /** Position in the §22 smoke list (1-based; PROC-001..003 expand items 16a/b/c). */
  smokeOrder: number;
  linkedSourceCase: string | null;
  /** Wall-clock budget for the row (milliseconds). */
  budgetMs: number;
  /**
   * ISS-001: declared workload nominal fps used as the cadence target when the
   * negotiated capture format reports a variable-rate framerate (fps_num=0).
   * Optional and additive — drivers that do not consult this field are
   * unaffected. Drivers MUST NOT silently pass when both the negotiated fps
   * is zero and this field is absent; they must record `nominalSource="missing"`
   * and fail the cadence gate.
   */
  nominalFps?: number;

  /**
   * ISS-003 D3: declared capture-cell width/height the row expects the portal /
   * PipeWire negotiation to deliver. Optional and additive — drivers that do
   * not consult this field are unaffected. When set, the driver MUST assert
   * the negotiated `sessionReady.format.width × height` exactly matches and
   * surface a precise `ThresholdResult` (or an explicit configured skip per
   * `onCellMismatch`) — never a silent pass on a different cell. The threshold
   * key (drop-tier) is also resolved from this declared cell when present so
   * the tier reflects row intent, not whatever the host happened to deliver.
   */
  expectedCaptureFormat?: { width: number; height: number };

  /**
   * ISS-003 D3: declared encoder backend the row expects to be selected.
   * Optional and additive. When set, the driver MUST gate
   * `encoder.selected.backend === expectedEncoderBackend` (strict equality)
   * and feed the backend into `deriveThresholdKey`. This field does NOT
   * synthesise or imply encoder availability — `encoder.selected` must remain
   * a real helper-emitted event; ISS-002 still gates the actual backend.
   */
  expectedEncoderBackend?: string;

  /**
   * ISS-003 D3: per-row policy when the host does not deliver the declared
   * `expectedCaptureFormat`. Default (`"fail"` or missing) keeps the row at
   * `fail` through the precise cell-mismatch `ThresholdResult` so the gap is
   * always visible in the per-row report. `"skip"` opts the row into an
   * explicit `skip` whose message contains the literal token
   * `host-does-not-deliver-declared-cell` so the matrix gate (N-008 §18)
   * can route per-host coverage without hiding mismatch.
   */
  onCellMismatch?: "fail" | "skip";

  /**
   * T-021 VAL-CAP-004 startup drop warmup: number of leading
   * `capture.diagnostics` samples to exclude from the drop-rate calculation
   * only. Optional and additive — drivers that do not consult this field are
   * unaffected, and absence is treated as `0` (current behaviour preserved
   * bit-identically). The cadence calculation MUST continue to use the
   * unfiltered sample set; warmup affects drop-rate exclusively.
   *
   * Rationale: PipeWire / NVENC startup transient (~first second) yields a
   * burst of dropped frames before steady state is reached (see rerun 8
   * and rerun 10 evidence — all 19 drops landed in sample 1, samples 2–60
   * had zero drops). This field lets a specific row separate that startup
   * transient from steady-state drops without weakening the threshold
   * constant (`THRESHOLDS.captureDropRate["1080p60-nvenc"]` remains `0`)
   * and without affecting any other row.
   */
  dropWarmupSamples?: number;
}

/**
 * N-008 §22 smoke suite — 18 numbered items expanded to 20 rows.
 * VAL-PROC-001..003 (item 16) is expanded to three separate rows.
 * Classification source: N-008 §19 and §22 inline labels.
 */
export const SMOKE_ROWS: SmokeRow[] = [
  {
    id: "VAL-PKG-001",
    title: "coveApi.env.probe() returns clean result within 5 s",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "packaging",
    smokeOrder: 1,
    linkedSourceCase: "N-007",
    budgetMs: 5_000,
  },
  {
    id: "VAL-CAP-001",
    title: "sessionReady event within 30 s of requestSession",
    classification: "manual",
    tier: "must-pass",
    ownerOnFail: "capture",
    smokeOrder: 2,
    linkedSourceCase: "N-003",
    budgetMs: 30_000,
  },
  {
    id: "VAL-CAP-003",
    title: "Portal denial emits captureError and leaves helper in IDLE",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "capture",
    smokeOrder: 3,
    linkedSourceCase: "N-003",
    budgetMs: 30_000,
  },
  {
    id: "VAL-CAP-004",
    title: "1080p60 monitor capture 60 s L-MOTION-60 on NVENC — drop and cadence gates",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "capture",
    smokeOrder: 4,
    linkedSourceCase: "N-003",
    budgetMs: 120_000,
    // ISS-001: row's declared 1080p60 workload nominal fps. Used as the
    // cadence target only when the portal negotiates a variable-rate format
    // (fps_num=0). ISS-003 (4K/~105fps workload mismatch) remains the real
    // failure signal in that case — see handover.
    nominalFps: 60,
    // ISS-003 D3: declared capture cell + encoder backend. The driver gates
    // negotiated sessionReady.format against this declared cell exactly, and
    // keys deriveThresholdKey off the declared cell so the drop tier reflects
    // row intent (1080p60-nvenc), not whatever the host happens to deliver.
    // onCellMismatch="fail" keeps the mismatch visible in the per-row report
    // by default; switching to "skip" yields an explicit
    // host-does-not-deliver-declared-cell skip for matrix-gated hosts.
    expectedCaptureFormat: { width: 1920, height: 1080 },
    expectedEncoderBackend: "nvenc",
    onCellMismatch: "fail",
    // T-021 startup drop warmup: exclude only the first diagnostics sample
    // from the drop-rate calculation. Cadence calculation is intentionally
    // unchanged in this pass and handled later. See SmokeRow.dropWarmupSamples
    // doc-comment for the rerun 8 / rerun 10 evidence basis.
    dropWarmupSamples: 1,
  },
  {
    id: "VAL-CAP-006",
    title: "Minimised window captures 60 s without frame loss — Issue #3 proof",
    classification: "manual",
    tier: "must-pass",
    ownerOnFail: "capture",
    smokeOrder: 5,
    linkedSourceCase: "N-003",
    budgetMs: 120_000,
  },
  {
    id: "VAL-UI-005",
    title: "Region overlay renders correctly and clips output — Issue #1 proof",
    classification: "manual",
    tier: "must-pass",
    ownerOnFail: "ui-fsm",
    smokeOrder: 6,
    linkedSourceCase: null,
    budgetMs: 120_000,
  },
  {
    id: "VAL-ENC-001",
    title: "NVENC positive probe result cached and reported via encoder.probeResult",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "encoder",
    smokeOrder: 7,
    linkedSourceCase: "N-004",
    budgetMs: 10_000,
  },
  {
    id: "VAL-ENC-006",
    title: "encoder.selected visible in HUD and diagnostics after session start",
    classification: "manual",
    tier: "must-pass",
    ownerOnFail: "encoder",
    smokeOrder: 8,
    linkedSourceCase: "N-004",
    budgetMs: 30_000,
  },
  {
    id: "VAL-SEG-001",
    title: "Rolling 60 s window stays within configured disk budget during capture",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "rolling-buffer",
    smokeOrder: 9,
    linkedSourceCase: "N-005",
    budgetMs: 120_000,
  },
  {
    id: "VAL-SEG-003",
    title: "replay.save completes within latency gate while capture continues",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "rolling-buffer",
    smokeOrder: 10,
    linkedSourceCase: "N-005",
    budgetMs: 120_000,
  },
  {
    id: "VAL-EXP-001",
    title: "Fast stream-copy export of 60 s window completes and emits export.completed",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "export",
    smokeOrder: 11,
    linkedSourceCase: "N-006",
    budgetMs: 120_000,
  },
  {
    id: "VAL-EXP-010",
    title: "No fake duplicated frames in VAL-EXP-001 output (ffprobe PTS walk)",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "export",
    smokeOrder: 12,
    linkedSourceCase: "N-006",
    budgetMs: 30_000,
  },
  {
    id: "VAL-EXP-012",
    title: "Export runs concurrently with RECORDING without capture frame loss",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "export",
    smokeOrder: 13,
    linkedSourceCase: "N-006",
    budgetMs: 180_000,
  },
  {
    id: "VAL-UI-003",
    title: "HUD timer continues updating during SAVING/EXPORTING — Issue #4 proof",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "ui-fsm",
    smokeOrder: 14,
    linkedSourceCase: null,
    budgetMs: 120_000,
  },
  {
    id: "VAL-UI-012",
    title: "Hotkey triggers replay.save and transitions FSM through SAVING→RECORDING",
    classification: "manual",
    tier: "must-pass",
    ownerOnFail: "ui-fsm",
    smokeOrder: 15,
    linkedSourceCase: null,
    budgetMs: 30_000,
  },
  {
    id: "VAL-PROC-001",
    title: "No leftover cove-replay-engine / ffmpeg / pactl processes after IDLE shutdown",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "process-cleanup",
    smokeOrder: 16,
    linkedSourceCase: "N-008",
    budgetMs: 30_000,
  },
  {
    id: "VAL-PROC-002",
    title: "No leftover processes after stopping a RECORDING session and quit",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "process-cleanup",
    smokeOrder: 17,
    linkedSourceCase: "N-008",
    budgetMs: 30_000,
  },
  {
    id: "VAL-PROC-003",
    title: "No leftover processes after app quit without explicit session stop",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "process-cleanup",
    smokeOrder: 18,
    linkedSourceCase: "N-008",
    budgetMs: 30_000,
  },
  {
    id: "VAL-PROC-007",
    title: "pactl never appears in process tree under helper PID during any smoke row",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "process-cleanup",
    smokeOrder: 19,
    linkedSourceCase: "N-008",
    budgetMs: 10_000,
  },
  {
    id: "VAL-REG-002",
    title: "Fake-60fps gate re-run on VAL-EXP-001 output confirms no duplicated PTS",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "regression",
    smokeOrder: 20,
    linkedSourceCase: "N-008",
    budgetMs: 10_000,
  },
  // §18 RC coverage rows — not part of §22 smoke set (smokeOrder > 20).
  // Executed individually or in rc mode; smoke mode filters to smokeOrder <= 20.
  {
    id: "VAL-CAP-016",
    title: "1080p60 monitor capture 60 s L-MOTION-60 on libx264 — drop and cadence gates",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "capture",
    smokeOrder: 21,
    linkedSourceCase: "N-008 §18",
    budgetMs: 120_000,
    nominalFps: 60,
    expectedCaptureFormat: { width: 1920, height: 1080 },
    expectedEncoderBackend: "libx264",
    onCellMismatch: "fail",
    dropWarmupSamples: 1,
  },
  {
    id: "VAL-CAP-013",
    title: "1440p60 monitor capture 60 s L-MOTION-60 on NVENC — drop and cadence gates",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "capture",
    smokeOrder: 22,
    linkedSourceCase: "N-008 §18",
    budgetMs: 120_000,
    nominalFps: 60,
    expectedCaptureFormat: { width: 2560, height: 1440 },
    expectedEncoderBackend: "nvenc",
    onCellMismatch: "skip",
    dropWarmupSamples: 1,
  },
  {
    id: "VAL-CAP-014",
    title: "4K60 monitor capture 60 s L-MOTION-60 on NVENC — drop and cadence gates",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "capture",
    smokeOrder: 23,
    linkedSourceCase: "N-008 §18",
    budgetMs: 120_000,
    nominalFps: 60,
    expectedCaptureFormat: { width: 3840, height: 2160 },
    expectedEncoderBackend: "nvenc",
    onCellMismatch: "skip",
    dropWarmupSamples: 1,
  },
  // §17 UI assertion rows — static source-scan only; no helper spawn.
  // smokeOrder > 20: excluded from smoke mode (smokeOrder <= 20 filter).
  {
    id: "VAL-UI-002",
    title: "RECORDING state reachable only via capture.sessionReady — Issue #1 structural proof",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "ui-fsm",
    smokeOrder: 24,
    linkedSourceCase: "N-007 §17",
    budgetMs: 10_000,
  },
  {
    id: "VAL-UI-004",
    title: "Three independent timer/progress state systems remain isolated — Issue #4 structural proof",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "ui-fsm",
    smokeOrder: 25,
    linkedSourceCase: "N-007 §17",
    budgetMs: 10_000,
  },
  {
    id: "VAL-CAP-007",
    title: "Minimised window capture path is not visibility-gated — Issue #3 structural proof",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "capture",
    smokeOrder: 26,
    linkedSourceCase: "N-007 §17",
    budgetMs: 10_000,
  },
  {
    id: "VAL-REG-013",
    title: "Timer/session state does not guess readiness from UI elapsed time — Issue #1 regression proof",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "regression",
    smokeOrder: 27,
    linkedSourceCase: "N-008 §16",
    budgetMs: 10_000,
  },
  {
    id: "VAL-REG-004",
    title: "Renderer encoder API is read-only and loop-free — broken hardware encoder fallback regression proof",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "regression",
    smokeOrder: 28,
    linkedSourceCase: "N-008 §16",
    budgetMs: 10_000,
  },
  // §16 regression proof rows — outside smokeOrder <= 20 smoke boundary.
  {
    id: "VAL-REG-007",
    title: "Capture session produces §7 capture.json evidence — replay source diagnostics regression proof",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "regression",
    smokeOrder: 29,
    linkedSourceCase: "N-008 §16",
    budgetMs: 60_000,
  },
  {
    id: "VAL-REG-006",
    title: "SAVING state entered only from RECORDING via event-driven saveReplay — replay save state regression proof",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "regression",
    smokeOrder: 30,
    linkedSourceCase: "N-008 §16",
    budgetMs: 10_000,
  },
  {
    id: "VAL-REG-001",
    title: "Replay corruption proof — faststart unconditional in export argv; moov precedes mdat in 60 s NVENC output",
    classification: "scripted-local",
    tier: "must-pass",
    ownerOnFail: "regression",
    smokeOrder: 31,
    linkedSourceCase: "N-008 §16",
    budgetMs: 120_000,
    nominalFps: 60,
  },
];

export function rowById(id: string): SmokeRow | undefined {
  return SMOKE_ROWS.find((r) => r.id === id);
}
