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
  const webviewRef = useRef<any>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const fitVideo = () => {
      const bounds = webview.getBoundingClientRect();
      const hostWidth = Math.round(webview.clientWidth || bounds.width || 0);
      const hostHeight = Math.round(webview.clientHeight || bounds.height || 0);

      void webview.executeJavaScript(`
        (() => {
          let attempts = 0;
          const applySize = () => {
            const video = document.querySelector("video");
            if (!video) {
              if (attempts++ < 40) setTimeout(applySize, 50);
              return;
            }

            const root = document.documentElement;
            const body = document.body;
            if (!root || !body) return;
            const viewportWidth = Math.max(
              ${hostWidth},
              window.innerWidth || 0,
              root.clientWidth || 0,
              body.clientWidth || 0,
              1,
            );
            const viewportHeight = Math.max(
              ${hostHeight},
              window.innerHeight || 0,
              root.clientHeight || 0,
              body.clientHeight || 0,
              1,
            );

            root.style.width = viewportWidth + "px";
            root.style.height = viewportHeight + "px";
            root.style.overflow = "hidden";
            body.style.width = viewportWidth + "px";
            body.style.height = viewportHeight + "px";
            body.style.margin = "0";
            body.style.background = "#000";
            const styleId = "cove-video-fit";
            let style = document.getElementById(styleId);
            if (!style) {
              style = document.createElement("style");
              style.id = styleId;
              (document.head || root).appendChild(style);
            }
            style.textContent = [
              "html, body { width: 100% !important; height: 100% !important; min-width: 100% !important; min-height: 100% !important; margin: 0 !important; overflow: hidden !important; background: #000 !important; }",
              "video { position: fixed !important; inset: 0 !important; display: block !important; max-width: none !important; max-height: none !important; margin: 0 !important; object-fit: contain !important; }",
            ].join("\\n");
            video.style.display = "block";
            video.style.setProperty("position", "fixed", "important");
            video.style.setProperty("inset", "0", "important");
            video.style.setProperty("width", viewportWidth + "px", "important");
            video.style.setProperty("height", viewportHeight + "px", "important");
            video.style.setProperty("max-width", "none", "important");
            video.style.setProperty("max-height", "none", "important");
            video.style.objectFit = "contain";

            if (video.dataset.coveVideoFitBound !== "true") {
              video.dataset.coveVideoFitBound = "true";
              video.addEventListener("loadedmetadata", applySize);
              window.addEventListener("resize", applySize);
            }
          };

          applySize();
        })();
      `).catch(() => {});
    };

    webview.addEventListener("dom-ready", fitVideo);
    webview.addEventListener("did-finish-load", fitVideo);
    const retryTimer = window.setTimeout(fitVideo, 100);

    return () => {
      window.clearTimeout(retryTimer);
      webview.removeEventListener("dom-ready", fitVideo);
      webview.removeEventListener("did-finish-load", fitVideo);
    };
  }, []);

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
