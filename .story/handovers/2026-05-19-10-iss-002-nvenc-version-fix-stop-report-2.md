# ISS-002 / T-024 — NVENC version fix, Round 2: probe path GREEN, configure path stops on mod.rs literal version words

**Date:** 2026-05-19
**Status:** Probe-path goal MET; secondary stop condition hit on mod.rs inline version literals.
**Do not commit.** Codex review not run yet. Pending orchestrator decision on scope.

This handover follows
`.story/handovers/2026-05-19-09-iss-002-nvenc-version-fix-stop-report.md` (Round 1).

---

## TL;DR

1. Round 1’s authorized one-line follow-up landed: `NV_ENC_DEVICE_TYPE_CUDA = 1` in `helper/src/encoder/backends/nvenc/ffi.rs`.
2. **The strict probe now reaches Available.** `COVE_NVENC_REQUIRE_AVAILABLE=1 cargo test … nvenc_probe_available_when_hardware_present --exact --nocapture` → PASS on this NVIDIA host.
3. **The handoff’s stated implementation goal is met.** Quote: *“Fix the local NVENC FFI version constants so NvEncodeAPICreateInstance no longer fails with INVALID_VERSION, and harden the hardware-positive test so this failure cannot hide again.”* `encoder.selected` gating (the VAL-CAP-004 blocker from T-021 rerun 5) depends on probe Available; configure runs later.
4. **However, a second test now fails after the probe unblocked it:** `nvenc_one_frame_shm_encode_produces_fmp4_fragment` reaches `configure()` and returns `Runtime("nvenc-init-failed:15")` (NV_ENC_ERR_INVALID_VERSION). The cause is the *same wrong version-word formula* the probe path used, but it lives in `helper/src/encoder/backends/nvenc/mod.rs` as parallel `const` definitions (lines 232-236 and 295).
5. The handoff stop rule is explicit:
   > “If you find an inline literal version word in mod.rs that bypasses ffi.rs constants, stop and report instead of broadening.”
6. Stopping. Round 1 patches plus Round 2’s one-line device-type fix remain in place uncommitted. Round 1 stop-report is preserved untouched.

This configure-path failure is **not a regression caused by my fix.** It is a pre-existing bug that was previously hidden because the probe always failed before configure could run. The probe fix unmasked it.

---

## Round 2 patch (allowed scope only)

### `helper/src/encoder/backends/nvenc/ffi.rs`
- One-line value fix: `NV_ENC_DEVICE_TYPE_CUDA: NV_ENC_DEVICE_TYPE = 2` → `1`, with a short comment citing the SDK 12.1 enum (`DIRECTX=0, CUDA=1, OPENGL=2, VULKAN=3`).
- No other edits in this round; Round 1’s `nvencapi_struct_version()`, `NV_ENC_ERR_INVALID_VERSION = 15`, `NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER = nvencapi_struct_version(1)`, and `NV_ENCODE_API_FUNCTION_LIST_VER = nvencapi_struct_version(2) | (1u32 << 31)` are still in place.

### `helper/tests/encoder_selection.rs`
- Unchanged from Round 1. `COVE_NVENC_REQUIRE_AVAILABLE=1` strict mode still gates the hardware-positive test; default soft-skip and `COVE_NVENC_FORCE_UNAVAILABLE` semantics preserved.

### Not touched (per handoff hard scope)
- `helper/src/encoder/backends/nvenc/mod.rs` — read-only; literal version-word block triggered the stop, did not patch.
- All non-NVENC source (capture, segment, export, transport, protocol, electron, src/, packaging, workflows, validation, Cargo files).
- `.story/issues/ISS-002.json` — still untouched (see “ISS-002 disposition” below).

---

## Verification evidence (Round 2)

```
git status --short --untracked-files=all
 M helper/src/encoder/backends/nvenc/ffi.rs
 M helper/tests/encoder_selection.rs
?? .story/handovers/2026-05-19-09-iss-002-nvenc-version-fix-stop-report.md
?? .story/handovers/2026-05-19-10-iss-002-nvenc-version-fix-stop-report-2.md

git diff --check
(clean)
```

Build / test (this NVIDIA host, RTX 4080 SUPER / driver 595.71.05):

