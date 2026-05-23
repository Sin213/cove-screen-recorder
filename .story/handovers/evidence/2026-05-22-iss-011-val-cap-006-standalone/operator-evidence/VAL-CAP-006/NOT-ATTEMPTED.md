# VAL-CAP-006 — NOT ATTEMPTED (DMA-BUF gate failed)

## Verdict

NOT-ATTEMPTED. The replay buffer was started and a PipeWire portal session was established (for the DMA-BUF gate check), but the gate failed — DMA-BUF negotiation hard-failed and the helper fell back to SHM at 4K. The row's validation procedure (behind-window coverage, save, ffprobe verification) was not attempted because the gate requires DMA-BUF to pass before proceeding.

## Root cause

Two compounding failures prevented controlled test conditions:

1. **KDE auto-restored DP-4 to 3840x2160@239.99.** kscreen-doctor set mode 11 (1920x1080@60) pre-flight and the pre-snapshot confirmed it. However, by the time `VITE_COVE_V2_UI=1 npm run dev` reached the PipeWire portal session (2026-05-23T03:40:15Z), KDE-Plasma had reverted DP-4 to its preferred mode 2 (3840x2160@239.99). This is the same KDE auto-restore behavior observed in retry-1 and retry-2 handovers.

2. **DMA-BUF negotiation hard-failed at 4K.** The helper logged:
   - `PW stream errored during DMA-BUF-only negotiation: no more input formats; triggering SHM-only fallback retry`
   - `PW: DMA-BUF negotiation hard-failed; reconnecting with SHM-only fallback`
   - `PW stream ready` at width=3840, height=2160, fourcc=XR24 (SHM path)

   This reproduces the same DMA-BUF failure from retry-2. At 4K, the DMA-BUF path is unavailable on this hardware/driver combination (RTX 4080 SUPER, driver 595.71.05).

## Procedure outcome

Per the standalone procedure's DMA-BUF gate:
- "If SHM fallback occurs: save dma-buf-fallback.txt, write NOT-ATTEMPTED.md, stop, do not resolve ISS-011."

The gate is designed to ensure the standalone test runs under conditions that differ from retry-2 (where the deficit was observed under SHM+4K). Running the row under the same degraded conditions would not disambiguate test-environment artifact from real defect.

## Evidence

- `../../dma-buf-fallback.txt` — filtered engine.log lines showing DMA-BUF hard-failure and SHM fallback
- `../../helper-log-session-start.txt` — session-start engine.log slice
- `../../kscreen-doctor-pre.txt` — DP-4 at 1920x1080@60 pre-flight (before KDE auto-restore)

## ISS-011 status

Unchanged: inprogress. Not resolved. The standalone test could not run under the required controlled conditions.

## Next steps for operator

The KDE auto-restore must be defeated before retrying. Options:
1. Disable KDE's display auto-restore (KScreen config) before launching Electron.
2. Re-apply `kscreen-doctor output.DP-4.mode.1920x1080@60` AFTER Electron is running but BEFORE clicking Start replay buffer (verify with kscreen-doctor -o that mode stuck).
3. Use `xrandr` or `wlr-randr` if available as an alternative to kscreen-doctor that KDE won't override.
4. Set DP-4 to 1080p in KDE System Settings as the preferred mode so auto-restore targets 1080p.
