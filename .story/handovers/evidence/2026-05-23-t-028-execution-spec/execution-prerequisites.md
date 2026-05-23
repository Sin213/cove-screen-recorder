# VAL-CAP-006b — Execution prerequisites / future operator checklist (T-028 execution spec)

> Define-only. **The current M1 NVIDIA / KDE Plasma 6 / Wayland machine is NOT eligible to adjudicate VAL-CAP-006b** (DMA-BUF hard-fails → SHM only → cannot-validate, already recorded). This checklist is for a future qualifying AMD/Intel session.

## Before running
1. **Qualifying host:** `gpuInfo` starts `amd:` or `intel:` (never `nvidia:`). See `hardware-eligibility.md`.
2. **Wayland + PipeWire portal:** Wayland session; portal screencast active; not the simulator.
3. **Correct encoder path:** AMD → VAAPI; Intel → QSV with **zero-copy DMA-BUF import in the v2 helper encoder** — an **implementation prerequisite not present today** (helper has NVENC + libx264 only; VAAPI/QSV out of scope; no backend imports DMA-BUF). See `instrumentation-sufficiency.md` / `hardware-eligibility.md`.
4. **Declared 60 fps preset** selected and confirmed.
5. **Stable source resolution:** verify with `kscreen-doctor` / `wlr-randr` (or equivalent) at session start AND just before save; confirm no mid-run change and no `capture.formatChanged` off DMA-BUF.
6. **Helper log location:** capture the helper session log (the source of the DMA-BUF settle + fallback markers in `dmabuf-success-criteria.md`); record its path.
7. **ffprobe artifacts:**
   - Frame count (N-008 §6.1 line 419): `ffprobe -v error -select_streams v -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$f"`.
   - Streams / duration: `ffprobe -show_streams "$f"` and `-show_entries format=duration`.
8. **Path-only evidence capture:** screenshots and operator notes referenced by path; no full raw log dumps unless a FAIL needs analysis (`evidence-bundle-template.md`).

## During / after
- Confirm DMA-BUF success (`dmabuf-success-criteria.md`) **before** trusting the frame count.
- Adjudicate via `decision-table.md`. Emit exactly one `PASS.md` or `FAIL.md` only for branches 2/3; branches 4/5 → retry note, no PASS/FAIL.
- Map the outcome to ISS-011 / T-010c per `iss-011-t010c-disposition.md`.
