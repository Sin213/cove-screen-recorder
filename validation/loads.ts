import * as path from "path";
import * as fs from "fs";
import { spawn, spawnSync } from "child_process";

export interface LaunchedLoad {
  name: string;
  pid: number;
  argv: string[];
  readonly exited: boolean;
  teardown: () => Promise<void>;
}

export class LoadScriptMissingError extends Error {
  constructor(scriptPath: string) {
    super(`L-MOTION-60 launch script not found: ${scriptPath}`);
    this.name = "LoadScriptMissingError";
  }
}

/**
 * Launch the L-MOTION-60 fullscreen motion load.
 * Returns null if no Chromium-based browser is available (caller should skip).
 * Throws LoadScriptMissingError if the launch script is missing (caller should error).
 */
export async function launchMotion60(): Promise<LaunchedLoad | null> {
  const scriptPath = path.resolve("validation/loads/l-motion-60/launch.sh");

  if (!fs.existsSync(scriptPath)) {
    throw new LoadScriptMissingError(scriptPath);
  }

  if (!checkBrowserAvailable()) {
    return null;
  }

  const argv: string[] = ["bash", scriptPath];
  if (!process.env["WAYLAND_DISPLAY"] && process.env["DISPLAY"]) {
    argv.push("--x11");
  }

  const child = spawn(argv[0]!, argv.slice(1), {
    stdio: "ignore", // prevent stdout/stderr pipes from filling and blocking Chromium
    detached: false,
  });

  const state = { exited: false };
  child.on("exit", () => {
    state.exited = true;
  });

  const teardown = async (): Promise<void> => {
    if (state.exited) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!state.exited) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  };

  return {
    name: "l-motion-60",
    pid: child.pid!,
    argv,
    get exited(): boolean {
      return state.exited;
    },
    teardown,
  };
}

function checkBrowserAvailable(): boolean {
  for (const bin of [
    "chromium",
    "chromium-browser",
    "google-chrome-stable",
    "google-chrome",
  ]) {
    const { status } = spawnSync("which", [bin], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (status === 0) return true;
  }
  return false;
}
