# B-FIELD-82 — field issues #77, #78, #79, #80, #81, #82, screened against the PRIME DIRECTIVE (`main`)

Refinement ON (prompt-contract changes). Premises measured 2026-10-06 at `main@faf459cd` (TZ=UTC, Node 24), in the
main checkout, read-only. Each claim is MEASURED (with its command) or marked HYPOTHESIS. Issue texts reach this PRD
by number and generic shape only; this PRD carries no client data.

**Invariants kept.**
- Gate legs: 22 → 22. No new gate leg, halt, `exit_reason`, verdict input, activity event or classifier.
- The pipeline never stops for any item here. One item is a deploy-shape change; the rest are prompt or report text.
- The one item that bears on the success verdict (T5) reuses `computePipelineVerdict`'s existing `openDecisions`
  term (`extension/src/bin/pipeline-runner.ts:6291`). Zero new runtime code for it.

## The screen (root `CLAUDE.md`), applied to every candidate

1. Would the NEXT ITERATION fix it? If yes, record it and add nothing.
2. Adds no halt, abort or launch-block condition.
3. Widens or subtracts before it adds; no new enumerated-set member without a written reason.
4. Any new check lives inside an EXISTING leg and names its falsifying control.
5. Every executable AC was RUN at HEAD and FAILS today (values below are the measured ones).
6. Files lists only paths that exist, and every exact-shape pin of a changed shape.

## Tickets

### T1 — #77: the deployed extension stops depending on the source checkout (Tier 1, reliability)

**Measured.**
- `install.sh:407-411` symlinks `typescript`, and `install.sh:421-433` (git mode) symlinks
  `@colbymchenry/codegraph` plus the resolved platform binding, from `$SCRIPT_DIR/extension/node_modules` into the
  deploy root. On this host, 3 links under `~/.claude/pickle-rick/extension/node_modules` resolve outside the deploy
  root (realpath check).
- `typescript` is in `devDependencies` only; deployed `did-we-count-replay.js` and
  `citadel/frontend-prop-drift-audit.js` import it at runtime (`grep -l "from 'typescript'"` over `extension/src`
  minus tests → those 2 files). Tarball mode runs `npm install --omit=dev` at the deploy root (`install.sh:443`), so
  a tarball install has NO `typescript` at all — HYPOTHESIS that those two modules fail to load there; the ticket
  measures it.
- `npm ls --omit=dev --all --parseable` in `extension/` lists exactly the runtime closure (today: codegraph + the
  platform binding, 1.2M + 278M). The list is derivable; no hand-maintained dep list is needed.

**Why it earns code.** The release gate begins with `npm ci` in `extension/`, which deletes the link targets. A
pipeline running during a gate (or after `git clean -xfd`, a branch switch with a different lockfile, a removed
worktree) loses modules mid-run → halt. The next iteration cannot fix a halt.

**Solution (subtraction).**
- Move `typescript` from `devDependencies` to `dependencies` in `extension/package.json` (and the lockfile).
- Git mode: replace both link blocks with ONE copy step that derives the closure from
  `npm ls --omit=dev --all --parseable` in the source `extension/` and copies each resolved package directory into
  the same relative path under the deploy root (`cp -R`, dereferencing). Delete the `for dep in typescript` loop and
  the git-mode codegraph link branch. Tarball mode is unchanged (it already installs real directories).
