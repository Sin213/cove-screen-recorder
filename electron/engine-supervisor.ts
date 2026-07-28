import { EventEmitter } from "node:events";
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { EngineRpc } from "./engine-rpc";

// ── Constants ─────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = 1;
const CONNECT_TIMEOUT_MS = 5_000;
const CONNECT_INTERVAL_MS = 250;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const SHUTDOWN_DEADLINE_MS = 5_000;
const SIGTERM_DELAY_MS = 5_000;
const SIGKILL_DELAY_MS = 7_000;
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 3;
const RESTART_DELAYS_MS: readonly number[] = [0, 2_000, 10_000];

// ── Types ─────────────────────────────────────────────────────────────────────

type SupervisorState =
  | "idle"
  | "starting"
  | "ready"
  | "restarting"
  | "shuttingDown"
  | "unavailable";

// ── Supervisor ────────────────────────────────────────────────────────────────

export class EngineSupervisor extends EventEmitter {
  private _rpc: EngineRpc | null = null;
  private proc: child_process.ChildProcess | null = null;
  private state: SupervisorState = "idle";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failureTimestamps: number[] = [];
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | null = null;
  private runningBoot: Promise<void> | null = null;

  // ── Public API ──────────────────────────────────────────────────────────────

  get rpcClient(): EngineRpc | null {
    return this._rpc;
  }

  get currentState(): SupervisorState {
    return this.state;
  }

  /** Start the supervisor. All errors are swallowed — the legacy path remains usable. */
  async start(): Promise<void> {
    if (this.state !== "idle") return;
    try {
      await this.bootCycle();
    } catch (err) {
      console.warn("[supervisor] start failed:", err);
      this.setState("unavailable");
      this.emit("unavailable", err);
    }
  }

