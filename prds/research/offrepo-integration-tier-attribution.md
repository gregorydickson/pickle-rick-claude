# B-OFFREPO — integration-tier attribution, 2026-08-05

`cd extension && npm run test:integration` at HEAD → **EXIT=1, 32 failures**. Attributed below.
`npm run test:fast` at the same HEAD is **GREEN** (7250 tests / 7247 pass / 0 fail / EXIT=0).

## Group A — INHERITED (~10), not this bundle

The R-GADEL / B-GITATTR WS-3 message-inference deletion, bisected to `a7d6d9ec` on 2026-07-27 —
**before this bundle existed**. Named in
`prds/BUG-REPORT-2026-07-27-gitattr-ws3-deletion-left-no-attribution-fallback.md` §2 and shelved by
operator decision:

`AC-WUWC-11a` · `AC-DURA-1 commit branch` · `AC-DURA-8 attribute branch` · `AC-DURA-2 allowlist
staging` · `path-2 autofill` · `path-3 manager-drift` · `path-7 backfill` · `AC-1/AC-2/AC-3 forced
fatal` · and siblings.

## Group B — STALE CONTRACT TESTS introduced by this bundle's behaviour change (NOT a production regression)

The `R-CWGE` family asserts *"a RED verdict is fail-CLOSED"*. They now fail. **The production code is
correct**; the tests are stale.

`isAdvisoryWorkerGateVerdict` (`extension/src/bin/mux-runner.ts:4908`) is correctly scoped:

```ts
if (verdict === 'not_run') return true;
if (verdict !== 'red') return false;
// `absent` is deliberately excluded — "the gate never reported" stays fail-closed everywhere.
return !fs.existsSync(path.join(workingDir, 'extension'));
```

So an **on-repo** red still fail-closes, and `absent` is never advisory. Only a red authored by a
*target repo's own toolchain* is advisory — which is the intended behaviour and the whole point of the
bundle.

**Why the tests fail:** their fixtures are off-repo **by construction**. The harness header says so
itself — *"In this temp-repo harness there is no `extension/`"*
(`extension/tests/integration/codex-worker-gate-fail-closed.test.js:7`). They assert on-repo semantics
against an off-repo fixture, so the new (correct) classifier makes their red advisory.

**Remedy — deliberate, per test, not a bulk rewrite:** either create an `extension/` dir in the fixture
so it genuinely exercises the on-repo path, or update the expectation to the new advisory semantics with
the reasoning recorded. Ticket 10 already did exactly this for the one assertion it was pointed at
(`:116` now reads *"no extension/ dir => worker gate not applicable => verdict not_run => Done flips"*).
Its R-CWGE siblings were never reconciled.

## The release-visibility trap fired exactly as predicted

The refined PRD's new P0 warned: the contract test for this seam is `@tier: integration`, **no pipeline
phase runs that tier**, so the bundle could *"run four green phases while breaking its own contract
test."* That is precisely what happened — 4 phases, 23 commits, and 32 integration failures nobody saw.
The prediction was correct and the mitigation (AC-OFFREPO-4b, run the integration tier) is what caught it.

## Disposition

**Ticket `69cdb73b` is NOT Done.** AC-OFFREPO-4b (`test:integration` green) is unmet, and the reason is
real remaining work, not a stamping problem. Its other four ACs are verified. It also lacks
`conformance_*` and `code_review_*` artifacts — the lifecycle stopped at implement.
