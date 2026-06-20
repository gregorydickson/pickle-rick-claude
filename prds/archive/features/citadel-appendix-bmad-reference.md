# Citadel Appendix — BMAD-inspired hardening (non-conformance)

> **Companion to**: `prds/citadel.md`. Split out 2026-05-01 to keep the parent PRD lean for coding-agent context. AC IDs in this file are authoritative for the appendix scope and do not collide with `AC-CIT-NN` in the parent.
>
> **Status**: T04-T27 SHIPPED via v1.62.x (see `prds/citadel.md` §Post-Validation Gaps for residual spec gaps). Section retained as the canonical reference for BMAD ACs and risk-register IDs cited from elsewhere in the codebase.

> **Provenance**: Absorbed verbatim from `prds/bmad-inspired-hardening.md` (deleted 2026-04-29) — refined 2026-04-26, post 3-cycle 3-analyst refinement. Source: code-level deep dive on `bmad-code-org/BMAD-METHOD@v6.4.0`. These capabilities are independent of the post-implementation conformance audit; they harden the engineering loop in other dimensions (pre-impl alignment gate, persistent project context, phase specialization, mid-execution adaptation, multi-agent debate, codex format pin, schema migration, hang guards, behavioral testing). The conformance overlap from BMAD's P0 (AC machinability + contract resolution) was folded into core task **T17** in `citadel.md`; everything else lives here.
>
> AC IDs from this appendix retain their `P0.N` / `P1.N` / `P2.N` / `P3.N` / `P4.N` / `R##` / `T0##` numbering — they do NOT collide with `AC-CIT-NN` and remain authoritative for the Appendix scope.

### Appendix Prerequisites *(refined: risk C3 R28)*

This section inherits a known gap from `prds/archive/bug-reports/codex-classifier-prompt-leak.md`: codex output format drift can silently re-expose prompt-leak. **In-scope mitigation chosen**: P0 gate adds session-boot codex-version smoke check (P0.10 below). Hard-prerequisite alternative (`prds/codex-format-pin-smoke.md`) deferred to follow-up.

### Appendix Problem

A code-level investigation of BMAD-METHOD v6.4 surfaced five capabilities Pickle Rick is missing. They sit on three different points of the lifecycle: upstream of execution, structural at execution boundaries, and adaptive during execution.

**Concrete pain we feel today:**

1. **Decisions converge before they're debated.** When PRD drafting hits a real fork, one Morty's prior wins by default. We have no primitive for genuinely-independent multi-agent debate at decision points.
2. **No structural gate between refinement and tmux launch.** `/pickle-refine-prd --run` hands the manifest to `mux-runner.js` and goes. If refinement produced misaligned tickets, Morty workers eat the whole epic before we notice.
3. **Every fresh context re-discovers the codebase.** Context clearing is our signature move. The cost: every iteration re-runs grep/read to figure out what library is used, where auth lives. We pay re-discovery tax forever.
4. **One Morty wears every hat.** Researcher-Morty and Implementer-Morty are the same prompt with phase instructions slapped on top. BMAD's evidence: prompt diversity from genuinely distinct agent priors changes what gets found.
5. **Long runs have no resilience to mid-execution discovery.** When ticket 12 of 25 reveals tickets 13–25 are wrong, options are: push through, circuit breaker stops, or manual restart.

**What changed since the prior draft (v1.54.x → v1.55.0):**

Two parallel workstreams shipped that this section must ride on:

- **`--teams` agent-teams mode (v1.55.0, SHA `a4662df`)** introduces harness-native subagent spawning via `Agent` tool with `subagent_type`, `team_name`, and `TaskUpdate` completion semantics. `--teams` is **claude-backend-only by hard guard**, re-checked across `--resume`. *(refined: codebase C3 — `Agent`/`TeamCreate` are orchestrator-only tools, not Node-callable; bin scripts MUST be brief-prep only, skill prompts drive spawning)*
- **Codex hardening chain (6 commits, `ba8744d` → `4b1f784`)** establishes canonical `PROMISE_TOKENS`, codex-aware `extractAssistantContent`, refinement/judge isolation via `PICKLE_REFINEMENT_LOCK=1`, and `buildJudgeInvocation()` for read-only sandboxes.

**Implication**: Pickle Rick now has two coexisting spawning paths (subprocess via `spawn-morty.ts`/`buildWorkerInvocation`, and Agent-tool via `pickle.md` Phase 3.B brief). New skills must declare which path(s) they use.

### Appendix Goal

Land five capabilities that rewire the lifecycle:

```
                                           ┌─→ /pickle-debate at decision forks (P4)
PRD ───────────────────────────────────────┤
                                           └─→ /pickle-refine-prd
                                                     ↓
                                            /pickle-readiness (GATE) (P0) ← also re-runs on tickets_version bump
                                                     ↓
                                            /pickle-archaeology (once, persistent) (P1)
                                                     ↓
                                  ┌─────────────────────────────────────┐
                                  │ Two execution paths:                │
                                  │  • teams: orchestrator dispatches   │
                                  │    subagent_type per phase via      │  (P2)
                                  │    Agent tool                       │
                                  │  • legacy: spawn-morty.ts injects   │
                                  │    persona block per phase          │  (P2)
                                  └─────────────────────────────────────┘
                                                     ↓
                                  /pickle-correct-course on discovery (P3)
                                  *P4 also invokable mid-loop and at any stage; on codex backend, defaults to --solo with banner.*
```

**Non-goal:** porting BMAD's runtime model. Pickle Rick keeps its runtime moat.

### Appendix Compatibility with `--teams` Mode *(refined: requirements C2/C3)*

| Skill | Subprocess (codex+claude) | Agent-tool (claude-only) | Notes |
|---|:---:|:---:|---|
| P0 `/pickle-readiness` | n/a — pure structural | n/a — pure structural | No LLM call. Backend-agnostic. |
| P1 `/pickle-archaeology` | yes | yes | Dual-path injection: preamble in `spawn-morty.ts`, brief block in `pickle.md` Phase 3.B. |
| P2 phase personas | yes (persona injection) | yes (`subagent_type` dispatch) | Six agent-md files single source of truth. |
| P3 `/pickle-correct-course` | yes | yes | Uses `buildJudgeInvocation()` (read-only sandbox). |
| P4 `/pickle-debate` | `--solo` (auto on codex) | **primary path** | Real parallel subagents are the architectural point. Codex auto-promoted to `--solo` per CUJ-7. |

### Appendix Configuration Reference *(refined: requirements C3 P0 #1)*

Every user-facing knob lives in exactly one of three surfaces. Anything not in this table is out-of-spec.

#### CLI flags

| Skill | Flag | Type | Default | Description |
|---|---|---|---|---|
| `/pickle-readiness` | `--skip-readiness "<reason>"` | string ≤200 chars | (none) | Bypass gate; reason required, logged |
| `/pickle-readiness` | `--repo-root <path>` (repeatable) | path | `process.cwd()` | Multi-repo workspace targeting |
| `/pickle-readiness` | `--history [--last N]` | int | 10 | Show readiness cycle history |
| `/pickle-archaeology` | `--refresh` | bool | false | Force re-archaeology |
| `/pickle-archaeology` | `--no-archaeology` | bool | false | Disable injection for session |
| `/pickle-archaeology` | `--project-type <category>` | enum | (auto) | Override classifier |
| `/pickle-correct-course` | `--auto-apply` | bool | false | Skip approval prompt |
| `/pickle-correct-course` | `--force` | bool | false | Override low-confidence gate (advisory only; structural predicates non-overridable) |
| `/pickle-correct-course` | `--dry-run` | bool | false | Emit proposal without apply |
| `/pickle-correct-course` | `--recover-from-ledger` | bool | false | Replay-reverse partial apply |
| `/pickle-correct-course` | `--recover --force` | bool | false | Forward-replay partial apply |
| `/pickle-debate` | `--solo` | bool | (auto on codex) | Sequential single-context |
| `/pickle-debate` | `--strict-teams` | bool | false | Disable codex auto-promote (persisted in `state.json.flags.strict_teams`) |
| `/pickle-debate` | `--continue [--personas <subset>]` | bool/csv | (off) | Continue prior debate; round-N fences against `tickets_version` snapshot |
| `/pickle-debate` | `--n <count>` | int 2..6 | 4 | Number of personas |
| `/pickle-debate` | `--personas <csv>` | csv | r,a,i,s | Persona selection |
| `/pickle-debate` | `--accept-stale` | bool | false | Round-N override after `tickets_version` change |

