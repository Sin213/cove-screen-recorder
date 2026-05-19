# ISS-002 / T-024 — NVENC version fix, Round 4: NV_ENC_INITIALIZE_PARAMS layout corrected; configure-time `:12` persists

**Date:** 2026-05-19
**Status:** `NV_ENC_INITIALIZE_PARAMS` re-laid-out to SDK 12.1. Probe path stays GREEN. `nvenc-init-failed:12` (NV_ENC_ERR_UNSUPPORTED_PARAM) **did not move** — the layout fix alone is not sufficient. Stopping per the handoff stop rule.
**Do not commit.** Codex review not run yet.

Follows:
- `.story/handovers/2026-05-19-09-iss-002-nvenc-version-fix-stop-report.md` (Round 1 — API version macros)
- `.story/handovers/2026-05-19-10-iss-002-nvenc-version-fix-stop-report-2.md` (Round 2 — device-type)
- `.story/handovers/2026-05-19-11-iss-002-nvenc-version-fix-stop-report-3.md` (Round 3 — encode-path version constants centralised)

---

## TL;DR

1. `NV_ENC_INITIALIZE_PARAMS` is now laid out to match the SDK 12.1 header:
   - 7 separate flag `u32` fields (`reportSliceOffsets`, `enableSubFrameWrite`, `enableExternalMEHints`, `enableMEOnlyMode`, `enableWeightedPrediction`, `enableOutputInVidmem`, `reserved`) collapsed into one packed `flags: u32`.
   - `maxMEHintCountsPerBlock: [u32; 2]` (8 bytes) corrected to `maxMEHintCountsPerBlockRow: [u32; 8]` (32 bytes) representing two `NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKROW` structs of 4 × `u32` each.
   - New fields exposed: `tuningInfo: u32` (`NV_ENC_TUNING_INFO`), `bufferFormat: u32` (`NV_ENC_BUFFER_FORMAT`).
   - `reserved1` length reduced from `[u32; 289]` to `[u32; 287]` to absorb the size delta of the new fields.
2. **Strict probe still PASS** — `COVE_NVENC_REQUIRE_AVAILABLE=1` test green on this NVIDIA host.
3. **`nvenc_one_frame_shm_encode_produces_fmp4_fragment` still fails with the same status:** `Runtime("nvenc-init-failed:12")`.
4. The driver is now accepting the version word, deviceType, and struct *size*, and rejecting the *content* of the struct — most likely `tuningInfo = NV_ENC_TUNING_INFO_UNDEFINED (0)` paired with a P-series preset GUID. SDK 12.1 documents `UNDEFINED` as invalid for encoding.
5. Setting `tuningInfo` (and possibly `bufferFormat`) to a real value is a **product decision** (HIGH_QUALITY vs LOW_LATENCY vs ULTRA_LOW_LATENCY) and is outside this round's authorization, which scoped to the layout. Stopping per the handoff rule:
   > “If a new NVENC status appears after fixing NV_ENC_INITIALIZE_PARAMS layout, stop again and report the exact status. Do not keep expanding into more structs without a fresh plan.”

---

## Round 4 patch (allowed scope only)

### `helper/src/encoder/backends/nvenc/mod.rs`
- Replaced `NV_ENC_INITIALIZE_PARAMS` (lines 113-140 previously) with the SDK 12.1-correct layout described above.
- **Struct doc-comment** describes the bit-field positions explicitly and notes that SDK 13+ adds `splitEncodeMode (4)`, `enableReconFrameOutput (1)`, and `enableOutputStats (1)` inside the same bit-field word; those bits remain inside the SDK-12.1 `reservedBitFields:26` slot and are not exposed here.
- No bit-field flags are enabled by `configure()` — the existing code did not toggle any of `reportSliceOffsets` / `enableSubFrameWrite` / etc., so the packed `flags: u32` is left zero-initialised. The bit positions are documented inline so a future caller can OR-in flags trivially.
- `configure()` body unchanged: all field assignments (`version`, `encodeGUID`, `presetGUID`, `encodeWidth`, `encodeHeight`, `darWidth`, `darHeight`, `frameRateNum`, `frameRateDen`, `enablePTD`, `maxEncodeWidth`, `maxEncodeHeight`) still reference fields that exist in the new struct.

### `helper/src/encoder/backends/nvenc/ffi.rs`
- Unchanged from Round 3. Six encode-path version constants still live here.

