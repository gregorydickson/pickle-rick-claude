---
title: P1 — szechuan-sauce Session Knowledge Transfer block reads outside the repo tree; codex workers correctly refuse under repo-side AGENTS.md firewalls
status: Draft
filed: 2026-05-17
priority: P1
type: bug-architecture
finding: 46
code: R-SSDF
backend_constraint: codex
related:
  - prds/archive/bundles/p1-bug-fix-bundle-2026-05-08-mega.md  # R-MJCP origin (Finding #14, closed v1.73.0)
  - prds/archive/bundles/p1-closer-ticket-spins-on-r-wsrc-forbidden-acs.md  # R-CTSF (Finding #44, closed v1.75.2)
  - prds/archive/bug-reports/p1-codex-manager-hallucinated-wedge-self-terminate.md  # R-CCPM-1b (Finding #45, filed 2026-05-17 AM)
  - prds/p1-worker-source-state-recursion-contamination.md  # R-WSRC — same defensive class as the AGENTS.md firewall that triggers this
recurrence:
  - "2026-05-17 ~15:09Z — session 2026-05-17-0fca029f, szechuan-sauce iter 1 on loanlight-api LOA-753 deslop. Codex worker refused before doing any work: `The worker protocol requires reading and later updating session files under /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-17-0fca029f, but this repo's firewall explicitly forbids reading or writing anything outside /Users/gregorydickson/loanlight/loanlight-api/ and node_modules/. That conflict is a hard blocker under the 'honest failure beats silent recovery' rule, so I'm stopping rather than improvising around it.` 22m 4s wall, 0 commits, exit_reason=judge_timeout (secondary: measureLlmMetric ETIMEDOUT × 4). AGENTS.md firewall in `loanlight-api/` (mtime 2026-05-15, scoped to `gregory/loa-780-781-extraction-schema-hardening` branch but lingered) was the explicit blocker."
---

<!-- R-CTSF compliant -->

# R-SSDF — szechuan-sauce Session Knowledge Transfer requires reads outside the repo tree; codex firewalls correctly refuse

**Author**: pickle-rick session 2026-05-17
**Project**: pickle-rick-claude
**Repo**: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude`

## Symptom

A codex worker spawned by szechuan-sauce on a repo that ships an `AGENTS.md` worker firewall refuses to start, before producing any artifacts. The worker correctly identifies a hard conflict between two authoritative instruction sources:

1. **szechuan-sauce.md `## Session Knowledge Transfer`** — instructs the worker to read and update `TASK_NOTES.md` in the pickle-rick session directory at `~/.local/share/pickle-rick/sessions/<id>/`. This path lives *outside* any repo tree.
2. **Repo-side `AGENTS.md` worker firewall** — restricts reads/writes to the repo tree (`/Users/gregorydickson/loanlight/loanlight-api/`) and `node_modules/`, and explicitly forbids anything outside, including pickle-rick install paths and session dirs.

The worker prefers the firewall (correct, per its `## 4. Honest failure beats silent recovery` rule) and stops. szechuan-sauce burns the entire iteration budget without making progress.

### Verbatim worker output (session `2026-05-17-0fca029f`, iter 1)

```
OpenAI Codex v0.130.0
workdir: /Users/gregorydickson/loanlight/loanlight-api
model: gpt-5.4
provider: openai
approval: never
sandbox: danger-full-access
session id: 019e367c-0938-7c23-b19f-f00e1f40dbf5

[... worker prompt loaded ...]

codex
The worker protocol requires reading and later updating session files under
`/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-17-0fca029f`,
but this repo's firewall explicitly forbids reading or writing anything outside
`/Users/gregorydickson/loanlight/loanlight-api/` and `node_modules/`. That
conflict is a hard blocker under the "honest failure beats silent recovery"
rule, so I'm stopping rather than improvising around it.

codex
Blocked by an instruction conflict.

The worker protocol for `--resume /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-17-0fca029f`
requires reading and updating session files outside the repo, including
`TASK_NOTES.md`, `prd.md`, `microverse.json`, and the session handoff. This
repo's mandatory firewall says I may read or write only
`/Users/gregorydickson/loanlight/loanlight-api/` and its `node_modules/`, and
it explicitly says to report blockers and stop rather than work around them.

I did not modify code, session state, or any pickle-rick runtime files. If you
want this worker run to proceed, one of these has to change:
 1. Allow access to that specific session directory.
 2. Copy the required session artifacts into the repo tree.
 3. Explicitly waive the repo firewall for this manager/worker turn.

tokens used 12,740
```

