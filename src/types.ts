export type {
  AppInfo,
  CaptureFormat,
  CaptureMode,
  CaptureSource,
  CoveApi,
  CropRect,
  CropSelectionResult,
  CustomQuality,
  FfmpegInfo,
  FinalizeParams,
  FinalizeResult,
  LogLevel,
  Preset,
  PresetId,
  RecordingProgress,
  ReplayStartParams,
  ReplayState,
  StartRecordingParams,
  UpdateEvent,
} from "../electron/types";

export interface LogEntry {
  id: string;
  ts: number;
  level: "info" | "good" | "warn" | "error";
  text: string;
}

export type ReplayQuality = "performance" | "balanced" | "quality" | "native";
