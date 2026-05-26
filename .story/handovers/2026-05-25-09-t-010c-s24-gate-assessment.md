# T-010c — §24 Gate Assessment

**Date:** 2026-05-25
**Ticket:** T-010c (inprogress — §22 cleared, §24 governance assessment)
**HEAD:** `3763ae1` — Finalize T-010c §22 smoke governance state
**Purpose:** Release governance adjudication of N-008 §24 items 1–7 against existing evidence only. No new execution. No new infrastructure. No runtime changes.

**Evidence locality note:** `validation-artifacts/` is gitignored and exists on local disk only. Referenced `validation-artifacts/` paths are authoritative on the M1 execution host but absent from a clean checkout. The prior handover `2026-05-25-08-t-010c-s23-m1-hard-stop-infrastructure-gap.md` was absent from HEAD `3763ae1` (untracked at that point) and is committed alongside this assessment.

---

## §24 Item-by-Item Verdicts

### Item 1 — §22 Smoke Suite Green on M1

**Verdict:** GREEN
**Blocker class:** already-satisfied
**Evidence:**
- All §22 scripted must-pass rows PASS on HEAD `d335a09`. Manual rows accepted per §22 matrix (SKIP/manual: VAL-CAP-001, VAL-CAP-006, VAL-UI-005, VAL-ENC-006, VAL-UI-012). ISS-020/021/022/023 resolved and committed.
- `validation-artifacts/smoke/2026-05-26T00-31-39-742Z/VAL-EXP-010/` (local disk)
- `validation-artifacts/smoke/2026-05-26T00-33-05-221Z/VAL-EXP-012/` (local disk)
- `validation-artifacts/smoke/2026-05-26T00-16-32-432Z/VAL-REG-002/` (local disk)
- Full row record: handover `2026-05-25-07-t-010c-s22-gate-cleared.md`

**Gap:** None.
**M1-closable:** N/A — already satisfied.
**Hardware-blocked:** No.
**Governance-only:** No.
**Post-release viable:** N/A.

---

### Item 2 — §23 RC Must-Pass Rows Green on M1+M2+M3+M4

**Verdict:** RED
**Blocker class:** runner-row-missing (M1 sub-portion) + hardware-blocked (M2/M3/M4 sub-portion)

**Evidence:**
- M1 §23 hard-stop evidence: handover `2026-05-25-08-t-010c-s23-m1-hard-stop-infrastructure-gap.md` (committed alongside this assessment)
- `rg "VAL-REG-001|VAL-REG-004|VAL-CAP-007|VAL-UI-002|VAL-UI-004|libx264|1440p" validation/rows.ts validation/runner.ts` → 0 matches
- Runner exclusively covers the 20-row §22 smoke set; no §23 target rows exist.

**Gap description:**
- M1: No §23 rows or drivers exist in `validation/rows.ts` / `validation/drivers.ts` for any §23 target surface.
- M2/M3/M4: Hardware machines not accessible; multi-machine RC execution not scheduled.

**M1-closable:** Partial — M1 sub-gap is closable once §23-tier rows and drivers are added. M2/M3/M4 requires hardware.
**Hardware-blocked:** YES (M2/M3/M4 required for full 4-machine RC).
**Governance-only:** No.
**Post-release viable:** No — must-pass §24 gate item.

---

### Item 3 — §18 Resolution × Encoder Coverage Gate

**Verdict:** PARTIAL
**Blocker class:** runner-row-missing (NVENC cells) + hardware-blocked (VAAPI/QSV cells)

**Evidence (satisfied):**
- 1080p60×NVENC: CONFIRMED via §22 VAL-CAP-004. `encoder-selected.json` (local disk) at `validation-artifacts/smoke/2026-05-25T21-56-49-317Z/VAL-CAP-004/encoder-selected.json` → `backend=nvenc, codec=h264, 1920×1080`.

**Per-cell gap table:**

