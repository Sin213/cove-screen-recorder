// V2 engine subscriptions — wires coveApi events into the Zustand v2 state slice.
// initV2Engine() is called once on app mount and returns a cleanup function.
//
// _enterRecording() is the SOLE call site that sets v2State to "RECORDING".
// All RECORDING transitions (initial entry via onSessionReady, and return
// after export completion) go through this single function.

import { useStore } from "../store";

type Unsub = () => void;

function gs() {
  return useStore.getState();
}

// SOLE call site for "RECORDING" state. All entries (initial and post-export) go here.
function _enterRecording(): void {
  gs().setV2State("RECORDING");
}

function _releaseCurrentSnapshot(): void {
  const id = gs().v2SnapshotId;
  if (id) void _releaseWithRetry(id);
}

// The helper may still hold the export active briefly after emitting a terminal
// event. Retry with backoff until the release is accepted.
async function _releaseWithRetry(id: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      gs().log("info", `[export lifecycle] snapshot release retry: id=${id} attempt=${attempt}`);
      await new Promise<void>((r) => setTimeout(r, 150 * attempt));
    }
    try {
      await window.coveApi.replay.snapshotRelease({ snapshot_id: id });
      gs().log("info", `[export lifecycle] snapshot release success: id=${id} attempt=${attempt}`);
      return;
    } catch {
      // retry
    }
  }
  gs().log("warn", `[export lifecycle] snapshot release exhausted: id=${id}`);
}

async function _applyEngineReady(info: { helperVersion: string; protocolVersion: number }): Promise<void> {
  gs().setV2EngineInfo(info);
  const cur = gs().v2State;
  if (cur === "BOOTING" || cur === "ENGINE_DOWN" || cur === "ENGINE_UNAVAILABLE") {
    await _refreshRecoverableSessions();
  }
}