  /**
   * Graceful shutdown: engine.shutdown RPC → SIGTERM at 5 s → SIGKILL at 7 s → cleanup.
   *
   * Idempotent and promise-reusing: re-entrant callers wait on the same
   * cleanup work. shutdownRequested is set synchronously so bootCycle checks
   * see it immediately, even before the first await in doShutdown().
   *
   * Runs cleanup even when state is "unavailable" — a failed boot may have left an
   * owned child process running. Adopted helpers receive engine.shutdown via RPC only;
   * we never signal a PID we did not spawn.
   */
  shutdown(): Promise<void> {
    this.shutdownRequested = true;
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  async restart(): Promise<void> {
    this.clearRestartTimer();
    await this.shutdown();
    this.shutdownRequested = false;
    this.shutdownPromise = null;
    await this.start();
  }

  private async doShutdown(): Promise<void> {
    // Cancel any pending auto-restart timer before taking lifecycle ownership.
    this.clearRestartTimer();

    // Wait for any in-flight boot to settle before touching this.proc.
    if (this.runningBoot) {
      await this.runningBoot.catch(() => {});
    }

    // If idle, nothing was ever started — nothing to clean up.
    if (this.state === "idle") return;

    this.setState("shuttingDown");
    this.stopHeartbeat();

    const rpc = this._rpc;
    const proc = this.proc;

    // 1. Send engine.shutdown RPC — covers both spawned and adopted helpers.
    //    Best-effort: 3 s timeout so quit does not hang.
    if (rpc?.connected) {
      try {
        await Promise.race([
          rpc.engineShutdown(SHUTDOWN_DEADLINE_MS),
          sleep(3_000).then(() => {
            throw new Error("rpc shutdown timeout");
          }),
        ]);
      } catch {
        // best-effort
      }
      rpc.disconnect();
      this._rpc = null;
    }

    // 2. Escalating kill — ONLY for processes we spawned (this.proc).
    //    Never signal an adopted PID: liveness alone is not ownership proof,
    //    and a reused PID could terminate an unrelated same-user process.
    if (proc && !proc.killed) {
      await killWithEscalation(proc);
    }

    this.cleanup();
    this.setState("idle");
  }

  // ── State machine ───────────────────────────────────────────────────────────

  private setState(s: SupervisorState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit("stateChanged", s);
  }

  // ── Path resolution ─────────────────────────────────────────────────────────

  private resolveSocketPath(): string {
    const xdg = process.env["XDG_RUNTIME_DIR"];
    if (xdg) return path.join(xdg, "cove-screen-recorder", "engine.sock");
    if (process.platform === "win32")
      return "\\\\.\\pipe\\cove-screen-recorder-engine";
    return path.join(app.getPath("temp"), "cove-screen-recorder", "engine.sock");
  }

  private resolvePidPath(): string {
    const xdg = process.env["XDG_RUNTIME_DIR"];
    if (xdg) return path.join(xdg, "cove-screen-recorder", "engine.pid");
    return path.join(app.getPath("temp"), "cove-screen-recorder", "engine.pid");
  }

  private resolveHelperBinary(): string {
    // Apply .exe extension on Windows for both packaged and dev paths.
    const ext = process.platform === "win32" ? ".exe" : "";
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "helper", `cove-replay-engine${ext}`);
    }
    return path.join(app.getAppPath(), "target", "debug", `cove-replay-engine${ext}`);
  }

  // ── Dependency sentinel check (Linux only) ─────────────────────────────────

  private checkDependencies(): void {
    if (process.platform !== "linux") return;
    const sentinels: ReadonlyArray<{ sentinel: string; dep: string }> = [
      {
        sentinel:
          "/usr/share/dbus-1/services/org.freedesktop.portal.Desktop.service",
        dep: "xdg-desktop-portal",
      },
      { sentinel: "/usr/bin/pipewire", dep: "pipewire" },
    ];
    for (const { sentinel, dep } of sentinels) {
      if (!fs.existsSync(sentinel)) {
        throw Object.assign(
          new Error(
            `required dependency not installed: ${dep} (sentinel: ${sentinel})`,
          ),
          { code: "missing-dependency" as const, detail: dep },
        );
      }
    }
  }

  // ── SHA-256 verification (packaged builds only) ─────────────────────────────

  private async verifySha256(binaryPath: string): Promise<void> {
    if (!app.isPackaged) {
      console.warn("[supervisor] dev mode: skipping SHA-256 verification");
      return;
    }
    const sidecarPath = `${binaryPath}.sha256`;
    let sidecar: string;
    try {
      sidecar = fs.readFileSync(sidecarPath, "utf8").trim();
    } catch (err) {
      throw new Error(`SHA-256 sidecar missing at ${sidecarPath}: ${err}`);
    }
    // Format: "<hex>  <filename>" (sha256sum standard output)
    const expectedHash = sidecar.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
      throw new Error(`malformed SHA-256 sidecar at ${sidecarPath}`);
    }
    const binData = fs.readFileSync(binaryPath);
    const actualHash = crypto.createHash("sha256").update(binData).digest("hex");
    if (actualHash !== expectedHash) {
      throw Object.assign(
        new Error(`SHA-256 mismatch for ${binaryPath}: expected ${expectedHash}, got ${actualHash}`),
        { code: "sha256-mismatch" as const },
      );
    }
  }

  // ── Orphan/adopt logic ──────────────────────────────────────────────────────

  /**
   * Spawn a fresh helper process unconditionally.
   * Handles SHA-256 verification, directory preparation, and process launch.
   * Used by both adoptOrSpawn (fresh start) and the adoption-fallback retry
   * in bootCycle when the adopted helper fails the socket/protocol handshake.
   */
  private async spawnFresh(
    socketPath: string,
    pidPath: string,
    binaryPath: string,
  ): Promise<child_process.ChildProcess> {
    await this.verifySha256(binaryPath);

    // Ensure directories — socket parent must be mode 0700 so the helper can
    // bind the socket without exposing it to other local users.
    if (process.platform !== "win32") {
      const sockDir = path.dirname(socketPath);
      ensureSocketDir(sockDir);
      // PID dir is the same directory in every current path resolution, but
      // handle a hypothetical divergence gracefully.
      const pidDir = path.dirname(pidPath);
      if (pidDir !== sockDir) {
        fs.mkdirSync(pidDir, { recursive: true });
      }
    } else {
      // Windows: named pipe needs no directory; create only the PID parent.
      fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    }

    const logDir = app.getPath("logs");
    const logLevel = process.env["HELPER_LOG_LEVEL"] ?? "info";

    // spawnHelper wraps spawn in a promise so spawn-time failures (ENOENT,
    // EACCES, invalid path) become rejected promises rather than unhandled
    // EventEmitter errors that could crash Electron main.
    const proc = await spawnHelper(
      binaryPath,
      [
        "--ipc-socket",
        socketPath,
        "--log-dir",
        logDir,
        "--log-level",
        logLevel,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        windowsHide: true,
      },
    );

    (proc.stdout as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) this.emit("logLine", { level: "info", message: line.trim() });
      }
    });
    (proc.stderr as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) this.emit("logLine", { level: "warn", message: line.trim() });
      }
    });

    try {
      fs.writeFileSync(pidPath, String(proc.pid ?? 0));
    } catch (err) {
      console.warn("[supervisor] failed to write PID file:", err);
    }

    return proc;
  }

  /**
   * Read PID file and decide whether to adopt an existing helper or spawn fresh.
   * Returns the spawned ChildProcess, or null if we adopted an existing process.
   *
   * Adoption only marks the PID as known-alive-same-user. Identity verification
   * happens via the socket/protocol handshake in bootCycle — if that fails,
   * bootCycle removes the stale files and calls spawnFresh() directly.
   * We never store the adopted PID as a kill target.
   */
  private async adoptOrSpawn(
    socketPath: string,
    pidPath: string,
    binaryPath: string,
  ): Promise<child_process.ChildProcess | null> {
    // Try reading an existing PID file
    let existingPid: number | null = null;
    try {
      const pidStr = fs.readFileSync(pidPath, "utf8").trim();
      const parsed = parseInt(pidStr, 10);
      if (!isNaN(parsed) && parsed > 0) existingPid = parsed;
    } catch {
      // No PID file — fresh start
    }

    if (existingPid !== null) {
      if (isAlive(existingPid)) {
        if (!isSameUser(existingPid)) {
          throw new Error(
            `cross-user helper process at PID ${existingPid} — refusing to adopt`,
          );
        }
        // Adopt: connect to the existing socket in bootCycle.
        // We do NOT store existingPid for killing — engine.shutdown is the only
        // shutdown path for adopted helpers. If the handshake fails, bootCycle
        // treats the files as stale and falls back to spawnFresh().
        console.log(`[supervisor] adopting existing helper PID ${existingPid}`);
        return null;
      }
      // Dead PID — unlink stale files before spawning fresh
      try {
        fs.unlinkSync(pidPath);
      } catch {}
      try {
        fs.unlinkSync(socketPath);
      } catch {}
    }

    return this.spawnFresh(socketPath, pidPath, binaryPath);
  }

  // ── Boot cycle ──────────────────────────────────────────────────────────────

  /**
   * Connect to the current socket and verify the protocol handshake.
   *
   * The post-ready disconnect handler is registered ONLY after a successful
   * handshake. This prevents the handler from firing (and calling scheduleRestart)
   * when we disconnect the RPC during catch-path cleanup, which would cause a
   * spurious restart race alongside the adoption-fallback or error rethrow.
   */
  private async connectAndVerify(socketPath: string): Promise<void> {
    const rpc = await this.connectWithRetry(socketPath);
    this._rpc = rpc;

    // Bound the handshake: a stale socket that accepts the connection but never
    // replies would otherwise hang "starting" forever, blocking the
    // adoption-fallback spawn path and preventing any supervisor recovery.
    const version = await Promise.race([
      rpc.engineVersion(),
      sleep(HANDSHAKE_TIMEOUT_MS).then<never>(() => {
        throw new Error(
          `engine.version handshake timed out after ${HANDSHAKE_TIMEOUT_MS} ms`,
        );
      }),
    ]);
    if (version.protocol_version !== PROTOCOL_VERSION) {
      rpc.disconnect();
      this._rpc = null;
      throw Object.assign(
        new Error(`protocolVersion mismatch: expected ${PROTOCOL_VERSION}, got ${version.protocol_version}`),
        { code: "protocol-mismatch" as const },
      );
    }

    rpc.onNotification("engine.logLine", (params) => {
      this.emit("logLine", params);
    });

    // Register the post-ready disconnect handler after the handshake succeeds.
    // If we registered it earlier and then disconnected during cleanup, the handler
    // would fire scheduleRestart() in parallel with our own error handling.
    rpc.once("disconnect", () => {
      if (this.shutdownRequested || this.state === "shuttingDown") return;
      this.proc = null;
      this.emit("crashed");
      this.scheduleRestart();
    });

    this.setState("ready");
    this.emit("ready", {
      helper_version: version.helper_version,
      protocol_version: version.protocol_version,
    });
    this.startHeartbeat();
  }

  private cleanupFailedBoot(): void {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill("SIGKILL");
      } catch {}
    }
    this.proc = null;
    if (this._rpc) {
      this._rpc.disconnect();
      this._rpc = null;
    }
  }

  private bootCycle(): Promise<void> {
    const p = this.doBoot();
    this.runningBoot = p.finally(() => {
      this.runningBoot = null;
    });
    return this.runningBoot;
  }

  private async doBoot(): Promise<void> {
    this.setState("starting");
    const socketPath = this.resolveSocketPath();
    const pidPath = this.resolvePidPath();
    const binaryPath = this.resolveHelperBinary();

    if (this.shutdownRequested) return;

    this.checkDependencies();

    const proc = await this.adoptOrSpawn(socketPath, pidPath, binaryPath);

    if (this.shutdownRequested) {
      // Kill the local proc variable — this.proc is not yet assigned here.
      // Adopted proc is null; the guard skips null naturally (adopted PID safety).
      if (proc && !proc.killed) {
        try { proc.kill("SIGKILL"); } catch {}
      }
      return;
    }

    this.proc = proc;
    const wasAdopted = proc === null;

    try {
      await this.connectAndVerify(socketPath);
      // No shutdown check after a successful handshake — this.proc is assigned;
      // doShutdown()'s normal SIGTERM/SIGKILL path handles cleanup from here.
    } catch (handshakeErr) {
      this.cleanupFailedBoot();

      if (this.shutdownRequested) return;

      if (!wasAdopted) {
        // Spawned helper failed to connect/verify — propagate for normal error handling
        throw handshakeErr;
      }

      // The adopted helper failed the socket/protocol handshake.
      // Before treating files as stale, re-check whether the PID is still alive.
      // If it is, another instance may have adopted the same socket — do not
      // unlink files that may still be in active use.
      let pidStillLive = false;
      try {
        const raw = fs.readFileSync(pidPath, "utf8").trim();
        const adoptedPid = parseInt(raw, 10);
        if (!isNaN(adoptedPid) && adoptedPid > 0) {
          pidStillLive = isAlive(adoptedPid);
        }
      } catch {
        // Can't read PID file — treat as not alive
      }

      if (pidStillLive) {
        const origCode = (handshakeErr as { code?: string })?.code;
        throw Object.assign(
          new Error(
            `adopted helper failed handshake but PID is still live — ` +
              `another instance may hold the connection; not spawning fresh helper`,
          ),
          origCode ? { code: origCode } : {},
        );
      }

      // PID no longer alive — genuinely stale files, safe to unlink and respawn.
      console.warn(
        `[supervisor] adopted helper failed handshake (${handshakeErr}); ` +
          `removing stale files and spawning fresh helper`,
      );
      try {
        fs.unlinkSync(pidPath);
      } catch {}
      try {
        fs.unlinkSync(socketPath);
      } catch {}

      if (this.shutdownRequested) return;

      const freshProc = await this.spawnFresh(socketPath, pidPath, binaryPath);

      if (this.shutdownRequested) {
        // Kill local freshProc — this.proc not yet reassigned to freshProc.
        if (freshProc && !freshProc.killed) {
          try { freshProc.kill("SIGKILL"); } catch {}
        }
        return;
      }

      this.proc = freshProc;

      try {
        await this.connectAndVerify(socketPath);
      } catch (spawnErr) {
        this.cleanupFailedBoot();
        if (this.shutdownRequested) return;
        const origCode = (spawnErr as { code?: string })?.code;
        throw Object.assign(
          new Error(`helper startup failed after adoption fallback to spawn: ${spawnErr}`),
          origCode ? { code: origCode } : {},
        );
      }
    }
  }

  // ── Connect with retry ──────────────────────────────────────────────────────

  private async connectWithRetry(socketPath: string): Promise<EngineRpc> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const rpc = new EngineRpc();
      try {
        await rpc.connect(socketPath);
        return rpc;
      } catch {
        await sleep(CONNECT_INTERVAL_MS);
      }
    }
    throw new Error(
      `could not connect to helper socket within ${CONNECT_TIMEOUT_MS} ms`,
    );
  }

  // ── Restart loop ────────────────────────────────────────────────────────────

  private scheduleRestart(): void {
    if (this.shutdownRequested) return;

    const now = Date.now();
    this.failureTimestamps = this.failureTimestamps.filter(
      (t) => now - t < FAILURE_WINDOW_MS,
    );
    this.failureTimestamps.push(now);

    if (this.failureTimestamps.length >= MAX_FAILURES) {
      console.error(
        "[supervisor] too many failures in window — entering unavailable state",
      );
      this.stopHeartbeat();
      this.setState("unavailable");
      this.emit("unavailable", new Error("helper failed too many times in 60 s"));
      return;
    }

    const attempt = this.failureTimestamps.length - 1;
    const delay =
      RESTART_DELAYS_MS[attempt] ??
      RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1] ??
      10_000;

    this.setState("restarting");
    console.log(
      `[supervisor] restart attempt ${attempt + 1}/${MAX_FAILURES} in ${delay} ms`,
    );
    this.stopHeartbeat();
    this.clearRestartTimer();

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shutdownRequested) return;
      this.bootCycle().catch((err: unknown) => {
        console.warn("[supervisor] restart failed:", err);
        const code = (err as { code?: string })?.code;
        if (
          code === "sha256-mismatch" ||
          code === "protocol-mismatch" ||
          code === "missing-dependency"
        ) {
          this.stopHeartbeat();
          this.setState("unavailable");
          this.emit("unavailable", err);
          return;
        }
        this.scheduleRestart();
      });
    }, delay);
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this._rpc?.connected) return;
      this._rpc.engineHealth().catch((err: unknown) => {
        console.warn("[supervisor] heartbeat failed:", err);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  private cleanup(): void {
    try {
      fs.unlinkSync(this.resolveSocketPath());
    } catch {}
    try {
      fs.unlinkSync(this.resolvePidPath());
    } catch {}
    this.proc = null;
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isSameUser(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const uidLine = status.split("\n").find((l) => l.startsWith("Uid:"));
      if (!uidLine) return false;
      const realUid = parseInt(uidLine.split(/\s+/)[1] ?? "-1", 10);
      const myUid =
        typeof process.getuid === "function" ? process.getuid() : -1;
      return realUid === myUid;
    } catch {
      return false;
    }
  }
  // Non-Linux: assume same user if alive (best-effort)
  return true;
}

/**
 * Wrap child_process.spawn in a Promise that:
 *  - resolves with the ChildProcess on the "spawn" event (process started successfully)
 *  - rejects on the "error" event (binary missing, not executable, invalid path, etc.)
 *
 * A permanent error handler is wired after successful spawn to prevent unhandled
 * EventEmitter errors from post-spawn operations (e.g. kill() on an already-dead process).
 */
function spawnHelper(
  binaryPath: string,
  args: string[],
  opts: child_process.SpawnOptions,
): Promise<child_process.ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn(binaryPath, args, opts);
    const onSpawnError = (err: Error) => reject(err);
    proc.once("error", onSpawnError);
    proc.once("spawn", () => {
      proc.off("error", onSpawnError);
      // Permanent handler prevents unhandled errors after a successful spawn.
      proc.on("error", (err) => {
        console.warn("[supervisor] helper process error:", err);
      });
      resolve(proc);
    });
  });
}

