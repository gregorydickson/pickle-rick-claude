# B-GATERED — the two gate reds B-INVENTED introduced

**Both reds are REAL. Neither is a stale pin over a behaviour-preserving refactor**, and that was
checked first, per the gate-red rule. Four legs went red at `3ae1d57a` from **two** causes.

| root | legs red | cause | verification host |
|---|---|---|---|
| **G1** two `execFileSync` git callsites without a `timeout` | 3 | `ac648a36` (this bundle's anatomy-park pass) | `scripts/audit-subprocess-heavy-tests.sh` |
| **G2** the executable-assertion ratio fell below its recorded floor | 1 | ticket authoring in this bundle | `scripts/audit-acceptance-assertion-coverage.sh` |
| **G3** the refinement wrapper exits 0 with zero analyses produced | 0 (blocked this bundle's own dispatch) | #41 | `tests/refinement-ac-shape-gate.test.js` |

**⚠ These premises were NOT analyst-checked.** The refinement team failed twice on an upstream API
safeguard error, producing zero analyses — which is how G3 was found. Unlike B-INVENTED, every root
here comes from a command run and read in-session: the audit output for G1, the two gate logs' coverage
lines for G2, and two captured exit codes for G3.

**All commands run from `extension/`.**

---

## 🚧 ROOT G1 — three legs, one defect

`tests/citadel-audit-runner.test.js` gained two `execFileSync('git', …)` callsites with **no
`timeout`**:

- `:196` — `const run = (args) => execFileSync('git', args, { cwd: root, stdio: [...] });`
- in test `'buildCitadelAuditReport consumes composed child AC and transition inputs'` (originally
  `:319`, since shifted — anchor by enclosing test name, not line number, per e3de37c4) —
  `const run = (args, cwd) => execFileSync('git', args, { cwd, stdio: [...] }).toString().trim();`

**Fixed** at `dc5c53dd` — both callsites now carry `timeout: 30_000`.

Root `CLAUDE.md`'s Worker Forbidden Ops table lists `spawnSync`/`spawn` with no `timeout` as forbidden,
enforced per-callsite by trap doors. The scanner reports:

```
tests/citadel-audit-runner.test.js: new missing-timeout execFileSync(...) callsite not in baseline
  (tests/citadel-audit-runner.test.js::execFileSync::e9bc83181a…)
```

**One defect reds three legs, which is why they must not be triaged separately:**
`audit-subprocess-heavy-tests` runs it directly; `test_integration` runs the same audit in its
`pretest:integration`; and `test_fast_budget` reds on `AP-EXT-ITER42-01: the committed extension/tests
corpus has zero un-baselined missing-timeout callsites` — the in-suite oracle for the same invariant.
It failed **3 of 3** flake-budget runs, so it is deterministic, not a flake.

**Fix the callsites, not the baseline.** Adding the hashes to
`scripts/subprocess-heavy-missing-timeout-baseline.json` would silence three legs while leaving two
unbounded git spawns in a test that runs under load — the exact "green light wired to nothing" this
repo keeps finding.

### Interface Contracts — G1
- **Inputs**: the two `execFileSync('git', …)` callsites and the existing option objects
  (`cwd`, `stdio`). No signature change to `run(...)` at either site.
- **Outputs**: identical stdout/stderr behaviour; the only difference is a bounded wall-clock.
- **Errors**: a git call exceeding the timeout throws the standard `ETIMEDOUT` child-process error and
  fails the test loudly. It must NOT be swallowed into a pass.
- **Invariants**: `scripts/subprocess-heavy-missing-timeout-baseline.json` is byte-identical before and
  after. The fix is at the callsite.

### AC-G1
- [ ] Neither callsite spawns without a timeout — Verify: `grep -n "execFileSync('git'" tests/citadel-audit-runner.test.js | grep -vc "timeout"` returns 0 — Type: lint
- [ ] The scanner reports no un-baselined callsite — Verify: `bash scripts/audit-subprocess-heavy-tests.sh` exits 0 — Type: lint
- [ ] The in-suite oracle greens — Verify: `node bin/test-runner.js tests/audit-subprocess-heavy-tests-missing-timeout.test.js --test-concurrency=1` exits 0 — Type: test
- [ ] The baseline file is unchanged — Verify: `git diff --name-only -- scripts/subprocess-heavy-missing-timeout-baseline.json` returns 0 — Type: lint
- [ ] The integration tier greens — Verify: `npm run test:integration` exits 0 — Type: integration
- [ ] Typecheck and lint pass — Verify: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exits 0 — Type: typecheck

### Test Expectations — G1
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| callsites bounded | `extension/tests/citadel-audit-runner.test.js` | both git spawns | each carries an explicit `timeout` |
| oracle greens | `extension/tests/audit-subprocess-heavy-tests-missing-timeout.test.js` | AP-EXT-ITER42-01 | zero un-baselined callsites |

---

## 🚧 ROOT G2 — the ratchet is correct and the authoring regressed

```
below floor: measured 25/82 is below the recorded session_min_ratio 13/40
  — tickets are being authored without an executable assertion
```

**Measured across the two gate runs:**

| | previous gate (`e8aa307d`, GREEN) | this gate (`3ae1d57a`, RED) |
|---|---:|---:|
| tickets scanned | 108 | 118 |
| guarded / measurable | **24/73** = 32.88% | **25/82** = 30.49% |
| floor `session_min_ratio` 13/40 | 32.5% | 32.5% |

**+9 to the denominator, +1 to the numerator.** Of this bundle's nine tickets, `grep -lE` finds two
matching the executable form and **one of those two is prose describing existing behaviour**
(`` `install.sh:225` exits 1 ``) that merely matches the regex. So **one genuine executable acceptance
criterion across nine tickets.**

**The instrument is not at fault and must not be touched.** `audit-acceptance-assertion-coverage.sh:28`
documents `session_min_ratio` as a deliberate **RATIO LOWER-BOUND ONLY** — it *"never refuses for being
above it, since the corpus grew since last time is not a regression"*. It refuses exactly one thing:
the ratio falling. It fell because of how the tickets were written.

**Do NOT retro-edit the Done B-INVENTED tickets to raise the number.** Their work is complete; adding
executable forms after the fact would move the metric without improving anything — fake-green in the
instrument this bundle exists to defend. **Do NOT lower the recorded floor.**

**The only honest repair is forward:** every criterion in this bundle's own tickets uses the executable
form (`` `cmd` exits N `` / `` `cmd` returns N ``), which lifts the corpus ratio as a consequence of
doing the work correctly rather than as its purpose.

### Interface Contracts — G2
- **Inputs**: this bundle's own ticket files, as authored.
- **Outputs**: a session-corpus ratio at or above `session_min_ratio`.
- **Errors**: none — this root changes no code. If the ratio cannot be lifted by correct authoring
  alone, the honest outcome is a recorded residual, NOT a floor change.
- **Invariants**: `scripts/acceptance-assertion-coverage-floor.json` is byte-identical before and after,
  and no ticket from session `2026-09-17-df5973be` is modified.

### AC-G2
- [ ] Every acceptance criterion in this bundle's tickets carries an executable assertion — Verify: `bash scripts/audit-acceptance-assertion-coverage.sh` exits 0 — Type: lint
- [ ] The recorded floor is unchanged — Verify: `git diff --name-only -- scripts/acceptance-assertion-coverage-floor.json` returns 0 — Type: lint
- [ ] No Done ticket from session `2026-09-17-df5973be` is edited — Verify: `git status --porcelain` returns 0 — Type: lint

---

---

## 🚧 ROOT G3 — the wrapper cannot tell "some analysts failed" from "all of them did" (#41)

Measured twice, exit code captured directly:

```
$ node bin/spawn-refinement-team.js --prd "$SR/prd.md" --session-dir "$SR"; echo "EXIT=$?"
⚠️  Workers failed: requirements, codebase, risk-scope. Synthesis will proceed with available analyses.
REFINEMENT_DIR=.../refinement
MANIFEST=.../refinement_manifest.json
EXIT=0
$ ls "$SR"/refinement/analysis_*.md
zsh: no matches found            # zero analyses exist
```

`src/bin/spawn-refinement-team.ts:2951-2960`: the `!cycleResults.allSuccess` branch logs and **falls
through** to the success path. Nothing branches on how many analyses were actually written, `main()`
returns normally, and the status is 0. **The message is false in the total-failure case** — *"Synthesis
will proceed with available analyses"* asserts a non-empty set the code never checked.

This defeats `/pickle-pipeline` Step 0d (*"On refine failure … fail fast … Do NOT launch the pipeline
against an unrefined PRD"*), which is unenforceable through a status that cannot express the
difference. On the previous bundle the analysts cut **2 of 4** roots, so the signal is not cosmetic.

**Prefer the collapse:** derive the disposition from the count of analyses actually written, rather than
adding a third case. Zero analyses exits non-zero; some-but-not-all keeps today's warning and exit 0.

### Interface Contracts — G3
- **Inputs**: `cycleResults` and the refinement directory as it exists on disk after the run.
- **Outputs**: exit status, plus a warning naming **how many** analyses were produced.
- **Errors**: zero analyses is a non-zero exit with a named reason. The API error that caused it is
  upstream and is not this root's concern.
- **Invariants**: the status is a function of what was produced, not of which roles were asked.

### AC-G3
- [ ] Zero analyses written exits non-zero — Verify: `node bin/test-runner.js tests/refinement-ac-shape-gate.test.js --test-concurrency=1` exits 0 — Type: test
- [ ] Over-trigger control: some-but-not-all analyses still exits 0 and still warns — a fix that reds partial success is worse than the defect — Verify: `node bin/test-runner.js tests/refinement-ac-shape-gate.test.js --test-concurrency=1` exits 0 — Type: test
- [ ] The warning states the produced count, so the log cannot claim a set it did not observe — Verify: `grep -c "available analyses" src/bin/spawn-refinement-team.ts` returns 0 — Type: lint
- [ ] Typecheck and lint pass — Verify: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exits 0 — Type: typecheck

### Test Expectations — G3
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| total failure | `extension/tests/refinement-ac-shape-gate.test.js` | every analyst fails | exit non-zero, reason names the zero count |
| partial failure | `extension/tests/refinement-ac-shape-gate.test.js` | one analyst fails, two succeed | exit 0, warning names 2 produced |

---

## NOT in Scope
- Adding the callsite hashes to the missing-timeout baseline.
- Lowering `session_min_ratio`, or any edit to either audit script.
- Retro-editing completed B-INVENTED tickets.
- Any new release-gate leg — both roots are already caught by existing legs, which is how they were found.

## Exit State
The gate is 22/22 green at a commit that fixes the callsites rather than baselining them, and the
executable-assertion ratio is back above its floor because the tickets were authored correctly.
