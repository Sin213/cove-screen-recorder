# Handover — T-009 Validation matrix for 1080p60 / 1440p60 / 4K60

**Date:** 2026-05-13
**Session type:** Design only (planning, `.story/` updates only — no source, test, helper, Electron, CI, or packaging edits).
**Branch:** main
**Ticket:** T-009 (Plan validation matrix for 1080p60, 1440p60, and 4K60) → **status: complete**
**Phase:** p3-integration

---

## What was decided

The v2.0.0 validation matrix and scripted-test plan are locked. Full design lives in `.story/notes/N-008.json` (25 sections). Summary captured below.

### Three goals

1. **v2 clears the v1.1.0 MediaRecorder ceiling.** On capable HW (NVENC, VAAPI, QSV), 1440p60 and 4K60 must be reachable end-to-end (capture → encode → segment → export) without the Chromium/Electron getDisplayMedia + canvas + MediaRecorder upstream drops. 1080p60 must remain stable.
2. **No regression of v1.1.0 fixes.** Replay corruption, fake duplicated-frame 60 fps, save freeze during save, broken Linux HW fallback loops, audio sidecar, save state, source diagnostics, FPS/cadence detection, leftover processes — each has a named row.
3. **Issues #1, #3, #4 are absorbed structurally.** Each issue has at least one row that asserts the new structural property and fails loudly if it is violated.

### Severity tiers

`must-pass` (blocks GA) ⊃ `smoke` (≤ 30 min on M1, runs every branch). `rc` = full 4-machine matrix, 4–6 h. `regression ⊂ must-pass`, pre-defined failure mode. `soak ≥ 15 min`. `nice-to-have` non-blocking.

### Hardware / environment matrix

- **M1** Arch / KDE Plasma 6 / Wayland / NVIDIA RTX 40-class — NVENC + libx264 — **smoke workstation**.
- **M2** Ubuntu LTS / GNOME / Wayland / AMD RDNA3 — VAAPI + libx264.
- **M3** Fedora / KDE Plasma 6 / Wayland / Intel Arc — QSV (preferred), VAAPI (fallback), libx264.
- **M4** Debian / wlroots (Sway) / Wayland / Intel iGPU — QSV + VAAPI + libx264.
- **M5** Arch / KDE / Wayland / NVIDIA — manual UX machine.
- **W1** Windows 11 / NVIDIA — placeholder only; AMF and WGC documented as inert in v2.0.0.

### Synthetic loads

- `L-MOTION-60` — full-screen frame-perfect scroll, PTS encoded in pixels. Load-bearing cadence proof.
- `L-STATIC`, `L-CHANGE`, `L-RESIZE`, `L-MINIMIZE`, `L-PORTAL-DENY`, `L-SOURCE-REMOVE`, `L-COMP-PAUSE`.
- `L-DISK-SLOW` (50 MB/s via `dm-delay`), `L-DISK-FULL` (200 MiB tmpfs).
- `L-CRASH-CAP`, `L-CRASH-EXP` (SIGKILL helper mid-{capture, export}).
- `L-AUDIO-SYNC` (placeholder for audio milestone).

Specs only — repo does not ship asset binaries; creation is a T-010 implementation task.

### Universal pass/fail thresholds (N-008 §6)

