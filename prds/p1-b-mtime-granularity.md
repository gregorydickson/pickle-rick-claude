# B-MTIME-GRAN — analyst freshness check races filesystem timestamp granularity; CI fast tier flakes on Linux (`main`)

CI on `main@aad36652` (a docs-only commit, right after `d9ee3c04` passed): fast-tier flake budget exceeded, 3 failed
runs of 5 (budget 2). From the uploaded `flake-budget-logs` artifact:
- 2 of the 3 are `tests/refinement-worker-evidence.test.js:13` "evaluateAnalystSuccess: fresh artifact + no token =>
  success true" (`false !== true`);
- 1 is `mux-runner relaunch claims ownership before monitor recovery sees session state` (a single occurrence;
  recorded, out of scope).

Measured 2026-10-05.

## Mechanism

`evaluateAnalystSuccess` (`extension/src/bin/spawn-refinement-team.ts`, ~:970) returns
`fs.statSync(outputFile).mtimeMs >= startTime`. File-system timestamps are coarser than `Date.now()`; Linux ext4
`current_time` can trail the wall clock by a few ms. A file written immediately after `startTime` can therefore carry an
`mtimeMs` a few ms BEFORE it, and the check reports a fresh artifact as stale. The test writes immediately, so it flakes.
In production the same edge would misjudge an analyst that finishes within the granularity window — rare, but the same
false-stale verdict.

Deterministic probe at HEAD (compiled JS): a file backdated 3 ms before `startTime` → `false` (should be `true`); a file
10 min old → `false` (correct).

## Fix

Compare against `startTime - MTIME_GRANULARITY_TOLERANCE_MS` with a named constant of `2000`. That covers ext4 (~ms),
HFS+ (1 s) and FAT (2 s) granularity. It stays far below any real cycle gap: a stale prior-cycle artifact is minutes old.
Update the docblock. No other comparator changes. `recoverable-json.ts` compares against process start, a different
semantic, and is out of scope.

## Acceptance criteria (measured at `aad36652`)

1. New test in `extension/tests/refinement-worker-evidence.test.js`, named with the prefix `MTIME-`: a file backdated by
   3 ms (`fs.utimesSync`) relative to `startTime` → `true`. Today: `false`.
2. New control test: a file backdated by 10 minutes → `false`. Today: `false`; this is a regression control.
3. `cd extension && ./node_modules/.bin/tsc && node --test tests/refinement-worker-evidence.test.js` → 0 failures.
4. `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exit 0.

## Simplification Review

One named constant in one comparator; no new gate. It makes an existing check honest about what the file system can
measure.
