# B-CIGREEN3 — the CI flake class, and the drain residuals

**Priority:** P1 (reliability)
**Type:** bundle (bug + hardening) — fix-forward from v2.1.0-beta.23.
**Branch:** `release/v2.1-beta`
**build_mode:** unattended.

## Where AC-R8 actually stands

**beta.23 fixed both of beta.22's blockers and they did not recur.** A1 (`simulateBinaryAbsent` deleting
`/usr/bin` + its `/bin` symlink on Linux) and A2 (`rg 14.1.0`'s Unicode matcher dropping the alternation,
fixed with `--no-unicode`) are both absent from the beta.23 CI run. Verified independently in
`ubuntu:24.04` / rg 14.1.0 before shipping.

**AC-R8 is still unmet — 17 consecutive — but the failure MODE changed.** beta.23 CI:

```
FAIL_BUDGET_EXCEEDED failures=3 budget=2 runs_completed=4 runs_requested=5
RUN 1: AP-EXT-ITER21-01 (timeout: bounds a detached unref'd child) + beta6-ga-session-resume
RUN 2: AP-EXT-ITER21-01
RUN 4: runWorkerGate: honors worker_test_gate_timeout_ms
REPEATED ACROSS RUNS: AP-EXT-ITER21-01   <- the ONLY repeat
```

Three failures across four runs; **only one test repeated**. All three are `@tier: fast` and all three
are **timeout-shaped**. This is contention, not breakage — and it is the last thing between HEAD and a
green release workflow.

## 🚨 ROOT A — a load-sensitivity WARNING with no consumer

**The repo already predicted this failure and then ignored its own prediction.**
`scripts/audit-subprocess-heavy-tests.sh` emits, on every single run:

```
WARN: tests/audit-subprocess-heavy-tests-missing-timeout.test.js: load-sensitive subprocess spawn
      (spawnSync(bash/sh, script, { timeout: 15000 })) in 6000-15000ms band — consider serialization
WARN: tests/regression-test-fast-integration-3x.test.js: ... timeout: 10000 ... — consider serialization
```

The first file is **exactly the test that failed twice**. The audit is a **producer with no consumer**:
it names the load-sensitive tests, advises serialization, exits 0, and nothing acts on it. That is this
codebase's recurring shape — a measurement taken and then discarded.

**The machinery to act already exists and is unused for this tier.** `bin/test-runner.js` supports
`--manifest` / `--manifest-mode include|exclude` (35 references), and BOTH `test:integration` and
`test:expensive` already split parallel/serial through `.serial-tests.json`. **The fast tier is the only
tier with no serial sub-tier**, and it runs at `--test-concurrency=8` on `ubuntu-latest`.

**A1 — give the fast tier a serial sub-tier, driven BY the audit's own output.**
Do NOT hand-maintain a second list — that is the enumerated-set shape, and the audit already computes
membership. Derive `tests/.serial-tests.json` (fast) from the audit's load-sensitive verdict, or have
the audit emit the manifest it is already implicitly describing, then run
`test:fast:parallel` + `test:fast:serial` the way integration does. `test:fast:budget` must drive the
same split so the budget measures what CI measures.
**AC-A1a:** the audit's WARN set and the fast serial manifest cannot disagree — a test the audit calls
load-sensitive that is NOT in the manifest fails the audit. Producer and consumer, one seam.
**AC-A1b:** `AP-EXT-ITER21-01`, `beta6-ga-session-resume` and `runWorkerGate: honors
worker_test_gate_timeout_ms` run serially.
**AC-A1c:** total fast-tier wall time does not regress more than 25% (serialization is not free; if it
costs more, narrow the manifest rather than accepting the toll silently).

**A2 — the flake-budget run logs never leave the CI runner.**
`check-flake-budget` writes full per-run output to `/tmp/flake-budget-logs-*/run-N.log` **on the runner**
and prints only the path. R-FBTN gave us the test NAMES (and beta.23 proved that works); the detail is
still unreachable, so every CI flake diagnosis starts from names alone. Upload that directory as a
workflow artifact on failure in BOTH `ci.yml` and `release.yml`.
**AC-A2:** a failing budget run leaves a downloadable artifact containing the per-run logs.

**A3 — decide the three named tests on evidence, not vibes.** For each: is it load-sensitive (serialize
it), or is its timeout genuinely too tight for a 2-core shared runner (raise it with a stated reason)?
`PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` already has a documented floor/clamp resolver — reuse it, do not
add a parallel knob.
**AC-A3:** each of the three carries a one-line rationale naming which of the two it was.

## ⚙️ ROOT B — runner/process operational residuals (verified STILL OPEN)

**B1 — R-TIERWEDGE.** A plain `test:fast` can wedge at ZERO CPU with no summary emitted: it cannot fake
a green (no summary block) but never returns, and `PICKLE_TEST_RUNNER_TIMEOUT_MS` defaults to 3h so a
naive waiter blocks. Encode the operational rule in code: any wait on a tier run needs a **stall
detector** (no log growth for N minutes), not a timeout.
**B2 — R-GRLS.** Fd cleanup registered only via `process.on('exit')`, which SIGKILL never runs.

## 🔌 ROOT C — prompt/template + judge contract

