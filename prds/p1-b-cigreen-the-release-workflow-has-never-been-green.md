# B-CIGREEN — the release workflow has never been green on a tag, and we can now name every reason

---
title: "B-CIGREEN — close the last reds between HEAD and a green release verdict (AC-R8)"
status: draft
priority: P1
type: bug-bundle
composes: [AC-R8, B-CIINT, R-ISSC-residual, B-ONEABORT-residual, B-DRAIN13-ROOT1-residual]
---

## Trigger

**Fourteen consecutive release-workflow runs have failed — beta.7 through beta.20, every v2.1 tag,
without exception.** Until this week nobody could say why, because two separate blindfolds were in the
way: the tags pointed at `origin/main` (fixed in [[B-RELTAG]], beta.19) and [[R-ISSC]] short-circuited
the serial tier whenever the parallel half was non-zero, so a third of the integration surface was never
measured on any release.

Both are now gone, and the beta.20 run (`33060047943`, Node **22.23.2**) is the first honest measurement
of the release surface:

| tier | result |
|---|---|
| `test:fast:budget` | **`OK failures=0 budget=2 runs_completed=5 runs_requested=5`** |
| `test:integration:parallel` | 662 · pass 659 · **fail 0 · cancelled 0** · skipped 3 |
| `test:integration:serial` | 625 · pass 615 · **fail 7 · cancelled 3** |

**This bundle exists to make that last line green.** Nothing else stands between HEAD and AC-R8.

## Two premises this bundle asserts, both measured — do not re-derive them

**1. [[B-DRAIN13]] worked, and CI proves it.** Diffing the beta.19 failing set against beta.20's:
**four tests fixed, zero new.** All four are the `R-APMW-6` wall-clock-guard cases —
`normal subprocess clears both timers on success`, `output every 10s for 4h - wall-clock guard fires`,
`output every 60s for 5 cycles then silence`, `timeout waits for delayed SIGTERM cleanup`. That is
ROOT 1's unref'd-sole-settle-path fix, verified on the platform where it mattered rather than on the
box that never reproduced it.

**2. The beta.19 `test:fast:budget RUN 4` failure was a flake, not a regression.** It read
`OK failures=1 budget=2`; beta.20 reads `failures=0 runs_completed=5`. Filed as unattributed, now
closed by measurement. **Do not open a ticket for it.**

## The constraint that shapes every ticket

**These failures do not reproduce on macOS.** The same serial tier measures **625/625 green** on
macOS / Node 24 — at both the beta.19 and beta.20 ship gates.

**CORRECTED 2026-08-30 (ticket `c1d1eeb3`).** The clause that stood here — "`docker` is present as a
CLI but has no running VM (`docker info` fails; no colima/podman/lima), so there is no local Linux
repro" — is **false as stated**, and being false it was shaping how tickets closed. Docker runs on
this host (server 29.0.1), and `extension/scripts/ci-repro.sh` is the local Linux repro. It derives
CI's provisioning from `.github/workflows/ci.yml` rather than mirroring it, and runs the tier in a
container as the same unprivileged uid CI uses, with no route to the model API. Measured at
`fe7860bb`: the naive `docker run -v "$PWD":/repo:ro node:22 npm run test:fast` shape — the one that
made "no repro" look true — reports **123 fail / 7 cancelled**, essentially all provisioning noise;
the harness reports **1 / 3 / 2 fail across three runs, 0 cancelled**, of 8902 tests. Harness
**provisioning noise measured 0** in every run — the count moves only because both survivors are
genuine and probabilistic on Linux: a coarse-clock `mtimeMs` race (0/300 on macOS, ~35% on Linux)
and one load-sensitive timing assertion. The baseline is deliberately reported as a range; a single
number would imply a determinism the tier does not have.

A ticket still may NOT close on "passes locally" — a macOS pass remains no evidence about Linux, and
that is what this rule was always about. Acceptance is (a) a mechanically-checkable property of the
code or workflow that explains the CI observation, (b) a green CI run on a pushed tag, or (c) a
`ci-repro.sh` run naming the sha it tested — valid only while the harness's own noise baseline is 0,
because a harness that carries noise cannot falsify anything. **State which one you are claiming.**
An "I couldn't reproduce it so it's probably fine" close is the fake-green this repo exists to
prevent.

## ROOT A — a test depends on a tool the runner does not have (1 ticket)

`spawnSync rg ENOENT`. `mega-bundle-e2e.test.js:345,350` calls `execFileSync('rg', ['--files', 'src'])`.
**Ripgrep is installed on this Mac (`/opt/homebrew/bin/rg`) and is NOT provisioned by either workflow** —
`grep -nE "ripgrep|apt-get" .github/workflows/{ci,release}.yml` returns no install step. So the
dependency is invisible locally and fatal in CI: the same absence-vs-measured shape as every other
finding this quarter, relocated to the environment boundary.

Three fast-tier files also spawn `rg` (`scope-one-hop-hang-guard`, `scope-resolver-import-walks`,
`scope-srgt`) and are not currently failing — establish why before assuming they are safe.

