# L-CHANGE — Complexity-Transition Load

A 15-second looping cycle: 5s static → 5s smooth motion → 5s static.

## Validation context

No canonical smoke-suite row targets content-complexity transitions directly.
(`VAL-ENC-001` is specifically NVENC probe caching, not encoding stability.)
This load is operator supporting evidence: run it as the capture source during
any NVENC encoder row (VAL-ENC-001, VAL-ENC-006) to verify the encoder and
segment writer handle sudden bitrate transitions without crash or corruption.

## Launch

```bash
cd validation/loads/l-change
chmod +x launch.sh
./launch.sh          # Wayland
./launch.sh --x11    # X11 fallback
```

## Purpose

Tests that the encoder and segment writer tolerate sudden bitrate changes.
The transition from static to 60fps motion can cause GOP boundary decisions,
reference frame changes, and a sudden increase in I-frame size. Any crash,
hang, or corrupted segment during the transition is a test failure.

## Cycle

| Phase    | Duration | Content |
|----------|----------|---------|
| STATIC-1 | 5s       | Dark background, label only |
| MOTION   | 5s       | Scrolling stripes, cyan bar |
| STATIC-2 | 5s       | Same as STATIC-1 |

The cycle repeats continuously until the browser window is closed.
