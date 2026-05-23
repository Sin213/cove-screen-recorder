# ISS-013: Engine Ready Race Resolved

**Date:** 2026-05-23
**Commit:** 0c38503

## Summary

ISS-013 reported that the renderer could miss the initial `engine.ready` event and remain stuck in BOOTING, requiring a manual `engine.restart()` from DevTools. The fix (committed as `0c38503`) reconciles current engine readiness after subscription registration via the existing `engine.version` IPC, routing both live `onReady` and reconcile through the same readiness handler.

## Validation

Manual validation confirmed first launch with `VITE_COVE_V2_UI=1 npm run dev` exits BOOTING without `engine.restart()`. RecoveryBanner rendered autonomously, and "Ignore for this session" enabled the "Start replay buffer" button.

## Evidence

- `.story/handovers/evidence/2026-05-23-iss-013-engine-ready-race-resolved/manual-validation.md`
- `.story/handovers/evidence/2026-05-23-iss-013-engine-ready-race-resolved/git-head.txt`
- `.story/handovers/evidence/2026-05-23-iss-013-engine-ready-race-resolved/git-status.txt`

## Scope

- No source/runtime code modified in this pass.
- ISS-008, ISS-009, ISS-011, ISS-012 untouched.
- T-010c not claimed as unblocked.
