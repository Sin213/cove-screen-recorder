# Cove Screen Recorder v1.0.0

First public release. Pick a region, hit record, save an MP4 — or a one-click 10-second GIF. Wayland and X11 on Linux, Windows 10/11. No telemetry.

![Cove Screen Recorder mid-recording](screenshot.webp)

## Highlights

- **Three capture modes** — Crop (drag-to-select region), Screen (full monitor), Window (pick an app)
- **Three presets** — Regular (1080p · 30 fps · ~6 Mbps · MP4), Gaming (1080p · 60 fps · ~16 Mbps · MP4), GIF (10 s · 15 fps · palette-optimised)
- **GPU-aware encoding** — detects vendor at startup and picks the right encoder first (NVENC on NVIDIA, AMF on AMD, QSV on Intel). Iterates through remaining HW encoders before falling back to `libx264` software, so a recording is never lost
- **Live preview** during recording — see exactly the frames being saved (post-crop pixels for region mode)
- **System audio + microphone**, both on by default
  - **Linux:** clean stereo through a parallel ffmpeg PulseAudio sidecar (FLAC intermediate, AAC mux at finalize, single lossy generation)
  - **Windows:** Chromium WASAPI loopback with WebRTC's voice DSP (AGC / noise suppression / echo cancellation) explicitly disabled so music isn't mangled
- **Customisable global hotkeys** — bind any combo for toggle / quick-GIF; defaults `Ctrl+Shift+R` and `Ctrl+Shift+G`, `Esc` to stop
- **Wayland-native** — single xdg-desktop-portal prompt per recording, no double-dialog regression
- **Verifiable releases** — every artifact below ships with a `.sha256` sidecar

## Downloads

| Platform | File | Size | SHA256 |
|---|---|---|---|
| Linux (universal) | `Cove-Screen-Recorder-1.0.0-x86_64.AppImage` | 106 MB | `29a320bdad34069ef8847c4200dffbe6fd986478b2270a30d4202c4506d45f56` |
| Debian / Ubuntu | `Cove-Screen-Recorder-1.0.0-amd64.deb` | 73 MB | `6a68e9123a9bb3cfd335b93be298a30c349ac73abcc82c429e19507180dc5221` |
| Windows installer | `Cove-Screen-Recorder-1.0.0-Setup.exe` | 104 MB | `46c61f9034ad1f1bc6562f395b2ad3db72de8871231019b9efbe80b5154ae5fc` |
| Windows portable | `Cove-Screen-Recorder-1.0.0-Portable.exe` | 104 MB | `6df6085db84986f5ffe739408d107eecaf6223eff766a557576cfcf7b0f890c9` |

Verify any download:

```bash
sha256sum -c Cove-Screen-Recorder-1.0.0-x86_64.AppImage.sha256
# Cove-Screen-Recorder-1.0.0-x86_64.AppImage: OK
```

## Install notes

**Linux (AppImage)** — `chmod +x` then run. AppImage users still need ffmpeg on `PATH` (`apt install ffmpeg` / `pacman -S ffmpeg` / `dnf install ffmpeg`). The deb pulls it in automatically.

**Linux (deb)** — `sudo dpkg -i Cove-Screen-Recorder-1.0.0-amd64.deb && sudo apt -f install`. ffmpeg + display-portal + PipeWire deps land via `Depends`.

**Windows installer** — per-user NSIS installer with optional install dir. Bundles `ffmpeg.exe` so MP4/GIF output works out of the box. If a system-wide ffmpeg is on `PATH`, it takes priority over the bundled copy.

**Windows portable** — single self-contained exe, no install required. Same bundled ffmpeg.

> Windows installer + portable are unsigned. SmartScreen will warn on first launch — click **More info → Run anyway**. We'll sign once a code-signing cert is in place.

## Requirements

- **Linux:** PipeWire or PulseAudio for system-audio capture; `xdg-desktop-portal-{kde,gnome,wlr}` for Wayland screen capture (any modern distro ships these)
- **Windows:** 10 or 11; bundled ffmpeg covers everything else

## Hotkeys

| Action | Default | Notes |
|---|---|---|
| Toggle default capture | `Ctrl+Shift+R` | Records using the action you last clicked (Crop / Screen / Window) |
| Crop GIF | `Ctrl+Shift+G` | Always opens crop selection, always uses the GIF preset |
| Stop | `Esc` | Built-in, not customisable |

Bindings are user-customisable — the **Customize** chip in the footer opens a key-capture dialog. Combos require at least one modifier.

## Output

Files land in `~/Videos/Cove Recordings/` by default. Filename pattern: `Cove_YYYY-MM-DD_HHMMSS_NNN.{mp4,webm,gif}` — millisecond suffix means back-to-back recordings never overwrite. Tildes typed in the output-folder field are expanded automatically.

## Build from source

```bash
git clone <repo-url>
cd cove-screen-recorder
npm install
npm run dev               # Vite + Electron, hot reload
npm run typecheck

# Production builds — outputs land in release/ alongside .sha256 sidecars
npm run dist:linux        # AppImage
npm run dist:linux:full   # AppImage + deb
npm run dist:win          # NSIS installer + portable .exe
npm run dist:win:portable # portable only
```

For Windows builds, drop a copy of `ffmpeg.exe` at `vendor/win/ffmpeg.exe` first — the README has a one-liner for fetching the [GyanD essentials build](https://github.com/GyanD/codexffmpeg/releases).

## License

MIT