export function initV2Engine(): Unsub {
  const api = window.coveApi;
  const subs: Unsub[] = [];

  // ── Engine lifecycle ──────────────────────────────────────────────────────

  subs.push(api.engine.onReady(async (info) => {
    await _applyEngineReady(info as { helperVersion: string; protocolVersion: number });
  }));

  subs.push(api.engine.onCrashed(() => {
    gs().setV2State("ENGINE_DOWN");
    gs().setV2SessionId(null);
    gs().setV2SessionReadyMs(null);
    gs().setV2SnapshotId(null);
    gs().setV2SnapshotHeld(false);
    gs().setV2ExportId(null);
  }));

  subs.push(api.engine.onStateChanged((state) => {
    if (state === "unavailable") {
      gs().setV2State("ENGINE_UNAVAILABLE");
      gs().setV2SessionId(null);
      gs().setV2SessionReadyMs(null);
      gs().setV2SnapshotId(null);
      gs().setV2SnapshotHeld(false);
      gs().setV2ExportId(null);
    }
  }));

  // ── Capture events ────────────────────────────────────────────────────────

  subs.push(api.capture.onSessionReady((raw) => {
    const ev = raw as { session_id: string };
    gs().setV2SessionId(ev.session_id);
    gs().setV2SessionReadyMs(Date.now());
    _enterRecording();
  }));

  subs.push(api.capture.onSessionLost(() => {
    gs().setV2SessionId(null);
    gs().setV2SessionReadyMs(null);
    const cur = gs().v2State;
    if (cur === "RECORDING" || cur === "SAVING") {
      gs().setV2State("IDLE");
    }
    // If EXPORTING: keep EXPORTING — export is independent of capture lifetime.
    // The export terminal event (completed/failed/cancelled) drives state to IDLE.
    // v2SessionId is now null, so those handlers will set IDLE instead of RECORDING.
  }));

  // ── Replay / snapshot events ──────────────────────────────────────────────

  subs.push(api.replay.onSnapshotPinned((raw) => {
    const ev = raw as { snapshot_id: string };
    // Dedupe: if the RPC fallback in saveReplay/restoreRecovery already claimed
    // this snapshot and started an export, skip.
    if (gs().v2SnapshotId === ev.snapshot_id && gs().v2State === "EXPORTING") return;
    gs().setV2SnapshotId(ev.snapshot_id);
    gs().setV2SnapshotHeld(true);
    gs().setV2State("EXPORTING");
    void _startExport(ev.snapshot_id);
  }));

  subs.push(api.replay.onSnapshotReleased((raw) => {
    const ev = raw as { snapshot_id: string };
    // Only clear if this event matches the snapshot we are currently tracking.
    // A stale release must not clobber a newer snapshot's id.
    if (gs().v2SnapshotId === ev.snapshot_id) {
      gs().setV2SnapshotId(null);
      gs().setV2SnapshotHeld(false);
    }
  }));

  subs.push(api.replay.onRecoveryAvailable((raw) => {
    const ev = raw as { sessions: unknown[] };
    const sessions = ev.sessions as never[];
    gs().setV2RecoverableSessions(sessions);
    if (gs().v2RecoveryIgnoredForSession) return;
    if (sessions.length > 0 && gs().v2State === "IDLE") {
      gs().setV2State("RECOVERY_AVAILABLE");
    }
  }));

  // ── Export events ─────────────────────────────────────────────────────────
  // Reject events only when both the event AND the store carry an export_id
  // and they differ. When v2ExportId is null (RPC response hasn't arrived yet),
  // accept the event — it belongs to the pending export.
  function _isStaleExport(eventId: string | undefined): boolean {
    const active = gs().v2ExportId;
    const stale = !!(eventId && active && eventId !== active);
    if (stale) {
      gs().log("info", `[export lifecycle] stale-guard discard: event export_id=${eventId} active=${active}`);
    }
    return stale;
  }

  subs.push(api.export.onProgress((raw) => {
    const ev = raw as { export_id?: string; pct: number };
    if (_isStaleExport(ev.export_id)) return;
    gs().setV2ExportProgress(ev.pct);
  }));

  subs.push(api.export.onCompleted((raw) => {
    const ev = raw as { export_id?: string; final_path?: string };
    gs().log("info", `[export lifecycle] export.completed received: export_id=${ev.export_id ?? "?"} final_path=${ev.final_path ?? "?"} v2State=${gs().v2State} v2ExportId=${gs().v2ExportId ?? "null"}`);
    if (_isStaleExport(ev.export_id)) return;
    gs().log(
      "info",
      `[export lifecycle] stale-guard accept: event export_id=${ev.export_id ?? "undef"} active=${gs().v2ExportId ?? "null"} verdict=accept`,
    );
    gs().setV2ExportOutputPath(ev.final_path ?? null);
    gs().setV2ExportProgress(null);
    gs().setV2ExportId(null);
    _releaseCurrentSnapshot();
    if (gs().v2SessionId !== null) {
      _enterRecording();
    } else {
      gs().setV2State("IDLE");
    }
    gs().log("info", `[export lifecycle] export.completed post-transition: v2State=${gs().v2State}`);
  }));

  subs.push(api.export.onFailed((raw) => {
    const ev = raw as { export_id?: string; stage?: string; reason_code?: string };
    gs().log("info", `[export lifecycle] export.failed received: export_id=${ev.export_id ?? "?"} stage=${ev.stage ?? "?"} reason_code=${ev.reason_code ?? "?"} v2State=${gs().v2State} v2ExportId=${gs().v2ExportId ?? "null"}`);
    if (_isStaleExport(ev.export_id)) return;
    gs().log(
      "info",
      `[export lifecycle] stale-guard accept: event export_id=${ev.export_id ?? "undef"} active=${gs().v2ExportId ?? "null"} verdict=accept`,
    );
    gs().setV2ExportProgress(null);
    gs().setV2ExportId(null);
    _releaseCurrentSnapshot();
    if (gs().v2State === "EXPORTING") {
      if (gs().v2SessionId !== null) {
        _enterRecording();
      } else {
        gs().setV2State("IDLE");
      }
    }
    gs().log("info", `[export lifecycle] export.failed post-transition: v2State=${gs().v2State}`);
  }));

  subs.push(api.export.onCancelled((raw) => {
    const ev = raw as { export_id?: string; stage?: string; partial_bytes?: number };
    gs().log("info", `[export lifecycle] export.cancelled received: export_id=${ev.export_id ?? "?"} stage=${ev.stage ?? "?"} partial_bytes=${ev.partial_bytes ?? "?"} v2State=${gs().v2State} v2ExportId=${gs().v2ExportId ?? "null"}`);
    if (_isStaleExport(ev.export_id)) return;
    gs().log(
      "info",
      `[export lifecycle] stale-guard accept: event export_id=${ev.export_id ?? "undef"} active=${gs().v2ExportId ?? "null"} verdict=accept`,
    );
    gs().setV2ExportProgress(null);
    gs().setV2ExportId(null);
    _releaseCurrentSnapshot();
    if (gs().v2State === "EXPORTING") {
      if (gs().v2SessionId !== null) {
        _enterRecording();
      } else {
        gs().setV2State("IDLE");
      }
    }
    gs().log("info", `[export lifecycle] export.cancelled post-transition: v2State=${gs().v2State}`);
  }));

  gs().log(
    "info",
    `[export lifecycle] engine subscriptions registered: subs=${subs.length} v2State=${gs().v2State}`,
  );

  // ── Reconcile: catch ready replay that fired before subscriptions ───────
  void api.engine.version().then(
    (info) => _applyEngineReady(info),
    () => {},
  );

  return () => {
    gs().log(
      "info",
      `[export lifecycle] engine subscriptions torn down: v2State=${gs().v2State} v2ExportId=${gs().v2ExportId ?? "null"} v2SnapshotId=${gs().v2SnapshotId ?? "null"}`,
    );
    subs.forEach((u) => u());
  };
}

