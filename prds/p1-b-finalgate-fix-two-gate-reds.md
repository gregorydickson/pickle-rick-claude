# B-FINALGATE-FIX — two fast-tier reds after B-FINALGATE (general; lands on main, then merges down per rule P)

Gate `20260926T194128Z-87129` on `main` at `09d8b3a3` (B-FINALGATE): **21/22 green**. `test_fast_budget` is red with
two deterministic failure groups, repeated in every flake-budget run. Measured 2026-09-26.

## Red 1 — a pin that is now stale (intended behaviour change)
`extension/tests/success-verdict-withheld.test.js` ("exactly four raise sites survive, one per named withholding path";
"V1-4: the nonConvergent raise sites are enumerated") pins the set
`[finalizePhaseSuccess, runAllBackendsExhaustedFinalizeGate, withholdForDegradedPostFinalVerdict, withholdForFailedAcGate]`.
B-FINALGATE deliberately added a fifth raise site, `runJudgeTimeoutFinalizeGate` (judge_timeout pass → `nonConvergent++`;
see `prds/p0-b-finalgate-strict-gate-on-incomplete-exits.md` T1b / R6). **Fix:** add `runJudgeTimeoutFinalizeGate` to the
enumerated set by name (five sites, one per named withholding path), and update the test's wording from four to five.
Keep the census derived and named. Do not loosen it into a count bound.

## Red 2 — a test that depends on the DEPLOYED install
`extension/tests/compose-manager-prompt-from-skill.test.js:340-364` (AC-3 / R-MPVU, claude and codex): "every executable
path the composed manager prompt names under the bound extension root exists". It binds the extension root to the
**real deployed** `~/.claude/pickle-rick/extension`. During the 2.2 beta soak that install is `exp/b-lanes`, which deleted
`bin/validate-teams-ticket.js`, while `main`'s manager prompt still names it. So the result depends on what is installed,
not on the tree under test. **Fix:** bind the test's extension root to the SOURCE tree under test (the repo's
`extension/` directory, with compiled JS present), so it checks the prompt against the files this commit actually ships.
The invariant is kept: every named path must exist in the tree that ships with the prompt.

## Acceptance criteria (measured at HEAD `09d8b3a3`: both red)
1. `cd extension && node --test tests/success-verdict-withheld.test.js` passes (HEAD: 2 failing cases; actual set has 5
   members, expected 4). Control: removing `runJudgeTimeoutFinalizeGate` from the pinned set reds it again.
2. `cd extension && node --test tests/compose-manager-prompt-from-skill.test.js` passes regardless of the deployed install
   (HEAD: red, naming `…/.claude/pickle-rick/extension/bin/validate-teams-ticket.js`). Control: deleting a named script
   from the SOURCE tree reds it; changing the deployed install does not.
3. `cd extension && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exits 0.

## Simplification Review
Updates one census by name, and removes one test's dependence on machine state. No product behaviour change.

## Out of scope
Anything else. `exp/b-lanes` gets these via the rule-P merge; its own prompt no longer names the deleted script.
