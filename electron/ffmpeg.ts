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

// Return encoder candidates in preference order. Hardware encoders that
// definitely won't work on the detected GPU (e.g. h264_nvenc on an AMD box,
// where ffmpeg lists it but loading nvcuda.dll fails at runtime) are
// dropped to avoid scary error logs and a wasted encode attempt. The list
// always ends in libx264 (or libvpx-vp9 for webm) as a guaranteed software
// fallback. VAAPI is intentionally excluded — needs hwupload plumbing we
// don't ship.
export function getEncoderCandidates(format: CaptureFormat, encoders: string[]): string[] {
  if (format === "gif") return ["gif"];

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

  const candidates = reordered.filter((enc) => encoders.includes(enc));
  // Always end with the unconditional software fallback.
  const swFallback = format === "webm" ? "libvpx-vp9" : "libx264";
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
  // Optional second input — system-audio captured separately by the
  // PulseAudio/PipeWire sidecar. Muxed onto the video at finalize.
  audioPath?: string | null;
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

/**
 * Take a captured webm (VP9 / VP8 / AV1) and produce a final mp4 / webm / gif.
 * For mp4: re-encodes video with hardware H.264 if available; copies audio when possible.
 * For webm: stream-copies (instant).
 * For gif: applies palettegen + paletteuse, capped to 15fps / 720p / ~10s.
 */
export function remux(opts: RemuxOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = ["-y", "-hide_banner", "-loglevel", "info", "-i", opts.inputPath];
    // Sidecar audio (Linux PulseAudio capture) becomes input #1.
    if (opts.audioPath) args.push("-i", opts.audioPath);

    // Decide audio routing once — used by both webm and mp4 paths. The
    // tricky case is when both the WebM (mic) and the sidecar (system
    // audio) have audio: we mix instead of dropping one.
    const hasInputAudio = !!opts.inputHasAudio;
    const hasSidecar = !!opts.audioPath;
    const audioMode: "none" | "mix" | "sidecar-only" | "input-only" =
      hasInputAudio && hasSidecar ? "mix" :
      hasSidecar ? "sidecar-only" :
      hasInputAudio ? "input-only" : "none";

    if (opts.format === "webm") {
      args.push("-c", "copy");
      if (audioMode === "sidecar-only") {
        // AAC isn't valid in WebM, so we re-encode the sidecar to opus.
        args.push("-map", "0:v:0", "-map", "1:a:0", "-c:a", "libopus", "-b:a", "160k");
      } else if (audioMode === "mix") {
        args.push(
          "-filter_complex",
          "[0:a:0][1:a:0]amix=inputs=2:duration=longest:dropout_transition=0[aout]",
          "-map", "0:v:0", "-map", "[aout]",
          "-c:a", "libopus", "-b:a", "160k",
        );
      }
      // input-only / none: -c copy already covers it.
    } else if (opts.format === "mp4") {
      const enc = opts.videoEncoderOverride ?? pickHardwareVideoEncoder("mp4", opts.encoders);
      args.push("-c:v", enc);
      if (enc === "libx264") {
        args.push("-preset", "veryfast", "-crf", opts.preset === "gaming" ? "20" : "23");
      } else if (enc === "h264_nvenc") {
        args.push("-preset", "p4", "-rc", opts.preset === "gaming" ? "cbr" : "vbr",
          "-cq", opts.preset === "gaming" ? "20" : "23", "-b:v", opts.preset === "gaming" ? "8M" : "0");
      } else if (enc === "h264_amf") {
        args.push("-quality", "balanced", "-rc", opts.preset === "gaming" ? "cbr" : "vbr_peak",
          "-b:v", opts.preset === "gaming" ? "8M" : "5M");
      } else if (enc === "h264_qsv") {
        args.push("-preset", "veryfast", "-global_quality", opts.preset === "gaming" ? "20" : "23");
      }
      args.push("-pix_fmt", "yuv420p", "-movflags", "+faststart");
      if (audioMode === "mix") {
        args.push(
          "-filter_complex",
          "[0:a:0][1:a:0]amix=inputs=2:duration=longest:dropout_transition=0[aout]",
          "-map", "0:v:0", "-map", "[aout]",
        );
      } else if (audioMode === "sidecar-only") {
        args.push("-map", "0:v:0", "-map", "1:a:0");
      } else if (audioMode === "input-only") {
        args.push("-map", "0:v:0", "-map", "0:a:0");
      } // none: ffmpeg's default selection keeps us silent
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
      args.push(
        "-vf",
        `fps=${fps},scale=${scale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`,
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
