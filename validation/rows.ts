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
    title: "HUD timer continues updating ≥ 1 Hz during SAVING — Issue #4 proof",
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
];

export function rowById(id: string): SmokeRow | undefined {
  return SMOKE_ROWS.find((r) => r.id === id);
}
