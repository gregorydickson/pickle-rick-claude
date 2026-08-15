# BUG: an audit ticket's own doc edit put HEAD red — trap-door entry 1831 chars against a 1500 cap

- **Date**: 2026-08-15
- **Priority**: P1 (red HEAD)
- **Branch**: `release/v2.1-beta`
- **Introduced by**: `1bead552` (session `2026-08-15-b88a6603`, ticket `62174ebf`, the bundle's own
  cross-reference audit ticket)
- **Class**: doc-coupled test regression. The bundle reported 8/8 Done and `EPIC_COMPLETED`; the tree is
  red.

## Problem

`extension/tests/trap-door-conformance.test.js:15` caps a trap-door entry at
`const maxEntryChars = 1500`. `1bead552` expanded the R-WTFT entry at `extension/CLAUDE.md:191` to
document the `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` parent/child split. That entry is now **1831 chars on
the line, 1825 chars of entry text** — over the cap.

Operator-run clean-env fast tier at `1bead552`: **7647 tests, 504 suites, pass 7641, fail 3, cancelled 0,
856579 ms, EXIT=1.** All three failures are the one violation:

```
✖ AC-BUNDLE-17: trap-door entries stay under 1500 chars
  ✖ line 191 conforms
  ✖ clean or unavailable diff has no false failure
✖ extension/CLAUDE.md touched trap-door entries
```

The documented content is CORRECT and must be preserved — the parent/child split is real and is exactly
the kind of invariant the trap-door table exists to record. Only its length violates the rule.

## Why this matters beyond the red

The bundle's per-ticket conformance verdicts all passed and the run synthesized
`EPIC_COMPLETED/all-tickets-done` while leaving the tree red. That is the standing lesson restated: a
per-ticket ALL_PASS verdict is not a tree verdict, and no phase in the run measured the tier after the
final docs commit landed. The fix here is the entry; the finding is that the last commit of a bundle can
redden HEAD with nothing in the run positioned to notice.

## Solution

Bring the R-WTFT entry at `extension/CLAUDE.md:191` under 1500 chars **without dropping the parent/child
invariant**. The entry must retain, in some form: that the variable sizes the gate spawn's timeout in the
PARENT (`resolveWorkerTestGateTimeoutMs`), that it is scrubbed from the gate CHILD's view via
`PICKLE_GATE_SCRUBBED_ENV_KEYS` / `scrubGateEnv()`, and the INVARIANT/BREAKS/ENFORCE triple the format
requires. Cut prose and the call-site enumeration, not the invariant.

Do NOT raise `maxEntryChars`. The cap is the rule being enforced; editing the test to admit the entry
inverts the trap door.

## Acceptance criteria

- **AC-1 — the entry conforms.** `extension/CLAUDE.md:191` entry text is under 1500 chars, and
  `extension/tests/trap-door-conformance.test.js` passes in full: `AC-BUNDLE-17`, `line 191 conforms`,
  `clean or unavailable diff has no false failure`, and `extension/CLAUDE.md touched trap-door entries`.
- **AC-2 — the invariant survives the trim.** The trimmed entry still names the parent resolver, the
  child scrub, and keeps exactly one INVARIANT / one BREAKS / one ENFORCE token. A reader must still be
  able to tell that the variable is honored in the parent and invisible in the child.
- **AC-3 — the cap is untouched.** `git diff` shows no change to `maxEntryChars` and no change to any
  threshold in `extension/tests/trap-door-conformance.test.js`. Raising the cap fails this ticket.
- **AC-4 — tier green.** `npm run test:fast` reports `fail 0` AND `cancelled 0`, measured with
  `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and a clean environment. `cancelled > 0` is inconclusive:
  re-run, never report as pass. Test count must not shrink below 7647.
- **AC-5 — scope.** The diff touches `extension/CLAUDE.md` only. No change under `extension/src/`.

## Out of scope

The between-ticket gate's failure parser (surfaces the npm banner `> pickle-rick-scripts@... pretest:fast`
as a test name) and the orphaned gate shims (`R-WGTORPH`). Both are filed separately.

## Simplification Review

1. **What can be subtracted instead of added?** The fix IS a subtraction — prose removed from an
   over-long entry. Nothing is added.
2. **Does this add a new abort condition?** No. No runtime code changes at all.
3. **Does this add a new configuration surface?** No — AC-3 explicitly forbids moving the threshold.
4. **Is a fix at this seam load-bearing for anything else?** The entry documents the gate-env scrub
   shipped this session, so keeping it accurate under the cap is what makes the trap-door table worth
   consulting at all.