/**
 * Ensure the direct socket parent directory exists with mode 0700.
 *
 * Uses lstatSync (not statSync) throughout — symlinks are rejected before
 * any chmod or use, preventing a local-user symlink attack in temp fallback paths.
 *
 * Strategy:
 *  - If missing: create it with mode 0700 (umask cannot reduce owner bits).
 *  - If a symlink: throw — never follow or chmod a symlink target.
 *  - If owned by another user: throw.
 *  - If wrong mode and owned by us: chmod to 0700, verify with lstat.
 *  - Verify final mode is exactly 0700 before returning.
 */
function ensureSocketDir(dir: string): void {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (stat === null) {
    // Create parents (XDG_RUNTIME_DIR already exists; only the app subdir is missing)
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // Create the direct socket parent at 0700.
    // umask does not reduce owner rwx bits, so 0700 is always the effective mode.
    fs.mkdirSync(dir, { mode: 0o700 });
    stat = fs.lstatSync(dir);
  }

  // Reject symlinks — never chmod or use a symlink target.
  if (stat.isSymbolicLink()) {
    throw new Error(
      `socket directory ${dir} is a symlink — refusing to use for security`,
    );
  }

  // Must be a real directory
  if (!stat.isDirectory()) {
    throw new Error(
      `socket directory path ${dir} exists but is not a directory`,
    );
  }

  // Ownership check (Linux — on Windows uid is always 0, skip)
  if (typeof process.getuid === "function") {
    const myUid = process.getuid();
    if (stat.uid !== myUid) {
      throw new Error(
        `socket directory ${dir} is owned by uid ${stat.uid} but current user is uid ${myUid} — refusing to use`,
      );
    }
  }

  // Mode check and correction
  const mode = stat.mode & 0o777;
  if (mode !== 0o700) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch (err) {
      throw new Error(
        `socket directory ${dir} has unsafe mode 0${mode.toString(8)} and chmod to 0700 failed: ${err}`,
      );
    }
    // Verify correction with lstatSync — never statSync, which would follow a symlink
    // that could have been swapped in after the ownership check.
    const corrected = fs.lstatSync(dir).mode & 0o777;
    if (corrected !== 0o700) {
      throw new Error(
        `socket directory ${dir}: mode correction failed — expected 0700, got 0${corrected.toString(8)}`,
      );
    }
  }
}

