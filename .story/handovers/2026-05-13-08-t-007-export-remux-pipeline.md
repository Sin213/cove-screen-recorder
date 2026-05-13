# Handover — T-007 Instant replay export/remux pipeline

**Date:** 2026-05-13
**Session type:** Design only (planning, no code)
**Repo:** `/home/sin/Projects/cove-screen-recorder`
**Branch:** `main` (clean coming in; only `.story/` files changed during this session)
**Ticket:** T-007 (Design instant replay export/remux pipeline)
**Status going out:** T-007 `complete`

---

## What was decided

The export layer of the v2 helper is locked. Full design lives in `.story/notes/N-006.json` (21 sections covering responsibility scope, T-006 boundary, the export state machine, the four operating modes with binding preconditions, the planning matrix, cadence preservation rules, the audio sidecar mux slot, final naming + temp strategy, atomic move semantics, the exactly-once snapshot release policy, cancel boundaries, queue behaviour, the six structural anti-freeze invariants, the binding failure-mode catalogue, helper-exit handling, diagnostics counters, the IPC event surface, the T-008 consumption contract, the validation matrix, deferred items, and open non-blocking implementation items). Summary in `.story/project-state.md` under "v2.0.0 instant replay export/remux pipeline (T-007, 2026-05-13)". The ticket description in `.story/tickets/T-007.json` was rewritten to carry the locked decisions standalone.

One-paragraph summary: the export pipeline is a helper-side module on a separate Tokio task that consumes a `ReplaySnapshot` (T-006 §5) and turns the pinned fMP4 segments into a single playable MP4 with `+faststart`. It runs an explicit state machine (`IDLE → QUEUED → PROBING → PLANNING → EXECUTING → MUXING → VALIDATING → FINALIZING → DONE`) where every transition emits an IPC event — the UI never has to infer state from elapsed time, which is the structural answer to the v1.1.x freeze-during-save bug. Mode is chosen once in PLANNING and locked at EXECUTING: `fast` (stream-copy concat when codec/profile/level/timescale/dims/pixel_format/SPS/PPS all match and head trim is on IDR), `lead-reencode` (head GOP re-encoded with libx264 only, tail stream-copied) for mid-GOP head trims, `discontinuity` (libx264 bridges around each crossing, copy outside) when `has_discontinuity == true` and bridges < 60 % of total, and `full-reencode` (single libx264 pass) under "Maximum compatibility" toggle or as the > 60 % escape valve. **Linux re-encode is libx264 only — HW is never asked to re-encode.** Cadence is preserved structurally (no re-stamping, no implicit CFR coercion, `samples_duplicated_total` must be 0) — no fake 60 fps. The audio sidecar slot is reserved in the mux step but unimplemented in v2.0.0. Snapshot release is exactly-once via a `SnapshotGuard` whose Drop releases the pin. Capture is NEVER paused for any export stage; the export task does not share locks with capture or encoder; ffmpeg is one-try with structured errors, never a retry loop. Final move is fsync + atomic rename + dir-fsync; temp files live in `<output_dir>/.cove-replay-<snapshot_id>.partial.mp4` and orphan-cleanup runs on next helper launch via an append-only exports manifest.

---

## Chosen export/remux design (binding)

### Export state machine

```
IDLE
 │ replay.save returns ReplaySnapshot
 ▼
QUEUED
 │ worker picks up
 ▼
PROBING              ── reason ─▶ FAILED
 │ inspect SPS/PPS/profile/level/timebase/IDR-front per SegmentRef
 ▼
PLANNING             ── reason ─▶ FAILED
 │ choose mode: fast | lead-reencode | discontinuity | full-reencode
 ▼
EXECUTING ┐
 │        ├── COPY            (fast path / non-discontinuity stretches)
 │        ├── REENCODE_HEAD   (lead trim mid-GOP)
 │        ├── REENCODE_BRIDGE (each discontinuity)
 │        └── REENCODE_FULL   (max-compat or escape valve)
 ▼
MUXING               ── reason ─▶ FAILED
 │ build moov + mdat into temp file; +faststart guaranteed
 ▼
VALIDATING           ── reason ─▶ FAILED
 │ ffprobe sanity, container check, first-frame decode probe
 ▼
FINALIZING           ── reason ─▶ FAILED
 │ fsync temp, atomic rename to final, fsync parent dir, snapshot_release
 ▼
DONE

Any state → CANCELLING (on user cancel) → CANCELLED
        (VALIDATING / FINALIZING reject cancel; UI disables button there)
Any state → FAILED on terminal error
DONE / FAILED / CANCELLED → IDLE (worker picks next queue item)
```

