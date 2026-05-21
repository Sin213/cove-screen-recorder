# T-021 MVP Smoke Rerun 18 — VAL-EXP-001 ffmpeg Diagnostics Evidence

**Date:** 2026-05-21
**Pass ID:** T-021 MVP smoke rerun 18 / VAL-EXP-001 ffmpeg diagnostics
**Purpose:** Evidence-only smoke rerun to capture real ffmpeg stderr/input diagnostics for VAL-EXP-001. No source/validation/policy changes during rerun.

---

## 1. Repo / Commit Tested

- **Repo:** /home/sin/Projects/cove-screen-recorder
- **HEAD:** `0961e264dbc95d03ba1812623f48460152ee04f2`
- **Commit message:** Capture ffmpeg export diagnostics
- **Branch:** main
- **Working tree:** clean (before and after rerun)

Recent history (matches expected):
- `0961e26 Capture ffmpeg export diagnostics`
- `f851dbc Record MVP smoke rerun 17 evidence`
- `0f6f702 Record MVP smoke rerun 16 evidence`
- `8c7bc47 Force periodic NVENC IDR frames`
- `50b681a Record H264 keyframe diagnostic evidence`

## 2. Preflight Result

- `git status --short --untracked-files=all`: CLEAN
- `git diff --check`: CLEAN
- `git log --oneline -10`: matches expected
- `pgrep cove-replay-engine`: none stale
- `pgrep ffmpeg`: none stale

## 3. Display / Environment Summary

- OS: Linux 6.18.32-1-lts
- GPU: NVIDIA GeForce RTX 4080 SUPER, driver 595.71.05
- Display before: DP-4 mode 2 (3840x2160@239.99) — incorrect for smoke
- Action: `kscreen-doctor output.DP-4.mode.11`
- Display after: DP-4 mode 11 (1920x1080@60.00), VRR Never
- Portal: running, Share clicked on DP-4

## 4. Exact Commands Run

```
git rev-parse HEAD
git status --short --untracked-files=all
git log --oneline -10
git diff --check

cargo build -p cove-replay-engine --release      # PASS
cargo test  -p cove-replay-engine --lib          # 90 passed
cargo test  -p cove-replay-engine --test encoder_session   # 27 passed
cargo test  -p cove-replay-engine --test segment_buffer    # 7 passed
npm run typecheck                                # PASS
npm run validate:build                           # PASS
npm run build                                    # PASS

kscreen-doctor -o                                # preflight
kscreen-doctor output.DP-4.mode.11               # set 1080p60
kscreen-doctor -o                                # confirm
nvidia-smi
pgrep -af cove-replay-engine
pgrep -af ffmpeg

RUST_LOG=info,cove_replay_engine=debug \
  node dist-validation/runner.js smoke \
  > .story/handovers/evidence/2026-05-20-t-021-mvp-smoke-rerun-18/runner-stdout.txt \
  2> .story/handovers/evidence/2026-05-20-t-021-mvp-smoke-rerun-18/runner-stderr.txt
```

## 5. Evidence Directory

`.story/handovers/evidence/2026-05-20-t-021-mvp-smoke-rerun-18/`

Contents:
- `runner-stdout.txt`, `runner-stderr.txt`
- `preflight-kscreen-o.txt`, `preflight-kscreen-j.json`
- `preflight-kscreen-o-after.txt`, `preflight-kscreen-j-after.json`
- `display-change.txt`
- `preflight-nvidia-smi.txt`, `preflight-pgrep-engine.txt`, `preflight-pgrep-ffmpeg.txt`
- `preflight-sanity.txt`
- `post-kscreen-o.txt`, `post-kscreen-j.json`, `post-nvidia-smi.txt`
- `post-pgrep-engine.txt`, `post-pgrep-ffmpeg.txt`, `post-load.txt`
- `validation-report-smoke-1779348808188.json`
- `smoke-evidence-tree/2026-05-21T07-29-16-246Z/` (full per-gate artifacts)

## 6. VAL-CAP-004 Verdict

**GREEN — PASS**

`Monitor capture passed drop+cadence gates (60 samples, key=1080p60-nvenc)` — same evidence shape as rerun 17. No regression.

## 7. VAL-SEG-003 Verdict

**GREEN — PASS**

`replay.save completed in 0 ms (gate: 2250 ms)` — same evidence shape as rerun 17.

## 8. VAL-EXP-001 Verdict

**FAIL** (as expected for diagnostics pass)

`Export validation failed — see thresholds` — ffmpeg exit 254 at copy stage.

## 9. `export.failed` Details

From `VAL-EXP-001/export-terminal-event.json`:

```json
{
  "method": "export.failed",
  "params": {
    "details": "exit code: Some(254)",
    "diagnostics_path": "/run/user/1000/cove-screen-recorder/exports/exp-1779348798104449905-0001.diagnostics.txt",
    "export_id": "exp-1779348798104449905-0001",
    "reason_code": "ffmpeg-nonzero-exit",
    "stage": "copy"
  }
}
```

- reason_code: `ffmpeg-nonzero-exit`
- stage: `copy`
- details: `exit code: Some(254)`
- diagnostics_path: **populated** (non-empty)

## 10. diagnostics_path Evidence

`diagnostics_path` is non-empty for the first time. Points to the staging-dir diagnostics file written before ffmpeg spawn and appended to with stderr.

## 11. `ffmpeg-diagnostics.txt` Presence

Copied into evidence dir at:
`smoke-evidence-tree/2026-05-21T07-29-16-246Z/VAL-EXP-001/ffmpeg-diagnostics.txt` (7,238 bytes)

