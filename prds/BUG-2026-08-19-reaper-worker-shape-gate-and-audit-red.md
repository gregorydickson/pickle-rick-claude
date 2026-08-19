# BUG-2026-08-19 — the reaper rejects its own leaker at the worker-shape gate, and HEAD is red from the bundle that shipped it

## Status

Open. Branch `release/v2.1-beta`, measured at HEAD `35d127b8`. HEAD is RED: `pretest:integration`
runs an audit that exits 1, so `test:integration` cannot run and the release gate is blocked.

Both defects were introduced or left behind by `2026-08-19-e61425f0` (R-ORCG, 5/5 Done,
`EPIC_COMPLETED`). That bundle ran to completion without succeeding at its thesis.

## WS-1 (P0) — five untimed `spawn(...)` callsites redden HEAD

`bash scripts/audit-subprocess-heavy-tests.sh` at HEAD:

```
AUDIT_EXIT=1
tests/fixture-lifetime-and-registry.test.js: new missing-timeout spawn(...) callsite not in baseline  (x4)
tests/suite-level-fixture-registry.test.js: new missing-timeout spawn(...) callsite not in baseline   (x1)
```

Both files were created by the R-ORCG bundle. `pretest:integration` runs this audit, so the serial
tier reports `fail 1` on `audit-subprocess-heavy-tests: real tests/ directory exits 0` and the tag is
blocked.

Precedent: `53d4ca74` registered three intentional orphan-fixture spawns in the audit's
missing-timeout baseline because those fixtures exist to outlive their parent and a timeout would
defeat the test. That precedent applies ONLY to callsites that genuinely must outlive the runner.

## WS-2 (P1) — the sweep discards the leaker before any ownership or age logic runs

`bin/reap-orphans.js` exits 0, prints nothing, and reaps nothing against a live population of 14
matching processes.

**Root cause, established by source read + live argv (do not re-derive).** The leaked procs are:

```
node /private/var/folders/.../T/pickle-spawn-morty-worker-gate-ctSoCs/bin/npm run test:fast
```

`isWorkerShapedCommand` (`extension/src/services/orphan-reaper.ts:139-149`) returns true only when
`path.basename(tokens[0])` is `codex` (with `exec` + `--dangerously-bypass-approvals-and-sandbox`) or
`claude` (with `-p` + `--dangerously-skip-permissions`). For this family `tokens[0]` is `node`, so the
candidate is rejected at that first gate in `parseWorkerProcsFromPs` (`:255`) and never reaches the
`tmp_fixture` branch at `:259-271`, the positive-ownership resolver, or the `minAgeSeconds` gate. The
`tmp_prefix_fixture` match class is unreachable for the dominant leaker.

This is why `p2-orphan-reaper-coverage-gaps-test-fixture-leak.md` D2's claim that this family is
"matchable in principle" did not hold in practice.

**Measured population (operator, 2026-08-19, full `ps` dump — never a `ps | grep` pipe):**

| point | orphan count |
|---|---|
| R-ORCG launch | 8 |
| before the post-R-ORCG serial tier | 14 |
| after that tier + its `posttest` sweep | 13 |
| after a manual `node bin/reap-orphans.js` | 14 |

All are `ppid 1`, all `0.0%` CPU, oldest ~15h. They cost host memory; they are NOT a CPU-contention
source and must not be described as one — the tier slowdowns measured on 2026-08-18 were a foreign
`loa-2261` jest suite at load average 14, not these.

**Secondary defect, same workstream.** AC-5 of the prior bundle made a zero-reap sweep deliberately
silent (`reap-orphans.ts:27-36` prints only when `result.reaped > 0`). A reaper that matches nothing
is therefore indistinguishable from a clean box. That is fake-green by construction.

## Acceptance criteria

- **AC-1** `cd extension && bash scripts/audit-subprocess-heavy-tests.sh` exits 0 at HEAD.
- **AC-2** For each of the five callsites the ticket states, per callsite, whether it must outlive its parent. Callsites that must → registered in the missing-timeout baseline citing the `53d4ca74` precedent. Callsites that need not → given a real `timeout`. A blanket baseline registration of all five without that per-callsite justification is REJECTED.
- **AC-3** `isWorkerShapedCommand` recognizes the `node <tmpdir>/pickle-*/bin/npm ...` shape as worker-shaped, so it reaches the existing `tmp_fixture` branch. The positive-ownership trap door, the `minAgeSeconds` gate, and the dead-pid demotion are NOT relaxed — this change only stops the early discard.
- **AC-4** A unit test builds the exact live argv `node /private/var/folders/.../T/pickle-spawn-morty-worker-gate-ctSoCs/bin/npm run test:fast` and asserts `parseWorkerProcsFromPs` yields one candidate with `kind: 'tmp_fixture'` and `matchClass: 'tmp_prefix_fixture'`. A companion negative test asserts an unrelated `node script.js` command still yields NO candidate.
- **AC-5** A test asserts a young candidate of this family (age below `minAgeSeconds`) is NOT reaped, so the widened shape cannot collect a live worker-gate child of a running pipeline.
- **AC-6** The sweep reports on every run, not only when it kills something: a zero-reap sweep prints its `scanned` count so "nothing matched" is distinguishable from "nothing to do". Update the prior AC-5 pin rather than leaving two contradictory tests.
- **AC-7** `cd extension && env -u PICKLE_TICKET_ID -u PICKLE_WORKER_TEST_FAST_TIMEOUT_MS -u PICKLE_DATA_ROOT -u PICKLE_DATA_DIR -u TMUX -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000 npm run test:integration:serial` reports `fail 0` / `cancelled 0`, `EXIT=0`.
- **AC-8** `npm run test:integration:parallel` reports `fail 0` / `cancelled 0`, tests >= 622, suites >= 21.
- **AC-9** `npm run test:fast` reports `fail 0` / `cancelled 0`, tests >= 7737, suites >= 508. A shrinking count is a regression, not a fix.
- **AC-10** No test is deleted, skipped, `todo`'d, or dropped from the serial manifest.

## Non-goals

- Killing the existing 14 orphans. That is operator hygiene, done by hand, and is NOT evidence that
  the fix works — the proof is AC-4/AC-5 plus a sweep that reports a non-zero `reaped` against a
  naturally-accumulated population.
- Widening the reaper to any other process family. The `cxhang-int-*` and bare-fixture families named
  in the older PRD stay out of scope; this bundle fixes the one family that is provably leaking.
- Any capability work.

## Simplification Review

1. **What can be deleted instead of added?** AC-3 is a widening of one predicate, not a new class. If
   the `tmp_fixture` branch already exists, nothing new should be built around it.
2. **Is there an existing seam?** Yes — `parseWorkerProcsFromPs` already has the `tmp_fixture` branch
   and match classes. The fix belongs in `isWorkerShapedCommand` alone.
3. **Does this add a new abort condition?** No. The sweep is best-effort and always exits 0; that must
   remain true (`reap-orphans.ts` header contract).
4. **What accretion does this remove?** A silent-on-zero reporting path that made an inert reaper look
   like a clean box.