The worker is doing exactly what it should. The bug is in our skill template.

### Triggering AGENTS.md firewall (verbatim, `loanlight-api/AGENTS.md`)

Header:
```
# AGENTS.md — TEMPORARY pickle-rick worker firewall

> Scope: This file overlays repo-specific rules for AI coding agents (codex / claude)
> running as pickle-rick Morty workers in this repo. It is temporary for the
> gregory/loa-780-781-extraction-schema-hardening branch — do not commit it; do not
> propagate to other repos.
```

Section 1 (the firewall):
```
### 1. Stay inside the assigned working directory

- The ONLY repo paths you may read or write:
  `/Users/gregorydickson/loanlight/loanlight-api/` (this tree) and its `node_modules/`.
- NEVER read, import, copy from, or write to `/Users/gregorydickson/loanlight/pickle-rick/`
  or any subdirectory.
- NEVER read or edit `~/.claude/pickle-rick/`, `~/.codex/pickle-rick/`,
  `~/.agents/skills/pickle-rick/`, or any other deployed pickle-rick install. If a
  deployed binary appears broken, STOP and report — do not attempt repair.
```

Section 4:
```
### 4. Honest failure beats silent recovery

- If anything blocks you — missing MCP, missing tool, broken bin, unreadable state,
  ambiguous instruction — report the blocker and stop. Do not paper over it.
```

This file was put in place for a legitimate defensive reason (prevent codex workers from reaching into the pickle-rick source tree while iterating on a sensitive branch). It was intended to be temporary but lingered. The point is not that this *specific* file is buggy — it's that the *class* of file is a legitimate, defensible operator pattern, and our skill template is structurally incompatible with it.

## Root cause

In `.claude/commands/szechuan-sauce.md` (lines 11-23), the Worker Mode prompt opens with:

```
## Session Knowledge Transfer

At the start of your work:
1. Read `TASK_NOTES.md` in your session directory if it exists
2. Use the Dead Ends and Key Discoveries sections to avoid repeating failed approaches

Before you finish:
1. Update (or create) `TASK_NOTES.md` in your session directory with these sections:
   - ## Progress — What you accomplished this iteration
   - ## Dead Ends — Approaches that failed and why (be specific)
   - ## Key Discoveries — Important findings about the codebase, constraints, or environment
   - ## Next — What the next iteration should focus on
```

The phrase "your session directory" resolves to an absolute path under `~/.local/share/pickle-rick/sessions/<id>/`. mux-runner / spawn-morty pass that absolute path to the worker via `--resume <SESSION_ROOT>` and via the rendered worker prompt. The worker reads it and immediately recognizes the conflict.

`anatomy-park.md` does NOT have a `## Session Knowledge Transfer` section, and pickle worker prompts (the build phase, which uses skill commands `pickle.md` / `pickle-tmux.md`) don't either. The discriminator is purely textual: only szechuan-sauce.md teaches the worker to consciously read/write a path outside the repo.

Pickle workers also write session artifacts (state.json, conformance, plan_*.md), but those writes happen via `mux-runner.js` / `spawn-morty.js` *running outside the worker's sandbox* — the runner files the artifacts; the worker just emits JSON-on-stdout or writes inside the working tree. The R-SSDF case is different: szechuan's Session Knowledge Transfer is the only place where the worker itself is told to perform file I/O outside its working dir, in the worker prompt text.

### Why anatomy-park doesn't trip on this

Searched `.claude/commands/anatomy-park.md` and confirmed:
- No `Session Knowledge Transfer` section.
- No `TASK_NOTES.md` reference anywhere in the file.
- No instruction to read or write session-directory paths.