Contains: argv preamble, per-input existence/size table, ffmpeg version banner, ffmpeg stderr.

## 12. ffmpeg argv

```
ffmpeg -y \
  -i concat:/run/user/1000/cove-screen-recorder/segments/pw-session-0000-488643-1779348732790/init.mp4|.../00001757.mp4|.../00001758.mp4|...|.../00001771.mp4 \
  -c copy \
  -movflags +faststart \
  -progress pipe:1 \
  /run/user/1000/cove-screen-recorder/exports/exp-1779348798104449905-0001.tmp
```

(16 inputs total: `init.mp4` + 15 fragments `00001757.mp4` … `00001771.mp4`.)

## 13. Input File Existence / Size Table

| # | File | exists | size_bytes |
|---|------|--------|------------|
| 0 | init.mp4 | **false** | ? |
| 1 | 00001757.mp4 | true | 28054 |
| 2 | 00001758.mp4 | true | 27888 |
| 3 | 00001759.mp4 | true | 26425 |
| 4 | 00001760.mp4 | true | 27570 |
| 5 | 00001761.mp4 | true | 24921 |
| 6 | 00001762.mp4 | true | 26070 |
| 7 | 00001763.mp4 | true | 26191 |
| 8 | 00001764.mp4 | true | 27348 |
| 9 | 00001765.mp4 | true | 29016 |
| 10 | 00001766.mp4 | true | 28147 |
| 11 | 00001767.mp4 | true | 27186 |
| 12 | 00001768.mp4 | true | 26833 |
| 13 | 00001769.mp4 | true | 28158 |
| 14 | 00001770.mp4 | true | 24968 |
| 15 | 00001771.mp4 | true | 25996 |

`init.mp4` is missing from the session segment dir. Live `ls` on segments dir at analysis time also shows no `init.mp4` — only numbered fragment files.

## 14. ffmpeg stderr Summary

```
[in#0 @ 0x...] Error opening input: No such file or directory
Error opening input file concat:/.../init.mp4|/.../00001757.mp4|...
Error opening input files: No such file or directory
```

ffmpeg's `concat:` protocol parses the URL as a single string and opens the first listed path (`init.mp4`) before continuing. That file does not exist, so ffmpeg aborts before it ever touches the fragments.

## 15. Root-Cause Verdict

**Two compounding defects, both supported by diagnostics:**

1. **Missing `init.mp4` in segment dir.** Encoder/segment writer never persisted the fMP4 init segment alongside the numbered media fragments. The export pipeline assumes it exists; segment dir listing and diagnostics confirm it does not.

2. **Wrong concat mechanism for fMP4.** ffmpeg's `concat:` protocol is documented for raw MPEG-TS / file-level byte concatenation, not for fMP4 init+fragments. Correct approaches for fMP4 are either (a) the `concat` demuxer (`-f concat -i list.txt`), or (b) byte-level concatenation of `init.mp4` + fragments into a single file before piping to ffmpeg. Even with `init.mp4` present, `-c copy` over `concat:` for fMP4 would still be fragile.

Of the two, **(1) is the proximate cause of exit 254** in this rerun — ffmpeg failed at input open, not during stream copy. (2) would surface as the next failure after (1) is fixed.

Stderr does NOT support: malformed fragment data, moov atom missing in fragments (ffmpeg never opened them), output path issue, or codec mismatch — those were not reached.

## 16. Can ISS-006 Close?

**No.** ISS-006 was filed for "VAL-EXP-001 ffmpeg copy stage exits 254 without diagnostics." Diagnostics are now present and useful, but the export still fails. ISS-006 (or a successor issue) should remain open and now carry the root-cause analysis. The diagnostics commit (`0961e26`) satisfies the "without diagnostics" half of the title; the "exits 254" half remains.

## 17. Can T-021 Go Green?

**No.** VAL-EXP-001 is a must-pass scripted-local gate and is still red. T-021 cannot green until VAL-EXP-001 passes.

## 18. Is T-010c Unblocked?

**No.** T-010c is gated on T-021 green.

## 19. Source / Validation / Policy Confirmations

- **No source files changed during rerun 18.** Working tree clean before and after `node dist-validation/runner.js smoke`.
- No validation logic changed.
- No thresholds changed.
- No segment-commit predicate changed.
- No replay.save behavior changed.
- No capture / cadence / VAL-CAP-004 changes.
- No NVENC / encoder changes.
- No ffmpeg argv change in this rerun (argv shape was set by the previous commit `0961e26`).
- Only operator action: `kscreen-doctor output.DP-4.mode.11` to satisfy the display preflight requirement.

## 20. Recommended Next Phase

Next pass should be a **source fix pass for VAL-EXP-001 init segment + concat strategy**, in order:

1. Fix the encoder/segment writer so the fMP4 init segment is persisted at the expected `init.mp4` path in the session segment dir (verify with a unit/integration test that asserts the file exists once the first fragment commits).
2. Replace the ffmpeg `concat:` protocol with either the `concat` demuxer or byte-level init+fragments concatenation; keep `-c copy` if and only if the resulting input is single-track contiguous fMP4 ffmpeg can stream-copy.
3. Re-run smoke (rerun 19). Expect VAL-EXP-001 to either green or fail with a NEW stderr that diagnostics now capture cleanly.
4. Only after VAL-EXP-001 greens: green T-021 and unblock T-010c.

Do not start T-010c. Do not green T-021. Do not modify capture / NVENC / replay.save / segment commit / VAL-CAP-004 / VAL-SEG-003 in the next pass.
