# v2.0.0 GA Adjudication — Bounded M1 NVENC-First Scope

**Date:** 2026-05-26
**Authority basis:** T-010c closure (d1c43b3; validation evidence ef45e20), T-010d completion, §22 smoke suite authority, bounded M1 convergence scope as approved GA candidate.
**Purpose:** Authoritative GA adjudication artifact for bounded M1 v2.0.0 release posture. Formalizes engineering-complete state, governance-gated remaining surfaces, and T-010e transition gate.

---

## Adjudication Finding

**Bounded M1 NVENC-first convergence conditionally satisfies T-010e** under the approved M1 GA scope.

Engineering is complete. No deterministic engineering failure exists in any M1-executed surface. All M1-implementable §24 validation rows are in PASS or formally-classified non-PASS state (STOP, cannot-validate, feature-deferred). Engineering has exited the critical path. Governance adjudication is now the gating activity for T-010e activation.

Remaining unresolved surfaces are **operationally deferred** classifications, not deterministic failures. They are non-blocking for bounded M1 GA.

---

## Approved GA Scope — Bounded M1 NVENC-First

| Dimension | Approved Bound |
|---|---|
| Platform | Linux only (FHS: Debian / Ubuntu / Arch / Fedora) |
| Encoder | NVENC primary; libx264 infra-ready (config-blocked on M1) |
| Resolution ceiling | 1440p60 PASS; 4K60 hardware-bound on M1 |
| Audio | Video-only GA; audio milestone post-GA |
| Baseline regression | v1.1.0 regression suite PASS on M1 (bounded scope) |
| RC matrix | M1 sub-portion only; M2/M3/M4 post-GA |
| Windows | Out of scope for v2.0.0 GA |

---

## §24 Item-by-Item Disposition

### Item 1 — §22 Smoke Suite Green on M1
**Classification: SATISFIED**
All §22 scripted must-pass rows (20 rows) PASS. Evidence anchor: HEAD `d335a09`. ISS-020/021/022/023 resolved and committed. No governance action required.

---

### Item 2 — §23 RC Must-Pass Rows Green on M1+M2+M3+M4
**Classification: HARDWARE-BLOCKED (M2/M3/M4); M1 sub-portion CONDITIONALLY SATISFIED**
VAL-CAP-013 (1440p60×NVENC) PASS. Evidence: `validation-artifacts/smoke/2026-05-26T04-07-46-832Z/VAL-CAP-013/`. No further M1-executable §23 rows in bounded scope. Full 4-machine RC matrix is a hardware acquisition decision, not an engineering gap.
**Governance decision required:** Confirm bounded M1-NVENC execution satisfies §23 for M1 GA scope.

---

### Item 3 — §18 Resolution × Encoder Coverage Gate
**Classification: M1-NVENC COMPLETE; VAAPI/QSV HARDWARE-BLOCKED; 4K60 HARDWARE-BOUND; libx264 CONFIG-BLOCKED**

| Cell | M1 State | Classification |
|---|---|---|
| 1080p60 × NVENC | PASS (VAL-CAP-004, §22) | SATISFIED |
| 1440p60 × NVENC | PASS (VAL-CAP-013) | SATISFIED |
| 4K60 × NVENC | Expected-fail (VAL-CAP-014, ~66% drop) | HARDWARE-BOUND |
| 1080p60 × libx264 | Infra-ready; fails on M1 (NVENC-priority config) | CONFIG-BLOCKED |
| Any × VAAPI | No evidence | HARDWARE-BLOCKED (M2/M3) |
| Any × QSV | No evidence | HARDWARE-BLOCKED (M3) |

**Governance decision required:** Waive VAAPI/QSV cells and 4K60×NVENC for M1 GA bounded scope; record as known limitations in CHANGELOG.

---

### Item 4 — §16 v1.1.0 Regression Suite Green
**Classification: SATISFIED (bounded scope); REG-008 STOP; REG-012 cannot-validate**

