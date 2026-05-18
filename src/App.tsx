import { useCallback, useEffect, useRef, useState } from "react";
import { SourceModal } from "./components/SourceModal";
import { HotkeysDialog } from "./components/HotkeysDialog";
import { useStore } from "./store";
import { initV2Engine, saveReplay as v2SaveReplay } from "./v2/engine";
import { Diagnostics } from "./v2/Diagnostics";
import type { AppInfo, CaptureSource, CropRect, PresetId } from "./types";
import {
  startCapture,
  startCaptureViaDisplayMedia,
  startReplayBuffer,
  type CaptureSession,
  type ReplayBufferHandle,
} from "./recorder-client";
import {
  PRESETS,
  PRESET_LIST,
  REPLAY_QUALITY_LIST,
  REPLAY_QUALITY_PRESETS,
  effectivePreset,
  CUSTOM_QUALITY_LIMITS,
} from "./presets";
import type { ReplayQuality } from "./types";

type IntentMode = "screen" | "window";

function isWaylandSession(info: AppInfo | null): boolean {
  return info?.platform === "linux" && info.sessionType === "wayland";
}

function formatPlatform(info: AppInfo): string {
  const session = info.sessionType?.toLowerCase();
  switch (info.platform) {
    case "win32": return "Windows";
    case "darwin": return "macOS";
    case "linux": {
      if (session === "wayland") return "Linux · Wayland";
      if (session === "x11") return "Linux · X11";
      return "Linux";
    }
    case "freebsd": return "FreeBSD";
    default: return info.platform;
  }
}

interface PendingStart {
  preset: PresetId;
  mode: IntentMode;
}

