import { useStore } from "../store";

export function OutputPicker() {
  const outputDir = useStore((s) => s.outputDir);
  const setOutputDir = useStore((s) => s.setOutputDir);
  const lastOutput = useStore((s) => s.lastOutputPath);
  const recording = useStore((s) => s.status !== "idle");

  const onPick = async () => {
    const dir = await window.cove.pickOutputDir();
    if (dir) setOutputDir(dir);
  };

  const effective = outputDir ?? (lastOutput ? dirname(lastOutput) : null);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="field-label">Output folder</span>
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-1.5">
        <input
          value={outputDir ?? ""}
          onChange={(e) => setOutputDir(e.target.value || null)}
          placeholder="~/Videos/Cove Recordings (default)"
          spellCheck={false}
          disabled={recording}
          className="folder-input"
        />
        <button
          type="button"
          onClick={onPick}
          disabled={recording}
          className="sq-btn"
          title="Browse for folder"
          aria-label="Browse for folder"
        >
          <FolderIcon />
        </button>
        <button
          type="button"
          onClick={() => effective && window.cove.openFolder(effective)}
          disabled={!effective || recording}
          className="sq-btn"
          title={effective ? `Open ${effective}` : "No folder yet"}
          aria-label="Open output folder"
        >
          <ExternalIcon />
        </button>
        <button
          type="button"
          onClick={() => setOutputDir(null)}
          disabled={!outputDir || recording}
          className="sq-btn"
          title="Reset to default"
          aria-label="Reset output folder"
        >
          <XIcon />
        </button>
      </div>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" />
      <path d="M3 9h18l-2 9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12" />
      <path d="M18 6l-12 12" />
    </svg>
  );
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : ".";
}