### `helper/tests/encoder_selection.rs`
- Unchanged from Round 1.

### Not touched (per handoff hard scope)
- All other NVENC structs in mod.rs (`NV_ENC_PIC_PARAMS`, `NV_ENC_LOCK_BITSTREAM`, `NV_ENC_CREATE_INPUT_BUFFER`, `NV_ENC_CREATE_BITSTREAM_BUFFER`, `NV_ENC_LOCK_INPUT_BUFFER`). See concern below.
- validation/, capture/, segment/, export/, transport/, protocol/, electron/, src/, packaging/, workflows/, Cargo files, ISS-002.json.

---

## Verification evidence (Round 4)

```
git status --short --untracked-files=all
 M helper/src/encoder/backends/nvenc/ffi.rs
 M helper/src/encoder/backends/nvenc/mod.rs
 M helper/tests/encoder_selection.rs
?? .story/handovers/2026-05-19-09-iss-002-nvenc-version-fix-stop-report.md
?? .story/handovers/2026-05-19-10-iss-002-nvenc-version-fix-stop-report-2.md
?? .story/handovers/2026-05-19-11-iss-002-nvenc-version-fix-stop-report-3.md
?? .story/handovers/2026-05-19-12-iss-002-nvenc-version-fix-stop-report-4.md

git diff --check
(clean)
```

Build / test on this NVIDIA host (RTX 4080 SUPER / driver 595.71.05):

- `cargo build -p cove-replay-engine --release` → OK (9.39s, 73 warnings — down from 77, due to the deleted parallel field declarations).
- `COVE_NVENC_REQUIRE_AVAILABLE=1 cargo test -p cove-replay-engine --test encoder_selection -- nvenc_probe_available_when_hardware_present --exact --nocapture` → **PASS**.
- `COVE_NVENC_FORCE_UNAVAILABLE=1 cargo test -p cove-replay-engine --test encoder_selection -- --test-threads=1` → 7/7 PASS.
- `cargo test -p cove-replay-engine -- --test-threads=1` → **1 FAILED**: same as Round 3 — `nvenc_one_frame_shm_encode_produces_fmp4_fragment` panics at `encoder_session.rs:1549:34`:
  ```
  configure must succeed when probe returned Available: Runtime("nvenc-init-failed:12")
  ```
  All other 25 tests in the binary pass; remainder of the crate passes.
- `npm run typecheck` → OK.
- `npm run validate:build` → OK.
- `npm run build` → OK.

---

## Cumulative status progression

| Round | Patch                                                              | Failure after patch                  |
|-------|--------------------------------------------------------------------|--------------------------------------|
| 0     | (baseline T-021 rerun 5)                                           | `nvenc-api-create-failed:15`        |
| 1     | API + session version macros, `NV_ENC_ERR_INVALID_VERSION=15`      | `session-create-failed:4`           |
| 2     | `NV_ENC_DEVICE_TYPE_CUDA = 1`                                      | `nvenc-init-failed:15`              |
| 3     | Centralised six encode-path version constants via `nvencapi_struct_version()` | `nvenc-init-failed:12`     |
| 4     | `NV_ENC_INITIALIZE_PARAMS` layout fix to SDK 12.1                  | `nvenc-init-failed:12`  *(unchanged)* |

The status `:12` did not move in Round 4 — the layout is now SDK-correct but a required field value is still wrong.

---

## What `:12` is most likely now

`NV_ENC_ERR_UNSUPPORTED_PARAM`. The driver is past the version-word check and past the struct-size check (since the layout now matches SDK 12.1). It is reading the *content* of fields it now correctly addresses, and rejecting something. Ranked candidates:

1. **`tuningInfo = NV_ENC_TUNING_INFO_UNDEFINED (0)` with `NV_ENC_PRESET_P4_GUID`.** SDK 12.1 docs state `UNDEFINED` is invalid for encoding. Setting `init_params.tuningInfo = 1` (HIGH_QUALITY) or another non-zero value is the most likely single-line fix.  Choosing the value is a product decision (screen-capture workloads often want `LOW_LATENCY=2` rather than `HIGH_QUALITY=1`).
2. **`bufferFormat = NV_ENC_BUFFER_FORMAT_UNDEFINED (0)`.** SDK 12.1 may require this be set for input buffers, even though it is also set later via `NV_ENC_CREATE_INPUT_BUFFER`.
3. **`encodeConfig = NULL` not actually permitted for this preset on this driver.** Some preset/driver combinations require an explicit `NV_ENC_CONFIG` populated via `nvEncGetEncodePresetConfigEx`. That would be a larger fix.
4. **Residual struct-layout error not yet caught.**  Cross-checking `std::mem::size_of::<NV_ENC_INITIALIZE_PARAMS>()` against the documented SDK size (expected ~1808 bytes) would settle this; the next pass should add that check.