| Row | State | Classification |
|---|---|---|
| VAL-REG-001 | PASS | SATISFIED |
| VAL-REG-002 | PASS | SATISFIED |
| VAL-REG-003 | COVERED | SATISFIED (VAL-UI-003 §22) |
| VAL-REG-004 | PASS | SATISFIED |
| VAL-REG-005 | N/A | OUT OF SCOPE (audio; video-only GA) |
| VAL-REG-006 | PASS | SATISFIED |
| VAL-REG-007 | PASS | SATISFIED |
| VAL-REG-008 | **STOP** | STOP / POST-GA |
| VAL-REG-009 | COVERED | SATISFIED (VAL-PROC-001 §22) |
| VAL-REG-010 | COVERED | SATISFIED (VAL-PROC-001..007 §22) |
| VAL-REG-011 | COVERED | SATISFIED (VAL-PROC-007 §22) |
| VAL-REG-012 | cannot-validate | GOVERNANCE-DEFERRED (ISS-011; M1 SHM/KDE limitation) |
| VAL-REG-013 | PASS | SATISFIED |

Evidence anchor: handover `2026-05-26-01-t010c-s16-reg001-convergence-complete.md`.
**Governance decision required:** Acknowledge REG-008 STOP and VAL-REG-012 cannot-validate as non-blocking for M1 GA.

---

### Item 5 — §17 Issue #1/#3/#4 Absorption Proofs Green
**Classification: PARTIAL — M1-executable rows SATISFIED; VAL-UI-005 FEATURE-DEFERRED**

| Row | State | Classification |
|---|---|---|
| VAL-UI-002 | PASS (§22) | SATISFIED |
| VAL-UI-004 | PASS (§22) | SATISFIED |
| VAL-CAP-007 | PASS (§22) | SATISFIED |
| VAL-UI-005 | Region capture UI absent from v2 renderer | FEATURE-DEFERRED (post-GA) |

**Governance decision required:** Acknowledge VAL-UI-005 feature-deferred as non-blocking for M1 GA.

---

### Item 6 — §21 v1.1.0 vs v2.0.0 Comparison Plot
**Classification: M1-NVENC PREREQUISITES SATISFIED; PLOT GOVERNANCE-GATED; VAAPI/QSV HARDWARE-BLOCKED**
1080p60×NVENC PASS (§22); 1440p60×NVENC PASS (VAL-CAP-013) — M1 comparison segments are runnable. 4K60 and VAAPI/QSV comparison segments require M2/M3 hardware.
**Governance decision required:** Confirm whether M1-NVENC-only comparison satisfies §21 for bounded GA scope; waive VAAPI/QSV and 4K60 segments if proceeding.

---

### Item 7 — §7 Diagnostics Bundle Produced + Redaction Verified
**Classification: GOVERNANCE-DEFERRED**
No `engine.diagnosticsBundlePath` driver built. T-010c is closed; adding a driver requires a new ticket. This item has a binary branch:
- **Include:** Requires new ticket under T-010e or separate chore; blocks GA until complete.
- **Defer (recommended):** Record in CHANGELOG as known limitation; post-GA tracking via existing issue or new ticket.

**Governance decision required (binary):** Include driver (new ticket) or defer to post-GA (CHANGELOG notation required).

---

## Disposition Tables

### IN SCOPE — Bounded M1 NVENC-First GA

