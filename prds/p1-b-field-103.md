# B-FIELD-103 — field-run classes #99–#103 (+ #66 verdict half)

**Status:** queued 2026-10-11 · **Scope base:** set at launch (HEAD before first ticket) · **Gate legs:** 22 → 22

Issues are referenced by number and generic shape only (root CLAUDE.md: no client content). Every
premise below was re-measured at HEAD `f2c590f4`; scope base `f2c590f4`.

## Premises

| # | Claim | Tag | Evidence at HEAD |
|---|---|---|---|
| P1 | `conformanceVerdictIsFail` reads only the first `ALL_PASS`/`FAIL` token after the last Verdict line, so `ALL_PASS for the ticket's own criteria` beside `40 FAIL` / "could not run" parses as a pass (#103) | verified | `extension/src/bin/mux-runner.ts:6557-6567` |
| P2 | `mux-runner.ts:2339` `if (conformance.hasManagerHandoff) continue;` skips the phantom-Done revert for a ticket whose artifact hands out-of-fence reds to the manager (#103) | verified | grep |
| P3 | `state.json` stamps `claude_version_seen` / `codex_version_seen` but no pickle-rick build version or source sha (#100) | verified | `extension/src/bin/setup.ts:1598-1599` |
| P4 | `check-update` runs only from the stop hook, after a session (#100) | verified (issue cites `stop-hook.ts:672-712`; re-grep at breakdown) | — |
| P5 | Refinement edge-case rubric is still "Covers empty, null, max, error states" (#101) | verified | `.claude/commands/pickle-refine-prd.md:476` |
| P6 | Verifier mutates only new throws/guards/fail-closed branches, ≤5 (#101) | verified | `.claude/agents/morty-phase-verifier.md:22` |
| P7 | Plan prompt's per-writer fixture rule covers writer shapes only, not cardinality / disagreeing related fields / derived variant sets (#101) | verified | `extension/src/bin/spawn-morty.ts:548` region |
| P8 | No rule asks the requirements analyst for degenerate-input rows of an outcome-publishing rule (#102) | hypothesis — grep analyst templates at breakdown | — |
| P9 | No phase renders a UI ticket's screen or reviews it against a checklist (#99) | verified | no screenshot/render step in `.claude/commands`, `.claude/agents`; `playwright` appears only as a test-command classifier (`ticket-tier.ts:94`, `convergence-gate.ts:119`) |

## Workstreams

### WS-1 (#103) — a check that did not run is not a pass
- `conformanceVerdictIsFail` returns FAIL for a **qualified** verdict (any text after the token that
  narrows it, e.g. "for the ticket's own criteria"), and when the artifact records a `not_run` /
  "could not run" lane or a failing count beside the verdict. Widen the existing predicate; no new
  parser beside it.
- The out-of-fence red is the ticket's own residual: delete the `hasManagerHandoff` carve-out at
  `mux-runner.ts:2339` **for test reds** (manager-only deploy/install/release handoffs keep it).
- Disposition per PRIME DIRECTIVE: the ticket is **not flipped Done** (parked, reason recorded:
  `not_run:<lane>` or `qualified_verdict`); the run CONTINUES and withholds its success verdict. It never
  halts.
- Repo CI-lane derivation (read the target's CI config, match path filters to the diff, record
  `{lane, ran, passed, failed}`) — **in scope for refinement to size**; if it exceeds one ticket, split
  the parse/carve-out fix (ships now) from lane derivation (follow-up row).
- Absorbs #66's verdict half (an unmeasured check is red, not converged) — refinement to confirm
  whether the anatomy-park `converged_with_unmeasured` path is the same predicate.

### WS-2 (#100) — a fix is live when a run records it
- `install.sh` writes the source sha (git mode) / release tag (tarball mode) beside the deployed
  `package.json`; `setup.ts` stamps `pickle_build: {version, source_sha}` into `state.json` and the
  pipeline-runner end-of-run summary prints it.
- `check-update`'s comparison runs at **launch** too (not only in the stop hook) and, when the installed
  build is behind the latest release tag or `origin/main`, **records** `build_behind: {installed, latest}`
  in state and the run-end summary, and withholds the auto-success verdict.
- **REJECTED half:** "the runner refuses to start unless an explicit override is passed" — a launch-block
  condition (screen item 2; PRIME DIRECTIVE). Replaced by record + disclose + withhold success.
- Closing-comment convention (MASTER_PLAN handoff checklist, not code): an issue closes as live by citing
  a session whose stamped `source_sha` contains the fix.

### WS-3 (#101 + #102) — test inputs span the code's distinctions; outcome rules carry degenerate rows
- **Plan template** (`spawn-morty.ts` Plan section): an input table per input the change reads — writers
  and storable values, cardinality (0 / 1 / many-differing), related fields that must disagree in one row,
  variant source (derived from the type/registry, never hand-listed), size bound (counted work at n and 2n,
  never timing). Each cell names its test row. Widens the existing per-writer rule (#80 follow-up) — it
  becomes one column.
- **Plan review** fails a plan whose table is missing or has an unassigned cell (local refusal).
- **Verifier** (`morty-phase-verifier.md`, `project-mayhem.md` Step 3b): domain mutants from the table —
  collapse to the first member, swap the two related fields, drop one variant — join #87's guard-mutant
  ledger under the same cap rule; a surviving mutant is a conformance FAIL (ticket not Done, run continues).
- **Refinement rubric**: replace `pickle-refine-prd.md:476`, `:458` and `:640` with the input-table rule;
  fold #79's symmetry clause in (an input side is one variant set) — net subtraction of rubric lines.
- **#102**: the requirements analyst emits a degenerate-row table (unreadable, empty, >1, conflicting
  members, malformed/foreign, oversized, lookalike-but-distinct) for each rule that publishes a persisted
  outcome over open input; every row without a spec outcome becomes an `## Open Decisions` row with
  `default: unknown (fail-closed)`. #82's counter-example rule becomes one case of it. The row kinds live
  in the analyst template.

### WS-4 (#99) — a UI ticket's rendered structure is reviewed (operator decision 2026-10-11: "ok, 3")
- Decided approach (quoted): **option 3 — no images; review the rendered structure.** Each PRD state row
  of a ticket that changes a user-facing screen is rendered to DOM/HTML **in the target repo's existing
  test runner** (its component/render tests), one render per state row. Widens #84's outermost-surface
  rule (`pickle-refine-prd.md:199`): when the outermost surface is a rendered screen, the row's test
  asserts on the rendered whole, not only on its parts.
- Fixed checklist, asserted over those renders and applied by conformance and anatomy-park:
  (a) no pass styling (class/role/token the target uses for pass) on a not-passed / unknown / missing
  state; (b) one value → one label everywhere it renders; (c) no empty container or orphan header;
  (d) every count/summary consistent with the state it summarizes.
- Presentation mutants join the WS-3 domain-mutant ledger: swap a fail state's styling to the pass style,
  relabel one occurrence of a value, render an empty group — a rendered-structure test must red; a
  survivor is a conformance FAIL (ticket not Done, run continues).
- pickle-rick adds **no browser or screenshot dependency** (portability). Known limit, recorded: purely
  visual defects (layout, contrast) are out of reach of this approach.

## Interface Contracts

- **WS-1** `conformanceVerdictIsFail(content: string): boolean` (`extension/src/bin/mux-runner.ts`) — signature
  unchanged. Returns `true` when the verdict token is `FAIL`, when an `ALL_PASS` token is followed on the verdict
  line by qualifying text, or when the artifact records a lane/check as not run. Returns `false` only for an
  unqualified `ALL_PASS` with no not-run record. Parked-ticket reason strings: `qualified_verdict`,
  `not_run:<lane>`.
- **WS-2** `state.json` gains `pickle_build: { version: string; source_sha: string | null }` (stamped by
  `setup.ts`; `source_sha` null when the deploy carries none) and, when behind,
  `build_behind: { installed: string; latest: string }`. Schema version unchanged (additive optional fields;
  confirm at breakdown whether `LATEST_SCHEMA_VERSION` policy requires a bump — if it does, record it as an
  Open Decision, never a worker bump).
- **WS-3 / WS-4** prompt contracts (`spawn-morty.ts` Plan section, `.claude/agents/morty-phase-verifier.md`,
  `.claude/commands/pickle-refine-prd.md`, `REQUIREMENTS_ROLE_INSTRUCTIONS` in
  `extension/src/bin/spawn-refinement-team.ts`).

## Acceptance Criteria (each measured at HEAD `f2c590f4`: all FAIL today)

| AC | Check | Today | Expected |
|---|---|---|---|
| WS-1a | `conformanceVerdictIsFail("## Verdict: ALL_PASS for the ticket's own criteria\n")` | `false` | `true` |
| WS-1b | control: `conformanceVerdictIsFail("## Verdict\nALL_PASS\n")` | `false` | `false` (unchanged) |
| WS-1c | an artifact with an unqualified `ALL_PASS` verdict plus a "could not run" lane line → `true` | `false` | `true` |
| WS-1d | `grep -c "if (conformance.hasManagerHandoff) continue;" extension/src/bin/mux-runner.ts` | 1 | 0 (test reds no longer carved out) |
| WS-2a | `grep -c "pickle_build" extension/src/bin/setup.ts` | 0 | ≥1, with a `setup.test.js` row asserting the stamp |
| WS-3a | `grep -c "Covers empty, null, max, error states" .claude/commands/pickle-refine-prd.md` | 1 | 0 |
| WS-3b | `grep -ci "cardinality" extension/src/bin/spawn-morty.ts` | 0 | ≥1 (Plan input table) |
| WS-3c | `grep -ci "domain mutant" .claude/agents/morty-phase-verifier.md` | 0 | ≥1 |
| WS-3d | `grep -ci "degenerate" extension/src/bin/spawn-refinement-team.ts` | 0 | ≥1 (requirements analyst) |
| WS-4a | `grep -ci "pass styling" .claude/agents/morty-phase-verifier.md` | 0 | ≥1 |

Executable WS-1 checks run against the compiled module:
`cd extension && ./node_modules/.bin/tsc && node --input-type=module -e "const m=await import('./bin/mux-runner.js'); ..."`.
Tests for WS-1 go in an existing mux-runner test file; WS-2 in `extension/tests/setup.test.js` (and
`check-update.test.js` for the launch-time comparison). Prompt-contract greps are necessary, not sufficient —
each prompt ticket also adds a pin in an existing prompt-contract test file.

## Open Decisions

| decision | options | default | owner | status |
|---|---|---|---|---|
| WS-4 approach | 1 screenshot capture / 2 target tooling only / 3 rendered-structure review, no images | 3 | operator | decided: "ok, 3" |
| WS-1 CI-lane derivation in this bundle or a follow-up | this bundle / follow-up row | refinement sizes it; split if > 1 ticket | operator | open |

## Simplification Review

1. **Necessary?** WS-1 widens one predicate and DELETES a carve-out. WS-2 adds two state fields and moves
   an existing comparison earlier; it adds no gate and rejects the proposed launch refusal. WS-3/WS-4 are
   prompt-contract changes.
2. **Reuse?** WS-1 reuses `conformanceVerdictIsFail` and the existing park/withhold-success disposition;
   WS-2 reuses `checkForUpdate`; WS-3 reuses #87's mutation ledger and the `## Open Decisions` gate (#75,
   #82); WS-4 reuses #84's outermost-surface rule and the target's own tooling.
3. **Brittle complexity subtracted?** The `hasManagerHandoff` carve-out for test reds; three rubric lines
   (`:458`, `:476`, `:640`) and #79's separate symmetry clause collapse into one input-table rule; #82's
   narrower counter-example rule becomes a case of #102's table.
4. **Subtraction:** as in 3. Gate legs 22 → 22; no new leg. Falsifying controls per ticket: a qualified
   `ALL_PASS` fixture must parse FAIL; reverting the predicate must red it.

## Rejected (recorded)

- #99 option 1 (pickle-rick captures screenshots: browser dependency + per-repo app-start/state reach) — deferred as a separate design item for the operator; not in this bundle.

- #100 launch refusal behind the released tag — launch-block condition (screen item 2).
- #103 "Blocked" as a halting state — expressed as not-Done + withheld success instead; never a halt.
