import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryEntry } from "../../electron/types";
import { useStore } from "../store";

const MAX_THUMB_CONCURRENT = 3;

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function extLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : "FILE";
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M11 5V3a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4a1 1 0 0 1 1-1h3.586a1 1 0 0 1 .707.293L8 4h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4z" stroke="currentColor" strokeWidth="1.5"/>
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="11" stroke="currentColor" strokeWidth="1.5" opacity="0.4"/>
      <path d="M10 8.5l6 3.5-6 3.5V8.5z" fill="currentColor"/>
    </svg>
  );
}

interface CardProps {
  entry: LibraryEntry;
  thumbDataUrl: string | null;
  onVisible: (path: string) => void;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
}

function RecordingCard({ entry, thumbDataUrl, onVisible, scrollRoot }: CardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "ok" | "err">("idle");
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (ioEntries) => {
        if (ioEntries[0]?.isIntersecting) {
          onVisible(entry.path);
          observer.disconnect();
        }
      },
      { root: scrollRoot.current, rootMargin: "100px", threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [entry.path, onVisible, scrollRoot]);

  function handleOpen() {
    void window.cove.openFile(entry.path);
  }

  function handleReveal() {
    void window.cove.revealInFolder(entry.path);
  }

  function handleCopy() {
    navigator.clipboard.writeText(entry.path).then(
      () => {
        setCopyStatus("ok");
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopyStatus("idle"), 1800);
      },
      () => {
        setCopyStatus("err");
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopyStatus("idle"), 2000);
      },
    );
  }

  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

  return (
    <div className="gallery-card" ref={cardRef}>
      <button
        className="gallery-card-thumb"
        onClick={handleOpen}
        title={`Open ${entry.name}`}
        aria-label={`Open ${entry.name}`}
      >
        {thumbDataUrl && (
          <img src={thumbDataUrl} alt="" aria-hidden="true" draggable={false} />
        )}
        {!thumbDataUrl && <span className="gallery-card-ext">{extLabel(entry.name)}</span>}
        <span className="gallery-card-play"><PlayIcon /></span>
      </button>

      <div className="gallery-card-meta">
        <span className="gallery-card-name" title={entry.name}>{entry.name}</span>
        <span className="gallery-card-info">{fmtDate(entry.modified)} · {fmtBytes(entry.bytes)}</span>
      </div>

      <div className="gallery-card-actions" role="group" aria-label={`Actions for ${entry.name}`}>
        <button className="gallery-action-btn" onClick={handleReveal} title="Open containing folder">
          <FolderIcon />
        </button>
        <button
          className={`gallery-action-btn${copyStatus === "ok" ? " gallery-action-copied" : copyStatus === "err" ? " gallery-action-copy-err" : ""}`}
          onClick={handleCopy}
          title={copyStatus === "ok" ? "Copied!" : copyStatus === "err" ? "Copy failed" : "Copy path"}
          aria-label="Copy path to clipboard"
        >
          <CopyIcon />
          {copyStatus !== "idle" && (
            <span className="gallery-action-toast">
              {copyStatus === "ok" ? "Copied" : "Failed"}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}

export function Gallery() {
  const outputDir = useStore((s) => s.outputDir);
  const lastOutputPath = useStore((s) => s.lastOutputPath);
  const v2ExportOutputPath = useStore((s) => s.v2ExportOutputPath);
  const status = useStore((s) => s.status);

  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // Thumbnail queue state in refs (no re-render needed for bookkeeping)
  const requestedRef = useRef(new Set<string>());
  const pendingRef = useRef(0);
  const queueRef = useRef<string[]>([]);
  const genRef = useRef(0);  // incremented on each new listing to invalidate stale requests
  const aliveRef = useRef(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Fetch listings; reset thumbnail state for each new listing
  useEffect(() => {
    let alive = true;
    setEntries(null);
    genRef.current++;
    requestedRef.current = new Set();
    // Do not reset pendingRef — stale in-flight requests still own those slots
    // and will decrement the counter themselves when they complete.
    queueRef.current = [];
    setThumbs({});
    window.cove.listRecordings(outputDir, 30).then(
      (list) => { if (alive) setEntries(list); },
      () => { if (alive) setEntries([]); },
    );
    return () => { alive = false; };
  }, [outputDir, lastOutputPath, v2ExportOutputPath, status]);

  // Drain the thumbnail queue, bounded to MAX_THUMB_CONCURRENT concurrent requests
  const processQueue = useCallback(() => {
    while (pendingRef.current < MAX_THUMB_CONCURRENT && queueRef.current.length > 0) {
      const p = queueRef.current.shift()!;
      const gen = genRef.current;
      pendingRef.current++;
      window.cove.getThumbnail(p).then(
        (url) => {
          pendingRef.current--;
          if (aliveRef.current && url && genRef.current === gen) {
            setThumbs((prev) => ({ ...prev, [p]: url }));
          }
          // Always drain queue — even stale completions free a slot for current-gen work
          if (aliveRef.current) processQueue();
        },
        () => {
          pendingRef.current--;
          if (aliveRef.current) processQueue();
        },
      );
    }
  }, []); // stable: all accessed values are refs or stable React setters

  const onCardVisible = useCallback((path: string) => {
    if (requestedRef.current.has(path)) return;
    requestedRef.current.add(path);
    queueRef.current.push(path);
    processQueue();
  }, [processQueue]);

  function handleOpenFolder() {
    if (outputDir) void window.cove.openFolder(outputDir);
  }

  return (
    <div className="gallery">
      <div className="gallery-header">
        <span className="gallery-title">Recent Recordings</span>
        {outputDir && (
          <button className="gallery-folder-btn" onClick={handleOpenFolder} title="Open recordings folder">
            Open folder
          </button>
        )}
      </div>

      <div className="gallery-body" ref={bodyRef}>
        {entries === null ? (
          <div className="gallery-empty"><span className="gallery-loading-dot" />Loading…</div>
        ) : entries.length === 0 ? (
          <div className="gallery-empty">No recordings yet</div>
        ) : (
          <div className="gallery-grid">
            {entries.map((e) => (
              <RecordingCard
                key={e.path}
                entry={e}
                thumbDataUrl={thumbs[e.path] ?? null}
                onVisible={onCardVisible}
                scrollRoot={bodyRef}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
