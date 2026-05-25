# T-010d — v2.0.0 Packaging Audit Report

**Date:** 2026-05-24  
**Ticket:** T-010d (open)  
**Session note:** Version string is 1.1.0 (version bump is T-010e scope). This audit validates the packaging *mechanism* against the v2.0.0 packaging contract.

---

## 1. Build Command

```
npm run dist:linux:full
```

Note: `dist:linux` (bootstrap shorthand) only produces AppImage. `dist:linux:full` produces both AppImage + deb as required by T-010d acceptance. The `:full` variant was used.

## 2. Artifact Inventory

| Artifact | Size | sha256 |
|---|---|---|
| Cove-Screen-Recorder-1.1.0-x86_64.AppImage | 109M | `c52b830d1f1b9999a31fd765de5bec72fc14220575dbf56e1b24c3a863551ed0` |
| Cove-Screen-Recorder-1.1.0-x86_64.AppImage.sha256 | 109B | — (sidecar) |
| Cove-Screen-Recorder-1.1.0-amd64.deb | 75M | `6b096c721e325eb3a982de08b7a3eba445903d95eab1746a16e7a9ac1f217330` |
| Cove-Screen-Recorder-1.1.0-amd64.deb.sha256 | 103B | — (sidecar) |
| target/release/cove-replay-engine (helper) | 7.8M | `3bb91dd2cb5d7fbe58e0ddc797dd5bbec43206c93aa35d8f2d2d12fc7413141c` |
| target/release/cove-replay-engine.sha256 | 100B | — (sidecar) |

All artifacts located in `release/`. Helper at `target/release/`.

## 3. sha256sum -c Verification

```
cd release
sha256sum -c Cove-Screen-Recorder-1.1.0-x86_64.AppImage.sha256
→ Cove-Screen-Recorder-1.1.0-x86_64.AppImage: OK

sha256sum -c Cove-Screen-Recorder-1.1.0-amd64.deb.sha256
→ Cove-Screen-Recorder-1.1.0-amd64.deb: OK
```

**PASS**: Both sidecar verifications pass.

## 4. Helper Payload Verification

### AppImage

Mounted via FUSE (`--appimage-mount`).

```
/tmp/.mount_Cove-SwQK2gV/resources/helper/cove-replay-engine     (8133760 bytes)
/tmp/.mount_Cove-SwQK2gV/resources/helper/cove-replay-engine.sha256
```

Expected hash (from sidecar): `3bb91dd2cb5d7fbe58e0ddc797dd5bbec43206c93aa35d8f2d2d12fc7413141c`  
Actual hash (of binary): `3bb91dd2cb5d7fbe58e0ddc797dd5bbec43206c93aa35d8f2d2d12fc7413141c`  
**PASS**: AppImage helper hash matches sidecar.

Path format: `resources/helper/cove-replay-engine` → `process.resourcesPath/helper/cove-replay-engine` ✓ (matches N-007 §17)

### .deb

Extracted via `dpkg-deb --extract`.

```
./opt/Cove Screen Recorder/resources/helper/cove-replay-engine     (8133760 bytes)
./opt/Cove Screen Recorder/resources/helper/cove-replay-engine.sha256
```

Expected hash (from sidecar): `3bb91dd2cb5d7fbe58e0ddc797dd5bbec43206c93aa35d8f2d2d12fc7413141c`  
Actual hash (of binary): `3bb91dd2cb5d7fbe58e0ddc797dd5bbec43206c93aa35d8f2d2d12fc7413141c`  
**PASS**: .deb helper hash matches sidecar.

Path format: `.../resources/helper/cove-replay-engine` → same `process.resourcesPath/helper/` structure ✓

## 5. Sha256 Check at Boot (N-007 §6)

File: `electron/engine-supervisor.ts`, `verifySha256()` method (lines 175–199).

- Skipped in dev mode (`!app.isPackaged`)
- Reads `${binaryPath}.sha256` sidecar, parses the hash (first whitespace-split token)
- Computes SHA-256 of binary, compares to sidecar hash
- Throws `SHA-256 mismatch` error on mismatch → supervisor catches → emits `"unavailable"` → renderer shows "Engine unavailable" banner

Boot-time check is wired correctly for packaged builds. ✓

## 6. .deb Depends Review

Current Depends list (from package.json `build.deb.depends`):
```
ffmpeg, libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0
```

Per N-007 §17, required Depends should include:
- `pipewire (>= 0.3.x)` — **MISSING** ⚠
- `xdg-desktop-portal (>= 1.18)` — **MISSING** ⚠

Note: N-007 §17 explicitly states portal backend (-gnome/-kde/-wlr) is user choice and is NOT a Depends.

**FINDING**: The Depends list is missing `pipewire` and `xdg-desktop-portal`. This is a packaging contract violation per N-007 §17. The fix (edit `package.json build.deb.depends`) is in T-010e scope. `package.json` is read-only in T-010d.

