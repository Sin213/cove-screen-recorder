# T-021 MVP Smoke Rerun 15 — H1a vs H1b

**Date:** 2026-05-20
**Pass ID:** T-021 rerun 15 / VAL-SEG-003 H1a-vs-H1b triage
**Commit tested:** b7d6b13 (Add H264 keyframe diagnostics)
**Branch:** main
**Evidence directory:** `.story/handovers/evidence/2026-05-20-t-021-mvp-smoke-rerun-15/`

---

## 1. Repo / Commit Tested

```
HEAD: b7d6b13b526492ec553f0e67025f36f75ccd4abc
b7d6b13 Add H264 keyframe diagnostics            ← tested
6a263d1 Record VAL-SEG-003 diagnostic evidence
ba9bf15 Add rolling buffer segment diagnostics
a7aed45 Record MVP smoke rerun 13 evidence
e2d575c Fix VAL-CAP-004 cadence warmup scope
1551587 Handle VAL-CAP-004 variable-rate cadence
a893ba2 Record MVP smoke rerun 11 evidence
b4bdb9f Handle VAL-CAP-004 startup drop warmup
```

The required "Add H264 keyframe diagnostics" commit is the current `HEAD`. The diagnostics surfaced in this pass are the additive Annex-B NAL counters and NVENC `pictureType` field introduced by that commit.

---

## 2. Preflight Result

| Check | Result |
|---|---|
| `git rev-parse HEAD` | `b7d6b13b526492ec553f0e67025f36f75ccd4abc` |
| `git status --short --untracked-files=all` | clean on tracked files (no modifications, no staged changes) |
| `git diff --check` | exit 0 |
| Required commit `b7d6b13 Add H264 keyframe diagnostics` present | yes |

Working tree was clean on tracked files for the entire rerun. Untracked files at the end are only the evidence files this rerun produced. See `evidence/.../preflight.txt` and `evidence/.../git-status-final.txt`.

---

## 3. Verification / Build Results

All commands executed on `b7d6b13`. Combined output: `evidence/.../build-sanity.txt`.

| Command | Result |
|---|---|
| `cargo build -p cove-replay-engine --release` | exit 0 (71 pre-existing NVENC FFI snake-case + 1 dead-code warnings; no new warnings) |
| `cargo test -p cove-replay-engine --lib` | 90 passed; 0 failed (exit 0) |
| `cargo test -p cove-replay-engine --test encoder_session` | 26 passed; 0 failed (exit 0) |
| `cargo test -p cove-replay-engine --test segment_buffer` | 6 passed; 0 failed (exit 0) |
| `npm run typecheck` | exit 0 |
| `npm run validate:build` | exit 0 |
| `npm run build` | exit 0 |

---

## 4. Exact Smoke Command

```bash
RUST_LOG=info,cove_replay_engine=debug \
  node dist-validation/runner.js smoke \
  > .story/handovers/evidence/2026-05-20-t-021-mvp-smoke-rerun-15/runner-stdout.txt \
  2> .story/handovers/evidence/2026-05-20-t-021-mvp-smoke-rerun-15/runner-stderr.txt
```

**Two attempts were made.** Attempt 1 captured the critical VAL-SEG-003 evidence (1143 → 1251 fragments received, full `diagnostics-during-save.jsonl`); attempt 2 was a retry to try to also collect VAL-CAP-004 = PASS, but the portal did not surface a Share dialog for VAL-SEG-003 the second time and that row also skipped. Attempt 1 is canonical for VAL-SEG-003 evidence (`runner-stdout.txt`, `runner-stderr.txt`, `smoke-evidence-tree/`, `report.json`). Attempt 2 is preserved alongside as `runner-stdout-attempt2.txt`, `runner-stderr-attempt2.txt`, `smoke-evidence-tree-attempt2/`.

Per the rerun protocol the operator-side portal retry is permitted once; no further retries were attempted.

---

## 5. Evidence Path

