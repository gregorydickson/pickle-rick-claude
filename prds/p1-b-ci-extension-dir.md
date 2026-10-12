# B-CI-EXTENSION-DIR — a new setup test inherits CI's EXTENSION_DIR and reds CI

**Status:** queued 2026-10-12 · **Scope base:** set at launch (HEAD before the ticket) · **Gate legs:** 22 → 22 (no new leg)

## Problem (measured at HEAD `a7eb4611`)

CI `test` is red on `e32100ac` and `a7eb4611`: `test:fast:budget` → `FAIL_BUDGET_EXCEEDED failures=3 budget=2`, and the
only failing test in every run is `extension/tests/setup.test.js` → `runSetupAt: a bare --paused spawn whose deployed
root carries a source sha stays off the network` (added by B-FIELD-103, #100). The local release gate was green
because the operator's shell has no `EXTENSION_DIR`.

`.github/workflows/ci.yml:62` exports `EXTENSION_DIR: ${{ github.workspace }}`. The test's comment says "No
EXTENSION_DIR: the root resolves from HOME", but it never unsets the variable: `runSetupAt` spreads `process.env`
through `setupEnv`, so on CI `getExtensionRoot()` (`extension/src/services/pickle-utils.ts:374`) resolves to the
workspace, `resolvePickleBuildForSetup` finds no `BUILD_INFO.json` there, no `gh` call is made, and
`readFileSync(gh-calls.log)` throws ENOENT. Reproduced locally:

```
cd extension && EXTENSION_DIR="$(cd .. && pwd)" node --test --test-concurrency=1 \
  --test-name-pattern="stays off the network" tests/setup.test.js      # exits 1, ENOENT gh-calls.log
```

The shipped runtime is unaffected (a test-hermeticity defect only).

## Fix

Pass `EXTENSION_DIR: undefined` in that test's `extraEnv`; `setupEnv` (`tests/setup.test.js:76`) already deletes
`undefined` keys for the child ("An `undefined` in extraEnv means unset this for the child"). No production change.

## Tickets

### T1 — setup.test.js: the HOME-resolved build test unsets EXTENSION_DIR
- **Files to modify/create**: `extension/tests/setup.test.js`
- `complexity_tier: small`; tests-only.
- AC1: `cd extension && EXTENSION_DIR="$(cd .. && pwd)" node --test --test-concurrency=1 --test-name-pattern="stays off the network" tests/setup.test.js` exits 0 (exits 1 at HEAD: measured).
- AC2: `cd extension && node --test --test-concurrency=1 tests/setup.test.js` exits 0.
- AC3 (falsifying control, recorded in the conformance artifact, not committed): remove the `EXTENSION_DIR: undefined` line → AC1 exits 1 again.

## Premises

| Claim | Tag | Evidence |
|---|---|---|
| CI red on `e32100ac`/`a7eb4611`, one test | verified | `gh run view --log-failed`: the only name in REPEATED ACROSS RUNS |
| Cause is the inherited `EXTENSION_DIR` | verified | AC1 command fails with ENOENT at HEAD; passes without the variable |
| `setupEnv` unsets `undefined` keys | verified | `extension/tests/setup.test.js:83-87` |

## Open Decisions

| decision | options | default | owner | status |
|---|---|---|---|---|
| none | — | — | — | — |

## Simplification Review

1. **Necessary?** Yes — CI is red on `main`.
2. **Reuse?** Reuses `setupEnv`'s existing `undefined`-unsets contract; no new helper.
3. **Guards brittle complexity?** No; it removes a hidden input (an ambient env var) from one test.
4. **New check?** None. Would the next iteration have caught it? CI did, on the first push — the second time in two
   days a local-green gate missed a CI-only red (B-CI-HERMETIC-HOME was HOME). Recorded; reading CI for the
   gated sha before any tag remains the rule. Gate legs 22 → 22.
