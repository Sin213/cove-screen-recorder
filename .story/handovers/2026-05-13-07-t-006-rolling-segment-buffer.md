# Handover — T-006 Rolling replay segment buffer

**Date:** 2026-05-13
**Session type:** Design only (planning, no code)
**Repo:** `/home/sin/Projects/cove-screen-recorder`
**Branch:** `main` (clean coming in; only `.story/` files changed during this session)
**Ticket:** T-006 (Design rolling replay segment buffer)
**Status going out:** T-006 `complete`

---

## What was decided

The replay buffer layer of the v2 helper is locked. Full design lives in `.story/notes/N-005.json` (21 sections covering responsibility scope, the segment-file-per-GOP decision with rejected alternatives, on-disk layout, segment naming + in-memory index, the atomic write/rotate state machine, exposed replay-window presets, eviction policy with two-limit design, the save snapshot model that preserves the v1.1.0 fix, format-change handling, crash-safety invariants, three-layer recovery, failure-mode catalogue, I/O budget at the 4K60/50 Mbps ceiling, diagnostics counters and the cross-layer triangulation argument, the four structural reasons live capture cannot freeze on save, the audio extension slot, the temp-vs-committed table, the binding T-007 consumption contract, the validation matrix this design commits us to, deferred items, and open non-blocking implementation items). Summary lives in `.story/project-state.md` under "v2.0.0 rolling replay segment buffer (T-006, 2026-05-13)". The ticket description in `.story/tickets/T-006.json` was rewritten to carry the locked decisions standalone.

One-paragraph summary: the rolling replay buffer is a helper-side module sitting between the encoder's `EncodedFragment` stream (T-005) and the export pipeline (T-007). It writes **one fMP4 segment file per GOP (~2 s)** into a per-session directory under `$XDG_STATE_HOME/cove-screen-recorder/replay/<sessionId>/`, appending fragments to a `.partial` and atomically renaming to `.m4s` at every IDR. Eviction enforces two limits in parallel — a primary `replay_window_seconds` (presets 30 s / 60 s / 2 m / 5 m / 10 m) and a safety-net `disk_cap_bytes` (default scaled from bitrate, clamped to an 8 GB user ceiling) — and runs after every commit, never before. Save is a **paths-not-bytes** snapshot: `replay.save(N)` forces IDR via the T-005 `force_idr_now()` API, drains to the next IDR-fronted fragment (≤ 250 ms), pins the segment range plus `init.mp4`, returns a `ReplaySnapshot` immediately, and T-007 reads pinned files on a separate task while capture and segment-writing continue uninterrupted. Pinned segments cannot be evicted; eviction defers and tries again next commit. Crash safety rests on three invariants: every `.m4s` is the product of completed atomic rename + fsync + parent-dir fsync; every `.partial` is discarded on recovery; `init.mp4` + `manifest.json` are durable. Recovery layers are manifest > JSONL replay > filesystem scan (which parses fMP4 headers for orphan `.m4s` files from rename-without-jsonl-append crashes). The v1.1.0 freeze-during-save bug cannot reoccur for four structural reasons (paths-not-bytes, eviction defers to pins, async back-pressure between encoder and sink, force-IDR bounded ≤ 250 ms).

---

## Chosen rolling buffer design (binding)

- **Unit on disk:** one fMP4 segment file per GOP (~2 s, 8 fragments at 60 fps × 250 ms).
- **File naming:** `seg-<index>.m4s` with `index` an 8-digit zero-padded monotonic integer from 1. `.partial` suffix while in flight; atomic rename on commit.
- **Init segment:** `init.mp4` at session root, fsync'd before any fragment.
- **Indexes:** append-only `index.jsonl` (events: `add` / `evict`), clean-shutdown `manifest.json` digest, best-effort `current.txt` hint.
- **Lifetime lock:** `pid.lock` exclusive-locked while a session is live.
- **Commit cadence:** every IDR (~0.5 Hz). fsync only at commit; never per-fragment. Parent-dir fsync after every rename for POSIX durability.
- **In-memory index:** ~850 KB for a 10-min buffer; carries pts range, byte size, sample table, pin counter, discontinuity flag per segment.

---

## Segment / file layout

**Linux (binding):**

