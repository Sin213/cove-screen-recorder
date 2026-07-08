# Issue #9 - Custom AppImage update installer (AppImageLauncher EPIPE fix)

## Task

Fix GitHub issue #9: auto-update silently fails with EPIPE when AppImageLauncher
is installed. electron-updater's AppImageUpdater.doInstall() finishes an update
by exec'ing the new AppImage (execFileSync); AppImageLauncher intercepts that
exec via its binfmt handler, the child exits before the handshake completes,
and Node throws EPIPE. The old code swallowed the error in a console.warn.

The issue's proposed fix (bundling appimageupdatetool via an electron-builder
`appImageUpdateTool` config) was verified to be nonexistent API and rejected.
Implemented instead: the pattern used by the other Cove projects - keep
electron-updater for detection + verified download (it checks sha512 from
latest-linux.yml during download), replace only the install step with an
atomic in-place file swap. No child process is spawned, so AppImageLauncher
has nothing to intercept. New version takes effect on next launch; the AIL
shortcut keeps pointing at the same path.

## Scope (files changed)

| File | Change |
|------|--------|
| `electron/appimage-updater.ts` | new - `installAppImageUpdate(downloadedFile, appImagePath)`: exclusive-create copy (random staging name + COPYFILE_EXCL, no symlink following) into the target dir (avoids EXDEV across mounts), chmod 755, fsync staged file, atomic rename over the AppImage path, fsync parent dir (crash durability), staging cleanup on any failure, best-effort cache cleanup on success |
| `electron/main.ts` | packaged Linux AppImage runs (`process.env.APPIMAGE` set): `autoDownload = true`, `autoInstallOnAppQuit = false` (blocks the broken doInstall on quit), `update-available`/`update-downloaded`/`error` handlers plus the `checkForUpdates()` catch all send `cove:update-event` IPC via module-level `sendUpdateEvent`; last event is buffered in `lastUpdateEvent` and replayed on `did-finish-load` (same pattern as `lastReadyPayload`) so a fast result can't be dropped before the renderer subscribes; all other platforms keep the previous `checkForUpdatesAndNotify()` path verbatim |
| `electron/types.ts` | `UpdateEvent` union (downloading / installed / error) + `onUpdateEvent` on `CoveApi` |
| `electron/preload.ts` | `onUpdateEvent` bridge on `cove:update-event` |
| `src/types.ts` | re-export `UpdateEvent` |
| `src/App.tsx` | subscribe to update events, surface via v3.2.0 toast system (info: downloading, success: installed / restart to apply, warning: failed) + log panel entries - update failures are never silent again |

## Design decisions

- Install-on-next-launch, no auto-relaunch: a forced restart could kill an
  active recording; the swap is complete once the toast shows.
- The rename is same-directory and atomic; the running process keeps the old
  inode, so the mounted AppImage is unaffected mid-session.
- On install failure the downloaded cache file is kept (retry next launch);
  the staging file is always removed.
- `autoInstallOnAppQuit = false` is load-bearing: default true would re-enter
  the broken AppImageUpdater.doInstall path on quit.

## Out of scope

- No appimageupdatetool bundling (proposed API does not exist in
  electron-builder/electron-updater 6.3.9 - verified by grep of node_modules).
- No Windows/deb behavior change.
- No new dependencies.

## Verification

- `npm run typecheck` - PASS (renderer + electron + validation tsconfigs)
- `npm run build:electron` - PASS (dist-electron/appimage-updater.js emitted)
- `npm run build:renderer` - PASS
- Smoke test of the compiled installer - ALL PASS (10/10 checks):
  script: /tmp/claude-1000/-home-sin-Projects-cove-screen-recorder/71b10409-bb86-4f21-8aed-1a0073a43bc9/scratchpad/smoke-appimage-updater.js
  covers: content swap, exec bit restored (AIL can drop it), cache cleanup,
  no staging residue, old inode still readable via open fd (running-app
  safety), missing-download throws with target untouched, rename failure
  throws with staging cleaned and download kept.
