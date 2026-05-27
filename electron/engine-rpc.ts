import * as net from "node:net";
import { EventEmitter } from "node:events";

const MAX_FRAME_BYTES = 1 * 1024 * 1024; // 1 MiB
const HEADER_BYTES = 4;

// ── Domain types (N-007 §5) ───────────────────────────────────────────────────

export interface EngineVersionResult {
  helper_version: string;
  protocol_version: number;
}

export interface EngineHealthResult {
  state: string;
  uptime_ms: number;
  active_sessions: number;
  active_snapshots: number;
  active_exports: number;
  last_error_ts?: number;
  diagnostics_dir: string;
  rolling_buffer_bytes: number;
}

export interface CaptureSourceInfo {
  id: string;
  kind: string;
  title: string;
}

export interface WindowsMonitorInfo {
  device_name: string;
  adapter_index: number;
  output_index: number;
  width_px: number;
  height_px: number;
  refresh_rate_num: number;
  refresh_rate_den: number;
  is_primary: boolean;
  scale_factor: number;
  hdr_capable: boolean;
}

// Wire shape of capture.listSources response (matches CaptureSourceDescriptor in types.rs).
export interface CaptureSourceDescriptorResult {
  modes: string[];
  known_restore_tokens: unknown[];
  monitors?: WindowsMonitorInfo[];
}

// ── Internal types ────────────────────────────────────────────────────────────

type NotificationHandler = (params: unknown) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

// ── RPC client ────────────────────────────────────────────────────────────────

export class EngineRpc extends EventEmitter {
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private notifHandlers = new Map<string, Set<NotificationHandler>>();
  private nextId = 1;
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ path: socketPath });
      sock.once("connect", () => {
        this._connected = true;
        this.sock = sock;
        resolve();
      });
      sock.once("error", (err) => {
        if (!this._connected) reject(err);
      });
      sock.on("data", (chunk: Buffer) => this.onData(chunk));
      sock.once("close", () => {
        this._connected = false;
        this.sock = null;
        this.rejectAllPending();
        this.emit("disconnect");
      });
    });
  }

  disconnect(): void {
    const s = this.sock;
    if (s) {
      this.sock = null;
      this._connected = false;
      s.destroy();
      this.rejectAllPending();
    }
  }

  // ── Sending ─────────────────────────────────────────────────────────────────

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.sock || !this._connected) {
      return Promise.reject(
        Object.assign(new Error("helper-disconnected"), { code: "helper-disconnected" }),
      );
    }
    const id = this.nextId++;
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) }),
      "utf8",
    );
    const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, HEADER_BYTES);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.sock!.write(frame, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  // ── Receiving ───────────────────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  private drain(): void {
    while (this.buf.length >= HEADER_BYTES) {
      const frameLen = this.buf.readUInt32BE(0);
      if (frameLen > MAX_FRAME_BYTES) {
        this.sock?.destroy(new Error(`oversized frame: ${frameLen} bytes`));
        return;
      }
      if (this.buf.length < HEADER_BYTES + frameLen) break;
      const body = this.buf.subarray(HEADER_BYTES, HEADER_BYTES + frameLen);
      this.buf = this.buf.subarray(HEADER_BYTES + frameLen);
      this.dispatchFrame(body);
    }
  }

  private dispatchFrame(body: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      return; // malformed — drop
    }

    if (typeof msg["method"] === "string") {
      // Server-sent notification (no id field)
      const method = msg["method"];
      const params = msg["params"];
      const handlers = this.notifHandlers.get(method);
      if (handlers) {
        for (const h of handlers) h(params);
      }
      this.emit("notification", method, params);
    } else if ("id" in msg) {
      // Response to one of our requests
      const id = msg["id"] as number;
      const pend = this.pending.get(id);
      if (!pend) return; // mismatched id — drop
      this.pending.delete(id);
      const errObj = msg["error"];
      if (errObj !== undefined && errObj !== null) {
        const e = errObj as { code: number | string; message: string };
        pend.reject(Object.assign(new Error(e.message ?? "rpc error"), { rpcCode: e.code }));
      } else {
        pend.resolve(msg["result"]);
      }
    }
  }

  private rejectAllPending(): void {
    const err = Object.assign(new Error("helper-disconnected"), { code: "helper-disconnected" });
    for (const pend of this.pending.values()) pend.reject(err);
    this.pending.clear();
  }

  // ── Notification subscriptions ──────────────────────────────────────────────

  onNotification(method: string, handler: NotificationHandler): void {
    let set = this.notifHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notifHandlers.set(method, set);
    }
    set.add(handler);
  }

  offNotification(method: string, handler: NotificationHandler): void {
    this.notifHandlers.get(method)?.delete(handler);
  }

  // ── Typed facades (N-007 §5) ─────────────────────────────────────────────────

  engineVersion(): Promise<EngineVersionResult> {
    return this.call("engine.version");
  }

  engineHealth(): Promise<EngineHealthResult> {
    return this.call("engine.health");
  }

  engineSetLogLevel(level: string): Promise<null> {
    return this.call("engine.setLogLevel", { level });
  }

  engineShutdown(deadlineMs: number): Promise<{ ok: boolean }> {
    return this.call("engine.shutdown", { deadlineMs });
  }

  engineDiagnosticsBundlePath(): Promise<{ path: string }> {
    return this.call("engine.diagnosticsBundlePath");
  }

  captureListSources(): Promise<CaptureSourceDescriptorResult> {
    return this.call<CaptureSourceDescriptorResult>("capture.listSources");
  }

  captureRequestSession(params: unknown): Promise<unknown> {
    return this.call("capture.requestSession", params);
  }

  captureStartStream(params: unknown): Promise<unknown> {
    return this.call("capture.startStream", params);
  }

  capturePauseStream(params: unknown): Promise<unknown> {
    return this.call("capture.pauseStream", params);
  }

  captureResumeStream(params: unknown): Promise<unknown> {
    return this.call("capture.resumeStream", params);
  }

  captureStopSession(params: unknown): Promise<unknown> {
    return this.call("capture.stopSession", params);
  }

  captureSetRegion(params: unknown): Promise<unknown> {
    return this.call("capture.setRegion", params);
  }

  captureSetFramerateHint(params: unknown): Promise<unknown> {
    return this.call("capture.setFramerateHint", params);
  }

  captureSetCursorMode(params: unknown): Promise<unknown> {
    return this.call("capture.setCursorMode", params);
  }

  replaySave(params: unknown): Promise<unknown> {
    return this.call("replay.save", params);
  }

  replaySnapshotRelease(params: unknown): Promise<unknown> {
    return this.call("replay.snapshot_release", params);
  }

  replayRecoverableSessions(): Promise<unknown> {
    return this.call("replay.recoverable_sessions");
  }

  replayDiscardRecoveredSession(params: unknown): Promise<unknown> {
    return this.call("replay.discard_recovered_session", params);
  }

  replayRestoreRecoveredSession(params: unknown): Promise<unknown> {
    return this.call("replay.restore_recovered_session", params);
  }

  replayExportStart(params: unknown): Promise<unknown> {
    return this.call("replay.export_start", params);
  }

  replayExportCancel(params: unknown): Promise<unknown> {
    return this.call("replay.export_cancel", params);
  }
}
