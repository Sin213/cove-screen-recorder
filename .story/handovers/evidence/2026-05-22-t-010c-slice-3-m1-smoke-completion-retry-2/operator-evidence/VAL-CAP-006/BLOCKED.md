# VAL-CAP-006 — BLOCKED (leg 1 FAIL, leg 2 PASS)

## N-008 criterion (verbatim, row 181)
> | VAL-CAP-006 | **Minimised source 60 s — no hover dependency (Issue #3 proof)** | must-pass / regression | manual | M1 | 1080p60 | NVENC | declared frame count produced even while source window is minimised or behind another window for the full 60 s; HUD timer increments | capture | N-003 §17 c.24 |

The criterion has two legs joined by ";" — both must pass for the row to be PASS.

| leg | criterion text | status this row |
|---|---|---|
| 1 | declared frame count produced even while source window is minimised or behind another window for the full 60 s | **FAIL** — 1200 frames vs 1671 expected at declared 60 fps over 27.86 s of muxed content (28 % deficit per N-008 §6.1 line 409 formula `round(duration × declared_fps)`) |
| 2 | HUD timer increments | **PASS** — operator visual + `hud-during-minimised.png` HUD reading 01:15 (≥60 s elapsed across coverage window) |

Net row verdict: **BLOCKED** (one must-pass leg fails). An earlier draft of this evidence file claimed PASS by re-interpreting the row criterion through VAL-EXP-011's "real cadence preserved" lens (sub-60 fps source faithfully reproduced, not padded to fake 60). Codex review 2026-05-22T16:43:28 (Issue #1) correctly rejected that re-interpretation — VAL-CAP-006's own pass text demands "declared frame count produced", not "real cadence preserved", and the ffprobe numbers do not satisfy the declared-count rule. This file is the corrected verdict.

## PASS timestamps (UTC)
- VAL-CAP-006 baseline recorded: 2026-05-22T18:52:52Z (after reset out of the discarded Region/v1 attempt; engine.log offset 134695, helper PID 1057119).
- Operator clicked `Start replay buffer` (INSTANT REPLAY card, green button): inferred 2026-05-22T18:54:27Z (per helper "portal session established" timestamp).
- Helper portal session established (session 1): **2026-05-22T18:54:27.094042Z**.
- Helper PW stream ready (session 1, equivalent to `capture.sessionReady`): **2026-05-22T18:54:27.113648Z** (Δ 20 ms from portal-established; no portal dialog rendered — restore token quick-pick path, see Caveats).
- Helper portal session established (session 2; unexplained — see Caveats): **2026-05-22T18:57:17.636113Z**.
- Helper PW stream ready (session 2): **2026-05-22T18:57:17.659363Z** (Δ 23 ms).
- Operator clicked `Save last 0.5 min`: inferred 2026-05-22T18:58:50Z (per export file mtime).
- v2 export file written: 2026-05-22T18:58:50Z @ `${XDG_RUNTIME_DIR}/cove-screen-recorder/exports/exp-1779476330387946665-0003.mp4` (87.1 MB; ffprobe in `ffprobe-frame-count.txt`).
- Operator clicked `Stop buffer`: shortly after.

## Declared frame count produced — FAIL (leg 1)
- Export file ffprobe (full output in `ffprobe-frame-count.txt`):
  - `codec_name=h264`, `width=3840`, `height=2160`, `r_frame_rate=120/1`, `avg_frame_rate=6750000/156691` (= 43.08 fps computed), `duration=27.856178`, **`nb_read_frames=1200`**, `nb_read_packets=1200`.
  - `format=mov,mp4,m4a,3gp,3g2,mj2`, size 87 122 333 bytes.
- **Expected per N-008 §6.1 line 409:** `round(duration × declared_fps) = round(27.856 × 60) = 1671` frames at declared 60 fps.
- **Actual:** 1200 frames → **28 % deficit vs declared**.
- Per the row criterion's plain text ("declared frame count produced even while source window is minimised or behind another window for the full 60 s"), this leg **FAILS**. The earlier interpretation through VAL-EXP-011's "real cadence preserved" lens was incorrect — the row's own pass text demands the declared-count rule, not the real-cadence rule. The deficit may be physically explained by KWin's PipeWire screencast behavior under SHM fallback (DMA-BUF rejected — see helper slice) plus substantial compositor idle while Cove was occluded for ≥60 s of the recording window, but that explanation does not satisfy the row's criterion as written.

## HUD timer increments — PASS (leg 2)
- `hud-during-minimised.png` taken within ~2 s of restoring Cove after the coverage window: HUD reads **`REC · 01:15`** (ELAPSED `01:15`, "Recording · 01:15" status panel). 75 s of elapsed HUD time is well above the 60 s coverage threshold required by the criterion.
- Operator visual observation (load-bearing for this leg): "post-restore HUD reading: timer went up by a minute (it continued even while minimized)". Operator confirmed step 1 (pre-coverage HUD reading) and step-2 cover maneuver per row procedure, and observed continuous HUD ticking on restore.
- Structural evidence (code invariant unchanged from VAL-CAP-001): `src/v2/engine.ts:78-83` sets `v2SessionReadyMs = Date.now()` only inside `api.capture.onSessionReady`; HUD elapsed-ms reads from that field. With the v2 capture path active (helper portal+PW events confirmed), the HUD is anchored to helper-reported session readiness, not to any DOM/canvas hover state. **Issue #3 (v1 hover/DOM dependency) absorption is structurally and empirically demonstrated.**

## Renderer audit
- No new `v2 capture: ...failed:` or `v2 capture: sessionReady not received within Nms:` lines added to the renderer Zustand log buffer this row (only the carry-over `recovery.ignored count=51` audit from the gate clear). `gs().log()` is only invoked on error/timeout paths for v2 capture — silence is evidence of a clean session.

## Source / mode / capture path
- Capture source: monitor (DP-4), Mode = **Screen**, source preset "Quality – 1440p · 60fps · 20 Mbps" per UI.
- Capture path: **v2** via helper `capture.requestSession → startStream` (proven by helper portal+PW events).
- Entry point: green `Start replay buffer` button in INSTANT REPLAY card under `VITE_COVE_V2_UI=1`; v1 Record button NOT clicked this row (the prior Region-mode attempt that did click Record was discarded — see Caveat 4).
- DMA-BUF → SHM transparent fallback occurred on both portal sessions (helper log entries `PW stream errored during DMA-BUF-only negotiation` → `reconnecting with SHM-only fallback`). Documented v2 behavior under VAL-CAP-009/010; does not affect VAL-CAP-006.

## Caveats (logged for Codex review)

1. **Source resolution drift to 3840x2160@240.** Row matrix expects 1080p60, but the captured frames are 3840x2160. DP-4 was kscreen-doctor-set to 1920x1080@60 in pre-flight (slice-level `dp4-modeset-cmd.txt` + `kscreen-doctor-pre.{txt,json}`); however the live `kscreen-doctor -j` invoked at row close shows DP-4 has reverted to 3840x2160@240 — KDE-Plasma auto-restored its preferred mode at some point during the session. No `capture.formatChanged` notification in the helper slice, suggesting the reversion happened before this row's capture sessions started OR happened silently between sessions. **VAL-CAP-006's criterion text is resolution-independent** (it tests HUD continuity + frame production, not a specific resolution); the deviation is a kscreen/KDE side-effect, not a v2 capture defect. Same caveat applies retroactively to VAL-CAP-001's 1080p60 expectation: that row passed its criterion regardless.

2. **Two distinct PipeWire sessions in this row's slice (18:54:27 + 18:57:17).** Operator reported clicking `Start replay buffer` once. The second portal-session at 18:57:17 has no direct cause from the renderer side per operator account; possibilities include (a) an internal helper segment-roll or session-refresh, (b) a re-trigger from the `Save last 0.5 min` snapshot mechanism, or (c) an inadvertent UI interaction during the coverage maneuver that the operator did not register. Both sessions complete a clean portal + PW handshake within ≤23 ms; both segments dirs exist (`${XDG_RUNTIME_DIR}/cove-screen-recorder/segments/pw-session-0000-1057119-1779476067094` and `…-1779476237636`). The export file (mtime 18:58:50Z) was produced ~93 s after session 2's portal-established and likely covers the last 27.86 s of session 2's segment buffer (matches the helper's 30 s rolling buffer). The Issue #3 absorption proof is satisfied by either session — the HUD ticked across the coverage window regardless of which session was active at any given moment. Worth a follow-up investigation; does not invalidate VAL-CAP-006.

