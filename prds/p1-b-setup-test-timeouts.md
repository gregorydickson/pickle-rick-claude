# B-SETUP-TEST-TIMEOUTS — two setup.test.js spawns lost their timeout in an anatomy-park rewrite

**Status:** queued 2026-10-12 · **Scope base:** `ee8a1a23` · **Gate legs:** 22 → 22 (no new leg)

## Problem (measured at HEAD `ee8a1a23`)

The B-FIELD-103 release gate (`prds/gate-runner.sh`) went red on 3 of 22 legs, all from one cause:

- `audit-subprocess-heavy-tests` exits 1: `tests/setup.test.js: new missing-timeout spawnSync(...) callsite not in baseline` ×2.
- `test_fast_budget` exits 1: the only failing test in every run is `AP-EXT-ITER42-01: the committed extension/tests corpus has zero un-baselined missing-timeout callsites`.
- `test_integration` exits 1 in its `pretest:integration` hook, which runs the same audit.

Anatomy-park commit `7c107055` ("route every setup spawn site through the no-network env") rewrote the
`env:` argument of two `spawnSync(process.execPath, [SETUP, ...])` calls in `extension/tests/setup.test.js`
(the `runSetup`-style helper near line 475 and the bare non-tmux test near line 755). Neither carries a
`timeout`. The rewrite changed their callsite fingerprints, so they no longer match the baseline in
`extension/scripts/subprocess-heavy-missing-timeout-baseline.json` and read as new.

## Fix

Give both callsites `timeout: 30_000` (the house value; the sibling call at line ~312 already has it).
Do NOT add them to the baseline — that loosens the check. No production code changes.

## Tickets

### T1 — setup.test.js: every SETUP spawn carries a timeout
- **Files to modify/create**: `extension/tests/setup.test.js`
- `complexity_tier: small`; tests-only.
- AC1: `cd extension && bash scripts/audit-subprocess-heavy-tests.sh` exits 0 (exits 1 at HEAD: measured).
- AC2: `cd extension && node --test --test-concurrency=1 tests/setup.test.js tests/audit-subprocess-heavy-tests-missing-timeout.test.js` exits 0.
- AC3: `git diff ee8a1a23 -- extension/scripts/subprocess-heavy-missing-timeout-baseline.json | wc -l` returns 0 (the baseline is not touched).

## Premises

| Claim | Tag | Evidence |
|---|---|---|
| 3 red legs share one cause | verified | gate log: the two audit lines appear in the audit leg and the integration pretest; fast-tier failures are only AP-EXT-ITER42-01 |
| The two calls lack `timeout` | verified | `extension/tests/setup.test.js` near 475 and 755 at `ee8a1a23` |
| Introduced by `7c107055` | verified | `git log -- extension/tests/setup.test.js` |

## Open Decisions

| decision | options | default | owner | status |
|---|---|---|---|---|
| none | — | — | — | — |

## Simplification Review

1. **Necessary?** Yes — three gate legs are red; nothing else ships until they are green.
2. **Reuse?** Reuses the existing `timeout: 30_000` convention and the existing audit; no new code.
3. **Guards brittle complexity?** No; it fixes the cause rather than widening the baseline.
4. **New check?** None. The existing audit caught it on the first gate run. Gate legs 22 → 22.