/**
 * Windows process-tree teardown.  Uses `taskkill /F /T /PID <pid>` to
 * forcefully terminate the helper and all its child processes.
 *
 * On Windows, `proc.kill("SIGTERM")` wraps TerminateProcess() which kills only
 * the direct process — child processes become orphans.  `taskkill /T` kills the
 * entire process tree.
 *
 * The RPC engine.shutdown is always attempted first (in doShutdown); this
 * function is the final escalation for processes that do not exit cleanly.
 */
async function killWithEscalationWindows(
  proc: child_process.ChildProcess,
): Promise<void> {
  const pid = proc.pid;
  if (pid == null) return;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  // Give the RPC-shutdown path a moment to complete before taskkill.
  const result = await Promise.race([
    exited.then(() => "exited" as const),
    sleep(SIGTERM_DELAY_MS).then(() => "timeout" as const),
  ]);
  if (result === "exited") return;
  try {
    child_process
      .spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      })
      .on("error", () => {
        // Suppress unhandled 'error' event (e.g. ENOENT if taskkill is absent).
        // Fall back to direct kill so the process is not left alive.
        try { proc.kill(); } catch {}
      })
      .unref();
  } catch {
    // Synchronous spawn failure — fall back to direct kill.
    try {
      proc.kill();
    } catch {}
  }
}

async function killWithEscalation(
  proc: child_process.ChildProcess,
): Promise<void> {
  if (process.platform === "win32") {
    return killWithEscalationWindows(proc);
  }
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  const result1 = await Promise.race([
    exited.then(() => "exited" as const),
    sleep(SIGTERM_DELAY_MS).then(() => "timeout" as const),
  ]);
  if (result1 === "exited") return;
  try {
    proc.kill("SIGTERM");
  } catch {}
  const result2 = await Promise.race([
    exited.then(() => "exited" as const),
    sleep(SIGKILL_DELAY_MS - SIGTERM_DELAY_MS).then(() => "timeout" as const),
  ]);
  if (result2 === "exited") return;
  try {
    proc.kill("SIGKILL");
  } catch {}
}
