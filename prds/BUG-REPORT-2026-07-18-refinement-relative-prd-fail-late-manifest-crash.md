# BUG-REPORT 2026-07-18 — refinement fail-lates on a relative `--prd` (crashes at manifest build after the full analyst spend)

**Finding code:** R-RPFL (relative-prd fail-late)
**Severity:** P2 (real, but the normal pipeline flow dodges it — see Blast radius)
**Status:** OPEN, unfiled until now. Surfaced by R-SAFP ticket `630b7aca` (the R11 verification) while checking whether R-SAFP actually unblocks B-NONSTOP.
**Branch:** `release/v2.1-beta` @ `v2.1.0-beta.3`+

## Symptom

A refinement run invoked with a **relative** `--prd` runs all three analyst cycles to completion (~15 min,
12 analyses on disk), then hard-crashes at manifest build:

```
Fatal: enrichManifestTicketsFromSourcePrds requires absolute parentPrdPath
  at enrichManifestTicketsFromSourcePrds (spawn-refinement-team.ts:1646)
  at buildRefinementManifest → main
```

The entire analyst spend is discarded; the analyses survive only as orphaned files in the session dir.

## Mechanism (verified at HEAD)

- `--prd` is read raw at `spawn-refinement-team.ts` argv parse and carried **unresolved** to
  `:2148`, where `enrichManifestTicketsFromSourcePrds(args.prdPath, …)` is called.
- `:1645-1646`: `if (!path.isAbsolute(prdPath)) throw new Error('enrichManifestTicketsFromSourcePrds requires absolute parentPrdPath')`.
- No `path.resolve` exists between argv-parse and `:2148`. So a relative `--prd` is knowable-bad at parse
  time but only detected after the full refinement — **a fail-late on a condition checkable at argv parse.**

## Blast radius (why P2, not P1)

**The normal pipeline flow dodges it.** Verified 2026-07-18: all three refinements run this session
(B-SSAT `fa82461f`, B-CGHARD `d933dddb`, R-SAFP `c06fd902`) were invoked with an **absolute**
`$SESSION_ROOT/prd.md` (setup.js mints an absolute session dir), and all three reached manifest build and
succeeded. So B-NONSTOP built via the normal `/pickle-pipeline` flow is **not** blocked by this. The crash
bites ad-hoc/relative invocations — which is exactly how the R11 verification hit it.

## Fix (subtractive, small)

Resolve `--prd` to an absolute path **once at argv-parse** (`path.resolve(process.cwd(), raw)`), so the
`:1645` guard becomes unreachable-by-construction and the invariant holds end-to-end. Do NOT relax the
`:1645` guard (it is a correct invariant); make the input satisfy it early. Fail-late → fail-never.

## Evidence trail

- R-SAFP §7 (`prds/p1-r-safp-symbol-audit-false-positive-unblock.md`), recorded by ticket `630b7aca`.
- Session `2026-07-18-18fa6417`, run log `/tmp/r-safp-refinement-run.log`.
- The three absolute-path successes above (manifest.prd_path all under `/Users/.../sessions/…`).