Anatomy-park instructs its worker to operate on the diff and within the repo. The runner manages anatomy-park-specific artifacts (`scope.json`, `findings_*.md`) and writes them to the session dir on the worker's behalf, outside the worker prompt's instruction surface.

This means **codex can run anatomy-park inside an AGENTS.md firewall, but cannot run szechuan-sauce** — until R-SSDF lands.

## Cost of the bug

| Metric | Value |
|---|---|
| Session 2026-05-17-0fca029f total wall | 22m 4s |
| Useful work | 0 commits |
| Iterations attempted | 1 (then judge_timeout cascade) |
| Tokens spent (worker side) | 12,740 |
| Tokens spent (judge attempts × 4) | ~unknown; spawnSync ETIMEDOUT before any successful exchange |
| Operator overhead | Full session decode + this PRD; ~45 min |

The structural cost is larger than this one session: **any repo that installs an `AGENTS.md`-style worker firewall cannot run szechuan-sauce with the codex backend.** Worker-side firewalls are becoming a common defensive pattern (the same shape as our own R-WSRC v1.75.0 fix on the runtime side — we, the pickle-rick team, *ship* this pattern to defend our own source tree, so it's hard to argue against operators installing it on theirs).

## Why it matters specifically now

- **Codex backend usage is up.** Recent ships (v1.74.0+) have been increasingly codex-driven. The AGENTS.md author's stated rationale ("temporary firewall for codex / claude Morty workers in this repo") names codex first; that's the model triggering the most repo-side defensive responses.
- **Worker-side firewalls are defensive, not adversarial.** The triggering AGENTS.md says explicitly: *"NEVER read, import, copy from, or write to `/Users/gregorydickson/loanlight/pickle-rick/`"*. The reason is to stop a worker on `loanlight-api` from accidentally clobbering pickle-rick source while iterating on a sibling branch. That's exactly the class of guardrail we'd recommend to other operators. We should not punish them for it.
- **The R-WSRC family (closed v1.75.0) is the symmetric pattern.** We shipped `StateManager` schema-ceiling + mux-runner schema-ahead exit + `PreToolUse` hooks + bash-scanner + test-harness add-dir containment + CLAUDE.md/AGENTS.md/send-to-morty.md forbidden-ops sections specifically so the *runtime* would defend the pickle-rick source tree from contaminated workers. R-SSDF is asking us to make our worker prompts symmetric: the *skill prompt* should also defend the working-dir boundary.
- **Anatomy-park widening risk.** If we ever add Session Knowledge Transfer to anatomy-park (a not-unreasonable feature request — "let anatomy-park learn from prior deslop iterations on the same bundle"), the bug widens. Better to fix the structural problem now than re-encounter it.

## Reproducer

1. `cd <any-fresh-repo>` and write the following to `AGENTS.md`:
   ```
   # Worker firewall
   You may only read or write inside `<absolute path to this repo>/` and `node_modules/`.
   If you cannot do something inside this tree, stop and report.
   ```
2. Drop a tiny PRD into the repo (e.g., copy any `p3-*.md` from pickle-rick-claude) and stage `prd.md`.
3. `/pickle-pipeline prd.md --backend codex --skip-anatomy-park` (or run `/szechuan-sauce <prd>` directly).
4. Watch iter 1: the worker stops with the conflict report shown in Symptom.

Repro time: <5 min including AGENTS.md write. The behavior is deterministic across runs because the conflict is in the static prompt text, not in any race / timing condition.

## Proposed fix (R-SSDF-1..6, ranked bandage → structural)

### R-SSDF-1 — Stage `TASK_NOTES.md` inside the working dir under `.pickle-rick/sessions/<id>/`

Move the worker-visible TASK_NOTES path from `~/.local/share/pickle-rick/sessions/<id>/TASK_NOTES.md` to `<working_dir>/.pickle-rick/sessions/<id>/TASK_NOTES.md`. The runner (`mux-runner.js` + `spawn-morty.js`) keeps writing the canonical copy to the session dir on the operator side, then `cp` / hardlinks it into the working tree before each iteration. After the iteration, copy any worker edits back out.

Update:
- `extension/src/bin/spawn-morty.ts` — pre-iteration stage step (mkdir + copy).
- `extension/src/bin/mux-runner.ts` — post-iteration drain step (copy worker-edited TASK_NOTES out, merge with canonical).
- `.claude/commands/szechuan-sauce.md` — change "your session directory" wording to "`.pickle-rick/sessions/<id>/` inside your working directory".
- `.gitignore` reminder in skill prompt: TASK_NOTES.md staging path should be gitignored by the worker before it commits. (Worker prompt addition; the runner can also `git update-index --skip-worktree` defensively but that has its own footguns.)

**Effort**: ≤1h
**Class**: bandage. Doesn't fix the broader "skill prompts should not reference paths outside the working dir" structural issue, but unblocks the immediate failure mode.

### R-SSDF-2 — Make Session Knowledge Transfer a soft hint with an explicit "skip if blocked" clause

Edit `.claude/commands/szechuan-sauce.md:11-23` to demote the directive from MUST to SHOULD, and add an explicit out:

```
## Session Knowledge Transfer (optional; soft hint)

If you can read `<working_dir>/.pickle-rick/sessions/<id>/TASK_NOTES.md` without
violating any repo-side firewall (AGENTS.md / CLAUDE.md / .codex/policy.toml),
do so to avoid repeating failed approaches. If that file is outside your
permitted read paths, SKIP this step silently — do not stop, do not report,
do not try to negotiate access. The runner has the canonical copy and will
merge what it can after your iteration.

Before you finish, update the staged TASK_NOTES.md if it's writable. If it
isn't, emit a `task_notes_inline:` block as part of your completion_commit
payload and the runner will persist it for you.
```

Update:
- `.claude/commands/szechuan-sauce.md` — section rewrite.
- `extension/src/services/refinement-prompts.ts` — `composeWorkerPromptFromSkill` adds the staged path to env-passed worker variables.
- New test: `extension/tests/services/szechuan-worker-prompt-firewall-safe.test.js` asserts the prompt contains the SKIP IF BLOCKED clause and contains no absolute path outside `<working_dir>/`.

**Effort**: ≤30 min
**Class**: structural framing. Cheapest of the bunch; if R-SSDF-1 lands first, R-SSDF-2 hardens it.

### R-SSDF-3 — At session-setup time, copy session artifacts into a working-dir-local cache

When mux-runner enters szechuan-sauce phase, eagerly stage `TASK_NOTES.md`, `microverse.json`, `prd.md`, and the session handoff into `<working_dir>/.pickle-rick/sessions/<id>/`. The worker reads from there; the runner is responsible for keeping the staging area in sync with the canonical session dir.

Update:
- `extension/src/bin/pipeline-runner.ts` — at szechuan phase entry, run `stageWorkingDirSessionCache(workingDir, sessionRoot)`.
- `extension/src/lib/session-cache-staging.ts` (new) — implements copy + reverse-merge.
- `extension/src/bin/mux-runner.ts` — same staging at iteration start when phase is szechuan-sauce.
- New test: `extension/tests/lib/session-cache-staging.test.js`.

**Effort**: ≤1h
**Class**: structural runtime support for R-SSDF-1. Bundle with it.

### R-SSDF-4 — Detect AGENTS.md-style firewalls at setup and stage session dir accordingly

Before launching the codex worker, mux-runner reads any `AGENTS.md` / `CLAUDE.md` / `.codex/policy.toml` in the working dir and parses for firewall directives ("only read/write inside X", "NEVER read Y"). If a firewall is detected, the staging path is forced to `<working_dir>/.pickle-rick/...` and the worker prompt is rewritten to use that path; if no firewall is detected, the worker can keep the original session-dir path (lower-overhead path, no staging).

Update:
- `extension/src/services/repo-firewall-detector.ts` (new) — parses common firewall headers, returns `{ hasFirewall: bool, allowedPaths: string[] }`.
- `extension/src/bin/mux-runner.ts` — call detector before composing worker prompt; pass result through to `composeWorkerPromptFromSkill`.
- `extension/src/services/refinement-prompts.ts` — branch on `hasFirewall` to select staged-path vs session-dir-path variant.
- New tests: `extension/tests/services/repo-firewall-detector.test.js` (positive cases: the AGENTS.md from the symptom + 3 synthetic variants; negative cases: README.md, no AGENTS.md, AGENTS.md without firewall section).

**Effort**: ≤2h
**Class**: structural detection. Removes the need for operators to flag firewall state manually.

### R-SSDF-5 — Worker-prompt change: stop telling the worker absolute paths; pass session-relative paths via env vars

Today the worker prompt contains literal absolute paths to session artifacts ("Read `TASK_NOTES.md` in your session directory" resolves to a full path at composition time). Replace this with env-var passing:

- The runner exposes `PICKLE_SESSION_CACHE_DIR` and `PICKLE_TASK_NOTES_PATH` as environment variables on the codex spawn.
- The worker prompt says: "If `$PICKLE_TASK_NOTES_PATH` is set and the file at that path is readable in your sandbox, read it; otherwise skip silently."
- The worker never sees a hardcoded absolute path inside or outside the working tree. The runner controls the path. The worker treats it as opaque.

Update:
- `extension/src/services/refinement-prompts.ts` — `composeWorkerPromptFromSkill` switches to env-var-based references.
- `extension/src/bin/spawn-morty.ts` — set the env vars on the spawned codex process.
- `.claude/commands/szechuan-sauce.md` — rewrite Session Knowledge Transfer in env-var language.
- New tests assert prompt has no absolute path outside `<working_dir>/`.

**Effort**: ≤2h
**Class**: full structural fix. Once this lands, R-SSDF-1/R-SSDF-3/R-SSDF-4 staging becomes the implementation detail behind a stable contract.

### R-SSDF-6 — Test coverage: end-to-end szechuan-sauce against a synthetic firewall fixture

Build a tiny fixture repo under `extension/tests/fixtures/repo-with-firewall/` with:
- minimal `package.json`
- `AGENTS.md` containing the same firewall directive shape as the symptom
- a `prd.md` with one trivial deslop task

Wire an integration test that runs `pickle-pipeline` against this fixture with `--backend codex --phases szechuan-sauce --max-iterations 1` and asserts:
- Worker did not exit with the "instruction conflict" message.
- Worker reads `TASK_NOTES.md` from inside `<fixture_dir>/.pickle-rick/sessions/<id>/`, not from `~/.local/share/...`.
- After the iteration, canonical `TASK_NOTES.md` in session dir reflects worker edits.

Update:
- `extension/tests/fixtures/repo-with-firewall/` (new directory with fixture files).
- `extension/tests/integration/szechuan-sauce-firewall.test.js` (new).
- CI: register the test under `npm run test:fast` (must be hermetic — gate codex spawn under a stub if codex CLI absent in CI; real codex spawn under a marker tag like `@integration-codex`).

**Effort**: ≤1h (after R-SSDF-1..5)
**Class**: regression prevention.

## Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| AC-SSDF-01 | `composeWorkerPromptFromSkill('szechuan-sauce', ...)` produces a prompt that does NOT contain any absolute path under `~/.local/share/pickle-rick/sessions/` or `/Users/.../.local/share/pickle-rick/sessions/`. | grep -c on rendered prompt fixture returns 0 for those path prefixes. |
| AC-SSDF-02 | When `<working_dir>/AGENTS.md` contains a firewall directive matching the canonical "only read/write inside X" shape, mux-runner stages session artifacts into `<working_dir>/.pickle-rick/sessions/<id>/` before spawning the worker. | Integration test `szechuan-sauce-firewall.test.js` asserts the staging dir exists and contains a copy of canonical `TASK_NOTES.md`. |
| AC-SSDF-03 | `.claude/commands/szechuan-sauce.md` Session Knowledge Transfer section explicitly permits the worker to SKIP the read/write if the path is not within its permitted sandbox, with no requirement to stop, report, or negotiate. | Skill-prompt grep finds the literal phrase "SKIP this step silently" or equivalent in the file. |
| AC-SSDF-04 | A codex worker spawned by szechuan-sauce on the fixture repo with the AGENTS.md firewall does NOT emit "instruction conflict" / "blocked by an instruction conflict" / equivalent and DOES produce at least one commit on a trivial deslop task. | Integration test captures worker stdout, asserts no "instruction conflict" substring, asserts `git log -1 --since="iteration start"` is non-empty. |
| AC-SSDF-05 | After the worker iteration, any worker edits to staged `TASK_NOTES.md` are reverse-merged into the canonical session-dir copy by the runner. | Integration test writes a sentinel via the worker (mock) and asserts the sentinel appears in `${SESSION_ROOT}/TASK_NOTES.md` after the iteration. |
| AC-SSDF-06 | The repo-firewall detector identifies the canonical AGENTS.md from the symptom (real `loanlight-api/AGENTS.md` shape) as a firewall and extracts the allowed path. | Unit test on detector against fixture file. |
| AC-SSDF-07 | When NO firewall is detected in the working dir, the staging step is skipped and the worker continues to use the session-dir path directly (zero-overhead path). | Unit test against an empty `AGENTS.md` and against absence of `AGENTS.md`; assert no `.pickle-rick/` directory created in working dir. |

## Bundle sizing

**Single-PRD bundle. ≤6 atomic + 4 hardening. ≤4-6h codex.**

Sequencing in the bundle PRD:
- R-SSDF-2 first (≤30 min, lowest blast radius — pure skill-prompt edit).
- R-SSDF-1 + R-SSDF-3 paired (≤2h, staging mechanics).
- R-SSDF-4 (≤2h, detector — depends on R-SSDF-1/3 for the staging behavior).
- R-SSDF-5 (≤2h, structural — depends on all above).
- R-SSDF-6 (≤1h, regression test — depends on R-SSDF-1..5).

Hardening tickets (3-4):
- Lint + typecheck + `npm run test:fast` after each implementation ticket (worker-gate compliant).
- Conformance docs for each R-code (R-CTSF-compliant; closer-owned residuals tagged `[manager]`).
- Documentation: `docs/repo-firewall-compatibility.md` describing the contract for operators who install AGENTS.md firewalls (what the runner does for them, what they need to do).
- Manager-owned closer (version bump, install.sh, MASTER_PLAN edit, gh release) — NOT in worker scope per R-CTSF.

## Out of scope

- **Fixing the LLM judge ETIMEDOUT seen as a secondary symptom on the same session.** The judge backend defaulted to `claude` regardless of `--backend codex`, and `spawnSync claude` ETIMEDOUT × 4 attempts (~5 min each) extended the session by ~20 minutes after the worker had already given up. This is a re-occurrence of the R-MJCP class (Finding #14, closed v1.73.0 — the closure relied on probe-timeout detection; this is a different sub-shape: the probe itself never returns). Defer to a separate R-MJCP successor PRD; reference Finding #14 in its filing. Mentioning it here for completeness, not for fix.
- **Fixing the AGENTS.md author's "temporary firewall lingered past its branch" problem.** That's operator hygiene, not a pickle-rick bug. R-SSDF is correctness-under-firewall; operators install firewalls at their own discretion and we should not assume they're always temporary.
- **Anatomy-park widening.** anatomy-park.md does not currently have Session Knowledge Transfer, so it does NOT have this bug. The fix here should NOT propagate Session Knowledge Transfer to anatomy-park as a side effect. If anatomy-park wants the feature later, it can re-use the R-SSDF-1..5 surface; that's a separate PRD.
- **General "workers must not reference paths outside working_dir" lint rule.** Tempting structural rule, but premature; the failure mode is one specific section in one specific skill prompt. We don't have enough data on how many other places implicitly assume outside-working-dir reads.

## Related findings / bundles

- **Finding #14 R-MJCP** (closed v1.73.0). Microverse judge probe ETIMEDOUT misclassification. Same secondary symptom shape as the judge_timeout we hit here. R-MJCP closed the misclassification, not the underlying spawn-timeout. The 2026-05-17 judge ETIMEDOUT × 4 is the same class re-emerging — file a successor (R-MJCP-2 or new code) separately.
- **Finding #45 R-CCPM-1b** (filed 2026-05-17 AM). Codex manager hallucinates wedge and SIGTERMs healthy mux-runner. Sibling bug: same root class ("operator did a normal thing on codex; the runner couldn't recover gracefully"). Same author (this session), same morning. Both should be in the same "codex backend compatibility hardening" arc.
- **Finding #44 R-CTSF** (closed v1.75.2). Closer-ticket-spin-on-forbidden-ACs. Established the convention that manager-owned residuals (version bump, install.sh, MASTER_PLAN) are tagged `[manager]` and excluded from worker AC evaluation — R-SSDF inherits this; the closer ticket here is purely manager-side.
- **Finding #43 R-WSRC** (closed v1.75.0). Worker source-state recursion contamination. R-SSDF is the symmetric problem: R-WSRC protected pickle-rick source FROM contaminated workers; R-SSDF protects workers FROM their own firewall constraints when our skill prompts require paths the firewall forbids. Same defensive thinking, opposite direction.
- **Working Rule 1** (`MASTER_PLAN.md` § Working Rules). Bugs first. Open P1 ceiling is currently ≤3; this filing pushes to 3 with R-CCPM-1b + R-CSI + R-SSDF. No new feature work until at least one drains.

## Post-validation gaps

To resolve before closing this PRD (the bundle that ships R-SSDF should answer these or file successors):

1. **Should anatomy-park adopt Session Knowledge Transfer?** If yes, the R-SSDF-5 env-var contract MUST be the entry point — do NOT propagate the absolute-path-in-prompt anti-pattern to anatomy-park. File as a P3 feature PRD if requested.
2. **Should pickle worker prompts (`pickle.md` / `pickle-tmux.md`) adopt the same firewall-detect-and-stage pattern preemptively?** They don't currently have the bug because their session-dir writes go through mux-runner / spawn-morty rather than the worker prompt, but the asymmetry is a footgun for future skill authors. Decision: keep monitoring; file as P3 hardening if a third skill (e.g., council-of-ricks) starts to require session-dir reads from the worker side.
3. **Should the repo-firewall detector also parse `.codex/policy.toml` and `~/.claude/CLAUDE.md` for the same directives?** R-SSDF-4 lists this as in-scope but the test fixture is AGENTS.md only. Coverage gap if other firewall surfaces matter to real users.
4. **Should we offer operators a `pickle-rick allow-session-dir` directive they can add to their AGENTS.md to opt-in to the original session-dir path** (skipping staging entirely)? Lower-overhead for the trusted case. Decide before R-SSDF-4 ships.
5. **Does the staging copy interact badly with `.gitignore` / `git status` in the worker's working tree?** If the worker accidentally commits `.pickle-rick/sessions/<id>/TASK_NOTES.md`, the canonical session dir gets a stale copy on next iteration. Verify R-SSDF-1's gitignore-or-skip-worktree solution holds under codex + claude both.
6. **What happens if the working dir is on a read-only filesystem** (uncommon but possible in some CI / sandbox setups)? Staging cannot write; fall back to env-var-with-null and the worker skip path. Confirm R-SSDF-2's "SKIP IF BLOCKED" wording covers this.

## Trap doors

Each ticket's `conformance_*.md` MUST include explicit evidence for:
- R-SSDF-1: `<working_dir>/.pickle-rick/sessions/<id>/TASK_NOTES.md` exists after iteration start; `git status` shows it as untracked or skip-worktree'd (not committed).
- R-SSDF-2: grep on `.claude/commands/szechuan-sauce.md` finds the SKIP IF BLOCKED clause; rendered worker prompt fixture contains the same.
- R-SSDF-3: `stageWorkingDirSessionCache` test fixture shows canonical-side files copied in, worker-side edits reverse-merged out.
- R-SSDF-4: `repo-firewall-detector` unit test passes on the symptom AGENTS.md verbatim; falsy on README.md and no-AGENTS.md fixtures.
- R-SSDF-5: rendered prompt contains `$PICKLE_TASK_NOTES_PATH` literal and no hardcoded absolute path outside `<working_dir>/`.
- R-SSDF-6: integration test on fixture repo asserts no "instruction conflict" substring in worker stdout AND at least one commit produced.
