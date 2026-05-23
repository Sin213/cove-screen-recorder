# Slice 4 Baseline State

## Date: 2026-05-23
## Monitor: DP-4 1920x1080@60 (kscreen-doctor confirmed)

## Process state
- Helper PID: 1374276 (cove-replay-engine)
- Electron PID: 1374261
- Node/Vite PID: 1374164 (port 5173)
- VITE_COVE_V2_UI=1 confirmed in process env

## Log offsets
- Engine log: 2921 lines (`~/.config/Cove Screen Recorder/logs/engine.log`)
- Export lifecycle log: 27 lines (`~/.config/Cove Screen Recorder/logs/export-lifecycle.log`)

## Recovery sessions
- 17 sessions in `/run/user/1000/cove-screen-recorder/segments/`
- RecoveryBanner expected to appear on app view

## Pre-flight verification
- ISS-008 fix (VITE_COVE_V2_UI gate): confirmed `src/App.tsx:124`
- ISS-009 fix (recovery skip/discard): confirmed `src/store.ts`, `src/v2/engine.ts:438`
- ISS-013 fix (engine ready race): commits 0c38503, f8f176d at HEAD
- Typecheck: pass
- Build: pass
- Storybloq validate: 0 errors
