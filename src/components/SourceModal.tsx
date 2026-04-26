import { useEffect, useState } from "react";
import type { CaptureMode, CaptureSource } from "../types";

interface Props {
  mode: CaptureMode;
  onPick: (source: CaptureSource) => void;
  onCancel: () => void;
}

export function SourceModal({ mode, onPick, onCancel }: Props) {
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const kind = mode === "window" ? "window" : "screen";
    window.cove
      .listSources(kind)
      .then((list) => { if (!cancelled) setSources(list); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const title = mode === "window" ? "Pick a window" : "Pick a screen";

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal" style={{ width: "min(720px, 100%)", maxHeight: "84vh" }}>
        <div className="modal-head">
          <h3>{title}</h3>
          {sources && (
            <span className="mono" style={{ color: "var(--text-faint)", fontSize: 11 }}>
              · {sources.length} {sources.length === 1 ? "source" : "sources"}
            </span>
          )}
          <div className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        </div>

        <div className="modal-body">
          {error && (
            <div className="section" style={{ borderColor: "var(--rec-ring)", background: "var(--rec-soft)", color: "var(--rec)" }}>
              Failed to list sources: {error}
            </div>
          )}
          {!error && !sources && (
            <div style={{ padding: "32px 0", textAlign: "center", color: "var(--text-faint)" }}>Loading sources…</div>
          )}
          {sources && sources.length === 0 && (
            <div style={{ padding: "32px 12px", textAlign: "center", color: "var(--text-faint)", fontSize: 12 }}>
              No sources available.
            </div>
          )}
          {sources && sources.length > 0 && (
            <div className="source-modal-grid">
              {sources.map((s) => (
                <button
                  key={s.id}
                  onClick={() => onPick(s)}
                  className="source-modal-tile"
                  title={`Record ${s.name}`}
                >
                  <img src={s.thumbnailDataUrl} alt="" />
                  <div className="name">
                    {s.appIconDataUrl && <img src={s.appIconDataUrl} alt="" />}
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                  </div>
                  <span className="kind">{s.kind}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
