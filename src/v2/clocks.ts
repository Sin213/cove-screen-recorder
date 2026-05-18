// rAF-driven elapsed timer hook for the v2 recording HUD.
// Driven by requestAnimationFrame, NOT setInterval/setTimeout.

import { useEffect, useRef, useState } from "react";

export function useV2ElapsedMs(sessionReadyMs: number | null): number {
  const [elapsed, setElapsed] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (sessionReadyMs === null) {
      setElapsed(0);
      return;
    }
    const tick = () => {
      setElapsed(Date.now() - sessionReadyMs);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [sessionReadyMs]);

  return elapsed;
}