**C1 — R-MPVU. CONFIRMED OPEN at HEAD: `grep -c EXTENSION_ROOT extension/templates/_pickle-manager-prompt.md`
= 8.** The manager prompt ships `${EXTENSION_ROOT}` unbound, so the manager guesses where
`spawn-morty.js` lives. Claude infers and proceeds; **codex binds `~/.codex/pickle-rick` and dies on a
schema mismatch — `--backend codex` fails 100% at first worker spawn.** The fix is written and unwired:
`getExtensionRoot()` (`services/pickle-utils.ts:301`) already sentinel-validates and REJECTS the codex
path. WS-1 substitute at render time (backend-agnostic, preferred). **Build on claude — this bundle
cannot build itself on codex.**

**C2 — the refinement template still recommends a `describe.each` that `node:test` does not have.**
`bin/spawn-refinement-team.ts:178` emits the acceptance-test template
`"describe.each([...]) covers every enumerated target"`, while `:1623` correctly notes `describe.each(`
is a jest/vitest literal absent from `node:test`. B-MEGADRAIN just created the real one —
`tests/helpers/describe-each.js` — so the template should point at that import instead of advising an
API that does not exist. Otherwise every refinement cycle keeps seeding the exact defect A1 of that
bundle spent a release fixing.

**C3 — R-BCFR** delete the `isBraceFreeIf` arm; verify-then-delete the `isNever` arm.

## 🔍 ROOT D — VERIFY-FIRST (each may already be closed; measure before building)

Two of four candidates checked this tick were **already fixed** — the documented ~2-in-6 drift rate held
again. Do the same for these; a ticket whose premise is dead must be CLOSED, not built.

- **D1 — R-JUNS** ("an unparseable judge answer is unrecoverable and aborts the pipeline").
  **Likely STALE:** `microverse-runner.ts:2112` logs `judge_json_parse_failed` and `:2118` calls it a
  *degraded* parse, and `MICROVERSE_FATAL_REASONS` is now exactly `['session_state_corrupted']`, so it
  cannot abort. Verify and close, or find the surviving arm.
- **D2 — R-EROS** (an In-Progress ticket reported "all-Failed" and stamped `recovery_exhausted`).
  Surface is live (49 `recovery_exhausted` references in `mux-runner.ts`); confirm the specific
  misclassification still reachable before building.
- **D3 — `--max-iterations 0` stops after ONE ticket.** No `max_iterations === 0` guard found in
  `pipeline-runner.ts` at HEAD — premise may be stale. Verify.

**DROPPED THIS TICK by the pre-launch check, do NOT re-file:**
- **R-DSPW** — premise dead. `rtk` appears NOWHERE in `extension/src/`; the only hit anywhere is a
  deployed docs evidence file. The "the `rtk` filter empties `ps|grep` so a live worker reads as dead"
  mechanism no longer exists.
- **B-OFFREPO** — **FIXED.** `spawn-morty.ts:2486` routes a target repo to `runOffRepoWorkerGate`,
  which runs the target's own toolchain via `detectProjectType` + the shared gate command map. The
  filed claim ("the worker quality gate does not exist on any repo that is not pickle-rick") is false
  at HEAD.

## 🛡 PRIME DIRECTIVE COMPLIANCE

- **No new halt path.** A1 splits a tier; A2 uploads an artifact; B1 replaces a blind wait with a stall
  detector; C1 binds a variable. Nothing gains an abort condition.
- **Subtraction:** A1 wires an existing producer to an existing consumer rather than adding a list. C1
  deletes a guess by binding a value that is already computed. C2 removes advice for an API that does
  not exist. C3 deletes two dead arms.
- **Enumerated sets:** A1's manifest MUST be derived from the audit, never hand-kept — a hand-kept
  serial list is one test away from the next flake.

## Acceptance criteria

- **AC-1** Node-22 fast tier `fail 0, cancelled 0` (floor: 8941/8947 at beta.23).
- **AC-2** `test:fast:budget` `failures=0, runs 5/5` locally, and the split budget measures the same
  parallel/serial partition CI runs.
- **AC-3** AC-A1a..c, AC-A2, AC-A3 as stated.
- **AC-4 (report-only)** Tiers do not regress from the beta.23 baseline: fast 8947 / int-parallel 687 /
  int-serial 661 / contract 99 / expensive 8 serial + 14 parallel, soak ≥1.8e6 ms.
  **No inherited failures exist — ANY failure is attributable to this bundle.**
- **AC-5 — THE HEADLINE: a green release-workflow run on the resulting tag (AC-R8),** unmet for 17
  consecutive releases. ROOT A is the whole remaining distance; B/C/D are hygiene riding the same
  ~300-minute review toll.

## Non-goals

- **Do NOT move CI off Node 22.** It hides the cancelled-subtest class rather than fixing it.
- **Do NOT raise the flake budget from 2 to hide the flakes.** The budget is the detector; widening it
  is fake-green. Fix the load sensitivity.
- **Do NOT lower `--test-concurrency` globally** as a blunt fix — that taxes every run for three tests.
  Serialize the load-sensitive set instead.
- Do NOT rewrite published tags.

## Simplification Review

1. **Necessary?** ROOT A is the only thing between HEAD and AC-R8 after 17 failures.
2. **Reuse?** A1 reuses `--manifest`/`--manifest-mode` and the `.serial-tests.json` pattern from two
   tiers; A3 reuses the existing timeout resolver; C1 reuses `getExtensionRoot()`, already written and
   sentinel-validated.
3. **Guards brittle complexity?** No — it connects a warning that already exists to an action that
   already exists.
4. **Subtracts?** One orphaned warning, one unbound variable, one impossible API recommendation, two
   dead arms, and two PRD rows closed by measurement rather than built.
