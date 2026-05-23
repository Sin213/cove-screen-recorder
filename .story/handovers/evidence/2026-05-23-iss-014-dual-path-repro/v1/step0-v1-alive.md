# Step 0 Gate — V1 Alive Check

**Result: V1 IS ALIVE**

## Evidence

- `~/.config/Cove Screen Recorder/recordings/rec_mpiwuepz_umc298.webm` — present, 73.7 MB (active buffer still writing at check time)
- V1 MediaRecorder path confirmed active: app logs show `codec=vp8`, `saveReplay start (v1)`, `replay save: using libx264`
- v2State: `RECOVERY_AVAILABLE` throughout (no V2 capture active)

## App Mode at Test Time

- npm run dev started WITHOUT `VITE_COVE_V2_UI=1` → `v2UiEnabled = false`
- V1 MediaRecorder path is active
- Helper engine running but not capturing (health pings only)

## V1 Degenerate Condition: NOT MET

Prior passes saw 0-1B webm stubs because those runs had the V2 UI enabled (or no replay buffer was started before saving). With V1 mode active and a buffer started, the webm is non-empty.

**Conclusion: Proceed with full V1 repro leg.**
