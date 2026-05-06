import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import type { FfmpegInfo, PresetId, CaptureFormat } from "./types";

let cachedInfo: FfmpegInfo | null = null;

function which(bin: string): string | null {
  const paths = (process.env.PATH || "").split(path.delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        const s = fs.statSync(candidate);
        if (s.isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

function siblingToolPath(toolPath: string, siblingBin: string): string | null {
  const exe = process.platform === "win32" ? `${siblingBin}.exe` : siblingBin;
  const candidate = path.join(path.dirname(toolPath), exe);
  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch {
    // not here
  }
  return which(siblingBin);
}

// Resolve a bundled ffmpeg if one was packed into the app's resources. We
// drop a Windows ffmpeg.exe in vendor/win/ during the dist:win build (see
// electron-builder `extraResources` in package.json). System ffmpeg on $PATH
// always wins so users with hardware-accelerated builds (NVENC/AMF/QSV)
// don't get downgraded to a generic bundled binary.
function bundledFfmpeg(): string | null {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates: string[] = [];
  // In packaged builds, extraResources lives under process.resourcesPath.
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, exe));
  }
  // In dev (electron .): app.getAppPath() points at the project root, so we
  // pick up the same vendor/ tree the build pulls from.
  try {
    const root = app.getAppPath();
    if (process.platform === "win32") {
      candidates.push(path.join(root, "vendor", "win", exe));
    } else if (process.platform === "linux") {
      candidates.push(path.join(root, "vendor", "linux", exe));
    }
  } catch {
    // app may not be ready in unit tests — ignore
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // not here
    }
  }
  return null;
}

export function detectFfmpeg(): FfmpegInfo {
  if (cachedInfo) return cachedInfo;

  // Prefer system ffmpeg, fall back to the bundled one (Windows installer).
  const ffPath = which("ffmpeg") ?? bundledFfmpeg();
  if (!ffPath) {
    cachedInfo = { available: false, encoders: [] };
    return cachedInfo;
  }

  let version: string | undefined;
  let encoders: string[] = [];
  try {
    const v = spawnSync(ffPath, ["-hide_banner", "-version"], { encoding: "utf-8", timeout: 5000 });
    if (v.stdout) {
      const m = /ffmpeg version (\S+)/.exec(v.stdout);
      version = m?.[1];
    }
    const e = spawnSync(ffPath, ["-hide_banner", "-encoders"], { encoding: "utf-8", timeout: 5000 });
    if (e.stdout) {
      const wanted = [
        "h264_nvenc", "hevc_nvenc", "av1_nvenc",
        "h264_amf", "hevc_amf",
        "h264_qsv", "hevc_qsv",
        "h264_vaapi", "hevc_vaapi",
        "libx264", "libx265", "libvpx-vp9", "libaom-av1", "libsvtav1",
        "gif",
      ];
      encoders = wanted.filter((name) => new RegExp(`\\b${name}\\b`).test(e.stdout));
    }
  } catch {
    // best effort
  }

  cachedInfo = { available: true, path: ffPath, version, encoders };
  return cachedInfo;
}

type GpuVendor = "nvidia" | "amd" | "intel" | "unknown";
let detectedGpuVendor: GpuVendor = "unknown";

export function setDetectedGpuVendor(v: GpuVendor): void {
  detectedGpuVendor = v;
}

export function getDetectedGpuVendor(): GpuVendor {
  return detectedGpuVendor;
}

// Process-lifetime cache of encoders that definitely don't work on this
// machine. Populated lazily after the first failed encode attempt — once we
// see e.g. h264_amf bail because libamfrt64.so.1 isn't installed, we skip
// it for every subsequent finalize so the user doesn't sit through the same
// load-and-fail cycle on every save. Cleared on app restart.
const SOFTWARE_ENCODERS = new Set(["libx264", "libvpx-vp9", "libaom-av1", "libsvtav1", "gif"]);
const brokenEncoders = new Set<string>();

export function markEncoderBroken(name: string): void {
  // Never blacklist software fallbacks — if libx264 fails we have nowhere
  // else to go, so keep retrying it (and surface the real error) instead of
  // permanently disabling it.
  if (SOFTWARE_ENCODERS.has(name)) return;
  brokenEncoders.add(name);
}

export function isEncoderBroken(name: string): boolean {
  return brokenEncoders.has(name);
}

