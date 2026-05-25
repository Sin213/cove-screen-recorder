// V2 diagnostics surface — engine status, export progress.
import { useStore } from "../store";

export function Diagnostics() {
  const v2State = useStore((s) => s.v2State);
  const v2EngineInfo = useStore((s) => s.v2EngineInfo);
  const v2ExportProgress = useStore((s) => s.v2ExportProgress);

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
