# L-STATIC — Static Validation Load

A nearly-still fullscreen page with a 1Hz blink indicator.

## Validation context

No canonical smoke-suite row targets static-source stability directly.
This load is operator supporting evidence: use it as the content source when
running VAL-CAP-001 (sessionReady) or VAL-CAP-004 (NVENC 60 s capture) to
verify the encoder and session machinery work on a near-zero-motion input.

## Launch

```bash
cd validation/loads/l-static
chmod +x launch.sh
./launch.sh          # Wayland
./launch.sh --x11    # X11 fallback
```

## Purpose

Tests that the encoder handles near-zero motion without producing corrupted output,
excessive bitrate spikes, or application errors. The 1Hz blink ensures there is at
least one motion event per second so the encoder is not given a completely frozen input.
