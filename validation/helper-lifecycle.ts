import { execSync, spawn, spawnSync, ChildProcess } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RpcClient } from "./rpc-client";

export interface SpawnedHelper {
  pid: number;
  process: ChildProcess;
  socketPath: string;
  exited: boolean;
  cleanup: () => void;
}

export interface PgrepResult {
  coveReplayEngine: number[];
  ffmpeg: number[];
  pactl: number[];
}

export function runnerOwnedSocketPath(): string {
  const xdgRuntime = process.env["XDG_RUNTIME_DIR"];
  const base = xdgRuntime ?? path.join(os.tmpdir(), `cove-${process.getuid?.() ?? "user"}`);
  const tag = crypto.randomBytes(4).toString("hex");
  return path.join(base, "cove-screen-recorder", `runner-${tag}.sock`);
}

function findHelperBinary(): string {
  const candidates = [
    path.resolve("target/debug/cove-replay-engine"),
    path.resolve("target/release/cove-replay-engine"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Helper binary not found. Tried: ${candidates.join(", ")}. Run: cargo build -p cove-replay-engine`,
  );
}

export function spawnHelper(socketPath: string, extraArgs: string[] = []): Promise<SpawnedHelper> {
  const binary = findHelperBinary();
  const socketDir = path.dirname(socketPath);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });

  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  const child = spawn(binary, ["--ipc-socket", socketPath, ...extraArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const state = { exited: false };
  child.on("exit", () => {
    state.exited = true;
  });

  const cleanup = (): void => {
    if (!state.exited) {
      child.kill("SIGTERM");
    }
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Helper did not create socket within 10 s"));
    }, 10_000);

    const check = setInterval(() => {
      if (fs.existsSync(socketPath)) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve({
          pid: child.pid!,
          process: child,
          socketPath,
          get exited() {
            return state.exited;
          },
          cleanup,
        });
      }
    }, 100);

    child.on("error", (err: Error) => {
      clearInterval(check);
      clearTimeout(timeout);
      reject(err);
    });

    child.on("exit", (code) => {
      clearInterval(check);
      clearTimeout(timeout);
      reject(
        new Error(`Helper exited with code ${code} before socket was ready`),
      );
    });
  });
}

export async function shutdownHelper(rpc: RpcClient): Promise<unknown> {
  const resp = await rpc.call("engine.shutdown", undefined, 5_000);
  return resp.result;
}

export class PgrepUnavailableError extends Error {
  constructor(tool: string, detail: string) {
    super(`${tool} unavailable or failed: ${detail}`);
    this.name = "PgrepUnavailableError";
  }
}

function assertPgrepAvailable(): void {
  try {
    execSync("command -v pgrep", { encoding: "utf8", timeout: 3_000 });
  } catch {
    throw new PgrepUnavailableError("pgrep", "not found on PATH");
  }
}

export function pgrepCheck(baseline?: PgrepResult): PgrepResult {
  assertPgrepAvailable();

  const uid = process.getuid?.() ?? 0;
  const result: PgrepResult = {
    coveReplayEngine: [],
    ffmpeg: [],
    pactl: [],
  };

  const procs: Array<[keyof PgrepResult, string]> = [
    ["coveReplayEngine", "cove-replay-eng"],
    ["ffmpeg", "ffmpeg"],
    ["pactl", "pactl"],
  ];

  for (const [key, name] of procs) {
    try {
      const { status, stdout } = spawnSync(
        "pgrep", ["-u", String(uid), "-x", name],
        { encoding: "utf8", timeout: 5_000 },
      );
      if (status === 0 && stdout.trim()) {
        const baselineSet = new Set(baseline?.[key] ?? []);
        result[key] = stdout
          .trim()
          .split("\n")
          .map(Number)
          .filter((n) => !isNaN(n) && n > 0 && !baselineSet.has(n));
      } else if (status !== 0 && status !== 1) {
        throw new PgrepUnavailableError("pgrep", `exit code ${status} for ${name}`);
      }
    } catch (err) {
      if (err instanceof PgrepUnavailableError) throw err;
      throw new PgrepUnavailableError("pgrep", `failed for ${name}: ${String(err)}`);
    }
  }

  return result;
}

export function sigtermSpawned(spawned: SpawnedHelper): void {
  if (!spawned.exited) {
    process.kill(spawned.pid, "SIGTERM");
  }
}

export function getDescendantProcessNames(rootPid: number): string[] {
  const { status, stdout, error } = spawnSync(
    "ps", ["-e", "-o", "pid=,ppid=,comm="],
    { encoding: "utf8", timeout: 5_000 },
  );

  if (error) {
    throw new PgrepUnavailableError("ps", `failed: ${String(error)}`);
  }

  if (status !== 0) {
    throw new PgrepUnavailableError("ps", `exit code ${status}`);
  }

  const children = new Map<number, number[]>();
  const commMap = new Map<number, string>();

  for (const line of stdout.trim().split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0]!, 10);
    const ppid = parseInt(parts[1]!, 10);
    const comm = parts.slice(2).join(" ");
    if (isNaN(pid) || isNaN(ppid)) continue;
    commMap.set(pid, comm);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }

  const result: string[] = [];
  const stack = children.get(rootPid) ?? [];
  while (stack.length > 0) {
    const childPid = stack.pop()!;
    const comm = commMap.get(childPid);
    if (comm) result.push(comm);
    const grandchildren = children.get(childPid);
    if (grandchildren) stack.push(...grandchildren);
  }

  return result;
}
