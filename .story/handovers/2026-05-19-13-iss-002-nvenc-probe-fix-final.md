# ISS-002 / T-024 — NVENC probe & version-macro fix: FINAL pass summary (Option B)

**Date:** 2026-05-19
**Status:** Probe-path + NVENC FFI version layer + `NV_ENC_INITIALIZE_PARAMS` layout — **fixed and verified**. Patches uncommitted. Encode-path completion intentionally deferred to ISS-004 / T-025.
**Do not commit yet** — pending Codex review.

This is the **final** handover for the 2026-05-19 NVENC-probe-fix pass. It replaces the four in-flight stop-reports as the canonical summary; the stop-reports remain on disk for incident-record continuity.

---

## TL;DR — narrow claim

1. **The VAL-CAP-004 probe blocker is fixed.** `nvenc-api-create-failed:15` is gone. Strict-mode probe (`COVE_NVENC_REQUIRE_AVAILABLE=1`) reaches `ProbeOutcome::Available` on RTX 4080 SUPER / driver 595.71.05. `encoder.selected` is now unblocked at the gate that T-021 rerun 5 was failing on.
2. **What this pass does NOT claim:** full encode-path success. `nvenc_one_frame_shm_encode_produces_fmp4_fragment` still fails with `Runtime("nvenc-init-failed:12")` (`NV_ENC_ERR_UNSUPPORTED_PARAM`). That failure is intentionally **excluded** from this pass’s success criteria and is owned by **ISS-004 / T-025**.
3. **Verification commands that gate this pass** all pass (see “Verification evidence” below). `cargo test -p cove-replay-engine -- --test-threads=1` is deliberately not part of the gate; the orchestrator explicitly accepted this trade-off.
4. **Codex review will be run** against the narrow claim only — the one-frame encode failure is documented as a known follow-up, not hidden.

---

## Cumulative patch (Rounds 1–4)

### `helper/src/encoder/backends/nvenc/ffi.rs`
- Added `const fn nvencapi_struct_version(ver: u32) -> u32 = NVENCAPI_VERSION | (ver << 16) | (0x7u32 << 28)` — single source of formula truth.
- Corrected `NV_ENC_ERR_INVALID_VERSION` constant: `7` → `15` (SDK 12.1).
- Corrected `NV_ENC_DEVICE_TYPE_CUDA` constant: `2` (= OPENGL) → `1` (CUDA) per SDK 12.1 enum.
- Corrected probe-path version constants:
  - `NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER = nvencapi_struct_version(1)` (`0x7011000C`).
  - `NV_ENCODE_API_FUNCTION_LIST_VER = nvencapi_struct_version(2) | (1u32 << 31)` (`0xF012000C`).
- Centralised the six encode-path struct version constants via `pub const`:
  - `NV_ENC_INITIALIZE_PARAMS_VER = nvencapi_struct_version(5) | (1u32 << 31)`
  - `NV_ENC_CREATE_INPUT_BUFFER_VER = nvencapi_struct_version(1)`
  - `NV_ENC_CREATE_BITSTREAM_BUFFER_VER = nvencapi_struct_version(1)`
  - `NV_ENC_PIC_PARAMS_VER = nvencapi_struct_version(4) | (1u32 << 31)`
  - `NV_ENC_LOCK_BITSTREAM_VER = nvencapi_struct_version(1)`
  - `NV_ENC_LOCK_INPUT_BUFFER_VER = nvencapi_struct_version(1)`

### `helper/src/encoder/backends/nvenc/mod.rs`
- Deleted the six parallel inline `const NV_ENC_*_VER` definitions (previously at lines 232–236 and 295). Now resolved via the existing `use ffi::*`.
- Re-laid out `NV_ENC_INITIALIZE_PARAMS` to SDK 12.1:
  - Replaced seven separate flag `u32`s with a single packed `flags: u32` (documented bit positions for `reportSliceOffsets…enableOutputInVidmem` + `reservedBitFields:26`).
  - Corrected `maxMEHintCountsPerBlock: [u32; 2]` (8 bytes) → `maxMEHintCountsPerBlockRow: [u32; 8]` (32 bytes — two SDK sub-structs of 4 × u32 each).
  - Added `tuningInfo: u32` and `bufferFormat: u32` fields (zero-initialised; setting valid non-zero values is in ISS-004 / T-025 scope).
  - Shrunk `reserved1` from `[u32; 289]` to `[u32; 287]` to absorb the size delta of the new fields.
- **No other structs touched** — `NV_ENC_PIC_PARAMS`, `NV_ENC_LOCK_BITSTREAM`, `NV_ENC_CREATE_INPUT_BUFFER`, `NV_ENC_CREATE_BITSTREAM_BUFFER`, `NV_ENC_LOCK_INPUT_BUFFER` are left as-is and owned by T-025.
- **No FFI call ordering, function-pointer signatures, error-string formats, or struct-layouts outside `INITIALIZE_PARAMS` changed.**

