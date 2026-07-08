import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import { autoUpdater } from "electron-updater";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { detectFfmpeg, setDetectedGpuVendor } from "./ffmpeg";
import { appendChunk, begin, cancel, cancelAll, finalize, setRecorderLogger } from "./recorder";
import { EngineSupervisor } from "./engine-supervisor";
import type { EngineRpc } from "./engine-rpc";
import { installAppImageUpdate } from "./appimage-updater";
import type {
  AppInfo,
  CaptureSource,
  CropRect,
  CropSelectionResult,
  FinalizeParams,
  HotkeyBindFailedPayload,
  RecordingProgress,
  StartRecordingParams,
  UpdateEvent,
} from "./types";
import { setupPortableMode } from "./portable";
import { pathToFileURL } from "node:url";

setupPortableMode();

// The AppImage launcher exports LD_LIBRARY_PATH pointing at the bundle's
// libraries. shell.openPath spawns xdg-open with our environment, so the
// launched app (file manager, player) inherits it, loads the bundle's
// outdated libs, and crashes on startup (e.g. liblzma "version XZ_5.4 not
// found"). Returns null when not running from an AppImage.
function appImageChildEnv(): NodeJS.ProcessEnv | null {
  if (process.platform !== "linux") return null;
  if (!process.env.APPIMAGE && !process.env.APPDIR) return null;
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  delete env.GSETTINGS_SCHEMA_DIR;
  return env;
}

async function openPathExternal(target: string): Promise<string> {
  const env = appImageChildEnv();
  if (env) {
    try {
      spawn("xdg-open", [target], { env, detached: true, stdio: "ignore" }).unref();
      return "";
    } catch {
      /* fall through to shell.openPath */
    }
  }
  return shell.openPath(target);
}

function revealExternal(target: string): void {
  const env = appImageChildEnv();
  if (env) {
    // FileManager1 keeps the file highlighted; the D-Bus-activated file
    // manager gets the session's clean env. Fall back to the parent folder.
    const child = spawn(
      "dbus-send",
      [
        "--session", "--print-reply",
        "--dest=org.freedesktop.FileManager1",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1.ShowItems",
        `array:string:${pathToFileURL(target).href}`,
        "string:",
      ],
      { env, stdio: "ignore" },
    );
    child.on("error", () => void openPathExternal(path.dirname(target)));
    child.on("exit", (code) => {
      if (code !== 0) void openPathExternal(path.dirname(target));
    });
    return;
  }
  shell.showItemInFolder(target);
}

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

let supervisor: EngineSupervisor | null = null;
let helperShutdownComplete = false;
let helperShutdownPromise: Promise<void> | null = null;

// Last payload from supervisor "ready" — re-sent on did-finish-load so the
// renderer receives engine.onReady even when the helper boots before the window.
let lastReadyPayload: { helperVersion: string; protocolVersion: number } | null = null;

// Single transient blocked payload — cleared when engine reaches ready.
// Re-sent on did-finish-load to cover startup race (supervisor fails before window loads).
let lastBlockedPayload: { code: string; detail?: string } | null = null;

// Last auto-update event — re-sent on did-finish-load so a fast update check
// result (failure or cached download) isn't dropped before the renderer's
// toast subscription is live.
let lastUpdateEvent: UpdateEvent | null = null;

function sendUpdateEvent(ev: UpdateEvent): void {
  lastUpdateEvent = ev;
  mainWindow?.webContents.send("cove:update-event", ev);
}

// Structured result envelope for v2 IPC handlers.
// Returned as a plain object so Electron's structured clone serializes all fields
// deterministically — no reliance on Error property preservation across invoke.
type RpcEnvelope<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; code: string; message: string };

function disconnectedEnv(): RpcEnvelope {
  return { ok: false, code: "helper-disconnected", message: "helper-disconnected" };
}

async function rpcEnv<T>(fn: () => Promise<T>): Promise<RpcEnvelope<T>> {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    const e = err as { rpcCode?: string | number; code?: string; message?: string };
    // rpcCode is set by EngineRpc for RPC-layer errors (e.g. "not-implemented").
    // code is set by rejectAllPending() for transport-layer errors ("helper-disconnected").
    const code =
      typeof e.rpcCode === "string" ? e.rpcCode :
      typeof e.code === "string" ? e.code :
      "rpc-error";
    return { ok: false, code, message: String(e.message ?? "rpc error") };
  }
}

// T-029 / ISS-012: tee the existing [export lifecycle] forwarding logs to a
// file sink so the main-process forwarding record survives past a stuck-
// EXPORTING occurrence. Plain console.log goes to stdout only, which is lost in
// packaged/headless runs and cannot be correlated after the fact. This is
// additive observability only — it does NOT change IPC channel names or any
// forwarded payload (every send(...) below is untouched). The sink is best-
// effort: any write failure is swallowed so it can never disrupt forwarding.
let exportLogPath: string | null = null;
function exportLog(line: string): void {
  console.log(line);
  if (!exportLogPath) {
    exportLogPath = path.join(app.getPath("logs"), "export-lifecycle.log");
  }
  fs.promises
    .appendFile(exportLogPath, `${new Date().toISOString()} ${line}\n`)
    .catch(() => {
      // Best-effort diagnostics; never let a log-sink failure disrupt forwarding.
    });
}