### Four operating modes (binding)

| Mode | Trigger | Encoder used | Cadence handling |
| ---- | ------- | ------------ | ---------------- |
| `fast` | Head trim on IDR/segment boundary, no discontinuity, all segments share codec/profile/level/timescale/dims/pixel_format/SPS/PPS | None (stream copy) | Sample table preserved exactly; no re-stamping |
| `lead-reencode` | Mid-GOP head trim, otherwise fast-compatible | **libx264 only** (Linux rule) | Head GOP re-encoded with passthrough vsync; ends with fresh IDR for clean concat with stream-copied tail |
| `discontinuity` | `has_discontinuity == true`, bridges < 60 % of total | **libx264 only** for bridges | Real PTS deltas through decoder→encoder; passthrough vsync; stretches outside bridges stream-copied |
| `full-reencode` | "Maximum compatibility" toggle OR escape valve from > 60 % bridges OR probe matrix fall-through | **libx264 only** | Passthrough vsync; preset `medium`, CRF 20, GOP 2 s |

Mode is decided exactly once in PLANNING and locked at EXECUTING. No silent fallback between modes mid-execution. **HW encoders never participate in finalisation re-encode on any platform** — that is the v1.1.0 broken-fallback-loop fix carried forward through T-005 / N-004 §13 and bound into this design.

### Planning matrix (first match wins)

1. User has "Maximum compatibility" toggle → `full-reencode`.
2. `has_discontinuity == true`:
   - Bridges < 60 % of snapshot duration → `discontinuity`.
   - Else → `full-reencode`.
3. Any pairwise mismatch in `{codec, profile_idc, level_idc, timescale, width, height, pixel_format, SPS, PPS}` → `full-reencode`.
4. Trim is mid-GOP at the leading edge → `lead-reencode`.
5. Otherwise → `fast`.

PLANNING emits a `PlanReport { mode, copy_ranges, reencode_ranges, est_output_bytes, est_duration_s, expected_fps }` carried by the `export.started` event.

### Snapshot release policy (exactly-once)

Pin is owned by a `SnapshotGuard(Arc<Snapshot>)`:
- **DONE:** explicit release before `export.completed` emit.
- **FAILED / CANCELLED / panic / helper exit:** Drop releases.
- `#[must_use]`; debug-build panic on drop-without-outcome.

Release fires exactly once in every code path including process crash (via OS teardown clearing `pid.lock` and T-006 recovery layers reclaiming the underlying session).

### Cancel boundaries

- **COPY:** checked between segments; ≤ 2 s of unfinishable work.
- **REENCODE_*:** ffmpeg drains gracefully up to 5 s, then SIGKILL.
- **MUXING:** in-progress moov/mdat write discarded; temp unlinked.
- **VALIDATING / FINALIZING:** cancel is rejected (rename race window). UI disables the cancel button.
- All successful cancels: temp unlinked, snapshot released, `export.cancelled` emitted. No partial-file recovery.

### Anti-freeze invariants (the v1.1.x bug made structurally impossible)

1. Snapshot is paths, not bytes (T-006 §5).
2. Export task does not share locks with capture or encoder tasks.
3. Every state transition emits an IPC event; UI spinner bound to event lifecycle, not a timer.
4. Per-export watchdog fires `export.stalled` (5 s / COPY, 10 s / REENCODE_*, 2 s / MUXING+VALIDATING+FINALIZING) but does NOT auto-kill.
5. ffmpeg is one-try with structured errors — NEVER a retry loop.
6. Capture is not paused for any export stage, even full re-encode of a 10-minute snapshot.

### Final file naming + temp + atomic move

