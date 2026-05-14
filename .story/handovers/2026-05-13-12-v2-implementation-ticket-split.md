# Handover — v2.0.0 implementation ticket split (T-011..T-021)

**Date:** 2026-05-13
**Session type:** Planning only (`.story/` updates only — no source, test, helper, Electron, CI, or packaging edits).
**Branch:** main
**Phase opened:** `p3b-implementation` ("v2.0.0 Native/Helper Engine Implementation"), inserted between `p3-integration` and `p4-release`.

---

## Why this split

T-001..T-009 designed v2. T-010 was the release umbrella. T-010a/b are tooling (runner harness, synthetic loads). **None of T-001..T-010 implement the helper itself.** T-010c (smoke + RC execution) cannot run because there is no v2 native/helper replay engine to drive yet. This session opens the implementation series that must land before T-010c becomes executable.

Each ticket is sized for one Sonnet implementation session followed by one Codex review pass. The series is deliberately ordered scaffold → contract tests → real subsystems → UI migration → MVP smoke — never landing a real subsystem before its contract test exists.

---

## Tickets created

| ticket | title | status | order | blocked by | gates |
|---|---|---|---|---|---|
| T-011 | Scaffold native/helper replay engine package (cove-replay-engine) | open | 10 | — | T-012 |
| T-012 | Implement helper JSON-RPC transport and protocol types | open | 20 | T-011 | T-013, T-015 |
| T-013 | Implement Electron main helper supervisor | open | 30 | T-012 | T-014, T-016 |
| T-014 | Wire preload/renderer API to helper contract (stub mode) | open | 40 | T-013 | T-020 |
| T-015 | Add helper stub/simulation mode for validation harness | open | 50 | T-012 | T-016 |
| T-016 | Implement PipeWire capture MVP (monitor mode, NV12, sessionReady) | open | 60 | T-013, T-015 | T-017 |
| T-017 | Implement encoder probe / selection MVP (NVENC + libx264) | open | 70 | T-016 | T-018 |
| T-018 | Implement rolling fMP4 segment buffer MVP | open | 80 | T-017 | T-019 |
| T-019 | Implement replay snapshot + export/remux MVP (stream-copy) | open | 90 | T-018 | T-020 |
| T-020 | Integrate v2 UI state/FSM and diagnostics surface in renderer | open | 100 | T-014, T-019 | T-021 |
| T-021 | Run MVP smoke validation on helper + Electron; prepare for T-010c | open | 110 | T-020 | T-010c |

### Dependency graph

```
T-011 → T-012 ┬─ T-013 ─┬─ T-014 ──────────────────────────────────┐
              │         └─ T-016 → T-017 → T-018 → T-019 ──┐       │
              └─ T-015 ─┘                                  │       │
                                                           └→ T-020 → T-021 → (gates T-010c)
```

- T-013 and T-015 are parallelisable once T-012 lands.
- T-014 runs in parallel with T-016..T-019.
- T-020 is the joining ticket; T-021 is the MVP smoke gate.

---

## Recommended first Sonnet implementation ticket

**T-011 — Scaffold native/helper replay engine package.**

Reasons:
- Smallest possible scope: empty crate with module stubs, a CLI flag, and a workspace entry.
- Zero PipeWire / ffmpeg / encoder dependencies — keeps the helper buildable while contracts get nailed down.
- Unblocks T-012 (transport), which is the wire-format gate for every later ticket.
- One Sonnet session, one Codex review pass; expected diff is one new directory + Cargo workspace tweak.

Second pick: **T-012** if scaffolding is already partial. Third pick: T-014/T-015 in parallel once T-012 is reviewed.

---

## Why T-010c is not next

- T-010c executes the smoke + RC matrix against the v2 helper. The v2 helper does not exist yet.
- T-010a's runner harness needs JSON-RPC methods to call; T-012 is what makes those calls answerable.
- T-010b's synthetic loads need a real capture/encode/export pipeline to drive; T-019 is the earliest point that pipeline is end-to-end runnable, and T-021 is the earliest point we've validated it on M1.
- T-010c's `blockedBy` was therefore updated to `["T-010a", "T-010b", "T-021"]`. Its description was rewritten to call out the v2 implementation gate explicitly.

T-010a and T-010b can still proceed in parallel — they have no implementation dependency. They block T-010c on their own merits (runner + loads), and the v2 implementation series blocks T-010c by producing the artefact they drive.

---

## Exact `.story` files changed

- `.story/roadmap.json` — **modified** by `storybloq_phase_create`: new phase `p3b-implementation` ("v2.0.0 Native/Helper Engine Implementation"), inserted after `p3-integration`.
- `.story/tickets/T-011.json` — **created.** Scaffold helper crate.
- `.story/tickets/T-012.json` — **created.** JSON-RPC transport + protocol types.
- `.story/tickets/T-013.json` — **created.** Electron main supervisor.
- `.story/tickets/T-014.json` — **created.** Preload/renderer surface (stub mode).
- `.story/tickets/T-015.json` — **created.** Helper simulator.
- `.story/tickets/T-016.json` — **created.** PipeWire capture MVP.
- `.story/tickets/T-017.json` — **created.** Encoder probe/selection MVP.
- `.story/tickets/T-018.json` — **created.** Rolling fMP4 segment buffer MVP.
- `.story/tickets/T-019.json` — **created.** Replay snapshot + export/remux MVP.
- `.story/tickets/T-020.json` — **created.** Renderer FSM/diagnostics migration.
- `.story/tickets/T-021.json` — **created.** MVP smoke validation, T-010c gate.
- `.story/tickets/T-010c.json` — **modified.** `blockedBy` extended to include `T-021`; description rewritten to call out the v2 implementation gate explicitly.
- `.story/project-state.md` — **appended.** New section "v2.0.0 native/helper implementation ticket series (T-011..T-021, 2026-05-13)" at the end.
- `.story/handovers/2026-05-13-12-v2-implementation-ticket-split.md` — this file.

No other files in the repo were touched. **Only `.story/` files changed.**

## Source files changed

None. Planning-only session.

---

## Implementation boundaries (binding, inherited by every ticket)

- Do NOT reintroduce Electron MediaRecorder replay buffering.
- Do NOT send raw frames to Electron — frames live below Boundary B per N-007 §1.
- Do NOT implement broad architecture in one ticket. Each ticket is one Sonnet session.
- Do NOT jump to PipeWire (T-016) before helper process/protocol scaffolding (T-011..T-015) lands.
- Do NOT claim 1440p60 / 4K60 success until T-010c validates it.
- T-010c remains BLOCKED until T-021 returns a `green` verdict on M1.
- Each ticket carries explicit acceptance criteria, verification commands, Codex review expectations, and a "no commits, tags, or publishes" footer.

---

## Verification (this session)

Run by the operator:

```
git status --short
git diff --name-only
find .story -maxdepth 3 -type f | sort
```

Expected: only `.story/` files modified or created.

---

## Codex review

**No Codex review needed unless non-`.story` files changed.** This session is planning-only — only `.story/` planning artifacts were modified. The Codex review expectation lives inside each implementation ticket (T-011..T-021) and is triggered when that ticket's implementer hands code over.

---

## What lands at T-021 success

A working v2 MVP on M1: helper crate building cleanly, supervisor adopting/restarting it, preload/renderer exposing the v2 surface, simulator + real PipeWire+NVENC+libx264 paths, fMP4 segments with crash recovery, stream-copy export, FSM-driven renderer with Issue #1/#3/#4 absorption proofs at the UI layer, and a documented `Ready for T-010c?` verdict.

At that point T-010c unblocks and the matrix execution can begin.