// Attaches helper RPC notification → webContents.send forwarding.
// Called on every supervisor "ready" so it re-wires after a crash/restart.
function wireHelperNotifications(rpc: EngineRpc): void {
  const send = (channel: string, params?: unknown) => {
    mainWindow?.webContents.send(channel, params);
  };
  // capture notifications
  rpc.onNotification("capture.sessionReady", (p) => send("cove/capture/sessionReady", p));
  rpc.onNotification("capture.formatChanged", (p) => send("cove/capture/formatChanged", p));
  rpc.onNotification("capture.streamPaused", (p) => send("cove/capture/streamPaused", p));
  rpc.onNotification("capture.streamResumed", (p) => send("cove/capture/streamResumed", p));
  rpc.onNotification("capture.sessionLost", (p) => send("cove/capture/sessionLost", p));
  rpc.onNotification("capture.diagnostics", (p) => send("cove/capture/diagnostics", p));
  // encoder notifications
  rpc.onNotification("encoder.probeResult", (p) => send("cove/encoder/probeResult", p));
  rpc.onNotification("encoder.selected", (p) => send("cove/encoder/selected", p));
  rpc.onNotification("encoder.fallbackEngaged", (p) => send("cove/encoder/fallbackEngaged", p));
  rpc.onNotification("encoder.runtimeError", (p) => send("cove/encoder/runtimeError", p));
  rpc.onNotification("encoder.backPressure", (p) => send("cove/encoder/backPressure", p));
  rpc.onNotification("encoder.diagnostics", (p) => send("cove/encoder/diagnostics", p));
  // replay notifications
  rpc.onNotification("replay.segmentDiagnostics", (p) => send("cove/replay/segmentDiagnostics", p));
  rpc.onNotification("replay.recoveryAvailable", (p) => send("cove/replay/recoveryAvailable", p));
  rpc.onNotification("replay.snapshotPinned", (p) => send("cove/replay/snapshotPinned", p));
  rpc.onNotification("replay.snapshotReleased", (p) => send("cove/replay/snapshotReleased", p));
  // export notifications
  rpc.onNotification("export.queued", (p) => {
    const ev = p as Record<string, unknown> | undefined;
    exportLog(`[export lifecycle] export.queued export_id=${ev?.export_id ?? "?"} snapshot_id=${ev?.snapshot_id ?? "?"}`);
    send("cove/export/queued", p);
  });
  rpc.onNotification("export.started", (p) => {
    const ev = p as Record<string, unknown> | undefined;
    exportLog(`[export lifecycle] export.started export_id=${ev?.export_id ?? "?"} mode=${ev?.mode ?? "?"}`);
    send("cove/export/started", p);
  });
  rpc.onNotification("export.progress", (p) => send("cove/export/progress", p));
  rpc.onNotification("export.stalled", (p) => send("cove/export/stalled", p));
  rpc.onNotification("export.completed", (p) => {
    const ev = p as Record<string, unknown> | undefined;
    exportLog(`[export lifecycle] export.completed export_id=${ev?.export_id ?? "?"} final_path=${ev?.final_path ?? "?"} bytes=${ev?.bytes ?? "?"}`);
    send("cove/export/completed", p);
  });
  rpc.onNotification("export.failed", (p) => {
    const ev = p as Record<string, unknown> | undefined;
    exportLog(`[export lifecycle] export.failed export_id=${ev?.export_id ?? "?"} stage=${ev?.stage ?? "?"} reason_code=${ev?.reason_code ?? "?"}`);
    send("cove/export/failed", p);
  });
  rpc.onNotification("export.cancelled", (p) => {
    const ev = p as Record<string, unknown> | undefined;
    exportLog(`[export lifecycle] export.cancelled export_id=${ev?.export_id ?? "?"} stage=${ev?.stage ?? "?"} partial_bytes=${ev?.partial_bytes ?? "?"}`);
    send("cove/export/cancelled", p);
  });
  rpc.onNotification("export.rejected", (p) => {
    const ev = p as Record<string, unknown> | undefined;
    exportLog(`[export lifecycle] export.rejected export_id=${ev?.export_id ?? "?"} reason_code=${ev?.reason_code ?? "?"} snapshot_id=${ev?.snapshot_id ?? "?"}`);
    send("cove/export/rejected", p);
  });
  // engine log
  rpc.onNotification("engine.logLine", (p) => send("cove/engine/logLine", p));
}

