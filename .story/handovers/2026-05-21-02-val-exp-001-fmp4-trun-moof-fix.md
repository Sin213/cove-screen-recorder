# VAL-EXP-001 fMP4 trun/moof Fix

**Date:** 2026-05-21
**Issue:** ISS-006
**Repo:** /home/sin/Projects/cove-screen-recorder
**Branch:** main
**HEAD at start:** fea7e34

---

## 1. Context

Rerun 19 confirmed:
- VAL-CAP-004: GREEN
- VAL-SEG-003: GREEN
- init.mp4: exists (664 bytes), init_segment_bytes: 664
- VAL-EXP-001: FAIL — ffmpeg exit 183 "Invalid data found when processing input"

Root cause identified: fMP4 fragments emitted by `fmp4.rs` have two defects:
1. trun ver+flags wrote `00 0F 01 00` (flags=0x0F0100) instead of `00 00 07 05` (flags=0x000705)
2. `compute_moof_size()` returned 100 but actual moof is 104 because tfdt is version=1 with 8-byte baseMediaDecodeTime (20 bytes, not 16)

This caused data_offset to be 108 instead of 112.

---

## 2. Files Changed

- `helper/src/encoder/backends/nvenc/fmp4.rs` — only file changed

Changes:
1. trun flags: `&[0x0f, 0x01, 0x00]` → `&[0x00, 0x07, 0x05]`
2. `compute_moof_size()`: 100 → 104
3. Comments updated: tfdt v1 = 20 bytes, traf = 80 bytes, moof = 104 bytes
4. Added 3 new tests + 2 helper functions (`find_box`, `find_box_nested`)

---

## 3. Tests Added

- `trun_ver_flags_is_000705` — asserts trun ver+flags bytes are `00 00 07 05`
- `trun_data_offset_equals_moof_size_plus_8` — asserts data_offset == moof_size + 8 (mdat header)
- `compute_moof_size_matches_actual` — asserts `compute_moof_size()` equals the actual built moof box size

All three would fail against the old values (0x0F0100 / 100 / 108).

---

## 4. Verification Results

```
cargo test -p cove-replay-engine --lib encoder::backends::nvenc::fmp4  → 5 passed (2 existing + 3 new)
cargo test -p cove-replay-engine --test encoder_session                → 28 passed
cargo test -p cove-replay-engine --test segment_buffer                 → 7 passed
cargo build -p cove-replay-engine                                      → 0 errors, 70 pre-existing warnings
npm run typecheck                                                      → PASS
npm run validate:build                                                 → PASS
npm run build                                                          → PASS
git diff --check                                                       → PASS (exit 0)
git status --short                                                     → M helper/src/encoder/backends/nvenc/fmp4.rs
```

---

## 5. Untouched Files Confirmation

- helper/src/export/mod.rs — NOT changed
- helper/src/capture/** — NOT changed
- helper/src/encoder/backends/nvenc/mod.rs — NOT changed
- helper/src/encoder/session.rs — NOT changed
- helper/src/segment/buffer.rs — NOT changed
- validation/** — NOT changed
- electron/** — NOT changed
- src/** — NOT changed

---

## 6. Next Steps

1. Codex review approval of this source patch
2. Commit source fix (after approval)
3. Smoke rerun 20 to verify VAL-EXP-001
4. Only after VAL-EXP-001 greens: green T-021 and unblock T-010c

Do not start T-010c. Do not green T-021.