```
$XDG_STATE_HOME/cove-screen-recorder/replay/<sessionId>/
  init.mp4
  manifest.json          # written at clean shutdown only
  index.jsonl            # append-only; one line per add/evict event
  current.txt            # last-committed index (recovery hint)
  pid.lock               # held for live-session lifetime
  segments/
    seg-00000001.m4s
    seg-00000002.m4s
    ...
    seg-00000124.partial # in-flight
```

**Windows:** same shape under `%LOCALAPPDATA%\cove-screen-recorder\replay\<sessionId>\` using `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` for atomicity.

**Audio future slot reserved:** sibling `audio/aud-XXXXXXXX.m4s` directory; commits aligned to video segment boundaries; snapshot extends with `audio_segments`. Out of scope for T-006 beyond reserving the slot.

---

## Save snapshot model (preserves the v1.1.0 fix)

`replay.save(durationSeconds)`:

1. Call `encoder.force_idr_now()` (T-005 §19).
2. Wait for the next fragment with `is_keyframe_first == true` — bounded ≤ 250 ms + encoder fragment latency.
3. Commit the in-flight segment via the normal atomic-rename protocol.
4. Compute `trim_end_pts_90k = latest_committed.pts_end_90k`; `trim_start_pts_90k = trim_end - N × 90 000`.
5. Identify the lowest-indexed segment whose `pts_start_90k ≤ trim_start_pts_90k` and the highest-indexed segment whose `pts_end_90k ≥ trim_end_pts_90k`. Increment `pinned_by[snapshot_id]` on every segment in that range and on `init.mp4`.
6. Return `ReplaySnapshot { snapshot_id, session_id, init_segment_path, init_segment_bytes, segments: Vec<SegmentRef>, trim_start_pts_90k, trim_end_pts_90k, codec, timescale, width, height, framerate_hint, has_discontinuity, discontinuity_at_pts_90k }`. `SegmentRef` carries index, path, pts range, duration, byte size, `is_keyframe_first`, `discontinuity`, `fragment_count`.
7. Return immediately. T-007 reads pinned files on a separate task. Capture, encode, and segment-writing all continue uninterrupted.
8. On `replay.snapshot_release(snapshot_id)`, decrement pins. Any segment whose pin count is now zero and whose index is in the deferred eviction queue gets unlinked.

**Contract owed:** `replay.save(...)` returns ≤ 250 ms + encoder fragment latency; capture rate identical before / during / after; multiple concurrent snapshots allowed.

---

## Eviction policy

Two limits in parallel; first tripped wins. Eviction runs **after every commit**, never before:

1. **Window limit (primary):** committed duration > `replay_window_seconds + 1 GOP` headroom.
2. **Byte limit (safety net):** bytes > `disk_cap_bytes` = `max(replay_window_seconds × target_bitrate_bps / 8 × 1.5, 1 GB)` clamped to user-configurable 8 GB ceiling.

Per-segment granularity. Pinned segments cannot be evicted; eviction defers and tries again next commit. If pinned segments alone exceed the byte cap, `segment-sink-disk-full(pinned_by_save)` ends the session and allows the save in flight to complete.

Replay window presets exposed in the UI: **30 s, 60 s, 2 m, 5 m, 10 m.** Underlying setting accepts `[10, 1800]`. 10 min is the longest default; 30 min is the absolute ceiling.

---

## Crash safety policy

Three invariants:

1. **Committed `.m4s` files survive.** Product of atomic rename + fsync + parent-dir fsync. A crash mid-rename leaves either the `.partial` or the `.m4s`; never an intermediate state.
2. **Partial segments are discarded on recovery.** Every `.partial` file is unlinked. Worst-case loss is one GOP (~2 s) — identical to the IDR cadence the user cannot save below anyway.
3. **Init segment and manifest are durable.** `init.mp4` fsynced before any fragment; `manifest.json` written atomically (tmpfile + rename) at clean shutdown only.

**Recovery on next launch** triages each session directory in three layers:

- **Manifest layer:** if `manifest.json` exists, trust it.
- **JSONL replay layer:** replay `index.jsonl`, cross-check each `add` line's file exists, drop missing-file lines.
- **Filesystem-scan layer:** look for orphan `.m4s` files (committed but JSONL append never fsynced); parse fMP4 header for PTS; incorporate.

Recovered sessions are surfaced via `replay.recoverable_sessions()` as an optional save prompt to the user (T-008 wires the UI). After save or dismiss, the session directory is unlinked.

---

## Diagnostics counters (1 Hz + on state transitions)

Pairs with capture (N-003 §14) and encoder (N-004 §16) so any "dropped frames" question can be triangulated to its source layer:

```
fragments_received_total
fragments_dropped_orphan_total
segments_committed_total
segments_evicted_total
segments_pinned_count
segments_count_on_disk
bytes_on_disk_total
bytes_written_total
evict_bytes_freed_total
evict_blocked_by_pin_total
disk_write_latency_ms { p50, p95, p99 }
fsync_latency_ms      { p50, p95, p99 }
rename_latency_ms     { p50, p95, p99 }
push_fragment_pending_events_total
back_pressure_sustained_ms
save_snapshots_taken_total
save_snapshots_active
partial_segment_recovered_total
partial_segment_discarded_total
formatchange_segments_total
buffer_window_seconds_observed
buffer_bytes_pct_of_cap
```

`sessionLost` events dump the last 30 s of these counters into `$XDG_STATE_HOME/cove-screen-recorder/diagnostics/<sessionId>.json`, matching N-003 §13 / N-004 §17.

---

## Exact `.story` files changed this session

- `.story/notes/N-005.json` — **created**. Full design record (21 numbered sections).
- `.story/project-state.md` — **modified**. New section `## v2.0.0 rolling replay segment buffer (T-006, 2026-05-13)` inserted between the T-005 encoder section and "Open issue triage".
- `.story/tickets/T-006.json` — **modified**. Status `open` → `inprogress` → `complete`. Description rewritten to carry the locked decisions standalone.
- `.story/handovers/2026-05-13-07-t-006-rolling-segment-buffer.md` — **created**. This file.

