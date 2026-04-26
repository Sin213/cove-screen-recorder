# Cove Screen Recorder

A small, fast, hardware-accelerated desktop screen recorder. Pick a region, screen, or window, hit record, get an MP4 — or a 10-second GIF in one click. Wayland and X11 on Linux, Windows 10/11 supported.

![Cove Screen Recorder mid-recording, with mpv playing alongside](screenshot.webp)

## Features

- **Three capture modes** — Crop (drag-to-select region), Screen (full monitor), Window (pick an app)
- **Three presets** — Regular (1080p · 30 fps · ~6 Mbps · MP4), Gaming (1080p · 60 fps · ~12 Mbps · MP4), GIF (10 s · 15 fps · palette-optimised)
- **GPU-aware hardware encoding** — detects vendor at startup and picks the matching encoder first (NVENC on NVIDIA, AMF on AMD, QSV on Intel). Iterates through remaining HW encoders before falling back to `libx264` software, so a recording is never lost
- **Live preview** during recording — see exactly the frames being saved (post-crop pixels for region mode)
- **System audio + microphone** — independent toggles, on by default. On Linux, system audio is captured via a parallel ffmpeg PulseAudio sidecar (clean stereo, full volume) and mixed onto the video at finalize. On Windows, Chromium's WASAPI loopback captures it inline with WebRTC's voice-tuned audio chain (AGC / noise suppression / echo cancellation) explicitly disabled so music isn't mangled.
- **Customisable global hotkeys** — bind any combo for toggle / quick-GIF; defaults are `Ctrl+Shift+R` and `Ctrl+Shift+G`, `Esc` to stop
- **Wayland-native** — single xdg-desktop-portal prompt per recording (no double-dialog regression)
- **Cross-platform** — Linux (AppImage / deb), Windows (Setup + Portable). No telemetry.
- **Verifiable releases** — every published binary ships with a `.sha256` sidecar

## Install

### Linux — AppImage

```bash
chmod +x Cove-Screen-Recorder-1.0.0-x86_64.AppImage
./Cove-Screen-Recorder-1.0.0-x86_64.AppImage
```

### Linux — Debian / Ubuntu

```bash
sudo dpkg -i Cove-Screen-Recorder-1.0.0-amd64.deb
sudo apt -f install   # if dependencies are missing
```

The deb declares `ffmpeg` as a dependency, so `apt` pulls it in automatically.

### Windows

- `Cove-Screen-Recorder-1.0.0-Setup.exe` — NSIS installer (per-user, optional install dir)
- `Cove-Screen-Recorder-1.0.0-Portable.exe` — single-file portable, no install required

The Windows installer ships with a bundled `ffmpeg.exe`, so MP4 / GIF output works out of the box. If a system-wide `ffmpeg` is on `PATH` it takes priority.

### Verify the download

Each artifact has a `<filename>.sha256` sidecar published next to it. Verify with:

```bash
sha256sum -c Cove-Screen-Recorder-1.0.0-x86_64.AppImage.sha256
# Cove-Screen-Recorder-1.0.0-x86_64.AppImage: OK
```

## Runtime requirements

| Component | Required for | How to install |
|---|---|---|
| `ffmpeg` on `PATH` | MP4 / GIF output | The Windows installer / portable both bundle it. The deb pulls it in via `Depends`. AppImage users: `sudo apt install ffmpeg` / `sudo pacman -S ffmpeg`. System ffmpeg always wins over the bundled copy if both exist. |
| `xdg-desktop-portal` + a backend | Wayland screen capture | `xdg-desktop-portal-kde` on KDE, `xdg-desktop-portal-gnome` on GNOME, `xdg-desktop-portal-wlr` on wlroots |
| `pipewire` + `pulseaudio` (or `pipewire-pulse`) | Linux system audio | Ships by default on every modern distro; Cove uses `pactl` + ffmpeg's `libpulse` input |

If `ffmpeg` is missing the recording falls back to a raw `.webm` and a warning is shown.

## Usage

1. Click **Crop**, **Screen**, or **Window** — that's it for normal use.
2. The toggle hotkey (default `Ctrl+Shift+R`) repeats whichever you last clicked. The GIF hotkey (default `Ctrl+Shift+G`) always crops + records a GIF.
3. `Esc` stops a recording. So does the OS "stop sharing" overlay on Wayland.

### Hotkeys

Click **Customize** in the bottom hint bar to rebind. Combos must include a modifier (Ctrl, Shift, Alt, or Super) — bare letters would steal global typing.

| Action | Default | Notes |
|---|---|---|
| Toggle default capture | `Ctrl+Shift+R` | Records using the action you last picked (Crop / Screen / Window) |
| Crop GIF | `Ctrl+Shift+G` | Always opens crop selection, always uses the GIF preset |
| Stop | `Esc` | Built-in, not customisable |

### Output

