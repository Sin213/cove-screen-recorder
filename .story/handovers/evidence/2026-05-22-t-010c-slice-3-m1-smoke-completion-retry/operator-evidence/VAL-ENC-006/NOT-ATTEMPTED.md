Row: VAL-ENC-006
Status: NOT ATTEMPTED (slice-3 retry pass)
Reason: Must-pass blocker ISS-009 (v2 UI gate disables Start replay buffer under v2State=RECOVERY_AVAILABLE) fires before VAL-CAP-001 — first row in the slice order — and per failure-handling all later rows are not advanced.
Blocker analysis (repo-relative): .story/handovers/evidence/2026-05-22-t-010c-slice-3-m1-smoke-completion-retry/blocker-VAL-CAP-001/analysis.md
Issue: ISS-009
