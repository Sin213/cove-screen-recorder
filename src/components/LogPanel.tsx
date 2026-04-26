import { useEffect, useRef } from "react";
import { useStore } from "../store";

export function LogPanel() {
  const logs = useStore((s) => s.logs);
  const clearLogs = useStore((s) => s.clearLogs);
  const collapsed = useStore((s) => s.logCollapsed);
  const setCollapsed = useStore((s) => s.setLogCollapsed);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (collapsed) return;
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs, collapsed]);

  if (logs.length === 0) return null;

  const copyAll = () => {
    const text = logs.map((l) => `${fmt(l.ts)}  ${l.level.toUpperCase().padEnd(5)}  ${l.text}`).join("\n");
    void navigator.clipboard.writeText(text);
  };

  return (
    <div
      className={`card mx-9 mb-3 flex flex-col overflow-hidden ${collapsed ? "" : "max-h-[160px]"}`}
      style={{ padding: 0 }}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 no-drag">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1.5 rounded-md px-1 py-0.5 font-mono text-[10px] uppercase tracking-[0.6px] text-text-3 hover:text-text"
          title={collapsed ? "Expand log" : "Collapse log"}
          aria-expanded={!collapsed}
        >
          <ChevronIcon collapsed={collapsed} />
          <span>Log · {logs.length}</span>
          {collapsed && lastError(logs) && (
            <span className="ml-1 text-[10px] normal-case tracking-normal text-danger">
              · {lastError(logs)?.slice(0, 60)}
            </span>
          )}
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyAll}
            className="rounded-md px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.5px] text-text-3 hover:bg-panel-hi hover:text-text"
            title="Copy log to clipboard"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={clearLogs}
            className="rounded-md px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.5px] text-text-3 hover:bg-panel-hi hover:text-text"
            title="Clear log"
          >
            Clear
          </button>
        </div>
      </div>
      {!collapsed && (
        <div ref={ref} className="overflow-y-auto px-3 py-2 selectable">
          {logs.map((l) => (
            <div key={l.id} className="log-line">
              <span className="text-text-3">{fmt(l.ts)}</span>{" "}
              <span className={`level-${l.level}`}>{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0)", transition: "transform 120ms" }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function lastError(logs: { level: string; text: string }[]): string | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].level === "error" || logs[i].level === "warn") return logs[i].text;
  }
  return null;
}

function fmt(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
