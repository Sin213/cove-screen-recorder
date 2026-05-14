# L-DISK-SLOW — Throttled Disk Load

Throttles the segment write directory to ~50 MB/s using the Linux `dm-delay` kernel module.

## Validation context

No canonical smoke-suite row targets disk I/O pressure directly.
(`VAL-PROC-001`, `VAL-PROC-002`, `VAL-PROC-003` are process-cleanup rows,
not disk-pressure rows.) This load is operator supporting evidence: use the
throttled mount during a full capture-and-export run to verify segments and
exports complete correctly under sustained write pressure.

## Operator procedure

1. **Setup** (requires root):
   ```bash
   sudo ./setup.sh
   ```
   Creates a loopback device, applies dm-delay at 20ms per I/O (~50 MB/s), formats ext4,
   and mounts it at a secure private path. The actual mountpoint is printed on success:
   ```
   [L-DISK-SLOW] Configure cove-screen-recorder to write segments to: /tmp/cove_slow.XXXXXXXXXX/mount
   ```

2. **Configure the app** to write segments to the mountpoint path printed above.

3. **Run a capture session** — at least 60 seconds, using L-MOTION-60 as the source.

4. **Export** — verify export completes without error.

5. **Teardown** (requires root):
   ```bash
   sudo ./teardown.sh
   ```
   Reads the mountpoint from the state file at `/run/cove-disk-slow.state`; no path argument needed.

## Requirements

- Linux kernel with dm-delay module (`modprobe dm-delay`)
- `dmsetup` installed (`device-mapper` package)
- Root access
- NOT supported on macOS or Windows

## Expected outcome

- Capture runs without crash or hang.
- Segments are written (possibly with queue delay).
- Export produces a valid MP4.
- App does not show a disk-full or I/O-error state.
