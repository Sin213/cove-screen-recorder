// Ambient Window extension for the v2 helper API (N-007 §2).
// Consumed by the renderer via tsconfig.json "include": ["src"].
// Implemented by electron/preload.ts → ipcMain handlers in electron/main.ts.

type UnsubscribeFn = () => void;

interface CoveApiEngine {
  version(): Promise<{ helperVersion: string; protocolVersion: number }>;
  status(): Promise<{
    state: string;
    uptimeMs: number;
    activeSessions: number;
    activeSnapshots: number;
    activeExports: number;
    lastErrorTs?: number;
    diagnosticsDir: string;
    rollingBufferBytes: number;
  }>;
  restart(): Promise<void>;
  openDiagnosticsBundle(): Promise<void>;
  onReady(cb: (info: { helperVersion: string; protocolVersion: number }) => void): UnsubscribeFn;
  onCrashed(cb: () => void): UnsubscribeFn;
  onStateChanged(cb: (state: string) => void): UnsubscribeFn;
  onLogLine(cb: (line: string) => void): UnsubscribeFn;
}

interface CoveApiCapture {
  listSources(): Promise<{ sources: Array<{ id: string; kind: string; title: string }> }>;
  requestSession(params: unknown): Promise<unknown>;
  startStream(params: unknown): Promise<unknown>;
  pauseStream(params: unknown): Promise<unknown>;
  resumeStream(params: unknown): Promise<unknown>;
  stopSession(params: unknown): Promise<unknown>;
  setRegion(params: unknown): Promise<unknown>;
  setFramerateHint(params: unknown): Promise<unknown>;
  setCursorMode(params: unknown): Promise<unknown>;
  onSessionReady(cb: (params: unknown) => void): UnsubscribeFn;
  onFormatChanged(cb: (params: unknown) => void): UnsubscribeFn;
  onStreamPaused(cb: (params: unknown) => void): UnsubscribeFn;
  onStreamResumed(cb: (params: unknown) => void): UnsubscribeFn;
  onSessionLost(cb: (params: unknown) => void): UnsubscribeFn;
  onDiagnostics(cb: (params: unknown) => void): UnsubscribeFn;
}

interface CoveApiEncoder {
  onProbeResult(cb: (params: unknown) => void): UnsubscribeFn;
  onSelected(cb: (params: unknown) => void): UnsubscribeFn;
  onFallbackEngaged(cb: (params: unknown) => void): UnsubscribeFn;
  onRuntimeError(cb: (params: unknown) => void): UnsubscribeFn;
  onBackPressure(cb: (params: unknown) => void): UnsubscribeFn;
  onDiagnostics(cb: (params: unknown) => void): UnsubscribeFn;
}

interface CoveApiReplay {
  save(params: unknown): Promise<unknown>;
  snapshotRelease(params: unknown): Promise<unknown>;
  recoverableSessions(): Promise<unknown>;
  discardRecoveredSession(params: unknown): Promise<unknown>;
  restoreRecoveredSession(params: unknown): Promise<unknown>;
  exportStart(params: unknown): Promise<unknown>;
  exportCancel(params: unknown): Promise<unknown>;
  onSegmentDiagnostics(cb: (params: unknown) => void): UnsubscribeFn;
  onRecoveryAvailable(cb: (params: unknown) => void): UnsubscribeFn;
  onSnapshotPinned(cb: (params: unknown) => void): UnsubscribeFn;
  onSnapshotReleased(cb: (params: unknown) => void): UnsubscribeFn;
}

interface CoveApiExport {
  onQueued(cb: (params: unknown) => void): UnsubscribeFn;
  onStarted(cb: (params: unknown) => void): UnsubscribeFn;
  onProgress(cb: (params: unknown) => void): UnsubscribeFn;
  onStalled(cb: (params: unknown) => void): UnsubscribeFn;
  onCompleted(cb: (params: unknown) => void): UnsubscribeFn;
  onFailed(cb: (params: unknown) => void): UnsubscribeFn;
  onCancelled(cb: (params: unknown) => void): UnsubscribeFn;
  onRejected(cb: (params: unknown) => void): UnsubscribeFn;
}

interface CoveApiSettings {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  onChanged(cb: (params: { key: string; value: unknown }) => void): UnsubscribeFn;
}

interface CoveApiHotkeys {
  get(): Promise<Record<string, string>>;
  set(bindings: Record<string, string>): Promise<void>;
  onTriggered(cb: (action: string) => void): UnsubscribeFn;
  onRefused(cb: (params: unknown) => void): UnsubscribeFn;
  onBindFailed(cb: (params: unknown) => void): UnsubscribeFn;
}

interface CoveApiEnv {
  probe(): Promise<unknown>;
  onProbeChanged(cb: (params: unknown) => void): UnsubscribeFn;
}

interface CoveApiV2 {
  engine: CoveApiEngine;
  capture: CoveApiCapture;
  encoder: CoveApiEncoder;
  replay: CoveApiReplay;
  export: CoveApiExport;
  settings: CoveApiSettings;
  hotkeys: CoveApiHotkeys;
  env: CoveApiEnv;
}

declare global {
  interface Window {
    coveApi: CoveApiV2;
  }
}

export {};
