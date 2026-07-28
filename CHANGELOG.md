# Changelog

All notable changes to Cove Screen Recorder are documented in this file.

## [3.3.0] - 2026-07-26

### Added

- **Per-card delete** -- hover any recording thumbnail to reveal an X button in the top-left corner. Click to delete with a confirmation prompt. The file is permanently removed from disk and the gallery refreshes immediately.
- **Multi-select** -- click the circle checkbox in the top-right corner of any thumbnail to toggle selection. Once one or more recordings are selected, a bulk-action bar appears in the gallery header with Delete (N), Copy (N), and Clear. Select and delete many at once.
- **Copy recording to clipboard** -- new "Copy file" button on each card copies the actual video file to the OS clipboard. Paste directly into chat apps like Slack, Discord, or Outlook. Uses `text/uri-list` on Linux and the platform-native bookmark format on Windows/macOS.

### Fixed

- Empty or near-instant recordings no longer fail with the cryptic ffmpeg exit code 183. A file-size guard now catches empty WebM output before the remux step and surfaces a clear diagnostic message.

## [3.2.1] - 2026-07-08

### Fixed

- Auto-update no longer fails silently when AppImageLauncher is installed (#9). electron-updater finished updates by launching the new AppImage; AppImageLauncher intercepted that launch and the install died with a swallowed EPIPE. Updates are now installed by atomically swapping the AppImage file in place - no process launch, nothing to intercept. The new version takes effect on the next start, and download/install/failure states are surfaced through the toast system. Reported by @kraibse.

## [3.2.0] - 2026-07-07

### Added

- Unified toast notification system (#8). On-screen toasts now appear for recording start, save success and failure, replay buffer start/stop, replay save progress and result, missing ffmpeg, and recording engine ready/crashed/session lost. Toasts auto-dismiss per type (info 3s, success 4s, warning 5s, error 6s), can be clicked away, and stack up to 5. Reported by @kraibse.

### Fixed

- Removed the runtime desktop-file installer that created a duplicate application shortcut next to AppImageLauncher's entry and left a dead shortcut behind after auto-updates replaced the AppImage (#7). Desktop integration is now left to AppImageLauncher and the packaged .deb. Reported by @kraibse.

## [3.1.3] - 2026-07-01

### Fixed

- Opening a recording or its folder from inside the AppImage could crash the file manager or media player. The AppImage's bundled library path leaked into external programs; they are now launched with a clean environment.

## [2.0.0] — 2026-05-27

### Summary

v2.0.0 replaces the v1 MediaRecorder-based capture pipeline with a native PipeWire helper process and a hardware-accelerated encoder backend matrix. The new architecture addresses four tracked user-facing issues and validates 1440p60 capture on M1 NVENC hardware.

### Added

- **PipeWire native capture** — PipeWire screencast portal replaces MediaRecorder; eliminates the WebRTC/Chromium capture path
- **NVENC encoder backend** — GPU-accelerated H.264 via NVENC; validated at 1080p60 and 1440p60 on M1 hardware
- **Rolling fMP4 segment buffer** — continuous segment ring enables instant-replay export without a second capture pass
- **Stream-copy remux pipeline** — export remuxes rolling segments without re-encoding; preserves encoder fidelity end-to-end
- **Electron ↔ helper IPC contract** — structured RPC channel between the Electron renderer and the native helper process with defined session lifecycle and FSM states
- **Hardware encoder matrix infrastructure** — encoder selection is config-driven; VAAPI and QSV paths are infra-ready

### Fixed

- **Issue #1 — Crop area selection not triggering capture** — absorbed by v2 FSM architecture; `capture.sessionReady` is the single enforced entry gate to RECORDING
- **Issue #3 — Source does not record until hovered** — same root cause as Issue #1; resolved by `sessionReady` enforcement
- **Issue #2 — Replay keybind not configurable** — resolved by v2 state and hotkey architecture
- **Issue #4 — Crop/replay timer state weirdness** — resolved by three-clocks design and HUD-non-freeze guarantee
- **Crop overlay dark bands on Wayland** — replaced clip-path polygon dim layer with four deterministic absolute-positioned rectangles; eliminates GPU compositor rasterization artifacts under Wayland Ozone *(reported by [@Kraibse](https://github.com/Kraibse))*
- **Double-prompt on Wayland crop/GIF** — on Wayland, recording now starts immediately after the PipeWire portal grants access instead of showing a redundant crop dialog *(suggested by [@Kraibse](https://github.com/Kraibse))*
- **Wayland balanced preset recording at native resolution** — the Wayland direct-start path was missing the capture quality downscale, so balanced preset recorded at native 1440p instead of 1080p
- **Portal overlay captured in first GIF frames** — added compositor settle delay between PipeWire stream acquisition and MediaRecorder start

### Known Limitations

- Linux only: Debian, Ubuntu, Arch, and Fedora on standard FHS install paths
- NVENC primary; VAAPI and QSV require AMD/Intel hardware (tracked post-GA)
- 4K60 × NVENC is hardware-bound on M1 (~66% frame-rate deficit); validated operating points are 1080p60 and 1440p60

---

## [1.1.0] — Prior release

See git history for v1.1.0 changes.