| Cell | Status | Gap class |
|---|---|---|
| 1080p60 × NVENC | confirmed via §22 VAL-CAP-004 | already-satisfied |
| 1080p60 × VAAPI | no evidence | hardware-blocked (M2/M3) |
| 1080p60 × QSV | no evidence | hardware-blocked (M3) |
| 1080p60 × libx264 | no row/driver | runner-row-missing |
| 1440p60 × NVENC | no row/driver | runner-row-missing |
| 1440p60 × VAAPI | no evidence | hardware-blocked (M2/M3) |
| 1440p60 × QSV | no evidence | hardware-blocked (M3) |
| 4K60 × NVENC | no row/driver | runner-row-missing |
| 4K60 × VAAPI | no evidence | hardware-blocked (M2/M3) |
| 4K60 × QSV | no evidence | hardware-blocked (M3) |

**M1-closable:** 3 cells — 1080p60×libx264, 1440p60×NVENC, 4K60×NVENC — once rows and drivers exist.
**Hardware-blocked:** YES — 6 of 10 must-pass cells (all VAAPI/QSV).
**Governance-only:** No.
**Post-release viable:** No — §24 item 3 is must-pass.

---

### Item 4 — §16 v1.1.0 Regression Suite Green

**Verdict:** PARTIAL
**Blocker class:** already-satisfied (5 rows) + runner-row-missing (6 rows)

**Satisfied via §22 evidence (local disk):**

| Row | §22 evidence path |
|---|---|
| VAL-REG-002 | `smoke/2026-05-26T00-16-32-432Z/VAL-REG-002/` |
| VAL-REG-003 | covered by VAL-UI-003 §22 `smoke/2026-05-25T23-33-20-183Z/` |
| VAL-REG-009 | covered by VAL-PROC-001 §22 `smoke/2026-05-25T23-34-18-071Z/` |
| VAL-REG-010 | covered by VAL-PROC-001..007 §22 (multiple dirs) |
| VAL-REG-011 | covered by VAL-PROC-007 §22 `smoke/2026-05-25T23-34-47-642Z/` |

**Unsatisfied rows:**

| Row | Gap class |
|---|---|
| VAL-REG-001 | runner-row-missing (needs EXP-009 + 5-min variant) |
| VAL-REG-004 | runner-row-missing (needs ENC-008/011) |
| VAL-REG-006 | runner-row-missing (needs UI-001) |
| VAL-REG-007 | runner-row-missing (capture.json absent from runner output) |
| VAL-REG-008 | runner-row-missing (needs EXP-011) |
| VAL-REG-013 | runner-row-missing (needs UI-002) |

**M1-closable:** YES — all 6 rows once their driver dependencies exist.
**Hardware-blocked:** No.
**Governance-only:** No.
**Post-release viable:** No — must-pass regression suite.

---

### Item 5 — §17 Issue #1/#3/#4 Absorption Proofs Green

**Verdict:** RED
**Blocker class:** runner-row-missing (3 rows) + manual-only/feature-blocked (1 row)

**Evidence:** None for any §17 row.
- `rg "VAL-CAP-007|VAL-UI-002|VAL-UI-004" validation/rows.ts` → 0 matches (rows absent from runner).
- VAL-UI-005: row EXISTS in `validation/rows.ts` (line 153) as a manual must-pass row. It was SKIP/manual in §22. Gap is feature readiness, not row absence.

**Per-row gap table:**

| Row | Issue proved | Row in rows.ts | Gap class |
|---|---|---|---|
| VAL-CAP-007 | Issue #3 structural proof | No | runner-row-missing |
| VAL-UI-002 | Issue #1 structural proof | No | runner-row-missing |
| VAL-UI-004 | Issue #4 structural proof | No | runner-row-missing |
| VAL-UI-005 | Issue #1 region capture mode | Yes (manual, line 153) | manual-only + feature-blocked (region capture UI absent from v2 renderer; per slice-4 handover 2026-05-23) |

**M1-closable:** Partial — VAL-CAP-007/UI-002/UI-004 closable once rows and drivers exist. VAL-UI-005 requires region capture UI feature implementation first.
**Hardware-blocked:** No.
**Governance-only:** No.
**Post-release viable:** No — must-pass absorption proofs.

