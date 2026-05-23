# ISS-013 Manual Validation

**Date:** 2026-05-23
**Commit:** 0c38503

## Steps

1. `VITE_COVE_V2_UI=1 npm run dev`
2. App launched to v2 UI on first run.
3. No DevTools `engine.restart()` workaround used.
4. RecoveryBanner rendered on first launch (engine reached ready state autonomously).
5. Clicked "Ignore for this session."
6. "Start replay buffer" became enabled.

## Result

PASS -- renderer exits BOOTING without manual intervention.
