---
title: P1+P2 — Mega bug-fix bundle 2026-05-08 (codex classifier root cause + szechuan judge model + scope.json edit-time preflight + scope launch-time auto-inference + recoverable-json readdir bound + subsystem CLAUDE.md drift + pkgjson version-only revert diagnosis + excessive-defense strip + microverse judge probe ETIMEDOUT misclassification)
status: Shipped
filed: 2026-05-08
priority: P1 (mixed P1 + P2 + ad-hoc; closer ships v1.73.0)
shipped: v1.73.0 (11/11 sections A–K, commit range ef3b2855..6851f41f)
type: bug-bundle
composes:
  - prds/archive/bug-reports/codex-classifier-prompt-leak.md                     # Slot G — MANAGER_PERSISTENT_HALLUCINATION root cause (P1)
  - prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md        # Slot H — claude-routed judge under codex backend (P1)
  - prds/archive/bug-reports/p2-anatomy-park-worker-edits-bypass-scope-allowlist.md  # Open Finding #11 — scope.json preflight at edit time (P2)
  - prds/archive/bug-reports/p2-pickle-pipeline-no-scope-auto-inference.md       # Open Finding #12 — scope auto-inference at launch time (P2)
  - prds/archive/bug-reports/p1-deployed-pkgjson-version-only-revert.md          # Slot K — diagnosis-first; output is a follow-up fix PRD (P1)
  - prds/p1-strip-excessive-defense-deploy-reversion.md      # Slot L — strip ~480 LOC (cron sampler stripped; rest queued; P1)
  - prds/archive/bug-reports/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md  # Open Finding #13 — judge probe ETIMEDOUT misclassification (P1, pipeline-killer)
related:
  - prds/archive/bundles/p1-bug-fix-bundle-2026-05-07-deferred-slots.md      # predecessor; Slots D/E/K/L + Closer shipped 2026-05-08 AM
  - prds/p1-anatomy-park-detectproject-null-skips-baseline.md  # Open Finding #10 — already shipped (`232f3d26`); deploy owed
  - prds/MASTER_PLAN.md                                       # post-bundle bookkeeping target
backend_constraint: claude
refine: false
unattended: true
---

# PRD — Mega Bug-Fix Bundle 2026-05-08

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Why this bundle