- `cargo build -p cove-replay-engine --release` → OK (10.68s).
- `COVE_NVENC_REQUIRE_AVAILABLE=1 cargo test -p cove-replay-engine --test encoder_selection -- nvenc_probe_available_when_hardware_present --exact --nocapture` → **PASS**.  Previous failure mode `nvenc-api-create-failed:15` and Round 1’s `session-create-failed:4` are both gone.  Probe reaches `ProbeOutcome::Available`.
- `COVE_NVENC_FORCE_UNAVAILABLE=1 cargo test -p cove-replay-engine --test encoder_selection -- --test-threads=1` → 7/7 PASS.
- `cargo test -p cove-replay-engine -- --test-threads=1` → **1 FAILED**: `nvenc_one_frame_shm_encode_produces_fmp4_fragment` panics at `encoder_session.rs:1549:34`:
  ```
  configure must succeed when probe returned Available: Runtime("nvenc-init-failed:15")
  ```
  All other tests in the crate pass.
- `npm run typecheck` → OK.
- `npm run validate:build` → OK.
- `npm run build` → OK (renderer + Electron tsc).

---

## Why `nvenc-init-failed:15` happens here

The failing test (`encoder_session.rs:1502-1598`) probes first and only enters `configure()` when probe returns Available (line 1539). It then calls `backend.configure(cfg)` which executes `mod.rs:566-585`, including:

```rust
init_params.version = NV_ENC_INITIALIZE_PARAMS_VER;
...
let init_status = unsafe { init_fn(encoder, &mut init_params) };
if init_status != NV_ENC_SUCCESS {
    return Err(EncoderError::Runtime(format!("nvenc-init-failed:{init_status}")));
}
```

The version constant comes from inline `const` definitions in `mod.rs` itself:

```rust
helper/src/encoder/backends/nvenc/mod.rs
232 const NV_ENC_INITIALIZE_PARAMS_VER:         u32 = NVENCAPI_VERSION | (5 << 31);
233 const NV_ENC_CREATE_INPUT_BUFFER_VER:       u32 = NVENCAPI_VERSION | (1 << 31);
234 const NV_ENC_CREATE_BITSTREAM_BUFFER_VER:   u32 = NVENCAPI_VERSION | (1 << 31);
235 const NV_ENC_PIC_PARAMS_VER:                u32 = NVENCAPI_VERSION | (6 << 31);
236 const NV_ENC_LOCK_BITSTREAM_VER:            u32 = NVENCAPI_VERSION | (1 << 31);
…
295 const NV_ENC_LOCK_INPUT_BUFFER_VER:         u32 = NVENCAPI_VERSION | (1 << 31);
```

These are the **same wrong formula** Round 1 fixed in ffi.rs (missing `(ver << 16)` and the `0x7 << 28` SDK struct-version tag).  They are inline literal version words in mod.rs that bypass ffi.rs’ `nvencapi_struct_version()`. The handoff stop rule for that is explicit, so I am not patching them in this pass.

For reference, the correct SDK 12.1 macro expansions (verify in a follow-up against `NvEncodeAPI.h` before patching) follow the pattern:

- `NV_ENC_INITIALIZE_PARAMS_VER`         → `nvencapi_struct_version(5) | (1u32 << 31)` (SDK keeps the high bit on this one)
- `NV_ENC_CREATE_INPUT_BUFFER_VER`       → `nvencapi_struct_version(1)`
- `NV_ENC_CREATE_BITSTREAM_BUFFER_VER`   → `nvencapi_struct_version(1)`
- `NV_ENC_PIC_PARAMS_VER`                → `nvencapi_struct_version(6) | (1u32 << 31)` (SDK keeps the high bit)
- `NV_ENC_LOCK_BITSTREAM_VER`            → `nvencapi_struct_version(1)`
- `NV_ENC_LOCK_INPUT_BUFFER_VER`         → `nvencapi_struct_version(1)`

The SDK macros that should be cross-checked next pass:
```
#define NV_ENC_INITIALIZE_PARAMS_VER     (NVENCAPI_STRUCT_VERSION(5) | (1<<31))
#define NV_ENC_CREATE_INPUT_BUFFER_VER   NVENCAPI_STRUCT_VERSION(1)
…
#define NV_ENC_PIC_PARAMS_VER            (NVENCAPI_STRUCT_VERSION(6) | (1<<31))
```

This is also the cleanest place to consolidate: move these six constants out of mod.rs and into ffi.rs alongside the existing version constants so a wrong-formula bug can’t recur in parallel definitions. Recommendation only; not requested.

---

## Stop rationale (verbatim from handoff)

> Stop conditions:
> - If full cargo test regresses, stop.
> - If any fix requires touching mod.rs beyond a literal version bypass, stop and report.

And from the implementation scope section:
> If you find an inline literal version word in mod.rs that bypasses ffi.rs constants, stop and report instead of broadening.

