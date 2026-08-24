> **✅ SHIPPED 2026-08-24 as v2.1.0-beta.14 — CLOSED.** Full pipeline 4/4, `exit_reason: converged`,
> 394m 16s, session `2026-08-24-04b1a11e`, 16 commits. Refined PRD: `BUG-2026-08-21-node-pin-REFINED.md`.
>
> **Refinement REFUTED this PRD's central premise.** Measured, not argued: `release.yml` was **12/12
> red since 2026-07-18** (a month-long release outage, not a comparability nitpick); `ci.yml` was
> **8/8 red on Node 24** and `main`-only so it never ran on this branch, which destroyed the
> evidentiary basis for "align on 24"; and the 38 cancellations are a **darwin × Node-22 interaction**,
> not a Node-22-line property — on `ubuntu-latest` at v22.23.2 the tier gives 3 named failures in a
> DIFFERENT suite set, and `monitor.test.js` (this PRD's headline suite) does not fail on Linux at all.
>
> **The decision went the opposite way from this PRD's lead: aligned DOWN to `22.x`**, with node's
> `engines` grammar declared as a major-line spec and pinned by a test covering all three workflows
> (the old test read `release.yml` alone, which is how the majors diverged with nothing going red).
>
> **The real blockers were two things this PRD never mentioned:** `spawnSync rg ENOENT` (fixed by
> degrading rg → git grep → grep -rl) and a **provisioning gap** — `release.yml` and `ci.yml` run the
> IDENTICAL command string but only `ci.yml` provisioned the environment it needs, accounting for 31
> of the 69 ubuntu failures. Aligning the pins alone would have shipped green and changed nothing.
>
> Darwin cancellations re-filed as `BUG-2026-08-24-darwin-node22-monitor-cancellations.md`, correctly
> scoped to `monitor.ts` **product code** (an `.unref()`'d watchdog), not the test file.

> **✅ BOTH MANDATORY PRE-LAUNCH CHECKS PASSED — re-measured 2026-08-24 at HEAD `bc6e687b`.**
>
> **Stale premise: PASSED.** All four pins are live and unchanged, measured (not asserted):
>
> | file | value |
> |---|---|
> | `extension/package.json` `engines.node` | `22.x` |
> | `.github/workflows/release.yml` | `'22.x'` |
> | `.github/workflows/ci.yml` | `'24'` |
> | `.github/workflows/stability-gate.yml` | `'24'` |
>
> The contradiction this PRD's correction block describes is ALSO still live: `ci.yml:21` carries
> `# R-CIFB: align CI to the project's actual target (CLAUDE.md = Node 25; ...)` while pinning `'24'`,
> and grepping BOTH `CLAUDE.md` and `extension/CLAUDE.md` for any Node version still returns nothing.
>
> **Green tree: PASSED, baseline recorded.** `npm run test:fast` from `extension/`, interpreter pinned
> to node 24.19.0: **7938 tests / 518 suites / pass 7931 / fail 1 / cancelled 0 / 175.2s**. The single
> failure is the inherited `install-bun-probe` P3. Recorded as inherited; any OTHER fast-tier failure
> during this bundle is caused by this bundle.
>
> **⚠️ THIS PRD'S OWN BASELINE CLAIM IS STALE AND MUST NOT BE REUSED.** The header says *"Measured at
> `770dfe8a` (fast tier green: 7720 tests, 507 suites, fail 0, cancelled 0)"*. **`fail 0` will not
> reproduce.** Measured 2026-08-23: the bun blast radius is ~9 tests, not the 2 filed, because bun IS
> installed and the hang-guard tests spawn the real binary (60s–1035s instead of milliseconds). See the
> amended `BUG-2026-08-21-bun-probe-path-filter-misses-homebrew.md`. Any AC that asserts `fail 0` on
> this host is unsatisfiable; AC-2's `cancelled 0` IS satisfiable and is the meaningful half.

> **⚠️ CORRECTED 2026-08-23 — the divergence is real, but this PRD named the wrong target and the
> authored table was partly unverified.** Measured at HEAD:
>
> | pin | value |
> |---|---|
> | `extension/package.json` `engines.node` | `22.x` |
> | `.github/workflows/release.yml` | `'22.x'` |
> | `.github/workflows/ci.yml` | `'24'` |
> | `.github/workflows/stability-gate.yml` | `'24'` |
>
> The release-gate-vs-CI divergence stands. Three corrections to the authored text:
>
> 1. **The authored `ci.yml` row was asserted before it was read.** It is `'24'`, but the value quoted
>    originally came from a grep that returned empty — right answer, unverified derivation.
> 2. **`ci.yml` carries an R-CIFB comment claiming the project target is Node 25** — *"align CI to the
>    project's actual target (CLAUDE.md = Node 25; dev runs 25.x)"* — yet it pins `'24'`. Grepping BOTH
>    `CLAUDE.md` and `extension/CLAUDE.md` for any Node version returns **nothing**. The comment cites a
>    target that is not documented anywhere. **The codebase disagrees with itself about what the target
>    is**, which is a larger defect than the pin mismatch this PRD describes, and it must be resolved
>    first — otherwise "align on one major" has no authority to align to.
> 3. **Node 25 is unusable on this host**: brew's 25.2.1 fails at launch with
>    `dyld: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.29.dylib`. So "align on 25"
>    is not merely undocumented, it is unavailable here.
>
> **AC-1 must therefore name a major, and that choice is NOT settled by this PRD.** The measured
> evidence favours **24** — both CI workflows use it, and it is the only line where the 38 fast-tier
> cancellations disappear (22.12.0 AND 22.23.2 both cancel; 24.19.0 does not). That is a **lead, not a
> conclusion**: an undocumented target plus a comment asserting a third version means the research phase
> must establish the intent, not infer it.

# BUG-2026-08-21 (P1) — the release gate is pinned to a Node line on which 38 tests cancel

## Status
Open. Found during the 2026-08-20 environmental sweep.

## What happens
Measured at `8c4c5b8a`, fast tier, same sha, same box:

| Node | `monitor.test.js` | `codegraph-service.test.js` |
|---|---|---|
| 22.12.0 | 54 pass / **20 cancelled** | 1 pass / **18 cancelled** |
| 22.23.2 (newest 22.x) | 54 pass / **20 cancelled** | 1 pass / **18 cancelled** |
| **24.19.0** | **74 pass / 0 cancelled** | **19 pass / 0 cancelled** |

Cancellations report `Promise resolution is still pending but the event loop has already resolved`.
This is a Node MAJOR-line behaviour, not patch staleness — the newest 22.x reproduces it exactly.

Meanwhile:

| File | Node |
|---|---|
| `extension/package.json` `engines.node` | `22.x` |
| `.github/workflows/release.yml` | `22.x` |
| `.github/workflows/ci.yml` | `24` |
| `.github/workflows/stability-gate.yml` | `24` |

**The release gate runs on the line where 38 tests cancel; CI runs on the line where they pass.**
GitHub's `22.x` resolves to 22.23.x, which was tested directly.

## Impact
A tier measured under the release pin is not comparable to one measured under CI's. This plausibly
explains why `prds/MASTER_PLAN.md`'s "all three tiers green at `f45812e1`" baseline did not reproduce
on a second machine — the result depends on which node is first on `PATH`.

## Acceptance criteria
- **AC-1** `engines.node`, `release.yml`, `ci.yml` and `stability-gate.yml` agree on one Node major.
- **AC-2** The chosen major produces `cancelled 0` on the fast tier at a named sha, measured on a
  censused idle box, with the census recorded.
- **AC-3** If Node 22 must stay supported, the 38 cancellations are fixed at their source (the async
  test lifecycle in `monitor.test.js` / `codegraph-service.test.js`) rather than by pinning around them.
- **AC-4** Report-only, non-gating: no measurement verdict halts a run (PRIME DIRECTIVE).

## Non-goals
Fixing the individual suites' async patterns unless AC-3 is chosen. Changing the test runner.

## Simplification Review
1. **Necessary?** Config reconciliation; ideally zero new code.
2. **Reuse?** One pinned value referenced by all four files.
3. **Guards brittle complexity?** It removes a divergence rather than adding a guard.
4. **Subtracts?** Two contradictory Node pins collapse to one.
