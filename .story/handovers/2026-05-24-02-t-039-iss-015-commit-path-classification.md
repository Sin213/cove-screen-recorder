# T-039 — ISS-015 Commit-Path Classification (Segment Diagnostics)

**Date:** 2026-05-24
**Ticket:** T-039 (complete). **Issues:** ISS-015 (open, B4 classified).

## Session Goal

Implement T-039: subscribe to `onSegmentDiagnostics` in `src/v2/engine.ts`, emit per-session edge logs, append save snapshot to both `saveReplay` failure paths. Deploy, verify, run functional repro, classify ISS-015 commit-path branch per decision tree.

## Result: COMPLETE — ISS-015 Classified as B4 (Eviction / Pin-Window Mismatch)

T-039 instrumentation deployed and functional repro produced qualifying B4 classification.

**Stop condition met:** segments_committed > 0 (up to 8) but `replay.save()` consistently reports "no committed segments available to pin" → **B4: eviction / pin-window mismatch.**

## What Changed

Single file: `src/v2/engine.ts` (+55 lines).

**Added module-level state (before `initV2Engine`):**
```ts
let _lastSegDiag: Record<string, unknown> | null = null;
let _sawFragment = false;
let _sawKeyframe = false;
let _sawDurationEligible = false;
let _sawCommit = false;

function _resetSegDiagEdges() { /* clears all five */ }
```

**`capture.onSessionReady`:** added `_resetSegDiagEdges()` before `_enterRecording()`.

**`capture.onSessionLost`:** added `_resetSegDiagEdges()` before state guard.

**New subscription (after `onRecoveryAvailable`, before export events):**
```ts
subs.push(api.replay.onSegmentDiagnostics((raw) => {
  // stores _lastSegDiag, emits 4 one-time edge logs
}));
```

**Both `saveReplay` failure paths (else + catch):** append `[segment diagnostics] save snapshot:` log using `_lastSegDiag` cast to narrowed type; falls back to `segDiag=none` if null.

## Verification

1. `npm run typecheck`: PASSED (all 3 tsconfig targets)
2. Forbidden-surface audit (`git diff --name-only -- helper electron src/cove-api.d.ts src/store.ts src/v2/fsm.ts`): EMPTY
3. Diff scope (`git diff --stat`): only `src/v2/engine.ts` + `.story/**` (pre-existing story changes from T-038 pass)
4. Codex review: **CLEAN** — 8/8 checks pass, no blocking defects

## Functional Repro

**Session:** pw-session-0000-1665676-1779608771513
**Source:** monitor (Wayland portal, XR24 SHM fallback)
**Buffer:** 0.5 min (30s)

### onSegmentDiagnostics delivery: CONFIRMED

Edge logs fired correctly:
- 00:46:31: `[segment diagnostics] first fragment received`
- 00:46:31: `[segment diagnostics] first keyframe seen`
- 00:46:51: `[segment diagnostics] duration became eligible`
- 00:47:09: `[segment diagnostics] first segment committed`

### Save Attempt Results

| # | Elapsed | frags | keyframes | committed | durElig | pendDur90k | lastKfAgeMs | Result |
|---|---------|-------|-----------|-----------|---------|------------|-------------|--------|
| 1 | 4s      | 3     | 1         | 0         | false   | 4500       | 657         | FAIL   |
| 2 | 72s     | 221   | 2         | **1**     | false   | 151500     | 32493       | FAIL ← **B4** |
| 3 | 82s     | 249   | 3         | **2**     | false   | 13500      | 2679        | FAIL ← B4 |
| 4 | 346s    | 1060  | 9         | **8**     | false   | 150000     | 32563       | FAIL ← B4 |

**Qualifying repro: Attempt 2** — committed=1 > 0, pin empty → B4.

### Critical Pattern (for next-slice investigation)

`durElig=false` is PERSISTENT across all 4 attempts, including committed=8 at 5m46s.
`pendDur90k` never exceeds ~150000 (1.67s @ 90kHz), cycling with ~32.5s keyframe intervals.
`frags=1060` in 346s ≈ 3 fragments/second, suggesting ~5% real-time encode rate (static screen, frame dedup).

**Hypothesis:** helper pin predicate requires `duration_eligible=true` for the in-progress segment. Under static-screen conditions, the encoder deduplicates most frames; the pending segment accumulates ~1.67s of PTS per 32.5s wall time and never crosses the duration threshold. This would explain why committed segments remain unpinnable regardless of count.

## ISS-015 Classification Update

- T-038 (prior): rolling-buffer seal failure — named reason "no committed segments available to pin"
- T-039 (this): **B4** — segments ARE committed (up to 8), but pin consistently fails; durElig=false is the likely predicate gate; next slice should investigate helper pin logic / duration_eligible threshold

## Evidence Root

`.story/handovers/evidence/2026-05-24-iss-015-commit-path-classification/`
- `render-snapshot.txt` — full LogPanel dump, all 4 save attempts
- `operator-note.md` — session details, classification table, pattern analysis

## Tickets Changed

- T-039: complete
- ISS-015: impact updated with B4 classification + evidence path

## Commit Status

NOT committed (per task instructions — do not commit unless explicitly told).
