---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Live ledger.** The babysitter (`babysitter.md`) re-reads this each tick, so it is kept lean
on purpose. Shipped-release detail and closed-finding forensics live in
[`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) + `git log`; the full finding catalog is in
[`BUG-INDEX.md`](BUG-INDEX.md).

**Updated 2026-06-21.** Shipped + deployed through **v2.0.0-beta.22** (B-PCOMP). The two seams that
broke *every* hands-off run — **R-RCFF** (start gate false-halts additive bundles) and **R-CECB**
(finish gate salvage-discards a committed ticket) — are **FIXED** in B-PCOMP, collapsed to ground-truth
gates (readiness reads the bundle creation set; completion reconciles against the branch). **First green
field-proof:** a real additive bundle (R-WSDO) ran **4/4 phases end-to-end hands-off, zero
intervention** (84m) on the deployed runtime — zero salvage-loops, zero `done_without_commit_evidence`.
**GA (drop `-beta`) now gates ONLY on field-soak repeatability: 1 of ~3–5 representative hands-off runs
done** — need ≥1 **live multi-ticket** additive bundle (R-WSDO was single-ticket; R-CECB recurred
*per ticket*) + 2–3 more reps at a low intervention rate. The GA-readiness ledger (next step) is the
soak. **Caveat:** B-PCOMP itself could not self-build (R-PSRB self-referential catch-22 — a bundle that
edits the recovery machinery); documented build protocol = hand-build recovery-path tickets, then deploy.

## Status

| Item | Value |
|---|---|
| Version (source = deployed) | **v2.0.0-beta.22** — B-PCOMP pipeline-completion fixes + R-WSDO; deployed via install.sh 2026-06-21. |
| Latest GitHub release | **v2.0.0-beta.22** (B-PCOMP + R-WSDO; prerelease). Prior: beta.21 #129 R-SSOC · beta.20 #128 R-TDCS · beta.19 #127 R-DEFCHURN. |
| Codex backend | `gpt-5.4` |
| Gate posture | Ship on the **local** gate (tsc + eslint + audits + fast-c4 + integration + expensive). **CI-green = hygiene, never a release gate.** |

**Directives.** Drain bugs before features, P1 > P2 > P3. The babysitter drains the entire plan
with **zero operator interaction**, including the full release cycle (`git push` + `gh release
create`), gated only on a green local gate + clean tree. Sole permitted residue: external-event-
gated work. Every bundle PRD carries a `## Simplification Review` (subtract-before-add) — see
[`CLAUDE.md`](CLAUDE.md).

**GA path (evidence-first).** GA gate = honesty ✅ + stability-surface ✅ + completion-bugs-fixed ✅
(B-PCOMP, beta.22) + **field-soak repeatability 🟡 (1 of ~3–5 done).** The two completion-breaking
seams are now collapsed to ground-truth gates and **live-proven once** (R-WSDO, 4/4 hands-off). The
remaining GA work is the **field-soak**: run ~3–5 representative bundles via `/pickle-pipeline`
(scoped — small bundles use `--scope branch`; an unscoped 1-event bundle made anatomy/szechuan review
the whole tree for 84m), INCLUDING ≥1 live multi-ticket additive bundle; record every intervention
point → ranked intervention-rate report = the GA-readiness ledger. Drop `-beta` once repeatability
holds (no new completion-class seam across the soak). Now-cheap to fix any new seam (gates deployed).

---

## ▶ Next step (active): GA field-soak

**The one active work item is the GA-readiness soak** (drop `-beta`). Run **~3–5 representative bundles**
hands-off via `/pickle-pipeline`, INCLUDING **≥1 live multi-ticket additive bundle** (R-WSDO was
single-ticket). Use `--scope branch` for small bundles (an unscoped 1-event bundle made anatomy/szechuan
review the whole tree for 84m). *Record* every intervention point (don't rescue unless data at risk) →
ranked intervention-rate report = the GA-readiness ledger. **1 of N done** (R-WSDO, 4/4 hands-off, clean).
Candidate soak PRDs: pick from the deferred/open rows below (e.g. a real multi-ticket bug bundle) or the
backlog. Drop `-beta` when repeatability holds with no new completion-class seam.

## Drain Queue — shipped + remaining (deferred / blocked / external-gated)

| # | Item | Pri | State | Source |
|---|------|-----|-------|--------|
| **B-PCOMP** | **B-PCOMP — beta 2.0 pipeline completion** — ground-truth gates at both boundaries (WS-D1=B-RFCU start gate + WS-D2 finish gate) | **P1** | **✅ SHIPPED v2.0.0-beta.22 (2026-06-21) + LIVE-PROVEN.** First green hands-off field-proof: the R-WSDO bundle ran **4/4 phases end-to-end with ZERO intervention** (84m, `pipeline-completed`), zero salvage-loops / zero done_without_commit_evidence — the exact pathology that broke every prior run. Fixes: `400fe433` salvage clean-tree back-fill, `aff2cfd4` bystander stash-not-commit, `b20a4c1a` R-OMTD orphan-mux reap, `fae9c590` e2e mechanism proof, start-gate WS-D1 (`26125e91`/`e9e55fc8`/`c08bb0d3`), WS-D2-1 attribution (`8b4f75c6`). Agent-team hand-built (R-PSRB catch-22). Full local gate green (tsc/eslint/10 audits/integration 513+486-0/fast-c4 6637-0). **GA (drop -beta) gate = field-soak repeatability: 1 of ~3-5 representative hands-off runs done (need ≥1 live multi-ticket).** Prior state: **IN BUILD 2026-06-21.** Start gate (WS-D1) ✅ committed (26125e91/e9e55fc8/c08bb0d3). WS-D2-1 branch attribution ✅ committed (8b4f75c6). 6-agent team re-understood the build failures + re-planned for simplification: **8 remaining tickets → 4 build steps** (3f6800f3 CUT = already-shipped artifact-delta reap; 0a1ce691 narrowed to reuse the shipped `readEvidence` oracle, NOT export `scanGitLog` which would break R-AFCC-CALLER-ENUMERATION; 4 hardening → 1; R-OMTD orphan-mux teardown folded in). Build via hand-build agent team (R-PSRB catch-22 forbids autonomous self-build). **Done = 4/4 phases hands-off e2e.** All 4 build steps ✅ committed (`400fe433` salvage clean-tree back-fill / `aff2cfd4` bystander stash-not-commit / `b20a4c1a` R-OMTD orphan-mux reap / `fae9c590` 4/4-phase hands-off e2e). **Quality-closure 3-pass hardening ✅ done** (NEW-quality-closure): code+data-flow review clean (no P0/P1), +A6 headSha-null rejection test, 3 new invariants documented with enforcing trap doors + ENFORCE tests in `extension/CLAUDE.md` + `extension/src/bin/CLAUDE.md`. Pending: deploy (install.sh) + release. See "Revised Build Plan" in the PRD. | `p1-beta2-pipeline-completion-2026-06-20.md` |
| B-RFCU | **B-RFCU** readiness forward-created unification (= B-PCOMP **WS-D1**, start gate; R-RGO/R-RPRA/R-QGSK/**R-RCFF** family) | P2 | **✅ SHIPPED-IN-BUNDLE (committed, not yet released) 2026-06-21** as B-PCOMP WS-D1 — `26125e91`+`e9e55fc8` (contract/symbol resolver wired to creation index) + `c08bb0d3` (annotation-omission robustness + audit parity). Both start-gate tickets Done hands-off. Deploy + release rides with B-PCOMP. | `p2-readiness-forward-created-unification-2026-06-20.md` |
| R-SLEAK | **R-SLEAK** (+ R-PSRB/R-OMTD/R-WSDO context) — session/process leak + contention-gauge | P3 | **PARTIAL — R-OMTD ✅ + R-WSDO ✅ SHIPPED beta.22; R-PSRB documented; R-SLEAK OPEN.** **R-OMTD (`b20a4c1a`):** pipeline-runner spawns mux children `detached` + reaps the subtree via `reapChildSubtree`/negative-PID on teardown (no more PPID-1 orphans). **R-WSDO (`177b84a7`):** `worker_produced_nothing` breadcrumb shipped. **R-PSRB (design, documented — not a code fix):** recovery-machinery bundles can't self-build (deployed pre-fix runtime salvage-resets the ticket building the fix); build protocol = hand-build recovery-path tickets then install.sh-deploy. **R-SLEAK (OPEN, P3 hygiene):** leaked tmux sessions + orphan runners persist for days; `pgrep -f claude` over-counts (matches node runners + own shell) → real worker-contention gauge is `ps -eo command \| grep -E '/claude '`. Session-GC unbuilt. | `BUG-REPORT-2026-06-21-pipeline-self-referential-build-catch22-and-orphan-mux.md` |
| 124 | **R-DPMC-3** decomposition-satisfiability residual | P2 | **DEFERRED** — large additive machinery; needs operator sign-off (R-DPMC-1/-2 already shipped: B-DECOMP-SAT beta.17 / B-GROUND2 beta.16). | `archive/bundles/p2-bug-fix-bundle-b-decomp-sat-decomposition-satisfiability-2026-06-18.md` |
| 125 | **B-GSUB** functional seam-collapse | P2 | **DEFERRED** — the next-week GA soak ranks which seam to collapse first; pure-doc track already closed (−9). | `archive/bundles/p2-simplification-pass-guard-inventory-subtraction-2026-06-18.md` |
| 119 | **B-CIINT** integration-tier CI-env e2e failures | P3 | **OPEN** — Linux-CI-only subprocess-e2e flakiness; CI hygiene, **not a release gate**. Pass locally (macOS). | `archive/bundles/p3-bug-fix-bundle-b-ciint-integration-tier-ci-env-e2e.md` |
| — | **B-CGCAP** codegraph default-on (v2.1) | P2 | **DEFERRED post-GA** (reliability-first / capability-second). | `p2-codegraph-default-on-capability-v2.1.md` *(pinned)* |
| 13 | **B-DWF-2** retire legacy refinement subprocess | P3 | **⏸️ SHELVED** — soak-harness prereq unmet; legacy path retained for zero regression. | `archive/bundles/p3-bug-fix-bundle-b-dwf2-retire-refinement-subprocess.md` |
| 25 | **R-CSI** concurrent-session destructive-command interference (DATA-LOSS class) | P1 | **EXTERNAL-GATED** — re-activates on the next real concurrent-session incident to analyze. | `archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md` |
| — | **R-RCFF** readiness false-halts on forward-created schema field-paths (start gate) | P3 | **✅ FIXED v2.0.0-beta.22 (B-PCOMP WS-D1).** Readiness contract/symbol resolver now consults the bundle creation index + annotation-omission robustness (`26125e91`/`e9e55fc8`/`c08bb0d3`) — additive bundles pass the start gate with no skip flag. Live-confirmed: R-WSDO additive bundle passed readiness 0-blocking. R-RGO/R-RPRA/R-QGSK family closed at the start boundary. | `BUG-REPORT-2026-06-20-readiness-contract-resolver-forward-created-schema-fields.md` |
| — | **R-CECB** completion-evidence fatal on CLAUDE backend; salvage-discards a committed ticket (finish gate) | P3 | **✅ FIXED v2.0.0-beta.22 (B-PCOMP WS-D2).** Salvage clean-tree back-fill from the shipped `readEvidence` oracle (`400fe433`) — a committed-green ticket with no `completion_commit` stamp reaches `committed-done`, never the `done_without_commit_evidence` fatal/salvage-loop; bystander work stashed not discarded (`aff2cfd4`); `allow_inferred_completion_commit` advice demoted. Live-confirmed: R-WSDO ran 4/4 hands-off, zero salvage-loops. **Residual class note:** multi-ticket per-ticket behavior is mechanism-tested (e2e) but the GA soak still needs ≥1 LIVE multi-ticket run. | `BUG-REPORT-2026-06-20-completion-evidence-fatal-claude-backend-strands-bystander-ticket.md` |

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