**Prefer the formulation that needs no tool.** Provisioning `rg` in the workflow fixes the symptom and
schedules the next one; a test that enumerates source files does not need ripgrep. Decide deliberately
and record the reasoning. AC: `mega bundle A-F smoke paths work together` green in CI, and no test in
the repo spawns a binary the workflow does not provision.

## ROOT B — Linux-only subprocess lifecycle (kill / timeout / orphan) (2–3 tickets)

Six failures, one family — process teardown behaving differently under Linux process semantics:
`PC-4: refinement worker 2-of-3 crash kills siblings — siblings dead in < 30s` ·
`PC-5: refinement team SIGTERM graceful shutdown — all workers killed, process exits` ·
`AP-EXT-ITER54-01: a timed-out gate check leaves no orphaned subtree behind` ·
`runner times out wedged child test process instead of hanging indefinitely` ·
`pipeline state stays coherent across a three-iteration mux-runner fixture` ·
`AC-PCOMP-4: a synthetic 4-ticket additive bundle completes 4/4 hands-off`.

**Lead, not conclusion:** process-group signalling and reaping differ between macOS and Linux
(`detached`, `process.kill(-pid)`, session leadership). Refinement must establish which of the six share
a cause and which are independent. **Do not assume one root because they read alike** — that is the
mistake this repo keeps punishing in the other direction.

## ROOT C — per-iteration gate remediation (1 ticket)

`per-iteration gate remediation logs worker_backend_resolved with backend-resolution source semantics` ·
`per-iteration gate remediation recovers orphan tmp result before classifying success`. Same subsystem,
adjacent assertions.

## ROOT D — path containment (1 ticket)

`check-update extraction containment` · `fails closed on a member whose path escapes via a dot segment`.
Both are archive-extraction containment. **These are security-relevant** — a containment check that
behaves differently on Linux is worth understanding precisely, not patching until green.

## ROOT E — three remaining unsettled promises (1 ticket)

`cancelled 3`, all `Promise resolution is still pending but the event loop has already resolved`. Same
signature as the four B-DRAIN13 just fixed, so **more sole-settle-path timers remain**. B-DRAIN13
classified 12 `.unref()` sites and ref'd those that were the sole settle path; these three are either
sites it declined or a shape it did not cover. Name which. **Do not blanket-ref** — a heartbeat holding
the loop open forever is a new hang, and that warning is why the last pass classified rather than swept.

## ~~ROOT F — [[B-ONEABORT]] residual: 3 abort conditions, target 1~~ — ✅ CLOSED, DO NOT SCOPE

> **Re-derived at HEAD `e4edb6f9` 2026-09-05 (babysitter).** `MICROVERSE_FATAL_REASONS`
> (`src/types/index.ts:1515`) is now **exactly one member**: `['session_state_corrupted']`. That IS
> B-ONEABORT's stated target, so this root is satisfied — closed by [[B-FRESHWIN]] ticket `0d579ec5`
> (`4eee6dbf` withheld the verdict instead of ending the run; `6d7be42a`/`43269175` collapsed
> `dispatchHaltAction` to one disposition at one exit). Per the drain-queue overlap rule the EARLIER
> bundle owns shared work, so B-CIGREEN is recomposed to its remaining five roots.
> **Field evidence, not just the constant:** this same day szechuan-sauce exited
> `baseline_unmeasurable_unrecoverable` and the pipeline still reported `4/4 phases, 403m 24s` —
> a measurement verdict that parks and reports rather than halting, exactly as B-NOSTOP-GATES requires.
> The paragraph below is the pre-fix premise, retained for the record.


`MICROVERSE_FATAL_REASONS` is `['judge_cli_missing', 'session_state_corrupted',
'baseline_unmeasurable_unrecoverable']`. B-ONEABORT's target was **exactly one**: terminate only when
state cannot be safely read or written. `session_state_corrupted` is that floor. The other two are not —
the PRD itself argued *"an inert review phase is not an unsafe run"* for `judge_cli_missing`, and
`baseline_unmeasurable_unrecoverable` is a **measurement** verdict, which [[B-NOSTOP-GATES]] requires to
park and report rather than halt. Park both; keep the set at one member.

## Non-goals

- **Do not bump CI off Node 22.** Node 24 hides the unsettled-promise class rather than fixing it —
  proven by controlled experiment (both lines fail identically with `unref`). Moving CI to 24 would turn
  the workflow green while leaving live production hangs in place. That is the definition of fake-green.
- Do not touch `main`. It is on the stale 2.0 line and is not this branch's problem.
- Do not retag `v2.1.0-beta.16` / `.17`. Standing operator residual; rewriting published history is not
  this bundle's call.

## Closer

Push a tag and **read the workflow verdict**. AC-R8 is met only by a green conclusion on a real tagged
run — not by a local gate, not by "the failures are gone from the log". Verify by comparison, using
`extension/scripts/verify-release-tag.sh`, the way beta.19 and beta.20 did.
