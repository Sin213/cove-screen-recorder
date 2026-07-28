import { useEffect, useRef, useState } from "react";

interface Props {
  /** absolute filesystem path to the recording */
  path: string;
  /** display name for the title bar */
  name: string;
  /** the current output directory (for IPC path validation) */
  outputDir: string | null;
  onClose: () => void;
}

/**
 * Full-screen overlay video player.  Loads the recording through a local
 * HTTP server (started by the main process) so the <video> element can
 * stream the file without CORS or protocol restrictions.
 */
export function VideoPlayer({ path, name, outputDir, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.cove.getMediaUrl(path, outputDir).then((url) => {
      if (alive) {
        if (url) setMediaUrl(url);
        else setError("Could not load recording");
      }
    }).catch(() => {
      if (alive) setError("Could not load recording");
    });
    return () => { alive = false; };
  }, [path, outputDir]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !mediaUrl) return;
    v.play().catch(() => {
      /* user gesture required on some platforms — controls handle it */
    });
  }, [mediaUrl]);

  return (
    <div className="vp-overlay" onClick={onClose}>
      <div className="vp-container" onClick={(e) => e.stopPropagation()}>
        <div className="vp-header">
          <span className="vp-title">{name}</span>
          <button className="vp-close" onClick={onClose} aria-label="Close player">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6l-12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        {error ? (
          <div className="vp-error">{error}</div>
        ) : mediaUrl ? (
          <video
            ref={videoRef}
            className="vp-video"
            src={mediaUrl}
            controls
            autoPlay
            playsInline
          />
        ) : (
          <div className="vp-loading">Loading…</div>
        )}
      </div>
    </div>
  );
}
