# Szechuan Sauce — codex backend judge spawn uses unsupported `claude-sonnet-4-6` model

**Status**: Draft (P1) — silently fakes convergence on every `--backend codex` szechuan run for users on a ChatGPT-account codex CLI

**Severity**: P1 — the loop reports `BestScore: 0` and `exit_reason: converged` after 2 false-stalled iterations, then hands off to `finalize-gate`. No principles review actually executes. The fake "all clean" signal can mask real violations and lull the operator into shipping unreviewed code.

## Symptom (observed)

Repo: `loanlight-api` @ `feat/dscr-agent-v1`. Invocation:

```
/szechuan-sauce --target /Users/gregorydickson/loanlight/loanlight-api --backend codex --scope branch --scope-base main
```

Pane output:

```
OpenAI Codex v0.128.0 (research preview)
--------
workdir: /Users/gregorydickson/loanlight/loanlight-api
model: claude-sonnet-4-6
provider: openai
approval: never
sandbox: read-only
--------
…(full judge prompt)…
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error",
"message":"The 'claude-sonnet-4-6' model is not supported when using Codex with a ChatGPT account."}}
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error",
"message":"The 'claude-sonnet-4-6' model is not supported when using Codex with a ChatGPT account."}}

[2026-05-01T21:42:32.190Z] WARNING: Metric measurement failed twice — treating as stall (commit preserved)
[2026-05-01T21:42:32.190Z] Converged after 2 iterations (stall_counter=1)

🔬 microverse-runner Complete
  Iterations: 2
  Elapsed:    7m 25s
  ExitReason: converged
  BestScore:  0
```

Session: `~/.local/share/pickle-rick/sessions/2026-05-01-330d0300/`. The runner exited "converged" without ever scoring a single iteration. Two commits had already landed during the worker phases (`d0f44b75`, `3ce84b9a`) before convergence; finalize-gate then ran 3 remediation cycles against unrelated `pnpm` env-var warnings (see secondary concern below).

## Root cause

The judge prompt is dispatched through the `codex exec` CLI when `--backend codex` is set. The codex spawn is being invoked with `--model claude-sonnet-4-6` (visible in the pane header `model: claude-sonnet-4-6`). Codex CLI v0.128.0 routes through OpenAI; on a ChatGPT-account install (no Anthropic API key bound to codex), Anthropic models are explicitly rejected with HTTP 400.

The runner treats two consecutive `metric_measurement_failed` events as a stall (`stall_counter=1`) and fast-paths to `converged: true` with `BestScore: 0` — designed for legitimate convergence, not for tool-config failures. Because the judge has emitted no score, `convergence.history` is empty, the iteration loop has no scoring signal, and the "convergence" is structurally indistinguishable from a real one.

## Why this is a bug, not a config issue

