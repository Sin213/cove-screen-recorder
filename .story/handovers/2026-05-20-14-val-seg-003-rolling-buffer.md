# VAL-SEG-003 Rolling Buffer Diagnostics Pass

**Date:** 2026-05-20
**Issue:** ISS-005 — VAL-SEG-003: rolling buffer never commits a segment
**Branch:** main (uncommitted)
**Basis:** Rerun 13 evidence — VAL-CAP-004 GREEN, suite blocks at VAL-SEG-003

---

## What was done

Added five additive diagnostic fields to `SegmentDiagnosticsEvent` to enable root-cause triage of VAL-SEG-003 ("no committed segments available to pin"). The current diagnostics show `fragments_received` increasing but `segments_committed` remains 0 — these new fields distinguish between three hypotheses:

- **H1:** Encoder only marks first frame as keyframe → `keyframes_seen` stays at 1
- **H2:** `duration_eligible` never flips → `duration_eligible` stays false, `pending_duration_90k` never reaches target
- **H3:** Keyframes and duration are present but commit predicate doesn't fire → all fields look correct but `segments_committed` stays 0

---

## Files Changed

| File | Change |
|---|---|
| `helper/src/protocol/events.rs` | Added 5 fields to `SegmentDiagnosticsEvent` |
| `helper/src/segment/buffer.rs` | Added `keyframes_seen`, `last_keyframe_at` to `BufferInner`; track in push; populate at diagnostics emit; 2 new tests |
| `helper/src/sim/dispatch.rs` | Populate plausible values for 5 new fields in sim diagnostics |
| `.story/issues/ISS-005.json` | Filed issue for VAL-SEG-003 |

---

## Diagnostic Fields Added

| Field | Type | Source |
|---|---|---|
| `keyframes_seen` | `u64` | Incremented each time `fragment.is_keyframe` is true |
| `duration_eligible` | `bool` | Current value of `BufferInner::duration_eligible` |
| `pending_duration_90k` | `u64` | `pending.total_duration_90k` — sum of pending fragment durations |
| `pending_bytes` | `u64` | `pending.total_bytes` — sum of pending fragment byte lengths |
| `last_keyframe_age_ms` | `u64` | ms since last keyframe seen; `u64::MAX` if none seen yet |

---

## Hard invariants confirmed

- Schema change is additive only — no fields renamed, removed, or reordered
- Commit predicate unchanged: `is_keyframe && !pending.is_empty() && duration_eligible`
- `seen_first_keyframe` behavior unchanged
- No capture/cadence/NVENC/encoder changes
- No Electron/renderer/packaging changes
- `replay.save` behavior unchanged — still requires committed segments

---

## Verification Results

| Command | Result |
|---|---|
| `cargo build -p cove-replay-engine --release` | OK (71 pre-existing NVENC naming warnings) |
| `cargo test -p cove-replay-engine --lib` | 80/80 pass (2 new) |
| `cargo test -p cove-replay-engine --test segment_buffer` | 6/6 pass |
| `npm run typecheck` | OK |
| `npm run validate:build` | OK |
| `npm run build` | OK |
| `git diff --check` | exit 0 |

---

## New Tests

1. `diagnostics_event_includes_keyframe_metrics` — pushes 2 keyframes + 1 non-keyframe, asserts `keyframes_seen=2`, `last_keyframe_at` is `Some`, `duration_eligible=false` (below target), pending duration accumulates
2. `diagnostics_event_after_commit_resets_pending` — pushes fragments to reach `target_duration_90k`, then a new keyframe triggers commit. Asserts pending resets, `keyframes_seen` increments, segment file exists on disk

---

## Smoke Evidence

**Not yet run.** This is a diagnostics-only patch. Smoke rerun to collect new diagnostic fields will be run after Codex review.

---

## H1/H2/H3 Verdict

**Unknown** — requires smoke rerun with the new diagnostic fields to determine.

---

## VAL-CAP-004 Sanity

**GREEN** — Rerun 13 confirmed. No capture/cadence changes in this patch.

---

## Next Recommended Pass

1. Codex reviews this diagnostics patch
2. Commit (if approved)
3. Run smoke rerun 14 to collect diagnostics-during-save.jsonl with new fields
4. Analyze `keyframes_seen`, `duration_eligible`, `pending_duration_90k`, `pending_bytes`, `last_keyframe_age_ms` to determine H1/H2/H3
5. Fix rolling buffer commit logic based on diagnosis
6. Rerun smoke to confirm VAL-SEG-003 passes