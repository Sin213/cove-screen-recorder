import type { Preset, PresetId } from "./types";

/**
 * Preset MIME types are passed to MediaRecorder (Chromium). Chromium's
 * MediaRecorder reliably supports `video/webm;codecs=vp9` plus opus audio,
 * so we record to webm and let ffmpeg remux to mp4 / gif on stop.
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
};

export const PRESET_LIST: Preset[] = [PRESETS.regular, PRESETS.gaming, PRESETS.gif];

// Slightly over 10s to compensate for MediaRecorder's stop-event latency and
// the ffmpeg fps=15 filter rounding the tail down. With chunk-write draining
// in stop(), the final GIF lands at ~10s instead of ~9.
export const GIF_MAX_DURATION_MS = 10_500;