---

## Authorization-vs-SDK contradiction (flagged for orchestrator)

The Round 4 authorization message said:

> Specifically fix the packed bitfield area:
>   reportSliceOffsets / enableSubFrameWrite / enableExternalMEHints / enableMEOnlyMode / enableWeightedPrediction / splitEncodeMode / enableOutputInVidmem / enableEncodeAsync / enablePTD / reservedBitFields
>   must be represented as the SDK's packed u32 bitfield, not separate u32 fields.

Two divergences from SDK 12.1:

- **`splitEncodeMode (4 bits)` is SDK 13.0+, not 12.1.** It is not part of the SDK 12.1 bit-field word.
- **`enableEncodeAsync` and `enablePTD` are *separate* `uint32_t` fields in every NVENC SDK header I have verified (12.0/12.1/12.2/13.0)** — they sit immediately *before* the bit-field word, not inside it.

I interpreted the message as (a) a high-level pointer at "fix the bit-field region and the surrounding repeated-`u32` area," (b) targeting SDK 12.1 to match the file comment in `ffi.rs:1` ("All types are sized per NVIDIA Video Codec SDK 12.1 headers"), and (c) the orchestrator's explicit *first-line* requirement "Correct `NV_ENC_INITIALIZE_PARAMS` to match SDK 12.1 layout."

The orchestrator should explicitly confirm in the next pass:
- **Target SDK:** 12.1 (current ffi.rs comment) or 13.0 (which would explain the `splitEncodeMode` mention).  Driver 595.71.05 supports both.
- **Bit-field membership** in that target SDK (with `enableEncodeAsync`/`enablePTD` definitively in or out).

If 13.0 is the target, the bit-field word and post-bit-field area both expand: `splitEncodeMode (4)` + `enableReconFrameOutput (1)` + `enableOutputStats (1)` join the bit field; `numStateBuffers` and `outputStatsLevel` join the post-pointer area, and `reserved1` shrinks accordingly.

---

## Concern that may shape the next-pass plan

`NV_ENC_PIC_PARAMS`, `NV_ENC_LOCK_BITSTREAM`, `NV_ENC_CREATE_INPUT_BUFFER`, `NV_ENC_CREATE_BITSTREAM_BUFFER`, and `NV_ENC_LOCK_INPUT_BUFFER` in `mod.rs` are written in the same dev-style as `NV_ENC_INITIALIZE_PARAMS` was — separate `u32`s where SDK packs bit fields, wrong-sized sub-arrays, missing post-pointer fields. Even if `configure()` is fully fixed, `push_frame()` and `drain()` will hit the same class of failure against those structs.

Concretely, `NV_ENC_PIC_PARAMS` (mod.rs:172-198) packs `codecPicParams: [u8; 256]` straight into the struct, which matches SDK structurally, but the surrounding fields (`reserved1: [u32; 6]`, `reservedBitFields`, `meHintRefPicDist`, `reservedBitFields2`) need cross-checking against SDK 12.1 size and bit-field layout.

This argues for Option B more strongly than in earlier rounds (see Options below).

---

## Stop rationale (verbatim from Round 4 authorization)

> If a new NVENC status appears after fixing NV_ENC_INITIALIZE_PARAMS layout, stop again and report the exact status. Do not keep expanding into more structs without a fresh plan.

A status (`:12`) appeared post-fix; it is non-success; setting tuningInfo would be (a) a product decision I am not authorized to make and (b) explicitly cautioned against by "do not keep expanding." Stopping.

---

## ISS-002 disposition (still open question)

Same framing as Rounds 2 and 3: the probe-layer cause named in ISS-002 (`nvenc-api-create-failed:15`) is provably fixed under strict-mode test gating. `encoder.selected` should now emit under VAL-CAP-004 conditions (T-021 rerun forbidden in this pass, so not directly re-verified). Subsequent encode-path bring-up is still red. Whether to add a clarifying note now or wait for a clean T-021 rerun + green encode test is the orchestrator's call.