- **Capture drop (capable HW).** 0 at 1080p60/1440p60 on NVENC/VAAPI/QSV; ≤ 0.1 % at 4K60 NVENC/VAAPI; ≤ 0.5 % at 4K60 QSV; libx264 4K60 may legitimately back-pressure — must engage `encoder.backPressure`, never silent.
- **Encoder drop.** 0 for 1080p/1440p on HW; ≤ 0.1 % at 4K60 NVENC/VAAPI.
- **No fake duplicated frames.** Frame count = `round(duration_s × declared_fps) ± 1`. Duplicated-PTS pairs ≤ 1 per 60 s. The v1.1.0 fake-60fps regression dies here.
- **Cadence.** Mean inter-PTS ±0.5 % of nominal; 95p ±2 %; 99p ±5 %.
- **Duration.** ±1 frame at 60 s; ±50 ms at 5 min; ±200 ms at 10 min; ±500 ms ≥ 15 min.
- **Save latency.** `replay.save` ≤ 250 ms + remaining fragment encode time (worst case ≈ 2.25 s).
- **HUD non-freeze.** HUD timer ≥ 1 Hz during the full SAVING window.
- **Export concurrency.** Capture frame production continues during EXPORTING with drop within 2× pre-export baseline. Exactly **one terminal event per `exportId`**.
- **Encoder fallback.** ≤ 1 `fallbackEngaged` per session. No mid-session switching. Linux re-encode = libx264 only. Negative probe cached, not re-tried within TTL.
- **Process cleanup.** 5 s after shutdown: zero `cove-replay-engine`/`ffmpeg`/`pactl` under `$UID`. `pactl` MUST NEVER appear in any helper child process tree.
- **Recovery.** `replay.recoveryAvailable` ≤ 2 s after `engine.ready`. Partial segments absent; committed segments present. Mid-export orphan reaped before `engine.ready`.
- **Supervision.** Restart loop ≤ 3 in 60 s → sticky `engine.unavailable`. Helper sha256/protocol mismatch refuses boot with blocking modal.

### Validation areas (categories)

