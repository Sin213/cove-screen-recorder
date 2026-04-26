import { contextBridge, ipcRenderer } from "electron";
import type {
  AppInfo,
  CaptureSource,
  CoveApi,
  CropSelectionResult,
  FinalizeParams,
  FinalizeResult,
  RecordingProgress,
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
  onHotkey: (cb) => {
    const listener = (_: unknown, action: "toggle" | "gif" | "preview") => cb(action);
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

export type { FinalizeResult };
