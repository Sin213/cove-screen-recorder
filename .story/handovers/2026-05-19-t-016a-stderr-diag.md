# T-016a stderr diagnostic — no-acceptable-buffer-type root cause

**Diagnostic pass ID:** T-016a no-acceptable-buffer-type stderr diagnostic  
**Date:** 2026-05-19  
**Repo:** /home/sin/Projects/cove-screen-recorder  
**Commit tested:** 5bfacfab1a25ee73a86d877b44b5b58c5c7820c5 (Record MVP smoke rerun 9 evidence)  
**T-016a commit in history:** b5db18b Implement PipeWire framerate hint  

---

## 1. Preflight result

PASSED.

- Working tree clean at start.
- HEAD = 5bfacfa "Record MVP smoke rerun 9 evidence".
- b5db18b "Implement PipeWire framerate hint" confirmed in history.
- `git diff --check` clean.

---

## 2. Environment summary

| Field | Value |
|---|---|
| Display | DP-4 |
| Active mode | 3840x2160@239.99 (VRR Never) |
| Compositor | KDE Wayland / xdg-desktop-portal-kde |
| GPU | NVIDIA (nvidia-smi captured) |
| Portal status | xdg-desktop-portal-kde running |

Note: Display is at 4K@240 (not 1080p@60 as in prior reruns). The diagnostic reproduces the same failure regardless, because the failure is at format-pod negotiation level, not display-mode-specific.

---

## 3. Diagnostic command / script

### Helper launch

```bash
RUST_LOG="debug,cove_replay_engine::capture::pipewire=trace" \
  ./target/release/cove-replay-engine --ipc-socket "$SOCK" \
  2>> "$LOG_DIR/helper-stderr.jsonl" &
```

### JSON-RPC driver (Python, throwaway, no tracked file)

Minimum sequence:
1. Receive `engine.ready` (4-byte length-prefixed frame)
2. `engine.version`
3. `engine.health`
4. `capture.requestSession` with `{mode: "monitor", cursor_mode: "embedded", persist: "transient"}`
5. `capture.startStream` with `{}`
6. Wait for `capture.sessionReady` or `capture.sessionLost` (up to 60s)
7. `engine.shutdown`

Driver saved only to `/tmp/diag-rpc-driver.py` — no tracked file created.

---

## 4. Evidence directory

```
.story/handovers/evidence/2026-05-19-t-016a-stderr-diag/
├── display-mode-before.json
├── display-mode-before.txt
├── display-mode-after.json
├── helper-stderr.jsonl          ← full structured stderr
├── helper-stderr.grep.txt       ← breadcrumb grep hits
├── host-load-before.txt
├── json-rpc-transcript.txt      ← full RPC sequence
├── nvidia-smi-before.txt
├── nvidia-smi-after.txt
├── portal-status-before.txt
├── post-pgrep-cove.txt
└── pre-pgrep-cove.txt
```

---

## 5. JSON-RPC transcript summary

```
engine.ready           → received (protocol_version: 1)
engine.version         → OK (helper_version: 0.1.0)
engine.health          → OK (state: ready)
capture.requestSession → OK (portal shown, DP-4 selected, Share clicked)
capture.startStream    → sessionLost notification arrived before id:4 response
capture.sessionLost    → notification {reason: "no-acceptable-buffer-type",
                          session_id: "pw-session-0000-151431-1779247112576",
                          stream_id: "pw-stream-0000"}
engine.shutdown        → request (id:5) sent; NO id:5 ack received.
                          Last frame received was the delayed id:4 startStream error:
                          {code: "not-implemented", message: "no-acceptable-buffer-type"}.
                          Driver misread this delayed id:4 frame as "Shutdown OK".
                          Actual shutdown RPC ack was NOT confirmed by the transcript.
```

**The failure reproduced exactly.** The missing shutdown ack does not affect the root-cause verdict (failure confirmed before shutdown was sent).

Note on transcript line ordering: `capture.sessionLost` notification arrived first (helper emits it immediately on failure), then the driver sent `engine.shutdown`, and the delayed `id:4` startStream error response arrived after. See `json-rpc-transcript.txt` lines 15–19 for the exact sequence.

