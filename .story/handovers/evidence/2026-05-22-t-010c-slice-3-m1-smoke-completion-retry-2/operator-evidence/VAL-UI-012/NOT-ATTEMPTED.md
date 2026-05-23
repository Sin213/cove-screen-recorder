# VAL-UI-012 — NOT-ATTEMPTED (per ordered smoke-suite stop-on-first-red rule, post VAL-CAP-006 leg-1 FAIL)

## Reclassification note (added post Codex review 2026-05-22T16:56:50, Issue #1)
The retry-2 prompt's "Failure handling" clause requires: "On first must-pass red: STOP. … Mark later rows NOT-ATTEMPTED." Per Codex review 2026-05-22T16:43:28 Issue #1, VAL-CAP-006 is the true first must-pass red (see `../VAL-CAP-006/BLOCKED.md` and ISS-011). VAL-UI-012 fell AFTER VAL-CAP-006 in execution order → NOT-ATTEMPTED.

The empirical leg-1 test below (operator pressed F8 during an active v2 buffer, new export file landed at 23:29:03Z) was performed when VAL-UI-012 was the active row. It is preserved as **supplementary investigation evidence** that the saveReplay hotkey IS functionally wired to v2 on the v2 path, NOT as a retry-2 row verdict. The row's official status this pass is **NOT-ATTEMPTED**.

---

# Supplementary investigation (NOT a retry-2 row-status claim)

# (former-draft) VAL-UI-012 — BLOCKED on leg 2 (leg 1 functionally confirmed)

## N-008 criterion (verbatim, row 282)
> | VAL-UI-012 | Hotkey `saveReplay` fires `replay.save` and shows toast | smoke / must-pass | manual | `Ctrl+Shift+R` fires save; `hotkeys.triggered` toast | ui |

The criterion has two legs joined by ";" — both must pass. The criterion's example accelerator `Ctrl+Shift+R` is illustrative; the build under test (HEAD ff67f98) binds `saveReplay` to **F8** per `src/store.ts:46` (`replay: "F8"`) and `electron/main.ts:609`, visible to the operator as "Hotkey: F8" next to `Start replay buffer` in the INSTANT REPLAY card.

| leg | criterion text | status this row |
|---|---|---|
| 1 | `Ctrl+Shift+R` (= F8 in this build) fires save | **PASS** (functionally; v2 save/export confirmed end-to-end) |
| 2 | `hotkeys.triggered` toast appears | **BLOCKED** (no toast surface exists in renderer; channel `cove/hotkeys/triggered` has no producer in main) |

Net row verdict: **BLOCKED**. Cannot mark PASS while leg 2 is unreachable.

## Leg 1 evidence — F8 fires save (PASS)

### Renderer routing (HEAD ff67f98)
- `electron/main.ts:649-651` — `globalShortcut.register(accel, () => mainWindow?.webContents.send("cove:hotkey", action))`. F8 → action="replay".
- `src/App.tsx:467-481` — `window.cove.onHotkey(action => { … if (action === "replay") { if (v2State === "RECORDING") void v2SaveReplay(replay.lengthSeconds); else if (v2State !== "SAVING" && v2State !== "EXPORTING") void saveReplay(); } })`. F8 routes to **v2SaveReplay** when v2State === "RECORDING".

### Empirical evidence
- Operator started replay buffer (v2 path) at 2026-05-22T23:28:57Z (portal session established per helper engine.log slice `helper-log-excerpt.txt`).
- Operator pressed F8 at ~23:29:00Z (HUD read ~0:00:05, per row instructions).
- New v2 export file written: `${XDG_RUNTIME_DIR}/cove-screen-recorder/exports/exp-1779492543377201773-0005.mp4` at 2026-05-22 16:29:03 PDT (= 23:29:03Z), 9 557 757 bytes. ~6 s after the F8 press. File size > 0, ISO MP4 container (consistent with the VAL-CAP-006 export at the same path). Exports dir count went from 2 → 3 (baseline `exports_dir_count_pre=2` in `helper-log-baseline.txt`).
- Operator report: "pressing F8 triggered the same save/export behavior as clicking 'Save last 0.5 min'. The recording continued running afterward and the SAVED row updated."
- HUD continued ticking after F8 (operator confirmed); recording was not interrupted — consistent with the v2 snapshot-then-export pattern (save pins a snapshot of the current buffer without stopping capture, per N-008 §6).

