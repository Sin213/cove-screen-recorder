# VAL-CAP-006b — Instrumentation sufficiency & implementation prerequisites (T-028 execution spec)

> Define-only. **Capture-side** instrumentation is sufficient today to *prove the DMA-BUF capture path*. The **encoder zero-copy import** path is **not implemented yet**, so VAL-CAP-006b is blocked by BOTH (a) qualifying AMD/Intel DMA-BUF hardware AND (b) the helper implementation prerequisites below. T-028 is **not** a pure hardware-availability gate.

## Sufficient today — capture-side evidence (read-only, really emitted)
| Need | Existing evidence source |
|------|--------------------------|
| Buffer type per tick | `capture.diagnostics.buffers.buffer_type` — `helper/src/capture/pipewire.rs:2072-2082` (value `"dmabuf"`/`"shm"`, `:73-74`) |
| DMA-BUF settled / first attempt | `BufferNegotiationPhase::Settled(DmaBuf)` flip — `pipewire.rs:1648-1656`; `"DMA-BUF-only first attempt"` — `:1421` |
| SHM / soft / hard / payload fallbacks | `"SHM-only … DMA-BUF fallback"` (`:1415`); `TriggerShmSoftFallback` (`:261,272`); `RetryShmAfterDmaBufFailure` + stream-error log (`:1335-1339`); `PayloadFailAction` + `DMABUF_UNUSABLE_THRESHOLD` (`:215,283-307`) |
| Format change off DMA-BUF | `capture.formatChanged` / `FormatChanged` — `pipewire.rs:37,108`; `format_changed_pending` `:1241` |
| First usable frame | `capture.sessionReady` — `pipewire.rs:1006-1015`; `helper/src/capture/mod.rs:147` |
| Frame count vs declared | `ffprobe` (external) per N-008 §6.1 line 419 |

These prove the capture path negotiated and held zero-copy DMA-BUF; **no capture-side change is needed.**

## NOT present today — implementation prerequisites (out of scope for this define-only pass)
VAL-CAP-006b's "encoder zero-copy import succeeds" criterion (`dmabuf-success-criteria.md` #9) **cannot be satisfied by the current helper** and requires follow-up implementation work (separate tickets — **not created in this define-only pass**):

1. **A VAAPI (AMD) / QSV (Intel) zero-copy DMA-BUF encoder backend.** The helper has NVENC + libx264 backends only; VAAPI/QSV/AMF are explicitly out of scope (`helper/src/encoder/backends/mod.rs:10`, `helper/src/encoder/mod.rs:69`). Even NVENC does **not** import DMA-BUF — `accepts_dmabuf: false` and it errors on a DMA-BUF payload (`helper/src/encoder/backends/nvenc/mod.rs:7,540,683-688`); libx264 is a `not-implemented-yet` stub (`x264.rs:59-69`). So no backend performs zero-copy import on any vendor yet.
2. **A real `dmabuf_imports` increment path.** The counter is declared and emitted (`helper/src/protocol/events.rs:123`; `helper/src/encoder/session.rs:108,739`) but is **never incremented in real code** — only the simulator sets it (`helper/src/sim/dispatch.rs:282`). On real hardware it stays `0`, so "nonzero and increasing" is currently unsatisfiable.

## Statements
- **Capture-side:** no new marker / field needed; sufficient as-is.
- **Encoder-side:** a VAAPI/QSV zero-copy backend **and** a real `dmabuf_imports` increment must be implemented before 006b can reach a confirmed-zero-copy PASS/FAIL. These are implementation blockers recorded here for the future operator; this define-only pass neither builds nor schedules them.
- **This define-only pass itself makes no runtime/helper/validation change** — it documents the existing code state; the prerequisites above are separate future work.
- **If a session ends before `capture.sessionReady` (first usable frame), the run is INVALID rather than evidence** — re-run, do not adjudicate (decision-table branch 5).
- The `buffers.buffer_type` vs `bufferType` field-name caveat (`dmabuf-success-criteria.md`) is a documentation note for the adjudicator; not fixed by T-028.
