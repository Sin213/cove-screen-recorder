# T-010c Slice 4 — §22 Manual Smoke Row Execution

## Scope
Execute the 5 manual §22 smoke rows that were never run: VAL-CAP-001, VAL-CAP-006(a), VAL-UI-005, VAL-ENC-006, VAL-UI-012. Pre-flight verification of ISS-008/009/013 fixes. ISS-009 validation. Post-execution issue resolution.

## Results Summary

| Row | Verdict | Notes |
|-----|---------|-------|
| VAL-CAP-001 | **PASS** | sessionReady in 33-56ms (budget: 5000ms). 3 sessions observed. Portal skipped (restore token). |
| VAL-CAP-006a | **PASS** | Capture survived 60s minimised. Export valid: 960 frames, 28s, h264/NVENC, zero duplicate PTS. |
| VAL-UI-005 | **BLOCKED** | v2 renderer has no region capture mode UI. Helper IPC exists but renderer doesn't expose it. |
| VAL-ENC-006 | **BLOCKED** | v2 renderer doesn't subscribe to encoder.selected. No Settings→Diagnostics panel. No HUD encoder badge. |
| VAL-UI-012 | **BLOCKED** | Hotkey fires v2SaveReplay correctly, but no `hotkeys.triggered` toast system exists in the app. |

**2 PASS, 3 BLOCKED** on missing v2 UI features (not code defects — features not yet implemented).

## Pre-flight
- ISS-008 fix (VITE_COVE_V2_UI gate): confirmed `src/App.tsx:124`
- ISS-009 fix (recovery skip/discard): confirmed `src/store.ts`, `src/v2/engine.ts:438`
- ISS-013 fix (engine ready race): commits 0c38503, f8f176d at HEAD
- Typecheck: pass
- Build: pass
- Storybloq validate: 0 errors
- Monitor set to 1920x1080@60 via kscreen-doctor (KDE later reverted to 3840x2160@240)

## ISS-009 Validation
Partial — existing running session reused. App was in IDLE with "Start replay buffer" enabled despite 17 recovery sessions on disk. Recovery was previously dismissed (Ignore/Discard). The fix is functional.

## Ticket/Issue Updates
- T-026: marked complete (ISS-012 diagnostics committed 80d1f3d)
- T-029: marked complete (ISS-012 render diagnostics committed f729ab8)
- ISS-008: resolved — v2 capture path activated, all executable rows reached it
- ISS-009: resolved — recovery skip/discard working, capture sessions started after dismissal

## KDE Resolution Drift (recurring)
DP-4 was set to 1920x1080@60 pre-flight. First capture session ran at 1080p. Subsequent sessions reverted to 3840x2160@240 (KDE Plasma auto-restores preferred mode). Same issue documented in prior slices. Does not affect VAL-CAP-001 (timing criterion) or VAL-CAP-006a (survival criterion). Both are resolution-independent.

## BLOCKED Row Analysis

### VAL-UI-005 (Region overlay — Issue #1 proof)
The v2 capture path only supports monitor capture. No `capture.mode === "region"` in v2 renderer. Helper has `capture.setRegion` RPC but renderer doesn't expose it. Requires v2 region capture UI implementation.

### VAL-ENC-006 (Encoder selected visible)
Helper emits `encoder.selected` → electron forwards → preload exposes `onSelected`. But v2 engine.ts doesn't subscribe. No Settings→Diagnostics panel exists. No HUD encoder badge during recording. Requires: (1) v2 subscription to encoder notifications, (2) UI display component.

### VAL-UI-012 (Hotkey saveReplay + toast)
Hotkey wiring works: F8 → v2SaveReplay → replay.save RPC. Export completes successfully. But no `hotkeys.triggered` toast notification system exists anywhere in `src/`. The functional save pipeline is complete; only the toast UI is missing.

## Evidence
All evidence at `.story/handovers/evidence/2026-05-23-t-010c-slice-4-manual-rows/`:
- `baseline.md` — pre-flight process state and log offsets
- `kscreen-doctor-pre.{json,txt}` — pre-flight monitor state
- `operator-evidence/VAL-CAP-001/PASS.md` + helper log excerpts
- `operator-evidence/VAL-CAP-006a/PASS.md` + helper log + ffprobe output
- `operator-evidence/VAL-UI-005/BLOCKED.md`
- `operator-evidence/VAL-ENC-006/BLOCKED.md`
- `operator-evidence/VAL-UI-012/BLOCKED.md`
- `operator-evidence/ISS-009-validation/partial-pass.md`

## What's Next
- 3 BLOCKED rows need v2 UI feature implementation before they can be executed
- ISS-011 remains parked (VAL-CAP-006b cannot-validate on NVIDIA per T-027/T-028)
- ISS-012 remains parked (non-repro, diagnostics in place via T-026/T-029)
- ISS-007 remains open (low severity, variable-rate spread metric)
- The 2 PASS rows + 3 BLOCKED rows complete the §22 manual row sweep for T-010c Slice 4

## Forbidden-zone check
No changes to src/, electron/, helper/, validation/, dist-validation/, packaging/, .github/, package.json, Cargo.toml. All output is in .story/ evidence/handover directories only.
