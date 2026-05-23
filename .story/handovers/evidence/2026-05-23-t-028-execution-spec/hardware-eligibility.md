# VAL-CAP-006b — Hardware / platform eligibility (T-028 execution spec)

> Define-only. The current M1 NVIDIA / KDE Plasma 6 / Wayland host is **NOT eligible** to adjudicate VAL-CAP-006b to pass/fail — it can only produce SHM-fallback evidence (→ cannot-validate, already recorded under T-027 / N-008 §26.8). Do not re-adjudicate it here.

A future session may adjudicate VAL-CAP-006b to a real pass/fail **only** when ALL of the following hold:

## Required
1. **Vendor.** `gpuInfo` starts with `amd:` or `intel:`. **Never `nvidia:`** for a 006b pass/fail. (Mirrors the N-008 §26.4 predicate, which keys the NVIDIA cannot-validate disposition on `gpuInfo` starting `"nvidia:"`.) Detected vendor is one of `nvidia|amd|intel|unknown` — `electron/ffmpeg.ts:109`, set from `app.getGPUInfo("basic")` in `electron/main.ts:1194-1200`.
2. **Session type = Wayland.** PipeWire screencast portal path (the only v2 capture path).
3. **PipeWire portal active.** A real portal session is negotiated — not the simulator.
4. **Encoder path matches vendor:** AMD → **VAAPI**; Intel → **QSV**, performing **zero-copy DMA-BUF import in the v2 helper encoder**. **Implementation prerequisite — NOT present today:** the helper has NVENC + libx264 backends only; VAAPI/QSV are out of scope (`helper/src/encoder/backends/mod.rs:10`, `helper/src/encoder/mod.rs:69`) and no backend imports DMA-BUF yet (`nvenc/mod.rs:540,688`). (`electron/ffmpeg.ts:197-203` is the v1 ffmpeg-sidecar vendor ordering, not the v2 helper encoder.) See `instrumentation-sufficiency.md`.
5. **Declared 60 fps preset confirmed** (the same declared_fps the assertion compares against; see `assertion-definition.md`).
6. **Source resolution verified twice** and stable across the run: at session start AND just before save. (ISS-011's 4K↔1080 drift with no `capture.formatChanged` is exactly the confound this guards against.)

## Not eligible
- Any `nvidia:` host → cannot-validate per §26.8 (unchanged); never a 006b pass/fail.
- Any host where DMA-BUF does not actually settle (see `dmabuf-success-criteria.md`) → INCONCLUSIVE, not eligible (see `decision-table.md`).
- The simulator / non-Wayland / non-portal paths.

**AMD/Intel hardware alone is not sufficient.** Vendor eligibility is necessary but not proof — DMA-BUF zero-copy success must be proven (`dmabuf-success-criteria.md`) before the frame-count result is trusted, and the VAAPI/QSV zero-copy encoder backend (an implementation prerequisite, not present today) must exist (`instrumentation-sufficiency.md`).
