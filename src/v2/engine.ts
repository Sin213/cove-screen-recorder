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
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 150 * attempt));
    try {
      await window.coveApi.replay.snapshotRelease({ snapshot_id: id });
      return;
    } catch {
      // retry
    }
  }
}

export function initV2Engine(): Unsub {
  const api = window.coveApi;
  const subs: Unsub[] = [];

  // ── Engine lifecycle ──────────────────────────────────────────────────────

  subs.push(api.engine.onReady(async (info) => {
    gs().setV2EngineInfo(info as { helperVersion: string; protocolVersion: number });
    const cur = gs().v2State;
    if (cur === "BOOTING" || cur === "ENGINE_DOWN" || cur === "ENGINE_UNAVAILABLE") {
      // Query helper for recoverable sessions — the push notification may have
      // fired before initV2Engine() subscribed, so we poll on every ready event.
      await _refreshRecoverableSessions();
    }
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
    return !!(eventId && active && eventId !== active);
  }

  subs.push(api.export.onProgress((raw) => {
    const ev = raw as { export_id?: string; pct: number };
    if (_isStaleExport(ev.export_id)) return;
    gs().setV2ExportProgress(ev.pct);
  }));

  subs.push(api.export.onCompleted((raw) => {
    const ev = raw as { export_id?: string; final_path?: string };
    if (_isStaleExport(ev.export_id)) return;
    gs().setV2ExportOutputPath(ev.final_path ?? null);
    gs().setV2ExportProgress(null);
    gs().setV2ExportId(null);
    _releaseCurrentSnapshot();
    if (gs().v2SessionId !== null) {
      _enterRecording();
    } else {
      gs().setV2State("IDLE");
    }
  }));

  subs.push(api.export.onFailed((raw) => {
    const ev = raw as { export_id?: string };
    if (_isStaleExport(ev.export_id)) return;
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
  }));

  subs.push(api.export.onCancelled((raw) => {
    const ev = raw as { export_id?: string };
    if (_isStaleExport(ev.export_id)) return;
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
  }));

  return () => subs.forEach((u) => u());
}

async function _startExport(snapshotId: string): Promise<void> {
  try {
    const result = await window.coveApi.replay.exportStart({
      snapshot: { snapshot_id: snapshotId },
      options: { max_compat: false, audio_mode: "default" },
    }) as { export_id?: string } | undefined;
    // Only store the export_id if the export is still active — a fast terminal
    // event may have already cleared the export and transitioned state.
    if (result?.export_id && gs().v2State === "EXPORTING" && gs().v2SnapshotId === snapshotId) {
      gs().setV2ExportId(result.export_id);
    }
  } catch {
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

// Refresh the recoverable sessions list from the helper and update FSM state.
// Falls back to IDLE when no sessions remain; onSnapshotPinned drives further transitions.
async function _refreshRecoverableSessions(): Promise<void> {
  try {
    const result = await window.coveApi.replay.recoverableSessions() as { sessions?: unknown[] };
    const sessions = (result?.sessions ?? []) as never[];
    gs().setV2RecoverableSessions(sessions.length > 0 ? sessions : null);
    if (sessions.length > 0) {
      const cur = gs().v2State;
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
