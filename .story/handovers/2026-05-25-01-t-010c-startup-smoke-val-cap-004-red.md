# T-010c — §22 Smoke Execution: PARTIAL — First Must-Pass Red at VAL-CAP-004

**Date:** 2026-05-25
**Ticket:** T-010c (inprogress)
**Issues filed:** ISS-020

## Session Goal

Execute N-008 §22 smoke suite against the finalized v2.0.0 startup/export path after T-033, ISS-017, ISS-018, ISS-019. Produce smoke verdict and per-row pass/fail matrix.

## Current HEAD

`8331348` — Add startup dependency presence probe (ISS-019)

## Pre-flight Checks

### Build verification
- `npm run validate:build` (TypeScript): **PASS** (clean, no errors)
- `cargo build -p cove-replay-engine`: **PASS** (0 errors, 70 warnings — pre-existing NVENC FFI naming)

### Context state
- ISS-008: resolved (2026-05-23, v2 UI gate)
- ISS-009: resolved (2026-05-23, recovery skip affordances + T-033 removal)
- ISS-011: inprogress, VAL-CAP-006b = cannot-validate on NVIDIA/SHM per §26 policy; VAL-CAP-006a passed
- ISS-012: open, bounded by watchdog + panic guard
- ISS-017/018/019: resolved (source commits on HEAD)
- T-033: resolved (recovery dialog removed)
- Open issues: ISS-007 (medium), ISS-012 (high)

### Execution path
T-010a harness: `node dist-validation/runner.js smoke` (headless, spawns helper directly via JSON-RPC — no Electron required for scripted-local rows).

### Dep sentinels (ISS-019)
- `/usr/bin/pipewire`: present ✓
- `/usr/share/dbus-1/services/org.freedesktop.portal.Desktop.service`: present ✓
ISS-019 dep probe will NOT fire during harness run (sentinels exist).

### Display
DP-4 was at 3840x2160@240 (KDE default). Modesetted to 1920x1080@60 for VAL-CAP-004. Restored to 3840x2160@240 post-run.

## Smoke Run Summary

### Run 1 — Pre-modeset (3840x2160@240)
Report: `validation-artifacts/smoke/2026-05-25T08-54-33-508Z/report.json`
Evidence: `.story/handovers/evidence/2026-05-25-t-010c-startup-smoke/run-1-pre-modeset/`
- VAL-PKG-001: skip (helper-not-available — `coveApi.env.probe()` requires Electron preload; harness spawns helper directly)
- VAL-CAP-001: skip (manual)
- VAL-CAP-003: **PASS** — portal denial: capture.sessionLost(portal-denied); helper returned to IDLE
- VAL-CAP-004: **FAIL** — capture cell 3840x2160, required 1920x1080 (display at 4K before modeset)

### Run 2 — Post-modeset (1920x1080@60)
Report: `validation-artifacts/smoke/2026-05-25T08-56-46-064Z/report.json`
Evidence: `.story/handovers/evidence/2026-05-25-t-010c-startup-smoke/run-2-post-modeset/`
- VAL-PKG-001: skip (same reason — harness only)
- VAL-CAP-001: skip (manual)
- VAL-CAP-003: **PASS** — portal denial confirmed
- VAL-CAP-004: **FAIL — first must-pass red** (see below)

**Stopped at VAL-CAP-004. Rows 5-18 NOT-ATTEMPTED per ordered-stop rule.**

## VAL-CAP-004 Failure Detail

| Threshold | Observed | Required | Pass |
|---|---|---|---|
| capture cell matches declared (1920x1080) | 1920x1080 | 1920x1080 | ✓ |
| drop rate <= 0 (1080p60-nvenc) | 0.771104 (77%) | <= 0 | ✗ |
| cadence mean [51..61.2] fps | 54.035 | 51..61.2 | ✓ |
| cadence spread <= 20 fps | 2.000 | <= 20 | ✓ |
| at least 1 diagnostics sample | 58 | >= 1 | ✓ |
| encoder.selected = nvenc | nvenc | nvenc | ✓ |

### Drop pattern
- Samples: 58 (1 warmup excluded)
- Drops per sample: min=40, max=47, **zero_count=0** (100% of samples have drops)
- Average: ~42 drops/sec sustained throughout entire 60s run

### Regression analysis
- Last known-good run: `2026-05-22T02-21-35-097Z` (T-021 rerun-27) — **0.000000 drop rate** with identical hardware
- `helper/src/capture/pipewire.rs` last modified: `6371f46` (Add ISS-014 encode-boundary diagnostics) — **before T-021 rerun-27, no change in capture code path**
- Post-T-021 helper changes: `927bf0d` (export/mod.rs watchdog), `1f558ae` + `e72670d` + `487721c` (segment/buffer.rs eviction) — none touch capture path
- System load at test time: kwin_wayland 9.5%, firefox 8.5%, baloo_file 7.3%

