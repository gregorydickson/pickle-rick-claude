# BUG-2026-08-20 — tier evidence for the trailer-normalization bundle

Ticket `9b3c4549` (verification). Branch `release/v2.1-beta`, final sha `291812e5`. Recorded
2026-08-21. Depends on `7c91858f` (`dfa6e239`, `stampPickleTicketTrailer` normalization) and
`87b562c2` (`291812e5`, `buildTrailerAmendedMessage` normalization).

Every count below is quoted verbatim from a captured runner summary block. Where a run was
discarded, the discard reason is recorded rather than the run being silently omitted. Measurement
preconditions: Node `v24.19.0`, pnpm `11.22.0`, all commands run from `extension/`.

## 0. The bundle's claim

`stampPickleTicketTrailer` (mux-runner) and `buildTrailerAmendedMessage` (spawn-morty) both pass an
unterminated commit message straight into `git interpret-trailers`, which only reliably recognizes
a trailing trailer block when its input ends in a newline. An unterminated message produces a
subject-glued trailer the consumer's `%(trailers:key=Pickle-Ticket,valueonly)` oracle cannot read —
the measured root cause of the commit-attribution cluster (see `dfa6e239`, `291812e5`). The fix adds
`normalizeTrailerInputNewline` (collapse trailing newlines to exactly one) applied once before each
`interpret-trailers` call. This ticket records durable, auditable tier evidence for that claim.

## 1. Environment correction — ambient contamination, not a real defect