3. **`source-minimised.png` shows Cove still in the foreground at HUD `00:05`.** The operator's `spectacle -b -f` fullscreen grab was taken BEFORE they covered the Cove window, not during the actual coverage. A true coverage screenshot would have shown whatever window was layered on top of Cove. The visual evidence for coverage is therefore weaker than ideal; the load-bearing proof of the coverage maneuver is (a) the operator's verbal attestation that the maneuver was performed for ≥60 s, and (b) the post-restore HUD reading on `hud-during-minimised.png` showing 70 s of elapsed time (00:05 → 01:15) consistent with the cover-then-restore wall-clock sequence. The criterion ("source window is minimised or behind another window for the full 60 s") is functionally validated by HUD continuity across that window, but the screenshot is technically mis-timed.

4. **Prior discarded Region/v1 attempt.** Operator initially routed this row through the v1 Record button (Crop/Region mode) at ~18:42-18:43Z. That attempt produced `~/Videos/Cove Recordings/Cove_Gaming_2026-05-22_114249_705.mp4` and `..._114314_065.mp4` (operator-owned, not referenced as VAL-CAP-006 evidence; v1 MediaRecorder path per ISS-008 does not validate v2 contract). Operator reset to Screen+IDLE (engine.log offset 134695 re-baselined at 18:52:52Z) and re-executed the row entirely on the v2 path.

