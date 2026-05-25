// V2 FSM states — N-007 renderer state machine
export type V2State =
  | "BOOTING"
  | "IDLE"
  | "PICKING"
  | "STARTING"
  | "RECORDING"
  | "SAVING"
  | "EXPORTING"
  | "ENGINE_DOWN"
  | "ENGINE_UNAVAILABLE";

export interface V2EngineInfo {
  helperVersion: string;
  protocolVersion: number;
}

export function canSaveReplay(s: V2State): boolean {
  return s === "RECORDING";
}

export function isEngineDown(s: V2State): boolean {
  return s === "ENGINE_DOWN" || s === "ENGINE_UNAVAILABLE";
}