---

## Source files changed

**None.** This was a planning-only session. No `package.json`, no lockfile, no Electron / renderer / recorder / ffmpeg code, no build config, no CI, no tests, no PipeWire code, no encoder code.

---

## Out of scope (deferred — explicitly recorded)

- **Audio encode and audio buffer layout.** Directory slot reserved in §3 / §16; design beyond that is a separate ticket.
- **Multi-stream replay** (two concurrent capture sessions writing to one buffer). Refused for v2.0.0 (matches N-003 capture deferral).
- **User-facing replay-window UI design.** T-006 defines the underlying setting + presets; T-008 wires the UI.
- **Encryption of segment files.** Out of scope; user can use LUKS / BitLocker / FileVault.
- **Cloud upload** of saved exports. Outside the helper entirely.
- **Pause / resume of the rolling buffer** beyond what the capture trait already does.
- **Manual eviction by the user.** Policy-driven only.
- **Open implementation items (non-blocking):** fMP4 muxer = ffmpeg `movenc`; Windows `FlushFileBuffers` semantics on network drives (refused by default); pre-session disk-space probe (`statvfs` / `GetDiskFreeSpaceEx`); `index.jsonl` compaction at clean shutdown only.

---

## Recommended next ticket

**T-007 — Design export and remux pipeline.** T-006 froze the only contract T-007 needs: the `ReplaySnapshot` shape (paths + PTS ranges + discontinuity list), the snapshot lifecycle (`replay.save` returns it; `replay.snapshot_release` ends the pin), and the four T-007 cases (trim-on-IDR concat + `+faststart`, trim-mid-GOP head/tail re-encode with libx264, libx264 re-encode across each discontinuity, libx264 full re-encode under "Maximum compatibility"). T-007 can begin without any further design input from T-006.

T-008 (UI ↔ engine integration) remains parallelisable; it now has the full capture method/event surface from T-004, encoder events from T-005, and replay events from T-006 (`replay.save`, `replay.snapshot_release`, `replay.recoverable_sessions`, plus diagnostics events).

---

## Codex review

**No Codex review needed.** This session only touched `.story/` planning files. Codex review remains gated on non-`.story` changes.

---

## Verification (run at end of session)

```bash
git status --short
git diff --name-only
find .story -maxdepth 3 -type f | sort
```

Expected: all changes confined to `.story/`. No source-file diff.
