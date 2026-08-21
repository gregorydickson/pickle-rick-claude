# BUG-2026-08-21 (P2) — `extension-wiring` deploy smoke asserts the path the installer deletes

## Status
Open. Split out of `BUG-2026-08-20` by experiment: it is the ONLY cluster suite that does not move
under the trailer normalization (`fail 1` before and after) — distinct cause, proven.

## What happens
`extension/tests/integration/extension-wiring.test.js:47` asserts the top-level
`~/.claude/agents/morty-gate-remediator.md`. But `install.sh:619-621` deploys managed agents to
`$AGENTS_DIR/.pickle-managed` *"so top-level files remain user overrides"*, and **`install.sh:646`
`rm -f`s the top-level copy** once the managed copy exists.

The managed copy IS present; the asserted path is not. **Re-running the installer cannot fix this — it
is the operation that guarantees the absence**, notwithstanding the test's own failure message telling
the operator to run it.

## Acceptance criteria
- **AC-1** The deploy smoke asserts a path the installer actually produces — either the
  `.pickle-managed` path, or accepts either location.
- **AC-2** The failure message no longer instructs the operator to run the command that causes the failure.
- **AC-3** `node --test tests/integration/extension-wiring.test.js` passes after a deploy.

## Non-goals
Changing the managed-agents deploy layout (the user-override behaviour is deliberate).

## Simplification Review
1. **Necessary?** No new code — a test assertion correction.
2. **Reuse?** Assert against the same constant the installer uses.
3. **Guards brittle complexity?** No; it removes a false assertion.
4. **Subtracts?** A misleading failure message that sends operators in a loop.
