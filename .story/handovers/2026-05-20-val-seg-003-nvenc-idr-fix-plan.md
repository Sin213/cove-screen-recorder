# VAL-SEG-003 NVENC periodic IDR fix (ISS-005 phase 1+2)

**Date:** 2026-05-20
**Branch:** main (uncommitted)
**Issue:** ISS-005 — VAL-SEG-003: rolling buffer never commits a segment
**Diagnosis basis:** Rerun 15 (commit `b7d6b13`) confirmed H1a — NVENC emitted no periodic IDR NALs and reported non-IDR `pictureType` at every sampled diagnostic tick. `keyframes_seen` stayed at 1 across the 60 s window; the rolling-buffer commit predicate (`is_keyframe && !pending.is_empty() && duration_eligible`) could not fire a second time.

---

## What this patch does

### Phase 1 — encoder (load-bearing)

1. **Force a real periodic IDR on every GOP boundary.** In `helper/src/encoder/backends/nvenc/mod.rs`:
   - Added `NV_ENC_PIC_FLAG_FORCEIDR = 0x2` (SDK 12.x).
   - `EncodeSession` gained two fields: `gop_size: u32` (stored as `gop_size.max(1)`, derived from `fps * cfg.gop_seconds`) and `frame_count: u64` (per-frame submission counter).
   - `push_frame` computes `is_idr_boundary = frame_count % gop_size == 0` and ORs `NV_ENC_PIC_FLAG_FORCEIDR` into `pic_params.encodePicFlags` on each boundary. `frame_count` is incremented after a successful `encode_pic`.
   - Removed the old first-frame-only heuristic `pending_frames.is_empty() && sps.is_none()`.

2. **Derive emitted `is_keyframe` from the bitstream.** In `drain`:
   - `nal_is_keyframe = nal_counts.idr > 0` is computed from the Annex-B scan.
   - Both `fmp4::build_fragment(...)` and `EncodedFragment.is_keyframe` use that bool.
   - `PendingFrame.is_keyframe` was unused after this change and was removed (eliminates a new dead-code warning; encoder-side intent now lives only in `is_idr_boundary` inside `push_frame`).
   - `extract_sps_pps` behaviour is unchanged.

3. **Test coverage** in `helper/tests/encoder_session.rs`:
   - Existing `nvenc_one_frame_shm_encode_produces_fmp4_fragment` now asserts `fragments[0].is_keyframe == true` and `fragments[0].diagnostics.nal_counts.idr > 0`.
   - New `nvenc_periodic_idr_at_gop_boundary` pushes `gop_size + 1` frames (fps=30, gop_seconds=0.5 → gop_size=15, 16 frames), asserts at least two fragments have `is_keyframe == true`, expects keyframes near frame 0 and frame `gop_size` (±1 tolerance), and re-asserts each keyframe-flagged fragment has `nal_counts.idr > 0`. Hardware-gated; skips cleanly on `ProbeOutcome::Unavailable`.

### Phase 2 — diagnostic-only observability

