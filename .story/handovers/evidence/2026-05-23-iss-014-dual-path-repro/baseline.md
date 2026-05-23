# ISS-014 Dual-Path Repro — Baseline

**Date:** 2026-05-23
**Pass:** controlled dual-path attribution (T-030)
**App state at pass start:** npm run dev running (PID 1446827/1446834), helper engine active (PID 1446895), engine IDLE (health-only pings)

## GPU

```
NVIDIA GeForce RTX 4080 SUPER, driver 595.71.05, 16376 MiB, compute cap 8.9
```

## Monitor (kscreen-doctor -o)

```
Output: 1 DP-4
  enabled, connected, priority 1, DisplayPort
  Modes:
    1:3840x2160@60.00
    2:3840x2160@239.99  ← CURRENT (*)
    3:3840x2160@180.00
    4:3840x2160@120.00
    5:2560x1440@239.85
    6:2560x1440@120.00
    7:2560x1440@59.95
    8:1920x1080@239.88
    9:1920x1080@119.93
    10:1920x1080@119.88
    11:1920x1080@60.00
  Scale: 1.45, Rotation: 1, VRR: Never, HDR: enabled
```

## ffmpeg / ffprobe

```
ffmpeg version n8.1.1
ffprobe version n8.1.1
libavcodec 62.28.101 / libavutil 60.26.101
```

## Config Directory

Active: `~/.config/Cove Screen Recorder/` (capital letters, space)
Also present: `~/.config/cove-screen-recorder/` (lowercase — no logs/, no active singleton)

## Instrumentation Verification

| Instrument | Location | Status |
|------------|----------|--------|
| `[iss-014][encode-boundary]` (T-031) | `target/debug/cove-replay-engine` (built 2026-05-23 12:12:40 PDT) | **CONFIRMED** (strings grep match) |
| `[iss-014][provenance]` (T-032) | `dist-electron/ffmpeg.js` | **CONFIRMED** (grep match) |

## Engine Log State at Pass Start

Engine restarted at 20:41:11 UTC. Since restart: health-check pings only. No capture, no encode, no replay activity.
Log: `~/.config/Cove Screen Recorder/logs/engine.log` (898KB total, fresh session tail is health-only)
Export lifecycle log: `~/.config/Cove Screen Recorder/logs/export-lifecycle.log` (8KB, last entry 17:45:57 UTC)

## Recordings Directory

`~/.config/Cove Screen Recorder/recordings/`: **EMPTY** (no webm files present)

## Runtime Directory

`/run/user/1000/cove-screen-recorder/`:
- `exports/`: 10 MP4 files (from prior V2 sessions, last: exp-1779558352913925351-0011.mp4, 161MB)
- `segments/`: 10 session directories
- `engine.sock`: active
