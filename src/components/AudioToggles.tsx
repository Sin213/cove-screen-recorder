import { useStore } from "../store";

export function AudioToggles() {
  const withMic = useStore((s) => s.withMic);
  const setMic = useStore((s) => s.setMic);
  const withSys = useStore((s) => s.withSystemAudio);
  const setSys = useStore((s) => s.setSystemAudio);
  const hotkeys = useStore((s) => s.hotkeysEnabled);
  const setHotkeys = useStore((s) => s.setHotkeys);
  const recording = useStore((s) => s.status !== "idle");

  return (
    <div className="flex flex-col gap-1.5">
      <span className="field-label">Audio &amp; hotkeys</span>
      <div className="flex flex-wrap items-center gap-2">
        <Toggle
          label="Microphone"
          checked={withMic}
          disabled={recording}
          onChange={setMic}
        />
        <Toggle
          label="System audio"
          checked={withSys}
          disabled={recording}
          onChange={setSys}
          title="Capture audio from the picked source (Linux: needs PipeWire portal support)"
        />
        <Toggle
          label="Global hotkeys"
          checked={hotkeys}
          disabled={recording}
          onChange={setHotkeys}
          title="Ctrl+Shift+R to toggle, Ctrl+Shift+G for GIF"
        />
      </div>
    </div>
  );
}

interface ToggleProps {
  label: string;
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (v: boolean) => void;
}

function Toggle({ label, checked, disabled, title, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      title={title}
      className={`btn ${checked ? "btn-primary" : ""}`}
      style={{ paddingLeft: 12, paddingRight: 14 }}
    >
      <span
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border"
        style={{
          borderColor: checked ? "rgb(var(--accent-ink))" : "rgb(var(--border-hi))",
          background: checked ? "rgb(var(--accent-ink))" : "transparent",
        }}
      >
        {checked && (
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
            <path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      {label}
    </button>
  );
}