- Pickle build phase used codex backend without issue (102 minutes, 11 commits) on the same machine — proving codex CLI itself works.
- The judge uses a different model from the worker: `claude-sonnet-4-6` (judge) vs whatever the worker negotiated (codex CLI default for the user's auth — likely `gpt-5` or similar).
- Hardcoding an Anthropic model name when `--backend codex` is set crosses the backend boundary the flag was supposed to honor.

## Where to fix

Search the pickle-rick-claude extension source for the judge model selection. Likely candidates:

```
extension/src/bin/microverse-runner.ts
extension/src/services/microverse/  (judge spawn helper if extracted)
extension/src/services/codex-spawn.ts  (or wherever codex args are assembled)
```

The fix is one of:

1. **Use a codex-supported model for the judge when `--backend codex`** — pick from `gpt-5-codex`, `gpt-5-mini`, etc., based on what the user's codex CLI accepts. Mirror whatever `pickle-pipeline` worker spawn passes.
2. **Always run the judge through `claude` regardless of `--backend`** — the judge is a small scoring call (~5K tokens, single integer output), and `claude` is always available since the harness itself runs it. Backend-routing for cheap scoring calls is over-engineered.
3. **At minimum: refuse to `converged` on `metric_measurement_failed`** — distinguish "scoring tool broken" from "score converged at zero." A stall caused by zero successful measurements should exit with a non-zero `exit_reason` like `judge_unreachable`.

Recommended: **(2) + (3) layered**. The judge is cheap; route it through claude unconditionally. Independently, harden the convergence logic to never claim convergence with an empty `convergence.history`.

## Atomic tickets (proposed)

### AC-SCJM-01 — Detect & isolate the judge model selection
- Locate the model arg passed to codex when spawning the judge prompt.
- File reference for reviewer: grep `extension/src/` for `claude-sonnet-4-6` literal — the hardcoded string almost certainly lives in one place.
- Output: short writeup of the call site, what determines the model today.

### AC-SCJM-02 — Route judge through claude unconditionally
- Refactor `microverse-runner.ts` (and any helpers) to always spawn the LLM judge via the claude CLI / SDK path, even when `--backend codex` is set.
- Worker iteration spawn continues to honor `--backend codex`.
- Document the rationale in `docs/codex-prompt-design-notes.md`.

### AC-SCJM-03 — Convergence guard against empty history
- In `microverse-runner.ts:~640` (the convergence-check block after `worker convergence: not yet`): before declaring convergence, assert `convergence.history.length >= min_iterations` AND at least one history entry has a non-null `score`. If neither holds, exit with `exit_reason: judge_unreachable` and a non-zero process exit code.
- Update `pipeline-runner.ts` to surface `judge_unreachable` distinctly from `converged` (don't treat as success).

### AC-SCJM-04 — Integration test
- New: `extension/tests/integration/microverse-runner-judge-failure.test.js`.
- Stub the judge spawn to throw the literal `'claude-sonnet-4-6' model is not supported when using Codex with a ChatGPT account` error twice.
- Assert the runner exits with `judge_unreachable` and a non-zero code, NOT `converged`.

### AC-SCJM-05 — Trap-door entry in `extension/CLAUDE.md`
- INVARIANT: judge LLM spawn must be claude-routed regardless of `--backend`.
- PATTERN_SHAPE: `model:\s*claude-` or `--model\s+claude-` appearing in any codex spawn site outside the worker iteration codepath.

### AC-SCJM-06 (optional) — Pickle-pipeline regression — szechuan-sauce skipped on judge failure
- When `/pickle-pipeline --backend codex` reaches the szechuan-sauce phase and the judge is misconfigured, currently `microverse-runner` exits 0 (false converged), then `finalize-gate` runs and possibly modifies code based on out-of-scope toolchain failures.
- After AC-SCJM-03 lands, `microverse-runner` will exit non-zero. Update `pipeline-runner.ts` to NOT spawn `finalize-gate` if microverse exited with `judge_unreachable`. The pipeline should report szechuan as failed and stop, not continue down a remediation path against a phantom score.

## Secondary concern — finalize-gate `pnpm` env-var leak (related, separate scope)

Same session, downstream of the false convergence, finalize-gate spawned 3 remediation cycles against these failures:

```
"check": "lint",
"file": ".../packages/api",
"message": "WARN  Issue while reading \".npmrc\". Failed to replace env in config: ${GITHUB_PACKAGES_TOKEN}",
"severity": "error"
```

The user's shell has `GITHUB_PACKAGES_TOKEN` set; the subshell that finalize-gate spawns doesn't inherit it. `pnpm` then prints a `WARN` and exits non-zero with no other output, which finalize-gate's parser treats as a hard error.

Two compounding bugs here:

- **finalize-gate parser** misclassifies pnpm's `WARN` line (severity=warn) as `severity=error`. A pnpm warning should not block the gate.
- **Subshell env inheritance** — finalize-gate's spawned shell drops the user's `GITHUB_PACKAGES_TOKEN`. Either inherit `process.env`, or document a session-bootstrap step that loads `.envrc` / direnv before spawning.

Not necessarily blocking on AC-SCJM-01..06; could be a follow-up PRD `finalize-gate-pnpm-warn-misclassification.md` if recurring.

## Reproduction (deterministic)

1. On a machine with codex CLI v0.128.0 authed via ChatGPT account (no Anthropic key bound to codex).
2. Any repo, any branch.
3. `/szechuan-sauce --target <path> --backend codex` (with or without `--scope`).
4. Watch the pane: judge spawn fails with the model-unsupported error twice → "Converged after 2 iterations" → `BestScore: 0`.

## Estimated scope

~200–300 LOC: ~50 LOC change in `microverse-runner.ts` (judge spawn + convergence guard), ~80 LOC integration test, trap-door catalog entry, doc note. 4–6 atomic tickets.

## Cross-references

- Sibling P1: `prds/archive/bug-reports/anatomy-park-runner-undefined-description-crash.md` (same backend, different runner crash, same blast radius — szechuan never gets a clean turn).
- Session evidence: `~/.local/share/pickle-rick/sessions/2026-05-01-330d0300/`.
- Triggering codebase context: `loanlight-api/feat/dscr-agent-v1`, PR #1229.
- Codex prompt design notes (existing): `docs/codex-prompt-design-notes.md` — extend with a judge-model section.

## Session Notes

- Both commits landed during the broken run before the false-convergence: `d0f44b75 szechuan-sauce: Small Functions — split DSCR engine orchestration helper` (iter 1, real review work) and `3ce84b9a szechuan-sauce: Fail-Fast — align DSCR form validation bounds` (remediator cycle, may have addressed a real lint/test issue or may be cargo-cult). Operator reviewed and decided to keep/discard.
- The `BestScore: 0` is meaningless for this run — no measurement ever succeeded.
- finalize-gate exhausted its 3-cycle cap and exited with `escalation_2026-05-01T21-48-22Z.md`, but the cycles were chasing pnpm warnings from the .npmrc env-var leak, not real code defects.
