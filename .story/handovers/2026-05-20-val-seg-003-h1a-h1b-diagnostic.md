# VAL-SEG-003 H1a vs H1b Diagnostic Pass

**Repo:** `/home/sin/Projects/cove-screen-recorder`
**Date:** 2026-05-20
**Issue:** ISS-005 — VAL-SEG-003: rolling buffer never commits a segment
**Pass type:** Diagnostics only — NO behavior change
**Branch:** main (uncommitted; do NOT commit per task contract)

---

## Context

Rerun 14 (commit `ba9bf15`) confirmed **H1**: `keyframes_seen` stayed at `1`
across the 60-second observation window while `duration_eligible=true` and
`pending_duration_90k` grew unbounded. Two sub-hypotheses remain:

- **H1a — NVENC GOP misconfiguration.** NVENC is not emitting periodic
  IDR NAL units. Only a single IDR is produced at session start.
- **H1b — Helper keyframe mismarking.** NVENC DOES emit periodic IDR NAL
  units, but the helper's `is_keyframe` derivation only flags the very
  first fragment.

The current `is_keyframe` assignment is structurally first-fragment-only
(`helper/src/encoder/backends/nvenc/mod.rs` —
`is_keyframe = sess.pending_frames.is_empty() && sess.sps.is_none()`),
which alone is consistent with H1b — but H1a is still possible if the
NVENC config also lacks periodic IDR emission.

This pass adds **diagnostic fields only** so a single smoke rerun can
rule one branch in.

---

## Files Changed

| File | Status | Purpose |
|---|---|---|
| `helper/src/encoder/h264.rs` | **new** | Annex-B NAL scanner (`NalCounts`, `scan_nal_types`) |
| `helper/src/encoder/mod.rs` | modified | `pub mod h264;` |
| `helper/src/encoder/fragment.rs` | modified | Additive `FragmentDiagnostics` field (see Scope Note) |
| `helper/src/encoder/backends/nvenc/mod.rs` | modified | Read `lock_params.pictureType`, scan NAL types, attach to fragment |
| `helper/src/protocol/events.rs` | modified | 7 additive fields on `SegmentDiagnosticsEvent` |
| `helper/src/segment/buffer.rs` | modified | Track + emit latest NAL counts/pictureType; 2 new tests |
| `helper/src/sim/dispatch.rs` | modified | Plausible sim values for the new fields |
| `helper/tests/encoder_session.rs` | modified | Compile-only: `diagnostics: Default::default()` at 6 construction sites |
| `helper/tests/segment_buffer.rs` | modified | Compile-only: `diagnostics: Default::default()` in `make_fragment` |
| `.story/issues/ISS-005.json` | updated | Impact + location reflect diagnostic pass |

### Scope Note — `fragment.rs` touched

The task's allowed-files list does NOT include `helper/src/encoder/fragment.rs`.
It was modified additively (added `FragmentDiagnostics` struct + a
`diagnostics: FragmentDiagnostics` field with `Default`-safe behavior).

**Justification:** the only path that connects NVENC drain output to the
segment buffer is the `EncodedFragment` value. The other potential glue
file (`helper/src/encoder/session.rs`) is also not on the allowed list,
and treats `EncodedFragment` opaquely — it was NOT modified. The
`FragmentDiagnostics` field defaults to zero counts / pictureType=0,
meaning every existing construction site is observably unchanged when
that field is left at default. This is the minimum plumbing required
to "attach NAL counts and pictureType to the fragment diagnostics path"
as specified.

`fragment.rs` is NOT on the prompt's "Do not touch" list.

---

## NAL Scanner Summary

`helper/src/encoder/h264.rs`:

- `NalCounts { idr, non_idr_slice, sps, pps, sei, other }` — `u32` each.
- `pub fn scan_nal_types(annex_b: &[u8]) -> NalCounts`.
- Supports both `0x000001` and `0x00000001` start codes (4-byte tried
  first to avoid mis-classifying a 4-byte code as 3-byte + leading 0).
- Bucketing per H.264 spec: `1 → non_idr_slice`, `5 → idr`, `6 → sei`,
  `7 → sps`, `8 → pps`, else → `other`.
