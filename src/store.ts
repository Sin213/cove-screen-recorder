import { create } from "zustand";
import type { AppInfo, CaptureMode, LogEntry, PresetId } from "./types";

const KEY_MODE = "cove:mode";
const KEY_PRESET = "cove:preset";
const KEY_OUTPUT_DIR = "cove:output-dir";
const KEY_MIC = "cove:mic";
const KEY_SYS = "cove:sys";
const KEY_HOTKEYS = "cove:hotkeys";
const KEY_LOG_COLLAPSED = "cove:log-collapsed";
const KEY_HOTKEY_BINDINGS = "cove:hotkey-bindings";

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
}

const DEFAULT_HOTKEY_BINDINGS: HotkeyBindings = {
  toggle: "Ctrl+Shift+R",
  gif: "Ctrl+Shift+G",
};

function readHotkeyBindings(): HotkeyBindings {
  const raw = readString(KEY_HOTKEY_BINDINGS);
  if (!raw) return DEFAULT_HOTKEY_BINDINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<HotkeyBindings>;
    return {
      toggle: typeof parsed.toggle === "string" && parsed.toggle ? parsed.toggle : DEFAULT_HOTKEY_BINDINGS.toggle,
      gif: typeof parsed.gif === "string" && parsed.gif ? parsed.gif : DEFAULT_HOTKEY_BINDINGS.gif,
    };
  } catch {
    return DEFAULT_HOTKEY_BINDINGS;
  }
}

function writeHotkeyBindings(b: HotkeyBindings): void {
  writeString(KEY_HOTKEY_BINDINGS, JSON.stringify(b));
}

export { DEFAULT_HOTKEY_BINDINGS };

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

  setAppInfo: (info: AppInfo) => void;
  setMode: (m: CaptureMode) => void;
  setPreset: (p: PresetId) => void;
  setOutputDir: (dir: string | null) => void;
  setMic: (v: boolean) => void;
  setSystemAudio: (v: boolean) => void;
  setHotkeys: (v: boolean) => void;
  setLogCollapsed: (v: boolean) => void;
  setHotkeyBindings: (b: HotkeyBindings) => void;

  setStatus: (s: RecorderStatus) => void;
  setRecording: (id: string | null) => void;
  tickElapsed: () => void;
  resetElapsed: () => void;
  setLastOutput: (p: string | null) => void;
  setLastError: (e: string | null) => void;

  log: (level: LogEntry["level"], text: string) => void;
  clearLogs: () => void;
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
  logCollapsed: readBool(KEY_LOG_COLLAPSED, true),

  status: "idle",
  recordingId: null,
  startedAt: null,
  elapsedMs: 0,
  lastOutputPath: null,
  lastError: null,

  logs: [],

  setAppInfo: (info) => set({ appInfo: info }),
  setMode: (mode) => { writeString(KEY_MODE, mode); set({ mode }); },
  setPreset: (preset) => { writeString(KEY_PRESET, preset); set({ preset }); },
  setOutputDir: (dir) => { writeString(KEY_OUTPUT_DIR, dir); set({ outputDir: dir }); },
  setMic: (v) => { writeBool(KEY_MIC, v); set({ withMic: v }); },
  setSystemAudio: (v) => { writeBool(KEY_SYS, v); set({ withSystemAudio: v }); },
  setHotkeys: (v) => { writeBool(KEY_HOTKEYS, v); set({ hotkeysEnabled: v }); },
  setLogCollapsed: (v) => { writeBool(KEY_LOG_COLLAPSED, v); set({ logCollapsed: v }); },
  setHotkeyBindings: (b) => { writeHotkeyBindings(b); set({ hotkeyBindings: b }); },

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
}));
