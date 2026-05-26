# Changelog

All notable changes to Cove Screen Recorder are documented in this file.

## [2.0.0] — 2026-05-26

### Summary

v2.0.0 replaces the v1 MediaRecorder-based capture pipeline with a native PipeWire helper process and a hardware-accelerated encoder backend matrix. The new architecture addresses four tracked user-facing issues and validates 1440p60 capture on M1 NVENC hardware.

### Added

- **PipeWire native capture** — PipeWire screencast portal replaces MediaRecorder; eliminates the WebRTC/Chromium capture path
- **NVENC encoder backend** — GPU-accelerated H.264 via NVENC; validated at 1080p60 and 1440p60 on M1 hardware (VAL-CAP-004, VAL-CAP-013)
- **Rolling fMP4 segment buffer** — continuous segment ring enables instant-replay export without a second capture pass
- **Stream-copy remux pipeline** — export remuxes rolling segments without re-encoding; preserves encoder fidelity end-to-end
- **Electron ↔ helper IPC contract** — structured RPC channel between the Electron renderer and the native helper process with defined session lifecycle and FSM states
- **Hardware encoder matrix infrastructure** — encoder selection is config-driven; VAAPI and QSV paths are infra-ready

### Fixed

- **Issue #1 — Crop area selection not triggering capture** — absorbed by v2 FSM architecture; `capture.sessionReady` is the single enforced entry gate to RECORDING, eliminating the silent non-start race present in v1
- **Issue #3 — Source does not record until hovered** — same root cause as Issue #1; resolved by `sessionReady` enforcement (VAL-UI-002)
- **Issue #2 — Replay keybind not configurable** — resolved by v2 state and hotkey architecture
- **Issue #4 — Crop/replay timer state weirdness** — resolved by three-clocks design and HUD-non-freeze guarantee (VAL-UI-003, VAL-UI-004)

### Known Limitations

**Platform**

- Linux only: Debian, Ubuntu, Arch, and Fedora on standard FHS install paths. Non-standard installs (Flatpak, Snap, NixOS, non-FHS) are outside v2.0.0 scope.
- Windows: out of scope for v2.0.0. AMF and WGC encoder backends are present in the binary but inert (VAL-ENC-012).

**Audio**

- Video-only release. Audio capture is a post-GA milestone.

**Encoder coverage**

- NVENC primary; 1080p60 and 1440p60 validated on M1 hardware.
- 4K60 × NVENC: hardware-bound on M1 (~66% frame-rate deficit). Expected behavior for this GPU generation; not a software regression.
- VAAPI (AMD/Intel DMA-BUF) and QSV: hardware-blocked on M1; require M2/M3 hardware. Tracked post-GA.
- libx264: infra-ready; blocked by NVENC-priority configuration on M1. Enablement is a config-only change for a future release.

**Deferred surfaces**

- Region capture UI (VAL-UI-005) is absent from the v2 renderer. Deferred to a post-GA feature release.
- Full multi-machine RC matrix (M2/M3/M4) is a post-GA hardware procurement track.
- REG-008 (timing-sensitive stabilization): STOP-classified; requires post-GA orchestration redesign. Not visible under normal operating conditions.
- Diagnostics bundle export (`engine.diagnosticsBundlePath`): governance-deferred; scoped for a post-GA release.

---

## [1.1.0] — Prior release

See git history for v1.1.0 changes.
