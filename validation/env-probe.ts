import { spawnSync } from "child_process";

export interface EnvProbeResult {
  display: string | null;
  waylandDisplay: string | null;
  xdgRuntimeDir: string | null;
  portalRunning: boolean;
  gpuInfo: string | null;
}

export function probeEnvironment(): EnvProbeResult {
  return {
    display: process.env["DISPLAY"] ?? null,
    waylandDisplay: process.env["WAYLAND_DISPLAY"] ?? null,
    xdgRuntimeDir: process.env["XDG_RUNTIME_DIR"] ?? null,
    portalRunning: checkPortalRunning(),
    gpuInfo: probeGpuInfo(),
  };
}

export function hasDisplayServer(probe: EnvProbeResult): boolean {
  return probe.display !== null || probe.waylandDisplay !== null;
}

function checkPortalRunning(): boolean {
  try {
    // Use -f to match against the full command line rather than the truncated
    // comm name (kernel TASK_COMM_LEN = 15 chars; "xdg-desktop-portal" is 18).
    const { status } = spawnSync("pgrep", ["-f", "xdg-desktop-portal"], {
      encoding: "utf8",
      timeout: 3_000,
    });
    return status === 0;
  } catch {
    return false;
  }
}

function probeGpuInfo(): string | null {
  try {
    const { status, stdout } = spawnSync(
      "nvidia-smi",
      ["--query-gpu=name,driver_version", "--format=csv,noheader"],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (status === 0 && stdout.trim()) {
      return `nvidia: ${stdout.trim()}`;
    }
  } catch {
    // not available
  }

  try {
    const { status, stdout } = spawnSync("lspci", [], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (status === 0 && stdout) {
      const lines = stdout
        .split("\n")
        .filter(
          (l) =>
            l.toLowerCase().includes("vga") ||
            l.toLowerCase().includes("display") ||
            l.toLowerCase().includes("3d controller"),
        );
      if (lines.length > 0) {
        return lines.join("; ");
      }
    }
  } catch {
    // not available
  }

  return null;
}
