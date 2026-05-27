import type { CaptureSource, CropRect, CustomQuality, PresetId } from "./types";
import {
  GIF_MAX_DURATION_MS,
  PRESETS,
  REPLAY_QUALITY_PRESETS,
  effectivePreset,
  type ReplayQualityPreset,
} from "./presets";

// On Linux, source-audio from getDisplayMedia/getUserMedia is unreliable
// (Wayland: mono mid-portal trick; X11: may double-up with the PulseAudio
// sidecar). The Linux sidecar is the canonical system-audio source. Drop
// portal audio everywhere on Linux. Computed from navigator.userAgent
// instead of plumbing appInfo through React closures (the closure path
// captured stale null on first render and silently flipped this off).
const IS_LINUX = /linux/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
  navigator.userAgent,
);

interface ChromiumGetUserMediaConstraints {
  audio?: false | {
    mandatory?: {
      chromeMediaSource: "desktop";
      chromeMediaSourceId?: string;
    };
  };
  video: {
    mandatory: {
      chromeMediaSource: "desktop";
      chromeMediaSourceId: string;
      maxFrameRate?: number;
      minFrameRate?: number;
      maxWidth?: number;
      maxHeight?: number;
    };
  };
}

export interface CaptureSession {
  recorder: MediaRecorder;
  sourceStream: MediaStream;
  // The exact stream MediaRecorder is encoding — i.e. the canvas-cropped
  // stream when in crop mode, otherwise the raw source. Useful for showing
  // a live in-app preview of what's actually being saved.
  previewStream: MediaStream;
  micStream: MediaStream | null;
  recordingId: string;
  preset: PresetId;
  startedAt: number;
  stop: () => Promise<void>;
  cancel: () => void;
}

export interface StartCaptureOptions {
  source: CaptureSource;
  preset: PresetId;
  // Live values used when preset === "custom". Pass-through so we don't
  // have to reach into the store from this layer.
  customQuality?: CustomQuality;
  outputDir: string;
  withMic: boolean;
  withSystemAudio: boolean;
  cropRect?: CropRect | null;
  // Recording encoder target. When set (and not in crop / custom / gif
  // mode), the source stream is canvas-downscaled before MediaRecorder
  // sees it — same fix applied to the replay buffer. Drives the source
  // frameRate constraint, output mime/bitrate, and target dimensions.
  captureQuality?: ReplayQualityPreset;
  onChunk?: () => void;
  onAutoStop?: () => void;
  onError?: (message: string) => void;
  onLog?: (level: "info" | "warn" | "error" | "good", text: string) => void;
}

export interface StartDisplayMediaOptions {
  // What to ask the portal for: a monitor, a window, or either.
  kind: "screen" | "window" | "all";
  // Used to label the recording when the picked source has no readable name.
  fallbackName?: string;
  preset: PresetId;
  customQuality?: CustomQuality;
  // See StartCaptureOptions.captureQuality.
  captureQuality?: ReplayQualityPreset;
  outputDir: string;
  withMic: boolean;
  withSystemAudio: boolean;
  // Linux: the main process runs a PulseAudio system-audio sidecar when
  // sysaudio is enabled. Set this true so the renderer doesn't ALSO put
  // the portal's audio track into the WebM (which would then get mixed
  // with the sidecar at finalize → doubled signal → reverb).
  systemAudioHandledBySidecar?: boolean;
  cropRect?: CropRect | null;
  onChunk?: () => void;
  onAutoStop?: () => void;
  onError?: (message: string) => void;
  onLog?: (level: "info" | "warn" | "error" | "good", text: string) => void;
}

