# T-021 MVP Smoke Validation — Rerun Report

**Date:** 2026-05-18
**Ticket:** T-021 — Run MVP smoke validation on helper + Electron; prepare for T-010c
**Repo path:** /home/sin/Projects/cove-screen-recorder
**Branch:** main
**Head commit tested:** `ff0a1d5 Implement HUD timer saving validation row`
**Platform:** Linux (Arch 7.0.8-arch1-1) — Wayland (`WAYLAND_DISPLAY=wayland-0`), X11 bridge (`DISPLAY=:1`), KDE Plasma portal backend
**GPU:** NVIDIA RTX 4080 SUPER (driver 595.71.05)

This rerun supersedes the prior conditional `2026-05-18-t-021-mvp-smoke-validation.md` verdict only as a *progress update*. The old handover is preserved unchanged.

---

## Why this rerun

The prior T-021 pass returned **conditional** because the T-010a scripted-local row drivers were stubs (every scripted-local row skipped with `runner-stub/T-010c`). Between then and now, ten commits landed the row drivers:

```
ff0a1d5  Implement HUD timer saving validation row     (VAL-UI-003)
cad5f0a  Use v2 elapsed clock for active HUD states
b1569b9  Add concurrent export validation driver        (VAL-EXP-012)
1a66c12  Add ffprobe PTS validation drivers             (VAL-EXP-010, VAL-REG-002)
f3f69be  Add export validation driver                   (VAL-EXP-001)
72c6694  Add segment and encoder validation drivers     (VAL-SEG-*, VAL-ENC-001)
54079b5  Add real capture validation driver foundation  (VAL-CAP-004, VAL-CAP-006)
e76002f  Add simulated validation lifecycle drivers
3db5e18  Add synthetic validation loads
a6d1d85  Implement scripted-local validation runner harness
```

Confirmed in-tree:
- `validation/drivers.ts:4630` — `export const NOT_IMPLEMENTED_REASONS: Record<string, string> = {};` (empty — no row is a stub).
- All 12 synthetic loads exist under `validation/loads/` (l-motion-60, l-static, l-change, l-resize, l-minimize, l-portal-deny, l-source-remove, l-comp-pause, l-disk-slow, l-disk-full, l-crash-cap, l-crash-exp).

This rerun re-executes the smoke suite against the now-driver-complete harness.

---

## Preflight

| Check | Result |
|---|---|
| `git status --short --untracked-files=all` (before metadata cleanup) | clean |
| `git log --oneline -10` top commit | `ff0a1d5 Implement HUD timer saving validation row` (matches expected) |
| `git diff --check` | clean |
| `.story/tickets/T-010a.json` | open (target of green verdict) |
| `.story/tickets/T-010b.json` | open → marked complete in this pass (12/12 loads on disk) |
| `.story/tickets/T-020.json` | open → marked complete in this pass (renderer FSM/diagnostics code-complete per prior handover invariant audit) |
| `.story/tickets/T-021.json` | open (this pass) |
| `.story/tickets/T-010c.json` | blocked by T-010a, T-010b, T-021 |
| `validation/runner.ts` | present (440 lines) |
| `validation/drivers.ts` | present (4630 lines, `NOT_IMPLEMENTED_REASONS = {}`) |
| `validation/rows.ts` | present, 20 rows enumerated |
| `validation/loads.ts` | present, launcher helpers wired |
| `src/App.tsx`, `src/v2/clocks.ts`, `src/v2/engine.ts` | present, v2 HUD elapsed wiring verified (`useV2ElapsedMs`, `v2SessionReadyMs`, single `setV2State("RECORDING")` at `src/v2/engine.ts:18`) |

---

## Phase 1 — Metadata cleanup performed

