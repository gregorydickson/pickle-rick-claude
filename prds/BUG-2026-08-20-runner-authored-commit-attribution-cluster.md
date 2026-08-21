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

## Root cause — deliberately OPEN

Not asserted here, per this repo's convention (the `BUG-2026-08-18` serial-tier PRD left its root
cause open for the same reason). One observation for the research phase, offered as a lead and NOT as
a conclusion:

`mux-runner.ts:3884-3885` builds the `core.hooksPath` + `PICKLE_TICKET_ID` trailer-hooks fragment into
the **manager iteration subprocess env** (B-GITATTR WS-1, ticket `cb36a189`). `commitAndContinueDoneFlip`
is ALSO reached in-process on the exit-commit path (`mux-runner.ts:6160`), where that env fragment may
not apply. Whether the in-process arm is genuinely missing the hook, or installs it and fails for
another reason, is exactly what research must establish.

Note the degraded arm PASSES: *"when interpret-trailers cannot run, the appended trailer is still
PARSED"* is green. So the fallback works and the PRIMARY path is what fails — which argues against a
missing-binary explanation.

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
