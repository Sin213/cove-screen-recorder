# T-029 — ISS-012 stuck-EXPORTING classification buckets → log signatures

Use the captured renderer LogPanel (`[export lifecycle][render]` lines), the main log
(`export-lifecycle.log` + stdout `[export lifecycle]`), and the helper engine-log together.
Map a stuck-EXPORTING occurrence to exactly one owning input.

Reference: T-026 emits FSM-side `[export lifecycle]` lines from `src/v2/engine.ts`
(export.completed/failed/cancelled received + post-transition, stale-guard discard, RPC
call/result/error). T-029 adds the render-layer `[export lifecycle][render]` lines and the
main file sink described in `diagnostic-scope.md`.

| Bucket | Signature to look for |
|--------|-----------------------|
| **not received** | Main log shows `export.completed`/`failed`/`cancelled` forwarded (or helper engine-log shows the terminal export event), but **no** corresponding `[export lifecycle] export.* received` line from engine.ts (T-026). The renderer never got the terminal IPC. Render snapshot stays `v2State=EXPORTING`. |
| **stale-rejected** | engine.ts logs `[export lifecycle] stale-guard discard: event export_id=… active=…` — terminal event arrived but `export_id` did not match the active one, so the FSM ignored it. Render snapshot stays `v2State=EXPORTING`. |
| **received + v2State transitioned but replaySaving/selector held UI** | engine.ts logs `export.completed post-transition: v2State=RECORDING` (or `IDLE`) — **FSM did leave EXPORTING** — yet a `[export lifecycle][render] snapshot` line shows controls still disabled because `replaySaving=true` (v1 latch never cleared) and/or `saveControlsDisabled=true` derived from a stale input. This is the render/derived owning-input case the ticket targets. |
| **handler threw** | A terminal `export.*` was received (engine.ts `received` line present) but **no** matching `post-transition` line follows, indicating the handler threw before completing the transition. Cross-check renderer console for an exception. |
| **duplicate re-entry** | Two `v2SaveReplay start (…)` render lines for the same buffer without an interleaved `finally`, and/or main log `export.rejected reason_code=…` (helper rejected a duplicate export request). |
| **inconclusive** | Use **only** if evidence capture itself failed (LogPanel/main log/helper-log missing or truncated) — never as a default verdict. |

## How the render snapshot disambiguates the core ISS-012 question

ISS-012 = "valid MP4 landed + 100%, but renderer stuck in EXPORTING, controls disabled."
The single decisive line is the `[export lifecycle][render] snapshot` at the moment of the hang:

- `v2State=EXPORTING` → ownership is the **FSM** (terminal event not received / stale-rejected /
  handler threw — see buckets above). Not a render-layer bug.
- `v2State=RECORDING`/`IDLE` **but** `saveControlsDisabled=true` or `replaySaving=true` →
  ownership is the **render/derived layer** (a renderer input held the UI after the FSM moved on).

`v2ExportProgress` / `v2ExportOutputPath` in the same line corroborate "valid output landed"
(progress=100 / non-null output path) independent of the disabled state.
