## Cove Screen Recorder 3.3.1

This is a bug fix release focused on audio reliability and gallery error handling.

### Fixed

- System audio recording no longer fails the entire capture when the OS refuses to open the loopback endpoint on a particular output device. Some vendor headset endpoints simply never support loopback capture. Cove now retries with progressively looser audio constraints, and falls back to video-only recording if none succeed, with a warning toast so you know audio was dropped instead of the recording failing outright.
- Gallery delete failures now show the actual error message instead of failing silently, for both single-card and bulk delete.
- Output directories starting with `~` (for example `~/Videos`) now resolve correctly for delete and clipboard-copy operations instead of failing every path check.

### Downloads

Every artifact ships with a matching `.sha256` sidecar. Verify a download with:

```bash
sha256sum -c Cove-Screen-Recorder-3.3.1-x86_64.AppImage.sha256
```
