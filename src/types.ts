export type {
  AppInfo,
  CaptureFormat,
  CaptureMode,
  CaptureSource,
  CoveApi,
  CropRect,
  CropSelectionResult,
  FfmpegInfo,
  FinalizeParams,
  FinalizeResult,
  LogLevel,
  Preset,
  PresetId,
  RecordingProgress,
  StartRecordingParams,
} from "../electron/types";

export interface LogEntry {
  id: string;
  ts: number;
  level: "info" | "good" | "warn" | "error";
  text: string;
}
