# BUG: three intentional orphan-fixture spawns fail the missing-timeout audit and block the release gate

- **Date**: 2026-08-16
- **Priority**: P0 — blocks `test:integration` and therefore the beta tag
- **Branch**: `release/v2.1-beta`
- **Measured at**: `5821f3b5` (fast tier green: 7723 tests, 507 suites, fail 0, cancelled 0)

## Problem

`scripts/audit-subprocess-heavy-tests.sh` now fails the missing-timeout check on three callsites, all
introduced by the R-WGTORPH bundle that added the check:

- `extension/tests/integration/orphan-worker-reaper-tmp-prefix-drain.test.js` ×2
- `extension/tests/spawn-morty-worker-gate.test.js` ×1

`pretest:integration` runs that audit, so `npm run test:integration` exits 1 without running a single
integration test. `pretest:fast` runs a different audit pair, which is why `test:fast` is green.

**The three callsites are correct as written.** They are `spawn(..., { detached: true, stdio: 'ignore' })`
orphan FIXTURES — processes deliberately created to outlive their parent so the reaper has something to
reap. A `timeout` would signal the child and defeat the test.

The audit already ships the right mechanism: `scripts/subprocess-heavy-missing-timeout-baseline.json`,
described in the script as grandfathering callsites so pre-existing debt does not redden the gate. These
three were never registered.

## Solution

Register exactly those three callsite keys in `scripts/subprocess-heavy-missing-timeout-baseline.json`,
each with a one-line justification naming why the spawn must be unbounded.

Do NOT add timeouts to them. Do NOT weaken, skip, or reorder the audit. Do NOT baseline anything else.

## Acceptance criteria

- **AC-1 — the audit passes.** `bash scripts/audit-subprocess-heavy-tests.sh` exits 0.
- **AC-2 — integration runs.** `npm run test:integration` gets past `pretest:integration` and reports a
  summary block for BOTH sub-tiers (it is `parallel && serial`; a red parallel short-circuits the serial
  tier, so both must be seen to report).
- **AC-3 — exactly three entries added.** `git diff` on the baseline file adds three keys and removes
  none. Any fourth entry fails this ticket.
- **AC-4 — the check still bites.** Adding a NEW missing-timeout spawn elsewhere still fails the audit.
  Prove it with the existing fixture test rather than by hand.
- **AC-5 — no source changes.** `git diff --name-only` touches only the baseline JSON. No edits under
  `extension/src/`, no edits to the audit script, no edits to the three test files.
- **AC-6 — tier stays green.** `npm run test:fast` reports `fail 0` AND `cancelled 0`, count not below
  7723, read from the runner's own summary block.
