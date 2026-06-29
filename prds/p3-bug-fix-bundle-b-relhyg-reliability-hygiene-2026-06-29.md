# B-RELHYG — Reliability hygiene bundle (microverse plateau-memory + test time-bombs + orphan-mux leak)

| | |
|---|---|
| **Bundle** | B-RELHYG |
| **Priority** | P3 — hygiene/reliability; none release-blocking, all pipeline-safe |
| **Class** | Bug-fix — microverse failure-memory + test-suite hygiene |
| **Closes** | [[R-MVFM]] (microverse plateau-memory) · test-hygiene follow-ups (hardcoded-date fixture time-bombs · R-OMTD test-subprocess leak) |
| **Backends** | claude |
| **Build protocol** | **NORMAL PIPELINE — R-PSRB does NOT apply.** WS-1 edits `microverse-runner.ts` (the convergence/optimization loop), NOT the salvage/completion/Done-flip path; WS-2/WS-3 edit test files only. The running pipeline executes the **deployed beta.29 JS**, not the source — zero mid-run effect (lands at the closer's `install.sh`). Run via `/pickle-pipeline --scope branch`. **⚠️ Tier every implementation ticket `medium` (NOT `small`)** — a `small`-tier worker gate SKIPS `test:fast`, which is exactly how the B-MWBG regression slipped past the build gate (2026-06-29). |

## Problem

Three independent reliability/hygiene gaps, all pipeline-safe:

1. **R-MVFM** — microverse failure-memory records only **regressions**, never **plateaus**. `recordFailedApproach`
   fires from exactly one trigger: `if (classification === 'regressed')` (`microverse-runner.ts:3409` →
   `:3417`). A `held` / `no_progress` iteration (worker changed code, metric didn't move) is logged into
   `failure_history` (`:3533`) but **never routed into `failed_approaches`** — the one field the next worker
   reads via `appendFailedApproachesHandoff` (`:2567`). So on the dominant stall shape (plateau), the
   `## Failed Approaches (DO NOT RETRY)` denylist is empty and the next worker can re-propose the same
   ineffective move. Live ground truth: all 4 real-iteration microverse runs show `failed_approaches:0`
   despite `held×5` plateaus. Source: `BUG-REPORT-2026-06-28-microverse-failure-memory-records-regressions-not-plateaus.md`.

2. **Hardcoded-date fixture time-bombs** — a fixture `started_at: <fixed past date>` ages past a real-wall-clock
   threshold and breaks the test (live: `beta6-ga-session-resume`'s `started_at: 2026-06-15` aged past
   `pruneOldSessions`, already fixed via dynamic date). **35 test files** carry hardcoded `started_at:` ISO
   dates; an unknown subset are genuine time-bombs (the date is compared against the REAL current time —
   `pruneOldSessions` age cutoff, recency ranking, future-skew guards). This is a latent gate-flake class that
   fires silently as dates age.

3. **R-OMTD test-subprocess leak** — `pipeline-runner-orphan-mux-teardown.test.js` spawns `mux.js`/`grandchild.js`
   subprocesses and, on a failed assertion, leaves them running (no `afterEach` reap). Leaked subprocesses
   accumulate machine load that flakes later subprocess-heavy tests in the same gate run (R-TFP/R-TSPF class).

---

## Workstreams

### WS-1 — R-MVFM: route plateaus into the failed-approaches denylist

In `microverse-runner.ts`, route a `held` / `no_progress` iteration (the plateau classes — worker produced a
diff but the metric did not improve) into `recordFailedApproach`, in addition to the existing `regressed`
trigger. Reuse the existing `recordFailedApproach` / `failed_approaches` / `appendFailedApproachesHandoff`
machinery — **no new state field, no schema bump, no new handoff path.** Add a **dedupe guard** so a long
plateau does not append a near-identical entry every iteration (bound prompt growth) — e.g. skip if the last
`failed_approaches` entry already describes this iteration's approach/class.

**Acceptance criteria (machine-checkable):**
- `AC-MVFM-1` — A `held` / `no_progress` classification appends a `failed_approaches` entry with a specific
  description (iteration + approach summary), not only `regressed`. Unit test in
  `extension/tests/microverse.test.js` (or `microverse-recovery.test.js`): drive a `no_progress` iteration and
  assert `state.failed_approaches.length` increments and the entry text names the plateau.
- `AC-MVFM-2` — Dedupe guard: N consecutive identical-approach plateaus append at most one (or a bounded,
  non-linear count of) `failed_approaches` entries — `failed_approaches` does NOT grow 1-per-iteration on a long
  stall. Test asserts the bound.
- `AC-MVFM-3` — `regressed` behavior is unchanged (still records, still rolls back). Test asserts the existing
  `regressed` path is untouched.
- `AC-MVFM-4` — Subtract-before-add: `grep` proves no new state field / no schema bump / reuse of
  `recordFailedApproach` + `appendFailedApproachesHandoff`. `audit-subtract-before-add.sh` stays green.
- `AC-MVFM-5` — The worker handoff prompt (`appendFailedApproachesHandoff`) surfaces the plateau entries — the
  next worker's `## Failed Approaches (DO NOT RETRY)` is non-empty on a plateau. Test asserts the handoff text
  includes the plateau entry.

### WS-2 — Audit + fix hardcoded-date fixture time-bombs

**Audit** the 35 test files carrying a hardcoded `started_at:` (or equivalent) ISO date. For each, determine
whether the fixture date is **compared against the real wall-clock** in a way that breaks as the date ages
(`pruneOldSessions` age cutoff, recency/`preferNewerSession` ranking, future-`started_at` skew guards). **Fix
only the genuine time-bombs** — convert their hardcoded date to a dynamic/relative one (e.g. `Date.now() - N`
days as ISO) computed at test time. **Leave deterministic-date fixtures untouched** (tests that pin a date for
reproducible output and never compare it to "now" are correct as-is — do NOT churn them).

**Acceptance criteria:**
- `AC-DATE-1` — Every genuine time-bomb fixture (date vs real-now) is converted to a relative/dynamic date; a
  documented list of audited files records, per file, time-bomb-or-deterministic with a one-line reason.
- `AC-DATE-2` — The full `test:fast` + `test:integration` tiers pass with the fixes (no regression from the date
  changes).
- `AC-DATE-3` — No deterministic-output fixture was needlessly converted (the change set touches only files
  whose date is wall-clock-compared). Reviewer-checkable from the AC-DATE-1 list.

### WS-3 — R-OMTD: afterEach subprocess reap in the orphan-mux teardown test

In `extension/tests/pipeline-runner-orphan-mux-teardown.test.js`, add an `afterEach` (or per-test `finally`)
that reaps every subprocess the test spawned (`mux.js` / `grandchild.js`) — track spawned PIDs and
`process.kill` the subtree on teardown, including the failure path. Reuse the negative-PID group-reap pattern if
the test spawns detached groups.

**Acceptance criteria:**
- `AC-OMTD-1` — After the test file runs (including a forced-failure path), no `mux.js`/`grandchild.js`
  subprocess from this test survives. Test asserts the teardown reaps spawned PIDs.
- `AC-OMTD-2` — `audit-subprocess-heavy-tests.sh` stays green (the test stays serialized/within budget).

---

## Out of scope (explicit)

- **R-MWBG runtime half** (reverted 2026-06-29, de-prioritized P2) — needs a design pass (detached lifecycle must
  preserve `runIteration` invariants for medium tickets); not this bundle.
- **A forward-protection lint for hardcoded future-relative dates** — tempting but new machinery; WS-2 fixes the
  existing time-bombs + documents them. Add the lint only if the class recurs (subtract-before-add).
- **R-DPMC-3 / B-GSUB** (P2 deferred, operator sign-off) · **B-CIINT** (Linux-CI-only) · capability work (codegraph
  v2.1, B-GIMA).

---

## Simplification Review (subtract-before-add)

**WS-1 (R-MVFM):**
1. *Necessary?* Adds one trigger branch + a dedupe guard. Necessary — the denylist is dead on the dominant stall.
2. *Reuse not add?* **Yes — pure reuse.** Re-points the existing `recordFailedApproach` trigger; reuses
   `failed_approaches` + `appendFailedApproachesHandoff`. No new field, no schema bump, no new handoff path.
3. *Guards brittle complexity?* The brittle thing is the single-trigger `=== 'regressed'` gate; the fix
   broadens that gate to the plateau classes rather than adding a parallel memory.
4. *Subtract?* Collapses "two notions of failure" (regressed-recorded vs plateau-unrecorded) into one — the
   denylist now reflects all non-progress, not just regressions.

**WS-2 (date fixtures):**
1. *Necessary?* Converts genuine time-bombs to dynamic dates. Necessary — latent gate-flake.
2. *Reuse not add?* Uses `Date.now()`-relative computation already used by the beta6 fix. No new helper unless 3+
   fixtures share identical relative-date logic (Rule of Three → extract one helper).
3. *Guards brittle complexity?* Removes the brittle hardcoded-date dependency rather than guarding it.
4. *Subtract?* Subtracts a latent failure class; net change is fixture-local. Deterministic fixtures are
   explicitly NOT touched (avoid churn).

**WS-3 (R-OMTD):**
1. *Necessary?* Adds an `afterEach` reap. Necessary — leaked subprocesses flake the gate.
2. *Reuse not add?* Reuses the existing negative-PID group-reap pattern. No new machinery.
3. *Guards brittle complexity?* Fixes the leak at its source (test teardown) rather than raising gate timeouts.
4. *Subtract?* Removes a load-flake source; the gate becomes more deterministic.

---

## Build sequencing & tiers

- **WS-1** `medium` (microverse-runner change + microverse tests). **WS-2** `medium` (35-file audit + targeted
  fixes). **WS-3** `medium` (single test file + reap logic). **All `medium`** so each worker gate runs `test:fast`
  and catches regressions during the build (the B-MWBG lesson). Independent — any order; no wiring ticket.
- **R-PSRB does NOT apply** — clean autonomous `/pickle-pipeline --scope branch`.

## Closer

- Single semver bump at the closer: **PATCH within beta → `v2.0.0-beta.30`** (behavior fix + test hygiene; no
  new flag/command/event/state field/schema change).
- Full local release gate GREEN before tag (the gate command in `CLAUDE.md` → Versioning). **Do NOT
  token-optimize `CLAUDE.md` in this bundle** — it carries test-pinned literal phrases (release-gate-parity,
  codegraph-docs-optin-parity). Commit residuals → bump → `install.sh` → `git push` → `gh release create
  v2.0.0-beta.30`. Ship on the local gate; CI-green is hygiene.
