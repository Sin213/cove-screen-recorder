# Handover — T-008 Electron UI ↔ native/helper engine integration

**Date:** 2026-05-13
**Session type:** Design only (planning, `.story/` updates only — no source edits).
**Branch:** main
**Ticket:** T-008 (Plan Electron UI integration with native/helper engine) → **status: complete**
**Phase:** p3-integration

---

## What was decided

The UI ↔ engine contract for v2.0.0 is locked. Full design is `.story/notes/N-007.json` (25 sections, ~12 KB). Summary captured below.

### Three processes, two IPC boundaries

```
Renderer  ─── ipcMain.handle / webContents.send (Electron IPC) ───  Main
   │                                                                  │
   │       (preload bridge: contextIsolation + sandbox)                │
   ▼                                                                  ▼
Main      ─── length-prefixed JSON-RPC 2.0 on UDS / named pipe ───  Helper (Rust)
                                                                       │
                                                                       └─ owns: PipeWire capture, encoder matrix, rolling buffer, export/remux
```

Frames never cross either boundary. Electron is the control plane only.

**Boundary A — renderer ↔ main:**
- `cove/<domain>/<verb|noun>` channel naming.
- `ipcMain.handle` (invoke) for request/response; `webContents.send` for events.
- Preload bridge exposes `window.coveApi` ONLY; renderer has no Node, no fs, no net.
- Every invoke resolves `{ ok: true, value } | { ok: false, error: { code, message, details? } }`; preload re-throws with `error.code` attached.

**Boundary B — main ↔ helper:**
- Linux/macOS: UDS at `$XDG_RUNTIME_DIR/cove-screen-recorder/engine.sock`, mode 0600 (macOS fallback `${TMPDIR}/cove-screen-recorder.<uid>.sock`).
- Windows: named pipe `\\.\pipe\cove-screen-recorder-<uid>` (per-user ACL).
- Framing: `[ 4-byte big-endian length N ][ N bytes UTF-8 JSON-RPC ]`, 1 MiB per-frame cap.
- Helper writes its PID to `$XDG_RUNTIME_DIR/cove-screen-recorder/engine.pid` (Linux) / `%LOCALAPPDATA%\cove-screen-recorder\engine.pid` (Windows). Main does the handshake to avoid stale-socket adoption.
- Notifications and requests both directions; main never sends notifications to the helper.

### JSON-RPC method namespace (binding)

```
capture.listSources()                                         -> CaptureSourceDescriptor[]
capture.requestSession({ mode, options })                     -> { sessionId, restoreToken? }
capture.startStream({ sessionId })                            -> { streamId }
capture.pauseStream({ streamId })                             -> void
capture.resumeStream({ streamId })                            -> void
capture.stopSession({ sessionId })                            -> void
capture.setRegion({ streamId, rect })                         -> void
capture.setFramerateHint({ streamId, fps })                   -> void
capture.setCursorMode({ streamId, mode })                     -> void

replay.save({ durationSeconds })                              -> ReplaySnapshot
replay.snapshot_release({ snapshotId })                       -> void
replay.recoverable_sessions()                                 -> RecoverableSession[]
replay.discard_recovered_session({ sessionId })               -> void
replay.restore_recovered_session({ sessionId })               -> ReplaySnapshot
replay.export_start({ snapshot, options })                    -> { exportId }
replay.export_cancel({ exportId })                            -> void

engine.version()                                               -> { helperVersion, protocolVersion }
engine.health()                                                -> EngineHealth
engine.setLogLevel({ level })                                  -> void
engine.shutdown({ deadlineMs })                                -> void
engine.diagnosticsBundlePath()                                 -> string
```

No `encoder.*` request methods (auto-selected per N-004). No `export.*` request methods — start/cancel live under `replay.*` because both take a `ReplaySnapshot`.

### Event surface (binding)

```
capture.sessionReady    capture.formatChanged    capture.streamPaused
capture.streamResumed   capture.sessionLost      capture.diagnostics

encoder.probeResult     encoder.selected         encoder.fallbackEngaged
encoder.runtimeError    encoder.backPressure     encoder.diagnostics

replay.segmentDiagnostics   replay.recoveryAvailable
replay.snapshotPinned       replay.snapshotReleased

export.queued    export.started    export.progress   export.stalled
export.completed export.failed     export.cancelled  export.rejected

engine.ready     engine.shutdownStarted     engine.logLine
engine.stateChanged   engine.crashed
```

