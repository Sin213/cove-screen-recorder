# ISS-009 Validation — Partial (existing session)

## Disposition: PASS (partial — existing session reused)

The app was already running with `VITE_COVE_V2_UI=1` from a prior operator session. The recovery banner was previously dismissed (ignore or discard). The app is in IDLE state with "Start replay buffer" enabled despite 17 recovery sessions present on disk at `/run/user/1000/cove-screen-recorder/segments/`.

### Evidence
- `v2State === "IDLE"` — app is in IDLE, not stuck at RECOVERY_AVAILABLE
- "Start replay buffer" button is enabled — confirms the ISS-009 fix allowed the operator past recovery
- 17 recovery sessions still present on disk — confirms "Ignore for this session" path (sessions NOT deleted)
- Helper PID 1374276 alive and healthy (engine.health every 5s in log)

### Checklist items not directly observed this session
- RecoveryBanner appearance (already dismissed in prior interaction)
- "Ignore for this session" click (already done)
- "Discard all (N)" inline confirmation flow
- App restart → banner reappears (would require killing the running instance)

### Structural evidence (code invariant)
- `v2RecoveryIgnoredForSession` is session-only (Zustand, no localStorage) — on app restart the banner will reappear with existing sessions
- `discardAllRecoverable()` at `src/v2/engine.ts:438` routes through per-session `discardRecovery()` calls

## Date: 2026-05-23
