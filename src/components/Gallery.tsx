import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryEntry } from "../../electron/types";
import { useStore } from "../store";
import { VideoPlayer } from "./VideoPlayer";

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

function DeleteIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7l3 3 5-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

interface CardProps {
  entry: LibraryEntry;
  thumbDataUrl: string | null;
  onVisible: (path: string) => void;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  // Multi-select & actions (v3.3.0)
  selected: boolean;
  selectionActive: boolean;
  outputDir: string | null;
  onSelect: (path: string, e: React.MouseEvent) => void;
  onDelete: (path: string) => void;
  onOpen: (path: string) => void;
}

// Cap the error lines in a bulk-failure dialog so a large failed selection
// cannot produce an unreadable alert.
const MAX_ERROR_LINES = 5;

// Display name for an error line. Handles both separators so a Windows path
// reports "clip.mp4" rather than the whole path.
function fileNameOf(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

function RecordingCard({ entry, thumbDataUrl, onVisible, scrollRoot, selected, selectionActive, outputDir, onSelect, onDelete, onOpen }: CardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "ok" | "err">("idle");
  const [clipStatus, setClipStatus] = useState<"idle" | "ok" | "err">("idle");
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  function handleThumbClick(e: React.MouseEvent) {
    onSelect(entry.path, e);
  }

  function handleThumbDoubleClick(e: React.MouseEvent) {
    e.preventDefault();
    onOpen(entry.path);
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

  function handleCopyFile() {
    void window.cove.copyRecordingToClipboard(entry.path, outputDir).then(
      (r) => {
        if (r.ok) {
          setClipStatus("ok");
          if (clipTimerRef.current) clearTimeout(clipTimerRef.current);
          clipTimerRef.current = setTimeout(() => setClipStatus("idle"), 1800);
        } else {
          setClipStatus("err");
          if (clipTimerRef.current) clearTimeout(clipTimerRef.current);
          clipTimerRef.current = setTimeout(() => setClipStatus("idle"), 2000);
        }
      },
      () => {
        setClipStatus("err");
        if (clipTimerRef.current) clearTimeout(clipTimerRef.current);
        clipTimerRef.current = setTimeout(() => setClipStatus("idle"), 2000);
      },
    );
  }

  function handleDeleteClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (window.confirm(`Move "${entry.name}" to trash?`)) {
      onDelete(entry.path);
    }
  }

  function handleSelectClick(e: React.MouseEvent) {
    e.stopPropagation();
    // Circle always toggles — Ctrl/Shift have no extra meaning here.
    onSelect(entry.path, e);
  }

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    if (clipTimerRef.current) clearTimeout(clipTimerRef.current);
  }, []);

  const showSelect = selectionActive || selected;

  return (
    <div className={`gallery-card${selected ? " gallery-card-selected" : ""}`} ref={cardRef}>
      <button
        className="gallery-card-thumb"
        onClick={handleThumbClick}
        onDoubleClick={handleThumbDoubleClick}
        title="Click to select, double-click to open"
        aria-label={`Select ${entry.name}`}
      >
        {thumbDataUrl && (
          <img src={thumbDataUrl} alt="" aria-hidden="true" draggable={false} />
        )}
        {!thumbDataUrl && <span className="gallery-card-ext">{extLabel(entry.name)}</span>}
        <span className="gallery-card-play"><PlayIcon /></span>

        {/* Delete X — top-left corner */}
        <span
          className="gallery-card-thumb-remove"
          onClick={handleDeleteClick}
          title="Delete recording"
          aria-label={`Delete ${entry.name}`}
          role="button"
        >
          <DeleteIcon />
        </span>

        {/* Select circle — top-right corner */}
        <span
          className={`gallery-card-checkbox${selected ? " gallery-card-checkbox-on" : ""}`}
          onClick={handleSelectClick}
          title={selected ? "Deselect" : "Select"}
          aria-label={selected ? `Deselect ${entry.name}` : `Select ${entry.name}`}
          role="button"
          style={showSelect ? { opacity: 1 } : undefined}
        >
          {selected && <CheckIcon />}
        </span>
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
        <button
          className={`gallery-action-btn${clipStatus === "ok" ? " gallery-action-copied" : clipStatus === "err" ? " gallery-action-copy-err" : ""}`}
          onClick={handleCopyFile}
          title={clipStatus === "ok" ? "File copied!" : clipStatus === "err" ? "Copy failed" : "Copy file to clipboard"}
          aria-label="Copy recording to clipboard"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3" y="2" width="11" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><path d="M6 6l2 2 3-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          {clipStatus !== "idle" && (
            <span className="gallery-action-toast">
              {clipStatus === "ok" ? "Copied" : "Failed"}
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

  // Selection state for multi-select (v3.3.0)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastSelectedRef = useRef<string | null>(null);

  // In-app video player
  const [playing, setPlaying] = useState<{ path: string; name: string } | null>(null);

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
    setSelected(new Set());
    window.cove.listRecordings(outputDir, 30).then(
      (list) => { if (alive) setEntries(list); },
      () => { if (alive) setEntries([]); },
    );
    return () => { alive = false; };
  }, [outputDir, lastOutputPath, v2ExportOutputPath, status]);

  // Keyboard: Delete key deletes selected recordings
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Delete" && selected.size > 0) {
        e.preventDefault();
        void handleDeleteMany();
      }
    }
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [selected]);

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

  // ── Selection handlers (v3.3.0) ──────────────────────────────────────────

  function handleSelect(path: string, e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd-click: toggle this item in/out of the set.
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path); else next.add(path);
        return next;
      });
      lastSelectedRef.current = path;
    } else if (e.shiftKey && lastSelectedRef.current && entries) {
      // Shift-click: select the range from the last-selected item to this one.
      const anchor = lastSelectedRef.current;
      const paths = entries.map((en) => en.path);
      const a = paths.indexOf(anchor);
      const b = paths.indexOf(path);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const range = new Set(paths.slice(lo, hi + 1));
        setSelected(range);
      }
    } else {
      // Plain click: replace selection with this single item.
      // If it's already the only selected item, deselect it.
      setSelected((prev) => {
        if (prev.size === 1 && prev.has(path)) return new Set();
        return new Set([path]);
      });
      lastSelectedRef.current = path;
    }
  }

  function handleOpen(path: string) {
    const entry = entries?.find((e) => e.path === path);
    setPlaying({ path, name: entry?.name ?? path });
  }

  function clearSelection() {
    setSelected(new Set());
    lastSelectedRef.current = null;
  }

  async function handleDeleteOne(path: string) {
    const r = await window.cove.deleteRecording(path, outputDir);
    if (r.ok) {
      // Drop from local state immediately so the card disappears
      setEntries((prev) => prev?.filter((e) => e.path !== path) ?? null);
      setThumbs((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    } else {
      window.alert(`Could not move "${fileNameOf(path)}" to trash.\n\n${r.error || "Unknown error"}`);
    }
  }

  async function handleDeleteMany() {
    const count = selected.size;
    if (!window.confirm(`Move ${count} recording${count > 1 ? "s" : ""} to trash?`)) return;
    let ok = 0;
    // Keep each failure's reason. Reporting only a count hides the actual
    // error (permissions, path validation, a trash backend that refused),
    // which leaves the user with no way to tell what went wrong.
    const failures: string[] = [];
    const remaining = [...selected];
    for (const p of remaining) {
      const r = await window.cove.deleteRecording(p, outputDir);
      if (r.ok) {
        ok++;
        setEntries((prev) => prev?.filter((e) => e.path !== p) ?? null);
        setThumbs((prev) => {
          const next = { ...prev };
          delete next[p];
          return next;
        });
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(p);
          return next;
        });
      } else {
        // Leave the card and the selection alone so the file stays visible.
        failures.push(`${fileNameOf(p)}: ${r.error || "Unknown error"}`);
      }
    }
    if (failures.length > 0) {
      const shown = failures.slice(0, MAX_ERROR_LINES);
      const hidden = failures.length - shown.length;
      if (hidden > 0) shown.push(`...and ${hidden} more.`);
      const header =
        ok > 0
          ? `Moved ${ok} of ${count} recordings to trash.\n\nCould not move:`
          : `Could not move ${count} recording${count > 1 ? "s" : ""} to trash.\n`;
      window.alert(`${header}\n${shown.join("\n")}`);
    }
  }

  async function handleCopyMany() {
    const remaining = [...selected];
    for (const p of remaining) {
      await window.cove.copyRecordingToClipboard(p, outputDir);
    }
    clearSelection();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const selCount = selected.size;
  const selectionActive = selCount > 0;

  return (
    <>
    <div className="gallery">
      <div className="gallery-header">
        <span className="gallery-title">Recent Recordings</span>
        {selectionActive && (
          <div className="gallery-bulk-bar">
            <button
              className="gallery-bulk-btn gallery-bulk-btn-danger"
              onClick={handleDeleteMany}
              title={`Delete ${selCount} selected recording${selCount > 1 ? "s" : ""}`}
            >
              Delete ({selCount})
            </button>
            <button
              className="gallery-bulk-btn"
              onClick={handleCopyMany}
              title="Copy files to clipboard (last-selected wins on paste)"
            >
              Copy ({selCount})
            </button>
            <button className="gallery-bulk-btn" onClick={clearSelection}>
              Clear
            </button>
          </div>
        )}
        {!selectionActive && outputDir && (
          <button className="gallery-folder-btn" onClick={handleOpenFolder} title="Open recordings folder">
            Open folder
          </button>
        )}
      </div>

      <div className="gallery-body" ref={bodyRef} tabIndex={-1}>
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
                selected={selected.has(e.path)}
                selectionActive={selectionActive}
                outputDir={outputDir}
                onSelect={handleSelect}
                onDelete={handleDeleteOne}
                onOpen={handleOpen}
              />
            ))}
          </div>
        )}
      </div>
    </div>
    {playing && (
      <VideoPlayer
        path={playing.path}
        name={playing.name}
        onClose={() => setPlaying(null)}
      />
    )}
    </>
  );
}