## 7. VAL-UI Validation Rows

### VAL-UI-010 — Helper sha256 mismatch blocks boot

**N-008 requirement**: Corrupt helper binary post-install → renderer shows blocking modal "Helper integrity check failed"; main UI not reachable.

**Actual implementation** (code audit):
- SHA-256 check is implemented in `engine-supervisor.ts` `verifySha256()` — fires on mismatch
- Error propagation: supervisor `start()` catches, sets state "unavailable", emits `supervisor.on("unavailable")` 
- `electron/main.ts` line 1203: sends `cove/engine/stateChanged` with `"unavailable"` — no error detail or code
- Renderer `src/v2/engine.ts` line 136: sets `ENGINE_UNAVAILABLE` state
- Renderer `src/v2/Diagnostics.tsx`: shows `"Engine unavailable"` banner with "Restart engine" button

**Gap**: No `helper-binary-tampered` IPC event or code. No dedicated blocking modal. The main UI IS reachable (banner is non-blocking, main controls visible). Does not match N-008 "blocking modal; main UI not reachable" requirement.

**Disposition**: ⚠ NOT IMPLEMENTED as specified. The sha256 check fires and disables the engine, but the blocking modal per N-008 is absent. Cannot be called green.

### VAL-UI-011 — Helper protocol mismatch blocks boot

**N-008 requirement**: Ship helper with wrong `--print-protocol-version` → blocking modal; main UI not reachable.

**Actual implementation** (code audit):
- Protocol check is implemented in `engine-supervisor.ts` `connectAndVerify()` line 350: `version.protocol_version !== PROTOCOL_VERSION` throws `protocolVersion mismatch`
- Same error propagation path as VAL-UI-010 → generic "Engine unavailable" banner
- No protocol-specific IPC code or modal

**Disposition**: ⚠ NOT IMPLEMENTED as specified. Protocol mismatch check fires and disables engine, but blocking modal per N-008 is absent.

### VAL-UI-014 — Dependency probe blocks app when required dep missing

**N-008 requirement**: Hide `xdg-desktop-portal` from PATH → renderer shows blocking install-hint modal.

**Actual implementation** (code audit):
- No dependency probe found in any electron/ or src/ file
- `electron/main.ts` references `xdg-desktop-portal` only in comments about Wayland capture flow
- No `which`, `execSync`, or startup check for `pipewire` or `xdg-desktop-portal`
- No "install-hint" modal or IPC event

**Disposition**: ✗ NOT IMPLEMENTED. Zero code exists for this feature.

## 8. Version String Note

Build produces `1.1.0` artifacts because `package.json version` has not been bumped (version bump is T-010e scope). The packaging mechanism, helper path, and sha256 contract are all present and correct. The v2.0.0 artifacts will be identical in structure with a different version string after T-010e.

## 9. Cargo Build Warnings

`cargo build --release` produced 70 warnings — all in the NVENC FFI bindings (C-convention struct naming). One `unreachable expression` in `helper/src/export/mod.rs:102`. These are pre-existing and do not affect packaging or runtime behavior.

---

## Summary Verdict

| Item | Status |
|---|---|
| AppImage produced | ✓ PASS |
| .deb produced | ✓ PASS |
| AppImage .sha256 sidecar | ✓ PASS |
| .deb .sha256 sidecar | ✓ PASS |
| sha256sum -c AppImage | ✓ PASS |
| sha256sum -c .deb | ✓ PASS |
| Helper in AppImage extraResources | ✓ PASS |
| Helper .sha256 in AppImage | ✓ PASS |
| Helper hash == sidecar hash (AppImage) | ✓ PASS |
| Helper in .deb extraResources | ✓ PASS |
| Helper .sha256 in .deb | ✓ PASS |
| Helper hash == sidecar hash (.deb) | ✓ PASS |
| Boot-time sha256 check wired | ✓ PASS |
| extraResources path matches N-007 §17 | ✓ PASS |
| .deb Depends: pipewire | ⚠ MISSING |
| .deb Depends: xdg-desktop-portal | ⚠ MISSING |
| VAL-UI-010 (blocking modal, sha256) | ⚠ NOT IMPLEMENTED |
| VAL-UI-011 (blocking modal, protocol) | ⚠ NOT IMPLEMENTED |
| VAL-UI-014 (dep probe modal) | ✗ NOT IMPLEMENTED |
| Version string (1.1.0 vs 2.0.0) | ℹ T-010e scope |

**Green items gate T-010e**: The artifact production, sidecar, and helper payload mechanisms are all correct.  
**Red/amber items block T-010d acceptance**: Depends gap, VAL-UI-010/011/014 not implemented. These require source changes (out of T-010d scope). A new ticket or T-010e sub-task must be created to implement the blocking modals and fix the Depends list before the packaging gate can clear.
