import { contextBridge, ipcRenderer } from "electron";
import type {
  AppInfo,
  CaptureSource,
  CoveApi,
  CropSelectionResult,
  FinalizeParams,
  FinalizeResult,
  RecordingProgress,
  ReplayStartParams,
  ReplayState,
  StartRecordingParams,
} from "./types";

const api: CoveApi = {
  getAppInfo: () => ipcRenderer.invoke("cove:get-app-info") as Promise<AppInfo>,
  listSources: (kind = "all") =>
    ipcRenderer.invoke("cove:list-sources", kind) as Promise<CaptureSource[]>,
  selectCropRegion: () =>
    ipcRenderer.invoke("cove:select-crop-region") as Promise<CropSelectionResult | null>,
  pickOutputDir: () => ipcRenderer.invoke("cove:pick-output-dir") as Promise<string | null>,
  openFolder: (dir) => ipcRenderer.invoke("cove:open-folder", dir),
  revealInFolder: (p) => ipcRenderer.invoke("cove:reveal", p),
  listRecordings: (dir, limit) =>
    ipcRenderer.invoke("cove:list-recordings", dir, limit) as Promise<import("./types").LibraryEntry[]>,

  beginRecording: (params: StartRecordingParams) =>
    ipcRenderer.invoke("cove:begin-recording", params) as Promise<{ recordingId: string }>,
  saveChunk: (recordingId, buffer) =>
    ipcRenderer.invoke("cove:save-chunk", recordingId, buffer),
  finalizeRecording: (params: FinalizeParams) =>
    ipcRenderer.invoke("cove:finalize-recording", params) as Promise<FinalizeResult>,
  cancelRecording: (recordingId) =>
    ipcRenderer.invoke("cove:cancel-recording", recordingId),

  registerHotkeys: (enabled) => ipcRenderer.invoke("cove:register-hotkeys", enabled),
  setHotkeyBindings: (bindings) => ipcRenderer.invoke("cove:set-hotkey-bindings", bindings) as Promise<void>,
  adjustWindowHeight: (deltaPx) => ipcRenderer.invoke("cove:adjust-window-height", deltaPx) as Promise<void>,

  setNextDisplayMedia: (kind) =>
    ipcRenderer.invoke("cove:set-next-display-media", kind) as Promise<void>,
  getLastDisplayMediaSelection: () =>
    ipcRenderer.invoke("cove:get-last-display-media-selection") as Promise<
      { id: string; name: string; kind: "screen" | "window" } | null
    >,
  setPickedDisplayMediaSource: (sourceId) =>
    ipcRenderer.invoke("cove:set-picked-display-media-source", sourceId) as Promise<void>,
  openFile: (p) => ipcRenderer.invoke("cove:open-file", p) as Promise<void>,

  replayStart: (opts: ReplayStartParams) =>
    ipcRenderer.invoke("cove:replay-start", opts) as Promise<{ ok: boolean; error?: string }>,
  replayStop: () => ipcRenderer.invoke("cove:replay-stop") as Promise<void>,
  replaySave: () => ipcRenderer.invoke("cove:replay-save") as Promise<{ ok: boolean; outputPath?: string; error?: string }>,
  onReplayState: (cb: (s: ReplayState) => void) => {
    const listener = (_: unknown, state: ReplayState) => cb(state);
    ipcRenderer.on("cove:replay-state", listener);
    return () => ipcRenderer.removeListener("cove:replay-state", listener);
  },
  onHotkey: (cb) => {
    const listener = (_: unknown, action: "toggle" | "gif" | "preview" | "replay") => cb(action);
    ipcRenderer.on("cove:hotkey", listener);
    return () => ipcRenderer.removeListener("cove:hotkey", listener);
  },
  onProgress: (cb) => {
    const listener = (_: unknown, p: RecordingProgress) => cb(p);
    ipcRenderer.on("cove:progress", listener);
    return () => ipcRenderer.removeListener("cove:progress", listener);
  },

  windowMinimize: () => ipcRenderer.send("cove:window-minimize"),
  windowToggleMaximize: () => ipcRenderer.send("cove:window-toggle-maximize"),
  windowClose: () => ipcRenderer.send("cove:window-close"),
};

contextBridge.exposeInMainWorld("cove", api);

// ── v2 helper API (N-007 §2) ─────────────────────────────────────────────────
// Exposed alongside the v1.1.0 "cove" surface; v1.1.0 renderer code is
// untouched until T-020 migrates App.tsx to use window.coveApi.

type UnsubFn = () => void;