### Root cause assessment
Capture code path is **unchanged** since passing run. Most likely cause: PipeWire/KWin compositor behavior difference between 2026-05-22 and 2026-05-25 (system state, compositor scheduling, or baloo_file indexing causing compositor CPU pressure).

Cannot fully rule out helper back-pressure from segment buffer changes (1f558ae) propagating upstream through encoder → capture chain. Requires retest in clean environment (no baloo, firefox, background load) to disambiguate.

**Filed as ISS-020 (high).**

## §22 Pass/Fail Matrix (current session)

| Row | Status | Notes |
|---|---|---|
| VAL-PKG-001 | skip (harness-only) | Requires Electron/coveApi — not in headless harness |
| VAL-CAP-001 | skip (manual) | Manual row, requires operator |
| VAL-CAP-003 | **PASS** | Portal denial confirmed |
| VAL-CAP-004 | **FAIL** — first red | Drop rate 77%, ISS-020 filed |
| VAL-CAP-006a | NOT-ATTEMPTED | Stopped post VAL-CAP-004 |
| VAL-UI-005 | NOT-ATTEMPTED | Stopped post VAL-CAP-004 |
| VAL-ENC-001 | NOT-ATTEMPTED | Stopped post VAL-CAP-004 |
| VAL-ENC-006 | NOT-ATTEMPTED | Stopped post VAL-CAP-004 |
| VAL-SEG-001..VAL-REG-002 | NOT-ATTEMPTED | Stopped post VAL-CAP-004 |

## Startup-Path Row Executability Assessment

These rows (VAL-UI-010, VAL-UI-011, VAL-UI-014) are NOT in the §22 ordered list but were flagged in session bootstrap as requiring validation:

| Row | Executability | Reason |
|---|---|---|
| VAL-UI-010 (sha256 mismatch → modal) | **NOT EXECUTABLE in dev** | `verifySha256()` has `if (!app.isPackaged) { return; }` guard at `electron/engine-supervisor.ts:200` |
| VAL-UI-011 (protocol mismatch → modal) | **NOT EXECUTABLE in dev** (without invasive helper swap) | Requires a stub helper binary returning wrong protocol version |
| VAL-UI-014 (dep probe → modal) | **NOT EXECUTABLE without root** | Sentinel at `/usr/share/dbus-1/services/org.freedesktop.portal.Desktop.service` (hardcoded absolute path, not PATH-based); hiding requires root |
| T-033 (no recovery dialog) | **Deferred** | Evidenced by commit 7fce888 + ISS-009 resolution; re-test requires operator-driven Electron session |

## Evidence Paths

- Pre-modeset display: `.story/handovers/evidence/2026-05-25-t-010c-startup-smoke/kscreen-pre-before-modeset.txt`
- Post-modeset display (1080p): `.story/handovers/evidence/2026-05-25-t-010c-startup-smoke/kscreen-pre.txt`
- Run 1 report (pre-modeset, 4K, cell fail): `.story/handovers/evidence/2026-05-25-t-010c-startup-smoke/run-1-pre-modeset/report.json`
- Run 2 report (post-modeset, 1080p, drop rate fail): `.story/handovers/evidence/2026-05-25-t-010c-startup-smoke/run-2-post-modeset/report.json`
- Run 2 VAL-CAP-004 thresholds: `.story/handovers/evidence/2026-05-25-t-010c-startup-smoke/run-2-post-modeset/VAL-CAP-004/thresholds.json`
- Run 2 VAL-CAP-004 diagnostics: `.story/handovers/evidence/2026-05-25-t-010c-startup-smoke/run-2-post-modeset/VAL-CAP-004/capture-diagnostics.json`
- Post-run display: `.story/handovers/evidence/2026-05-25-t-010c-startup-smoke/kscreen-post.txt`

## T-010c Status

**inprogress** — smoke verdict: **PARTIAL RED** at VAL-CAP-004.

## Issues Filed/Updated

- **ISS-020** (new, high): VAL-CAP-004 drop rate regression (77%, was 0% in T-021 rerun-27) — owner: capture

## Next Actions

1. Re-run §22 smoke in clean environment (baloo stopped: `balooctl6 suspend`, no firefox/background load)
2. If drop rate issue resolves → ISS-020 = environmental, resolve, continue smoke
3. If drop rate persists in clean env → ISS-020 = code regression from helper changes, investigate 1f558ae/927bf0d back-pressure path
4. Startup-path rows (VAL-UI-010/011/014): require packaged build OR packaged test environment — defer to RC suite pass or dedicated startup validation session
5. T-033 startup flow: operator-driven Electron session needed to confirm no recovery dialog appears

## Source Modifications

None. Read-only execution session. No `src/**`, `helper/**`, `electron/**` files modified.

`git diff -- src/ helper/ electron/` is empty.
