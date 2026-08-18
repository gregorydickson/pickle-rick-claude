# BUG-2026-08-14 — the fast tier's wall clock has outgrown every cap that measures it

**Status:** SUPERSEDED — do not launch. See `prds/BUG-2026-08-14-concurrent-workers-per-session.md`.

> **Why this PRD was wrong.** Its premise was that a 712s tier against a 600s cap is arithmetic. The
> cap was then raised to 1800000 ms and the gate still timed out on all three tickets. Measurement
> found the real cause: workers outlive the manager's 600s Bash ceiling, so two `spawn-morty`
> processes run concurrently and each runs its own full tier. Cost-class partitioning tunes
> concurrency *within* one tier run and does nothing about N tiers at once — and a heavy+light split
> running concurrently would make overlapping workers strictly worse. The measured profile below is
> still accurate and reusable; the thesis is not. Retire rather than implement.

**Status (original):** ready to launch
**Priority:** P1 (reliability)
**Branch:** release/v2.1-beta
**Launch commit:** must be re-measured at launch; the tier was green at `d0099e58` (7600 tests, 7597 pass, fail 0, cancelled 0)

---

## Problem

The `test:fast` tier takes **712 seconds** of wall clock. The worker gate that runs it is capped at
**600000 ms**. The gate cannot pass. It has not been able to pass for as long as the tier has been
this size, and every worker in every bundle pays ~12 minutes to discover that.

This is arithmetic, not flake. Measured on session `2026-08-13-e4ab0833`:

```
worker_gate_failed  c5b81af7  test:fast  __timeout__  "timed out after 600000ms; sent SIGTERM to process tree"
worker_gate_failed  c5b81af7  test:fast  __timeout__  "timed out after 600000ms; sent SIGTERM to process tree"
worker_gate_failed  4f860deb  test:fast  __timeout__  "timed out after 600000ms; sent SIGTERM to process tree"
```

Three gate failures, ~36 minutes burned, and `c5b81af7` consumed its full 2/2
`failed_flip_suppression_cap`. The run completed anyway — `failed_flip_suppressed` absorbed all
three and the pipeline continued, which is B-NOSTOP-GATES working exactly as designed. That is the
saving grace and also the reason this went unnoticed: the gate has been reporting `red` on healthy
code, the suppression ladder has been quietly eating it, and no one had to look.

Two consequences, both reliability:

1. **Every worker gate verdict on a non-`small` ticket is noise.** `worker_gate_tests_verdict: red`
   currently means "the tier is bigger than the cap", not "this worker broke something". The
   `c916b3da` bundle is about making the success verdict consume the test dimension; feeding it
   this signal builds an honest verdict on a dishonest input.
2. **The suppression budget is being spent on arithmetic.** A cap that always trips is a cap that
   is not available when a real failure needs absorbing.

## Evidence

