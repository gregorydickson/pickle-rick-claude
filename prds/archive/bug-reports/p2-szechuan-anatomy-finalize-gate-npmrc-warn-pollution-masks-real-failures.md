# PRD: szechuan-sauce + anatomy-park `finalize-gate` Output Classifier Conflates `.npmrc` WARN With Real Failures (P2)

**Status**: Bug PRD (2026-05-10) — `finalize-gate.ts` (and the per-iteration gate it shares with anatomy-park) treat pnpm's `.npmrc` env-var WARN lines as "failures," exhausting the remediator's 3-cycle cap on noise while real toolchain failures (TS errors, lint errors) get silently buried in the same output stream and never reach the remediator.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**:
- `prds/archive/features/convergence-toolchain-gates.md` — the strategic PRD that defined the convergence-gate + finalize-gate + remediator architecture. THIS PRD reports an *implementation bug* in that architecture's stdout-classifier.
- `prds/p1-szechuan-sauce-llm-judge-non-deterministic-scoring-false-stalls.md` — separate failure mode (false-stall scoring). When BOTH bugs fire together — false-stall ends iteration early AND the gate fails to remediate real toolchain debt — the operator gets a fully-failed shipping pass that *looks* converged.

**Triggering session**: `2026-05-10-965b96f9` — szechuan-sauce Round 2 on `loanlight-api@gregory/1025-appraisal-epic`. Loop exited at iter 7 with `no_progress` (per #17), then finalize-gate ran 3 remediation cycles and escalated. Escalation file: `gate/escalation_2026-05-10T12-14-14Z.md`. Same pattern observed in `2026-05-09-92dbdff2` (szechuan R1) and `2026-05-08-5d60b760` (anatomy-park R1) earlier.

---

## Severity: P2

- **Compound mission failure**: combined with #17's false-stall, the operator gets a session that (a) stops early on misleading signal, (b) introduces real toolchain regressions during its iterations, and (c) cannot rescue them via finalize-gate because the gate classifier is blind to them.
- **Silent**: `escalation_*.md` files claim "Manual remediation required" against `.npmrc` WARN, but the actual TS errors / lint errors are nowhere in the file. Operator chasing the escalation message hits a dead end.
- **Persistent across sessions**: every szechuan/anatomy-park run on `loanlight-api` exhibits this — `${GITHUB_PACKAGES_TOKEN}` is unset in the worker shell, so every pnpm invocation prints `WARN  Issue while reading ".../.npmrc"`. The gate parser has no env-noise filter.
- **Not pipeline-killer**: the runner exits cleanly with `RC=2` from finalize-gate; the work is committed; manual `pnpm run typecheck && pnpm run lint:quiet` reveals the real debt. Operator just has to know to look — that knowledge is not surfaced anywhere in the runner output.

---

## Symptom (observed Round 2)

`gate/escalation_2026-05-10T12-14-14Z.md`:

```
# Gate Escalation: Cap Exhausted

Skill: szechuan
Cap: 3 cycles
Timestamp: 2026-05-10T12:14:14.568Z
Remaining failures: 2

## Failures

- `.../packages/api` [typecheck] 1: WARN  Issue while reading "/.../.npmrc". Failed to replace env in config: ${GITHUB_PACKAGES_TOKEN}
 WARN  Issue while reading "/.../
- `.../packages/api` [lint] 1: WARN  Issue while reading "/.../.npmrc". Failed to replace env in config: ${GITHUB_PACKAGES_TOKEN}
 WARN  Issue while reading "/.../
```

Both "failures" are pnpm's WARN about an unset env var. No real failure is listed. Yet at this exact HEAD, manual gate run shows:

```
$ cd packages/api && pnpm run typecheck
src/lib/appraisal-pipeline/adapter.ts:1185 — error TS18046: 'salesComparison.comparable_sales' is of type 'unknown'
src/lib/appraisal-pipeline/adapter.ts:1186 — error TS18046: 'salesComparison.comparable_sales' is of type 'unknown'

$ pnpm run lint:quiet
✖ 22 problems (22 errors, 0 warnings)
   (prettier drift in agentic-orchestrator.ts, ocr-preprocessor.ts;
    require-await in 4 spec files;
    no-base-to-string in compute-differences.ts;
    unused 'foundAny' var in exhibits-checklist-generator.ts;
    + 16 others introduced by Round 2's Small-Functions / Cognitive-Load / DRY refactors)
```

The remediator's 3 abort files all said:
```
reason: disallowed_failure_class
why: the only reported failures are pnpm warnings while reading .npmrc
because ${GITHUB_PACKAGES_TOKEN} is unset. This is not one of the allowed
hand-edit classes...
```

Remediator correctly refused — env-var noise is outside its remit. Gate then exhausted its 3-cycle cap. Real failures never even entered the conversation.

---

## Root Cause

### Bug A: `.npmrc` WARN pollution

`finalize-gate.ts` and `convergence-gate.ts` capture the combined stdout+stderr of `pnpm run typecheck` / `pnpm run lint:quiet` and parse it for failure lines. pnpm prints `WARN  Issue while reading ".../.npmrc". Failed to replace env in config: ${GITHUB_PACKAGES_TOKEN}` to stderr **before** the actual command runs. The classifier's failure-line regex (or whatever heuristic it uses to count failures) matches these WARN lines, treating them as the only "failures" present.

When the real check then succeeds-or-fails, its output is appended *after* the WARN lines. The classifier likely takes the *first* match or counts only the lines it understands as failures — and in either path, the env-var WARN wins the attention.

### Bug B: worker template doesn't run `pnpm run lint --fix`

The szechuan-sauce worker template (`.claude/commands/szechuan-sauce.md` Override 3) instructs the worker to run tests and commit, but does NOT instruct it to run `pnpm run lint --fix` (or the project's lint-with-autofix script) before each commit. Most of the 22 new lint errors Round 2 introduced are prettier-fixable formatting drift that `pnpm run lint` (which already has `--fix --cache` baked in for `loanlight-api`) would clear with a single invocation. The worker doesn't run it, so each iteration's commit accumulates style debt.

This is **already documented** as a working rule at `prds/MASTER_PLAN.md:17` ("Worker tickets must run the lint + typecheck gate before completion-commit"). The rule exists; the worker template does not enforce it.

### Bug C: gate output parser doesn't distinguish env-var noise from check failures

This is the proximate cause that turns Bug A into a P2. A robust gate parser would:
1. Filter known-benign noise prefixes from stderr before parsing (`^ WARN  Issue while reading.*\.npmrc.*\$\{.*_TOKEN\}` is a deterministic prefix).
2. Track the *exit code* of each pnpm subprocess as the source of truth for "did this check fail" — not stdout/stderr scraping.
3. Only scrape stdout/stderr for *which lines* identify the failure, not *whether* one occurred.

Today the parser appears to do (3) before (2), and treats the WARN match as evidence of failure even when exit code is 0.

---

## Acceptance Criteria

R-FGNC-1 (P2, R-MUST): `finalize-gate.ts` (and the shared `convergence-gate.ts`) MUST filter `.npmrc` env-var WARN lines from stderr before parsing failure lines. Specifically: lines matching `^[\s]*WARN[\s]+Issue while reading ".*\.npmrc".*\$\{.*_TOKEN\}` MUST be dropped from the failure-line stream before classification.

R-FGNC-2 (P2, R-MUST): the gate's "did this check fail" decision MUST be driven by the subprocess exit code, NOT by stdout/stderr line matches. Stdout/stderr is parsed only to enumerate *which* failures exist when exit code is non-zero. When exit code is 0, no failures are reported regardless of stderr content.

R-FGNC-3 (P2, R-MUST): `escalation_*.md` files MUST include the parsed-stdout body (or at least the last 50 lines) when the cap is exhausted, so operators can see what the gate actually saw — not just the noise that got promoted to "failure."

R-FGNC-4 (P2, R-SHOULD): regression test fixture: a recorded `pnpm run typecheck` output containing `.npmrc` WARN + 0 errors + exit 0 MUST classify as `green` with `failures.length === 0`. A recorded output with `.npmrc` WARN + 5 real `error TS....` lines + exit 1 MUST classify as `red` with `failures.length === 5` (the real errors only).

R-FGNC-5 (P2, R-MUST): szechuan-sauce worker template (`.claude/commands/szechuan-sauce.md` Override 3) MUST require `pnpm run lint` (or project-equivalent autofix script, detected via `setup.js`'s project-type detection) to run before each commit when the project is detected as having an autofix script. Failure to autofix-clean blocks the commit; the worker either applies the autofix and commits the cleaned result, or surfaces the residual lint errors as the iteration's principle violation. (Identical structural pattern to anatomy-park's existing per-iteration test gate at `anatomy-park.md:270`.)

R-FGNC-6 (P3, R-MAY): `setup.js` should preflight-check `${GITHUB_PACKAGES_TOKEN}` (and any other tokens referenced in detected `.npmrc` files) and warn the operator at session-start if absent — converting the silent per-invocation WARN into a single up-front actionable message.

R-FGNC-7 (P2, R-SHOULD): trap-door entry in `extension/CLAUDE.md` recording the invariant "gate classifier MUST use exit code as failure signal; stderr scraping is for line enumeration only" with a regression-test reference.

---

## Verification

1. Replay Round 2's `gate_result_cycle_*.json` through the patched classifier — assert `failures.length === 24` (2 TS + 22 lint), not `2` (the WARN noise). Assert no entry in `failures` matches the `.npmrc` WARN regex.
2. Replay Round 2 escalation through R-FGNC-3 — assert escalation_*.md includes the actual TS error lines, not just the WARN excerpts.
3. Synthetic test: mock pnpm subprocess returning `(stderr: " WARN  Issue while reading .npmrc...", stdout: "", exit: 0)` — assert `runGate(...)` returns `{ status: 'green', failures: [] }`.
4. Synthetic test: mock pnpm returning `(stderr: " WARN ...npmrc...", stdout: "src/foo.ts(1,1): error TS2322: ...", exit: 1)` — assert `runGate(...)` returns `{ status: 'red', failures: [{ check: 'typecheck', file: 'src/foo.ts', ruleOrCode: 'TS2322', ... }] }` with no env-var entry.

---

## Out of Scope

- Fixing the underlying `${GITHUB_PACKAGES_TOKEN}` unset in operator shells — that's a per-developer-machine config issue. R-FGNC-6 surfaces it without requiring it to be set.
- Strategic gate architecture (covered in `convergence-toolchain-gates.md`).
- Remediator allowlist expansion — the abort reason here was correct (env-var WARN is genuinely outside the remediator's remit). The fix is upstream of the remediator, in the classifier.
- The LLM-judge false-stall (covered in `prds/p1-szechuan-sauce-llm-judge-non-deterministic-scoring-false-stalls.md`).

---

## Session Notes

Discovered while debugging Round 2 szechuan-sauce on `2026-05-10-965b96f9`. Operator question: "is szechuan-sauce not succeeding its mission?" Answer: yes, by compound failure mode:

1. False-stall (`#17`) ends iteration 7/50 with 22 unaddressed lint errors + 1 TS error introduced by Round 2's small-functions extractions.
2. finalize-gate runs but classifier sees only `.npmrc` WARN noise as "failures."
3. Remediator correctly refuses to fix env-var WARN; cap exhausts.
4. Escalation file claims "Remaining failures: 2" — both are the WARN noise. Real 24 failures (2 TS + 22 lint) are nowhere in the file.
5. Operator manually runs `pnpm run lint` (which auto-fixes) — 22 lint errors disappear instantly. None of them needed worker-LLM intervention; they were prettier drift the worker should have cleared with a single autofix-then-commit step (R-FGNC-5).
6. The 1 TS error needed a 3-line manual fix to restore type narrowing the small-functions extraction dropped — this is the kind of regression a per-iteration `pnpm run typecheck` gate would have caught immediately.

Net: the convergence-toolchain-gates architecture is *correct* — finalize-gate exists, the remediator exists, the escalation flow exists. Two specific bugs (`.npmrc` WARN classification + worker-template missing lint-autofix step) cause the architecture to fail in practice on this codebase. Both are tactical fixes (~half-day each).

Recommended interim mitigation: operators on `loanlight-api` should `export GITHUB_PACKAGES_TOKEN=anything` in the shell before launching pickle-rick sessions — this silences the WARN and makes the gate classifier's noise-confusion go away at the cost of pretending the token is set. Real fix is R-FGNC-1..2.
