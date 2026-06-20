# PRD: Anatomy-Park Worker Edits Bypass `scope.json` Allowlist (Runtime Edit-Time Gap)

**Status**: Bug PRD (2026-05-08) — runtime scope-enforcement gap. `scope.json:allowed_paths` filters subsystems at *discovery* time but does not gate worker edits at *fix* time. Workers can `git add -u` and commit edits to any path in the repo, even when the operator passed `--scope branch` with a strict allowlist.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**: `prds/archive/bug-reports/anatomy-park-szechuan-monorepo-missed-detection-gap.md` (RC-2) — that PRD addresses *discovery-time* scope flattening (subsystems-as-`packages` on monorepos). This PRD addresses the **edit-time** gap: even when discovery is correctly partitioned by an operator-supplied `scope.json`, the worker is free to edit files outside the allowlist.
**Triggering session**: `2026-05-08-5d60b760` — `/anatomy-park --backend codex --scope branch --scope-base origin/main` against `packages/api/src/lib/appraisal-pipeline/` on the `gregory/1025-appraisal-epic` branch.

---

## What was missed

The session resolved scope correctly at init time:

```
scope.json: 91 allowed_paths, all under packages/api/src/lib/appraisal-pipeline/**
```

Across 14 iterations the codex worker produced 13 fix commits whose diffs stayed strictly inside the allowlist — one commit leaked outside:

| Commit | In-scope edits | Out-of-scope edit |
|---|---|---|
| `fe927181a` (comparison — re_taxes alias drift) | `comparison/CLAUDE.md`, `comparison/__tests__/compute-differences.spec.ts`, `comparison/compute-differences.ts` | `packages/api/src/modules/portal-appraisal/portal-appraisal.service.spec.ts` |

The portal-appraisal test was edited because it asserts on the comparison-output shape that `compute-differences.ts` produces — a downstream consumer test that broke when the producer's behavior changed. Defensible *intent*, but the worker performed the edit silently with no warning, no `<scope-leak>` activity event, and no operator confirmation.

In a stricter `--scope paths:<globs>` invocation (e.g. an operator deliberately scoping to only `comparison/` to land an isolated bug-fix), the same behavior would let the worker rewrite arbitrary callers without a paper trail.

### Historical evidence (sister gap)

The same branch's **prior** anatomy-park run on 2026-04-28 produced 30+ commits with the prefix `anatomy-park: packages — …` touching `bank-statement/`, `portal-feedback/`, `credit/`, `loan-program/`, `URLA/`, etc. That run was scopeless (no `--scope` flag), and the worker invented a `packages` subsystem name to bag findings outside the configured rotation. RC-2 of `anatomy-park-szechuan-monorepo-missed-detection-gap.md` covers the discovery side of that incident; this PRD covers the **edit-time** side that lets the symptom express even when scope IS configured.

---

## Root causes (composed)

### RC-1: `scope.json` is consumed only at discovery and gate-baseline time

`extension/services/scope-resolver.js::filterBySubsystem` filters discovered subsystems against `allowed_paths` once, at session init. After that, the array of subsystem names is the only state that survives into the worker iteration. The worker reads its current subsystem (`anatomy-park.json:current_index`) but never re-consults `scope.json` to validate the diff it's about to commit.

`extension/bin/check-gate.js` accepts `--allowed-paths-file` for the per-iteration baseline check, but the gate runs on **typecheck + lint over the whole project** — its allowlist is used for *failure attribution* (filter failures to in-scope paths), not for **diff containment** (reject a commit whose diff includes out-of-scope paths).

Net effect: there is no place between `worker writes file` and `git commit` that re-asserts `git diff --name-only --staged` ⊆ `scope.json:allowed_paths`.

### RC-2: Worker prompt does not surface the allowlist

The anatomy-park worker prompt (`extension/.claude/commands/anatomy-park.md`) carries the allowed-paths file via the `<!-- scope-hook: discovery-filter -->` marker but does not embed an explicit edit-time directive. The worker template references the scope file for *Phase 2.5 pattern replay* ("re-grep across the active scope when `scope.json` exists"), but there is no symmetric Phase 2 fix-edit constraint such as:

> Phase 2 fix edits MUST stay within `scope.json:allowed_paths`. Before staging, run `git diff --name-only` and reject any path that is not present in `allowed_paths`. Producer→consumer test updates that touch out-of-scope files are RESEARCH FINDINGS, not fix-iteration commits — surface them as separate findings for operator decision.