Files land in **~/Videos/Cove Recordings/** by default — change in the Output Folder field. Filename format: `Cove_YYYY-MM-DD_HHMMSS_NNN.{mp4,webm,gif}`. The `_NNN` is milliseconds so back-to-back recordings never overwrite. Tildes (`~/Videos/...`) are expanded automatically.

## Wayland notes

On Wayland the system portal owns source selection — clicking any of Crop / Screen / Window shows the same native dialog (KDE's "Share screen", GNOME's screen-share prompt, etc.) and lets you pick a monitor, window, or region from there. To avoid Electron's [classic double-prompt bug](https://github.com/electron/electron/issues/30652), Cove passes a placeholder source ID through `setDisplayMediaRequestHandler` and lets PipeWire drive the picker directly — exactly one prompt per recording.

The Cove drag-to-select overlay is only used on X11 / Windows. On Wayland, use the portal's **Share region** option for a region recording.

### Linux system audio

Chromium's `getDisplayMedia` doesn't deliver clean system audio on Wayland (the placeholder source ID workaround that gets us to one portal prompt also breaks audio negotiation). Cove side-channels system audio through a parallel ffmpeg process bound to PulseAudio's `<default-sink>.monitor`, then muxes the captured FLAC onto the video at finalize. Highlights:

- **Volume bumping** — PipeWire-Pulse can leave the monitor source's gain attenuated by default (we've seen 8% / -66 dB). Cove temporarily sets it to 100% during recording and restores the prior value on stop.
- **Lossless intermediate** — the sidecar writes FLAC, so the AAC encoding step at finalize is the only lossy generation in the pipeline.
- **Stereo + 48 kHz pinned** — `-ac 2 -ar 48000` is set explicitly to defeat ffmpeg builds that would otherwise default to mono.

If you have both microphone and system audio enabled, the two are mixed via ffmpeg's `amix` filter into a single stereo track.

## Build from source

Requires Node 20+ and `npm`. For Windows cross-builds you also need `wine` installed (electron-builder uses it for resource packing).

```bash
git clone <repo-url>
cd cove-screen-recorder
npm install
npm run dev               # Vite + Electron, hot reload
npm run typecheck         # tsc on renderer + main

# Production builds — outputs go to release/ alongside .sha256 sidecars
npm run dist:linux        # AppImage
npm run dist:linux:full   # AppImage + deb
npm run dist:win          # NSIS installer + portable .exe
npm run dist:win:portable # portable .exe only
npm run dist:sha          # regenerate SHA256 sidecars without rebuilding
```

### Bundling ffmpeg.exe (Windows builds only)

The Windows builds bundle `ffmpeg.exe` as `extraResources` so users don't have to install it themselves. Drop a copy at `vendor/win/ffmpeg.exe` before running `npm run dist:win` — the [GyanD essentials build](https://github.com/GyanD/codexffmpeg/releases) is what we ship:

```bash
mkdir -p vendor/win && cd vendor/win
curl -fL -o ffmpeg.zip "https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip"
unzip -j ffmpeg.zip "*/bin/ffmpeg.exe" -d .
rm ffmpeg.zip
```

`vendor/` is gitignored — the binary isn't committed.

## Stack

- Electron 32 · React 18 · TypeScript · Vite · Tailwind · Zustand
- Capture: `navigator.mediaDevices.getDisplayMedia` everywhere, routed through `setDisplayMediaRequestHandler`. Wayland uses a placeholder source ID to dodge the [classic double-prompt bug](https://github.com/electron/electron/issues/30652); X11/Windows pre-tells the handler which user-picked source to hand back, then `getDisplayMedia` triggers Chromium's `audio: "loopback"` for clean WASAPI-backed system audio
- Encode: `MediaRecorder` (VP9 / Opus 384k in WebM) → system or bundled `ffmpeg` remux to MP4 / GIF. Encoder candidates are GPU-vendor-filtered (NVENC dropped on AMD, AMF dropped on NVIDIA, etc.) and iterated on failure with `libx264` as the guaranteed software fallback

## Troubleshooting

**Wayland: I get two portal prompts.** That was the old bug; the current build issues exactly one. Make sure you're on a recent build and that `XDG_SESSION_TYPE=wayland` is set.

**Recording is mono / weird-sounding.**

*Linux:* the audio is pinned to stereo + 48 kHz and goes through a lossless FLAC intermediate. If your PipeWire setup still produces unusual audio, file an issue with `ffprobe Cove_*.mp4 | grep -E 'channels|sample_rate'` and your `pactl info` server line.

*Windows:* WebRTC's voice processing chain (auto-gain, noise suppression, echo cancellation) is disabled in the audio constraint, so music is captured raw. If you still hear pumping or smearing, double-check your playback device's "Default Format" in Windows Sound settings — set it to 24 bit 48 kHz stereo. Cove also requests stereo via the `channelCount` constraint; if Chromium still hands back mono, the diagnostic line will say `1ch@...` and the file will be 2-channel via mux upmix (centered, not true stereo).

**MP4 export is encoding on CPU even though I have a GPU.** Cove auto-picks the encoder matching your GPU vendor (`NVENC` for NVIDIA, `h264_amf` for AMD, `h264_qsv` for Intel). If you previously saw `Cannot load nvcuda.dll` failures and a `libx264` fallback on an AMD card, that's the problem — and it's fixed in the GPU-aware build. Look for `Saved → ...` *without* the `*_failed; saved with libx264 software encode.` warning. If you still see software fallback, file an issue with the full log so we can see which HW encoder failed first.

**MP4 export fails entirely.** Cove iterates through every viable encoder before giving up — the auto-picked HW encoder, then any remaining HW encoders, then `libx264`. If even libx264 fails, the temp `.webm` is **preserved** and its path is shown in the error so you can mux it manually with your own ffmpeg instead of losing the take.

**Recording is black / blank.** On Wayland, the source dialog must be the system portal — install the right `xdg-desktop-portal-*` backend for your DE.

**The hotkey does nothing.** Some compositors grab specific combos system-wide. Try a different combo via **Customize** (e.g. `Alt+Shift+R`).

**Wayland AppImage shows the generic Electron icon in the taskbar.** AppImages aren't registered with the desktop environment by default. Cove writes `~/.local/share/applications/cove-screen-recorder.desktop` + a copy of the icon under `~/.local/share/icons/hicolor/256x256/apps/` on first launch — you may need to log out and back in once for the cache to pick it up. If you'd rather avoid that, install the deb instead; it registers everything system-wide.

## License

MIT