| Ticket | Before | After | Justification |
|---|---|---|---|
| T-020 | open | **complete** | Code-complete per prior T-021 invariant audit (10/10 renderer FSM invariants pass: single RECORDING callsite, no `getDisplayMedia`/`MediaRecorder` in `src/v2/`, recovery/snapshot lifecycle correct, helper-error modal/banner separation correct). Both T-014 (preload/IPC) and T-019 (export MVP) are complete. `cad5f0a` added v2 elapsed clock for HUD active states (Issue #4 absorption surface). Update is metadata-only via `storybloq_ticket_update`. |
| T-010b | open | **complete** | All 12 synthetic loads in `validation/loads/` and `validation/loads.ts` (l-motion-60..l-crash-exp). Update is metadata-only via `storybloq_ticket_update`. |
| T-010a | open | open | Not touched — depends on a green T-021 smoke verdict. This pass is conditional. |
| T-021 | open | open | Not touched — verdict is conditional (see below). |
| T-010c | blocked | blocked | Not touched — remains blocked by T-010a and T-021. |

`git status --short` post-cleanup shows only `.story/tickets/T-010b.json` and `.story/tickets/T-020.json` modified.

---

## Phase 2 — Build / typecheck / build commands

| Command | Result | Log |
|---|---|---|
| `cargo build -p cove-replay-engine --release` | OK (1 cosmetic `unreachable_code` warning in `helper/src/export/mod.rs:102` — pre-existing, unchanged) | `build-test-logs/cargo-build-release.txt` |
| `npm run typecheck` | clean (3 tsconfig targets) | `build-test-logs/npm-typecheck.txt` |
| `npm run build` | clean (Vite + tsc electron) | `build-test-logs/npm-build.txt` |
| `npm run validate` (which runs `validate:build` + `node dist-validation/runner.js smoke`) | suite verdict **PASS** (no must-pass red); 5 pass / 0 fail / 15 skip / 0 error | `build-test-logs/npm-validate-no-helper.txt` |
| `node dist-validation/runner.js row VAL-PKG-001` | skip `helper-not-available` (no external helper started in this pass — invariant prevents claiming `/run/user/1000/cove-screen-recorder/engine.sock`) | `build-test-logs/npm-validate-row-VAL-PKG-001.txt` |

Runner command actually executed: `node dist-validation/runner.js smoke` (the `npm run validate` wrapper). This matches the documented suite entrypoint from T-010a.

---

## Phase 3 — Row-by-row results

Mapping back to T-021's 13-row MVP subset and the full 20-row smoke enumeration in `validation/rows.ts`:

| # | Row ID | Title | Class | Status | Evidence | Skip/Fail reason |
|---|---|---|---|---|---|---|
| 1 | VAL-PKG-001 | coveApi.env.probe()/helper-up gate | scripted-local | **skip** | `row-VAL-PKG-001/report.json` | `helper-not-available` — external helper not started by this pass. The runner-owned-vs-external invariant forbids claiming the global socket path; no external operator process is currently running the Electron supervisor or a standalone helper on the canonical path. Not a product/harness failure. |
| 2 | VAL-CAP-001 | sessionReady event after portal pick | manual | **skip** | — | `manual` — operator-driven; `--ingest` flag not yet implemented (T-010c work). |
| 3 | VAL-CAP-003 | Portal denial emits `sessionLost{portal-denied}` and returns to IDLE | scripted-local | **PASS** | `smoke-run/VAL-CAP-003/{requestSession-response,sessionLost-notification,engine-health,shutdown-response,startStream-response}.json` | Driver spawned a runner-owned helper, called `capture.requestSession`, the portal pipeline produced `capture.sessionLost{reason: "portal-denied"}`, helper returned to IDLE, clean shutdown. |
| 4 | VAL-CAP-004 | 1080p60 monitor capture 60 s — drop & cadence gates | scripted-local | **skip** | `smoke-run/VAL-CAP-004/{env-probe,engine-ready,helper-socket,load-launch}.json` | `helper-not-available` (driver-level): `capture.requestSession` timed out because the xdg-desktop-portal screencast prompt requires an interactive operator click. No user is present in this session to grant the portal. Helper spawned, L-MOTION-60 load launched, env probe passed; the failure is the absent operator, not the harness. Must-pass row for green verdict — deferred. |
| 5 | VAL-CAP-006 | Minimized-window capture 60 s — Issue #3 | manual | **skip** | — | `manual` — requires operator to minimize a window during active capture. |
| 6 | VAL-UI-005 | Region overlay renders correctly — Issue #1 | manual | **skip** | — | `manual` — region mode (T-016) deferred to follow-up; not in MVP scope. |
| 7 | VAL-ENC-001 | NVENC positive probe via `encoder.probeResult` | scripted-local | **skip** | `smoke-run/VAL-ENC-001/{env-probe,engine-ready,helper-socket}.json` | `helper-not-available` (driver-level, same portal-timeout root cause as #4). |
| 8 | VAL-ENC-006 | `encoder.selected` visible in HUD | manual | **skip** | — | `manual` — operator-observed HUD. |
| 9 | VAL-SEG-001 | Rolling 60 s window within disk budget | scripted-local | **skip** | `smoke-run/VAL-SEG-001/` | `helper-not-available` (same portal root cause). |
| 10 | VAL-SEG-003 | `replay.save` within latency gate | scripted-local | **skip** | `smoke-run/VAL-SEG-003/` | `helper-not-available` (same portal root cause). |
| 11 | VAL-EXP-001 | Stream-copy export of 60 s window | scripted-local | **skip** | `smoke-run/VAL-EXP-001/` | `helper-not-available` (same portal root cause). |
| 12 | VAL-EXP-010 | No fake duplicated frames (ffprobe PTS walk) | scripted-local | **skip** | `smoke-run/VAL-EXP-010/` | `helper-not-available` (depends on VAL-EXP-001 output). |
| 13 | VAL-EXP-012 | Export concurrent with RECORDING without capture loss | scripted-local | **skip** | `smoke-run/VAL-EXP-012/` | `helper-not-available` (same portal root cause). |
| 14 | VAL-UI-003 | HUD timer continues ≥ 1 Hz during SAVING — Issue #4 | scripted-local | **skip** | `smoke-run/VAL-UI-003/` | `helper-not-available` (driver requires an active SAVING transition, which requires capture, which requires the portal pick). Driver itself is now wired (per `ff0a1d5`); blocker is the portal pick. |
| 15 | VAL-UI-012 | Hotkey path: `saveReplay` → SAVING → RECORDING | manual | **skip** | — | `manual` — operator-driven hotkey press. |
| 16 | VAL-PROC-001 | No leftover processes after IDLE shutdown | scripted-local | **PASS** | `smoke-run/VAL-PROC-001/` | All processes cleaned up within 5 s after `engine.shutdown`. |
| 17 | VAL-PROC-002 | No leftover processes after `stopSession + shutdown` | scripted-local | **PASS** | `smoke-run/VAL-PROC-002/` | All processes cleaned up within 5 s after `stopSession + shutdown`. |
| 18 | VAL-PROC-003 | No leftover processes after app quit without explicit stop | scripted-local | **PASS** | `smoke-run/VAL-PROC-003/` | All processes cleaned up within 5 s after SIGTERM (no explicit stopSession). |
| 19 | VAL-PROC-007 | `pactl` never spawned by helper or its children | scripted-local | **PASS** | `smoke-run/VAL-PROC-007/` | `ps --ppid <helper>` shows no `pactl` during idle helper lifetime. Full active-capture spot-check deferred (same portal-pick blocker). |
| 20 | VAL-REG-002 | Fake-60 fps gate re-run on VAL-EXP-001 output | scripted-local | **skip** | `smoke-run/VAL-REG-002/` | `helper-not-available` — depends on VAL-EXP-001 producing an MP4. |

### Summary

| Bucket | Count | Notes |
|---|---|---|
| `pass` | 5 | VAL-CAP-003, VAL-PROC-001, VAL-PROC-002, VAL-PROC-003, VAL-PROC-007 |
| `skip` — scripted-local with env limit | 9 | VAL-CAP-004, VAL-ENC-001, VAL-SEG-001, VAL-SEG-003, VAL-EXP-001, VAL-EXP-010, VAL-EXP-012, VAL-UI-003, VAL-REG-002 — *all* blocked on the same root cause: the xdg-desktop-portal screencast prompt has no operator to grant it in this non-interactive session |
| `skip` — scripted-local awaiting external helper | 1 | VAL-PKG-001 — needs an externally-running helper (Electron supervisor or standalone) on the canonical socket. Invariant forbids this pass from claiming that path. |
| `skip` — manual | 5 | VAL-CAP-001, VAL-CAP-006, VAL-UI-005, VAL-ENC-006, VAL-UI-012 |
| `fail` | 0 | — |
| `error` | 0 | — |

Suite verdict from runner: `PASS` (no must-pass red; smoke contract per N-008 §22 is "stop on first must-pass red" — there were none). The runner's `PASS` verdict is not by itself a "Ready for T-010c green"; it only certifies that nothing failed actively.

---

## Environment summary

| Probe field | Value |
|---|---|
| `display` | `:1` |
| `waylandDisplay` | `wayland-0` |
| `xdgRuntimeDir` | `/run/user/1000` |
| `portalRunning` | `true` (xdg-desktop-portal + xdg-desktop-portal-kde + xdg-desktop-portal-gtk live) |
| `gpuInfo` | `nvidia: NVIDIA GeForce RTX 4080 SUPER, 595.71.05` |
| Interactive operator present | **NO** — this session has no human to click "Share screen" in the picker |

Captured per-row at `smoke-run/<ROW>/env-probe.json`.

---

## Helper / Electron launch method

| Path | Method | Used here? |
|---|---|---|
| Path A — Electron supervisor (spawns helper as a managed child) | run `npm run dev` / start built Electron app, supervisor spawns helper | **NO** — not exercised; requires interactive desktop session for capture rows and is out of scope for this rerun (deferred to T-010c). |
| Path B — Standalone helper on canonical socket | `./target/release/cove-replay-engine --ipc-socket /run/user/1000/cove-screen-recorder/engine.sock` | **NO** — refused by invariant "Existing external helper sockets must not be killed or claimed." There is a stale `engine.sock.lock` from 2026-05-17 in that directory; cleaning or claiming it is out of scope. |
| Path C — Runner-owned helper on runner-owned socket | The validation runner spawns its own helper per row using `runner-<rand>.sock` paths under `$XDG_RUNTIME_DIR/cove-screen-recorder/`. | **YES** — used by every passing scripted-local row in this pass (VAL-CAP-003, VAL-PROC-001/002/003/007) and attempted by every skipped scripted-local row that requires capture (VAL-CAP-004, VAL-ENC-001, etc.) where the helper spawned successfully but `capture.requestSession` timed out waiting for an operator. |

---

## Manual checks

T-021 names four operator-relevant checks (Issue #3 absorption / VAL-CAP-006, Issue #4 / VAL-UI-003, portal denial confirmation / VAL-CAP-003, hotkey path / VAL-UI-012). Their classification in `validation/rows.ts` and disposition in this rerun:

- **VAL-CAP-003 (portal denial)** — classification: `scripted-local`. PASSED automatically. No additional operator confirmation required.
- **VAL-CAP-006 (Issue #3 minimize)** — classification: `manual`. NOT run — requires operator to minimize a window for 60 s mid-capture. Not faked.
- **VAL-UI-003 (Issue #4 HUD during SAVING)** — classification: `scripted-local` (driver landed in `ff0a1d5`). Row is the source of record; in this rerun it skipped `helper-not-available` because the upstream portal pick failed. Supplemental visual cross-check against a live UI was NOT performed (no interactive desktop). Recorded as not-run with explicit reason; the scripted row will carry the verdict once an operator can grant the portal.
- **VAL-UI-012 (hotkey path)** — classification: `manual`. NOT run — requires operator hotkey press during a RECORDING state we cannot enter without an operator at the portal.

No fake results recorded.

---

## Process cleanup result (post-run)

```
$ pgrep -u $UID 'cove-replay-engine|ffmpeg|pactl'
# (no output)
```

No leaked `cove-replay-engine`, `ffmpeg`, or `pactl` processes after the smoke run completed. The runner's per-row helper spawning is matched by `engine.shutdown` / SIGTERM teardown.

---

## Ready for T-010c verdict

**Ready for T-010c: CONDITIONAL.**

### Why not green

T-021's must-pass set (rows 4–10, 13–14 in the T-021 subset list — 1080p60 capture, NVENC probe, save+export, no-fake-dup-frames, concurrent export, HUD during SAVING) cannot be exercised end-to-end in this non-interactive session because every one of them blocks on the xdg-desktop-portal screencast prompt waiting for an operator to pick a source. The harness is now driver-complete (T-010a scripted-local 15/15 wired); the gap is the operator's absence at the portal, not the code.

### Why not red

- Zero product failures observed.
- Zero harness failures observed.
- Zero process leaks.
- Zero unexpected event surfaces.
- The 5 passing rows exercise the helper lifecycle / portal-denial / process-cleanup spine end-to-end with real evidence.
- All skipped scripted-local rows skip with structured, accurate `helper-not-available` messages distinguishing environment skip from product failure.
- Every driver that could run, did run, up to the portal-grant gate.

### Exact remaining blockers for green / T-010c gate

1. **An interactive operator session on M1** that can grant the xdg-desktop-portal screencast prompt for each capture row. This unblocks: VAL-CAP-004, VAL-ENC-001, VAL-SEG-001, VAL-SEG-003, VAL-EXP-001, VAL-EXP-010, VAL-EXP-012, VAL-UI-003, VAL-REG-002. (All same root cause.)
2. **An external helper on the canonical socket** (Electron supervisor or `./target/release/cove-replay-engine --ipc-socket .../engine.sock`) for VAL-PKG-001. The invariant prevents this pass from doing it; an operator can.
3. **Operator-driven manual rows** for VAL-CAP-001, VAL-CAP-006, VAL-UI-005, VAL-ENC-006, VAL-UI-012, and the visual cross-check on VAL-UI-003. These remain manual until T-010a's `--ingest` flag lands (T-010c work).

### Status decisions

| Ticket | Decision | Rationale |
|---|---|---|
| T-021 | **stay open** | Conditional verdict, not green. |
| T-010a | **stay open** | Conditional verdict on T-021, not green; cannot be completed off a conditional pass. |
| T-010b | **mark complete** (this pass) | Metadata cleanup — 12/12 loads code-complete on disk. |
| T-020 | **mark complete** (this pass) | Metadata cleanup — code-complete, invariants verified. |
| T-010c | **stay blocked** | Still blocked by T-010a and T-021. No execution attempted. |

### Issues filed

None. Zero defects were discovered in product or harness during this rerun.

---

## Allowed files actually touched

- `.story/tickets/T-020.json` — status → complete
- `.story/tickets/T-010b.json` — status → complete
- `.story/handovers/2026-05-18-t-021-mvp-smoke-rerun.md` — this file (new)
- `.story/handovers/evidence/2026-05-18-t-021-mvp-smoke-rerun/**` — evidence bundle (new)

No file under `validation/`, `electron/`, `helper/`, `src/`, `packaging/`, GitHub Actions, `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, release artifacts, or old `.story/handovers/*.md` files was edited. No issue file was created (no defects).

---

## Out of scope (confirmed not done)

- No code patches.
- No validation harness patches.
- No product fixes.
- No helper fixes.
- No Electron supervisor fixes.
- No release/packaging work.
- No screenshots/release notes.
- No T-010c execution.
- No broad retroactive Storybloq rewrite (only T-020 and T-010b metadata-only updates).
- No edits to old handovers.
- No v1.1.0 legacy MediaRecorder/recorder-client paths touched.
- No external helper claimed on the canonical socket path.
- No `.skip`/temp instrumentation added or removed.

---

## Codex review focus

1. No source/harness/product files were changed in this pass.
2. Only allowed `.story` metadata (T-020, T-010b status), new handover, new evidence directory changed. No issues filed because no defects were observed.
3. T-020 and T-010b metadata cleanup is justified and minimal: T-020 code-complete per prior T-021 invariant audit + new HUD elapsed-clock commit (`cad5f0a`); T-010b code-complete via 12 loads on disk + `loads.ts`.
4. T-010a and T-021 were **NOT** marked complete because the verdict is conditional (interactive operator absent for portal-pick rows). The user's contract requires "explicit Storybloq allowance" before completing under conditional, which was not invoked.
5. Existing handovers were not edited.
6. Row-by-row summary matches evidence files in `.story/handovers/evidence/2026-05-18-t-021-mvp-smoke-rerun/`.
7. Environment skips (portal-timeout, helper-not-available) are NOT presented as product passes. Five real passes are clearly named.
8. Zero product failures → zero issues filed → zero patches. Faithful to "execution/evidence pass, not implementation pass."
9. The Ready for T-010c verdict (`conditional`) is supported by the evidence: must-pass capture rows could not be driven through the portal-pick step from this session.
10. No T-010c execution attempted.
11. No release/packaging/GitHub Actions work was done.
12. No v1.1.0 legacy path was removed or modified.
