# ISS-003 — Implementation: VAL-CAP-004 Negotiated-Cell Validation Rescope (D3)

**Date:** 2026-05-18
**Issue:** ISS-003 — VAL-CAP-004 capture workload mismatch (portal delivered 4K/variable-fps instead of 1080p60)
**Pass id (Storybloq):** T-023 (auto-numbered — see §10 for why this is not `T-021a`)
**Pass intent:** Implement the D3 validation-only schema + driver changes chosen in
`.story/handovers/2026-05-18-04-iss-003-design.md`.
**Owner layer:** validation
**Repo path:** /home/sin/Projects/cove-screen-recorder
**Branch:** main
**Base commit:** `94f16ac Decide VAL-CAP-004 workload semantics`

This handover is an **implementation pass only**. No T-021 rerun. No T-010c
execution. No helper / electron / src / packaging / Cargo / workflow change.
No ISS-002 work. ISS-003 stays `open` (status: implementation complete,
pending T-021 rerun for accepted evidence).

---

## 1. Chosen Path

**D3 — Rescope validation to the negotiated matrix cell and split/adjust rows.**

Per the design handover (`94f16ac`), the row schema gains additive optional
fields declaring the cell each row expects; the driver asserts the negotiated
cell against the declared cell; mismatch surfaces as a precise per-row failure
(or a clean configured skip). No capture-layer or encoder-layer Rust change.

D1, D2, D4 are rejected for the reasons recorded in the design handover and
are not revisited here.

## 2. Files Changed / Created

| File | Kind | Reason |
|---|---|---|
| `validation/rows.ts` | modified | Add additive optional `SmokeRow` fields `expectedCaptureFormat`, `expectedEncoderBackend`, `onCellMismatch`; annotate VAL-CAP-004 |
| `validation/drivers.ts` | modified | `deriveThresholdKey` accepts declared cell + declared encoder; `driveValCap004` records declared-vs-negotiated, short-circuits to a `host-cell-mismatch` skip when configured, and adds a precise cell-match `ThresholdResult` |
| `validation/types.ts` | modified | Additive `SkipReason` union member `"host-cell-mismatch"` |
| `.story/tickets/T-023.json` | new | Storybloq ticket for this pass (auto-numbered; see §10) |
| `.story/issues/ISS-003.json` | modified | Implementation-status note via `storybloq_issue_update`; `relatedTickets` adds `T-023`; status remains `open` |
| `.story/handovers/2026-05-18-05-iss-003-implementation.md` | new | This handover |

