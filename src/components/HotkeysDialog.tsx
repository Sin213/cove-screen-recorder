import { useEffect, useState } from "react";
import { DEFAULT_HOTKEY_BINDINGS, type HotkeyBindings } from "../store";

interface Props {
  initial: HotkeyBindings;
  onSave: (next: HotkeyBindings) => void;
  onCancel: () => void;
}

type SlotId = keyof HotkeyBindings;

const SLOTS: { id: SlotId; label: string; hint: string }[] = [
  { id: "toggle", label: "Toggle recording", hint: "Starts/stops the highlighted Crop / Screen / Window action" },
  { id: "gif",    label: "Crop & capture GIF", hint: "Opens crop selection and uses the GIF preset" },
];

export function HotkeysDialog({ initial, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<HotkeyBindings>(initial);
  const [recording, setRecording] = useState<SlotId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setRecording(null); return; }
      const combo = comboFromEvent(e);
      if (!combo) return;
      if (!/(Ctrl|Shift|Alt|Super|Cmd)/i.test(combo)) {
        setError("Pick a combo with a modifier (Ctrl, Shift, Alt, or Super).");
        return;
      }
      setError(null);
      setDraft((d) => ({ ...d, [recording]: combo }));
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal">
        <div className="modal-head">
          <h3>Customize hotkeys</h3>
          <span className="mono" style={{ color: "var(--text-faint)", fontSize: 11 }}>click a binding to rebind</span>
          <div className="spacer" />
          <button className="icon-btn" onClick={onCancel} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {SLOTS.map((slot) => {
            const parts = (draft[slot.id] || "").split("+").filter(Boolean);
            const isEditing = recording === slot.id;
            return (
              <div key={slot.id} className="hotkey-row">
                <div className="name">
                  <b>{slot.label}</b>
                  <span style={{ color: "var(--text-faint)" }}>{slot.hint}</span>
                </div>
                <div
                  className="keys"
                  onClick={() => setRecording(isEditing ? null : slot.id)}
                  style={{ cursor: "pointer" }}
                >
                  {isEditing ? (
                    <kbd className="editing">press keys…</kbd>
                  ) : (
                    parts.map((k, i) => (
                      <span key={i} style={{ display: "inline-flex", gap: 4 }}>
                        {i > 0 && <span className="plus">+</span>}
                        <kbd>{k}</kbd>
                      </span>
                    ))
                  )}
                </div>
              </div>
            );
          })}
          <div className="hotkey-row" style={{ opacity: 0.6 }}>
            <div className="name"><b>Stop recording</b><span style={{ color: "var(--text-faint)" }}>built-in, not customisable</span></div>
            <div className="keys"><kbd>Esc</kbd></div>
          </div>

          {error && (
            <div style={{ padding: 10, borderRadius: 8, background: "var(--rec-soft)", border: "1px solid var(--rec-ring)", color: "var(--rec)", fontSize: 12 }}>
              {error}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost btn-sm" onClick={() => setDraft(DEFAULT_HOTKEY_BINDINGS)}>Reset</button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
          <button className="btn btn-record btn-sm" onClick={() => onSave(draft)} disabled={!!recording}>Save</button>
        </div>
      </div>
    </div>
  );
}

function comboFromEvent(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");
  const main = mainKeyName(e);
  if (!main) return null;
  parts.push(main);
  return parts.join("+");
}

function mainKeyName(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === "Control" || k === "Alt" || k === "Shift" || k === "Meta" || k === "OS") return null;
  if (k === " ") return "Space";
  if (k.length === 1) return k.toUpperCase();
  if (/^F\d{1,2}$/.test(k)) return k;
  if (/^Arrow/.test(k)) return k.replace("Arrow", "");
  return k.charAt(0).toUpperCase() + k.slice(1);
}