Without that line, codex (and any model the worker prompt is run against) treats `--scope` as a hint, not a contract.

### RC-3: `git add -u` happens without a pre-stage allowlist check

The worker's commit step (`extension/.claude/commands/anatomy-park.md` Override 4 + Microverse Worker protocol) instructs `git add -u` (tracked files only) and then `git commit -m "anatomy-park: …"`. Neither step validates the staged paths against `scope.json`. A pre-commit hook OR a worker-side preflight (call `extension/bin/check-scope-diff.js` — does not exist today) would catch the leak.

### RC-4: No activity event for "edit outside scope"

`extension/services/activity-logger` has events for `gate_baseline_captured`, `gate_skipped`, `worker_committed`, `subsystem_rotated`, etc. There is no `worker_edit_outside_scope` event. The silent-leak pattern is therefore invisible to `/pickle-status`, `/pickle-metrics`, and post-mortem reads.

---

## Fix

Three changes, each independently shippable.

### F1 — Worker-side `pre-commit-scope-check.js` preflight (resolves the immediate gap)

Source: new `extension/bin/check-scope-diff.js`. Worker template change in `extension/.claude/commands/anatomy-park.md` Phase 2 step 4 (after tests pass, before commit).

Behavior:

```bash
# Called by the worker before `git commit` in Phase 2 / Phase 2.5
node "$EXTENSION_ROOT/extension/bin/check-scope-diff.js" \
  --session-root "$SESSION_ROOT" \
  --staged          # diff against index, not working tree
```

Reads `${SESSION_ROOT}/scope.json`. If `allowed_paths` is empty or absent, exits 0 (no scope set, no enforcement). Otherwise enumerates `git diff --name-only --staged` and, for each path:

1. If the path lies under any `allowed_paths` entry → OK.
2. Else → emit `worker_edit_outside_scope` activity event with `{file, finding_id, subsystem}` and exit non-zero.

The worker prompt instructs: "If `check-scope-diff.js` exits non-zero, do NOT commit. Either (a) un-stage the out-of-scope file via `git restore --staged <file>` and add a research finding to `anatomy-park.json:findings_history` describing the cross-scope dependency, or (b) ask the operator to widen the scope (out-of-scope edit becomes a separate ticket)."

### F2 — Activity event + `/pickle-status` surfacing

Source: `extension/services/activity-logger/event-types.js` + `/pickle-status` skill.

Add `worker_edit_outside_scope` to the canonical event list. Surface in `/pickle-status` under a new "Scope deviations" line:

```
Scope: 91 allowed paths
  Deviations: 1 file in 1 commit (use `pickle session --scope-deviations` to inspect)
```

### F3 — Worker prompt explicit edit-time clause (anatomy-park.md + szechuan-sauce.md)

Source: `extension/.claude/commands/anatomy-park.md` Override 2 (Three-Phase Protocol) Phase 2 + szechuan-sauce.md analogue.

Add the directive quoted in RC-2 above. Specifically, before "5. If any test fails, determine whether…" insert:

```markdown
4.5 **Pre-commit scope check.** Run
    `node "$EXTENSION_ROOT/extension/bin/check-scope-diff.js" --session-root "$SESSION_ROOT" --staged`.
    If it exits non-zero, do NOT commit. The staged diff includes a path
    outside `scope.json:allowed_paths`. Choose one:
    a. **Un-stage the out-of-scope file** (`git restore --staged <file>`),
       record the cross-scope coupling as a new entry in
       `anatomy-park.json:findings_history` with category `cross-scope-coupling`,
       and proceed with the smaller commit.
    b. **Defer the entire fix** if the in-scope edit cannot stand alone; revert,
       increment stall_count, and rotate to next subsystem.
    Do NOT silently widen the scope by committing the out-of-scope file.
```

---

## Acceptance Criteria

