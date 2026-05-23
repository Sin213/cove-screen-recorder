# ISS-011 standalone VAL-CAP-006 retest — NOT ATTEMPTED (DMA-BUF gate failed)

## Scope

Single-row standalone retest of VAL-CAP-006 under controlled conditions to disambiguate whether retry-2's frame-count deficit (28%, 1200 vs 1671 expected at declared 60 fps) was a test-environment artifact (4K+SHM+idle compositor) or a true capture/encoder defect. v2 path only. No source/runtime/validation/release-policy edits. No ISS-007/ISS-008/ISS-009 changes.

## Outcome

**NOT ATTEMPTED.** The replay buffer was started and a PipeWire portal session was established (for the DMA-BUF gate check), but the gate failed — the row's validation procedure (behind-window coverage, save, ffprobe verification) was not attempted. Two compounding failures prevented controlled test conditions:

1. **KDE auto-restored DP-4 from 1920x1080@60 to 3840x2160@239.99.** The kscreen-doctor modeset was applied and confirmed in the pre-snapshot, but KDE-Plasma reverted DP-4 to its preferred 4K mode before the PipeWire portal session was established. Same behavior as retry-1 and retry-2.

2. **DMA-BUF negotiation hard-failed at 4K.** Helper fell back to SHM (width=3840, height=2160, fourcc=XR24). Same failure as retry-2.

Running the row under these conditions would reproduce the same degraded environment as retry-2, not the controlled 1080p60+DMA-BUF conditions the standalone procedure requires.

## Additional observations

- The initial `npm run dev` launch hit the engine.onReady subscription race (same as retry-2). App stuck at BOOTING with no banner. Operator used `window.coveApi.engine.restart()` to cycle the supervisor, then clicked "Ignore for this session" for recovery. Start replay buffer became enabled. The replay buffer was started successfully on the v2 path before the DMA-BUF gate check terminated the pass.
- The engine.onReady race is still unfiled (was deferred from retry-2 per ISS budget). It continues to reproduce on every cold start.

## Evidence root

`.story/handovers/evidence/2026-05-22-iss-011-val-cap-006-standalone/`

| Artifact | Content |
|---|---|
| `kscreen-doctor-pre.txt` / `.json` | DP-4 at 1920x1080@60 (confirmed before Electron launch) |
| `kscreen-doctor-post.txt` / `.json` | DP-4 at 3840x2160@239.99 (KDE auto-restored) |
| `nvidia-smi-pre.txt` / `nvidia-smi-post.txt` | GPU state pre/post |
| `pgrep-cove-pre.txt` / `pgrep-ffmpeg-pre.txt` | Pre-flight process check (only matches are self-references from the evidence-capture shell command; no stale app/ffmpeg processes) |
| `pgrep-cove-post.txt` / `pgrep-ffmpeg-post.txt` | Post state |
| `uptime-pre.txt` / `uptime-post.txt` | System uptime |
| `segments-dir-pre.txt` | 75 session directories on disk; helper classified 62 as recoverable (per engine log `discovered recoverable sessions from prior crash count=62`) |
| `electron-dev.txt` | First dev launch (exited immediately — engine.onReady race) |
| `helper-log-session-start.txt` | Engine log slice: portal session, DMA-BUF failure, SHM fallback |
| `dma-buf-fallback.txt` | Filtered DMA-BUF failure lines |
| `operator-evidence/VAL-CAP-006/NOT-ATTEMPTED.md` | Row verdict and next-step analysis |

## ISS-011 status

**inprogress** — unchanged. Not resolved. The standalone test could not run under controlled conditions.

## ISS-007 / ISS-008 / ISS-009 status

Untouched. No reads, no edits.

## T-010c status

Open, unchanged.

## Statement

No source, runtime, validation, or release-policy files modified. No `.story/tickets/`, `.story/notes/`, `.story/issues/ISS-007.json`, `.story/issues/ISS-008.json`, `.story/issues/ISS-009.json` modified. No new ISS filed (the abort branch does not require one). `git diff -- src/ helper/ electron/ validation/ dist-validation/ packaging/ .github/ .story/notes/ .story/tickets/ .story/issues/ISS-007.json .story/issues/ISS-008.json .story/issues/ISS-009.json` is empty.

## Next steps for operator

The KDE display auto-restore must be defeated before retrying. Options:
1. Disable KDE KScreen auto-restore before launching Electron (e.g., set preferred mode to 1080p in System Settings → Display).
2. Re-apply `kscreen-doctor output.DP-4.mode.1920x1080@60` AFTER Electron is running but BEFORE clicking Start replay buffer, and verify the mode stuck with `kscreen-doctor -o`.
3. Use an alternative display tool (xrandr / wlr-randr) that KDE won't override.
4. Accept that DMA-BUF may not negotiate at 4K on this driver and test at 1080p with the mode locked.