export function App() {
  const status = useStore((s) => s.status);
  const setStatus = useStore((s) => s.setStatus);
  const setRecording = useStore((s) => s.setRecording);
  const tickElapsed = useStore((s) => s.tickElapsed);
  const elapsedMs = useStore((s) => s.elapsedMs);
  const setLastOutput = useStore((s) => s.setLastOutput);
  const setLastError = useStore((s) => s.setLastError);
  const log = useStore((s) => s.log);
  const setAppInfo = useStore((s) => s.setAppInfo);

  const preset = useStore((s) => s.preset);
  const setPreset = useStore((s) => s.setPreset);
  const outputDir = useStore((s) => s.outputDir);
  const setOutputDir = useStore((s) => s.setOutputDir);
  const withMic = useStore((s) => s.withMic);
  const setMic = useStore((s) => s.setMic);
  const withSystemAudio = useStore((s) => s.withSystemAudio);
  const setSystemAudio = useStore((s) => s.setSystemAudio);
  const hotkeysEnabled = useStore((s) => s.hotkeysEnabled);
  const setHotkeysEnabled = useStore((s) => s.setHotkeys);
  const hotkeyBindings = useStore((s) => s.hotkeyBindings);
  const setHotkeyBindings = useStore((s) => s.setHotkeyBindings);
  const lastOutput = useStore((s) => s.lastOutputPath);
  const lastError = useStore((s) => s.lastError);
  const appInfo = useStore((s) => s.appInfo);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const customQuality = useStore((s) => s.customQuality);
  const setCustomQuality = useStore((s) => s.setCustomQuality);
  const replay = useStore((s) => s.replay);
  const setReplay = useStore((s) => s.setReplay);
  const logs = useStore((s) => s.logs);
  const clearLogs = useStore((s) => s.clearLogs);
  const logCollapsed = useStore((s) => s.logCollapsed);
  const setLogCollapsed = useStore((s) => s.setLogCollapsed);

  const v2State = useStore((s) => s.v2State);

  // Initialize v2 engine subscriptions once on mount.
  useEffect(() => initV2Engine(), []);

  const [pendingStart, setPendingStart] = useState<PendingStart | null>(null);
  const [pendingReplaySource, setPendingReplaySource] = useState<IntentMode | null>(null);
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [replayHandle, setReplayHandle] = useState<ReplayBufferHandle | null>(null);
  const [replayBuffered, setReplayBuffered] = useState(0);
  const [replaySaving, setReplaySaving] = useState(false);
  const replayHandleRef = useRef<ReplayBufferHandle | null>(null);
  useEffect(() => { replayHandleRef.current = replayHandle; }, [replayHandle]);
  const [livePreview, setLivePreview] = useState<MediaStream | null>(null);
  const sessionRef = useRef<CaptureSession | null>(null);
  const stopFlowRef = useRef<((manual: boolean) => Promise<void>) | null>(null);

  // Boot: app info + ffmpeg detection.
  useEffect(() => {
    let mounted = true;
    window.cove.getAppInfo().then((info) => {
      if (!mounted) return;
      setAppInfo(info);
      if (!info.ffmpeg.available) {
        log("warn", "ffmpeg not found — recordings will save as raw .webm. Install ffmpeg for MP4/GIF.");
      } else if (info.ffmpeg.encoders.length > 0) {
        log("info", `ffmpeg ${info.ffmpeg.version ?? ""} · encoders: ${info.ffmpeg.encoders.slice(0, 6).join(", ")}${info.ffmpeg.encoders.length > 6 ? "…" : ""}`);
      }
      if (isWaylandSession(info)) {
        log("info", "Wayland session — pick the source in the system screen-share dialog (one prompt per recording).");
      }
    });
    return () => { mounted = false; };
  }, [setAppInfo, log]);

  useEffect(() => {
    void window.cove.registerHotkeys(hotkeysEnabled);
  }, [hotkeysEnabled]);

  useEffect(() => {
    void window.cove.setHotkeyBindings(hotkeyBindings);
  }, [hotkeyBindings]);

  useEffect(() => {
    if (status !== "recording") return;
    const id = setInterval(() => tickElapsed(), 250);
    return () => clearInterval(id);
  }, [status, tickElapsed]);

  useEffect(() => {
    const off = window.cove.onProgress((p) => {
      if (p.stage === "muxing" && p.message) {
        const m = p.message.trim();
        // Surface anything informative: ffmpeg progress lines, errors, and
        // recorder-side diagnostics (audio sidecar status, etc.). We still
        // drop the per-second `size=` clutter from sidecar stderr.
        const interesting =
          m.startsWith("frame=") ||
          m.startsWith("audio sidecar") ||
          m.startsWith("displayMedia handler") ||
          m.startsWith("replay") ||
          /error|warning|fail/i.test(m);
        if (interesting && !m.startsWith("size=")) {
          log("info", m.slice(0, 200));
        }
      }
      if (p.stage === "done" && p.outputPath) log("good", `Saved → ${p.outputPath}`);
      if (p.stage === "error" && p.message) log("error", p.message);
    });
    return off;
  }, [log]);

  const getCurrentAppInfo = useCallback(async () => {
    if (appInfo) return appInfo;
    const info = await window.cove.getAppInfo();
    setAppInfo(info);
    return info;
  }, [appInfo, setAppInfo]);

  const startWithSource = useCallback(
    async (source: CaptureSource, presetId: PresetId, cropRect?: CropRect | null) => {
      setPendingStart(null);
      setStatus("preparing");
      setLastError(null);
      try {
        const dir = outputDir ?? "";
        // captureQuality drives the canvas downscale + fast codec path
        // for normal recording. Skipped for crop (region already user-
        // sized), gif (own pipeline), and custom (user-tuned values).
        const captureQuality = (cropRect || presetId === "gif" || presetId === "custom")
          ? undefined
          : REPLAY_QUALITY_PRESETS[replay.quality];
        const session = await startCapture({
          source,
          preset: presetId,
          customQuality,
          captureQuality,
          outputDir: dir,
          withMic,
          withSystemAudio,
          cropRect: cropRect ?? null,
          onAutoStop: () => void stopFlowRef.current?.(false),
          onError: (msg) => { log("error", msg); setLastError(msg); },
          onLog: (level, text) => log(level, text),
        });
        sessionRef.current = session;
        setLivePreview(session.previewStream);
        setRecording(session.recordingId);
        setStatus("recording");
        const region = cropRect ? ` · ${cropRect.width}×${cropRect.height}` : "";
        log("info", `Recording ${source.name} (${PRESETS[presetId].name}${region})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("error", `Failed to start: ${msg}`);
        setLastError(msg);
        setStatus("idle");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outputDir, withMic, withSystemAudio, customQuality, replay.quality, setStatus, setRecording, setLastError, log],
  );

  const startWaylandCapture = useCallback(
    async (kind: "screen" | "window", presetId: PresetId, cropRect: CropRect | null = null) => {
      setPendingStart(null);
      setStatus("preparing");
      setLastError(null);
      try {
        const dir = outputDir ?? "";
        const captureQuality = (cropRect || presetId === "gif" || presetId === "custom")
          ? undefined
          : REPLAY_QUALITY_PRESETS[replay.quality];
        const session = await startCaptureViaDisplayMedia({
          kind,
          fallbackName: kind === "window" ? "Window" : "Screen",
          preset: presetId,
          customQuality,
          captureQuality,
          outputDir: dir,
          withMic,
          withSystemAudio,
          // Linux: the main process runs a PulseAudio sidecar for system
          // audio. Tell the renderer not to also bake the portal's audio
          // track into the WebM, otherwise the two streams would end up
          // mixed at finalize and the result would have comb-filter reverb.
          systemAudioHandledBySidecar: appInfo?.platform === "linux",
          cropRect,
          onAutoStop: () => void stopFlowRef.current?.(false),
          onError: (msg) => { log("error", msg); setLastError(msg); },
          onLog: (level, text) => log(level, text),
        });
        sessionRef.current = session;
        setLivePreview(session.previewStream);
        setRecording(session.recordingId);
        setStatus("recording");
        const region = cropRect ? ` · ${cropRect.width}×${cropRect.height}` : "";
        log("info", `Recording ${kind} (${PRESETS[presetId].name}${region})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          log("info", "Capture cancelled");
        } else {
          log("error", `Failed to start: ${msg}`);
          setLastError(msg);
        }
        setStatus("idle");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outputDir, withMic, withSystemAudio, customQuality, replay.quality, appInfo, setStatus, setRecording, setLastError, log],
  );

  const beginScreen = useCallback(
    async (presetId: PresetId) => {
      if (status !== "idle") return;
      const info = await getCurrentAppInfo();
      if (isWaylandSession(info)) {
        await startWaylandCapture("screen", presetId);
        return;
      }
      const screens = await window.cove.listSources("screen");
      if (screens.length === 1) await startWithSource(screens[0], presetId);
      else if (screens.length > 1) setPendingStart({ preset: presetId, mode: "screen" });
      else log("error", "No screens detected.");
    },
    [status, getCurrentAppInfo, log, startWithSource, startWaylandCapture],
  );

  const beginWindow = useCallback(
    async (presetId: PresetId) => {
      if (status !== "idle") return;
      const info = await getCurrentAppInfo();
      if (isWaylandSession(info)) {
        await startWaylandCapture("window", presetId);
        return;
      }
      setPendingStart({ preset: presetId, mode: "window" });
    },
    [status, getCurrentAppInfo, startWaylandCapture],
  );

  const beginCrop = useCallback(
    async (presetId: PresetId) => {
      if (status !== "idle") return;
      const info = await getCurrentAppInfo();
      if (isWaylandSession(info)) {
        log("info", "Use the dialog's “Share region” option to record a specific area.");
        await startWaylandCapture("screen", presetId);
        return;
      }
      setStatus("preparing");
      const result = await window.cove.selectCropRegion();
      if (!result) {
        setStatus("idle");
        return;
      }
      setStatus("idle");
      if (result.source) await startWithSource(result.source, presetId, result.rect);
      else log("error", "Crop selection returned no source.");
    },
    [status, getCurrentAppInfo, setStatus, startWithSource, startWaylandCapture, log],
  );

  const beginDefault = useCallback(() => {
    if (mode === "window") void beginWindow(preset);
    else if (mode === "area") void beginCrop(preset);
    else void beginScreen(preset);
  }, [mode, preset, beginWindow, beginScreen, beginCrop]);

  const stopFlow = useCallback(
    async (manual: boolean) => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      setLivePreview(null);
      setStatus("finalizing");
      try { await session.stop(); }
      catch (err) { log("warn", `Stop error: ${describe(err)}`); }
      const presetId = session.preset;
      const presetMeta = PRESETS[presetId];
      const resolvedPreset = effectivePreset(presetId, customQuality);
      const durationMs = Math.round(performance.now() - session.startedAt);
      log("info", manual ? "Stop requested — finalizing…" : "Auto-stop — finalizing…");
      const result = await window.cove.finalizeRecording({
        recordingId: session.recordingId,
        preset: presetId,
        format: presetMeta.format,
        durationMs,
        fps: resolvedPreset.fps,
      });
      if (result.ok && result.outputPath) {
        setLastOutput(result.outputPath);
        if (result.error) log("warn", result.error);
      } else if (!result.ok) {
        log("error", result.error ?? "Finalize failed");
        setLastError(result.error ?? "Finalize failed");
      }
      setRecording(null);
      setStatus("idle");
    },
    [customQuality, log, setLastOutput, setLastError, setRecording, setStatus],
  );

  // Keep ref synced so onAutoStop can call the latest stopFlow without
  // re-creating the session.
  useEffect(() => { stopFlowRef.current = stopFlow; }, [stopFlow]);

  const startReplayWithSource = useCallback(async (source: CaptureSource | null, sourceKind: IntentMode) => {
    if (replayHandle) return;
    setPendingReplaySource(null);
    setLastError(null);
    try {
      const dir = outputDir ?? "";
      const handle = await startReplayBuffer({
        source,
        sourceKind,
        preset,
        customQuality,
        outputDir: dir,
        withMic,
        withSystemAudio,
        lengthSeconds: replay.lengthSeconds,
        replayQuality: REPLAY_QUALITY_PRESETS[replay.quality],
        onState: (s) => {
          setReplayBuffered(s.bufferedSeconds);
          if (!s.active) {
            setReplayHandle(null);
            if (s.error) setLastError(s.error);
          }
        },
        onError: (msg) => { log("error", `Replay buffer: ${msg}`); setLastError(msg); },
        onLog: (level, text) => log(level, text),
      });
      setReplayHandle(handle);
      log("good", `Replay buffer started (${Math.round(replay.lengthSeconds / 60)} min window)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        log("info", "Replay buffer cancelled");
      } else {
        log("error", `Couldn't start replay buffer: ${msg}`);
        setLastError(msg);
      }
    }
  }, [replayHandle, outputDir, preset, customQuality, withMic, withSystemAudio, replay.lengthSeconds, log, setLastError]);

  const startReplay = useCallback(async () => {
    if (replayHandle) return;
    const replayKind: IntentMode = mode === "window" ? "window" : "screen";
    const info = await getCurrentAppInfo();
    if (replayKind === "window" && !isWaylandSession(info)) {
      setPendingReplaySource("window");
      return;
    }
    await startReplayWithSource(null, replayKind);
  }, [replayHandle, mode, getCurrentAppInfo, startReplayWithSource]);

  const stopReplay = useCallback(async () => {
    const h = replayHandleRef.current;
    if (!h) return;
    await h.stop();
    setReplayHandle(null);
    setReplayBuffered(0);
    log("info", "Replay buffer stopped");
  }, [log]);

  const saveReplay = useCallback(async () => {
    const h = replayHandleRef.current;
    if (!h) {
      log("warn", "Replay buffer isn't running — start it from the footer first.");
      return;
    }
    if (replaySaving) {
      log("info", "Replay save already in progress.");
      return;
    }
    log("info", "Saving replay…");
    setReplaySaving(true);
    try {
      const result = await h.save();
      if (result.outputPath) {
        setLastOutput(result.outputPath);
        log("good", `Replay saved → ${result.outputPath}`);
      } else if (result.error) {
        log("error", `Replay save failed: ${result.error}`);
        setLastError(result.error);
      }
    } finally {
      setReplaySaving(false);
    }
  }, [log, setLastOutput, setLastError, replaySaving]);

  // Hotkey + Esc.
  useEffect(() => {
    const off = window.cove.onHotkey((action) => {
      if (action === "toggle") {
        if (status === "recording") void stopFlow(true);
        else if (status === "idle") beginDefault();
      } else if (action === "gif") {
        if (status === "idle") void beginCrop("gif");
      } else if (action === "replay") {
        if (v2State === "RECORDING") {
          void v2SaveReplay(replay.lengthSeconds);
        } else if (v2State !== "SAVING" && v2State !== "EXPORTING") {
          void saveReplay();
        }
        // Suppress while v2 is busy (SAVING/EXPORTING)
      }
    });
    return off;
  }, [status, beginDefault, beginCrop, stopFlow, saveReplay, v2State, replay.lengthSeconds]);

  useEffect(() => {
    if (status !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); void stopFlow(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, stopFlow]);

  const presetMeta = effectivePreset(preset, customQuality);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const isRecording = status === "recording";
  const recordingState: "ready" | "recording" | "preparing" | "error" = isRecording
    ? "recording"
    : replaySaving || status === "preparing" || status === "finalizing"
      ? "preparing"
      : lastError
        ? "error"
        : "ready";
  const recordingLabel = isRecording
    ? "Recording"
    : replaySaving
      ? "Saving replay"
      : status === "preparing"
        ? "Preparing"
        : status === "finalizing"
          ? "Finalizing"
          : lastError
            ? "Error"
            : "Ready";

  const bigButtonDisabled = status !== "idle" && !isRecording;
  const triggerDefault = () => {
    if (isRecording) void stopFlow(true);
    else if (status === "idle") beginDefault();
  };

  return (
    <div className="chrome">
      <Titlebar />

      <div className="app">
        {/* Stage (left) */}
        <div className="stage">
          <div className="hero">
            <div>
              <h1>Cove Screen Recorder</h1>
              <p>Pick a region, hit record, save. Hardware-accelerated MP4 + one-click GIF.</p>
            </div>
            <span className="status-pill" data-state={recordingState}>
              <span className="dot" />{recordingLabel}
            </span>
          </div>

          {(isRecording || livePreview) && (
            <CapturePreview
              mode={mode}
              preset={preset}
              recording={isRecording}
              elapsedSeconds={elapsedSeconds}
              liveStream={livePreview}
            />
          )}

          <Stats preset={preset} mode={mode} elapsedSeconds={elapsedSeconds} recording={isRecording} />

          <div>
            <div className="section-label" style={{ marginBottom: 10 }}>Capture source</div>
            <div className="source-group">
              <SourceTile active={mode === "area"}   onClick={() => setMode("area")}   icon={<Icons.Crop />}    title="Crop"   desc="Drag to select a region" />
              <SourceTile active={mode === "screen"} onClick={() => setMode("screen")} icon={<Icons.Monitor />} title="Screen" desc="Record an entire monitor" />
              <SourceTile active={mode === "window"} onClick={() => setMode("window")} icon={<Icons.Window />}  title="Window" desc="Pick an application window" />
            </div>
          </div>
        </div>

        {/* Panel (right) */}
        <div className="panel">
          {/* Preset */}
          <div className="section">
            <div className="section-row">
              <div className="section-label">Preset</div>
              <div className="preset-summary">
                <b>{presetMeta.fps}</b> fps
                <span className="sep">·</span>
                {preset === "gif"
                  ? "palette"
                  : <><span>~{Math.round(presetMeta.videoBitsPerSecond / 1_000_000)}</span> Mbps</>}
                <span className="sep">·</span>
                <b>{formatPresetCodec(preset)}</b>
              </div>
            </div>
            <div className="segmented" role="tablist">
              {PRESET_LIST.map((p) => (
                <button
                  key={p.id}
                  className={preset === p.id ? "active" : ""}
                  disabled={status !== "idle"}
                  onClick={() => setPreset(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
            {preset === "custom" && (
              <CustomQualityPanel
                value={customQuality}
                onChange={setCustomQuality}
                disabled={status !== "idle"}
              />
            )}
          </div>

          {/* Output folder */}
          <div className="section">
            <div className="section-label">Output folder</div>
            <div className="input-row">
              <input
                className="input"
                value={outputDir ?? ""}
                onChange={(e) => setOutputDir(e.target.value || null)}
                placeholder="~/Videos/Cove Recordings (default)"
                spellCheck={false}
              />
              <button
                className="icon-btn"
                title="Choose folder…"
                aria-label="Choose folder"
                onClick={async () => {
                  const dir = await window.cove.pickOutputDir();
                  if (dir) setOutputDir(dir);
                }}
              >
                <Icons.Folder />
              </button>
              <button
                className="icon-btn"
                title="Open folder"
                aria-label="Open folder"
                aria-disabled={!outputDir}
                onClick={() => outputDir && window.cove.openFolder(outputDir)}
              >
                <Icons.External />
              </button>
              <button
                className="icon-btn"
                title="Reset to default"
                aria-label="Reset"
                aria-disabled={!outputDir}
                onClick={() => setOutputDir(null)}
              >
                <Icons.X />
              </button>
            </div>
          </div>

          {/* Audio + hotkeys + default action */}
          <div className="section">
            <div className="section-label">Audio &amp; hotkeys</div>
            <div className="toggle-row">
              <button
                className={`toggle ${withMic ? "on" : ""}`}
                onClick={() => setMic(!withMic)}
              >
                <span className="check"><Icons.Check /></span>
                <span className="lbl">Microphone<small>capture mic</small></span>
              </button>
              <button
                className={`toggle ${withSystemAudio ? "on" : ""}`}
                onClick={() => setSystemAudio(!withSystemAudio)}
              >
                <span className="check"><Icons.Check /></span>
                <span className="lbl">System audio<small>desktop sound</small></span>
              </button>
              <button
                className={`toggle ${hotkeysEnabled ? "on" : ""}`}
                onClick={() => setHotkeysEnabled(!hotkeysEnabled)}
              >
                <span className="check"><Icons.Check /></span>
                <span className="lbl">Global hotkeys<small>system-wide</small></span>
              </button>
            </div>

            <details className="disc">
              <summary>
                <span className="caret"><Icons.Caret /></span>
                Hotkey default action
              </summary>
              <div className="disc-body">
                {([
                  { id: "area",   title: "Crop",   note: "Drag-to-select region (system portal on Wayland)" },
                  { id: "screen", title: "Screen", note: "Record full monitor" },
                  { id: "window", title: "Window", note: "Pick an application window" },
                ] as const).map((o) => (
                  <div key={o.id} className={`opt ${mode === o.id ? "on" : ""}`} onClick={() => setMode(o.id)}>
                    <span className="radio" />
                    <label><b>{o.title}</b> <span style={{ color: "var(--text-faint)" }}>· {o.note}</span></label>
                  </div>
                ))}
                <p style={{ margin: "4px 4px 0", fontSize: 11, color: "var(--text-faint)" }}>
                  Triggered by {hotkeyBindings.toggle}. Clicking a tile above also updates this.
                </p>
              </div>
            </details>
          </div>

          {/* Instant replay */}
          <div className="section">
            <div className="section-row">
              <div className="section-label">Instant replay</div>
              <span className="preset-summary">
                buffer <b>{Math.round(replay.lengthSeconds / 60 * 10) / 10}</b> min
                <span className="sep">·</span>
                <b>{REPLAY_QUALITY_PRESETS[replay.quality].label}</b>
                {replayHandle && (
                  <>
                    <span className="sep">·</span>
                    <span style={{ color: "var(--accent-2)" }}>
                      ● live {Math.floor(replayBuffered)}s
                    </span>
                  </>
                )}
              </span>
            </div>
            <input
              type="range"
              min={30}
              max={5 * 60}
              step={30}
              value={replay.lengthSeconds}
              disabled={!!replayHandle}
              onChange={(e) => setReplay({ ...replay, lengthSeconds: Number(e.target.value) })}
              style={{ width: "100%", accentColor: "var(--accent)" }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
              <label
                htmlFor="capture-quality"
                style={{ fontSize: 11, color: "var(--text-faint)", whiteSpace: "nowrap" }}
                title="Encoder target for both replay and normal recording. Crop, GIF, and Custom presets ignore this."
              >
                Capture quality
              </label>
              <select
                id="capture-quality"
                className="input"
                disabled={!!replayHandle || status === "recording"}
                value={replay.quality}
                onChange={(e) =>
                  setReplay({ ...replay, quality: e.target.value as ReplayQuality })
                }
                style={{ padding: "4px 8px", fontSize: 12, flex: 1 }}
              >
                {REPLAY_QUALITY_LIST.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.label} — {q.hint}
                  </option>
                ))}
              </select>
            </div>
            <div className="replay-actions">
              {!replayHandle ? (
                <button
                  className="btn btn-outline btn-sm"
                  disabled={status !== "idle"}
                  onClick={() => void startReplay()}
                >
                  Start replay buffer
                </button>
              ) : (
                <>
                  <button
                    className="btn btn-record btn-sm"
                    onClick={() => {
                      if (v2State === "RECORDING") void v2SaveReplay(replay.lengthSeconds);
                      else if (v2State !== "SAVING" && v2State !== "EXPORTING") void saveReplay();
                    }}
                    disabled={replaySaving || v2State === "SAVING" || v2State === "EXPORTING"}
                    aria-busy={replaySaving}
                  >
                    {replaySaving
                      ? "Saving replay…"
                      : `Save last ${Math.round(replay.lengthSeconds / 60 * 10) / 10} min`}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => void stopReplay()}
                    disabled={replaySaving}
                  >
                    Stop buffer
                  </button>
                </>
              )}
              <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
                Hotkey: <b style={{ color: "var(--text-dim)" }}>{hotkeyBindings.replay}</b>
              </span>
            </div>
          </div>

          {/* Action bar */}
          <div className={`actionbar ${isRecording ? "recording" : ""}`}>
            <div className="ab-info">
              <div className="t">
                {isRecording
                  ? `Recording · ${formatTime(elapsedSeconds)}`
                  : replaySaving
                    ? "Saving replay… (encoding to mp4)"
                    : status === "preparing"
                      ? "Preparing capture…"
                      : status === "finalizing"
                        ? "Finalizing recording…"
                        : "Ready to record"}
              </div>
              <div className="s">
                {modeLabel(mode)} · {presetMeta.name} · {formatPresetCodec(preset)}
              </div>
            </div>
            {isRecording ? (
              <button className="btn btn-stop" onClick={() => void stopFlow(true)}>
                <Icons.Stop /> Stop
              </button>
            ) : (
              <button
                className="btn btn-record"
                disabled={bigButtonDisabled}
                onClick={triggerDefault}
              >
                <Icons.Rec /> Record
              </button>
            )}
          </div>

          {/* Last save / last error */}
          {lastOutput && !isRecording && (
            <div className="section" style={{ padding: "12px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="status-pill" style={{ color: "var(--accent-2)", borderColor: "rgba(61,220,151,0.4)", background: "rgba(61,220,151,0.10)" }}>
                  <span className="dot" style={{ background: "var(--accent-2)" }} /> Saved
                </span>
                <span className="selectable mono" style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={lastOutput}>
                  {lastOutput}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void navigator.clipboard.writeText(lastOutput)}
                  title="Copy path"
                >
                  <Icons.Copy /> Copy path
                </button>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    const dir = lastOutput.replace(/[\\/][^\\/]+$/, "");
                    if (dir) void window.cove.openFolder(dir);
                  }}
                >
                  <Icons.Folder /> Open output folder
                </button>
              </div>
            </div>
          )}

          {lastError && (
            <div className="section" style={{ padding: "12px 14px", borderColor: "var(--rec-ring)", background: "var(--rec-soft)" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span className="status-pill" data-state="error"><span className="dot" /> Error</span>
                <span className="selectable mono" style={{ flex: 1, fontSize: 11.5, color: "var(--rec)", wordBreak: "break-word" }}>{lastError}</span>
                <button className="icon-btn" onClick={() => void navigator.clipboard.writeText(lastError)} title="Copy">
                  <Icons.Copy />
                </button>
              </div>
            </div>
          )}

          <Diagnostics />
        </div>
      </div>

      <div className="footer">
        <div className="foot-row">
          <span className="lbl">Hotkeys</span>
          <span className="keys">
            <b>{hotkeyBindings.toggle}</b> toggle
            <span className="sep">·</span>
            <b>{hotkeyBindings.gif}</b> crop GIF
            <span className="sep">·</span>
            <b>Esc</b> stop
          </span>
          <button className="btn btn-outline btn-sm" onClick={() => setHotkeysOpen(true)}>
            <Icons.Key /> Customize
          </button>
{appInfo && (
            <span className="platform">
              <span className="pdot" /> {formatPlatform(appInfo)}
            </span>
          )}
        </div>

        <div className="log">
          <details
            open={!logCollapsed}
            onToggle={(e) => {
              const open = (e.currentTarget as HTMLDetailsElement).open;
              const wasCollapsed = logCollapsed;
              setLogCollapsed(!open);
              // Grow / shrink the window so the log body doesn't push the
              // app into a scrollbar — it now visibly opens "downwards".
              const willOpen = open && wasCollapsed;
              const willClose = !open && !wasCollapsed;
              if (willOpen) void window.cove.adjustWindowHeight(220);
              else if (willClose) void window.cove.adjustWindowHeight(-220);
            }}
          >
            <summary>
              <span className="caret"><Icons.Caret /></span>
              <span className="lbl">Log</span>
              <span className="count">· {logs.length}</span>
              <span className="acts">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const txt = logs.map((l) => `${formatLogTime(l.ts)}\t${l.level}\t${l.text}`).join("\n");
                    void navigator.clipboard.writeText(txt);
                  }}
                >
                  <Icons.Copy /> Copy
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    clearLogs();
                  }}
                >
                  <Icons.Trash /> Clear
                </button>
              </span>
            </summary>
            <div className="log-body">
              {logs.length === 0 ? (
                <div style={{ color: "var(--text-faint)" }}>—</div>
              ) : (
                logs.map((l) => (
                  <div key={l.id} className="log-line">
                    <span className="t">{formatLogTime(l.ts)}</span>
                    <span className={`lvl ${l.level}`}>{l.level}</span>
                    <span className="msg">{l.text}</span>
                  </div>
                ))
              )}
            </div>
          </details>
        </div>
      </div>

      {/* Existing X11/Windows source picker — restyled by the new CSS */}
      {pendingStart && (
        <SourceModal
          mode={pendingStart.mode}
          onPick={(s) => void startWithSource(s, pendingStart.preset)}
          onCancel={() => { setPendingStart(null); setStatus("idle"); }}
        />
      )}

      {pendingReplaySource && (
        <SourceModal
          mode={pendingReplaySource}
          onPick={(s) => void startReplayWithSource(s, pendingReplaySource)}
          onCancel={() => setPendingReplaySource(null)}
        />
      )}


      {hotkeysOpen && (
        <HotkeysDialog
          initial={hotkeyBindings}
          onSave={(next) => {
            setHotkeyBindings(next);
            setHotkeysOpen(false);
            log("info", `Hotkeys updated: ${next.toggle} toggle · ${next.gif} crop GIF`);
          }}
          onCancel={() => setHotkeysOpen(false)}
        />
      )}
    </div>
  );
}

