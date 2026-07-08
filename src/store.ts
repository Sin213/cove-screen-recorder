import { create } from "zustand";
import type { AppInfo, CaptureMode, LogEntry, PresetId, ReplayQuality } from "./types";
import type { V2EngineInfo, V2State } from "./v2/fsm";

const KEY_MODE = "cove:mode";
const KEY_PRESET = "cove:preset";
const KEY_OUTPUT_DIR = "cove:output-dir";
const KEY_MIC = "cove:mic";
const KEY_SYS = "cove:sys";
const KEY_HOTKEYS = "cove:hotkeys";
const KEY_LOG_COLLAPSED = "cove:log-collapsed";
const KEY_HOTKEY_BINDINGS = "cove:hotkey-bindings";
const KEY_CUSTOM_QUALITY = "cove:custom-quality";
const KEY_REPLAY = "cove:replay";

const MAX_LOGS = 120;

function readString(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeString(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}
function readBool(key: string, dflt: boolean): boolean {
  const v = readString(key);
  if (v === "true") return true;
  if (v === "false") return false;
  return dflt;
}
function writeBool(key: string, v: boolean): void { writeString(key, String(v)); }

export interface HotkeyBindings {
  toggle: string;  // start / stop default capture
  gif: string;     // crop-and-record GIF
  replay: string;  // save the last N minutes from the replay buffer
}

const DEFAULT_HOTKEY_BINDINGS: HotkeyBindings = {
  toggle: "F9",
  gif: "F10",
  replay: "F8",
};

function readHotkeyBindings(): HotkeyBindings {
  const raw = readString(KEY_HOTKEY_BINDINGS);
  if (!raw) return DEFAULT_HOTKEY_BINDINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<HotkeyBindings>;
    return {
      toggle: typeof parsed.toggle === "string" && parsed.toggle ? parsed.toggle : DEFAULT_HOTKEY_BINDINGS.toggle,
      gif: typeof parsed.gif === "string" && parsed.gif ? parsed.gif : DEFAULT_HOTKEY_BINDINGS.gif,
      replay: typeof parsed.replay === "string" && parsed.replay ? parsed.replay : DEFAULT_HOTKEY_BINDINGS.replay,
    };
  } catch {
    return DEFAULT_HOTKEY_BINDINGS;
  }
}

function writeHotkeyBindings(b: HotkeyBindings): void {
  writeString(KEY_HOTKEY_BINDINGS, JSON.stringify(b));
}

export { DEFAULT_HOTKEY_BINDINGS };

export interface ReplaySettings {
  enabled: boolean;
  // Buffer length in seconds. Slider in UI shows minutes (0.5 - 20).
  lengthSeconds: number;
  // Replay quality preset — controls dimensions, fps, and bitrate of the
  // MediaRecorder pipeline. Default = balanced (1080p60); see
  // REPLAY_QUALITY_PRESETS in presets.ts. Persisted so a user only has to
  // pick once.
  quality: ReplayQuality;
}

const VALID_REPLAY_QUALITIES: ReplayQuality[] = ["performance", "balanced", "quality", "native"];
const DEFAULT_REPLAY: ReplaySettings = {
  enabled: false,
  lengthSeconds: 5 * 60,
  quality: "balanced",
};

function readReplaySettings(): ReplaySettings {
  const raw = readString(KEY_REPLAY);
  if (!raw) return DEFAULT_REPLAY;
  try {
    const parsed = JSON.parse(raw) as Partial<ReplaySettings>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_REPLAY.enabled,
      lengthSeconds: typeof parsed.lengthSeconds === "number" && Number.isFinite(parsed.lengthSeconds)
        ? Math.min(300, Math.max(30, parsed.lengthSeconds))
        : DEFAULT_REPLAY.lengthSeconds,
      quality: typeof parsed.quality === "string" && VALID_REPLAY_QUALITIES.includes(parsed.quality as ReplayQuality)
        ? (parsed.quality as ReplayQuality)
        : DEFAULT_REPLAY.quality,
    };
  } catch {
    return DEFAULT_REPLAY;
  }
}

function writeReplaySettings(s: ReplaySettings): void {
  writeString(KEY_REPLAY, JSON.stringify(s));
}

import { CUSTOM_QUALITY_DEFAULTS } from "./presets";
import type { CustomQuality } from "./types";

