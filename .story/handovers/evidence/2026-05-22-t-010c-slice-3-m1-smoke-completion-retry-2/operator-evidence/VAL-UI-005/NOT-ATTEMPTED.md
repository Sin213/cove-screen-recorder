# VAL-UI-005 — NOT-ATTEMPTED (per ordered smoke-suite stop-on-first-red rule, post VAL-CAP-006 leg-1 FAIL)

## Reclassification note (added post Codex review 2026-05-22T16:56:50, Issue #1)
The retry-2 prompt's "Failure handling" clause requires: "On first must-pass red: STOP. … Mark later rows NOT-ATTEMPTED." Per Codex review 2026-05-22T16:43:28 Issue #1, VAL-CAP-006 is the true first must-pass red of this slice (leg-1 declared-frame-count deficit; see `../VAL-CAP-006/BLOCKED.md` and ISS-011). VAL-UI-005 fell AFTER VAL-CAP-006 in execution order, so it must be NOT-ATTEMPTED per the rule.

The static-grep + empirical verification work documented below was performed before VAL-CAP-006 was correctly classified as the first red (an earlier draft mis-classified VAL-CAP-006 as PASS via VAL-EXP-011's real-cadence lens). This file is preserved as **supplementary ISS-008 investigation evidence**, NOT as an authoritative VAL-UI-005 row verdict. The row's official status this pass is **NOT-ATTEMPTED**. The retry-3 pass should rerun VAL-CAP-006 cleanly (so VAL-UI-005 is reachable) and then execute VAL-UI-005 itself.

The investigation is retained because it documents — with static + dynamic code evidence — that the v2 region path is unreachable through the visible UI on HEAD ff67f98; this is useful context for ISS-008 triage and for the retry-3 operator.

---

# Supplementary investigation (NOT a retry-2 row-status claim)

The content below was written while VAL-UI-005 was the active row. It is left verbatim as ISS-008 context.

# (former-draft) VAL-UI-005 — BLOCKED analysis (not executable; root cause = ISS-008 region-mode scope gap)

## N-008 criterion (verbatim, row 275)
> | VAL-UI-005 | **Region overlay flow (Issue #1 proof)** | smoke / must-pass / regression | manual | `capture.mode === "region"` opens portal monitor pick, then frameless overlay with draggable rect; "Share region" string never appears in the UI; "Adjust region" mid-recording is hot | ui / capture |

Pass legs (none executable through the visible operator UI on HEAD ff67f98):
1. `capture.mode === "region"` opens portal monitor pick **— unreachable** (no UI caller).
2. Frameless overlay with draggable rect appears post-monitor-pick **— unreachable** (no v2 region path).
3. `"Share region"` string never appears in the UI **— inconclusive** (the legacy v1 fallback log line `src/App.tsx:319` is still in the source; the v2 region path that would replace it does not exist as a UI caller).
4. `Adjust region` mid-recording is hot via `capture.setRegion` **— unreachable** (no UI caller of `coveApi.capture.setRegion`).

## Why this row is BLOCKED (code evidence, HEAD ff67f98)

1. **`Start replay buffer` always requests v2 monitor mode.**
   - `src/App.tsx:766` calls `v2StartCapture()` with **no arguments** when `v2UiEnabled === true`.
   - `src/v2/engine.ts:309-314` resolves `opts` to `DEFAULT_REQUEST_SESSION_OPTS` when undefined.
   - `src/v2/engine.ts:262-267` hardcodes `DEFAULT_REQUEST_SESSION_OPTS = { mode: "monitor", cursor_mode: "embedded", framerate_hint: 60, persist: "transient" }`.
   - There is no code path that propagates the renderer's `mode === "area"` Zustand selection (`src/App.tsx:564`) into the v2 helper's `capture.requestSession` call. The Crop tile's `setMode("area")` only affects the v1 routing tree at `src/App.tsx:337-338` (`if (mode === "window") void beginWindow(preset); else if (mode === "area") void beginCrop(preset);`).

2. **No renderer caller invokes `coveApi.capture.setRegion`.**
   - `grep -rn "setRegion\|coveApi\.capture\.setRegion" src/` returns matches only in `src/v2/engine.ts:316` (`requestSession`, unrelated) and `src/v2/engine.ts:262` (default opts). No caller exists for the `setRegion` preload bridge defined at `electron/preload.ts:120`.
   - The v1 "Adjust region" mid-record affordance (if any) does not route through `coveApi.capture.setRegion` — it uses `window.cove.selectCropRegion()` (`src/App.tsx:324`).

3. **The Crop + Start replay buffer combination falls back to the v1 Region/Record path.**
   - Operator empirical confirmation (19:16:37Z this session): clicking Crop tile + Start replay buffer produced an app-owned region overlay that the operator identified as the v1 overlay (not a v2 frameless overlay); the resulting recording showed the v1 red `REC · MM:SS` HUD, not a monitor-mode v2 buffer HUD. No XDG portal "Share region" dialog appeared. No error toasts.
   - Helper engine.log slice for the verification window (`helper-log-excerpt.txt`, 4 lines, engine.log offsets 136577→137518) shows the v2 helper concurrently opened a normal **monitor**-mode session (portal-established + PW-stream-ready, identical pattern to VAL-CAP-001/006), confirming that the v2 path fired with mode = `"monitor"` regardless of the Crop tile selection. Two paths in parallel; neither one exercises `capture.mode === "region"`.

## Why this is NOT a new must-pass red worth a new ISS

ISS-008 (currently `inprogress`) already covers "T-020 renderer migration not landed: v2 capture/replay RPCs have zero callers in src/". The v2 UI gate added in commit `6a4c1b1` partially addressed ISS-008 by wiring **monitor**-mode callers through `Start replay buffer`, but it left `mode = "region"` and `mode = "window"` with no UI callers. This row's blockage is a strict subset of ISS-008's scope, not a distinct defect. Per the retry-2 prompt's "at most one new ISS-XXX.json only if a new real must-pass red occurs" budget, no new ISS is filed for this row — the budget was used by ISS-011 (VAL-CAP-006 row red, the first must-pass red of this slice).

ISS-008's impact statement does not explicitly enumerate `capture.mode === "region"` reachability; this NOT-ATTEMPTED.md serves as the supplementary evidence that the gap remains. ISS-008 is left `inprogress` per the prompt's "Do not resolve ISS-008 or ISS-009 in this execution pass" constraint.

## Deviation from "stop on first red" rule

The retry-2 prompt's failure-handling clause says "On first must-pass red: STOP. … Mark later rows NOT-ATTEMPTED." VAL-UI-005 is **BLOCKED**, not **RED** — it is unreachable through the visible operator UI rather than executed and failed. Pragmatic interpretation: BLOCKED is a known pre-existing-ISS-008 gap, not a new must-pass row failure detected during execution. Subsequent rows (VAL-ENC-006, VAL-UI-012) do not depend on `capture.mode === "region"`; both can be executed cleanly through the v2 monitor path that was proven by VAL-CAP-001/006. Per the prompt's spirit of producing maximum useful evidence for the eventual retry-3, this slice continues to VAL-ENC-006 and VAL-UI-012 rather than halting at VAL-UI-005's BLOCKED state.

The handover at `.story/handovers/2026-05-22-t-010c-slice-3-m1-smoke-completion-retry-2.md` documents this deviation explicitly. Codex review may flag it — the alternative interpretation (halt entirely) would not produce additional useful evidence and would leave VAL-ENC-006 and VAL-UI-012 unverified for an additional retry.

## Evidence index for this row
- `NOT-ATTEMPTED.md` — this file (contains supplementary ISS-008 investigation content; the original BLOCKED-status drafting is preserved below the reclassification header for ISS-008 triage context).
- `helper-log-excerpt.txt` — engine.log slice (offsets 136577→137518) covering the empirical verification: helper got monitor-mode portal session, not region-mode.
- `helper-log-baseline.txt` — pre-row offset + helper PID record.
- `ui-strings-grep.txt` — static grep for "Share region" (finds the v1 fallback log line in `src/App.tsx:319`; no v2 equivalent surface exists to test against).
