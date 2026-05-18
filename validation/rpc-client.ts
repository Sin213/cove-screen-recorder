import * as net from "net";

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number | string; message: string; data?: unknown };
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type PendingHandler = {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
};

type NotifyWaiter = {
  method: string;
  resolve: (n: RpcNotification) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RpcClient {
  private sock: net.Socket;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingHandler>();
  private notifications: RpcNotification[] = [];
  private notifyWaiters: NotifyWaiter[] = [];
  private closed = false;

  private constructor(sock: net.Socket) {
    this.sock = sock;
    this.sock.on("data", (chunk: Buffer) => this.onData(chunk));
    this.sock.on("error", (err: Error) => this.onError(err));
    this.sock.on("close", () => {
      this.closed = true;
    });
  }

  static connect(socketPath: string, timeoutMs = 5_000): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ path: socketPath }, () => {
        sock.setTimeout(0);
        sock.removeAllListeners("error");
        resolve(new RpcClient(sock));
      });
      sock.setTimeout(timeoutMs, () => {
        sock.destroy();
        reject(new Error(`RPC connect timeout after ${timeoutMs}ms`));
      });
      sock.on("error", (err: Error) => {
        sock.destroy();
        reject(err);
      });
    });
  }

  async call(
    method: string,
    params?: unknown,
    timeoutMs = 10_000,
  ): Promise<RpcResponse> {
    if (this.closed) throw new Error("RpcClient is closed");
    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });
    const payloadBytes = Buffer.byteLength(payload);
    const buf = Buffer.alloc(4 + payloadBytes);
    buf.writeUInt32BE(payloadBytes, 0);
    buf.write(payload, 4);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC call ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.sock.write(buf, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  waitNotification(
    method: string,
    timeoutMs = 30_000,
  ): Promise<RpcNotification> {
    const existing = this.notifications.find((n) => n.method === method);
    if (existing) {
      this.notifications.splice(this.notifications.indexOf(existing), 1);
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.notifyWaiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.notifyWaiters.splice(idx, 1);
        reject(
          new Error(
            `Timed out waiting for notification ${method} after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.notifyWaiters.push({ method, resolve, timer });
    });
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.sock.destroy();
    }
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const frameLen = this.buf.readUInt32BE(0);
      if (frameLen > 1_048_576) {
        this.close();
        return;
      }
      if (this.buf.length < 4 + frameLen) break;
      const payload = this.buf.subarray(4, 4 + frameLen).toString("utf8");
      this.buf = this.buf.subarray(4 + frameLen);
      try {
        const msg = JSON.parse(payload) as Record<string, unknown>;
        if ("id" in msg && msg.id !== undefined && msg.id !== null) {
          const handler = this.pending.get(msg.id as number);
          if (handler) {
            this.pending.delete(msg.id as number);
            handler.resolve(msg as unknown as RpcResponse);
          }
        } else if ("method" in msg) {
          const notif = msg as unknown as RpcNotification;
          const waiterIdx = this.notifyWaiters.findIndex(
            (w) => w.method === notif.method,
          );
          if (waiterIdx >= 0) {
            const waiter = this.notifyWaiters[waiterIdx]!;
            this.notifyWaiters.splice(waiterIdx, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(notif);
          } else {
            this.notifications.push(notif);
          }
        }
      } catch {
        // malformed frame — skip
      }
    }
  }

  private onError(err: Error): void {
    for (const [id, handler] of this.pending) {
      handler.reject(err);
      this.pending.delete(id);
    }
  }
}
