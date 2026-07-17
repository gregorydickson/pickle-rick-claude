# BUG — the refinement symbol audit's `exit_code` category false-positives and HARD-FAILS refinement on a correct PRD

**Filed:** 2026-07-16 · **Hit while:** authoring the R-MWMO defect-2 PRD and running `/pickle-refine-prd` (session `2026-07-16-9ef7bafb`)
**Component:** `extension/src/bin/spawn-refinement-team.ts` → `collectExitCodeReferences` / `runSymbolAuditEnforcement`
**Severity:** **P1** — deterministically blocks refinement (`exit 2`) for an entire CLASS of PRDs: any PRD that discusses exit codes. Refinement produces the tickets, so **a blocked refinement blocks the whole pipeline**. Directly gates autonomy.
**Status:** OPEN · **Reproduced 2026-07-16**, first try, on a PRD whose every citation was source-verified.
**Also on `main`:** this checker is part of the analyst-citation work back-ported for v2.0 GA (`2ac84924`). **This is a GA-line defect, not v2.1-only.**

## Reproduction (deterministic, not flaky)

Run `/pickle-refine-prd` on `prds/p1-bug-fix-r-mwmo-d2-exit-code-masking.md` (a PRD about the
`done_without_commit_evidence` exit-code masking bug). All 3 cycles run, then:

```
[pickle-rick] symbol audit failed: 7 phantom symbol(s).
[pickle-rick] Ensure each cited symbol is declared at HEAD or in a PRD listed in this bundle's `composes:` frontmatter.
[pickle-rick] activity_event done_without_commit_evidence (PRD line 177): not present in VALID_ACTIVITY_EVENTS
[pickle-rick] activity_event done_without_commit_evidence (PRD line 207): not present in VALID_ACTIVITY_EVENTS
[pickle-rick] exit_code iteration_cap_exhausted (PRD line 52): not present in PipelineRunnerExitCode
[pickle-rick] exit_code iteration_cap_exhausted (PRD line 150): not present in PipelineRunnerExitCode
[pickle-rick] exit_code guardCompletionCommitBeforeDone (PRD line 206): not present in PipelineRunnerExitCode
[pickle-rick] exit_code exit_reason (PRD line 222): not present in PipelineRunnerExitCode
[pickle-rick] exit_code exit_reason (PRD line 248): not present in PipelineRunnerExitCode
EXIT=2
```

`refinement_manifest.json`: `"tickets": []`, `"ac_shape_smells": []`. **Zero tickets produced.**
Note the failure is NOT the AC-shape collapse-or-justify case that `/pickle-refine-prd` Step 5
documents for `exit 2` — the skill's exit-2 guidance sends the operator at the wrong diagnosis.

**All 7 findings are FALSE POSITIVES.** None of these symbols is claimed to be a
`PipelineRunnerExitCode` member or an activity-event name:
- `guardCompletionCommitBeforeDone` — a **function**, declared at HEAD (`mux-runner.ts`).
- `exit_reason` — a **`state.json` field name**.
- `iteration_cap_exhausted` — a **`mux-runner` `ExitReason`** (`mux-runner.ts:4367`), a different
  enum from `PipelineRunnerExitCode`. It was flagged **while quoting real source verbatim**.
- `done_without_commit_evidence` — an `ExitReason` carried as the **`error` payload field** of the
  `session_end` event. It is not an event *name*.

## Root cause — three compounding defects in `collectExitCodeReferences`

`extension/src/bin/spawn-refinement-team.ts:1919-1941`:

```ts
for (const { line, sourceLine } of lineRefs(prdContent)) {
  if (!/\b(?:exit[-_\s]?codes?|PipelineRunnerExitCode|process\.exit)\b/i.test(line)) continue;
  const symbols = new Set<string>();
  for (const symbol of quotedSymbols(line)) symbols.add(symbol.replace(/^PipelineRunnerExitCode\./, ''));
  ...
  const status = names.has(symbol) || values.has(symbol) ? 'pass' : 'fail';
```

**(1) Line-proximity is treated as a membership CLAIM.** The audit takes *every* quoted symbol on
any line that merely **mentions** exit codes and demands it be a `PipelineRunnerExitCode` member.
Co-occurrence on a line is not an assertion. This is the same structural error as
[[R-BCFR]]/[[B-FOMC C-1]]: the checker cannot distinguish *"token appears near a word"* from
*"token is claimed to be a member of that set."*

**(2) No `declaredSymbols` escape — asymmetric with the sibling branch, and the error text lies.**
The `activity_event` branch unions in real declarations (`:1886`):
```ts
const valid = new Set<string>([...VALID_ACTIVITY_EVENTS, ...declaredSymbols]);
```
The `exit_code` branch (`:1920`) validates against `PipelineRunnerExitCode` **only**. So
`guardCompletionCommitBeforeDone` — genuinely declared at HEAD — **can never pass**, while the
enforcement message instructs the operator to *"Ensure each cited symbol is declared at HEAD"*.
Following the error's own advice cannot clear the error.

