import { useEffect, useRef } from "react";

interface Props {
  path: string;
  name: string;
  onClose: () => void;
}

/**
 * Full-screen overlay video player using an Electron <webview>.
 * webview loads the file:// URL in its own isolated renderer process,
 * bypassing the CORS restriction that blocks <video> from http://localhost.
 */
export function VideoPlayer({ path, name, onClose }: Props) {
  const webviewRef = useRef<Electron.WebviewTag>(null);

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
          ref={webviewRef}
          src={`file://${path}`}
          className="vp-video"
          allowtransparency="true"
        />
      </div>
    </div>
  );
}