- Output dir default: `$XDG_VIDEOS_DIR/Cove Replays/` (Linux), `%USERPROFILE%\Videos\Cove Replays\` (Windows). Lazily created, mode 0700.
- Final name: `Replay-<YYYY-MM-DD>-<HHMMSS>-<duration>s.mp4` with `-<n>` collision suffix.
- Temp: `<output_dir>/.cove-replay-<snapshot_id>.partial.mp4` — same FS as final to keep rename atomic.
- Atomic move: fsync temp → close → SHA-256 (single sequential read) → POSIX `rename(2)` / Windows `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` → directory fsync (Linux) or `FlushFileBuffers` on dir handle (Windows) → manifest `outcome = success` → emit `export.completed`.
- Orphan tracking: append-only `$XDG_STATE_HOME/cove-screen-recorder/exports/manifest.jsonl`. Next launch unlinks any temp whose start line lacks an end line.

### Queue behaviour

- Single-worker FIFO. Depth cap 8.
- Each `replay.save(...)` pins its own snapshot immediately — user CAN keep saving while another export runs.
- Ninth submission → `export.rejected(queue-full)`; the rejected snapshot is released immediately.
- In-memory queue only; helper crash loses queue state. T-006 recovery layers offer orphaned snapshots back to the user.

### Cadence / FPS preservation (v1.1.0 lesson made structural)

- Fast and lead-reencode: sample timing preserved exactly via MP4 sample table. No re-stamping.
- Discontinuity and full-reencode: real PTS deltas pass through decoder → encoder. libx264 invoked with passthrough vsync — no implicit CFR coercion.
- `samples_duplicated_total` MUST be 0 in production. Non-zero is a defect, triggers a diagnostics dump.
- `fps_observed_out` computed from the muxed sample table, not parsed from ffmpeg stderr.
- **No fake 60 fps anywhere in the pipeline.**

### Audio sidecar mux slot (future-proofing, no implementation in T-007)

- Mux step has `if let Some(audio) = snapshot.audio_segments { ... }`.
- v2.0.0 audio plan: AAC-LC, single track, shared `t0_ns` with video — v1.1.0 audio sidecar stability fix expressed as contract.
- Audio always stream-copied even when video re-encodes.
- Trim is sample-accurate via `edts/elst` edit list, not by re-encoding head AAC frame.
- If `audio_segments.is_none()`, produces video-only MP4 with no behaviour change. Audio encode itself = separate ticket.

### Failure modes (binding catalogue)

`snapshot-read-failed`, `probe-sps-pps-missing`, `ffmpeg-spawn-failed`, `ffmpeg-exited-nonzero` (carries last 8 KB stderr), `reencode-libx264-missing`, `mux-faststart-failed`, `validate-ffprobe-failed`, `validate-first-frame-decode-failed`, `finalize-rename-failed`, `finalize-disk-full`, `cancel-requested`, `helper-shutdown`.

Each fatal dumps last 30 s of T-007 counters + the PlanReport into `$XDG_STATE_HOME/cove-screen-recorder/diagnostics/<export_id>.json` — same shape as N-003 / N-004 / N-005.

### Progress / cancel / error event surface

```
export.queued      { export_id, snapshot_id, requested_duration_s }
export.started     { export_id, mode, plan: PlanReport, est_duration_s, est_output_bytes }
export.progress    { export_id, stage, pct, bytes_in, bytes_out, samples_processed, samples_total, eta_ms }   # ≥ 1 Hz
export.stalled     { export_id, stage, last_progress_ms_ago }
export.completed   { export_id, final_path, bytes, sha256, duration_s, mode, fps_observed_out }
export.failed      { export_id, stage, reason_code, details, diagnostics_path }
export.cancelled   { export_id, stage, partial_bytes }
export.rejected    { export_id, reason: "queue-full" }
```

Exactly one terminal event per `export_id`.

### Diagnostics counters (1 Hz + transitions)

`export_started_total`, `export_completed_total{mode}`, `export_failed_total{reason}`, `export_cancelled_total`, `export_queue_depth`, `export_queue_rejected_total`,
`export_stage_duration_ms.{queued,probing,planning,copy,reencode_head,reencode_bridge,reencode_full,muxing,validating,finalizing}.{p50,p95,p99}`,
`bytes_in_total`, `bytes_out_total`, `bytes_copied_total`, `bytes_reencoded_in_total`, `bytes_reencoded_out_total`,
`samples_total`, `samples_copied_total`, `samples_reencoded_total`, `samples_duplicated_total` (must be 0), `samples_dropped_total` (must be 0 outside trim),
`reencode_seconds_total`, `reencode_pixels_total`, `reencode_libx264_kfps.{p50,p95}`,
`fps_observed_in`, `fps_observed_out`, `fps_divergence_pct` (> 5 % triggers dump),
`ffmpeg_spawn_latency_ms.{p50,p95,p99}`, `ffmpeg_exit_code_last`,
`final_file_move_latency_ms.{p50,p95,p99}`, `final_file_size_bytes`, `final_file_sha256_compute_latency_ms`,
`temp_file_orphan_cleaned_total`, `exports_manifest_append_latency_ms.{p50,p95}`.

Pairs with N-003 §14 / N-004 §16 / N-005 §16 so any delay is triangulated to its source layer: snapshot vs probe vs copy vs re-encode vs mux vs finalize.

---

## Exact `.story` files changed this session

- `.story/notes/N-006.json` — **created**. Full design record (21 numbered sections).
- `.story/project-state.md` — **modified**. New section `## v2.0.0 instant replay export/remux pipeline (T-007, 2026-05-13)` inserted between the T-006 rolling buffer section and "Open issue triage".
- `.story/tickets/T-007.json` — **modified**. Status `open` → `inprogress` → `complete`. Description rewritten to carry the locked decisions standalone.
- `.story/handovers/2026-05-13-08-t-007-export-remux-pipeline.md` — **created**. This file.

