# Council of Ricks — Catalog Mode & Publish Fixes PRD

**One sentence**: Reframe Council of Ricks from a (structurally unreachable) convergence loop into a deterministic cataloging tool, fix the round-loss-on-breaker bug, fix the publish-on-circuit-open gap, and add severity filtering to `council-publish.js`.

---

## Problem

### Current Process
Today, `/council-of-ricks` runs an iterative loop that fans out subagents to review a Graphite stack each round, synthesizes findings into `council-directive.{json,md}`, and waits for `THE_CITADEL_APPROVES` — defined in the command prompt as "two consecutive clean rounds with zero P0/P1 findings and all unconditional categories reporting `ok`."

The command prompt explicitly says: "You never fix code — you judge, synthesize, and document only." The approval gate is unreachable under that constraint: with nothing applying fixes between rounds, P0/P1 findings either persist (same issues, same severities, no clean round forever) or shuffle (subagent perspective drift surfaces new findings, also no clean round). Either way, the loop runs until `max_iterations`, the circuit breaker trips, or a `--max-iterations 1` operator override forces termination.

### Users
- **Operators** running Council against a static branch for a "before-you-ship" audit.
- **Stack reviewers** (often working in `loanlight-api` or similar large monorepos) who want a structured, severity-graded list of issues plus trap doors, *not* a self-driving convergence engine.
- **Future-state**: operators who chain Council → fixer agent → Council, where the fixer (codex / `/pickle` / a human) iterates on the directive between rounds. This use case is in scope for a follow-up PRD (`council-of-ricks-with-fixer.md`), NOT this one.

### Pain Points

