# T-026: ISS-012 Export Lifecycle Diagnostics Instrumentation

## Outcome
Additive-only instrumentation across helper, Electron main, and renderer. No behavior changes. ISS-012 remains OPEN.

## Touched Files
- `helper/src/export/mod.rs` — +160 lines of info!/warn! lifecycle tracing
- `electron/main.ts` — +30 lines of console.log in wireHelperNotifications
- `src/v2/engine.ts` — +28 lines of gs().log("info", ...) at export FSM decision points
- `.story/tickets/T-026.json` — new ticket

## Helper Instrumentation Sites (export/mod.rs)
1. `export.queued` — export_id, snapshot_id, requested_duration_s, pid
2. `export.started` — export_id, snapshot_id, est_duration_s, est_output_bytes, tmp_path, final_path, pid
3. `export.progress terminal pct=100` — export_id, pct, bytes_out, elapsed_ms
4. `export.muxing enter` — export_id, bytes_out, elapsed_ms (+ local Instant for mux_duration_ms)
5. `export.tmp fsync success` — export_id, tmp_bytes, tmp_path
6. `export.rename success (same-device)` — export_id, final_path
7. `export.rename success (cross-device)` — export_id, final_path
8. `export.dir fsync success` — export_id, dir
9. `export.sha256 success` — export_id, bytes, sha256, final_path
10. `export.completion preswap` — export_id, terminal_fired_was, mux_duration_ms, total_duration_ms
11. `export.completion postswap` — export_id, mux_duration_ms, total_duration_ms
12. `export.completion suppressed_double_emit` — warn! when terminal already fired
13. `export.completed emit` — export_id, final_path, bytes, sha256, total_duration_ms, pid
14. `export.failed emit` — warn! with export_id, stage, reason_code, details, pid
15. `export.failed suppressed_double_emit` — warn! with terminal_fired_was
16. `export.cancel preswap/postswap (copy-stage)` — export_id, partial_bytes
17. `export.cancel preswap/postswap (mux-stage)` — export_id, partial_bytes
18. `export.cancel suppressed_double_emit` — warn! for both cancel paths

## Electron Instrumentation Sites (main.ts)
Inside wireHelperNotifications only:
1. `export.queued` — export_id, snapshot_id
2. `export.started` — export_id, mode
3. `export.completed` — export_id, final_path, bytes
4. `export.failed` — export_id, stage, reason_code
5. `export.cancelled` — export_id, stage, partial_bytes

## Renderer Instrumentation Sites (engine.ts)
1. `_isStaleExport` — logs when stale guard discards an event (event export_id vs active)
2. `export.completed received` — pre-transition state dump
3. `export.completed post-transition` — target state after transition
4. `export.failed received` — pre-transition state dump with stage, reason_code
5. `export.failed post-transition` — target state after transition
6. `export.cancelled received` — pre-transition state dump with stage, partial_bytes
7. `export.cancelled post-transition` — target state after transition
8. `_startExport RPC call` — snapshotId, v2State
9. `_startExport RPC result` — export_id, v2State, v2SnapshotId
10. `_startExport RPC error` — error message, v2State
11. `snapshot release retry` — id, attempt number
12. `snapshot release success` — id, attempt number
13. `snapshot release exhausted` — id (after 4 attempts)

## Grep Commands for Future ISS-012 Repro Triage
```bash
# Helper: full export lifecycle from engine.log
grep 'export\.' ~/.config/Cove\ Screen\ Recorder/logs/engine.log

# Helper: specific export by ID
grep 'export_id=exp-XXXXX' ~/.config/Cove\ Screen\ Recorder/logs/engine.log

# Helper: terminal_fired and double-emit diagnostics
grep 'terminal_fired_was\|suppressed_double_emit' ~/.config/Cove\ Screen\ Recorder/logs/engine.log

# Electron: export lifecycle in main process stdout
# (visible in terminal when running `npm run dev`)
grep '\[export lifecycle\]' <electron-stdout>

# Renderer: export lifecycle in LogPanel / DevTools console
# Filter by "[export lifecycle]" in the renderer log panel
```

## Expected Log Ordering (Happy Path)
1. helper: `export.queued`
2. electron: `[export lifecycle] export.queued`
3. helper: `export.started`
4. electron: `[export lifecycle] export.started`
5. renderer: `[export lifecycle] _startExport RPC call`
6. renderer: `[export lifecycle] _startExport RPC result`
7. helper: `export.progress terminal pct=100`
8. helper: `export.muxing enter`
9. helper: `export.tmp fsync success`
10. helper: `export.rename success (same-device)` or `(cross-device)`
11. helper: `export.dir fsync success`
12. helper: `export.sha256 success`
13. helper: `export.completion preswap` (terminal_fired_was=false)
14. helper: `export.completion postswap`
15. helper: `export.completed emit`
16. electron: `[export lifecycle] export.completed`
17. renderer: `[export lifecycle] export.completed received`
18. renderer: `[export lifecycle] snapshot release success`
19. renderer: `[export lifecycle] export.completed post-transition`

## Verification Summary
- cargo build: PASS (0 errors)
- cargo test: 101/101 unit tests pass; 1 pre-existing nvenc env test failure
- cargo clippy -D warnings: all findings pre-existing (nvenc, pipewire, sim)
- npm run typecheck: PASS
- npm run build: PASS
- npm run validate: VAL-CAP-004 pre-existing failure (helper socket not available)

## Codex Review
- Review 1: stale handoff — rejected (task mismatch, not reviewing our changes)
- Review 2: 1 Low finding — cross-device rename success path missing info! trace
- Fix applied: added info! at cross-device xd_rename Ok(()) branch
- Review 3: **patch is correct** — 0 issues found
- Review path: `/home/sin/Desktop/Codex-Reviews/codex-review-2026-05-22_22-54-51.txt`

## ISS-012 Status
**OPEN** — unchanged. This pass adds diagnostics visibility only. No fix attempted. The next stuck-EXPORTING repro will have full lifecycle tracing across all three layers to identify where the completion signal is lost.

## T-026 Status
Implementation complete. Not committed (per instructions).
