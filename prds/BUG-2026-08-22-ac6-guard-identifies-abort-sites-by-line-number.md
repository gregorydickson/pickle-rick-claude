# BUG-2026-08-22 (P2) — the AC-6 operator-surface guard identifies abort sites by LINE NUMBER, so any edit above one false-positives

## Status

Open. Found 2026-08-22 by the fixture-leak bundle's own post-terminal verification. **The guard fired,
the finding was false, and the bundle it accused had added no abort site at all.**

## What happens

`extension/tests/ac6-operator-surface-guard.test.js` maintains `TERMINAL_ABORT_SITES`, a baseline
inventory of functions returning `: never`, pinned against base sha `0d7e58dc`. Each member is recorded
as **`file:line`**, and the check is plain string membership:

```js
const added = current.filter(item => !baseline.includes(item));
if (added.length > 0) assert.fail(`${check.surface}: added ${added.length} new member(s) …`);
```

Because the identity is positional, **any edit that shifts a tracked function's line number reads as a
newly-added abort site.**

Measured:

```
base sha 0d7e58dc :  function main(): never   extension/src/bin/test-runner.ts:298
after 313baa68    :  function main(): never   extension/src/bin/test-runner.ts:312
guard             :  "TERMINAL_ABORT_SITES: added 1 new member(s) not in base sha 0d7e58dc:
                      bin/test-runner.ts:312"
```

`313baa68` added a `disposableTmpRoot` helper and one import above `main()`, moving it 14 lines. The
file's `: never` inventory is **unchanged** — `exitWithError` at `:57` and `main`, both before and
after. Nothing was added.

## Why this matters more than a flaky test

The guard exists to enforce the PRIME DIRECTIVE's *"do not add abort conditions."* That is one of the
most important invariants in the repo. A guard that cries wolf on every unrelated edit above a tracked
function will be **routinely overridden**, and the one time a real abort site is added it will be
waved through with the same shrug. A brittle guard on a load-bearing invariant is worse than no guard,
because it manufactures the habit of ignoring it.

It also mis-attributes: the bundle under test was accused of violating its own AC-7 (*"no new abort
condition, no new halt path"*) when it had done nothing of the kind. Resolving that took a manual
`git show` of the base sha.

## Root cause

Positional identity standing in for semantic identity. This is the same shape as the codebase's
dominant defect class (the `did-it-RUN` / lexical-matcher family): `04df0897` compared a realpath
against `path.resolve(os.tmpdir())`; the missing-timeout matcher fired on `RegExp.prototype.exec`; the
bash-scanner blocked on PRD **prose** containing `bash install.sh`. Here, a line number stands in for
"which function".

## Acceptance criteria

- **AC-1** A tracked abort site is identified by something stable under unrelated edits — the enclosing
  **symbol name** plus file (e.g. `bin/test-runner.ts:main`), not `file:line`. Moving a tracked function
  within its file does NOT fire the guard.
- **AC-2** Adding a genuinely new function returning `: never` DOES fire the guard. Pin with a test that
  adds one to a fixture and asserts the failure.
- **AC-3** Removing a tracked site still fires the existing removal arm (the mutation-detection path is
  preserved, not traded away for AC-1).
- **AC-4** Renaming a tracked function is reported as `removed X` + `added Y`, not silently accepted —
  a rename IS a surface change and must be re-baselined deliberately.
- **AC-5** The baseline is re-pinned once at the new identity scheme, and `BASE_SHA` updated, so the
  first run after the fix is green without hand-editing entries.
- **AC-6** No new `exit_reason`, no new abort condition, no new halt path (PRIME DIRECTIVE).
- **AC-7 (report-only)** Tiers do not regress: `cancelled 0`, no new failures beyond the two filed known
  ones (`install-bun-probe`, `extension-wiring` deploy smoke).

## Non-goals

- Widening the guard to ignore additions (that would disable the invariant it protects).
- Re-baselining `TERMINAL_ABORT_SITES` as a workaround while leaving `file:line` identity in place —
  that buys one green run and re-breaks on the next edit above any tracked function.
- The other inventories in the same suite (`pickle_settings.json` keys, CLI parser flags) unless they
  share the positional-identity defect; check, and state the finding either way.

## Simplification Review

1. **Is the addition necessary at all?** No new machinery — a change of identity key in an existing
   check. Ideally a net simplification: symbol names are shorter and more readable than line numbers in
   the baseline array.
2. **Can it REUSE instead of ADD?** Yes — the repo already extracts symbol inventories elsewhere
   (`src/services/CLAUDE.md` records exported-symbol lists per module, and the trap-door catalog cites
   `PATTERN_SHAPE` by symbol). Reuse that convention rather than inventing a third.
3. **Does it guard EXISTING brittle complexity that should be SUBTRACTED?** It IS the brittle thing.
   The honest fix is to correct the identity key, not to add an allowlist of "expected line shifts"
   beside it — that would be a second hatch for one guard.
4. **What can this SUBTRACT?** A whole class of false positives, and the override habit they train on
   the repo's most load-bearing invariant.