The 2026-05-07-deferred-slots bundle session `2026-05-08-d6f98b66` shipped Sections D/E/K/L + Closer (`187aa589`, `2f4369c4`, `ce578369`, `1c3e4c27`) and exposed a fresh-init pipeline-killer in `convergence-gate.runGate({mode:'baseline'})` (Open Finding #10). That defect is fixed at `232f3d26` (R-APBN-1..5) but **deploy is owed** — `bash install.sh` was blocked by an active anatomy-park session in `loanlight-api`. Predecessor bundle's Sections B (Slot G — codex classifier prompt leak) and C (Slot H — szechuan judge model) did not enter the pickle phase before its anatomy-park phase failed; both remain Open and are the highest-priority residuals.

A separate anatomy-park session in `loanlight-api` (2026-05-08-5d60b760) surfaced Open Finding #11: worker edits leak past `scope.json:allowed_paths` between edit and `git commit` because `scope.json` is consumed only at *discovery* and *gate-baseline-failure* time, not at *fix* time.

The same pipeline session (`2026-05-08-33d10614`, `/pickle-pipeline` for LOA-763) surfaced **two** distinct bugs:

- Open Finding #12: the `/pickle-pipeline` skill has no scope auto-inference at launch time.
- Open Finding #13 (P1, **pipeline-killer**): `microverse-runner.ts:probeJudgeCliAvailability` runs `claude --version` with a 50ms timeout AND collapses `ETIMEDOUT` / `ENOENT` / other into one `{ok:false}` boolean. The caller maps any failure to `judge_cli_missing`, which `pipeline-runner.ts:1670` honors as a hard no-finalize-gate exit. In this session anatomy-park converged green at 33m03s with 7 CRITICAL fixes shipped, then szechuan-sauce died at `attempts: 0` inside its baseline probe — the 4-attempt backoff loop never even ran. Smoking gun: `microverse-runner.log` literally records `spawnSync claude ETIMEDOUT` while classifying the failure as `judge_cli_missing`. Single-file fix in `microverse-runner.ts` + regression test + trap-door.

Finding #12 detail: the operator's kickoff prompt named a branch (`gregory/loa-763-shadow-audit-diff-writer`), said "Scope: API-only", and listed a bounded deliverable surface — but the skill treats `--scope`/`--scope-base` as strictly literal-flag-only and wrote a scopeless `pipeline.json`. Anatomy-park self-targeted by luck (citadel's findings happened to all live in `shadow-audit-diff/`); szechuan-sauce was queued unscoped against the entire `packages/api/` tree. Recovery required a 6-step manual state patch (pipeline.json + state.json + pipeline-status.json + tmux pane 0 respawn). Sister to Finding #11: same structural problem (scope under-applied) at different lifecycle stages — Finding #11 is **edit-time** leak; Finding #12 is **launch-time** silence.

Two ad-hoc items earned their way into this bundle:
- **Finding #5** (subsystem CLAUDE.md drift) — partial; only `extension/src/types/CLAUDE.md` was created during anatomy-park; the other 4 subsystems may also be missing them.
- **Followup #16** (`readRecoverableJsonObject` `readdirSync` cost) — `assertBackendPreSpawn` still does one slow read on macOS where `/var/folders/.../T` has 70k+ entries; cleanest follow-up to `67ae0348`.

Slots K and L are queued to drain the open-bug ceiling: K's output is research → follow-up PRD (no fix lands this run); L removes ~480 LOC of defense-in-depth (cron sampler already stripped at `c2ec3cf1`; mux pre-flight, scheduled finalizer, launch-gate verifier remain).

This bundle composes 9 fix sections + bootstrap + closer into a single unattended `/pickle-pipeline --no-refine --backend claude` run. Backend MUST be `claude`. **Slot G IS the codex hallucination root cause** — running this bundle on `--backend codex` would reproduce the very defect it fixes. Predecessor bundle session `2026-05-08-d6f98b66` ran on claude precisely for this reason; that decision stands.

## Refinement: SKIPPED (quick-refine via parallel Agent fan-out)

`refine: false`. Each fix section maps 1:1 to either (a) an existing source PRD with R-codes already enumerated (G/H/11/K/L), or (b) a self-contained additive fix specified in this PRD with R-codes inline (5/16). The full 3-cycle refinement team would re-scope work that's already crisp. Quick-refine workflow (validated 2026-05-06 9-ticket pipeline + 2026-05-08 5-ticket pipeline) authors atomic tickets in ~2 min via parallel `Agent` fan-out, lifting ACs verbatim from peer PRDs.

Operator override: drop `--no-refine` from the launch command if a section proves under-specified mid-run. Not expected.

## Per-section disposition table — R-BUNDLE-DISPO-2026-05-08-mega

| Section | Slot / Finding | R-codes | Source PRD | Disposition |
|---|---|---|---|---|
| **A** | Bundle bootstrap | R-BUNDLE-1, R-BUNDLE-DISPO | this PRD § A | **IMPLEMENT** — bootstrap flags + disposition file |
| **B** | Slot G — codex classifier prompt leak | R-CCPL-1..6 *(=source R1..R6)* | `prds/archive/bug-reports/codex-classifier-prompt-leak.md` | **IMPLEMENT** — all 6 reqs from source PRD |
| **C** | Slot H — szechuan judge model | R-SCJM-1..6 *(=source AC-SCJM-01..06)* | `prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md` | **IMPLEMENT** — all 6 ACs from source PRD |
| **D** | Open Finding #11 — anatomy-park scope.json edit-time preflight | R-APWS-1..7 | `prds/archive/bug-reports/p2-anatomy-park-worker-edits-bypass-scope-allowlist.md` | **IMPLEMENT** — F1+F2+F3 from source PRD; R-codes assigned in this PRD |
| **E** | Open Finding #12 — `/pickle-pipeline` launch-time scope auto-inference | R-PSAI-1..7 *(=source AC-PSAI-01..07)* | `prds/archive/bug-reports/p2-pickle-pipeline-no-scope-auto-inference.md` | **IMPLEMENT** — all 7 ACs from source PRD; sibling to Section D |
| **F** | Followup #16 — recoverable-json readdir bound | R-RJR-1..3 *(NEW)* | this PRD § F | **IMPLEMENT** — readdirSync filter + perf regression test |
| **G** | Open Finding #5 — subsystem CLAUDE.md drift audit | R-CMD-1..4 *(NEW)* | this PRD § G | **IMPLEMENT** — audit-only, files follow-up tickets per drift class |
| **H** | Slot K — pkgjson version-only revert diagnosis | R-PJV-1..6 | `prds/archive/bug-reports/p1-deployed-pkgjson-version-only-revert.md` | **DIAGNOSE** — no fix ships from this section; output is research artifact + follow-up PRD |
| **I** | Slot L — strip excessive defense | R-SED-1..7 *(carries source PRD's strip list)* | `prds/p1-strip-excessive-defense-deploy-reversion.md` | **IMPLEMENT** — mux pre-flight + scheduled finalizer + launch-gate verifier removal |
| **J** | Open Finding #13 — microverse judge probe ETIMEDOUT misclassification | R-MJCP-1..8 *(=source PRD verbatim)* | `prds/archive/bug-reports/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md` | **IMPLEMENT** — discriminated probe result + 5000ms default + shared `classifyJudgeError` helper; pipeline-killer fix |
| **K** | Closer | R-CLOSER-1..3 | this PRD § K | **IMPLEMENT** — version bump + deploy parity + (optional) gh release |

Section ordering rationale: G (highest blast-radius defect) before H (judge fix only matters if codex pipelines run). 11 (edit-time scope) immediately before 12 (launch-time scope) because they share R-APWS / R-PSAI plumbing and the worker-side preflight (R-APWS-1) is a natural building block for the operator-side `lock-scope.js` recovery action (R-PSAI-4). 16 (perf, low risk) and 5 (audit) sandwiched between scope work and Slot K so the audit's child-ticket overhead doesn't bottleneck downstream fix sections. K (diagnosis) before L (LOC removal) so K's research artifacts are written before L touches the same general defense-in-depth area. L before #13 because the strip touches `services/`-level files while #13 touches `bin/microverse-runner.ts` (no overlap; sequential ordering keeps merge conflicts minimal). #13 last among fix sections so the smallest, hottest pipeline-killer fix lands against an otherwise-stable base — closer (Section K) deploys the bundle including #13 in one shot. Closer last.

## Pre-flight — REQUIRED before launch

These checks must all be green before `/pickle-pipeline` is invoked. Bundle does NOT implement them; operator runs them as gating steps.

1. **Open Finding #10 deploy parity.** `bash install.sh` to deploy `232f3d26`. Blocked while anatomy-park session `2026-05-08-5d60b760` (loanlight-api) is active. Either wait for that session to complete OR pass `bash install.sh --override-active` (R-ITS-5-MIN forensic risk acknowledged). Verify: `md5sum extension/services/convergence-gate.js ~/.claude/pickle-rick/extension/services/convergence-gate.js` must match. (See `extension/CLAUDE.md` R-ITS-5-MIN guard rationale.)
2. **Working-tree quarantine.** Current dirty paths from a sister session (`prds/MASTER_PLAN.md`, `prds/archive/bug-reports/p2-anatomy-park-worker-edits-bypass-scope-allowlist.md`) belong to the loanlight-api anatomy-park session — leave them alone. Either commit them on a branch the bundle won't touch, or `git stash --keep-index` against this bundle's launch.
3. **Active session inventory.** `jq -r '.active' ~/.local/share/pickle-rick/sessions/*/state.json | sort -u` must show only `false` and possibly the about-to-launch session. The pipeline `--unattended` launch creates a new session; pre-existing `active=true` entries from sister sessions are tolerated only when not pickle-rick-claude-targeted.
4. **Production gate baseline.** `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1` must be clean at HEAD. Current expected state per MASTER_PLAN: TypeScript clean, ESLint clean, trap-door audit at 121 ENFORCE refs.
5. **Source / deployed parity probe.** Run `md5sum extension/types/index.js extension/services/state-manager.js extension/bin/spawn-morty.js extension/bin/mux-runner.js extension/services/pickle-utils.js` and compare against deployed. The R-ITS-2 parity probe inside `install.sh` covers this on its happy path; pre-launch reverify mitigates a slow-second-mtime cache-miss class.

## Section A — Bundle bootstrap *(FIRST)*

| Req | Description |
|---|---|
| **R-BUNDLE-1** | `state.flags.bundle_bootstrap_mode = "2026-05-08-mega"` with the new session-hash allowlist; auto-applies BOTH `skip_readiness_reason` AND `skip_ticket_audit_reason` for THIS bundle's launch only. Activity event `bundle_bootstrap_exemption_applied` records `{bundle_id, session_hash, flags}`. |
| **R-BUNDLE-DISPO** | The disposition table above is committed at `extension/src/data/bundle-disposition-2026-05-08-mega.json`. R-TAQ-2 audit-ticket-bundle reads this file. Exempts disposition `DIAGNOSE` (Section H is research-only; no implementation tickets ship). |

**Section A — Acceptance Criteria**

- **AC-A-01** — `bundle-disposition-2026-05-08-mega.json` exists, schema-valid against `extension/src/data/bundle-disposition.schema.json`.
- **AC-A-02** — Audit-ticket-bundle on this session's tickets exits 0 (or only with non-fatal warnings); the `DIAGNOSE` disposition for Section H is recognized.
- **AC-A-03** — Activity event `bundle_bootstrap_exemption_applied` records `bundle_id="2026-05-08-mega"`.

**Files in scope**: `extension/src/data/bundle-disposition-2026-05-08-mega.json` *(NEW)*, `extension/src/data/bundle-disposition.schema.json` (extend `disposition` enum to include `DIAGNOSE` if not present), `extension/src/services/state-manager.ts` (allowlist), `extension/src/services/audit-ticket-bundle.ts` (recognize new bundle id + DIAGNOSE).

## Section B — Slot G — Codex classifier prompt leak *(SECOND — closes Open Finding #1 if not already closed by predecessor session)*

> **Note on closure status.** MASTER_PLAN.md line 55 lists Open Finding #1 as "✅ CLOSED by 2026-05-07-deferred-slots bundle Slot G (R-CCPL-1..6)" but inspection of session `2026-05-08-d6f98b66`'s ticket-set shows only Sections D/E/K/L + Closer shipped (5 tickets); Sections B+C never ran. The MASTER_PLAN bookkeeping is therefore optimistic-pending. This section implements the work for real.

Source: `prds/archive/bug-reports/codex-classifier-prompt-leak.md` (read in full; commit hash referenced in PR body of each ticket). All 6 source requirements R1..R6 are inherited verbatim and renamed `R-CCPL-1..6` for disposition-table consistency.

| Req | Description |
|---|---|
| **R-CCPL-1** *(=source R1)* | `extractAssistantContent` distinguishes prompt content from model response in codex plain-text logs. |
| **R-CCPL-2** *(=source R2)* | `classifyCompletion` returns `'task_completed'` only when the model's response contains the EPIC_COMPLETED token. Prompt content (e.g. `<promise>EPIC_COMPLETED</promise>` echoed from the worker template) MUST NOT trigger task_completed. |
| **R-CCPL-3** *(=source R3)* | Worker template files contain no classifier-matched promise token in unbroken substring form. Authoritative blocklist sourced from `extension/src/hooks/handlers/stop-hook.ts:170-183` (or a shared constants module both files import). |
| **R-CCPL-4** *(=source R4)* | Codex output format is detected explicitly via the block-delimiter rule, not via "stream-json failed → assume plain-text." Fail-loud on delimiter drift. |
| **R-CCPL-5** *(=source R5)* | Regression tests cover all 6 fixtures from source PRD § "Test Expectations" (`codex-prompt-leak`, `codex-real-completion`, `codex-ticket-selected`, `claude-stream-json`, `claude-real-completion`, `mixed-json-noise`). |
| **R-CCPL-6** *(=source R6)* | All-tickets-pending guard error message includes the iteration log path. |

**Section B — Acceptance Criteria**

- **AC-CCPL-01..06** *(=source PRD § Verification table, one per requirement)* — covered by `extension/tests/mux-runner-classifier.test.ts`, `extension/tests/template-no-bare-tokens.test.ts`, `extension/tests/mux-runner-guard-logging.test.ts` per source verification table.
- **AC-CCPL-07** — Deployed templates (`~/.claude/commands/{pickle,meeseeks,szechuan-sauce,microverse,pickle-tmux}.md`) post-`bash install.sh` contain zero unbroken `<promise>[A-Z_]*</promise>` substrings outside HTML comments.
- **AC-CCPL-08** — Trap-door entry in `extension/CLAUDE.md`: "Codex plain-text classifier MUST detect via block delimiters; stream-json fallback MUST require ≥1 `type:\"assistant\"` JSON line." ENFORCE: `extension/tests/mux-runner-classifier.test.ts`.

**Files in scope**: `extension/src/bin/mux-runner.ts` (extractAssistantContent + classifier), `extension/src/services/promise-tokens.ts` *(NEW; shared constants module per source PRD § Coupling)*, `.claude/commands/{pickle,meeseeks,szechuan-sauce,microverse,pickle-tmux}.md` (substring-broken token forms), `install.sh` (template macro substitution if R-CCPL-3 chooses the macro variant), tests as listed in source PRD.

## Section C — Slot H — Szechuan judge model claude-routed *(THIRD)*

Source: `prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md` (read in full). All 6 ACs inherited verbatim and renamed `R-SCJM-1..6`.

| Req | Description |
|---|---|
| **R-SCJM-1** *(=source AC-SCJM-01)* | Locate the call site that selects `claude-sonnet-4-6` as judge model for codex backend. Grep `extension/src/` for the literal `claude-sonnet-4-6`. Document call site in PR description. (Operator-cited site is `extension/src/bin/init-microverse.ts:13` — verify it's still the only one.) |
| **R-SCJM-2** *(=source AC-SCJM-02)* | Refactor `microverse-runner.ts` (and helpers) to always spawn the LLM judge via the claude path, even when `--backend codex` is set. Worker iteration spawn continues to honor `--backend codex`. |
| **R-SCJM-3** *(=source AC-SCJM-03)* | Convergence guard: before declaring convergence in `microverse-runner.ts:~640`, assert `convergence.history.length >= min_iterations` AND ≥1 history entry has a non-null `score`. If neither holds, exit `judge_unreachable` with non-zero process exit code. `pipeline-runner.ts` surfaces `judge_unreachable` distinctly from `converged`. |
| **R-SCJM-4** *(=source AC-SCJM-04)* | Integration test `extension/tests/integration/microverse-runner-judge-failure.test.js`: stub judge spawn to throw the literal `'claude-sonnet-4-6' model is not supported when using Codex with a ChatGPT account` error twice; assert `judge_unreachable` + non-zero exit. |
| **R-SCJM-5** *(=source AC-SCJM-05)* | Trap-door in `extension/CLAUDE.md`: judge LLM spawn MUST be claude-routed regardless of `--backend`. PATTERN_SHAPE: forbid `model:\s*claude-` or `--model\s+claude-` in any codex spawn site outside the worker iteration codepath. ENFORCE: `extension/tests/integration/microverse-runner-judge-failure.test.js`. |
| **R-SCJM-6** *(=source AC-SCJM-06)* | `pipeline-runner.ts` does NOT spawn `finalize-gate` when microverse exits with `judge_unreachable`; pipeline reports szechuan as failed and stops. |

**Section C — Acceptance Criteria** — `AC-SCJM-01..06` lifted verbatim from source PRD.

**Files in scope**: `extension/src/bin/microverse-runner.ts`, `extension/src/services/microverse/` (judge-spawn helper if extracted), `extension/src/services/codex-spawn.ts`, `extension/src/bin/init-microverse.ts:13`, `extension/src/bin/pipeline-runner.ts` (judge_unreachable handling), tests as above, `extension/CLAUDE.md`.

## Section D — Open Finding #11 — Anatomy-park worker scope.json preflight *(FOURTH — P2)*

Source: `prds/archive/bug-reports/p2-anatomy-park-worker-edits-bypass-scope-allowlist.md`. Source PRD enumerates F1/F2/F3 fix sections without R-codes; this bundle assigns `R-APWS-1..7` for disposition-table consistency.

| Req | Description |
|---|---|
| **R-APWS-1** *(=source F1)* | `extension/bin/check-scope-diff.js` (NEW) — preflight script that compares `git diff --staged --name-only` against `scope.json:allowed_paths`; exits 0 when all staged paths are in allowlist; exits 1 with structured error JSON when any staged path is outside. Stdin: optional `{scope_json_path, head_ref}`; defaults to `<session>/scope.json` and `HEAD`. |
| **R-APWS-2** *(=source F1 cont'd)* | Worker prompt template (`anatomy-park.md`, `szechuan-sauce.md`) gains a `Phase 2 step 4.5` block: when `scope.json` exists in the session root, the worker MUST run `node ~/.claude/pickle-rick/extension/bin/check-scope-diff.js` before `git commit`; on exit code 1 the worker MUST surface the cross-scope coupling as an anatomy-park finding (or szechuan principle violation) rather than committing it. |
| **R-APWS-3** *(=source F2)* | New activity event `worker_edit_outside_scope` registered in `extension/src/types/index.ts` `VALID_ACTIVITY_EVENTS` + `activity-events.schema.json` + payload-test fixture + count-assertion + deployed mirror (full registration quartet). Payload: `{ticket_id, scope_json_path, staged_paths_outside_scope: string[], head_ref, suggested_remediation}`. |
| **R-APWS-4** *(=source F2 cont'd)* | `/pickle-status` surfaces `worker_edit_outside_scope` events from the current session as a top-level "Scope drift" line. |
| **R-APWS-5** *(=source F3)* | Anatomy-park.md Phase 2 step 4.5 + szechuan-sauce.md analogous step are committed; deployed `~/.claude/commands/{anatomy-park,szechuan-sauce}.md` post-`install.sh` contain the new step. |
| **R-APWS-6** *(NEW)* | Trap-door entry in `extension/CLAUDE.md`: "When `scope.json` exists in session root, every worker `git commit` MUST be preceded by `check-scope-diff.js`. Cross-scope coupling discovered in pre-stage is a *finding*, not a commit." ENFORCE: `extension/tests/check-scope-diff-preflight.test.js`. |
| **R-APWS-7** *(NEW)* | Regression test `extension/tests/check-scope-diff-preflight.test.js` covers: (a) all paths inside allowlist → exit 0, (b) one path outside allowlist → exit 1 + structured error, (c) no scope.json → exit 0 (no-op), (d) malformed scope.json → exit 2 + clear error. |

**Section D — Acceptance Criteria**

- **AC-APWS-01..07** — one per requirement, mapped to: `extension/tests/check-scope-diff-preflight.test.js` (R-APWS-1, R-APWS-7), worker-template-text test `extension/tests/worker-templates-include-scope-preflight.test.js` *(NEW)* (R-APWS-2, R-APWS-5), event-registration tests `extension/tests/activity-event-payload.test.js` + count-assertion (R-APWS-3), `/pickle-status` test `extension/tests/pickle-status-scope-drift.test.js` *(NEW)* (R-APWS-4), trap-door-conformance.test.js (R-APWS-6).

**Files in scope**: `extension/src/bin/check-scope-diff.ts` *(NEW)*, `.claude/commands/anatomy-park.md`, `.claude/commands/szechuan-sauce.md`, `extension/src/types/index.ts`, `extension/src/data/activity-events.schema.json`, `extension/tests/fixtures/activity-event-payloads/worker_edit_outside_scope.json` *(NEW)*, `extension/src/bin/pickle-status.ts`, `extension/CLAUDE.md`, tests as above.

## Section E — Open Finding #12 — `/pickle-pipeline` launch-time scope auto-inference *(FIFTH — P2)*

Source: `prds/archive/bug-reports/p2-pickle-pipeline-no-scope-auto-inference.md` (read in full). Sibling of Section D — Section D fixes the **edit-time** leak after scope is set; this section fixes the **launch-time** silence that lets scope go unset when the operator's kickoff prompt names a branch / subset. Source PRD enumerates `R-PSAI-1..7`; this bundle inherits them verbatim.

| Req | Description |
|---|---|
| **R-PSAI-1** *(=source AC)* | Scope auto-inference clause in `/pickle-pipeline` Step 0 (or new Step 0.6). Regex matches branch-name / "API-only" / no-cross-repo phrasings + non-default-branch context. When matched AND `--scope` not passed, single AskUserQuestion: `branch` / `paths:<auto-extracted>` / `none (proceed unscoped)`. MUST NOT silently flip scope on. |
| **R-PSAI-2** *(=source AC)* | Step 8 report MUST surface resolved scope: `Scope: <branch \| paths:<list> \| unscoped>` + `allowed_paths: <N>` + `refresh: per non-pickle phase`. When unscoped, append `⚠ scope: unscoped — anatomy-park and szechuan-sauce will operate on the entire target directory.` |
| **R-PSAI-3** *(=source AC)* | Pre-launch safety prompt when target is git repo on non-default branch with ≥1 commit ahead AND `--scope` not passed. Single AskUserQuestion: "Target is on branch `<X>` with `<N>` commits ahead of `<default>`. Lock pipeline to branch diff, or proceed unscoped?" with options `Lock to branch (Recommended)` / `Proceed unscoped (with reason)`. |
| **R-PSAI-4** *(=source AC)* | New `extension/bin/lock-scope.js <session-root> --mode branch [--scope-base main]` mid-flight recovery action. Validates session is paused (no live `pipeline-runner.js` PID); patches `pipeline.json`, `state.json` (`active: true`, `step: <next>`, `worker_timeout_seconds: <restored>`, `exit_reason: null`), and `pipeline-status.json` (`status: running`, `current_phase: <next>`, `completed_phases: <preserved>`). Prints resumed launch command. Collapses 6-step manual patch to one command. |
| **R-PSAI-5** *(=source AC)* | `extension/src/services/pickle-utils.ts:ensureMonitorWindow` MUST re-respawn pane 0 on resume. Extend `startRespawnWatchdog` to poll pane 0 (verify which panes it polls today and harden). Confirmed-dead pane 0 (`pane_current_command !== 'node'`) MUST respawn within 30s regardless of phase-transition events. |
| **R-PSAI-6** *(=source AC)* | `PRD_GUIDE.md` and `COMMANDS.md` document the auto-inference clause + safety prompt + `lock-scope.js` recovery action. Operator-facing line: "Naming a branch in your kickoff prompt is enough — the skill will ask. Use `--scope branch` to skip the prompt." |
| **R-PSAI-7** *(=source AC)* | Regression test `extension/tests/integration/pickle-pipeline-scope-inference.test.js` covers 6 cases: branch-named kickoff, "API-only" kickoff, `--scope` already passed (auto-inference skipped), no-signal default-branch kickoff (no prompt), non-default-branch + ≥1 ahead + no-scope (safety prompt fires), operator picks "unscoped" (audit log line present). |

**Section E — Acceptance Criteria** — `AC-PSAI-01..07` lifted verbatim from source PRD § Acceptance Criteria. Plus three trap-door tests already enumerated in source PRD § Trap doors:

- **AC-PSAI-08** *(=source trap-door 1)* — `extension/tests/skill-prompt-shape/pickle-pipeline-scope-inference-clause.test.js` greps deployed `pickle-pipeline.md` for the regex tokens + AskUserQuestion call.
- **AC-PSAI-09** *(=source trap-door 2)* — `extension/tests/integration/monitor-pane-zero-watchdog.test.js` simulates mid-run pane-0 exit, asserts respawn within 30s.
- **AC-PSAI-10** *(=source trap-door 3)* — `extension/tests/integration/lock-scope-rejects-live-runner.test.js` asserts `lock-scope.js` refuses to run while `pipeline-runner.js` PID is alive.

**Files in scope**: `.claude/commands/pickle-pipeline.md` (Step 0.6 auto-inference + Step 8 scope-surfacing), `extension/src/bin/lock-scope.ts` *(NEW)*, `extension/src/services/pickle-utils.ts` (pane 0 respawn watchdog), `PRD_GUIDE.md`, `COMMANDS.md`, `extension/tests/integration/pickle-pipeline-scope-inference.test.js` *(NEW)*, `extension/tests/integration/monitor-pane-zero-watchdog.test.js` *(NEW)*, `extension/tests/integration/lock-scope-rejects-live-runner.test.js` *(NEW)*, `extension/tests/skill-prompt-shape/pickle-pipeline-scope-inference-clause.test.js` *(NEW)*.

## Section F — Followup #16 — recoverable-json readdir bound *(SIXTH — perf)*

This section is a self-contained perf fix; no source PRD. R-codes assigned inline.

| Req | Description |
|---|---|
| **R-RJR-1** | `readRecoverableJsonObject(basePath)` in `extension/src/services/recoverable-json.ts` MUST filter `readdirSync` results by literal `path.basename(basePath) + '.tmp.'` prefix BEFORE the per-entry stat / open. Pre-fix, every call enumerates the full parent directory; on macOS where `/var/folders/.../T` accumulates 70k+ entries, each call costs ~6.7s. |
| **R-RJR-2** | Cache the prefix as a closure-captured constant (or pass-through arg). No behavior change; only filtered enumeration. |
| **R-RJR-3** | Perf regression test `extension/tests/recoverable-json-readdir-bound.test.js`: synthetic parent dir with 10k decoy entries + 1 matching tmp; assert call wall-clock < 50ms (margin: macOS ext_attr stat ~~ 20µs × 10k ~ 200ms uncached; filtered access < 10ms). Test gated on `process.platform === 'darwin'` to avoid Linux noise. |

**Section F — Acceptance Criteria**

- **AC-RJR-01** — `recoverable-json.ts` `readdirSync` callsite filters by prefix; verified by line-anchored snapshot test.
- **AC-RJR-02** — `recoverable-json-readdir-bound.test.js` passes; wall-clock under threshold on macOS.
- **AC-RJR-03** — `assertBackendPreSpawn` (which calls `_sm.read()` → indirectly `readRecoverableJsonObject`) does not regress in `extension/tests/spawn-morty-readiness.test.js` timing assertions (existing).

**Files in scope**: `extension/src/services/recoverable-json.ts`, `extension/tests/recoverable-json-readdir-bound.test.js` *(NEW)*.

## Section G — Open Finding #5 — Subsystem CLAUDE.md drift audit *(SEVENTH — audit-only)*

This section audits the 5 subsystems under `extension/src/` for missing or stale `CLAUDE.md` files; remediation tickets are filed as follow-ups, NOT shipped here. Bounded scope = audit + drift-classification report; prevents this section from blowing the bundle's wall-clock budget.

| Req | Description |
|---|---|
| **R-CMD-1** | For each of `extension/src/{bin,hooks,lib,services,types}/`, check existence of `CLAUDE.md`. Audit script `extension/scripts/audit-subsystem-claude-md.sh` (NEW) emits structured report `extension/audit/subsystem-claude-md-2026-05-08.json`: `[{subsystem, has_claude_md, last_modified_iso, file_count, drift_class}]`. |
| **R-CMD-2** | Drift classification per subsystem: `MISSING` (no CLAUDE.md), `STALE` (CLAUDE.md older than newest source file by >7 days), `INCOMPLETE` (CLAUDE.md exists but covers <50% of public exports), `OK` (otherwise). |
| **R-CMD-3** | For each `MISSING` / `STALE` / `INCOMPLETE` subsystem, file a follow-up PRD `prds/p3-subsystem-claude-md-<name>.md` with: enumeration of public exports, suggested invariants, suggested trap-door entries. PRDs are DRAFT; not refined; not in this bundle. |
| **R-CMD-4** | Trap-door entry in `extension/CLAUDE.md`: "Each `extension/src/<subsystem>/` directory MUST have a `CLAUDE.md` documenting public exports + invariants. Drift class `OK` enforced by `extension/scripts/audit-subsystem-claude-md.sh`." ENFORCE: `extension/tests/audit-subsystem-claude-md.test.js`. |

**Section G — Acceptance Criteria**

- **AC-CMD-01** — Audit script exists and runs cleanly; emits the JSON report.
- **AC-CMD-02** — Per-subsystem follow-up PRDs filed under `prds/p3-subsystem-claude-md-*.md` for every non-OK subsystem.
- **AC-CMD-03** — Trap-door entry committed; conformance test passes.
- **AC-CMD-04** — `extension/audit/subsystem-claude-md-2026-05-08.json` is committed (small enough to track; not generated artifact).

**Out of scope (this bundle)**: actually authoring the missing CLAUDE.md files. That work is the follow-up PRDs' responsibility; ranked P3 because it's documentation, not bug-fix.

**Files in scope**: `extension/scripts/audit-subsystem-claude-md.sh` *(NEW)*, `extension/audit/subsystem-claude-md-2026-05-08.json` *(NEW)*, `extension/tests/audit-subsystem-claude-md.test.js` *(NEW)*, `extension/CLAUDE.md`, `prds/p3-subsystem-claude-md-*.md` *(NEW, one per non-OK subsystem)*.

## Section H — Slot K — Deployed pkgjson version-only revert *(EIGHTH — diagnosis-only, P1)*

Source: `prds/archive/bug-reports/p1-deployed-pkgjson-version-only-revert.md` (read in full). Disposition is `DIAGNOSE`: this section runs the H-A..H-E hypothesis triage and emits a research artifact + follow-up fix PRD. **No fix code ships from this section.** That keeps the closer (Section K) free from a half-diagnosed change.

| Req | Description |
|---|---|
| **R-PJV-1** *(=source FR-1)* | Capture forensic state for the next observable revert event: `extension/scripts/capture-pkgjson-revert-forensic.sh` (NEW) snapshots `extension/package.json`, deployed `~/.claude/pickle-rick/extension/package.json`, the 5 most-trafficked compiled-JS files' content hashes, the install-audit log tail, and `git log --since='1 hour ago' -- extension/package.json` into `extension/audit/pkgjson-revert-<iso>.json`. |
| **R-PJV-2** *(=source FR-2)* | `extension/scripts/audit-pkgjson-writers.sh` (NEW) greps `extension/`, `~/.claude/pickle-rick/`, `~/.claude/`, and the npm/yarn cache dirs for any process or file that writes `package.json:version` without touching content fields. Output: structured list of suspected writers ranked by recency. |
| **R-PJV-3** *(=source FR-3)* | Triage report `extension/audit/pkgjson-revert-triage-2026-05-08.md` (NEW) walks H-A..H-E hypotheses: H-A npm install accidental write, H-B install.sh jq merge bug, H-C auto-update path, H-D cron sampler residue (mostly stripped at `c2ec3cf1`; verify), H-E external editor (Cursor/VS Code) reformat. Each hypothesis: status `confirmed / disproven / inconclusive` + one-line evidence anchor. |
| **R-PJV-4** *(=source FR-4 / Sequencing)* | Follow-up fix PRD `prds/p1-pkgjson-revert-<top-hypothesis>.md` filed with: confirmed root cause, atomic fix plan, regression test outline. PRD is DRAFT; not refined; not in this bundle. |
| **R-PJV-5** *(NEW)* | Activity event `pkgjson_revert_forensic_captured` registered with full quartet (types, schema, fixture, count). Payload: `{forensic_artifact_path, suspected_hypothesis, src_version, deployed_version}`. |
| **R-PJV-6** *(NEW)* | Trap-door entry: "Until R-PJV-4 follow-up ships, `install.sh` MUST log `pkgjson_revert_forensic_captured` whenever `extension/package.json:version` is bumped without `git commit` parentage." ENFORCE: `extension/tests/install-pkgjson-version-trace.test.js`. |

**Section H — Acceptance Criteria**

- **AC-PJV-01** — Forensic capture script exists, runs cleanly on demand, writes JSON to `extension/audit/`.
- **AC-PJV-02** — Writer audit script exists, ranks suspects.
- **AC-PJV-03** — Triage report committed with per-hypothesis status.
- **AC-PJV-04** — Follow-up PRD filed; status `Draft`; references the triage report.
- **AC-PJV-05** — Activity event registered; payload schema validates.
- **AC-PJV-06** — Trap-door committed; conformance test passes.

**Files in scope**: `extension/scripts/capture-pkgjson-revert-forensic.sh` *(NEW)*, `extension/scripts/audit-pkgjson-writers.sh` *(NEW)*, `extension/audit/pkgjson-revert-triage-2026-05-08.md` *(NEW)*, `extension/src/types/index.ts`, `extension/src/data/activity-events.schema.json`, `extension/tests/fixtures/activity-event-payloads/pkgjson_revert_forensic_captured.json` *(NEW)*, `extension/tests/install-pkgjson-version-trace.test.js` *(NEW)*, `extension/CLAUDE.md`, `prds/p1-pkgjson-revert-<top-hypothesis>.md` *(NEW)*.

## Section I — Slot L — Strip excessive defense *(NINTH — ~480 LOC removal, P1)*

Source: `prds/p1-strip-excessive-defense-deploy-reversion.md` (read in full). Cron sampler stripped at `c2ec3cf1` 2026-05-02 (verify in this section's R-SED-7). Remaining strip targets: mux pre-flight verifier, scheduled finalizer, launch-gate verifier, and their tests/wiring.

| Req | Description |
|---|---|
| **R-SED-1** *(=source PRD § Strip — A)* | Remove mux-runner pre-flight verifier (`extension/src/services/mux-preflight-verifier.ts` + wiring in `mux-runner.ts`). ~140 LOC. Replaced by the existing post-rsync md5-parity probe in `install.sh` (R-ITS-2) which is the actual defense layer that catches the deploy-parity class. |
| **R-SED-2** *(=source PRD § Strip — B)* | Remove scheduled finalizer (`extension/src/services/scheduled-finalizer.ts` + cron entries in `extension/scripts/install-cron.sh`). ~120 LOC. Replaced by the in-process finalizer that already runs at pipeline exit. |
| **R-SED-3** *(=source PRD § Strip — C)* | Remove launch-gate verifier (`extension/src/services/launch-gate-verifier.ts` + invocations in `setup.ts` / `pipeline-runner.ts`). ~110 LOC. Replaced by the existing readiness-gate machinery (`check-readiness.ts`). |
| **R-SED-4** *(=source PRD § Strip — D)* | Remove tests that exclusively cover the stripped components (`extension/tests/mux-preflight-verifier.test.js`, `extension/tests/scheduled-finalizer.test.js`, `extension/tests/launch-gate-verifier.test.js`). Keep tests that exercise the *replacement* defenses (md5-parity probe test, readiness-gate test). |
| **R-SED-5** *(=source PRD § Keep — invariant)* | Verify the kept defenses (R-ITS-2 md5-parity probe, in-process finalizer, readiness-gate) are end-to-end covered by tests at HEAD. If any gap, file a follow-up ticket; do NOT block this section. |
| **R-SED-6** *(NEW)* | Activity events emitted by stripped components are removed from `VALID_ACTIVITY_EVENTS`: `mux_preflight_verifier_*`, `scheduled_finalizer_*`, `launch_gate_verifier_*`. Schema + count-assertion + deployed mirror updated. |
| **R-SED-7** *(NEW)* | Verify `c2ec3cf1` actually stripped the cron sampler — `git log --oneline c2ec3cf1 -- extension/src/services/cron-sampler.ts` should show the deletion. If sampler still exists in any form, include its removal here. |

**Section I — Acceptance Criteria**

- **AC-SED-01** — `mux-preflight-verifier.ts`, `scheduled-finalizer.ts`, `launch-gate-verifier.ts` removed from `extension/src/services/`. Wiring in callers also removed.
- **AC-SED-02** — Tests exclusive to stripped components removed; replacement-defense tests still pass.
- **AC-SED-03** — `VALID_ACTIVITY_EVENTS` count reduced by N (where N = number of removed events); count-assertion test updated.
- **AC-SED-04** — `npm run test:fast` passes at HEAD after the removal.
- **AC-SED-05** — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1` clean after removal.
- **AC-SED-06** — Cron sampler verified absent (R-SED-7).
- **AC-SED-07** — Trap-door entries for the stripped components are removed from `extension/CLAUDE.md` (no orphaned ENFORCE refs).

**Files in scope**: `extension/src/services/{mux-preflight-verifier,scheduled-finalizer,launch-gate-verifier}.ts` *(REMOVED)*, `extension/src/bin/mux-runner.ts` (wiring), `extension/src/bin/setup.ts` (wiring), `extension/src/bin/pipeline-runner.ts` (wiring), `extension/scripts/install-cron.sh`, `extension/src/types/index.ts` (event removal), `extension/src/data/activity-events.schema.json`, count-assertion test, `extension/CLAUDE.md` (trap-door cleanup), `extension/tests/{mux-preflight-verifier,scheduled-finalizer,launch-gate-verifier}.test.js` *(REMOVED)*.

## Section J — Open Finding #13 — Microverse judge probe ETIMEDOUT misclassification *(TENTH — P1 pipeline-killer)*

Source: `prds/archive/bug-reports/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md` (read in full). All 8 reqs `R-MJCP-1..8` lifted verbatim.

The probe at `extension/src/bin/microverse-runner.ts:1354–1367` runs `claude --version` with `timeout: 50` (milliseconds — below the macOS dyld+V8 cold-start floor) and collapses every error path into `{ ok: false }`. The caller (`measureLlmMetricWithBackoff`, lines 1378–1387) maps that uniformly to `exitReason: 'judge_cli_missing'` — even when the actual error is `ETIMEDOUT`. `pipeline-runner.ts:1670` correctly treats `judge_cli_missing` as no-finalize-gate (the contract is right when the CLI is genuinely absent), but here the misclassification is upstream and the runner faithfully amplifies it. Smoking gun: `attempts: 0` in the runner's exit log — the existing 4-attempt backoff loop (which already classifies `judge_timeout` correctly) never executed.

| Req | Description |
|---|---|
| **R-MJCP-1** | `probeJudgeCliAvailability` returns a discriminated union `{ kind: 'ok' \| 'missing' \| 'timeout' \| 'failed', message? }`, not a boolean. Caller short-circuits to `judge_cli_missing` ONLY for `kind: 'missing'`. For `'timeout'` or `'failed'`, fall through to the existing 4-attempt backoff loop with its own (longer) timeouts. |
| **R-MJCP-2** | Default probe timeout = **5000 ms** (≥ macOS cold-start floor). Configurable via `PICKLE_JUDGE_PROBE_TIMEOUT_MS` (positive integer, clamp ≤ 60000ms, log when override applied). ENOENT still returns ~10ms — the higher cap doesn't slow the genuinely-missing-CLI path. |
| **R-MJCP-3** | Extract shared `classifyJudgeError(err): 'missing' \| 'timeout' \| 'failed'` helper from existing `measureLlmMetricAttempt` lines 1346–1349. Both `probeJudgeCliAvailability` and `measureLlmMetricAttempt` MUST call it. No duplicate `isMissingCliError(...) ? ... : /ETIMEDOUT/.test(...) ? ...` branches in the file. |
| **R-MJCP-4** | **Pipeline-runner unchanged.** No new exit reasons. The fix lives entirely upstream of the `exit_reason` that `pipeline-runner.ts:1670` consumes. Real ENOENT still produces `judge_cli_missing`; slow probe falls through to `judge_timeout` (already correctly handled — no short-circuit). Verified by `extension/tests/process-iteration-outcome.test.js` passing without changes. |
| **R-MJCP-5** | Operator diagnostic on timeout-class probe failure — verbatim log line (both `microverse-runner.log` and stderr): `[microverse] judge probe timed out at <NNN>ms (claude --version exceeded probe timeout); falling back to measurement loop with 10s/30s/60s backoff. If this recurs, set PICKLE_JUDGE_PROBE_TIMEOUT_MS=10000 or higher.` |
| **R-MJCP-6** | Regression test `extension/tests/bin/microverse-judge-probe.test.js` (NEW) covers all four probe classifications. Stubbed `_deps.execFileSync` for ENOENT and ETIMEDOUT cases. Asserts: (a) `probeJudgeCliAvailability` returns the right `kind`, (b) `measureLlmMetricWithBackoff` does NOT return `judge_cli_missing` for ETIMEDOUT, (c) backoff loop returns `judge_timeout` if it also fails, (d) symmetric ENOENT case still short-circuits to `judge_cli_missing` with `attempts: 0`. |
| **R-MJCP-7** | Trap-door entry pinned in `extension/CLAUDE.md`: "`src/bin/microverse-runner.ts` (probe path) — INVARIANT: `probeJudgeCliAvailability` MUST classify ENOENT, ETIMEDOUT, and other errors via `classifyJudgeError`; only ENOENT-class produces `judge_cli_missing`. BREAKS: cold-start probe timeouts on macOS misclassified as missing CLI, killing pipelines that have completed converged phases." ENFORCE: `extension/tests/bin/microverse-judge-probe.test.js`. |
| **R-MJCP-8** | Subsystem doc (`extension/src/bin/CLAUDE.md` or microverse subsystem doc) gains a short section explaining the probe-vs-measurement timeout distinction: probe is a fail-fast existence check (≥5s, ENOENT-only); measurement is a correctness-check with retry-with-backoff. |

**Section J — Acceptance Criteria** — `AC-MJCP-01..08` lifted verbatim from source PRD § Acceptance Criteria.

**Files in scope**: `extension/src/bin/microverse-runner.ts` (probe + helper extraction), `extension/tests/bin/microverse-judge-probe.test.js` *(NEW)*, `extension/CLAUDE.md` (trap-door), `extension/src/bin/CLAUDE.md` *(NEW or updated)* (probe-vs-measurement distinction docs). **Pipeline-runner explicitly OUT of scope** per R-MJCP-4.

## Section K — Closer *(ELEVENTH — version bump + deploy parity)*

| Req | Description |
|---|---|
| **R-CLOSER-1** | Bump `extension/package.json` from `1.72.2` → `1.73.0` (minor — bundle ships features: scope-diff preflight, audit script, forensic capture). Lockfile sync. |
| **R-CLOSER-2** | `bash install.sh` deploys to `~/.claude/pickle-rick/`. Post-rsync md5-parity probe (R-ITS-2) must pass. Active-bundle guard auto-permits closer's own session via `--closer-context`. |
| **R-CLOSER-3** | Update `prds/MASTER_PLAN.md`: mark Open Findings #1, #5, #11, #12, #13, #16 as closed (or note Section G's audit deferral); move source PRDs from Active Queue to Shipped table; record this bundle's session id under "Recently Shipped". |

**Section K — Acceptance Criteria**

- **AC-CLOSER-01** — `extension/package.json:version === "1.73.0"` at HEAD; lockfile sync committed.
- **AC-CLOSER-02** — `bash install.sh` exits 0; md5-parity probe passes for all 5 trafficked files.
- **AC-CLOSER-03** — MASTER_PLAN updated; commit message references this bundle's PRD path.
- **AC-CLOSER-04** *(optional, operator-gated)* — `gh release create v1.73.0 --latest` if operator chooses to break the local-only-mode dam (current MASTER_PLAN policy: deferred). Default: no push.

**Files in scope**: `extension/package.json`, `extension/package-lock.json`, `prds/MASTER_PLAN.md`, install.sh (no edits; just runs).

## Risk Register

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| **R1** | Slot G is the MPH cure → bundle MUST run on `--backend claude` | High | `backend_constraint: claude` in frontmatter; closer + launch script enforce. Explicit comment in this PRD. |
| **R2** | Open Finding #10 fix (`232f3d26`) deploy owed; running this bundle on stale runtime risks the same fresh-init pipeline-killer that bailed `2026-05-08-d6f98b66` | High | Pre-flight check #1 mandates `bash install.sh` before launch. Closer's `R-CLOSER-2` re-verifies post-bundle parity. |
| **R3** | Slot L removes ~480 LOC; later sections must not depend on removed defenses | Medium | Section ordering puts L second-to-last. Sections B/C/D/E/F/G complete before L touches code. R-SED-5 verifies kept defenses are end-to-end covered. |
| **R4** | Slot K is diagnosis-only — `audit-ticket-bundle` may complain about no fix shipping | Medium | Bundle-disposition file declares `DIAGNOSE` for Section H; `R-BUNDLE-DISPO` exempts. |
| **R5** | Section G audit may generate child tickets mid-pipeline; if the audit script is slow, blows wall-clock budget | Medium | Section G is bounded to `audit-only`; remediation ships as follow-up DRAFT PRDs, NOT in this bundle. Audit script wall-clock target: <30s. |
| **R6** | Working tree currently dirty with another session's MASTER_PLAN edits + new bug PRD | High | Pre-flight check #2 mandates quarantine. The dirty paths are owned by session `2026-05-08-5d60b760` (loanlight-api) which is still active — DO NOT touch those files in this bundle's pickle phase. |
| **R7** | Slot G touches deployed templates (`.claude/commands/*.md`); `install.sh` deploy of the bundle's closer must not race with worker template reads mid-pickle | Medium | Closer runs after pickle phase exits; pre-fix templates remain in place during pickle phase. R-CCPL-3's substring-broken token forms are source-side only until the closer deploys them. |
| **R8** | The new activity events (`worker_edit_outside_scope`, `pkgjson_revert_forensic_captured`) MUST be registered through the full quartet, not just types | High | R-APWS-3 + R-PJV-5 explicitly list all 5 registration points. Audit-ticket-bundle's existing event-registration check enforces. |
| **R9** | Quick-refine ticket authoring may drop ACs if Agent prompts under-specify | Medium | Each section's ACs are listed verbatim or with explicit `(=source X)` mapping; quick-refine prompts MUST lift these unchanged. Validation: spot-check 2 random tickets post-quick-refine; if drift, re-run that ticket's authoring. |
| **R10** | Closer's `gh release create` is OPT-IN; default no-push per local-only-mode policy | Low | AC-CLOSER-04 marked optional; pickle-rick session does NOT auto-push without operator instruction. |
| **R11** | Sections D + E both touch scope-resolution code paths; ordering matters because R-PSAI-4 (`lock-scope.js`) calls into the same scope-resolver that R-APWS-1 (`check-scope-diff.js`) consumes | Medium | Section D ships first; Section E's `lock-scope.js` imports the scope-resolver helper that Section D's preflight script also uses. Both depend on the same source-of-truth `extension/src/services/scope-resolver.ts` (existing). If Section D touches the resolver's public API, Section E's quick-refine ticket MUST re-read the resolver before authoring. |
| **R12** | R-PSAI-1's regex catalog is operator-facing; false-positive rate must be low | Medium | Auto-inference NEVER flips scope on silently — always prompts. Worst case: an extra AskUserQuestion. R-PSAI-7 covers all 6 regex cases including `--scope` already-passed (no double-prompt). Operator can document `regex matched but unscoped` via R-PSAI-1.4 audit log. |
| **R13** | Section J's R-MJCP-4 forbids pipeline-runner changes; quick-refine ticket might erroneously touch `pipeline-runner.ts:1670` while looking for the exit-reason consumer | Medium | R-MJCP-4 explicit in section text + AC-MJCP-07 verifies `process-iteration-outcome.test.js` passes without changes. Quick-refine prompt MUST highlight "pipeline-runner OUT of scope". If the ticket touches it, the audit-ticket-bundle exempt-files allowlist will reject the diff. |
| **R14** | Section J raises the probe timeout 50ms → 5000ms; could mask a *real* missing-CLI case for 5 extra seconds in operator-facing diagnostics | Low | ENOENT-class still returns ~10ms (system-call cost, not timeout-bound). Only ETIMEDOUT-class gets the longer cap, and that's exactly the misclassified-as-missing case we're fixing. Operator diagnostic per R-MJCP-5 is the visibility for slow-but-installed CLI. |

## Pre-flight checklist (operator runs before launch)

- [ ] Pre-flight #1: `bash install.sh` deployed `232f3d26` (verify `convergence-gate.js` md5 src=dst)
- [ ] Pre-flight #2: dirty paths quarantined or committed on a sister branch
- [ ] Pre-flight #3: only THIS bundle's session is `active=true` (or no session is)
- [ ] Pre-flight #4: production gate clean at HEAD (tsc + eslint + trap-door audit)
- [ ] Pre-flight #5: source / deployed parity probe green (5 trafficked files)

## Launch command

```bash
cd /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
/pickle-pipeline --no-refine --backend claude prds/archive/bundles/p1-bug-fix-bundle-2026-05-08-mega.md
```

`--no-refine` because each section is fully specified or has a self-contained R-code list; quick-refine fan-out happens inside the pickle phase per section. `--backend claude` is non-negotiable (R1).

## Refinement directives (for the quick-refine fan-out inside the pickle phase)

The pickle phase will spawn 11 parallel `Agent` calls (one per section A..K), each authoring 1 atomic ticket:

1. **Lift ACs verbatim** from this PRD's section. Do NOT paraphrase.
2. **Lift R-codes verbatim** from this PRD's table. Source-PRD R-codes that this bundle renames (e.g. `R-CCPL-1 (=source R1)`) are committed under both names — primary `R-CCPL-1`, alias `(=source R1)`.
3. **Files in scope** are listed per section; ticket MUST not touch files outside that list without filing a follow-up.
4. **Sections G and H deliver research artifacts**, not fixes — Agent prompts MUST emit the JSON / markdown report files at the listed paths and mark the ticket Done on artifact landing, not on a code change. (G = Finding #5 audit; H = Slot K diagnosis.)
5. **Section I (Slot L)** is removal — Agent prompt explicitly instructs `git rm` on the listed services, not `git mv`.
6. Per Working Rule #2, every ticket's worker MUST run `npx eslint src/ --max-warnings=-1 && npx tsc --noEmit` before completion-commit.

## Post-bundle bookkeeping (closer's R-CLOSER-3)

- Mark Open Finding #1 ✅ CLOSED in MASTER_PLAN.md (now actually closed by Section B).
- Mark Open Finding #5 ⚠️ DEFERRED in MASTER_PLAN.md (audit done; remediation queued as P3 follow-up PRDs).
- Mark Open Finding #11 ✅ CLOSED in MASTER_PLAN.md (closed by Section D).
- Mark Open Finding #12 ✅ CLOSED in MASTER_PLAN.md (closed by Section E).
- Mark Open Finding #13 ✅ CLOSED in MASTER_PLAN.md (closed by Section J).
- Mark Followup #16 ✅ CLOSED in MASTER_PLAN.md (closed by Section F).
- Move Slots G, H, K, L from Active Queue to Shipped (or "Diagnosis-only" for K) table.
- Append entry to "Recently Shipped" with bundle session id, ticket count, wall-clock, commit hash range.
- Bump Last-updated header date.

## Cross-references

- Predecessor: `prds/archive/bundles/p1-bug-fix-bundle-2026-05-07-deferred-slots.md`
- Predecessor's tail finding (already shipped, deploy owed): `prds/p1-anatomy-park-detectproject-null-skips-baseline.md`
- Working Rule #2 (lint+typecheck at completion-commit): MASTER_PLAN.md § Working Rules
- Quick-refine workflow: `prds/archive/features/p2-abbreviated-refine-command.md`
- R-ITS-2 parity probe (kept defense): `extension/install.sh:330-359`
- R-ITS-5-MIN install-during-active guard: `extension/install.sh:228-246`

## Session Notes (post-run; appended by closer)

*[Closer fills this in after bundle ships.]*