// Recognise ffmpeg stderr that means "this encoder can never work on this
// machine" (vs. a transient encode failure). Used by finalize() to decide
// whether to mark the encoder broken for the rest of the session.
const STRUCTURAL_ENCODER_FAILURE_PATTERNS = [
  /InitializeEncoder failed/i,                    // NVENC bad params (e.g. Invalid Level)
  /Cannot load .*libamfrt|libamfrt.* could not/i, // AMF runtime missing on Linux
  /Failed to load AMF/i,
  /Could not load .*nvcuda|cannot load .*nvcuda/i,
  /No NVENC capable devices found/i,
  /Cannot init MFX session|MFX session/i,         // QSV has no Intel iGPU
  /Driver does not support the required nvenc/i,
  /Cannot find .*encoder|Encoder not found/i,
];

export function isStructuralEncoderError(stderr: string): boolean {
  if (!stderr) return false;
  return STRUCTURAL_ENCODER_FAILURE_PATTERNS.some((re) => re.test(stderr));
}

export interface EncoderCandidatesOptions {
  // True for replay saves on platforms where the HW-fallback chain is slow
  // and unreliable (mainly Linux without an AMF runtime / Intel iGPU). Skips
  // every hardware encoder so the save lands quickly via libx264.
  preferSoftware?: boolean;
}

// Return encoder candidates in preference order. Hardware encoders that
// definitely won't work on the detected GPU (e.g. h264_nvenc on an AMD box,
// where ffmpeg lists it but loading nvcuda.dll fails at runtime) are
// dropped to avoid scary error logs and a wasted encode attempt. The list
// always ends in libx264 (or libvpx-vp9 for webm) as a guaranteed software
// fallback. VAAPI is intentionally excluded — needs hwupload plumbing we
// don't ship.
export function getEncoderCandidates(
  format: CaptureFormat,
  encoders: string[],
  opts: EncoderCandidatesOptions = {},
): string[] {
  if (format === "gif") return ["gif"];

  const swFallback = format === "webm" ? "libvpx-vp9" : "libx264";

  // preferSoftware short-circuits the whole HW chain — used for Linux replay
  // saves so we don't sit through a minute of nvenc/amf/qsv init failures.
  // libx264/libvpx-vp9 ship with every recent ffmpeg, so we don't bother
  // checking the encoder list — finalize() will surface any "encoder not
  // found" error directly.
  if (opts.preferSoftware) {
    return [swFallback];
  }

  const baseOrder = format === "webm"
    ? ["av1_nvenc", "av1_qsv", "av1_amf", "libsvtav1", "libaom-av1", "libvpx-vp9", "h264_nvenc", "libx264"]
    : ["h264_nvenc", "h264_amf", "h264_qsv", "libx264"];

  // Reorder so the encoder matching the detected vendor is tried first.
  const reordered = [...baseOrder];
  if (detectedGpuVendor === "amd") {
    moveToFront(reordered, ["h264_amf", "av1_amf"]);
    drop(reordered, ["h264_nvenc", "av1_nvenc"]);  // will fail on AMD
  } else if (detectedGpuVendor === "intel") {
    moveToFront(reordered, ["h264_qsv", "av1_qsv"]);
    drop(reordered, ["h264_nvenc", "av1_nvenc", "h264_amf", "av1_amf"]);
  } else if (detectedGpuVendor === "nvidia") {
    // Already first in baseOrder; drop AMD's encoder (won't work on NVIDIA).
    drop(reordered, ["h264_amf", "av1_amf"]);
  }

  const candidates = reordered.filter(
    (enc) => encoders.includes(enc) && !brokenEncoders.has(enc),
  );
  // Always end with the unconditional software fallback (even if an earlier
  // failure tried to mark it broken — which markEncoderBroken refuses).
  if (!candidates.includes(swFallback)) candidates.push(swFallback);
  return candidates;
}

// Backward-compatible alias for callers that just want the top pick.
export function pickHardwareVideoEncoder(format: CaptureFormat, encoders: string[]): string {
  return getEncoderCandidates(format, encoders)[0];
}

function moveToFront(arr: string[], items: string[]): void {
  for (let i = items.length - 1; i >= 0; i--) {
    const idx = arr.indexOf(items[i]);
    if (idx > 0) {
      arr.splice(idx, 1);
      arr.unshift(items[i]);
    }
  }
}

function drop(arr: string[], items: string[]): void {
  for (const it of items) {
    const idx = arr.indexOf(it);
    if (idx >= 0) arr.splice(idx, 1);
  }
}

