// V2 diagnostics surface — engine status, restart, bundle, recovery.
import { useState } from "react";
import { useStore } from "../store";
import type { V2RecoverableSession } from "./fsm";
import {
  discardAllRecoverable,
  discardRecovery,
  ignoreRecoveryForSession,
  restoreRecovery,
} from "./engine";

function formatBytes(b: number): string {

  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, "0")}`;
}

function RecoveryBanner({ sessions }: { sessions: V2RecoverableSession[] }) {
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  return (
    <div className="v2-recovery-banner">
      <div className="v2-recovery-title">Unsaved recordings found</div>
      {sessions.map((s) => (
        <div key={s.session_id} className="v2-recovery-row">
          <span className="v2-recovery-meta">
            {formatDuration(s.duration_s)} · {formatBytes(s.bytes_on_disk)}
          </span>
          <button
            className="btn btn-record btn-sm"
            onClick={() => void restoreRecovery(s.session_id)}
          >
            Save
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void discardRecovery(s.session_id)}
          >
            Discard
          </button>
        </div>
      ))}
      <div className="v2-recovery-footer">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => ignoreRecoveryForSession()}
        >
          Ignore for this session
        </button>
        {confirmDiscardAll ? (
          <div className="v2-recovery-confirm">
            <span className="v2-recovery-meta">
              Discard {sessions.length} unsaved recording{sessions.length === 1 ? "" : "s"}?
            </span>
            <button
              className="btn btn-record btn-sm"
              onClick={() => {
                void discardAllRecoverable();
                setConfirmDiscardAll(false);
              }}
            >
              Confirm discard all
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirmDiscardAll(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setConfirmDiscardAll(true)}
          >
            Discard all ({sessions.length})
          </button>
        )}
      </div>
    </div>
  );
}

export function Diagnostics() {
  const v2State = useStore((s) => s.v2State);
  const v2EngineInfo = useStore((s) => s.v2EngineInfo);
  const v2ExportProgress = useStore((s) => s.v2ExportProgress);
  const v2RecoverableSessions = useStore((s) => s.v2RecoverableSessions);

  const isDown = v2State === "ENGINE_DOWN" || v2State === "ENGINE_UNAVAILABLE";
  const isExporting = v2State === "EXPORTING";
  const isRecovery = v2State === "RECOVERY_AVAILABLE";

  if (!isDown && !isExporting && !isRecovery && v2State === "BOOTING") {
    return null;
  }

  return (
    <div className="v2-diagnostics">
      {isDown && (
        <div className="v2-banner v2-banner--error">
          <span>
            {v2State === "ENGINE_DOWN" ? "Engine crashed" : "Engine unavailable"}
            {v2EngineInfo ? ` (v${v2EngineInfo.helperVersion})` : ""}
          </span>
          <div className="v2-banner-actions">
            <button
              className="btn btn-outline btn-sm"
              onClick={() => void window.coveApi.engine.restart()}
            >
              Restart engine
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void window.coveApi.engine.openDiagnosticsBundle()}
            >
              Diagnostics…
            </button>
          </div>
        </div>
      )}

      {isExporting && v2ExportProgress !== null && (
        <div className="v2-export-progress">
          <div className="v2-export-label">Exporting replay… {Math.round(v2ExportProgress)}%</div>
          <div className="v2-export-bar">
            <div
              className="v2-export-fill"
              style={{ width: `${v2ExportProgress}%` }}
            />
          </div>
        </div>
      )}

      {isRecovery && v2RecoverableSessions && v2RecoverableSessions.length > 0 && (
        <RecoveryBanner sessions={v2RecoverableSessions} />
      )}
    </div>
  );
}