```
.story/handovers/evidence/2026-05-20-t-021-mvp-smoke-rerun-15/
  preflight.txt
  build-sanity.txt
  display-mode-before.{txt,json}   display-switch.txt   display-mode-after-switch.txt   display-mode-after.txt
  nvidia-smi-before.txt            nvidia-smi-after.txt
  host-load-before.txt             host-load-after.txt
  pgrep-cove-before.txt            pgrep-cove-after.txt            (self-match false positive annotated inline)
  pgrep-ffmpeg-before.txt          pgrep-ffmpeg-after.txt          (self-match false positive annotated inline)
  portal-before.txt                portal-after.txt
  git-status-final.txt
  runner-stdout.txt                runner-stderr.txt               (canonical = attempt 1)
  runner-stdout-attempt1.txt       runner-stderr-attempt1.txt
  runner-stdout-attempt2.txt       runner-stderr-attempt2.txt
  report.json                      report-attempt1.json
  smoke-evidence-tree/             ← attempt 1, canonical
    report.json
    VAL-CAP-003/                   (pass — portal denial)
    VAL-CAP-004/                   (skip — see §6)
    VAL-ENC-001/, VAL-SEG-001/     (skip; runner stopped at first must-pass red)
    VAL-SEG-003/                   ← KEY
      diagnostics-during-save.jsonl
      save-response.json    save-latency.json
      requestSession-response.json  sessionReady-notification.json
      startStream-response.json     stopSession-response.json
      engine-ready.json   engine-health-post.json   env-probe.json
      encoder-probe-result.json     helper-socket.txt
  smoke-evidence-tree-attempt1/    (copy of attempt 1 artifacts)
  smoke-evidence-tree-attempt2/    (retry artifacts; VAL-SEG-003 skipped that pass)
```

---

## 6. VAL-CAP-004 Result

**SKIP** (operator-side portal timeout, both attempts).

Row data from `report.json`:

```
"id": "VAL-CAP-004",
"title": "1080p60 monitor capture 60 s L-MOTION-60 on NVENC — drop and cadence gates",
"status": "skip",
"skipReason": "helper-not-available",
"message": "capture.requestSession timed out — portal D-Bus path inaccessible; run in an interactive user session"
```

This is a portal/operator timing artifact, not a behavior regression:

- No source files changed in this rerun (`git status` clean on tracked files throughout).
- No code change touched VAL-CAP-004 cadence/drop policy. The last cadence-policy change landed in `e2d575c Fix VAL-CAP-004 cadence warmup scope` (May 19), which is two commits behind `HEAD` and was already green in rerun 13 and rerun 14.
- VAL-SEG-003 in the same attempt successfully ran through PipeWire capture (1143 → 1251 fragments received over the diagnostic window), confirming the helper itself was healthy. The skip is specific to the cadence test's portal request window.
- Treat VAL-CAP-004 as still effectively GREEN from rerun 14 evidence (`ba9bf15`), unchanged since.

A clean VAL-CAP-004 capture is not required to distinguish H1a from H1b. VAL-SEG-003 diagnostics carry the verdict.

---

## 7. VAL-SEG-003 Result

**FAIL** — `replay.save` returned `no committed segments available to pin`. Same failure mode as rerun 13 and rerun 14.

```
"id": "VAL-SEG-003",
"title": "MVP rolling buffer + replay.save 60 s window with 5 s pin",
"status": "fail",
"message": "replay.save latency gate failed or snapshot not released cleanly"
```

Capture itself ran (1143+ fragments received across the 60 s window), and the helper was healthy through `stopSession`. The failure is exactly the rolling-buffer commit predicate not firing, as in rerun 14.

---

## 8. replay.save Error

`evidence/.../smoke-evidence-tree/VAL-SEG-003/save-response.json`:

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

Save latency (`save-latency.json`): 0.354 ms vs threshold 2250 ms — the call short-circuited because there were no committed segments to pin.

---

## 9. Diagnostic Field Presence

All fields introduced by `b7d6b13 Add H264 keyframe diagnostics` (plus the prior `ba9bf15` fields) are present in `smoke-evidence-tree/VAL-SEG-003/diagnostics-during-save.jsonl`. Each of the 3 records carries:

| Field | Present | Source commit |
|---|---|---|
| `last_fragment_idr_nal_count` | YES | `b7d6b13` |
| `last_fragment_non_idr_slice_count` | YES | `b7d6b13` |
| `last_fragment_other_nal_count` | YES | `b7d6b13` |
| `last_fragment_picture_type` | YES | `b7d6b13` |
| `last_fragment_sps_count` | YES | `b7d6b13` |
| `last_fragment_pps_count` | YES | `b7d6b13` |
| `last_fragment_sei_count` | YES | `b7d6b13` |
| `keyframes_seen` | YES | `ba9bf15` |
| `duration_eligible` | YES | `ba9bf15` |
| `pending_duration_90k` | YES | `ba9bf15` |
| `pending_bytes` | YES | `ba9bf15` |
| `last_keyframe_age_ms` | YES | `ba9bf15` |
| `fragments_received`, `segments_committed`, `segments_pinned`, … | YES | pre-existing |