/* ============================================================ CustomQualityPanel */

interface CustomQualityPanelProps {
  value: { fps: number; videoBitsPerSecond: number; scaleHeight: number };
  onChange: (next: { fps: number; videoBitsPerSecond: number; scaleHeight: number }) => void;
  disabled: boolean;
}

function CustomQualityPanel({ value, onChange, disabled }: CustomQualityPanelProps) {
  const fpsLimits = CUSTOM_QUALITY_LIMITS.fps;
  const mbpsLimits = CUSTOM_QUALITY_LIMITS.videoMbps;
  const heightLimits = CUSTOM_QUALITY_LIMITS.scaleHeight;
  const mbps = Math.round(value.videoBitsPerSecond / 1_000_000);
  return (
    <div className="custom-quality">
      <div className="cq-row">
        <label>
          <span className="cq-lbl">Frame rate <b>{value.fps}</b> fps</span>
          <input
            type="range"
            min={fpsLimits.min}
            max={fpsLimits.max}
            step={fpsLimits.step}
            value={value.fps}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, fps: Number(e.target.value) })}
          />
        </label>
        <label>
          <span className="cq-lbl">Bit rate <b>{mbps}</b> Mbps</span>
          <input
            type="range"
            min={mbpsLimits.min}
            max={mbpsLimits.max}
            step={mbpsLimits.step}
            value={mbps}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, videoBitsPerSecond: Number(e.target.value) * 1_000_000 })}
          />
        </label>
      </div>
      <div className="cq-row">
        <label>
          <span className="cq-lbl">Resolution height <b>{value.scaleHeight}</b>p</span>
          <input
            type="range"
            min={heightLimits.min}
            max={heightLimits.max}
            step={heightLimits.step}
            value={value.scaleHeight}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, scaleHeight: Number(e.target.value) })}
          />
        </label>
        <span className="cq-hint">
          Height drives the encode resolution; aspect ratio follows the source.
        </span>
      </div>
    </div>
  );
}

