# T-021 MVP Smoke Rerun 14 — VAL-SEG-003 Diagnostics

**Date:** 2026-05-20
**Pass ID:** T-021 rerun 14 / VAL-SEG-003 diagnostics
**Commit tested:** ba9bf15 (Add rolling buffer segment diagnostics)
**Branch:** main
**Evidence directory:** `.story/handovers/evidence/2026-05-20-t-021-mvp-smoke-rerun-14/`

---

## 1. Repo / Commit Tested

```
HEAD: ba9bf15ee1fb42e3a38eeb2f9c443c416e19a602
Log:
ba9bf15 Add rolling buffer segment diagnostics   ← tested
a7aed45 Record MVP smoke rerun 13 evidence
e2d575c Fix VAL-CAP-004 cadence warmup scope
1551587 Handle VAL-CAP-004 variable-rate cadence
a893ba2 Record MVP smoke rerun 11 evidence
b4bdb9f Handle VAL-CAP-004 startup drop warmup
```

Working tree: **clean** (no tracked modifications, no staged changes)
`git diff --check`: exit 0

**Note on untracked files:** Two untracked WIP files (`electron/library.ts`, `src/components/LibraryView.tsx`) appeared mid-session due to an accidental git stash pop of a pre-existing "wip recordings library feature" stash. They were **removed after Codex review round 1** and the final-state evidence (`git-status-final.txt`, `build-sanity.txt`) was re-captured post-cleanup. The final workspace contains only the evidence directory and handover as untracked files; no source files were modified or left behind. The stash remains safe at `stash@{0}`.

---

## 2. Preflight Result

| Check | Result |
|---|---|
| `git status --short` | clean (no tracked/staged changes) |
| `git diff --check` | exit 0 |
| HEAD | ba9bf15 Add rolling buffer segment diagnostics |
| Required commits present | ba9bf15, a7aed45, e2d575c, 1551587 — all confirmed |

All preflight conditions satisfied.

---

## 3. Environment Summary

- **Session:** KDE Wayland
- **Display:** DP-4, 1920x1080@60.00 (mode 11)
- **VRR:** Never
- **GPU:** RTX 4080 SUPER, Driver 595.71.05
- **GPU state before:** 42°C, 16W, 3% util, 3454MiB/16376MiB
- **GPU state after:** 47°C, 16W, 3% util, 3451MiB/16376MiB
- **Portal:** xdg-desktop-portal active, xdg-desktop-portal-kde
- **Stale processes killed before run:** 4 stuck encoder_session test processes (PIDs 35970, 38484, 40778, 43592) from May 19 — cleared ~1 GB NVRAM
- **Stale cove-replay-engine:** none
  - `pgrep-cove-before.txt`: `none` (no engine running pre-run)
  - `pgrep-cove-after.txt`: contains a **known self-match false positive** — the single matching PID is the evidence-collector shell itself, whose argv contains the literal string `pgrep -af cove-replay-engine`. No real `cove-replay-engine` process existed post-run. The file is annotated inline.
- **Stale ffmpeg:** none
- **Host load before:** 2.71, 3.07, 2.11
- **Host load after:** 0.56, 1.56, 1.73
- **Portal selection:** DP-4 selected, Share clicked promptly

---

## 4. Exact Commands Run

**Preflight:**
```bash
git rev-parse HEAD
git status --short --untracked-files=all
git log --oneline -10
git diff --check
```

**Sanity:**
```bash
cargo build -p cove-replay-engine --release        # pass (71 pre-existing NVENC warnings)
cargo test -p cove-replay-engine --test segment_buffer  # 6/6 pass
cargo test -p cove-replay-engine -- --test-threads=1    # 9 pass, 14 transport_integration fail (pre-existing)
npm run typecheck                                   # exit 0
npm run validate:build                             # pass
npm run build                                      # pass
```

**Note on transport_integration failures:** 14 tests fail in `transport_integration` (socket/IPC tests). Confirmed pre-existing by running the same tests on the prior commit — identical 14 failures. Unrelated to the diagnostics patch.

**Display switch:**
```bash
kscreen-doctor output.DP-4.mode.11   # → 1920x1080@60.00
```

**Smoke run:**
```bash
RUST_LOG=info,cove_replay_engine=debug \
  node dist-validation/runner.js smoke \
  > .story/handovers/evidence/2026-05-20-t-021-mvp-smoke-rerun-14/runner-stdout.txt \
  2> .story/handovers/evidence/2026-05-20-t-021-mvp-smoke-rerun-14/runner-stderr.txt
```

**Diagnostic analysis:**
```bash
# Field presence check
head -1 diagnostics-during-save.jsonl | python3 -m json.tool | grep fields

# Full progression
cat diagnostics-during-save.jsonl | python3 -c "import sys,json; ..."
```

---

## 5. Evidence Directory