- **VAL-CAP** — PipeWire sessionReady, portal denial, monitor / window / region capture, **Issue #3 minimised-source 60 s**, formatChanged, DMA-BUF vs SHM, source removal, compositor pause, 1440p60 and 4K60 sweeps, 15-min soak rows.
- **VAL-ENC** — positive probe per backend, negative probe + cache, manual reset, selected/fallback visibility, **no mid-session switching**, libx264 universal fallback, **Linux re-encode libx264-only**, **no blind HW retry loops**, AMF future-slot visibly inert, backPressure at 4K60 libx264.
- **VAL-SEG** — 30 s / 60 s / 2 min / 5 min / 10 min windows bounded disk; atomic commit; save-while-capture; pin defers eviction; slow disk; disk full; crash recovery committed-only; snapshot is paths not bytes.
- **VAL-EXP** — fast stream-copy, lead-trim re-encode, discontinuity re-encode, max-compat full re-encode, cancel before MUXING, cancel disabled past MUXING, failure path with diagnostics, exactly-once terminal events, faststart, **no fake duplicated frames**, real cadence preserved, concurrent with RECORDING, mid-export orphan reaping.
- **VAL-UI** — FSM coverage, **`RECORDING` reachable only via `capture.sessionReady`** (instrumented assertion), **HUD non-freeze during SAVING (Issue #4)**, **three clocks independent (Issue #4)**, **region overlay flow (Issue #1)**, helper crash → ENGINE_DOWN, recovery prompt non-modal, helper sha256 / protocol blocking modals, hotkeys, dependency probe.
- **VAL-REC** — `L-CRASH-CAP`, `L-CRASH-EXP`, restart loop bound, adopt live same-user helper, refuse cross-user PID, stale socket/pid scrub.
- **VAL-PROC** — IDLE / RECORDING / SAVING / EXPORTING quit cleanup, SIGKILL scrub, **`pactl` never spawned**, Linux `PDEATHSIG=SIGKILL` on every helper child, Windows Job Object kill-on-close (future-CI).
- **VAL-PERF** — 15-min soak at 1080p60/1440p60/4K60 across HW encoder paths; save spam 1/5 s for 5 min; concurrent export; 4K60 libx264 back-pressure observation.

### v1.1.0 regression suite (VAL-REG-001..013)

Consolidated to one table. Every row `must-pass` + `regression`; many are also `smoke`.

| id | v1.1.0 issue | proven by |
|---|---|---|
| REG-001 | Replay corruption | VAL-EXP-001 + 009 + 010 on 60 s and 5 min outputs across encoder paths |
| REG-002 | Fake duplicated-frame 60 fps | VAL-EXP-010 + 011 |
| REG-003 | Replay freeze during save | VAL-UI-003 + VAL-PERF-007 |
| REG-004 | Broken Linux HW fallback loops | VAL-ENC-008 + 011 |
| REG-005 | Audio sidecar stability | placeholder, must-pass on audio launch |
| REG-006 | Replay save state handling | VAL-UI-001 + 003 |
| REG-007 | Replay source diagnostics | `capture.json` produced per session |
| REG-008 | Replay FPS/cadence detection | VAL-EXP-011 + UI fps = ffprobe r_frame_rate ±1 % |
| REG-009 | Process cleanup issues | VAL-PROC-001..008 |
| REG-010 | No leftover ffmpeg | VAL-PROC-001..005 + 007 post-condition |
| REG-011 | No leftover pactl | VAL-PROC-007 (helper child tree clean of `pactl`) |
| REG-012 | No hover / DOM / canvas readiness dependency | VAL-CAP-006 |
| REG-013 | No timer-based readiness guessing | VAL-UI-002 (instrumented FSM assertion) |

### Issue #1 / #3 / #4 absorption proofs (triple-classified must-pass + smoke + regression)

- **#1 (region selection)** — VAL-UI-005 (frameless overlay shown; "Share region" string NEVER appears in v2 UI) + VAL-CAP-007 (hot region change via `capture.setRegion`, no session restart).
- **#3 (no hover dependency)** — VAL-CAP-006 (minimised source 60 s produces declared frame count) + VAL-UI-002 (instrumented assertion: `setState(RECORDING)` only from the `capture.sessionReady` handler).
- **#4 (timer state weirdness)** — VAL-UI-003 (HUD ≥ 1 Hz during SAVING) + VAL-UI-004 (three clocks in three DOM regions; mutating one does not perturb the others).

### Resolution × encoder coverage gate (§18)

| res / fps | NVENC | VAAPI AMD | QSV Intel | VAAPI Intel | libx264 | AMF | WGC+NVENC Win |
|---|---|---|---|---|---|---|---|
| 1080p60 | must-pass / smoke | must-pass | must-pass | must-pass | must-pass | n/a | n/a |
| 1440p60 | must-pass | must-pass | must-pass | must-pass | nice-to-have | n/a | n/a |
| 4K60 | must-pass | must-pass | must-pass | nice-to-have | nice-to-have (back-pressure mandatory) | n/a | n/a |

v2.0.0 ships when every `must-pass` cell is green on M1+M2+M3+M4. **No 4K60 success claim** — this is the acceptance plan only.

### Smoke suite (≤ 30 min on M1+M5)

18 ordered rows, stop on first must-pass fail:

env probe → sessionReady → portal denial → 1080p60 NVENC 60 s L-MOTION-60 → **Issue #3 proof (minimised 60 s)** → **Issue #1 proof (region overlay)** → NVENC probe + selected visibility → 60 s bounded disk → save-while-capture → fast stream-copy 60 s → no-fake-duplicated-frames check → export concurrent with RECORDING → **Issue #4 proof (HUD non-freeze during SAVING)** → hotkey saveReplay → no-leftover-processes after IDLE/RECORDING/quit → `pactl`-never-spawned post-suite → fake-60fps regression re-run.

### RC suite (4–6 h on M1+M2+M3+M4)

Smoke + all VAL-CAP/ENC/SEG/EXP/UI/REC/PROC must-pass + all VAL-REG + soak (VAL-PERF-001..005) + helper sha256 / protocol mismatch modals + dependency probe modal + v1.1.0 vs v2.0.0 comparison plot per encoder family. `nice-to-have` rows run on schedule but do not gate RC.

### v1.1.0 vs v2.0.0 comparison protocol (§21)

Structural, not parity — v1.1.0 cannot pass 1440p60/4K60. Run `L-MOTION-60` on both at every resolution × encoder cell; record drop rate, frame count vs declared fps, save round-trip, HUD freeze duration. v1.1.0 will fail 1440p/4K and freeze HUD on save. v2.0.0 must clear all. **Discipline:** if v2.0.0 regresses below v1.1.0 at 1080p60, that is a hard fail even within absolute tolerance.

### ffprobe / mediainfo check recipes (§20)

Spec-level recipes for duration, declared fps, frame count, duplicated-PTS detection, real cadence, faststart, codec, GOP / fragment structure. T-010 wraps them in a runner.

### Diagnostics bundle (§7)

Every must-pass row produces a bundle: `engine.diagnosticsBundle.zip` (helper) + `capture.json` + `encoder.json` + `segments.json` + per-export `export.json` + `out.mp4` + `out.mp4.ffprobe.json` + `out.mp4.mediainfo.json` + `pre/post_pgrep.txt` + `renderer-events.jsonl` + `dmesg.tail`. Redaction of paths-above-recording is itself a row (VAL-DIAG-002).

### T-010 release-gate checklist (§24, the literal list T-010 opens with)

1. ☐ Smoke green on M1.
2. ☐ RC `must-pass` green on M1+M2+M3+M4.
3. ☐ §18 coverage gate: every must-pass cell green.
4. ☐ VAL-REG green.
5. ☐ Issue #1/#3/#4 proofs green.
6. ☐ v1.1.0 vs v2.0.0 comparison plot produced.
7. ☐ Diagnostics bundle produced per encoder path; redaction verified.
8. ☐ Helper `.sha256` sidecar present for every shipped binary (global release rule).
9. ☐ Linux `.deb` Depends honoured (dependency probe modal).
10. ☐ Release notes generated from matrix output.

A red signal blocks GA. A `nice-to-have` red signal becomes a tracked post-GA issue.

---

## Exact `.story` files changed

- `.story/notes/N-008.json` — **created.** Full validation matrix design (25 sections).
- `.story/tickets/T-009.json` — status `open` → `complete`; description rewritten to cite N-008 and lock the contract.
- `.story/project-state.md` — appended new section "v2.0.0 validation matrix for 1080p60 / 1440p60 / 4K60 (T-009, 2026-05-13)" before the open-issue triage table.
- `.story/handovers/2026-05-13-10-t-009-validation-matrix.md` — this file (created by `storybloq_handover_create`).

No other files in the repo were touched. **Only `.story/` files changed.**

## Source files changed

None. Planning-only session.

---

## Out of scope (deferred — recorded for follow-up)

- **No test files this ticket.** No `*.spec.ts`, no Rust `#[test]`, no `tests/` mutations.
- **No CI changes.**
- **No runner harness.** The scripted-local runner that drives JSON-RPC, captures synthetic loads, runs ffprobe, and asserts is a T-010 implementation task (or split into T-009b if T-010 prefers a clean separation).
- **No synthetic asset binaries.** Specs only.
- **No release execution.** This ticket defines the gate; T-010 runs against it.
- **No Windows hardware in matrix.** W1 is placeholder.
- **No audio gating** for v2.0.0 video-only GA. Audio rows enumerated for the audio milestone.
- **No 4K60 success claim** — acceptance plan only.

---

## What T-009 hands T-010

- The literal release-gate checklist (§24) that T-010 opens with.
- The smoke suite (§22) and RC suite (§23) row order.
- The pass/fail thresholds (§6).
- The diagnostics bundle requirements (§7).
- The synthetic-load specs (§5) for asset creation.
- The ffprobe/mediainfo recipes (§20) for the runner.
- The v1.1.0 vs v2.0.0 comparison protocol (§21) for the release-notes plot.

## Recommended next ticket

**T-010 — v2.0.0 release checklist, validation, packaging, and publish.** Design tickets T-001..T-009 are now complete. T-010 is the last remaining ticket; it consumes N-008 §24 directly and will likely split into:
- T-010a runner harness (drives the JSON-RPC socket, captures synthetic loads, runs ffprobe — required to execute the matrix).
- T-010b synthetic asset creation (per §5 specs).
- T-010c RC execution on M1+M2+M3+M4 + report.
- T-010d packaging audit (`.sha256` sidecars, Linux `.deb` Depends, dependency probe).
- T-010e release publish.

Whether T-010 stays as one ticket or splits is T-010's call; this handover does not pre-decide.

---

## Codex review

**No Codex review needed unless non-`.story` files changed.** Only `.story/` planning artifacts were modified this session.

---

## Storybloq updates

- T-009 status set to `complete` via `storybloq_ticket_update` (`completedDate` recorded by the tool).
- N-008 validation-matrix note created via `storybloq_note_create` (tags: v2, design, validation, test-matrix, release-gate, t-009).
- `project-state.md` appended with the validation matrix summary section before the open-issue triage.
- This handover saved via `storybloq_handover_create`.
