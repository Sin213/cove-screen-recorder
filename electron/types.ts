export type CaptureMode = "screen" | "window" | "area";
export type PresetId = "regular" | "gaming" | "gif";
export type CaptureFormat = "mp4" | "webm" | "gif";
export type LogLevel = "info" | "good" | "warn" | "error";

export interface CaptureSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnailDataUrl: string;
  appIconDataUrl?: string;
  display_id?: string;
}

export interface Preset {
  id: PresetId;
  name: string;
  hint: string;
  format: CaptureFormat;
  mimeType: string;
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  fps: number;
  audio: boolean;
}

export interface StartRecordingParams {
  mode: CaptureMode;
  preset: PresetId;
  outputDir: string;
  withMic: boolean;
  withSystemAudio: boolean;
  sourceId: string;
  sourceName: string;
}

export interface SaveChunkParams {
  recordingId: string;
  buffer: ArrayBuffer;
}

export interface FinalizeParams {
  recordingId: string;
  preset: PresetId;
  format: CaptureFormat;
  durationMs: number;
}

export interface FinalizeResult {
  ok: boolean;
  outputPath?: string;
  error?: string;
}

export interface RecordingProgress {
  // Optional — diagnostic messages from the recorder (e.g. audio sidecar
  // startup) aren't tied to a specific recording session.
  recordingId?: string;
  stage: "encoding" | "muxing" | "done" | "error";
  percent?: number;
  message?: string;
  outputPath?: string;
}

export interface FfmpegInfo {
  available: boolean;
  path?: string;
  version?: string;
  encoders: string[];
}

export interface AppInfo {
  version: string;
  platform: string;
  sessionType: string | null;
  ffmpeg: FfmpegInfo;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
  displayId: string;
  displayWidth: number;
  displayHeight: number;
  sourceId: string;
}

export interface CropSelectionResult {
  rect: CropRect;
  // Source is omitted on Wayland — the renderer fulfils the source via
  // navigator.mediaDevices.getDisplayMedia() to keep portal prompts at one.
  source?: CaptureSource;
}

export interface CoveApi {
  getAppInfo: () => Promise<AppInfo>;
  listSources: (kind?: "screen" | "window" | "all") => Promise<CaptureSource[]>;
  selectCropRegion: () => Promise<CropSelectionResult | null>;
  pickOutputDir: () => Promise<string | null>;
  openFolder: (dir: string) => Promise<void>;
  revealInFolder: (path: string) => Promise<void>;

  beginRecording: (params: StartRecordingParams) => Promise<{ recordingId: string }>;
  saveChunk: (recordingId: string, buffer: ArrayBuffer) => Promise<void>;
  finalizeRecording: (params: FinalizeParams) => Promise<FinalizeResult>;
  cancelRecording: (recordingId: string) => Promise<void>;

  registerHotkeys: (enabled: boolean) => Promise<void>;
  setHotkeyBindings: (bindings: { toggle?: string; gif?: string }) => Promise<void>;
  adjustWindowHeight: (deltaPx: number) => Promise<void>;

  // Wayland: control which source kinds the next getDisplayMedia() call asks
  // the portal for, then read back which the user chose.
  setNextDisplayMedia: (kind: "screen" | "window" | "all") => Promise<void>;
  getLastDisplayMediaSelection: () => Promise<{
    id: string;
    name: string;
    kind: "screen" | "window";
  } | null>;

  // Windows / X11: tell the display-media handler which user-picked source
  // (from desktopCapturer) to hand back. Routing through the handler is
  // also how we get system audio working — Chromium honors `audio:"loopback"`
  // through this path; the legacy chromeMediaSource constraint doesn't.
  setPickedDisplayMediaSource: (sourceId: string | null) => Promise<void>;

  onHotkey: (cb: (action: "toggle" | "gif" | "preview") => void) => () => void;
  onProgress: (cb: (p: RecordingProgress) => void) => () => void;

  windowMinimize: () => void;
  windowToggleMaximize: () => void;
  windowClose: () => void;
}