async function _startExport(snapshotId: string): Promise<void> {
  gs().log("info", `[export lifecycle] _startExport RPC call: snapshotId=${snapshotId} v2State=${gs().v2State}`);
  try {
    const result = await window.coveApi.replay.exportStart({
      snapshot: { snapshot_id: snapshotId },
      options: { max_compat: false, audio_mode: "default" },
    }) as { export_id?: string } | undefined;
    gs().log("info", `[export lifecycle] _startExport RPC result: export_id=${result?.export_id ?? "null"} v2State=${gs().v2State} v2SnapshotId=${gs().v2SnapshotId ?? "null"}`);
    // Only store the export_id if the export is still active — a fast terminal
    // event may have already cleared the export and transitioned state.
    if (result?.export_id && gs().v2State === "EXPORTING" && gs().v2SnapshotId === snapshotId) {
      gs().setV2ExportId(result.export_id);
      gs().log(
        "info",
        `[export lifecycle] _startExport export_id stored: export_id=${result.export_id} stored=true`,
      );
    } else if (result?.export_id) {
      gs().log(
        "info",
        `[export lifecycle] _startExport export_id NOT stored: export_id=${result.export_id} v2State=${gs().v2State} v2SnapshotId=${gs().v2SnapshotId ?? "null"} expected=${snapshotId} stored=false`,
      );
    }
  } catch (err) {
    gs().log("info", `[export lifecycle] _startExport RPC error: ${err instanceof Error ? err.message : String(err)} v2State=${gs().v2State}`);
    gs().setV2ExportId(null);
    gs().setV2ExportProgress(null);
    _releaseCurrentSnapshot();
    if (gs().v2State === "EXPORTING") {
      if (gs().v2SessionId !== null) {
        _enterRecording();
      } else {
        gs().setV2State("IDLE");
      }
    }
  }
}

export async function saveReplay(durationSeconds: number): Promise<void> {
  if (gs().v2State !== "RECORDING") return;
  gs().setV2State("SAVING");
  try {
    const result = await window.coveApi.replay.save({ duration_s: durationSeconds }) as { snapshot_id?: string } | undefined;
    // Use RPC response as authoritative fallback — if onSnapshotPinned already
    // fired, the state is already EXPORTING and the guard below is a no-op.
    if (result?.snapshot_id && gs().v2State === "SAVING") {
      gs().setV2SnapshotId(result.snapshot_id);
      gs().setV2SnapshotHeld(true);
      gs().setV2State("EXPORTING");
      void _startExport(result.snapshot_id);
    }
  } catch {
    if (gs().v2State === "SAVING") {
      _enterRecording();
    }
  }
}