/* ============================================================ Titlebar */

function Titlebar() {
  return (
    <div className="titlebar">
      <div className="mark"><img src="cove_icon.png" alt="" /></div>
      <div className="title">
        <b>Cove Screen Recorder</b>
        <span className="ver">v1.1.0</span>
      </div>
      <div className="spacer" />
      <button className="win-btn" onClick={() => window.cove.windowMinimize()} aria-label="Minimize">
        <svg viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
      <button className="win-btn" onClick={() => window.cove.windowToggleMaximize()} aria-label="Maximize">
        <svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" stroke="currentColor" fill="none" strokeWidth="1.2" /></svg>
      </button>
      <button className="win-btn close" onClick={() => window.cove.windowClose()} aria-label="Close">
        <svg viewBox="0 0 12 12"><line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

/* ============================================================ Capture preview */

interface PreviewProps {
  mode: "area" | "screen" | "window";
  preset: PresetId;
  recording: boolean;
  elapsedSeconds: number;
  liveStream: MediaStream | null;
}

function CapturePreview({ mode, preset, recording, elapsedSeconds, liveStream }: PreviewProps) {
  const presetMeta = PRESETS[preset];
  const videoRef = useRef<HTMLVideoElement>(null);

  // Wire the live stream into the <video> via srcObject. Setting it through
  // a ref avoids React re-creating the element when the stream is replaced
  // (which would briefly black-out the preview).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (liveStream) {
      v.srcObject = liveStream;
      // Autoplay gets blocked unless we mark muted; we want preview-only.
      v.muted = true;
      v.play().catch(() => { /* user-paused or detached, fine */ });
    } else {
      v.srcObject = null;
    }
  }, [liveStream]);

  const showLive = recording && liveStream !== null;

  return (
    <div className="preview">
      {showLive ? (
        <video
          ref={videoRef}
          className="preview-video"
          autoPlay
          muted
          playsInline
        />
      ) : (
        <div className="grid-bg" />
      )}

      {!showLive && mode === "screen" && (
        <div className="mon-mock">
          <div className="topbar">
            <div className="item acc" />
            <div className="item" />
            <div className="item" style={{ width: 64 }} />
            <div style={{ flex: 1 }} />
            <div className="item" style={{ width: 24 }} />
            <div className="item" style={{ width: 24 }} />
          </div>
          <div className="desk">
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className="icon" style={{ opacity: 0.4 + (i % 5) * 0.08 }} />
            ))}
          </div>
          <div className="dock">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="di" style={{ background: i === 2 ? "var(--accent-soft)" : undefined }} />
            ))}
          </div>
        </div>
      )}

      {!showLive && mode === "window" && (
        <div className="win-mock">
          <div className="wb"><span /><span /><span /><span className="wt">app · main.py</span></div>
          <div className="wbody">
            <div className="wsidebar" />
            <div className="wcontent">
              <div className="wline w70" />
              <div className="wline w50" />
              <div className="wline acc" />
              <div className="wline w70" />
              <div className="wline w50" style={{ width: "42%" }} />
              <div className="wline w70" style={{ width: "60%" }} />
              <div className="wline acc" style={{ width: "24%" }} />
            </div>
          </div>
        </div>
      )}

      {!showLive && mode === "area" && (
        <div className="frame" style={{ left: "18%", top: "22%", right: "22%", bottom: "20%" }}>
          <span className="corner bl" /><span className="corner br" />
        </div>
      )}

      <div className="label">
        {showLive ? (
          <>
            {mode === "area"   && <><Icons.Crop />    Live · cropped region</>}
            {mode === "screen" && <><Icons.Monitor /> Live · screen</>}
            {mode === "window" && <><Icons.Window />  Live · window</>}
          </>
        ) : (
          <>
            {mode === "area"   && <><Icons.Crop />     Region · drag to select on record</>}
            {mode === "screen" && <><Icons.Monitor />  Screen · system picks the monitor</>}
            {mode === "window" && <><Icons.Window />   Window · pick on record</>}
          </>
        )}
      </div>
      <div className="res-tag">{presetMeta.name} · {presetMeta.fps}fps</div>

      {recording && (
        <>
          <div className="rec-overlay" />
          <div className="rec-time"><span className="blink" />REC · {formatTime(elapsedSeconds)}</div>
        </>
      )}
    </div>
  );
}

