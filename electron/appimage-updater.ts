// Custom AppImage update install (issue #9).
//
// electron-updater's built-in AppImageUpdater.doInstall() finishes an update
// by launching the new AppImage via execFileSync. When AppImageLauncher is
// installed it intercepts that exec (binfmt handler), the child exits before
// the handshake completes, and Node throws EPIPE - the update silently never
// happens. electron-updater is still used for detection and download (it
// verifies the sha512 from latest-linux.yml during download); this module
// replaces only the install step: swap the file on disk in place.
//
// The running process keeps the old inode (rename is atomic), the
// AppImageLauncher shortcut keeps pointing at the same path, and the new
// version takes effect on the next launch. No child process is spawned, so
// there is nothing for AppImageLauncher to intercept.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function fsyncPath(p: string): void {
  const fd = fs.openSync(p, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function installAppImageUpdate(downloadedFile: string, appImagePath: string): void {
  const dir = path.dirname(appImagePath);
  // Unpredictable staging name + exclusive create: COPYFILE_EXCL fails if
  // anything (including a planted symlink) already sits at the staging path,
  // so the updater only ever writes a file it created itself.
  const staging = path.join(
    dir,
    `.${path.basename(appImagePath)}.update-${crypto.randomBytes(8).toString("hex")}`,
  );
  // Copy into the target directory first: the updater cache may live on a
  // different filesystem, and rename() across mounts fails with EXDEV. A
  // same-directory rename is atomic, so the AppImage path always holds
  // either the complete old or the complete new file.
  try {
    fs.copyFileSync(downloadedFile, staging, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(staging, 0o755);
    // Make the staged contents durable before the swap, and the rename
    // durable after it, so a crash or power loss can't leave the AppImage
    // path pointing at an incomplete replacement after we report success.
    fsyncPath(staging);
    fs.renameSync(staging, appImagePath);
  } catch (err) {
    try { fs.unlinkSync(staging); } catch { /* best effort */ }
    throw err;
  }
  // The rename is committed; a failed directory flush is a durability risk,
  // not a failed install, so it must not be reported as one.
  try {
    fsyncPath(dir);
  } catch (err) {
    console.warn("appimage update: directory fsync failed:", err);
  }
  try { fs.unlinkSync(downloadedFile); } catch { /* cache cleanup, best effort */ }
}
