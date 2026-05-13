# Handover — T-003 v2 replay engine architecture decision

**Date:** 2026-05-13
**Session type:** Research / decision only (planning, no code)
**Repo:** `/home/sin/Projects/cove-screen-recorder`
**Branch:** `main` (clean coming in; only `.story/` files changed during this session)
**Ticket:** T-003 (research and choose native replay engine approach)

---

## Decision

**Primary:** persistent native **Rust sidecar** helper process. Electron launches it on app start, talks to it over **length-prefixed JSON-RPC** on a **UNIX domain socket** (Linux/macOS) or **named pipe** (Windows). The sidecar owns capture, encode, rolling segments, and export/remux. Electron remains UI + control plane only.

**Fallback:** **ffmpeg-driven helper process** with PipeWire input. Same sidecar shape and same IPC contract, but the inner engine is a managed `ffmpeg` child process driven by carefully chosen flags. Kept as the escape hatch and Linux-first viability check if the Rust path slips.

**Rejected:**

- Per-command standalone native binary (cannot hold a continuous rolling replay buffer).
- Node N-API addon linked into Electron main (ABI coupling per Electron version, per-platform prebuild matrix, native crash takes the UI down — hostile to solo maintenance).

Full rationale lives in `.story/notes/N-002.json` and `.story/project-state.md` (new "v2.0.0 replay engine decision" section).

---

## Why the primary won (one paragraph)

The v1.1.0 ceiling is frames being dropped *before* any encoder is reached — inside Chromium MediaRecorder + canvas scaling. Only an out-of-process native engine with its own scheduler, a dmabuf/shm capture-to-encoder path, and structural crash isolation from Electron actually escapes that pipeline. An N-API addon shares Electron's main process and gives up isolation. An on-demand child binary cannot hold a continuously-running rolling buffer. An ffmpeg-wrapper helper gives most of the right shape but at the cost of driving the ffmpeg CLI as a brittle wrapper — strong as a fallback, weak as the long-term primary.

---

## Shape that the next tickets must respect

- `CaptureSource` trait — first impl `PipeWireSource` via xdg-desktop-portal `ScreenCast` + `pipewire-rs`. `WgcSource` follows on Windows. macOS deferred. → **T-004**.
- `EncoderBackend` trait — `NvencEncoder`, `VaapiEncoder`, `QsvEncoder`, `AmfEncoder` (Windows, later), `X264Encoder`. Implementation strategy: bind libavcodec via the `ffmpeg-next` Rust crate so the engine inherits ffmpeg's encoder coverage without shelling out to the ffmpeg CLI. Probe order NVENC → VAAPI / QSV → AMF → x264. → **T-005**.
- Rolling segment ring buffer in-memory (no on-disk write amplification during normal replay-buffer operation). → **T-006**.
- Export/remux performed inside the engine via libavformat (eliminates the v1.1.0 finalize-vs-encoder race). → **T-007**.
- IPC contract design (JSON-RPC framing vs Cap'n Proto vs bincode; method surface; lifecycle). → **T-008**.
- Validation matrix planning at 1080p60, 1440p60, 4K60. → **T-009**.

The fallback (ffmpeg helper) shares the same `CaptureSource`/`EncoderBackend` boundaries at the IPC layer — Electron should not need to know which inner engine is running.

---

## Files changed in this session

Only `.story/` planning state changed. Verification commands are listed at the bottom.

- `.story/notes/N-002.json` — created. Full architecture decision record.
- `.story/project-state.md` — appended new section: "v2.0.0 replay engine decision (T-003, 2026-05-13)".
- `.story/tickets/T-003.json` — status `open` → `complete`; description rewritten with the decision summary and downstream-ticket links.
- `.story/handovers/2026-05-13-03-t-003-replay-engine-decision.md` — this file.

**No source files were edited.** No `package.json`, no lockfile, no Electron / renderer / recorder / ffmpeg config, no build config, no tests, no CI.

---

## Out of scope (carried into v2 design phase)

- No Rust code written.
- No PipeWire prototype.
- No encoder probing implementation.
- No IPC framing choice locked.
- No ring-buffer data structure picked.
- No NVENC SDK version commitment.
- No packaging change.
- No release build.
- No commits.

---

## Recommended next ticket

**T-004 — Design PipeWire capture backend boundary.**

It's the first downstream design ticket gated on this decision, it's Linux-first (matches the project's deployment target), and it produces the `CaptureSource` interface that both T-005 (encoder matrix) and T-008 (IPC) will reference. T-005 can start in parallel if a second planning session is opened, since the `EncoderBackend` trait is decoupled from capture by design.

T-004 should produce: the trait surface, the xdg-desktop-portal flow, dmabuf vs memfd transport, multi-monitor / region selection, source-restart semantics, and a stub IPC method list for capture lifecycle. Still **no code**.

---

## Codex review

**No Codex review needed.** This session only touched `.story/` planning files. Codex review is gated on non-`.story` changes.

---

## Storybloq bookkeeping done this session

- `storybloq_ticket_update T-003 status=inprogress` (start) → `status=complete` (end).
- `storybloq_note_create` → N-002 (decision record).
- `storybloq_handover_create` → this handover.

A `storybloq_snapshot` should be taken at end of session per the skill's session-lifecycle rule.

---

## Verification (run at end of session)

```bash
git status --short
git diff --name-only
find .story -maxdepth 3 -type f | sort
```

Expected: all changes confined to `.story/`. No source-file diff.
