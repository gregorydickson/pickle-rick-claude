# BUG — `pipeline-runner` pickle phase: `--max-iterations 0` stops after ONE ticket, and the manager orphans its background worker → 0/4 phases

**Filed:** 2026-07-14 · **Hit while:** running `/pickle-pipeline` for LOA-1763 (loanlight-api, 66-ticket bundle)
**Component:** `extension/bin/pipeline-runner.js` (pickle phase relaunch loop) + the tmux pickle manager worker-spawn path
**Severity:** HIGH — a documented "unlimited" launch form silently builds **one** ticket of N and reports success-shaped `Pipeline finished`.
**Status:** CAPTURE-ONLY

## What happened

A 66-ticket bundle launched via `pipeline-runner.js` with `state.max_iterations = 0` (set by
`setup.js --tmux --resume … --max-iterations 0 --max-time 0` — the exact form the
`/pickle-pipeline` skill Step 11b documents as the "unlimited" auto-launch). Result after 8m17s:

```
PHASE 1/4: PICKLE (backend=claude)
Phase pickle exited with code 0
Phase pickle exited but 65/66 tickets remain pending (1 Done) — not all-tickets-terminal, marking phase incomplete (not advancing)
Phase pickle exited (exit_reason=done_without_commit_evidence); 65/66 tickets remain unfinished.
Pipeline finished: 0/4 phases, 8m 17s
```

State at exit: `max_iterations=0`, `iteration=2`, `step=completed`, `active=false`. Tickets:
**1 Done, 1 In Progress, 64 Todo.**

## Two compounding defects

### (1) `--max-iterations 0` means "stop after one," NOT "unlimited" — inconsistent with `--max-time 0`

`--max-time 0` renders as `Max Time: ∞` (unlimited). By symmetry an operator reads `--max-iterations 0`
as "unlimited iterations." It is not: the pickle-phase relaunch guard appears to be
`iteration <= max_iterations` (or `<`), so with `max_iterations=0` the runner does **one** manager
invocation, increments `iteration` to 2, fails `2 <= 0`, and ends the phase. One ticket built, phase
marked incomplete, pipeline stops at 0/4.

The two flags interpret `0` **oppositely** (time: unlimited; iterations: one-shot). That is the footgun.
The `/pickle-pipeline` skill's own Step 11b uses `--max-iterations 0 --max-time 0` and calls it the
unlimited form — so the skill's documented auto-launch caps the build at a single ticket on any bundle.

**Fix candidates:** make `max_iterations = 0` mean unlimited for iterations too (match `max_time`), OR
have the skill pass an explicit high default (it already defaults to 500 on the *non*-auto path — Step 3
— so the inconsistency is only on the auto-launch/resume path).

### (2) The tmux pickle manager orphans its per-ticket worker on exit

Independent of (1): within its single iteration, the manager closed ticket 10 (a `[manager]`-only
pre-flight, no code — correct), then for ticket 20 (a real code ticket) it spawned the worker as a
**harness-backgrounded task** (`braodi29f`, PID 2607). The manager's own narration:

> "The harness auto-backgrounded that (I didn't request it). Since I'm the tmux manager (likely a
> `claude -p` subprocess), R-MWBG warns a background…"

The manager's turn then reached `end_turn` and the process exited **while the worker was mid-Implement**.
The worker had produced `research_*.md`, `research_review.md`, `plan_*.md`, `plan_review.md`, an edit to
`eligibility-evaluator.ts` and a new `matrix-fidelity.spec.ts` — **all uncommitted** — then died with its
parent (PID 2607 gone). So the ticket reached `In Progress` with **no commit**, yielding
`exit_reason=done_without_commit_evidence`.

Note `allow_inferred_completion_commit=true` **was set** and did **not** help: the flag can infer a
commit whose message lacks the hash tag, but here there is **no commit at all** to infer — the worker was
orphaned before committing. So (2) defeats the R-CECX mitigation by producing a genuinely commit-less
ticket. This is adjacent to **R-MWBG** (manager backgrounding workers) and **R-AICF** (evidence-oracle
disagreement), but the trigger here is the *manager process exiting while its worker is still alive*.

## Repro

1. `setup.js --tmux --resume <SR> --max-iterations 0 --max-time 0` on a multi-ticket bundle.
2. Write `pipeline.json` with `phases:["pickle",…]`; run `pipeline-runner.js <SR>`.
3. Observe: one ticket closes, the next ticket's worker is backgrounded and orphaned on manager exit,
   `Phase pickle exited … 0/4`.

## Impact

A full 4-phase pipeline over a 66-ticket, launch-critical bundle built **~1.5 tickets** and reported a
terminal `Pipeline finished` in 8 minutes — with a `step=completed` state that looks like success to any
non-forensic check. Silent under-build of a launch-blocker bundle.

## Suggested ACs

- `it("max_iterations=0 runs the pickle phase until all tickets are terminal — it does NOT stop after one")`
- `it("--max-iterations 0 and --max-time 0 both mean UNLIMITED — the two flags interpret 0 identically")`
- `it("a tmux manager iteration BLOCKS until its worker commits or fails — the manager never exits with a live orphaned worker")`
- `it("a phase that ends with tickets pending AND iteration budget remaining RELAUNCHES the manager, it does not report Pipeline finished")`
