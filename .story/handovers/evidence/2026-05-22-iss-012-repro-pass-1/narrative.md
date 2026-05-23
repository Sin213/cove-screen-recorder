# ISS-012 Reproduction Pass 1 — Narrative

## Outcome: Happy path — hang did not reproduce

## Timeline

- 23:18:28 — App launched with `VITE_COVE_V2_UI=1 npm run dev` on HEAD 80d1f3d
- 23:18:28 — ffmpeg n8.1.1 detected, Wayland session identified
- 23:25:20 — RecoveryBanner appeared (65 stale recovery records), dismissed with "Ignore for this session"
- 23:25:33 — PipeWire capture started; DMA-BUF negotiation failed, SHM fallback activated
- 23:25:33 — PW stream ready: 3840x2160, XR24 format
- 23:25:59 — User clicked "Save replay"
- 23:25:59.156 — Helper: export.queued → export.started (export_id=exp-1779517559156083846-0001)
- 23:25:59.379 — Helper: export.muxing → fsync → rename → dir fsync (222ms mux)
- 23:26:01.702 — Helper: sha256 computed, export.completed emit (total 2545ms)
- 23:26:01 — Renderer: export.completed received, post-transition v2State=RECORDING
- 23:26:01 — Renderer: snapshot release success

## Export ID Correlation

| Surface | export_id | Event |
|---------|-----------|-------|
| Helper (engine-log) | exp-1779517559156083846-0001 | export.completed emit |
| Electron main (electron-dev.txt) | N/A — stdout buffered by concurrently, file empty | — |
| Renderer (LogPanel) | exp-1779517559156083846-0001 | export.completed received |

The shared export_id confirms end-to-end IPC delivery: helper emitted, renderer received and transitioned to RECORDING. The electron main process forwarding is implied by the successful renderer receipt (renderer cannot receive IPC events without main-process relay).

## Classification Decision Tree

- B1 helper-internal hang: NO — helper emitted export.completed at 06:26:01.702
- B2 helper→main IPC drop: NO — renderer received export.completed (implies main forwarded it)
- B3 main→renderer IPC drop: NO — renderer logged export.completed received
- B4 stale-guard misclassification: NO — no stale-guard discard logged
- B5 state-to-UI binding drift: NO — UI transitioned to RECORDING, controls re-enabled
- B6 transition handler exception: NO — post-transition line logged successfully

**Result: hang did not reproduce. All decision-tree branches cleared.**

## Evidence Gaps

- `electron-dev.txt` is empty (0 lines) due to `concurrently` stdout buffering. The main process `[export lifecycle] export.completed` forwarding event cannot be directly confirmed from this file. However, the renderer's receipt of the event with matching export_id confirms the forwarding occurred.

## MP4 Validation

- Path: /run/user/1000/cove-screen-recorder/exports/exp-1779517559156083846-0001.mp4
- Size: 107,657,245 bytes (102.7 MB)
- Resolution: 3840x2160 (4K)
- Codec: h264 High, level 52
- Duration: 25.227s
- Frames: 1080
- Bitrate: ~34 Mbps
- SHA256: bfe7ee5aa78cd0a9eb3f91a1ba24dbb9a1aa3f7f60585a8844b11e39b774d845