Full-tier profile, taken on a quiet box at `--test-concurrency=8` with
`PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and a clean env
(`env -u PICKLE_TICKET_ID -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_COUNT`):

```
tests 7600   suites 502   pass 7597   fail 0   cancelled 0   skipped 2   todo 1
duration_ms 712377
```

Cost is a heavy tail of subprocess-spawning suites, not a broad mass of small ones:

| seconds | unit |
|--------:|------|
| 128.7 | W4a single choke point / backend / mode / halt-site matrix |
| 104.8 | relational oracle: diff(enabled, disabled) == exactly the injected section |
|  96.3 | mux-runner: rejects command_template with forward slash |
|  94.0 | node-modules-reuse: stubbed worker runs leave extension node_modules lock mtime |
|  82.3 | computeOneHop import walks |
|  79.7 | mux-runner: rejects command_template with path traversal (../) |
|  70.9 | backend=codex |
|  66.6 | mux-runner: runs readiness gate at iteration 0 before manager spawn |
|  60.3 | plumbus-frame-analyzer / bun hang guard |
|  59.5 | spawn-refinement-team: recovered working_dir controls worker cwd |

**128.7s is a hard floor.** No partitioning scheme produces a shard faster than its slowest single
unit. Any design that promises sub-130s is wrong on its face.

Host: 24 cores. `bin/test-runner.js` caps requested concurrency to core count, so the `=8` in
`test:fast` is self-imposed, not a hardware limit.

## The trap this PRD exists to avoid

The obvious fix is `--test-concurrency=24`. It is wrong, and the second-most-obvious fix is the same
mistake wearing a different hat.

- Raising concurrency directly: the standing evidence is that c=8 already yields timeout-shaped
  flakes and c=4 is what reads authoritative. These are subprocess-heavy tests spawning node
  processes and building git repos; they starve under load, and a starved test fails on a stopwatch,
  not a defect. Buying wall clock this way makes the signal less trustworthy, which is the opposite
  of the goal.
- **Sharding on one box is the same lever.** N shards × c=8 on a single machine is `8N` concurrent
  test processes. Four shards is c=32 on 24 cores. Sharding only buys free wall clock when the
  shards land on separate machines; on one box it is a concurrency increase with extra steps.

So the design cannot be "split the file list N ways and run them at once."

## Thesis

**Partition by cost class, not by count.** The tail is subprocess-heavy and starves under load; the
bulk is pure-unit and does not. Run them under different concurrency:

- a **heavy** shard: the subprocess-spawning suites, run at low concurrency where they do not starve
- a **light** shard: everything else, run hot

Total concurrent processes stays near the current envelope. Wall clock drops because the light bulk
stops queueing behind the heavy tail. Contention drops on precisely the suites that flake. This is
the same insight the serial-manifest already encodes (`tests/integration/.serial-tests.json` runs at
`--test-concurrency=1` for exactly this reason) applied one tier down.

## Simplification Review

**1. Is the addition necessary at all?**
Partially. The cost-class split is new behavior. But the raise-the-cap alternative is not a fix — a
cap set above a runtime that keeps growing buys one bundle of relief and re-breaks on the next
suite added. The env override `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS=1800000` is the stopgap already in
use and should stay available; this bundle removes the need to reach for it.

**2. Can it REUSE instead of ADD?**
Yes, and it must. `bin/test-runner.js` already partitions by manifest:
`--manifest <path> --manifest-mode include|exclude`, which is how `test:integration` splits parallel
from serial. A cost-class split is two npm scripts over one new manifest — the same shape as
`test:integration:parallel` / `test:integration:serial`, which already exists and already works.
**Do not add shard flags to the runner.** If the implementation finds itself writing
`--shard i/N` argument parsing, the reuse question was answered wrong.

**3. Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?**
It relieves it. The `failed_flip_suppression_cap` ladder is currently absorbing a deterministic
arithmetic failure, which is not what it is for. Making the gate passable returns that budget to its
actual job. No new guard is added around the existing one.

**4. What can this issue SUBTRACT?**
The standing need for the `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` override on this repo's own bundles.
If the tier fits inside the compiled default, the operator tune-back CUJ stops being load-bearing
for routine launches. Also a candidate: several of the heaviest units above are near-duplicates
(`command_template with forward slash` at 96.3s and `with path traversal (../)` at 79.7s are the
same guard tested twice at 176s combined) — the implementation should look for merges before
accepting the tail as fixed cost.

## Scope

**In:** cutting full-tier wall clock so `test:fast` completes inside the worker gate's compiled
default cap, without raising total concurrency and without reducing coverage.

**Out:**
- Scope-selected shards (the worker gate running only the shard covering its ticket). Deliberately
  excluded — that trades missed-breakage risk for speed and is a separate decision.
- Any change to what the worker gate runs. It keeps running the FULL fast tier.
- Deleting or quarantining tests to make the number smaller.
- Raising `--test-concurrency` as the primary lever.

## Acceptance criteria

Every criterion is a command with a checkable result. Measurements are taken on a quiet box with
`PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and
`env -u PICKLE_TICKET_ID -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_COUNT`.

