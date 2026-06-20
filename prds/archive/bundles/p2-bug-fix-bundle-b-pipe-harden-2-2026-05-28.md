---
title: P2 — B-PIPE-HARDEN-2 bundle: drain the 3 operator-salvage burdens that surfaced during v1.81.0
status: Draft
filed: 2026-05-28
priority: P2
type: bug-bundle
composes:
  - 34   # R-WTB — worker_timeout_seconds 1200 too short for R-PTG worker lifecycle
  - 87   # R-CSIS — closer-ticket manager runs expensive soaks standalone (timeout loop)
  - 32   # R-TFP — test:fast/integration concurrency flakes (auto-resume, microverse)
---

# PRD — B-PIPE-HARDEN-2 bundle

**Trigger**: The B-PIPE-BABYSIT-HARDEN v1.81.0 run completed but only because the operator hand-salvaged three distinct, *recurrent* pipeline-robustness gaps that the codebase already classifies as known findings. Each one would have looped or failed the bundle outright if the babysitter wasn't present:

1. **#34 R-WTB** — b04f41d6 (R-OMS implementation) hit the 2400s per-ticket worker timeout during a legitimate implement phase. The work was sound (tsc + 15/15 tests). Operator salvaged the validated commit and bumped `worker_timeout_seconds` for the rest of the bundle. Without that intervention, the bundle would have looped on b04f41d6.
2. **#87 R-CSIS** — the closer e7c52000 spawned `node --test tests/integration/deploy-lifecycle-soak.test.js` standalone, executing the full 30-min soak (`SOAK_SECONDS ?? 1800`, enforced `≥ 1800`) instead of the documented `RUN_EXPENSIVE_TESTS=1 npm run test:expensive` where the soak self-skips. Combined with the 44-min manager turn it guaranteed a timeout-halt → relaunch → re-soak **infinite loop**. Operator took over the closer manually.
3. **#32 R-TFP** — `auto-resume-stop-conditions:251` (`status=143 ETIMEDOUT` at 45s) and `microverse.test.js:142` (5s deep-equal timeout) failed in the original c=8 gate. Both passed 100% in isolation (8/8, 175/175). Operator had to re-run at c=4 (test:fast green) AND properly re-run integration (286/288 + 202/202) to authoritatively prove the gate green. Without that proof the release was blocked by the hard "test failures block release" rule.

These three together turn every long-running bundle into a high-touch operator-salvage exercise. Fixing them makes the next B-PIPE-class bundle self-recover.

## Acceptance Criteria

