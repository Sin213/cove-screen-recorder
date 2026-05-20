# VAL-CAP-004 Threshold Diff — Rerun 8 vs Rerun 9

**Rerun 8 commit:** 814034f (pre-T-016a)
**Rerun 9 commit:** b5db18b (T-016a — "Implement PipeWire framerate hint")

## Outcome Comparison

| Stage | Rerun 8 (814034f) | Rerun 9 (b5db18b) |
|-------|-------------------|-------------------|
| engine.ready | received (pid 98078) | received (pid 126052) |
| env-probe | ok (pipewire+portal+nvidia) | ok (pipewire+portal+nvidia) |
| capture.requestSession | `{ok: true}` | `{ok: true}` |
| Portal pick | DP-4 selected by operator | DP-4 selected by operator |
| capture.startStream | `{ok: true}` | **error** `{code:"not-implemented", message:"no-acceptable-buffer-type"}` |
| capture.sessionReady | emitted (1920x1080 XR24 fps_num=0) | **never emitted** |
| Observation window (60s) | opened, 60 samples collected | **never opened** |
| Thresholds evaluated | YES (5 thresholds) | **NO (0 thresholds)** |
| Graceful stop / shutdown | stopSession + shutdown received | helper terminated by runner error path |

## Threshold Evaluations

| Threshold | Rerun 8 observed | Rerun 9 observed | Delta |
|-----------|------------------|------------------|-------|
| capture cell matches declared (1920x1080) | 1920x1080 — PASS | NOT EVALUATED (startStream failed) | n/a |
| drop rate <= 0 (1080p60-nvenc) | 0.005843 (0.58%) — FAIL | NOT EVALUATED | n/a |
| cadence mean within ±0.5% of 60.00 fps | 54.200 — FAIL | NOT EVALUATED | n/a |
| at least 1 diagnostics sample received | 60 — PASS | NOT EVALUATED | n/a |
| encoder.selected backend is nvenc | nvenc — PASS | NOT EVALUATED | n/a |

## File Presence Diff (`VAL-CAP-004/`)

Files produced in rerun 8 but **missing** in rerun 9 (because the run aborted at startStream):

- `capture-diagnostics.json`
- `encoder-probe-result.json`
- `encoder-selected.json`
- `sessionReady-notification.json`
- `thresholds.json`
- `shutdown-response.json`
- `stopSession-response.json`

Files present in both:
- `engine-ready.json`
- `env-probe.json`
- `helper-socket.txt`
- `load-launch.json`
- `requestSession-response.json`
- `startStream-response.json` (different content — error in rerun 9)

## Interpretation

Rerun 8 (pre-T-016a) successfully negotiated a 1920x1080 XR24 stream with
`fps_num=0/fps_den=1` (variable rate) and produced 60 seconds of diagnostics.
Both must-pass thresholds it evaluated (drop rate and cadence) failed because
PipeWire delivered ~54 fps under a variable-rate stream — the gap that
T-016a's framerate hint was intended to address.

Rerun 9 (T-016a applied) never reached the diagnostics window. The captured
artifacts prove the symptom — `capture.startStream` failed within 5197 ms
with `{code:"not-implemented", message:"no-acceptable-buffer-type"}` — but
they do not include helper/PipeWire logs that would identify which path
inside the helper produced the terminal reason. The bisect window between
rerun 8 (814034f) and rerun 9 (b5db18b) modifies only
`helper/src/capture/pipewire.rs`, so T-016a is the prime suspect for the
regression. Treat the connection between T-016a's format-pod / `UpdateFramerate`
changes and `no-acceptable-buffer-type` as a **hypothesis** until a follow-up
run captures helper stderr (or runs the helper with `RUST_LOG=debug` against
the same JSON-RPC sequence).

Because rerun 9 never opened the 60s observation window, **it cannot answer
the question rerun 9 was designed to answer** — whether T-016a changed the
~54 fps PipeWire cadence baseline observed in rerun 8. The cadence question
is blocked behind a separate, harder regression: stream negotiation is now
broken end-to-end on this host.

## Verdict

T-021 remains OPEN. Next pass is **NOT** the cadence/drop investigation path
documented in rerun 8's handover. It is the capture-layer regression that
prevents the stream from reaching `sessionReady` on b5db18b. Routing per
decision tree: file an issue against the capture/PipeWire layer (T-016a
prime suspect, but record it as a hypothesis bounded by the bisect window
rather than as a confirmed path). Do not patch in this ticket.
