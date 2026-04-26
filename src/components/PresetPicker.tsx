import { useStore } from "../store";
import { PRESET_LIST } from "../presets";

export function PresetPicker() {
  const preset = useStore((s) => s.preset);
  const setPreset = useStore((s) => s.setPreset);
  const recording = useStore((s) => s.status !== "idle");

  const current = PRESET_LIST.find((p) => p.id === preset) ?? PRESET_LIST[0];

  return (
    <div className="flex flex-col gap-1.5">
      <span className="field-label">Preset</span>
      <div className="flex items-center gap-2.5">
        <div className="segmented">
          {PRESET_LIST.map((p) => (
            <button
              key={p.id}
              disabled={recording}
              onClick={() => setPreset(p.id)}
              title={p.hint}
              className={preset === p.id ? "active" : ""}
            >
              {p.name}
            </button>
          ))}
        </div>
        <span className="font-mono text-[11px] text-text-3">{current.hint}</span>
      </div>
    </div>
  );
}
