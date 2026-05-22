# Slice 3 runtime reconciliation note

Prompt prescribed two separate commands:
- `target/release/cove-replay-engine --socket /run/user/1000/cove-screen-recorder/engine.sock`
- `VITE_COVE_V2_UI=1 npm run dev`

Actual runtime (dev mode):
- The helper CLI flag is `--ipc-socket`, not `--socket` (verified via `--help`).
- `electron/engine-supervisor.ts` (`spawnFresh` at L209, `adoptOrSpawn` at L284, pid file resolver at L160-161) shows the dev-mode EngineSupervisor spawns and manages the helper itself, writing the PID to `$XDG_RUNTIME_DIR/cove-screen-recorder/engine.pid` and piping helper stdout/stderr through Electron's `logLine` event (L255-264). The supervisor's adoption path keys off that PID file.
- An externally-launched helper without a written PID file causes the supervisor to attempt `spawnFresh` over the bound socket; the spawn fails, the supervisor exhausts its restart budget, and the dev tree exits.

Resolution applied: let the dev-mode supervisor own the helper. The active helper is supervisor-spawned (PID 996598, `target/debug/cove-replay-engine --ipc-socket /run/user/1000/cove-screen-recorder/engine.sock --log-dir "/home/sin/.config/Cove Screen Recorder/logs" --log-level info`). Helper events stream to the external file `/home/sin/.config/Cove Screen Recorder/logs/engine.log` (outside the repo; not part of this patch) and also via the supervisor `logLine` channel into `electron-dev.txt`.

Process lifecycle for evidence (artifacts inside the repo use `.txt` extensions because `*.log` is gitignored at `.gitignore:10`):
- `helper.txt` at the evidence root holds the very first external helper attempt (PID 993826, lifetime ~08:11:24–08:11:55), preserved for traceability.
- `electron-dev.txt` (first attempt) holds the first npm-dev cycle that exited under the supervisor-spawn conflict.
- The active operator-driven session ran against the supervisor-spawned helper; row-level excerpts (had any row been executed) would be sliced from the external `~/.config/Cove Screen Recorder/logs/engine.log` by date-range. No row executed this slice — see blocker-VAL-CAP-001/.

No source/runtime/validation/release-policy files were modified to resolve this.