export async function discardRecovery(sessionId: string): Promise<void> {
  if (gs().v2State !== "RECOVERY_AVAILABLE") return;
  await window.coveApi.replay.discardRecoveredSession({ session_id: sessionId });
  await _refreshRecoverableSessions();
}

export async function restoreRecovery(sessionId: string): Promise<void> {
  if (gs().v2State !== "RECOVERY_AVAILABLE") return;
  gs().setV2State("SAVING");
  try {
    const result = await window.coveApi.replay.restoreRecoveredSession({ session_id: sessionId }) as { snapshot_id?: string } | undefined;
    gs().setV2RecoverableSessions(null);
    if (result?.snapshot_id && gs().v2State === "SAVING") {
      gs().setV2SnapshotId(result.snapshot_id);
      gs().setV2SnapshotHeld(true);
      gs().setV2State("EXPORTING");
      void _startExport(result.snapshot_id);
    }
  } catch {
    await _refreshRecoverableSessions();
  }
}

// Default helper capture options used when the operator clicks Start replay
// buffer without overriding parameters. Mirrors the smoke matrix baseline.
const DEFAULT_REQUEST_SESSION_OPTS = {
  mode: "monitor",
  cursor_mode: "embedded",
  framerate_hint: 60,
  persist: "transient",
} as const;

// Module-level in-flight guard against concurrent helper start RPCs (e.g.
// double-click on the Start button while requestSession/startStream are still
// negotiating, or while the helper has accepted the stream but hasn't yet
// emitted capture.sessionReady). Belt-and-suspenders alongside any caller-side
// latch.
let _captureStartInFlight = false;

// Safety cap on how long startCapture's post-startStream wait may block
// before the in-flight latch self-releases. Matches the validation contract's
// 30 s sessionReady budget so a slow-but-still-valid helper startup doesn't
// re-enable the Start button mid-handshake. Bounded so a stuck helper can't
// permanently disable the Start button either.
const _CAPTURE_START_READY_TIMEOUT_MS = 30_000;

// Block until the v2 FSM transitions away from IDLE (driven by the existing
// capture.onSessionReady subscriber → _enterRecording) or the safety timeout
// fires. Returns true if the helper became ready in time, false if the
// timeout elapsed first. Resolves immediately with true if v2State is
// already non-IDLE on entry.
async function _waitForCaptureStateLeavesIdle(): Promise<boolean> {
  if (gs().v2State !== "IDLE") return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (becameReady: boolean) => {
      if (settled) return;
      settled = true;
      unsub();
      clearTimeout(timer);
      resolve(becameReady);
    };
    const unsub = useStore.subscribe((s, prev) => {
      if (s.v2State !== prev.v2State && s.v2State !== "IDLE") finish(true);
    });
    const timer = setTimeout(() => finish(false), _CAPTURE_START_READY_TIMEOUT_MS);
  });
}