### Caveat: helper opened a second portal session at 23:30:33Z
Identical anomaly to VAL-CAP-006 — a second `portal session established` + `PW stream ready` event pair fires ~90 s after the first, with no clear renderer-side trigger from the operator's account. Logged for follow-up but does not affect leg 1's verdict; the save fired and the export file landed before the second portal event.

## Leg 2 evidence — toast never appears (BLOCKED)

### Static evidence (HEAD ff67f98)
- `grep -nE "toast|Toast|hotkey.*triggered" src/` → **0 matches**. No renderer-side toast component, no toast emission for hotkey events, no consumer for `cove/hotkeys/triggered`.
- `grep -nE "cove/hotkeys/triggered" electron/main.ts` → **0 matches**. The preload bridge at `electron/preload.ts:174` defines `onTriggered: cb => onCh("cove/hotkeys/triggered", cb)`, but `electron/main.ts` only emits `cove:hotkey` (legacy v1 channel, line 650), never `cove/hotkeys/triggered`. The v2 hotkey audit channel exists in the contract but no main-side caller bridges from `globalShortcut` to it.

### Empirical evidence
- Operator visual: "Toast appeared: no". Watched for ~2 s after F8 press — no toast, notification, or system tray indicator appeared.
- `toast.png` (this directory) — clean screenshot of the Cove window ~1 s after F8 press. The only visible save-related UI surface is the persistent "SAVED" status panel in the bottom-right ("● SAVED  /home/sin/Videos/Cove Recordings/Cove_Gaming_2026-05-2…"), which:
  - **Is not a transient toast** — it's a steady-state status row that persists across multiple saves.
  - **Points at a stale path** — the path string references `~/Videos/Cove Recordings/Cove_Gaming_2026-05-2…` which corresponds to the prior discarded v1 Region attempt (`Cove_Gaming_2026-05-22_114314_065.mp4` at 11:43:14 PDT). The actual F8-triggered v2 export landed at `${XDG_RUNTIME_DIR}/cove-screen-recorder/exports/exp-1779492543377201773-0005.mp4`. Same UI staleness as VAL-CAP-006 Caveat 5: the SAVED indicator does not reflect v2 save outcomes.
  
  Therefore the SAVED indicator does NOT satisfy the criterion's `hotkeys.triggered` toast requirement — it is neither hotkey-triggered (it predates the hotkey press) nor a transient toast.

## Why this is NOT a new must-pass red worth a new ISS

Same scope-gap pattern as VAL-UI-005 + VAL-ENC-006: ISS-008 covers the broader "T-020 renderer migration not landed" for v2 event consumers. The hotkey-audit IPC contract (`cove/hotkeys/triggered`, `cove/hotkeys/refused`, `cove/hotkeys/bindFailed`) exists at the preload bridge layer but has no main-side producer and no renderer-side consumer with a toast UI surface. This is a strict subset of ISS-008's scope. Per the retry-2 prompt's new-ISS budget, no new issue is filed — the budget was used by ISS-011 (VAL-CAP-006 row red). ISS-008 is left `inprogress` per the "Do not resolve ISS-008 or ISS-009" constraint.

## Adjacent UI observation (notable, not blocking)
Operator observation: "The v2 replay-buffer HUD still presents as the red 'REC · MM:SS' style recording indicator during active buffer capture, even though the flow is clearly using the v2 helper/export path (quick-pick restore token path confirmed from engine.log earlier)." The HUD style is shared between v1 and v2 recordings — there is no v2-specific visual marker on the HUD. This is a UI-discoverability observation (would benefit from a v2-specific badge to help future smoke-row operators distinguish the path without DevTools / engine.log), but it does not affect VAL-UI-012's pass criterion.

## Evidence index for this row
- `NOT-ATTEMPTED.md` — this file (contains supplementary leg-1 functional-wiring investigation; the original BLOCKED-status drafting is preserved below the reclassification header).
- `helper-log-excerpt.txt` — engine.log slice (offsets 137518→139400) showing both portal sessions and the F8-triggered save window.
- `helper-log-baseline.txt` — pre-row offset, helper PID, exports dir count baseline.
- `toast.png` — clean post-F8 Cove window state. Persistent SAVED indicator visible; no transient hotkey-triggered toast.
- `renderer-log-excerpt.txt` — narrative note (no DevTools probe rerun for this row; leg 1 evidence is on the helper + filesystem side, leg 2 evidence is the empirical absence + static grep).