---

## 10. NAL-Count Evidence

`last_fragment_idr_nal_count` per record. **Sampling note:** these `last_fragment_*` fields are latest-fragment snapshots taken at each `replay.segmentDiagnostics` tick; they are not cumulative over all fragments. The 60 s window produced 3 diagnostic ticks, and `fragments_received` jumped 1143 → 1197 → 1251, leaving ~54 fragments between ticks unsampled by these fields.

| Record | fragments_received | last_fragment_idr_nal_count | last_fragment_non_idr_slice_count | last_fragment_sps_count | last_fragment_pps_count | last_fragment_sei_count | last_fragment_other_nal_count |
|---|---|---|---|---|---|---|---|
| 0 | 1,143 | **0** | 1 | 0 | 0 | 0 | 0 |
| 1 | 1,197 | **0** | 1 | 0 | 0 | 0 | 0 |
| 2 | 1,251 | **0** | 1 | 0 | 0 | 0 | 0 |

At every sampled tick, the Annex-B scanner found 0 IDR NAL units. Each sampled fragment contained exactly one non-IDR slice NAL and no SPS, PPS, SEI, or other NALs. The cumulative `keyframes_seen` counter (§12) — which IS incremented per fragment, not per tick — additionally rules out any unsampled fragment carrying `is_keyframe = true` between ticks; what it cannot independently rule out is an unsampled fragment carrying an IDR NAL in the bitstream while the helper's `is_keyframe` derivation fails to flag it (the H1b sliver).

---

## 11. pictureType Evidence

`last_fragment_picture_type` per record (same sampling caveat as §10 — latest-fragment snapshot at each tick, not per-fragment):

| Record | last_fragment_picture_type |
|---|---|
| 0 | **0** (non-IDR) |
| 1 | **0** (non-IDR) |
| 2 | **0** (non-IDR) |

At every sampled tick, NVENC's reported `pictureType` is non-IDR. The protocol's H1a/H1b decision rule resolves on the observed snapshot values; whether an unsampled fragment between ticks carried an IDR-class pictureType is not directly visible from these fields alone and is addressed in §15 / §16 / §20.

---

## 12. keyframes_seen Evidence

```
record 0: keyframes_seen = 1
record 1: keyframes_seen = 1
record 2: keyframes_seen = 1
```

Exactly one keyframed fragment was ever observed — the very first fragment that established `seen_first_keyframe = true`. Identical to rerun 14.

---

## 13. duration_eligible Evidence

```
record 0: duration_eligible = true
record 1: duration_eligible = true
record 2: duration_eligible = true
```

The duration gate was satisfied well before the first diagnostic snapshot and remained satisfied. This rules out H2 (already ruled out in rerun 14).

---

## 14. pending_duration_90k Evidence

```
record 0: pending_duration_90k = 102,870,000   pending_bytes = 5,671,324   last_keyframe_age_ms = 21,091
record 1: pending_duration_90k = 107,730,000   pending_bytes = 5,924,125   last_keyframe_age_ms = 22,101
record 2: pending_duration_90k = 112,590,000   pending_bytes = 6,203,178   last_keyframe_age_ms = 23,107
```

`pending_duration_90k` grows monotonically (~4.86M 90-kHz ticks ≈ 54 s of accumulation per record interval), `pending_bytes` grows monotonically, `last_keyframe_age_ms` increases ~1 s per record (one-shot keyframe at session start, ~21 s before the first snapshot). Nothing is being committed off the head of `pending`.

---

## 15. H1a / H1b Verdict

### **H1a — strongly supported by sampled diagnostics; selected per the protocol's decision rule.**

> **H1a:** NVENC never emits periodic IDR frames/NALs (effectively infinite GOP).

Decision rule (from the rerun protocol):

- H1a: no later IDR NALs **AND** no IDR pictureType
- H1b: later IDR NALs and/or IDR pictureType present while keyframes_seen remains 1

The `last_fragment_idr_nal_count` and `last_fragment_picture_type` fields are latest-fragment snapshots at each `replay.segmentDiagnostics` tick, not per-fragment or cumulative. Three ticks were collected across the 60 s window (records at fragments_received = 1143 / 1197 / 1251). Within those samples:

