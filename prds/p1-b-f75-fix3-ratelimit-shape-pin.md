# B-F75-FIX3 — an integration test pins the pre-#72 RateLimitInfo shape (`main`)

Gate `20261005T033126Z-57054` at `main@9d6510e7`: 21/22, soak 1803.7s. Red: `test_integration` (parallel half), one
test: `tests/mux-runner-extracted-helpers-behaviour.test.js:357` "classifyAndRecordIterationEnd: a rejected
rate_limit_event in the iteration log classifies api_limit and records it". f7500002 (`ad5c592a`, #72) and szechuan
`68456fb2` made `RateLimitInfo` carry the deciding event's `status` (`'rejected' | 'allowed_warning'`); the test's
exact `deepEqual` predates it and now sees `status: 'rejected'`. The behaviour is correct; the pin is stale (the file
is integration-tier and was outside the ticket's scope). Measured 2026-10-05.

## Fix
Add `status: 'rejected'` to the expected `rateLimitInfo`. Test-only.

## Acceptance criteria (measured at `9d6510e7`)
1. `cd extension && ./node_modules/.bin/tsc && node --test tests/mux-runner-extracted-helpers-behaviour.test.js` → 0 failures (today: 1).

## Simplification Review
One expected-object field; no product change.
