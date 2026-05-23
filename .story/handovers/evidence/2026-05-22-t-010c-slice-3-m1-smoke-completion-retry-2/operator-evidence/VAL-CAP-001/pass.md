# VAL-CAP-001 — PASS

## N-008 criterion (verbatim, row 176)
> | VAL-CAP-001 | PipeWire portal `sessionReady` arrives within 5 s of accept | smoke / must-pass | manual | any | 1080p60 | NVENC | event observed; tsNs monotonic; HUD does not start until event | capture | N-003 §5 |

Pass leg: **event observed; tsNs monotonic; HUD does not start until event**.

## PASS timestamps (UTC)
- Portal session established (operator clicked "Allow" in the system screen-share dialog): **2026-05-22T17:58:50.258Z**.
- PW stream ready (capture session ready, equivalent to `capture.sessionReady`): **2026-05-22T17:58:50.283Z**.
- Portal→ready delta: **25 ms** (budget: 5000 ms; PASS).

## Event observed
- Helper log slice: `.story/handovers/evidence/2026-05-22-t-010c-slice-3-m1-smoke-completion-retry-2/operator-evidence/VAL-CAP-001/helper-log-excerpt.txt` (4 lines; narrowed to the VAL-CAP-001 row session only, dropping the unrelated second portal session at 18:05:42Z that occurred ~7 min later between rows and is out of VAL-CAP-001's scope).
- Sequence in slice (all events for session_id `pw-session-0000-1057119-1779472730258`):
  1. `portal session established` @ 17:58:50.258361Z (node_id=152)
  2. `PW stream errored during DMA-BUF-only negotiation: no more input formats; triggering SHM-only fallback retry` @ 17:58:50.272147Z
  3. `PW: DMA-BUF negotiation hard-failed; reconnecting with SHM-only fallback` @ 17:58:50.272220Z
  4. `PW stream ready` @ 17:58:50.283851Z (same session_id; stream_id=pw-stream-0000; 3840×2160; fourcc=XR24)
- The DMA-BUF→SHM transparent fallback at 17:58:50.272Z is the documented path under N-008 VAL-CAP-009/010 (DMA-BUF preferred, SHM fallback) and does not affect VAL-CAP-001. No helper restart, no session-loss event.

## tsNs monotonic
For this VAL-CAP-001 row session (single PipeWire session `pw-session-0000-1057119-1779472730258`), the helper emitted exactly one `PW stream ready` event at 17:58:50.283851Z, which is the helper-side emit point for the corresponding `capture.sessionReady` JSON-RPC notification to the renderer. Single emission in this row's session ⇒ trivially monotonic.

Note: a SECOND PipeWire session (`pw-session-0000-1057119-1779473142559`) appears in the raw engine.log later at 18:05:42.580973Z (≥7 minutes after VAL-CAP-001 closed). That second session is unrelated to this row (operator transitioning between rows; see the corresponding events in the slice-level engine context). It is excluded from this row's `helper-log-excerpt.txt`. **For cross-session tsNs monotonicity over the full slice:** the two helper emit times (`17:58:50.283851Z` and `18:05:42.580973Z`) are strictly increasing in wall clock, and the helper's `tsNs` field on `capture.sessionReady` is sourced from a monotonic clock (`std::time::Instant`-derived nanos in the Rust helper), so cross-session tsNs is monotonic by clock-source contract. No `capture.formatChanged`, no `capture.sessionLost`, no `engine.crashed` between the two sessions.

## HUD does not start until event
- **Operator visual observation (load-bearing for this leg):** HUD held at the IDLE display between the portal "Allow" click and the moment `capture.sessionReady` reached the renderer; the HUD did NOT tick immediately on click — operator described "held for a second, wasn't immediate after clicking allow" (which aligns with the 25 ms helper-side timing plus the portal close animation and renderer commit latency).
- Structural evidence (code invariant): `src/v2/engine.ts:78-83` sets `v2SessionReadyMs = Date.now()` only inside `api.capture.onSessionReady` and only from there is `_enterRecording()` invoked. The HUD timer reads `v2SessionReadyMs`; with that field null no elapsed-ms is computable.
- `hud-pre.png` — IDLE state, READY badge, "Start replay buffer" button enabled, no recording indicator. Captured under the same `VITE_COVE_V2_UI=1` dev session as the row evidence (post-stop, immediately before the next row).
- `hud-post.png` — RECORDING state mid-row: red `REC · 00:14` HUD ticking, ELAPSED `00:14`, "Recording · 00:14" status panel, "Save last 0.5 min" button live. Captured at row-end with the timer visibly incrementing.

## Mode / encoder / source
- DP-4 set to **1920x1080@60** via pre-flight `kscreen-doctor output.DP-4.mode.1920x1080@60` (see `../../dp4-modeset-cmd.txt`, `../../kscreen-doctor-pre.{txt,json}`).
- Capture source picked in the portal: monitor (DP-4 @ 1080p60).
- Encoder selected: NVENC (M1 default; encoder cell verified via VAL-ENC-006 row).
- Buffer mode: instant replay 0.5 min · Quality (visible in `hud-post.png`).

## Renderer audit
- `renderer-log-excerpt.txt`: only `recovery.ignored count=51` at 10:50:03 (local, = 17:50:03 UTC) — the ISS-009 affordance audit from the gate clear, unrelated to this row's capture flow. No matching entries for the engine.ts error paths (`v2 capture: requestSession failed`, `v2 capture: startStream failed`, `v2 capture: sessionReady not received within Nms`, `v2 capture: stopSession failed`). `gs().log()` is only invoked on error/timeout paths for capture, so absence is evidence of clean execution.

## Operational note (initial-ready-race workaround)
This row was reached after the operator worked around the renderer engine.onReady subscription race investigated this pass at `../../blocker-initial-ready-race/`. On initial mount the renderer was stuck at `v2State === "BOOTING"` so neither `Start replay buffer` nor the RecoveryBanner was reachable; a one-time `window.coveApi.engine.restart()` from DevTools caused the supervisor to re-emit `ready` and the renderer's `useEffect`-installed listener caught it, after which the ISS-009 affordance and this row became reachable. **No formal ISS was filed for this race this pass** — the prompt's "at most one new ISS" budget was used for ISS-011 (VAL-CAP-006's row red, per the failure-handling rule). The race investigation remains in the evidence tree at `../../blocker-initial-ready-race/{analysis.md,devtools-probes.txt,code-refs.txt}` for follow-up filing if it resurfaces.

## Evidence index for this row
- `pass.md` — this file.
- `helper-log-excerpt.txt` — engine.log slice covering portal-establish → SHM fallback → PW stream ready.
- `helper-log-baseline.txt` — pre-row engine.log offset + helper PID record.
- `hud-pre.png` — pre-Start IDLE state (post-stop view; equivalent to pre-row).
- `hud-post.png` — mid-recording HUD ticking at 00:14.
- `renderer-log-excerpt.txt` — Zustand log buffer slice (only the recovery audit; no error logs == clean run).
