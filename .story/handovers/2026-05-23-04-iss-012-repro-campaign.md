# ISS-012 Manual Repro Campaign — 2026-05-23

## Summary

6 controlled repro runs targeting ISS-012 (v2 export FSM stuck in EXPORTING after valid output).
T-029 render diagnostics were confirmed at HEAD (f729ab8). All runs produced non-repro-happy-path results.
ISS-012 remains open — 6 non-repro runs do not close the issue.

## Conditions

- T-029 diagnostics present: `[export lifecycle][render] snapshot` in src/App.tsx, `export-lifecycle.log` sink in electron/main.ts
- T-026 FSM diagnostics present: `stale-guard discard` in src/v2/engine.ts
- ffprobe n8.1.1 available
- Wayland session, h264_nvenc encoder, 1440p Quality preset (60fps capture, 120fps output)
- Log path correction: `~/.config/Cove Screen Recorder/logs/` (spaces in dir name), not `~/.config/cove-screen-recorder/logs/`
- Recovery banner appeared every run (discardedAll), always chose Discard all

## Per-Run Table

| Run | Source | Occlusion | Recovery | Saves | MP4 Valid | Bucket | Evidence Path |
|-----|--------|-----------|----------|-------|-----------|--------|---------------|
| 01 | Screen | N | Y (67) | 1 | Y (3840x2160 27.2s) | non-repro | .story/handovers/evidence/2026-05-23-iss-012-repro-campaign/run-01/ |
| 02 | Screen | N | Y (2) | 1 | Y (3840x2160 21.8s) | non-repro | .story/handovers/evidence/2026-05-23-iss-012-repro-campaign/run-02/ |
| 03 | Window | Y | Y (2) | 3 | Y (1920x1080 16.5s) | non-repro | .story/handovers/evidence/2026-05-23-iss-012-repro-campaign/run-03/ |
| 04 | Window | Y | Y (1) | 2 | Y | non-repro | .story/handovers/evidence/2026-05-23-iss-012-repro-campaign/run-04/ |
| 05 | Screen | Y | Y (1) | 1 | Y (3840x2160 27.5s) | non-repro | .story/handovers/evidence/2026-05-23-iss-012-repro-campaign/run-05/ |
| 06 | Screen | Y | Y (1) | 1 | Y (3840x2160 27.5s) | non-repro | .story/handovers/evidence/2026-05-23-iss-012-repro-campaign/run-06/ |

## Observations

- All 6 runs: `export.completed` received with matching export_id, FSM transitioned EXPORTING→RECORDING, `saveControlsDisabled=false`
- No stale-guard discards observed in any run
- No `export.rejected` events observed
- No handler exceptions observed
- Runs 05-06 showed 2-3s gap between progress=100 and export.completed (vs near-instant in earlier runs) — may correlate with longer recording durations
- Runs 03-04 had multiple rapid saves (user pressed save again 2-3s after first) — no FSM confusion from rapid double-save
- Live preview not working in Window mode (black tiles) — separate from ISS-012
- Wayland portal does not allow explicit window selection — "pick on record" mode

## Classification

**Non-repro.** T-029 diagnostics were present and captured clean lifecycle evidence across all runs.
Occlusion stress (fullscreen terminal cover for 10-15s) was applied in runs 03-06 without triggering ISS-012.
The stuck-EXPORTING condition from the original ISS-012 observation did not reproduce.

## ISS-012 Status

**Remains open.** 6 non-repro runs with diagnostics present do not close the issue.
The original observation was during ISS-011 VAL-CAP-006 standalone retry-2, which may have had different conditions (longer recording, different encoder load, different PipeWire state).

## No Runtime Code Changed

Confirmed: `git diff -- src/ electron/ helper/ validation/` is empty. No source files were modified.

## Codex Plan Gate

Plan was reviewed by Codex (gpt-5.5). Initial plan flagged as incorrect:
- Buckets were numbered 1-10 but repo defines 6 named buckets
- src/v2/engine.ts diagnostics are T-026 not T-029
- handoff.md path outside Codex sandbox

Plan patched and re-approved: "plan is correct"

## Evidence Root

`.story/handovers/evidence/2026-05-23-iss-012-repro-campaign/`