// Wayland boot setup: must run BEFORE app is ready. Tells Chromium's Ozone
// layer to use Wayland natively and enables the PipeWire screencast capturer
// — without these, screen capture goes through the legacy X11 path under
// XWayland and the portal handshake doesn't kick in.
{
  const isLinux = process.platform === "linux";
  const isWayland =
    isLinux &&
    (process.env.XDG_SESSION_TYPE === "wayland" || Boolean(process.env.WAYLAND_DISPLAY));
  if (isWayland) {
    if (!process.env.ELECTRON_OZONE_PLATFORM_HINT) {
      process.env.ELECTRON_OZONE_PLATFORM_HINT = "wayland";
    }
    app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");
  }
  if (isLinux) {
    // Set the wm_class / Wayland app_id so the compositor matches us against
    // a bundled .desktop file (or any user-installed one) and uses the Cove
    // icon in the taskbar instead of the generic Electron one. Must be set
    // before app is ready.
    app.commandLine.appendSwitch("class", "cove-screen-recorder");
    app.setName("Cove Screen Recorder");
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayRecordingStartedAt: number | null = null;
let trayDurationInterval: NodeJS.Timeout | null = null;

interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

function boundsFile(): string {
  return path.join(app.getPath("userData"), "window-bounds.json");
}

function readBounds(): WindowBounds | null {
  try {
    const raw = fs.readFileSync(boundsFile(), "utf-8");
    const parsed = JSON.parse(raw) as WindowBounds;
    // Discard saved sizes from the old 1.x layout (980x720 default) — the
    // 2.x two-column layout collapses below ~1100px, so those bounds make
    // the app look broken on first 2.x launch.
    if (
      typeof parsed.width === "number" &&
      typeof parsed.height === "number" &&
      parsed.width >= 1100 &&
      parsed.height >= 880
    ) {
      return parsed;
    }
  } catch {
    // first run / corrupt — fall back to defaults
  }
  return null;
}

function writeBounds(b: WindowBounds): void {
  try {
    fs.mkdirSync(path.dirname(boundsFile()), { recursive: true });
    fs.writeFileSync(boundsFile(), JSON.stringify(b));
  } catch {
    // best effort
  }
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | null = null;
  return ((...args: unknown[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

// ── Tray helpers ─────────────────────────────────────────────────────────────

function updateTrayMenu(): void {
  if (!tray) return;
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "Show Cove", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
  ];
  if (trayRecordingStartedAt !== null) {
    items.push({
      label: "Stop Recording",
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          if (!mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send("cove:hotkey", "toggle");
          }
        }
      },
    });
  }
  items.push({ type: "separator" });
  items.push({ label: "Quit", click: () => { app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function updateTrayTooltip(): void {
  if (!tray) return;
  if (trayRecordingStartedAt === null) {
    tray.setToolTip("Cove Screen Recorder");
    return;
  }
  const elapsedSec = Math.floor((Date.now() - trayRecordingStartedAt) / 1000);
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");
  tray.setToolTip(`Cove — Recording ${mm}:${ss}`);
}

function onTrayRecordingStart(): void {
  if (!tray) return;
  if (trayDurationInterval) { clearInterval(trayDurationInterval); trayDurationInterval = null; }
  trayRecordingStartedAt = Date.now();
  trayDurationInterval = setInterval(updateTrayTooltip, 1_000);
  updateTrayMenu();
  updateTrayTooltip();
  const recIcon = path.join(app.getAppPath(), "cove_icon_recording.png");
  if (fs.existsSync(recIcon)) tray.setImage(recIcon);
}

function onTrayRecordingStop(outputPath?: string): void {
  trayRecordingStartedAt = null;
  if (trayDurationInterval) { clearInterval(trayDurationInterval); trayDurationInterval = null; }
  updateTrayMenu();
  updateTrayTooltip();
  const iconPath = path.join(app.getAppPath(), "cove_icon.png");
  tray?.setImage(iconPath);
  if (process.platform === "win32" && tray && outputPath) {
    tray.displayBalloon({
      iconType: "info",
      title: "Recording saved",
      content: path.basename(outputPath),
    });
  }
}

function createTray(): void {
  if (tray) return;
  const iconPath = path.join(app.getAppPath(), "cove_icon.png");
  tray = new Tray(iconPath);
  tray.setToolTip("Cove Screen Recorder");
  updateTrayMenu();
  tray.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
  tray.on("double-click", () => { mainWindow?.show(); mainWindow?.focus(); });
}

function createWindow(): void {
  const saved = readBounds();
  // Bumped minimum past the 980px breakpoint so the two-column layout always
  // gets to render. Saved bounds from older 1.x runs could be < 1100; we
  // ignore them in `readBounds` and fall back to the default below.
  const defaultWidth = 1320;
  const defaultHeight = 920;
  const iconPath = path.join(app.getAppPath(), "cove_icon.png");

  mainWindow = new BrowserWindow({
    width: saved?.width ?? defaultWidth,
    height: saved?.height ?? defaultHeight,
    x: saved?.x,
    y: saved?.y,
    minWidth: 1100,
    minHeight: 640,
    backgroundColor: "#0b0b10",
    show: false,
    frame: false,
    titleBarStyle: "hidden",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true broke Chromium's `chromeMediaSource: "desktop"` audio
      // constraint on Windows — getUserMedia returned a video-only stream
      // with no audio tracks, even with system audio toggled on. The legacy
      // desktop-loopback path needs the renderer's privileged process to
      // resolve. Stay sandbox-off here; contextIsolation + nodeIntegration
      // off + no remote content keeps the threat model reasonable.
      sandbox: false,
    },
  });

  // Linux window managers often ignore BrowserWindow.icon, leaving the
  // taskbar with the default Electron icon. setIcon() forces it through.
  if (process.platform === "linux") {
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) mainWindow.setIcon(img);
    } catch {
      // best effort
    }
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // Replay the last supervisor "ready" payload so the renderer receives
  // engine.onReady even when the helper finished booting before the window loaded.
  // Also replay a blocked payload to cover the startup race (supervisor fails before
  // the window finishes loading).
  mainWindow.webContents.on("did-finish-load", () => {
    if (lastReadyPayload) {
      mainWindow?.webContents.send("cove/engine/ready", lastReadyPayload);
    }
    if (lastBlockedPayload) {
      mainWindow?.webContents.send("cove/engine/blocked", lastBlockedPayload);
    }
    if (lastUpdateEvent) {
      mainWindow?.webContents.send("cove:update-event", lastUpdateEvent);
    }
  });

  if (saved?.maximized) mainWindow.maximize();

  if (DEV_URL) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }

  const persist = () => {
    if (!mainWindow) return;
    const isMax = mainWindow.isMaximized();
    const bounds = isMax ? saved ?? mainWindow.getBounds() : mainWindow.getBounds();
    writeBounds({ ...bounds, maximized: isMax });
  };
  mainWindow.on("close", persist);
  mainWindow.on("resize", debounce(persist, 250));
  mainWindow.on("move", debounce(persist, 250));

  mainWindow.on("closed", () => {
    if (trayDurationInterval) { clearInterval(trayDurationInterval); trayDurationInterval = null; }
    tray?.destroy();
    tray = null;
    mainWindow = null;
  });

  // Hide to tray on minimize so PipeWire screen-share sessions survive.
  // Without this, KDE/Wayland revokes the portal token when the window
  // is minimized, killing any active replay buffer or recording.
  mainWindow.on("minimize", () => {
    mainWindow?.hide();
    createTray();
  });
}

function sendProgress(p: RecordingProgress): void {
  mainWindow?.webContents.send("cove:progress", p);
}

function detectSessionType(): string | null {
  const t = process.env.XDG_SESSION_TYPE;
  if (t) return t;
  if (process.env.WAYLAND_DISPLAY) return "wayland";
  if (process.env.DISPLAY) return "x11";
  return null;
}

let overlayWindow: BrowserWindow | null = null;
let pendingSelection:
  | {
      resolve: (value: CropSelectionResult | null) => void;
      displayId: string;
      displayWidth: number;
      displayHeight: number;
      // Omitted on Wayland: the source is picked through the portal at capture
      // time, not chosen up-front from a desktopCapturer enumeration.
      source: CaptureSource | null;
    }
  | null = null;

// Cache desktopCapturer.getSources because each call triggers a fresh
// xdg-desktop-portal prompt on Wayland. Cache for 30s — long enough to cover
// a single record-flow, short enough to pick up new windows reasonably fast.
const SOURCE_CACHE_TTL_MS = 30_000;
let cachedSourcesAt = 0;
let cachedSources: import("electron").DesktopCapturerSource[] = [];
let cachedSourceKey = "";

async function getSourcesCached(
  types: Array<"screen" | "window">,
  fetchWindowIcons: boolean,
): Promise<import("electron").DesktopCapturerSource[]> {
  const key = types.slice().sort().join(",") + ":" + (fetchWindowIcons ? "icons" : "noicons");
  const fresh = Date.now() - cachedSourcesAt < SOURCE_CACHE_TTL_MS;
  if (fresh && cachedSourceKey === key && cachedSources.length > 0) {
    return cachedSources;
  }
  cachedSources = await desktopCapturer.getSources({
    types,
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons,
  });
  cachedSourcesAt = Date.now();
  cachedSourceKey = key;
  return cachedSources;
}

function invalidateSourceCache(): void {
  cachedSourcesAt = 0;
  cachedSources = [];
  cachedSourceKey = "";
}

function destroyOverlay(): void {
  if (overlayWindow) {
    try {
      // destroy() is non-cancellable and faster than close() — important on
      // Wayland/KDE where close() can deadlock if focus transitions race.
      if (!overlayWindow.isDestroyed()) overlayWindow.destroy();
    } catch {
      // already gone
    }
    overlayWindow = null;
  }
}

function showMainSafely(): void {
  // Defer to next tick — synchronously calling show() right after the overlay
  // is destroyed has been observed to deadlock the main process on KDE Wayland.
  setImmediate(() => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } catch (err) {
      console.warn("show main failed", err);
    }
  });
}

function resolveSelection(value: CropSelectionResult | null): void {
  const pending = pendingSelection;
  pendingSelection = null;
  destroyOverlay();
  showMainSafely();
  pending?.resolve(value);
}

function makeCaptureSource(
  s: import("electron").DesktopCapturerSource,
): CaptureSource {
  const base: CaptureSource = {
    id: s.id,
    name: s.name,
    kind: s.id.startsWith("screen") ? "screen" : "window",
    thumbnailDataUrl: s.thumbnail.toDataURL(),
    appIconDataUrl: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : undefined,
    display_id: s.display_id || undefined,
  };
  if (process.platform === "win32" && s.display_id) {
    const disp = screen.getAllDisplays().find((d) => String(d.id) === s.display_id);
    if (disp) {
      base.scale_factor = disp.scaleFactor;
      base.refresh_rate_hz = (disp as { displayFrequency?: number }).displayFrequency ?? undefined;
    }
  }
  return base;
}

// Windows-only: best-effort augment sources with DXGI adapter/output indices and HDR capability.
// No-op while the Rust stubs return an empty monitors array (T-051 will populate them).
async function tryAugmentWithDxgi(sources: CaptureSource[]): Promise<void> {
  if (process.platform !== "win32") return;
  const rpc = supervisor?.rpcClient;
  if (!rpc?.connected) return;
  try {
    const desc = await rpc.captureListSources();
    const monitors = desc.monitors ?? [];
    if (monitors.length === 0) return;
    let monIdx = 0;
    for (const src of sources) {
      if (src.kind !== "screen" || monIdx >= monitors.length) continue;
      const mon = monitors[monIdx++];
      src.dxgi_adapter_index = mon.adapter_index;
      src.dxgi_output_index = mon.output_index;
      src.hdr_capable = mon.hdr_capable;
    }
  } catch {
    // non-fatal: DXGI info is best-effort
  }
}

async function startCropSelection(): Promise<CropSelectionResult | null> {
  if (pendingSelection) return null;

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor) ?? screen.getPrimaryDisplay();

  // On Wayland, calling desktopCapturer.getSources() here would trigger an
  // xdg-desktop-portal prompt up front — and the renderer is going to call
  // getDisplayMedia() afterwards anyway, which fires its own prompt. So skip
  // the enumeration on Wayland and let the portal pick handle it. On X11 /
  // Windows the enumeration is silent, so we still resolve a source up front
  // and the renderer takes the legacy getUserMedia path.
  const onWayland = detectSessionType() === "wayland";
  let source: CaptureSource | null = null;
  if (!onWayland) {
    const sources = await getSourcesCached(["screen"], false);
    if (sources.length === 0) return null;
    let raw = sources.find((s) => s.display_id && Number(s.display_id) === display.id);
    if (!raw) raw = sources[0];
    source = makeCaptureSource(raw);
  }

  if (mainWindow && mainWindow.isVisible()) mainWindow.hide();

  return new Promise<CropSelectionResult | null>((resolve) => {
    pendingSelection = {
      resolve,
      displayId: String(display.id),
      displayWidth: display.size.width,
      displayHeight: display.size.height,
      source,
    };

    overlayWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      fullscreenable: false,
      focusable: true,
      backgroundColor: "#00000000",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "overlay-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
    try {
      overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      // not supported on every platform — ignore
    }

    const overlayHtml = path.join(app.getAppPath(), "dist", "overlay.html");
    overlayWindow.loadFile(overlayHtml);

    // Push the display's exact scale factor to the renderer so it can use it for
    // coordinate normalisation on mixed-DPI multi-monitor setups.
    overlayWindow.webContents.once("did-finish-load", () => {
      overlayWindow?.webContents.send("overlay-scale-factor", display.scaleFactor ?? 1);
    });

    overlayWindow.once("ready-to-show", () => {
      try {
        overlayWindow?.show();
        overlayWindow?.focus();
      } catch (err) {
        console.warn("overlay show failed", err);
      }
    });

    overlayWindow.on("closed", () => {
      overlayWindow = null;
      // If closed without a commit/cancel, treat as cancel.
      if (pendingSelection) {
        const p = pendingSelection;
        pendingSelection = null;
        showMainSafely();
        p.resolve(null);
      }
    });
  });
}

async function listSources(kind: "screen" | "window" | "all"): Promise<CaptureSource[]> {
  // On Wayland, source enumeration is not passive: Electron reaches the
  // xdg-desktop-portal picker. Keep all Wayland capture requests on the
  // getDisplayMedia path so a recording flow cannot show two portal dialogs.
  if (detectSessionType() === "wayland") return [];

  const types: Array<"screen" | "window"> =
    kind === "all" ? ["screen", "window"] : [kind];
  const raw = await getSourcesCached(types, kind !== "screen");
  const result = raw.map<CaptureSource>(makeCaptureSource);
  await tryAugmentWithDxgi(result);
  return result;
}

// Non-Wayland getDisplayMedia path: the renderer can hint which source kind it
// wants before calling navigator.mediaDevices.getDisplayMedia().
//
// On Linux, keep this handler installed. Electron's default getDisplayMedia path
// is not supported reliably there, so the handler must fulfill the request via
// desktopCapturer.getSources(). Do not pass useSystemPicker on Linux: that can
// make Chromium try a portal request before this handler opens the portal again.
let nextDisplayMediaTypes: Array<"screen" | "window"> = ["screen", "window"];
let nextDisplayMediaSelected: { id: string; name: string; kind: "screen" | "window" } | null = null;
// On Windows/X11, the renderer pre-selects a source via the Cove SourceModal
// and tells the handler to use exactly that one — instead of guessing
// sources[0]. This is also how we get audio working on Windows: routing
// through getDisplayMedia (handler returns picked source + audio:"loopback")
// instead of the legacy getUserMedia({audio:{mandatory:{chromeMediaSource:
// "desktop"}}}) constraint, which Electron 32+ no longer honors reliably.
let pendingPickedSourceId: string | null = null;

function getLastDisplayMediaSelection(): { id: string; name: string; kind: "screen" | "window" } | null {
  const v = nextDisplayMediaSelected;
  nextDisplayMediaSelected = null;
  return v;
}

function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const types: Array<"screen" | "window"> =
        nextDisplayMediaTypes.length > 0 ? nextDisplayMediaTypes : ["screen", "window"];
      // Reset for next call.
      nextDisplayMediaTypes = ["screen", "window"];
      // Always pass "loopback" when audio was requested. On Windows this
      // captures system-audio output; on Linux/macOS it's a no-op but
      // satisfies the request contract — without it (audio:undefined when
      // audioRequested:true) Chromium errors with "Error starting capture"
      // before the portal even opens. Wayland system-audio capture itself
      // is a deeper Electron limitation tracked separately.
      const audio = request.audioRequested ? "loopback" : undefined;

      // The Wayland double-prompt bug: PipeWire portal sessions can't be
      // shared between enumeration and capture. If we call
      // desktopCapturer.getSources() here it opens session A (prompt 1), then
      // when Chromium uses the returned source ID it opens session B (prompt
      // 2). The fix is to NOT enumerate — pass a placeholder source and let
      // Chromium drive the portal once when capture starts.
      // Reference: github.com/electron/electron/issues/30652
      if (detectSessionType() === "wayland") {
        // The placeholder ID is intentionally not a valid PipeWire node. It
        // satisfies Electron's API contract; the actual source comes from
        // Chromium's portal handshake on Start. The renderer falls back to
        // the resulting MediaStreamTrack's label/displaySurface for naming.
        nextDisplayMediaSelected = null;
        callback({
          video: { id: "screen:0:0", name: "Screen" } as Electron.DesktopCapturerSource,
          audio,
        });
        return;
      }

      try {
        // Re-enumerate sources so we can hand back a real DesktopCapturerSource
        // (Chromium needs a fresh handle, not just the cached id+name we held).
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        if (sources.length === 0) {
          sendProgress({ stage: "muxing", message: "displayMedia handler: no sources available" });
          callback({});
          return;
        }

        let picked: import("electron").DesktopCapturerSource | undefined;
        const wantedId = pendingPickedSourceId;
        if (wantedId) {
          picked = sources.find((s) => s.id === wantedId);
          pendingPickedSourceId = null;
          if (!picked) {
            sendProgress({
              stage: "muxing",
              message: `displayMedia handler: picked source unavailable id=${wantedId}`,
            });
            callback({});
            return;
          }
        }
        const matchedPick = !!picked;
        if (!picked) {
          picked =
            sources.find((s) => types.includes(s.id.startsWith("window") ? "window" : "screen")) ??
            sources[0];
        }

        nextDisplayMediaSelected = {
          id: picked.id,
          name: picked.name,
          kind: picked.id.startsWith("screen") ? "screen" : "window",
        };

        // Diagnostic line — surfaces what the handler actually decided so a
        // 0-audio-track stream on the renderer side can be traced to the
        // exact source/audio pair we handed Chromium.
        const pickedKind = picked.id.startsWith("window") ? "window" : "screen";
        sendProgress({
          stage: "muxing",
          message:
            `displayMedia handler: ${pickedKind} id=${picked.id} ` +
            `name="${picked.name}" audio=${audio ?? "off"} ` +
            `wantedId=${wantedId ?? "(none)"} matchedPick=${matchedPick}`,
        });

        callback({ video: picked, audio });
      } catch (err) {
        console.warn("display media request failed", err);
        sendProgress({ stage: "error", message: `displayMedia handler error: ${err instanceof Error ? err.message : String(err)}` });
        callback({});
      }
    },
  );
}