export interface RemuxOptions {
  inputPath: string;
  outputPath: string;
  preset: PresetId;
  format: CaptureFormat;
  ffmpegPath: string;
  encoders: string[];
  // Nominal capture fps. Used by the mp4 branch to pin CFR + r_frame_rate
  // so the output is playable in strict players (Windows Media Player,
  // Films & TV, Chromium <video>). Optional for backwards compat; falls
  // back to 30 when unset.
  fps?: number;
  // Optional second input — system-audio captured separately by the
  // PulseAudio/PipeWire sidecar. Muxed onto the video at finalize.
  audioPath?: string | null;
  // Keep only the final N milliseconds from the input stream(s).
  trimLastMs?: number;
  // Duration of the MediaRecorder timeline. When trimming replay, ffmpeg
  // trims against this timeline instead of independently seeking each input.
  mediaDurationMs?: number;
  // Milliseconds between MediaRecorder PTS 0 and sidecar audio PTS 0.
  // Positive means sidecar started first; negative means it started later.
  sidecarStartOffsetMs?: number;
  // True when the WebM input has its own audio track (mic / Windows
  // loopback). Lets us decide between mapping that audio directly, mixing
  // it with the sidecar, or skipping audio mapping entirely.
  inputHasAudio?: boolean;
  // Override the video encoder. When unset, picks the best hardware
  // encoder available; finalize() can pass "libx264" here to force a
  // software fallback after a hardware encode fails.
  videoEncoderOverride?: string | null;
  onLog?: (line: string) => void;
}

export interface VideoTimelineProbe {
  durationMs: number;
  frames: number;
  averageFps: number | null;
}

export function probeVideoTimeline(ffmpegPath: string, inputPath: string): VideoTimelineProbe | null {
  const ffprobePath = siblingToolPath(ffmpegPath, "ffprobe");
  if (ffprobePath) {
    try {
      const result = spawnSync(ffprobePath, [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "frame=best_effort_timestamp_time,pkt_duration_time",
        "-of", "json",
        inputPath,
      ], { encoding: "utf-8", timeout: 30000, maxBuffer: 20 * 1024 * 1024 });
      if (result.status === 0 && result.stdout) {
        const parsed = JSON.parse(result.stdout) as {
          frames?: Array<{
            best_effort_timestamp_time?: string;
            pkt_duration_time?: string;
          }>;
        };
        const probe = timelineFromFrames(parsed.frames ?? []);
        if (probe) return probe;
      }
    } catch {
      // Fall through to ffmpeg showinfo below.
    }
  }

  return probeVideoTimelineWithFfmpeg(ffmpegPath, inputPath);
}

function timelineFromFrames(frames: Array<{
  best_effort_timestamp_time?: string;
  pkt_duration_time?: string;
}>): VideoTimelineProbe | null {
  let lastEndSeconds: number | null = null;
  let countedFrames = 0;
  for (const frame of frames) {
    const pts = Number(frame.best_effort_timestamp_time);
    if (!Number.isFinite(pts)) continue;
    const duration = Number(frame.pkt_duration_time);
    const end = pts + (Number.isFinite(duration) && duration > 0 ? duration : 0);
    lastEndSeconds = Math.max(lastEndSeconds ?? 0, end);
    countedFrames += 1;
  }
  if (lastEndSeconds === null || lastEndSeconds <= 0 || countedFrames === 0) return null;
  return {
    durationMs: Math.max(1, Math.round(lastEndSeconds * 1000)),
    frames: countedFrames,
    averageFps: countedFrames / lastEndSeconds,
  };
}

function probeVideoTimelineWithFfmpeg(ffmpegPath: string, inputPath: string): VideoTimelineProbe | null {
  try {
    const result = spawnSync(ffmpegPath, [
      "-hide_banner",
      "-nostdin",
      "-i", inputPath,
      "-map", "0:v:0",
      "-an",
      "-vf", "showinfo",
      "-f", "null",
      "-",
    ], { encoding: "utf-8", timeout: 30000, maxBuffer: 20 * 1024 * 1024 });
    const stderr = result.stderr ?? "";
    let lastPtsSeconds: number | null = null;
    let countedFrames = 0;
    for (const match of stderr.matchAll(/pts_time:([+-]?\d+(?:\.\d+)?)/g)) {
      const pts = Number(match[1]);
      if (!Number.isFinite(pts)) continue;
      lastPtsSeconds = Math.max(lastPtsSeconds ?? 0, pts);
      countedFrames += 1;
    }
    if (lastPtsSeconds === null || lastPtsSeconds <= 0 || countedFrames === 0) return null;
    return {
      durationMs: Math.max(1, Math.round(lastPtsSeconds * 1000)),
      frames: countedFrames,
      averageFps: countedFrames / lastPtsSeconds,
    };
  } catch {
    return null;
  }
}