/* ============================================================ Stats */

function Stats({ preset, mode, elapsedSeconds, recording }: { preset: PresetId; mode: string; elapsedSeconds: number; recording: boolean }) {
  const m = PRESETS[preset];
  const mbps = Math.round(m.videoBitsPerSecond / 1_000_000);
  const estPerMin = Math.max(1, Math.round((m.videoBitsPerSecond / 8) * 60 / 1_000_000));
  return (
    <div className="stats">
      <div className="stat">
        <div className="k">Mode</div>
        <div className="v">{modeLabel(mode)}</div>
      </div>
      <div className="stat">
        <div className="k">Frame rate</div>
        <div className="v">{m.fps} <small>fps</small></div>
      </div>
      <div className="stat">
        <div className="k">{preset === "gif" ? "Palette" : "Bitrate"}</div>
        <div className="v">{preset === "gif" ? "192" : `~${mbps}`} <small>{preset === "gif" ? "colors" : "Mbps"}</small></div>
      </div>
      <div className="stat">
        <div className="k">{recording ? "Elapsed" : "Est. /min"}</div>
        <div className="v">{recording ? formatTime(elapsedSeconds) : `~${estPerMin}`} <small>{recording ? "" : "MB"}</small></div>
      </div>
    </div>
  );
}

/* ============================================================ Source tile */

