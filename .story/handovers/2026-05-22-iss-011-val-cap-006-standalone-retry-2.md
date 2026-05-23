# ISS-011 VAL-CAP-006 Standalone Retry-2

## Scope
Controlled VAL-CAP-006 standalone retest under stable 1920x1080@60 + DMA-BUF conditions
to determine whether ISS-011 frame-count deficit is an environment artifact or real defect.

## Current HEAD
211007f Record ISS-011 VAL-CAP-006 standalone retest blocker

## Authoritative Sources (read-only)
- `.story/issues/ISS-011.json`
- `.story/handovers/2026-05-22-iss-011-val-cap-006-standalone.md`
- `.story/handovers/evidence/2026-05-22-iss-011-val-cap-006-standalone/`
- `.story/notes/N-008.json`
- `.story/tickets/T-010c.json`

## Evidence Root
`.story/handovers/evidence/2026-05-22-iss-011-val-cap-006-standalone-retry-2/`

## Mode Checkpoints
All checkpoints confirm DP-4 held at 1920x1080@60 throughout.

| Checkpoint | File | DP-4 Mode |
|---|---|---|
| postlogin | kscreen-doctor-postlogin.txt/.json | 1920x1080@60.00* |
| postelectron | kscreen-doctor-postelectron.txt/.json | 1920x1080@60.00* |
| midcoverage | kscreen-doctor-midcoverage.txt/.json | 1920x1080@60.00* |
| postsave | kscreen-doctor-postsave.txt/.json | 1920x1080@60.00* |
| postquit | kscreen-doctor-postquit.txt/.json | 1920x1080@60.00* |

Note: preportal checkpoint was not captured separately; postelectron serves as the pre-portal baseline.
Note: The test-run Cove instance (PIDs 1183xxx) exited after the export-hang observation. The operator relaunched Cove (PIDs 1186xxx) afterward. Postquit evidence reflects this mixed state — the test-run instance is gone, but a new instance is running.

## DBus Monitor
`dbus-kscreen-monitor.txt` — 4 lines, no KScreen mode change events during test window.

## Helper Log
`engine-log.txt` — 1021 lines from `~/.config/Cove Screen Recorder/logs/engine.log`.
Excerpt in `helper-log-excerpt.txt` (lines 1018-1021).

## DMA-BUF / SHM Verdict
**SHM fallback — DMA-BUF never succeeded.**

engine-log.txt line 1019: `PW stream errored during DMA-BUF-only negotiation: no more input formats; triggering SHM-only fallback retry`

DMA-BUF hard-fails on EVERY portal session in the entire engine-log.txt, spanning three
helper instances (PIDs 1057119, 1158597, 1187898) across >10 hours. This is systemic
to the hardware/driver/compositor combination:
- GPU: NVIDIA GeForce RTX 4080 Super
- Driver: 595.71.05 (CUDA 13.2)
- Compositor: KDE Plasma Wayland (kwin_wayland)
- Portal: xdg-desktop-portal-kde

Gate abort documented in `gate-abort-shm-fallback.md`.

## ffprobe / Frame-Count Verdict
Export: `exp-1779512366090814371-0005.mp4` (46.5M, 1920x1080)

| Metric | Value |
|---|---|
| duration | 28.542656s |
| r_frame_rate | 54/1 |
| avg_frame_rate | ~54.65 fps |
| nb_read_frames | 1560 |
| expected (round(dur × 60)) | 1713 |
| ratio | 91.1% |
| deficit | 8.9% |
| ±5% tolerance | OUTSIDE |

Full data in `ffprobe-frame-count.txt`.

## Export Finalization Hang (Secondary Finding)
UI displayed "Exporting replay... 100%" and never transitioned to completion.
The export file was written successfully (ffprobe validates it) but the completion
event did not reach the renderer. This is a separate defect from ISS-011.
Documented in `export-finalization-hang.md`.

## ISS-009 Recovery Gate
- engine.restart() workaround applied (engine.onReady race hit on initial load)
- RecoveryBanner appeared (63 recoverable sessions from prior crashes)
- "Ignore for this session" clicked — Start replay buffer became enabled
- No recovery-related screenshots captured (operator was interacting directly)

## Final Row Verdict
**NOT ATTEMPTED**

Three compounding issues prevented a valid result:
1. **SHM fallback gate abort** — DMA-BUF hard-failed; test requires DMA-BUF conditions (primary)
2. **Frame count outside tolerance** — 8.9% deficit under SHM (outside ±5%)
3. **Export finalization hang** — UI stuck at 100%, export completion event lost

## ISS-011 Recommendation
**Remains `inprogress`.** The triage question — "is the deficit an environment artifact
from SHM fallback or a real capture defect under DMA-BUF?" — cannot be answered on this
hardware because DMA-BUF has never succeeded on this NVIDIA 595.71 + KDE Wayland stack.

Next steps to consider:
1. Investigate why DMA-BUF negotiation always hard-fails (NVIDIA driver limitation?
   Missing VA-API/NVDEC interop? KDE portal DMA-BUF support gap?)
2. Test on AMD or Intel GPU where DMA-BUF typically succeeds
3. Consider whether SHM at 1080p (8.9% deficit) vs SHM at 4K (28% deficit) tells us
   the deficit is resolution-dependent under SHM — if so, the criterion may need
   SHM-specific tolerance or DMA-BUF may be a hard requirement

Additionally, the export finalization hang should be filed as a separate issue.

## No T-010c Status Changes
T-010c status was not modified. No claims about other VAL rows.

## Evidence Files
```
kscreen-doctor-postlogin.txt/.json
kscreen-doctor-postelectron.txt/.json
kscreen-doctor-midcoverage.txt/.json
kscreen-doctor-postsave.txt/.json
kscreen-doctor-postquit.txt/.json
kscreen-persisted-config-postpersist/
dbus-kscreen-monitor.txt
engine-log.txt
helper-log-excerpt.txt
electron-dev-initial-launch-failed.txt
ffprobe-frame-count.txt
ffprobe-newest-export.txt
frame-count-verdict.txt
gate-abort-shm-fallback.md
export-finalization-hang.md
pw-session-manifest.json
nvidia-smi-pre.txt
nvidia-smi-at-stuck.txt
nvidia-smi-post.txt
pgrep-cove-pre.txt
pgrep-all-at-stuck.txt
pgrep-cove-post.txt
pgrep-ffmpeg-pre.txt
pgrep-ffmpeg-post.txt
uptime-pre.txt
uptime-post.txt
```
