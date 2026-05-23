# VAL-CAP-006b — Evidence bundle template (T-028 execution spec)

> Define-only. **These are placeholders only. No adjudication occurs in this pass. No NVIDIA/KDE evidence may be reclassified into this bundle.** A future qualifying AMD/Intel session fills these in.

Future bundle location (per qualifying run):
`.story/handovers/evidence/<date>-t-028-val-cap-006b-<vendor>/`

## Required files
| File | Contents |
|------|----------|
| `gpuinfo.txt` | `gpuInfo` string; must start `amd:` or `intel:` (see `hardware-eligibility.md`). |
| `session-type.txt` | Wayland + PipeWire portal active confirmation. |
| `helper-log-excerpt.txt` | Excerpt showing DMA-BUF settle + absence of every fallback marker (`dmabuf-success-criteria.md` 2–8). Excerpt, not a full dump. |
| `capture-diagnostics.json` | `capture.diagnostics` samples: `buffers.buffer_type == "dmabuf"` steady. |
| `encoder-diagnostics.json` | `encoder.diagnostics` samples: `dmabuf_imports` nonzero/increasing, `shm_copy_bytes` ~0 (zero-copy import — an implementation prerequisite, see `instrumentation-sufficiency.md`). Emitted on the `encoder.diagnostics` channel, not `capture.diagnostics`. |
| `ffprobe-streams.txt` | `ffprobe -show_streams` — resolution, codec, r/avg_frame_rate, duration. |
| `ffprobe-frame-count.txt` | §6.1 count command output (`nb_read_packets`/`nb_read_frames`). |
| `declared-fps.txt` | Declared preset fps (60 for ISS-011 lineage). |
| `expected-frames.txt` | `round(duration_s × declared_fps)` computed for this run. |
| `adjudication.md` | Reasoning: predicate complete? DMA-BUF confirmed? frame count vs ±1? → verdict via `decision-table.md`. |
| `PASS.md` **or** `FAIL.md` | Exactly one, per `decision-table.md` (branches 2/3 only). INCONCLUSIVE/INVALID → no PASS/FAIL file; record a retry note instead. |
| operator screenshots / notes | **Referenced by path only**; not inlined. |

## Discipline
- **No full raw log dumps** unless a FAIL requires deeper failure analysis.
- One `PASS.md` xor one `FAIL.md` — never both, and **never a NVIDIA-host PASS/FAIL**.
- The bundle is created by the future hardware session, **not** by this define-only pass.