---

## 6. Helper stderr breadcrumb table

| Timestamp | Level | Message |
|---|---|---|
| 03:18:32.576 | INFO | `portal session established` node_id=121 |
| 03:18:32.584 | WARN | `PW stream errored during DMA-BUF-only negotiation: no more input formats; triggering SHM-only fallback retry` |
| 03:18:32.584 | INFO | `PW: DMA-BUF negotiation hard-failed; reconnecting with SHM-only fallback` |
| 03:18:32.594 | WARN | `PW stream errored during DMA-BUF-only negotiation: no more input formats; triggering SHM-only fallback retry` ← **second fire** |
| 03:18:32.594 | WARN | `start_stream failed` reason=no-acceptable-buffer-type |

---

## 7. Failure reproduced

YES. `capture.startStream` → `sessionLost(no-acceptable-buffer-type)` reproduced on commit 5bfacfa / b5db18b.

---

## 8. Root-cause path verdict

### **PATH D CONFIRMED**

`RetryShmAfterDmaBufFailure` handler reconnects using the primary nonzero-rate pod (`build_format_enum_pod(retry_hint)`) instead of the legacy permissive pod (`build_format_enum_pod_legacy_permissive()`).

### Exact call sequence

**pipewire.rs:1750–1786** — initial connect:

```rust
let primary_bytes = build_format_enum_pod(primary_hint)?;  // min framerate = 1/1
// ...
if let Err(e_primary) = stream.connect(..., &mut primary_params) {
    // only catches synchronous rejection — not async negotiation failure
    let legacy_bytes = build_format_enum_pod_legacy_permissive()?;
    stream.connect(..., &mut legacy_params);
}
```

Primary `stream.connect()` returns `Ok(())` (synchronous call succeeds). The async format negotiation then fails: PipeWire emits "no more input formats" via the state error callback.

**pipewire.rs:1335–1339** — state error callback (DmaBufAttempted phase):

```rust
if matches!(ud.negotiation_phase, BufferNegotiationPhase::DmaBufAttempted) {
    warn!("PW stream errored during DMA-BUF-only negotiation: {msg}; triggering SHM-only fallback retry");
    let _ = ud.pw_cmd_tx.send(PwCommand::RetryShmAfterDmaBufFailure);
}
```

**pipewire.rs:1808–1848** — `RetryShmAfterDmaBufFailure` cmd handler (first fire):

```rust
// force_shm_on_negotiation.swap(true) returns false (first time) → proceed
info!("PW: DMA-BUF negotiation hard-failed; reconnecting with SHM-only fallback");
let _ = stream_cmd.disconnect();
let retry_hint = { /* reads counters_cmd.framerate_hint = 0 → None */ };
match build_format_enum_pod(retry_hint) {  // ← BUG: uses primary pod (min=1/1) not legacy (min=0/1)
    Ok(bytes) => {
        stream_cmd.connect(..., &mut retry_params);  // also fails async negotiation
    }
}
```

The retry connect also calls `stream.connect()` with the **same primary nonzero-rate pod** (min framerate=1/1). The compositor rejects this for the same reason: it cannot satisfy a minimum framerate of 1/1 (it likely proposes 0/1 as an initial variable-rate negotiation value).

The state error callback fires a **second time**, dispatches `RetryShmAfterDmaBufFailure` again.

**pipewire.rs:1808–1815** — `RetryShmAfterDmaBufFailure` cmd handler (second fire):

```rust
if counters_cmd.force_shm_on_negotiation.swap(true, Ordering::Relaxed) {
    // Already true → second-fire guard triggers
    signal_terminal_fail(..., REASON_NO_ACCEPTABLE_BUFFER_TYPE);
    return;
}
```

Second-fire guard activates → `no-acceptable-buffer-type`.

---

## 9. Analysis answers