5. **v2 export landed in helper runtime dir, not ~/Videos.** The v2 `Save last 0.5 min` write target is `${XDG_RUNTIME_DIR}/cove-screen-recorder/exports/` — the export file referenced above. The UI "SAVED" toast visible in `hud-during-minimised.png` shows a `/home/sin/Videos/Cove Recordings/Cove_Gaming_2026_05_…` path, but `ls -la ~/Videos/Cove\ Recordings/` (run at row close) shows no new file in that directory since 11:43:22 PDT (the discarded v1 attempt). The UI toast is therefore either stale from the prior v1 save OR the v2 "Saved" UI surfaces a path that the renderer does not actually copy to. **This is a separate UI-layer concern, not the cause of leg-1 FAIL** (leg-1 FAIL is the declared-count deficit, independent of where the export landed); the v2 export file does exist (87 MB, valid h264 MP4, ffprobe-decodable) at the runtime path.

6. **Portal restore-token quick-pick.** Both portal sessions in this row's helper slice opened without rendering a XDG screen-share dialog. This is the documented v2 behavior of N-008 VAL-CAP-002 ("Quick-pick via stored restore token skips portal dialog … `capture.sessionReady` emitted") — restore token cached at `~/.local/state/cove-screen-recorder/portal-restore.json` from the VAL-CAP-001 portal accept. **Not a defect; expected v2 quick-pick path.** VAL-CAP-002 is not on retry-2's 5-row scope; no row-pass claim is made for it from this slice.

## Operational note (initial-ready-race workaround)
Same workaround as VAL-CAP-001: this row's session traces back to the `engine.restart()` workaround that cleared the initial-ready race (see `../../blocker-initial-ready-race/`). The race is investigated but not filed as a formal ISS this pass (the new-ISS budget was used for ISS-011, this row's leg-1 frame-count red). The race affected only the renderer's ability to reach the v2 path at all; it is unrelated to the leg-1 frame-count failure documented above. The row's BLOCKED verdict and ISS-011 filing stand independent of the race workaround.

## Evidence index for this row
- `BLOCKED.md` — this file.
- `helper-log-excerpt.txt` — engine.log slice covering both portal sessions (134695→136577, 8 lines).
- `helper-log-baseline.txt` — pre-row offset + helper PID record (re-baselined after the discarded v1 attempt reset).
- `ffprobe-frame-count.txt` — ffprobe output + computed interpretation + per-frame pict_type histogram.
- `hud-during-minimised.png` — HUD reads `REC · 01:15` within 2 s of restoring Cove after the coverage window (the load-bearing screenshot).
- `source-minimised.png` — fullscreen grab during the early recording period (operator-mis-timed — see Caveat 3); included for completeness.
