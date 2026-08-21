# BUG-2026-08-20 (P0) — runner-authored commits are unattributable: empty `Pickle-Ticket` trailer → `commit-failed`

## Status

Open. Branch `release/v2.1-beta`, HEAD `8c4c5b8a`. Twelve failures across eight suites, one shared
signature. **This is the last thing standing between this branch and a green tier**, and it is a
reliability defect, not a quality one: a runner that cannot attribute its own commit cannot flip a
ticket Done, so the work is stranded.

## What happens

`commitAndContinueDoneFlip` lands a commit whose `Pickle-Ticket` trailer reads back **empty**. The
completion guard then correctly refuses the Done flip, and every downstream caller reports
`reason=commit-failed`:

```
runner-authored-trailer.test.js:132   '' !== 'a1b2c3d4'
runner-authored-trailer.test.js:144   false !== true
mux-runner-fix-b.test.js:149          expected commit, got reason=commit-failed
mux-exit-path-commit.test.js:90       expected committed, got reason=commit-failed
exit-path-bystander-stash.test.js:94  expected N committed, got reason=commit-failed
boundary-commit-at-iteration.test.js:87,201  expected committed, got honest_failure/commit-failed
spawn-morty-commit-attribution.test.js:124   trailer parses via the consumer's oracle, not a raw-message grep
spawn-morty-commit-attribution.test.js:151   the trailer scan can now attribute the commit
```

The refusal is CORRECT behaviour on an unattributable commit (`mux-runner.ts:6164`). The defect is
upstream: the trailer never gets stamped, so a commit that *should* be attributable isn't.

## Scope — one signature, eight suites

| Suite | fails |
|---|---|
| `tests/runner-authored-trailer.test.js` | 3 |
| `tests/spawn-morty-commit-attribution.test.js` | 2 |
| `tests/boundary-commit-at-iteration.test.js` | 2 |
| `tests/mux-runner-fix-b.test.js` | 1 |
| `tests/mux-exit-path-commit.test.js` | 1 |
| `tests/exit-path-bystander-stash.test.js` | 1 |
| `tests/integration/pipeline-completion-handsoff-e2e.test.js` (`AC-PCOMP-4`) | 1 |
| `tests/integration/extension-wiring.test.js` (`deploy smoke`) | 1 |

`extension-wiring`'s `deploy smoke: gate bins and data exist after bash install.sh` may be a distinct
cause; the research phase should confirm or split it out rather than assume it joins the cluster.

## What is ALREADY excluded — do not re-litigate these

This bundle exists because a full environmental sweep was completed first (2026-08-20). Re-deriving
any of it is wasted iteration:

- **NOT the Node version.** Provisioning Node 24.19.0 removed all 51 cancellations across the three
  tiers. These 12 survive it. The whole Node 22 line (22.12.0 AND 22.23.2) cancels 38 fast-tier tests;
  see `engines.node`/`release.yml` pinning `22.x` below.
- **NOT pnpm.** Installing pnpm 11.22.0 fixed 8 separate `runGate` failures. These 12 survive it.
- **NOT ripgrep, NOT tmux.** Both installed; these 12 survive both.
- **NOT the git version.** `git 2.39.5 (Apple Git-154)` round-trips a `Pickle-Ticket` trailer
  correctly, including the exact `%(trailers:key=Pickle-Ticket,valueonly)` reader the consumer uses.
- **NOT git config.** No `trailer.*`, `hooks`, `gpg`, or `template` keys are set, global or local.
- **NOT the hook mechanism itself.** A hand-built `prepare-commit-msg` hook wired through
  `core.hooksPath` with `PICKLE_TICKET_ID` set stamps and reads back `a1b2c3d4` on this exact box.
- **NOT a regression from the last 17 commits.** All eight suites fail IDENTICALLY at `f45812e1` —
  the sha `prds/MASTER_PLAN.md` records as *"the first fully green measurement on this branch"* —
  when re-run under the corrected environment.

That last point is the uncomfortable one and should be treated as a finding in its own right: **the
ledger's green baseline does not reproduce.** Either that measurement was environment-dependent in a
way not captured, or it did not hold as recorded. The research phase should say which, from evidence.

## Root cause — IDENTIFIED AND REPRODUCED

`mux-runner.ts:5971` builds a **single-line** commit message and stamps the trailer into it:

```ts
const commitMsg = stampPickleTicketTrailer(
  input.workingDir,
  `fix(${input.ticketId}): commit-and-continue recovery (R-ORSR-2)`,  // single line, NO body
  input.ticketId,
);
const commit = spawnSync('git', ['-C', input.workingDir, 'commit', '-m', commitMsg], ...);
```

