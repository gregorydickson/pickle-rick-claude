---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Live ledger.** The babysitter (`babysitter.md`) re-reads this each tick, so it is kept lean
on purpose. Shipped-release detail and closed-finding forensics live in
[`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) + `git log`; the full finding catalog is in
[`BUG-INDEX.md`](BUG-INDEX.md).

**Updated 2026-06-20.** The simplification arc shipped + deployed through **v2.0.0-beta.21**.
The plan is **effectively drained** — every actionable P1/P2/P3 bug bundle has shipped. The only
remaining items are **deferred / operator-blocked / external-event-gated** (below). GA (dropping
`-beta`) is gated on **field-proof of hands-off autonomy** — a measured soak, not more code.

## Status

| Item | Value |
|---|---|
| Version (source = deployed) | **v2.0.0-beta.21** — one `install.sh` deployed beta.17–21 (2026-06-19); deployed runtime = repo HEAD. |
| Latest GitHub release | **v2.0.0-beta.21** (#129 R-SSOC; prerelease). Recent: beta.20 #128 R-TDCS · beta.19 #127 R-DEFCHURN · beta.18 #126 R-CCEM · beta.17 B-DECOMP-SAT · beta.16 B-GROUND2. |
| Codex backend | `gpt-5.4` |
| Gate posture | Ship on the **local** gate (tsc + eslint + audits + fast-c4 + integration + expensive). **CI-green = hygiene, never a release gate.** |

**Directives.** Drain bugs before features, P1 > P2 > P3. The babysitter drains the entire plan
with **zero operator interaction**, including the full release cycle (`git push` + `gh release
create`), gated only on a green local gate + clean tree. Sole permitted residue: external-event-
gated work. Every bundle PRD carries a `## Simplification Review` (subtract-before-add) — see
[`CLAUDE.md`](CLAUDE.md).

**GA path (operator-decided 2026-06-20, evidence-first).** GA gate = honesty ✅ + stability-surface
✅ (B-GSUB proved the guard surface is mostly load-bearing, not bloat) + **field-proof of hands-off
autonomy ❌** (beta.14–21 all shipped via babysitter takeover — the real blocker). Next week: a
**measured field-soak** — operator launches representative bundles via `/pickle-pipeline`; the
babysitter *records* every intervention point (does not rescue unless data is at risk) → a ranked
intervention-rate + failure-seam report = the GA-readiness ledger. Then decide whether to collapse
the top recurring seam(s). Do **not** pre-build the collapse; let the soak rank the seams. The
pure-doc-subtraction track (B-GSUB) is closed (−9, low-yield).

---

## Drain Queue — open items (all deferred / blocked / external-gated)

| # | Item | Pri | State | Source |
|---|------|-----|-------|--------|
| B-RFCU | **B-RFCU** readiness forward-created unification — collapse the D1 validation-overreach seam (R-RGO/R-RPRA/R-QGSK/**R-RCFF** family) | P2 | **PLAN DRAFTED 2026-06-20** — evidence-first (R-RCFF gave 2 same-day instances). Subtraction: wire the existing `buildBundleCreationIndex` into the contract resolver + populate field-paths + demote forward-created refs to advisory; no new grammar, no new skip flag. Operator decides drain timing (top seam-collapse candidate for the GA soak). | `p2-readiness-forward-created-unification-2026-06-20.md` |
| 124 | **R-DPMC-3** decomposition-satisfiability residual | P2 | **DEFERRED** — large additive machinery; needs operator sign-off (R-DPMC-1/-2 already shipped: B-DECOMP-SAT beta.17 / B-GROUND2 beta.16). | `archive/bundles/p2-bug-fix-bundle-b-decomp-sat-decomposition-satisfiability-2026-06-18.md` |
| 125 | **B-GSUB** functional seam-collapse | P2 | **DEFERRED** — the next-week GA soak ranks which seam to collapse first; pure-doc track already closed (−9). | `archive/bundles/p2-simplification-pass-guard-inventory-subtraction-2026-06-18.md` |
| 119 | **B-CIINT** integration-tier CI-env e2e failures | P3 | **OPEN** — Linux-CI-only subprocess-e2e flakiness; CI hygiene, **not a release gate**. Pass locally (macOS). | `archive/bundles/p3-bug-fix-bundle-b-ciint-integration-tier-ci-env-e2e.md` |
| — | **B-CGCAP** codegraph default-on (v2.1) | P2 | **DEFERRED post-GA** (reliability-first / capability-second). | `p2-codegraph-default-on-capability-v2.1.md` *(pinned)* |
| 13 | **B-DWF-2** retire legacy refinement subprocess | P3 | **⏸️ SHELVED** — soak-harness prereq unmet; legacy path retained for zero regression. | `archive/bundles/p3-bug-fix-bundle-b-dwf2-retire-refinement-subprocess.md` |
| 25 | **R-CSI** concurrent-session destructive-command interference (DATA-LOSS class) | P1 | **EXTERNAL-GATED** — re-activates on the next real concurrent-session incident to analyze. | `archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md` |
| — | **R-RCFF** readiness contract-resolver false-halts on forward-created schema field-paths | P3 | **OPEN — capture-only** (**2 instances 2026-06-20**: sessions 4124c822 + 9ab25dfa/LOA-1449). Instance of R-RGO/R-RPRA/R-QGSK family; gap = the forward-ref grammar (R-RTRC-2/R-FRA-6) covers file paths/symbols but NOT dotted field-paths in `## Interface Contracts` Outputs, so additive-field PRDs false-halt on first launch. 9ab25dfa adds data points: an **un-annotated forward-created `*.spec.ts`** also false-halted as `file_path` (annotation-omission gap), and the halt masked 2 real doc-path typos → argues for finding-scoped skip over the coarse flag. Sanctioned `skip_quality_gates_reason` applied both times; correctness unaffected. | `BUG-REPORT-2026-06-20-readiness-contract-resolver-forward-created-schema-fields.md` |

> Everything else has shipped. For the chronological record of the ~60 shipped bundles and the
> ~244 closed findings, see [`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) and
> [`BUG-INDEX.md`](BUG-INDEX.md). Feature epics (R-PGI v1.83.0 · R-PIAP v1.84.0 · R-DC v1.85.0 ·
> B-DWF v1.91.0 · B-HERMES · B-CBI · B-DSEK) are all shipped or shelved.

---

## Engineering Rules

Detail in `extension/CLAUDE.md` + `citadel.md`. Quick form:

1. **Atomic PRs** — one ticket per PR, independently revertible.
2. **Full release gate** — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` (+ audit scripts + `RUN_EXPENSIVE_TESTS=1 npm run test:expensive`). Green before tag.
3. **Source-of-truth** — edit `extension/src/*.ts` + `.claude/commands/*.md`; `bash install.sh` to deploy. Never edit `~/.claude/pickle-rick/`.
4. **Trap-door preservation** — every `extension/CLAUDE.md` invariant has an enforcing test.
5. **Hook decisions** — `"approve"` / `"block"` only.
6. **CLI guard** — `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`.
7. **Error handling** — `const msg = err instanceof Error ? err.message : String(err);` at boundaries.
8. **Versioning** — semver in `extension/package.json`; single bump per bundle at the closer.
9. **No dirty release** — all changes committed before tag; compiled JS matches TS source.
10. **Greenfield** — no legacy aliases, no backward-compat shims.

---

## Quick Reference

```bash
/pickle-status                       # formatted current session
/pickle-metrics                      # token/commit/LOC report
/pickle-prd                          # interview then PRD
/pickle-refine-prd <prd>             # 3-cycle decomposition
/pickle-tmux <prd>                   # launch ticket pipeline (tmux, all sizes)
/pickle-pipeline <prd>               # pickle, citadel, anatomy-park, szechuan-sauce
gh release create vX.Y.Z             # tag + publish
```

**Resume an active loop:** `node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --resume <SESSION_ROOT>`.
Closer manager-handoff runbook: `../docs/closer-ticket-manager-handoff.md`. Babysitter: `babysitter.md`.
