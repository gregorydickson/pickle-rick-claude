# B-FIELD-82 — field issues #77, #78, #79, #80, #81, #82, screened against the PRIME DIRECTIVE (`main`) — REFINED

Source: `prds/p1-b-field-82.md` @ `main@62131993`. Refined from 3 analysts × 3 cycles (all 9 succeeded). Every change
from the source is attributed `*(refined: <analyst> c<N>)*`. Issue texts reach this PRD by number and generic shape
only; no client data.

**Invariants kept.**
- **No gate leg added** (the `&&` chain in `release.yml:61` / `ci.yml:63` counts 21 links including `npm ci`; the source
  PRD's "22" was a wrong literal). *(refined: requirements c3, codebase c3, risk-scope c3)*
- The pipeline never stops for any item here. T1 changes the deploy shape and widens an EXISTING `install.sh` `exit 1`
  (an install-time failure, never a pipeline-loop halt — workers are forbidden to run `install.sh`). The rest are
  prompt or report text.
- T4 bears on the success verdict through `computePipelineVerdict`'s existing `openDecisions` term
  (`pipeline-runner.ts:6291`). It acts only on refinement-ON runs, because `readOpenDecisions` reads `prd_refined.md`
  only. *(refined: requirements c3, risk-scope c3)*

## Premises

| Claim | Tag | Evidence |
|---|---|---|
| 3 deployed `node_modules` links resolve outside the deploy root (typescript, codegraph, platform binding) | (verified) | realpath check of `~/.claude/pickle-rick/extension/node_modules`; `install.sh:409,425,432` |
| `typescript` is devDependency-only, yet `pipeline-runner.js` reaches it at load: `:114` → `citadel/audit-runner.ts:7` → `frontend-prop-drift-audit.ts:3` | (verified) | static import walk (risk-scope c2/c3) |
| `did-we-count-replay.js` has no deployed caller and also needs `eslint`/`typescript-eslint`; it is NOT part of T1's premise | (verified) | requirements c2, codebase c3 |
| The link failure surfaces at the next pipeline **launch or `--resume`** after the source tree loses `node_modules`, not mid-run (codegraph is lazy and fails open) | (verified) | risk-scope c2/c3; source PRD's "mid-run" mechanism is falsified |
| Self-update (`check-update.ts:381-391`) runs `install.sh` from an extracted release with no `.git` → TARBALL mode | (verified) | `check-update.ts:14-25`, `:388` |
| Tarball/self-update deploys cannot load `pipeline-runner.js` at HEAD (no `typescript` under `--omit=dev`) | (hypothesis) | `install.sh:328-331` + import chain; T1 measures it |
| After `typescript` moves to `dependencies`, the tarball named install at `install.sh:443` also installs it | (verified for resolve plan only) | `npm install --dry-run` → `add typescript 5.9.3` (codebase c2) |
| `npm ls --omit=dev --all --parseable` prints REALPATHS; `install.sh:4` `SCRIPT_DIR` is logical | (verified) | codebase c3: under `/tmp` every line printed `/private/tmp/…` |
| The derived closure lists only installed platform bindings (no phantoms) | (verified) | codebase c3 |
| `rsync --delete-excluded` (`install.sh:380`) deletes deployed `node_modules` every deploy | (verified) | comment `install.sh:404` |
| Keyword anchors no longer credit citadel AC coverage; credit = AC id or mapped-entity string in a changed line | (verified) | `ac-coverage-scorecard.ts:199,206,232-238` |
| The coverage header is ONE source line at `ac-coverage-scorecard.ts:148`; no test pins it | (verified) | grep (requirements c3) |
| `research_review` FAILs research that "proposes solutions" (`spawn-morty.ts:530`) | (verified) | codebase c3 |
| Of 40 local `prd_refined.md`, 25 have `## Open Decisions` and 0 have an open row | (verified) | risk-scope c3 corpus count |

## Open Decisions

| decision | options | default | owner | status |
|---|---|---|---|---|
| none | | | | |

## Tickets

### T1 — #77: the deployed extension stops depending on the source checkout (Tier 1, reliability) — `large`

**Problem.** In git mode `install.sh` symlinks `typescript` (`:407-411`) and `@colbymchenry/codegraph` + its platform
binding (`:421-433`) from `$SCRIPT_DIR/extension/node_modules` into the deploy root. When the source loses
`node_modules` (`npm ci` during a gate, `git clean -xfd`, `git worktree remove`), the next pipeline launch or
`--resume` fails with `ERR_MODULE_NOT_FOUND` until a redeploy. Separately, `typescript` is a devDependency, so tarball
(self-update) deploys very probably cannot load `pipeline-runner.js` at all — and the codegraph-only self-probe
(`:447`) reports `OK` anyway. *(refined: risk-scope c2/c3)*

**Solution (subtraction).**
1. Move `typescript` to `dependencies`: `cd extension && npm install --save-prod typescript@^5.9.3`. The lockfile diff
   should touch only typescript's entry (record the measured line count). *(refined: risk-scope c3)*
2. Git mode: inside the git arm of the existing `CODEGRAPH RUNTIME DEP` block (KEEP that banner literal —
   `install-script.test.js:1669` anchors on it), after the rsync and before the self-probe, copy the derived closure:
   ```
   _closure="$(cd "$SCRIPT_DIR/extension" && npm ls --omit=dev --all --parseable 2>/dev/null || true)"
   _root="$(printf '%s\n' "$_closure" | head -n1)"
   printf '%s\n' "$_closure" | while IFS= read -r p; do
     case "$p" in "$_root"/node_modules/*) ;; *) continue ;; esac
     dst="$EXTENSION_ROOT/extension/${p#"$_root"/}"
     rm -rf "$dst"; mkdir -p "$(dirname "$dst")"
     cp -cR "$p" "$dst" 2>/dev/null || cp -R "$p" "$dst"
   done
   ```
   The prefix comes from npm's own first line, so a symlinked checkout path cannot empty the copy, and the root line
   filters itself out. *(refined: codebase c3)* Delete the `for dep in typescript` loop and the git-arm `ln -sfn`
   lines. No hand-maintained dependency list remains.
3. Widen the EXISTING self-probe at `install.sh:447` to also `import('./bin/pipeline-runner.js')` (the real
   `typescript` consumer; guarded by the CLI basename check, so the import is inert). This widens an existing `exit 1`;
   it adds no new abort site and no gate leg. Effect: a deploy that today "succeeds" with an unloadable runner now
   fails loudly at install time. That is honest reporting at install, not a pipeline halt. *(refined: risk-scope c2/c3,
   codebase c3; the requirements analyst's objection is recorded below)*
4. Tarball mode: no `install.sh` edit. The named install at `:443` now pulls `typescript` too (~23MB more fetch per
   auto-update under the existing 600s `INSTALL_SCRIPT_TIMEOUT_MS`). Resolution stays unpinned by design.
5. Update the comments that describe the old shape: `install.sh:328-331`, `:398-405`, `:413-419`;
   `check-update.ts:14-25` (fetch size).
6. `install.sh:585`/`:588` (source-tree links) are out of scope.

**Acceptance criteria.**
- `node -e 'process.exit(require("./extension/package.json").dependencies.typescript?0:1)'` exits 0 (exits 1 today).
- `sed -n '/MODE DETECTION/,/OK codegraph/p' install.sh | grep -c 'ln -s'` returns 0 (returns 3 today). This is a shape
  hint only; the behavioural assertion below is the real check. *(refined: requirements c3)*
- `cd extension && npm ci` exits 0.
- In `extension/tests/integration/install-typescript-package.test.js`, test `codegraph per-mode deploy` (`:55`), git
  mode: (a) `:95`/`:103` invert to `!isSymbolicLink() && isDirectory()`, and the title drops "scoped symlinks";
  (b) for every package in the source closure (`npm ls --omit=dev --all --parseable` lines under the FIRST line's
  `node_modules/`), `fs.realpathSync(createRequire(path.join(prefix,'extension','bin','pipeline-runner.js')).resolve(pkg))`
  starts with `fs.realpathSync(prefix)`; (c) `<prefix>/extension/src` does not exist.
  **Falsifying controls:** restore the `ln -sfn` loop → (a) and (b) red; include the root line in the copy → (c) reds.
- The existing R-DTS-3 module-load smoke (`:14`) still exits 0.
- **Tarball axis (measurement, recorded in the completion note):** `git archive HEAD | tar -x -C <tmp>`, then
  `bash <tmp>/install.sh --prefix <p> --no-confirm`, then `node -e "import('<p>/extension/bin/pipeline-runner.js')"`
  exits 0. Record the same run at the pre-change commit as the control. If not run: write **tarball axis UNRUN**.
- Completion note reports `install.sh` wall-clock and peak TMPDIR bytes, before and after. No threshold.

**Files.** `install.sh`, `extension/package.json`, `extension/package-lock.json`, `extension/src/bin/check-update.ts`
(comment only) + `extension/bin/check-update.js`, `extension/tests/integration/install-typescript-package.test.js`,
`extension/tests/install-script.test.js`:
- `:1489` — invert the `_cg_src` link regex into an absence assertion plus a copy-step presence assertion;
- `:1637` — re-anchor `gitIf` on the new git-arm opener; keep the "spec read + FATAL only in tarball" assertions;
- `:1653` — delete (the loop it guards is deleted);
- `:1669` — unchanged (banner kept);
- `:1408-1486` — delete the mirror fixture and its `install.sh typescript symlink` describe (do not port).

**Risk.** The deploy wipes deployed `node_modules` before the copy, so a `pipeline-runner` launch during a deploy fails
for the copy's duration (~0.1s cloned, ~0.8s+ uncloned, vs ~0s for links). Accepted; no lock. Disk: ~302MB per uncloned
sandbox install; sandbox installers are integration-tier and clean up in `finally`.

**Recorded objection (requirements c3).** Widening the probe makes a broken tarball deploy exit 1 instead of 0. Not
taken as a reason to skip: the alternative leaves the self-update path reporting success over an unloadable runner,
which is the fake-green class. The tarball measurement above runs before the gate.

### T2 — #78 + #79: Step 7a carries decision text and gives every shared rule one owner — `medium`

*(merged from source T2+T3; refined: all three analysts c2/c3)*

**Problem.** Step 7a already says "Self-contained: worker executes without reading PRD"
(`.claude/commands/pickle-refine-prd.md:196`), and the workflow decompose phase reads this same Step 7a
(`.claude/workflows/refine-analyze.js:273`). A field build still cited decisions by id only, and split one shared rule
across tickets with no owner, tiering the rule-defining ticket `small`.

**Solution.** In `.claude/commands/pickle-refine-prd.md` Step 7a:
- Extend the self-contained bullet: a ticket that applies a recorded decision or ruling (D-n, R-n, an Open Decisions
  row) quotes the decision's text verbatim — an id alone is not self-contained. Acceptance-criterion wording is carried
  into tickets unparaphrased.
- Add a bullet: a rule or predicate consumed by two or more tickets has ONE rule owner ticket that defines it for every
  input side, with a symmetry test (each input side × each outcome) in its acceptance criteria; consumer tickets order
  after it.
- Inside the tier paragraph (`:205`), as an exception: a rule owner ticket is never tier `small`.

**Acceptance criteria** (each returns 0 today):
- `grep -c 'an id alone is not self-contained' .claude/commands/pickle-refine-prd.md` returns 1
- `grep -c 'unparaphrased' .claude/commands/pickle-refine-prd.md` returns 1
- `grep -c 'rule owner ticket' .claude/commands/pickle-refine-prd.md` returns 1
- `grep -c 'symmetry test' .claude/commands/pickle-refine-prd.md` returns 1
- `grep -c 'is never tier' .claude/commands/pickle-refine-prd.md` returns 1
- `npm run test:fast` passes: six fast-tier suites read this file (`refine-analyze-workflow`,
  `pickle-refine-prd-failure-mode-checklist`, `spawn-refinement-team-checker`, `acceptance-assertion-authoring-form`,
  `spawn-refinement-claude-only`, `skill-prompt-shape/fom-infusion-prompts`).

**Rejected.** A pointer-only audit row, an AC-paraphrase diff, and a runtime tier-floor case (new classifiers /
enumerated-set members).

**Files.** `.claude/commands/pickle-refine-prd.md`.

### T3 — #80: research names the writers of the inputs it reads; plans build fixtures through them — `medium`

**Problem.** Research described the code being changed but not the producers of the rows it reads, so an upstream
conditional null went unseen and a fixture encoded a state the producer cannot write.

**Solution.** In `extension/src/bin/spawn-morty.ts`:
- Research block (`:526`, "what IS"): "For each persisted input the change reads (row, column, file, field), cite its
  writer and write condition (conditional nulling, rejection) as `file:line`."
- Plan block (`:534`): "Build test fixtures through the input's writer where one exists."
The fixture clause goes in Plan, not Research, because `research_review` FAILs research that proposes solutions
(`:530`) — in research it would loop medium/large tickets. *(refined: codebase c3, requirements c2/c3)*

**Acceptance criteria.**
- `grep -c 'write condition' extension/src/bin/spawn-morty.ts` returns ≥ 1 (0 today).
- In `extension/tests/spawn-morty-tier-phases.test.js` (fast tier, already imports `buildTierLifecycleSections`):
  `buildTierLifecycleSections(TIER_LIFECYCLE.medium,'medium')` contains `write condition`, and
  `buildTierLifecycleSections(TIER_LIFECYCLE.small,'small')` contains `through the input's writer`.
  Control: revert either sentence → red.

**Rejected.** A fixture-realism checker and a plan-review refusal.

**Files.** `extension/src/bin/spawn-morty.ts`, `extension/bin/spawn-morty.js`,
`extension/tests/spawn-morty-tier-phases.test.js`.

### T4 — #82 (analyst half): a counter-example to a recorded decision is an open decision — `medium`

**Problem.** An analyst showed a decided rule produces wrong outputs for named inputs, then deferred ("not reopening
it"). The decision stood and became the review blockers.

**Solution.** APPEND to synthesis rule 13 on BOTH surfaces (`.claude/commands/pickle-refine-prd.md:188`,
`.claude/workflows/refine-analyze.js:236-238`) — do not rewrite the rule-13 sentences, which
`refine-analyze-workflow.test.js:268-333` pins:
> A counter-example to a recorded decision — named inputs, the decided rule's output, and the expected output — is a NEW
> row in this table, even when the decision is marked final: `decision`: `<id>: counter-example — <inputs>`; `options`:
> `keep rule | amend rule`; `default`: `keep rule`; `owner`: the decision's owner; `status`: `open`. Only
> `decided: <quote>` closes it; "already decided" never does.

Uses rule 13's five columns; `readOpenDecisions` indexes by header name, so a short row would mis-attribute owner and
default. *(refined: codebase c3, requirements c3, risk-scope c3)*

**Acceptance criteria.**
- `grep -c 'counter-example to a recorded decision' .claude/commands/pickle-refine-prd.md` returns 1 (0 today).
- `grep -c 'counter-example to a recorded decision' .claude/workflows/refine-analyze.js` returns 1 (0 today).
- `npm run test:fast` passes (rule-13 pins in `refine-analyze-workflow.test.js` unchanged).

**Expected effect (prediction, not a gate).** Baseline: 0 of 40 local refined PRDs carry an open row. Runs with a
contested decision will now withhold success until a human records `decided: <quote>`. A rise in that count after the
next field run is the expected signal, not a regression.

**Files.** `.claude/commands/pickle-refine-prd.md`, `.claude/workflows/refine-analyze.js`.

### T5 — #81: the citadel coverage table says what it measures — `small`

**Problem.** The coverage table's `Implemented` / `Tested` columns read as conformance, but credit is a MENTION: the AC
id or a mapped entity string in a changed line.

**Solution.** In `renderAcCoverageMarkdownTable` (`extension/src/services/citadel/ac-coverage-scorecard.ts:148`):
header becomes `| ID | Mentioned in code | Mentioned in tests | File:line evidence |`; after the rows, append a blank
`''` element, then the line: "Coverage means the criterion's id or a mapped entity appears in a changed line; it is not
a check that the criterion holds." (The blank line keeps GFM from parsing it as a table row; it renders also when
`rows` is empty.) `citadel_report.json` keys are unchanged; the `sections.ac_coverage.markdownTable` value changes.
*(refined: requirements c3)*

**Acceptance criteria.**
- `grep -c "'| ID | Mentioned in code | Mentioned in tests | File:line evidence |'" extension/src/services/citadel/ac-coverage-scorecard.ts` returns 1 (0 today).
- `grep -c 'not a check that the criterion holds' extension/src/services/citadel/ac-coverage-scorecard.ts` returns 1 (0 today).
- In `extension/tests/citadel-ac-coverage-scorecard.test.js`: `result.markdownTable` matches
  `/\| ID \| Mentioned in code \| Mentioned in tests \|/` and contains the explanation line after a blank line.
  Control: revert the header → red.

**Files.** `extension/src/services/citadel/ac-coverage-scorecard.ts`, `extension/services/citadel/ac-coverage-scorecard.js`,
`extension/tests/citadel-ac-coverage-scorecard.test.js`.

## Rejected or recorded (not built)

| Candidate | Screen it failed |
|---|---|
| #82: block the build until an operator acknowledges a non-zero readiness / ticket-audit exit | 2 — an abort condition; reverses R-GATE-ADVISORY (`mux-runner.ts:13870`, `:13904`) |
| #82: carry the advisory exit into the final report | 3 — needs a new event/channel for a heuristic with a false-block history; T4 carries the decisive signal through an existing channel |
| #81: per-criterion counter-example generation | 3 — a model spawn per criterion |
| #81: run citadel after anatomy-park | phase-order change; operator decision |
| #81: diff citadel from the scope base, not `start_commit` | HYPOTHESIS — measure on the next field run (owner: MASTER_PLAN field-run checklist) |
| #59 (PRD ids in shipped code) | already satisfied — `spawn-morty.ts:515` (MREL-B3) |
| Worker rule "every test spawn gets an explicit `timeout:`" | 1 — already at `extension/CLAUDE.md:76`; the gate's subprocess audit catches it; a worker-prompt copy reproduces #62 |
| #77: pin tarball installs to a lockfile | intentional exclusion (`install.sh:417-419`); tarball codegraph/typescript version drift is accepted |
| T1 staging-dir + `mv` copy | `install.sh:406` pre-creates `node_modules`, so `mv` would nest; adds a leakable state |

## Simplification Review

1. **Necessary?** T1 removes a launch-failure path and a self-update fake-green. T2–T5 are prompt or report text.
2. **Reuse?** T2 widens an existing 7a rule; T4 reuses the Open Decisions table and verdict term; T1 widens the existing
   self-probe and derives the dependency list from `npm ls`.
3. **Guarding brittle complexity?** #82's launch block would guard the advisory readiness gate — rejected for that reason.
4. **Subtracted.** T1 deletes the hand-maintained `for dep in typescript` list, the git-mode link branch and its mirror
   fixture test. T5 removes an overclaim from a report.

## Verification order

T1 first. T2 → T4 (both edit `pickle-refine-prd.md`, sequential). T3, T5 independent. The release gate runs after the bundle.

## Implementation Task Breakdown

| Order | ID | Title | Priority | Tier | Entry | Exit |
|---|---|---|---|---|---|---|
| 10 | dffe1ae9 | Deploy runtime deps into the deploy root instead of symlinking the source checkout (#77) | High | large | prior orders Done | its ACs hold |
| 20 | a5278539 | Widen Step 7a: quote decision text, one rule owner ticket per shared rule (#78, #79) | Medium | medium | prior orders Done | its ACs hold |
| 30 | 4ca8b3e9 | Research cites input writers and write conditions; Plan builds fixtures through them (#80) | Medium | medium | prior orders Done | its ACs hold |
| 40 | b3bfab18 | Synthesis rule 13: a counter-example to a recorded decision is an open row (#82) | Medium | medium | prior orders Done | its ACs hold |
| 50 | 2e77dc00 | Citadel AC coverage table reports mention, not conformance (#81) | Low | small | prior orders Done | its ACs hold |
| 60 | 3d9d012c | Harden: code quality review of B-FIELD-82 changes | High | large | prior orders Done | its ACs hold |
| 70 | a8691840 | Audit: data flow integrity for B-FIELD-82 changes | High | large | prior orders Done | its ACs hold |
| 80 | fccc51d9 | Harden: test quality review of B-FIELD-82 changes | High | large | prior orders Done | its ACs hold |
| 90 | ce534203 | Audit: cross-reference consistency for B-FIELD-82 changes | High | medium | prior orders Done | its ACs hold |