**No** file under `helper/`, `electron/`, `src/`, `packaging/`, `.github/workflows/`,
`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, or
`validation/assertions.ts` was touched. **No** prior handover was edited.
**No** other issue (`ISS-001`, `ISS-002`) was touched. **No** ticket other
than the new T-023 was touched.

## 3. Schema Changes (validation/rows.ts)

Three optional, additive fields appended to `SmokeRow`:

```ts
expectedCaptureFormat?: { width: number; height: number };
expectedEncoderBackend?: string;
onCellMismatch?: "fail" | "skip";
```

`VAL-CAP-004` is annotated with:

```ts
expectedCaptureFormat: { width: 1920, height: 1080 },
expectedEncoderBackend: "nvenc",
onCellMismatch: "fail",
```

ISS-001's `nominalFps: 60` annotation is preserved verbatim. No other row was
modified. Drivers that do not consult these new fields are unaffected
(mirroring the ISS-001 additive precedent).

## 4. Driver Changes (validation/drivers.ts)

### 4.1 `deriveThresholdKey`

Signature extended additively (two trailing optional params):

```ts
function deriveThresholdKey(
  negotiatedFormat,
  fallbackEncoderBackend,
  declaredFormat?,            // NEW (ISS-003 D3)
  declaredEncoderBackend?,    // NEW (ISS-003 D3)
): string
```

Behaviour:

- **Height (drop-tier resolution):** uses `declaredFormat.height` when present;
  otherwise the previous chain `negotiatedFormat?.height ?? 1080`. Tiering
  thresholds (`≥2160 → 4k60`, `≥1440 → 1440p60`, else `1080p60`) unchanged.
- **Encoder suffix:** when `declaredEncoderBackend` is a non-empty string,
  the suffix is taken from that value verbatim (lowercased) — no heuristics.
  Otherwise the existing string-matching fallback runs against
  `fallbackEncoderBackend` (`includes("nvenc"|"nvidia") → nvenc`,
  `includes("vaapi") → vaapi`, `includes("qsv"|"quicksync"|"intel") → qsv`,
  else `libx264`).
- Non-D3 callers (no declared params) get the previous return value
  byte-for-byte.

### 4.2 `driveValCap004`

Behavioural additions, in order:

1. **Declared resolution.** `declaredCaptureFormat = row.expectedCaptureFormat`
   and `expectedEncoderBackend = row.expectedEncoderBackend ?? "nvenc"`.
   Compute `cellsMatch` and `cellMismatch` against negotiated
   `sessionReady.params.format.width × height` (string-cast for evidence).
2. **Threshold-key resolution.** `deriveThresholdKey(captureFormat,
   expectedEncoderBackend, declaredCaptureFormat, expectedEncoderBackend)`.
   On VAL-CAP-004 the row's declared `1920x1080` + `nvenc` yield
   `1080p60-nvenc` (drop tier `0`), not the negotiated `4k60-nvenc`
   (drop tier `0.001`).
3. **thresholds.json (additive).** New keys:
   - `declaredCaptureFormat` — declared `{ width, height }` or `null`.
   - `negotiatedCaptureFormat` — alias of the negotiated `captureFormat` for
     readability (existing `captureFormat` key preserved verbatim).
   - `cellMismatch` — boolean.
   - `expectedEncoderBackend` — declared backend or default `"nvenc"`.
   Existing keys preserved: `key`, `maxDropRate`,
   `cadenceMeanToleranceFrac`, `captureFormat`, `encoderObserved`,
   `nominalFps`, `nominalSource`.
4. **Optional skip path.** When `cellMismatch === true` AND
   `row.onCellMismatch === "skip"`, the driver returns immediately with:
   - `status: "skip"`
   - `skipReason: "host-cell-mismatch"`
   - `message: "host-does-not-deliver-declared-cell: declared <WxH>, negotiated <WxH or (no sessionReady format)>"`
   The literal token `host-does-not-deliver-declared-cell` is required so the
   N-008 §18 matrix gate can recognise per-host coverage gaps.
   Default policy (`onCellMismatch === "fail"` or absent) does **not**
   short-circuit; the row continues into the threshold array and fails
   honestly via the cell-mismatch `ThresholdResult`.
5. **Cell-match ThresholdResult.** When `declaredCaptureFormat !== undefined`,
   the driver pushes the gate ahead of the drop / cadence / encoder gates:
   ```
   {
     name: "capture cell matches declared (1920x1080)",
     observed: "<NegW>x<NegH>" | "(no sessionReady format)",
     required: "1920x1080",
     passed: cellsMatch
   }
   ```
   Rows without `expectedCaptureFormat` skip this gate (other rows unaffected).
6. **Encoder backend gate.** The previous hard-coded `"nvenc"` is replaced
   with `expectedEncoderBackend`:
   ```
   {
     name: `encoder.selected backend is ${expectedEncoderBackend}`,
     observed: encoderBackend || "(not received)",
     required: expectedEncoderBackend,
     passed: encoderBackend === expectedEncoderBackend
   }
   ```
   Strict equality preserved. `encoder.selected` is still consumed from a
   real helper notification (`rpc.waitNotification("encoder.selected", ...)`)
   — never synthesised. ISS-002 still gates real backend availability
   (T-017a remains the unblock).

### 4.3 ISS-001 invariants preserved verbatim

- `CadenceNominalSource` union and the three-source resolution
  (`negotiated` → `row-config` → `missing`) unchanged.
- `nominalFps` resolution from `captureFormat.fps_num/fps_den` (when
  `fps_num>0 && fps_den>0`) → `row.nominalFps` (when positive) → `null`
  unchanged.
- `thresholds.json` still records `nominalFps` and `nominalSource`.
- The cadence gate is unchanged — it still fails honestly when
  `nominalSource === "missing"`, and uses `nominalFps` as the target
  otherwise. Tolerance constants are not loosened (see §6).

## 5. Types (validation/types.ts)

Single additive change — `SkipReason` gains the new member
`"host-cell-mismatch"`. The union is reformatted as a per-line literal list
for readability; the existing five members keep their string values byte-for-
byte. No other type change.

## 6. Tolerance Constants — UNCHANGED

`validation/assertions.ts` is **not modified** by this pass.
The following invariants hold:

| Constant | Value | Verified |
|---|---|---|
| `cadenceMeanToleranceFrac` | `0.005` | grep — unchanged |
| `cadenceP95ToleranceFrac` | `0.02` | grep — unchanged |
| `cadenceP99ToleranceFrac` | `0.05` | grep — unchanged |
| `duplicatedPtsPerMinute` | `1` | grep — unchanged |
| `captureDropRate` table | all values unchanged | grep — unchanged |
| `encoderDropRate` table | all values unchanged | grep — unchanged |
| `durationToleranceMs` | unchanged | grep — unchanged |
| `saveLatencyMaxMs`, `hudMinHz`, `exportTerminalEventsPerExportId`, `encoderFallbackMaxPerSession`, `processCleanupAfterShutdownS`, `restartLoopMaxIn60s` | unchanged | grep — unchanged |

`checkFrameCount`, `countDuplicatedPts`, `checkDuration`, `checkHudHz`,
`runFfprobe`, `extractVideoPts`, `analyzePtsCadence`, `FfprobeError` — all
unchanged. Duplicated-PTS detection logic is untouched. No tolerance was
loosened; no predicate was weakened.

## 7. Evidence-Field Map (thresholds.json)

After this pass, a `VAL-CAP-004` run on a 4K host writes:

```json
{
  "key": "1080p60-nvenc",                // declared, not negotiated
  "maxDropRate": 0,
  "cadenceMeanToleranceFrac": 0.005,
  "captureFormat": { "width": 3840, "height": 2160, "fps_num": 0, ... },
  "declaredCaptureFormat": { "width": 1920, "height": 1080 },
  "negotiatedCaptureFormat": { "width": 3840, "height": 2160, ... },
  "cellMismatch": true,
  "expectedEncoderBackend": "nvenc",
  "encoderObserved": "(not received)",
  "nominalFps": 60,
  "nominalSource": "row-config"
}
```

The underlying ISS-003 4K mismatch is preserved as evidence
(`captureFormat`, `negotiatedCaptureFormat`, `cellMismatch: true`). The
threshold key now reflects row intent (`1080p60-nvenc`). The cell-mismatch
`ThresholdResult` (`passed: false`) makes the failure precise in the per-row
report.

## 8. Verification

```
$ git status --short --untracked-files=all
 M validation/drivers.ts
 M validation/rows.ts
 M validation/types.ts