function extractThumbnail(ffmpegPath: string, filePath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (val: string | null) => { if (!settled) { settled = true; resolve(val); } };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffmpegPath, [
        "-hide_banner", "-loglevel", "error",
        "-ss", "0", "-i", filePath,
        "-vframes", "1", "-vf", "scale=240:-2",
        "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
      ]);
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch { /**/ } done(null); }, 3000);
    proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || chunks.length === 0) return done(null);
      done(`data:image/jpeg;base64,${Buffer.concat(chunks).toString("base64")}`);
    });
    proc.on("error", () => { clearTimeout(timer); done(null); });
  });
}

function defaultOutputDir(): string {
  const videos = app.getPath("videos");
  const dir = path.join(videos, "Cove Recordings");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return videos;
  }
  return dir;
}

interface HotkeyBindings {
  toggle: string;
  gif: string;
  replay: string;
}

const DEFAULT_HOTKEYS: HotkeyBindings = {
  toggle: "F9",
  gif: "F10",
  replay: "F8",
};

let activeHotkeys: HotkeyBindings = { ...DEFAULT_HOTKEYS };
let hotkeysEnabled = false;

// Translate UI-style accelerators ("Ctrl+Shift+R") into Electron's expected
// form ("Control+Shift+R") and validate the basic shape.
function normalizeAccelerator(accel: string): string | null {
  if (!accel) return null;
  const cleaned = accel
    .trim()
    .replace(/\s+/g, "")
    .replace(/^Ctrl\b/i, "Control")
    .replace(/\+Ctrl\b/gi, "+Control")
    .replace(/^Cmd\b/i, "Command")
    .replace(/\+Cmd\b/gi, "+Command")
    .replace(/^Win\b/i, "Super")
    .replace(/\+Win\b/gi, "+Super");
  // Must end in a non-modifier key.
  const parts = cleaned.split("+");
  const tail = parts[parts.length - 1];
  if (!tail || /^(Control|Shift|Alt|Command|Super|Meta)$/i.test(tail)) return null;
  return cleaned;
}

