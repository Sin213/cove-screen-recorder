# ISS-002 / T-024 — NVENC version fix, Round 3: encode-path version macros centralised; new status `nvenc-init-failed:12` surfaces

**Date:** 2026-05-19
**Status:** All NVENC struct-version constants are now correct and centralised. Probe path remains GREEN. New post-version failure surfaces in `configure()` (`NV_ENC_ERR_UNSUPPORTED_PARAM = 12`); handoff stop rule §6 hit.
**Do not commit.** Codex review not run yet.

Follows:
- `.story/handovers/2026-05-19-09-iss-002-nvenc-version-fix-stop-report.md` (Round 1)
- `.story/handovers/2026-05-19-10-iss-002-nvenc-version-fix-stop-report-2.md` (Round 2)

---

## TL;DR

1. Option A applied: the six inline NVENC struct-version constants previously living in `helper/src/encoder/backends/nvenc/mod.rs` are now expressed via `ffi::nvencapi_struct_version()` and exposed as `pub const` in `ffi.rs`. Single source of formula truth.
2. **Strict probe still passes** (`COVE_NVENC_REQUIRE_AVAILABLE=1 … nvenc_probe_available_when_hardware_present --exact` → OK on this NVIDIA host).
3. `cargo test --test-threads=1` shows `nvenc_one_frame_shm_encode_produces_fmp4_fragment` now fails with a **new** NVENC runtime status:
   ```
   configure must succeed when probe returned Available: Runtime("nvenc-init-failed:12")
   ```
   `12` = `NV_ENC_ERR_UNSUPPORTED_PARAM` per SDK 12.1.
4. The version-word layer is no longer the gating factor — the driver now accepts the version slot and rejects the **content** of `NV_ENC_INITIALIZE_PARAMS`. This is outside the version-fix scope of this pass.
5. Handoff stop rule §6 (“If a new NVENC runtime status appears after fixing the inline versions, stop and report the exact status”) is explicitly hit. Stopping.

---

## Round 3 patch (allowed scope only)

### `helper/src/encoder/backends/nvenc/ffi.rs`
- Added six `pub const` declarations using `nvencapi_struct_version()` with the SDK 12.1 macro intent:
  - `NV_ENC_INITIALIZE_PARAMS_VER         = nvencapi_struct_version(5) | (1u32 << 31)`
  - `NV_ENC_CREATE_INPUT_BUFFER_VER       = nvencapi_struct_version(1)`
  - `NV_ENC_CREATE_BITSTREAM_BUFFER_VER   = nvencapi_struct_version(1)`
  - `NV_ENC_PIC_PARAMS_VER                = nvencapi_struct_version(4) | (1u32 << 31)`
  - `NV_ENC_LOCK_BITSTREAM_VER            = nvencapi_struct_version(1)`
  - `NV_ENC_LOCK_INPUT_BUFFER_VER         = nvencapi_struct_version(1)`
