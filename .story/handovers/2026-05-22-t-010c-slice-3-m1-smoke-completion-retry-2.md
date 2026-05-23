# T-010c Slice 3 retry-2 — M1 §22 manual-row evidence (PARTIAL: 1 PASS / 1 BLOCKED-RED / 3 NOT-ATTEMPTED / 1 new ISS — in budget)

## Scope confirmation
Manual/evidence execution pass only. Re-ran the five §22 manual rows previously gated by ISS-008 + ISS-009, under `VITE_COVE_V2_UI=1 npm run dev` on M1. Did not rerun VAL-PKG-001, the rerun-27 scripted-local rows, the full §22 smoke suite, or the §23 RC suite. No source / runtime / validation / release-policy edits. ISS-007, ISS-008, ISS-009 left untouched. T-010c left open. **One new ISS filed this pass: ISS-011 (VAL-CAP-006 leg-1 declared-frame-count deficit, capture/encoder layer)** — within the prompt's "at most one new ISS-XXX.json" budget. Additionally, a renderer engine.onReady subscription race was investigated mid-pass and is documented at `…/blocker-initial-ready-race/`; that race is a real defect but is **NOT filed as a formal ISS this pass** (operator-authorized 2026-05-22; the budget was reserved for the first must-pass row red per the failure-handling rule). A follow-up pass can file the race as a new ISS if it resurfaces.

## Current HEAD
`ff67f98` — Add v2 recovery skip and discard affordances (unchanged across this pass).

## Authoritative sources (read-only)
- `.story/notes/N-008.json`
- `.story/tickets/T-010c.json`
- `.story/handovers/2026-05-22-t-010c-slice-3-m1-smoke-completion-retry.md`
- `.story/handovers/2026-05-22-iss-009-recovery-unblock.md`
- `.story/handovers/evidence/2026-05-22-t-010c-slice-2-m1-smoke-completion/VAL-PKG-001/`
- `.story/handovers/evidence/2026-05-21-t-021-mvp-smoke-rerun-27/`

## Reused-not-rerun evidence (unchanged this slice)
- `.story/handovers/evidence/2026-05-22-t-010c-slice-2-m1-smoke-completion/VAL-PKG-001/` — Slice 2 VAL-PKG-001 helper-readiness pass.
- `.story/handovers/evidence/2026-05-21-t-021-mvp-smoke-rerun-27/` — MVP scripted-local rerun-27 evidence.

## New evidence root
`.story/handovers/evidence/2026-05-22-t-010c-slice-3-m1-smoke-completion-retry-2/`

Slice-level artifacts (root):
- `kscreen-doctor-pre-before-modeset.{txt,json}` — DP-4 at 3840x2160@239.99 pre-flight.
- `dp4-modeset-cmd.txt` — `kscreen-doctor output.DP-4.mode.1920x1080@60`.
- `kscreen-doctor-pre.{txt,json}` — DP-4 at 1920x1080@60 after modeset.
- `nvidia-smi-pre.txt`, `pgrep-cove-pre.txt`, `pgrep-ffmpeg-pre.txt`, `uptime-pre.txt`, `segments-dir-pre.txt`.
- `helper-launch.txt` — launch baseline; helper PID 1037950 first reached `listening` at 2026-05-22T17:07:10Z, then operator-cycled to PID 1057119 (post engine.onReady race workaround; see `blocker-initial-ready-race/`).
- `electron-dev.txt` — `VITE_COVE_V2_UI=1 npm run dev` first session tee (clean exit code 0 at 17:13:18Z; operator relaunched independently after).
- `engine-log-session-1.txt` — engine.log slice for the first launch window.
- `recovery-ignore.txt` — ISS-009 affordance audit; `recovery.ignored count=51` at 10:50:03 PDT, captured via DOM probe against the in-app Log panel (window.useStore not exposed; switched to `.log-line` DOM probing throughout the slice).
- `recovery-ignore-pre.png` / `recovery-ignore-post.png`.
- `blocker-initial-ready-race/{analysis.md,devtools-probes.txt,code-refs.txt}` — full root-cause + workaround narrative for the renderer engine.onReady subscription race that was investigated but not filed as a formal ISS this pass (operator-authorized; follow-up pass may file if it resurfaces).
- `kscreen-doctor-post.{txt,json}` — DP-4 reverted to 3840x2160@239.99 (KDE auto-restored preferred mode mid-session; not part of any §22 assertion per prior precedent).
- `nvidia-smi-post.txt`, `pgrep-cove-post.txt`, `pgrep-ffmpeg-post.txt`, `uptime-post.txt`, `segments-dir-post.txt`.