function SourceTile({ active, onClick, icon, title, desc }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; desc: string }) {
  return (
    <button className={`source-tile ${active ? "active" : ""}`} onClick={onClick} aria-pressed={active}>
      <div className="src-icon">{icon}</div>
      <div>
        <div className="src-title">{title}</div>
        <div className="src-desc">{desc}</div>
      </div>
    </button>
  );
}

/* ============================================================ utils */

function modeLabel(m: string): string {
  if (m === "area") return "Region";
  if (m === "window") return "Window";
  return "Screen";
}

function formatPresetCodec(p: PresetId): string {
  if (p === "gif") return "GIF";
  return "MP4";
}

function formatTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, "0");
  const sss = String(ss).padStart(2, "0");
  return h ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

function formatLogTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ============================================================ icons */

const Icons = {
  Crop: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <path d="M6 2v16a2 2 0 0 0 2 2h16" />
      <path d="M2 6h16a2 2 0 0 1 2 2v16" />
    </svg>
  ),
  Monitor: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  Window: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
    </svg>
  ),
  Folder: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  ),
  External: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M20 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5" />
    </svg>
  ),
  X: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  ),
  Check: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="10" height="10">
      <path d="M5 12 10 17 19 7" />
    </svg>
  ),
  Caret: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="10" height="10">
      <path d="M9 6 15 12 9 18" />
    </svg>
  ),
  Key: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
      <circle cx="8" cy="14" r="4" />
      <path d="m11 11 9-9" /><path d="m17 5 3 3" /><path d="m14 8 3 3" />
    </svg>
  ),
  Rec: () => (
    <svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><circle cx="12" cy="12" r="6" /></svg>
  ),
  Stop: () => (
    <svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
  ),
  Copy: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  ),
  Trash: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
      <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
    </svg>
  ),
};