---

## Options for next pass

- **A: authorize a tight follow-up.**  Scope:
  - `helper/src/encoder/backends/nvenc/mod.rs` `configure()` — set `init_params.tuningInfo = N` and `init_params.bufferFormat = M` (orchestrator picks values; HIGH_QUALITY=1 vs LOW_LATENCY=2 vs ULTRA_LOW_LATENCY=3 for tuningInfo; NV12 buffer format almost certainly).
  - Add a `const _:() = assert!(std::mem::size_of::<NV_ENC_INITIALIZE_PARAMS>() == EXPECTED);` invariant in mod.rs to lock the layout going forward.
  - Verification commands unchanged.
  - **Expected risk:** this is the smallest path to a green configure, but `push_frame` and `drain` are likely to fail next due to PIC_PARAMS / LOCK_BITSTREAM layout issues, cascading into Round 5+ on each subsequent struct.
- **B (now strongly recommended): ship the probe-path + version-macro + INITIALIZE_PARAMS layout fixes from Rounds 1-4 as-is.**  File a separate ticket for the full encode-path FFI cleanup (set tuningInfo/bufferFormat, audit PIC_PARAMS / LOCK_BITSTREAM / CREATE_INPUT_BUFFER / CREATE_BITSTREAM_BUFFER / LOCK_INPUT_BUFFER for the same divergence pattern, cross-check sizes against SDK). VAL-CAP-004 `encoder.selected` is unblocked, which is what T-021 rerun 5 was actually blocked on; the encode-path completion ticket must land before T-010c smoke/RC. This avoids burning multiple session rounds on the same class of bug.
- **C: revert all four rounds and restart with a broader-scope plan that covers full NVENC FFI bring-up in a single pass with a real SDK header on hand.**  Not recommended — Rounds 1-4 are correct and provably reduce the bug surface step-by-step.

Personal recommendation: **B**. The session has demonstrated that the NVENC FFI bindings need a wholesale audit; trying to finish that audit one struct per session round is high-overhead.  Capturing the probe-path win now and queuing the encode-path FFI cleanup as one well-scoped follow-up ticket is cleaner than four more rounds.

---

## Invariants (still upheld)

- `encoder.selected` remains a real helper/product event — unchanged.
- `ProbeOutcome::Available` still requires `NvEncodeAPICreateInstance` *and* `nvEncOpenEncodeSessionEx` to both succeed. Strict probe proves this on real hardware.
- `nvenc-api-create-failed:{status}` raw format unchanged.
- `COVE_NVENC_FORCE_UNAVAILABLE` unchanged.
- `COVE_NVENC_REQUIRE_AVAILABLE` opt-in only; default CI behavior preserved.
- T-021 not rerun; T-010c not started; VAL-CAP-004 policy untouched.
- ISS-001, ISS-003, T-023 behavior — untouched.
- v1.1.0 legacy recording path — untouched.

---

## Files / refs

- Uncommitted patches (Rounds 1–4):
  - `helper/src/encoder/backends/nvenc/ffi.rs`
  - `helper/src/encoder/backends/nvenc/mod.rs`
  - `helper/tests/encoder_selection.rs`
- Round 1 stop-report (preserved): `.story/handovers/2026-05-19-09-iss-002-nvenc-version-fix-stop-report.md`
- Round 2 stop-report (preserved): `.story/handovers/2026-05-19-10-iss-002-nvenc-version-fix-stop-report-2.md`
- Round 3 stop-report (preserved): `.story/handovers/2026-05-19-11-iss-002-nvenc-version-fix-stop-report-3.md`
- Round 4 stop-report (this): `.story/handovers/2026-05-19-12-iss-002-nvenc-version-fix-stop-report-4.md`
- Rerun 5 failure evidence: `.story/handovers/evidence/2026-05-19-t-021-mvp-smoke-rerun-5/smoke-run/2026-05-19T06-59-35-326Z/VAL-CAP-004/encoder-probe-result.json`
- Issue: `ISS-002` (open, untouched)
- Ticket: `T-024` (open, untouched)
- Prior top commit: `f29b14a Record MVP smoke rerun 5 failure evidence`

Codex review loop intentionally **not started**.
