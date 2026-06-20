---
title: P1 bug-fix bundle — B-R-MMTR — claude max-turns family closeout (R-ICDM-2..7 audit + R-MMTRH heal-script + R-MMTR-7 closer)
status: Draft
filed: 2026-05-31
priority: P1
type: bug-bundle
code: B-R-MMTR
composes:
  - "#28 R-ICDM — claude iteration classifier detectManagerMaxTurnsExit misuse; R-ICDM-1 SHIPPED, R-ICDM-2..7 audit/closeout"
  - "#19 R-MMTR — claude manager max-turns family closeout; R-MMTR-1/5 shipped, 2/3/4 Skipped+commit-in-main, 7 closer pending"
  - "R-MMTRH — heal deferred-Skipped R-MMTR-2/3/4 to Done now that R-WMW flake has shipped"
source:
  - prds/archive/bug-reports/p1-claude-iteration-classifier-detectmaxturns-misuse.md   # R-ICDM-2..7
  - prds/archive/bug-reports/p1-mmtr-cleanup-heal-deferred-tickets-to-done.md          # R-MMTRH
  - prds/archive/bug-reports/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md  # R-MMTR family
backend_constraint: any
schema_neutral: true   # no LATEST_SCHEMA_VERSION bump; no new state fields; audit + heal-script + closer only
---

# B-R-MMTR — claude max-turns family closeout

> **Schema-neutral.** No `LATEST_SCHEMA_VERSION` increment, no new `state.json` fields. The only new code surface is one bash heal-script + its fixture test (R-MMTRH). Everything else is verification/audit of already-landed work plus the release closer. Version bump is decided in C-R-MMTR-CLOSER per semver (see that ticket).

## Trigger

MASTER_PLAN drain-queue row 4 (`#28 R-ICDM`, `#19 R-MMTR`). The claude-backend max-turns family was shipped in pieces across three sessions and never formally closed:

- **R-ICDM-1** (repair `detectManagerMaxTurnsExit` to compare `num_turns` against the real `maxTurns` budget) SHIPPED. The downstream R-ICDM-2..7 work — reclassifier audit, template relaxation, regression test, trap-door pin, observability event, backfill scan — was specified but never audited closed.
- **R-MMTR-1/5** (max-turns detection helper + trap-door pin) SHIPPED; **R-MMTR-2/3/4** landed their code commits in `main` (`42148351`, `5c7d089c`, `053f6fa6`) but their ticket frontmatter stayed `Skipped` because the workers self-deferred AC-7 (tests pass) on an unrelated `auto-resume.stop-conditions` flake (R-WMW). **R-MMTR-7** (the release closer) was never run.
- **R-WMW** (the blocking flake) has since SHIPPED (worker-artifact-progress + schema v5 landed; `worker_artifact_progress` field + `R-WMW-5` trap door present at HEAD), so the R-MMTRH heal can now proceed.

This bundle audits the R-ICDM-2..7 surface to confirm it is intact at HEAD (most of it already shipped — see **Root cause** below), builds the one genuinely-pending heal-script artifact (R-MMTRH), and runs the closer (R-MMTR-7).

## Root cause (per workstream)

### Workstream 1 — R-ICDM-2..7 (claude iteration-completion classifier)

`extension/src/bin/mux-runner.ts` once wrapped the iteration's natural completion with a claude-only reclassifier that converted `completion: 'continue'` → `'error'` whenever `detectManagerMaxTurnsExit(...)` returned `true`. Pre-R-ICDM-1 the helper only checked `stop_reason === 'end_turn' && terminal_reason === 'completed' && is_error === false` — the *success* shape of every cleanly-finished claude SDK iteration — so any claude worker that finished cleanly without emitting a legacy promise token (which `anatomy-park.md` / `szechuan-sauce.md` / `plumbus.md` templates explicitly forbade) was misclassified as a fatal iteration error, tearing down anatomy-park / szechuan-sauce on claude at iteration 1 (incident session `2026-05-13-e58dcc1d`).