export async function startCapture(opts: StartCaptureOptions): Promise<CaptureSession> {
  const preset = opts.customQuality ? effectivePreset(opts.preset, opts.customQuality) : PRESETS[opts.preset];
  // captureQuality.fps overrides the preset fps when present — no point
  // asking the OS for 60 fps when we'll cap at 30 (Performance), and the
  // mismatch was part of why MediaRecorder used to choke on 4K@60.
  const sourceFps = opts.captureQuality?.fps ?? preset.fps;

  // Modern path: route through setDisplayMediaRequestHandler so Chromium
  // accepts `audio: "loopback"` for system audio on Windows. The legacy
  // chromeMediaSource:"desktop" audio constraint silently returned a
  // video-only stream on Electron 32+. Pre-tell the handler which source
  // the user picked from the Cove SourceModal.
  await window.cove.setPickedDisplayMediaSource(opts.source.id);
  await window.cove.setNextDisplayMedia(
    opts.source.kind === "window" ? "window" : "screen",
  );

  let sourceStream: MediaStream;
  try {
    // Explicit stereo / 48 kHz audio constraint. Chromium's WASAPI loopback
    // on Windows otherwise inherits the playback device's "default format",
    // which Windows often leaves at mono — the captured audio comes out
    // 1ch and music sounds flat. With `channelCount: 2 (ideal)` Chromium
    // will internally upmix to satisfy the constraint when the source is
    // mono. On Linux this branch isn't hit when sysaudio is on (sidecar
    // handles it), so this can't regress the Linux flow.
    sourceStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: sourceFps, max: sourceFps } },
      audio: opts.withSystemAudio
        ? {
            channelCount: { ideal: 2 },
            sampleRate: { ideal: 48000 },
            // WebRTC's voice-tuned audio chain is on by default for any
            // mediaDevices stream. It runs AGC + noise suppression + echo
            // cancellation over the loopback feed — fine for voice calls,
            // disastrous for music: gain pumping, transient softening,
            // tonal smearing. Turning all three off gives Chromium's pure
            // capture without DSP, so what we encode matches what plays.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          }
        : false,
    });
  } catch (err) {
    // Last-ditch fallback to the legacy constraint — useful in case some
    // Windows setup blocks getDisplayMedia for our preselected source.
    opts.onLog?.("warn", `getDisplayMedia failed (${describeError(err)}); falling back to legacy capture.`);
    const constraints = {
      audio: opts.withSystemAudio
        ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: opts.source.id } }
        : false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: opts.source.id,
          maxFrameRate: sourceFps,
          minFrameRate: 5,
        },
      },
    } as unknown as ChromiumGetUserMediaConstraints;
    sourceStream = await navigator.mediaDevices.getUserMedia(
      constraints as unknown as MediaStreamConstraints,
    );
  }

  const audioTrackList = sourceStream.getAudioTracks();
  const videoTrackList = sourceStream.getVideoTracks();
  if (opts.withSystemAudio && audioTrackList.length === 0) {
    opts.onLog?.(
      "warn",
      `Capture returned ${videoTrackList.length} video, 0 audio — system audio loopback unavailable on this Windows install.`,
    );
  } else {
    const aDesc = audioTrackList.map((t) => {
      const s = t.getSettings();
      const ch = s.channelCount ?? "?";
      const sr = s.sampleRate ?? "?";
      return `${ch}ch@${sr}Hz "${t.label || "no-label"}"`;
    }).join(", ");
    opts.onLog?.(
      "info",
      `Source stream — ${videoTrackList.length} video, ${audioTrackList.length} audio${aDesc ? ` [${aDesc}]` : ""}`,
    );
  }

  return wrapStreamIntoSession({
    sourceStream,
    mode: opts.source.kind === "window" ? "window" : "screen",
    sourceId: opts.source.id,
    sourceName: opts.source.name,
    preset: opts.preset,
    customQuality: opts.customQuality,
    captureQuality: opts.captureQuality,
    outputDir: opts.outputDir,
    withMic: opts.withMic,
    withSystemAudio: opts.withSystemAudio,
    omitSourceAudio: IS_LINUX,
    cropRect: opts.cropRect ?? null,
    onChunk: opts.onChunk,
    onAutoStop: opts.onAutoStop,
    onError: opts.onError,
    onLog: opts.onLog,
  });
}

// Wayland (and any platform that supports getDisplayMedia) — Electron fulfils
// this through the main-process display media handler. On Linux that handler
// must call desktopCapturer.getSources(), which opens the portal picker.
export async function startCaptureViaDisplayMedia(
  opts: StartDisplayMediaOptions,
): Promise<CaptureSession> {
  const preset = opts.customQuality ? effectivePreset(opts.preset, opts.customQuality) : PRESETS[opts.preset];
  const sourceFps = opts.captureQuality?.fps ?? preset.fps;

  await window.cove.setNextDisplayMedia(opts.kind);

  const sourceStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: sourceFps, max: sourceFps } },
    // System audio is best-effort on Wayland — depends on portal + PipeWire.
    audio: opts.withSystemAudio,
  });

  // Wayland subtlety: with our placeholder source-ID approach, Electron
  // resolves getDisplayMedia() immediately while PipeWire is still showing
  // the portal picker. The track exists but isn't producing frames. The
  // `muted` flag is unreliable here (Chromium often leaves it false even
  // while the source isn't connected), so wait for the actual first frame
  // via a hidden <video> element — `loadeddata` only fires when real pixels
  // arrive from PipeWire.
  const videoTrack = sourceStream.getVideoTracks()[0];
  if (videoTrack) {
    await waitForFirstFrame(sourceStream, videoTrack);
  }

  // Fetch what the user picked in the portal so we can label the recording.
  const picked = await window.cove.getLastDisplayMediaSelection();
  const settings = videoTrack?.getSettings?.() as MediaTrackSettings & { displaySurface?: string };
  const displaySurface = settings?.displaySurface;
  const inferredKind: "screen" | "window" =
    picked?.kind ??
    (displaySurface === "window" || displaySurface === "browser" ? "window" : "screen");
  const sourceName =
    picked?.name ??
    videoTrack?.label ??
    opts.fallbackName ??
    (inferredKind === "window" ? "Window" : "Screen");
  const sourceId = picked?.id ?? `displaymedia:${videoTrack?.id ?? "unknown"}`;

  return wrapStreamIntoSession({
    sourceStream,
    mode: inferredKind,
    sourceId,
    sourceName,
    preset: opts.preset,
    customQuality: opts.customQuality,
    captureQuality: opts.captureQuality,
    outputDir: opts.outputDir,
    withMic: opts.withMic,
    withSystemAudio: opts.withSystemAudio,
    omitSourceAudio: IS_LINUX,
    cropRect: opts.cropRect ?? null,
    onChunk: opts.onChunk,
    onAutoStop: opts.onAutoStop,
    onError: opts.onError,
    onLog: opts.onLog,
  });
}

