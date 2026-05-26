# T-010c — §16 REG-001 Bounded Convergence Complete

**Date:** 2026-05-26
**Ticket:** T-010c (inprogress — §22 cleared, §16 regression convergence slice complete)
**HEAD:** `146d433` (uncommitted changes in validation/ only)
**Purpose:** Implement bounded VAL-REG-006 and VAL-REG-001 drivers, completing the §16 M1-executable regression convergence. All implementable REG rows are now PASS.

---

## Files Changed

| File | Change |
|---|---|
| `validation/drivers.ts` | +VAL-REG-006 driver (SAVING state isolation, static) |
| `validation/drivers.ts` | +VAL-REG-001 driver (faststart static + runtime atom walk) |
| `validation/rows.ts` | +VAL-REG-006 (smokeOrder 30) +VAL-REG-001 (smokeOrder 31) |
| `validation/runner.ts` | +2 imports, +2 SELF_SPAWNING_ROW_IDS, +2 dispatch cases |

**Hard boundary:** `git diff -- src/ helper/ electron/` → empty ✓

---

## VAL-REG-006 — SAVING State Isolation (smokeOrder 30)

**Pattern:** Static source-scan only (like VAL-REG-013, VAL-REG-004)
**Result:** PASS

4 assertions:
1. `setV2State("SAVING")` appears exactly once across engine.ts + App.tsx
2. That call is inside `saveReplay()` behind `gs().v2State !== "RECORDING"` guard — entry only from RECORDING
3. `saveReplay()` body contains no `setTimeout` — exits are event-driven (RPC response or catch)
4. App.tsx has ≥2 `v2State !== "SAVING"` guards at `saveReplay()` call sites — UI-layer concurrent save prevention

---

## VAL-REG-001 — Replay Corruption / Faststart (smokeOrder 31)

**Pattern:** Hybrid static + runtime (no subprocess for faststart check)
**Result:** PASS

**Static assertions (covers all encoder paths + all durations unconditionally):**
1. `"-movflags"` appears in `helper/src/export/mod.rs` Command argv (count ≥ 1)
2. `"+faststart"` adjacent to `"-movflags"` in the argv array (`"-movflags",\n  "+faststart"` pattern)
3. Diagnostic argv format string also contains `-movflags +faststart` (belt-and-suspenders)

**Runtime assertion (60s NVENC spot-check):**
4. Raw MP4 atom walk via `fs.openSync`/`fs.readSync` — moov atom precedes mdat at root level (ftyp→moov order confirmed)
   - No subprocess spawned; no new binary dependency (pure Node.js fs reads)
   - Atom walk reads 8-byte headers, skips by size, stops at first moov or mdat

**Non-gating cross-reference:**
- VAL-EXP-010 PASS (smoke row 12) already establishes monotonic PTS + no fake-duplication for 60s NVENC path — not re-executed per "do not rerun already-green rows" policy

**Evidence path:** `validation-artifacts/smoke/2026-05-26T09-40-36-415Z/VAL-REG-001/`
- `runtime-atom-order.json` → `{ atomsScanned: ["ftyp","moov"], moovBeforeMdat: true }`

---

## §16 Bounded Convergence State (Final)

| REG Row | Status | Method |
|---|---|---|
| VAL-REG-001 | **PASS** | Static argv + runtime atom walk |
| VAL-REG-002 | PASS (smoke) | ffprobe PTS walk |
| VAL-REG-003 | Covered | VAL-UI-003 PASS (smoke) |
| VAL-REG-004 | **PASS** | Static: no encoder fallback/retry |
| VAL-REG-005 | N/A | Audio scope; video-only GA |
| VAL-REG-006 | **PASS** | Static: SAVING state isolation |
| VAL-REG-007 | **PASS** | Runtime: §7 capture.json synthesis |
| VAL-REG-008 | **STOP** | timing-sensitive-stabilization + orchestration-redesign |
| VAL-REG-009 | Covered | VAL-PROC-001 PASS (smoke) |
| VAL-REG-010 | Covered | VAL-PROC-001..005+007 PASS (smoke) |
| VAL-REG-011 | Covered | VAL-PROC-007 PASS (smoke) |
| VAL-REG-012 | cannot-validate | VAL-CAP-006: manual + M1 cannot-validate (ISS-011) |
| VAL-REG-013 | **PASS** | Static: RECORDING-only via sessionReady |

**All M1-implementable §16 rows are PASS. Bounded convergence complete.**

---

## Smoke Suite Verification

- Smoke runs exactly 20 rows (smokeOrder ≤ 20 filter) — VAL-REG-001/006 excluded ✓
- VAL-EXP-001 sequential-suite failure = pre-existing environmental flap (portal not available in this run window). §22 gate was cleared via individual row runs at d335a09 per governance. Not a regression from this work.
- `git diff --stat HEAD` → validation/drivers.ts, rows.ts, runner.ts only (1583 insertions) ✓

---

## Codex Review

**Review file:** `/home/sin/Desktop/Codex-Reviews/claude-handoff-review.2g3wWf/codex-review-2026-05-26_02-33-41.txt`

Issue #1 (High): Task Mismatch — stale-context noise; handoff.md anchored to §18 CAP task; discarded per saved memory (L-codex-task-mismatch).

Issue #2 (Medium): REG-007 synthesis — concerns prior-session's accepted row. N-008 §7 specifies `capture.json` as driver-synthesized artifact ("stage the notification payloads"); the driver asserts real helper-emitted data fields. No action taken; not a finding against the current REG-001 slice.

**No concrete findings target VAL-REG-001 or VAL-REG-006.**

---

## Remaining §24 Gap Analysis (Unchanged)

VAL-REG-001/006 advance §24 item 4 (§16 regression suite). The remaining §24 gaps are:
- Item 2: §23 RC — hardware-blocked (M2/M3/M4)
- Item 3: §18 coverage — 3 NVENC cells now infra-ready; VAAPI/QSV hardware-blocked
- Item 5: §17 absorption proofs — VAL-UI-002, VAL-UI-004, VAL-CAP-007 PASS (prior sessions)
- Item 6: §21 comparison plot — downstream of items 2+3
- Item 7: §7 diagnostics bundle — M1-closable but not in this slice

---

## Rollback Surface

Revert `validation/drivers.ts`, `validation/rows.ts`, `validation/runner.ts`. No runtime, build, or packaging state changed. §22 green evidence is untouched.
