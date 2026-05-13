# Handover — T-005 Encoder backend matrix and fallback policy

**Date:** 2026-05-13
**Session type:** Design only (planning, no code)
**Repo:** `/home/sin/Projects/cove-screen-recorder`
**Branch:** `main` (clean coming in; only `.story/` files changed during this session)
**Ticket:** T-005 (Design encoder backend matrix and fallback policy)
**Status going out:** T-005 `complete`

---

## What was decided

The encoder layer of the v2 helper is locked. Full design lives in `.story/notes/N-004.json`; the binding summary lives in `.story/project-state.md` under "v2.0.0 encoder backend matrix and fallback policy (T-005, 2026-05-13)"; the ticket description in `.story/tickets/T-005.json` was rewritten to carry the matrix and policy headlines so the ticket alone is enough context for the next implementer.

One-paragraph summary: the v2 helper picks a single encoder backend at session start by running a real minimum-cost probe (open device + tiny NV12 + two-frame encode + close), cached per (platform, vendor, GPU PCI, driver, kernel, app) — positive 7 days, **negative 30 days and never auto-retried**. NVIDIA → NVENC, AMD on Linux → VAAPI, AMD on Windows → AMF slot reserved but never selected in v2.0.0 (falls through to libx264 with a visible indicator), Intel Arc on Linux → QSV with VAAPI as sub-fallback, Intel iGPU gen <12 on Linux → VAAPI only, Intel on Windows → QSV, universal fallback → libx264. **SHM frames go to libx264 only** — if capture is forced to SHM, encoder switches to libx264 at session start before a single frame flows. Rolling capture uses closed GOP / IDR every 2 s / `bf=0` / no lookahead / CBR-or-CBR-equivalent at a 12/25/50 Mbps H.264 ladder. Segments are **fragmented MP4** (250 ms fragments, init segment once). Export defaults to stream copy; every re-encode case on Linux is **libx264 only** — never the HW encoder. Fallback is reported loudly: `encoder.probeResult` + `encoder.selected` + `encoder.fallbackEngaged` are surfaced to the UI and the recording status bar shows the active backend at all times. **Mid-session encoder switching is forbidden** — on runtime error, the session ends, the cached HW path is marked negative, and the next session uses libx264 with the fallback indicator. This is the v1.1.0 broken-fallback-loop fix expressed as policy.

---

## Encoder matrix (binding)

| Backend | Codec(s) | Linux | Windows | Status v2.0.0 |
| ------- | -------- | ----- | ------- | ------------- |
| NVENC   | h264_nvenc, hevc_nvenc | Yes | Yes | First-class. av1_nvenc deferred. |
| VAAPI   | h264_vaapi, hevc_vaapi | Yes (AMD always; Intel iGPU gen <12; Intel Arc as sub-fallback) | n/a | First-class on Linux. |
| QSV     | h264_qsv, hevc_qsv     | Yes (Intel Arc only) | Yes (Intel) | First-class on Windows; secondary on Linux. |
| AMF     | h264_amf, hevc_amf     | n/a | **Slot reserved; never probed; never selected in v2.0.0.** | Future path. |
| AV1     | av1_nvenc, av1_vaapi, av1_qsv | — | — | Deferred. |
| libx264 | libx264                | Yes | Yes | Universal fallback. Also the **only** Linux re-encoder for any finalisation re-encode. |

At most one HW backend is selected per session. Probe runs once at session start. Never mid-stream.

---

## Fallback policy (binding)