Per-row dirs (each has its own pass.md or BLOCKED.md plus row-scoped evidence):
- `operator-evidence/VAL-CAP-001/` — pass.md + hud-pre.png + hud-post.png + helper-log-{baseline,excerpt}.txt + renderer-log-excerpt.txt.
- `operator-evidence/VAL-CAP-006/` — BLOCKED.md + source-minimised.png + hud-during-minimised.png + ffprobe-frame-count.txt + helper-log-{baseline,excerpt}.txt.
- `operator-evidence/VAL-UI-005/` — NOT-ATTEMPTED.md (with supplementary ISS-008 investigation content) + ui-strings-grep.txt + helper-log-{baseline,excerpt}.txt.
- `operator-evidence/VAL-ENC-006/` — NOT-ATTEMPTED.md (with supplementary ISS-008 investigation content) + helper-log-baseline.txt.
- `operator-evidence/VAL-UI-012/` — NOT-ATTEMPTED.md (with supplementary leg-1-functionally-wired investigation content) + toast.png + helper-log-{baseline,excerpt}.txt + renderer-log-excerpt.txt.

## Five-row table

| Row | Status | Evidence path | Notes |
|---|---|---|---|
| VAL-CAP-001 | **PASS** | `…/operator-evidence/VAL-CAP-001/pass.md` | Portal session established → PW stream ready in 25 ms (2026-05-22T17:58:50.258Z → .283Z); HUD held between portal accept and ticker start per operator visual; HUD then incremented monotonically. Helper log slice narrowed to the row's single PipeWire session (`pw-session-0000-1057119-1779472730258`); tsNs monotonic by single emission within the row. |
| VAL-CAP-006 | **BLOCKED — first must-pass red of slice** (leg 1 FAIL, leg 2 PASS) | `…/operator-evidence/VAL-CAP-006/BLOCKED.md` + **ISS-011** | Leg 1 (declared frame count produced): **FAIL** — ffprobe 1200 frames vs `round(27.86 × 60) = 1671` expected per N-008 §6.1 line 409, a 28 % deficit. Earlier draft re-interpreted via VAL-EXP-011's real-cadence lens; Codex review 2026-05-22T16:43:28 (Issue #1) correctly rejected that re-interpretation — the row's own pass text demands declared-count, not real-cadence. Leg 2 (HUD increments): PASS — HUD jumped 0:00:05 → 1:15 across coverage. Net BLOCKED. Helper log shows two portal sessions (18:54:27Z + 18:57:17Z; second unexplained); export at `${XDG_RUNTIME_DIR}/cove-screen-recorder/exports/exp-1779476330387946665-0003.mp4`. Owner-on-fail layer: capture / encoder (under SHM fallback against an occluded compositor at 4K, the helper doesn't sustain 60 fps). Filed as **ISS-011** this pass. |
| VAL-UI-005 | **NOT-ATTEMPTED** (per ordered-stop rule, post VAL-CAP-006 first red) | `…/operator-evidence/VAL-UI-005/NOT-ATTEMPTED.md` | Per the retry-2 prompt's failure-handling clause ("Mark later rows NOT-ATTEMPTED"), this row was reclassified to NOT-ATTEMPTED after Codex correctly identified VAL-CAP-006 as the first red. The investigation work performed under the earlier mis-classified row order is preserved in the file as supplementary ISS-008 context (static + dynamic evidence that the v2 region path is unreachable through the visible UI on HEAD ff67f98), NOT as a retry-2 row verdict. |
| VAL-ENC-006 | **NOT-ATTEMPTED** (per ordered-stop rule, post VAL-CAP-006 first red) | `…/operator-evidence/VAL-ENC-006/NOT-ATTEMPTED.md` | Same as above. Supplementary investigation content preserved for ISS-008 triage; no retry-2 row verdict. |
| VAL-UI-012 | **NOT-ATTEMPTED** (per ordered-stop rule, post VAL-CAP-006 first red) | `…/operator-evidence/VAL-UI-012/NOT-ATTEMPTED.md` | Same as above. The empirical F8-fires-save evidence inside is preserved as informative context (showing the hotkey is functionally wired to v2 on the v2 path), but does not count as a retry-2 row verdict because the row should not have been attempted. |

No row marked pass on false grounds. No row faked. The single red detected during ordered execution is **VAL-CAP-006 leg-1 (declared frame count deficit)** — tracked by the newly-filed **ISS-011** (capture / encoder layer; NOT a subset of ISS-008). The three subsequent rows are NOT-ATTEMPTED per the strict ordered-stop rule; their preserved investigation content documents the **broader ISS-008 scope gap** (no v2 UI callers for region/setRegion / encoder events / hotkey-triggered toast surface), which the retry-3 pass should address before VAL-UI-005 / VAL-ENC-006 / VAL-UI-012 become reachable.

## ISS-008 status
**inprogress** — unchanged this pass. The three NOT-ATTEMPTED rows (VAL-UI-005, VAL-ENC-006, VAL-UI-012) all have preserved investigation content that documents ISS-008-scope gaps (no v2 UI callers for region/setRegion / encoder events / hotkey-triggered toast surface) — useful supplementary evidence for ISS-008 triage. The reclassification of these rows from BLOCKED to NOT-ATTEMPTED was driven by the ordered-stop rule, not by a change in their underlying reachability status (which remains: still gated by ISS-008). Per the prompt's "Do not resolve ISS-008 or ISS-009 in this execution pass" constraint, no `status` / `resolution` / `resolvedDate` edits to `.story/issues/ISS-008.json`.

## ISS-009 status
**inprogress** — unchanged this pass. The "Ignore for this session" affordance was exercised once and functioned correctly (`recovery-ignore.txt` audit; 51 helper recoverable sessions preserved on disk per ISS-009 impl's non-destructive contract). VAL-CAP-001 and VAL-CAP-006 were reachable through the gate. ISS-009 is NOT resolved this pass per the prompt — resolution gated on a separate status-resolution pass after Codex agrees with the patch.

## Engine.onReady subscription race (investigated this pass; NOT filed as a formal ISS — operator-authorized 2026-05-22 to drop ISS-010)
Reproduced this session: initial mount of the renderer's `useEffect(() => initV2Engine(), [])` (src/App.tsx:99) installed the `cove/engine/ready` listener AFTER the main process had already fired its `did-finish-load` replay of `lastReadyPayload`, so v2State was stuck at "BOOTING" with no banner of any kind reachable. DevTools-driven `window.coveApi.engine.restart()` cycled the supervisor (`shuttingDown → idle → starting → ready`) so the now-subscribed listener caught the next `ready`; banner appeared; row execution unblocked. Full root-cause + reproducible probe transcript at `blocker-initial-ready-race/`. Slice 3 retry-1's blocker (ISS-009 RECOVERY_AVAILABLE gating Start) probably won the race favorably; retry-2 lost it. Bug is latent in both. **No formal ISS filed this pass** — the prompt's new-ISS budget was reserved for ISS-011 (VAL-CAP-006 row red, per the failure-handling rule). If the race resurfaces in retry-3, the operator should file it then.

## ISS-011 status (newly filed this pass — the one allowed new ISS, within budget)
**inprogress** — severity high, owner-on-fail layer **capture / encoder**, components capture+encoder+helper. Tracks VAL-CAP-006 leg-1 declared-frame-count deficit (1200 actual vs 1671 expected at declared 60 fps over 27.86 s muxed content; 28 % deficit per N-008 §6.1 line 409 formula). Test-conditions context for triage: source captured at 3840x2160 (DP-4 reverted from pre-flight 1080p60 to KDE-preferred 4K@240); DMA-BUF hard-failed on both portal sessions → SHM fallback; Cove window occluded for ≥60 s of the recording window. Re-test conditions documented in the ISS-011 impact field to disambiguate "test-environment artifact" vs "real capture/encoder defect" (rerun at confirmed 1080p60 + DMA-BUF + occluded-but-active compositor). Evidence cited from `…/operator-evidence/VAL-CAP-006/{BLOCKED.md,ffprobe-frame-count.txt,helper-log-excerpt.txt,hud-during-minimised.png,source-minimised.png}`.

## T-010c status
**open** — unchanged. No description / status / blockedBy edits to `.story/tickets/T-010c.json`.

## ISS-007 status
**unchanged** — not touched this pass.

## Pre/post snapshot paths
Pre:
- `kscreen-doctor-pre-before-modeset.{txt,json}` (DP-4 @ 3840x2160@240)
- `dp4-modeset-cmd.txt`
- `kscreen-doctor-pre.{txt,json}` (DP-4 @ 1920x1080@60 after modeset)
- `nvidia-smi-pre.txt`, `pgrep-cove-pre.txt`, `pgrep-ffmpeg-pre.txt`, `uptime-pre.txt`, `segments-dir-pre.txt`

Post:
- `kscreen-doctor-post.{txt,json}` (DP-4 reverted to 3840x2160@240 — KDE auto-restored preferred mode; same precedent as retry-1 handover line 62)
- `nvidia-smi-post.txt`, `pgrep-cove-post.txt`, `pgrep-ffmpeg-post.txt`, `uptime-post.txt`, `segments-dir-post.txt`

## Leak summary
- `pgrep cove-replay-engine` (process-name pgrep, NOT substring): **0 matches** post-quit. Helper PID 1057119 is DEAD (`kill -0` confirms).
- `pgrep electron`: **0 matches** post-quit.
- `pgrep ffmpeg`: **0 matches** post-quit (no orphan `/usr/bin/ffmpeg`).
- `engine.sock`: removed (supervisor cleanup).
- `engine.pid`: still present, contains the now-dead PID 1057119. Stale-pidfile pattern matches retry-1 precedent; supervisor handles cleanup on next start.
- Ignore-for-session was non-destructive: pre-segments-dir count 64, post-segments-dir count 75 (+11 from this slice's v2 capture sessions; all 51 original recoverable sessions preserved).
- DP-4 reverted post-Electron-quit to its KDE preferred mode (3840x2160@240) — acceptable per the §22 assertion precedent (retry-1 noted the same behavior; not part of any §22 row).

## Statement on source / runtime / validation / release-policy
No `src/**`, `helper/**`, `electron/**`, `validation/**`, `dist-validation/**`, `packaging/**`, `.github/**`, `.story/notes/**`, `.story/tickets/**`, `.story/issues/ISS-007.json`, `.story/issues/ISS-008.json`, or `.story/issues/ISS-009.json` files were modified in this execution pass.

`git diff -- src/ helper/ electron/ validation/ dist-validation/ packaging/ .github/ .story/notes/ .story/tickets/ .story/issues/ISS-007.json .story/issues/ISS-008.json .story/issues/ISS-009.json` is empty.

## Statement on issue resolution
No issues were resolved this pass. ISS-007, ISS-008, ISS-009 remain at their prior `status` values; no `resolution` or `resolvedDate` fields were set. ISS-011 was newly created at `inprogress` — the one allowed new ISS this pass, tracking VAL-CAP-006's leg-1 capture/encoder red.

## Compliance summary (final form post operator-authorized restructure)

This slice's evidence record was restructured through three Codex review iterations:
1. **2026-05-22T16:43:28 (Issue #1)** — VAL-CAP-006 reclassified from PASS to BLOCKED on leg 1 (declared-frame-count deficit, not VAL-EXP-011 real-cadence re-interpretation).
2. **2026-05-22T16:56:50 (Issue #1)** — post-VAL-CAP-006 rows (VAL-UI-005, VAL-ENC-006, VAL-UI-012) reclassified from BLOCKED to NOT-ATTEMPTED per the ordered-stop rule; ISS-011 filed for the VAL-CAP-006 row red (Issue #2).
3. **2026-05-22T17:07:28 (Issue #1)** — new-ISS budget overrun (2 ISS filed: ISS-010 race + ISS-011 row red) flagged as HIGH. Operator authorized 2026-05-22 to drop ISS-010 (preserve race investigation in evidence tree only) and keep ISS-011 (the one allowed ISS per the failure-handling rule for the first must-pass row red).

Final state — fully compliant:

**Row-classification compliance.** VAL-CAP-001 PASS; VAL-CAP-006 BLOCKED (first must-pass red, tracked by ISS-011); VAL-UI-005 / VAL-ENC-006 / VAL-UI-012 NOT-ATTEMPTED per the ordered-stop rule. The NOT-ATTEMPTED.md files preserve earlier investigation content as supplementary ISS-008 triage notes only; no retry-2 row verdict is claimed for those three rows.

**New-ISS budget compliance.** One new ISS filed: **ISS-011** (VAL-CAP-006 leg-1 capture/encoder red). The renderer engine.onReady subscription race investigated mid-pass is documented at `blocker-initial-ready-race/` as evidence only — NOT filed as a formal ISS this pass per operator authorization. The race is reproducible and structural (would have warranted ISS-010); a follow-up pass can file it if it resurfaces. ISS-007, ISS-008, ISS-009 unchanged per prompt's "Do not resolve" constraint.

Codex review is invited to verify compliance and either accept the pass or flag any remaining issues. The 2026-05-22T17:07:28 review's HIGH (budget overrun) finding is resolved by this restructure; the Low (stale BLOCKED.md self-references in NOT-ATTEMPTED.md) is resolved by editing the evidence-index lines in each NOT-ATTEMPTED.md.
