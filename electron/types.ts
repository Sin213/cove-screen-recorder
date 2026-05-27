export type CaptureMode = "screen" | "window" | "area";
export type PresetId = "regular" | "gaming" | "gif" | "custom";

export interface HotkeyBindFailedPayload {
  action: "toggle" | "gif" | "replay";
  accelerator: string;
  reason: "invalid" | "reserved" | "conflict" | "error";
  detail: string;
}

export interface CustomQuality {
  fps: number;            // 15-120
  videoBitsPerSecond: number;  // 1_000_000 - 50_000_000
  scaleHeight: number;    // 360 - 2160 (output height; aspect preserved)
}

export interface LibraryEntry {
  path: string;
  name: string;          // basename
  bytes: number;
  modified: number;      // unix ms
  durationSec: number | null;  // probed via ffmpeg, null if unknown
  thumbDataUrl: string | null;  // generated lazily, may be null
}
export type CaptureFormat = "mp4" | "webm" | "gif";
export type LogLevel = "info" | "good" | "warn" | "error";

export interface CaptureSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnailDataUrl: string;
  appIconDataUrl?: string;
  display_id?: string;
  // Windows-only display metadata (populated from screen.getAllDisplays() and DXGI)
  scale_factor?: number;
  refresh_rate_hz?: number;
  dxgi_adapter_index?: number;
  dxgi_output_index?: number;
  hdr_capable?: boolean;
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
  // Skip the Linux PulseAudio sidecar for sessions that intentionally do not
  // want main-process system audio capture.
  skipAudioSidecar?: boolean;
  // Instant replay cannot silently degrade when Linux system audio was
  // requested because the save is expected to include that audio.
  isReplay?: boolean;
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
  // When set, finalize keeps only the last N ms of the captured stream.
  // Used by replay saves so the input remains one continuous MediaRecorder
  // WebM and ffmpeg performs the actual tail trim.
  trimLastMs?: number;
  // Replay timing metadata, in Date.now() milliseconds, used to align Linux
  // sidecar audio with the MediaRecorder video timeline.
  mediaStartedAtMs?: number;
  mediaStoppedAtMs?: number;
  // Nominal capture fps from the resolved preset. Plumbed through so the
  // mp4 remux path can pin CFR output and write consistent r_frame_rate /
  // avg_frame_rate metadata — without it many players read the WebM's
  // VFR cluster timestamps and stop after ~1 s of playback.
  fps: number;
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
  setHotkeyBindings: (bindings: { toggle?: string; gif?: string; replay?: string }) => Promise<void>;
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
  openFile: (path: string) => Promise<void>;

  // Instant replay buffer (driven entirely from the renderer in v1.0.1 —
  // these IPC entries are reserved for moving the buffer into the main
  // process if memory pressure becomes an issue).
  replayStart: (opts: ReplayStartParams) => Promise<{ ok: boolean; error?: string }>;
  replayStop: () => Promise<void>;
  replaySave: () => Promise<{ ok: boolean; outputPath?: string; error?: string }>;
  onReplayState: (cb: (state: ReplayState) => void) => () => void;

  onHotkey: (cb: (action: "toggle" | "gif" | "preview" | "replay") => void) => () => void;
  onProgress: (cb: (p: RecordingProgress) => void) => () => void;

  windowMinimize: () => void;
  windowToggleMaximize: () => void;
  windowClose: () => void;
}

export interface ReplayStartParams {
  outputDir: string;
  preset: PresetId;
  withMic: boolean;
  withSystemAudio: boolean;
  lengthSeconds: number;
  source: CaptureSource | null;  // user-picked source or null for portal flow
}

export interface ReplayState {
  active: boolean;
  bufferedSeconds: number;
  error?: string;
}
