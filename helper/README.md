# cove-replay-engine

Native helper process for Cove Screen Recorder v2.

## Location

This crate lives at `helper/` in the repo root, alongside `electron/` and `src/`. The workspace root `Cargo.toml` lists it as the sole workspace member.

## Build

```
cargo build -p cove-replay-engine
cargo build -p cove-replay-engine --release
```

The binary is at `target/debug/cove-replay-engine` or `target/release/cove-replay-engine`.

## Invocation

The helper is spawned by the Electron main process. Do not invoke it directly.

Running it without `--ipc-socket` prints a message and exits non-zero.

```
./target/debug/cove-replay-engine --print-protocol-version  # prints 1 and exits 0
```