- **AC-1 — coverage is conserved.** The union of tests executed across the new scripts equals the
  set executed by the current `test:fast`. Assert `tests` count >= 7600 and `suites` >= 502 summed
  across the split, with `fail 0` and `cancelled 0`. A shrinking test count is a failed AC, not a
  faster tier.
- **AC-2 — wall clock fits the cap.** End-to-end wall clock for the full split is under 540000 ms
  (600000 ms cap with 10% headroom). Report the measured number; do not report a pass without it.
- **AC-3 — concurrency envelope is not raised.** Peak concurrent `node --test` worker processes
  across the split does not exceed the current envelope of 8. A design that passes AC-2 by running
  32 processes fails this AC.
- **AC-4 — no shard flags in the runner.** `grep -c 'shard' extension/src/bin/test-runner.ts` is 0.
  The split is expressed in manifests and npm scripts, per Simplification Review Q2.
- **AC-5 — the heavy manifest is justified per entry.** Each entry in the new heavy-class manifest
  carries a recorded reason, mirroring the existing
  `extension/tests/integration/.serial-tests.reasons.json` 1:1-coverage discipline. A test is in the
  heavy class because it spawns subprocesses, not because it happened to be slow once.
- **AC-6 — tier conformance holds.** Every entry in the new manifest declares the `@tier:` of the
  npm script that passes that manifest. This is the trap door that has already bitten twice
  (`tests/dispatch.test.js` sat `@tier: fast` in the integration manifest since v1.78.0 and never
  serialized). Enforced the same way — extend `extension/tests/serial-tests-reasons-coverage.test.js`
  rather than writing a parallel checker.
- **AC-7 — the release gate still reads as one verdict.** The full gate command in
  `extension/CLAUDE.md` and `.github/workflows/release.yml` stay in parity
  (`release-gate-parity.test.js` must pass), and a red sub-tier still reddens the whole gate. A split
  that lets one half go red while the aggregate reads green is a fake-green regression and fails this
  AC outright.
- **AC-8 — the worker gate passes on a real bundle.** After deploy, one bundle runs with no
  `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` override and produces zero
  `worker_gate_failed` events with `__timeout__`. This is the AC that runs the claim; the others
  measure the mechanism.

## Risks

- **AC-3 and AC-2 are in tension by construction.** If the heavy tail cannot be compressed below
  ~540s at low concurrency, the honest outcome is that the tail must shrink (merges, or promotion of
  genuinely-integration-shaped tests to the integration tier following the R-TFP precedent) rather
  than the envelope grow. Report that finding; do not resolve it by quietly raising concurrency.
- **The 128.7s floor.** If a single unit ever exceeds the cap on its own, no partitioning saves it.
  Watch that number.
- **Manifest drift.** A cost-class manifest is a hand-maintained list, and hand-maintained lists go
  stale — that is exactly the `.serial-tests.json` failure mode AC-6 exists to catch. Prefer a
  derivation the audit can re-check over a list someone must remember to update.

## Verification ticket

Per standing practice, this bundle needs a ticket that RUNS the claim rather than inspecting the
mechanism: launch a bundle with the override unset and assert AC-8 against its activity log. A
bundle that only proves the manifests are well-formed has not proven the gate can pass.

## References

- Measured tier profile and the three `worker_gate_failed` events: session `2026-08-13-e4ab0833`
- `extension/src/bin/test-runner.ts` — `--manifest` / `--manifest-mode` selection, `discoverTierFiles`,
  `getRunnerTimeoutMs`
- `extension/package.json` — `test:fast`, `test:integration:parallel`, `test:integration:serial`
- `extension/tests/integration/.serial-tests.json` and `.serial-tests.reasons.json` — the reuse target
- `extension/CLAUDE.md` — serial-manifest hygiene principle (AC-R-ITIH-4), R-TFP precedent,
  R-WTFT worker test-gate timeout trap door
