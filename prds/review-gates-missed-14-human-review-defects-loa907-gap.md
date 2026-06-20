# PRD: Review Gates Missed 14 Human-Review Defects — Add Two General Finding Dimensions (LOA-907)

**Status**: Bug PRD / quality-gate efficacy gap (2026-06-08). The complete automated review+cleanup stack ran on a 117-file LangGraph-migration PR — `/pickle-pipeline` (incl. anatomy-park + szechuan-sauce), then THREE additional ultracode agent-team reviews (breadth code review, anatomy-park-depth re-run, CLAUDE.md audit). All reported the branch clean (0–1 trivial findings). A human reviewer (Jorge, `jcapona`) then opened the PR and found **14 real issues: 2 Critical, 8 Warning, 3 Simplification, 1 Historical.** Every one was inside the diff the gates already scanned.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension (the gate prompts live here; the defects were in the *target* repo, loanlight-api)
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**: `prds/archive/bug-reports/anatomy-park-szechuan-monorepo-missed-detection-gap.md` (the monorepo-flattening miss). Same family: declared-scope defects the post-pipeline review phases did not surface. That PRD fixed subsystem *discovery*; this PRD targets the **defect classes the finders have no dimension for**, on a *single-package* target where flattening is not the excuse.
**Triggering work**: loanlight-api PR #1707 (`gregory/loa-907-...`), the appraisal LangGraph migration.

---

## Design thesis (read this first)

The naive fix is one bespoke scanner per missed defect class. **We are explicitly NOT doing that.** Seven special-case scanners would be seven new false-positive surfaces, and in this codebase a finder that emits P0/P1 is a *pipeline halt* — so every bespoke scanner is a candidate new wedge point. The repo's entire trap-door history is "a well-meaning gate false-positived and stalled a launch." Catching 14 defects must not cost us autonomy.

The 14 defects reduce to **two questions a human asks that the gates do not**:

1. **"Does this match what we *said* we'd do?"** — checkable against the target's *own declared constraints* (`CLAUDE.md` trap doors / `PATTERN_SHAPE:` / "Never…" / "MUST…" / documented multi-place edits).
2. **"Does this *make sense*?"** — open-ended skeptical reasoning (a UUID flowing into a `code` field, a comment that lies, a pool opened and never closed, a fallback whose consumers don't guard it).

So this PRD ships **two general finding dimensions, not seven rules** — and crucially, **most of dimension 1 already exists.** B-HRP (v1.99.0, this PRD's predecessor) already shipped a directory of diff-scanning citadel analyzers (`banned-casts`, `sibling-auth`, `stale-reference`, `schema-registry-drift`, `test-authenticity`, …) feeding a **no-halt** `GateResult → spawn-gate-remediator` rail. The bulk of the LOA-907 misses already have a detector — they slipped because **citadel only runs inside `/pickle-pipeline`** and the review used standalone passes that never invoked it. So the work is mostly **invoke + extend what exists**, plus **one** new analyzer and a **report-only** judgment lens. Net machinery should trend *down*, the way B-HRP and B-GNXR did. The flywheel turns every future human/Council catch into a permanent automated check at near-zero cost.

---

## What was missed (fixture source of truth)

| # | Jorge issue | Severity | Caught by | Mechanism |
|---|-------------|----------|-----------|-----------|
| 1 | appraisal.processor.ts passes `lenderId` (UUID) into the `lenderCode: string` parameter → every LangSmith trace mislabeled with the UUID. Type-correct, semantically-wrong: both args are `string`, so typecheck + type-aware data-flow see nothing. | **Critical** | M2 (semantic identity) | 2 |
| 2 | Three sites do `Math.round(pipelineResult.coverage.coverage_pct * 100)`; the graph's empty-result fallback returns `coverage: {}` → `NaN` persisted to a numeric DB column. `{} as T` producer in langgraph.service.ts; unguarded consumers in appraisal.processor.ts. | **Critical** | M2 (fallback null-flow) | 2 |
| 3 | Graph `evaluateRules` node computes compliance into `state.complianceResults`, output type drops it, processor re-runs (double eval); node uses module-level `let sharedDb = new pg.Pool({max:1})` outside DI, never closed. | **Warning** | M2 (resource lifecycle / dead-work) | 2 |
| 6 | `0154` migration step 2 `ON CONFLICT DO UPDATE SET enabled=false` silently downgrades any lender that already has `appraisal=true` (clobbers a column another feature owns). | **Warning** | M1 (if documented) / M2 (SQL conflict-clobber) | 1+2 |
| 7 | `fs.readFileSync('/etc/ssl/.../rds-ca-bundle.pem')` runs synchronously inside the graph-node hot path, per invocation. | **Warning** | M2 (blocking IO on hot path) | 2 |
| 9 | `app.invoke(state as never)` — a **direct violation of the target repo's CLAUDE.md trap door** ("Never `as Type` when TS infers; only cast across untyped boundaries"). The most damning miss: the rule is *written down*, yet the diff introduced the violation and no scan cross-referenced it. | **Warning** | **M1** (declared-constraint conformance) | 1 |
| 10 | New migration specs added to jest.containers.config.json + CI but **not** `package.json::testPathIgnorePatterns` — incomplete three-place edit (documented in the target's root CLAUDE.md). | **Warning** | **M1** (documented multi-place edit) | 1 |
| 11 | `normalizeFormType(state.formType ?? "1004") as FormType` duplicated across 5 node files. | Simplification | M2 (cross-file DRY) | 2 |
| 13 | `default:` arm on a switch over a `0\|90\|180\|270` union defeats exhaustiveness. | Simplification | M2 (exhaustiveness) | 2 |
| 14 | Comment introduced by this PR is already stale (`via isCompoundRulesEnabled` → actually `isAppraisalEnabled`); has re-drift history (flagged by a different human on PR #1602). | Historical | **M1** (`stale-reference-audit` — deterministic cited-symbol mismatch) | 1 |
| 15 | **ATTOM dead-guard — surfaced *post-fix*, by a human follow-up question, not any gate.** The migration moved ATTOM enrichment into a graph node `attomFetch` behind a new guard `attomSecondPassExceedsLockBudget`: `firstPassCeiling(form) + ATTOM_SECOND_PASS_CEILING_MS >= APPRAISAL_EXTRACTION_LOCK_DURATION_MS`. With the real constants this is **ALWAYS TRUE for every form** (1004: 60+60≥90 min; 1025: 85+60≥90 min — it stacks two worst-case *timeout* ceilings) → `attomFetch` is unreachable and `ENABLE_ATTOM_ENRICHMENT` became a **NO-OP**. Silent universal regression vs `main` (which ran ATTOM-enriched re-extraction for both forms when the flag was on, with no lock-budget guard). Jorge caught only the 1004 *symptom* (#8) and accepted a wrong "it's intentional" framing; the universal scope + dead flag surfaced only when the operator asked **"why are we not doing ATTOM on 1004?"** Slipped a 13-angle ultracode review that **explicitly named** `fix-set-regressions` + `observability-correctness` lenses. | **Critical** | M2 (dead-guard / no-op-flag / behavior-parity) | 2 |

(#4 latency regression, #5 default-flip test-gap, #8 silent-1004-ATTOM-refusal *(the symptom of #15)*, #12 boolean collapse omitted for brevity — same families.)

**14 of 14 (plus a 15th found post-fix) were in declared scope. Four full review passes — and a 13-angle ultracode review that *named* the very lens (#15) — surfaced essentially none. This is a systemic dimension gap, not bad luck.** #15 is the sharpest proof: a lens that is merely *named* but not *operationalized into a concrete checkable shape* catches nothing. Every issue above is assigned to Mechanism 1 (it's a *declared* rule) or Mechanism 2 (it requires *judgment*).

---

## Evidence from the 2026 merged-PR corpus

LOA-907 is not a one-off. A mining pass over **all 63 PRs `gregorydickson` merged in 2026** (~230 reviewer-flagged issues; full taxonomy in **`docs/review-defect-taxonomy.md`** — the flywheel seed) confirms the two-mechanism design and sharpens it:

- **The class ranking validates the split.** Top classes by frequency: **Security/trust-boundary (~35)**, Error-handling/edge-case (~34), DRY/dead-code (~30), Semantic-correctness (~26), Migration/data-loss (~19), declared-constraint violations (~18). Roughly **half the corpus is M1** (declarable / eslint-able) — M1 is the highest-leverage investment, more so than the original draft assumed.
- **Trust-boundary asymmetry is the #1 shape and it is *comparative*, not novel.** Almost every security finding was "a new path omits a guard its documented sibling already has" (missing `@UseGuards`, a budget check present on chat but not summary, CSRF sent but never validated, an `E2E_MOCK_AUTH` dual-gate enforced on the API side but not the Next.js side). So **Mechanism 1 must include sibling-route guard parity, not only CLAUDE.md text** — see the Mechanism 1 section.
- **The flywheel is proven, not hypothetical.** The `E2E_MOCK_AUTH` single-gate bug was caught on **PR#1585, fixed, then reappeared on PR#1649 six days later**; a stale JSDoc flagged on **PR#1586 carried forward into PR#1602**. Both are "caught twice because nobody wrote it down" — exactly what AC-6 prevents.
- **Recurring eslint-able violations.** Brace-free one-liner `if` (5 PRs) and nested ternaries in JSX (2 PRs) are flagged manually every time, caught by no current lint rule. Cheapest possible M1 wins — an eslint config change, not a gate prompt.
- **The gates are frequently the *only* review.** octy merged **10/10 PRs with zero substantive human review**; ~25% of loanlight-api likewise. For agent-generated and infra PRs the automated gate is not a backstop to a human — it *is* the reviewer. This raises the stakes and reframes the "human reviews the residue" note below: for many PRs there is no human pass at all.

---

## Mechanism 1 — Diff-vs-declared-constraints conformance scan

**The only thing the target already wrote down what NOT to do — so just check the diff against it.**

**Most of this already exists — B-HRP (v1.99.0) shipped it.** The citadel analyzer directory (`extension/src/services/citadel/`) already contains diff-scanning analyzers that cover the bulk of the declared-constraint classes, all feeding the **shipped** `citadelFindingsToGateResult()` adapter → `spawn-gate-remediator` rail (where **nothing halts** — B-HRP removed citadel's halt):

| LOA-907 / corpus class | Existing analyzer (already shipped) |
|---|---|
| `as never` / unnecessary cast (#9) | `banned-casts-audit.ts` |
| nested ternary / brace-free `if` / forbidden constructs | `banned-constructs-audit.ts` |
| sibling-route guard parity (corpus's #1 security shape) | `sibling-auth-audit.ts` |
| stale comment/ref on the diff (#14) | `stale-reference-audit.ts` |
| schema drift | `schema-registry-drift-audit.ts` |
| vacuous / inauthentic tests (#6) | `test-authenticity-audit.ts` |

So Mechanism 1 is **mostly an audit-and-wire task, not a build task.** Three pieces of real work, in leverage order:

1. **Invocation gap (the actual reason LOA-907 slipped).** Per the ledger, **citadel runs only inside `/pickle-pipeline`** — the LOA-907 review used standalone `/anatomy-park` + `/szechuan-sauce` + ultracode passes, which **never invoked these analyzers.** Half the misses had a working detector that simply was not run. Making the citadel analyzer set invokable on a review target (or having the standalone review paths call it) is higher-leverage than any new detector — and adds no detector at all.
2. **Coverage audit + extend the closest analyzer.** Run the existing analyzers against the LOA-907 diff fixture and find the gaps — e.g. does `banned-casts-audit` flag `as never` specifically? does `sibling-auth-audit` catch a missing *budget*/feature-flag/CSRF guard, not just auth? Extend the nearest analyzer; **do not author a parallel one.**
3. **The one genuinely-new analyzer — `pattern-conformance-audit.ts` (build-from-scratch).** A declared-`PATTERN_SHAPE`-conformance check: harvest the `PATTERN_SHAPE:` declarations from a target's in-scope `CLAUDE.md` and flag a diff hunk that *violates* one. This is **not** an extension of `trap-door-coverage-audit.ts` (that asks "is a documented trap door *tested*?") — `PATTERN_SHAPE` appears in **zero `.ts` at HEAD** (only in CLAUDE.md prose), so it is a new module that *mirrors a sibling in spirit only*. The AC must (a) define the `PATTERN_SHAPE:` grammar it parses, and (b) make **absent/malformed declarations a clean no-op, never an error or halt** (G2). Ship the SQL `ON CONFLICT … DO UPDATE SET <col>=<const>` data-loss check **inside the same module** so the R-CCNW-2 analyzer count rises by **exactly one** (wiring is one `...patternConformance.findings.map(f => withFindingSource(f, 'pattern_conformance'))` line at `audit-runner.ts:137-152`). The SQL check **filters `.sql` off `changedFiles[].path` itself** — it must **not** lean on (or widen) `ChangedFileKind` (`'production' | 'test'` only; `.sql` classifies as `'production'`), and is **never gated on a Drizzle `_journal.json`** (the monorepo-skip precedent). No new flags, no new dedup, no new state.

**Severity & routing — the honest contract (analyst flagship finding):** these findings feed B-HRP's `citadelFindingsToGateResult` → `spawn-gate-remediator` rail, but two facts the original draft glossed:
- At default config (`citadel_strict=false`, `pipeline-runner.ts:195`) the remediator threshold is **`Critical`** (`remediationSeverityThreshold(false)`:1790; gate at `:1945`) — **only `Critical`-emitted findings reach the remediator.**
- The mechanical remediator (prettier/eslint + 4 hand-fix classes) **cannot safely fix** a SQL `ON CONFLICT` clobber (#6), an `as never` removal (#9), or an incomplete multi-place edit (#10). So **M1's flagship detections are *surfaced* in `citadel_report.json`, report-only — not auto-fixed — regardless of severity.** `citadel_report.json` is their canonical read surface (below-threshold findings are not echoed in the run log).
- Therefore every new/extended analyzer (AC-2, AC-3) **MUST declare the `CitadelSeverity` it emits** (imported from `reporter.ts:1` — one of `Critical|High|Medium|Low`; there is **no `Warning`**), and a guard test MUST assert no analyzer emits a string outside that four-member enum, because the runtime swallows a mistake three different ways (native → never-remediable; cross-phase → **dropped** at `:271`; normalizer → **coerced to `Medium`** at `:340`). The PRD's table labels (`Warning`/`Simplification`/`Historical`) are *not* severities — map them to the enum in each AC.

**Why this is still the simple, no-wedge shape:** findings are **deterministic** (regex/AST on the diff, no LLM judgment, no convergence loop) and convert to `GateResult` exactly as citadel's own findings already do — so they cannot false-stall or score-inflate like the **B-SJWT**/**R-SLLJ** finders. Net analyzer count goes up by **one**, and AC-8 checks whether it lets us **delete** a bespoke one — net complexity trends flat-or-down, the B-HRP way.

---

## Mechanism 2 — One "review like a skeptic" lens, **report-only, off the convergence loop**

The judgment classes need open-ended reasoning, not a regex. Add them as a few **prompt bullets on the existing citadel / anatomy analyzer** — one skeptic dimension that reasons about the diff with human-style suspicion:

- **Semantic identity** — a call argument whose source-variable name strongly mismatches the parameter name on the *same* type (`lenderId` → `lenderCode: string`). (#1)
- **Fallback null-flow** — a function that can return a partial / `{} as T` / `Partial<T>` value, traced to consumers with unguarded field access (`x.a.b`, `Math.round(x.maybe * n)`). (#2)
- **Resource lifecycle** — a module-scope mutable pool/connection/handle created outside DI and never closed; sync `readFileSync`/blocking IO inside a node/handler hot path; output computed then discarded across a type boundary. (#3, #7)
- **Cross-file repetition & exhaustiveness** — Rule-of-Three repetition clustered across sibling files; `default:` on a narrowed union. (#11, #13)
- **Dead guard / no-op flag / pre-migration behavior parity** (#15) — three concrete shapes the *lens reasons about* (this is the *operationalized* form of the `fix-set-regressions` / `observability-correctness` lenses the ultracode review only *named* — operationalized as **prompt guidance**, not deterministic code):
  1. **Unsatisfiable / tautological predicate** — a boolean guard introduced by the diff whose condition is always-true/always-false given the constants it references. The *lens reasons about* the inequality (`firstPassCeiling(form) + ATTOM_SECOND_PASS_CEILING_MS >= APPRAISAL_EXTRACTION_LOCK_DURATION_MS` → always true). **This is genuine M2 judgment, not a deterministic check:** there is no constant-resolver at HEAD, `firstPassCeiling(form)` is a per-form function (not a literal), the constants are cross-repo, and citadel's diff-level `ChangedFileSummary[]` cannot even see them — and a deterministic constant-folder *would* be wedge-capable (FP → finding), violating M2's "physically cannot wedge" guarantee. So the lens flags it; nothing auto-evaluates it.
  2. **No-op feature flag** — an `if (process.env.X === "true")` / flag read whose body is now unreachable, or whose effect is nullified by a downstream always-true guard. Flag a flag that can no longer change behavior (`ENABLE_ATTOM_ENRICHMENT`).
  3. **Flag-gated behavior parity vs the pre-migration path** — when a refactor/migration moves a feature (especially one behind an env/feature flag) from path A to path B, **diff the enabling conditions**. If B adds a gate A didn't have such that the feature reaches fewer/no cases than A did, flag a potential silent regression — *even when the flag is currently off in prod* (the regression is "you can no longer turn it on").

**Critical — learned from this month's ledger: M2 must NOT drive a convergence-to-0 loop.** A fuzzy LLM "does this make sense?" finder feeding an iterate-fix-remeasure loop is precisely the shape that produced **B-SJWT** (judge scope → `judge_timeout` + score inflation), **B-ORSR** (over-sensitive trigger), and the **R-SLLJ** judge-non-determinism family — the loop never cleanly converges, and "fixing" a taste finding can regress real code. Therefore:

- M2 findings are **surfaced like a Council directive** — written to the report / PR comment for a human or a follow-up agent to act on. They are **NOT** fed to the mechanical `spawn-gate-remediator` (which can only do prettier/eslint/4 hand-fix classes and cannot safely fix a semantic bug), and **NOT** used as a convergence signal.
- This makes M2 **a prompt addition plus a report section. Zero new code path, zero new loop, zero new state, zero new control flow** — so it physically cannot wedge anything.
- Improves by prompt iteration. The deterministic half stays in Mechanism 1; of *its* findings, only the prettier/eslint-shaped subset is auto-fixed by the remediator — M1's flagship detections (#6/#9/#10) are surfaced report-only in `citadel_report.json` (see the severity-routing contract above), not auto-fixed.

---

## The flywheel — make every future human catch a permanent check (nearly free)

Close the loop between human review and the gate: **when a human or the Council finds a defect the gate missed, the remediation is to write it as a `PATTERN_SHAPE:` trap door in the target's `CLAUDE.md`** — at which point **Mechanism 1 enforces it on every future diff, forever.** The human is the teacher; the conformance scan is the student that never forgets. This converts one-off review labor into compounding automated coverage with a convention plus the one scan — no new code per defect class. M2 surfaces *novel* judgment defects; M1 ensures we never miss the *same* class twice.

---

## Acceptance criteria

All ACs inherit two standing guarantees: **(G1) no new pipeline hard-stop** — findings ride B-HRP's already-shipped no-halt rail (`citadelFindingsToGateResult` → `spawn-gate-remediator`), never a new halt; **(G2) no false-positive inflation** — a clean diff produces zero new findings (guard the converge-to-0 contract, cf. #95 R-SJWT).

- **AC-1 — Close the invocation gap (highest leverage, zero new detectors).** Extract a **state-free `runCitadelStandalone(target)`** from the pipeline-coupled citadel path so the analyzer set runs *outside* `/pickle-pipeline` (and wire the standalone `/anatomy-park` + `/szechuan-sauce` review paths to call it). **Define "review target" concretely:** `target = { workingDir, diffRange }` where `diffRange` defaults to the branch diff (`<default-branch>..HEAD`); no PR number, no live session required. It emits the same `citadel_report.json` as the in-pipeline run. The existing `banned-casts` / `banned-constructs` / `sibling-auth` / `stale-reference` / `schema-registry-drift` / `test-authenticity` analyzers already detect roughly half the LOA-907 classes — they simply were not run. This adds no detector.
- **AC-2 — Coverage audit + extend the closest analyzer.** Run the existing analyzers against the LOA-907 diff fixture; for each verified gap, extend the nearest analyzer: `banned-casts-audit`→`as never` (#9; refinement verified zero coverage at HEAD), `sibling-auth-audit`→**exactly two** new guard tokens `budget-check` + `csrf-validation` at `sibling-auth-audit.ts:255-257` (feature-flag parity `flag-check` is *already* there at `:255` — do **not** re-add it), `stale-reference-audit`→diff-introduced cited-symbol mismatch (#14). Each extended analyzer **declares its emitted `CitadelSeverity`** (from `reporter.ts:1`); a guard test asserts no analyzer emits outside `{Critical,High,Medium,Low}`. **No parallel analyzers** — extend, don't duplicate; R-CCNW-2 module count rises by **0**.
- **AC-3 — The one new analyzer (`pattern-conformance-audit.ts`, build-from-scratch).** It harvests `PATTERN_SHAPE:` declarations from the target's in-scope `CLAUDE.md` and flags a diff hunk that *violates* one; **define the grammar it parses**, and make **absent/malformed declarations a clean no-op (never error/halt)**. Ship the SQL `ON CONFLICT … DO UPDATE SET <col>=<const>` check **in the same module** (count +1), filtering `.sql` off `changedFiles[].path` — **must not** widen `ChangedFileKind`. Wire as one `withFindingSource(f,'pattern_conformance')` line at `audit-runner.ts:137-152` → the existing `citadelFindingsToGateResult` rail; declare emitted severity. **Flywheel-closes sub-assertion (absorbs AC-7's missing proof):** a `PATTERN_SHAPE:` declaration newly introduced into the fixture's `CLAUDE.md` produces a conformance finding when the diff violates it — the one machine-checkable proof the loop turns. Catches #6, #10, and any future documented constraint.
- **AC-4 — *Descoped (target-repo follow-up, no bundle ticket).*** The one net-new lint win belongs in the **target repo's** eslint config, not pickle-rick's gates; recorded as a recommendation in `docs/review-defect-taxonomy.md`. See Non-goals. (Refinement verified the rest already exist in `banned-constructs-audit.ts` and correctly flagged this OUT OF BUNDLE.)
- **AC-5 — Mechanism 2 report-only lens + a *proof* it stays report-only.** Add the skeptic dimension (semantic identity, fallback null-flow, resource lifecycle, cross-file repetition/exhaustiveness, and the dead-guard / no-op-flag / behavior-parity shapes) as prompt bullets on the existing citadel/anatomy analyzer; output goes to a **non-ingested `skeptic_findings.json` sink** (Council-directive style). Surfaces #1, #2, #3, #7, #11, #13, **#15** for a human/follow-up agent. **AC-5b (the safety guarantee, now testable):** a test asserts M2/skeptic findings land in `skeptic_findings.json` and do **NOT** appear in the `GateResult` / remediable set fed to `spawn-gate-remediator`, and are **never** a convergence signal.
- **AC-6 — Fixture regression + no-wedge proof, split by mechanism.** Reconstruct PR #1707's diff as the **dirty** fixture. Assert two separate sets:
  - **Deterministic floor (M1, exact CI assertion):** the invoked + extended analyzers surface **≥ #6, #9, #10, #14**, each pinning the emitted `CitadelSeverity`.
  - **Structural (M2, presence-only):** the `skeptic_findings.json` / `## Skeptic Findings` section is non-empty and names the expected symbols for #1, #2, #3, #7, #11, #13, and **#15** (the entry references `attomSecondPassExceedsLockBudget` / `ENABLE_ATTOM_ENRICHMENT`). Content correctness is validated by **prompt iteration, not a deterministic CI assertion** — #15 is *not* constant-resolvable (no resolver, cross-repo constants, diff-level data); a deterministic version is out of scope and wedge-prone.
  - **G2 needs its own artifact:** add a **paired clean fixture** (forward-created under `extension/tests/`) that exercises every new/extended detector and yields **zero** findings — with per-detector empty cases: `PATTERN_SHAPE` target with no trap doors → no-op; `.sql` diff with no `ON CONFLICT` → clean; route with no documented sibling → no fabricated parity finding; #15-style guard with no in-scope constants → no-op.
  - Prove **G1** (a finding-bearing run does not change the pipeline's terminal exit behavior vs today).
- **AC-7 — Flywheel convention (doc only; the *proof* lives in AC-3).** `docs/review-defect-taxonomy.md` is the append-only seed (already ~90% written from the 2026 corpus); document that a missed-defect remediation adds a one-line taxonomy entry and, if declarable, a `PATTERN_SHAPE:` trap door. Worked examples: the two **proven** carry-forward cases `E2E_MOCK_AUTH` (PR#1585→#1649) and the stale-`module` JSDoc (PR#1586→#1602). The machine-checkable proof that the loop actually *turns* (a new trap door → a finding on a violating diff) is **AC-3's flywheel-closes sub-assertion**, not a separate test here — so AC-7 is a trivial doc ticket, not a code deliverable.
- **AC-8 — Net-complexity check ("what can we delete?") + no double-report.** Confirm the AC-3 conformance analyzer does **not** duplicate `banned-casts` / `banned-constructs` / `sibling-auth`; if it subsumes a bespoke analyzer, delete that one. Acceptance: analyzer count rises by **≤ 1** (asserted in `citadel-analyzer-wiring.test.js`) and total citadel LOC is **flat-or-down** — the B-HRP precedent (net-deleted) and B-GNXR doctrine (remove at the root), not net-add. **Dedup note:** `dedupeCrossPhaseFindings` (`audit-runner.ts:295`) keys on `original_id` and only de-dupes *cross-phase* findings against each other — it cannot merge a native finding against a cross-phase one (native findings carry no `original_id`). Since #14 is now **M1-only** (no M2 twin), the concrete double-report is resolved; the AC must assert no *new* native-vs-native overlap (e.g. AC-3 PATTERN_SHAPE and `banned-casts` both flagging the same `as never` line) is introduced, or accept it explicitly.

**Priority:** AC-1 first (free — half the value is an invocation fix, no new code), then AC-2 (extend existing), then AC-3 (the single new analyzer), AC-5 (M2 report-only), AC-6 (proof), AC-7 (flywheel), AC-8 (delete-check, runs throughout). AC-4 is descoped (target-repo follow-up).

---

## Non-goals / guardrails

Drawn directly from this month's reliability ledger — every one of these is a failure mode the gates already inflicted on themselves:

- **No per-defect bespoke scanners.** Seven special-case finders are rejected (false-positive surface + maintenance rot). One new analyzer (AC-3), everything else is invoke/extend.
- **No new hard-stop / halt / abort.** Findings ride B-HRP's no-halt rail. (B-HRP v1.99.0 *removed* citadel's halt; do not add one back. Cf. B-SMAF / gitnexus-statdrift: gates that abort on tree state wedge launches.)
- **No new state field, schema bump, `exit_reason`, or config knob.** New persisted surface is new drift surface (cf. B-LASP, B-WSWA, and B-ORSR's near-miss on schema-neutrality). The analyzers are stateless and read the diff.
- **No tree mutation and no scope-based abort.** Analyzers are read-only over the diff. (B-SMAF aborted on out-of-scope churn; the gitnexus preflight mutated `CLAUDE.md` and self-bricked the pipeline — B-GNXR removed it entirely.)
- **M2 never feeds the mechanical remediator and never drives a convergence loop.** Fuzzy finders on an iterate-to-0 loop are the B-SJWT / R-SLLJ bug class. M2 is report-only.
- **Net complexity must not rise.** Prefer invoke → extend → delete over add (AC-8). The B-HRP and B-GNXR precedents both shipped quality by *removing* machinery, not adding it.
- **No SQL check buried in conditional Override 6** (journal-gated → skips the very targets this is about).
- **Dropped:** the standalone "missing-regression-test" scanner (#5/#8) as a blocking check — most false-positive-prone; folded into the flywheel (document it → AC-3 enforces it).
- **Target-repo follow-up, not in this bundle:** the `no-unnecessary-type-assertion` eslint rule (and any author-time lint config) lives in the *target* repo (e.g. loanlight-api), not pickle-rick's gates. The brace-free-`if` / nested-ternary classes are already caught by `banned-constructs-audit.ts`. Recorded in `docs/review-defect-taxonomy.md` as a recommendation; refinement flagged it OUT OF BUNDLE.

---

## Notes

- This is **not** an autonomy/recovery bug (cf. B-ORSR family, #100–104). The pipeline ran to completion and produced good work; the gap is **review efficacy** — what the finders are blind to, even on a single package with warm scope. The fix *preserves* autonomy: more finding-power, zero new places a pipeline can stop.
- It validates keeping a human reviewer in the loop for large/architectural PRs **and** gives the finders two general dimensions plus a flywheel, so the human reviews *taste*, not Critical-severity NaN-to-DB and leaked-pool defects — and every catch they do make becomes a permanent automated check. The 2026 corpus adds urgency: for a large fraction of PRs (octy 10/10, ~25% of loanlight-api) **there is no substantive human review at all** — the automated gate is the only reviewer, so its blind spots ship unfiltered.
- **The gates find the obvious; the human finds the load-bearing "why."** #15 was caught not by a reviewer reading the diff but by a human asking a *follow-up question about behavior* ("why are we not doing ATTOM on 1004?") — after the 14 were already fixed and the symptom (#8) had been waved off as intentional. That is the irreducible human contribution this PRD is designed to *amplify*, not replace: M2 operationalizes the "does this make sense?" question into concrete shapes (resolve-the-constants, diff-the-enabling-conditions) so the gate surfaces the load-bearing ones too, leaving the human to ask the questions no checklist anticipates.
- Seed record: **`docs/review-defect-taxonomy.md`** (the flywheel's append-only memory, populated from the 63-PR 2026 corpus). It is both the evidence base for this PRD and the live target for AC-6.

---

## Implementation Task Breakdown

| Order | ID | Title | Priority | Tier | Mapped |
|---|---|---|---|---|---|
| 10 | 28af5d15 | Extract state-free runCitadelStandalone + wire standalone invocation | High | small | AC-1 |
| 20 | 3c7619fd | Extend banned-casts / sibling-auth / stale-reference | High | small | AC-2 |
| 30 | 1c1d094c | New pattern-conformance-audit.ts (PATTERN_SHAPE + SQL) + flywheel + count/dedup | High | medium | AC-3, AC-7, AC-8 |
| 40 | c3a969a1 | M2 report-only skeptic lens → skeptic_findings.json sink + safety proof | High | small | AC-5 |
| 50 | 548559f1 | PR#1707 dirty + clean fixtures, deterministic/structural split, G1/G2 | High | small | AC-6 |
| 60 | 1eb80f18 | Wire: integrate standalone + new analyzer + M2 sink end-to-end | High | medium | AC-1/3/5 |
| 70 | 3284688f | Harden: code quality review | High | large | AC-8 |
| 80 | bb9f76d1 | Audit: data flow integrity | High | large | AC-5/8 |
| 90 | 05e86ab7 | Harden: test quality review | High | large | AC-6 |
| 100 | ec79dcca | Audit: cross-reference consistency | High | medium | AC-7 |

(AC-4 descoped — target-repo eslint follow-up, not in this bundle.)