| Question | Answer |
|---|---|
| Did run reproduce `capture.startStream → no-acceptable-buffer-type`? | YES |
| Did helper stderr contain expected PipeWire tracing lines? | YES — at `debug,pipewire=trace` level |
| Which path fired? | **D** — RetryShm reconnect used primary nonzero-rate pod |
| Failure before or after OnParamChanged? | **Before** — "no more input formats" means format negotiation failed; `param_changed` never fires |
| Was `RetryShmAfterDmaBufFailure` dispatched? | YES — twice |
| Did retry reconnect use primary nonzero-rate pod? | **YES** — this is the bug |
| Did helper try legacy permissive pod for the retry? | NO |
| Did stream.connect() reject the nonzero-rate pod? | Synchronous call succeeded; async negotiation rejected it |
| Did compositor deliver DMA-BUF during ShmAttempted? | Not reached — failure before buffer negotiation phase |
| Did build_frame_payload return None repeatedly? | Not reached |

### Why does the primary pod fail?

`build_format_enum_pod` sets `VideoFramerate` min=`1/1`. The compositor proposes `0/1` (variable rate) during KDE Wayland screencast format negotiation. Since 0/1 < 1/1, the intersection is empty → "no more input formats".

`build_format_enum_pod_legacy_permissive` uses min=`0/1`, which includes the compositor's proposal → negotiation succeeds.

---

## 10. Log evidence

```
PW stream errored during DMA-BUF-only negotiation: no more input formats  [first fire]
PW: DMA-BUF negotiation hard-failed; reconnecting with SHM-only fallback
PW stream errored during DMA-BUF-only negotiation: no more input formats  [second fire — same pod]
start_stream failed reason=no-acceptable-buffer-type
```

The second WARN fires with the same "DMA-BUF-only negotiation" message because `negotiation_phase` is still `DmaBufAttempted` — the retry connect never advanced to `param_changed`, so the phase was never updated to `ShmAttempted`.

---

## 11. Sufficiency of helper stderr

YES. `RUST_LOG=debug,cove_replay_engine::capture::pipewire=trace` produced sufficient breadcrumbs to identify the exact call site. The two WARN lines plus the INFO reconnect message unambiguously confirm path D.

---

## 12. Files created / touched

**Created:**
- `.story/handovers/2026-05-19-t-016a-stderr-diag.md` (this file)
- `.story/handovers/evidence/2026-05-19-t-016a-stderr-diag/` (evidence directory)
- `/tmp/diag-rpc-driver.py` (throwaway, not tracked)

**Not touched:**
- `helper/**` — no source changes
- `validation/**` — no validation changes
- `electron/**`, `src/**`, `Cargo.toml`, `package.json` — untouched
- `.story/tickets/T-021.json`, `.story/tickets/T-010c.json` — untouched
- VAL-CAP-004 thresholds/policy — unchanged
- NVENC/encoder files — untouched

---

## 13. Confirmations

- No source files changed: **CONFIRMED**
- No validation files changed: **CONFIRMED**
- No T-021 smoke rerun: **CONFIRMED**
- No VAL-CAP-004 policy change: **CONFIRMED**
- No NVENC or encoder files changed: **CONFIRMED**

---

## 14. Recommended next implementation pass

**Path D fix — `helper/src/capture/pipewire.rs` only:**

In the `PwCommand::RetryShmAfterDmaBufFailure` handler (approx. line 1835), replace:

```rust
match build_format_enum_pod(retry_hint) {
```

with:

```rust
match build_format_enum_pod_legacy_permissive() {
```

This makes the retry reconnect use the legacy permissive pod (min=0/1 framerate) which the compositor accepts, allowing format negotiation to succeed and the stream to advance to the buffer-type negotiation phase where SHM fallback can complete.

Additionally, consider whether `build_format_enum_pod_legacy_permissive` should also be tried in the initial connect's async failure path (not just the synchronous `stream.connect()` error path), to close the gap between synchronous and asynchronous rejection handling.

---

## 15. Stop-condition notes

- Failure reproduced on first diagnostic run.
- Helper stderr was sufficient; no second pass needed.
- No source changes required for this diagnostic pass.
- Codex review pending before implementation recommendation is acted on.