#### Environment variables

| Variable | Type | Default | Effect |
|---|---|---|---|
| `PICKLE_PHASE_PERSONAS` | `on\|off` | `off` (until P2.7 baseline checked in) | P2 dispatcher kill-switch |
| `PICKLE_ARCHAEOLOGY_AUTO_REFRESH` | `on\|off` | `on` | P1.6 auto-trigger kill-switch |
| `BEHAVIORAL` | `0\|1` | `0` | Gate behavioral tests |
| `CI` | `0\|1` | `0` | Suppress confirmation prompts; strict budget |

#### Settings (`~/.claude/pickle-rick/pickle_settings.json:bmad_hardening`)

| Key | Type | Default | Used by |
|---|---|---|---|
| `archaeology_refresh_threshold_pct` | int 0-100 | 10 | P1.6 |
| `debate_max_rounds` | int 1-10 | 5 | P4.7 |
| `debate_codex_solo_max_rounds` | int 1-5 | 2 | P4 R26 |
| `debate_min_rounds_confirm` | int 1-10 | 3 | P4.7 |
| `readiness_skip_reasons_max_len` | int | 200 | P0.6 |
| `readiness_max_recycle_cycles` | int | 3 | P0 R33 |
| `phase_personas_enabled` | bool | false | P2 dispatcher |
| `phase_personas.model_override` | object<phase, "sonnet"\|"opus"\|"haiku"> | `{}` | P2 R31 |
| `behavioral_test_max_usd_per_test` | float | 0.50 | Behavioral framework |
| `behavioral_test_max_wall_s` | int | 120 | Behavioral framework |
| `calibration.drift_threshold_pct` | int | 5 | R22 |

#### Discoverability surface

- `/help-pickle` lists all skills + their primary flags.
- `/pickle-status --config` prints the resolved configuration table for the current session (CLI args + env + settings, with provenance).
- `/pickle-readiness --history` shows readiness cycle log.
- `PRD_GUIDE.md` "Configuration Reference" section mirrors this table.

### Appendix Flag Interaction Matrix *(refined: risk C3)*

| PICKLE_PHASE_PERSONAS | PICKLE_REFINEMENT_LOCK | strict_teams | --auto-apply | --skip-readiness | Status |
|---|---|---|---|---|---|
| off | * | * | * | * | Default v1 ship; matches v1.55.0 |
| on | 0 | false | false | false | "Full feature" mode; behavioral baseline must exist |
| on | 1 | * | * | * | Illegal: refinement-lock implies pre-implementation; rejected at session boot |
| on | 0 | true | * | * | Codex sessions explicitly fail per R16/R27 |
| on | 0 | * | true | true | Logged WARN; structural predicates of R5 still must pass |
| off | * | * | true | * | Auto-correct works without phase-personas |

`tests/flag-interaction-matrix.test.js` enumerates every legal combo. Untested combos default-fail.

### Appendix Schema Migration (v2 → v3) *(refined: codebase C3 P1 #11)*

`STATE_MANAGER_DEFAULTS.schemaVersion` bumps from 2 to 3. New optional fields, default-emitted at session boot:

| Field | Type | Default | Source |
|---|---|---|---|
| `archaeology` | `{ project_context_path: string, last_run_iso: string, file_count: number, project_type: string } \| null` | `null` | P1 |
| `tickets_version` | `number` (monotonic counter, bumped under transaction lock on ticket-tree mutations) | `0` | R13 |
| `last_course_correction` | `{ proposal_path, applied_iso, restart_ticket_id \| null, before_count, after_count } \| null` | `null` | P3 |
| `phase_personas_active` | `boolean` (controlled by `PICKLE_PHASE_PERSONAS`) | `false` | P2 |
| `flags` | `{ strict_teams?: boolean, [key: string]: unknown }` | `{}` | R27 |
| `readiness.cycle_history` | `Array<{cycle, status, suggested_analyst, user_action, timestamp}>` | `[]` | P0 |
| `codex_version_seen` | `string \| null` | `null` | R28 |

`tests/state-manager.test.js` MUST round-trip v1→v2→v3 migrations. State-manager `transaction()` MUST detect schema-version mismatch on read-after-write; refuse write if on-disk version > cached version; throw `SchemaVersionMismatchError`; mux-runner aborts iteration on catch *(refined: risk C3 R32)*.

### Appendix Hang Guards *(refined: codebase C3 P0 #8)*

Every external-process spawn introduced by this section passes an explicit timeout option. Mirrors `extension/CLAUDE.md` trap-door enumeration (council-publish gh, scope-resolver rg/grep, plumbus bun, pickle-utils osascript) — the four new bins constitute the **fifth silent-hang class**.

| Const | Default | Used by |
|---|---|---|
| `READINESS_GREP_TIMEOUT_MS` | `30_000` | P0 contract-resolution via `scope-resolver.computeOneHop()` |
| `ARCHAEOLOGY_WORKER_TIMEOUT_S` | `600` | P1 worker spawn via `buildWorkerInvocation()` |
| `CORRECTOR_TIMEOUT_S` | `300` | P3 corrector spawn via `buildJudgeInvocation()` |
| `DEBATER_TIMEOUT_S` | `240` | P4 per-persona; cap × N |

Each new bin includes `tests/<bin-name>-hang-guard.test.js` covering wedged-spawn with a fake-tool shim on `PATH` (mirrors `scope-one-hop-hang-guard.test.js`).

### Appendix Section 1 — `/pickle-readiness` Implementation Readiness Gate (P0)

> **Citadel coordination**: T17 in core uses this section's `check-readiness.ts` bin and reuses P0.2 / P0.5 / P0.7 / P0.8 / P0.12. The full skill (with `--history`, `--repo-root`, `--skip-readiness`, codex-version smoke at P0.10, recycle-cycle history) is non-conformance hardening and lives here.

