import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

export interface TransportProbe {
  available: boolean;
  socketPath: string;
  error?: string;
}

function resolveSocketPath(): string {
  // N-007 §1: UDS at $XDG_RUNTIME_DIR/cove-screen-recorder/engine.sock on Linux/macOS.
  const xdgRuntime = process.env["XDG_RUNTIME_DIR"];
  const runtimeDir = xdgRuntime ?? path.join(os.tmpdir(), `cove-${process.getuid?.() ?? "user"}`);
  return path.join(runtimeDir, "cove-screen-recorder", "engine.sock");
}

/**
 * Probes the helper IPC socket per N-007 §1.
 * Returns immediately if the socket file is absent (no timeout cost).
 * Attempts a TCP-style connect if the file exists, with a 3 s timeout.
 */
export function probeSocket(): Promise<TransportProbe> {
  const socketPath = resolveSocketPath();

  if (!fs.existsSync(socketPath)) {
    return Promise.resolve({
      available: false,
      socketPath,
      error: "socket-file-absent",
    });
  }

  return new Promise((resolve) => {
    const sock = net.createConnection({ path: socketPath }, () => {
      sock.destroy();
      resolve({ available: true, socketPath });
    });

    sock.setTimeout(3_000, () => {
      sock.destroy();
      resolve({ available: false, socketPath, error: "connection-timeout" });
    });

    sock.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ available: false, socketPath, error: err.message });
    });
  });
}
