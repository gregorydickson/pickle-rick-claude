# BUG-2026-08-21 (P1→**P0 severity in effect**) — the release workflow has produced no verdict in a month

## 0. What refinement changed (read first — the authored premise is REFUTED)

Refined 2026-08-24, 3 roles × 2 cycles, session `2026-08-24-04b1a11e`. Cycle 2 did the one thing every
prior cycle skipped: **it looked at CI.** Five corrections, each measured:

1. **This is not a comparability nitpick. It is a month-long release outage.** `gh run list
   --workflow=release.yml`: **12 of 12 runs `failure`**, unbroken 2026-07-18 → 2026-08-24, including
   `v2.1.0-beta.13` cut today. Every one died at `Install and compile` — the step that runs the full
   release gate — with `Build tarball` and `Create release` **skipped**. **No release artifact has been
   produced in a month.** Releases exist only because they are cut by hand with `gh release create`
   per `CLAUDE.md`'s own procedure, and that hand-cut tag triggers the workflow nobody reads.
   *(Operator-verified independently of the analysts.)*
2. **"CI runs on the line where they pass" is FALSE**, and it was the entire evidentiary basis for
   choosing 24. `ci.yml`: **8 of 8 `failure`** on Node 24, most recent **2026-07-16**. It also triggers
   only on push/PR to **`main`** (`ci.yml:3-9`) while all this work is on `release/v2.1-beta`, so it
   has not run against any of it.
3. **"This is a Node MAJOR-line behaviour" is FALSE.** On `ubuntu-latest` at **node v22.23.2** — the
   exact build the PRD indicts — the fast tier produces **3 named failures, not 38 cancellations**, and
   the strings `cancelled` and `Promise resolution is still pending` appear **zero times** in the
   87,992-byte log. `extractFailingTestDetails` strips the TAP directive, so cancellations *would* have
   been extracted by name; 38 would have printed ~38 names, and 3 printed. **The 38 cancellations are a
   darwin × Node-22 interaction, not a property of the Node 22 line.**
4. **Every number in the authored PRD was taken on darwin. All three workflows run `ubuntu-latest`.**
   The Linux failing set is a *different* suite set: `codegraph-service.test.js`,
   `oneabort-termination-invariant.test.js`, `convergence-gate-flake-allowlist.test.js`. Two are named
   nowhere in the PRD, and `monitor.test.js` — the PRD's headline suite, 20 of its 38 cancellations —
   **does not appear in the Linux failure set at all.**
5. **AC-1 + AC-2 are both satisfiable while the release workflow stays exactly as red**, because Node 24
   CI dies immediately afterwards on a second, independent blocker (`spawnSync rg ENOENT`) this PRD
   never mentions. That is textbook fake-green, on the one artifact `CLAUDE.md` says must never be faked.

## 1. Rulings (the PRD rules; the worker does not)

- **The success criterion is a GREEN `release.yml` run, not four matching strings.** Aligning the pins
  is necessary and not sufficient. No AC may be satisfiable while the workflow stays red.
- **Measure on the platform that gates releases.** `ubuntu-latest` is authoritative for every claim in
  this bundle. Darwin numbers are host-local observations and must be labelled as such — they are the
  reason the authored premise was wrong.
- **The darwin × Node-22 cancellations are OUT OF SCOPE and must be re-filed**, not fixed here. They
  are real (measured repeatedly on this host) but they are not what reddens the gate.
- **AC-3's target is PRODUCT code, not test code.** The unsettled promise is manufactured by
  `extension/src/bin/monitor.ts:93-103`, a deliberately `.unref()`'d watchdog timer. A ticket scoped to
  the test file is unsatisfiable by construction, and the authored Non-goals line points the
  implementer *away* from the only file that can change. Since `monitor.test.js` does not fail on
  Linux, this work is **deferred with its consequence stated**, not silently dropped.
