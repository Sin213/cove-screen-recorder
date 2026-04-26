import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app } from "electron";
import { detectFfmpeg, getEncoderCandidates, remux } from "./ffmpeg";
import type {
  CaptureFormat,
  FinalizeParams,
  FinalizeResult,
  PresetId,
  StartRecordingParams,
} from "./types";

interface ActiveRecording {
  id: string;
  filePath: string;
  fd: number;
  outputDir: string;
  baseName: string;
  preset: PresetId;
  format: CaptureFormat;
  closing: boolean;
  // Linux-only: a parallel ffmpeg process capturing system audio from the
  // PulseAudio/PipeWire monitor. Chromium's getDisplayMedia handler can't
  // deliver loopback audio on Linux, so we side-channel it here and let
  // finalize() mux it onto the video.
  audioProc?: ChildProcess;
  audioPath?: string;
  // PipeWire-Pulse compatibility quirk — the monitor source's gain is often
  // attenuated (we've seen 8% / -66 dB by default) so we briefly bump it to
  // 100% during capture and restore the prior value on stop.
  audioMonitorName?: string;
  audioMonitorPriorVolume?: string;  // raw amplitude e.g. "5140"
}

const sessions = new Map<string, ActiveRecording>();

function newId(): string {
  return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function tsName(prefix = "Cove"): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  // Include milliseconds so two recordings finalised in the same second don't
  // overwrite each other (ffmpeg is invoked with -y and would silently clobber).
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${prefix}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${ms}`;
}

// Expand a leading "~" / "~/" to the user's home dir. Users typing
// "~/Videos" in the output picker would otherwise hit ENOENT.
function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export type RecorderLogger = (line: string) => void;

let activeLogger: RecorderLogger = () => { /* noop */ };

export function setRecorderLogger(fn: RecorderLogger): void {
  activeLogger = fn;
}

export function begin(params: StartRecordingParams): { recordingId: string; tempPath: string } {
  const resolvedOutputDir = expandHome(params.outputDir);
  params = { ...params, outputDir: resolvedOutputDir };
  ensureDir(resolvedOutputDir);

  const recordingId = newId();
  const tempDir = path.join(app.getPath("userData"), "recordings");
  ensureDir(tempDir);
  const tempPath = path.join(tempDir, `${recordingId}.webm`);

  const fd = fs.openSync(tempPath, "w");
  const baseName = tsName(presetPrefix(params.preset));

  const session: ActiveRecording = {
    id: recordingId,
    filePath: tempPath,
    fd,
    outputDir: params.outputDir,
    baseName,
    preset: params.preset,
    format: presetFormat(params.preset),
    closing: false,
  };
  sessions.set(recordingId, session);

  // Linux: spin up a sidecar ffmpeg to capture system audio. Skipped if
  // the user disabled system audio, or if we can't find pulseaudio /
  // pipewire-pulse on this box.
  if (process.platform === "linux" && params.withSystemAudio && params.preset !== "gif") {
    startAudioSidecar(session, tempDir);
  }

  return { recordingId, tempPath };
}

function startAudioSidecar(session: ActiveRecording, tempDir: string): void {
  const ff = detectFfmpeg();
  if (!ff.available || !ff.path) {
    activeLogger("audio sidecar skipped — ffmpeg unavailable");
    return;
  }

  // Resolve the default sink's monitor explicitly so we can manage its
  // volume. (`@DEFAULT_MONITOR@` works for capture but isn't a name we can
  // pass to `pactl set-source-volume`.)
  const sinkName = (() => {
    try {
      const r = spawnSync("pactl", ["get-default-sink"], { encoding: "utf8" });
      if (r.status === 0) return r.stdout.trim() || null;
    } catch { /* ignore */ }
    return null;
  })();
  if (!sinkName) {
    activeLogger("audio sidecar — pactl get-default-sink failed");
    return;
  }
  const monitor = `${sinkName}.monitor`;

  // PipeWire-Pulse can leave a monitor source's gain attenuated (we've seen
  // 8% / -66 dB on a default install). Reading from a quiet source and
  // amplifying via ffmpeg works but raises the noise floor too — capturing
  // at native 100% then restoring the prior value avoids static. The save
  // is the raw amplitude (0..65536) so we round-trip cleanly across Pulse's
  // cubic % mapping.
  const priorRawVolume = (() => {
    try {
      const r = spawnSync("pactl", ["get-source-volume", monitor], { encoding: "utf8" });
      if (r.status !== 0) return null;
      const m = r.stdout.match(/(\d+)\s*\/\s*\d+%/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  })();
  if (priorRawVolume) {
    try {
      const setRes = spawnSync("pactl", ["set-source-volume", monitor, "100%"], { encoding: "utf8" });
      if (setRes.status !== 0) {
        activeLogger(`audio sidecar — set-source-volume failed: ${(setRes.stderr ?? "").trim()}`);
      } else {
        session.audioMonitorName = monitor;
        session.audioMonitorPriorVolume = priorRawVolume;
      }
    } catch (err) {
      activeLogger(`audio sidecar — set-source-volume threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sidecar writes lossless FLAC at the source's native rate so the
  // mux at finalize is the only AAC pass — going AAC→AAC introduced
  // generation-loss artifacts. Explicit -ac/-ar so the channel count
  // doesn't fall back to mono on ffmpeg builds with different defaults
  // (the previous setup landed mono on this box).
  const audioPath = path.join(tempDir, `${session.id}.audio.flac`);
  const args = [
    "-y", "-hide_banner", "-loglevel", "info",
    "-f", "pulse", "-ac", "2", "-ar", "48000", "-i", monitor,
    "-c:a", "flac", "-compression_level", "0",
    audioPath,
  ];
  activeLogger(
    session.audioMonitorPriorVolume && session.audioMonitorPriorVolume !== "65536"
      ? `audio sidecar starting — ${monitor} (monitor vol bumped to 100%, restoring on stop)`
      : `audio sidecar starting — ${monitor}`,
  );
  try {
    const proc = spawn(ff.path, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrBuf = "";
    proc.stderr?.on("data", (chunk) => {
      const s = chunk.toString();
      stderrBuf += s;
      // Surface meaningful errors live; ffmpeg's "size=" progress lines we drop.
      const lines = s.split(/\r?\n/).filter((l: string) =>
        l && !l.startsWith("size=") && !/^\s*frame=/.test(l)
      );
      for (const line of lines) {
        if (/error|fail|cannot|denied|unable|connection refused/i.test(line)) {
          activeLogger(`audio sidecar: ${line.trim().slice(0, 200)}`);
        }
      }
    });
    proc.on("error", (err) => {
      activeLogger(`audio sidecar spawn failed: ${err.message}`);
      session.audioProc = undefined;
      session.audioPath = undefined;
    });
    proc.on("exit", (code, signal) => {
      // Normal stop is via SIGTERM; only log unexpected exits.
      if (signal !== "SIGTERM" && signal !== "SIGKILL") {
        activeLogger(`audio sidecar exited code=${code} signal=${signal}; tail: ${stderrBuf.slice(-200).trim()}`);
      }
    });
    session.audioProc = proc;
    session.audioPath = audioPath;
  } catch (err) {
    activeLogger(`audio sidecar threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function stopAudioSidecar(s: ActiveRecording): Promise<void> {
  const proc = s.audioProc;
  const restore = () => {
    if (s.audioMonitorName && s.audioMonitorPriorVolume) {
      try {
        spawnSync("pactl", [
          "set-source-volume",
          s.audioMonitorName,
          s.audioMonitorPriorVolume,
        ]);
      } catch { /* best-effort */ }
      s.audioMonitorName = undefined;
      s.audioMonitorPriorVolume = undefined;
    }
  };

  if (!proc) {
    restore();
    return;
  }
  s.audioProc = undefined;

  await new Promise<void>((resolve) => {
    const onExit = () => resolve();
    proc.once("exit", onExit);
    proc.once("close", onExit);
    // SIGTERM tells ffmpeg to flush and finalise the container cleanly.
    try { proc.kill("SIGTERM"); } catch { resolve(); }
    // Belt-and-braces: don't hang the finalize path forever.
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* ignore */ } resolve(); }, 4000);
  });

  restore();

  // If the file is empty or missing (sidecar bailed early), drop the path
  // so finalize doesn't try to mux a zero-byte input.
  if (s.audioPath) {
    try {
      const st = fs.statSync(s.audioPath);
      if (st.size < 1024) {
        try { fs.unlinkSync(s.audioPath); } catch { /* ignore */ }
        s.audioPath = undefined;
      }
    } catch {
      s.audioPath = undefined;
    }
  }
}

export function appendChunk(recordingId: string, buffer: ArrayBuffer): void {
  const s = sessions.get(recordingId);
  if (!s || s.closing) return;
  fs.writeSync(s.fd, Buffer.from(buffer));
}

export async function finalize(
  params: FinalizeParams,
  onLog: (line: string) => void,
): Promise<FinalizeResult> {
  const s = sessions.get(params.recordingId);
  if (!s) return { ok: false, error: "no active recording" };
  s.closing = true;

  // Drain the audio sidecar before closing the video file so both endpoints
  // are flushed before remux starts.
  await stopAudioSidecar(s);
  if (s.audioPath) {
    try {
      const sz = fs.statSync(s.audioPath).size;
      activeLogger(`audio sidecar ok — captured ${(sz / 1024).toFixed(0)} KB`);
    } catch { /* dropped already */ }
  } else if (process.platform === "linux") {
    // Only mention this on Linux where we actually try to capture.
    activeLogger("audio sidecar produced no audio (file missing or empty)");
  }

  try {
    fs.closeSync(s.fd);
  } catch {
    // already closed
  }

  const ff = detectFfmpeg();
  if (!ff.available || !ff.path) {
    // No ffmpeg: just rename the webm into outputDir as-is.
    const fallback = path.join(s.outputDir, `${s.baseName}.webm`);
    try {
      fs.renameSync(s.filePath, fallback);
    } catch (err) {
      // Cross-device — copy + unlink.
      fs.copyFileSync(s.filePath, fallback);
      try { fs.unlinkSync(s.filePath); } catch { /* ignore */ }
    }
    if (s.audioPath) try { fs.unlinkSync(s.audioPath); } catch { /* ignore */ }
    sessions.delete(params.recordingId);
    return {
      ok: true,
      outputPath: fallback,
      error: "ffmpeg not found — saved raw .webm. Install ffmpeg for mp4/gif output.",
    };
  }

  const ext = params.format;
  const outputPath = path.join(s.outputDir, `${s.baseName}.${ext}`);
  const inputHasAudio = await probeHasAudio(ff.path, s.filePath);

  // Iterate every viable encoder in preference order — GPU-aware (we drop
  // h264_nvenc on AMD boxes, h264_amf on NVIDIA, etc. via the candidates
  // list), then any HW that's still left, ending at libx264 software. This
  // way an unexpected HW failure on one encoder doesn't immediately fall
  // back to CPU; another HW path gets a shot first.
  const candidates = getEncoderCandidates(params.format, ff.encoders);
  const tryRemux = async (videoEncoder: string): Promise<void> => {
    await remux({
      inputPath: s.filePath,
      outputPath,
      preset: params.preset,
      format: params.format,
      ffmpegPath: ff.path!,
      encoders: ff.encoders,
      audioPath: s.audioPath ?? null,
      inputHasAudio,
      videoEncoderOverride: videoEncoder,
      onLog,
    });
  };

  let usedEncoder: string | null = null;
  let firstAttempt: string | null = null;
  let lastErr: unknown;
  for (const enc of candidates) {
    if (!firstAttempt) firstAttempt = enc;
    try {
      await tryRemux(enc);
      usedEncoder = enc;
      break;
    } catch (err) {
      lastErr = err;
      activeLogger(
        `${enc} failed (${err instanceof Error ? err.message : String(err)}); trying next encoder`,
      );
    }
  }
  if (!usedEncoder) {
    return preserveOnFailure(s, params.recordingId, lastErr ?? new Error("all encoders failed"));
  }

  // Cleanup temp on success.
  try { fs.unlinkSync(s.filePath); } catch { /* ignore */ }
  if (s.audioPath) try { fs.unlinkSync(s.audioPath); } catch { /* ignore */ }
  sessions.delete(params.recordingId);

  const usedFallback = firstAttempt !== usedEncoder;
  return {
    ok: true,
    outputPath,
    error: usedFallback
      ? `${firstAttempt} failed; saved with ${usedEncoder}.`
      : undefined,
  };
}

// Keep the temp .webm + sidecar .m4a around when finalize fails so the user
// can rescue the recording manually instead of losing it. The error message
// surfaces the temp paths so they're discoverable from the log panel.
function preserveOnFailure(
  s: ActiveRecording,
  recordingId: string,
  err: unknown,
): { ok: false; error: string } {
  sessions.delete(recordingId);
  const msg = err instanceof Error ? err.message : String(err);
  const parts = [`finalize failed: ${msg}`, `temp video kept at ${s.filePath}`];
  if (s.audioPath) parts.push(`temp audio kept at ${s.audioPath}`);
  return { ok: false, error: parts.join("\n") };
}

async function probeHasAudio(ffmpegPath: string, file: string): Promise<boolean> {
  // Quick ffprobe-via-ffmpeg check: ffmpeg -i prints stream info to stderr;
  // if any "Stream #...: Audio:" line shows up, we've got an audio track.
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ["-hide_banner", "-i", file], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let buf = "";
    proc.stderr?.on("data", (b: Buffer) => { buf += b.toString("utf-8"); });
    proc.once("close", () => resolve(/Stream\s+#\d+:\d+.*?: Audio:/.test(buf)));
    proc.once("error", () => resolve(false));
  });
}

export function cancel(recordingId: string): void {
  const s = sessions.get(recordingId);
  if (!s) return;
  s.closing = true;
  // Best-effort SIGKILL — cancel doesn't need the audio file to be valid.
  try { s.audioProc?.kill("SIGKILL"); } catch { /* ignore */ }
  // Restore the monitor source's prior volume even on cancel — leaving the
  // user's system at 100% would be unexpected if they aborted the take.
  if (s.audioMonitorName && s.audioMonitorPriorVolume) {
    try {
      spawnSync("pactl", [
        "set-source-volume",
        s.audioMonitorName,
        s.audioMonitorPriorVolume,
      ]);
    } catch { /* ignore */ }
  }
  try { fs.closeSync(s.fd); } catch { /* ignore */ }
  try { fs.unlinkSync(s.filePath); } catch { /* ignore */ }
  if (s.audioPath) try { fs.unlinkSync(s.audioPath); } catch { /* ignore */ }
  sessions.delete(recordingId);
}

export function cancelAll(): void {
  for (const id of [...sessions.keys()]) cancel(id);
}

function presetPrefix(p: PresetId): string {
  if (p === "gif") return "Cove_GIF";
  if (p === "gaming") return "Cove_Gaming";
  return "Cove";
}

function presetFormat(p: PresetId): CaptureFormat {
  return p === "gif" ? "gif" : "mp4";
}
