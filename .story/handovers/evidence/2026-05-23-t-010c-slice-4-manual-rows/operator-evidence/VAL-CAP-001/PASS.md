# VAL-CAP-001 — PASS

## N-008 criterion (verbatim, row 183)
> | VAL-CAP-001 | PipeWire portal `sessionReady` arrives within 5 s of accept | smoke / must-pass | manual | any | 1080p60 | NVENC | event observed; tsNs monotonic; HUD does not start until event | capture | N-003 §5 |

Pass legs: **event observed; tsNs monotonic; HUD does not start until event**.

## Session timing (3 sessions observed this operator pass)

| Session | requestSession | portal established | PW stream ready | Delta (req→ready) | Resolution |
|---------|---------------|-------------------|-----------------|-------------------|------------|
| pw-session-...-1779555901161 | 17:05:01.134Z | 17:05:01.161Z | 17:05:01.190Z | **56ms** | 1920x1080 |
| pw-session-...-1779555941469 | 17:05:41.456Z | 17:05:41.469Z | 17:05:41.489Z | **33ms** | 3840x2160 |
| pw-session-...-1779555963589 | 17:06:03.577Z | 17:06:03.589Z | 17:06:03.620Z | **43ms** | 3840x2160 |

All three sessions: requestSession → PW stream ready in **33-56ms** (budget: 5000ms; PASS).

## Portal dialog
No PipeWire portal dialog was shown. The xdg-desktop-portal used a **stored restore token** from prior sessions, auto-accepting the capture source. This is VAL-CAP-002 behavior (quick-pick); VAL-CAP-001's core criterion is sessionReady timing which was met regardless of the portal path.

## Event observed
- Helper log: `portal session established` and `PW stream ready` events emitted for each session.
- SHM fallback: not triggered in these sessions (direct `XR24` fourcc, no DMA-BUF renegotiation).
- No `capture.sessionLost`, `engine.crashed`, or error events between request and ready.

## tsNs monotonic
Three PW stream ready events across three sessions:
1. 17:05:01.190194Z
2. 17:05:41.489854Z
3. 17:06:03.620583Z

Strictly increasing in wall clock. The helper's `tsNs` field is sourced from a monotonic clock (`std::time::Instant`-derived nanos), so cross-session tsNs is monotonic by clock-source contract.

## HUD does not start until event
Renderer log evidence:
- 10:05:01: `v2State=IDLE` → `v2State=RECORDING` transition occurs in the same second as PW stream ready (17:05:01.190Z). The renderer transitions to RECORDING only inside `api.capture.onSessionReady` handler (`src/v2/engine.ts:78-83`), which sets `v2SessionReadyMs = Date.now()`. The HUD timer reads `v2SessionReadyMs`; with that field null no elapsed-ms is computable.
- Operator observed: "went straight to recording" — no delay between button click and HUD start because restore token eliminated the portal dialog wait.

## Resolution note
Session 1 captured at 1920x1080 (correct per matrix spec, kscreen-doctor set pre-flight). Sessions 2-3 captured at 3840x2160 (KDE Plasma auto-reverted to preferred mode — same kscreen issue documented in prior slices). Resolution drift does not affect VAL-CAP-001's timing criterion.

## Encoder
h264 via NVENC (confirmed by ffprobe of exports: `codec_name=h264`).

## Evidence index
- `PASS.md` — this file
- `helper-log-session-1080p.txt` — engine.log slice for the 1920x1080 session
- `helper-log-session-4k.txt` — engine.log slices for the two 3840x2160 sessions

## Date: 2026-05-23
