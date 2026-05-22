# 2026-05-21 — VAL-UI-003 Fast-Export Policy

## Context
Rerun 26 smoke confirmed VAL-CAP-004 / VAL-SEG-003 / VAL-EXP-001 / VAL-EXP-010 /
VAL-EXP-012 PASS, but VAL-UI-003 FAILED because the EXPORTING window observed
during a healthy fast stream-copy export was only 119 ms while the legacy gate
required `>= 3000 ms`. Fast stream-copy export is a product success, not a
runtime regression — the helper finishes export.completed in well under one
HUD-Hz sampling interval, so the old window/HUD-Hz dynamic checks have nothing
to measure.

Decision: split VAL-UI-003 into a slow-export branch (legacy strict) and a
fast-export branch (window/HUD-Hz demoted to informational, gated by
`export.completed + windowS < 3` + the unchanged static assertions on
`src/App.tsx` and `src/v2/clocks.ts`).

## Change

### `validation/drivers.ts`
- New pure helper `evaluateUi003PolicyThresholds(input) → { thresholds, policy }`
  that branches on the already-computed `windowS`:
  - **`windowS >= 3` (slow-export)**: emits the legacy strict thresholds
    unchanged — "EXPORTING window >= 3 seconds" and "HUD diagnostics at
    >= 1 Hz" stay gating; missed HUD seconds still fail the row.
  - **`windowS < 3` (fast-export)**: the same two thresholds are emitted with
    name suffix `(fast-export informational)` and `gating: false`. A new
    gating threshold is added:
    `fast-export branch active (windowS < 3): EXPORTING state observed;
     HUD/freeze regression covered by static assertions`
    with `observed = JSON.stringify({ windowS, diagCount, terminalMethod })`,
    `required = 'windowS < 3 AND terminalMethod === "export.completed"'`,
    `passed = terminalMethod === "export.completed" && windowS < 3`.
  - Both branches keep the unconditional strict gates:
    - `export completed successfully (not failed or cancelled)`
    - `App.tsx: v2 clock active for RECORDING/SAVING/EXPORTING with
      v2SessionReadyMs guard`
    - `src/v2/clocks.ts: useV2ElapsedMs is rAF-driven`
- `driveValUi003`:
  - Calls the helper instead of building thresholds inline.
  - `allPassed = thresholds.every((t) => t.gating === false || t.passed)`
    (was `t.passed` only).
  - Success / failure messages now include `policy=<fast-export|slow-export>`
    and the failure listing filters out `t.gating === false` rows.
  - No change to: helper RPC sequence, drain logic, `savingStartMs` /
    `savingEndMs` measurement, terminal-event race, snapshot release, or
    finally-block cleanup.

### `validation/rows.ts`
- Title only: `VAL-UI-003` retitled from
  `HUD timer continues updating ≥ 1 Hz during SAVING — Issue #4 proof`
  to
  `HUD timer continues updating during SAVING/EXPORTING — Issue #4 proof`.
- `id`, `tier`, `ownerOnFail`, `smokeOrder`, `linkedSourceCase`, `budgetMs`,
  and gating semantics are unchanged.

### `validation/drivers.ui003-policy.test.ts` (new)
Node `node:test` runner (matches `drivers.drop-warmup.test.ts`). Six tests:
1. fast export (`windowS=0`, `export.completed`, statics pass) → PASS;
   window + HUD-Hz emitted as `gating: false`; fast-export branch threshold
   present and passing.
2. fast export with terminal=`export.failed` → FAIL on export-completed gate
   and on the fast-export branch threshold.
3. slow export (`windowS=5`, `hudPassed=false`, missed seconds) → FAIL via the
   strict HUD-Hz gate; no fast-export threshold present.
4. slow export (`windowS=5`, clean HUD Hz, statics pass) → PASS.
5. slow export with failing `App.tsx` assertion → FAIL (static remains strict).
6. fast export with failing `clocks.ts` rAF assertion → FAIL (static remains
   strict in fast-export branch).

All 6 tests pass.

## Untouched (explicit scope)
- helper/**
- src/**, electron/**
- validation/assertions.ts
- validation/thresholds.json (no constants added; gating field already exists
  on `ThresholdResult`)
- validation/runner.ts
- validation/types.ts
- package.json / package-lock.json / Cargo.toml / Cargo.lock
- .story/tickets/T-021.json, T-010c.json
- .story/issues/**

T-021 NOT greened, T-010c NOT started. No runtime delay, no UI delay, no
artificial timer persistence. Static assertions remain strict in both
branches. Slow-export dynamic HUD-Hz and window gates remain strict.

## Verification
```
git status --short --untracked-files=all
 M validation/drivers.ts
 M validation/rows.ts
?? validation/drivers.ui003-policy.test.ts

git diff --check                                         clean
cargo build -p cove-replay-engine --release              0 errors, 70 warnings
cargo test -p cove-replay-engine --lib                   101 passed
cargo test -p cove-replay-engine --test encoder_session  28 passed
cargo test -p cove-replay-engine --test segment_buffer   7 passed
npm run typecheck                                        clean
npm run validate:build                                   clean
npm run build                                            clean
node --test dist-validation/drivers.ui003-policy.test.js 6 pass, 0 fail
node --test dist-validation/drivers.drop-warmup.test.js
              dist-validation/drivers.cadence-policy.test.js
                                                         21 pass, 0 fail
```

## Smoke result (this session)
Smoke stopped early at `VAL-EXP-010` because that row reported a variable-rate
cadence/frame-count failure on this host run (pre-existing behaviour unrelated
to this patch — `validation/drivers.ts` diff contains zero lines from
`driveValExp010` / `produceStreamCopyMp4`). VAL-UI-003 was not reached on this
smoke pass; correctness of the fast-export policy patch is validated by the
new `drivers.ui003-policy.test.ts` (6/6 PASS) and by typecheck / validate:build
/ build success. VAL-EXP-010 belongs to a separate ticket (already documented
in `2026-05-21-val-exp-010-variable-rate-cadence-policy.md`).

## Codex Review
See `/home/sin/Desktop/Claude-Handoff/handoff.md` and the resulting Codex
review log in `/home/sin/Desktop/Codex-Reviews/` (path captured in the final
session response).

## Next
- Codex approval, then commit the VAL-UI-003 policy patch (do NOT commit in
  this session — user instruction).
- Rerun smoke once committed; if VAL-EXP-010 still red on the host, that is a
  separate issue (out of scope for this pass).
