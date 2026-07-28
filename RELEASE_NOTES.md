## Cove Screen Recorder 3.3.0

This release focuses on managing your recordings without leaving the app.

### What's new

- **Recordings gallery.** Browse your saved recordings inline. Single-click selects a card, Ctrl or Shift click for multi-select, and double-click opens it.
- **In-app video player.** Plays MP4, WebM, and GIF directly inside Cove with native controls, so you no longer need an external media player just to check a clip.
- **Delete from the gallery.** Hover a card for a per-card delete button, or select several and delete them in bulk. Deleted files go to the OS trash or recycle bin, so a mis-click is recoverable.
- **Copy a recording to the clipboard.** Copies the actual video file, not just the path, so you can paste it straight into Discord, Slack, or Outlook.

### Fixed

- Video playback in the in-app player rendered as a narrow strip in the top-left corner with the rest of the player black. Video now fills the player, stays centred, keeps its aspect ratio, and rescales properly when you resize or maximise the window.
- Recordings whose filenames contain spaces, Unicode characters, `#`, `?`, or `%` failed to open in the player. These now load correctly. Windows drive paths are built correctly too.
- Empty or near-instant recordings failed with a cryptic ffmpeg exit code 183. A file-size guard now catches this early and shows a clear message instead.

### Downloads

Every artifact ships with a matching `.sha256` sidecar. Verify a download with:

```bash
sha256sum -c Cove-Screen-Recorder-3.3.0-x86_64.AppImage.sha256
```

### Thanks

Thanks to Qb for the suggestions, and to Whooshy for testing.