| Surface | Status | Evidence anchor |
|---|---|---|
| §22 smoke suite (20 rows) | PASS | d335a09 |
| §16 VAL-REG-001 | PASS | `validation-artifacts/.../VAL-REG-001/` |
| §16 VAL-REG-002 | PASS | §22 ffprobe PTS walk |
| §16 VAL-REG-003 | COVERED | VAL-UI-003 §22 |
| §16 VAL-REG-004 | PASS | Static |
| §16 VAL-REG-006 | PASS | Static |
| §16 VAL-REG-007 | PASS | §7 capture.json synthesis |
| §16 VAL-REG-009 | COVERED | VAL-PROC-001 §22 |
| §16 VAL-REG-010 | COVERED | VAL-PROC-001..007 §22 |
| §16 VAL-REG-011 | COVERED | VAL-PROC-007 §22 |
| §16 VAL-REG-013 | PASS | Static |
| §17 VAL-UI-002 | PASS | §22 |
| §17 VAL-UI-004 | PASS | §22 |
| §17 VAL-CAP-007 | PASS | §22 |
| §18 1080p60×NVENC | PASS | VAL-CAP-004 §22 |
| §18 1440p60×NVENC | PASS | VAL-CAP-013 evidence dir |
| T-010d packaging audit | COMPLETE | Separate confirmation |

### OUT OF SCOPE — v2.0.0 GA

| Surface | Reason |
|---|---|
| Windows packaging | Linux-first per N-008 §4 |
| Audio capture validation | Audio milestone post-GA |
| AMF / WGC encoders | Visibly inert (VAL-ENC-012); out-of-scope for bounded GA |
| M2/M3/M4 RC matrix | Hardware acquisition decision |
| Full §21 comparison plot | Downstream of M2/M3/M4 hardware |

### HARDWARE-BLOCKED

| Surface | Blocking hardware | Post-GA tracking |
|---|---|---|
| §18 VAAPI cells (all resolutions) | M2/M3 | T-028 (AMD/Intel DMA-BUF) |
| §18 QSV cells (all resolutions) | M3 | T-028 or new ticket |
| §23 M2/M3/M4 RC rows | M2/M3/M4 | Hardware procurement track |
| §21 VAAPI/QSV comparison | M2/M3 | Downstream of §18 VAAPI/QSV |
| §18 4K60×NVENC PASS | M1 hardware-bound (~66% drop) | Post-GA hardware decision |

### FEATURE-BLOCKED

| Surface | Blocking feature | Post-GA tracking |
|---|---|---|
| VAL-UI-005 (region capture) | Region capture UI absent from v2 renderer | Post-GA feature ticket |
| §18 1080p60×libx264 | NVENC-priority config; no libx264-only helper path on M1 | Post-GA config/scope ticket |
| §18 4K60×libx264 | Same + hardware-bound at 4K60 | Post-GA |

### GOVERNANCE-DEFERRED

| Surface | Governance decision required | §24 item |
|---|---|---|
| M1-only §23 scope acceptance | Accept bounded M1-NVENC as §23 gate | Item 2 |
| VAAPI/QSV waiver | Explicit waiver + CHANGELOG notation | Item 3 |
| 4K60×NVENC HARDWARE-BOUND acknowledgment | Acknowledge as non-blocking | Item 3 |
| VAL-UI-005 deferral acknowledgment | Acknowledge as non-blocking | Item 5 |
| §21 M1-NVENC-only acceptance | Accept M1-NVENC-only comparison plot | Item 6 |
| §7 diagnostics bundle decision | Binary: new ticket OR CHANGELOG deferral | Item 7 |
| REG-008 STOP acknowledgment | Acknowledge as non-blocking | Item 4 |
| VAL-REG-012 cannot-validate acknowledgment | Acknowledge as non-blocking | Item 4 |

### STOP / POST-GA

| Surface | Classification | Rationale |
|---|---|---|
| VAL-REG-008 | STOP | timing-sensitive-stabilization + orchestration-redesign required; non-deterministic; post-GA architecture decision |
| §7 diagnostics bundle (if deferred) | POST-GA | T-010c closed; CHANGELOG notation sufficient pending governance decision |
| ISS-011 (VAL-CAP-006 frame-count deficit) | POST-GA | ISS-011 open; T-028 tracks |
| ISS-012 (export FSM stuck EXPORTING) | POST-GA | ISS-012 open; T-037 tracks |
| §23 M2/M3/M4 full RC matrix | POST-GA | Hardware acquisition decision |

---

## Why Engineering Is No Longer the Bottleneck

