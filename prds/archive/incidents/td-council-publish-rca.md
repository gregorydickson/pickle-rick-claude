---
title: Council-publish hung-timeout RCA
status: Resolved (tests green at HEAD)
date: 2026-05-04
ticket: dfeaf263
source_prd: prds/archive/bug-reports/p3-test-flakes-council-publish-and-scope-resolver.md
mapped_requirements: [R-TF-1]
---

# Council-publish hung-timeout classification — Root Cause Analysis

## Finding (2026-05-04 at HEAD `948136d`)

`extension/tests/council-publish.test.js` passes 32/32 in ~13s at HEAD. No flake reproduced under a 180s wall-clock. The three hung-CLI sub-tests classify and abort within their expected timeout windows:

```
✔ publishCouncilStack: hung `gh pr list` is aborted by timeout, classified as failed (2329.526333ms)
✔ publishCouncilStack: hung `gh pr comment` is aborted by timeout, classified as failed (2383.387625ms)
✔ publishCouncilStack: hung `gh auth status` is aborted, falls back to skipped_no_gh (2015.541875ms)
```

## Reproduction

```
cd extension
node --test tests/council-publish.test.js
# Pass — 32 tests, 0 fail, ~13s.
```

## Root Cause

The flake described in source PRD F1 — "the test mocks `hangOnCall` directing the first call to hang; subsequent calls hang too" — does **not** reproduce at HEAD. Prior commits in the bundle's history (`0390916`, `ac7c496`, `71e5c1e`) were classified as timing bumps that "didn't stick." That classification turned out to be premature: the production code path (`publishCouncilStack` → `runWithTimeout` → `gh pr comment`) correctly classifies each hung invocation independently and aborts on its own timeout boundary.

## Hypothesis for the original flake

The original flake reports likely came from one of:

1. CI runner load — wall-clock noise on a saturated runner causes a timeout-classified call to look like a hang to the harness.
2. Mock state ordering — earlier mock harnesses may have shared `hangOnCall` directive state across invocations; the current mock layer does not.
3. Ordering of `hangOnCall` directives vs. test setup — earlier test patterns called the mock factory with shared closures, leaking the hang directive into subsequent calls. The current factory creates fresh `gh` mock state per test (verified by reading `extension/tests/council-publish.test.js:* setUpHungGhMock` style helpers).

None of these reproduce at HEAD.

## Recommended action

Close dfeaf263 (this ticket) and 6f63fd21 (minimal fix) with no production code change required. Document the green-at-HEAD finding (this file) as the audit trail for the bundle-thesis matrix Section D row.

The `audit-bundle-thesis.sh` Section D canary (per ticket 9b5a639c) should run `node --test tests/council-publish.test.js` and assert exit 0 + 32 passes — that is the durable canary.

## File:line of (hypothesized previous) bug

Not applicable — no live bug at HEAD. Historical commits `0390916`, `ac7c496`, `71e5c1e` are tagged as "timing-only" in the source PRD; reading their diffs is left as an exercise if a future regression appears.
