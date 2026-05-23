# VAL-CAP-006b — DMA-BUF zero-copy success criteria (T-028 execution spec)

> Define-only. These criteria prove the *precondition* (a working zero-copy path) before the §6.1 frame-count assertion is trusted. All marker semantics below come from the **existing** helper instrumentation; T-028 changes none of it.

A run qualifies as "confirmed zero-copy DMA-BUF" only if **ALL** hold for the measured session:

1. **Buffer type steady = dmabuf.** `capture.diagnostics.buffers.buffer_type == "dmabuf"` steadily for the whole session (not just one tick). Emitted ~1×/s by the diagnostics loop — `helper/src/capture/pipewire.rs:2072-2082` (value from `BufferMemType` Display → `"dmabuf"`/`"shm"`, `pipewire.rs:73-74`).
2. **DMA-BUF settled.** Negotiation reached `BufferNegotiationPhase::Settled(DmaBuf)`; `buffers.buffer_type` flips Unknown→`dmabuf` (`pipewire.rs:1648-1656`); first-attempt marker `"DMA-BUF-only first attempt"` present (`pipewire.rs:1421`).
3. **No SHM fallback markers.** Neither the SHM-only reconnect log `"SHM-only (MemFd|MemPtr) — DMA-BUF fallback"` (`pipewire.rs:1415`) nor `buffers.buffer_type == "shm"` at any tick.
4. **No soft fallback marker.** `PreBuildAction::TriggerShmSoftFallback` not taken (process-callback soft fallback — `pipewire.rs:261,272`).
5. **No payload extraction failure marker.** No `PayloadFailAction::TriggerShmFallbackOnUnusableDmaBuf`; `dmabuf_attempt_failures` stays below `DMABUF_UNUSABLE_THRESHOLD (=3)` (`pipewire.rs:215,283-307`).
6. **No hard-fail reconnect marker.** No `"PW stream errored during DMA-BUF-only negotiation … triggering SHM-only fallback retry"` → `PwCommand::RetryShmAfterDmaBufFailure` (`pipewire.rs:1335-1339`).
7. **No stream-error fallback marker.** Same hard-fail path as (6): the session must not have dropped from `DmaBufAttempted` into a SHM retry due to a stream `Error`.
8. **No `capture.formatChanged` to a non-DMA-BUF format.** No `FormatChanged` event flipping the path off DMA-BUF (`pipewire.rs:37,108`; `format_changed_pending` `:1241`).
9. **Encoder zero-copy import succeeds.** Encoder diagnostics show `dmabuf_imports` nonzero and increasing — `helper/src/protocol/events.rs:123`; `helper/src/encoder/session.rs:108,739`. **Implementation prerequisite — NOT present today:** no helper backend imports DMA-BUF yet. NVENC rejects it (`accepts_dmabuf: false`; errors on a DMA-BUF payload — `helper/src/encoder/backends/nvenc/mod.rs:7,540,683-688`), libx264 is a `not-implemented-yet` stub (`x264.rs:59-69`), and VAAPI/QSV are out of scope (`helper/src/encoder/backends/mod.rs:10`, `helper/src/encoder/mod.rs:69`). The `dmabuf_imports` counter is emitted but **never incremented** in real code — only the simulator sets it (`helper/src/sim/dispatch.rs:282`). This criterion is satisfiable only after a VAAPI/QSV zero-copy encoder backend and a real `dmabuf_imports` increment land (see `instrumentation-sufficiency.md`).
10. **Session reached first usable frame.** `capture.sessionReady` fired (`pipewire.rs:1006-1015`; `helper/src/capture/mod.rs:147`). A run that ends before `sessionReady` is INVALID, not evidence (see `decision-table.md`).

If any of criteria **1–9** is violated, the run is **not** a confirmed zero-copy path → **INCONCLUSIVE** on AMD/Intel and must be retried (decision-table branch 4). A criterion **#10** violation (no first usable frame) is **INVALID** (branch 5), not INCONCLUSIVE. Neither is ever a 006b PASS, and on AMD/Intel neither is cannot-validate.

## Field-name caveat (document only; do NOT fix in T-028)
- The helper **emits** `capture.diagnostics.buffers.buffer_type` (snake_case, nested under `buffers`) — `pipewire.rs:2076-2082`.
- N-008 **VAL-CAP-009 prose** (note line 192) and the T-028 ticket text say `capture.diagnostics.bufferType` (camelCase, flat).
- The adjudicator MUST read the **real emitted field** `buffers.buffer_type` (value `"dmabuf"`). The camelCase prose is documentation shorthand, not the wire field.
- This is recorded for the future operator only. **T-028 does not edit N-008/VAL-CAP-009 prose or any helper/validation code to reconcile it** — out of scope; no runtime/policy change in this define-only pass.
