# Gate Abort: SHM Fallback

## Trigger
Per VAL-CAP-006 standalone retest procedure step 7:
> If SHM fallback appears: STOP. Write NOT ATTEMPTED.

## Evidence
engine-log.txt line 1019-1020:
```
PW stream errored during DMA-BUF-only negotiation: no more input formats; triggering SHM-only fallback retry
PW: DMA-BUF negotiation hard-failed; reconnecting with SHM-only fallback
```

Portal session: pw-session-0000-1187898-1779512250870
Timestamp: 2026-05-23T04:57:30.878244Z
Helper PID: 1187898

## Systemic Pattern
DMA-BUF negotiation hard-fails on EVERY portal session in the engine-log.txt (1021 lines),
spanning three helper instances (PIDs 1057119, 1158597, 1187898) across >10 hours.
No single DMA-BUF session has ever succeeded on this system.

Hardware: NVIDIA GeForce RTX 4080 Super
Driver: 595.71.05 (CUDA 13.2)
Compositor: KDE Plasma Wayland (kwin_wayland)
Portal: xdg-desktop-portal-kde

## Consequence
The ISS-011 triage question — "is the frame deficit an environment artifact from SHM fallback
or a real capture defect under DMA-BUF?" — cannot be answered on this hardware.
DMA-BUF conditions cannot be established.