// Known Windows system shortcuts that globalShortcut cannot capture.
// PrintScreen is intentionally excluded — it CAN be captured on most Windows builds.
// Keys are normalized with the letter-key portion uppercased for case-insensitive lookup.
const WINDOWS_RESERVED = new Map<string, string>([
  ["Super+G",           "Windows Game Bar"],
  ["Super+PrintScreen", "Save screenshot to Pictures"],
  ["Super+Shift+S",     "Windows Snipping Tool"],
  ["Super+L",           "Windows lock screen"],
]);

function checkWindowsReserved(normalizedAccel: string): string | null {
  if (process.platform !== "win32") return null;
  // Case-insensitive lookup handles both bare letters ("Super+g"→"Super+G")
  // and named keys ("Super+printscreen"→"Super+PrintScreen").
  const lower = normalizedAccel.toLowerCase();
  for (const [key, label] of WINDOWS_RESERVED) {
    if (key.toLowerCase() === lower) return label;
  }
  return null;
}

function applyHotkeys(): void {
  globalShortcut.unregisterAll();
  if (!hotkeysEnabled) return;
  const sendBindFailed = (payload: HotkeyBindFailedPayload) => {
    mainWindow?.webContents.send("cove/hotkeys/bindFailed", payload);
    // Also surface through sendProgress so the current UI shows the error
    // until a dedicated bindFailed consumer is added to the renderer.
    sendProgress({ stage: "error", message: `hotkey error — ${payload.detail}` });
  };
  const tryRegister = (raw: string, action: "toggle" | "gif" | "replay") => {
    const accel = normalizeAccelerator(raw);
    if (!accel) {
      sendBindFailed({ action, accelerator: raw, reason: "invalid",
        detail: `"${raw}" is not a valid accelerator` });
      return false;
    }
    const reserved = checkWindowsReserved(accel);
    if (reserved) {
      sendBindFailed({ action, accelerator: accel, reason: "reserved",
        detail: `Reserved by ${reserved} — choose a different binding` });
      return false;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => {
        mainWindow?.webContents.send("cove:hotkey", action);
        mainWindow?.webContents.send("cove/hotkeys/triggered", action);
      });
    } catch (err) {
      sendBindFailed({ action, accelerator: accel, reason: "error",
        detail: err instanceof Error ? err.message : String(err) });
      return false;
    }
    if (!ok) {
      sendBindFailed({ action, accelerator: accel, reason: "conflict",
        detail: `"${accel}" conflicts with another application` });
    }
    return ok;
  };
  tryRegister(activeHotkeys.toggle, "toggle");
  tryRegister(activeHotkeys.gif, "gif");
  tryRegister(activeHotkeys.replay, "replay");
}