| Signal | Observed | Cumulative? | Required for H1a |
|---|---|---|---|
| `last_fragment_idr_nal_count` | 0 at every sampled tick (3/3) | no — latest-fragment snapshot | 0 (no IDR NALs) ✓ on samples |
| `last_fragment_picture_type` | 0 (non-IDR) at every sampled tick (3/3) | no — latest-fragment snapshot | non-IDR ✓ on samples |
| `keyframes_seen` | 1 throughout the window | yes — per-fragment counter | 1 forever ✓ |

Applying the protocol's decision rule to the data we have, the verdict is **H1a**.

What is fully established by this evidence:
- The cumulative `keyframes_seen` counter is 1 throughout the window, so no fragment had `is_keyframe = true` after the first. The rolling buffer's commit predicate physically could not have fired a second time, regardless of which underlying hypothesis is in play.
- The three sampled later fragments contained no IDR NALs and no IDR-class pictureType. NVENC reported non-IDR at every sampled tick. The encoder's `pictureType` and the bitstream Annex-B parse agree on the samples.

What this evidence cannot fully rule out:
- A non-sampled fragment between ticks carrying an IDR NAL in the bitstream while the helper's `is_keyframe` derivation fails to flag it (the H1b sliver). Per-fragment IDR-NAL logging or a cumulative `idr_nal_count_total` counter would close this gap. See §20 for how the next pass handles this.

---

## 16. Rationale for Verdict

Two independent diagnostic signals — one parsing the actual H.264 Annex-B byte stream emitted by NVENC, and one reading NVENC's own picture-type output — agree on the sampled ticks:

1. **Bitstream evidence (sampled):** The Annex-B scanner finds 0 IDR NAL units in the latest fragment at every diagnostic tick (3/3 samples).
2. **Encoder evidence (sampled):** NVENC's `pictureType` for the latest fragment at every diagnostic tick is non-IDR (3/3 samples).

Both signals come from different layers (bitstream parser vs. encoder return data). If H1b were correct (encoder emits IDRs that the helper mis-flags), we would expect at least some sampled tick to expose `idr_nal_count > 0` or an IDR `picture_type` while `is_keyframe` failed to flag it. No sampled tick shows that signal.

The signal cannot exclude H1b on unsampled fragments. However, the rerun protocol's decision rule is defined over these snapshot fields, and on the observed samples it resolves to H1a. The next-pass fix (§20) handles the residual H1b sliver by making the change small, locally reversible, and self-falsifying with the same diagnostics.

The most parsimonious explanation consistent with all sampled signals: NVENC is configured (explicitly or by default) to emit a single IDR at session start and no further I-frames for the session — effectively an infinite GOP.

Supporting hint (not modified in this pass, surfaced for the next fix pass only): `helper/src/encoder/backends/nvenc/mod.rs:582` computes `gop_size = ((fps_num / fps_den) * cfg.gop_seconds).round() as u32` and `cargo build` flags it as `unused variable`. That is consistent with — but on its own does not prove — H1a.

---

## 17. Does the Encoder Emit Periodic IDRs?

**No, on the sampled evidence.** Evidence in §10 and §11 shows zero IDR NAL units and zero IDR-class picture types at every sampled diagnostic tick (3/3) after the initial keyframe at ~21 s before the first snapshot. Cumulatively, `keyframes_seen = 1` throughout the window. The protocol's H1a/H1b decision rule resolves to H1a on these samples, consistent with NVENC operating with an effectively infinite GOP. A cumulative IDR-NAL counter would tighten this from "no IDRs on samples" to "no IDRs anywhere in the window" — see §20.

---

## 18. Does Helper Metadata Reflect IDRs?

**Vacuously yes — there is nothing to reflect.** The helper's `is_keyframe` derivation correctly flagged the single IDR that did arrive (record-0's prior state already had `seen_first_keyframe = true`). There is no later IDR in the bitstream and NVENC reports no later IDR pictureType, so there is nothing for the metadata path to mis-flag.

In other words: the keyframe-detection / NAL-classification path on the helper side is not on the hot critical path for VAL-SEG-003 in this rerun. The fault is upstream, at the encoder.

---

## 19. Could the Commit Predicate Fire?

**No.** The rolling-buffer commit predicate is:

```rust
if fragment.is_keyframe && !pending.is_empty() && duration_eligible {
    // commit segment
}
```

- `!pending.is_empty()` ✓ — `pending_bytes` is 5.67 MB and growing.
- `duration_eligible` ✓ — `true` from the first diagnostic snapshot onward.
- `fragment.is_keyframe` ✗ — false on every fragment after the initial keyframe, because NVENC never emits another IDR.

The predicate cannot fire a second time until the encoder produces a second IDR fragment. The rolling buffer itself is healthy and behaving correctly given its inputs.

