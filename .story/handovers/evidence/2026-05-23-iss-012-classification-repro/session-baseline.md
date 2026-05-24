# T-037 Session Baseline

**Date:** 2026-05-24 (session started 05:21 UTC)
**Ticket:** T-037
**Goal:** Reproduce ISS-012 stuck-EXPORTING and classify boundary via T-036 logs

## Build State

- HEAD: 4e5640e Add ISS-012 renderer completion logging (T-036)
- Bundle: dist/assets/index-CRtW0lJW.js
- T-036 strings confirmed in bundle:
  - `engine subscriptions registered` ✓
  - `export.completed received` ✓
  - `stale-guard accept` ✓ (3 occurrences — completed/failed/cancelled handlers)

## Log Routing

T-036 logs route: `gs().log()` → `useStore.getState().logs` → LogPanel
NOT in `export-lifecycle.log` (that file is main-process forwarding only).
To capture: DevTools console → `useStore.getState().logs`

## Required Repro Conditions (VAL-CAP-006 style)

- Recording duration > 60s buffered
- Window source (not monitor)
- 4K if available
- Portal session active
- Avoid short monitor-mode saves

## Prior Pass (T-035)

- 2 attempts, both hit ISS-015 (SAVING→RECORDING, null snapshot ID)
- ISS-012 never reached EXPORTING in T-035

## Decision Tree

1. No `export.completed received` + valid MP4 exists + main log shows completed forwarded → delivery/subscription fault
2. `export.completed received` + `stale-guard discard` + no `stale-guard accept` → stale-guard/export_id lineage fault
3. `export.completed received` + `stale-guard accept` + `post-transition: RECORDING|IDLE` but controls disabled → Zustand/UI render-propagation fault
4. `export.completed received` + `stale-guard accept` + `post-transition: EXPORTING` → FSM transition-execution fault
5. Save never reaches EXPORTING, SAVING→RECORDING, null snapshot → ISS-015 interception → STOP