```
.story/handovers/evidence/2026-05-20-t-021-mvp-smoke-rerun-14/
  preflight-head.txt
  preflight-git-status.txt
  preflight-git-log.txt
  preflight-diff-check.txt
  build-sanity.txt
  display-mode-before.txt
  display-mode-before.json
  display-mode-after-switch.txt
  display-mode-after.txt
  nvidia-smi-before.txt
  nvidia-smi-after.txt
  host-load-before.txt
  host-load-after.txt
  pgrep-cove-before.txt
  pgrep-cove-after.txt
  pgrep-ffmpeg-before.txt
  pgrep-ffmpeg-after.txt
  git-status-final.txt
  runner-stdout.txt
  runner-stderr.txt
  validation-report.json
  smoke-evidence-tree/
    report.json
    VAL-CAP-003/
    VAL-CAP-004/
    VAL-ENC-001/
    VAL-SEG-001/
    VAL-SEG-003/
      diagnostics-during-save.jsonl   ← KEY
      save-response.json
      save-latency.json
      ...
```

---

## 6. VAL-CAP-004 Sanity Verdict

**PASS — GREEN** (unchanged from rerun 13)

```
VAL-CAP-004: pass — Monitor capture passed drop+cadence gates (60 samples, key=1080p60-nvenc)
```

No capture/cadence/NVENC changes in this pass. VAL-CAP-004 remains green.

---

## 7. VAL-SEG-003 Verdict

**FAIL** — `replay.save` returned error: `no committed segments available to pin`

Suite stopped at VAL-SEG-003 (first must-pass red).

---

