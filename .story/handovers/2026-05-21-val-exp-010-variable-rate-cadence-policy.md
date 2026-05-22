# 2026-05-21 — VAL-EXP-010 Variable-Rate Export Cadence Policy

## Context
Rerun 25 smoke: VAL-CAP-004 / VAL-SEG-003 / VAL-EXP-001 all PASS, but
VAL-EXP-010 FAILS because it hardcoded `nominalFps = 60` and applied strict
fixed-60fps gates regardless of capture mode. On the KDE PipeWire host the
helper negotiates a variable-rate stream (`capture.sessionReady.format.fps_num
= 0`); VAL-CAP-004 already mirrors this with its variable-rate envelope but
VAL-EXP-010 did not.

Rerun 25 VAL-EXP-010 metrics:
- duplicatedPtsCount = 0
- frameCount = 1560
- duration ≈ 28.5 s
- meanIntervalS = 18.284 ms → meanFps ≈ 54.69 fps
- p95 = 18.767 ms, p99 = 19.389 ms
- VAL-CAP-004 mean ≈ 54.915 fps (variable-rate envelope already passes this).

## Change
Mirror VAL-CAP-004's variable-rate cadence policy on the export side.

### `validation/drivers.ts`
- Added `CaptureFormat` interface and extended `ProduceResult.ok` to carry
  `captureFormat: CaptureFormat | null`.
- `produceStreamCopyMp4` parses `sessionReadyNotif.params.format` defensively
  and returns it (null on missing/malformed).
- `driveValExp010`:
  - Derives `nominalFps` + `nominalSource` like VAL-CAP-004
    (`negotiated` when `fps_num>0 && fps_den>0`, otherwise `row-config=60`).
  - `isVariableRate = captureFormat !== null && captureFormat.fps_num === 0`.
  - `cadencePolicy = isVariableRate && nominalSource==="row-config" ?
                     "variable-rate" : "strict"`.
  - Variable-rate path:
    - `duplicatedPtsCount` gate stays strict.
    - Mean-fps gate `[0.85·nominal .. 1.02·nominal]`.
    - Frame-count gate via `checkFrameCountVariableRate`.
    - Strict mean/p95/p99 ms gates AND strict frame-count gate kept as
      `gating: false` evidence rows.
  - Strict path: behaviour preserved exactly (the `row-config` no-format case
    still uses nominal=60 → identical to pre-policy code).
  - `allPassed` uses `t.gating === false || t.passed` so informational rows
    never gate.
  - New `exp-cadence-policy.json` evidence sidecar.

### `validation/assertions.ts`
- New `checkFrameCountVariableRate(actualCount, durationS, nominalFps)` —
  reuses `VARIABLE_RATE_CADENCE.variableRateCadenceMin/MaxFracOfNominal`;
  returns `passed, lowExpected, highExpected, actualCount, durationS,
  nominalFps`.

### `validation/drivers.cadence-policy.test.ts`
Existing 10 VAL-CAP-004 tests preserved. Added 4 PTS-shaped tests:
1. rerun-25-shaped fps_num=0 passes variable-rate envelope.
2. degenerate 5 fps fails variable-rate mean range.
3. fps_num>0 + rerun-25-shaped numbers fails strict path.
4. duplicatedPtsCount above allowance fails on variable-rate path.

All 14 tests pass.

## Untouched (explicit scope)
- helper/**
- validation/rows.ts
- validation/runner.ts
- electron/**, src/**, packaging/**, .github/**
- package.json / package-lock.json / Cargo.toml / Cargo.lock
- .story/tickets/T-021.json, T-010c.json
- .story/issues/ISS-006.json, ISS-007.json

T-021 NOT greened, T-010c NOT started, ISS-006/007 NOT closed,
duplicatedPtsCount remains strict, export generation unchanged.

## Verification
```
git status --short --untracked-files=all
 M validation/assertions.ts
 M validation/drivers.cadence-policy.test.ts
 M validation/drivers.ts

git diff --check                                         clean
cargo build -p cove-replay-engine --release              0 errors
cargo test -p cove-replay-engine --lib                   101 passed
cargo test -p cove-replay-engine --test encoder_session  28 passed
cargo test -p cove-replay-engine --test segment_buffer   7 passed
npm run typecheck                                        clean
npm run validate:build                                   clean
npm run build                                            clean
node --test dist-validation/drivers.cadence-policy.test.js
                                                         14 pass, 0 fail
```

## Codex Review
- /home/sin/Desktop/Codex-Reviews/codex-review-2026-05-21_16-29-03.txt
- Verdict: **patch is correct** (0 findings, single pass).

## Next
- Commit the policy patch (do NOT commit in this session — user instruction).
- Rerun 26 smoke once committed.
