# T-028 — VAL-CAP-006b zero-copy declared-frame-count execution spec (define-only)

**Date:** 2026-05-23
**Scope:** Define-only. No hardware validation, no adjudication, no runtime/helper/encoder/validation/policy change. Prior context: ISS-011 + T-027 handover `2026-05-23-01-t-027-cannot-validate-policy.md` (committed `5a0849b`); not restated here.

## Summary
Authored the verbatim-runnable execution spec a future AMD (VAAPI) / Intel (QSV) DMA-BUF session will use to adjudicate VAL-CAP-006b to a real pass/fail. VAL-CAP-006b stays parked (cannot-validate on the M1 NVIDIA/KDE host per T-027 / N-008 §26.8); T-028 stays open (hardware-blocked, M2/M3). No statuses changed.

## Why no hardware validation was run
Current host is M1 NVIDIA / KDE Plasma 6 / Wayland: DMA-BUF zero-copy hard-fails, so only SHM-fallback evidence exists and there is no working zero-copy baseline to measure declared frame count against. The §26.4 NVIDIA predicate is complete → 006b is cannot-validate here (already recorded under T-027). A real 006b pass/fail requires `gpuInfo` starting `amd:`/`intel:` with confirmed DMA-BUF — unavailable on this machine. Any NVIDIA/KDE PASS/FAIL would be invalid; none was produced.

## Instrumentation: capture-side sufficient; encoder zero-copy import is an implementation prerequisite
Capture-side signals are emitted (read-only) and prove the DMA-BUF capture path: `capture.diagnostics.buffers.buffer_type` (pipewire.rs:2072-2082); DMA-BUF settle/first-attempt + SHM/soft/payload/hard-fail/stream-error fallback markers (pipewire.rs:1415/1421/261/283-307/1335-1339/1648-1656); `capture.formatChanged` (pipewire.rs:37,108); `capture.sessionReady` (pipewire.rs:1006-1015). **But encoder zero-copy import is NOT implemented:** no helper backend imports DMA-BUF (NVENC `accepts_dmabuf:false`/errors — nvenc/mod.rs:540,688; libx264 stub; VAAPI/QSV out of scope per T-017 — encoder/backends/mod.rs:10, encoder/mod.rs:69), and `dmabuf_imports` is emitted but never incremented in real code (sim-only — sim/dispatch.rs:282). So VAL-CAP-006b is **dual-gated**: qualifying AMD/Intel DMA-BUF hardware AND a VAAPI/QSV zero-copy encoder backend + real `dmabuf_imports` increment (implementation prerequisites, separate follow-up tickets — not created in this define-only pass). This pass itself makes no helper/runtime/validation change. See `instrumentation-sufficiency.md`.

## Files changed
- NEW spec dir `.story/handovers/evidence/2026-05-23-t-028-execution-spec/` (8 files): assertion-definition, hardware-eligibility, dmabuf-success-criteria, evidence-bundle-template, decision-table, instrumentation-sufficiency, execution-prerequisites, iss-011-t010c-disposition.
- `.story/tickets/T-028.json` — additive description reference to the spec (status unchanged: open).
- `.story/notes/N-009.json` — NEW note "T-028 execution spec".
- This handover.

## Forbidden surfaces untouched
helper/, electron/, src/, validation/ (assertions/runner/types/drivers/rows), dist-validation/, packaging/, .github/, package.json, lockfiles, Cargo.toml, Cargo.lock — no diffs. N-008, T-023, T-027, T-010c, ISS-008/009/011/012/013 — no diffs. No new issues/tickets; no executable scripts/tools; no typed cannot-validate verdict; no VAL-CAP-006b driver; no rows.ts split.

## Verification (one line per check)
- storybloq validate: 0 errors / 0 warnings / 0 info.
- `git diff --check`: clean.
- forbidden-path diff (helper/ electron/ src/ validation/ dist-validation/ packaging/ .github/ package.json Cargo.toml Cargo.lock): empty.
- N-008 / T-023 / T-027 / T-010c / ISS-008 / ISS-009 / ISS-011 / ISS-012 / ISS-013 diff: empty.
- T-028: status open; only the description gained an additive execution-spec reference.
- ISS-011: inprogress. T-010c: open. T-028: open.
- Spec dir: 8 required markdown files present.
- decision-table.md: explicit "No fake-green branch exists"; SHM-on-AMD/Intel = INCONCLUSIVE (not cannot-validate); pre-first-frame = INVALID.
- assertion-definition.md: pins strict §6.1 `round(duration_s × declared_fps) ± 1`; excludes the `checkFrameCountVariableRate` 0.85–1.02 band.

## Spec / evidence paths
- Spec: `.story/handovers/evidence/2026-05-23-t-028-execution-spec/` (8 files above).
- ISS-011 source evidence (unmoved, mapped to 006b per §26.7): `.story/handovers/evidence/2026-05-22-t-010c-slice-3-m1-smoke-completion-retry-2/operator-evidence/VAL-CAP-006/`.

## Status
T-028 remains **open** — dual-gated: hardware-blocked (M2/M3 AMD/Intel) AND implementation-blocked (VAAPI/QSV zero-copy encoder backend + real `dmabuf_imports` increment; follow-up tickets not created here). ISS-011 remains **inprogress** (parked pending T-028; cannot-validate does not resolve it). N-008 unchanged. No validation/runtime path changed. Not committed (per instruction).

## Adjudicator caveat (carried forward)
Helper emits `capture.diagnostics.buffers.buffer_type` (snake_case, nested under `buffers`) — N-008 VAL-CAP-009 prose says `bufferType`. The future adjudicator uses the emitted field. Not reconciled in T-028 (out of scope).