- `install.sh:588` (a link inside the SOURCE tree's own `node_modules/.bin`) is out of scope: it is not a deploy
  dependency.

**Acceptance criteria.**
- `node -e 'process.exit(require("./extension/package.json").dependencies.typescript?0:1)'` exits 0 (exits 1 today).
- `grep -cE 'ln -sfn "\$(SCRIPT_DIR/extension/node_modules|_cg_)' install.sh` returns 0 (returns 3 today).
- In `extension/tests/integration/install-typescript-package.test.js` (existing, integration tier — it already installs
  into a sandbox `--prefix`), a new assertion: every symlink under `<prefix>/extension/node_modules` resolves inside
  `<prefix>`. **Falsifying control:** restore the `ln -sfn` loop → the assertion reds (3 escaping links on a host
  whose source has codegraph installed).
- The existing module-load smoke in that file still exits 0 after the install.

**Files.** `install.sh`, `extension/package.json`, `extension/package-lock.json`,
`extension/tests/integration/install-typescript-package.test.js`, `extension/tests/install-script.test.js` (pins the
old shape: the `for dep in typescript` fixture copy ~:1417, `typescript-symlink` tests ~:1445/:1463, the codegraph
link regex ~:1498, the loop-shape tests ~:1653/:1669 — each is updated to the copy shape or deleted with the
behaviour it pinned).

**Risk.** Each sandbox install now copies ~300MB. Several integration tests install into a temp prefix; they must
clean up (they do today via `rmSync` in `finally`). Measure the tier's wall-clock before/after and report it.

### T2 — #78: a ticket that applies a decision quotes the decision (Tier 2)

**Measured.** Step 7a already requires "Self-contained: worker executes without reading PRD"
(`.claude/commands/pickle-refine-prd.md:196`). The workflow decompose phase does not restate the rule — it reads this
file's Step 7a (`.claude/workflows/refine-analyze.js:273`), so ONE edit covers both decomposition paths. The defect is
a violation of an existing rule, so the fix widens that rule.

**Solution.** Extend the 7a bullet: a ticket that applies a recorded decision or ruling (D-n, R-n, an Open Decisions
row) quotes the decision's text verbatim — an id alone is not self-contained. Acceptance-criterion wording is carried
into tickets unparaphrased.

**AC.** `grep -c 'an id alone is not self-contained' .claude/commands/pickle-refine-prd.md` returns 1 (returns 0 today).

**Rejected.** The proposed pointer-only audit row and AC-paraphrase diff: a new classifier inside `audit-ticket-bundle`
for a rule the prompt can state. Revisit only if a field run shows the widened rule did not hold.

**Files.** `.claude/commands/pickle-refine-prd.md`.

### T3 — #79: one owner ticket per shared rule (Tier 2)

**Solution.** Add a Step 7a bullet: a rule or predicate consumed by two or more tickets has ONE rule owner ticket
that defines it for every input side, with a symmetry test (each input side × each outcome) in its acceptance
criteria; consumer tickets order after it; a rule owner ticket is never tier `small`.

**AC.** `grep -ci 'rule owner' .claude/commands/pickle-refine-prd.md` returns ≥ 1 (returns 0 today).

**Rejected.** A tier-floor case in the runtime tier heuristic (an enumerated-set member). The floor is stated in the
decomposition prompt that already assigns `complexity_tier`.

**Files.** `.claude/commands/pickle-refine-prd.md`.

### T4 — #80: research names the writers of the inputs it reads (Tier 2)

**Measured.** The worker research step is rendered by `spawn-morty.ts:525-527` ("What IS, not SHOULD BE … Write
research: Summary, Context (file:line), Findings, Constraints"). No test pins that text
(`grep -rl "What IS, not SHOULD BE" extension/tests` → 0 files).

**Solution.** Extend that block: for each persisted input (row, column, file, field) the change reads, cite its writer
and write condition (conditional nulling, rejection), and build fixtures through that writer where one exists.

**AC.** `grep -c 'write condition' extension/src/bin/spawn-morty.ts` returns ≥ 1 (returns 0 today).

**Rejected.** The fixture-realism checker (no repo-independent formulation — it needs a per-repo model of every
producer), and a plan-review refusal when the section is missing (a new refusal).

**Files.** `extension/src/bin/spawn-morty.ts`, `extension/bin/spawn-morty.js` (compiled).

### T5 — #82 (analyst half): a counter-example to a recorded decision is an open decision (Tier 2)

**Measured.** Synthesis rule 13 writes `## Open Decisions` on BOTH synthesis surfaces
(`.claude/commands/pickle-refine-prd.md:188`, `.claude/workflows/refine-analyze.js:236-238`). `readOpenDecisions`
(`pipeline-runner.ts:3540`) feeds `computePipelineVerdict` (`:6291`), which withholds success while any row is open,
and `discloseOpenDecisions` prints them at run start and end (`:5665`, `:7487`).

**Solution.** Widen rule 13 on both surfaces: an analyst's counter-example to a recorded decision — named inputs for
which the decided rule yields a wrong output — is written as an `open` row, even when the decision is marked final.
It is never closed by "already decided".

**AC.** `grep -c 'counter-example to a recorded decision' .claude/commands/pickle-refine-prd.md
.claude/workflows/refine-analyze.js` returns 1 for each file (0 for each today).

**Files.** `.claude/commands/pickle-refine-prd.md`, `.claude/workflows/refine-analyze.js`.

### T6 — #81: the citadel coverage table says what it measures (Tier 2)

**Measured.** The issue's "keyword matching" premise is PARTLY STALE. Keyword anchors no longer credit coverage:
`buildRow` calls `findImplementation([])` / `findTests([])` (`ac-coverage-scorecard.ts:199,207`); anchor hits are
reported as `lexical-only` (`:292`). What credits `implemented`/`tested` is an AC id or a mapped entity string
appearing in a changed line (`:232-238`) — evidence of MENTION, not that the criterion holds. The table header reads
`| ID | Implemented | Tested | File:line evidence |` (`:149`); no test pins it (`grep -rn "Implemented | Tested"
extension/tests` → 0).

**Solution.** Rename the columns to `Mentioned in code` / `Mentioned in tests` and add one line under the table:
coverage means the criterion's id or a mapped entity appears in a changed line; it is not a check that the criterion
holds. Field names in `citadel_report.json` are unchanged.

**AC.** `grep -c 'Mentioned in' extension/src/services/citadel/ac-coverage-scorecard.ts` returns ≥ 2 (0 today).

**Files.** `extension/src/services/citadel/ac-coverage-scorecard.ts`, its compiled JS,
`extension/tests/citadel-ac-coverage-scorecard.test.js`.

## Rejected or recorded (not built)

| Candidate | Screen it failed |
|---|---|
| #82: block the build until an operator acknowledges a non-zero readiness / ticket-audit exit | 2 — an abort condition; also reverses R-GATE-ADVISORY (`mux-runner.ts:13869-13878`, `:13903-13910`): both checks false-blocked legitimate bundles |
| #82: carry the advisory exit into the final report | 3 — needs a new event/channel for a heuristic with a false-block history; T5 carries the decisive signal (the analyst counter-example) through an existing channel. The exit is already in the runner log |
| #81: per-criterion counter-example generation | 3 — a model spawn per criterion ("precision that costs a spawn") |
| #81: run citadel after anatomy-park | phase-order change; operator decision (2026-09-16 "review phases stay simple") |
| #81: diff citadel from the scope base, not `start_commit` | HYPOTHESIS only — no field session on this host to measure whether `start_commit` ≠ `scope.json` `base_sha` in the stacked build. Measure on the next field run |
| #59 (PRD ids in shipped code) | already satisfied — `spawn-morty.ts:515` ("Name the behaviour, not the PRD clause", MREL-B3) |
| Worker rule "every test spawn gets an explicit `timeout:`" | 1 — already stated at `extension/CLAUDE.md:76`, and the gate's subprocess audit catches violations; putting a pickle-only convention into every target repo's worker prompt reproduces #62 |
| #77: pin tarball installs to a lockfile | the deploy-tree lockfile exclusion is intentional (`install.sh:417-419`) |

## Simplification Review

1. **Necessary?** T1 removes a halt path (reliability). T2–T6 are prompt or report text; no runtime branch is added.
2. **Reuse?** T2 widens an existing 7a rule; T5 reuses the Open Decisions table and verdict term; T1 reuses the
   lockfile-installed source tree as the copy source and derives the dep list from `npm ls`.
3. **Guarding brittle complexity?** #82's launch block would have guarded the advisory readiness gate whose
   brittleness is why it was demoted — rejected for that reason.
4. **Subtracted.** T1 deletes the hand-maintained `for dep in typescript` list and the git-mode codegraph link
   branch (the list becomes derived). T6 removes an overclaim from a report.

## Verification order

T1 first (independent). T2 → T3 (same file). T4, T5, T6 independent. The release gate (22 legs) runs after the bundle.
