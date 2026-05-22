# ISS-009 — v2 recovery skip + discard-all affordances (implementation only)

## Scope
Add a safe operator path out of `RECOVERY_AVAILABLE` so `Start replay buffer` becomes reachable under `VITE_COVE_V2_UI=1` without auto-deleting helper recovery data. Implementation-only pass: no smoke / RC / Slice 3 retry, no ticket status changes, no closure of any issue, no commits.

## Current HEAD
`ffc8b0f Record T-010c Slice 3 M1 manual-row retry blocker` (unchanged across this pass).

## Files changed (allowed list only)
- `src/store.ts` — added non-persistent `v2RecoveryIgnoredForSession` slice + setter. No `KEY_*`, no `writeStored`, no `localStorage`.
- `src/v2/engine.ts` — both recovery entry points (`onRecoveryAvailable` subscriber, `_refreshRecoverableSessions`) honor `v2RecoveryIgnoredForSession` and skip the transition to `RECOVERY_AVAILABLE` when set; `v2RecoverableSessions` continues to be populated. In `_refreshRecoverableSessions`, when the flag is set AND `sessions.length > 0`, we still normalize `SAVING` / `BOOTING` / `ENGINE_DOWN` / `ENGINE_UNAVAILABLE` back to `IDLE` so a mid-session helper recovery (engine.onReady → refresh) does not leave `Start replay buffer` disabled. Two new exports: `ignoreRecoveryForSession()` and `discardAllRecoverable()`.
- `src/v2/Diagnostics.tsx` — `RecoveryBanner` extended with a footer row: `Ignore for this session` and `Discard all (N)` (two-click inline confirmation with `Confirm discard all` / `Cancel`). No modal, no backdrop, no portal, no focus trap, no blocking overlay.
- `.story/issues/ISS-009.json` — `status` flipped `open → inprogress`. No `resolution`, no `resolvedDate` set.

`git diff --stat src/store.ts src/v2/engine.ts src/v2/Diagnostics.tsx .story/issues/ISS-009.json` shows 4 files / ~92 insertions / 2 deletions.

## Codex review
- Round 1: `patch is incorrect` (1 Medium finding — Issue #1 "Ignored Recovery Can Leave Engine Stuck Down After Restart"). Saved at `/home/sin/Desktop/Codex-Reviews/codex-review-2026-05-22_09-37-25.txt`. Patched by extending the ignore-flag branch in `_refreshRecoverableSessions` to normalize `SAVING` / `BOOTING` / `ENGINE_DOWN` / `ENGINE_UNAVAILABLE` to `IDLE`. The asymmetric concern does not apply to the `onRecoveryAvailable` subscriber, which only transitions from `IDLE` → `RECOVERY_AVAILABLE`.
- Round 2: `patch is correct` (0 findings). Saved at `/home/sin/Desktop/Codex-Reviews/codex-review-2026-05-22_09-39-29.txt`.

## Behavior summary
- **Ignore for this session** — sets `v2RecoveryIgnoredForSession=true`, forces `v2State=IDLE`, emits one audit line `recovery.ignored count=N`. Does NOT call `discardRecovery`, does NOT touch helper recovery data. Flag is renderer-session-only (lives in Zustand, never persisted) so on app restart `_refreshRecoverableSessions` re-surfaces the banner if sessions still exist.
- **Discard all (N)** — first click only flips an inline confirmation row inside the banner (no state side-effects, no helper IPC). `Confirm discard all` calls `discardAllRecoverable()` which snapshots `v2RecoverableSessions`, emits one audit line `recovery.discardedAll count=N`, then sequentially calls existing `discardRecovery(session_id)` for each (which already routes through `window.coveApi.replay.discardRecoveredSession` + `_refreshRecoverableSessions`), then re-refreshes after the loop. `Cancel` clears the confirmation without any helper call.
- Per-row `Save` / `Discard` unchanged.

## Verification
- `npm run typecheck` — pass (tsc renderer + electron + validation projects).
- `npm run build` — pass (renderer 210.46 KiB / CSS 30.69 KiB; electron emit clean).
- `npm run validate:build` — pass.
- `storybloq validate` — 0 errors, 0 warnings, 0 info.
- `git diff --check` — clean.
- `git status --short` — exactly `src/store.ts`, `src/v2/engine.ts`, `src/v2/Diagnostics.tsx`, `.story/issues/ISS-009.json` (plus this handover, untracked).
- `git diff -- helper/ electron/ validation/ packaging/ dist-validation/ .github/ .story/notes/ .story/tickets/ .story/issues/ISS-007.json .story/issues/ISS-008.json` — empty.

## Manual validation checklist (to execute under `VITE_COVE_V2_UI=1`)
Implementation pass did NOT execute the §22 manual rows. The following checklist exercises the new UI path itself; it is NOT a Slice 3 retry and does NOT close ISS-008 or ISS-009.

- [ ] Launch `VITE_COVE_V2_UI=1 npm run dev` with populated helper recovery sessions.
- [ ] `RecoveryBanner` appears and `Start replay buffer` is disabled.
- [ ] Click `Ignore for this session` → banner hides, `Start replay buffer` becomes enabled.
- [ ] `Start replay buffer` triggers the v2 capture path (helper `capture.requestSession` + `startStream`; renderer transitions out of IDLE via `capture.onSessionReady`).
- [ ] Restart app → `RecoveryBanner` reappears with the same recoverable sessions (flag did not persist).
- [ ] Click `Discard all (N)` → inline confirm/cancel row appears (no modal/backdrop).
- [ ] `Cancel` → confirmation row hides; sessions still present.
- [ ] `Confirm discard all` → all recoverable sessions cleared, banner disappears, `v2State` returns to IDLE.
- [ ] In-app log includes `recovery.ignored count=N` and `recovery.discardedAll count=N`.

## ISS-009 status
**inprogress** (not resolved). No `resolution` set, no `resolvedDate` set.

ISS-009 is NOT resolved until T-010c Slice 3 retry evidence proves the five §22 manual rows (VAL-CAP-001, VAL-CAP-006, VAL-UI-005, VAL-ENC-006, VAL-UI-012) are reachable through this affordance under `VITE_COVE_V2_UI=1`. No §22 row pass claims are made by this pass.

## Untouched
- `helper/**`, `electron/**`, `src/v2/fsm.ts`, `src/recorder-client.ts`, `src/App.tsx`, `validation/**`, `dist-validation/**`, `packaging/**`, `.github/**`, `.story/notes/**`, `.story/tickets/**`, `.story/issues/ISS-007.json`, `.story/issues/ISS-008.json`, existing `.story/handovers/**`.
- T-010c / T-020 status: unchanged.
- ISS-007 / ISS-008: unchanged.
- No new IPC, helper API, preload binding, or `window.coveApi` surface.