// Operator-facing wrapper for the v2 helper capture path. Never sets v2State
// directly — RECORDING is reached only when capture.onSessionReady fires and
// the existing subscriber calls _enterRecording().
export async function startCapture(opts?: Record<string, unknown>): Promise<void> {
  if (_captureStartInFlight) return;
  _captureStartInFlight = true;
  try {
    const api = window.coveApi;
    const sessionOpts = opts ?? DEFAULT_REQUEST_SESSION_OPTS;
    try {
      await api.capture.requestSession(sessionOpts);
    } catch (err) {
      gs().log("error", `v2 capture: requestSession failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      await api.capture.startStream({});
    } catch (err) {
      gs().log("error", `v2 capture: startStream failed: ${err instanceof Error ? err.message : String(err)}`);
      try {
        await api.capture.stopSession({});
      } catch {
        // Defensive: helper may have already torn down the session.
      }
      return;
    }
    // Hold the in-flight latch through the post-startStream → onSessionReady
    // gap so a fast second click cannot dispatch a duplicate requestSession
    // against an already-active helper session. The safety timeout matches
    // the validation contract's sessionReady budget — if it fires, treat the
    // start as a terminal failure and defensively tear down the helper
    // session before releasing the latch so we don't leak an orphan session.
    const becameReady = await _waitForCaptureStateLeavesIdle();
    if (!becameReady) {
      gs().log("error", `v2 capture: sessionReady not received within ${_CAPTURE_START_READY_TIMEOUT_MS}ms; tearing down helper session.`);
      try {
        await window.coveApi.capture.stopSession({});
      } catch {
        // Defensive: helper may already have torn down.
      }
    }
  } finally {
    _captureStartInFlight = false;
  }
}

export async function stopCapture(): Promise<void> {
  try {
    await window.coveApi.capture.stopSession({});
  } catch (err) {
    gs().log("warn", `v2 capture: stopSession failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Refresh the recoverable sessions list from the helper and update FSM state.
// Falls back to IDLE when no sessions remain; onSnapshotPinned drives further transitions.
async function _refreshRecoverableSessions(): Promise<void> {
  try {
    const result = await window.coveApi.replay.recoverableSessions() as { sessions?: unknown[] };
    const sessions = (result?.sessions ?? []) as never[];
    gs().setV2RecoverableSessions(sessions.length > 0 ? sessions : null);
    if (sessions.length > 0) {
      const cur = gs().v2State;
      // Operator opted out of the recovery prompt for this renderer session.
      // Keep the recoverable list visible to other surfaces but don't gate
      // the Start replay buffer button by entering RECOVERY_AVAILABLE — still
      // normalize boot / down / unavailable / saving back to IDLE so a helper
      // restart after an in-session Ignore doesn't leave Start disabled.
      if (gs().v2RecoveryIgnoredForSession) {
        if (cur === "SAVING" || cur === "BOOTING" || cur === "ENGINE_DOWN" || cur === "ENGINE_UNAVAILABLE") {
          gs().setV2State("IDLE");
        }
        return;
      }
      if (cur === "IDLE" || cur === "SAVING" || cur === "BOOTING" || cur === "ENGINE_DOWN" || cur === "ENGINE_UNAVAILABLE") {
        gs().setV2State("RECOVERY_AVAILABLE");
      }
    } else {
      const cur = gs().v2State;
      if (cur === "RECOVERY_AVAILABLE" || cur === "SAVING" || cur === "BOOTING" || cur === "ENGINE_DOWN" || cur === "ENGINE_UNAVAILABLE") {
        gs().setV2State("IDLE");
      }
    }
  } catch {
    gs().setV2RecoverableSessions(null);
    const cur = gs().v2State;
    // Do not overwrite ENGINE_DOWN or ENGINE_UNAVAILABLE — those are driven
    // by engine lifecycle events, not by a recovery query failure.
    if (cur === "RECOVERY_AVAILABLE" || cur === "SAVING" || cur === "BOOTING") {
      gs().setV2State("IDLE");
    }
  }
}

// Operator opted out of the recovery prompt for this renderer session only.
// Does NOT touch helper recovery data; the banner reappears on next app start
// while sessions still exist on disk.
export function ignoreRecoveryForSession(): void {
  const count = gs().v2RecoverableSessions?.length ?? 0;
  gs().setV2RecoveryIgnoredForSession(true);
  gs().setV2State("IDLE");
  gs().log("info", `recovery.ignored count=${count}`);
}

// Discard every recoverable session via the existing per-session discardRecovery
// path. Two-click confirmation is the caller's responsibility (RecoveryBanner).
export async function discardAllRecoverable(): Promise<void> {
  if (gs().v2State !== "RECOVERY_AVAILABLE") return;
  const sessions = (gs().v2RecoverableSessions ?? []).slice();
  gs().log("info", `recovery.discardedAll count=${sessions.length}`);
  for (const s of sessions) {
    try {
      await discardRecovery(s.session_id);
    } catch (err) {
      gs().log("warn", `recovery.discardedAll: discard failed for ${s.session_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await _refreshRecoverableSessions();
}
