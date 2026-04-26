export function Titlebar() {
  return (
    <div className="titlebar-drag flex h-[34px] items-center justify-between border-b border-border bg-bg px-3">
      <div className="flex items-center gap-2.5">
        <img
          src="./cove_icon.png"
          alt=""
          className="h-[22px] w-[22px] object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]"
          draggable={false}
        />
        <span className="font-mono text-[11.5px] font-semibold tracking-wider text-text-2">
          Cove Screen Recorder
        </span>
        <span className="font-mono text-[10px] text-text-3">v{__APP_VERSION__}</span>
      </div>
      <div className="no-drag flex items-center">
        <button
          className="win-ctrl"
          onClick={() => window.cove.windowMinimize()}
          title="Minimize"
          aria-label="Minimize"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <button
          className="win-ctrl"
          onClick={() => window.cove.windowToggleMaximize()}
          title="Maximize"
          aria-label="Maximize"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1.2" fill="none" /></svg>
        </button>
        <button
          className="win-ctrl win-ctrl-close"
          onClick={() => window.cove.windowClose()}
          title="Close"
          aria-label="Close"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>
    </div>
  );
}