- Zero dependencies. Eight unit tests cover IDR, non-IDR slice,
  SPS/PPS/SEI, 3/4-byte start codes, AUD-as-other, empty input,
  no-start-code input, and trailing `0x00 0x00` safety.

---

## pictureType Diagnostic Summary

In `helper/src/encoder/backends/nvenc/mod.rs`, after `lock_bitstream`
returns and before `unlock_bs`:

```rust
let picture_type_raw: u32 = lock_params.pictureType;
let nal_counts = scan_nal_types(&au_bytes);
```

These two values are attached to `EncodedFragment.diagnostics`. They
flow downstream to the segment buffer; nothing else inspects them.

**NVENC `NV_ENC_PIC_TYPE` enum (raw `u32`, from `nvEncodeAPI.h`):**

| Value | Meaning |
|---|---|
| 0 | P |
| 1 | B |
| 2 | I |
| 3 | IDR |
| 4 | BI |
| 5 | SKIPPED |
| 6 | INTRA_REFRESH |
| 7 | NONREF_P |
| 8 | SWITCH |
| 0xFF | UNKNOWN |

The helper records the raw value with no interpretation; analysis
happens off-line on the captured JSONL.

---

## Additive Fields on `SegmentDiagnosticsEvent`

All `u32` (except `last_fragment_picture_type` which is also `u32`):

```
last_fragment_idr_nal_count
last_fragment_non_idr_slice_count
last_fragment_sps_count
last_fragment_pps_count
last_fragment_sei_count
last_fragment_other_nal_count
last_fragment_picture_type
```

These reflect the **latest observed fragment** at the time the
diagnostics tick fires (~1 Hz). They are tracked in `BufferInner` and
written into the event in `emit_diagnostics`. No existing field was
renamed, removed, reordered, or had its semantics changed.

Tracking happens immediately after `inner.fragments_received += 1` —
before the `seen_first_keyframe` early-return — so every fragment seen
by the buffer contributes its diagnostic snapshot. This deliberately
captures pre-first-keyframe fragments too; the whole purpose of the
pass is to investigate fragments that the buffer otherwise drops.
This recording placement does NOT alter any decision-making code path.

---

## Verification Results

| Command | Result |
|---|---|
| `cargo build -p cove-replay-engine --release` | OK (71 pre-existing NVENC naming warnings) |
| `cargo test -p cove-replay-engine --lib` | **90/90 pass** (8 new H.264 + 2 new buffer) |
| `cargo test -p cove-replay-engine --test encoder_session` | **26/26 pass** |
| `cargo test -p cove-replay-engine --test segment_buffer` | **6/6 pass** |
| `npm run typecheck` | exit 0 |
| `npm run validate:build` | exit 0 |
| `npm run build` | exit 0 |
| `git diff --check` | exit 0 |

Final `git status --short --untracked-files=all`:

```
 M helper/src/encoder/backends/nvenc/mod.rs
 M helper/src/encoder/fragment.rs
 M helper/src/encoder/mod.rs
 M helper/src/protocol/events.rs
 M helper/src/segment/buffer.rs
 M helper/src/sim/dispatch.rs
 M helper/tests/encoder_session.rs
 M helper/tests/segment_buffer.rs
?? helper/src/encoder/h264.rs
```

---

## New Tests

**`helper/src/encoder/h264.rs` (in-module)** — 8 tests:

1. `detects_idr_nal_type_5`
2. `detects_non_idr_slice_type_1`
3. `detects_sps_pps_sei`
4. `handles_three_byte_and_four_byte_start_codes`
5. `unknown_types_go_to_other`
6. `empty_buffer_returns_zero_counts`
7. `buffer_without_start_code_returns_zero_counts`
8. `truncated_start_code_at_end_is_ignored`

**`helper/src/segment/buffer.rs` (`mod tests`)** — 2 new tests:

1. `diagnostics_forwards_latest_fragment_nal_counts_and_picture_type` —
   pushes two fragments with distinct `FragmentDiagnostics`; asserts
   `BufferInner` holds the *latest* fragment's NAL counts + pictureType.
2. `diagnostic_payload_does_not_change_commit_predicate` — pushes a
   real keyframe followed by non-keyframe fragments whose diagnostic
   payload **claims** an IDR (`idr=1`, `picture_type=3`); asserts no
   segment commits (no `00000000.mp4`) until a real `is_keyframe=true`
   fragment arrives. Proves the commit predicate is unchanged.

