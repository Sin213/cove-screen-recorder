# VAL-CAP-006b — Decision table (T-028 execution spec)

> Define-only. No row is adjudicated in this pass. These are the branches a future session evaluates **after** confirming hardware eligibility (`hardware-eligibility.md`) and DMA-BUF success (`dmabuf-success-criteria.md`).
>
> **Preconditions.** These branches presume the implementation prerequisites in `instrumentation-sufficiency.md` are met — a VAAPI/QSV zero-copy encoder backend + a real `dmabuf_imports` increment path. Until those land, no AMD/Intel run can reach a *confirmed* zero-copy encode, so 006b stays **blocked (not adjudicable)** regardless of hardware — distinct from branch 4 INCONCLUSIVE (a per-run capture-negotiation miss).

| # | Vendor (`gpuInfo`) | DMA-BUF zero-copy | Frame count vs §6.1 `round(duration_s×60) ± 1` | Verdict | Action |
|---|--------------------|-------------------|-----------------------------------------------|---------|--------|
| 1 | `nvidia:` | SHM fallback (DMA-BUF hard-fails) | n/a | **cannot-validate** | Unchanged M1 state; recorded under T-027 / N-008 §26.8. Not green; parks the §24 cell. |
| 2 | `amd:` / `intel:` | **confirmed** | within ±1 | **PASS** | Real zero-copy pass obtained. May resolve ISS-011 (see `iss-011-t010c-disposition.md`). |
| 3 | `amd:` / `intel:` | **confirmed** | outside ±1 | **FAIL** | Real capture/encoder defect on a working path. File a fix ticket against owner_on_fail = capture / encoder (N-008 §3). |
| 4 | `amd:` / `intel:` | **not confirmed** (any of `dmabuf-success-criteria.md` 1–9 violated) | n/a | **INCONCLUSIVE** | Retry on a clean zero-copy path. **Not** PASS; **not** cannot-validate. |
| 5 | any | run ended before `capture.sessionReady` / unknown | n/a | **INVALID** | Pre-first-frame; not evidence. Retry. |

## Hard rules
- **AMD/Intel hardware alone is not evidence.** Vendor eligibility ≠ proof. Branches 2/3 require DMA-BUF success to be *proven* (`dmabuf-success-criteria.md`), not assumed.
- **DMA-BUF success must be proven** before the frame-count number is trusted.
- **SHM on AMD/Intel is NOT cannot-validate.** cannot-validate is keyed to the `nvidia:` predicate (§26.4). On AMD/Intel, SHM / no-confirmed-DMA-BUF → INCONCLUSIVE (branch 4), retry.
- **No fake-green branch exists.** There is no path in this table from a deficit to a non-red "green." A within-tolerance result is reachable only through a *confirmed* zero-copy path (branch 2); branches 4 and 5 are retries, never passes.