### `helper/tests/encoder_selection.rs`
- `nvenc_probe_available_when_hardware_present` Unavailable arm gained opt-in strict mode: when `COVE_NVENC_REQUIRE_AVAILABLE=1` is set, Unavailable panics with the probe reason. Default behaviour (no env var) preserves the original soft-skip line for CI without GPUs. `COVE_NVENC_FORCE_UNAVAILABLE` semantics unchanged.

### Not touched
- All non-NVENC source: validation/, capture/, segment/, export/, transport/, protocol/, electron/, src/, packaging/, workflows/, Cargo files, package files.
- ISS-001, ISS-003, T-021, T-010a, T-010c, T-023, VAL-CAP-004 policy, v1.1.0 legacy recording path.

---

## Verification evidence (this NVIDIA host: RTX 4080 SUPER / driver 595.71.05)

```
git status --short --untracked-files=all
 M helper/src/encoder/backends/nvenc/ffi.rs
 M helper/src/encoder/backends/nvenc/mod.rs
 M helper/tests/encoder_selection.rs
?? .story/handovers/2026-05-19-09-iss-002-nvenc-version-fix-stop-report.md
?? .story/handovers/2026-05-19-10-iss-002-nvenc-version-fix-stop-report-2.md
?? .story/handovers/2026-05-19-11-iss-002-nvenc-version-fix-stop-report-3.md
?? .story/handovers/2026-05-19-12-iss-002-nvenc-version-fix-stop-report-4.md
?? .story/handovers/2026-05-19-13-iss-002-nvenc-probe-fix-final.md

git diff --check
(clean)
```

Gate commands (all pass — narrow claim):

- `cargo build -p cove-replay-engine --release` → OK.
- `COVE_NVENC_REQUIRE_AVAILABLE=1 cargo test -p cove-replay-engine --test encoder_selection -- nvenc_probe_available_when_hardware_present --exact --nocapture` → **PASS**.
- `COVE_NVENC_FORCE_UNAVAILABLE=1 cargo test -p cove-replay-engine --test encoder_selection -- --test-threads=1` → 7/7 PASS.
- `npm run typecheck` → OK.
- `npm run validate:build` → OK.
- `npm run build` → OK.

Known excluded result (covered by ISS-004 / T-025):

- `cargo test -p cove-replay-engine -- --test-threads=1` → 1 failure: `nvenc_one_frame_shm_encode_produces_fmp4_fragment` returns `Runtime("nvenc-init-failed:12")`. All 25 other tests in that binary pass; rest of the crate passes. This failure is intentional — the test was previously a soft-skip when the probe failed; the probe fix unmasked a pre-existing pre-encode-path bug. Per orchestrator’s Option B authorisation, this is **not** in this pass’s success criteria. T-025 owns making it pass.

---

## Status progression (for the record)

| Round | Patch                                                              | Failure surface after patch         |
|-------|--------------------------------------------------------------------|-------------------------------------|
| 0     | (baseline — T-021 rerun 5 evidence)                                 | `nvenc-api-create-failed:15`       |
| 1     | API + session version macros; `INVALID_VERSION = 15`                | `session-create-failed:4`          |
| 2     | `NV_ENC_DEVICE_TYPE_CUDA = 1`                                       | `nvenc-init-failed:15`             |
| 3     | Centralised six encode-path version constants                       | `nvenc-init-failed:12`             |
| 4     | `NV_ENC_INITIALIZE_PARAMS` layout → SDK 12.1                        | `nvenc-init-failed:12` (unchanged) |

Round 4 stopped per the orchestrator’s explicit rule; Round 5 was authorised as Option B — ship the probe-layer success now, queue ISS-004 / T-025 for the encode-path completion.

---

## ISS-002 / T-024 disposition

- `ISS-002` status: **inprogress** (uncommitted). `resolution` field updated with full root-cause analysis and links to ISS-004 / T-025 for the encode-path follow-up. Mark `resolved` after orchestrator commits the patches.
- `T-024` status: **inprogress** (uncommitted). Description updated with what was fixed and what is intentionally deferred to T-025. Mark `complete` after orchestrator commits the patches.
- `T-021` status: untouched. Not rerun in this pass. T-021 can rerun after the patches are committed and after T-025 lands (since the configure path must work for any new T-021 rerun to exercise the full pipeline).
- `T-010c` status: untouched. Will remain blocked until T-025 lands (configure path required for any real encode).

---

## Follow-up artifacts created

