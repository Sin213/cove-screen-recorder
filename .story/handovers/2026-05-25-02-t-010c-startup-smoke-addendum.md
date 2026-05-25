# T-010c — Addendum: Uncommitted Validation Harness Changes Discovered

**Date:** 2026-05-25
**Addendum to:** 2026-05-25-01-t-010c-startup-smoke-val-cap-004-red.md

## Discovered: Pre-existing Uncommitted Source Changes

After Codex review, git status revealed TWO unstaged source modifications NOT created by this session:

### 1. `validation/display-mode.ts` (new, untracked)
A new module adding kscreen-doctor integration to automatically enforce display mode before VAL-CAP-004. Contains `enforceDisplayMode()`, `restoreDisplayMode()`, `parseKscreenOutput()`.

### 2. `validation/drivers.ts` (modified, unstaged, +55 lines)
`driveValCap004` now imports from `display-mode.ts` and calls `enforceDisplayMode()` in a "Stage 2b" block right before spawning the helper, retrying up to 3 times with verification. Comment attributes this to "ISS-021".

**These changes were NOT staged in this session per bootstrap constraints ("Forbidden: validation redesign").**

## Impact on This Session's Runs

Since `npm run validate:build` was run BEFORE this session's harness runs, the compiled `dist-validation/runner.js` ALREADY included these changes. So:

- **Run 1 (pre-modeset)**: Harness had display mode enforcement active. Enforcement apparently ran but display was still at 3840x2160 (enforcement may have failed or KDE reverted before PipeWire stream negotiated). Result: capture cell 3840x2160 = cell fail.
- **Run 2 (manual modeset + re-run)**: Display was pre-set to 1920x1080 via `kscreen-doctor` BEFORE running harness. Display mode enforcement in harness also ran but display was already correct. Capture cell matched (1920x1080 ✓). Drop rate failure (ISS-020) is independent of the display mode.

## Key Separation

**ISS-021** (KDE 4K revert): addressed by `validation/display-mode.ts` pre-existing changes — SEPARATE from this session's failing issue.

**ISS-020** (77% drop rate at 1920x1080): persists even with correct display mode. Independent failure.

## For Next Session

The uncommitted validation changes (`validation/drivers.ts`, `validation/display-mode.ts`) need a decision:
- Were they correct and intended to be committed? (Prior session left them uncommitted per constraints)
- If committed (separate ticket from T-010c), they address ISS-021 resolution mismatch
- They do NOT address ISS-020 (drop rate), which needs separate investigation

**To commit these validation changes**: They require their own ticket (not T-010c scope), Codex review, and the usual approval flow.

**To investigate ISS-020**: Re-run harness in clean environment (baloo suspended: `balooctl6 suspend`, Firefox closed, no background indexing). If drop rate persists in clean env → code regression from 927bf0d/1f558ae; if resolves → environmental.