`stampPickleTicketTrailer` (`mux-runner.ts:5891`) delegates to `git interpret-trailers`. On a message
with **no body**, git appends the trailer directly after the subject with NO blank line — so the
trailer lands inside the SUBJECT paragraph. Git parses trailers out of the LAST paragraph only, so
`%(trailers:key=Pickle-Ticket,valueonly)` — the reader the completion guard uses — returns EMPTY.

Standalone reproduction (git 2.39.5, this repo's box):

```
$ printf 'chore(a1b2c3d4): worker deliverable\nPickle-Ticket: a1b2c3d4\n' > m.txt && git commit -F m.txt
$ git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'
                                     <-- EMPTY

$ printf 'chore(a1b2c3d4): worker deliverable\n\nPickle-Ticket: a1b2c3d4\n' > m2.txt && git commit -F m2.txt
$ git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'
a1b2c3d4                             <-- parses
```

The ONLY difference is the blank line. The trailer is present in `%B` either way — which is why a raw
grep cannot see the damage and why `spawn-morty-commit-attribution.test.js` asserts *"trailer parses
via the consumer's oracle, not a raw-message grep"*. `git-trailer-hooks.ts:157-163` documents this
exact hazard for the hook path; the in-process committer reproduces it via a different route.

Chain: single-line message → subject-glued trailer → consumer reader returns empty → completion guard
sees `kind === 'absent'` → `commitAndContinueDoneFlip` returns `{ok:false}` → callers report
`reason=commit-failed`.

**Left to the research phase:** whether the correct fix is at the message-construction site (give the
message a body), inside `stampPickleTicketTrailer` (guarantee a trailer paragraph for body-less
messages), or both. AC-3 constrains it to ONE seam. Note `stampPickleTicketTrailer`'s fallback
`rendered ?? \`${message}\n\n${trailer}\`` already produces the CORRECT blank-line form — so the
degraded arm is right and the primary arm is wrong, which matches the observed test results exactly.

## Interface Contracts

**`stampPickleTicketTrailer(workingDir: string, message: string, ticketId: string): string`**
- **Inputs**: repo path; a commit message that MAY be a single line with no body; an 8-char ticket id.
- **Output**: a message whose `Pickle-Ticket` trailer is readable by
  `git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'` — for ALL inputs, body or no body.
- **Invariants**: empty/whitespace ticket id → message returned unchanged (no valueless trailer);
  already-carrying messages are not double-stamped; pre-existing trailers
  (`Co-Authored-By`, `Signed-off-by`) remain PARSED, not demoted to body prose.

**`commitAndContinueDoneFlip(input: CommitAndContinueDoneFlipInput): { ok: boolean; sha?: string }`**
- **Inputs**: `{ sessionDir, ticketId, workingDir, statePath, flags, log, stagePaths?, allowDoneWhenGateNotRun? }`
- **Outputs**: `{ ok: true, sha }` when the commit is attributable; `{ ok: false }` otherwise.
- **Errors**: `git add` / `git commit` non-zero → `{ok:false}` with a logged reason.
- **Invariants**: `ok:true` REQUIRES a commit whose trailer the consumer's reader can parse. The
  refusal on a genuinely unattributable commit is preserved unchanged.

## Verification Strategy

Every command below is runnable from `extension/`. **All measurements require Node 24 and pnpm on
PATH** (Node 22 cancels 38 fast-tier tests; pnpm is required by the convergence-gate fixtures):

```bash
# the eight cluster suites
node --test tests/runner-authored-trailer.test.js
node --test tests/spawn-morty-commit-attribution.test.js
node --test tests/boundary-commit-at-iteration.test.js
node --test tests/mux-runner-fix-b.test.js
node --test tests/mux-exit-path-commit.test.js
node --test tests/exit-path-bystander-stash.test.js
node --test tests/integration/pipeline-completion-handsoff-e2e.test.js
node --test tests/integration/extension-wiring.test.js

# tiers (censused idle box; record process census + load average alongside)
node bin/test-runner.js --tier fast --test-concurrency=8
npm run test:integration:parallel
npm run test:integration:serial
npx tsc --noEmit && npx eslint src/ --max-warnings=-1
```

Oracle for AC-1, runnable against any candidate commit:

```bash
git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'   # MUST print the ticket id
```

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-1 | `tests/runner-authored-trailer.test.js` | body-less runner message stamps a PARSED trailer | `parsedTrailer(dir,'Pickle-Ticket') === TICKET_ID` |
| AC-1 | `tests/runner-authored-trailer.test.js` | new regression: single-line message with NO body | trailer parses via `%(trailers:...)`, not just `%B` |
| AC-2 | `tests/runner-authored-trailer.test.js` | guard is satisfiable — evidence committed, not absent | `result.ok === true` and `result.sha` matches HEAD |
| AC-2 | `tests/mux-runner-fix-b.test.js` | M1 ticket-owned dirty work is still committed | outcome is `committed`, not `commit-failed` |
| AC-2 | `tests/boundary-commit-at-iteration.test.js` | boundary commit reports committed | not `honest_failure/commit-failed` |
| AC-4 | `tests/spawn-morty-commit-attribution.test.js` | prose-only id mention is NOT attribution | tip IS amended; trailer scan attributes the commit |
| AC-6 | `tests/runner-authored-trailer.test.js` | degraded arm + idempotence unchanged | one trailer value; fallback still PARSED |

## Acceptance criteria

- **AC-1** `commitAndContinueDoneFlip` produces a commit whose `Pickle-Ticket` trailer reads back via
  `%(trailers:key=Pickle-Ticket,valueonly)` as the ticket id, on BOTH the manager-subprocess arm and
  the in-process exit-commit arm.
- **AC-2** `result.ok === true` and a `completion_commit` is stamped when the work is gate-passing and
  ticket-owned. The guard's REFUSAL on a genuinely unattributable commit is UNCHANGED — this bundle
  must not weaken `mux-runner.ts:6164`, only make the attributable case actually attributable.
- **AC-3** One trailer-stamping seam, not two. If the in-process arm needs the hook, it REUSES the
  existing `git-trailer-hooks.ts` installer rather than adding a parallel stamping path. No third
  policy site.
- **AC-4** All eight suites listed above pass. Each must FAIL if the defect is reintroduced.
- **AC-5** No new `exit_reason`, no new abort condition, no new halt path (PRIME DIRECTIVE).
- **AC-6** `tests/runner-authored-trailer.test.js`'s degraded arm and idempotence tests still pass —
  the fix must not make double-stamping possible or break the `printf` fallback.
- **AC-7** Fast tier: `cancelled 0`, `fail` reduced by at least the 5 cluster members it contains,
  tests >= 7766, suites >= 508. **Measured under Node 24 with pnpm present, on a censused idle box**
  (process census + load average recorded alongside the result, per the binding method rule).
- **AC-8** `test:integration:parallel` and `test:integration:serial` both `cancelled 0`, with the
  cluster's integration members passing. Same measurement conditions as AC-7.

## Non-goals

- **The bun probe.** `tests/install-bun-probe.test.js` fails for an unrelated reason: it simulates
  bun's absence by dropping `PATH` entries whose path string contains `"bun"`, which does not match
  Homebrew's `/opt/homebrew/bin`, so the filter removes zero entries and the probe still finds bun.
  That is a test-isolation defect. File separately; do NOT fold it in.
- **`worker-timeout-preserves-commit` (AC-WDTFTO-1-1/1-3) and `worker-gate-not-run-invariant` AC-1.**
  Real, but a different signature. Separate bundle.
- **The Node pin inconsistency.** `engines.node` and `release.yml` pin `22.x` — a line on which 38
  tests cancel — while `ci.yml` and `stability-gate.yml` use `24`. Real release-gate defect, filed
  separately; do NOT fix it here.
- Re-running the environmental sweep. See "already excluded" above.

## Execution posture

**UNATTENDED.** This bundle edits the commit-attribution / Done-flip path, which is adjacent to the
salvage seam — but per the operator directive of 2026-08-04 there is no hand-build exception, and the
running pipeline executes DEPLOYED JS (`2.1.0-beta.10`, which already carries the `done_without_commit_evidence`
park fix), not the source diff. Watch the Done-flip seam; recover rather than hand-build if it bites.

## Simplification Review

1. **Is the addition necessary at all?** Ideally NO new code. If the in-process arm is simply missing
   the env fragment the subprocess arm already builds, the fix is to route both through one existing
   installer — a reconcile, not an addition.
2. **Can it REUSE instead of ADD?** Yes, and AC-3 requires it: `git-trailer-hooks.ts` already owns
   hook materialization and already handles the idempotence guard and the degraded arm. A second
   stamping mechanism beside it is the smell this section exists to catch.
3. **Does it guard EXISTING brittle complexity that should be SUBTRACTED?** The completion guard is
   NOT brittle here — it refuses correctly on an unattributable commit, and the honest fix is upstream.
   Do not add an escape hatch around the guard; that would be a second hatch for one guard.
4. **What can this SUBTRACT?** Candidate: the divergence between the subprocess arm and the in-process
   arm — two ways to reach one committer, only one of which stamps. Collapsing that to one path leaves
   the system flatter. If research shows the arms cannot merge, record "no subtraction available" with
   the reason.