### F1
- **AC-APWS-1** `extension/bin/check-scope-diff.js` exists, exits 0 when `scope.json` is absent, exits 0 when staged diff ⊆ `allowed_paths`, exits non-zero with `worker_edit_outside_scope` event when staged diff includes a path outside the allowlist.
- **AC-APWS-2** Regression test `extension/tests/check-scope-diff.test.js` covers four cases: (a) no scope file, (b) staged diff fully in-scope, (c) staged diff partially out-of-scope (one file leaks), (d) staged diff fully out-of-scope.
- **AC-APWS-3** The activity event payload includes `{ working_dir, scope_session_root, allowed_paths_count, leaked_paths: string[] }` so `/pickle-status` can render a deterministic diagnostic.

### F2
- **AC-APWS-4** `worker_edit_outside_scope` is added to `VALID_ACTIVITY_EVENTS`. Count assertion in `extension/tests/activity-event-payload.test.js` bumps by 1.
- **AC-APWS-5** `/pickle-status` reads the most recent session's activity log and prints "Deviations: N files in M commits" when `worker_edit_outside_scope` events exist; prints nothing when zero. Regression in `extension/tests/standup.test.js` (or a new `pickle-status-scope-deviations.test.js`).

### F3
- **AC-APWS-6** `extension/.claude/commands/anatomy-park.md` Phase 2 step 4.5 is present in the source file. `bash install.sh` deploys it to `~/.claude/pickle-rick/.claude/commands/anatomy-park.md`. Trap-door audit count grows by 1.
- **AC-APWS-7** `extension/tests/anatomy-park-scope.test.js` extended with a worker-simulation case: synthesize a fake session with `scope.json`, drop a fake commit with one out-of-scope file, run `check-scope-diff.js`, assert the non-zero exit + activity event.

### Trap doors (to add to `extension/CLAUDE.md` after F1+F3 ship)

```markdown
- `bin/check-scope-diff.js` — INVARIANT: pre-commit gate rejects staged diffs that escape `scope.json:allowed_paths`. BREAKS: silent scope-leak commits like `fe927181a` (2026-05-08 anatomy-park session 5d60b760). ENFORCE: `extension/tests/check-scope-diff.test.js`. PATTERN_SHAPE: worker `git commit` invocation in Phase 2 / Override 4 lacking a `check-scope-diff.js` predecessor.
- `extension/.claude/commands/anatomy-park.md` Phase 2 step 4.5 — INVARIANT: worker MUST run `check-scope-diff.js` before staging fix commits when `scope.json` exists. BREAKS: edit-time scope drift even when discovery is correctly partitioned. ENFORCE: `extension/tests/anatomy-park-scope.test.js` (worker-simulation case). PATTERN_SHAPE: anatomy-park.md Phase 2 ordering — `git commit` MUST follow `check-scope-diff.js` MUST follow tests-pass.
```

---

## Out of scope (this PRD)

- **Discovery-time monorepo subsystem partitioning.** Covered by `prds/archive/bug-reports/anatomy-park-szechuan-monorepo-missed-detection-gap.md` RC-2 + F2.
- **Codex-specific prompt-design issues.** If FM-1..FM-4 from `docs/codex-prompt-design-notes.md` are at play (literalism, scope confusion), document there. F3 of this PRD is sufficient mitigation regardless of model: it makes the contract machine-checkable instead of relying on the worker to interpret a hint.
- **Cross-scope coupling discovery.** When a fix in subsystem A genuinely requires a downstream test update in subsystem B, that's a real signal (not noise). This PRD makes the worker SURFACE such couplings as findings rather than silently committing them. A separate ticket can decide whether to auto-widen scope, prompt the operator, or always defer — that's a policy question, not a gap question.

---

## Triggering-session evidence (preserved for forensics)

- Session root: `/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-08-5d60b760`
- `scope.json` mode `branch`, base `origin/main@1901487d`, head `6a3406f5`, 91 allowed paths under `packages/api/src/lib/appraisal-pipeline/**`
- 14 fix commits, 13 strict in-scope, 1 (`fe927181a`) leaks `packages/api/src/modules/portal-appraisal/portal-appraisal.service.spec.ts`
- Subsystem rotation: `candidate-generators, comparison, rules, schemas, xml`
- Worker backend: `codex-cli 0.128.0`
- Operator stopped the run mid-iteration on a misdiagnosed wider-scope-leak claim, then re-launched after diagnostics confirmed the actual leak was 1 file. Decision retained the 14 commits.

This PRD does NOT recommend reverting `fe927181a`. The downstream test update is correct (the producer's behavior changed and the consumer test had to follow). The PRD targets the **lack of paper trail**, not the edit itself.