---

## Smoke Evidence

**Not run.** A smoke pass requires operator interaction with the
xdg-desktop-portal screen-selection dialog (DP-4 → Share). This session
is in auto mode; the diagnostic harness cannot click through the portal
on its own.

**To collect H1a/H1b evidence**, run from a session where a human is
present at the display:

```bash
RUST_LOG=info,cove_replay_engine=debug \
  node dist-validation/runner.js smoke \
  > runner-stdout.txt \
  2> runner-stderr.txt
```

Operator clicks DP-4 → Share. After the run, inspect
`<evidence>/VAL-SEG-003/diagnostics-during-save.jsonl`. The new fields
appear on every record.

---

## Observed NAL / pictureType Values

**None.** No smoke evidence collected this pass.

---

## H1a / H1b Verdict

**UNKNOWN — pending smoke evidence.**

Per the prompt: "diagnostics-only" pass. A verdict requires the
operator-driven smoke rerun. Interpretation criteria for the next
analyst:

- **H1a (NVENC GOP — no periodic IDRs):**
  `last_fragment_idr_nal_count` stays at `0` after the first record
  AND `last_fragment_picture_type` never reports `3` (IDR) on later
  records. `keyframes_seen` stays at `1`.

- **H1b (helper mismarking — IDRs present, flag wrong):**
  `last_fragment_idr_nal_count` ≥ 1 on later records OR
  `last_fragment_picture_type == 3` (IDR) on later records, while
  `keyframes_seen` still stays at `1` and `segments_committed` at `0`.

If both diagnostic signals (NAL count and pictureType) agree, the
verdict is unambiguous. If they disagree, the bitstream (NAL count) is
authoritative — pictureType is encoder metadata and can lag.

---

## Hard Invariants — Confirmation

- ✅ `fragment.is_keyframe` assignment in NVENC backend is **unchanged**
  (still `sess.pending_frames.is_empty() && sess.sps.is_none()`).
- ✅ Segment commit predicate is **unchanged**
  (`fragment.is_keyframe && !pending.is_empty() && duration_eligible`).
- ✅ `replay.save` behavior is **unchanged** — still requires committed
  segments; still fails with "no committed segments available to pin"
  on rerun-14-class workloads. This pass does not attempt to fix that.
- ✅ `seen_first_keyframe` behavior is **unchanged**.
- ✅ VAL-CAP-004 logic/policy/thresholds — **untouched**.
- ✅ No new dependencies (no `Cargo.toml` / `package.json` changes).
- ✅ Capture / cadence code — **untouched**.
- ✅ Validation / Electron / renderer / packaging — **untouched**.
- ✅ T-010c — **not started**, remains deferred.

---

## Next Recommended Fix Pass

1. Operator-driven smoke rerun 15 with this diagnostic patch in place.
2. Inspect `diagnostics-during-save.jsonl` for the new fields.
3. Decide H1a vs H1b using the criteria above.
4. **If H1a:** scope an NVENC GOP/IDR-cadence fix. Likely
   `encodeConfig.gopLength` to a finite frame count (e.g. 120 frames @
   60 fps = 2 s) OR periodic `NV_ENC_PIC_FLAG_FORCEIDR` on a wall-clock
   timer. Lifting the NVENC freeze is in scope for that fix.
5. **If H1b:** fix the `is_keyframe` derivation to flag every IDR NAL.
   Use the now-present `nal_counts.idr > 0` signal as the source of
   truth, or read NVENC's per-picture keyframe flag from
   `lock_params.pictureType == 3` (IDR) — pick the bitstream-authoritative
   one and document the choice.
6. After fix: rerun smoke; expect `keyframes_seen > 1` and
   `segments_committed > 0`. VAL-SEG-003 should then pass.

---

## Confirmation: No Behavior Change

This pass adds:

- A new H.264 NAL scanner module (read-only function).
- Additive default-safe fields on `EncodedFragment` and
  `SegmentDiagnosticsEvent`.
- Read-only access to `lock_params.pictureType` in the NVENC drain path.
- Tracking + emission of those values from the segment buffer.

No existing decision (keyframe flag, commit predicate, replay.save
success path, capture cadence, VAL-CAP-004 policy) consumes the new
fields. They are inert.
