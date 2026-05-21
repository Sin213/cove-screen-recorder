# VAL-EXP-001 ffmpeg output muxer fix

## Context
Rerun 20 confirmed the fMP4 trun/moof layout fix unblocked ffmpeg input
parsing. ffmpeg now successfully reads the concat input but fails with
"Unable to choose an output format" because the temporary export path
ends in `.tmp` and ffmpeg cannot infer the muxer from that extension.

## Fix
Add `-f mp4` to the ffmpeg argv before the `.tmp` output path in
helper/src/export/mod.rs. Two argv emission sites updated:

1. The diagnostics preamble argv string in the `run_export` function.
2. The actual `tokio::process::Command` arg list passed to ffmpeg.

## Scope
- Only file touched: helper/src/export/mod.rs
- Concat input building unchanged.
- Stream-copy behavior unchanged.
- Staging path naming unchanged.
- replay.save behavior unchanged.
- T-021 and T-010c ticket files unchanged.
- No encoder/segment/capture/validation/electron/renderer/packaging
  changes.

## Verification
- cargo build -p cove-replay-engine             -> 0 errors
- cargo test -p cove-replay-engine --lib        -> 94 passed
- cargo test -p cove-replay-engine
    --test encoder_session                      -> 28 passed
- cargo test -p cove-replay-engine
    --test segment_buffer                       -> 7 passed
- npm run typecheck                             -> clean
- npm run validate:build                        -> clean
- npm run build                                 -> renderer + electron built
- git diff --check                              -> clean
- git status --short --untracked-files=all      -> only export/mod.rs modified

## Next
- Codex review of the source patch via claude-handoff-review.sh.
- After Codex says "patch is correct": commit and rerun 21 MVP smoke.
- T-021 is NOT being greened manually; T-010c is NOT being started.
