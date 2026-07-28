import { useEffect, useRef } from "react";

interface Props {
  /** path on disk that Chromium can play (file:// or the raw path) */
  path: string;
  /** display name for the title bar */
  name: string;
  onClose: () => void;
}

/**
 * Full-screen overlay video player.  Uses a plain <video> element with
 * native controls — Chromium ships H.264 + AAC + VP8/VP9/AV1 decoders
 * so MP4 / WebM / GIF play without extra codecs.
 */
export function VideoPlayer({ path, name, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // Close on Esc
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Autoplay once the source is loaded
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.play().catch(() => {
      /* user gesture required on some platforms — controls handle it */
    });
  }, [path]);

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
        <video
          ref={videoRef}
          className="vp-video"
          src={`file://${path}`}
          controls
          autoPlay
          playsInline
        >
          Your browser does not support the video tag.
        </video>
      </div>
    </div>
  );
}