function readCustomQuality(): CustomQuality {
  const raw = readString(KEY_CUSTOM_QUALITY);
  if (!raw) return CUSTOM_QUALITY_DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<CustomQuality>;
    return {
      fps: clamp(parsed.fps, 15, 120, CUSTOM_QUALITY_DEFAULTS.fps),
      videoBitsPerSecond: clamp(parsed.videoBitsPerSecond, 1_000_000, 50_000_000, CUSTOM_QUALITY_DEFAULTS.videoBitsPerSecond),
      scaleHeight: clamp(parsed.scaleHeight, 360, 2160, CUSTOM_QUALITY_DEFAULTS.scaleHeight),
    };
  } catch {
    return CUSTOM_QUALITY_DEFAULTS;
  }
}

function writeCustomQuality(q: CustomQuality): void {
  writeString(KEY_CUSTOM_QUALITY, JSON.stringify(q));
}

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function readInitialMode(): CaptureMode {
  const v = readString(KEY_MODE);
  if (v === "window" || v === "area" || v === "screen") return v;
  return "area";
}
function readInitialPreset(): PresetId {
  const v = readString(KEY_PRESET);
  if (v === "gaming" || v === "gif") return v;
  return "regular";
}

export type RecorderStatus = "idle" | "preparing" | "recording" | "finalizing";

export type ToastType = "info" | "success" | "warning" | "error";

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration: number; // ms, 0 = persistent
}

// Auto-dismiss defaults per toast type. duration: 0 opts out (persistent).
const TOAST_DURATION_MS: Record<ToastType, number> = {
  info: 3000,
  success: 4000,
  warning: 5000,
  error: 6000,
};

// Cap the visible stack; oldest toasts are dropped first.
const MAX_TOASTS = 5;

interface State {
  appInfo: AppInfo | null;

  mode: CaptureMode;
  preset: PresetId;
  outputDir: string | null;
  withMic: boolean;
  withSystemAudio: boolean;
  hotkeysEnabled: boolean;

  status: RecorderStatus;
  recordingId: string | null;
  startedAt: number | null;
  elapsedMs: number;
  lastOutputPath: string | null;
  lastError: string | null;

  logs: LogEntry[];
  logCollapsed: boolean;

  hotkeyBindings: HotkeyBindings;

  customQuality: CustomQuality;
  replay: ReplaySettings;

  // ── V2 FSM state ──────────────────────────────────────────────────────────
  v2State: V2State;
  v2EngineInfo: V2EngineInfo | null;
  v2SessionId: string | null;
  v2SessionReadyMs: number | null;
  v2SnapshotId: string | null;
  v2SnapshotHeld: boolean;
  v2ExportId: string | null;
  v2ExportProgress: number | null;
  v2ExportOutputPath: string | null;
  v2BlockReason: { code: string; detail?: string } | null;
  setV2State: (s: V2State) => void;
  setV2EngineInfo: (info: V2EngineInfo | null) => void;
  setV2SessionId: (id: string | null) => void;
  setV2SessionReadyMs: (ms: number | null) => void;
  setV2SnapshotId: (id: string | null) => void;
  setV2SnapshotHeld: (held: boolean) => void;
  setV2ExportId: (id: string | null) => void;
  setV2ExportProgress: (pct: number | null) => void;
  setV2ExportOutputPath: (p: string | null) => void;
  setV2BlockReason: (r: { code: string; detail?: string } | null) => void;

  setAppInfo: (info: AppInfo) => void;
  setMode: (m: CaptureMode) => void;
  setPreset: (p: PresetId) => void;
  setOutputDir: (dir: string | null) => void;
  setMic: (v: boolean) => void;
  setSystemAudio: (v: boolean) => void;
  setHotkeys: (v: boolean) => void;
  setLogCollapsed: (v: boolean) => void;
  setHotkeyBindings: (b: HotkeyBindings) => void;

  setCustomQuality: (q: CustomQuality) => void;
  setReplay: (s: ReplaySettings) => void;

  setStatus: (s: RecorderStatus) => void;
  setRecording: (id: string | null) => void;
  tickElapsed: () => void;
  resetElapsed: () => void;
  setLastOutput: (p: string | null) => void;
  setLastError: (e: string | null) => void;

  log: (level: LogEntry["level"], text: string) => void;
  clearLogs: () => void;

