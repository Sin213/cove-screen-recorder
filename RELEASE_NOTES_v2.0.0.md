# Cove Screen Recorder v2.0.0 — Release Notes

**Release date:** 2026-05-26
**Release posture:** Bounded M1 NVENC-first GA · Linux only

---

## Highlights

v2.0.0 is a full capture-pipeline rewrite. The v1 MediaRecorder architecture is replaced by a native PipeWire helper process with a hardware-accelerated encoder backend matrix, a rolling fMP4 segment buffer, and a stream-copy remux export pipeline. Four tracked user-facing issues are resolved by the new FSM-based session lifecycle.

**Architecture changes:**

- **PipeWire native capture** — direct PipeWire screencast portal; no WebRTC dependency
- **NVENC GPU encoding** — hardware H.264 via NVENC; validated at 1080p60 and 1440p60 on M1
- **Rolling fMP4 segment buffer** — instant-replay export without a re-encode pass
- **Stream-copy remux** — export preserves encoder output end-to-end; no quality loss on save
- **Structured Electron ↔ helper IPC** — RPC channel with defined session lifecycle, FSM states, and `sessionReady` gate

---

## Validated M1 GA Scope

| Surface | Result | Evidence |
|---------|--------|----------|
| §22 smoke suite (20 rows) | PASS | validation commit `d335a09` |
| 1080p60 × NVENC | PASS | VAL-CAP-004 (§22) |
| 1440p60 × NVENC | PASS | VAL-CAP-013 |
| v1.1.0 regression suite (M1 scope) | PASS | §16 bounded convergence |
| Issue #1 / #3 absorption proofs | PASS | VAL-UI-002, VAL-CAP-007 |
| Issue #2 / #4 resolution | PASS | VAL-UI-003, VAL-UI-004 |

---

## Resolved Issues

| Issue | Description | Resolution |
|-------|-------------|------------|
| #1 | Crop area selection not triggering capture | Absorbed by v2 FSM; `sessionReady` is the single entry gate to RECORDING |
| #2 | Replay keybind not configurable | Resolved by v2 hotkey architecture |
| #3 | Source does not record until hovered | Same root cause as #1; resolved by `sessionReady` enforcement |
| #4 | Crop/replay timer state weirdness | Resolved by three-clocks design and HUD-non-freeze guarantee |

---

## Installation and Update

**Supported platforms:**

- Debian / Ubuntu — `.deb` package
- Arch Linux — AppImage
- Fedora — AppImage

Standard FHS install paths are required. Flatpak, Snap, NixOS, and non-FHS environments are outside v2.0.0 scope.

### Downloads

| Asset | SHA256 |
|-------|--------|
| `Cove-Screen-Recorder-2.0.0-x86_64.AppImage` | *(see `.sha256` sidecar)* |
| `Cove-Screen-Recorder-2.0.0-amd64.deb` | *(see `.sha256` sidecar)* |

*SHA256 checksums will be confirmed at publish time. Each artifact ships with a matching `.sha256` sidecar file for manual verification.*

### Updating from v1.1.0

Download the new installer for your distribution and install over the existing version. At startup, the application verifies the integrity of the bundled helper binary using its `.sha256` sidecar (N-007 §17). The release asset `.sha256` files above are for manual verification of downloaded packages. No persistent state is shared between v1 and v2 in a way that would be corrupted by upgrade.

---

## Known Limitations

**Audio**
Video-only release. Audio capture is a post-GA milestone.

**Windows**
Out of scope for v2.0.0. AMF and WGC encoder backends are present in the binary but inert (VAL-ENC-012).

**4K60 on M1**
Hardware-bound. M1 GPU produces a ~66% frame-rate deficit at 4K60×NVENC. This is expected hardware behavior for the M1 generation, not a software regression. The validated operating points for v2.0.0 are 1080p60 and 1440p60.

**VAAPI / QSV (AMD / Intel encoders)**
Hardware-blocked on M1. Require M2/M3 hardware. Tracked for a post-GA release.

**Region capture UI**
The region capture UI surface (VAL-UI-005) is absent from the v2 renderer. Deferred to a post-GA feature release.

**Diagnostics bundle**
`engine.diagnosticsBundlePath` export is not yet implemented. For bug reports, attach application logs from `~/.config/Cove Screen Recorder/logs/`.

**REG-008 / timing stability**
One regression row (REG-008) is STOP-classified — requires post-GA orchestration redesign. Not visible under normal operating conditions.

---

## Rollback

To revert to v1.1.0, reinstall the v1.1.0 package for your distribution. v2.0.0 does not share persistent state with v1 in a way that would be corrupted by downgrade.

---

## Support

File issues at: https://github.com/Sin213/cove-screen-recorder/issues

For triage, include:
- Distribution name and version
- GPU model and driver version
- Steps to reproduce
- Application logs from `~/.config/Cove Screen Recorder/logs/`

---

*v2.0.0 validated under bounded M1 NVENC-first GA scope. Multi-platform parity (M2/M3/M4 RC matrix, VAAPI/QSV validation, Windows) is a post-GA track.*