Helper emits `snake_case`; the main-process bridge re-keys to `camelCase` before forwarding to the renderer.

### Helper lifecycle / supervision model

- **Launch.** Main spawns the helper after `app.whenReady()` and before any BrowserWindow. Pre-spawn: resolve binary at `process.resourcesPath/helper/cove-replay-engine[.exe]` (dev override `COVE_HELPER_PATH`), **verify the `.sha256` sidecar** (global release rule; refuse with `helper-binary-tampered` on mismatch), `engine --print-protocol-version` must match Electron's baked-in protocol (else `helper-protocol-mismatch`).
- **Orphan adoption.** If `engine.pid` points to a live same-user `cove-replay-engine`, **adopt without respawn**. Stale PID + socket files are scrubbed before fresh spawn. PID belonging to a different user → refuse with `helper-pid-collision`.
- **Shutdown.** Clean: `engine.shutdown({ deadlineMs: 5000 })`; helper drains every session/segment/export; main waits, SIGTERM after 6 s, SIGKILL after 8 s. Forced: `deadlineMs: 0`; helper SIGKILLs ffmpeg children. Always: main scrubs `engine.{sock,pid}` on exit.
- **Crash detection signals.** `child.on("exit")`, socket EOF without prior `engine.shutdown`, `engine.health` heartbeat timeout (10 s, suppressed while other traffic is flowing).
- **Crash response.** Emit `engine.crashed { reason, exitCode?, signal?, stderrTail }`. Reject in-flight RPC promises with `helper-disconnected`. Invalidate any pinned snapshots the renderer is holding. Run restart loop: immediate, +2 s, +10 s. 3 failures within 60 s → sticky `engine.unavailable` requiring `engine.restart`.
- **No silent auto-resume of recording.** Crash mid-record returns the UI to `IDLE`. Any recoverable session is offered via `replay.recoveryAvailable` (N-005 §11) as a non-modal banner the user must explicitly act on.
- **Crash mid-export.** Temp file orphaned; next helper boot scans `exports/manifest.jsonl` and unlinks orphans (N-006 §15). Source session may surface via `replay.recoveryAvailable`.
- **Process cleanup invariant (v1.1.0 carry-forward, structural).** All subprocess lifecycle lives inside the helper. Linux: `prctl(PR_SET_PDEATHSIG, SIGKILL)` on every helper subprocess. Windows: Job Objects with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = true`. **No `pactl` anywhere** — v2 uses PipeWire audio API directly when audio lands; v1.1.0 leftover-`pactl` class is eliminated. Main scrubs only the socket and PID file.

### Renderer state model (FSM, event-driven, no timers)

```
IDLE → PICKING → SESSION_PENDING → STREAM_PENDING → READY
       → RECORDING → SAVING → SNAPSHOT_HELD → EXPORTING (concurrent w/ RECORDING)

Any → SESSION_LOST   (sticky; needs "Pick source")
Any → ENGINE_DOWN    (sticky; needs engine.restart)
```

Invariants:
1. `RECORDING` reachable ONLY via `capture.sessionReady` — no timer, no DOM mount, no MediaRecorder state subscription.
2. `SAVING` does NOT freeze the HUD; HUD timer continues from `capture.diagnostics` / `encoder.diagnostics` / `replay.segmentDiagnostics` ticks.
3. `EXPORTING` is concurrent with `RECORDING`; exports live in a separate panel.
4. `SESSION_LOST` and `ENGINE_DOWN` are sticky; user action is required to leave them.

Three clocks, never conflated:
- Active session time = `Date.now() − sessionReady.tsNs/1e6` (HUD top-left)
- Replay window duration = static setting (save button label)
- Export progress = `export.progress.pct` per export (export panel)

### Settings surface

```
replay.{durationSeconds (default 60; range 10..1800; presets 30/60/120/300/600),
        startReplayBufferOnLaunch}
capture.{mode (monitor|window|region), region, framerateHint,
         cursorMode (default embedded), rememberRestoreToken}
