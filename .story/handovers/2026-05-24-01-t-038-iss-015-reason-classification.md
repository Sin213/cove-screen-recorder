# T-038 — ISS-015 Reason Classification (Rolling-Buffer Seal Failure)

**Date:** 2026-05-24
**Ticket:** T-038 (complete). **Issues:** ISS-015 (open, reason classified), ISS-012 (open, unchanged).

## Session Goal

Implement T-038: one additive renderer-surface log to make ISS-015/ISS-012 repro attempts self-classifying. Deploy, verify, run functional repro, classify ISS-015 reason per stop conditions.

## Result: COMPLETE — ISS-015 Classified as Rolling-Buffer Seal Failure

T-038 instrumentation deployed and functional repro produced a qualifying classification on attempt 1.

**Stop condition met:** reason = `"no committed segments available to pin"` →
**ISS-015 = rolling-buffer seal failure.**

## What Changed

Single file: `src/v2/engine.ts` (+10/-1 lines). `saveReplay` only.

**Change 1 — catch now captures err:**
```diff
-  } catch {
+  } catch (err) {
+    gs().log(
+      "warn",
+      `[export lifecycle] v2SaveReplay RPC rejected: code=${(err as { code?: string })?.code ?? "?"} message=${err instanceof Error ? err.message : String(err)} v2State=${gs().v2State}`,
+    );
     if (gs().v2State === "SAVING") {
       _enterRecording();
     }
```

**Change 2 — else branch on snapshot_id guard:**
```diff
     if (result?.snapshot_id && gs().v2State === "SAVING") {
       ...
+    } else {
+      gs().log(
+        "warn",
+        `[export lifecycle] v2SaveReplay no snapshot_id: hasResult=${!!result} snapshot_id=${result?.snapshot_id ?? "null"} v2State=${gs().v2State}`,
+      );
     }
```

## Verification

1. `npm run typecheck`: PASSED (all 3 tsconfig targets)
2. Forbidden-surface audit: CLEAN — no helper/, electron/, validation/, Cargo.*, package.json, src/App.tsx, src/store.ts, src/v2/fsm.ts touched
3. Diff scope: only `src/v2/engine.ts`

## Functional Repro — Attempt 1 (QUALIFYING)

**Session:** `pw-session-0000-1651816-1779606815259`
**Source:** monitor (Wayland portal, XR24 SHM fallback — DMA-BUF hard-failed as expected)
**Recording elapsed:** ~39 seconds (00:13:35 → 00:14:14 local)

**New warn log fired:**
```
warn [export lifecycle] v2SaveReplay RPC rejected: code=? message=no committed segments available to pin v2State=SAVING
```

**Sequence:**
- 07:13:35 UTC: portal established, PW stream ready (XR24, 3840×2160), seq=1 received
- 07:14:14 UTC: save triggered via button (v2State=RECORDING → SAVING)
- 07:14:14 UTC: catch (err) branch fires — RPC rejected
- 07:14:14 UTC: SAVING → RECORDING (guard fires, _enterRecording() called)
- v2SnapshotId=null, v2ExportId=null throughout

**Engine.log note:** Only seq=1 entry at 07:13:35 UTC; no segment-seal entries after that. Confirms rolling buffer writer did not produce any committed segments during the ~39s window.

## ISS-015 Classification

**Root cause boundary:** rolling-buffer seal failure — the segment ring writer does not seal segments during some sessions. The `replay.save()` RPC reaches the helper, which correctly reports that no committed segments are available to pin. The helper rejection propagates to the renderer as a thrown error, previously swallowed silently by `catch {}`. Now surfaced by T-038.

**ISS-015 impact update:** Added named reason + evidence path to ISS-015.

## T-037 Disposition

Unchanged. T-037 still requires a window-source qualifying attempt. ISS-015 classification does not satisfy T-037's window-source gate. All prior T-037 attempts hit Branch 5 (ISS-015 interception) under Screen source only — that pattern is now explained by the rolling-buffer seal failure, but ISS-012 classification still requires a genuine EXPORTING-reach repro.

## Codex Review Findings

Codex reviewed the diff and found:

1. **One observation (non-blocking):** The else branch log message `"no snapshot_id"` is misleading when `onSnapshotPinned` wins the race (v2State already EXPORTING, result.snapshot_id is truthy). In that case the log reads `hasResult=true snapshot_id=<real-id> v2State=EXPORTING` — distinguishable but prefix text is wrong. Per spec, the message was not changed. Flag for future cleanup.
2. `(err as { code?: string })?.code` cast: safe.
3. Log before SAVING guard in catch: no observable change.
4. Template literals: safe.

**No blocking defects.**

## Evidence Root

`.story/handovers/evidence/2026-05-24-iss-015-reason-classification/`
- `render-snapshot.txt` — full LogPanel dump (useStore.getState().logs), attempt 1
- `operator-note.md` — session details, sequence, observations
- `engine-snapshot.log` — relevant engine.log entries (07:09–07:14 UTC)

## Tickets Changed

- T-038: complete
- T-037: description updated (ISS-015 classification noted, window-source gate unchanged)
- ISS-015: impact updated with named reason + evidence path

## Commit Status

NOT committed (per task instructions — do not commit unless explicitly told).