**(3) The trigger regex matches the identifier `exitCode`, so quoting real source self-trips.**
`/\bexit[-_\s]?codes?\b/i` matches inside `exitCode` (`[-_\s]?` matches empty; `codes?` matches
`Code`; `\b` holds at both ends). So the PRD's verbatim quote of the actual fix site —
```ts
if (exitReason === 'iteration_cap_exhausted') exitCode = 3;
```
— is a trigger line carrying a foreign quoted symbol, and hard-fails. **A PRD is penalized for
citing the code it is about.** The more precisely a PRD quotes its fix site, the likelier it is
rejected — exactly backwards.

## Impact — the catch-22

Any PRD about exit codes is unbuildable while this stands, including **the PRD that would fix this
checker**. The blast radius is every exit-path / halt-honesty / graduation-gate PRD — i.e. much of
the open reliability queue (`R-MWMO`, and the `B.5(a)` phase-reporting subtraction).

This is a refinement-stage sibling of [[R-PSRB]]: the tool's own defect blocks the fix for that
defect. Workaround used for R-MWMO d2 (documented, not silent): reformat the PRD so no single line
carries both the trigger and a foreign symbol. **That is gaming a broken gate, not a fix.**

## Fix candidates (decide in refinement — this bug report does NOT pre-commit a design)

1. **Subtractive (preferred): delete the `exit_code` category.** It has produced only false
   positives here. Per [[feedback_subtract_flaky_gate_input_not_add_resistance]] — when a gate
   false-blocks on a flaky/ill-posed input dimension, **subtract the dimension** rather than adding
   resistance. Question to answer first: has this category EVER caught a real phantom? If never
   → it is dead weight (R-CCNW-2 discipline: a gate that only ever fires falsely is worse than absent).
2. **Narrow the claim shape.** Only audit a symbol when the line actually asserts membership
   (`PipelineRunnerExitCode.Foo`, or `exit code: <n>`) — never bare co-occurrence.
3. **Add the `declaredSymbols` escape** to match the `activity_event` branch, so the enforcement
   message stops lying. Necessary but NOT sufficient — it would not fix `iteration_cap_exhausted`
   (a real `ExitReason`, still not a `PipelineRunnerExitCode`).
4. **Fail OPEN (warn) instead of `process.exit(2)`.** A hygiene checker that cannot distinguish a
   claim from a co-occurrence must not be a hard gate. Cross-ref
   [[project_b_fomc_checker_structurally_blind_to_fabrication]]: this checker's warning count is
   not a metric, so it should not be load-bearing.

**Do NOT "fix" this by rewording PRDs.** That trains the team to write vaguer PRDs to appease a
broken gate — the opposite of the citation discipline the checker exists to enforce.

## Secondary finding (same run) — **[[R-WDTF]] IS A CLASS, AND THIS IS ITS SECOND SITE** (P1)

**The `requirements` analyst did NOT fail.** `refinement_manifest.json` marks it
`success: false` for c1, c2 **and** c3 — while it wrote **`analysis_requirements.md` at 37,989 bytes**,
the single most valuable artifact of the run (it caught a genuine false-sufficiency claim in the PRD
under refinement, verified independently and confirmed).

**Root cause — `extension/src/bin/spawn-refinement-team.ts:933`:**
```ts
const success = !workerTimedOut && hasToken(logContent, PromiseTokens.ANALYSIS_DONE);
```

This is **exactly the R-WDTF defect**, at a second, previously-unrecorded site: a **narrative signal
(did the model emit a string?) is a hard AND-conjunct that outranks ground truth** (a large, valid,
on-disk analysis artifact). It can only ever DESTROY information. R-WDTF's own bug report frames the
principle: *"`I AM DONE` is a claim, not a fact"* — the same inversion lives here.

| | R-WDTF site 1 | R-WDTF site 2 (NEW) |
|---|---|---|
| File | `extension/src/bin/spawn-morty.ts:2336` | `extension/src/bin/spawn-refinement-team.ts:933` |
| Token | `WORKER_DONE` | `ANALYSIS_DONE` |
| Ground truth ignored | artifacts + edits + `completion_commit` | the written `analysis_*.md` |
| Damage | ticket → `Failed`, `completion_commit: null` | analyst → `success:false`, `all_success:false` |

**Impact:** `all_success:false` degrades or skips synthesis, so the run's best analysis is discarded
as a failure. This makes refinement quality silently non-deterministic — and it is **repo-agnostic**
(it bites on every target repo). **Fix R-WDTF at the CLASS level, not just `spawn-morty`:** consult
ground truth (does the artifact exist and is it substantive?) before recording failure. Note the
existing artifact-based heuristic already used elsewhere — memory
`feedback_morty_validation_log_heuristic` / `feedback_dont_respawn_morty_on_garbled_output` — is the
same recurring lesson.

The benign permission-rule notice in the worker logs
(`Permission allow rule (.claude/settings.local.json): Write(.claude/commands/**) ... use Edit(...)`)
is **NOT** the cause — it appears in the succeeding `codebase`/`risk-scope` logs too.

## Related

- `prds/p1-bug-fix-r-mwmo-d2-exit-code-masking.md` — the PRD this blocked.
- MASTER_PLAN §A.2 — the back-port of this checker to `main` for v2.0 GA (`2ac84924`).
- Memory: `project_b_fomc_checker_structurally_blind_to_fabrication`, `feedback_subtract_flaky_gate_input_not_add_resistance`.