---

## Source files changed

**None.** This was a planning-only session. No `package.json`, no lockfile, no Electron / renderer / recorder / ffmpeg code, no build config, no CI, no tests, no PipeWire code, no encoder code, no rolling-buffer code, no UI code.

---

## Out of scope (deferred — explicitly recorded)

- **Audio encode itself** (slot reserved in §7 of N-006; separate ticket).
- **HDR tone-mapping policy on export** (P010 → SDR). Reuses N-004 deferral.
- **AV1 export** (encoder side deferred in N-004).
- **User-facing trim adjustment UI** (T-008).
- **Cloud upload / share-link generation.** Outside helper entirely.
- **Multi-track exports** (separate mic / system audio). Reuses N-003 multi-stream deferral.
- **Subtitle / overlay burning.**
- **Per-export bitrate override** (re-encode uses fixed CRF).
- **GIF / WebM / image-sequence export.** v2.0.0 outputs MP4 only.
- **Open implementation items (non-blocking):** ffmpeg subprocess vs library (default subprocess), libx264 thread count default `min(num_cores − 2, 8)`, Windows long-path support on output dir, manifest fsync per-append vs batched (default per-append). To be pinned at the implementation ticket.

---

## Recommended next ticket

**T-008 — Design UI ↔ engine integration (IPC surface + UX states).** With T-007 complete, T-008 now has every helper-side method and event it needs to spec the Electron-side renderer surface:

- Capture method shape + `capture.sessionReady` / `capture.formatChanged` / `capture.sessionLost` events (T-004 / N-003).
- Encoder events `encoder.probeResult` / `encoder.selected` / `encoder.fallbackEngaged` / `encoder.runtimeError` / `encoder.backPressure` (T-005 / N-004).
- Replay events `replay.save` (sync return), `replay.snapshot_release`, `replay.recoverable_sessions` (T-006 / N-005).
- Export events `export.queued` / `export.started{plan}` / `export.progress` / `export.stalled` / `export.completed` / `export.failed` / `export.cancelled` / `export.rejected` (T-007 / N-006).
- Method surface for the renderer: `replay.save(N)`, `replay.export_start(snapshot, options)`, `replay.export_cancel(export_id)`, `replay.snapshot_release(snapshot_id)`.

T-008 can pin: the IPC transport choice (helper ↔ Electron), the typed message envelope, the renderer state machine for the in-record / recording / saving / completed / error states, the toast/notification placement for `export.stalled`, the disabled-cancel rule past MUXING, the recovered-session prompt on app launch, and the fallback-indicator chip in the status bar. T-008 should begin without any further input from T-007.

T-009 (validation matrix) is downstream and depends on T-008's UI definitions to spec player-side test coverage.

---

## Codex review

**No Codex review needed unless non-`.story` files changed.** This session only touched `.story/` planning files. Codex review remains gated on non-`.story` changes.

---

## Storybloq bookkeeping done this session

- `storybloq_ticket_update T-007 status=inprogress` (start) → `status=complete` with rewritten description (end).
- `storybloq_note_create` → N-006 (instant replay export/remux pipeline design record).
- `storybloq_handover_create` → this handover.
- `storybloq_snapshot` should be taken at end of session per the skill's session-lifecycle rule.

---

## Verification (run at end of session)

```bash
git status --short
git diff --name-only
find .story -maxdepth 3 -type f | sort
```

Expected: all changes confined to `.story/`. No source-file diff.