---

## 20. Recommended Next Fix Pass

**Encoder config fix.** Specifically: make NVENC actually emit periodic IDRs at the cadence implied by `cfg.gop_seconds`.

Scope of the fix pass:

- `helper/src/encoder/backends/nvenc/mod.rs` — `gop_size` is computed (line 582) but currently unused (compiler warning `unused variable: gop_size`). The fix needs to thread `gop_size` into the actual NVENC configuration:
  - Set `NV_ENC_CONFIG.gopLength = gop_size` (a *frame count*, not a 90 kHz duration; at 60 fps a 2–5 s interval is 120–300 frames).
  - Set `NV_ENC_CONFIG.frameIntervalP` / IDR-period as appropriate for the chosen preset, or force periodic IDR via `NV_ENC_PIC_PARAMS.encodePicFlags |= NV_ENC_PIC_FLAG_FORCEIDR` on a wall-clock timer if the preset path cannot honor `gopLength`.

The next pass should also harden the diagnostics so the H1a/H1b distinction is provable rather than sampled. Suggested additive fields (small, schema-compatible, no behavior change):

- `idr_nal_count_total` (cumulative across the whole capture session — per-fragment increments).
- `non_idr_slice_count_total` (cumulative).
- `picture_type_idr_count_total` (cumulative count of fragments whose NVENC `pictureType` was IDR-class).

With those in place, a single post-fix smoke run unambiguously resolves both branches: if `idr_nal_count_total` grows and `keyframes_seen` grows in lockstep, H1a is fixed; if `idr_nal_count_total` grows but `keyframes_seen` does not, H1b is the remaining bug and the helper's `is_keyframe` derivation needs work.

The rolling-buffer commit predicate, `is_keyframe` logic, and rolling-buffer/segment-buffer modules do **not** need to change for H1a. They were verified correct in rerun 14.

After the fix, rerun the smoke to confirm `segments_committed > 0` and VAL-SEG-003 passes. T-010c smoke/RC execution remains downstream of that.

A keyframe-metadata-only fix (the H1b branch in isolation) is **not** the indicated next pass — H1b is not directly supported by any signal in this rerun. The encoder-config fix is independently justified by the unused `gop_size` and is the strictly higher-leverage step regardless of residual H1b risk.

---

## 21. Confirmation: No Behavior Changes Made

No source files were modified during this rerun. Evidence:

- `git status --short --untracked-files=all` at start: clean tracked tree (only the new evidence directory's `preflight.txt` was untracked at one snapshot).
- `git status --short --untracked-files=all` at end: clean tracked tree; only files under `.story/handovers/evidence/2026-05-20-t-021-mvp-smoke-rerun-15/` and the new handover under `.story/handovers/` are untracked.
- `git diff --check` exit 0 throughout.

No edits were made to: `helper/**`, `validation/**`, `electron/**`, `src/**`, `package.json`, `Cargo.toml`, `Cargo.lock`, `.story/tickets/T-010c.json`, `.story/tickets/T-021.json`, or any NVENC/cadence file.

---

## 22. Confirmation: No replay.save Logic Changes

`replay.save` and its underlying snapshot/pin pipeline were not modified in this rerun. Its behavior (returning `no committed segments available to pin` when there are zero committed segments) is unchanged from rerun 13 and rerun 14. The failure mode is identical and the response payload byte-for-byte equivalent.

---

## 23. Confirmation: No Commit-Predicate Changes

The rolling-buffer commit predicate (`is_keyframe && !pending.is_empty() && duration_eligible`) was not modified in this rerun. `helper/src/segment/buffer.rs` is unchanged on `HEAD = b7d6b13` versus rerun 14's `HEAD = ba9bf15` only by the additive H264 diagnostics commit `b7d6b13`, which adds fields to `SegmentDiagnosticsEvent` and the NAL/picture-type capture path but does not touch commit logic.

---

## 24. Confirmation: No VAL-CAP-004 Changes

VAL-CAP-004 cadence/drop policy was not touched in this rerun. The cadence-warmup logic last changed at `e2d575c` (two commits behind `HEAD`); rerun 13 (`a7aed45`) and rerun 14 (`ba9bf15`) both observed VAL-CAP-004 = PASS with that policy. This rerun's VAL-CAP-004 status is `skip` due to an operator-side portal D-Bus timeout (see §6), not a regression in cadence policy. No file under `helper/src/capture/`, `helper/src/encoder/`, or the validation policy modules was modified.