interface WrapOptions {
  sourceStream: MediaStream;
  mode: "screen" | "window";
  sourceId: string;
  sourceName: string;
  preset: PresetId;
  customQuality?: CustomQuality;
  captureQuality?: ReplayQualityPreset;
  outputDir: string;
  withMic: boolean;
  withSystemAudio: boolean;
  // When true, the system-audio sidecar (Linux PulseAudio capture) handles
  // system audio — so we must NOT also let the WebM include the portal's
  // own system-audio track, otherwise the two streams get mixed and the
  // result has comb-filter "reverb".
  omitSourceAudio?: boolean;
  cropRect: CropRect | null;
  onChunk?: () => void;
  onAutoStop?: () => void;
  onError?: (message: string) => void;
  onLog?: (level: "info" | "warn" | "error" | "good", text: string) => void;
}

async function wrapStreamIntoSession(opts: WrapOptions): Promise<CaptureSession> {
  const preset = opts.customQuality ? effectivePreset(opts.preset, opts.customQuality) : PRESETS[opts.preset];
  const { sourceStream } = opts;

  let micStream: MediaStream | null = null;
  if (opts.withMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      opts.onLog?.("warn", `Microphone unavailable: ${describeError(err)}`);
    }
  }

  // Pipeline selection: crop wins (user explicitly chose a region), else
  // captureQuality builds a downscale canvas (same fix that unblocked
  // replay), else passthrough. Crop / gif / custom intentionally skip the
  // downscale because their dimensions are user-driven; captureQuality is
  // suppressed for those cases by App.tsx so we don't need to re-check it
  // here, but the cropPipeline branch wins anyway.
  const cropPipeline = opts.cropRect ? buildCropPipeline(sourceStream, opts.cropRect, preset.fps) : null;
  const sourceVideoTrack = sourceStream.getVideoTracks()[0] ?? null;
  const downscalePipeline = !cropPipeline && opts.captureQuality && sourceVideoTrack
    ? buildDownscalePipeline(sourceStream, sourceVideoTrack, opts.captureQuality)
    : null;
  const activePipeline = cropPipeline ?? downscalePipeline;

  // Source diagnostics — pair with the encoder-target log so the user can
  // see at a glance that e.g. a 4K@60 source is being recorded as 1080p60.
  if (downscalePipeline && sourceVideoTrack) {
    const ts = sourceVideoTrack.getSettings() as MediaTrackSettings & {
      displaySurface?: string;
      logicalSurface?: boolean;
      cursor?: string;
    };
    const trackFps = typeof ts.frameRate === "number" ? Math.round(ts.frameRate * 10) / 10 : null;
    const summary = [
      `${ts.width ?? "?"}×${ts.height ?? "?"}`,
      `${trackFps ?? "?"}fps`,
      ts.displaySurface ? `surface=${ts.displaySurface}` : null,
      typeof ts.logicalSurface === "boolean" ? `logical=${ts.logicalSurface}` : null,
      ts.cursor ? `cursor=${ts.cursor}` : null,
    ].filter(Boolean).join(" · ");
    const trackLabel = sourceVideoTrack.label || "(no label)";
    opts.onLog?.("info", `Recording capture source — ${summary} · "${trackLabel}"`);
  }

  const composedStream = new MediaStream();
  if (activePipeline) {
    for (const t of activePipeline.stream.getVideoTracks()) composedStream.addTrack(t);
  } else {
    for (const t of sourceStream.getVideoTracks()) composedStream.addTrack(t);
  }
  if (!opts.omitSourceAudio) {
    for (const t of sourceStream.getAudioTracks()) composedStream.addTrack(t);
  }
  if (micStream) for (const t of micStream.getAudioTracks()) composedStream.addTrack(t);

  // Codec + bitrate: when captureQuality is driving the pipeline, use the
  // performance-first mime list (VP8 → H.264 → VP9 → webm) and the
  // preset's bitrate budget. The preset.mimeType "vp9" path is kept for
  // crop / gif / custom flows, where the source is already user-sized
  // and VP9 quality can be afforded.
  const hasAudio = composedStream.getAudioTracks().length > 0;
  const mimeType = downscalePipeline ? pickFastMime(hasAudio) : pickSupportedMime(preset.mimeType);
  if (!mimeType) {
    activePipeline?.stop();
    sourceStream.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    throw new Error("No supported MediaRecorder MIME type for this preset");
  }

  if (downscalePipeline) {
    const codecMatch = /codecs=([^;,)]+)/i.exec(mimeType);
    opts.onLog?.(
      "info",
      `Recording encoder target — ${downscalePipeline.output.width}×${downscalePipeline.output.height} · `
      + `${downscalePipeline.output.fps}fps · codec=${codecMatch?.[1] ?? mimeType} · `
      + `preset=${opts.captureQuality?.label ?? "?"}`,
    );
  }

  const recorder = new MediaRecorder(composedStream, {
    mimeType,
    videoBitsPerSecond: opts.captureQuality?.videoBitsPerSecond ?? preset.videoBitsPerSecond,
    audioBitsPerSecond: preset.audioBitsPerSecond || undefined,
  });

  const { recordingId } = await window.cove.beginRecording({
    mode: opts.mode,
    preset: opts.preset,
    outputDir: opts.outputDir,
    withMic: opts.withMic,
    withSystemAudio: opts.withSystemAudio,
    sourceId: opts.sourceId,
    sourceName: opts.sourceName,
  });

  // Track in-flight chunk writes so stop() can wait for them. Without this,
  // MediaRecorder's `stop` event fires before the final ondataavailable IPC
  // round-trip completes, and finalize() runs against a temp file that's
  // missing its tail — typically ~1s for a 1s chunk cadence (the cause of
  // GIFs landing at 9s instead of the 10s cap).
  const pendingChunks = new Set<Promise<void>>();

  recorder.ondataavailable = (ev) => {
    if (!ev.data || ev.data.size === 0) return;
    const write = (async () => {
      try {
        const buf = await ev.data.arrayBuffer();
        await window.cove.saveChunk(recordingId, buf);
        opts.onChunk?.();
      } catch (err) {
        opts.onError?.(describeError(err));
      }
    })();
    pendingChunks.add(write);
    void write.finally(() => pendingChunks.delete(write));
  };

  recorder.onerror = (ev: Event) => {
    const message = (ev as unknown as { error?: { message?: string } }).error?.message
      ?? "MediaRecorder error";
    opts.onError?.(message);
  };

  // Browser surface ended (user clicked the OS "stop sharing" button) →
  // auto-stop. Listen on the *source* tracks: when a downscale pipeline
  // is active, composedStream contains canvas tracks that keep firing
  // even after the source dies, so they would never raise 'ended'.
  for (const t of sourceStream.getVideoTracks()) {
    t.addEventListener("ended", () => opts.onAutoStop?.());
  }

  recorder.start(1000); // 1s chunk cadence
  const startedAt = performance.now();

  if (opts.preset === "gif") {
    setTimeout(() => {
      if (recorder.state === "recording") opts.onAutoStop?.();
    }, GIF_MAX_DURATION_MS);
  }

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      const finish = async () => {
        recorder.removeEventListener("stop", finish);
        // Drain any chunk writes still in flight before letting finalize
        // close the temp file.
        await Promise.allSettled([...pendingChunks]);
        activePipeline?.stop();
        for (const t of composedStream.getTracks()) t.stop();
        sourceStream.getTracks().forEach((t) => t.stop());
        micStream?.getTracks().forEach((t) => t.stop());
        resolve();
      };
      if (recorder.state === "inactive") {
        void finish();
      } else {
        recorder.addEventListener("stop", finish);
        recorder.stop();
      }
    });

  const cancel = () => {
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      // ignore
    }
    activePipeline?.stop();
    for (const t of composedStream.getTracks()) t.stop();
    sourceStream.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    void window.cove.cancelRecording(recordingId);
  };

  // Build a video-only preview stream. We strip audio so the in-app
  // <video> element doesn't echo system audio back through the speakers.
  const previewStream = new MediaStream();
  for (const t of composedStream.getVideoTracks()) previewStream.addTrack(t);

  return { recorder, sourceStream, previewStream, micStream, recordingId, preset: opts.preset, startedAt, stop, cancel };
}