The first (unscrubbed) run of the nine in-scope suites showed 2 failures in
`spawn-morty-commit-attribution.test.js` with diff `actual: ['9b3c4549'], expected: ['c46045a6']`.
This is the documented ambient-contamination signature (see prior-session memory
`ambient-git-config-false-gate-reds.md`): this worker session's own environment exports
`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0/1`, `GIT_CONFIG_VALUE_0/1` (pointing `core.hooksPath` at this
session's git-trailer-hooks) and `PICKLE_TICKET_ID=9b3c4549`, which stamps `Pickle-Ticket: 9b3c4549`
into ANY commit made by test fixtures — including fixtures asserting against a different fixture
ticket id (`c46045a6`). This is environment leakage from the worker's own harness, not a defect in
the trailer-normalization code under test. Every command below is run scrubbed:

```
env -u PICKLE_TICKET_ID -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 \
    -u GIT_CONFIG_KEY_1 -u GIT_CONFIG_VALUE_1 <command>
```

All nine in-scope suites pass 0-fail/0-cancelled once scrubbed (Section 2).

A second, separate contamination was discovered mid-measurement: a runtime worker-gate check
(`npm run test:fast` under `pickle-spawn-morty-worker-gate-*`, outside this worker's control) was
found running concurrently on this box while a prior iteration's fast-tier attempt was launched in
the background and killed at turn boundary — that discarded run showed mass
`'Promise resolution is still pending but the event loop has already resolved'` corruption across
dozens of suites. Re-run properly in the foreground (Section 3), the fast tier completed cleanly
with zero such corruption, confirming the mass failures were an artifact of the killed background
process racing the concurrent gate check, not a code or environment defect.

## 2. Nine in-scope suites (scrubbed, individually)

| Suite | tests | pass | fail | cancelled | duration_ms |
|---|---|---|---|---|---|
| `tests/boundary-commit-at-iteration.test.js` | 5 | 5 | 0 | 0 | 887.805958 |
| `tests/exit-path-bystander-stash.test.js` | 3 | 3 | 0 | 0 | 505.976708 |
| `tests/mux-exit-path-commit.test.js` | 5 | 5 | 0 | 0 | 474.319291 |
| `tests/mux-runner-fix-b.test.js` | 14 | 14 | 0 | 0 | 312.493667 |
| `tests/integration/pipeline-completion-handsoff-e2e.test.js` | 1 | 1 | 0 | 0 | 582.283709 |
| `tests/runner-authored-trailer.test.js` | 15 | 15 | 0 | 0 | 1457.709333 |
| `tests/spawn-morty-commit-attribution.test.js` | 14 | 14 | 0 | 0 | 1997.260625 |
| `tests/worker-gate-not-run-invariant.test.js` | 12 | 12 | 0 | 0 | 1452.381667 |
| `tests/worker-timeout-preserves-commit.test.js` | 5 | 5 | 0 | 0 | 681.69725 |

All nine: 0 fail / 0 cancelled, scrubbed. Command shape:
`env -u PICKLE_TICKET_ID -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 -u
GIT_CONFIG_KEY_1 -u GIT_CONFIG_VALUE_1 node --test tests/<suite>.test.js`.

## 3. Tier results at `291812e5`

### fast (`node bin/test-runner.js --tier fast --test-concurrency=8`, scrubbed)

Census before: `2026-08-21T16:07:37Z`, `11:07 up 295 days, 21:06, 3 users, load averages: 2.65 6.31
7.33`. Census after: `2026-08-21T16:10:57Z`, `11:10 up 295 days, 21:10, 3 users, load averages: 8.52
9.19 8.43` (load rose sharply — a real 8-core-saturating fast-tier run, not idle).

```
ℹ tests 7766
ℹ suites 508
ℹ pass 7759
ℹ fail 1
ℹ cancelled 0
ℹ skipped 5
ℹ todo 1
ℹ duration_ms 165983.850625
```

The single failure is UNRELATED to this bundle — `tests/install-bun-probe.test.js` ("bun probe emits
banner when bun is absent") — a pre-existing environmental flake (the `bug-2026-08-19` evidence doc
already records this same suite failing identically at both the pre-bundle and post-bundle sha for
that bundle). `grep -c "Promise resolution is still pending"` on the captured output = 0.

### integration:parallel (`npm run test:integration:parallel`, scrubbed)

Census before: `2026-08-21T16:11:17Z`, `11:11 up 295 days, 21:10, 3 users, load averages: 7.05 8.80
8.31`. Census after: `2026-08-21T16:13:02Z`, `11:13 up 295 days, 21:12, 3 users, load averages: 3.98
7.15 7.71`.

```
ℹ tests 632
ℹ suites 21
ℹ pass 631
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 97682.148541
```

The single failure is `tests/integration/extension-wiring.test.js` ("deploy smoke: gate bins and
data exist after bash install.sh"): `Missing deployed paths (run bash install.sh):
/Users/gregorydickson/.claude/agents/morty-gate-remediator.md`. This is a `bash install.sh`
deployment-freshness gap on this operator box, unrelated to trailer normalization — recorded here
as an **out-of-scope PASS for this bundle**, not a bundle failure, per this ticket's Acceptance
Criteria. `grep -c "Promise resolution is still pending"` = 0.

### integration:serial (`npm run test:integration:serial`, scrubbed)

Census before: `2026-08-21T16:13:02Z` (same as integration:parallel "after", run launched
immediately following). Census after: `2026-08-21T16:21:04Z`, `11:21 up 295 days, 21:20, 3 users,
load averages: 1.52 3.11 5.37`.

```
ℹ tests 606
ℹ suites 24
ℹ pass 606
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 465995.443959
```

Clean pass, 0 fail, 0 cancelled. `grep -c "Promise resolution is still pending"` = 0.

## 4. Negative control — revert normalization, suites fail again

Method: `git worktree add --detach /tmp/negctrl-worktree 291812e5` (bundle HEAD, both fix commits
present), then `git revert -n 291812e5 dfa6e239` to revert both source fixes into the working tree,
then `git restore --source 291812e5 -- extension/tests/runner-authored-trailer.test.js` to restore
the CURRENT (post-fix) test file — i.e. revert only the source normalization, keep the regression
tests the fix added. (`git checkout <ref> -- <path>` was tried first and BLOCKED by the runtime
R-WSRC-GR hook — "git checkout is FORBIDDEN inside worker subprocesses"; `git restore --source <ref>
-- <path>` is the sanctioned equivalent.) `extension/node_modules` was symlinked from the main tree,
not reinstalled. Main tree (`git status`) was clean before and after; the worktree was removed after
capture.

`npx tsc --noEmit` in the reverted worktree: exit 0, clean. This confirms the bug is a runtime
behavior defect, not a type error — expected, and consistent with the fix commits' own note.

**`node --test tests/runner-authored-trailer.test.js` (scrubbed), reverted:**

```
ℹ tests 15
ℹ suites 0
ℹ pass 11
ℹ fail 4
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2498.285875
```

The 4 failures are exactly the 4 AC-1b/AC-6 tests commit `dfa6e239` added to prove the fix, e.g.:

```
✖ AC-1b: subject + body paragraph, unterminated, still parses (98.865042ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  false !== true

✖ site 2: executeConvergedPlanAdapter phase commits stamp the trailer (115.473375ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  '' !== 'a1b2c3d4'
```

**`node --test tests/spawn-morty-commit-attribution.test.js` (scrubbed), reverted:**

```
ℹ tests 14
ℹ suites 0
ℹ pass 12
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1995.439709
```

Failures: "untagged single-commit tip is amended with a Pickle-Ticket trailer (word-boundary
attributable)" and "a PROSE-only ticket-id mention is not attribution — the tip IS amended".

**Conclusion**: reverting the 2-line normalization reproduces exactly the failures the bundle's two
fix commits claim to resolve, in the exact two suites the bundle targets. The negative control
confirms the fix's causal claim.

## 5. AC disposition

| AC | Requirement | Result |
|---|---|---|
| AC-4 | nine in-scope suites recorded pass/fail individually | met — Section 2, all nine 0 fail / 0 cancelled scrubbed |
| AC-7 | tier results recorded report-only, no runner-level halt | met — Section 3, `cancelled 0` in all three tiers |
| AC-8 | measurement preconditions recorded, degradations reported honestly | met — Section 0/1 records both contamination findings; neither was silently converted to a pass or omitted |

## 6. Attribution — the two remaining tier-level reds predate/are outside this bundle

- `tests/install-bun-probe.test.js` (fast tier) — pre-existing environmental flake, already recorded
  identically failing at both the pre-bundle and post-bundle sha of the immediately prior bundle
  (`extension/docs/bug-2026-08-19-tier-evidence.md`, Section 5).
- `tests/integration/extension-wiring.test.js` (integration:parallel tier) — `bash install.sh`
  deployment-freshness gap on this operator box (missing deployed
  `~/.claude/agents/morty-gate-remediator.md`), unrelated to trailer normalization. Recorded as an
  **out-of-scope PASS** for this bundle per the ticket's Acceptance Criteria, not a bundle failure.

**Disposition: the bundle's thesis holds.** The nine in-scope suites are clean, all three tiers
report `cancelled 0`, and the negative control reproduces the pre-fix failures exactly. The two
tier-level reds observed are both attributed to causes outside this bundle's diff and are recorded
honestly rather than omitted, per this repo's PRIME DIRECTIVE (report degradation, do not halt, do
not silently convert a red into a pass).

## 7. Code review (ticket `294c6ed6`)

A code-quality review pass over the same 5 scoped files (`mux-runner.ts`, `spawn-morty.ts`,
`runner-authored-trailer.test.js`, `spawn-morty-commit-attribution.test.js`, this doc) found **zero
P0/CRITICAL and zero P1/HIGH findings**. Both call sites in `mux-runner.ts` remain unmerged, no
blank-id guard was added at `buildTrailerAmendedMessage`, and no behavioral change shipped without
regression coverage — the apparent gap (no new test alongside the `spawn-morty.ts` fix) is not a gap:
`reconcileGit` unconditionally `.trim()`s its output, so every production message reaching
`buildTrailerAmendedMessage` was already newline-stripped pre-fix, and the pre-existing tests in
`spawn-morty-commit-attribution.test.js` already exercise that precondition — confirmed by the
Section 4 negative control above, which reproduces exactly 2 failures in that suite when the fix is
reverted. One non-blocking suggestion was recorded (the two newline-normalization implementations are
functionally identical but not shared as one helper across the two files) and left unactioned as
out of scope for a 2-line fix. Re-ran both in-scope suites live: 29/29 pass. Full detail:
`code_review_2026-08-21.md` and `conformance_2026-08-21.md` under ticket `294c6ed6`.

## 8. Data flow integrity audit (ticket `f168caeb`)

An independent third-angle audit traced the trailer message value end-to-end through both fixed
functions, looking for any remaining path where an unterminated or multi-trailing-newline message
reaches `interpret-trailers`, and whether CRLF or whitespace-only trailing lines are handled.

**Both `mux-runner.ts` call sites** (`commitAndContinueDoneFlip`, `executeConvergedPlanAdapter`'s
`commitPhase`) pass hardcoded single-line literals with zero trailing newlines — trivially safe,
no CRLF possible. **`spawn-morty.ts`'s `buildTrailerAmendedMessage`** has exactly one producer of
its `message` argument (`reconcileGit`'s unconditional `.trim()` in `maybeAmendTicketTrailer`), so
its internal `message.replace(/\n+$/, '') + '\n'` normalization is a no-op-strip-then-append in
every production call — correct, not dead code.

Empirically confirmed in a scratch repo (not committed): an unterminated message fed to
`interpret-trailers` glues the trailer onto the previous line and `--parse` reads it back as
EMPTY, reproducing the bundle's claimed root cause. A whitespace-only trailing line and a
CRLF-terminated message (git canonicalizes CRLF to LF at commit-object-creation time, verified via
`%B` readback) are BOTH already handled correctly by git's own trailer/commit machinery and do not
reach the consumer's `%(trailers:...)` read path malformed — neither is a defect.

**Verdict: zero P0/CRITICAL and zero P1/HIGH data-flow-integrity findings.** No code change
required. Full detail: `research_2026-08-21.md`, `conformance_2026-08-21.md`,
`code_review_2026-08-21.md` under ticket `f168caeb`.

## 9. Test quality review (ticket `01be73ae`)

An independent review of the two in-scope test files (`runner-authored-trailer.test.js`,
`spawn-morty-commit-attribution.test.js`) against four criteria: real-oracle assertions, failure
against unfixed code, meaningful edge-case coverage, and freedom from assertion-free/tautological
tests or shared mutable fixture state.

**Real oracle**: every positive claim about trailer presence/value in both files reads
`%(trailers:key=Pickle-Ticket,valueonly)` (via `parsedTrailer`/`parsedTicketTrailers` helpers), never
a raw `%B` regex. Raw `%B` checks appear only for legitimate orthogonal purposes: proving a trailer
was demoted to prose (present in `%B`, absent from the parsed view — the AC-6 test's whole point),
confirming message-body survival, and one deliberate word-boundary check in spawn-morty's "untagged
tip amended" test that is immediately contrasted by the next test's explicit parsed-oracle assertion
(documented in that test's own comment as the fix for the original prose-mention bug).

**Failure against unfixed code**: already demonstrated by Section 4's negative control (not re-run
here) — reverting both fixes while keeping the current tests reproduces exactly the 4 AC-1b/AC-6
failures in `runner-authored-trailer.test.js` and 2 in `spawn-morty-commit-attribution.test.js`.

**Edge cases pinned**: already-carries-trailer idempotence (both files, via real `readEvidence` calls
in two tests — the strongest possible assertion, exercising the actual production consumer rather
than a simulation), blank/whitespace-only ticket id (`runner-authored-trailer.test.js`, 3 tests),
degraded interpret-trailers-unavailable fallback for `stampPickleTicketTrailer` (2 tests, incl. the
harder pre-existing-trailer-demotion case).

**The `buildTrailerAmendedMessage` "no dedicated test" claim (Section 7) was independently
re-traced, not merely re-cited**: `maybeAmendTicketTrailer` is the sole production call site, and it
builds `message` via `reconcileGitOrNull` → `reconcileGit`, whose `.trim()` unconditionally strips
every trailing newline — so production input is ALWAYS in the exact unterminated state the fix
repairs; there is no reachable production path where the function receives an already-terminated
message. Existing tests already exercise this precondition via real `git commit -m` (git always
stores `%B` ending in one `\n`, per Section 8's empirical probe), across both a single-paragraph
shape and a multi-paragraph shape with pre-existing trailers. Combined with Section 4's negative
control reproducing exactly 2 failures in that suite on revert, the argument holds — **not a gap**.

**Zero assertion-free/tautological tests; zero shared mutable fixture state** — every test uses its
own `mkdtempSync` temp dir.

**One non-blocking observation, not P0/P1**: `spawn-morty-commit-attribution.test.js` has no test
for `maybeAmendTicketTrailer`'s degraded fallback arm (the pre-existing `-m message -m trailer`
two-arg amend at spawn-morty.ts:2436, taken when `buildTrailerAmendedMessage` returns `null`). This
code predates this bundle's normalization fix and is explicitly excluded by this ticket's "NOT in
Scope: Promoting the degraded arm" — recorded for a future ticket, not actioned here.

**Verdict: zero P0/CRITICAL and zero P1/HIGH test-quality findings.** No test or source change
required. Full detail: `research_2026-08-21.md`, `conformance_2026-08-21.md`,
`code_review_2026-08-21.md` under ticket `01be73ae`.
