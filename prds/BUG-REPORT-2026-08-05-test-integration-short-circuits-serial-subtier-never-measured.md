# BUG REPORT 2026-08-05 — R-ISSC: `test:integration` short-circuits, so the serial sub-tier is never measured when parallel fails

**Priority:** P1 — corrupts every integration-tier attribution we have made
**Found:** by ticket `a6af84ea` (B-OFFREPO) while measuring its own AC, 2026-08-05.
**Status:** open, unfixed.

## The defect

`extension/package.json`:

```json
"test:integration": "npm run test:integration:parallel && npm run test:integration:serial",
"test:integration:parallel": "node bin/test-runner.js --tier integration --manifest tests/integration/.serial-tests.json --manifest-mode exclude",
"test:integration:serial":   "node bin/test-runner.js --tier integration --manifest tests/integration/.serial-tests.json --manifest-mode include --test-concurrency=1"
```

`&&` short-circuits. **When the parallel sub-tier exits non-zero, the serial sub-tier never runs at
all** — and `npm run test:integration` is the release-gate command, named twice in `CLAUDE.md`.

## Why it matters — every red-tier attribution is a partial measurement

A red `test:integration` reports only the **parallel** half. The serial half's state is *unknown*, not
green. So:

- Any statement of the form *"the integration tier has N failures"* is a lower bound on the parallel
  subset, never a count of the tier.
- The serial sub-tier is only ever measured on runs where parallel is **already green** — i.e. exactly
  the runs where it is least likely to matter. **When the tier is broken, half of it is invisible.**
- Ticket `a6af84ea` measured the halves separately and found the serial sub-tier had **never been
  measured**, surfacing 4 distinct failures no one had seen.

**This retroactively qualifies prior findings.** `GATE_RESULT=RED / FAILED_STAGE=test-integration /
10 failures` in
`prds/BUG-REPORT-2026-07-27-gitattr-ws3-deletion-left-no-attribution-fallback.md` was a parallel-only
count. The same applies to the 32-failure count in
`prds/research/offrepo-integration-tier-attribution.md` — corrected there once both halves were
measured.

## Root-cause shape

This is the same family as the rest of the 2026-08 findings: **the instrument, not the thing measured.**
A gate whose failure mode hides part of its own surface cannot be used to attribute anything, and a
human reading its output cannot tell a 10-failure tier from a 14-failure tier.

## Candidate fix — subtractive, and do NOT add a third script

Run both sub-tiers unconditionally and combine their exit codes, so the tier reports its whole surface
on every invocation. `;` + explicit status aggregation, or a single runner invocation that owns both
concurrency modes, rather than a shell `&&` chain. **Do not** add a `test:integration:all` alongside the
existing three — that leaves the broken composite in place as a trap for the next reader, and
`CLAUDE.md`'s release gate would still name the wrong one.

Reuse note: `bin/test-runner.js` already takes `--manifest-mode` and `--test-concurrency`; the two
invocations differ only in those flags, so one runner call that executes both passes is the smaller
change.

## Verification the fix must satisfy

- With a deliberately failing parallel test, `npm run test:integration` still executes the serial
  sub-tier and reports failures from **both**.
- The composite exit code is non-zero if **either** half fails.
- `CLAUDE.md`'s release-gate command needs no edit (the same name keeps working), or is updated in the
  same commit if the name changes.
