import { spawnSync } from "child_process";

export interface DisplayOutput {
  id: string;
  name: string;
  activeMode: { width: number; height: number; refresh: number } | null;
  preferredMode: { width: number; height: number; refresh: number } | null;
}

export interface ModesetResult {
  success: boolean;
  output: string;
  priorMode: { width: number; height: number; refresh: number } | null;
  appliedMode: { width: number; height: number; refresh: number } | null;
  attempts: number;
  kscreenOutput: string;
}

const SETTLE_MS = 2000;
const VERIFY_DELAY_MS = 1500;
const MAX_ATTEMPTS = 3;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function parseKscreenOutput(raw: string): DisplayOutput | null {
  const clean = stripAnsi(raw);

  const outputMatch = clean.match(
    /Output:\s+(\d+)\s+(\S+)/,
  );
  if (!outputMatch) return null;

  const id = outputMatch[1];
  const name = outputMatch[2];

  let activeMode: DisplayOutput["activeMode"] = null;
  let preferredMode: DisplayOutput["preferredMode"] = null;

  const modesMatch = clean.match(/Modes:\s*(.*)/);
  if (modesMatch) {
    const modesStr = modesMatch[1];
    const modeRe = /(\d+):(\d+)x(\d+)@([\d.]+)([!*]*)/g;
    let m: RegExpExecArray | null;
    while ((m = modeRe.exec(modesStr)) !== null) {
      const mode = {
        width: Number(m[2]),
        height: Number(m[3]),
        refresh: parseFloat(m[4]),
      };
      const flags = m[5];
      if (flags.includes("*")) activeMode = mode;
      if (flags.includes("!")) preferredMode = mode;
    }
  }

  return { id, name, activeMode, preferredMode };
}

function readCurrentOutput(): { raw: string; parsed: DisplayOutput | null } {
  const { status, stdout, stderr } = spawnSync("kscreen-doctor", ["-o"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const raw = (stdout ?? "") + (stderr ?? "");
  if (status !== 0) return { raw, parsed: null };
  return { raw, parsed: parseKscreenOutput(raw) };
}

function modeMatches(
  mode: { width: number; height: number; refresh: number } | null,
  target: { width: number; height: number },
): boolean {
  if (!mode) return false;
  return mode.width === target.width && mode.height === target.height;
}

export function enforceDisplayMode(
  target: { width: number; height: number },
  targetRefresh = 60,
): ModesetResult {
  const initial = readCurrentOutput();
  if (!initial.parsed) {
    return {
      success: false,
      output: "(unknown)",
      priorMode: null,
      appliedMode: null,
      attempts: 0,
      kscreenOutput: initial.raw,
    };
  }

  const outputName = initial.parsed.name;
  const priorMode = initial.parsed.activeMode;

  if (modeMatches(priorMode, target)) {
    return {
      success: true,
      output: outputName,
      priorMode,
      appliedMode: priorMode,
      attempts: 0,
      kscreenOutput: initial.raw,
    };
  }

  const modeStr = `${target.width}x${target.height}@${targetRefresh}`;
  let lastRaw = initial.raw;
  let appliedMode: DisplayOutput["activeMode"] = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    spawnSync(
      "kscreen-doctor",
      [`output.${outputName}.mode.${modeStr}`],
      { encoding: "utf8", timeout: 10_000 },
    );

    sleepSync(attempt === 1 ? SETTLE_MS : SETTLE_MS + VERIFY_DELAY_MS);

    const verify = readCurrentOutput();
    lastRaw = verify.raw;
    appliedMode = verify.parsed?.activeMode ?? null;

    if (modeMatches(appliedMode, target)) {
      return {
        success: true,
        output: outputName,
        priorMode,
        appliedMode,
        attempts: attempt,
        kscreenOutput: lastRaw,
      };
    }
  }

  return {
    success: false,
    output: outputName,
    priorMode,
    appliedMode,
    attempts: MAX_ATTEMPTS,
    kscreenOutput: lastRaw,
  };
}

export function restoreDisplayMode(
  mode: { width: number; height: number; refresh: number } | null,
  outputName?: string,
): void {
  if (!mode) return;

  let name = outputName;
  if (!name) {
    const cur = readCurrentOutput();
    name = cur.parsed?.name;
  }
  if (!name) return;

  const refreshStr = mode.refresh.toFixed(0);
  spawnSync(
    "kscreen-doctor",
    [`output.${name}.mode.${mode.width}x${mode.height}@${refreshStr}`],
    { encoding: "utf8", timeout: 10_000 },
  );
}

function sleepSync(ms: number): void {
  spawnSync("sleep", [String(ms / 1000)], { timeout: ms + 2000 });
}