- **AC-BPH2-00**: full release gate green from a clean clone — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive` exits 0 — with **no manual c=4 re-run** required.
- **AC-BPH2-01 (#34 R-WTB)**: a B-PIPE-class ticket whose implement phase legitimately requires ≥40 min of work completes its lifecycle and commits *without* tripping `worker_timeout_seconds` halt. Mechanism: raise the documented R-PTG-floor on the medium-tier `worker_timeout_seconds` and/or add a per-ticket override read at runtime (R-WTB-2/3/4 residual scope).
- **AC-BPH2-02 (#87 R-CSIS)**: the closer's gate-runner invokes `npm run test:expensive` (or equivalent tier-runner) *never* an individual expensive-tier test file standalone via `node --test`. Regression test asserts the closer-issued command set matches the CLAUDE.md release-gate spec exactly.
- **AC-BPH2-03 (#32 R-TFP)**: `auto-resume-stop-conditions.test.js` and `microverse.test.js`'s `per-iteration gate remediation recovers orphan tmp result before classifying success` test both pass cleanly under `--test-concurrency=8` (the gate's actual concurrency), no longer requiring an operator c=4 re-run for authoritative green.
- **AC-BPH2-04**: no `LATEST_SCHEMA_VERSION` bump; schema-neutral (continue the design constraint that protected B-PIPE-BABYSIT-HARDEN from #74 R-WSWA).

---

## Class A — R-WTB worker-timeout-too-short (#34, ~3 tickets)

**Symptom**: B-PIPE b04f41d6 implement phase legitimately took >40 min and tripped `Timeout halt: ticket b04f41d6 timed out 2 consecutive iterations` despite producing correct work. The 2400s medium-tier default + the 2-consecutive-iteration circuit breaker is too aggressive for R-PTG worker lifecycle.

- **R-WTB-A1** — Diagnose which medium-tier B-PIPE-class tickets actually need >40 min vs which are looking-stuck. Instrument an artifact-progress-detector inside the per-ticket timeout: if research/plan/conformance/code-review/commit artifacts are being produced (mtime advancing), the timeout SHOULD NOT halt; if no artifact progress in N min, halt as before.
- **R-WTB-A2** — Raise `TICKET_TIER_BUDGETS.medium.worker_timeout_seconds` from 2400 → 3600 (60 min) as the new documented R-PTG floor, *or* implement the artifact-progress-aware budget from A1 if it's cleaner. Update the trap-door pin in `extension/src/services/CLAUDE.md`.
- **R-WTB-A3** — Regression test: a fixture ticket whose implement phase deliberately runs ~50 min (mocked) completes without a timeout halt under the new budget. Pair with a fixture for the *legitimate* halt case (no artifact progress) to confirm the no-progress guard still fires.

---

## Class B — R-CSIS closer-soak-in-isolation (#87, ~2 tickets)

**Symptom**: closer e7c52000 spawned `node --test tests/integration/deploy-lifecycle-soak.test.js` directly. The standalone invocation bypasses the npm script's `RUN_EXPENSIVE_TESTS=1` skip-path and runs the full 30-min soak (`SOAK_SECONDS ≥ 1800` enforced). Inside a 60-min per-ticket budget this loops.

- **R-CSIS-B1** — Update the closer skill / closer-ticket worker prompt template (`docs/closer-ticket-manager-handoff.md` is the runbook; the prompt template likely lives under `extension/persona.md` or a closer-step skill) to mandate: the gate is executed via the *documented* CLAUDE.md release-gate command (`cd extension && npx tsc --noEmit && … && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`) — never via `node --test <individual-expensive-test-file>`. Add a worker-side trap door enforcing this contract.
- **R-CSIS-B2** — Regression test that scans the closer ticket's research/plan/conformance artifacts for any forbidden command pattern (`node --test tests/integration/deploy-lifecycle-soak.test.js` standalone, or any `node --test` invocation of a `test:expensive`-tier file) and asserts the closer used `npm run test:expensive` (or equivalent tier-runner CLI) instead.

---

## Class C — R-TFP concurrency flakes (#32, ~2-3 tickets)

**Symptom**: `auto-resume-stop-conditions:251` and `microverse.test.js:142` fail timeout-shaped at `--test-concurrency=8` but pass at isolation and at c=4. Both are subprocess-heavy (auto-resume spawns child processes; microverse runs gate-remediation orphan-tmp recovery). The v1.76.0 B-FLAKE bundle serialized some test:fast tail tests; these two evidently slipped through.

- **R-TFP-C1** — Move `auto-resume-stop-conditions.test.js` and `microverse.test.js` (or the specific test cases that flake) into `tests/integration/.serial-tests.json` so they run at `--test-concurrency=1`. Mirror the R-TFP/B-FLAKE precedent.
- **R-TFP-C2** — Audit any *other* subprocess-heavy test that's likely to flake at c=8: integration tests that `spawnSync` a child process with a wall-clock timeout ≤ 5s and read its output deserve serialization. Add a heuristic-based serialization audit (or document the criterion in the trap-door pin) for future tests.
- **R-TFP-C3** — Regression test: run the full `npm run test:fast` + `npm run test:integration` chain 3× in sequence (each at the gate's actual concurrency settings) and assert zero failures across all 3 runs. If this stays green for 3 consecutive CI runs, mark R-TFP fully closed (it'll move from watch-item P3 back to closed status).

---

## Total: 7-8 tickets + closer

| Class | Finding | Tickets | Why |
|---|---|---|---|
| A R-WTB | #34 | 3 | b04f41d6 timeout halt — the loudest salvage |
| B R-CSIS | #87 | 2 | closer-soak loop — the worst latent loop |
| C R-TFP | #32 | 2-3 | unblocks "authoritative green" without manual c=4 |

Dispatch order: B → A → C → close (B is the highest-leverage robustness fix because it prevents the worst loop; A removes the most frequent operator-touch; C closes the long-standing watch-item).

## Closer

`R-PIPE-HARDEN-2-CLOSER` — full release gate, version bump 1.81.0 → **1.81.1** (PATCH — fixes only, no new behavior or events), `bash install.sh`, `gh release create v1.81.1`. Closes findings #32, #34, #87.
