# Initial-ready race — pre-row blocker investigation (no formal ISS this pass; worked around via engine.restart())

## Filing status
**No formal ISS filed for this race this pass.** The retry-2 prompt's "at most one new ISS-XXX.json" budget was used for ISS-011 (VAL-CAP-006 leg-1 frame-count red, per the failure-handling rule's "file at most one new ISS-XXX … for the first must-pass row red" requirement). This race is a real, reproducible defect — it would have warranted ISS-010 — but to comply with the strict budget it remains documented here only. If the race resurfaces in retry-3 (likely, since no source change has shipped to fix it), the operator should file it as a new ISS at that time. This document and the adjacent `devtools-probes.txt` + `code-refs.txt` carry forward all the diagnostic context.

---

# Original analysis (race description, root cause, workaround)

## Symptom (first observed at ~17:24Z on this dev session)
Under `VITE_COVE_V2_UI=1 npm run dev` with the helper booting cleanly and the OS-level supervisor↔helper unix-stream connection ESTABLISHED, the renderer was stuck at `v2State === "BOOTING"`:
- `.v2-diagnostics` element absent from DOM (proves Diagnostics returned null at src/v2/Diagnostics.tsx:100, which only happens when `v2State === "BOOTING"`).
- `Start replay buffer` button rendered with `disabled: true`, classes `btn btn-outline btn-sm`.
- No RecoveryBanner — the ISS-009 affordance was unreachable.

## OS-level state at time of symptom
- helper PID 1040850 (cove-replay-engine --ipc-socket /run/user/1000/cove-screen-recorder/engine.sock --log-dir /home/sin/.config/Cove Screen Recorder/logs --log-level info), LISTEN on engine.sock fd 19u plus an ESTABLISHED accept on fd 16u.
- Electron main PID 1040789 held the peer connection on fd 109u (inode 7737751).
- engine.log: `listening` at 2026-05-22T17:15:19.739986Z; zero events after `listening` (no `engine.shutdown`, no error frames). Handshake at the unix-socket layer succeeded; the helper just doesn't log per-RPC dispatch at INFO.

## Renderer-side probe confirming the race
DevTools console:
```
> window.coveApi.engine.onReady(info => console.log('READY-CAUGHT', JSON.stringify(info)));
> window.coveApi.engine.onStateChanged(s => console.log('STATE-CAUGHT', s));
> 'subscribed; will report if anything fires'
< 'subscribed; will report if anything fires'

> window.coveApi.engine.restart().then(r => console.log('restart returned', JSON.stringify(r)));
< Promise {<pending>}

STATE-CAUGHT "shuttingDown"
STATE-CAUGHT "idle"
STATE-CAUGHT "starting"
STATE-CAUGHT "ready"
restart returned null
READY-CAUGHT {"helperVersion":"0.1.0","protocolVersion":1}
```

The newly-installed listeners catch the supervisor's `stateChanged` and `ready` events after `engine.restart()`. The supervisor IS emitting `ready` correctly and the preload bridge IS routing it; the **original** first `ready` was simply lost because the subscription was not yet in place when main fired the IPC.

## Root cause
`src/App.tsx:99` registers `useEffect(() => initV2Engine(), [])`. React runs `useEffect` callbacks after commit, asynchronously. `electron/main.ts:232-236` schedules a `did-finish-load` replay of `cove/engine/ready` from `lastReadyPayload`, but `did-finish-load` can fire before the React mount commit + `useEffect` has registered the `ipcRenderer.on("cove/engine/ready", ...)` listener installed inside `initV2Engine` (`src/v2/engine.ts:46-54`). `ipcRenderer.on` is forward-only — any prior emission is lost.

Code references (current HEAD ff67f98):
- `electron/main.ts:39` (`lastReadyPayload` cache)
- `electron/main.ts:232-236` (did-finish-load replay)
- `electron/main.ts:1143-1148` (supervisor.on("ready") handler — also fires at the moment of handshake completion if mainWindow is already open)
- `electron/engine-supervisor.ts:372-377` (supervisor `setState("ready"); this.emit("ready", ...)`)
- `electron/preload.ts:107-108` (`onReady` bridge → `ipcRenderer.on("cove/engine/ready", cb)`)
- `src/v2/engine.ts:46-54` (renderer listener inside initV2Engine)
- `src/App.tsx:99` (`useEffect(() => initV2Engine(), [])` — race origin)
- `src/v2/Diagnostics.tsx:100-102` (`!isDown && !isExporting && !isRecovery && v2State === "BOOTING"` → return null)

## Workaround applied this session (no source edits)
Operator ran `window.coveApi.engine.restart()` from DevTools. The supervisor cycled the helper (`shuttingDown → idle → starting → ready`) and re-emitted `ready`; the listener installed by the prior probe step caught it; `_refreshRecoverableSessions` then surfaced the 51 sessions; v2State → RECOVERY_AVAILABLE; banner rendered.

After the banner appeared, the operator clicked "Ignore for this session" (ISS-009 affordance). The banner hid, Start replay buffer became enabled, and `recovery.ignored count=51` (expected) was emitted to the renderer log buffer. From that point the visible operator UI was reachable and Slice 3 retry-2 rows became executable.

## Why this didn't trip retry-1
Retry-1's blocker was ISS-009 (RECOVERY_AVAILABLE disabling Start). That state implies the supervisor's `ready` event DID reach the renderer in retry-1 — the race must have resolved favorably on that boot. The race is timing-dependent (depends on how soon `did-finish-load` fires relative to React's useEffect microtask), so retry-1 happened to win and retry-2 happened to lose. The bug is latent in both.

## Severity / owner-on-fail
- Severity: high (blocks every §22 manual row that requires `Start replay buffer` reachability via the visible operator UI).
- Owner-on-fail layer: ui (initV2Engine subscription timing); structural fix candidates include: replaying `lastReadyPayload` on every `cove:store:ready` request from renderer, or exposing a synchronous `window.coveApi.engine.lastReady` getter so initV2Engine can pull on subscribe, or delaying the supervisor's `mainWindow.webContents.send` until after a renderer `ready` ack.