---

### Item 6 — §21 v1.1.0 vs v2.0.0 Comparison Plot Produced

**Verdict:** RED
**Blocker class:** runner-row-missing (downstream dependency on items 2 + 3)

**Evidence:** No runner support for L-MOTION-60 benchmark rows. No 1440p/4K run outputs exist. Prerequisite: items 2 and 3 must produce 1440p/4K pass evidence before the comparison can be plotted.

**Gap description:** No comparison-plot rows in runner. Plot cannot be produced without prior 1440p/4K run execution. VAAPI/QSV comparison segments also require M2/M3 hardware.

**M1-closable:** Partial — M1-class NVENC comparison segments closable once rows exist; VAAPI/QSV segments hardware-blocked.
**Hardware-blocked:** Partial — VAAPI/QSV comparison segments require M2/M3 hardware.
**Governance-only:** No.
**Post-release viable:** No — §24 item 6 is explicitly required ("produced").

---

### Item 7 — Diagnostics Bundle Produced + Redaction Verified

**Verdict:** RED
**Blocker class:** runner-row-missing (driver-level collection absent)

**Evidence:**
- Partial NVENC encoder confirmation only: `encoder-selected.json` (local disk) at `validation-artifacts/smoke/2026-05-25T21-56-49-317Z/VAL-CAP-004/encoder-selected.json` → `backend=nvenc`. This is NOT the §7 `engine.diagnosticsBundlePath` bundle format.
- `rg "diagnosticsBundlePath" validation/` → 0 matches. No driver calls this RPC.

**Gap description:** §7 requires a full diagnostics bundle ZIP per encoder path with redaction verified against N-007 §16 (paths above recording directory redacted — VAL-DIAG-002). The `engine.diagnosticsBundlePath` RPC is never called by any current driver; no bundle has been collected or redaction-checked.

**M1-closable:** YES — driver modification to call `engine.diagnosticsBundlePath`, copy output, and assert N-007 §16 redaction rule.
**Hardware-blocked:** No.
**Governance-only:** No.
**Post-release viable:** No — §24 item 7 is must-pass.

---

## Summary Tables

### Release-Critical Blockers

| Item | Verdict | Primary gap class | M1-closable | HW-blocked |
|---|---|---|---|---|
| 1. §22 smoke | GREEN | already-satisfied | N/A | No |
| 2. §23 RC suite | RED | runner-row-missing + hardware-blocked | Partial | YES (M2/M3/M4) |
| 3. §18 coverage gate | PARTIAL | runner-row-missing + hardware-blocked | 3 NVENC cells | YES (6 VAAPI/QSV cells) |
| 4. §16 regression suite | PARTIAL | runner-row-missing | YES (6 rows) | No |
| 5. §17 absorption proofs | RED | runner-row-missing + feature-blocked | Partial (3 rows) | No |
| 6. §21 comparison plot | RED | runner-row-missing | Partial | Partial |
| 7. §7 diagnostics bundle | RED | runner-row-missing | YES | No |

### M1-Only Executable Remaining Work (Once Infrastructure Exists)

All require new row/driver additions to `validation/rows.ts` / `validation/drivers.ts` before execution is possible:

- §16: VAL-REG-001, VAL-REG-004, VAL-REG-006, VAL-REG-007, VAL-REG-008, VAL-REG-013 (6 rows)
- §17: VAL-CAP-007, VAL-UI-002, VAL-UI-004 (3 new rows; VAL-UI-005 exists at row line 153 — needs feature work only)
- §18: 1080p60×libx264, 1440p60×NVENC, 4K60×NVENC (3 cells)
- §7: diagnostics bundle driver (1 driver addition/modification)
- §23 M1 sub-portion: new §23-tier rows covering the above surfaces

### Hardware-Blocked Surfaces