1. **The convergence promise is a lie.** Operators reading the command prompt see `THE_CITADEL_APPROVES` and the two-clean-rounds gate and reasonably expect that, given enough rounds, the loop will declare done. It will not — it cannot — because Council does not fix anything. This was confirmed empirically on session `2026-05-11-425c52fb` (loanlight-api PR #1286, stack tier `xl`, 18,628 LOC / 132 files) which ran 7 rounds, never had a clean round, and P0 count drifted 2 → 2 → 2 → 3 → 2 → 4 before the circuit breaker tripped.
2. **The circuit breaker is the de-facto termination signal**, and Step 17.7 (Final Publish) does not fire on `exit_reason === 'circuit_open'`. Step 17.7 only triggers on `THE_CITADEL_APPROVES` (path 1) or `current_round >= max_iterations` (path 2). The third terminal path — breaker open — silently exits without posting any PR comments. Confirmed on the same session: `.published/` was empty despite `council-directive.json` being well-formed and `gh` being authed.
3. **Rounds disappear when the breaker transitions mid-round.** On session `2026-05-11-425c52fb`, the summary jumps R1 → R2 → R4 with no R3 section. The breaker transition CLOSED → HALF_OPEN at iteration 3 either aborted the round before synthesis/append OR the synthesis step short-circuited on detection of breaker movement. Either way, the operator lost the round-3 directive, and the canonical "last directive" rolls back to R2 in a way that's not obvious from `state.json` alone.
4. **`council-publish.js` posts everything-or-nothing.** Operators who want to surface only P0/P1/P2 (typical PR-comment use case) have to filter the directive themselves with ad-hoc Python, as happened during the post-incident response on session `2026-05-11-425c52fb`. The publisher should support `--filter-severity P0,P1,P2` natively.

### Importance
Council is the most resource-intensive review tool in the kit — every round spawns 8 unconditional B-subagents + 1 conditional B7 + N C_correctness subagents (one per branch, sharded × per-branch for tier ≥ `l`) + 1 Codex adversarial sweep. On a tier `xl` stack with effective_min=6, effective_max=8, a single Council session burns ~50 subagent invocations against the Anthropic / Codex APIs over multiple hours of wall time. Running it to "find the same issues again" because the model promised convergence is wasted budget at scale.

---

## Scope

### Objective
**One measurable goal**: A `/council-of-ricks` invocation against a static branch terminates cleanly in exactly the rounds requested (default: 1), writes a directive on every round, publishes the canonical (= last) directive to every non-trunk PR on exit, and does so on all four terminal paths: normal completion, max-iterations, circuit-open, and operator cancel.

### Done looks like
- `pnpm test` (extension/) passes including new tests for the four catalog-mode acceptance criteria families.
- Running `/council-of-ricks` against a 50-commit static branch with the default invocation produces exactly 1 round, 1 directive, 1 PR comment per non-trunk branch, exit code 0, `state.exit_reason === 'completed'`.
- Running `/council-of-ricks --rounds 3` against the same branch produces 3 rounds, 3 directives (round-N-final is canonical), 1 PR comment per non-trunk branch with the round-3 content, exit code 0.
- Forcing a circuit-open by setting `noProgressThreshold: 1` produces the post-breaker exit AND publishes the last good directive AND records `exit_reason: 'circuit_open'` AND appends a `## Final Publish` section to `council-of-ricks-summary.md`.
- All three production gates (`tsc`, `eslint`, audit-tier scripts) stay green on the diff.

### In-scope (this PRD)

- **R-CMR-1** Drop the convergence model from the command prompt. Remove `THE_CITADEL_APPROVES` gate language, the two-clean-rounds wait, and the approval-gate-four-conditions block. Reframe the loop as cataloging with optional re-runs for randomness-tolerance.
- **R-CMR-2** Make `--rounds 1` the new default. CLI flag `--rounds N` replaces (and is an alias of) `--min-iterations N --max-iterations N`. Existing `--min-iterations` / `--max-iterations` remain for backwards compatibility and continue to work.
- **R-CMR-3** Fix Step 17.7 to fire on `exit_reason ∈ {'completed', 'iteration_cap_exhausted', 'circuit_open', 'cancelled'}` — i.e., every terminal path except an in-flight crash. Add `'cancelled'` and `'circuit_open'` to the publish-firing list.
- **R-CMR-4** Fix round-loss-on-breaker. When the circuit breaker transitions CLOSED → HALF_OPEN or HALF_OPEN → OPEN, the in-flight round MUST complete its Phase D synthesis and Step 17 summary append before the breaker decision applies to the NEXT iteration.
- **R-CMR-5** Add `--filter-severity` flag to `extension/src/bin/council-publish.ts`. Default unchanged (post everything). When passed, only findings matching the listed severities are included in the rendered comment body.
- **R-CMR-6** Rename `THE_CITADEL_APPROVES` to a strictly persona-only utterance. The promise that ends a clean-round session is `<promise>TASK_COMPLETED</promise>` in every code path. Persona text may still say "The Citadel approves" as flavor where a round produced zero findings, but it is not a state-machine signal.
- **R-CMR-7** Master plan bookkeeping. Add a row to `prds/MASTER_PLAN.md` referencing this PRD; keep `council-of-ricks-v1.50-json-directive.md` row untouched (represents prior work).

### Not-in-scope (filed for follow-up)

- **OUT-1** Council-with-fixer chain mode. A future PRD (`council-of-ricks-with-fixer.md`) will define an opt-in `--with-fixer <agent>` flag that takes each round's directive and feeds it to `/pickle`, codex, or a custom binary for fixes before the next round. *This is the only mode under which convergence is structurally reachable* — and it is explicitly not delivered by this PRD.
- **OUT-2** Cross-session directive history (e.g., session N+1 reading session N's directive as a "what was fixed last time" context).
- **OUT-3** GitNexus graph diff between rounds. Useful, deferred.
- **OUT-4** Auto-routing of directive output to Linear / Jira tickets. Filed as `prds/p3-council-linear-handoff.md` for later.
- **OUT-5** Multi-PR-stack Council in non-Graphite repos (`gt`-less stacks). The existing protocol requires Graphite tracking; that constraint is preserved.

---

## User Journeys

### J1 — One-shot stack review (default)
1. Operator: `/council-of-ricks` on a worktree at branch tip.
2. Council runs setup (gates, tier compute, session init).
3. Council fans out one round of subagents (Phase A historical + Phase B categories + Phase C per-branch correctness + Phase C Codex).
4. Phase D synthesis writes `council-directive.{json,md}` and appends `## Round 1: — <N> issues (P0/P1/P2/P3/P4)` (or `— no findings.`) to `council-of-ricks-summary.md`.
5. Step 17.7 publishes the directive to PR #N for every non-trunk branch.
6. mux-runner exits with `exit_reason: 'completed'`. tmux session prints "The Council has adjourned." and ends.

Acceptance: exactly 1 round, 1 directive, exactly N PR comments (N = non-trunk branches), `.published/<branch-slug>` marker file exists for each. `state.exit_reason === 'completed'`.

### J2 — Multi-round catalog (perspective coverage)
1. Operator: `/council-of-ricks --rounds 3`.
2. Council runs three rounds, each producing a directive. Round-N's directive overwrites the prior `council-directive.{json,md}` file (last-write canonical).
3. After round 3, Step 17.7 publishes round 3's directive.
4. Summary file has three `## Round N: — <N> issues` headers, all informational.

Acceptance: 3 rounds completed, last directive is round 3, PR comments contain round-3 content, summary has three round sections.

### J3 — Circuit-breaker exit (incident)
1. Operator: `/council-of-ricks --rounds 8` against a stack so large the breaker trips on no-progress.
2. Council runs N rounds (N < 8), breaker opens, mux-runner records `exit_reason: 'circuit_open'`.
3. Step 17.7 fires anyway, publishes the last completed round's directive.
4. Summary file has a Final Publish section noting `## Final Publish — Posted: <N>, Skipped (no PR): 0, ...` plus a `## Note: circuit breaker tripped at round <N>; this directive reflects the last completed round.` operator-facing block.

Acceptance: PR comments posted, `.published/` markers present, `exit_reason === 'circuit_open'`, summary contains both the Final Publish block AND a breaker-tripped operator note.

### J4 — Severity-filtered publish (PR hygiene)
1. Operator: `/council-of-ricks --rounds 1 --filter-severity P0,P1,P2`.
2. Council runs one round, writes the full directive (all severities) to `council-directive.{json,md}`.
3. Step 17.7 invokes `council-publish.js --filter-severity P0,P1,P2` which renders comment bodies containing only P0/P1/P2 findings.
4. The directive on disk still has all severities; only the posted comment is filtered.

Acceptance: `council-directive.json` has all findings; PR comment includes ONLY findings whose `severity` is one of the requested values. P3/P4 findings remain inspectable in the on-disk directive.

### J5 — Operator-cancelled session (`/eat-pickle`)
1. Operator: `/council-of-ricks --rounds 5`, then mid-round-2 runs `/eat-pickle`.
2. mux-runner records `exit_reason: 'cancelled'`.
3. Step 17.7 fires, publishes round 1's directive (the last completed round).
4. Round 2's in-flight subagent payloads, if any returned before cancel, are written to `<SESSION_ROOT>/round-2/` for forensic inspection but are NOT synthesized into a directive (cancel halts mid-phase).

Acceptance: round 1 directive on disk, round 1 directive posted to PR, `state.exit_reason === 'cancelled'`, summary file contains `## Cancelled at round 2 (mid-phase)` operator note.

---

## Functional Requirements

| ID | Priority | Requirement | Verification |
|:--|:--|:--|:--|
| R-CMR-1 | P0 | The deployed `.claude/commands/council-of-ricks.md` MUST NOT contain the strings `THE_CITADEL_APPROVES` (gate semantics), `two consecutive clean rounds`, or `Approval gate` (as a heading). Replace approval-gate Step 16 condition list with a "Last-write canonical" block. | `grep -c "THE_CITADEL_APPROVES" .claude/commands/council-of-ricks.md` returns `0` for non-persona references; `grep -nE "Approval gate\\|two consecutive clean rounds" .claude/commands/council-of-ricks.md` returns nothing. Allowed exception: a single persona-flavor mention with a leading `<!-- persona-only -->` comment. Tested in `extension/tests/council-of-ricks-prompt-shape.test.js`. |
| R-CMR-2 | P0 | `setup.js --command-template council-of-ricks.md` MUST accept a new `--rounds N` flag that sets both `min_iterations` and `max_iterations` to `N`. Default when neither `--rounds` nor `--{min,max}-iterations` is passed: `--rounds 1`. The command prompt MUST document `--rounds` first in its flag list (and mark `--min-iterations` / `--max-iterations` as legacy aliases). | `node extension/bin/setup.js --tmux --rounds 3 --command-template council-of-ricks.md --task "x"` prints `Limit: 3` and `Min Passes: 3` in setup output. Test: `extension/tests/setup-council-rounds-flag.test.js`. |
| R-CMR-3 | P0 | `extension/src/bin/mux-runner.ts` MUST invoke the publish step on `exit_reason ∈ {'completed', 'iteration_cap_exhausted', 'circuit_open', 'cancelled'}` for council sessions (detected by `state.command_template === 'council-of-ricks.md'`). Invocation MUST NOT block exit on publish failure — publish failures log to `publish.log` and emit `council_publish_failed` activity event but the exit_reason is preserved. | Integration test `extension/tests/integration/council-publish-on-circuit-open.test.js` forces `noProgressThreshold: 1` via a fixture state, runs a fake council loop, asserts `.published/<branch-slug>` marker file exists post-exit AND `state.exit_reason === 'circuit_open'`. Parallel coverage for `cancelled` in `extension/tests/integration/council-publish-on-cancel.test.js`. |
| R-CMR-4 | P0 | Phase D synthesis (directive write + summary append) for round N MUST complete atomically before the circuit breaker's `recordIterationResult` is evaluated for that round. Round-loss occurs only on hard crash (signal, OOM, kill -9) — soft circuit transitions MUST NOT abort an in-flight round. | Test `extension/tests/integration/council-round-loss-on-breaker.test.js` simulates a CLOSED → HALF_OPEN transition during synthesis and asserts the post-transition state has a complete `round-<N>/` directory, a `council-directive.json` whose `round` field equals N, and a `## Round N:` section in `council-of-ricks-summary.md` AT THE END of the summary. |
| R-CMR-5 | P1 | `extension/src/bin/council-publish.ts` MUST accept `--filter-severity <comma-separated>` (allowed values: `P0,P1,P2,P3,P4`). When set, the renderer iterates over `directive.branches[].findings` and includes ONLY findings whose `severity` ∈ the filter set. Findings outside the filter are dropped from the rendered Markdown body but the on-disk directive is not modified. Default behavior (no flag) is unchanged. | Unit test `extension/tests/council-publish-filter-severity.test.js` constructs a directive with findings across all 5 severities, invokes the renderer with `--filter-severity P0,P1`, asserts only P0/P1 strings appear in the output body. Negative test: `--filter-severity P9` exits 64 (CLI usage error). |
| R-CMR-6 | P1 | Every `<promise>` tag emitted by the deployed `.claude/commands/council-of-ricks.md` MUST be `<promise>TASK_COMPLETED</promise>`. The command file MUST NOT emit `<promise>THE_CITADEL_APPROVES</promise>` in any code path. (The string may remain in persona/voice sections as flavor; it is not a tool-recognized promise token.) | `grep -nE "<promise>THE_CITADEL_APPROVES</promise>" .claude/commands/council-of-ricks.md` returns no matches. Tested in `extension/tests/council-of-ricks-prompt-shape.test.js`. |
| R-CMR-7 | P2 | `prds/MASTER_PLAN.md` MUST have a row referencing `council-of-ricks-catalog-mode-and-publish-fixes.md` in the "Design docs (active, no immediate ship target)" section. The existing `council-of-ricks-v1.50-json-directive.md` row remains untouched. | `grep -c "council-of-ricks-catalog-mode-and-publish-fixes.md" prds/MASTER_PLAN.md` returns `1`. Tested in `extension/tests/master-plan-row-present.test.js` (or by hand at PR review). |
| R-CMR-8 | P2 | `council-of-ricks-summary.md` MUST append a `## Final Publish` section after the last `## Round N:` block regardless of which exit path fired. The section MUST contain `Posted: <count>`, `Skipped (no PR): <count>`, `Skipped (gh unavailable): <count>`, `Failed: <count>`, `Details: \`publish.log\``. When publish was skipped (e.g., `--no-publish`), the section MUST instead contain `Publish skipped (--no-publish)`. | Test `extension/tests/council-summary-final-publish-section.test.js` runs a synthetic 1-round session, asserts the summary file ends with the Final Publish block on all four exit paths. |
| R-CMR-9 | P3 | The deployed Step 9.5 setup report MUST print `rounds: <N>` (not "min N rounds, max M"). Tier scaling still applies — for tier ≥ `m`, if the operator did not pass `--rounds`, setup defaults to the tier's `scaled_min_rounds` value (preserving the current heuristic that big stacks benefit from multiple passes). | `node extension/bin/setup.js --tmux --command-template council-of-ricks.md --task "x"` (no `--rounds`) against a fixture tier-`l` stack prints `rounds: 4`. Test: `extension/tests/setup-council-tier-default-rounds.test.js`. |
| R-CMR-10 | P3 | The "needs-attention" / "approve" Codex verdict is preserved verbatim in directive JSON `stack_overview.codex_verdicts.<branch>` regardless of whether `--rounds` is 1 or N. No round merges or overwrites the Codex verdict block; round-N's verdict supersedes earlier rounds. | Test `extension/tests/council-codex-verdicts-per-round.test.js` builds two synthetic rounds with different verdicts, asserts round 2 directive's `codex_verdicts` matches round 2's payload, not round 1's. |

---

## Interface Contracts

### Contract 1 — `setup.js` accepting `--rounds`

| Input | Output | Error |
|:--|:--|:--|
| `--rounds <int>` flag, positive integer | `state.json.min_iterations` and `state.json.max_iterations` both set to the value | Non-positive integer or non-numeric → exit code 64 (usage error), stderr line `error: --rounds must be a positive integer`. Conflicting flags (`--rounds 3 --min-iterations 5`) → exit code 64, stderr line `error: --rounds is mutually exclusive with --min-iterations / --max-iterations`. |

### Contract 2 — `council-publish.ts` filter-severity flag

| Input | Output | Error |
|:--|:--|:--|
| `--filter-severity P0,P1,P2` (any subset of `{P0,P1,P2,P3,P4}`) | Comment body Markdown contains only findings whose `severity ∈ <set>`; on-disk `council-directive.json` unchanged | Unknown severity token (e.g. `P9`) → exit code 64, stderr `error: unknown severity '<token>' (allowed: P0,P1,P2,P3,P4)`. Empty filter (`--filter-severity ""`) → treat as no flag (post all). |

### Contract 3 — `mux-runner.ts` publish-on-exit dispatch

```typescript
// extension/src/bin/mux-runner.ts (excerpt — illustrative)
const COUNCIL_PUBLISH_EXIT_REASONS: ReadonlySet<ExitReason> = new Set([
  'completed',
  'iteration_cap_exhausted',
  'circuit_open',
  'cancelled',
]);

function maybeRunCouncilPublish(state: State, sessionDir: string): void {
  if (state.command_template !== 'council-of-ricks.md') return;
  if (!COUNCIL_PUBLISH_EXIT_REASONS.has(state.exit_reason as ExitReason)) return;
  try {
    runCouncilPublish(sessionDir);
  } catch (err) {
    logActivity({ event: 'council_publish_failed', source: 'mux-runner', error: safeErrorMessage(err) });
    // Do NOT propagate — publish failure must not change exit_reason.
  }
}
```

Invocation point: immediately before `finalizeTerminalState` / `safeDeactivate`, after `recordExitReason` has stamped the final exit_reason but before the process exits. Publish runs synchronously; the existing `ghTimeoutMs` trap-door enforces bounded wall time per branch.

### Contract 4 — Trap door registration (extension/CLAUDE.md additions)

Two new trap doors are added to `extension/CLAUDE.md` to lock in the invariants once shipped:

```markdown
- `src/bin/mux-runner.ts` (R-CMR-3 council publish dispatch) — INVARIANT: every council session
  (state.command_template === 'council-of-ricks.md') MUST invoke maybeRunCouncilPublish before
  finalizeTerminalState / safeDeactivate on any of exit_reason ∈ {'completed',
  'iteration_cap_exhausted', 'circuit_open', 'cancelled'}. Publish failures emit
  council_publish_failed activity and DO NOT change exit_reason.
  ENFORCE: extension/tests/integration/council-publish-on-circuit-open.test.js,
  extension/tests/integration/council-publish-on-cancel.test.js.
  PATTERN_SHAPE: `COUNCIL_PUBLISH_EXIT_REASONS` Set literal containing all four reasons.

- `src/bin/mux-runner.ts` (R-CMR-4 atomic round synthesis) — INVARIANT: when state.command_template
  === 'council-of-ricks.md', the synthesis-and-summary-append step for round N MUST complete
  before recordIterationResult applies the breaker decision to iteration N+1. A CLOSED -> HALF_OPEN
  or HALF_OPEN -> OPEN transition observed during round N MUST NOT cancel round N's directive
  write or summary append.
  ENFORCE: extension/tests/integration/council-round-loss-on-breaker.test.js.
  PATTERN_SHAPE: synthesis call site followed by recordIterationResult, not the reverse.
```

---

## Verification Strategy

Conformance for this PRD is checked by four mechanisms, in order of authority:

1. **Type**: `cd extension && npx tsc --noEmit` — passes after every commit on the implementation branch.
2. **Test**: `cd extension && npm test` (fast tier) — every new test referenced in the FR table is registered in `tests/` and passes. Integration coverage referenced above runs under `npm run test:integration`.
3. **Contract**: `cd extension && npx eslint src/ --max-warnings=-1` — no new lint warnings. `bash scripts/audit-trap-door-enforcement.sh` — every new trap door listed in extension/CLAUDE.md has its ENFORCE test file present and registered.
4. **LLM behavioral spot-check**: an agent reads `.claude/commands/council-of-ricks.md` and answers "what happens after the last round completes?" The expected answer references catalog-mode last-write semantics and Step 17.7 publish; references to "two consecutive clean rounds" or "Citadel approves" fail the check. This check is a manual `/citadel` audit step, not gated in CI.

---

## Test Expectations

| Requirement | Test File | Description | Assertion |
|:--|:--|:--|:--|
| R-CMR-1 | `extension/tests/council-of-ricks-prompt-shape.test.js` | Parse the deployed command file, assert removed strings absent | `grep("THE_CITADEL_APPROVES")` finds 0 non-persona occurrences; `grep("two consecutive clean rounds")` returns no matches |
| R-CMR-2 | `extension/tests/setup-council-rounds-flag.test.js` | Invoke `setup.js --rounds 3` against a temp session, read state.json | `state.min_iterations === 3 && state.max_iterations === 3` |
| R-CMR-2 (negative) | same file | `setup.js --rounds 3 --min-iterations 5` | Exits 64 with mutually-exclusive error |
| R-CMR-3 | `extension/tests/integration/council-publish-on-circuit-open.test.js` | Fixture state with breaker forced open at iter 2, run mux-runner | `.published/<branch-slug>` marker exists; `state.exit_reason === 'circuit_open'`; `publish.log` contains a "Posted" line |
| R-CMR-3 | `extension/tests/integration/council-publish-on-cancel.test.js` | Send SIGTERM to a 3-round council session mid-round-2 | Round-1 directive published; `state.exit_reason === 'cancelled'` |
| R-CMR-4 | `extension/tests/integration/council-round-loss-on-breaker.test.js` | Force a HALF_OPEN transition during synthesis; assert round-N directive complete | `council-directive.json` has `round === N`; summary file ends with `## Round N:` block |
| R-CMR-5 | `extension/tests/council-publish-filter-severity.test.js` | Directive with all 5 severities; invoke renderer with `--filter-severity P0,P1` | Body contains "P0", "P1" headers; "P2", "P3", "P4" headers absent |
| R-CMR-5 (negative) | same file | `--filter-severity P9` | CLI exits 64 with unknown-severity error |
| R-CMR-6 | `extension/tests/council-of-ricks-prompt-shape.test.js` | Parse command file | `<promise>THE_CITADEL_APPROVES</promise>` not present; `<promise>TASK_COMPLETED</promise>` present |
| R-CMR-7 | (manual at PR review) | `grep "council-of-ricks-catalog-mode-and-publish-fixes.md" prds/MASTER_PLAN.md` | Returns 1 line |
| R-CMR-8 | `extension/tests/council-summary-final-publish-section.test.js` | Run synthetic 1-round session on all 4 exit paths | Summary file has `## Final Publish` block in each case |
| R-CMR-9 | `extension/tests/setup-council-tier-default-rounds.test.js` | Fixture tier-`l` stack, no `--rounds` flag | Setup report contains `rounds: 4` |
| R-CMR-10 | `extension/tests/council-codex-verdicts-per-round.test.js` | Two synthetic rounds with conflicting verdicts | Round-2 directive's `codex_verdicts` matches round-2 input |

---

## Out-of-Band Concerns

### Backwards compatibility
- `--min-iterations` and `--max-iterations` remain valid flags (legacy aliases). Operators with existing aliases / shell history continue to work. Documentation marks them as legacy but does not remove them.
- Existing session directories created by older Council versions remain readable. The summary-file terminal-suffix contract (`— clean round.` / `— partial round (...)` / `— <N> issues (...)`) remains parseable; the loop just no longer USES the parse result for the approval gate.

### Cross-document fallout
- `README.md` lists `/council-of-ricks` — update its description to "stack cataloger" wording.
- `competitive-analysis.md` may reference the convergence model — verify and update.
- `pickle_settings.json` documented defaults (`default_council_min_rounds: 2`, `default_council_max_rounds: 5`) are now interpreted as `default_council_rounds: <max(min,max)>` for catalog mode. The legacy two-field config remains readable for backwards compat; if both are present, `max` wins.

### Performance
No change. Removing the gate-wait loop reduces wasted rounds (operators previously had to specify `--max-iterations 1` to escape; now default is 1). Net effect on a typical static-stack review: ~5x reduction in API calls.

---

## Open Questions

1. Should `--rounds 0` be an explicit "setup-only, no review" mode (useful for testing the gate logic without firing subagents)? Default: out of scope. Filed as `OUT-6`.
2. Should `council-of-ricks-summary.md` get a `## Canonical Directive` block at the top pointing to the last directive's round number for at-a-glance scanning? Default: out of scope; the file is short enough that reading the last `## Round N:` header is fine.
3. The trap-door doc at `extension/CLAUDE.md` keeps growing. Per `prds/archive/subsystem/p3-subsystem-claude-md-bin.md` (already shipped), bin-level CLAUDE.md drift is audited. Are the two new trap doors in this PRD covered by that audit? Default: yes — the audit runs against every entry in `extension/src/bin/CLAUDE.md`; verify on the first run after merge.

---

## Acceptance Criteria Summary

This PRD is **done** when all of:

- [ ] AC1: `grep -c "THE_CITADEL_APPROVES" .claude/commands/council-of-ricks.md` returns the count of persona-flavor occurrences only (typically 1–2). No `<promise>THE_CITADEL_APPROVES</promise>` references.
- [ ] AC2: Default `/council-of-ricks` invocation runs exactly 1 round end-to-end on a static branch and posts to the PR.
- [ ] AC3: `--rounds 3` runs exactly 3 rounds, posts round-3's directive.
- [ ] AC4: Forced circuit-open exit posts the last completed round's directive to the PR.
- [ ] AC5: `council-publish --filter-severity P0,P1,P2` renders a comment body with only those severities.
- [ ] AC6: All 12 listed test files are registered, present, and passing under `cd extension && npm test`.
- [ ] AC7: `extension/CLAUDE.md` has the two new trap door entries (R-CMR-3, R-CMR-4) with valid ENFORCE pointers.
- [ ] AC8: `prds/MASTER_PLAN.md` has the new row.
- [ ] AC9: Release-gate parity check (`tsc + eslint + audit-tier scripts + npm test`) green.
- [ ] AC10: A `/citadel` audit of the diff returns no P0/P1 findings.

---

## Notes for `/pickle-refine-prd`

This PRD is structured as a single epic with 10 atomic requirements (R-CMR-1 through R-CMR-10). Refinement should produce one ticket per requirement, with the following expected dispositions:

- R-CMR-1, R-CMR-6, R-CMR-9 — `.claude/commands/council-of-ricks.md` edits (single-file, low LOC, high risk because the file IS the protocol)
- R-CMR-2 — `extension/src/bin/setup.ts` flag handling (small TS change + setup tests)
- R-CMR-3, R-CMR-4 — `extension/src/bin/mux-runner.ts` dispatch + trap door (medium TS change, integration tests gate)
- R-CMR-5 — `extension/src/bin/council-publish.ts` flag handling (small TS change + unit tests)
- R-CMR-7 — `prds/MASTER_PLAN.md` edit (single-row addition)
- R-CMR-8 — Summary append logic, likely lives near R-CMR-3's dispatch site
- R-CMR-10 — Verdict preservation; may be no-op if current code already handles it, but ticket exists so the test is written

Bundle thesis: this PRD is a single coherent epic. Splitting into multiple PRs is discouraged because R-CMR-3 / R-CMR-4 / R-CMR-8 / R-CMR-9 are mutually reinforcing — shipping only some of them would leave the loop in a half-converted state.

---

## Sign-off

Drafted by Pickle Rick (`/pickle-prd`-equivalent freeform) on 2026-05-11 in response to session `2026-05-11-425c52fb` — Council of Ricks ran 7 rounds against `loanlight-engineering/loanlight-api` PR #1286 without converging. Empirical confirmation that the convergence model was a category error. *Burp.*
