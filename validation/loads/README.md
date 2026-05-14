# Validation Loads — T-010b

Synthetic assets and operator procedures for the cove-screen-recorder v2.0.0
validation matrix (N-008 §5).

These loads are used by validation rows in the §22 smoke suite (T-010a) and the
full RC matrix. They are not shipped in the app build.

---

## Load index

| Load | Type | Scripts | Validation rows |
|------|------|---------|-----------------|
| [L-MOTION-60](#l-motion-60) | Scripted | HTML + launcher | VAL-CAP-004, VAL-EXP-010, VAL-REG-002 |
| [L-STATIC](#l-static) | Scripted | HTML + launcher | supporting evidence (no direct row) |
| [L-CHANGE](#l-change) | Scripted | HTML + launcher | supporting evidence (no direct row) |
| [L-DISK-SLOW](#l-disk-slow) | Scripted (root) | setup/teardown | supporting evidence (no direct row) |
| [L-DISK-FULL](#l-disk-full) | Scripted (root) | setup/teardown | supporting evidence (no direct row) |
| [L-CRASH-CAP](#l-crash-cap) | Scripted | crash.sh | supporting evidence (no direct row) |
| [L-CRASH-EXP](#l-crash-exp) | Scripted | crash.sh | supporting evidence (no direct row) |
| [L-RESIZE](#l-resize) | Manual | — | supporting evidence (no direct row) |
| [L-MINIMIZE](#l-minimize) | Manual | — | VAL-CAP-006 |
| [L-PORTAL-DENY](#l-portal-deny) | Manual | — | VAL-CAP-003 |
| [L-SOURCE-REMOVE](#l-source-remove) | Manual + scripted | close.sh | supporting evidence (no direct row) |
| [L-COMP-PAUSE](#l-comp-pause) | Manual | — | supporting evidence (no direct row) |

---

## L-MOTION-60

**Fullscreen 60fps horizontal scroll with binary frame counter.**

Load-bearing load. Required for:

- **VAL-CAP-004**: 1080p60 monitor capture (60 s L-MOTION-60 NVENC — drop and cadence gates).
- **VAL-EXP-010**: No fake duplicated frames in exported MP4 (ffprobe PTS walk).
- **VAL-REG-002**: Fake-60fps gate re-run confirms no duplicated PTS (N-008 §6.1).

### Binary frame counter protocol

24-bit unsigned counter encoded as 8×8 pixel blocks at pixels [0,0]–[191,7].

- White block (luma ≥128) = bit 1; black block (luma <128) = bit 0.
- MSB first (bit 23 at x=0).
- Counter value: `Math.round((rAF_timestamp - startTime) × 60 / 1000)`
- Time-based, not rAF-count-based — correct cadence on 144Hz displays.
- Block size (8×8) aligns with H.264 DCT for compression robustness.

Full protocol spec: `l-motion-60/README.md`

### Running

```bash
cd validation/loads/l-motion-60
chmod +x launch.sh
./launch.sh           # Wayland
./launch.sh --x11     # X11 fallback
```

---

## L-STATIC

**Nearly-still fullscreen page with 1Hz blink.**

Tests stable capture on a low-motion source.

```bash
cd validation/loads/l-static
chmod +x launch.sh && ./launch.sh
```

---

## L-CHANGE

**15s cycle: 5s static → 5s motion → 5s static (repeating).**

Tests encoder behavior on sudden content-complexity transitions.

```bash
cd validation/loads/l-change
chmod +x launch.sh && ./launch.sh
```

---

## L-DISK-SLOW

**Throttled disk (~50 MB/s) via Linux dm-delay kernel module.**

Tests capture stability under I/O pressure.

```bash
sudo ./l-disk-slow/setup.sh
# setup prints the actual mountpoint — configure the app to use it
# … run capture session …
sudo ./l-disk-slow/teardown.sh
```

Requires root and the `dm-delay` kernel module. Linux only.

---

## L-DISK-FULL

**200 MiB tmpfs segment directory that fills quickly.**

Tests the app's disk-full handling and user-visible error state.

```bash
sudo ./l-disk-full/setup.sh
# setup prints the actual mountpoint — configure the app to use it
# … run capture session until full …
sudo ./l-disk-full/teardown.sh
```

Requires root. Linux only.

---

## L-CRASH-CAP

**Kills cove-replay-engine mid-capture via SIGKILL.**

Tests that the app detects helper death and surfaces an error (not a hang).

```bash
# In another terminal while a capture session is running:
./l-crash-cap/crash.sh
```

---

## L-CRASH-EXP

**Kills cove-replay-engine mid-export via SIGKILL.**

Tests that the app handles helper death during export without producing a corrupt file.

```bash
# In another terminal while an export is in progress (within first 5s):
./l-crash-exp/crash.sh
```

---

## L-RESIZE

Manual. Resize the source window multiple times during an active capture session.
See `l-resize/README.md` for the full procedure.

---

## L-MINIMIZE

Manual. Minimize and restore the source window multiple times during capture.
See `l-minimize/README.md`.

---

## L-PORTAL-DENY

Manual. Deny the XDG Desktop Portal screen-share permission request.
Compositor-specific procedure in `l-portal-deny/README.md`.

---

## L-SOURCE-REMOVE

Manual (preferred) or scripted fallback. Close the source window during an active
capture session. See `l-source-remove/README.md`.

Scripted fallback (requires `wmctrl`):
```bash
./l-source-remove/close.sh "Window Title Substring"
```

---

## L-COMP-PAUSE

Manual. Suspend/resume compositor compositing during an active capture session.
Compositor-specific procedure (KDE / GNOME / Sway) in `l-comp-pause/README.md`.

---

## Script permissions

After cloning or checking out, make scripts executable:

```bash
find validation/loads -name '*.sh' -exec chmod +x {} \;
```

## Integration status

These loads are in **dry-run state**. The validation runner (T-010a) skips all
scripted-local rows with `reason: helper-not-available` until the v2 helper IPC
socket is present (T-010c). The loads themselves are complete and ready for manual
use.
