import { useStore } from "../store";
import type { CaptureMode } from "../types";

const MODES: { value: CaptureMode; label: string; hint: string }[] = [
  { value: "area", label: "Crop", hint: "Hotkey opens the crop selection / system region picker" },
  { value: "screen", label: "Screen", hint: "Hotkey records the full screen" },
  { value: "window", label: "Window", hint: "Hotkey opens the window picker" },
];

export function ModeToggle() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const recording = useStore((s) => s.status !== "idle");

  return (
    <div className="flex flex-col gap-1.5">
      <span className="field-label">Source</span>
      <div className="segmented">
        {MODES.map((m) => (
          <button
            key={m.value}
            disabled={recording}
            onClick={() => setMode(m.value)}
            title={m.hint}
            className={mode === m.value ? "active" : ""}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
