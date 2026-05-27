import { useCallback, useEffect, useRef, useState } from "react";
import type { CropRect } from "../types";

interface Props {
  stream: MediaStream;
  onConfirm: (rect: CropRect) => void;
  onCancel: () => void;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function CropOverlay({ stream, onConfirm, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [videoReady, setVideoReady] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => {});
    const onLoaded = () => setVideoReady(true);
    video.addEventListener("loadeddata", onLoaded);
    return () => {
      video.removeEventListener("loadeddata", onLoaded);
      video.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const toVideoCoords = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay) return null;
    const bounds = overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(clientX - bounds.left, bounds.width)),
      y: Math.max(0, Math.min(clientY - bounds.top, bounds.height)),
    };
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const pt = toVideoCoords(e.clientX, e.clientY);
    if (!pt) return;
    setDrawing(true);
    setStart(pt);
    setRect(null);
  }, [toVideoCoords]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drawing || !start) return;
    const pt = toVideoCoords(e.clientX, e.clientY);
    if (!pt) return;
    setRect({
      x: Math.min(start.x, pt.x),
      y: Math.min(start.y, pt.y),
      width: Math.abs(pt.x - start.x),
      height: Math.abs(pt.y - start.y),
    });
  }, [drawing, start, toVideoCoords]);

  const onMouseUp = useCallback(() => {
    setDrawing(false);
  }, []);

  const handleConfirm = useCallback(() => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!rect || !video || !overlay || rect.width < 10 || rect.height < 10) return;
    const bounds = overlay.getBoundingClientRect();
    const scaleX = video.videoWidth / bounds.width;
    const scaleY = video.videoHeight / bounds.height;
    onConfirm({
      x: Math.round(rect.x * scaleX),
      y: Math.round(rect.y * scaleY),
      width: Math.round(rect.width * scaleX),
      height: Math.round(rect.height * scaleY),
      dpr: 1,
      displayId: "",
      displayWidth: video.videoWidth,
      displayHeight: video.videoHeight,
      sourceId: "",
    });
  }, [rect, onConfirm]);

  const hasValidRect = rect && rect.width >= 10 && rect.height >= 10;

  return (
    <div className="modal-backdrop" style={{ cursor: drawing ? "crosshair" : "default" }}>
      <div className="modal" style={{ width: "min(900px, 95vw)", maxHeight: "90vh" }}>
        <div className="modal-head">
          <h3>Select crop region</h3>
          <div className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        </div>
        <div className="modal-body" style={{ padding: 0, overflow: "hidden", position: "relative" }}>
          {!videoReady && (
            <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-faint)" }}>
              Loading preview...
            </div>
          )}
          <div
            ref={overlayRef}
            style={{ position: "relative", cursor: "crosshair", display: videoReady ? "block" : "none" }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          >
            <video
              ref={videoRef}
              muted
              playsInline
              style={{ width: "100%", display: "block", pointerEvents: "none" }}
            />
            {rect && (
              <>
                <div style={{
                  position: "absolute", inset: 0,
                  background: "rgba(0,0,0,0.45)",
                  clipPath: `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${rect.x}px ${rect.y}px, ${rect.x}px ${rect.y + rect.height}px, ${rect.x + rect.width}px ${rect.y + rect.height}px, ${rect.x + rect.width}px ${rect.y}px, ${rect.x}px ${rect.y}px)`,
                  pointerEvents: "none",
                }} />
                <div style={{
                  position: "absolute",
                  left: rect.x, top: rect.y,
                  width: rect.width, height: rect.height,
                  border: "2px solid var(--accent)",
                  borderRadius: 2,
                  pointerEvents: "none",
                }} />
                <div style={{
                  position: "absolute",
                  left: rect.x, top: rect.y - 22,
                  fontSize: 11, fontFamily: "var(--mono)",
                  color: "var(--accent)", background: "rgba(0,0,0,0.7)",
                  padding: "1px 6px", borderRadius: 3,
                  pointerEvents: "none",
                }}>
                  {Math.round(rect.width)}×{Math.round(rect.height)}
                </div>
              </>
            )}
          </div>
          <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <p style={{ flex: 1, margin: 0, fontSize: 12, color: "var(--text-faint)" }}>
              Click and drag to select the recording area
            </p>
            <button
              className="btn btn-primary"
              disabled={!hasValidRect}
              onClick={handleConfirm}
            >
              Start recording
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
