import type { CustomQuality, Preset, PresetId, ReplayQuality } from "./types";

export const CUSTOM_QUALITY_DEFAULTS: CustomQuality = {
  fps: 60,
  videoBitsPerSecond: 12_000_000,
  scaleHeight: 1080,
};

export const CUSTOM_QUALITY_LIMITS = {
  fps: { min: 15, max: 120, step: 5 },
  videoMbps: { min: 1, max: 50, step: 1 },        // shown in UI as Mbps
  scaleHeight: { min: 360, max: 2160, step: 60 }, // height; width derives from track
};

/**
 * Preset MIME types are passed to MediaRecorder (Chromium). Chromium's
 * MediaRecorder reliably supports `video/webm;codecs=vp9` plus opus audio,
 * so we record to webm and let ffmpeg remux to mp4 / gif on stop.
 *
 * "Custom" reads its values from the store at recording time; the entry
 * here is just a placeholder so picker UI can list it. The renderer's
 * `effectivePreset()` swaps the live values in.
 */
export const PRESETS: Record<PresetId, Preset> = {
  regular: {
    id: "regular",
    name: "Regular",
    hint: "1080p · 30 fps · ~6 Mbps · MP4 (H.264)",
    format: "mp4",
    mimeType: "video/webm;codecs=vp9,opus",
    videoBitsPerSecond: 6_000_000,
    // 384 kbps Opus gives the second encoding pass (Opus → AAC at finalize
    // on the Windows path) enough headroom to stay transparent for music.
    // 256 kbps was clean for voice but slightly off for stereo music.
    audioBitsPerSecond: 384_000,
    fps: 30,
    audio: false,
  },
  gaming: {
    id: "gaming",
    name: "Gaming",
    hint: "1080p · 60 fps · ~16 Mbps · MP4 (H.264)",
    format: "mp4",
    mimeType: "video/webm;codecs=vp9,opus",
    videoBitsPerSecond: 16_000_000,
    audioBitsPerSecond: 320_000,
    fps: 60,
    audio: true,
  },
  gif: {
    id: "gif",
    name: "GIF",
    hint: "10s · 15 fps · 720p · palettized GIF",
    format: "gif",
    mimeType: "video/webm;codecs=vp9",
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 0,
    fps: 30,
    audio: false,
  },
  custom: {
    id: "custom",
    name: "Custom",
    hint: "Editable fps / bitrate / resolution",
    format: "mp4",
    mimeType: "video/webm;codecs=vp9,opus",
    videoBitsPerSecond: CUSTOM_QUALITY_DEFAULTS.videoBitsPerSecond,
    audioBitsPerSecond: 384_000,
    fps: CUSTOM_QUALITY_DEFAULTS.fps,
    audio: true,
  },
};

export const PRESET_LIST: Preset[] = [PRESETS.regular, PRESETS.gaming, PRESETS.gif, PRESETS.custom];

/**
 * Returns a Preset with `custom`'s fps + bitrate filled in from the user's
 * live customQuality state. Other presets pass through unchanged.
 */
export function effectivePreset(id: PresetId, custom: CustomQuality): Preset {
  if (id !== "custom") return PRESETS[id];
  return {
    ...PRESETS.custom,
    fps: custom.fps,
    videoBitsPerSecond: custom.videoBitsPerSecond,
  };
}

// Slightly over 10s to compensate for MediaRecorder's stop-event latency and
// the ffmpeg fps=15 filter rounding the tail down. With chunk-write draining
// in stop(), the final GIF lands at ~10s instead of ~9.
export const GIF_MAX_DURATION_MS = 10_500;

/**
 * Replay buffer quality presets. Replay capture used to feed
 * MediaRecorder a raw 4K@60 stream and Chromium's software VP9 encoder
 * couldn't keep up — we'd see ~10 fps land on disk. The downscale pipeline
 * fixed that for the conservative 1080p30 default; these presets let
 * users opt into smoother capture when their CPU has the headroom.
 *
 * - `performance`: the safe default, matches the original 1080p30 fix
 * - `balanced`: 1080p60 — fits inside VP8 software-encode budget on
 *   recent CPUs (Zen 3+/Alder Lake+/Apple silicon)
 * - `quality`: 1440p60 — needs more CPU; H.264 hardware path helps when
 *   the Chromium build supports `video/webm;codecs=h264`
 * - `native`: source resolution at min(srcFps, 60) — explicitly
 *   experimental; falls back to the same constraints that caused the
 *   original choppiness on a 4K@60 source
 *
 * Bitrate scales roughly with pixels/sec; values are MediaRecorder
 * targets — Chromium will exceed them for complex content but won't
 * fall below by much.
 */
export interface ReplayQualityPreset {
  id: ReplayQuality;
  label: string;
  // Hint shown in the dropdown so users don't have to translate jargon.
  hint: string;
  maxWidth: number;
  maxHeight: number;
  fps: number;
  videoBitsPerSecond: number;
}

export const REPLAY_QUALITY_PRESETS: Record<ReplayQuality, ReplayQualityPreset> = {
  performance: {
    id: "performance",
    label: "Performance",
    hint: "1080p · 30fps · 6 Mbps",
    maxWidth: 1920,
    maxHeight: 1080,
    fps: 30,
    videoBitsPerSecond: 6_000_000,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    hint: "1080p · 60fps · 12 Mbps",
    maxWidth: 1920,
    maxHeight: 1080,
    fps: 60,
    videoBitsPerSecond: 12_000_000,
  },
  quality: {
    id: "quality",
    label: "Quality",
    hint: "1440p · 60fps · 20 Mbps",
    maxWidth: 2560,
    maxHeight: 1440,
    fps: 60,
    videoBitsPerSecond: 20_000_000,
  },
  native: {
    id: "native",
    label: "Native (experimental)",
    hint: "source · ≤60fps · 40 Mbps",
    maxWidth: Number.POSITIVE_INFINITY,
    maxHeight: Number.POSITIVE_INFINITY,
    fps: 60,
    videoBitsPerSecond: 40_000_000,
  },
};

export const REPLAY_QUALITY_LIST: ReplayQualityPreset[] = [
  REPLAY_QUALITY_PRESETS.performance,
  REPLAY_QUALITY_PRESETS.balanced,
  REPLAY_QUALITY_PRESETS.quality,
  REPLAY_QUALITY_PRESETS.native,
];

export const DEFAULT_REPLAY_QUALITY: ReplayQuality = "balanced";
