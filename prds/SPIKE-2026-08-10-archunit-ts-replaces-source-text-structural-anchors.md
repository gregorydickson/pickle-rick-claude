# SPIKE-ARCHUNIT — replace source-text structural anchors with AST-based architecture rules

**Status:** Draft — **time-boxed spike with pre-committed kill criteria**
**Branch:** `release/v2.1-beta`
**Baseline:** `b8281478`
**build_mode:** `unattended` — test-tier and dev-dependency work only; does not touch the
salvage / completion-evidence / Done-flip seam, so R-PSRB does not apply.
**Library:** [ArchUnitTS](https://github.com/LukasNiessen/ArchUnitTS) — TS-AST architecture testing
(dependency direction, cycles, layer/allowlist rules, naming). Inspired by Java's ArchUnit.

---

## The thesis

This repo has already built a poor-man's ArchUnit **in regex**, and the regexes go stale in ways that
cost more than the bugs they catch.

Measured at `b8281478`:

```
42   test files read src/ as TEXT and assert on its contents
287  PATTERN_SHAPE anchors across the three trap-door catalogs
~15  of those are dependency-shaped (importer / caller-count / cycle)
```

`AP-EXT-ITER12-01` ("catalog-anchor executability") already catalogues **four** ways a source-text
anchor goes false: call sites centralised; a symbol renamed to a test seam; prose that matches its own
grep; an identifier that never existed. This session produced two fresh instances — a test grepping
`emitCgSessionSummary`, a symbol with **no definition anywhere in `src/`**, and a citadel finding
citing a line that already has braces. R-BCFR's tally for the class: **20 remediation aborts, 0 fixes.**

**An AST rule cannot fail that way.** If a symbol moves, the rule follows it or fails honestly.

**A live example of the failure mode, found while writing this PRD:** grepping for the enforced symbols
matched `src/bin/CLAUDE.md` and `src/services/CLAUDE.md` — the catalogs describing the rules. The prose
matches its own grep. That is falsification mode #3, in the very measurement used to scope this spike.

---

## What is IN and what is explicitly OUT

**IN — dependency-shaped invariants only.** Four verified against live source at `b8281478`:

| # | Invariant (today's enforcement) | Ground truth now |
|---|---|---|
| 1 | `R-AFCC-CALLER-ENUMERATION` — the completion-evidence oracle has exactly 2 importers | `bin/auto-fill-completion-commit.ts`, `bin/mux-runner.ts` ✓ |
| 2 | `completion-authority-single-source` — terminal `Done`/`Skipped` writes confined to an allowlist | `bin/mux-runner.ts`, `services/pickle-utils.ts` — **only 2 of the 4 allowlisted files still contain it** |
| 3 | B-1SEAM — `salvageDirtyTree(` reaches exactly 2 call sites | `bin/mux-runner.ts`, `bin/microverse-runner.ts` ✓ |
| 4 | `EXIT_REASONS` parity — *"`types/index.ts` cannot import `mux-runner.ts` without a cycle, so the type system does not tie them; **a source-text test does**"* | 0 such imports ✓ |

Invariant 4 is the sharpest argument in the document: the catalog **names the cycle constraint in
prose** and then enforces it with a string comparison, because nothing better was available.
Cycle detection is a first-class ArchUnitTS feature.

**OUT — everything behavioural.** ArchUnitTS has nothing to say about these and no rule may attempt them:

- intra-function ordering (*"the guard must be called BEFORE `markTicketDone`"*)
- implementation choice (*"stamp via `interpret-trailers`, not `printf`"*)
- call-site arguments (*"every spawn passes a finite `timeout`"*, *"`maxBuffer` present"*)
- entry ordering within a rendered payload

**OUT — the metrics module, entirely.** `mux-runner.ts` is ~11 k lines; LCOM / complexity / distance
metrics would emit a wall of findings nobody acts on. That is the flaky-gate-input class this repo's
governance says to subtract, not add. Do **not** enable it, even "just to look".

**OUT — report/graph generation.** Marked experimental upstream.

---

## Simplification Review

1. **Is the addition necessary?** It adds one dev dependency and a rule file. Justified **only** as a
   trade: every rule added MUST delete a hand-rolled source-text test in the same commit.
2. **REUSE instead of ADD?** No in-repo primitive does AST dependency analysis. The closest is
   `audit-trap-door-enforcement.sh` (grep) — which is precisely what is being replaced, not duplicated.
3. **Does it guard existing brittle complexity that should be SUBTRACTED?** Yes, and that is the point.
   The four target invariants are guarded today by greps with a documented staleness failure mode.
   **Net anchor count must go DOWN** (AC-D1). If it goes up, the spike failed by definition.
4. **What does this SUBTRACT?** At minimum three bespoke test files' structural assertions, ~15
   PATTERN_SHAPE anchors long-term, and one whole class of phantom finding. It also *retires* the
   need to hand-maintain caller counts in catalog prose.

---

## Workstreams

### WS-A — the four dependency rules, each replacing a grep

- AC-A1: **Every** rule in the new suite is dependency-, cycle-, or allowlist-shaped. No rule asserts
  intra-function ordering, argument presence, or a metric. Verify: `grep -cE "lcom|complexity|countOfMethods|distance" extension/tests/architecture/*.ts` is 0 — Type: lint
- AC-A2: **For each** of the four invariants, an ArchUnitTS rule expresses it AND the source-text
  assertions it replaces are deleted in the same commit. Verify: each commit touching
  `tests/architecture/` also shows deletions in `tests/*.test.js` — Type: lint
- AC-A3: The suite runs in `test:fast` — it is AST-over-`src/`, not subprocess work — so **every worker
  gate** enforces it, not just a closer. Verify: the file carries `// @tier: fast` and appears in a
  `npm run test:fast` run — Type: test
- AC-A4: ArchUnitTS is a **devDependency** and reaches no deploy tree. Verify: `node -e "const p=require('./extension/package.json'); process.exit(p.dependencies?.['archunit']?1:0)"` exits 0, AND `R=$(mktemp -d); PICKLE_INSTALL_ROOT=$R bash install.sh >/dev/null 2>&1; find "$R" -name 'archunit*' | wc -l` is 0 — Type: integration

### WS-B — cycle detection, the one genuinely NEW capability

No existing test detects import cycles; the catalogs merely *assert* in prose that certain cycles
would occur. This is the spike's upside case, not a replacement.

- AC-B1: A rule asserts the repo-wide `src/` import graph is cycle-free, OR — if cycles already exist —
  the run **reports them as a finding and the spike records the list**, rather than the rule being
  weakened to pass. Verify: run it; the count is recorded in the ticket either way — Type: test
- AC-B2: The `types/index.ts` ↛ `bin/**` constraint named in the `EXIT_REASONS` trap door is expressed
  as a dependency rule, and its source-text twin is deleted. Verify: rule present; twin gone — Type: lint

### WS-C — the falsification matrix (**the actual point of the spike**)

A rule that survives a rename but reddens on a real violation is worth having. One that does the
reverse is worse than the grep it replaced. **This workstream decides the outcome.**

- AC-C1: **For every** rule in the suite, both halves of the matrix hold:
  **(a) green through a pure rename** — rename an enforced symbol and its references (`npx tsc --noEmit`
  clean), the rule stays green; **(b) red on a real violation** — add a third importer / a
  `markTicketDone(` in a non-allowlisted file / an import cycle, the rule goes red.
  Verify: run both mutations per rule and record the 2×N result table in the ticket — Type: llm-conformance
- AC-C2: **Zero** rules produce a finding on the unmodified tree at `b8281478` other than genuine
  pre-existing violations, each individually confirmed by reading the source. A finding that cannot be
  confirmed by reading the source is a **false positive and kills that rule** — Type: llm-conformance
- AC-C3: The rename half of AC-C1 is proven against a rename that **would have broken the grep** —
  concretely, the `emitCgSessionSummary`-class rename. Verify: the equivalent rename leaves the AST rule
  green — Type: test

### WS-D — the anchor census, so "subtractive" is a number and not a vibe

- AC-D1: Net structural-anchor count **decreases**. Verify: record before/after for
  `grep -rlE "readFileSync\([^)]*(src/|_SRC|MUX_SRC)" extension/tests/ | wc -l` (42 at baseline) and the
  per-catalog `PATTERN_SHAPE` counts (132 / 85 / 70 at baseline); after must be lower on at least the
  test-file count and no higher on any catalog — Type: lint
- AC-D2: **Every** catalog entry whose anchor was replaced is updated to name the ArchUnitTS rule as its
  ENFORCE, so no entry is left citing a deleted grep. Verify: for each replaced anchor, the entry's
  ENFORCE line names the rule file — Type: lint

### WS-E — pre-committed kill criteria (write these down BEFORE running)

Recorded now so the outcome cannot be rationalised afterwards. **Any one of these kills the spike**;
the ticket then reverts the dependency and records why.

1. **Any** false positive on the unmodified tree that cannot be confirmed by reading source (AC-C2).
2. **Any** rule that stays green under its real-violation mutation (AC-C1b) — it enforces nothing.
3. **Any** rule that reddens under a pure rename (AC-C1a) — it reproduces the grep's failure mode with
   extra machinery.
4. Net anchor count does not decrease (AC-D1) — additive, therefore the R-ATBG pattern.
5. The suite adds more than **20 s** to `test:fast`. Verify: time the tier before and after — the tier
   runs on every worker gate and its budget is not free.
6. The dependency reaches any deploy tree (AC-A4).

- AC-E1: The kill criteria are evaluated **explicitly, one by one**, and the verdict is recorded in the
  ticket with evidence — including a KILL verdict if one fires. A spike that reports only success is a
  spike that was not run honestly.

---

## Incidental finding, already surfaced by scoping this

`completion-authority-single-source` allowlists **four** files for terminal `Done`/`Skipped` writes;
only **two** still contain `markTicketDone(` / `markTicketSkipped(` (`bin/mux-runner.ts`,
`services/pickle-utils.ts`). The allowlist is **wider than reality** — it would permit two files to
start writing terminal status without any gate objecting. That is exactly the drift an AST rule makes
visible and a grep-against-an-allowlist does not. **Do not silently narrow it in this spike** — record
it; narrowing the completion-authority surface is its own bundle with its own review.

---

## Bundle-wide gate

```
cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc \
  && bash scripts/audit-test-tiers.sh \
  && bash scripts/audit-test-isolation.sh \
  && bash scripts/audit-subprocess-heavy-tests.sh \
  && bash scripts/audit-trap-door-enforcement.sh \
  && npm run test:fast \
  && npm run test:integration:parallel
```

The three audits are named explicitly: npm binds `pre` hooks to literal script names and there is no
`pretest:integration:parallel`, so the split invocation otherwise runs with zero audit preflight.

`audit-trap-door-enforcement.sh` matters most here — it verifies every catalog entry's ENFORCE is
reachable, so it is what catches a WS-D catalog update that points at a rule file that does not exist.

**Measurement note:** the fast tier has timeout-shaped flakes at `-c 8`, and this box currently runs
Time Machine. Take the AC-E1 §5 timing at rest (`uptime` load < 4, `tmutil status` not `Running`) or the
20 s budget verdict is meaningless.

---

## Out of scope

Metrics, reports, the graph module, Nx support, UML validation. Replacing behavioural PATTERN_SHAPE
anchors. Narrowing the completion-authority allowlist. Expanding beyond the four named invariants —
that is the **follow-up** bundle, gated on this spike returning a clean falsification matrix.
