---
title: P2 — Remove the bare `/pickle` non-tmux build loop; extract its load-bearing manager-prompt template; consolidate on `/pickle-tmux` / `/pickle-zellij` / `/pickle-pipeline`; keep `/pickle-refine-prd`
status: Queued (P1 drain row 4 per Finding #77)
filed: 2026-05-18
rescoped: 2026-05-30
priority: P2
type: deprecation-removal
code: R-PNTR
bundle: B-PNTR
related:
  - .claude/commands/pickle.md            # DUAL-PURPOSE: bare /pickle command surface (REMOVE) + manager-prompt template (EXTRACT, do NOT delete blindly)
  - extension/src/bin/mux-runner.ts        # consumer: command_template default + composeManagerPromptFromSkill
  - extension/src/bin/pipeline-runner.ts   # consumer: enterPicklePhase hardcodes command_template='pickle.md'
  - extension/src/bin/jar-runner.ts        # consumer: reads ~/.claude/commands/pickle.md directly
  - extension/src/services/pickle-utils.ts # composeManagerPromptFromSkill (strips Setup + Step-One)
  - .claude/commands/pickle-tmux.md        # survivor
  - .claude/commands/pickle-refine-prd.md  # EXPLICITLY KEPT
---

# R-PNTR — Remove bare `/pickle`; extract its manager-prompt template (re-scoped 2026-05-30)

## Why this was re-scoped (Finding #77 — the original premise was fatal)

The original R-PNTR-1 said **"delete `.claude/commands/pickle.md` (the canonical source)."** A worker did exactly that (`d586b545`) and the next dispatch hit `[FATAL] pickle.md not found in …/templates or …/commands`. `pickle.md` is **two things wearing one name**:

1. **The bare `/pickle` slash-command surface** — the in-session build loop (no true `/clear` between iterations, stop-hook spam). *This is the deprecation target.*
2. **The canonical manager-lifecycle prompt template** read on **every tmux iteration** by the survivors:
   - `mux-runner.ts:2223`/`:4845` — `state.command_template || 'pickle.md'`, resolved templates-dir-first then `~/.claude/commands/`, fed to `composeManagerPromptFromSkill` (`:2281`).
   - `pipeline-runner.ts:1014` (`enterPicklePhase`) — **hardcodes** `s.command_template = 'pickle.md'`.
   - `jar-runner.ts:120`/`:142` — reads `~/.claude/commands/pickle.md` directly.

`composeManagerPromptFromSkill` (`pickle-utils.ts:2817`) calls `stripSetupSection` + `stripStepOneBlock` before use — so the runtime already consumes **only the shared manager-lifecycle body**; the stripped Setup/Step-One blocks *are* the interactive-command surface. The body is load-bearing infra; the Setup/Step-One blocks are the thing to remove.

**Re-scope verdict (operator-confirmed 2026-05-30):** remove the bare `/pickle` command and its non-tmux execution path, but **extract** the manager-lifecycle body into a dedicated infra template `_pickle-manager-prompt.md` in the `extensionRoot/templates/` dir (the dormant templates-dir-first resolver, "hidden from slash command list"), repoint the three consumers + the `command_template` default, add a **schema-neutral** read-time remap so resumed sessions don't FATAL, then delete `pickle.md`. This eliminates the dual-name footgun permanently so the file can never be re-deleted by mistake.

## Symptom (unchanged)

Bare `/pickle` launches the lifecycle INSIDE the parent claude session (in-process `spawn-morty` / `Agent` primitives). No true `/clear` between iterations; the stop-hook fires every parent turn; long epics degrade as context accumulates. Observed 2026-05-18: 100+ consecutive "Pickle Rick Loop Active" stop-hook blocks in one babysitter session. The tmux variants (`/pickle-tmux`, `/pickle-zellij`, `/pickle-pipeline`) spawn detached `claude -p` subprocesses with hard per-iteration isolation and do not exhibit this.

## Survivors (keep) vs targets (remove)

| Surface | Disposition |
|---|---|
| `/pickle-tmux`, `/pickle-zellij`, `/pickle-pipeline` | KEEP — detached, true `/clear` per iteration |
| `/pickle-refine-prd`, `/pickle-jar-open`, `/pickle-retry`, `/pickle-microverse`, `/pickle-status`/`-metrics`/`-standup` | KEEP |
| **bare `/pickle` command + in-session (non-tmux) execution path** | **REMOVE** |
| **`/pickle --teams` (in-session Teams Mode)** | **MIGRATE** → `/pickle-tmux --teams` (Teams Mode under tmux; `morty-phase-*` subagents preserved) |
| **`pickle.md` manager-lifecycle body** | **EXTRACT** → `_pickle-manager-prompt.md` (infra template), then delete `pickle.md` |

## Schema impact

**Schema-neutral — no `LATEST_SCHEMA_VERSION` bump (dodges #74 R-WSWA).** `command_template` is an existing `state.json` field; this bundle only changes its default *value* and adds a read-time value remap (`'pickle.md'` → `'_pickle-manager-prompt.md'`). No new field, no version bump, so it self-deploys cleanly from a clean no-active-pipeline state.

## Atomic ticket scope

### R-PNTR-1 — Extract the manager-lifecycle template (do NOT delete pickle.md yet)
- Create `templates/_pickle-manager-prompt.md` (forward-created) — the source for `extensionRoot/templates/_pickle-manager-prompt.md`, deployed by the existing `install.sh` `$SCRIPT_DIR/templates/ → $EXTENSION_ROOT/templates/` rsync (install.sh:467-468).
- Content = the manager-lifecycle body of the current `pickle.md` (the post-`stripSetupSection`/`stripStepOneBlock` content; the Setup + Step-One blocks are intentionally dropped).
- **Acceptance / trap door (R-PNTR-TEMPLATE-PARITY):** a characterization test asserts `composeManagerPromptFromSkill('_pickle-manager-prompt.md', backend, opts)` produces byte-identical output to `composeManagerPromptFromSkill(<historical pickle.md>, backend, opts)` for both backends — i.e. zero manager-prompt regression.

### R-PNTR-2 — Repoint the three runtime consumers + the default
- `mux-runner.ts` (`:2223`, `:4845`): default fallback `state.command_template || '_pickle-manager-prompt.md'`.
- `pipeline-runner.ts:1014` (`enterPicklePhase`): `s.command_template = '_pickle-manager-prompt.md'` (update the surrounding comment block that says "Always overwrite to 'pickle.md'").
- `jar-runner.ts:120`: resolve via the templates-dir-first path (mirror mux-runner's `extensionRoot/templates` → `~/.claude/commands` resolution) targeting `_pickle-manager-prompt.md`; drop the hardcoded `~/.claude/commands/pickle.md`.
- `setup.ts` (`config.commandTemplate` default + `:1044` write): default `_pickle-manager-prompt.md`.
- **Acceptance:** `grep -rn "'pickle\.md'\|commands/pickle\.md" extension/src` returns only the deprecation tombstone (R-PNTR-5) and the legacy-remap branch (R-PNTR-3).

### R-PNTR-3 — Schema-neutral resume migration
- Read-time value remap: any persisted `state.command_template === 'pickle.md'` resolves as `'_pickle-manager-prompt.md'` (so in-flight sessions resumed after deploy don't FATAL). Put it in the same read path the other consumers share (mux-runner templateName resolution, mirrored in jar-runner), or a `state-manager` read normalization — value-only, **no** `LATEST_SCHEMA_VERSION` bump.
- **Acceptance / trap door (R-PNTR-MIGRATION):** regression test — a `state.json` written with `command_template:'pickle.md'` resolves the new template on read; assert `schema_version` is unchanged (no bump).

### R-PNTR-4 — Remove the bare `/pickle` execution path; migrate `--teams`
- Remove the in-session (non-tmux) build-loop path in `setup.ts` (the historical `tmux_mode:false` branch — pin current lines, the PRD's old `862/1013` have drifted). Non-tmux invocation becomes an explicit hard error with a migration hint.
- Add `## Teams Mode (--teams)` to `pickle-tmux.md`; `--teams` now sets `tmux_mode:true` + `teams_mode:true` jointly. Bare `--teams` without tmux rejected with a migration hint. Verify Agent-harness primitives work from the tmux subprocess context.
- **Acceptance:** `/pickle-tmux --teams` launches Teams Mode in a tmux pane (`morty-phase-*` available); no `/pickle --teams` path remains.

### R-PNTR-5 — Delete pickle.md + deprecation tombstone
- Delete `.claude/commands/pickle.md`; `install.sh` adds/keeps a one-shot `rm -f ~/.claude/commands/pickle.md` (replace the R-PNTR-1-revert guard comment at install.sh:518-519 with the extract-then-delete rationale).
- `pickle-deprecated.ts` (forward-created) — bare-`/pickle` invocation route prints: `/pickle is removed. Use /pickle-tmux <args> for the build loop, /pickle-refine-prd for refinement, /pickle-pipeline for the full pipeline.` and emits a `pickle_command_deprecated` activity event (register in `VALID_ACTIVITY_EVENTS` per the oneOf 5-touchpoint pattern).
- **Acceptance:** `git ls-files .claude/commands/pickle.md` empty; old route exits nonzero with the message + event.

### R-PNTR-6 — Cross-reference sweep
- README, `.claude/commands/*.md` (remove "or use /pickle for interactive mode" fallbacks), `docs/*.md`, `CLAUDE.md`, `persona.md` — migrate bare `/pickle` references to `/pickle-tmux`.
- **Acceptance (revised — exempts the infra template + tombstone):** the conformance grep for bare `/pickle` and `pickle.md` MUST exclude: `_pickle-manager-prompt.md`, the R-PNTR-3 legacy-remap branch, the R-PNTR-5 tombstone, `pickle-*` subcommands, and `MASTER_PLAN-archive.md`.

### R-PNTR-7 — Test migration
- Migrate/remove tests exercising bare `/pickle` or `setup({tmuxMode:false})`.
- Update `mux-runner.output-stall.spec.ts:43` — it writes `templates/pickle.md`; repoint to `_pickle-manager-prompt.md`.
- **Acceptance:** `cd extension && npm run test:fast && npm run test:integration` exits 0, no `/pickle removed` skips.

## Hardening (2)
- **T-HARDEN-PNTR-DOCS** — sweep `prds/MASTER_PLAN.md` (drain-queue row + Finding #77) and any pickle skills outside `commands/`; leave `MASTER_PLAN-archive.md` untouched.
- **T-HARDEN-PNTR-CONFORMANCE** — full release-gate audit; confirm `install.sh` deploys `templates/_pickle-manager-prompt.md` and does NOT regress-redeploy `pickle.md`; the R-PNTR-6 exemption grep is the conformance assertion.

## Closer (1)
- **C-PNTR-CLOSER [manager]** — version PATCH bump, rebuild JS, `bash install.sh` (confirm `pickle.md` removed + `templates/_pickle-manager-prompt.md` present), full release gate, commit, push, `gh release create` (notes: removal + migration guide + the extract rationale), move B-PNTR → Shipped in `prds/MASTER_PLAN.md` and close Finding #77.

## Acceptance criteria

| ID | Criterion | Evidence | Owner |
|---|---|---|---|
| AC-PNTR-01 | Manager-prompt parity: extracted template's composed output == historical `pickle.md` composed output (both backends). | Characterization test. | R-PNTR-1 |
| AC-PNTR-02 | All 3 consumers + setup default read `_pickle-manager-prompt.md`; no live `'pickle.md'`/`commands/pickle.md` except tombstone + remap. | Grep + unit. | R-PNTR-2 |
| AC-PNTR-03 | Resumed session with `command_template:'pickle.md'` resolves the new template; `schema_version` unchanged. | Regression test. | R-PNTR-3 |
| AC-PNTR-04 | Bare `/pickle` + non-tmux path removed; `/pickle-tmux --teams` launches Teams Mode in tmux. | Integration test (3-ticket fixture). | R-PNTR-4 |
| AC-PNTR-05 | `pickle.md` deleted; deprecation route prints message + emits `pickle_command_deprecated`. | `git ls-files` + unit/integration. | R-PNTR-5 |
| AC-PNTR-06 | No live doc references bare `/pickle` (exemptions per R-PNTR-6). | Conformance grep. | R-PNTR-6 |
| AC-PNTR-07 | Test suite exits 0, no `/pickle removed` skips. | `npm run test:fast && test:integration`. | R-PNTR-7 |
| AC-PNTR-08 | Schema-neutral: no `LATEST_SCHEMA_VERSION` bump in the diff. | `git diff` on the schema constant. | T-HARDEN-PNTR-CONFORMANCE |
| AC-PNTR-09 | Bundle ship: version bumped, install.sh idempotent (pickle.md gone, template present), gh release published. | git log + gh release view + `ls` deployed paths. | C-PNTR-CLOSER |

## Trap doors
- **R-PNTR-TEMPLATE-PARITY** (R-PNTR-1) — characterization test pins composed-output equality.
- **R-PNTR-MIGRATION** (R-PNTR-3) — legacy `command_template` remap; schema-neutral assertion.
- **R-PNTR-NO-BARE** (R-PNTR-5/6) — conformance grep: no bare `/pickle` invocation route survives; tombstone present; template path exempted.

## Notes
- **Refinement recommended pre-launch** (3-cycle): the resume-migration + 3-consumer repoint have hidden coupling (`enterPicklePhase` resume semantics, jar-runner resolution parity, the `command_template` default in `setup.ts` config). Decompose with a refinement pass before dispatch.
- **Out of scope:** renaming `/pickle-tmux`→`/pickle`; removing the `tmux_mode` state field; a Zellij Teams variant; `/pickle-refine-prd` (kept).
- **Superseded:** the original "Scope" §1 ("Delete pickle.md") and §5 ("Rewire jar-runner to read pickle-tmux.md") — both replaced by the extract-to-infra-template approach above.
