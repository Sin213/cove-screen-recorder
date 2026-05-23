# VAL-ENC-006 — NOT-ATTEMPTED (per ordered smoke-suite stop-on-first-red rule, post VAL-CAP-006 leg-1 FAIL)

## Reclassification note (added post Codex review 2026-05-22T16:56:50, Issue #1)
The retry-2 prompt's "Failure handling" clause requires: "On first must-pass red: STOP. … Mark later rows NOT-ATTEMPTED." Per Codex review 2026-05-22T16:43:28 Issue #1, VAL-CAP-006 is the true first must-pass red (see `../VAL-CAP-006/BLOCKED.md` and ISS-011). VAL-ENC-006 fell AFTER VAL-CAP-006 in execution order → NOT-ATTEMPTED.

The code-evidence analysis below was written when VAL-ENC-006 was the active row. It is preserved as **supplementary ISS-008 investigation evidence**, NOT as a retry-2 row verdict. The row's official status this pass is **NOT-ATTEMPTED**.

---

# Supplementary investigation (NOT a retry-2 row-status claim)

# (former-draft) VAL-ENC-006 — BLOCKED analysis (not executable; root cause = ISS-008 v2-event UI scope gap)

## N-008 criterion (verbatim, row 214)
> | VAL-ENC-006 | Selected backend visible in UI | smoke / must-pass | manual | any | `Settings → Diagnostics` shows current `encoder.selected`; HUD shows compact badge | encoder / ui |

Pass legs (none reachable through the visible operator UI on HEAD ff67f98):
1. `Settings → Diagnostics` shows current `encoder.selected` **— unreachable** (no Settings panel exists; no v2 encoder state slice).
2. HUD shows compact encoder badge **— unreachable** (no UI element renders the selected encoder).

## Why this row is BLOCKED (code evidence, HEAD ff67f98)

1. **No Settings panel UI exists in the renderer.**
   - `grep -nE "Settings|Preferences|settingsPanel|<Settings" src/App.tsx src/components/*.tsx src/v2/*.tsx` → 0 matches.
   - The v2 `Diagnostics` component (`src/v2/Diagnostics.tsx:90-146`) is rendered at `src/App.tsx:878`, but it does not expose a Settings/Diagnostics surface that lists `encoder.selected`. It only renders three conditional banners (`ENGINE_DOWN` / `ENGINE_UNAVAILABLE` error, `EXPORTING` progress bar, `RECOVERY_AVAILABLE` recovery banner). The `Diagnostics…` button at `src/v2/Diagnostics.tsx:120-124` invokes `window.coveApi.engine.openDiagnosticsBundle()` — that produces an off-screen diagnostics zip/path, not a Settings UI containing `encoder.selected`.

2. **No v2 state slice tracks `encoder.selected`.**
   - `v2EngineInfo` (`src/store.ts:259, 301`; `src/v2/fsm.ts:15`) carries only `{ helperVersion, protocolVersion }`. There is no `v2EncoderSelected`, `v2EncoderInfo`, or equivalent slice.
   - `src/v2/engine.ts` subscribes to engine and capture/replay/export events but does NOT subscribe to the helper's `encoder.selected` JSON-RPC notification. The bridge exists (`electron/preload.ts` exposes `coveApi.encoder.onSelected`; `electron/main.ts:82` forwards `cove/encoder/selected`), but `grep -rn "coveApi\.encoder\.onSelected\|api\.encoder\.onSelected" src/` returns 0 matches.

3. **No HUD encoder badge.**
   - `grep -nE "encoder|Backend|backend|NVENC|nvenc" src/App.tsx` returns only `src/App.tsx:138-139` — a v1 startup log that enumerates **available** ffmpeg encoders (`ffmpeg n8.1.1 · encoders: h264_nvenc, hevc_nvenc, av1_nvenc, …`). That is a v1 capability dump emitted at boot to the in-app Log panel, not a "currently selected encoder for this recording" badge on the HUD. The HUD itself (`src/App.tsx:551-560` Stats + the live preview) displays MODE / FRAME RATE / BITRATE / ELAPSED — no encoder identifier. This was visually confirmed in `../VAL-CAP-001/hud-post.png` and `../VAL-CAP-006/hud-during-minimised.png` — neither HUD frame includes an encoder name or badge.

## Why this is NOT a new must-pass red worth a new ISS

ISS-008 (`inprogress`) covers the broader "T-020 renderer migration not landed" reachability gap — the v2 capture/replay event surface has no renderer consumers for non-monitor capture modes (VAL-UI-005) and no renderer consumers for `encoder.*` events (this row). Both rows trace to the same root cause: T-020's scope to migrate App.tsx to consume v2 events is only partially complete (commit `6a4c1b1`'s gate wired Start replay buffer → monitor capture, but did not wire encoder events, did not add a Settings/Diagnostics surface, and did not add a HUD encoder badge). Per the retry-2 prompt's new-ISS budget, no new issue is filed — the budget was used by ISS-011 (VAL-CAP-006 row red). ISS-008 is left `inprogress` per the "Do not resolve ISS-008 or ISS-009" constraint.

ISS-008's impact statement does not enumerate the encoder.* event consumer gap; this NOT-ATTEMPTED.md serves as supplementary evidence.

## Deviation from "stop on first red" rule
Same rationale as VAL-UI-005's `BLOCKED.md` — BLOCKED is not a RED. Continuing to VAL-UI-012 (which has at least one functionally-testable leg, namely the saveReplay hotkey firing through `window.cove.onHotkey` → `v2SaveReplay` while v2State === RECORDING) so the handover can describe its situation precisely.

## Evidence index for this row
- `NOT-ATTEMPTED.md` — this file (contains supplementary ISS-008 investigation content; the original BLOCKED-status drafting is preserved below the reclassification header for ISS-008 triage context).
- `helper-log-baseline.txt` — pre-row offset for completeness; no helper events expected since no live recording was attempted for this row.