| Surface | Hardware required | Blocking items |
|---|---|---|
| §23 M2/M3/M4 execution | Dedicated RC machines | Item 2 |
| §18 VAAPI cells (1080p/1440p/4K) | AMD/Intel GPU machine (M2/M3) | Items 3, 6 |
| §18 QSV cells (1080p/1440p/4K) | Intel QSV machine (M3) | Items 3, 6 |
| §21 VAAPI/QSV comparison segments | Same as §18 VAAPI/QSV | Item 6 |

Hardware acquisition/scheduling is a project-level decision outside T-010c execution scope.

### Governance Decision Surface

1. **§22 cross-coverage acceptance for §16**: Accept §22 PASS evidence for VAL-REG-002/003/009/010/011 as satisfying §16 requirements for those rows. Handover `2026-05-25-07-t-010c-s22-gate-cleared.md` records this; explicit §24-level confirmation pending.

2. **cannot-validate disposition for VAL-CAP-006**: Per N-008 §26 policy, VAL-CAP-006 is adjudicated `cannot-validate` on M1 NVIDIA/KDE Plasma 6/Wayland stack (ISS-011 evidence, local disk). T-028 (AMD/Intel DMA-BUF) is the tracking vehicle. No new action required — governance record established.

3. **Hardware-blocked §18 VAAPI/QSV release scope**: Determine whether hardware-blocked cells constitute a GA blocker or are waivable for the M1-NVENC-primary release scope. This is a project-level release decision, not an evidence gap. N-008 §24 item 3 lists them as must-pass; scope reduction requires explicit governance acknowledgement.

4. **Hardware-blocked §23 M2/M3/M4 release scope**: Same determination — full 4-machine RC matrix requirement vs. M1-gated GA. If M2/M3/M4 is waived, item 2 becomes partially closable on M1 alone.

### Optional Confidence Improvements (Not Release Blockers)

- **ISS-011** (VAL-CAP-006 frame-count deficit, SHM fallback): Already deferred post-GA. No action needed.
- **ISS-012** (export FSM stuck in EXPORTING): Already deferred post-GA. Not reproducible in controlled runs. No action needed.
- **1080p60×NVENC §18 full-run evidence**: §22 confirms NVENC encoder selection. A full §23 run would upgrade this cell from partial-confirmation to full evidence. Optional upgrade, not a blocker.

### Post-Release Candidates

- Item 10 (release notes from matrix output): T-010e scope; downstream of T-010c completion.
- ISS-011, ISS-012: Tracked post-GA storybloq issues per §24 footnote policy.
- N-008 §25 automation: future CI ticket; out of scope for this release.

---

## Single Highest-Priority Release-Critical Action

**Build the missing validation row and driver infrastructure for M1-executable §24 targets (items 4, 5-partial, 7, and the M1 sub-portions of items 2, 3, 6).**

This is the single gate blocking all M1-closable §24 items. Items 4, 5 (partial), 7, and the M1 sub-portions of 2, 3, and 6 all share one root cause: no rows or drivers exist in `validation/rows.ts` for any §23/§16/§17/§18 target surface beyond the §22 smoke set. Resolving this unblocks the maximum number of §24 items with zero hardware dependency.

Hardware procurement (M2/M3/M4) is a separate track that does not need to gate the M1-executable work and should proceed in parallel.

---

## Verification State

- `git diff -- src/ helper/ electron/ validation/` → empty at assessment time
- `storybloq validate` → 0/0/0
- No runtime, build, validation, or packaging state changed this session
- §22 green evidence is untouched; no regression possible
- This artifact is governance-only; no code, no test execution, no evidence regeneration

---

## Codex Review Notes

Initial draft reviewed by Codex (review `codex-review-2026-05-25_19-20-39.txt`). Three corrections applied:
1. §22 evidence wording: clarified "scripted must-pass rows PASS; manual rows SKIP/manual per matrix" (was: overstatement "all 20 rows PASS").
2. Evidence locality: added note that `validation-artifacts/` is gitignored (local-disk only).
3. VAL-UI-005 classification: corrected from runner-row-missing to manual-only + feature-blocked (row exists in rows.ts at line 153; gap is feature readiness, not row absence).
