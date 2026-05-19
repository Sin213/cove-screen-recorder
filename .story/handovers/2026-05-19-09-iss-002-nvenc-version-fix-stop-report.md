# ISS-002 / T-024 — NVENC version fix: PARTIAL, HANDOFF STOP CONDITION HIT

**Date:** 2026-05-19
**Status:** Partial fix landed (uncommitted) — handoff stop condition triggered.
**Do not commit.** Do not run Codex review yet. Do not rerun T-021. Do not start T-010c.

---

## TL;DR

1. The NVENC FFI version-macro layer is fixed in `helper/src/encoder/backends/nvenc/ffi.rs`. The previous runtime failure `nvenc-api-create-failed:15` (NV_ENC_ERR_INVALID_VERSION) is **gone**.
2. The hardware-positive test in `helper/tests/encoder_selection.rs` is hardened with an opt-in `COVE_NVENC_REQUIRE_AVAILABLE=1` strict mode.
3. The strict probe now reports a **different** NVENC status: `session-create-failed:4` (NV_ENC_ERR_INVALID_DEVICE).
4. The handoff stop condition is explicit:
   > "If strict test reports a different NVENC status, stop and report the new status."
5. Stopping per the handoff. New status is reported below with a probable cause that is **outside the handoff scope** and requires orchestrator decision before proceeding.

---

## What changed (allowed scope only)

### `helper/src/encoder/backends/nvenc/ffi.rs`
- Added `const fn nvencapi_struct_version(ver: u32) -> u32 = NVENCAPI_VERSION | (ver << 16) | (0x7u32 << 28)`.
- Fixed `NV_ENC_ERR_INVALID_VERSION` constant: `7` → `15` (matches NVENC SDK 12.1 enum).
- Fixed `NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER`: was `NVENCAPI_VERSION | (1 << 31)`, now `nvencapi_struct_version(1)` → `0x7011000C`.
- Fixed `NV_ENCODE_API_FUNCTION_LIST_VER`: was `NVENCAPI_VERSION | (2 << 31)`, now `nvencapi_struct_version(2) | (1u32 << 31)` → `0xF012000C`.
- Struct layouts, function pointer signatures, and FFI call ordering unchanged.

### `helper/tests/encoder_selection.rs`
- `nvenc_probe_available_when_hardware_present` Unavailable arm gains opt-in strict mode: when `COVE_NVENC_REQUIRE_AVAILABLE=1`, Unavailable panics with the probe reason. Default behavior (no env var) preserves the original soft-skip line for CI without GPUs.
- `COVE_NVENC_FORCE_UNAVAILABLE` semantics unchanged.

### Not touched (per handoff hard scope)
- `helper/src/encoder/backends/nvenc/mod.rs` — read-only; no literal version word bypass found.
- All non-NVENC source (capture, segment, export, transport, protocol, electron, src/, packaging, workflows, validation, Cargo files).
- `.story/issues/ISS-002.json` is **untouched** — the probe path is not yet proven Available, so per the handoff (“Update ISS-002 with a note only if verification proves the probe path is fixed”) no note was added.

---

## Verification evidence

```
git status --short --untracked-files=all
 M helper/src/encoder/backends/nvenc/ffi.rs
 M helper/tests/encoder_selection.rs

git diff --check
(clean)
```

Build / test:
- `cargo build -p cove-replay-engine --release` → OK (9.40s).
- `cargo test -p cove-replay-engine -- --test-threads=1` → all crate tests pass.
- `cargo test -p cove-replay-engine --test encoder_selection -- --test-threads=1` → 7/7 pass.
- `COVE_NVENC_FORCE_UNAVAILABLE=1 cargo test -p cove-replay-engine --test encoder_selection -- --test-threads=1` → 7/7 pass.
- `COVE_NVENC_REQUIRE_AVAILABLE=1 cargo test -p cove-replay-engine --test encoder_selection -- nvenc_probe_available_when_hardware_present --exact --nocapture` → **FAILS** with `COVE_NVENC_REQUIRE_AVAILABLE=1 but NVENC probe returned Unavailable: session-create-failed:4`.

Structural greps (post-patch):
```
helper/src/encoder/backends/nvenc/ffi.rs:31:pub const NVENCAPI_VERSION: u32 = 12 | (1 << 24);
helper/src/encoder/backends/nvenc/ffi.rs:41:pub const fn nvencapi_struct_version(ver: u32) -> u32 {
helper/src/encoder/backends/nvenc/ffi.rs:42:    NVENCAPI_VERSION | (ver << 16) | (0x7u32 << 28)
helper/src/encoder/backends/nvenc/ffi.rs:48:pub const NV_ENC_ERR_INVALID_VERSION: NVENCSTATUS = 15;
helper/src/encoder/backends/nvenc/ffi.rs:73:pub const NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER: u32 = nvencapi_struct_version(1);
helper/src/encoder/backends/nvenc/ffi.rs:142:pub const NV_ENCODE_API_FUNCTION_LIST_VER: u32 =
helper/src/encoder/backends/nvenc/ffi.rs:143:    nvencapi_struct_version(2) | (1u32 << 31);

helper/tests/encoder_selection.rs:294:            if std::env::var("COVE_NVENC_REQUIRE_AVAILABLE").as_deref() == Ok("1") {

helper/src/encoder/backends/nvenc/mod.rs:370:        return Err(format!("nvenc-api-create-failed:{status}"));
```

