import { useEffect } from "react";

interface Props {
  path: string;
  name: string;
  onClose: () => void;
}

/**
 * Build a file:// URL from an absolute filesystem path.
 * Normalizes Windows separators, keeps the drive-letter colon unencoded
 * (C:\Videos\clip.mp4 -> file:///C:/Videos/clip.mp4), and percent-encodes
 * every other segment so spaces, Unicode, #, ? and % survive intact.
 */
function toFileUrl(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const withRoot = /^[a-zA-Z]:/.test(normalized) ? `/${normalized}` : normalized;
  const encoded = withRoot
    .split("/")
    .map((segment) => (/^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
  return `file://${encoded}`;
}

/**
 * Full-screen overlay video player using an Electron <webview>.
 * webview loads the file:// URL in its own isolated renderer process,
 * bypassing the CORS restriction that blocks <video> from http://localhost.
 * The guest is Chromium's built-in media document, which already centers the
 * video, preserves aspect ratio, letterboxes, and provides native controls
 * once the host keeps its required flex layout (see .vp-video in index.css).
 */
export function VideoPlayer({ path, name, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
        <webview
          src={toFileUrl(path)}
          className="vp-video"
          allowtransparency="true"
        />
      </div>
    </div>
  );
}
