# B-FIXTURE-ENV — a fixture's size depends on the temp-dir path length, so CI has been red on Linux since ~2026-09-26 (`main`)

CI (GitHub Actions, Linux, Node 22) on `main` has failed on every push since about 2026-09-26 (last green `b19f391c`).
The failing test is `tests/microverse.test.js:302` "runRemediatorForIteration bounds the prompt it hands to execve, not
just in the helper": `fixture must produce an over-budget brief; got 86116 <= 98304`. Measured 2026-10-04.

## Mechanism

The fixture builds 200 failures whose `file` is `path.join(workingDir, 'brokenN.test.js')`, with a 120-char message.
The brief's size therefore scales with the temp-dir path length, and it sits right at the `REMEDIATION_PROMPT_MAX_BYTES`
(98304) threshold:
- macOS default `TMPDIR` (`/var/folders/…/T/`), standalone: **98146** — red;
- short `TMPDIR=/tmp/pk`: **81705** — red;
- CI Linux (`/tmp`): **86116** — red;
- inside the local release gate it passes, because the gate's per-run tmp registry gives a longer path. **The local gate
  has been green on an environment accident** while CI was red.

The test's own precondition ("If the brief ever stops exceeding the budget, every assertion below would pass with the
bound removed") is right; the fixture just doesn't guarantee it.

## Fix (test-only)

Make the fixture exceed the budget regardless of path length: raise the per-failure message so 200 failures exceed
`REMEDIATION_PROMPT_MAX_BYTES` by at least 2× with a zero-length path contribution (e.g. `'x'.repeat(1200)`), and keep
the precondition assertion. Update the "~363 KB" comment to the measured size. No product change.

## Acceptance criteria (measured at `aeb3af77`)

1. `cd extension && ./node_modules/.bin/tsc && TMPDIR=/tmp/pk node --test --test-name-pattern="bounds the prompt it hands to execve" tests/microverse.test.js`
   (after `mkdir -p /tmp/pk`) → 1 pass (today: fail, `got 81705`).
2. The same without `TMPDIR` override → 1 pass (today: fail, `got 98146`).
3. `cd extension && node --test tests/microverse.test.js` → 0 failures.
4. `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exit 0.

## Simplification Review

One fixture constant; no product change, no new gate. The general lesson (a fixture threshold must not depend on
ambient paths) is recorded, not turned into a lint.