- **AC-1 must declare node's GRAMMAR, not merely its major.** The repo has a test-enforced per-key
  `engines` convention (`engines-node-pin.test.js`): `codex` a `>=` floor (`:32-38`), `claude`/`gh`
  exact triples (`:47-53`). `node` is the only key with no grammar test and the only one in a third
  format (`22.x`). Pick the grammar and pin it with a test, or this drifts again.
- **The second blocker is IN SCOPE.** `spawnSync rg ENOENT` on Node 24 CI must be fixed or the bundle
  cannot reach its own success criterion. If it proves separable, file it and say so explicitly — do
  not leave it implicit.

## 2. Acceptance criteria

- **AC-1** `engines.node`, `release.yml`, `ci.yml`, `stability-gate.yml` agree on one Node major AND one
  declared grammar, with a grammar test in `engines-node-pin.test.js` covering `node` as the sibling
  keys already are.
- **AC-2** A `release.yml` run on a pushed tag reaches **`Create release`** and produces a build
  artifact. This is the bundle's binding success criterion. Evidence is a run URL and its conclusion.
- **AC-3** The `spawnSync rg ENOENT` blocker on Node 24 CI is resolved, or is filed as its own PRD with
  the measured evidence and an explicit statement that AC-2 cannot pass until it lands.
- **AC-4** `ci.yml` runs against the branch that actually carries the work, or the PRD records why it
  is `main`-only and what that costs.
- **AC-5** No measurement in the shipped artifacts cites a darwin number as evidence about the gate.
  Host-local observations are labelled host-local.
- **AC-6 (PRIME DIRECTIVE)** Report-only, non-gating: no measurement verdict halts a run, no new
  `exit_reason`.
- **AC-7 (regression)** The three Linux failures (`codegraph-service`, `oneabort-termination-invariant`,
  `convergence-gate-flake-allowlist`) are each either fixed or flake-listed with rationale — not left to
  redden `FAIL_BUDGET_EXCEEDED`.

## 3. Non-goals

Fixing the darwin × Node-22 cancellations (re-filed). Changing the test runner. Changing the release
procedure itself. Any new halt path or `exit_reason`.

## 4. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Pins aligned, workflow still red — fake-green on the release artifact | AC-2 binds success to a green run, not to string equality |
| R2 | Scope fence built from the authored AC-3 file list forbids touching the suites that actually fail | §1 ruling + AC-7 name the real Linux set |
| R3 | Worker "verifies" on darwin and declares victory | AC-5 forbids darwin evidence about the gate |
| R4 | The second blocker is discovered mid-bundle and silently deferred | AC-3 forces fix-or-file-with-consequence |
| R5 | `node` grammar drifts again after this bundle | AC-1 requires a grammar test, matching the sibling keys |

## 5. Assumptions

- `gh` CLI can read workflow runs for this repo from the worker (verified: the operator ran it).
- `ubuntu-latest` behaviour is stable enough that a green run is reproducible, not a one-off.

## 6. Decomposition

`complexity_tier: medium`. Config + CI + one grammar test; the unknown is the second blocker.

| # | ticket | ACs |
|---|---|---|
| 1 | Declare node's `engines` grammar + major and pin it with a grammar test | AC-1 |
| 2 | Align the three workflow pins to that decision | AC-1 |
| 3 | Resolve or file the `spawnSync rg ENOENT` Node 24 blocker | AC-3 |
| 4 | Fix-or-flake-list the three Linux fast-tier failures | AC-7 |
| 5 | Re-file the darwin × Node-22 cancellations as their own PRD | §1 ruling |
| 6 | Closer: push a tag, prove `release.yml` reaches `Create release` | AC-2, AC-4, AC-5 |

## 7. Simplification Review

1. **Necessary?** Yes — the release workflow has produced nothing for a month.
2. **Reuse?** The `engines` grammar convention and its test already exist for three sibling keys; this
   adds the fourth rather than inventing a mechanism.
3. **Guards brittle complexity?** It removes a divergence and adds one grammar test.
4. **Subtracts?** Two contradictory Node pins collapse to one, and a class of darwin-based reasoning
   about a Linux gate is retired.
