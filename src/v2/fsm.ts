// V2 FSM states — N-007 renderer state machine
export type V2State =
  | "BOOTING"
  | "IDLE"
  | "PICKING"
  | "STARTING"
  | "RECORDING"
  | "SAVING"
  | "EXPORTING"
  | "RECOVERY_AVAILABLE"
  | "ENGINE_DOWN"
  | "ENGINE_UNAVAILABLE";

export interface V2EngineInfo {
  helperVersion: string;
  protocolVersion: number;
}

// Wire-format shape of recoverable session (snake_case, no re-keying by main.ts)
export interface V2RecoverableSession {
  session_id: string;
  started_at: number;
  duration_s: number;
  bytes_on_disk: number;
  segments_count: number;
  has_discontinuity: boolean;
}

export function canSaveReplay(s: V2State): boolean {
  return s === "RECORDING";
}

export function isEngineDown(s: V2State): boolean {
  return s === "ENGINE_DOWN" || s === "ENGINE_UNAVAILABLE";
}