## 8. Exact replay.save Error

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32600,
    "message": "no committed segments available to pin"
  }
}
```

Save latency: 0.344ms (threshold: 2250ms). The call returned immediately with no committed segments.

---

## 9. New Diagnostic Field Presence

All 5 new fields are present in `diagnostics-during-save.jsonl`:

| Field | Present | First Record Value |
|---|---|---|
| `keyframes_seen` | YES | 1 |
| `duration_eligible` | YES | true |
| `pending_duration_90k` | YES | 104,760,000 |
| `pending_bytes` | YES | 5,481,964 |
| `last_keyframe_age_ms` | YES | 21,023 |

---

## 10. Segment Lifecycle Table

3 diagnostic records collected during the 60-second window.

| Record | fragments_received | segments_committed | keyframes_seen | duration_eligible | pending_duration_90k | last_keyframe_age_ms |
|---|---|---|---|---|---|---|
| 0 | 1,164 | 0 | 1 | true | 104,760,000 | 21,023 |
| 1 | 1,219 | 0 | 1 | true | 109,710,000 | 22,036 |
| 2 | 1,274 | 0 | 1 | true | 114,660,000 | 23,043 |

**Summary:**
- `keyframes_seen` stays at **1** across all records — encoder never emits a second keyframe
- `segments_committed` stays at **0** — commit predicate never fires
- `duration_eligible` stays **true** — duration threshold was met early and stayed exceeded
- `pending_duration_90k` grows continuously — raw 90kHz tick accumulation; duration_eligible=true confirms threshold is exceeded regardless of the exact unit conversion
- `last_keyframe_age_ms` grows steadily — only one keyframe was ever seen, ~21 seconds into the session at first record

---

## 11. H1/H2/H3 Verdict

### H1 CONFIRMED

> **H1: keyframes_seen stays at 1 while pending_duration_90k grows beyond target.**
> Next pass investigates encoder keyframe flag.

Evidence:
1. `keyframes_seen` = 1 at every record — NVENC only set the keyframe flag on the very first fragment
2. `duration_eligible` = true — the duration threshold was surpassed long ago
3. `segments_committed` = 0 — commit predicate `is_keyframe && !pending.is_empty() && duration_eligible` never fires because no second keyframe arrives
4. `pending_duration_90k` = 104,760,000+ and growing — raw 90kHz tick count, with `duration_eligible=true` confirming the threshold is exceeded; no conversion needed for the diagnosis
5. `last_keyframe_age_ms` starts at 21,023ms — the only keyframe was emitted 21 seconds into the recording

H2 and H3 are ruled out:
- H2 (duration_eligible stays false): **ruled out** — duration_eligible is true
- H3 (keyframes_seen > 1, duration_eligible true, but commit doesn't fire): **ruled out** — keyframes_seen never exceeds 1

---

## 12. Evidence Supporting Verdict

The commit predicate in `buffer.rs` is:
```rust
if fragment.is_keyframe && !pending.is_empty() && duration_eligible {
    // commit segment
}
```

After the initial keyframe:
- `seen_first_keyframe` = true (set on first fragment)
- Subsequent fragments enter pending
- Duration accumulates and becomes eligible
- But **only one fragment was ever marked `is_keyframe = true`** across the entire observation window
- → commit predicate never fires → `segments_committed` stays 0

**What the evidence proves:** Exactly one fragment in this session had `fragment.is_keyframe = true`. That is sufficient to explain why VAL-SEG-003 fails — the commit predicate requires a second keyframed fragment which never arrives.

**What the evidence does NOT yet prove:** *Why* only one fragment was marked keyframed. Two distinct hypotheses remain consistent with this signal and must both be ruled in or out by the next pass:

- **H1a (NVENC GOP/IDR config):** NVENC is configured (explicitly or by default) to emit a single IDR at session start and no subsequent I-frames (effectively infinite GOP). Periodic IDRs are never produced by the encoder.
- **H1b (keyframe detection mismarking):** NVENC does emit periodic IDR/I-frames in the bitstream, but the helper's `fragment.is_keyframe` derivation (from NAL unit type or encoder output flags) only flags the very first fragment and fails to flag subsequent IDRs.

Both branches are downstream of the rolling buffer (which is correct given its inputs) and both live in encoder-adjacent code. The next pass MUST inspect the actual bitstream or encoder output flags to distinguish them before committing to a fix.

---

## 13. Does Next Pass Need Encoder Scope?

**YES — H1 requires lifting the NVENC freeze, but the work is encoder-adjacent investigation first, not a presumed config change.**

The next pass scope is the encoder-adjacent area (NVENC backend AND the helper's `fragment.is_keyframe` derivation path). The diagnostic step — inspecting the actual bitstream / NAL unit types from a rerun — is **mandatory** before any code change, because the evidence does not yet distinguish H1a (NVENC emits no periodic IDRs) from H1b (NVENC emits periodic IDRs but `is_keyframe` is mismarked).

Apply a code change only after the diagnostic step rules in one branch:
- **Only if H1a is confirmed** (no periodic IDRs in the bitstream): configure NVENC GOP/keyframe interval (`encodeConfig.gopLength` as a frame count, or periodic `NV_ENC_PIC_FLAG_FORCEIDR`).
- **Only if H1b is confirmed** (IDRs present but unflagged): fix the helper's keyframe-detection / NAL classification path.

The rolling buffer commit logic itself is correct — it just needs correctly-flagged keyframed fragments to arrive.

---

## 14. Confirmation: No Source Files Changed During Rerun

- `helper/**` — unchanged (confirmed: no tracked modifications)
- `validation/**` — unchanged
- `electron/**` — unchanged
- `src/**` — unchanged
- `packaging/**` — unchanged
- `.github/**` — unchanged
- `package.json`, `Cargo.toml`, `Cargo.lock` — unchanged
- VAL-CAP-004 logic/policy — unchanged
- NVENC/encoder files — unchanged

---

## 15. Confirmation: No Validation/Capture/Cadence/NVENC Changes

No changes to validation logic, capture policy, cadence thresholds, or NVENC/encoder files during this rerun. Working tree clean on tracked files throughout.

---

## 16. Recommended Next Phase

### Investigate: Why Only One Fragment Is Marked `is_keyframe`

**Scope:** NVENC encoder backend AND keyframe-detection path — diagnostics show one keyframed fragment, but do not yet identify which of H1a (missing periodic IDRs in the bitstream) or H1b (IDRs present but not flagged on the fragment) is the actual fault. The next pass must distinguish them *before* selecting a code change.

**What the evidence supports:** Exactly one fragment carries `is_keyframe = true`; therefore the rolling-buffer commit predicate cannot fire a second time. The rolling buffer's commit logic is correct given its inputs.

**What the evidence does NOT yet support:** A specific NVENC-config root cause. The handoff previously claimed "NVENC encodes the entire session as a single GOP." That claim is consistent with the data but not proven by it, because the helper's keyframe-detection path is also a viable explanation. Acting on the single-GOP claim alone risks fixing the wrong layer.

**Required diagnostic step (before any code change):**
1. Inspect the actual encoded bitstream from a rerun (dump fragments to disk or log NAL unit types) to determine whether periodic IDR NALs are present.
2. Inspect the helper code path that sets `fragment.is_keyframe` (NAL parsing or encoder-output flag handling) to confirm it would correctly flag subsequent IDRs.

**Fix branches (apply only the one the diagnostic step rules in):**
- **If H1a (no periodic IDRs in the bitstream):** Configure NVENC GOP/keyframe interval — e.g., set `encodeConfig.gopLength` to a *frame count* (NOT a 90 kHz duration; at 60 fps a 2–5 s interval is 120–300 frames), or force periodic IDR via `NV_ENC_PIC_PARAMS.encodePicFlags |= NV_ENC_PIC_FLAG_FORCEIDR` on a wall-clock timer.
- **If H1b (IDRs present, but `is_keyframe` only flags the first one):** Fix the keyframe-detection logic in the helper to correctly classify all IDR/I-frame NAL units (or correctly read the encoder's per-picture keyframe output flag) rather than only the first.

**Both branches require lifting the NVENC encoder freeze** (T-010c was deferred pending VAL-CAP-004 + VAL-SEG-003 resolution). Scope is encoder-adjacent in either case.

**Next steps:**
1. Open a fix pass scoped to: (a) bitstream/NAL inspection to distinguish H1a vs H1b, then (b) the minimal code change in the ruled-in branch.
2. After fix: run smoke rerun 15 to confirm `keyframes_seen` > 1 and `segments_committed` > 0.
3. If VAL-SEG-003 passes: close T-021, proceed to T-010c execution.