/**
 * Take a captured webm (VP9 / VP8 / AV1) and produce a final mp4 / webm / gif.
 * For mp4: re-encodes video with hardware H.264 if available; copies audio when possible.
 * For webm: stream-copies (instant).
 * For gif: applies palettegen + paletteuse, capped to 15fps / 720p / ~10s.
 */
export function remux(opts: RemuxOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const trimSeconds = opts.trimLastMs && opts.trimLastMs > 0
      ? Math.max(0.001, opts.trimLastMs / 1000)
      : null;
    const mediaDurationSeconds = opts.mediaDurationMs && opts.mediaDurationMs > 0
      ? opts.mediaDurationMs / 1000
      : null;
    const trimDurationSeconds = trimSeconds !== null && mediaDurationSeconds !== null
      ? Math.min(trimSeconds, mediaDurationSeconds)
      : null;
    const trimStartSeconds = trimSeconds !== null && mediaDurationSeconds !== null
      ? Math.max(0, mediaDurationSeconds - trimSeconds)
      : null;
    const sidecarTrimStartSeconds = trimStartSeconds !== null
      ? Math.max(0, trimStartSeconds + (opts.sidecarStartOffsetMs ?? 0) / 1000)
      : null;
    const args: string[] = [
      "-y", "-hide_banner", "-loglevel", "info",
      // WebM cluster timestamps from MediaRecorder are sparse / VFR; backfill
      // PTS so the mp4 muxer doesn't carry that VFR shape into the output.
      "-fflags", "+genpts",
    ];
    args.push("-i", opts.inputPath);
    // Sidecar audio (Linux PulseAudio capture) becomes input #1.
    if (opts.audioPath) {
      args.push("-i", opts.audioPath);
    }

    // Decide audio routing once — used by both webm and mp4 paths. The
    // tricky case is when both the WebM (mic) and the sidecar (system
    // audio) have audio: we mix instead of dropping one.
    const hasInputAudio = !!opts.inputHasAudio;
    const hasSidecar = !!opts.audioPath;
    const audioMode: "none" | "mix" | "sidecar-only" | "input-only" =
      hasInputAudio && hasSidecar ? "mix" :
      hasSidecar ? "sidecar-only" :
      hasInputAudio ? "input-only" : "none";

    const useComplexTrim = trimStartSeconds !== null && opts.format !== "gif";
    const videoMap = useComplexTrim ? "[vout]" : "0:v:0";
    let audioMap: string | null = null;
    const filters: string[] = [];
    if (useComplexTrim && trimDurationSeconds !== null) {
      filters.push(`[0:v:0]trim=start=${trimStartSeconds}:duration=${trimDurationSeconds},setpts=PTS-STARTPTS[vout]`);
      if (audioMode === "input-only" || audioMode === "mix") {
        filters.push(`[0:a:0]atrim=start=${trimStartSeconds}:duration=${trimDurationSeconds},asetpts=PTS-STARTPTS[a0]`);
      }
      if ((audioMode === "sidecar-only" || audioMode === "mix") && sidecarTrimStartSeconds !== null) {
        filters.push(`[1:a:0]atrim=start=${sidecarTrimStartSeconds}:duration=${trimDurationSeconds},asetpts=PTS-STARTPTS[a1]`);
      }
      if (audioMode === "mix") {
        filters.push("[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0[aout]");
        audioMap = "[aout]";
      } else if (audioMode === "sidecar-only") {
        audioMap = "[a1]";
      } else if (audioMode === "input-only") {
        audioMap = "[a0]";
      }
    }
    if (filters.length > 0) {
      args.push("-filter_complex", filters.join(";"));
    }

    if (opts.format === "webm") {
      if (trimStartSeconds === null) args.push("-c", "copy");
      else args.push("-c:v", "libvpx-vp9");
      if (audioMode === "sidecar-only") {
        // AAC isn't valid in WebM, so we re-encode the sidecar to opus.
        args.push("-map", videoMap, "-map", audioMap ?? "1:a:0", "-c:a", "libopus", "-b:a", "160k");
      } else if (audioMode === "mix") {
        args.push("-map", videoMap, "-map", audioMap ?? "[aout]", "-c:a", "libopus", "-b:a", "160k");
      } else if (trimStartSeconds !== null) {
        args.push("-map", videoMap);
        if (audioMode === "input-only") args.push("-map", audioMap ?? "0:a:0", "-c:a", "libopus", "-b:a", "160k");
      }
      // input-only / none: -c copy already covers it.
    } else if (opts.format === "mp4") {
      const enc = opts.videoEncoderOverride ?? pickHardwareVideoEncoder("mp4", opts.encoders);
      args.push("-c:v", enc);
      // Output bitrate ceiling per preset. Quality stays content-aware via
      // -crf / -cq, but a maxrate cap stops libx264 from peaking at
      // 100+ Mbps on a 4K source — the previous unconstrained -crf 20 was
      // producing ~120 Mbps files for short Gaming-preset captures. The
      // numbers track the preset hints ("~16 Mbps" gaming, "~6 Mbps"
      // regular) with a 1.5× peak headroom.
      const targetMbps = opts.preset === "gaming" ? 16 : 6;
      const maxMbps = Math.round(targetMbps * 1.5);
      if (enc === "libx264") {
        args.push(
          "-preset", "veryfast",
          "-crf", opts.preset === "gaming" ? "20" : "23",
          "-maxrate", `${maxMbps}M`,
          "-bufsize", `${maxMbps * 2}M`,
        );
      } else if (enc === "h264_nvenc") {
        args.push(
          "-preset", "p4",
          "-rc", "vbr",
          "-cq", opts.preset === "gaming" ? "20" : "23",
          "-b:v", `${targetMbps}M`,
          "-maxrate", `${maxMbps}M`,
        );
      } else if (enc === "h264_amf") {
        args.push(
          "-quality", "balanced",
          "-rc", "vbr_peak",
          "-b:v", `${targetMbps}M`,
          "-maxrate", `${maxMbps}M`,
        );
      } else if (enc === "h264_qsv") {
        args.push(
          "-preset", "veryfast",
          "-global_quality", opts.preset === "gaming" ? "20" : "23",
          "-maxrate", `${maxMbps}M`,
          "-bufsize", `${maxMbps * 2}M`,
        );
      }
      if (trimStartSeconds !== null) {
        // Replay saves trim a sparse/VFR MediaRecorder stream. Preserve the
        // captured cadence instead of duplicating frames up to the preset fps.
        args.push("-fps_mode", "passthrough");
      } else {
        // Pin CFR + an explicit framerate so r_frame_rate and avg_frame_rate
        // agree in the output mp4. Without this, strict players read the WebM
        // input's VFR cluster timestamps and bail after ~1 s.
        const fps = opts.fps && opts.fps > 0 ? opts.fps : 30;
        args.push("-fps_mode", "cfr", "-r", String(fps));
      }
      args.push("-pix_fmt", "yuv420p", "-movflags", "+faststart");
      if (audioMode === "mix") {
        args.push("-map", videoMap, "-map", audioMap ?? "[aout]");
      } else if (audioMode === "sidecar-only") {
        args.push("-map", videoMap, "-map", audioMap ?? "1:a:0");
      } else if (audioMode === "input-only") {
        args.push("-map", videoMap, "-map", audioMap ?? "0:a:0");
      } else if (trimStartSeconds !== null) {
        args.push("-map", videoMap);
      } // none without trim: ffmpeg's default selection keeps us silent
      // 256 kbps AAC is transparent enough that the second encoding pass
      // (Opus → AAC for the input-only Windows path) is no longer audible.
      // Pin sample rate + stereo so nothing silently downmixes during mux.
      args.push(
        "-c:a", "aac",
        "-b:a", "256k",
        "-ar", "48000",
        "-ac", "2",
        "-shortest",
      );
    } else if (opts.format === "gif") {
      const fps = 15;
      const scale = 720;
      const trimPrefix = trimStartSeconds !== null && trimDurationSeconds !== null
        ? `trim=start=${trimStartSeconds}:duration=${trimDurationSeconds},setpts=PTS-STARTPTS,`
        : "";
      args.push(
        "-vf",
        `${trimPrefix}fps=${fps},scale=${scale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`,
        "-loop", "0",
      );
    }

    args.push(opts.outputPath);

    const proc = spawn(opts.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (b: Buffer) => opts.onLog?.(b.toString("utf-8")));
    proc.stderr.on("data", (b: Buffer) => opts.onLog?.(b.toString("utf-8")));
    proc.once("error", (err) => reject(err));
    proc.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}