encoder.preference (auto|nvenc|vaapi|qsv|libx264) -- hint only; helper may downgrade per N-004
export.{maxCompatibility, outputDir, overwritePolicy (default unique)}
hotkeys.{saveReplay (default "CommandOrControl+Shift+R" — carries T-002),
         toggleRecording (default "CommandOrControl+Shift+F9"),
         pauseResume (default unbound)}
diagnostics.{verbosity (default info), keepDiagnosticsBundles (default 5)}
startup.{autoLaunch, startMinimized}
```

Mid-session live-update rules: capture.{region,framerateHint,cursorMode} → call `capture.set*` immediately. capture.mode → end session + prompt re-pick. encoder.preference → queue for next session. diagnostics.verbosity → `engine.setLogLevel`. hotkeys → re-register `globalShortcut`.

### Issue #1 / #3 / #4 absorption

- **#1 (crop area selection unclear/missing).** `region` is a first-class capture mode. After the portal picks a monitor, the renderer opens a frameless overlay window (darkened mask + draggable rectangle). Rectangle → `capture.setRegion`. Helper crops at the encoder boundary (N-003 §6). "Adjust region" mid-recording is hot. **The phrase "Share region" never appears in the UI.**
- **#3 (source does not record until hovered).** `capture.sessionReady` is the ONLY transition into `RECORDING`. HUD timer reads `sessionReady.tsNs`, not `Date.now()` at component mount. Helper produces frames as soon as `pw_stream` reaches `Streaming` (N-003 §5) — no DOM coupling. The N-003 §17 case 24 validation (60 s minimised-preview must produce expected frame count) is the load-bearing assertion.
- **#4 (crop/replay timer state weirdness).** Three clocks in three UI regions with no shared state (§ above). `SAVING` does not freeze the HUD. Replay window duration is a static setting. Region change does not interact with the timer.

### Capture source / region selection UX

- Primary entry: **Pick source** button. Reads `capture.mode` from settings, invokes `capture.requestSession`, transitions UI through PICKING → SESSION_PENDING → READY on `capture.sessionReady`.
- Quick-pick: known restore tokens (returned in `CaptureSourceDescriptor.knownRestoreTokens`) appear as rows like "Last used: Monitor 1 (DP-1)". Clicking suppresses the portal dialog (per N-003 §5 token flow); falls back gracefully if rejected.
- Region overlay: frameless, owned by the renderer, drawn over the picked monitor's geometry. Before/during/after states are explicit (drag instructions / live dimensions / confirm-cancel handles).
- "Forget all sources" clears the helper-side restore-token file.

### Replay save / export UX

- Save button labelled with current replay duration ("Save last 60 s"); enabled only in `RECORDING`.
- One-click flow: `replay.save` (≤ 250 ms + encoder fragment latency) → `replay.exportStart` with default `ExportOptions` → export panel populates. The HUD timer does not freeze during save.
- Export panel: per-row stage badge, progress bar, ETA, **Cancel disabled past `MUXING`** per N-006 §11. Stalled overlay clears on next `progress`; never auto-cancels.
- On `export.completed`: toast with "Show in folder" (shell.showItemInFolder via main bridge). Row moves to recent-exports history (last 10 retained for the session).
- On `export.failed`: row shows mapped reason + "Show diagnostics" CTA opening `diagnosticsPath`.
- On `export.rejected`: toast ("Too many pending exports — please wait").
- Recoverable session prompt: non-modal sticky banner at top of window, one row per recoverable session; [Save] → `replay.restoreRecoveredSession` → snapshot → export; [Discard] → `replay.discardRecoveredSession`.

### Diagnostics surface

| Sink | Owner | Location |
| --- | --- | --- |
| Per-session JSON dumps | Helper | `$XDG_STATE_HOME/cove-screen-recorder/diagnostics/<id>.json` (N-003/N-004/N-005/N-006) |
| `engine.log` (rotating) | Helper | same dir; 50 MiB / 24 h rotation; retain `keepDiagnosticsBundles` |
| `main.log` | Main | `app.getPath("logs")/main.log` (supervisor, IPC, settings, hotkeys, renderer crashes) |
| `engine.logLine` ring buffer | Renderer | in-memory, last 200; Settings → Diagnostics → "View live engine log" |

`engine.copyDiagnosticsBundle()` produces a zip: last N per-session dumps + helper log tail + main log tail + redacted settings + environment manifest (OS, kernel, PipeWire version, compositor name, GPU vendor/driver, helper version, Electron version).

### Error mapping

Every helper reason code maps to ONE user-facing string + at most one CTA. Unrecognised codes surface verbatim ("Engine error: foo-bar — please report this"). Full table in N-007 §17.1 covers portal/encoder/segment/export/helper-* codes.

### Dependency probe (Linux first)

On app start, `coveApi.env.probe()` reports presence of `xdg-desktop-portal`, `pipewire`, `libx264`, helper binary (path + version + sha256 match), GPU vendor/driver. Missing required dependencies show a **blocking modal** with platform-specific install hints; settings remain reachable.

### Packaging implications (no changes this session)

- Helper ships via `extraResources` per target: `resources/helper/cove-replay-engine[.exe]`.
- Every shipped binary gets a `.sha256` sidecar per global release rule.
- Linux `.deb` Depends on `pipewire (>= 0.3.x)`, `xdg-desktop-portal (>= 1.18)`; backend (`-gnome`/`-kde`/`-wlr`) is user's choice.
- Windows helper signed in the same step as the main exe.
- Auto-update unchanged from v1.1.0; sha256 check at boot covers integrity after update.

### Linux-first, Windows path shape preserved

UDS↔named pipe is the only transport switch. Capture `WgcSource` slot (N-003 §18) and encoder `AmfEncoder` slot (N-004 §1) are already there; render FSM / settings / event surface / method namespace are platform-agnostic. Defaults differ only for output dir, diagnostics dir, hotkey accelerators (handled by `CommandOrControl`), auto-launch mechanism.

---

## Exact `.story` files changed

- `.story/notes/N-007.json` — created. Full design record.
- `.story/tickets/T-008.json` — status `open` → `complete`; description rewritten to cite N-007 and pin the contract.
- `.story/project-state.md` — appended new section "v2.0.0 Electron UI ↔ native/helper engine integration (T-008, 2026-05-13)" before the open-issue triage table.
- `.story/handovers/2026-05-13-09-t-008-ui-engine-integration.md` — this file.

No other files in the repo were touched.

## Source files changed

None. Planning-only session. No code, no Electron, no helper, no PipeWire, no encoder, no rolling-buffer, no export/remux, no packaging, no tests, no release build.

---

## Out of scope (deferred — recorded for follow-up)

- Onboarding flow / first-run UX.
- Trim adjustment UI for saved replays.
- Multi-stream / multi-source recording UX.
- Audio routing UX (helper doesn't implement audio capture yet; placeholder is one disabled checkbox).
- Telemetry / anonymous usage reporting.
- In-app updates UI (auto-update mechanism unchanged from v1.1.0).
- Theme switching, custom keybind chord support, accessibility audit.
- Direct rendering of replay thumbnails in the export panel.
- v1.1.0 saved-replay migration (v1.1.0 already outputs MP4; nothing to migrate).
- Settings import/export.

---

## What T-008 hands T-009

The validation cases enumerated in N-007 §22 (lifecycle/supervision, renderer FSM, region UX, Issue #3 absorption, Issue #4 absorption, hotkeys, dependency probe, settings, diagnostics, process cleanup, recovery flow) combine with the helper-side cases in N-003 §17, N-004 §20, N-005 §19, N-006 §18 to make up the v2 validation surface. T-009 writes the matrix that asserts each.

## Recommended next ticket

**T-009 — Plan validation matrix for 1080p60, 1440p60, and 4K60.** All four design tickets (T-004..T-007) plus T-008 are now complete; T-009 has the full input surface it needs. T-009 is planning-only as well (validation matrix + scripted test plan; no test files yet).

---

## Codex review

**No Codex review needed unless non-`.story` files changed.** Only `.story/` planning artifacts were modified this session.

---

## Storybloq updates (no MCP)

The cove-nexus storybloq MCP instance is bound to the cove-nexus cwd; the cove-screen-recorder `.story/` tree was updated directly via file writes from the repo root. The structure matches the previous handovers (T-003 through T-007).

- T-008 status set to `complete` in `.story/tickets/T-008.json` (`completedDate: 2026-05-13`).
- N-007 design note created in `.story/notes/N-007.json` (tags: v2, design, integration, ipc, electron, helper, supervision, t-008).
- Handover saved as `.story/handovers/2026-05-13-09-t-008-ui-engine-integration.md`.