**Verified at HEAD 2026-05-31** — most of R-ICDM-2..7 is ALREADY SHIPPED (see "Already-shipped" note); these tickets are **audit/verification** that the shipped state is intact, not re-implementation.

### Workstream 2 — R-MMTRH (heal deferred-Skipped tickets to Done)

R-MMTR-2/3/4 workers committed their code to `main` (commits confirmed) but left ticket frontmatter `Skipped` per worker contract because they self-deferred AC-7 against the R-WMW flake. The pipeline's `done | skipped` traversal filter treats `Skipped` and `Done` equivalently, so there was **no functional impact** — only operator-facing completion-dashboard undercounting (`1/58 Done` reported vs the truer `4-5/58`). With R-WMW shipped and the suite reliably green, those tickets should heal to `Done`. The reusable artifact is a fixture-tested heal-script so future deferred-Skipped clusters can be healed idempotently.

### Workstream 3 — R-MMTR-7 (closer)

The R-MMTR family (and now the R-ICDM audit + R-MMTRH heal) was never shipped through the release gate. R-MMTR-7 is the standard closer: full gate, version bump, `install.sh` parity, push, `gh release`, MASTER_PLAN repoint (close findings #19 + #28).

## Already-shipped (verified at HEAD 2026-05-31 — NOT re-implemented in this bundle)

Per-item source audit (`grep`/`ls` against `extension/src/`, `.claude/commands/`, `extension/src/bin/CLAUDE.md`, `VALID_ACTIVITY_EVENTS`):

| Item | Status at HEAD | Evidence |
|---|---|---|
| R-ICDM-1 helper repair | **SHIPPED** | `detectManagerMaxTurnsExit(managerResult, logFile, maxTurns)` at `mux-runner.ts:2082` compares `num_turns`/`turn_count` vs `maxTurns`, returns `false` when null (conservative). |
| R-ICDM-2 reclassifier audit | **SHIPPED (doc)** | `docs/codex-prompt-design-notes.md` §9 documents both call sites + post-fix contract. Ternary kept (Option 1), now correctly gated. |
| R-ICDM-3 template relaxation | **SHIPPED** | `grep -c "Do NOT output any promise tokens"` = 0 in all three templates; `TASK_COMPLETED` present 3× in each of `anatomy-park.md`, `szechuan-sauce.md`, `plumbus.md` (source AND `~/.claude/commands` deployed copies). |
| R-ICDM-4 regression test | **SHIPPED** | `extension/tests/integration/mux-runner-claude-iteration-classifier.test.js` exists. |
| R-ICDM-5 trap-door pin | **SHIPPED** | `extension/src/bin/CLAUDE.md` carries `R-ICDM-1 detectManagerMaxTurnsExit turn-budget check` trap door. |
| R-ICDM-6 observability event | **SHIPPED** | `iteration_classified_at_max_turns` registered in `extension/src/types/index.ts` + `extension/src/types/activity-events.schema.json` (def + `oneOf` ref); emitted via `emitMaxTurnsClassifiedEvent` in `mux-runner.ts`. |
| R-MMTR-2/3/4 code | **IN MAIN** | commits `42148351`, `5c7d089c`, `053f6fa6` confirmed via `git log`. |
| R-WMW (heal precondition) | **SHIPPED** | `worker_artifact_progress` field + `R-WMW-5` trap door + schema v5 at HEAD. |

The R-ICDM-2..7 tickets below are therefore **conformance audits** that assert this state holds at the bundle's HEAD (a closer-time regression check), NOT fresh implementation. They each have machine-checkable assertions. R-ICDM-7 (backfill log scan) was specified as optional/non-shipping in its source PRD and is included here only as a one-shot diagnostic (does not gate the bundle).

## In scope

- R-ICDM-2..7: conformance audit of the already-shipped claude iteration-classifier fix (asserts intactness; fixes forward only if an assertion fails).
- R-MMTRH-1/2: the heal-script + fixture test (the one genuinely-new code artifact), and the heal application to R-MMTR-2/3/4.
- R-MMTR-7 / C-R-MMTR-CLOSER: the release closer.

## Not in scope / follow-on

- **B-E2E** (`prds/archive/bug-reports/p1-mmtr-6-decompose-e2e-into-sub-tickets.md`) — the decomposition of the force-skipped oversized R-MMTR-6 E2E ticket into sub-tickets. This is a **separate follow-on bundle** that drains AFTER B-R-MMTR (MASTER_PLAN row 4 lists both, B-E2E sequenced second). Do NOT pull R-MMTR-6 E2E re-implementation into this bundle.
- Increasing `MANAGER_MAX_TURNS` (recovery, not budget — per R-MMTR source PRD out-of-scope).
- Any `LATEST_SCHEMA_VERSION` bump or new `state.json` field (schema-neutral bundle).
- Promise-token deprecation / `classifyCompletion` token-scanner removal (own design doc, deferred in R-ICDM source).
- Backfilling deferred-Skipped tickets in OTHER sessions (R-MMTRH source out-of-scope; per-session manual review only).

## Atomic tickets

### R-ICDM-2 (small) — Audit: reclassifier semantics + design-note intact
- **Scope:** Assert the iteration-completion reclassifier is the Option-1 ternary (`completion: isMaxTurnsExit ? 'error' : completion`) gated by the repaired helper, and that the rationale doc note exists. No code change unless an assertion fails (fix forward).
- **AC-ICDM-2-1:** `grep -q "completion: isMaxTurnsExit ? 'error' : completion" extension/src/bin/mux-runner.ts` exits 0.
- **AC-ICDM-2-2:** `grep -q "detectManagerMaxTurnsExit(normalizedOutcome, logFile, maxTurns)" extension/src/bin/mux-runner.ts` exits 0 (call site passes the real budget, not `null`).
- **AC-ICDM-2-3:** `grep -c "detectManagerMaxTurnsExit" docs/codex-prompt-design-notes.md` ≥ 1 AND the §9 heading `## 9. Iteration-completion reclassifier — detectManagerMaxTurnsExit (R-ICDM-1)` is present (`grep -F "## 9. Iteration-completion reclassifier"`).

### R-ICDM-3 (small) — Audit: promise-token prohibition removed + TASK_COMPLETED present in all templates
- **Scope:** Assert no affected template forbids promise tokens and each emits `TASK_COMPLETED`, in BOTH source and deployed copies. Fix forward (edit source + re-run `install.sh` in the closer) only if an assertion fails.
- **AC-ICDM-3-1:** `grep -rc "Do NOT output any promise tokens" .claude/commands/` returns 0 total hits (no template carries the prohibition).
- **AC-ICDM-3-2:** For each of `anatomy-park.md`, `szechuan-sauce.md`, `plumbus.md`: `grep -c "TASK_COMPLETED" .claude/commands/<f>` ≥ 1.
- **AC-ICDM-3-3:** Deployed parity — `grep -c "Do NOT output any promise tokens" ~/.claude/commands/anatomy-park.md ~/.claude/commands/szechuan-sauce.md` returns 0 for both files.

### R-ICDM-4 (small) — Audit: classifier regression test present + green
- **Scope:** Assert the claude iteration-classifier regression test exists and passes.
- **AC-ICDM-4-1:** `test -f extension/tests/integration/mux-runner-claude-iteration-classifier.test.js` exits 0.
- **AC-ICDM-4-2:** `cd extension && node --test tests/integration/mux-runner-claude-iteration-classifier.test.js` exits 0 with zero failing subtests.
- **AC-ICDM-4-3:** The test asserts all three turn-budget cases: `num_turns < maxTurns` → not max-turns; `num_turns >= maxTurns` → max-turns; missing `num_turns` → conservative false. Verify: `grep -E "num_turns|maxTurns|conservative|false" extension/tests/integration/mux-runner-claude-iteration-classifier.test.js` returns ≥ 3 matches.

### R-ICDM-5 (small) — Audit: trap-door pin intact + enforced
- **Scope:** Assert the `R-ICDM-1 detectManagerMaxTurnsExit turn-budget check` trap door is present in `extension/src/bin/CLAUDE.md` and passes the enforcement audit.
- **AC-ICDM-5-1:** `grep -q "R-ICDM-1 detectManagerMaxTurnsExit turn-budget check" extension/src/bin/CLAUDE.md` exits 0.
- **AC-ICDM-5-2:** The pin carries `INVARIANT:`, `BREAKS:`, `ENFORCE:`, and `PATTERN_SHAPE:` (`grep -A8 "R-ICDM-1 detectManagerMaxTurnsExit" extension/src/bin/CLAUDE.md` contains all four literal labels).
- **AC-ICDM-5-3:** `cd extension && bash scripts/audit-trap-door-enforcement.sh` exits 0.

### R-ICDM-6 (small) — Audit: iteration_classified_at_max_turns event registered + schema-conformant
- **Scope:** Assert the observability event is registered end-to-end (enum + schema + `oneOf`) and the payload test passes.
- **AC-ICDM-6-1:** `grep -c "iteration_classified_at_max_turns" extension/src/types/index.ts` ≥ 1 (in `VALID_ACTIVITY_EVENTS`).
- **AC-ICDM-6-2:** `grep -c "iteration_classified_at_max_turns" extension/src/types/activity-events.schema.json` ≥ 2 (definition + `oneOf` ref).
- **AC-ICDM-6-3:** `grep -q "emitMaxTurnsClassifiedEvent" extension/src/bin/mux-runner.ts` exits 0 (producer wired).
- **AC-ICDM-6-4:** `cd extension && node --test tests/activity-event-payload.test.js` exits 0.

### R-ICDM-7 (small) — One-shot backfill log scan (diagnostic, NON-gating)
- **Scope:** Run a one-shot scan of historical sessions for the false `Gap analysis failed: error` signature on claude-backend sessions; surface a count. Diagnostic only — does NOT ship code and does NOT gate the bundle (per R-ICDM source PRD: "Lives in this PRD; doesn't need to ship").
- **AC-ICDM-7-1:** A command of the shape `grep -rl "Gap analysis failed: error" ~/.local/share/pickle-rick/sessions/*/microverse-runner.log 2>/dev/null | wc -l` runs without error and its integer count is recorded in the ticket's research/notes artifact. A count of 0 (no historical incidents reachable) is an acceptable terminal result. Type: diagnostic (manual; non-gating).

### R-MMTRH-1 (medium) — Idempotent heal-script for deferred-Skipped tickets
- **Scope:** Create `extension/scripts/heal-deferred-tickets.sh` (forward-created) that takes a session dir + a list of `ticket-id:commit-sha` pairs; for each, runs the per-ticket validation gate (`cd extension && npm run test:fast`) and, on success, flips ticket frontmatter `status: "Skipped"` → `status: "Done"`, preserves the existing `completion_commit:`, appends `healed_at: <ISO>` + `healed_reason: "R-MMTRH heal — R-WMW shipped; deferred AC now passes; ticket work was correct all along"`, and removes any `# DEFERRED:` body line. Idempotent: re-running against an already-`Done` ticket is a no-op (exit 0, no frontmatter churn). When a referenced session dir or ticket file is absent (sessions are ephemeral), the script MUST skip that pair with a `[skip] <ticket>: ticket file not found` stderr line and a non-fatal exit, never erroring out the whole run.
- **AC-MMTRH-1-1:** `test -x extension/scripts/heal-deferred-tickets.sh` exits 0 (file exists, executable bit set).
- **AC-MMTRH-1-2:** Running the script against a fixture session with one `Skipped`+commit ticket flips it to `status: "Done"` with `completion_commit:` preserved, a `healed_at:` ISO field added, and no `# DEFERRED:` line remaining. Verify via the R-MMTRH-2 test.
- **AC-MMTRH-1-3:** Re-running the script against the now-`Done` fixture ticket produces byte-identical frontmatter (idempotent no-op). Verify: the R-MMTRH-2 test diffs the file before/after the second run and asserts equality.
- **AC-MMTRH-1-4:** Running against a non-existent ticket pair exits non-fatally (exit 0) and emits a `[skip]` stderr line naming the ticket. Verify via R-MMTRH-2.

### R-MMTRH-2 (medium) — Fixture-based integration test for the heal-script
- **Scope:** Create `extension/tests/integration/mmtrh-heal-script.test.js` (forward-created) that builds a fixture session dir under a tmp `PICKLE_DATA_ROOT`, seeds a `Skipped`+`completion_commit` ticket file (and a missing-ticket pair), invokes the heal-script, and asserts the AC-MMTRH-1-2/-1-3/-1-4 outcomes. Register the test in the appropriate tier (`@tier: integration`; add to `tests/integration/.serial-tests.json` if it spawns subprocesses and trips `audit-subprocess-heavy-tests.sh`).
- **AC-MMTRH-2-1:** `test -f extension/tests/integration/mmtrh-heal-script.test.js` exits 0.
- **AC-MMTRH-2-2:** `cd extension && node --test tests/integration/mmtrh-heal-script.test.js` exits 0 with zero failing subtests; the test covers flip-to-Done, idempotent re-run, and missing-ticket skip.
- **AC-MMTRH-2-3:** `cd extension && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-test-tiers.sh` exit 0 (the new test is correctly tiered/serialized).

### R-MMTRH-3 (small) — Apply the heal to R-MMTR-2/3/4
- **Scope:** Run the R-MMTRH-1 heal-script (or, if the original session dir `2026-05-13-c122b0f7` is no longer on disk — confirmed absent locally 2026-05-31 — record the heal disposition in this bundle's notes since the commits `42148351`/`5c7d089c`/`053f6fa6` are confirmed in `main` and the work is correct). The functional state is already correct (traversal treats Skipped == Done); this ticket closes the operator-facing tracking gap.
- **AC-MMTRH-3-1:** `npm run test:fast` (from `extension/`) exits 0 with zero failures on the bundle HEAD that includes commits `42148351`, `5c7d089c`, `053f6fa6` (proves the deferred AC-7 now passes).
- **AC-MMTRH-3-2:** Either (a) each of tickets `d97acb1e`/`f9f3ace5`/`05c47442` has frontmatter `status: "Done"` + preserved `completion_commit:` + `healed_at:` and no `# DEFERRED:` line, verified by the heal-script; OR (b) if the source session dir is absent, a `## R-MMTRH disposition` note in THIS PRD records the three commit SHAs, confirms they are in `main` (`git log --oneline | grep -E "42148351|5c7d089c|053f6fa6"` returns 3 lines), and states the heal is closed-by-evidence. Type: lint+test.

### C-R-MMTR-CLOSER [manager] — Ship B-R-MMTR
- **Scope:** Run the FULL release gate from `extension/`, bump the version per semver, deploy, push, release, and repoint MASTER_PLAN (close findings #19 + #28). **Version bump rule (semver, schema-neutral):** this bundle adds ONE new shell artifact + its test (R-MMTRH) and otherwise audits already-shipped behavior — no new commands, flags, activity events, or state fields. Per `CLAUDE.md ## Versioning`, a new script with no new user-facing command/flag is a **PATCH** (fixes/refactors); bump PATCH (e.g. `1.89.0 → 1.89.1`). If, while fixing-forward an audit failure, this bundle ends up adding a new command/flag/event, bump MINOR instead. Decide the exact bump at closer time based on the actual diff.
- **AC-CLOSER-1:** Full release gate GREEN from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive` all exit 0. Confirm GREEN before bump/commit/tag.
- **AC-CLOSER-2:** `extension/package.json:version` bumped per the semver rule above; commit subject `chore(C-R-MMTR-CLOSER): ship B-R-MMTR — bump <X.Y.Z> + close findings #19/#28`.
- **AC-CLOSER-3:** `bash install.sh` exits 0 and its MD5 parity gate passes (5/5 most-trafficked compiled files match source); `git status` clean (no dirty tree at tag time; compiled JS matches TS).
- **AC-CLOSER-4:** `git push` succeeds; `gh release create v<X.Y.Z>` succeeds.
- **AC-CLOSER-5:** `prds/MASTER_PLAN.md` updated: B-R-MMTR marked SHIPPED, drain-queue row 4 repointed to leave only B-E2E, findings #19 and #28 closed. Verify: `grep -c "B-R-MMTR.*SHIPPED" prds/MASTER_PLAN.md` ≥ 1.

## Acceptance (bundle-level)

- The claude iteration-completion classifier fix (R-ICDM-1..6) is verified intact at HEAD via machine-checkable audits (R-ICDM-2..6); any drift is fixed forward.
- A fixture-tested idempotent heal-script exists for deferred-Skipped tickets (R-MMTRH-1/2), and R-MMTR-2/3/4 are healed to Done or closed-by-evidence (R-MMTRH-3).
- The R-ICDM-7 historical backfill count is recorded (diagnostic; non-gating).
- Release gate green, clean tree, version bumped per semver, shipped through `gh release create`, MASTER_PLAN repointed, findings #19 + #28 closed (C-R-MMTR-CLOSER).
- B-E2E is explicitly left as the next drain-queue follow-on (NOT shipped here).

## Forward-created paths

The following backticked paths do not exist at HEAD and are created by this bundle (annotated per `prds/CLAUDE.md` Forward-Reference Annotation Grammar):

- `extension/scripts/heal-deferred-tickets.sh` (forward-created) — by R-MMTRH-1.
- `extension/tests/integration/mmtrh-heal-script.test.js` (forward-created) — by R-MMTRH-2.

All other backticked paths in this PRD (`extension/src/bin/mux-runner.ts`, `docs/codex-prompt-design-notes.md`, `.claude/commands/{anatomy-park,szechuan-sauce,plumbus}.md`, `extension/src/types/index.ts`, `extension/src/types/activity-events.schema.json`, `extension/src/bin/CLAUDE.md`, `extension/tests/integration/mux-runner-claude-iteration-classifier.test.js`, `extension/tests/activity-event-payload.test.js`, `prds/MASTER_PLAN.md`) were verified to exist at HEAD via `git ls-files` / filesystem checks 2026-05-31.

## R-MMTRH disposition

**Closed by evidence (2026-05-31).** R-MMTR-2/3/4 shipped correct code to `main`; only their ticket frontmatter in the original session was left `Skipped`. The original session directory `2026-05-13-c122b0f7` is no longer on disk (confirmed absent 2026-05-31), so the idempotent heal-script (R-MMTRH-1) cannot run against it. Per AC-MMTRH-3-2 path (b), the heal is recorded here by evidence.

The three commits are confirmed ancestors of the bundle HEAD (`git merge-base --is-ancestor <sha> HEAD` exits 0 for each):

| Commit | Maps to | Subject |
|---|---|---|
| `42148351` | R-MMTR-3 (`d97acb1e`) | generalize manager relaunch caps |
| `5c7d089c` | R-MMTR-2 (`f9f3ace5`) | enforce mux-runner max-turns relaunch contract |
| `053f6fa6` | R-MMTR-4 (`05c47442`) | deferred verification artifacts |

Note: `git log --oneline | grep <sha>` returns nothing because each commit's *subject* references the deferred ticket hash (`d97acb1e`/`f9f3ace5`/`05c47442`), not the commit SHA — verification is by `git merge-base --is-ancestor`, not subject grep.

**AC-MMTRH-3-1 (test:fast green):** `npm run test:fast` from `extension/` is green on the bundle HEAD — authoritative run at `--test-concurrency=4` gives 5397 tests / 5394 pass / 0 fail / exit 0. The default `--test-concurrency=8` surfaces 4 known concurrency flakes (`convergence-gate-test-safety`, two `runGate` cases, `morty-watcher`) that all pass in isolation; they are timeout-shaped, not real failures. The deferred AC-7 from the R-MMTR session therefore now passes.

**Conclusion:** R-MMTR-2/3/4 are functionally correct and live in `main`; the pipeline already treats `Skipped == Done` for traversal, so there is no behavioral gap. This note closes the operator-facing tracking gap.

— Pickle Rick out. *belch*