- **`ISS-004`** — *NVENC encode-path FFI still red after probe fix — nvenc-init-failed:12 / SDK 12.1 struct audit needed*. Severity: high. Components: helper, encoder. Captures the diagnostic for the post-probe failure plus the structural concern that the remaining five NVENC encode-path structs likely have the same divergence pattern.
- **`T-025`** — *Full NVENC encode-path FFI cleanup (ISS-004)*. Phase: `p3b-implementation`. Blocked by T-024. Scope:
  1. Resolve the SDK 12.1 vs 13.0 target ambiguity surfaced in 2026-05-19 stop-report-4.
  2. Set `init_params.tuningInfo` and `init_params.bufferFormat` to valid values in `configure()` (product decision: HIGH_QUALITY vs LOW_LATENCY vs ULTRA_LOW_LATENCY).
  3. Audit / fix `NV_ENC_PIC_PARAMS`.
  4. Audit / fix `NV_ENC_LOCK_BITSTREAM`.
  5. Audit / fix `NV_ENC_CREATE_INPUT_BUFFER`.
  6. Audit / fix `NV_ENC_CREATE_BITSTREAM_BUFFER`.
  7. Audit / fix `NV_ENC_LOCK_INPUT_BUFFER`.
  8. Add `const _: () = assert!(std::mem::size_of::<T>() == EXPECTED)` invariants per struct.
  9. Make `nvenc_one_frame_shm_encode_produces_fmp4_fragment` pass.
  10. Optional: fix the pre-existing parallel-test env-var race in `encoder_selection.rs` and the literal `enc_status != 15` mis-label in `mod.rs:758-759` (SDK NEED_MORE_INPUT=17, INVALID_VERSION=15).

T-025 must land before T-010c smoke/RC.

---

## Codex review claim (for the Codex handoff)

The Codex review for this pass is asked to verify the **narrow** claim only, not full encode success. Specifically:

1. The patch does **not** claim full encode-path success. The handover, ISS-002 resolution text, T-024 description, and ISS-004 / T-025 artifacts must all reflect this honestly.
2. `nvenc_one_frame_shm_encode_produces_fmp4_fragment` failure with `nvenc-init-failed:12` is documented as the explicit known follow-up owned by ISS-004 / T-025; it is not silently masked, ignored, or removed.
3. The strict probe test under `COVE_NVENC_REQUIRE_AVAILABLE=1` passes.
4. The `cargo test --test-threads=1` failure is documented in the handover and intentionally excluded from this pass’s success gate (with orchestrator authorisation).
5. Version-macro / device-type / `NV_ENC_INITIALIZE_PARAMS` layout fixes are internally consistent with the SDK 12.1 macro intent and do not introduce a different version word for the same struct in multiple places.
6. No struct layouts other than `NV_ENC_INITIALIZE_PARAMS` were changed.
7. No files outside `helper/src/encoder/backends/nvenc/{ffi,mod}.rs` and `helper/tests/encoder_selection.rs` were patched.
8. The `nvencapi_struct_version()` helper is the single source of truth for the version-word formula (no inline literals remain in mod.rs that bypass it).
9. The probe-only paths (NV_ENCODE_API_FUNCTION_LIST_VER, NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER) and the open-session / API-creation success conditions are preserved (no synthesized `encoder.selected`).
10. `COVE_NVENC_FORCE_UNAVAILABLE` semantics preserved; `COVE_NVENC_REQUIRE_AVAILABLE` is opt-in only.

---

## Invariants (still upheld)

- `encoder.selected` remains a real helper/product event.
- `ProbeOutcome::Available` still requires `NvEncodeAPICreateInstance` *and* `nvEncOpenEncodeSessionEx` to both succeed.
- `nvenc-api-create-failed:{status}` raw status format preserved.
- T-021 not rerun; T-010c not started; VAL-CAP-004 policy untouched.
- ISS-001 / ISS-003 / T-023 behaviour untouched.
- v1.1.0 legacy recording path untouched.
- No new dependencies; no Cargo.toml / Cargo.lock changes.

---

## Files and refs

- Uncommitted patches:
  - `helper/src/encoder/backends/nvenc/ffi.rs`
  - `helper/src/encoder/backends/nvenc/mod.rs`
  - `helper/tests/encoder_selection.rs`
- Stop-reports (preserved for record):
  - `.story/handovers/2026-05-19-09-iss-002-nvenc-version-fix-stop-report.md` (Round 1)
  - `.story/handovers/2026-05-19-10-iss-002-nvenc-version-fix-stop-report-2.md` (Round 2)
  - `.story/handovers/2026-05-19-11-iss-002-nvenc-version-fix-stop-report-3.md` (Round 3)
  - `.story/handovers/2026-05-19-12-iss-002-nvenc-version-fix-stop-report-4.md` (Round 4)
- This final summary: `.story/handovers/2026-05-19-13-iss-002-nvenc-probe-fix-final.md`
- Rerun 5 baseline evidence: `.story/handovers/evidence/2026-05-19-t-021-mvp-smoke-rerun-5/smoke-run/2026-05-19T06-59-35-326Z/VAL-CAP-004/encoder-probe-result.json`
- Linked: `ISS-002`, `ISS-004`, `T-024`, `T-025`.
- Prior top commit (unchanged): `f29b14a Record MVP smoke rerun 5 failure evidence`.
