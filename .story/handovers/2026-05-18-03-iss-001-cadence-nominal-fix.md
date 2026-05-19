# ISS-001 — VAL-CAP-004 cadence nominal handling fix

**Date:** 2026-05-18
**Issue:** ISS-001 — Validation cadence gate fails against `fps_num=0` (variable-rate PipeWire capture)
**Owner layer:** validation
**Repo path:** /home/sin/Projects/cove-screen-recorder
**Branch:** main
**Base commit:** `02a6eba Record interactive smoke failure issues`

This handover documents the ISS-001 fix. It does **not** modify any prior handover. T-021 rerun 3 verdict (RED) and ISS-002 / ISS-003 remain unchanged.

---

## Problem

`validation/drivers.ts` `driveValCap004` previously computed the cadence nominal as:

```ts
const nominalFps = captureFormat
  ? captureFormat.fps_num / captureFormat.fps_den
  : 60;
```

When the portal/PipeWire negotiation returned `fps_num=0, fps_den=1` (variable-rate capture — the only mode the compositor offered for this host's 4K monitor), this yielded a `0 fps` nominal. Every non-zero observed mean failed the cadence band — false-fail. Evidence (`thresholds.json` from T-021 rerun 3):

```json
"captureFormat": { "width": 3840, "height": 2160, "fps_num": 0, "fps_den": 1, "fourcc": "XR24" },
"encoderObserved": "(not received)",
"key": "4k60-nvenc"
```

The "5fps" portion of the failure was the harness math; the underlying 4K/~105fps workload mismatch (ISS-003) and the missing `encoder.selected` (ISS-002) remained the real product defects.

## Fix

### `validation/rows.ts` (additive)

- New optional field on `SmokeRow`: `nominalFps?: number`. Drivers that ignore the field are unaffected. The field documents the row's declared workload nominal fps and is only consulted as a fallback when the negotiated capture format reports variable-rate (`fps_num=0`).
- `VAL-CAP-004` now sets `nominalFps: 60` (the row's declared 1080p60 workload).
- No other row was given a value; no other row's behavior changes.

### `validation/drivers.ts` — `driveValCap004` only

After parsing `captureFormat`, resolve the cadence nominal:

```ts
type CadenceNominalSource = "negotiated" | "row-config" | "missing";
let nominalFps: number | null = null;
let nominalSource: CadenceNominalSource = "missing";
if (
  captureFormat &&
  captureFormat.fps_num > 0 &&
  captureFormat.fps_den > 0
) {
  nominalFps = captureFormat.fps_num / captureFormat.fps_den;
  nominalSource = "negotiated";
} else if (typeof row.nominalFps === "number" && row.nominalFps > 0) {
  nominalFps = row.nominalFps;
  nominalSource = "row-config";
}
```

`thresholds.json` now additively records `nominalFps` and `nominalSource`. Existing fields (`key`, `maxDropRate`, `cadenceMeanToleranceFrac`, `captureFormat`, `encoderObserved`) are preserved.

The cadence gate now branches three ways:

1. `nominalSource === "missing"` (neither negotiated nor row-config nominal available) → push a `ThresholdResult { name: "cadence (no nominal fps available)", observed: "<mean> fps observed", required: "row nominal fps or non-zero negotiated fps", passed: false }`. Never a silent skip; never a pass.
2. `samples.length >= 10` and nominal is present → existing band check using `THRESHOLDS.cadenceMeanToleranceFrac` (unchanged) against the resolved `nominalFps`. The gate name now includes `(nominal source=<source>)` so the source is visible in the per-row report.
3. `samples.length < 10` → existing "insufficient samples for mean check" failure (unchanged).

`meanFps` is computed once from `samples[i].observedFps` and reused.

## What is preserved

- `cadenceMeanToleranceFrac = 0.005` (unchanged)
- `cadenceP95ToleranceFrac = 0.02` (unchanged)
- `duplicatedPtsPerMinute = 1` (unchanged)
- Duplicated-PTS detection in `analyzePtsCadence` and `countDuplicatedPts` (unchanged)
- ffprobe-based PTS checks in `driveValExp010` / `driveValReg002` (unchanged)
- `replay.export_start` output_path remains a final `.mp4` (unchanged — different driver)
- Snapshot release behavior (unchanged — different driver)
- `export.failed` / `export.cancelled` non-pass semantics (unchanged)
- Helper socket / runner-owned helper semantics (unchanged)
- v1.1.0 legacy path (untouched)

## Files changed / created

| File | Kind | Notes |
|------|------|-------|
| `validation/rows.ts` | modified | Optional `nominalFps?: number` field on `SmokeRow`; set `nominalFps: 60` on `VAL-CAP-004` only |
| `validation/drivers.ts` | modified | `driveValCap004` only: resolve nominal with source tracking; write `nominalFps`/`nominalSource` into `thresholds.json`; three-way cadence gate |
| `.story/issues/ISS-001.json` | modified | Status flipped to `resolved` with resolution note (via storybloq) |
| `.story/handovers/<date>-iss-001-cadence-nominal-fix.md` | new | This handover |

No file under `helper/`, `electron/`, `src/`, `packaging/`, `.github/workflows/`, `package.json`, `package-lock.json`, `Cargo.toml`, or `Cargo.lock` was touched. No `.story/tickets/*.json` status was flipped. ISS-002 and ISS-003 were not modified.

## Verification

| Command | Result |
|---------|--------|
| `git status --short --untracked-files=all` | clean pre-edit; only `validation/drivers.ts` and `validation/rows.ts` modified post-edit (plus this handover and the ISS-001 status update) |
| `git diff --check` | clean |
| `npm run typecheck` | clean — `tsc --noEmit && tsc -p tsconfig.electron.json --noEmit && tsc -p tsconfig.validation.json --noEmit` all green |
| `npm run validate:build` | clean |
| `npm run build` | clean (vite renderer + tsc electron) |
| `grep -n nominalSource\\|nominalFps validation/{drivers,assertions,rows,types}.ts` | references present in `drivers.ts` and `rows.ts` only; pre-existing `nominalFps` locals in other drivers (`driveValExp010`/`driveValReg002`) untouched |
| `grep -n cadenceMeanToleranceFrac\\|cadenceP95ToleranceFrac\\|duplicatedPtsPerMinute validation/{drivers,assertions}.ts` | constants unchanged at their declarations in `assertions.ts`; existing usages preserved |

No test runner is configured in `package.json` (no `test` script, no vitest/jest/mocha dependency). Verification is typecheck + build + structural review per the implementation contract.

T-021 rerun 4 was **not** executed.

## Expected behavior after fix on the T-021 rerun 3 evidence case

Replaying the rerun 3 conditions through the updated driver:

- `captureFormat = { width: 3840, height: 2160, fps_num: 0, fps_den: 1 }` → negotiated branch skipped.
- `row.nominalFps = 60` → `nominalSource = "row-config"`, `nominalFps = 60`.
- `meanFps ≈ 105.328` → cadence band `[59.70, 60.30]`. `Math.abs(105.328 - 60) / 60 ≈ 0.755`, which exceeds `0.005` → **fail honestly**.
- The first-line failure now reads `cadence mean within ±0.5% of 60.00 fps (nominal source=row-config)`, observed `105.328` — pointing at the real workload mismatch (ISS-003), not at a 0fps harness artifact.
- `thresholds.json` now contains `nominalFps: 60`, `nominalSource: "row-config"`, alongside the existing `captureFormat: { ..., fps_num: 0, fps_den: 1 }` and `encoderObserved: "(not received)"` fields. Both ISS-002 and ISS-003 evidence remain visible without re-reading raw events.

The row still fails. T-021 rerun 4 remains blocked by **ISS-002** (encoder backend not implemented under T-017a — `encoder.selected` will not arrive until at least one backend probes Available) and **ISS-003** (workload mismatch — 4K variable-rate vs the row's declared 1080p60).

## Ticket / issue status

| Item | State after this pass |
|------|----------------------|
| ISS-001 | **resolved** (status flipped, resolution recorded) |
| ISS-002 | open (unchanged) — routed to helper/encoder / T-017a |
| ISS-003 | open (unchanged) — workload negotiation/decision pending |
| T-010a | open (unchanged) |
| T-021 | open (unchanged) — verdict remains RED |
| T-010c | blocked (unchanged) — still gated on T-010a, T-010b, T-021 |

## Out of scope (confirmed not done)

- No helper change (capture, encoder, transport, engine, protocol)
- No Electron / renderer / `src/` change
- No packaging / GitHub Actions / `package.json` / Cargo file change
- No PipeWire `EnumFormat` constraint change
- No T-021 rerun 4
- No T-010c execution
- No `.story/tickets/*.json` status flip
- No v1.1.0 legacy path change
- No prior handover edited
- No new test framework introduced
- No release artifact

## Next recommended step

After ISS-001:

1. **ISS-003 design decision** (planning, no code yet). Choose: (a) constrain the helper's PipeWire `EnumFormat` pod to a fixed `1920×1080@60` and accept compositor rejection as a real product gap; (b) accept the negotiated mode and add a downscale step (depends on ISS-002); (c) rescope `VAL-CAP-004` to evaluate the actually-negotiated cell per N-008 §18 and add a separate row for native 1080p60 hardware.
2. **ISS-002 implementation** under T-017a. Implement at least one encoder backend (libx264 first is the lowest-hardware-risk path). Multi-file Rust work in `helper/src/encoder/backends/`. Out of scope for the validation tab.
3. **T-021 rerun 4** only after the ISS-003 decision is implemented and ISS-002 is resolved. Goal: a clean VAL-CAP-004 verdict that reflects actual product state, not harness math.

## Codex review focus

1. Patch is confined to `validation/` (`drivers.ts`, `rows.ts`) and the ISS-001 status + this handover.
2. No `helper/`, `electron/`, `src/`, `packaging/`, workflow, `package.json`, `Cargo.*` change.
3. `fps_num=0` no longer becomes a `0 fps` nominal target.
4. Missing nominal cannot pass — the gate name `cadence (no nominal fps available)` is unconditionally `passed: false`.
5. Row-config nominal does not silently hide the workload mismatch — the band check still runs against `row.nominalFps = 60`, which fails against the observed ~105fps from a 4K capture, so ISS-003 remains visible.
6. Observed cadence evidence remains written: per-sample `observedFps` in `capture-diagnostics.json`; mean fps observed appears in the cadence `ThresholdResult.observed` field; `captureFormat` continues to appear in `thresholds.json` so the 4K resolution and `fps_num=0` are recorded.
7. `nominalSource` is transparent: written into `thresholds.json` and into the cadence gate name (`(nominal source=...)`).
8. `cadenceMeanToleranceFrac` (0.005), `cadenceP95ToleranceFrac` (0.02), and `duplicatedPtsPerMinute` (1) are unchanged at their declarations in `validation/assertions.ts`.
9. Duplicated-PTS detection (`analyzePtsCadence`, `countDuplicatedPts`) is unchanged.
10. ISS-002 and ISS-003 remain open and untouched.
11. T-010a, T-021, and T-010c ticket statuses remain unchanged.
12. No T-021 rerun was performed.
