# VAL-CAP-006b — ISS-011 / T-010c disposition (T-028 execution spec)

> Define-only. This pass changes **no** statuses. ISS-011 stays `inprogress`; T-010c stays `open`; T-028 stays `open`; N-008 unchanged.

## ISS-011 (stays inprogress this pass)
- ISS-011 is **parked pending T-028** and remains `inprogress` (resolution null) in this define-only pass — no edit to ISS-011 here.
- A future **PASS** on a confirmed AMD/Intel DMA-BUF run (`decision-table.md` branch 2) **can resolve ISS-011**, citing the qualifying evidence-bundle path: the original deficit would be confirmed an environment limitation (SHM / occluded / idle compositor), not a product defect on a working zero-copy path.
- A future **FAIL** (branch 3) keeps/escalates ISS-011 as a **confirmed capture/encoder defect** on a working path (owner_on_fail = capture / encoder, N-008 §3); ISS-011 stays open and a fix ticket is filed.
- **cannot-validate never resolves ISS-011.** The NVIDIA/KDE cannot-validate disposition (§26.8) parks the cell; it carries no credit and does not close the issue.
- INCONCLUSIVE / INVALID (branches 4/5) → retry; no ISS-011 status change.

## T-010c (stays open; not unblocked here)
- **T-028 define-only does NOT unblock T-010c.** T-010c §22 smoke remains blocked by its listed issues (including ISS-011); writing this spec changes nothing about that gate.
- **VAL-CAP-006a** (minimised/occluded survival + HUD increments + playable output — Issue #3 proof) covers the §16 / §17 / §22 references and is adjudicated normally on every host (N-008 §26.6); it is **not** what 006b parks.
- **VAL-CAP-006b** parks its §24 release-gate cell (not green; cannot-validate on NVIDIA) **until** a real qualifying AMD/Intel PASS/FAIL exists. Only then does the 006b cell leave the parked state.
- This pass asserts no T-010c unblock and makes no §24 green claim.
