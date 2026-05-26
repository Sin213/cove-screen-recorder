# T-010c — §23 RC Suite: M1-Local Gap Assessment (HARD STOP)

**Date:** 2026-05-25
**Ticket:** T-010c (inprogress — §22 cleared, §23 M1-local execution attempted)
**HEAD:** `3763ae1` — Finalize T-010c §22 smoke governance state

## Session Goal

Execute M1-local portion of §23 RC suite against §24 gate assessment targets:
- §18 coverage cells: 1080p60 × libx264, 1440p60 × NVENC, 4K60 × NVENC
- §16 regression rows: VAL-REG-001/004/006/007/008/013
- §17 absorption proofs: VAL-CAP-007, VAL-UI-002, VAL-UI-004, VAL-UI-005 adjudication
- §7 diagnostics: NVENC bundle confirmation, VAL-DIAG-002 redaction

## HARD STOP Condition

**New RC infrastructure required for every target surface.**

The runner (`validation/runner.ts`, `validation/rows.ts`) exclusively covers the 20-row §22 smoke set. No rows exist in `SMOKE_ROWS` for §16/§17/§18 targets. No drivers exist in `drivers.ts` for any of those rows.

`rg "VAL-REG-001|VAL-REG-004|VAL-CAP-007|VAL-UI-002|VAL-UI-004|libx264|1440p" validation/rows.ts validation/runner.ts` → 0 matches.

Per session instructions: stop, produce blocker evidence, no speculation, no architecture changes.

## Status Table

| Target | Status | Evidence |
|---|---|---|
| §18 · 1080p60 × libx264 | HARD STOP | No row; no driver |
| §18 · 1440p60 × NVENC | HARD STOP | No row; no driver |
| §18 · 4K60 × NVENC | HARD STOP | No row; no driver |
| §16 · VAL-REG-001 | HARD STOP | No row; no driver (needs EXP-009 + 5-min variant) |
| §16 · VAL-REG-004 | HARD STOP | No row; no driver (needs ENC-008/011) |
| §16 · VAL-REG-006 | HARD STOP | No row; no driver (needs UI-001) |
| §16 · VAL-REG-007 | HARD STOP | No row; no driver; capture.json absent from runner output |
| §16 · VAL-REG-008 | HARD STOP | No row; no driver (needs EXP-011) |
| §16 · VAL-REG-013 | HARD STOP | No row; no driver (needs UI-002) |
| §17 · VAL-CAP-007 | HARD STOP | No row; no driver |
| §17 · VAL-UI-002 | HARD STOP | No row; no driver |
| §17 · VAL-UI-004 | HARD STOP | No row; no driver |
| §17 · VAL-UI-005 adjudication | FEATURE BLOCKED | Region capture UI not implemented (slice-4 handover 2026-05-23) |
| §7 · engine.diagnosticsBundle.zip | HARD STOP | engine.diagnosticsBundlePath RPC not called by any driver |
| §7 · VAL-DIAG-002 redaction | HARD STOP | Bundle absent; redaction unverifiable |

## Covered by Existing §22 Evidence (No New Execution Needed)

| §16 Row | Coverage | Evidence Path |
|---|---|---|
| VAL-REG-002 | PASS via VAL-REG-002 §22 | `validation-artifacts/smoke/2026-05-26T00-16-32-432Z/VAL-REG-002/` |
| VAL-REG-003 | PASS via VAL-UI-003 §22 | `validation-artifacts/smoke/2026-05-25T23-33-20-183Z/VAL-UI-003/` |
| VAL-REG-009 | PASS via PROC-001 §22 | `validation-artifacts/smoke/2026-05-25T23-34-18-071Z/VAL-PROC-001/` |
| VAL-REG-010 | PASS via PROC-001..007 §22 | as above + PROC-002/003/007 dirs |
| VAL-REG-011 | PASS via PROC-007 §22 | `validation-artifacts/smoke/2026-05-25T23-34-47-642Z/VAL-PROC-007/` |

**NVENC encoder partial confirmation (not full §7 bundle):**
`validation-artifacts/smoke/2026-05-25T21-56-49-317Z/VAL-CAP-004/encoder-selected.json`
→ `backend=nvenc`, `codec=h264`, `1920×1080`. This is NOT the required §7 `encoder.json` per-session dump.

## §24 Item Impact Summary

| Item | Status | Gap |
|---|---|---|
| 1. §22 smoke green on M1 | CLEARED (`d335a09`) | — |
| 2. §23 RC must-pass green M1+M2+M3+M4 | BLOCKED | New drivers + rows + M2/M3/M4 all required |
| 3. §18 coverage gate | BLOCKED | 1080p60 NVENC only green; libx264/1440p/4K NVENC blocked by infrastructure |
| 4. §16 regression suite | PARTIAL | REG-002/003/009/010/011 green from §22; REG-001/004/006/007/008/013 need drivers |
| 5. §17 absorption proofs | BLOCKED | CAP-007/UI-002/UI-004 need drivers; UI-005 needs region capture UI |
| 6. §21 comparison plot | BLOCKED | No runner support; 1440p/4K runs prerequisite |
| 7. §7 diagnostics bundle | BLOCKED | Collection not implemented; NVENC encoder confirmed via incomplete artifact |
| 8. Helper sha256 sidecar | T-010d | Not in T-010c scope |
| 9. .deb Depends VAL-UI-014 | BLOCKED | Dep probe modal not implemented |
| 10. Release notes | Post-release | Downstream of T-010c completion |

## Remaining Blockers (Explicit Distinction)

**New RC infrastructure (M1-executable once built):**
- rows.ts additions: 1080p60-libx264, 1440p60-nvenc, 4K60-nvenc variants of VAL-CAP-004-class rows
- Driver additions: VAL-REG-001/004/006/007/008/013; VAL-CAP-007; VAL-UI-001/002/004
- §7 bundle: `engine.diagnosticsBundlePath` call + copy + redaction check in at least one driver

**Hardware-blocked (M2/M3/M4 required):**
- §18: VAAPI/QSV cells (1080p/1440p/4K)
- §24 item 2: full 4-machine RC matrix
- VAL-CAP-006b: cannot-validate on M1 NVIDIA/KDE; parked at T-028 (AMD/Intel DMA-BUF)

**Feature-blocked (missing v2 UI):**
- VAL-UI-005 §17 Issue #1: region capture mode UI not in v2 renderer
- VAL-ENC-006: v2 renderer missing encoder.selected subscription
- VAL-UI-012: no hotkey toast system
- VAL-UI-014 §24 item 9: dep probe modal not implemented

**Governance-only (evidence complete):**
- §24 item 1: CLEARED
- §16 REG-002/003/009/010/011: covered by §22

**Post-release:**
- §24 item 10 (release notes from matrix output)

## Source Verification

- `git diff -- src/ helper/ electron/ validation/` → empty
- `storybloq validate` → 0/0/0
- §22 green rows: untouched, no regression possible