function onCh<T>(channel: string, cb: (v: T) => void): UnsubFn {
  const listener = (_: Electron.IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Main-process v2 handlers always return a plain envelope object.
// Using a plain object (not a thrown Error) means the code field survives
// Electron's structured clone serialization deterministically.
type RpcEnvelope = { ok: true; result: unknown } | { ok: false; code: string; message: string };

function callRpc(channel: string, params?: unknown): Promise<unknown> {
  return ipcRenderer.invoke(channel, params).then((env: RpcEnvelope) => {
    if (!env.ok) {
      throw Object.assign(new Error(env.message), { code: env.code });
    }
    return env.result;
  });
}

const coveApiV2 = {
  engine: {
    version: () => callRpc("cove/engine/version"),
    status: () => callRpc("cove/engine/status"),
    restart: () => callRpc("cove/engine/restart"),
    openDiagnosticsBundle: () => callRpc("cove/engine/openDiagnosticsBundle"),
    onReady: (cb: (info: { helperVersion: string; protocolVersion: number }) => void) =>
      onCh("cove/engine/ready", cb),
    onCrashed: (cb: () => void) => onCh("cove/engine/crashed", cb),
    onStateChanged: (cb: (state: string) => void) => onCh("cove/engine/stateChanged", cb),
    onLogLine: (cb: (line: string) => void) => onCh("cove/engine/logLine", cb),
    onBlocked: (cb: (reason: { code: string }) => void) => onCh("cove/engine/blocked", cb),
  },
  capture: {
    listSources: () => callRpc("cove/capture/listSources"),
    requestSession: (params: unknown) => callRpc("cove/capture/requestSession", params),
    startStream: (params: unknown) => callRpc("cove/capture/startStream", params),
    pauseStream: (params: unknown) => callRpc("cove/capture/pauseStream", params),
    resumeStream: (params: unknown) => callRpc("cove/capture/resumeStream", params),
    stopSession: (params: unknown) => callRpc("cove/capture/stopSession", params),
    setRegion: (params: unknown) => callRpc("cove/capture/setRegion", params),
    setFramerateHint: (params: unknown) => callRpc("cove/capture/setFramerateHint", params),
    setCursorMode: (params: unknown) => callRpc("cove/capture/setCursorMode", params),
    onSessionReady: (cb: (v: unknown) => void) => onCh("cove/capture/sessionReady", cb),
    onFormatChanged: (cb: (v: unknown) => void) => onCh("cove/capture/formatChanged", cb),
    onStreamPaused: (cb: (v: unknown) => void) => onCh("cove/capture/streamPaused", cb),
    onStreamResumed: (cb: (v: unknown) => void) => onCh("cove/capture/streamResumed", cb),
    onSessionLost: (cb: (v: unknown) => void) => onCh("cove/capture/sessionLost", cb),
    onDiagnostics: (cb: (v: unknown) => void) => onCh("cove/capture/diagnostics", cb),
  },
  encoder: {
    onProbeResult: (cb: (v: unknown) => void) => onCh("cove/encoder/probeResult", cb),
    onSelected: (cb: (v: unknown) => void) => onCh("cove/encoder/selected", cb),
    onFallbackEngaged: (cb: (v: unknown) => void) => onCh("cove/encoder/fallbackEngaged", cb),
    onRuntimeError: (cb: (v: unknown) => void) => onCh("cove/encoder/runtimeError", cb),
    onBackPressure: (cb: (v: unknown) => void) => onCh("cove/encoder/backPressure", cb),
    onDiagnostics: (cb: (v: unknown) => void) => onCh("cove/encoder/diagnostics", cb),
  },
  replay: {
    save: (params: unknown) => callRpc("cove/replay/save", params),
    snapshotRelease: (params: unknown) => callRpc("cove/replay/snapshotRelease", params),
    recoverableSessions: () => callRpc("cove/replay/recoverableSessions"),
    discardRecoveredSession: (params: unknown) =>
      callRpc("cove/replay/discardRecoveredSession", params),
    restoreRecoveredSession: (params: unknown) =>
      callRpc("cove/replay/restoreRecoveredSession", params),
    exportStart: (params: unknown) => callRpc("cove/replay/exportStart", params),
    exportCancel: (params: unknown) => callRpc("cove/replay/exportCancel", params),
    onSegmentDiagnostics: (cb: (v: unknown) => void) =>
      onCh("cove/replay/segmentDiagnostics", cb),
    onRecoveryAvailable: (cb: (v: unknown) => void) =>
      onCh("cove/replay/recoveryAvailable", cb),
    onSnapshotPinned: (cb: (v: unknown) => void) => onCh("cove/replay/snapshotPinned", cb),
    onSnapshotReleased: (cb: (v: unknown) => void) => onCh("cove/replay/snapshotReleased", cb),
  },
  export: {
    onQueued: (cb: (v: unknown) => void) => onCh("cove/export/queued", cb),
    onStarted: (cb: (v: unknown) => void) => onCh("cove/export/started", cb),
    onProgress: (cb: (v: unknown) => void) => onCh("cove/export/progress", cb),
    onStalled: (cb: (v: unknown) => void) => onCh("cove/export/stalled", cb),
    onCompleted: (cb: (v: unknown) => void) => onCh("cove/export/completed", cb),
    onFailed: (cb: (v: unknown) => void) => onCh("cove/export/failed", cb),
    onCancelled: (cb: (v: unknown) => void) => onCh("cove/export/cancelled", cb),
    onRejected: (cb: (v: unknown) => void) => onCh("cove/export/rejected", cb),
  },
  settings: {
    get: (key: string) => callRpc("cove/settings/get", key),
    set: (key: string, value: unknown) => callRpc("cove/settings/set", { key, value }),
    onChanged: (cb: (v: { key: string; value: unknown }) => void) =>
      onCh("cove/settings/changed", cb),
  },
  hotkeys: {
    get: () => callRpc("cove/hotkeys/get"),
    set: (bindings: Record<string, string>) => callRpc("cove/hotkeys/set", bindings),
    onTriggered: (cb: (action: string) => void) => onCh("cove/hotkeys/triggered", cb),
    onRefused: (cb: (v: unknown) => void) => onCh("cove/hotkeys/refused", cb),
    onBindFailed: (cb: (v: unknown) => void) => onCh("cove/hotkeys/bindFailed", cb),
  },
  env: {
    probe: () => callRpc("cove/env/probe"),
    onProbeChanged: (cb: (v: unknown) => void) => onCh("cove/env/probeChanged", cb),
  },
};

contextBridge.exposeInMainWorld("coveApi", coveApiV2);

export type { FinalizeResult };