- Each line carries a one-line doc referencing the SDK 12.1 macro form so a future change is unambiguous.
- (For PIC_PARAMS, SDK 12.1 uses `STRUCT_VERSION(4)`, not `6`. My Round 2 stop-report candidate list had `6`; that came from the dev's literal `(6 << 31)`, which evaluates to `0u32` because bit 0 of 6 is 0 and the rest shift out. So `6` was a guess with no working signal behind it. `4` is the SDK-correct value.)

### `helper/src/encoder/backends/nvenc/mod.rs`
- Deleted the six local `const` definitions (lines 232–236 and former 295). A one-line comment replaces them noting the constants now live in `ffi.rs` and are pulled in via the existing `use ffi::*` at line 27.
- **No struct layouts, function-pointer signatures, FFI call orderings, or error-string formats changed.**

### `helper/tests/encoder_selection.rs`
- Unchanged in Round 3. Round 1’s opt-in `COVE_NVENC_REQUIRE_AVAILABLE=1` strict mode remains in place.

### Not touched (per handoff hard scope)
- `mod.rs` struct layouts, `mod.rs:758-759` literal `enc_status != 15`, validation/capture/segment/export/transport/protocol, electron/src/, packaging/workflows, Cargo files, ISS-002.json.

---

## Verification evidence (Round 3)

```
git status --short --untracked-files=all
 M helper/src/encoder/backends/nvenc/ffi.rs
 M helper/src/encoder/backends/nvenc/mod.rs
 M helper/tests/encoder_selection.rs
?? .story/handovers/2026-05-19-09-iss-002-nvenc-version-fix-stop-report.md
?? .story/handovers/2026-05-19-10-iss-002-nvenc-version-fix-stop-report-2.md
?? .story/handovers/2026-05-19-11-iss-002-nvenc-version-fix-stop-report-3.md

git diff --check
(clean)
```

Structural grep — all six constants live in `ffi.rs`, zero in `mod.rs`:
```
helper/src/encoder/backends/nvenc/ffi.rs:162:pub const NV_ENC_INITIALIZE_PARAMS_VER: u32 =
helper/src/encoder/backends/nvenc/ffi.rs:166:pub const NV_ENC_CREATE_INPUT_BUFFER_VER: u32 = nvencapi_struct_version(1);
helper/src/encoder/backends/nvenc/ffi.rs:169:pub const NV_ENC_CREATE_BITSTREAM_BUFFER_VER: u32 = nvencapi_struct_version(1);
helper/src/encoder/backends/nvenc/ffi.rs:172:pub const NV_ENC_PIC_PARAMS_VER: u32 =
helper/src/encoder/backends/nvenc/ffi.rs:176:pub const NV_ENC_LOCK_BITSTREAM_VER: u32 = nvencapi_struct_version(1);
helper/src/encoder/backends/nvenc/ffi.rs:179:pub const NV_ENC_LOCK_INPUT_BUFFER_VER: u32 = nvencapi_struct_version(1);
helper/src/encoder/backends/nvenc/mod.rs:565: init_params.version = NV_ENC_INITIALIZE_PARAMS_VER;
helper/src/encoder/backends/nvenc/mod.rs:638: create_in.version = NV_ENC_CREATE_INPUT_BUFFER_VER;
helper/src/encoder/backends/nvenc/mod.rs:657:     version: NV_ENC_LOCK_INPUT_BUFFER_VER,
helper/src/encoder/backends/nvenc/mod.rs:722: create_out.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
helper/src/encoder/backends/nvenc/mod.rs:740: pic_params.version = NV_ENC_PIC_PARAMS_VER;
helper/src/encoder/backends/nvenc/mod.rs:791:     lock_params.version = NV_ENC_LOCK_BITSTREAM_VER;
```

Test runs (RTX 4080 SUPER / driver 595.71.05):
- `cargo build -p cove-replay-engine --release` → OK (9.48s).
- `COVE_NVENC_REQUIRE_AVAILABLE=1 cargo test -p cove-replay-engine --test encoder_selection -- nvenc_probe_available_when_hardware_present --exact --nocapture` → **PASS**. Probe reaches `ProbeOutcome::Available`.
- `COVE_NVENC_FORCE_UNAVAILABLE=1 cargo test -p cove-replay-engine --test encoder_selection -- --test-threads=1` → 7/7 PASS.
- `cargo test -p cove-replay-engine -- --test-threads=1` → **1 FAILED**:
  ```
  nvenc_one_frame_shm_encode_produces_fmp4_fragment
    panicked at helper/tests/encoder_session.rs:1549:34:
    configure must succeed when probe returned Available:
      Runtime("nvenc-init-failed:12")
  ```
  All other tests in the crate pass.
- `npm run typecheck` → OK.
- `npm run validate:build` → OK.
- `npm run build` → OK.

---

## What `nvenc-init-failed:12` means

`12` = `NV_ENC_ERR_UNSUPPORTED_PARAM` per NVENC SDK 12.1 NvEncodeAPI.h `NVENCSTATUS` enum:
```
NV_ENC_ERR_NO_ENCODE_DEVICE        =  1
NV_ENC_ERR_UNSUPPORTED_DEVICE      =  2
NV_ENC_ERR_INVALID_ENCODERDEVICE   =  3
NV_ENC_ERR_INVALID_DEVICE          =  4
NV_ENC_ERR_DEVICE_NOT_EXIST        =  5
NV_ENC_ERR_INVALID_PTR             =  6
NV_ENC_ERR_INVALID_EVENT           =  7
NV_ENC_ERR_INVALID_PARAM           =  8
NV_ENC_ERR_INVALID_CALL            =  9
NV_ENC_ERR_OUT_OF_MEMORY           = 10
NV_ENC_ERR_ENCODER_NOT_INITIALIZED = 11
NV_ENC_ERR_UNSUPPORTED_PARAM       = 12   ← new failure surface
NV_ENC_ERR_LOCK_BUSY               = 13
NV_ENC_ERR_NOT_ENOUGH_BUFFER       = 14
NV_ENC_ERR_INVALID_VERSION         = 15   ← Round 1+2+3 cleaned this layer up
```

The driver now accepts the version slot of `NV_ENC_INITIALIZE_PARAMS` and rejects the **content** of the struct itself.

### Most likely root cause (out-of-scope, requires orchestrator decision)

`mod.rs:113-140` declares `NV_ENC_INITIALIZE_PARAMS` with each enable flag as a full `u32`:

```rust
struct NV_ENC_INITIALIZE_PARAMS {
    // …
    enableEncodeAsync: u32,
    enablePTD: u32,
    reportSliceOffsets: u32,
    enableSubFrameWrite: u32,
    enableExternalMEHints: u32,
    enableMEOnlyMode: u32,
    enableWeightedPrediction: u32,
    enableOutputInVidmem: u32,
    reserved: u32,
    // …
}
```

SDK 12.1 `NvEncodeAPI.h` packs `reportSliceOffsets…reservedBitFields:26` into a **single** `uint32_t` via C bit fields. That is a ~20-byte layout divergence shifted down for every later field in the struct, so what the driver reads as `privDataSize` is actually our `enableSubFrameWrite`, what it reads as `privData` is somewhere inside our enable flags, and so on. From the driver’s perspective every later field is misinterpreted; depending on values the rejection surfaces as `INVALID_PARAM` / `UNSUPPORTED_PARAM`. Status `12` is consistent with that diagnosis.

Additionally, SDK 12.1 `NV_ENC_INITIALIZE_PARAMS` defines fields (`tuningInfo`, `bufferFormat`, `numStateBuffers`, `outputStatsLevel`, `maxMEHintCountsPerBlockRow` as a struct rather than `[u32; 2]`) that are not present (or differently sized) in mod.rs.

Fixing this is **not a version-macro change** — it requires editing the struct layout, which the handoff explicitly bars (“Do not change struct layouts”). I am not changing the struct. Filed for the next pass.

---

## Stop rationale (verbatim from this round’s handoff)

> 6. If a new NVENC runtime status appears after fixing the inline versions, stop and report the exact status.

Status was `15` (INVALID_VERSION); is now `12` (UNSUPPORTED_PARAM). New status. Stopping.

(Cumulative status history across the three rounds: `nvenc-api-create-failed:15` → `session-create-failed:4` (Round 1 stopped here) → after one-line device-type fix in Round 2: `nvenc-init-failed:15` (Round 2 stopped here) → after centralising the six encode-path versions in Round 3: `nvenc-init-failed:12`. Each round eliminated exactly one class of FFI bug.)

---

## ISS-002 disposition (still open question)

The version-macro layer named in ISS-002’s impact (`nvenc-api-create-failed:15` blocking `encoder.selected`) is now provably fixed end-to-end. The probe reaches Available on real hardware under the strict-mode test gate. By the handoff's “Update ISS-002 with a note only if verification proves the probe path is fixed” rule, a clarifying note is now defensible.

I did **not** add the note yet. Two reasons:
1. The runtime evidence that `encoder.selected` is actually emitted in VAL-CAP-004 conditions can only come from a T-021 rerun, which is forbidden in this pass.
2. The new `nvenc-init-failed:12` failure means subsequent code paths after `encoder.selected` (configure → push_frame → drain) are still red. If you want ISS-002 to track *all* NVENC bring-up failures, the issue should stay open until those are clean; if it tracks *only* the probe-layer `:15` from rerun 5, a note recording that the specific cause has been fixed is appropriate now.

Asking: which framing do you want? Default answer is to wait for an actual rerun to add the note.

---

## Options for next pass

- **A (recommended): authorize a follow-up pass that fixes the `NV_ENC_INITIALIZE_PARAMS` struct layout.** Same narrow scope as this pass — `mod.rs` struct layouts and any required field-name renames only; no encode-logic changes beyond field assignment edits. Run the same verification: full `cargo test --test-threads=1`, strict probe, FORCE_UNAVAILABLE, npm typecheck/validate/build. Codex review after.  Likely needs to extend to other encode-path structs (`NV_ENC_PIC_PARAMS`, `NV_ENC_LOCK_BITSTREAM`, etc.) but the next pass can be incremental — fix INITIALIZE_PARAMS first since that’s what’s currently red.
- **B: ship the probe-path + version-macro fix as-is.** Same caveats as Round 2’s Option B — `encoder.selected` is unblocked, T-021 can rerun and pass its `must-pass` cell-validation gate, but actually starting an NVENC encode (push_frame) will fail. The follow-up to fix struct layouts must land before T-010c smoke/RC.
- **C: revert this pass and redo with broader scope.** Not recommended.

In all three cases, the parallel-test env-var race in `encoder_selection.rs` and the `mod.rs:758-759` literal `enc_status != 15` (SDK NEED_MORE_INPUT is 17, not 15) remain pre-existing follow-ups — they should be picked up alongside the struct-layout fix.

---

## Invariants (still upheld)

- `encoder.selected` remains a real helper/product event — unchanged.
- `ProbeOutcome::Available` still requires `NvEncodeAPICreateInstance` *and* `nvEncOpenEncodeSessionEx` to both succeed. Strict probe proves this on real hardware.
- `nvenc-api-create-failed:{status}` raw format unchanged.
- `COVE_NVENC_FORCE_UNAVAILABLE` unchanged.
- `COVE_NVENC_REQUIRE_AVAILABLE` opt-in only; default CI behavior preserved.
- T-021 not rerun.
- T-010c not started.
- VAL-CAP-004 policy / `expectedEncoderBackend = "nvenc"` untouched.
- ISS-001, ISS-003, T-023 behavior — untouched.
- v1.1.0 legacy recording path — untouched.

---

## Files / refs

- Uncommitted patches (Rounds 1–3):
  - `helper/src/encoder/backends/nvenc/ffi.rs`
  - `helper/src/encoder/backends/nvenc/mod.rs`
  - `helper/tests/encoder_selection.rs`
- Round 1 stop-report (preserved): `.story/handovers/2026-05-19-09-iss-002-nvenc-version-fix-stop-report.md`
- Round 2 stop-report (preserved): `.story/handovers/2026-05-19-10-iss-002-nvenc-version-fix-stop-report-2.md`
- Round 3 stop-report (this): `.story/handovers/2026-05-19-11-iss-002-nvenc-version-fix-stop-report-3.md`
- Rerun 5 failure evidence: `.story/handovers/evidence/2026-05-19-t-021-mvp-smoke-rerun-5/smoke-run/2026-05-19T06-59-35-326Z/VAL-CAP-004/encoder-probe-result.json`
- Issue: `ISS-002` (open, untouched)
- Ticket: `T-024` (open, untouched)
- Prior top commit: `f29b14a Record MVP smoke rerun 5 failure evidence`

Codex review loop intentionally **not started**.