- **Probe cache rule:** negative cache hits do not retry. Manual override only (`--reset-encoder-probe` or advanced settings). This is the explicit fix for the v1.1.0 broken Linux HW fallback loop.
- **SHM path:** SHM frames go to libx264 only. If capture is forced to SHM, encoder switches before any frame flows. `encoder.fallbackEngaged(shm-forced)` surfaced.
- **Linux finalisation re-encode:** **always libx264.** Hardware encoders are never asked to re-encode in v2.0.0. Five trigger cases: trim mid-GOP, format-change spanning trim, muxer validation failure, "Maximum compatibility" toggle, full export re-encode. All five go to libx264.
- **Mid-session encoder switching:** forbidden. On `encoder-runtime-error`: end the session, mark cached HW path negative, surface the error. User retries → libx264 with the fallback indicator. No silent SPS/VPS change inside a single bitstream.
- **Fallback transparency:** `encoder.probeResult` + `encoder.selected` + `encoder.fallbackEngaged` are always emitted at session start; UI status bar always shows the active backend + a fallback indicator when libx264 is in use as a fallback (not as the user's chosen primary).

Three-line rule for Linux: **HW for live, CPU for re-encode, no exceptions.**

---

## Exact `.story` files changed this session

- `.story/notes/N-004.json` — **created**. Full design record (22 numbered sections): probe order, capability probe strategy (incl. the v1.1.0 broken-loop fix), per-vendor accepted inputs, DMA-BUF/modifier import expectations, SHM fallback policy, rate control defaults, GOP/keyframe policy, PTS expectations, rolling-segment container choice (fMP4 with rationale + rejected alternatives), final-export container/codec, replay finalisation/remux policy, when HW vs CPU runs on Linux, fallback reporting events, diagnostics counters, error reason codes, mid-session-switch refusal, T-006 consumption contract, deferred items, validation cases, open implementation items.
- `.story/project-state.md` — **modified**. New section `## v2.0.0 encoder backend matrix and fallback policy (T-005, 2026-05-13)` inserted between the T-004 PipeWire section and "Open issue triage".
- `.story/tickets/T-005.json` — **modified**. Status `open` → `inprogress` → `complete`. Description rewritten to carry the locked matrix + policy headlines (backend matrix, probe order, capability probe + cache, per-vendor inputs, DMA-BUF expectations, SHM policy, rate control defaults, GOP policy, PTS expectations, container choices, finalisation policy, Linux HW-vs-CPU rule, diagnostics counters, error reason codes, fallback reporting events, mid-session-switch refusal, T-006 contract, deferrals).
- `.story/handovers/2026-05-13-06-t-005-encoder-matrix.md` — **created**. This file.

**No source files were edited.** No `package.json`, no lockfile, no Electron / renderer / recorder / ffmpeg code, no build config, no CI, no tests.

---

## Source files changed

**None.** This was a planning-only session.

---

## Out of scope (deferred — explicitly recorded)

- AV1 encode on any vendor.
- AMF on Windows (slot reserved; v2.0.0 falls through to libx264 with a visible indicator).
- HDR end-to-end tone-mapping policy (P010 accepted at the encoder layer when source is 10-bit + HEVC chosen; the tone-mapping / colour-metadata export policy is post-v2.0.0).
- User-facing rate-control overrides (bitrate ladder is fixed for v2.0.0).
- Audio encode (AAC-LC is the planned target; separate ticket; will share `t0_ns`).
- macOS VideoToolbox backend (trait shape ready; not built).
- Mid-session encoder reconfiguration beyond IDR forcing — refused.
- Per-source encoder choice in multi-stream — refused for v2.0.0 (multi-stream is itself deferred from T-004).
- Open implementation items (not blockers): ffmpeg-the-library vs direct NVENC/VAAPI/QSV bindings; fMP4 muxer choice (`movenc` default); CUDA context sharing between NVENC and any optional convert shader; VAAPI driver deny-list for known-bad HEVC encoder versions. To be pinned at T-005 implementation ticket time.

---

## Recommended next ticket

**T-006 — Design rolling segment buffer + replay buffer storage layout.** T-005 froze the encoder's output contract (`EncodedFragment` shape, init-segment delivery, fMP4 fragmentation cadence, back-pressure semantics, force-IDR API). T-006 can pick that up directly with no further input from T-005.

T-007 (export/remux pipeline) should wait for T-006 — it needs the on-disk segment layout to plan the concat + remux pass.

T-008 (UI ↔ engine integration) is still parallelisable; it now has both the capture-shaped methods (from T-004) and the encoder events (`encoder.probeResult`, `encoder.selected`, `encoder.fallbackEngaged`, `encoder.runtimeError`, `encoder.backPressure`) it needs to spec the IPC surface.

---

## Codex review

**No Codex review needed.** This session only touched `.story/` planning files. Codex review remains gated on non-`.story` changes.

---

## Storybloq bookkeeping done this session

- `storybloq_ticket_update T-005 status=inprogress` (start) → `status=complete` with rewritten description (end).
- `storybloq_note_create` → N-004 (encoder backend matrix and fallback policy design record).
- `storybloq_handover_create` → this handover.
- `storybloq_snapshot` should be taken at end of session per the skill's session-lifecycle rule.

---

## Verification (run at end of session)

```bash
git status --short
git diff --name-only
find .story -maxdepth 3 -type f | sort
```

Expected: all changes confined to `.story/`. No source-file diff.