?? .story/handovers/2026-05-18-05-iss-003-implementation.md
?? .story/tickets/T-023.json
(plus the storybloq-managed .story/issues/ISS-003.json modification)

$ git diff --check     # clean

$ npm run typecheck    # clean
$ npm run validate:build  # clean
$ npm run build        # clean (vite + tsc -p tsconfig.electron.json)
```

Structural greps (all hits intentional):

```
$ grep -n "expectedCaptureFormat\|expectedEncoderBackend\|onCellMismatch" \
    validation/rows.ts validation/drivers.ts validation/types.ts
  → rows.ts: schema fields + VAL-CAP-004 annotation
  → drivers.ts: derived locals in driveValCap004 + threshold gate fields
  → types.ts: doc comment cross-references on SkipReason

$ grep -n "capture cell matches declared\|host-does-not-deliver-declared-cell" \
    validation/drivers.ts
  → drivers.ts: cell-match ThresholdResult name + skip-message token

$ grep -n "cadenceMeanToleranceFrac\|cadenceP95ToleranceFrac\|duplicatedPtsPerMinute" \
    validation/assertions.ts validation/drivers.ts
  → all preserved at original values; no new mutations
```

`cargo build` was **not** run — no Rust file changed.
No tests are present in the repo (per ISS-001's same disclaimer); no test
runner is configured to execute.

## 9. Ticket / Issue Status After This Pass

| Item | State | Note |
|---|---|---|
| ISS-001 | resolved | unchanged |
| ISS-002 | open | **unchanged** — still routed to encoder backends / T-017a |
| ISS-003 | **open** (implementation complete, pending rerun) | resolution-plan supplemented with implementation note; flip to `resolved` deferred to a T-021 rerun pass that produces a real per-row report |
| T-010a | open | unchanged |
| T-010c | blocked | unchanged |
| T-017 | complete | unchanged |
| T-021 | open | unchanged — rerun 4 still blocked by ISS-002 |
| T-022 | (pre-existing) | not touched |
| **T-023** | **open** (new) | tracks this pass; description carries the validation-only scope and Codex-review focus |

## 10. Why the Storybloq Ticket Is T-023 and Not T-021a

The implementation prompt specified `T-021a` as the recommended ticket id
(child of `T-021`, following the `T-010a..e` umbrella precedent). Storybloq
rejected the parented create with:

```
Ticket T-010c blockedBy references umbrella ticket T-021. Use leaf tickets
instead.
```

Reason: making `T-021` an umbrella (by attaching `T-021a` as a child)
invalidates `T-010c.blockedBy = [..., T-021]`. The prompt's policy is to
create a ticket **only if Storybloq structure supports it cleanly**; it does
not. Two options remained:

1. Leave no ticket and document the implementation in this handover only.
2. Create a sibling leaf ticket with an auto-numbered id (Storybloq picked
   `T-023`), preserving the audit trail of the implementation pass.

I chose (2). `T-023` references `T-021` in its description as "related"; its
scope, allowed-files list, invariants list, and Codex-review focus are the
same as the prompt's `T-021a` brief. ISS-003 `relatedTickets` is updated to
include `T-023` alongside `T-021` and `T-010a`. No umbrella was created; no
existing ticket's `blockedBy` was modified.

## 11. Out of Scope (confirmed not done)

- No helper/ Rust change.
- No electron/ change.
- No src/ change.
- No packaging/ change.
- No .github/workflows/ change.
- No `package.json` / `package-lock.json` / `Cargo.toml` / `Cargo.lock` change.
- No encoder backend implementation (ISS-002 / T-017a remains open).
- No PipeWire pod constraint or per-session format hint plumbing.
- No downscale, fps clamp, or capture-layer mode synthesis.
- No T-021 rerun.
- No T-010c execution.
- No tolerance constant loosening.
- No tolerance constant tightening.
- No predicate weakening.
- No `validation/assertions.ts` change.
- No prior handover edited.
- No issue-state flip on ISS-002.
- No status flip on T-010a, T-021, T-010c.
- No release artifact, screenshot, generated doc, or extra file.
- v1.1.0 legacy recording path untouched.
- No commits.

## 12. Invariants Preserved

- Rows must not pass without real evidence. ✓ (cell-mismatch is a real fail.)
- Workload mismatch must remain explicit. ✓ (precise cell-match
  `ThresholdResult`; mismatch also recorded as `cellMismatch: true` in
  thresholds.json.)
- Default VAL-CAP-004 cell mismatch must FAIL, not silently pass. ✓
- Optional skip path is explicit and names
  `host-does-not-deliver-declared-cell` in the message. ✓
- `encoder.selected` is a real helper event — not synthesised. ✓
- `expectedEncoderBackend` does not synthesise or imply encoder
  availability. ✓ (the gate still fails when no event arrives.)
- ISS-001 `nominalFps` / `nominalSource` behaviour preserved verbatim. ✓
- `cadenceMeanToleranceFrac` unchanged. ✓
- `cadenceP95ToleranceFrac` unchanged. ✓
- `duplicatedPtsPerMinute` unchanged. ✓
- Duplicated-PTS / frame checks unchanged. ✓
- ffprobe checks use real ffprobe output. ✓ (no change to runFfprobe /
  extractVideoPts.)
- PTS / frame checks are not synthesised. ✓
- `replay.export_start` output_path remains a final `.mp4`. ✓
- Snapshot release behaviour unchanged. ✓ (no packaging file touched.)
- `export.failed` / `export.cancelled` do not pass. ✓ (no export-driver
  edit.)
- Existing helper sockets are not killed or claimed. ✓
- Runner-owned helper uses runner-owned socket path. ✓ (unchanged.)
- ISS-002 remains open and untouched. ✓
- T-010a, T-021 remain open; T-010c remains blocked. ✓
- v1.1.0 legacy path untouched. ✓

## 13. Next Recommended Step

1. **ISS-002 / T-017a** — encoder backend implementation. Until
   `encoder.selected` is emitted with a real backend, the per-row report for
   VAL-CAP-004 will still fail on the encoder gate even after D3 lands.
2. **T-021 rerun 4** — only after both ISS-002 lands and the matrix-gate
   per-host decision is taken (either connect a 1080p60-native display or
   switch the row's `onCellMismatch` to `"skip"` on 4K-only hosts).
3. On a successful rerun whose per-row report shows the precise
   cell-mismatch gate (or the matrix-gated skip), flip ISS-003 to
   `resolved` with the rerun evidence path as the resolution.

## 14. Codex Review Focus

1. New `SmokeRow` fields are optional and purely additive — other drivers
   compile and run unchanged.
2. `VAL-CAP-004` declares `expectedCaptureFormat: {1920, 1080}` and
   `expectedEncoderBackend: "nvenc"`.
3. `deriveThresholdKey` uses the declared cell when present; non-D3 callers
   are byte-for-byte unaffected.
4. Negotiated capture format remains recorded as evidence
   (`captureFormat` preserved; `negotiatedCaptureFormat` alias added).
5. Cell mismatch is a real threshold fail by default; never a silent pass.
6. Optional skip path is explicit and the message contains the literal
   token `host-does-not-deliver-declared-cell`.
7. `expectedEncoderBackend` flows into both the threshold key and the
   encoder gate.
8. `encoder.selected` is not synthesised — still consumed from the real
   helper notification stream.
9. ISS-001 `nominalFps` / `nominalSource` behaviour preserved verbatim.
10. Tolerance constants and duplicated-PTS checks are unchanged
    (`assertions.ts` untouched).
11. No file under `helper/`, `electron/`, `src/`, `packaging/`,
    `.github/workflows/`, `package.json`, `package-lock.json`,
    `Cargo.toml`, `Cargo.lock` is changed.
12. ISS-002 remains open and untouched.
13. T-010a / T-021 / T-010c statuses unchanged.
14. No T-021 rerun and no T-010c execution occurred.
15. No prior handover was edited.
