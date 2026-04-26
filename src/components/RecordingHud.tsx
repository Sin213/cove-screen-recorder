import { useStore } from "../store";

interface Props {
  onStop: () => void;
  onCancel: () => void;
}

export function RecordingHud({ onStop, onCancel }: Props) {
  const elapsed = useStore((s) => s.elapsedMs);
  const status = useStore((s) => s.status);
  const preset = useStore((s) => s.preset);

  const finalizing = status === "finalizing";

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-7 px-9 py-10">
      <span className={`status-pill ${finalizing ? "status-pill-running" : "status-pill-recording"}`}>
        <span className="dot" />
        {finalizing ? "Finalizing" : preset === "gif" ? "Recording GIF" : "Recording"}
      </span>

      <div className="timer">{fmt(elapsed)}</div>

      <div className="flex items-center gap-3">
        <button
          onClick={onStop}
          disabled={finalizing}
          className="btn btn-primary"
        >
          <StopIcon /> Stop &amp; save
        </button>
        <button
          onClick={onCancel}
          disabled={finalizing}
          className="btn"
          title="Discard recording"
        >
          Discard
        </button>
      </div>
      <p className="font-mono text-[11px] text-text-3">
        Hotkey: Ctrl + Shift + R · Esc to stop
      </p>
    </div>
  );
}

function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
  );
}

function fmt(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}