function setHotkeysEnabled(enabled: boolean): void {
  hotkeysEnabled = enabled;
  applyHotkeys();
}

function setHotkeyBindings(bindings: Partial<HotkeyBindings>): void {
  activeHotkeys = {
    toggle: normalizeAccelerator(bindings.toggle ?? activeHotkeys.toggle) ?? activeHotkeys.toggle,
    gif: normalizeAccelerator(bindings.gif ?? activeHotkeys.gif) ?? activeHotkeys.gif,
    replay: normalizeAccelerator((bindings as { replay?: string }).replay ?? activeHotkeys.replay) ?? activeHotkeys.replay,
  };
  applyHotkeys();
}

function registerIpc(): void {
  ipcMain.handle("cove:get-app-info", async (): Promise<AppInfo> => {
    return {
      version: app.getVersion(),
      platform: process.platform,
      sessionType: detectSessionType(),
      ffmpeg: detectFfmpeg(),
    };
  });

  ipcMain.handle(
    "cove:list-sources",
    async (_e, kind: "screen" | "window" | "all" = "all") => {
      try {
        return await listSources(kind);
      } catch (err) {
        console.warn("listSources failed", err);
        return [];
      }
    },
  );

  ipcMain.handle(
    "cove:select-crop-region",
    async (): Promise<CropSelectionResult | null> => {
      try {
        return await startCropSelection();
      } catch (err) {
        console.warn("crop selection failed", err);
        return null;
      }
    },
  );

  ipcMain.on(
    "cove:selection-commit",
    (_e, rect: { x: number; y: number; width: number; height: number; dpr: number }) => {
      if (!pendingSelection) {
        destroyOverlay();
        return;
      }
      const p = pendingSelection;
      const result: CropRect = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        dpr: rect.dpr,
        displayId: p.displayId,
        displayWidth: p.displayWidth,
        displayHeight: p.displayHeight,
        sourceId: p.source?.id ?? "",
      };
      resolveSelection(p.source ? { rect: result, source: p.source } : { rect: result });
    },
  );

  ipcMain.on("cove:selection-cancel", () => {
    resolveSelection(null);
  });

  ipcMain.on("cove:set-ignore-mouse-events", (e, ignore: boolean) => {
    if (
      overlayWindow &&
      !overlayWindow.isDestroyed() &&
      e.sender === overlayWindow.webContents
    ) {
      overlayWindow.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });

  ipcMain.handle("cove:pick-output-dir", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select output folder",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: defaultOutputDir(),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("cove:open-folder", async (_e, dir: string) => {
    if (dir && fs.existsSync(dir)) await openPathExternal(dir);
  });

  ipcMain.handle("cove:reveal", async (_e, p: string) => {
    if (p && fs.existsSync(p)) revealExternal(p);
  });

  ipcMain.handle("cove:open-file", async (_e, p: string) => {
    if (p && fs.existsSync(p)) await openPathExternal(p);
  });

  ipcMain.handle("cove:get-thumbnail", async (_e, filePath: unknown): Promise<string | null> => {
    if (typeof filePath !== "string" || !filePath) return null;
    const ALLOWED_EXTS = new Set([".mp4", ".gif", ".webm"]);
    if (!ALLOWED_EXTS.has(path.extname(filePath).toLowerCase())) return null;
    const home = os.homedir();
    const expanded =
      filePath === "~" ? home
      : filePath.startsWith("~/") || filePath.startsWith("~\\") ? path.join(home, filePath.slice(2))
      : filePath;
    const resolved = path.resolve(expanded);
    const ffInfo = detectFfmpeg();
    if (!ffInfo.available || !ffInfo.path) return null;
    try { await fs.promises.access(resolved); } catch { return null; }
    return extractThumbnail(ffInfo.path, resolved);
  });

  ipcMain.handle(
    "cove:list-recordings",
    async (_e, dir: string | null, limit?: number): Promise<import("./types").LibraryEntry[]> => {
      const ALLOWED_EXTS = new Set([".mp4", ".gif", ".webm"]);
      const cap = Math.min(typeof limit === "number" && limit > 0 ? limit : 30, 100);
      const scanDir = (() => {
        if (typeof dir === "string" && dir.length > 0) {
          const home = os.homedir();
          const expanded =
            dir === "~" ? home
            : dir.startsWith("~/") || dir.startsWith("~\\") ? path.join(home, dir.slice(2))
            : dir;
          return path.resolve(expanded);
        }
        return defaultOutputDir();
      })();
      try {
        const names = await fs.promises.readdir(scanDir);
        const entries: import("./types").LibraryEntry[] = [];
        for (const name of names) {
          if (name.startsWith(".")) continue;
          const ext = path.extname(name).toLowerCase();
          if (!ALLOWED_EXTS.has(ext)) continue;
          const full = path.join(scanDir, name);
          try {
            const st = await fs.promises.stat(full);
            if (!st.isFile() || st.size === 0) continue;
            entries.push({
              path: full,
              name,
              bytes: st.size,
              modified: st.mtimeMs,
              durationSec: null,
              thumbDataUrl: null,
            });
          } catch {
            // disappeared or unreadable — skip
          }
        }
        entries.sort((a, b) => {
          const diff = b.modified - a.modified;
          if (diff !== 0) return diff;
          return b.name > a.name ? 1 : b.name < a.name ? -1 : 0;
        });
        return entries.slice(0, cap);
      } catch {
        return [];
      }
    },
  );

  ipcMain.handle("cove:begin-recording", async (_e, params: StartRecordingParams) => {
    const outDir = params.outputDir || defaultOutputDir();
    const { recordingId } = await begin({ ...params, outputDir: outDir });
    // Recording started — invalidate the source cache so the next "Add window"
    // session sees the current state of the desktop, not a stale snapshot.
    invalidateSourceCache();
    sendProgress({ recordingId, stage: "encoding", percent: 0, message: "recording" });
    onTrayRecordingStart();
    return { recordingId };
  });

  ipcMain.handle(
    "cove:save-chunk",
    async (_e, recordingId: string, buffer: ArrayBuffer) => {
      appendChunk(recordingId, buffer);
    },
  );

  ipcMain.handle("cove:finalize-recording", async (_e, params: FinalizeParams) => {
    sendProgress({ recordingId: params.recordingId, stage: "muxing", percent: 50, message: "encoding" });
    const result = await finalize(params, (line) => {
      sendProgress({ recordingId: params.recordingId, stage: "muxing", message: line.trim().slice(0, 200) });
    });
    if (result.ok) {
      sendProgress({
        recordingId: params.recordingId,
        stage: "done",
        percent: 100,
        message: result.error ?? "saved",
        outputPath: result.outputPath,
      });
    } else {
      sendProgress({
        recordingId: params.recordingId,
        stage: "error",
        message: result.error,
      });
    }
    onTrayRecordingStop(result.outputPath);
    return result;
  });

  ipcMain.handle("cove:cancel-recording", async (_e, recordingId: string) => {
    cancel(recordingId);
    onTrayRecordingStop();
  });

  ipcMain.handle("cove:register-hotkeys", async (_e, enabled: boolean) => {
    setHotkeysEnabled(enabled);
  });

  ipcMain.handle(
    "cove:set-hotkey-bindings",
    async (_e, bindings: Partial<HotkeyBindings>) => {
      setHotkeyBindings(bindings);
    },
  );

  // Grow / shrink the main window vertically without ever shrinking past the
  // user's manually-resized footprint. Used when the renderer expands the log
  // panel so users see more content without an inner scrollbar.
  ipcMain.handle(
    "cove:adjust-window-height",
    async (_e, deltaPx: number) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isFullScreen() || mainWindow.isMaximized()) return;
      const [w, h] = mainWindow.getSize();
      const next = Math.max(540, Math.round(h + deltaPx));
      // Cap to the display's working area so we never push the titlebar off-screen.
      const display = screen.getDisplayMatching(mainWindow.getBounds());
      const maxH = display.workArea.height - 8;
      mainWindow.setSize(w, Math.min(next, maxH), true);
    },
  );

  ipcMain.handle(
    "cove:set-next-display-media",
    async (_e, kind: "screen" | "window" | "all" = "all") => {
      nextDisplayMediaTypes =
        kind === "all" ? ["screen", "window"] : [kind];
      nextDisplayMediaSelected = null;
    },
  );

  ipcMain.handle(
    "cove:get-last-display-media-selection",
    async () => getLastDisplayMediaSelection(),
  );

  ipcMain.handle(
    "cove:set-picked-display-media-source",
    async (_e, sourceId: string | null) => {
      pendingPickedSourceId = typeof sourceId === "string" && sourceId ? sourceId : null;
    },
  );

  ipcMain.on("cove:window-minimize", () => mainWindow?.minimize());
  ipcMain.on("cove:window-toggle-maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on("cove:window-close", () => mainWindow?.close());

  // ── v2 helper API (N-007 §3.1) ────────────────────────────────────────────
  // Channel convention: cove/<namespace>/<method>
  // All handlers return RpcEnvelope plain objects — no Error throwing across
  // invoke, so error codes survive Electron's structured clone serialization.

  // engine.*
  ipcMain.handle("cove/engine/version", async () => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    const env = await rpcEnv(() => rpc.engineVersion());
    if (!env.ok) return env;
    return { ok: true, result: { helperVersion: env.result.helper_version, protocolVersion: env.result.protocol_version } };
  });

  ipcMain.handle("cove/engine/status", async () => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    const env = await rpcEnv(() => rpc.engineHealth());
    if (!env.ok) return env;
    const r = env.result;
    return { ok: true, result: {
      state: r.state,
      uptimeMs: r.uptime_ms,
      activeSessions: r.active_sessions,
      activeSnapshots: r.active_snapshots,
      activeExports: r.active_exports,
      lastErrorTs: r.last_error_ts,
      diagnosticsDir: r.diagnostics_dir,
      rollingBufferBytes: r.rolling_buffer_bytes,
    }};
  });

  ipcMain.handle("cove/engine/restart", async () => {
    if (!supervisor) return { ok: false, code: "helper-unavailable", message: "helper-unavailable" };
    lastReadyPayload = null;
    try {
      await supervisor.restart();
      return { ok: true, result: null };
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)) || "restart-failed";
      return { ok: false, code: "restart-failed", message: msg };
    }
  });

  ipcMain.handle("cove/engine/openDiagnosticsBundle", async () => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    const env = await rpcEnv(() => rpc.engineDiagnosticsBundlePath());
    if (!env.ok) return env;
    if (env.result.path) await openPathExternal(env.result.path);
    return { ok: true, result: null };
  });

  // capture.*
  ipcMain.handle("cove/capture/listSources", async () => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.captureListSources());
  });

  ipcMain.handle("cove/capture/requestSession", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.captureRequestSession(params));
  });

  ipcMain.handle("cove/capture/startStream", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.captureStartStream(params));
  });

  ipcMain.handle("cove/capture/pauseStream", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.capturePauseStream(params));
  });

  ipcMain.handle("cove/capture/resumeStream", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.captureResumeStream(params));
  });

  ipcMain.handle("cove/capture/stopSession", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.captureStopSession(params));
  });

  ipcMain.handle("cove/capture/setRegion", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.captureSetRegion(params));
  });

  ipcMain.handle("cove/capture/setFramerateHint", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.captureSetFramerateHint(params));
  });

  ipcMain.handle("cove/capture/setCursorMode", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.captureSetCursorMode(params));
  });

  // replay.*
  ipcMain.handle("cove/replay/save", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.replaySave(params));
  });

  ipcMain.handle("cove/replay/snapshotRelease", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.replaySnapshotRelease(params));
  });

  ipcMain.handle("cove/replay/recoverableSessions", async () => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.replayRecoverableSessions());
  });

  ipcMain.handle("cove/replay/discardRecoveredSession", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.replayDiscardRecoveredSession(params));
  });

  ipcMain.handle("cove/replay/restoreRecoveredSession", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.replayRestoreRecoveredSession(params));
  });

  ipcMain.handle("cove/replay/exportStart", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.replayExportStart(params));
  });

  ipcMain.handle("cove/replay/exportCancel", async (_e, params: unknown) => {
    const rpc = supervisor?.rpcClient;
    if (!rpc?.connected) return disconnectedEnv();
    return rpcEnv(() => rpc.replayExportCancel(params));
  });

  // settings.* — passthrough stubs; no v2 settings schema yet
  ipcMain.handle("cove/settings/get", async () => ({ ok: true, result: null }));
  ipcMain.handle("cove/settings/set", async () => ({ ok: true, result: null }));

  // hotkeys.* — expose existing bindings; set delegates to main-process handler
  ipcMain.handle("cove/hotkeys/get", async () => ({ ok: true, result: { ...activeHotkeys } }));
  ipcMain.handle("cove/hotkeys/set", async (_e, bindings: Record<string, string>) => {
    setHotkeyBindings(bindings);
    return { ok: true, result: null };
  });

  // env.* — capability probe; filesystem paths are stripped from the response
  ipcMain.handle("cove/env/probe", async () => {
    const ffmpeg = detectFfmpeg();
    return { ok: true, result: {
      platform: process.platform,
      sessionType: detectSessionType(),
      ffmpeg: {
        available: ffmpeg.available,
        version: ffmpeg.version,
        encoders: ffmpeg.encoders,
      },
    }};
  });
}

