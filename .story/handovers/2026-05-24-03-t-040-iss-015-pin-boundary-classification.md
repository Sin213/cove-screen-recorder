# T-040 — ISS-015 B4 Helper-Side Pin-Boundary Classification

**Date:** 2026-05-24
**Ticket:** T-040 (complete). **Issues:** ISS-015 (open, awaiting next B4 repro).

## Session Goal

Implement T-040: add minimal helper-side observability at the `pin_snapshot` failure boundary to conclusively distinguish the five B4 classification targets on the next qualifying repro.

## Result: COMPLETE — Instrumentation deployed, Codex clean

Two files changed. Zero behavior changes. 8/8 Codex criteria pass.

## What Changed

### helper/src/segment/buffer.rs (+30 lines)

**Change 1 — committed-ring-empty warn! (before `return None`)**

Inside `pin_snapshot`, immediately before the early-return on `inner.committed.is_empty()`:

```rust
warn!(
    session_id = %inner.session_id,
    committed_len = 0u64,
    segments_committed = inner.segments_committed,
    segments_evicted = inner.segments_evicted,
    pinned_count = inner.pinned_count(),
    next_index = inner.next_index,
    bytes_on_disk = inner.bytes_on_disk,
    window_duration_90k = inner.config.window_duration_90k,
    disk_cap_bytes = inner.config.disk_cap_bytes,
    requested_duration_90k = duration_90k,
    "pin_snapshot: committed ring empty at save time"
);
```

**Classification targets from this warn:**
- `segments_committed==0` → session/buffer swap (ring never populated)
- `segments_evicted==segments_committed` → eviction unexpectedly emptied ring
- `segments_evicted < segments_committed` → accounting/removal inconsistency

**Change 2 — refs-empty-after-cutoff warn! (defensive, after cutoff loop)**

After `refs.reverse()`, if `refs.is_empty()` (mathematically unreachable while committed is non-empty):

```rust
if refs.is_empty() {
    let oldest_pts_start_90k = inner.committed.front().map(|s| s.pts_start_90k);
    let oldest_pts_end_90k = inner.committed.front().map(|s| s.pts_end_90k);
    let newest_pts_start_90k = inner.committed.back().map(|s| s.pts_start_90k);
    warn!(
        session_id = %inner.session_id,
        committed_len = inner.committed.len(),
        oldest_pts_start_90k = ?oldest_pts_start_90k,
        oldest_pts_end_90k = ?oldest_pts_end_90k,
        newest_pts_start_90k = ?newest_pts_start_90k,
        newest_pts_end_90k = newest_pts,
        cutoff = cutoff,
        duration_90k = duration_90k,
        "pin_snapshot: refs empty after cutoff loop (unexpected path)"
    );
}
```

Control flow unchanged: `Some(refs)` still returned.

### helper/src/export/mod.rs (+14 lines)

Correlation warn! logs at both match arms of `buffer_clone.pin_snapshot(duration_90k).await`:

- **`Some(_)` arm** (empty segments): logs `session_id`, `duration_s`, `duration_90k`, `is_closing`
- **`None` arm**: same fields

RPC error strings unchanged.

## Verification

1. `cargo build -p cove-replay-engine`: **0 errors**, 70 pre-existing warnings
2. `cargo clippy -p cove-replay-engine`: **0 errors**
3. `cargo test -p cove-replay-engine pin`: **2/2 pass**
4. `git diff --stat`: only `helper/src/export/mod.rs`, `helper/src/segment/buffer.rs`, `.story/tickets/T-037.json` (pre-existing story change)
5. Forbidden surface audit (helper/src/protocol/events.rs, encoder, capture, renderer, electron, validation, packaging, Cargo.toml, package.json): **EMPTY**
6. Codex review: **8/8 pass, no blocking defects**

## Evidence Root

`.story/handovers/evidence/2026-05-24-iss-015-pin-boundary-classification/`

(Empty until next B4 repro — functional verification pending.)

## Classification Targets for Next Repro

On the next B4 qualifying save failure, the helper log will fire at one of:

| warn! message | Fields to read | Classification |
|---|---|---|
| `pin_snapshot: committed ring empty at save time` | `segments_committed==0` | session/buffer swap |
| `pin_snapshot: committed ring empty at save time` | `segments_evicted==segments_committed` | eviction emptied ring |
| `pin_snapshot: committed ring empty at save time` | `segments_evicted < segments_committed` | accounting inconsistency |
| `pin_snapshot: refs empty after cutoff loop` | any | impossible cutoff/pinning logic |
| `replay.save: pin_snapshot None` | `is_closing=true` | finalize/closing-state interaction |

**Stop after ONE qualifying repro. Do NOT remediate.**

## Commit Status

NOT committed (per task instructions — do not commit unless explicitly told).

## Tickets Changed

- T-040: complete