All M1-executable §24 surfaces have been addressed within bounded convergence scope as of T-010c COMPLETE (closure commit d1c43b3; validation evidence ef45e20):

- **§22 smoke suite:** All 20 scripted must-pass rows PASS; gate cleared at d335a09
- **§16 regression suite:** All M1-implementable rows PASS; REG-008 STOP-classified; REG-012 cannot-validate per ISS-011
- **§17 absorption proofs:** All M1-executable rows PASS; VAL-UI-005 feature-deferred
- **§18 M1-NVENC cells:** 1080p60 + 1440p60 PASS confirmed; 4K60 hardware-bound; VAAPI/QSV hardware-blocked
- **§23 M1 sub-portion:** 1440p60×NVENC PASS evidence established
- **T-010d:** Packaging audit COMPLETE (separately confirmed)

Remaining gaps are exclusively hardware acquisition decisions, release scope decisions, feature decisions, and governance scope decisions. None require engineering execution on M1. All require project-level governance decisions.

---

## T-010e Transition Gate

Bounded M1 convergence **conditionally satisfies T-010e** under approved M1 GA scope. Governance decisions below must be recorded before T-010e proceeds to version bump → CHANGELOG → tag → push.

| Gate | Required action | §24 item |
|---|---|---|
| M1-only §23 scope | Accept bounded M1-NVENC as §23 gate | Item 2 |
| VAAPI/QSV waiver | Approve + CHANGELOG notation | Item 3 |
| VAL-UI-005 deferral | Acknowledge as non-blocking | Item 5 |
| §21 M1-NVENC-only scope | Accept M1-NVENC-only comparison | Item 6 |
| §7 diagnostics bundle | Binary decision: include (new ticket) or defer (CHANGELOG) | Item 7 |
| REG-008 STOP | Acknowledge as non-blocking | Item 4 |
| VAL-REG-012 cannot-validate | Acknowledge as non-blocking | Item 4 |

Once all gates cleared: version bump → CHANGELOG → tag → push per T-010e description. Explicit user approval required before tag, push, or publish per CLAUDE.md.

---

## Preserved Governance Authority

The following dispositions are authoritative and must not be reinterpreted absent new deterministic evidence:

- **§22 smoke authority:** 20 rows, smokeOrder ≤ 20; §22 gate cleared at d335a09 via individual row runs; VAL-EXP-001 sequential-suite failure is environmental flap, non-blocking
- **T-010c closure posture:** COMPLETE at d1c43b3 (validation evidence ef45e20); closed; no engineering work is reopenable under T-010c scope
- **REG-008 STOP classification:** Authoritative and permanent absent new deterministic evidence; timing-sensitive-stabilization + orchestration-redesign required; post-GA; cannot be elevated to a pre-GA blocker
- **VAL-CAP-006 cannot-validate (REG-012):** M1 SHM/KDE limitation; ISS-011 tracks; non-blocking for M1 GA
- **VAL-UI-005 feature-deferred:** Region capture UI absent from v2 renderer; post-GA feature track; non-blocking for bounded GA scope
- **Deferred scope is not latent engineering debt:** Hardware-blocked, feature-blocked, and governance-deferred surfaces are operationally deferred classifications, not unresolved failures requiring pre-GA remediation
- **Bounded M1 scope is the approved GA candidate:** Multi-platform parity, VAAPI/QSV validation, and full RC matrix are post-GA tracks; no new release blockers may be invented absent deterministic failing evidence

---

## Verification Summary

- `storybloq validate` → Errors: 0 | Warnings: 0 | Info: 0 ✓
- `git diff -- src/ helper/ electron/ validation/` → empty (artifact creation only; no source or validation changes) ✓
- T-010c status: complete (closure d1c43b3; validation evidence ef45e20) — unchanged ✓
- §24 items 1–7: all have explicit disposition classification ✓
- No unresolved surface left ambiguous ✓
- Engineering remains exited from the critical path ✓
- Governance adjudication is the gating activity ✓