| ID | Requirement | Verification |
|:---|:---|:---|
| P0.1 | New script `extension/src/bin/check-readiness.ts` exits 0 on pass, 2 on structural failure, 1 on internal error; emits structured JSON to stdout | `node ~/.claude/pickle-rick/extension/bin/check-readiness.js --session-dir $SESSION_DIR` returns `{ status, findings, elapsed_ms }` |
| P0.2 | Gate enforces five alignment checks reading from ticket dirs `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md` (NOT `refinement_manifest.json`, which is metadata-only) *(refined: codebase C3 P0 #1)*: every PRD requirement maps to ≥1 ticket; every AC is machine-checkable; every ticket file path resolves; every contract referenced exists (via `scope-resolver.computeOneHop({findImportersTimeoutMs: 30_000})` *(refined: codebase C3 P1 #7)*); every ticket dependency is in the manifest or marked external | `tests/check-readiness.test.js` covers each check independently |
| P0.3 | `/pickle-readiness` is invokable manually AND auto-invoked at THREE execution points *(refined: codebase C3 P0 #6)*: (i) end of `/pickle-refine-prd --run` BEFORE `setup.ts` mints state.json; (ii) inside `mux-runner.ts` at iteration 0 BEFORE first spawn (legacy resume); (iii) inside `pickle.md` Phase 3.B BEFORE first `Agent` call (teams resume) | Integration test exercises all three with misaligned-fixture |
| P0.4 | Findings written to `${SESSION_DIR}/readiness_<date>.md` with three sections: PRD↔ticket map, AC verifiability matrix, contract resolution table | Schema validator |
| P0.5 | Failure routes back to refinement: gate suggests which analyst (gaps / codebase / risk) should re-cycle based on finding category. Hard cap `state.json.readiness.cycle_history.length ≤ 3` *(refined: risk C3 R33)*; after 3 cycles, halt with `readiness_escalation_<date>.md` | Test: contract failures → codebase analyst; AC failures → gaps analyst; cycle 4 halts |
| P0.6 | `--skip-readiness "<reason>"` (≤200 chars, required) bypasses; logs `event: 'readiness_skipped'` with reason | Test: flag without reason rejects via `die()` |
| P0.7 | Gate runs in <10s on 25-ticket manifest fixture at `tests/__fixtures__/readiness-timing/large-manifest/` *(refined: requirements C3 P2)* | `time` measurement |
| P0.8 | Reuses `findMissingPrefixes` from `extension/src/services/artifact-validation.ts` (promoted from `validate-teams-ticket.ts:53-58`) with refactored signature `findMissingPrefixes(files, prefixes: readonly string[]) => string[]` *(refined: codebase C3 P0 #5)*; `validate-teams-ticket.ts:86` becomes `findMissingPrefixes(files, ARTIFACT_PREFIXES[role])`; `WorkerRole` enum NOT extended | New `tests/artifact-validation.test.js` |
| P0.9 | `/pickle-readiness --history [--last N]` prints cycle table with status, suggested-analyst, user-action, timestamp *(refined: requirements C3)* | Manual review of stdout format |
| P0.10 | Session boot writes `state.json.codex_version_seen` from `codex --version` (when codex is the resolved backend); setup.ts asserts version against `extension/package.json:engines.codex` (semver `^0.42.0`); mismatch fails session entry *(refined: risk C3 R28)* | `tests/codex-version-smoke.test.js` |
| P0.11 | `--repo-root <path>` (repeatable) for multi-repo workspaces; output sectioned per repo *(refined: requirements C3 P1)* | Test: 3 repos, mixed pass/fail |
| P0.12 | P0 auto-runs in DELTA MODE on `tickets_version` bump (after `course_corrected` event); validates only added/modified tickets; failures emit `readiness_failed_post_correction`; halt next iteration with banner *(refined: risk C3 R30 Critical)* | Integration test: course-correct adds malformed ticket → next iteration halts |

### Appendix Section 2 — `/pickle-archaeology` Persistent Project Context (P1)

| ID | Requirement | Verification |
|:---|:---|:---|
| P1.1 | New skill `/pickle-archaeology` invokable manually; auto-invoked once per session by `/pickle-refine-prd --run` after gate passes (idempotent unless `--force`) | Test: invoking twice is no-op |
| P1.2 | `extension/data/project-types.csv` registry with 10 categories (web, mobile, backend, CLI, library, desktop, game, data, extension, infra/embedded). Resolved via `path.join(getExtensionRoot(), 'extension', 'data', 'project-types.csv')` — NOT `getDataRoot()` *(refined: codebase C3 P0 #3)*. New service `extension/src/services/project-type-classifier.ts` takes `extensionRoot` injectable parameter | Test: 10 fixture projects each correctly classified, ≥90% accuracy. Each fixture is ≥5 files matching category archetype *(refined: risk C3 P1)* |
| P1.3 | New script `extension/src/bin/archaeology.ts` runs worker (subprocess via `buildWorkerInvocation()` honoring backend) with archaeology prompt | Backend stub tests for codex + claude |
| P1.4 | Produces `${SESSION_ROOT}/project-context.md` with sections in load-bearing order: Architecture, Trap Doors, Unobvious Constraints, Key Entry Points, Conventions, Data Model *(refined: requirements C3 P2)*. First line: `> Project type: <category> — see ${EXTENSION}/data/project-types.csv for category definition` | Schema validator on output |
| P1.5 | **Subprocess preamble injection**: `spawn-morty.ts` injects `project-context.md` content as `## Project Context` block (the P2 persona block follows). Insertion point spec'd in P2.5 below | Spawned worker prompt diff |
| P1.6 | **Agent-tool brief injection**: `pickle.md` Phase 3.B brief includes `## Project Context` block before phase instructions | Greppable static assertion + integration test |
| P1.7 | Re-runs automatically when files in tracked directories change beyond threshold (default 10%, configurable). Override: `PICKLE_ARCHAEOLOGY_AUTO_REFRESH=off` | Test: simulate >10% change → re-run; below → no-op |
| P1.8 | `--refresh` forces new pass; `--no-archaeology` disables injection for session in BOTH paths; `--project-type <category>` overrides classifier | Test: each flag honored, activity events emitted |
| P1.9 | Token cost recorded in `state.json.activity` as `event: 'archaeology_complete'` with `bytes_out_utf8`, `tokens_in_estimated`, `tokens_out_estimated`, `duration_ms`, `project_type`, `backend` *(refined: requirements C2 P2)* | Activity log assertion |
| P1.10 | Stdout on completion: `[archaeology] complete — project type: <category> (confidence: high, file-pattern match); duration: 45s; bytes: 12,400; written: ${SESSION_ROOT}/project-context.md` *(refined: requirements C3 P1)* | stdout match |
| P1.11 | Gracefully degrades on archaeology failure — both paths proceed without `project-context.md`; `event: 'archaeology_skipped'` records failure mode | Test: simulate crash → mux-runner and teams flow continue |

### Appendix Section 3 — Phase-Specialized Morty Subagent Definitions (P2) *(refined: codebase C3 P0 #4 — agent-md `tools:` is CSV STRING; drop `allowed_tools[]`)*

| ID | Requirement | Verification |
|:---|:---|:---|
| P2.1 | Six agent-md files added under `.claude/agents/`: `morty-phase-researcher.md`, `morty-phase-planner.md`, `morty-phase-implementer.md`, `morty-phase-verifier.md`, `morty-phase-reviewer.md`, `morty-phase-simplifier.md` *(refined: requirements C3 — naming locked)*. Each has YAML frontmatter with `name`, `description`, `tools` (CSV STRING matching harness contract — same shape as `morty-implementer.md:4`), `model`, `role`, `identity`, `communication_style`, `principles[]` | Schema check `tests/agent-md-schema.test.js` |
| P2.2 | Per-phase `model` defaults specified in agent-md frontmatter AND in `extension/data/phase-personas.json` (single source of truth) *(refined: risk C3 R31 Critical)*: researcher=sonnet, planner=sonnet, **phase-implementer=opus** (matches v1.55.0 baseline), **verifier=opus**, phase-reviewer=sonnet, simplifier=sonnet. Override via `pickle_settings.json:bmad_hardening.phase_personas.model_override.<phase>` | `tests/phase-personas-model-defaults.test.js` |
| P2.3 | Distinct phase priors: Researcher *what exists*; Planner *what's needed*; Phase-Implementer *exactness and brevity*; Verifier *adversarial test coverage*; Phase-Reviewer *contract conformance*; Simplifier *removal* | Manual review documented in PRD_GUIDE.md |
| P2.4 | `extension/data/phase-personas.json` mapping table *(refined: codebase C3 P1 #8)*. Schema: `{ "<phase>": { "subagent_type": "morty-phase-<role>", "complexity_tier_default": "small\|medium\|large", "model": "sonnet\|opus\|haiku" }, "version": <int> }`. `pickle.md` Phase 3.B asserts `version >= <pinned>` at start; mismatch is hard failure | `tests/phase-personas-json-schema.test.js` |
| P2.5 | **Legacy/subprocess persona injection** *(refined: codebase C3 P1 #2 — insertion order locked)*: `spawn-morty.ts` constructs prompt as: (1) template body from `send-to-morty.md`, (2) `## Active Persona` block (NEW), (3) `## Project Context` block (P1.5), (4) `# TARGET TICKET CONTENT`, (5) `# EXECUTION CONTEXT`, (6) FORBIDDEN tail. Persona resolved from `phase-personas.json[state.step]`; loaded via new `extension/src/services/agent-md-loader.ts` reusing `extractFrontmatter()` from `pickle-utils.ts:204-214` *(refined: codebase C3 P1 #6 — no new YAML deps)*. Precedence: ticket-tier > persona-default > 'sonnet' *(refined: codebase C3 P1 #1)* | `tests/spawn-morty.test.js` byte-orders 6 sections + tier precedence |
| P2.6 | **Teams-mode dispatcher**: `pickle.md` Phase 3.B updated so per-ticket loop dispatches `subagent_type` per phase (not single-implementer-all-8-phases). Pre-flight check at ticket entry verifies all 6 agent-md files exist; missing files emit `phase_dispatch_preflight_failed` with `[ticket T<id>] missing: morty-phase-verifier.md, ...; install path: ~/.claude/agents/.pickle-managed/; recovery: bash install.sh && /pickle-retry T<id>` | Greppable static assertion + integration test observes 6 distinct Agent calls per ticket |
| P2.7 | **Falsifiability check** *(refined: requirements C2 + risk C3 R23)*: same input through six personas produces measurably different outputs (Jaccard token-set distinctness ≥30%). If <15%, P2 is theater and gets cut. **Flag-flip from off→on requires committed `tests/behavioral/phase-personas/baseline.json` with measured distinctness; PR cannot land without baseline update** *(refined: risk C3 R23)* | `tests/feature-flag-baseline.test.js` |
| P2.8 | All eight agent-md files (6 new + existing morty-implementer.md, morty-reviewer.md) pass `tests/agent-md-schema.test.js`. Existing `tools` field shape preserved | New test |
| P2.9 | install.sh agent rsync target moves to `~/.claude/agents/.pickle-managed/` *(refined: codebase C3 P1 #3)*. agent-md-loader resolution: (1) `~/.claude/agents/<name>.md` (user override); (2) `~/.claude/agents/.pickle-managed/<name>.md` (canonical). install.sh migrates existing pickle-canonical files to `.pickle-managed/` on first run post-bump; emits notice on legacy-path conflicts (mtime + size heuristic) | `tests/install-agent-overlay.test.js` |
| P2.10 | `PICKLE_PHASE_PERSONAS=off` default until P2.7 baseline checked in *(refined: requirements C3 + risk C3 R3)*. One-time-per-session stdout when off and feature would apply: `[phase-personas] feature available but disabled (calibration in progress); enable with: pickle settings set bmad_hardening.phase_personas_enabled true OR PICKLE_PHASE_PERSONAS=on`. Activity event `phase_personas_disabled_seen` once per session | Test: stdout emitted once; second invocation no-op |
| P2.11 | Existing `persona.md` content (Rick voice) prepended to every persona's worker prompt as base layer; per-phase blocks layer specialization on top | Smoke test: clean install, every persona prompt contains Rick voice |
| P2.12 | Schema-version bump for `state.json.phase_personas_active` covered by Schema Migration v3 above | Round-trip test |

### Appendix Section 4 — `/pickle-correct-course` Mid-Execution Adaptive Skill (P3)

| ID | Requirement | Verification |
|:---|:---|:---|
| P3.1 | New skill `/pickle-correct-course "<discovery>"` invokable manually; surfaced by circuit breaker as suggested recovery when no-progress signature matches "constraint discovery" patterns | Test: matching CB signature emits suggestion |
| P3.2 | New agent-md `.claude/agents/morty-course-corrector.md`: read-only role (`tools: Read, Glob, Grep`), produces proposal artifact only. Manager performs the actual restructure. Mirrors `morty-implementer.md:13` forbidden-state-mutation note *(refined: codebase C3 P2)* | Schema check; `tools` excludes Edit/Write/Bash |
| P3.3 | New script `extension/src/bin/correct-course.ts` is **brief-prep helper only** *(refined: codebase C3 P0 #2)* — resolves session context, validates discovery statement, writes `${SESSION_ROOT}/change_proposal_<date>_brief.md`. Actual subagent spawning happens in `.claude/commands/pickle-correct-course.md` orchestrator skill prompt via `buildJudgeInvocation(backend, ...)` (read-only sandbox: codex `-s read-only --ignore-rules --ephemeral`, claude `--allowedTools Read,Glob,Grep --no-session-persistence`) | Test asserts `--dangerously-bypass-approvals-and-sandbox` never on codex; no Edit/Write tools on claude |
| P3.4 | Produces `${SESSION_ROOT}/change_proposal_<date>.md` with five sections: Discovery Summary, Impact Map, Artifact Diffs, Restart Point, **Confidence Metadata** (renamed from Confidence Score) *(refined: risk C3 R5 reconciliation)*. Plus `change_proposal_<date>_trace.md` with full reasoning trace *(refined: risk C2 R19)*. Artifact set validated via `findMissingPrefixes(files, ['discovery_summary', 'impact_map', 'artifact_diffs', 'restart_point', 'confidence_metadata'])` | Schema validator |
| P3.5 | **Atomic restructure with current_ticket invariants** *(refined: codebase C3 P0 #1 + risk C3)*. After approval, MANAGER atomically applies under composite lock (state.json transaction + restructure.lock). Within transaction: (1) resolve `current_ticket` membership: killed-set → `current_ticket = last_course_correction.restart_ticket_id` (null if absent, force re-pick); kept-set → no-op; added-set (corner) → `current_ticket = <new_hash>` + `current_ticket_redirected_to_new` event; (2) apply ticket-tree mutations per ledger (kill via `markTicketKilled`, add via dir+linear_ticket write — kills+adds only, no in-place rename); (3) bump `tickets_version` (R13 monotonic counter); (4) append `course_corrected` event with before/after sets + branch ('a'\|'b'\|'c'); (5) trigger P0 delta-mode re-run (R30 → P0.12); (6) release locks LIFO. Partial-failure → replay-reverse via apply-ledger at `${SESSION_ROOT}/change_proposal_<date>_apply.log` | `tests/integration/course-correct-hot-swap.test.js` covers all 3 branches; partial-failure replay-reverse tested |
| P3.6 | `--auto-apply` waits for next iteration boundary before acquiring state lock *(refined: risk C3 R24)*; activity event `course_correct_pending_iteration_boundary` records wait. Mid-iteration aborts on `tickets_version` mismatch print: `[iteration ABORTED] manifest swapped during iteration <N>; resuming on next iteration with restructured plan`. 3+ aborts in single epic emit warning *(refined: requirements C3 P1)* | Race test |
| P3.7 | `--dry-run` emits proposal without writing changes; `--auto-apply` skips approval prompt | Both flags tested |
| P3.8 | **Confidence is structural, not numeric** *(refined: risk C3 R5 reconciliation)*. Four structural predicates: (a) impact-map enumerates ≥1 ticket; (b) every referenced ticket-id resolves to a current `${SESSION_ROOT}/<hash>/` directory OR is in killed-set; (c) discovery_summary contains user statement verbatim or documented derivation; (d) restart_point resolves to current ticket-id OR null with documented reason. Auto-apply requires ALL four to pass. `--force` overrides only the *advisory* portion; structural predicates are non-overridable *(refined: requirements C3)* | Unit tests with passing+failing fixtures per predicate |
| P3.9 | `--recover-from-ledger` reads `change_proposal_<date>_apply.log`, identifies last successful step, replays-reverse from that point under fresh composite lock; on success writes `course_correct_recovered` *(refined: requirements C3)*. `--recover --force` allows forward-replay (transient-cause case) | Tests for both modes |
| P3.10 | Partial-failure under `--auto-apply` writes `${SESSION_ROOT}/HALT_<date>.md` with failed step, ledger path, three recovery options. mux-runner halts at next iteration boundary; activity event `course_correct_apply_failed` *(refined: requirements C3 P0 + P1)*. On user attach, tmux pane top banner shows HALT contents (CUJ-6) | Integration test |
| P3.11 | New service `extension/src/services/transaction-ticket-ops.ts` *(refined: codebase C3 P1 #5)*: `updateTicketStatusInTransaction(ticketId, newStatus, sessionDir, txCtx) => {path, content}` returns planned write; manager replays inside transaction. Existing `updateTicketStatus` becomes thin wrapper. Same pattern for `materializeNewTicket(spec) => {dirPath, files: [{path, content}]}` and `replayReverseLedger(ledgerPath, sessionRoot)` helpers | `tests/transaction-ticket-ops.test.js` |
| P3.12 | Backend works under both `--backend claude` and `--backend codex` in legacy mode; teams mode is claude-only by inheritance | Backend-stub tests |
| P3.13 | Detects `PICKLE_REFINEMENT_LOCK=1` if invoked during refinement; logs `course_correct_during_refinement`; forces claude backend with user-visible note *(refined: risk C3 R25)* | Test |

### Appendix Section 5 — `/pickle-debate` Multi-Agent Decision Primitive (P4)

| ID | Requirement | Verification |
|:---|:---|:---|
| P4.1 | New skill `/pickle-debate "<question>" [--personas r,a,i,s] [--n 4]` invokable at any lifecycle stage; default personas: Researcher, Architect, Implementer, Skeptic | `/help-pickle` lists; flag parsing tested |
| P4.2 | **Per-persona agent-md files** *(refined: risk C3 P1)*: `morty-debater-researcher.md`, `morty-debater-architect.md`, `morty-debater-implementer.md`, `morty-debater-skeptic.md`. Generation script `extension/src/bin/generate-debate-personas.ts` produces all 4 from common template + per-persona overlay (DRY at build-time). `tests/debate-persona-generation.test.js` asserts no drift between template and committed copies | Generation test |
| P4.3 | New script `extension/src/bin/debate.ts` is **brief-prep helper only** *(refined: codebase C3 P0 #2 + risk C3)*: resolves personas, validates frontmatter, writes `${SESSION_ROOT}/debate_<date>_brief.md`. **Orchestrator-driven path** in `.claude/commands/pickle-debate.md` calls `TeamCreate`, N parallel `Agent` invocations with `subagent_type: "morty-debater-<persona>"`, then `TeamDelete` | Integration test: 4 parallel Agent spawns; team teardown |
| P4.4 | Each subagent's prompt capped at 600 words shared context; per-persona response capped at 800 words BPE *(refined: requirements C2 + risk C2)* | Token-budget assertion |
| P4.5 | Each persona instructed to "respond authentically as <persona>" with explicit disagreement permission. Subagent's `tools` field contains `Read, Glob, Grep` only (no Edit/Write/Bash) | Schema check |
| P4.6 | Each persona signals completion via `TaskUpdate(status="completed")` (NOT `<promise>` token) | Greppable assertion; template-no-bare-tokens passes |
| P4.7 | **Multi-round debate with caps** *(refined: risk C3 R29 + R26)*: max rounds 5 (`debate_max_rounds`); **codex `--solo` hard cap 2** (`debate_codex_solo_max_rounds`); rounds 3+ on codex fail with migration suggestion. Round-N entry pre-flight: assert `state.json.tickets_version` == round-1 snapshot; mismatch halts unless `--accept-stale`. New persona at round-N receives full round-1 priors with note "weren't in round 1, read for context". Latest-first truncation when prompt > round-budget; `debate_round_truncated` event records bytes-dropped. 3+ rounds requires `--continue --confirm-multi-round` | Round-3 codex test fails; mid-debate course-correct test halts round-2 |
| P4.8 | Output `${SESSION_ROOT}/debate_<date>.md`: one section per persona (full unabridged), no synthesis. Optional Orchestrator note flagging disagreement points (regex-deterministic header `^## Disagreements with prior speakers$`) *(refined: risk C2 minor)* | Output schema check |
| P4.9 | `--solo` falls back to single-context sequential roleplay when teams unavailable (codex). `--strict-teams` *(refined: risk C3 R27)* persisted in `state.json.flags.strict_teams`; resumed sessions inherit; per-invocation `--no-strict-teams` overrides | Resume test |
| P4.10 | Activity log records `debate_complete` with `personas`, `rounds`, `tokens_in`, `tokens_out`, `wall_clock_ms`, `mode: 'teams'\|'solo'\|'solo (auto)'` | Integration test |
| P4.11 | Backend gating *(refined: requirements C3)*: codex without `--solo` and without `--strict-teams` triggers CUJ-7 auto-promote with cost banner: `[debate] codex backend detected — auto-promoting to --solo (use --strict-teams to require parallel subagents and fail-fast on codex). Sequential debate starting; estimated cost: $0.40, est. wall-clock: 90s. Continue? [Y/n]`. Activity event `debate_solo_auto`. `--strict-teams` on codex exits 7: `debate: --strict-teams requires claude backend; current: codex; remove --strict-teams to allow auto-promote, or switch backend` | Test: codex prompt + auto-promote; --strict-teams fail-fast |
| P4.12 | Mid-debate course-correct invalidation: `tickets_version` mismatch at round-N entry halts debate; activity event `debate_invalidated_by_correction` *(refined: risk C3 R29)* | Test |

### Appendix Behavioral Test User-Flow *(refined: requirements C3 P0 #4)*

`npm run test:behavioral` is interactive by default and CI-safe via env:

1. Discovers tests via `tests/behavioral/**/*.test.js` glob.
2. Reads `// COST_CEILING: $X.XX` and `// WALL_CEILING: Ns` from each test header.
3. Prints: `[behavioral] N tests will run; estimated cost: $X.XX (max budget cap: $Y.YY); estimated wall-clock: Z minutes; continue? [Y/n]`.
4. On `Y` (or `CI=1`), runs each test serially with per-test stdout: `[behavioral i/N] <name>: cost $A.AA / cap $0.50, wall <s>s / cap 120s, status: PASS|FAIL|BUDGET_EXCEEDED`.
5. Final summary: `[behavioral] N tests, M passed, K failed, X budget-exceeded; total cost: $T.TT; log: tests/behavioral/.last-run.json`.
6. CI runs (`BEHAVIORAL=1 CI=1`) skip prompt; **fail-closed default**: PR cannot land if any test was skipped due to budget *(refined: risk C3)*. Override via `BEHAVIORAL_BUDGET_OVERRIDE=1`.

### Appendix Cross-Cutting User Journeys (CUJs)

#### CUJ-3 (revised): Course-correction restructure approval

User reviews proposal at `change_proposal_<date>.md`; sees four-pane preview *(refined: requirements C3 P0 #8)*: (a) ticket directory tree (renames/removals/adds), (b) per-ticket frontmatter changes, (c) `state.json` diff, (d) **projected apply ledger** with recovery class per step. Step 7 of CUJ-3: MANAGER acquires composite lock, applies operations in order, writes apply-ledger entry per operation, logs `course_corrected`.

#### CUJ-6: Partial-failure recovery on `/pickle-correct-course --auto-apply` *(refined: requirements C3 P0 #2)*

Unattended runner; corrector writes proposal at 03:14; manager begins composite-lock apply. Step 4 fails (disk/FS/permission). Apply-ledger writes `step_4: FAILED`. Replay-reverse runs. Manager writes `${SESSION_ROOT}/HALT_<date>.md` with failed step, cause, ledger path, three recovery options, "if you do nothing" outcome. mux-runner halts at next iteration boundary. User attaches at 09:00; tmux pane top banner shows HALT summary. Recovery: `--recover-from-ledger`, `--recover --force`, or `/pickle-status --reset-current-ticket`.

#### CUJ-7: Codex auto-promote-to-`--solo` *(refined: requirements C3 P0 #3)*

Codex-backed user invokes `/pickle-debate "Postgres or DuckDB?"` without `--solo` and without `--strict-teams`. Skill detects `state.json.backend == "codex"`. Stdout: `[debate] codex backend detected — auto-promoting to --solo ...`. On `Y`, runs sequentially. Each persona response prefixed `### <icon> <name>`. Output `debate_<date>.md` with header `mode: solo (auto)`. Activity event `debate_solo_auto`.

### Appendix Codebase Context

#### Files this section touches *(refined: codebase C3 path-resolution corrections)*

| Path | Why |
|:---|:---|
| `extension/src/bin/check-readiness.ts` | NEW — P0 gate script (also used by core T17) |
| `extension/src/bin/archaeology.ts` | NEW — P1 reverse-engineering bin (subprocess worker spawn) |
| `extension/src/bin/correct-course.ts` | NEW — P3 brief-prep helper (NOT spawning) |
| `extension/src/bin/debate.ts` | NEW — P4 brief-prep helper (NOT spawning) |
| `extension/src/bin/generate-debate-personas.ts` | NEW — P4 codegen for 4 debater agent-md files |
| `extension/src/bin/spawn-refinement-team.ts` | P0 gate invocation in `--run` flow; P1 archaeology auto-trigger |
| `extension/src/bin/spawn-morty.ts` | P1 project-context preamble injection (subprocess); P2 phase persona injection (insertion order P2.5); tier precedence rule |
| `extension/src/bin/mux-runner.ts` | P0 abort on gate failure (iter 0); P3 manifest hot-swap; circuit-breaker integration |
| `extension/src/bin/setup.ts` | Schema migration v3; codex version smoke (P0.10); flag persistence (state.json.flags) |
| `extension/src/services/state-manager.ts` | Schema v3 migration; SchemaVersionMismatchError; transaction lock for ticket-tree |
| `extension/src/services/circuit-breaker.ts` | P3 constraint-discovery signature → suggest correct-course |
| `extension/src/services/backend-spawn.ts` | Reuse `buildJudgeInvocation()` for P3/P4; document new skills' usage |
| `extension/src/services/promise-tokens.ts` | (no changes) — new skills MUST import from here |
| `extension/src/services/agent-md-loader.ts` | NEW — P2 reads agent-md frontmatter via `extractFrontmatter()`; `agentsDir` injectable; `.pickle-managed/` overlay precedence |
| `extension/src/services/classifier-utils.ts` | NEW — `extractAssistantContent` moved here from `mux-runner.ts:181-225`; `mux-runner.ts:181` re-exports for backwards compat *(refined: codebase C3 P0 #7 LOCK)* |
| `extension/src/services/artifact-validation.ts` | NEW — `findMissingPrefixes(files, prefixes)` moved from `validate-teams-ticket.ts:53-58` with refactored signature; `validate-teams-ticket.ts:86` becomes wrapper |
| `extension/src/services/transaction-ticket-ops.ts` | NEW — P3 `updateTicketStatusInTransaction`, `materializeNewTicket`, `replayReverseLedger` |
| `extension/src/services/project-type-classifier.ts` | NEW — P1 file-pattern heuristic classifier; `extensionRoot` injectable |
| `extension/src/types/index.ts` | Schema v3 fields; `ProjectContext`; `PhasePersona`; `ChangeProposal`; `DebateRound`; rename `PromiseTokens` → `PROMISE_TOKEN_VALUES` *(refined: codebase C3 P1 #10)* |
| `extension/src/hooks/handlers/stop-hook.ts` | P3 detect course-correction tokens |
| `extension/data/project-types.csv` | NEW — P1 registry; deployed via `install.sh:56-62` rsync to `~/.claude/pickle-rick/extension/data/`; resolved via `getExtensionRoot()` (NOT getDataRoot); 10 categories; per-category fixture at `tests/__fixtures__/archaeology/<category>/` |
| `extension/data/phase-personas.json` | NEW — P2 phase → subagent_type → model mapping; deployed same path; consumed by `pickle.md` Phase 3.B (Read tool, absolute path); schema includes `version` field |
| `.claude/agents/morty-phase-researcher.md` | NEW — P2 |
| `.claude/agents/morty-phase-planner.md` | NEW — P2 |
| `.claude/agents/morty-phase-implementer.md` | NEW — P2 (model: opus) |
| `.claude/agents/morty-phase-verifier.md` | NEW — P2 (model: opus) |
| `.claude/agents/morty-phase-reviewer.md` | NEW — P2 |
| `.claude/agents/morty-phase-simplifier.md` | NEW — P2 |
| `.claude/agents/morty-course-corrector.md` | NEW — P3 read-only |
| `.claude/agents/morty-debater-{researcher,architect,implementer,skeptic}.md` | NEW — P4; generated by `generate-debate-personas.ts` |
| `.claude/commands/pickle-readiness.md` | NEW — P0 skill (orchestrator path also calls bin) |
| `.claude/commands/pickle-archaeology.md` | NEW — P1 skill |
| `.claude/commands/pickle-correct-course.md` | NEW — P3 skill (orchestrator drives Agent spawn for corrector; bin writes brief) |
| `.claude/commands/pickle-debate.md` | NEW — P4 skill (orchestrator drives `TeamCreate` + N `Agent` calls; bin writes brief) |
| `.claude/commands/pickle-refine-prd.md` | Document new flags; auto-invoke gate at end (P0.3 path i) |
| `.claude/commands/pickle.md` | P2 update Phase 3.B per-phase `subagent_type` dispatch; P1 brief block injection; P0 gate invocation (path iii) |
| `.claude/commands/pickle-tmux.md` | P1 brief injection notes; P2 phase-aware persona injection notes |
| `.claude/commands/send-to-morty.md` | P1 + P2 injection points (insertion order P2.5) |
| `.claude/commands/help-pickle.md` | Surface new skills + flags |
| `install.sh` | Agents rsync target → `~/.claude/agents/.pickle-managed/`; migration to move existing pickle-canonical files; legacy-path conflict notice |
| `extension/eslint-plugin-pickle/index.js` | (no changes — allowlist already covers `services/promise-tokens.ts` and `types/index.ts` per `4b1f784`) |
| `extension/package.json` | `engines.codex: ^0.42.0` for P0.10 smoke check |
| `pickle_settings.json` | `bmad_hardening` block per Configuration Reference |
| `tests/check-readiness.test.js` | NEW — P0 |
| `tests/check-readiness-hang-guard.test.js` | NEW — P0 hang guard |
| `tests/archaeology.test.js` | NEW — P1 |
| `tests/archaeology-hang-guard.test.js` | NEW — P1 hang guard |
| `tests/agent-md-schema.test.js` | NEW — P2 schema check |
| `tests/correct-course.test.js` | NEW — P3 |
| `tests/correct-course-hang-guard.test.js` | NEW — P3 hang guard |
| `tests/debate.test.js` | NEW — P4 |
| `tests/debate-hang-guard.test.js` | NEW — P4 hang guard |
| `tests/debate-persona-generation.test.js` | NEW — P4 generation drift |
| `tests/integration/readiness-gate.test.js` | NEW — P0 three integration points |
| `tests/integration/archaeology-injection.test.js` | NEW — P1 dual-path |
| `tests/integration/phase-persona-dispatch.test.js` | NEW — P2 dispatch + injection |
| `tests/integration/course-correct-hot-swap.test.js` | NEW — P3 atomic restructure |
| `tests/integration/codex-version-smoke.test.js` | NEW — P0.10 |
| `tests/behavioral/phase-personas/harness.test.js` | NEW — P2.7 distinctness |
| `tests/behavioral/phase-personas/quality-vs-baseline.test.js` | NEW — R31 quality regression |
| `tests/behavioral/phase-personas/baseline.json` | NEW — flag-flip gate file |
| `tests/feature-flag-baseline.test.js` | NEW — R23 |
| `tests/flag-interaction-matrix.test.js` | NEW — flag combos |
| `tests/state-manager.test.js` | UPDATE — v2→v3 migration round-trip |
| `tests/install-agent-overlay.test.js` | NEW — `.pickle-managed/` overlay |
| `tests/transaction-ticket-ops.test.js` | NEW — P3 |
| `tests/artifact-validation.test.js` | NEW — P0.8 |
| `tests/calibration-baseline-drift.test.js` | NEW — R22 |

#### Patterns to follow

- **Promise tokens**: import from `extension/src/services/promise-tokens.ts`. Broken-substring in templates. Use `extractAssistantContent()` (now `services/classifier-utils.ts`) before scanning.
- **Backend spawning**: workers via `buildWorkerInvocation`; managers via `buildManagerInvocation`; **judges/correctors/debaters via `buildJudgeInvocation`** (read-only sandbox). Refinement uses `buildRefinementEnv()` + `'claude'`.
- **Artifact validation**: `findMissingPrefixes(files, prefixes)` from `services/artifact-validation.ts`.
- **Schema migration**: state-manager `migrate*` pattern. ONE bump (v2→v3) covers all P1–P4 fields.
- **Hang guards**: every external-process spawn passes explicit timeout; corresponding `tests/<bin>-hang-guard.test.js`.
- **Activity logging**: emit via `services/activity-logger.ts`. New events: `readiness_skipped`, `readiness_failed`, `readiness_failed_post_correction`, `archaeology_complete`, `archaeology_skipped`, `archaeology_truncated`, `course_corrected`, `course_correct_apply_failed`, `course_correct_pending_iteration_boundary`, `course_correct_during_refinement`, `course_correct_recovered`, `current_ticket_redirected_to_new`, `iteration_aborted_manifest_swap`, `phase_dispatch_preflight_failed`, `phase_personas_disabled_seen`, `debate_complete`, `debate_solo_auto`, `debate_user_declined_auto_promote`, `debate_invalidated_by_correction`, `debate_solo_round_capped`, `debate_round_truncated`. **All MUST be added to `VALID_ACTIVITY_EVENTS as const`** *(refined: codebase C2/C3)*.
- **Agent-md schema**: every `.claude/agents/*.md` has frontmatter with `name`, `description`, `tools` (CSV STRING), `model`, plus pickle-extension fields `role`, `identity`, `communication_style`, `principles[]`. Schema enforced by `tests/agent-md-schema.test.js`.

### Appendix Updated Risk Register *(refined: risk C2/C3 — R5 reconciled, R21–R33 added)*

| ID | Risk | Severity | Mitigation | Verification |
|:---|:---|:---|:---|:---|
| R5 (revised) | P3 confidence is structural, not numeric | High | 4 structural predicates per P3.8; no threshold; band display optional | Unit tests per predicate |
| R9 | Atomic restructure across heterogeneous file ops | High | Apply-ledger replay-reverse via `change_proposal_<date>_apply.log` | Integration test for partial-failure |
| R12 | Schema migration mid-session | Med | v3 forward-compat-only; SchemaVersionMismatchError | Round-trip tests |
| R13 | Mid-iteration manifest swap race | High | `tickets_version` monotonic counter; iteration boundary fence | Race test |
| R16 | Codex auto-promote-to-`--solo` | Med | CUJ-7; `--strict-teams` opt-out | Test |
| R20 | Multi-round debate token amplification | Med | Latest-first truncation; 600w/800w caps; round confirm | Token-budget assertion |
| R21 (NEW) | Compound orchestrator-turn cost (~155 turns/25-ticket epic) | High | Per-ticket and per-epic `orchestrator_turn_count` telemetry; alert >180/epic | `/pickle-metrics` surfaces; alert fixture |
| R22 (NEW) | Calibration corpus governance | Med | Versioned baselines; recalibration triggers; drift >5% blocks merge | `tests/calibration-baseline-drift.test.js` |
| R23 (NEW) | P2.7 flag-flip is unauditable | Med | Flag-flip requires committed baseline; CI test asserts baseline-before-flip | `tests/feature-flag-baseline.test.js` |
| R24 (NEW) | Unattended `--auto-apply` mid-iteration data-loss | Med | `--auto-apply` waits for next iteration boundary; activity event records wait | Race test |
| R25 (NEW) | `/pickle-correct-course` during refinement | Low | Detect `PICKLE_REFINEMENT_LOCK=1`; force claude with note | Test |
| R26 (NEW) | P4 codex `--solo` round amplification (5200+ words) | High | Codex `--solo` round cap = 2 hard | Round-3 codex test fails |
| R27 (NEW) | `--strict-teams` flag persistence across `--resume` | High | Stored in `state.json.flags.strict_teams` | Resume test |
| R28 (NEW) | Codex format drift detection | High | P0.10 session-boot version smoke check | `tests/codex-version-smoke.test.js` |
| R29 (NEW) | Mid-debate course-correct orphans round-2 priors | High | Round-N entry pre-flight on `tickets_version`; halt unless `--accept-stale` | Test |
| R30 (NEW) | P0 doesn't re-run after `course_corrected` | Critical | Delta-mode P0 invoke on `tickets_version` bump; `readiness_failed_post_correction` halts | Integration test |
| R31 (NEW) | Per-phase `model` defaults silently sonnet | Critical | Per-phase model defaults explicit (phase-implementer/verifier=opus); behavioral A/B vs v1.55.0 baseline | `tests/behavioral/phase-personas/quality-vs-baseline.test.js` |
| R32 (NEW) | install.sh during session corrupts schema migration | High | SchemaVersionMismatchError on read-after-write | Test: simulate mid-session bump |
| R33 (NEW) | P0.5 recycle-hint infinite loop | Med | Hard cap `cycle_history.length ≤ 3`; halt with escalation file | Test |

### Appendix Verification Strategy

- **Type**: `npx tsc --noEmit` clean.
- **Lint**: `npx eslint src/ --max-warnings=-1` clean. `pickle/promise-token-format` zero errors.
- **Test**: `npm test` passes. All P0/P1/P2/P3/P4 unit tests in default suite. `tests/template-no-bare-tokens.test.js` passes against new templates.
- **Behavioral**: `npm run test:behavioral` runs P2.7 distinctness, P3 confidence-stability, R31 quality-vs-baseline. Manual or nightly. Fail-closed on budget.
- **Schema**: `tests/agent-md-schema.test.js` passes against all 14 deployed agent-md files (8 phase + 1 corrector + 4 debater + 1 review). State.json v3 round-trip.
- **Calibration**: `npm run calibrate:readiness`, `npm run calibrate:correct-course`, `npm run calibrate:archaeology` documented; required pre-PR for heuristic file changes; drift gate `tests/calibration-baseline-drift.test.js`.
- **Dual-path integration**: P0 three integration points; P1 dual injection; P2 6 distinct Agent calls per ticket (teams) + persona block in worker prompt (legacy); P3 `buildJudgeInvocation` in both modes; P4 teams parallel + codex `--solo` + `--strict-teams` fail-fast.
- **End-to-end**: Full epic on fixture project; both `/pickle` (legacy) and `/pickle --teams` paths.

### Appendix Hidden Assumptions

- A11: `model` frontmatter defaults documented per-phase (R31).
- A12: Calibration corpora versioned under `tests/__fixtures__/` (R22).
- A13: `state.json.flags` documented schema field; new flags add own keys (R12 + R27).
- A14: `--auto-apply` is iteration-boundary-aware, not instantaneous (R24).
- A15: Codex format drift detection in-scope via P0.10 (R28).
- A16: Per-phase `model` documented in agent-md frontmatter AND `phase-personas.json` AND PRD_GUIDE.md (R31 + Codebase C3).

### Appendix Source Material

- BMAD checkout: `/tmp/bmad-dive/BMAD-METHOD` (v6.4.0, SHA `1197122`)
- Pickle Rick foundations: `prds/pickle-agent-teams.md` (P2/P4 spawning), `prds/archive/bug-reports/codex-classifier-prompt-leak.md` (token discipline), `services/promise-tokens.ts`, `services/backend-spawn.ts` `buildJudgeInvocation()`, `validate-teams-ticket.ts` `findMissingPrefixes` pattern, v1.55.0 SHA `a4662df`
- 3-cycle 3-analyst refinement transcripts at `${SESSION_ROOT}/refinement/`

### Appendix Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | (T01) | Promote findMissingPrefixes to artifact-validation.ts | High | v1.55.0 | service exists, validate-teams-ticket.ts wraps | 4 |
| 20 | (T02) | Promote extractAssistantContent to classifier-utils.ts | High | v1.55.0 | service exists, mux-runner re-exports | 3 |
| 30 | (T03) | Schema migration v2→v3 (all new fields) | High | T01,T02 | state-manager v3 round-trips | 3 |
| 40 | (T04) | check-readiness.ts with 5 alignment checks | High | T01,T03 | bin exits 0/1/2; readiness_<date>.md | 4 |
| 50 | (T05) | Wire P0 into 3 integration points + delta-mode | High | T04 | refinement, mux-runner, pickle.md call gate | 4 |
| 60 | (T06) | /pickle-readiness --history + cycle cap | Med | T03,T04 | --history prints; cycle 4 halts | 3 |
| 70 | (T07) | project-types.csv + project-type-classifier service | High | T03 | 10 fixtures classify ≥90% | 4 |
| 80 | (T08) | archaeology.ts bin + project-context.md schema | High | T07,T02 | bin produces context file | 4 |
| 90 | (T09) | Archaeology dual-path injection (subprocess + brief) | High | T08 | spawn-morty preamble; pickle.md brief | 4 |
| 100 | (T10) | Archaeology auto-refresh + flags | Med | T08 | --refresh, --no-archaeology, --project-type honored | 3 |
| 110 | (T11) | phase-personas.json + 6 agent-md files | High | T03 | 6 files exist; phase-personas.json schema | 4 |
| 120 | (T12) | agent-md-loader service + .pickle-managed overlay + install migration | High | T11 | loader resolves overlay; install.sh migrates | 4 |
| 130 | (T13) | spawn-morty.ts persona injection (insertion order) | High | T12 | 6 sections byte-ordered | 3 |
| 140 | (T14) | pickle.md Phase 3.B per-phase dispatcher | High | T11,T12 | 6 distinct Agent calls per ticket | 3 |
| 150 | (T15) | PICKLE_PHASE_PERSONAS env flag + behavioral falsifiability | High | T13,T14 | flag default off; baseline.json gate | 4 |
| 160 | (T16) | morty-course-corrector.md + correct-course.ts brief-prep | High | T03 | corrector agent-md; bin writes brief | 4 |
| 170 | (T17) | transaction-ticket-ops service | High | T03 | updateTicketStatusInTransaction, materializeNewTicket, replayReverseLedger | 3 |
| 180 | (T18) | Composite lock + tickets_version fence + apply-ledger | High | T17 | atomic restructure; ledger format | 4 |
| 190 | (T19) | --recover-from-ledger + --recover --force + CUJ-6 | High | T18 | both flags work; HALT file | 4 |
| 200 | (T20) | Structural confidence (4 predicates) + current_ticket invariants + circuit breaker | High | T18 | 4 predicates; 3 branches; CB suggestion | 4 |
| 210 | (T21) | 4 debater agent-md files + generation script | High | T03 | 4 files committed; gen script | 3 |
| 220 | (T22) | debate.ts brief-prep + pickle-debate.md orchestrator | High | T21 | bin writes brief; skill spawns | 4 |
| 230 | (T23) | --solo + --strict-teams persistence + auto-promote | High | T22 | CUJ-7; flags persist; codex fail-fast | 4 |
| 240 | (T24) | --continue multi-round + R29/R26 caps | High | T22,T18 | round fence; codex round cap=2 | 4 |
| 250 | (T25) | Hang guards (4 hang-guard tests) + Configuration Reference docs | Med | T04,T08,T16,T22 | 4 hang-guard tests; PRD_GUIDE updated | 5 |
| 260 | (T26) | Codex format pin smoke check (P0.10) | High | T03 | session boot logs codex_version_seen | 3 |
| 270 | (T27) | Calibration corpus governance + drift detection | Med | T07 | 3 baseline.json; drift test | 3 |
| 280 | (T28) | Flag interaction matrix test | Med | T15,T18,T22 | matrix enumerated; combos asserted | 2 |
| 290 | (W) | Wire: integrate all modules into working pickle-rick-claude | High | T01-T28 | full epic runs both paths | many |
| 300 | (H1) | Harden: code quality review of feature area | High | W | zero P0-P1 violations | many |
| 310 | (H2) | Audit: data flow integrity for feature area | High | H1 | zero CRITICAL/HIGH findings | many |
| 320 | (H3) | Harden: test quality review of feature area | High | H2 | every AC has test | many |
| 330 | (H4) | Audit: cross-reference consistency for feature area | High | H3 | zero CRITICAL/HIGH cross-ref | many |

> **Appendix task-ID note**: This Appendix section's `(T01)`–`(T28)` numbering is BMAD-internal and does NOT collide with citadel core tasks T0–T17 / T20–T23. They are namespaced — Appendix `(T17)` refers to `transaction-ticket-ops service`, citadel core `T17` refers to the refinement-time machinability gate. Refer to Appendix tasks as `BMAD-T01` … `BMAD-T28` when discussed in PR descriptions to disambiguate.
