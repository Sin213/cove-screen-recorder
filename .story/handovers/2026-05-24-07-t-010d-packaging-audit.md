# T-010d — v2.0.0 Packaging Audit

**Date:** 2026-05-24  
**Ticket:** T-010d (inprogress — audit complete, acceptance blocked by findings)  
**Issues filed:** ISS-017, ISS-018, ISS-019

## Session Goal

Execute T-010d packaging audit: build release artifacts, verify sha256 sidecars, inspect AppImage and .deb payloads, validate VAL-UI-010/011/014, draft RELEASES.md v2.0.0 section.

## Build

Command: `npm run dist:linux:full` (not `dist:linux` — bootstrap shorthand only produces AppImage, not deb).

Build succeeded. Cargo compiled with 70 warnings (pre-existing NVENC FFI naming, one unreachable expression — no action required). electron-builder produced both targets.

## Artifact Inventory

| Artifact | Size | sha256 |
|---|---|---|
| Cove-Screen-Recorder-1.1.0-x86_64.AppImage | 109M | `c52b830d1f1b9999a31fd765de5bec72fc14220575dbf56e1b24c3a863551ed0` |
| Cove-Screen-Recorder-1.1.0-amd64.deb | 75M | `6b096c721e325eb3a982de08b7a3eba445903d95eab1746a16e7a9ac1f217330` |
| cove-replay-engine (helper) | 7.8M | `3bb91dd2cb5d7fbe58e0ddc797dd5bbec43206c93aa35d8f2d2d12fc7413141c` |

Version: 1.1.0 (version bump is T-010e scope — packaging mechanism is correct).

## Verification Results

| Check | Result |
|---|---|
| sha256sum -c AppImage | PASS |
| sha256sum -c deb | PASS |
| Helper in AppImage at `resources/helper/` | PASS |
| Helper .sha256 in AppImage | PASS |
| AppImage helper hash == sidecar | PASS |
| Helper in .deb at `resources/helper/` | PASS |
| Helper .sha256 in .deb | PASS |
| .deb helper hash == sidecar | PASS |
| Boot-time verifySha256() wired (engine-supervisor.ts:175) | PASS |
| extraResources path matches N-007 §17 | PASS |

## Findings (3 issues filed)

### ISS-017 — .deb Depends missing pipewire/xdg-desktop-portal [high]
`package.json build.deb.depends` has: `ffmpeg, libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0`. Missing: `pipewire (>= 0.3.x)` and `xdg-desktop-portal (>= 1.18)` per N-007 §17. Fix is a one-line edit to package.json.

### ISS-018 — VAL-UI-010/011 blocking modal absent [high]
SHA-256 mismatch (engine-supervisor.ts:194) and protocol version mismatch (engine-supervisor.ts:350) both correctly throw and cause supervisor "unavailable". But electron/main.ts only sends `cove/engine/stateChanged "unavailable"` — no error code, no dedicated IPC event. Renderer shows a non-blocking "Engine unavailable" banner (Diagnostics.tsx). N-008 requires a dedicated blocking modal ("Helper integrity check failed") with the main UI unreachable. Feature absent.

### ISS-019 — VAL-UI-014 dep probe not implemented [high]
No startup probe for `pipewire` or `xdg-desktop-portal` anywhere in electron/ or src/. The app proceeds to boot regardless of whether these system deps are present. N-008 requires a blocking install-hint modal when `xdg-desktop-portal` is hidden from PATH.

## VAL-UI Row Dispositions

| Row | N-008 Requirement | Disposition |
|---|---|---|
| VAL-UI-010 | Blocking modal on sha256 mismatch | ⚠ NOT IMPLEMENTED — underlying check fires, modal absent |
| VAL-UI-011 | Blocking modal on protocol mismatch | ⚠ NOT IMPLEMENTED — underlying check fires, modal absent |
| VAL-UI-014 | Dep probe blocking modal on missing xdg-desktop-portal | ✗ NOT IMPLEMENTED — no probe code at all |

## RELEASES.md

Updated `RELEASES.md` with a `## v2.0.0 Packaging Notes (draft)` section covering:
- Build command (dist:linux:full)
- Artifact list and naming convention
- sha256 sidecar policy
- Helper extraResources path (N-007 §17)
- .deb Depends known gap
- Portal backend recommendation (user choice, not a Depends)
- Dep probe gap (VAL-UI-014 not yet implemented)
- Boot-time integrity gate gaps (VAL-UI-010/011)
- Auto-update unchanged from v1.1.0

## Evidence

`.story/handovers/evidence/2026-05-24-t-010d-packaging-audit/packaging-audit-report.md` — full audit report with all hashes, verification commands, code paths, and disposition detail.

## T-010d Acceptance Status

The artifact production, sidecar generation, helper payload, and boot-time sha256 check are all **green**. The packaging mechanism is correct.

**Not accepted as complete** because:
- ISS-017: Depends gap (needs package.json edit)
- ISS-018: VAL-UI-010/011 blocking modal (needs IPC + renderer implementation)
- ISS-019: VAL-UI-014 dep probe (needs implementation)

These three gaps require source changes. A pre-T-010e ticket should implement ISS-017/018/019 before the packaging gate can issue a go/no-go for T-010e.

## Files Changed

- `RELEASES.md` — v2.0.0 packaging notes section added
- `.story/handovers/evidence/2026-05-24-t-010d-packaging-audit/packaging-audit-report.md` — created
- `.story/issues/ISS-017.json`, `ISS-018.json`, `ISS-019.json` — created
- `.story/tickets/T-010d.json` — status → inprogress

## Not Committed

No code commits (per T-010d scope). RELEASES.md edit is documentation only and follows the no-commit rule.