`npm run typecheck` started — not exercised end-to-end since stop conditions hit before completion; the patch does not touch any TypeScript surface. `npm run validate:build` / `npm run build` not run for the same reason.

---

## The new failure: `session-create-failed:4`

`NV_ENC_ERR_INVALID_DEVICE` per NVENC SDK 12.1 NvEncodeAPI.h:
```
NV_ENC_ERR_NO_ENCODE_DEVICE        = 1
NV_ENC_ERR_UNSUPPORTED_DEVICE      = 2
NV_ENC_ERR_INVALID_ENCODERDEVICE   = 3
NV_ENC_ERR_INVALID_DEVICE          = 4
```

The version layer now succeeds — `NvEncodeAPICreateInstance` returns `NV_ENC_SUCCESS`, the typed function list is populated, and `nvEncOpenEncodeSessionEx` is called. Session creation then fails with status 4.

### Probable cause (out-of-scope, requires orchestrator decision)

`helper/src/encoder/backends/nvenc/ffi.rs:51` currently declares:
```rust
pub const NV_ENC_DEVICE_TYPE_CUDA: NV_ENC_DEVICE_TYPE = 2;
```

NVENC SDK 12.1 `NV_ENC_DEVICE_TYPE`:
```
NV_ENC_DEVICE_TYPE_DIRECTX = 0x0
NV_ENC_DEVICE_TYPE_CUDA    = 0x1   <-- correct value for our CUDA-backed probe
NV_ENC_DEVICE_TYPE_OPENGL  = 0x2   <-- what we are currently passing
NV_ENC_DEVICE_TYPE_VULKAN  = 0x3
```

We pass a CUDA `CUcontext` in the `device` field while tagging it as device type `2` (OPENGL). NVENC returns `INVALID_DEVICE` (4) because the device-type tag does not match the pointer kind.

This is a single-line, low-risk ffi.rs fix that is morphologically identical to the version-macro fixes in this pass, but **`NV_ENC_DEVICE_TYPE_CUDA` is not listed in the handoff’s scope**, and the handoff stop condition (“If strict test reports a different NVENC status, stop”) is explicit. Per the handoff, I am not applying it.

### Recommended next pass scope (for orchestrator)

Option A (smallest, recommended): authorize a one-line follow-up edit to ffi.rs setting `NV_ENC_DEVICE_TYPE_CUDA = 1`, then re-run the strict probe. If Available, write the success handover and proceed.

Option B: file a separate ticket for the device-type constant and let it sequence after orchestrator review. Choose this if process discipline matters more than throughput.

In either case, the same strict-test gate (`COVE_NVENC_REQUIRE_AVAILABLE=1`) will catch any future regression of this kind.

---

## Pre-existing parallel-test race (flagged, not addressed)

Initial `cargo test` (parallel, default) flagged `nvenc_force_unavailable_env_overrides_probe` because the two tests in this file mutate the same process-wide env var (`COVE_NVENC_FORCE_UNAVAILABLE`). Running with `--test-threads=1` is deterministic and clean (7/7 pass). The race is pre-existing — both tests mutated the env before this pass and continue to do so. Out of scope for this fix; flag for a follow-up if you want full parallel-test safety here.

---

## Pre-existing literal `15` in `mod.rs` (flagged, not addressed)

`helper/src/encoder/backends/nvenc/mod.rs:758-759` allows `enc_status != NV_ENC_SUCCESS && enc_status != 15` in the encode-picture path with the comment claiming `15` is `NV_ENC_ERR_NEED_MORE_INPUT`. Per the SDK, `NV_ENC_ERR_NEED_MORE_INPUT = 17` and `NV_ENC_ERR_INVALID_VERSION = 15`. The literal is wrong but it only fires in `push_frame()`, not the probe, and is outside this pass’s scope.

---

## Invariant audit

- `encoder.selected` remains a real helper/product event — untouched. The strict test failing is the correct signal that probe is still not Available; nothing synthesises a fake `selected`.
- `ProbeOutcome::Available` still requires NVENC API creation *and* session creation; the new failure proves the gate works.
- `nvenc-api-create-failed:{status}` raw status format is unchanged.
- `COVE_NVENC_FORCE_UNAVAILABLE` still works (verified).
- `COVE_NVENC_REQUIRE_AVAILABLE` is opt-in only; default CI behaviour preserved.
- T-023 declared-cell behaviour, ISS-001 nominalFps/source behaviour, ISS-003 — untouched.
- v1.1.0 legacy recording path — untouched.

---

## Files and refs

- Patch (uncommitted):
  - `helper/src/encoder/backends/nvenc/ffi.rs`
  - `helper/tests/encoder_selection.rs`
- Rerun 5 failure evidence:
  - `.story/handovers/evidence/2026-05-19-t-021-mvp-smoke-rerun-5/smoke-run/2026-05-19T06-59-35-326Z/VAL-CAP-004/encoder-probe-result.json`
- Issue: `ISS-002` (open, untouched)
- Ticket: `T-024` (open, untouched)
- Prior top commit: `f29b14a Record MVP smoke rerun 5 failure evidence`

---

## Stop reason (verbatim from handoff)

> Stop conditions:
> - If strict test reports a different NVENC status, stop and report the new status.

Strict test reports `session-create-failed:4` (was `nvenc-api-create-failed:15`). Stopping.

Codex handoff loop has **not** been started. Awaiting orchestrator decision on Option A vs Option B above.