  toasts: Toast[];
  addToast: (type: ToastType, message: string, opts?: { duration?: number }) => string;
  removeToast: (id: string) => void;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useStore = create<State>((set, get) => ({
  appInfo: null,

  mode: readInitialMode(),
  preset: readInitialPreset(),
  outputDir: readString(KEY_OUTPUT_DIR),
  withMic: readBool(KEY_MIC, false),
  withSystemAudio: readBool(KEY_SYS, true),
  hotkeysEnabled: readBool(KEY_HOTKEYS, true),
  hotkeyBindings: readHotkeyBindings(),
  customQuality: readCustomQuality(),
  replay: readReplaySettings(),
  logCollapsed: readBool(KEY_LOG_COLLAPSED, true),

  status: "idle",
  recordingId: null,
  startedAt: null,
  elapsedMs: 0,
  lastOutputPath: null,
  lastError: null,

  logs: [],

  v2State: "BOOTING",
  v2EngineInfo: null,
  v2SessionId: null,
  v2SessionReadyMs: null,
  v2SnapshotId: null,
  v2SnapshotHeld: false,
  v2ExportId: null,
  v2ExportProgress: null,
  v2ExportOutputPath: null,
  v2BlockReason: null,
  setAppInfo: (info) => set({ appInfo: info }),
  setMode: (mode) => { writeString(KEY_MODE, mode); set({ mode }); },
  setPreset: (preset) => { writeString(KEY_PRESET, preset); set({ preset }); },
  setOutputDir: (dir) => { writeString(KEY_OUTPUT_DIR, dir); set({ outputDir: dir }); },
  setMic: (v) => { writeBool(KEY_MIC, v); set({ withMic: v }); },
  setSystemAudio: (v) => { writeBool(KEY_SYS, v); set({ withSystemAudio: v }); },
  setHotkeys: (v) => { writeBool(KEY_HOTKEYS, v); set({ hotkeysEnabled: v }); },
  setLogCollapsed: (v) => { writeBool(KEY_LOG_COLLAPSED, v); set({ logCollapsed: v }); },
  setHotkeyBindings: (b) => { writeHotkeyBindings(b); set({ hotkeyBindings: b }); },
  setCustomQuality: (q) => { writeCustomQuality(q); set({ customQuality: q }); },
  setReplay: (s) => { writeReplaySettings(s); set({ replay: s }); },

  setStatus: (status) => set({ status }),
  setRecording: (id) => set({ recordingId: id, startedAt: id ? Date.now() : null, elapsedMs: 0 }),
  tickElapsed: () => {
    const s = get();
    if (s.startedAt) set({ elapsedMs: Date.now() - s.startedAt });
  },
  resetElapsed: () => set({ startedAt: null, elapsedMs: 0 }),
  setLastOutput: (p) => set({ lastOutputPath: p }),
  setLastError: (e) => set({ lastError: e }),

  log: (level, text) =>
    set((state) => {
      const next = state.logs.length >= MAX_LOGS ? state.logs.slice(state.logs.length - MAX_LOGS + 1) : state.logs.slice();
      next.push({ id: makeId(), ts: Date.now(), level, text });
      return { logs: next };
    }),
  clearLogs: () => set({ logs: [] }),

  toasts: [],
  addToast: (type, message, opts) => {
    const id = makeId();
    const duration = opts?.duration ?? TOAST_DURATION_MS[type];
    set((state) => {
      const next = state.toasts.length >= MAX_TOASTS
        ? state.toasts.slice(state.toasts.length - MAX_TOASTS + 1)
        : state.toasts.slice();
      next.push({ id, type, message, duration });
      return { toasts: next };
    });
    return id;
  },
  removeToast: (id) =>
    set((state) => {
      if (!state.toasts.some((t) => t.id === id)) return state;
      return { toasts: state.toasts.filter((t) => t.id !== id) };
    }),

  setV2State: (v2State) => set({ v2State }),
  setV2EngineInfo: (v2EngineInfo) => set({ v2EngineInfo }),
  setV2SessionId: (v2SessionId) => set({ v2SessionId }),
  setV2SessionReadyMs: (v2SessionReadyMs) => set({ v2SessionReadyMs }),
  setV2SnapshotId: (v2SnapshotId) => set({ v2SnapshotId }),
  setV2SnapshotHeld: (v2SnapshotHeld) => set({ v2SnapshotHeld }),
  setV2ExportId: (v2ExportId) => set({ v2ExportId }),
  setV2ExportProgress: (v2ExportProgress) => set({ v2ExportProgress }),
  setV2ExportOutputPath: (v2ExportOutputPath) => set({ v2ExportOutputPath }),
  setV2BlockReason: (v2BlockReason) => set({ v2BlockReason }),
}));
