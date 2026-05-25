// V2 diagnostics surface — engine status, export progress.
import { useStore } from "../store";

export function Diagnostics() {
  const v2State = useStore((s) => s.v2State);
  const v2EngineInfo = useStore((s) => s.v2EngineInfo);
  const v2ExportProgress = useStore((s) => s.v2ExportProgress);
  const v2BlockReason = useStore((s) => s.v2BlockReason);

  const isBlocked =
    v2BlockReason?.code === "sha256-mismatch" ||
    v2BlockReason?.code === "protocol-mismatch" ||
    v2BlockReason?.code === "missing-dependency";

  if (isBlocked) {
    const { code, detail } = v2BlockReason!;

    const title =
      code === "sha256-mismatch"
        ? "Helper integrity check failed"
        : code === "protocol-mismatch"
        ? "Helper protocol mismatch"
        : detail === "pipewire"
        ? "PipeWire not installed"
        : "xdg-desktop-portal not installed";

    const body =
      code === "sha256-mismatch"
        ? "The helper binary has been modified or corrupted. Please reinstall Cove."
        : code === "protocol-mismatch"
        ? "The installed helper version is incompatible with this app. Please reinstall Cove."
        : detail === "pipewire"
        ? "PipeWire is required for screen recording but is not installed. Install pipewire using your package manager."
        : "xdg-desktop-portal is required for screen recording but is not installed. Install xdg-desktop-portal using your package manager.";

    return (
      <div className="modal-backdrop">
        <div className="modal">
          <div className="modal-head">
            <h3>{title}</h3>
          </div>
          <div className="modal-body">
            <p>{body}</p>
          </div>
          <div className="modal-foot">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void window.coveApi.engine.openDiagnosticsBundle()}
            >
              Diagnostics…
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isDown = v2State === "ENGINE_DOWN" || v2State === "ENGINE_UNAVAILABLE";
  const isExporting = v2State === "EXPORTING";

  if (!isDown && !isExporting && v2State === "BOOTING") {
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
    </div>
  );
}
