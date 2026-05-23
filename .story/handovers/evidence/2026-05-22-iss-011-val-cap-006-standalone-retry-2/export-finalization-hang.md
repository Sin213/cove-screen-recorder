# Secondary Finding: Export Finalization Hang

## Observation
After saving replay, the UI displayed "Exporting replay... 100%" and never
transitioned to completion/reset state. Replay controls remained stuck in
exporting state indefinitely.

## Evidence
- Export file exists and is valid: exp-1779512366090814371-0005.mp4 (46.5M)
- ffprobe reads the file successfully: 1920x1080, 1560 frames, 28.54s duration
- The export was written to disk but the completion event did not reach the renderer
- No error entries in engine-log.txt after the portal session
- engine-log.txt contains no export/save/finalize entries at all (export may be
  handled by a code path that doesn't log to engine-log.txt)

## Impact
This is a separate defect from ISS-011 (frame count deficit). The export pipeline
completes file writing but fails to signal completion to the UI, leaving the user
in a stuck state requiring app restart.

## Relationship to ISS-011
Orthogonal. The export hang affects the UI completion signal, not frame production
or capture rate. However, both issues were observed in the same test run.
