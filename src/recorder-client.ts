import type { CaptureSource, CropRect, PresetId } from "./types";
import { GIF_MAX_DURATION_MS, PRESETS } from "./presets";

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
  outputDir: string;
  withMic: boolean;
  withSystemAudio: boolean;
  cropRect?: CropRect | null;
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
  const preset = PRESETS[opts.preset];

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
      video: { frameRate: { ideal: preset.fps, max: preset.fps } },
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
          maxFrameRate: preset.fps,
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
  const preset = PRESETS[opts.preset];

  await window.cove.setNextDisplayMedia(opts.kind);

  const sourceStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: preset.fps, max: preset.fps } },
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
  const preset = PRESETS[opts.preset];
  const { sourceStream } = opts;

  let micStream: MediaStream | null = null;
  if (opts.withMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      opts.onLog?.("warn", `Microphone unavailable: ${describeError(err)}`);
    }
  }

  // If we have a crop rect, run the screen frames through a canvas first and
  // record the canvas's captureStream — that way we encode only the cropped
  // region, not the whole screen.
  const cropPipeline = opts.cropRect ? buildCropPipeline(sourceStream, opts.cropRect, preset.fps) : null;

  const composedStream = new MediaStream();
  if (cropPipeline) {
    for (const t of cropPipeline.stream.getVideoTracks()) composedStream.addTrack(t);
  } else {
    for (const t of sourceStream.getVideoTracks()) composedStream.addTrack(t);
  }
  if (!opts.omitSourceAudio) {
    for (const t of sourceStream.getAudioTracks()) composedStream.addTrack(t);
  }
  if (micStream) for (const t of micStream.getAudioTracks()) composedStream.addTrack(t);

  const mimeType = pickSupportedMime(preset.mimeType);
  if (!mimeType) {
    sourceStream.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    throw new Error("No supported MediaRecorder MIME type for this preset");
  }

  const recorder = new MediaRecorder(composedStream, {
    mimeType,
    videoBitsPerSecond: preset.videoBitsPerSecond,
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

  // Browser surface ended (user clicked the OS "stop sharing" button) → auto-stop.
  for (const t of composedStream.getVideoTracks()) {
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
        cropPipeline?.stop();
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
    cropPipeline?.stop();
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

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
