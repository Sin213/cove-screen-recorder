# L-DISK-FULL — Disk-Full Stress Load

Mounts a 200 MiB tmpfs as the segment directory so it fills quickly.

## Validation context

No canonical smoke-suite row targets the disk-full condition directly.
(`VAL-PROC-002` is "no leftover processes after RECORDING stop"; `VAL-PROC-007`
is "pactl never appears in process tree" — neither is a disk-pressure check.)
This load is operator supporting evidence: use it to verify the app surfaces a
user-visible error and does not crash or hang when the segment directory fills.

## Operator procedure

1. **Setup** (requires root):
   ```bash
   sudo ./setup.sh
   ```
   Mounts a 200 MiB tmpfs at a secure private path. The actual mountpoint is printed on success:
   ```
   [L-DISK-FULL] Configure cove-screen-recorder to write segments to: /tmp/cove_full.XXXXXXXXXX/mount
   ```

2. **Configure the app** to write segments to the mountpoint path printed above.

3. **Run a capture session** using L-MOTION-60 as the source. At 60fps H.264, 200 MiB fills in roughly 30–90 seconds depending on content bitrate.

4. **Observe**: The app should surface a disk-full error in the UI — not crash, not hang silently.

5. **Teardown** (requires root):
   ```bash
   sudo ./teardown.sh
   ```
   Reads the mountpoint from the state file at `/run/cove-disk-full.state`; no path argument needed.

## Requirements

- Linux (any distro with tmpfs support)
- Root access
- NOT supported on macOS or Windows

## Expected outcome

- App detects the disk-full condition.
- User-visible error message is displayed.
- App does not crash or produce a corrupt partial segment.
- After teardown and reconfiguration, a new capture session can start cleanly.
