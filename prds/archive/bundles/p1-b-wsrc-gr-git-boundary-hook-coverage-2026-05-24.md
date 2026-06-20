---
title: P1 — B-WSRC-GR — extend config-protection.ts to block worker `git reset` / `git checkout <ref>` / sibling Git Boundary Rules violations
status: Draft
filed: 2026-05-24
priority: P1
type: bug-bundle
r_code_prefix: R-WSRC-GR
related:
  - prds/MASTER_PLAN.md
  - prds/p1-worker-source-state-recursion-contamination.md
backend_constraint: any
refine: false
unattended: true
remediation_phases_required: ["citadel"]
---

# PRD — B-WSRC-GR — Git Boundary Rules hook coverage

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Why this bundle

R-WSRC-GR fired **5 times in 24 hours** during B-FRA and B-APWS runs (MASTER_PLAN Finding #72). Every B-APWS implementation ticket triggered a worker `git reset` violation; the runner self-recovered each via path-scoped `git restore --source <dropped-sha>` from reflog, but each recovery cost ~1 iteration of wall-clock and the latent risk that gc/reflog-expiry would have made the dropped commit unrecoverable.

| Date | Bundle | Ticket | Dropped commit | Recovery commit |
|---|---|---|---|---|
| 2026-05-24 | B-FRA | `76605b8f` (R-FRA-1) | `f9c553f6` (R-FRA-6) | `36ae2f76` |
| 2026-05-24 | B-FRA | `2d3b7924` (R-FRA-4) | (prds/CLAUDE.md changes) | `63b9c346` |
| 2026-05-24 | B-APWS | `27aedb81` (R-APWS-8) | `b39913f4` | `45223a06` |
| 2026-05-24 | B-APWS | `0fee5b66` (R-APWS-9) | `98b7cf2d` | `e80eaed5` |
| 2026-05-24 | B-APWS | `b5846f64` (R-APWS-10) | `ff97f1ab` + `5c40cc30` (ledger) | `2aa079c2` |

The pattern is consistent: workers issue `git reset` (typically `git reset --hard <ref>` or `git reset HEAD~1`) believing they're cleaning up scratch state, but the runtime treats this as a Git Boundary Rules violation. The Git Boundary Rules are PROSE in `/pickle-tmux` skill prompt — workers (LLM subagents) may follow them or may not.

This bundle closes the gap by extending the existing `config-protection.ts` PreToolUse hook to block prohibited git operations at the hook layer, the same way `bash install.sh` is already blocked.

## Architectural alignment

Existing pattern (per `extension/src/hooks/handlers/config-protection.ts:374-501`): `bash install.sh` is detected as the EXECUTABLE token via `parseFirstShellWord` + basename check, then blocked with `block('R-WSRC: ...')` plus a documented `state.flags.allow_install_sh_reason` operator override.

This bundle applies the same pattern to the Git Boundary Rules PROHIBITED commands enumerated in `.claude/commands/pickle-tmux.md` (and `pickle.md`):

- `git checkout <ref>` (branch/HEAD mutation; NOT `git checkout -- <path>` which is allowed via `git restore --staged --worktree <path>`)
- `git switch`
- `git reset` (any flavor: `--hard`, `--soft`, `--mixed`, bare `git reset <ref>`)
- `git stash` / `git stash push`
- `git rebase`
- `git commit --amend`
- `git pull`
- `git push`
- `git fetch --prune`

The block must be skippable via a documented operator override flag per the existing pattern, but the override should be NARROWLY SCOPED (e.g. `state.flags.allow_git_reset_reason` for the specific `git reset` case, not a blanket "allow all forbidden git" flag).

## Bundle thesis

> "Prose in the worker prompt has failed five times in 24 hours. Runtime hook enforcement is the load-bearing layer. This bundle extends config-protection.ts to fail-closed on Git Boundary Rules violations the same way it already fails-closed on `bash install.sh`."

## Bundle-level acceptance criteria

- [ ] **AC-WSRC-GR-01** — `extension/src/hooks/handlers/config-protection.ts` exports a new detection function (or extends an existing one) that matches `git reset` / `git checkout <ref>` / `git switch` / `git stash` / `git rebase` / `git commit --amend` / `git pull` / `git push` / `git fetch --prune` as the EXECUTABLE token, with the same robustness as `parseFirstShellWord` already provides for `install.sh` (handles `bash -c`, env vars, quoted args, etc.). `git checkout -- <path>` (path-scoped restore) is NOT blocked.
- [ ] **AC-WSRC-GR-02** — When matched in a worker subprocess context, the hook returns `{"decision": "block"}` with a message referencing `R-WSRC-GR` and naming the specific prohibited verb. The message includes the operator override flag (e.g. `state.flags.allow_git_reset_reason`) for the matched verb.
- [ ] **AC-WSRC-GR-03** — Manager / operator invocations are NOT blocked (per existing pattern: only worker subprocesses see the block; manager spawns inherit `PICKLE_REFINEMENT_LOCK` style env discrimination). Look at how `bash install.sh` distinguishes manager vs worker — apply the same gate.
- [ ] **AC-WSRC-GR-04** — Regression test `extension/tests/hooks/config-protection-git-boundary.test.js`: for each of the 9 prohibited verbs above, synthesize a worker-context PreToolUse event with the verb in `tool_input.command` and assert the hook returns `{decision: 'block'}` with a `R-WSRC-GR` message; for `git checkout -- <path>` and other ALLOWED variants (e.g. `git add`, `git commit`, `git restore <path>`, `git restore --source <ref> --staged --worktree <path>`), assert the hook returns `{decision: 'approve'}` or no decision.
- [ ] **AC-WSRC-GR-05** — Operator override path: synthesize a worker-context `git reset --hard HEAD~1` event with `state.flags.allow_git_reset_reason = "<reason>"`; assert the hook returns `approve` (or no block decision) and emits a `worker_git_reset_bypass` activity event with the reason string.
- [ ] **AC-WSRC-GR-06** — Trap door added to `extension/CLAUDE.md` under `## Trap Doors` pinning the new detection function, ENFORCE pointing at the new test, PATTERN_SHAPE anchoring on `parseFirstShellWord` + the verb match. `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0.
- [ ] **AC-WSRC-GR-07** — `.claude/commands/pickle-tmux.md` and `.claude/commands/pickle.md` Git Boundary Rules block updated to mention the runtime hook (currently it's all prose); add a one-line note: "Enforced at runtime by `config-protection.ts` (R-WSRC-GR trap door); attempting a prohibited verb returns `{decision: 'block'}`."
- [ ] **AC-WSRC-GR-08** — Closer commit body includes the outcome line `Closed: MASTER_PLAN #72 R-WSRC-GR via config-protection.ts hook extension + extension/tests/hooks/config-protection-git-boundary.test.js`.

## Trap-door touchpoints

### TOUCHES (must stay green)

- `src/hooks/handlers/config-protection.ts` — existing R-PIPE-3 / R-WSRC `bash install.sh` block at `:422` and `:501`. New verb-detection MUST coexist; do not break the install.sh detection.
- `src/services/state-manager.ts` (R-WSRC-1) — schema-ceiling. Not touched directly, but the override flag plumbing must use `StateManager.read()` to avoid orphan-tmp issues.

### ADDS

- `src/hooks/handlers/config-protection.ts` — INVARIANT: `detectProhibitedGitVerb(command)` returns `{verb, basename}` when the EXECUTABLE token is `git` AND the first non-flag argument is one of the prohibited verbs (case-insensitive); returns null otherwise. The hook calls `block('R-WSRC-GR: `git <verb>` is FORBIDDEN ...')` when the detection fires AND there's no documented override flag. BREAKS: removing the detection re-opens the R-WSRC-GR class; matching `git checkout -- <path>` (path-scoped restore) as prohibited would break the runner's own recovery path (`36ae2f76`/`63b9c346`/`45223a06`/`e80eaed5`/`2aa079c2` all use `git restore --source` which is the documented allowed escape hatch). ENFORCE: `extension/tests/hooks/config-protection-git-boundary.test.js`. PATTERN_SHAPE: `parseFirstShellWord` returning `git` AND second token matching one of the 9 verbs.

## Ticket sizing (~2 atomic tickets)

| Code | Effort | Files | ACs |
|---|---|---|---|
| **R-WSRC-GR-1** | M (~30min) | `extension/src/hooks/handlers/config-protection.ts` + new test file | AC-WSRC-GR-01..05 |
| **R-WSRC-GR-2-CLOSER** | S (~20min) | `extension/CLAUDE.md` (trap door), `.claude/commands/pickle-tmux.md` + `.claude/commands/pickle.md` (docs), `prds/MASTER_PLAN.md` (close #72), version bump + install.sh + tag | AC-WSRC-GR-06..08 |

## Pre-flight checklist

1. Working tree clean. HEAD on `main`. No active pipeline.
2. R-PIPE-3 / R-WSRC install.sh block (the existing pattern this bundle replicates) is green: `node --test extension/tests/hooks/config-protection.test.js` exits 0 (or whatever the existing test is).
3. The Git Boundary Rules prose in `.claude/commands/pickle-tmux.md` and `.claude/commands/pickle.md` is the source of truth for the prohibited verbs list. Verify the verb list in code matches both prompts.

## Risk register

- **R1**: A future legitimate use case requires a prohibited verb (e.g. operator-driven cleanup script). Mitigation: each verb gets its own override flag, NOT a blanket "allow all" flag. Operator MUST set the specific flag for the specific verb with a documented reason.
- **R2**: The hook decision logic is shared with `bash install.sh` blocking. Care must be taken not to break the existing install.sh detection. Mitigation: keep the new `detectProhibitedGitVerb` as a SIBLING function; both `install.sh` detection and the new verb detection fire from the same entry point but via separate detection functions.
- **R3**: Worker prompt updates (AC-WSRC-GR-07) must NOT remove the prose Git Boundary Rules block — augment, don't replace. Workers without context of the hook may still rely on the prose at read time.

## Closer behavior (R-WSRC-GR-2-CLOSER)

- Version bump: patch (e.g., `1.79.1 → 1.79.2`). New behavior is fail-closed enforcement of a documented contract — no operator-visible API change beyond a stricter error surface.
- Release gate: full canonical from `extension/`.
- Deploy: `bash install.sh`; verify md5-parity for compiled mirrors.
- MASTER_PLAN bookkeeping: close Finding #72 R-WSRC-GR with closure commit SHA; remove "fired 5x in 24h" promotion notice.
- Closer commit body: `Closed: MASTER_PLAN #72 R-WSRC-GR via config-protection.ts hook extension + extension/tests/hooks/config-protection-git-boundary.test.js`.

## What this bundle does NOT do

- Does NOT remove or weaken the existing `bash install.sh` block. The new detection is a SIBLING, not a replacement.
- Does NOT auto-recover from a blocked verb. The block is fail-closed; the worker MUST emit a different action (use `git restore --source <ref> --staged --worktree <paths>` per the documented allowed list).
- Does NOT change the prose Git Boundary Rules in `/pickle-tmux` / `/pickle` — augments with a one-line "Enforced at runtime by ..." note but the prose enumeration stays.
- Does NOT extend coverage to other shells (e.g., `fish`, `csh`). The detection runs on the bash command string parsed by `parseFirstShellWord`; other shells inherit whatever that function returns.

## Triggering session

To be assigned at launch via `/pickle-tmux prds/archive/bundles/p1-b-wsrc-gr-git-boundary-hook-coverage-2026-05-24.md`. Expected duration: ~30-60 min (2 small tickets).
