# T-027 — Audit-safe `cannot-validate` policy + VAL-CAP-006 split (N-008 §26)

**Date:** 2026-05-23
**Scope:** Policy-only. IMPLEMENTATION ONLY. No runtime/capture/export/threshold/runner change. Prior context: ISS-011 (see issue + prior T-010c retry-2 handover/evidence — not restated here).

## What changed
- **T-027 created** (p4-release, task): the audit-safe validation-policy update. Status: open.
- **T-028 created** (p4-release, task): follow-up — AMD/Intel VAL-CAP-006b zero-copy declared-frame-count validation on DMA-BUF hardware (M2 VAAPI / M3 QSV). Status: open.
- **N-008 patched additively** (new §26; +8774 chars; two surgical insertions; §6.1 byte-identical; updatedDate→2026-05-23).
- **ISS-011 updated**: appended `DISPOSITION (2026-05-23)`; relatedTickets now `T-010c, T-027, T-028`; status stays `inprogress`; resolution stays null.

## N-008 policy deltas (all in new §26; existing §1–§25 + Summary unchanged)
- §26.1 disposition taxonomy: **pass / fail / cannot-validate** (no formal `blocked` — wording does not require it).
- §26.2 cannot-validate = complete evidence-backed precondition-unavailable; neither passed nor failed; never green; never satisfies §24; parks the cell.
- §26.3 anti-abuse: cannot-validate **strictly narrower** than fail; incomplete/ambiguous/unsupported predicate ⇒ fall back to normal pass/fail.
- §26.4 platform predicate (all three required): `gpuInfo` starts `"nvidia:"`; Wayland+KDE evidence; helper session log shows DMA-BUF negotiation failure + SHM fallback.
- §26.5 §24 guard: manual row-level adjudication beats suite-level automated aggregation; skip-only / skip+pass summary is **not** gate-green.
- §26.6 VAL-CAP-006 split: **006a** (minimised/occluded survival + HUD increments [ISS-011 leg 2, passed] + valid playable output — Issue #3 proof; existing §16/§17/§22 refs resolve here) / **006b** (declared frame-count tolerance under zero-copy DMA-BUF — ISS-011 leg 1, failed under SHM; §6.1 ±1 unchanged).
- §26.7 ISS-011 evidence mapped by path (unmoved) to 006b.
- §26.8 NVIDIA/KDE + complete predicate ⇒ 006b is cannot-validate (SHM-only baseline); AMD/Intel DMA-BUF must yield a real pass/fail (T-028). Forward-pointer note added under §8 table.

## Why cannot-validate is not pass (and why no runner change)
cannot-validate carries **no credit**: it is not green, does not satisfy §24, and never becomes pass or skip. It is gated behind a deterministic, evidence-backed predicate that is strictly narrower than fail, so a real defect cannot be laundered into a non-red state. It is an **adjudication disposition recorded in §24**, not a runner verdict — so `verdictFromCounts`, the runner status union, drivers, assertions, and types are untouched. `validation/rows.ts` was **not** touched: `VAL-CAP-006` there is a `manual` row with no runner driver (runner only drives `VAL-CAP-004`), so the split lives in N-008 policy/§24, not code — touching rows.ts would risk a skip-only suite reading green and orphaning the ISS-011 evidence map.

## Evidence paths referenced (unmoved, unrenamed)
`.story/handovers/evidence/2026-05-22-t-010c-slice-3-m1-smoke-completion-retry-2/operator-evidence/VAL-CAP-006/` → `{BLOCKED.md, ffprobe-frame-count.txt, helper-log-excerpt.txt, hud-during-minimised.png, source-minimised.png}` (maps to VAL-CAP-006b).

## Verification (one line per check)
- storybloq validate: **0 errors / 0 warnings / 0 info**.
- forbidden-path diff (`helper/ electron/ src/ validation/{assertions,runner,types,drivers}.ts dist-validation/ packaging/ .github/ package.json lockfiles`): **empty**.
- `validation/rows.ts` diff: **empty**.
- `git diff --check`: clean.
- §6.1 frame-integrity block: byte-identical (script-guarded; `round(duration_s × declared_fps) ± 1` and ±0.5% cadence intact).
- T-023: untouched. ISS-008 / ISS-009 / ISS-012 / ISS-013: untouched. T-010c: open. ISS-011: inprogress.
- N-008 contains: cannot-validate disposition, anti-abuse rule, 3-artifact predicate, VAL-CAP-006a, VAL-CAP-006b, "never green", row-level-beats-suite-level guard — all confirmed.

## Note on mechanism
N-008 and ISS-011 were edited via surgical, escape-safe scripted insertions (additive only) rather than a full-content `note_update`/`issue_update` rewrite, to guarantee the frozen text (esp. §6.1) stayed byte-identical. Result validated through `storybloq_validate` (0/0/0) and `storybloq_note_get`/issue JSON read-back.

## Next
- T-028 adjudicates VAL-CAP-006b to a real pass/fail on AMD/Intel DMA-BUF hardware (requires M2/M3). Until then VAL-CAP-006b is parked (cannot-validate) and ISS-011 stays inprogress.
- Not committed (per instruction). Commit command provided in session output.