# v2 GA Disposition — Post-ISS-011 Release-Path Assessment

## Current State

T-010c (v2.0.0 smoke + RC execution) remains open, now blocked by five issues: ISS-008, ISS-009, ISS-011, ISS-012, ISS-013. No VAL-CAP-006 retries should run on this NVIDIA/KDE stack — the test environment cannot produce a DMA-BUF baseline, so any further retry will reproduce the same SHM-fallback frame-count deficit.

## ISS-011 Classification

ISS-011 is a mixed environment + validation-policy gap:

- **Environment**: DMA-BUF hard-fails on RTX 4080 Super / NVIDIA 595.71.05 / KDE Wayland in all observed portal sessions. The helper falls back to SHM transparently, but SHM at 4K cannot sustain declared 60 fps under an occluded compositor. The frame-count deficit (28%) is observed under SHM fallback only.
- **Validation-policy gap**: N-008 has no platform-predicate mechanism to classify a must-pass row as not-applicable when the required capture path (DMA-BUF) is unavailable on the test hardware. The row can neither pass (SHM deficit) nor be skipped (no policy support).

ISS-011 cannot be resolved on this machine without either AMD/Intel DMA-BUF validation hardware or a formal cannot-validate policy update to N-008.

## New Issues Filed This Pass

- **ISS-012** — v2 export FSM can remain stuck in EXPORTING after valid output. Observed during ISS-011 VAL-CAP-006 standalone retry-2: replay save reached 100%, valid MP4 on disk, but renderer stuck in EXPORTING with controls disabled. Evidence: `.story/handovers/evidence/2026-05-22-iss-011-val-cap-006-standalone-retry-2/`
- **ISS-013** — Renderer can miss initial engine.ready and remain in BOOTING. Renderer subscribes to `cove/engine/ready` after main has already replayed `lastReadyPayload`, leaving v2State stuck in BOOTING. Evidence: `.story/handovers/evidence/2026-05-22-t-010c-slice-3-m1-smoke-completion-retry-2/blocker-initial-ready-race/`

## Why No More VAL-CAP-006 Retries on NVIDIA/KDE

1. DMA-BUF is unavailable — every portal session falls back to SHM.
2. SHM at 4K + occluded compositor cannot sustain 60 fps frame emission (compositor supply-limited).
3. KDE auto-restores 4K preferred mode even after kscreen-doctor modeset to 1080p60, defeating the controlled-resolution precondition.
4. Each retry reproduces the same 28% frame-count deficit under the same SHM conditions.
5. ISS-012 (export FSM hang) and ISS-013 (engine.onReady race) introduce additional blockers unrelated to the DMA-BUF path — these must be fixed in source before any retry is meaningful.

## T-010c Status

Open. blockedBy field left empty (storybloq schema accepts ticket IDs only, not issue IDs); blocking issues recorded as a description addendum: ISS-008, ISS-009, ISS-011, ISS-012, ISS-013. No acceptance criteria modified. No rows marked pass on false grounds.

## Recommended Next Tickets

- **T-022** — Export FSM instrumentation. Add end-to-end export-completion signaling so the renderer transitions out of EXPORTING when the helper confirms the MP4 is finalized. Addresses ISS-012.
- **T-023** — N-008 cannot-validate / platform-predicate policy update. Add formal support for classifying must-pass rows as not-applicable when required hardware capabilities (DMA-BUF, specific GPU vendor) are unavailable on the test machine. Addresses the validation-policy gap in ISS-011.
- **T-024** — engine.onReady race fix. Ensure renderer receives the initial engine.ready event regardless of subscription timing relative to main's `did-finish-load` replay. Addresses ISS-013.
- **T-025** — AMD/Intel validation hardware smoke pass. Run the T-010c §22 smoke suite on hardware with working DMA-BUF to establish a zero-copy baseline for VAL-CAP-006 and disambiguate ISS-011 (test-environment artifact vs real capture/encoder defect).

## Constraints

- No policy implementation in this pass.
- No release claim.
- No source changes.
- No prior handovers or evidence trees modified.