Both apply.

---

## ISS-002 disposition (open question for orchestrator)

ISS-002’s “Impact” paragraph names the runtime failure precisely as `nvenc-api-create-failed:15` blocking `encoder.selected`. Strict-mode probe verification shows that exact failure mode is now gone and the probe reaches Available. By the handoff’s rule (“Update ISS-002 with a note only if verification proves the probe path is fixed”), the probe-path layer arguably qualifies.

I did **not** update ISS-002 because the broader implication (`encoder.selected` actually emitted under real VAL-CAP-004 conditions) hasn’t been re-verified end-to-end (T-021 rerun forbidden in this pass), and the configure path is still red. Asking: do you want a clarifying note added now, or wait for a clean rerun?

---

## Options for next pass (recommended ordering)

- **A (recommended): authorize a tight follow-up pass.**  Same scope discipline.  Only files:
  - `helper/src/encoder/backends/nvenc/ffi.rs` (move the six constants here, expressed via `nvencapi_struct_version()`)
  - `helper/src/encoder/backends/nvenc/mod.rs` (delete the parallel constants; reference ffi.rs)
  - Optionally `helper/tests/encoder_session.rs` (only if a fixture path changes; expected: no change)
  - Verification: full `cargo test --test-threads=1`, including `nvenc_one_frame_shm_encode_produces_fmp4_fragment`, must pass strict.
  - Codex review loop after PASS.
- **B: ship probe-path fix as-is now; file mod.rs version literals as a separate ticket.**  Acceptable because `encoder.selected` only needs probe Available, which unblocks VAL-CAP-004 and the T-021 rerun.  Caveat: the configure path will hit `nvenc-init-failed:15` the first time someone actually starts an NVENC encode, so the follow-up ticket must land before T-010c smoke/RC.  Risk of false confidence between merges.
- **C: revert this pass and redo with a broader scope.**  Not recommended.  Round 1 + Round 2 ffi.rs edits are correct, verified, and small; reverting loses provably good work.

---

## Flagged but not addressed (per “file as follow-ups only if needed”)

- Pre-existing parallel-test env-var race in `helper/tests/encoder_selection.rs` (tests mutate `COVE_NVENC_FORCE_UNAVAILABLE` without isolation). `--test-threads=1` is clean. Pre-existing; out of scope.
- `helper/src/encoder/backends/nvenc/mod.rs:758-759` literal `enc_status != 15` is mis-labelled as `NEED_MORE_INPUT`; per SDK `NEED_MORE_INPUT = 17` and `INVALID_VERSION = 15`. Only fires in `push_frame`. Pre-existing; out of scope here. Should be picked up in the same follow-up pass that fixes mod.rs version literals.

---

## Invariants (still upheld)

- `encoder.selected` remains a real helper/product event — unchanged.
- `ProbeOutcome::Available` still requires `NvEncodeAPICreateInstance` *and* `nvEncOpenEncodeSessionEx` to both succeed. Strict probe proves this end-to-end on hardware.
- `nvenc-api-create-failed:{status}` raw format unchanged; strict-mode panic surfaces the raw reason string.
- `COVE_NVENC_FORCE_UNAVAILABLE` unchanged behavior.
- `COVE_NVENC_REQUIRE_AVAILABLE` only affects the targeted hardware-positive test; never set in default CI.
- T-021 not rerun.
- T-010c not started.
- VAL-CAP-004 policy / `expectedEncoderBackend = "nvenc"` untouched.
- ISS-001 nominal/source behavior, ISS-003 declared-cell behavior — untouched.
- v1.1.0 legacy recording path — untouched.

---

## Files / refs

- Uncommitted patches (Round 1 + Round 2):
  - `helper/src/encoder/backends/nvenc/ffi.rs`
  - `helper/tests/encoder_selection.rs`
- Round 1 stop-report (preserved): `.story/handovers/2026-05-19-09-iss-002-nvenc-version-fix-stop-report.md`
- This Round 2 stop-report: `.story/handovers/2026-05-19-10-iss-002-nvenc-version-fix-stop-report-2.md`
- Rerun 5 failure evidence: `.story/handovers/evidence/2026-05-19-t-021-mvp-smoke-rerun-5/smoke-run/2026-05-19T06-59-35-326Z/VAL-CAP-004/encoder-probe-result.json`
- Issue: `ISS-002` (open, untouched)
- Ticket: `T-024` (open, untouched)
- Prior top commit: `f29b14a Record MVP smoke rerun 5 failure evidence`

Codex review loop intentionally **not started**.