4. **Constant.** `helper/src/encoder/fragment.rs`: `pub const NV_ENC_PIC_TYPE_IDR: u32 = 3` (re-export of NVENC's IDR picture type code; used only for diagnostic classification).

5. **Cumulative counters** in `helper/src/segment/buffer.rs`:
   - `BufferInner` gained `idr_nal_count_total: u64` and `picture_type_idr_count_total: u64`, initialised to 0.
   - In `push()`, after the existing `last_fragment_*` snapshot block and **before** the `seen_first_keyframe` early-return, counters increment via `saturating_add(1)`:
     - `idr_nal_count_total` when `fragment.diagnostics.nal_counts.idr > 0`.
     - `picture_type_idr_count_total` when `fragment.diagnostics.picture_type == NV_ENC_PIC_TYPE_IDR`.
   - `emit_diagnostics` includes both counters in the `SegmentDiagnosticsEvent`.
   - **Counters are emit-only.** They do not appear in the commit predicate, `seen_first_keyframe`, or any `replay.save` decision path.

6. **Schema additions.** `helper/src/protocol/events.rs`: additive `pub idr_nal_count_total: u64` and `pub picture_type_idr_count_total: u64` on `SegmentDiagnosticsEvent`. `helper/src/sim/dispatch.rs` returns plausible simulated values (`tick / 2 + 1` to track cumulative even-tick IDR landings).

7. **Test coverage** in `helper/tests/segment_buffer.rs`:
   - New `cumulative_idr_counters_track_diagnostics_without_committing` constructs a custom-notifier `SegmentBuffer`, pushes a mix of (keyframe + IDR diag), (non-keyframe + zero diag), (non-keyframe + IDR diag), and (keyframe + IDR diag), waits 1.1 s, triggers one diagnostics emit, then asserts on the captured `replay.segmentDiagnostics` payload:
     - `idr_nal_count_total == 3` (one per IDR-shaped fragment, regardless of `is_keyframe`).
     - `picture_type_idr_count_total == 3`.
     - `keyframes_seen == 2` (the diagnostic counter must not bleed into the keyframe counter).
     - `buf.committed_segments().await.is_empty()` — the non-keyframe-with-IDR-diag fragment must not trigger a commit.

---

## Hard invariants confirmed

- Commit predicate `is_keyframe && !pending.is_empty() && duration_eligible` is **unchanged**.
- `replay.save` behaviour is **unchanged** (still requires committed segments).
- No changes under `helper/src/encoder/backends/nvenc/ffi.rs`, `helper/src/encoder/backends/nvenc/fmp4.rs`, `helper/src/encoder/h264.rs`, `helper/src/capture/`, `validation/`, `helper/src/replay/`, `electron/`, `src/`, `packaging/`, `.github/`, `package.json`, `package-lock.json`, `Cargo.toml`, or `Cargo.lock`.
- VAL-CAP-004 cadence/drop logic untouched.
- T-010c / T-021 ticket state untouched.
- Schema changes are additive only (new optional-on-deserialize fields on `SegmentDiagnosticsEvent`).
- New cumulative counters use `saturating_add` so they cannot overflow a session into UB.

---

## Files changed

| File | Change |
|---|---|
| `helper/src/encoder/backends/nvenc/mod.rs` | FORCEIDR cadence, `gop_size`/`frame_count` session fields, bitstream-derived `is_keyframe`, removed `PendingFrame.is_keyframe`, removed unused `NV_ENC_PIC_FLAG_FORCEINTRA` const |
| `helper/src/encoder/fragment.rs` | `pub const NV_ENC_PIC_TYPE_IDR: u32 = 3` |
| `helper/src/segment/buffer.rs` | `idr_nal_count_total` / `picture_type_idr_count_total` (additive, diagnostic-only) |
| `helper/src/protocol/events.rs` | Two new `u64` fields on `SegmentDiagnosticsEvent` |
| `helper/src/sim/dispatch.rs` | Plausible simulated values for the new counters |
| `helper/tests/encoder_session.rs` | Updated one-frame test assertions + new `nvenc_periodic_idr_at_gop_boundary` |
| `helper/tests/segment_buffer.rs` | New `cumulative_idr_counters_track_diagnostics_without_committing` |
| `.story/issues/ISS-005.json` | Implementation note appended (status remains `open`) |

`git status --short --untracked-files=all` reports only the seven modified files above plus this handover (untracked).

---

## Verification

| Command | Result |
|---|---|
| `cargo build -p cove-replay-engine --release` | exit 0; 70 warnings (down from 71 — the prior FORCEINTRA dead-code warning is gone) |
| `cargo test -p cove-replay-engine --lib` | 90 passed |
| `cargo test -p cove-replay-engine --test encoder_session` | 27 passed (incl. real-NVENC `nvenc_periodic_idr_at_gop_boundary`) |
| `cargo test -p cove-replay-engine --test segment_buffer` | 7 passed (incl. new cumulative counter test) |
| `npm run typecheck` | exit 0 |
| `npm run validate:build` | exit 0 |
| `npm run build` | exit 0 |
| `git diff --check` | exit 0 |

The hardware-gated GOP-boundary test passed on this box's NVENC driver (`595.71.05`, CUDA 13.2) — `FORCEIDR` produces real IDR-class NALs on this preset, so the Phase 2 STOP gate is clear and there is no need to escalate to `encodeConfig.gopLength` (Candidate A in the rerun-15 protocol).

---

## Next step

**Run MVP smoke rerun 16** against this patch to confirm:

- `segments_committed > 0` in `replay.segmentDiagnostics`.
- `idr_nal_count_total` and `picture_type_idr_count_total` grow in lockstep with `keyframes_seen`.
- `replay.save` returns a snapshot (no `no committed segments available to pin`).
- VAL-SEG-003 turns green; VAL-CAP-004 remains green (no capture/cadence code changed).

Only after rerun 16 is green should ISS-005 be resolved and T-010c be unblocked.
