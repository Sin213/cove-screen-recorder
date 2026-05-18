export type RowClassification = "scripted-local" | "manual" | "future-ci";
export type RowStatus = "pass" | "fail" | "skip" | "error";
export type SkipReason = "helper-not-available" | "manual" | "future-ci" | "dependency-failed" | "not-implemented";
export type RowTier = "must-pass" | "should-pass" | "informational";
export type SuiteKind = "smoke" | "rc";
export type Verdict = "pass" | "fail" | "skip" | "error";

export interface ThresholdResult {
  name: string;
  observed: number | string | null;
  required: string;
  passed: boolean;
}

/** N-008 §7 evidence bundle paths, all optional in the dry-run case. */
export interface EvidenceBundle {
  diagnosticsBundle: string;
  captureJson: string;
  encoderJson: string;
  segmentsJson: string;
  /** key = exportId */
  exportJson: Record<string, string>;
  outMp4: string;
  outMp4FfprobeJson: string;
  outMp4MediainfoJson: string;
  prePgrep: string;
  postPgrep: string;
  rendererEventsJsonl: string;
  dmesgTail: string;
  /** Row-specific evidence not covered by the N-008 §7 bundle schema. */
  extra: Record<string, string>;
}

/** Per-row result emitted by the runner. */
export interface RowReport {
  id: string;
  title: string;
  classification: RowClassification;
  tier: RowTier;
  ownerOnFail: string;
  linkedSourceCase: string | null;
  status: RowStatus;
  skipReason?: SkipReason;
  message?: string;
  durationMs?: number;
  evidencePaths?: Partial<EvidenceBundle>;
  thresholds?: ThresholdResult[];
  /** exportId → terminal event name; null until the row executes. */
  terminalEvent?: Record<string, string> | null;
}

/** Top-level report written after a suite run. */
export interface SuiteReport {
  schema: "cove-validation-report/v1";
  suite: SuiteKind;
  startedAt: string;
  completedAt: string;
  rows: RowReport[];
  totalPass: number;
  totalFail: number;
  totalSkip: number;
  totalError: number;
  verdict: Verdict;
  /** Smoke only: true if the run halted on the first must-pass red. */
  stoppedEarly?: boolean;
  stoppedAtRow?: string;
}