interface CropPipeline {
  stream: MediaStream;
  stop: () => void;
}

function buildCropPipeline(sourceStream: MediaStream, rect: CropRect, fps: number): CropPipeline {
  const video = document.createElement("video");
  video.srcObject = sourceStream;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  void video.play().catch(() => { /* ignore */ });

  const dpr = rect.dpr || 1;
  // Crop region in source-stream pixels. desktopCapturer streams the source at
  // ~display physical resolution; the overlay reported logical CSS pixels, so
  // multiply by DPR to get source pixels.
  const sx = Math.round(rect.x * dpr);
  const sy = Math.round(rect.y * dpr);
  const sw = Math.max(2, Math.round(rect.width * dpr));
  const sh = Math.max(2, Math.round(rect.height * dpr));

  // Output size: even numbers (encoder requirement), preserve crop aspect.
  const outW = sw % 2 === 0 ? sw : sw - 1;
  const outH = sh % 2 === 0 ? sh : sh - 1;

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) {
    return {
      stream: sourceStream,
      stop: () => { /* noop */ },
    };
  }

  let stopped = false;
  const frameInterval = 1000 / fps;
  let lastDraw = 0;

  // Auto-correct crop coords if the source resolution differs from what we expected.
  const draw = (now: number) => {
    if (stopped) return;
    if (now - lastDraw >= frameInterval - 1) {
      lastDraw = now;
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (vw > 0 && vh > 0) {
          // Clamp to actual video extents in case of DPR mismatch.
          const cx = Math.min(Math.max(0, sx), Math.max(0, vw - 2));
          const cy = Math.min(Math.max(0, sy), Math.max(0, vh - 2));
          const cw = Math.max(2, Math.min(sw, vw - cx));
          const ch = Math.max(2, Math.min(sh, vh - cy));
          ctx.drawImage(video, cx, cy, cw, ch, 0, 0, outW, outH);
        }
      } catch {
        // drawImage can throw briefly while video metadata loads — ignore.
      }
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  const stream = canvas.captureStream(fps);

  return {
    stream,
    stop: () => {
      stopped = true;
      video.pause();
      video.srcObject = null;
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

function pickSupportedMime(preferred: string): string | null {
  const candidates = [
    preferred,
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

// Codec preference is performance-first: VP8 is real-time at 1080p30 on any
// CPU we ship to, H.264 hits hardware encoders in some Chromium builds, and
// VP9 stays in the list only as a last-resort floor. Used for both replay
// buffer and quality-preset normal recording.
function pickFastMime(hasAudio: boolean): string | null {
  const audioSuffix = hasAudio ? ",opus" : "";
  const candidates = [
    `video/webm;codecs=vp8${audioSuffix}`,
    `video/webm;codecs=h264${audioSuffix}`,
    `video/webm;codecs=vp9${audioSuffix}`,
    "video/webm",
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

interface DownscalePipeline {
  stream: MediaStream;
  output: { width: number; height: number; fps: number };
  stop: () => void;
}

// Render the source displayMedia stream into a hidden canvas at the
// quality preset's max dimensions / fps cap, then expose
// canvas.captureStream() as the video source for MediaRecorder. Same
// canvas pattern as the crop path; target dimensions come from the
// preset rather than a user-drawn region. Aspect ratio is preserved;
// sources at or below the preset max are kept at native dimensions
// (we never upscale).
function buildDownscalePipeline(
  sourceStream: MediaStream,
  videoTrack: MediaStreamTrack,
  qualityPreset: ReplayQualityPreset,
): DownscalePipeline | null {
  const settings = videoTrack.getSettings();
  const srcW = settings.width ?? 0;
  const srcH = settings.height ?? 0;
  const srcFps = typeof settings.frameRate === "number" && settings.frameRate > 0
    ? settings.frameRate
    : qualityPreset.fps;
  if (srcW < 2 || srcH < 2) return null;

  const scale = srcW > qualityPreset.maxWidth || srcH > qualityPreset.maxHeight
    ? Math.min(qualityPreset.maxWidth / srcW, qualityPreset.maxHeight / srcH)
    : 1;
  // Even-pixel dimensions — H.264/VP9 chroma subsampling requires it and
  // VP8 silently right-pads otherwise (causing a 1-px green column).
  const outW = Math.max(2, Math.round((srcW * scale) / 2) * 2);
  const outH = Math.max(2, Math.round((srcH * scale) / 2) * 2);
  const outFps = Math.min(qualityPreset.fps, Math.max(1, Math.round(srcFps)));

  const video = document.createElement("video");
  video.srcObject = sourceStream;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  void video.play().catch(() => { /* ignore — first-frame gating already succeeded */ });

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) return null;

  let stopped = false;
  const frameInterval = 1000 / outFps;
  let lastDraw = 0;

  const draw = (now: number) => {
    if (stopped) return;
    if (now - lastDraw >= frameInterval - 1) {
      lastDraw = now;
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (vw > 0 && vh > 0) {
          ctx.drawImage(video, 0, 0, vw, vh, 0, 0, outW, outH);
        }
      } catch {
        // drawImage can throw briefly while video metadata loads — ignore.
      }
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  const stream = canvas.captureStream(outFps);

  return {
    stream,
    output: { width: outW, height: outH, fps: outFps },
    stop: () => {
      stopped = true;
      try { video.pause(); } catch { /* ignore */ }
      video.srcObject = null;
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ============================================================ Replay buffer */

export interface ReplayBufferOptions {
  source: CaptureSource | null;  // null → constrained display-media flow
  sourceKind: "screen" | "window";
  preset: PresetId;
  customQuality?: CustomQuality;
  outputDir: string;
  withMic: boolean;
  withSystemAudio: boolean;
  lengthSeconds: number;
  // Quality preset for the replay capture pipeline (dimensions, fps cap,
  // bitrate). When omitted, defaults to the conservative `performance`
  // preset — but App.tsx always passes the user-selected one from the
  // store so this default rarely applies.
  replayQuality?: ReplayQualityPreset;
  onState: (state: { active: boolean; bufferedSeconds: number; chunks: number; error?: string }) => void;
  onError: (msg: string) => void;
  // Optional plumbing for buffer-side diagnostics — capture track settings
  // at start, save lifecycle notes — so they show up in the in-app log
  // panel and not just devtools.
  onLog?: (level: "info" | "warn" | "error" | "good", text: string) => void;
}

export interface ReplayBufferHandle {
  stop: () => Promise<void>;
  save: () => Promise<{ outputPath?: string; error?: string }>;
  state: () => { active: boolean; bufferedSeconds: number; chunks: number };
}

/**
 * Continuous capture session for instant replay. Save keeps the MediaRecorder
 * output as one complete stream and asks ffmpeg to trim the tail; it must not
 * splice arbitrary rolling timeslice blobs into a synthetic WebM.
 */
export async function startReplayBuffer(opts: ReplayBufferOptions): Promise<ReplayBufferHandle> {
  const preset = opts.customQuality ? effectivePreset(opts.preset, opts.customQuality) : PRESETS[opts.preset];
  if (preset.format === "gif") throw new Error("Replay buffer doesn't support the GIF preset.");
  const qualityPreset = opts.replayQuality ?? REPLAY_QUALITY_PRESETS.performance;
  const targetLostMessage = "Selected window was closed. Replay buffer stopped.";

  // Acquire source — same dance as normal capture, just without finalize.
  let sourceStream: MediaStream;
  if (opts.source) {
    await window.cove.setPickedDisplayMediaSource(opts.source.id);
    await window.cove.setNextDisplayMedia(opts.source.kind === "window" ? "window" : "screen");
  } else {
    await window.cove.setNextDisplayMedia(opts.sourceKind);
  }
  try {
    sourceStream = await navigator.mediaDevices.getDisplayMedia({
      // Constrain source fps to the replay quality target — no point
      // asking the portal for 60 fps when we'll cap at 30 (Performance),
      // and asking for 60 only when the preset actually wants it spares
      // the OS unnecessary frame production.
      video: { frameRate: { ideal: qualityPreset.fps, max: qualityPreset.fps } },
      audio: opts.withSystemAudio
        ? { channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 },
            echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
    });
  } catch (err) {
    if (opts.source?.kind === "window") {
      throw new Error(targetLostMessage);
    }
    throw err;
  }
  // Wait for first frame (Wayland portal session may not be live yet).
  const videoTrack = sourceStream.getVideoTracks()[0];
  if (videoTrack) await waitForFirstFrame(sourceStream, videoTrack);

  // Replay-buffer diagnostic: surface what the source actually delivered.
  // When playback turns out choppy, this is where to look first — a
  // PipeWire portal handing back 9 fps for a window capture is invisible
  // from the saved mp4 alone, and the choppiness is otherwise easy to
  // misread as an encoder problem. Logged once at start so the log isn't
  // spammed during the buffer's lifetime.
  if (videoTrack) {
    const ts = videoTrack.getSettings() as MediaTrackSettings & {
      displaySurface?: string;
      logicalSurface?: boolean;
      cursor?: string;
    };
    const trackFps = typeof ts.frameRate === "number" ? Math.round(ts.frameRate * 10) / 10 : null;
    const summary = [
      `${ts.width ?? "?"}×${ts.height ?? "?"}`,
      `${trackFps ?? "?"}fps`,
      ts.displaySurface ? `surface=${ts.displaySurface}` : null,
      typeof ts.logicalSurface === "boolean" ? `logical=${ts.logicalSurface}` : null,
      ts.cursor ? `cursor=${ts.cursor}` : null,
    ].filter(Boolean).join(" · ");
    const trackLabel = videoTrack.label || "(no label)";
    opts.onLog?.("info", `Replay capture source — ${summary} · "${trackLabel}"`);
    // Compared against the chosen quality preset's fps target. The
    // preset.fps from the recording config doesn't apply — the replay
    // pipeline caps at qualityPreset.fps independently. Anything below
    // half of that target is already too low for a smooth save no matter
    // what we do downstream; the main-process probe is the authoritative
    // cadence check at save time.
    if (trackFps !== null && trackFps > 0 && trackFps < qualityPreset.fps * 0.5) {
      opts.onLog?.(
        "warn",
        `Replay source is reporting only ${trackFps} fps — below the ${qualityPreset.fps} fps target `
        + `for the ${qualityPreset.label} preset. Capture will look choppy regardless of downscale.`,
      );
    }
  }

  // Optional mic.
  let micStream: MediaStream | null = null;
  if (opts.withMic) {
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
    catch { /* ignore — replay carries on without mic */ }
  }

  // Downscale + fps-cap the source before MediaRecorder sees it. Without
  // this, Chromium's software VP9 encoder gets pinned encoding 4K@60 and
  // silently drops to ~10 fps. This is the single biggest perf win for
  // replay capture. The quality preset controls how aggressive the cap
  // is — Performance keeps the original 1080p30 floor; Native effectively
  // disables the resolution cap (60 fps cap remains).
  const downscale = videoTrack
    ? buildDownscalePipeline(sourceStream, videoTrack, qualityPreset)
    : null;
  if (!downscale) {
    sourceStream.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    throw new Error("Replay buffer couldn't construct a capture canvas.");
  }

  const composedStream = new MediaStream();
  for (const t of downscale.stream.getVideoTracks()) composedStream.addTrack(t);
  if (!IS_LINUX) for (const t of sourceStream.getAudioTracks()) composedStream.addTrack(t);
  if (micStream) for (const t of micStream.getAudioTracks()) composedStream.addTrack(t);

  const hasAudio = composedStream.getAudioTracks().length > 0;
  const mimeType = pickFastMime(hasAudio);
  if (!mimeType) {
    downscale.stop();
    sourceStream.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    throw new Error("No supported MediaRecorder MIME type for replay buffer.");
  }

  // Replay-target log: pairs with the "Replay capture source" line above
  // so the user can see at a glance that a 4K source is being recorded
  // as 1080p, what codec is in use, what the encoder fps cap is, and
  // which preset is driving the choice.
  const codecMatch = /codecs=([^;,)]+)/i.exec(mimeType);
  opts.onLog?.(
    "info",
    `Replay encoder target — ${downscale.output.width}×${downscale.output.height} · `
    + `${downscale.output.fps}fps · codec=${codecMatch?.[1] ?? mimeType} · preset=${qualityPreset.label}`,
  );

  const cleanup = () => {
    downscale.stop();
    for (const t of composedStream.getTracks()) t.stop();
    sourceStream.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
  };

  interface ReplayRecording {
    recordingId: string;
    recorder: MediaRecorder;
    pendingChunks: Set<Promise<void>>;
    startedAt: number;
    startedAtWallMs: number;
    stoppedAtWallMs?: number;
    chunks: number;
  }

  const beginReplayRecording = async (): Promise<ReplayRecording> => {
    const { recordingId } = await window.cove.beginRecording({
      mode: opts.sourceKind,
      preset: opts.preset,
      outputDir: opts.outputDir,
      withMic: opts.withMic,
      withSystemAudio: opts.withSystemAudio,
      isReplay: true,
      sourceId: opts.source?.id ?? "replay",
      sourceName: opts.source?.name ?? "Replay buffer",
    });
    try {
      const recorder = new MediaRecorder(composedStream, {
        mimeType,
        // Replay overrides the recording-preset bitrate — that one is sized
        // for the *source* resolution (e.g. 16 Mbps for 4K). The replay
        // bitrate scales with the quality preset's pixels/sec budget so
        // Performance gets a tight 6 Mbps floor and Native gets enough
        // headroom for 4K motion without bloating shorter buffers.
        videoBitsPerSecond: qualityPreset.videoBitsPerSecond,
        audioBitsPerSecond: preset.audioBitsPerSecond || undefined,
      });
      const session: ReplayRecording = {
        recordingId,
        recorder,
        pendingChunks: new Set<Promise<void>>(),
        startedAt: performance.now(),
        startedAtWallMs: 0,
        chunks: 0,
      };

      recorder.ondataavailable = (ev) => {
        if (!ev.data || ev.data.size === 0) return;
        const write = (async () => {
          try {
            const buf = await ev.data.arrayBuffer();
            await window.cove.saveChunk(recordingId, buf);
            session.chunks += 1;
            const t = performance.now() - session.startedAt;
            opts.onState({
              active: !stopped,
              bufferedSeconds: Math.min(opts.lengthSeconds, t / 1000),
              chunks: session.chunks,
            });
          } catch (err) {
            opts.onError(describeError(err));
          }
        })();
        session.pendingChunks.add(write);
        void write.finally(() => session.pendingChunks.delete(write));
      };

      recorder.onerror = (ev: Event) => {
        const msg = (ev as unknown as { error?: { message?: string } }).error?.message ?? "MediaRecorder error";
        opts.onError(msg);
      };

      recorder.start(1000);
      session.startedAtWallMs = Date.now();
      return session;
    } catch (err) {
      await window.cove.cancelRecording(recordingId);
      throw err;
    }
  };

  let stopped = false;
  let saving = false;
  let targetLost = false;
  let suppressTrackEndedUntil = 0;
  let activeRecording: ReplayRecording;
  try {
    activeRecording = await beginReplayRecording();
  } catch (err) {
    cleanup();
    throw err;
  }

  const markTargetLost = () => {
    if (stopped || targetLost) return;
    targetLost = true;
    opts.onError(targetLostMessage);
    void handleStop(targetLostMessage);
  };

  let frameWatchStop: (() => void) | null = null;
  // Listen on the *source* video tracks, not composedStream's. The canvas
  // downscale pipeline keeps drawing the last frame even after the source
  // dies, so canvas-track 'ended' would never fire on its own. Source
  // tracks still fire normally (user pressed OS "stop sharing", window
  // closed, portal session ended).
  for (const t of sourceStream.getVideoTracks()) {
    t.addEventListener("ended", () => {
      if (Date.now() < suppressTrackEndedUntil) return;
      if (opts.sourceKind === "window") markTargetLost();
      else void handleStop();
    });
    if (opts.sourceKind === "window") {
      t.addEventListener("mute", () => {
        window.setTimeout(() => {
          if (!stopped && t.muted && Date.now() >= suppressTrackEndedUntil) markTargetLost();
        }, 3000);
      });
    }
  }

  if (opts.sourceKind === "window") {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = sourceStream;
    let lastFrameAt = performance.now();
    let frameCallback = 0;
    const videoWithFrames = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const onFrame = () => {
      lastFrameAt = performance.now();
      if (!stopped && videoWithFrames.requestVideoFrameCallback) {
        frameCallback = videoWithFrames.requestVideoFrameCallback(onFrame);
      }
    };
    if (videoWithFrames.requestVideoFrameCallback) {
      frameCallback = videoWithFrames.requestVideoFrameCallback(onFrame);
    }
    const interval = window.setInterval(() => {
      if (!stopped && performance.now() - lastFrameAt > 5000) markTargetLost();
    }, 1000);
    void video.play().catch(() => { /* first-frame gating already succeeded */ });
    frameWatchStop = () => {
      window.clearInterval(interval);
      if (frameCallback && videoWithFrames.cancelVideoFrameCallback) {
        videoWithFrames.cancelVideoFrameCallback(frameCallback);
      }
      try { video.pause(); } catch { /* ignore */ }
      video.srcObject = null;
    };
  }

  const handleStop = async (error?: string) => {
    if (stopped) return;
    stopped = true;
    try {
      if (activeRecording.recorder.state !== "inactive") activeRecording.recorder.stop();
    } catch { /* ignore */ }
    await Promise.allSettled([...activeRecording.pendingChunks]);
    await window.cove.cancelRecording(activeRecording.recordingId);
    frameWatchStop?.();
    cleanup();
    opts.onState({ active: false, bufferedSeconds: 0, chunks: 0, error });
  };

  const save = async (): Promise<{ outputPath?: string; error?: string }> => {
    if (saving) return { error: "Replay save already in progress." };
    if (targetLost) return { error: targetLostMessage };
    if (stopped) return { error: "Replay buffer is not running." };
    if (activeRecording.chunks === 0) return { error: "Replay buffer hasn't captured any data yet." };
    saving = true;

    const sessionToSave = activeRecording;

    try {
      await new Promise<void>((resolve) => {
        const finish = () => {
          sessionToSave.recorder.removeEventListener("stop", finish);
          sessionToSave.stoppedAtWallMs = Date.now();
          resolve();
        };
        if (sessionToSave.recorder.state === "inactive") {
          sessionToSave.stoppedAtWallMs = sessionToSave.stoppedAtWallMs ?? Date.now();
          resolve();
        } else {
          sessionToSave.recorder.addEventListener("stop", finish);
          sessionToSave.recorder.stop();
        }
      });
      await Promise.allSettled([...sessionToSave.pendingChunks]);
      if (targetLost) {
        await window.cove.cancelRecording(sessionToSave.recordingId);
        return { error: targetLostMessage };
      }

      const result = await window.cove.finalizeRecording({
        recordingId: sessionToSave.recordingId,
        preset: opts.preset,
        format: preset.format,
        durationMs: Math.round((sessionToSave.stoppedAtWallMs ?? Date.now()) - sessionToSave.startedAtWallMs),
        trimLastMs: opts.lengthSeconds * 1000,
        mediaStartedAtMs: sessionToSave.startedAtWallMs,
        mediaStoppedAtMs: sessionToSave.stoppedAtWallMs,
        // Send the *encoder target* fps (e.g. 30) instead of the preset's
        // 60 — the main-process cadence check needs to compare what we
        // actually asked MediaRecorder for, not what the preset would have
        // requested if we hadn't downscaled.
        fps: downscale.output.fps,
      });
      if (!stopped) {
        try {
          suppressTrackEndedUntil = Date.now() + 4000;
          activeRecording = await beginReplayRecording();
        } catch (err) {
          stopped = true;
          cleanup();
          opts.onError(`Replay buffer stopped after save: ${describeError(err)}`);
        }
      }
      if (result.ok && result.outputPath) {
        return { outputPath: result.outputPath };
      }
      return { error: result.error ?? "Replay save failed." };
    } finally {
      saving = false;
    }
  };

  return {
    stop: handleStop,
    save,
    state: () => ({
      active: !stopped,
      bufferedSeconds: activeRecording.chunks > 0
        ? Math.min(opts.lengthSeconds, (performance.now() - activeRecording.startedAt) / 1000)
        : 0,
      chunks: activeRecording.chunks,
    }),
  };
}

// Resolve when the source actually starts producing frames. Used to gate
// MediaRecorder.start() on Wayland where getDisplayMedia() resolves before
// the portal picker is dismissed. A 30-second timeout exists so a portal
// or driver that hands us a track but never produces frames doesn't leave
// the UI permanently stuck in "Preparing".
const FIRST_FRAME_TIMEOUT_MS = 30_000;

function waitForFirstFrame(
  stream: MediaStream,
  track: MediaStreamTrack,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    let settled = false;
    const timer = window.setTimeout(() => finish(() => {
      // Stop the dead stream so we don't leak the portal session.
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      reject(new Error(
        `Capture stream produced no frames after ${FIRST_FRAME_TIMEOUT_MS / 1000}s — portal or driver may have stalled.`,
      ));
    }), FIRST_FRAME_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timer);
      track.removeEventListener("ended", onEnded);
      video.onloadeddata = null;
      video.onerror = null;
      try { video.pause(); } catch { /* ignore */ }
      video.srcObject = null;
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onEnded = () => finish(() =>
      reject(new DOMException("Capture cancelled", "NotAllowedError")),
    );
    track.addEventListener("ended", onEnded);
    video.onloadeddata = () => finish(() => resolve());
    video.onerror = () => finish(() =>
      reject(new Error("Failed to read source stream")),
    );
    video.play().catch((err) => finish(() => reject(err)));
  });
}