// Sweep stale temp files left in <userData>/recordings/ from a previous
// crash mid-finalize. finalize()/cancel() unlink on the happy path; this
// just covers SIGKILL etc. Runs before begin() ever opens a fresh temp,
// and Chromium's userData lock prevents a concurrent Cove writer, so any
// file present at this point is an orphan. Best-effort — a failure here
// must not block startup.
function sweepStaleRecordings(): void {
  try {
    const dir = path.join(app.getPath("userData"), "recordings");
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) fs.unlinkSync(full);
      } catch {
        // skip — can't stat / unlink, leave it for next pass
      }
    }
  } catch {
    // best effort
  }
}

// Prevent a second instance from starting its own helper and stealing the
// live helper socket from the primary instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  supervisor = new EngineSupervisor();

  supervisor.on("ready", ({ helper_version, protocol_version }) => {
    lastReadyPayload = { helperVersion: helper_version, protocolVersion: protocol_version };
    lastBlockedPayload = null;
    mainWindow?.webContents.send("cove/engine/ready", lastReadyPayload);
    const rpc = supervisor?.rpcClient;
    if (rpc) wireHelperNotifications(rpc);
  });

  supervisor.on("crashed", () => {
    lastReadyPayload = null;
    mainWindow?.webContents.send("cove/engine/crashed");
  });

  supervisor.on("stateChanged", (state: string) => {
    mainWindow?.webContents.send("cove/engine/stateChanged", state);
  });

  supervisor.on("unavailable", (err: unknown) => {
    lastReadyPayload = null;
    mainWindow?.webContents.send("cove/engine/stateChanged", "unavailable");
    const code = (err as { code?: string })?.code;
    if (
      code === "sha256-mismatch" ||
      code === "protocol-mismatch" ||
      code === "missing-dependency"
    ) {
      const detail = (err as { detail?: string })?.detail;
      const payload: { code: string; detail?: string } =
        detail !== undefined ? { code, detail } : { code };
      lastBlockedPayload = payload;
      mainWindow?.webContents.send("cove/engine/blocked", payload);
    }
  });

  void supervisor.start();
  Menu.setApplicationMenu(null);
  registerIpc();
  installDisplayMediaHandler();
  sweepStaleRecordings();
  // Detect GPU vendor so the encoder picker can skip e.g. h264_nvenc on AMD
  // boxes (where it's compiled into ffmpeg but fails because nvcuda.dll
  // isn't loadable). Fire-and-forget — pickHardwareVideoEncoder treats an
  // unset vendor as "try everything in order".
  app.getGPUInfo("basic").then((info) => {
    const blob = JSON.stringify(info).toLowerCase();
    let vendor: "nvidia" | "amd" | "intel" | "unknown" = "unknown";
    if (/nvidia|geforce|quadro|tesla/.test(blob)) vendor = "nvidia";
    else if (/\bamd\b|radeon|advanced micro devices/.test(blob)) vendor = "amd";
    else if (/\bintel\b/.test(blob)) vendor = "intel";
    setDetectedGpuVendor(vendor);
  }).catch(() => {
    // best-effort; the picker falls back to "try all encoders" on unknown
  });
  // Pipe recorder diagnostics (audio sidecar status, etc.) into the renderer
  // log panel via the existing progress channel.
  setRecorderLogger((line) => {
    sendProgress({ stage: "muxing", message: line });
  });
  // Force light theme out — we ship dark only.
  if (!app.isPackaged) {
    // Avoid a console warning when Vite reloads.
    app.commandLine.appendSwitch("disable-features", "OverlayScrollbar");
  }
  createWindow();
  if (process.platform === "win32") createTray();

  if (process.platform === "win32") {
    screen.on("display-added", invalidateSourceCache);
    screen.on("display-removed", invalidateSourceCache);
    screen.on("display-metrics-changed", invalidateSourceCache);
  }

  // Default-pick output dir if nothing is set yet — done lazily in IPC handler.
  // Pre-warm: nothing.
  // App icon for taskbar.
  try {
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), "cove_icon.png"));
    if (!icon.isEmpty() && process.platform === "linux") app.dock?.setIcon?.(icon);
  } catch {
    // ignore
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  if (app.isPackaged) {
    const appImagePath = process.platform === "linux" ? process.env.APPIMAGE : undefined;
    if (appImagePath) {
      // Issue #9: electron-updater's AppImageUpdater finishes an update by
      // exec'ing the new AppImage; AppImageLauncher intercepts that exec and
      // the child exits early, killing the update with a silent EPIPE.
      // electron-updater still detects and downloads (verifying sha512 from
      // latest-linux.yml); the install is a plain in-place file swap with no
      // child process, so AppImageLauncher has nothing to intercept. The new
      // version takes effect on next launch.
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.on("update-available", (info) => {
        sendUpdateEvent({ kind: "downloading", version: info.version });
      });
      autoUpdater.on("update-downloaded", (info) => {
        try {
          installAppImageUpdate(info.downloadedFile, appImagePath);
          sendUpdateEvent({ kind: "installed", version: info.version });
        } catch (err) {
          console.warn("auto-update install failed:", err);
          sendUpdateEvent({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
      autoUpdater.on("error", (err) => {
        console.warn("auto-update failed:", err);
        sendUpdateEvent({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
      autoUpdater.checkForUpdates().catch((err) => {
        console.warn("auto-update check failed:", err);
        sendUpdateEvent({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      autoUpdater.checkForUpdatesAndNotify().catch((err) => {
        console.warn("auto-update check failed:", err);
      });
    }
  }
});

app.on("window-all-closed", () => {
  cancelAll();
  globalShortcut.unregisterAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  cancelAll();
  globalShortcut.unregisterAll();
  if (helperShutdownComplete || !supervisor) return;
  event.preventDefault();
  // Guard against re-entrant quit: a second before-quit fires while the first
  // shutdown is still in progress. Calling preventDefault() above keeps Electron
  // from exiting; returning here lets the original race's .finally() call
  // app.quit() once — and only once — when real cleanup is done.
  if (helperShutdownPromise) return;
  helperShutdownPromise = Promise.race([
    supervisor.shutdown(),
    new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
  ])
    .catch((err: unknown) => {
      console.warn("[main] supervisor shutdown error:", err);
    })
    .finally(() => {
      helperShutdownComplete = true;
      app.quit();
    });
});
