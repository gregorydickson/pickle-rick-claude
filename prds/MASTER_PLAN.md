---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Live ledger.** The babysitter (`babysitter.md`) re-reads this each tick, so it is kept lean
on purpose. Shipped-release detail and closed-finding forensics live in
[`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) + `git log`; the full finding catalog is in
[`BUG-INDEX.md`](BUG-INDEX.md).

**Updated 2026-06-20 (PM).** Shipped + deployed through **v2.0.0-beta.21**. **NOT drained for the
hands-off goal:** 5 sessions in one day surfaced the two seams that break *every* hands-off pipeline
run — **R-RCFF** (start gate false-halts additive bundles at iter 0) and **R-CECB** (finish gate
fatals + salvage-discards a committed ticket, recurs once per ticket). These are one structural
defect at two boundaries: *the gates validate an LLM-produced bookkeeping artifact against a strict
grammar instead of reconciling against the actual repo state.* The next beta — **B-PCOMP** (top of
queue, P1) — collapses both to ground-truth gates. **Release goal: a multi-ticket additive bundle
completes 4/4 phases hands-off.** That is the GA path, evidence-ranked (not a future soak).

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
| **B-PCOMP** | **B-PCOMP — beta 2.0 pipeline completion** — ground-truth gates at both boundaries (WS-D1=B-RFCU start gate + WS-D2 finish gate) | **P1** | **✅ SHIPPED v2.0.0-beta.22 (2026-06-21) + LIVE-PROVEN.** First green hands-off field-proof: the R-WSDO bundle ran **4/4 phases end-to-end with ZERO intervention** (84m, `pipeline-completed`), zero salvage-loops / zero done_without_commit_evidence — the exact pathology that broke every prior run. Fixes: `400fe433` salvage clean-tree back-fill, `aff2cfd4` bystander stash-not-commit, `b20a4c1a` R-OMTD orphan-mux reap, `fae9c590` e2e mechanism proof, start-gate WS-D1 (`26125e91`/`e9e55fc8`/`c08bb0d3`), WS-D2-1 attribution (`8b4f75c6`). Agent-team hand-built (R-PSRB catch-22). Full local gate green (tsc/eslint/10 audits/integration 513+486-0/fast-c4 6637-0). **GA (drop -beta) gate = field-soak repeatability: 1 of ~3-5 representative hands-off runs done (need ≥1 live multi-ticket).** Prior state: **IN BUILD 2026-06-21.** Start gate (WS-D1) ✅ committed (26125e91/e9e55fc8/c08bb0d3). WS-D2-1 branch attribution ✅ committed (8b4f75c6). 6-agent team re-understood the build failures + re-planned for simplification: **8 remaining tickets → 4 build steps** (3f6800f3 CUT = already-shipped artifact-delta reap; 0a1ce691 narrowed to reuse the shipped `readEvidence` oracle, NOT export `scanGitLog` which would break R-AFCC-CALLER-ENUMERATION; 4 hardening → 1; R-OMTD orphan-mux teardown folded in). Build via hand-build agent team (R-PSRB catch-22 forbids autonomous self-build). **Done = 4/4 phases hands-off e2e.** All 4 build steps ✅ committed (`400fe433` salvage clean-tree back-fill / `aff2cfd4` bystander stash-not-commit / `b20a4c1a` R-OMTD orphan-mux reap / `fae9c590` 4/4-phase hands-off e2e). **Quality-closure 3-pass hardening ✅ done** (NEW-quality-closure): code+data-flow review clean (no P0/P1), +A6 headSha-null rejection test, 3 new invariants documented with enforcing trap doors + ENFORCE tests in `extension/CLAUDE.md` + `extension/src/bin/CLAUDE.md`. Pending: deploy (install.sh) + release. See "Revised Build Plan" in the PRD. | `p1-beta2-pipeline-completion-2026-06-20.md` |
| B-RFCU | **B-RFCU** readiness forward-created unification (= B-PCOMP **WS-D1**, start gate; R-RGO/R-RPRA/R-QGSK/**R-RCFF** family) | P2 | **✅ SHIPPED-IN-BUNDLE (committed, not yet released) 2026-06-21** as B-PCOMP WS-D1 — `26125e91`+`e9e55fc8` (contract/symbol resolver wired to creation index) + `c08bb0d3` (annotation-omission robustness + audit parity). Both start-gate tickets Done hands-off. Deploy + release rides with B-PCOMP. | `p2-readiness-forward-created-unification-2026-06-20.md` |
| R-PSRB | **R-PSRB / R-OMTD / R-WSDO / R-SLEAK** — pipeline self-referential build catch-22 + orphan-mux teardown + worker silent-death observability + session leak | P2 | **OPEN — filed 2026-06-21 from the B-PCOMP build.** **R-PSRB (design):** a bundle that modifies the recovery/salvage/completion machinery can't be built autonomously — the deployed pre-fix runtime salvage-resets the very ticket building the fix (B-PCOMP `0a1ce691` failed 3× incl. at zero contention). Build protocol: hand-build recovery-path tickets or install.sh-deploy incrementally. **R-OMTD (bug): ✅ FIXED-IN-BUNDLE 2026-06-21 (`b20a4c1a`)** — pipeline-runner now spawns mux children `detached` (own process group) and reaps the whole subtree via `reapChildSubtree`/negative-PID group signal on teardown; trap door + ENFORCE test landed. Was: killing pipeline-runner orphaned its mux child (PPID 1) which kept looping. **R-WSDO:** silent-death workers leave 0-byte logs / no spawn log → zero forensic signal. **R-SLEAK:** 13 leaked tmux sessions + orphan runners persist for days; `pgrep -f claude` over-counts → contention misdiagnosis. | `BUG-REPORT-2026-06-21-pipeline-self-referential-build-catch22-and-orphan-mux.md` |
| 124 | **R-DPMC-3** decomposition-satisfiability residual | P2 | **DEFERRED** — large additive machinery; needs operator sign-off (R-DPMC-1/-2 already shipped: B-DECOMP-SAT beta.17 / B-GROUND2 beta.16). | `archive/bundles/p2-bug-fix-bundle-b-decomp-sat-decomposition-satisfiability-2026-06-18.md` |
| 125 | **B-GSUB** functional seam-collapse | P2 | **DEFERRED** — the next-week GA soak ranks which seam to collapse first; pure-doc track already closed (−9). | `archive/bundles/p2-simplification-pass-guard-inventory-subtraction-2026-06-18.md` |
| 119 | **B-CIINT** integration-tier CI-env e2e failures | P3 | **OPEN** — Linux-CI-only subprocess-e2e flakiness; CI hygiene, **not a release gate**. Pass locally (macOS). | `archive/bundles/p3-bug-fix-bundle-b-ciint-integration-tier-ci-env-e2e.md` |
| — | **B-CGCAP** codegraph default-on (v2.1) | P2 | **DEFERRED post-GA** (reliability-first / capability-second). | `p2-codegraph-default-on-capability-v2.1.md` *(pinned)* |
| 13 | **B-DWF-2** retire legacy refinement subprocess | P3 | **⏸️ SHELVED** — soak-harness prereq unmet; legacy path retained for zero regression. | `archive/bundles/p3-bug-fix-bundle-b-dwf2-retire-refinement-subprocess.md` |
| 25 | **R-CSI** concurrent-session destructive-command interference (DATA-LOSS class) | P1 | **EXTERNAL-GATED** — re-activates on the next real concurrent-session incident to analyze. | `archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md` |
| — | **R-RCFF** readiness contract-resolver false-halts on forward-created schema field-paths | P3 | **OPEN — capture-only** (**2 instances 2026-06-20**: sessions 4124c822 + 9ab25dfa/LOA-1449). Instance of R-RGO/R-RPRA/R-QGSK family; gap = the forward-ref grammar (R-RTRC-2/R-FRA-6) covers file paths/symbols but NOT dotted field-paths in `## Interface Contracts` Outputs, so additive-field PRDs false-halt on first launch. 9ab25dfa adds data points: an **un-annotated forward-created `*.spec.ts`** also false-halted as `file_path` (annotation-omission gap), and the halt masked 2 real doc-path typos → argues for finding-scoped skip over the coarse flag. Sanctioned `skip_quality_gates_reason` applied both times; correctness unaffected. | `BUG-REPORT-2026-06-20-readiness-contract-resolver-forward-created-schema-fields.md` |
| — | **R-CECB** completion-evidence fatal on CLAUDE backend; salvage-loops an already-committed ticket + strands next ticket's work | P3 | **OPEN — capture-only** (**2 instances 2026-06-20**: sessions 4124c822 + 575e20b3/LOA-1365). Instance of the open completion-commit cluster (R-AFCC/R-RIC/R-CCC/B-WUWC). NEW: prior reports are codex-only — this confirms the missing-`completion_commit`-frontmatter → `readEvidence absent` → `[salvage] reset Todo` loop → `[fatal] cannot flip Done` path on the **claude** backend; and a fatal on ticket 1 stranded ticket 2's verified-green uncommitted work (bystander-loss risk). Recovery: commit the green bystander work + back-fill EXPLICIT per-ticket `completion_commit` (⚠️ `allow_inferred_completion_commit=true` is INSUFFICIENT — verified on 4124c822: it RECURS once per ticket because workers commit with `(LOA-####)`/`feat: N.X` subjects that carry no ticket-hash, so inference can't attribute → R-CCRC gap; also watch B-PDBL phantom-Done/state-bloat). Reliable fix = explicit stamp per ticket; ~1 stop/back-fill/relaunch cycle per ticket ⇒ no hands-off autonomy for multi-ticket bundles until workers write `completion_commit` or the gate attributes LOA/ref commits. **575e20b3 adds** (different worktree, same day): same claude-backend fatal at `0/4 phases` on ticket 1 (`e13f9264`/`dcde06041`); recovery confirmed working. Also surfaces a compounding **[[B-GNXR]] salvage-reaps-in-progress angle**: post-recovery, larger ticket `14f134ca` salvage-looped 4× (~2-3 min cadence) while the worker WAS producing real artifacts (7.1K grounded research) — manager's spawn-async→yield pattern lets the iteration-boundary salvage reap pre-commit; manager (opus-4-8) recovered by holding its turn open + active-watch. Cross-ref B-GNXR no-progress-discards-uncommitted-output on the **claude** backend for large tickets. | `BUG-REPORT-2026-06-20-completion-evidence-fatal-claude-backend-strands-bystander-ticket.md` |

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
