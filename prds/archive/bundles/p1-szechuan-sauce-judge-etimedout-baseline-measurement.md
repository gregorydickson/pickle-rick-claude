---
title: P1 — szechuan-sauce judge baseline-measurement deterministically ETIMEDOUTs on `spawnSync claude` × 4 (B-SJET-2 scope; refined 2026-05-18)
status: Active (B-SJET-2, partial-ship cleanup from v1.75.4)
filed: 2026-05-17
refined: 2026-05-18
priority: P1
type: bug-infrastructure
finding: 47
code: R-SJET
bundle: B-SJET-2
already_shipped:
  - "R-SJET-2 (command-metric path async) — v1.75.4 commit 66e187e8 — converted measureMetric to async spawn for the COMMAND metric path; LLM judge path still synchronous at HEAD"
  - "R-SJET-5 (judge_measurement_attempted telemetry) — v1.75.4 commit 4bf68232 — per-attempt structured events with backend/model/fallback/spawn_context"
b_sjet_2_scope:
  - "R-SJET-1 — stdin-close (2 sites) + async pivot + typed errors (LLM judge path) + Math.max floor removal + PICKLE_JUDGE_LEGACY_SPAWN kill-switch"
  - "R-SJET-3 — nested-claude env isolation via judge-spawn-env.ts helper"
  - "R-SJET-4 — judge_backend config + sticky fallback (no new event; reuses judge_measurement_attempted)"
  - "R-SJET-6 — integration tests + forward-created fixtures"
  - "T-HARDEN-AUTORESUME — pipeline-runner exit-reason mapping for all_judge_backends_exhausted"
  - "T-HARDEN-DOCS — docs/judge-spawn-troubleshooting.md + activity event catalog updates"
  - "T-HARDEN-PROBE — three-probe pre-validation script repro-judge-timeout.sh"
  - "T-HARDEN-CONFORMANCE — per-R-code conformance_*.md docs + lint/typecheck/test:fast gates"
  - "C-SJET-CLOSER — [manager] version bump 1.75.6, compiled-JS rebuild, install.sh parity, gh release, MASTER_PLAN.md"
deferred:
  - "R-SJET-7 (continue-on-judge-unmeasurable) — DROPPED from B-SJET-2 entirely per 3-analyst consensus. Conflicts with R-PRJT-2 + R-MBLE-2 live trap doors. File B-SJET-3 with explicit interaction-matrix design PRD before reconsidering."
tickets:
  R-SJET-1: { tier: medium, effort_max: "2h" }
  R-SJET-3: { tier: medium, effort_max: "2h" }
  R-SJET-4: { tier: medium, effort_max: "2h" }
  R-SJET-6: { tier: small, effort_max: "1h" }
  T-HARDEN-AUTORESUME: { tier: small, effort_max: "1h" }
  T-HARDEN-DOCS: { tier: small, effort_max: "1h" }
  T-HARDEN-PROBE: { tier: small, effort_max: "1h" }
  T-HARDEN-CONFORMANCE: { tier: small, effort_max: "1h" }
  C-SJET-CLOSER: { tier: small, effort_max: "30m", owner: manager }
recurrence:
  - "2026-05-17 15:09:17Z — session 2026-05-17-0fca029f run 1, codex worker, iter-1 ETIMEDOUT × 4, 22m 4s wall, exit_reason=judge_timeout. Worker landed 1 commit a6abeb8d1 before judge died."
  - "2026-05-17 15:42:35Z — same session run 2, codex worker, iter-1 ETIMEDOUT × 4, 27m 0s wall, exit_reason=judge_timeout."
  - "2026-05-17 19:00:06Z — session 2026-05-17-902b9155, claude worker, iter-1 baseline SUCCEEDED in 28m 50s (anomalous slow-not-timeout), iter-3 ETIMEDOUT × 4 at 20:02:20Z, 62m 13s wall, 1 commit a9c0038eb landed."
related:
  - prds/archive/bundles/p1-bug-fix-bundle-2026-05-08-mega.md  # R-MJCP origin (Finding #14, closed v1.73.0)
  - prds/archive/bug-reports/p1-szechuan-sauce-session-dir-firewall-conflict.md  # R-SSDF (Finding #46)
  - prds/archive/bug-reports/p1-codex-manager-hallucinated-wedge-self-terminate.md  # R-CCPM-1b (Finding #45)
  - prds/archive/bundles/p1-closer-ticket-spins-on-r-wsrc-forbidden-acs.md  # R-CTSF (Finding #44)
  - prds/archive/bundles/p1-hallucinated-conformance-attestation-gate.md  # B-HCAG (closes Finding #2, deferred F4)
---

<!-- R-CTSF compliant: workers own R-SJET-1/3/4/6 + T-HARDEN-* ; closer C-SJET-CLOSER owns [manager] residuals (version bump, install.sh, MASTER_PLAN, release) -->

# R-SJET (B-SJET-2) — szechuan-sauce judge baseline-measurement deterministically ETIMEDOUTs on `spawnSync claude`

**Author**: pickle-rick session 2026-05-17 PM; refined 2026-05-18
**Project**: pickle-rick-claude
**Repo**: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude`
**HEAD verified at refinement**: `7a280bdb`

## Symptom (revised — backend-modulated, not deterministic)

On the codex worker backend, the LLM judge baseline-measurement deterministically hangs at iter-1 across both observed runs. On the claude worker backend, iter-1 baseline succeeds (slowly, 28+ min — itself anomalous), then hangs deterministically at iter-3+. The bug is **intermittent within a single backend's traces but deterministic across observed traces of either backend**. Three sessions in §recurrence confirm.

The structural location: `extension/src/bin/microverse-runner.ts:1745-1759` (measurement) and `:1797-1817` (probe). Both call `_deps.execFileSync('claude', …, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...backendEnvOverrides('claude') } })`. Probe path was hardened by R-MJCP (Finding #14, v1.73.0) for misclassification but the measurement spawn-hang was left for a successor (this PRD).

## Root cause hypothesis stack (3-analyst consensus)

| H | Hypothesis | Evidence | Falsifiable via |
|---|---|---|---|
| H1 | Stdin pipe held open with no writer; claude CLI reads stdin until EOF before producing output. | `stdio: ['pipe', 'pipe', 'pipe']` × 2 sites; codex-worker case fails 100% at iter-1; matches `probeJudgeCliAvailability` not exercising full prompt pipeline. | T-HARDEN-PROBE P1 (clean shell). |
| H2 | Nested-claude auth/session contention. | Claude-worker case fails at iter-3 (not iter-1); 28-min "success" baseline anomaly suggests partial state contention. | T-HARDEN-PROBE P2 (nested claude shell). |
| H3 | Output stream backpressure on long judge responses. | execFileSync stdout buffer ≤ 1MB; judge prompts ≤ 100KB typical. | Less likely; not falsifiable without telemetry. Punted to R-SJET-5 mid-spawn fields. |

R-SJET-1 (stdin-close) is load-bearing under H1, defensive under H2. R-SJET-3 (env isolation) is load-bearing under H2, defensive under H1. R-SJET-4 (fallback config) is the operator escape hatch regardless of which H dominates. All three ship together.

## Cost of the bug

| Metric | Value |
|---|---|
| Sessions broken (observed) | 3 |
| Total wall-time wasted | 1h 51m |
| Iterations completed across all 3 sessions | 1 (the 28-min anomalous baseline) |
| Useful commits the workers landed BEFORE the judge died | 2 (`a6abeb8d1`, `a9c0038eb`) |
| Structural impact | Every LLM-judge-driven convergence mode (szechuan-sauce, plumbus, microverse) broken on this environment |

## Pipeline-Layer Exit-Reason Mapping (R-CNAR-4 / R-PRJT-2 alignment)

Verified at `extension/scripts/auto-resume.sh:144-145` (R-CNAR-4(c)): auto-resume.sh halts the overnight resume loop on any `state.json.exit_reason != 'pipeline_phase_incomplete'`. Verified at `extension/src/bin/pipeline-runner.ts:2181-2269` (R-PRJT-2): `judge_timeout` is recovered via finalize-gate.js spawn; exit_reason rewritten to `pipeline_phase_incomplete` (recovery succeeded) or `failed` (recovery failed).

Every new microverse exit_reason introduced by B-SJET-2 MUST be mapped explicitly. T-HARDEN-AUTORESUME owns this wiring.

| New microverse exit_reason | In MICROVERSE_FAILURE_REASONS? | pipeline-runner translation | Operator-visible exit_reason | Auto-resume? |
|---|---|---|---|---|
| `all_judge_backends_exhausted` (R-SJET-4) | NO (transient) | finalize-gate.js spawn (mirror R-PRJT-2) | `pipeline_phase_incomplete` on gate pass / `failed` on gate fail | Yes |
| `judge_cli_missing` (R-SJET-4, codex pinned + absent CLI) | YES (terminal) | passthrough | `judge_cli_missing` | No (operator install required) |

## Fallback Policy (R-SJET-4 within-session and resume semantics)

When `judge_backend: 'auto'` engages the fallback backend in iteration N of a session, ALL subsequent iterations in the same session use the fallback backend exclusively. The runner does NOT re-probe the failed primary mid-session.

**Within-session**: on attempt N's `JudgeMeasurementTimeout` or `JudgeMeasurementSpawnFailed` from the primary backend, attempt N+1 uses the fallback. The 4-attempt schedule (immediate + 10s + 30s + 60s × 180s per attempt) is **shared across backends** — at most 4 spawn attempts total per iteration, not 4 per backend. Once fallback engages in attempt N+1, all subsequent attempts in the same session use the fallback backend.

**Resume semantics**: the fallback decision persists to `state.json.judge_backend_resolved` (new optional field, no schema bump). On `--resume`, microverse-runner reads this field and skips the primary probe. Operator can force re-probe by `jq 'del(.judge_backend_resolved)' state.json | sponge state.json` (documented in `docs/judge-spawn-troubleshooting.md`).

**New sessions** reset to primary-first.

**Telemetry**: do NOT introduce a new activity event for the fallback transition. The shipped `judge_measurement_attempted` (`types/index.ts:469`) already carries `gate_payload.judge_backend`, `gate_payload.fallback_activated`, `gate_payload.spawn_context`. The SECOND `judge_measurement_attempted` on a fallback iteration sets `fallback_activated: true` and `judge_backend: 'codex'`. Operators reading `activity_<date>.jsonl` see two adjacent events on the same iteration. This avoids the R-PDD-oneOf five-touchpoint cost and matches the v1.75.4 telemetry design.

## Schema deltas (no LATEST_SCHEMA_VERSION bump)

This bundle introduces ZERO schema-version-affecting changes. All new fields are OPTIONAL:

- `MicroverseHistoryEntry.judge_backend_used?: 'claude' | 'codex'` (R-SJET-4) — backward-compatible.
- `state.json.judge_backend_resolved?: 'claude' | 'codex'` (R-SJET-4 fallback-stickiness across resume) — backward-compatible.
- `pickle_settings.json.microverse.{judge_backend, judge_backend_fallback, judge_model_claude, judge_model_codex}` (R-SJET-4) — new top-level namespace; loader is non-strict (verified at `extension/src/services/recoverable-json.ts:52-89`); no schema-version bump.
- `judge_measurement_attempted.gate_payload` (extended via R-SJET-3 + R-SJET-5+1) — additional OPTIONAL fields: `pre_spawn_env_key_names: string[]`, `mid_spawn_pid: number`, `mid_spawn_stdout_bytes: number`, `mid_spawn_stderr_bytes: number`, `time_to_first_stdout_byte_ms: number|null`, `nested_claude_detected: boolean`, `stdout_redacted_preview: string|null`, `stderr_redacted_preview: string|null`. Existing tests cover the event; no new schema-conformance test file needed.

**Producer discipline** (per R-CCPM-1 + R-WSE-2 trap doors at `extension/src/bin/CLAUDE.md`):
- Emission site MUST stamp `ts: new Date().toISOString()` explicitly (writeActivityEntry does NOT auto-stamp).
- `gate_payload.attempt_number` MUST be the actual attempt index (1-indexed), never reconstructed.
- `ticket` field MUST be `state.current_ticket ?? null`.

**Forbidden by this bundle**: bumping `LATEST_SCHEMA_VERSION`. The R-WSRC-1 ceiling at `extension/src/services/state-manager.ts:update()` throws `SchemaVersionAheadError` on any worker forward-schema write. Workers MUST add fields as OPTIONAL and tolerate `undefined` on read.

**DROPPED from B-SJET-2** (R-SJET-7 deferral, 3-analyst consensus):
- New event `judge_unmeasurable_iteration_continued` — overlaps shipped `pipeline_judge_timeout_recovery_attempted`.
- New event `judge_backend_fallback_engaged` — overlaps shipped `judge_measurement_attempted.fallback_activated`.
- Type field `MicroverseHistoryEntry.convergence_status` — no consumer in B-SJET-2.
- Settings key `microverse.continue_on_judge_timeout` — no consumer in B-SJET-2.

## Atomic ticket scope (4)

### R-SJET-1 (medium, ≤2h) — Stdin-close + async pivot + typed errors + Math.max floor removal + kill-switch

**Files to modify**:
- `extension/src/bin/microverse-runner.ts`
- `extension/src/bin/CLAUDE.md` (trap-door entries for the new typed error classes)
- `extension/tests/bin/microverse-judge-probe.test.js` (extend; do NOT remove existing assertions)
- `extension/tests/microverse-runner.test.js` (extend if present; otherwise add new)

**Changes**:

1. **Stdin-close** at the two judge spawn sites (lines verified at HEAD `7a280bdb`):
   - `microverse-runner.ts:1758` (measureLlmMetricAttempt) — `stdio: ['pipe', 'pipe', 'pipe']` → `stdio: ['ignore', 'pipe', 'pipe']`.
   - `microverse-runner.ts:1804` (probeJudgeCliAvailability) — same.
   - Grep assertion: `grep -c "stdio: \['pipe', 'pipe', 'pipe'\]" extension/src/bin/microverse-runner.ts` count drops from 8 to 6.

2. **Async pivot**: replace `_deps.execFileSync` at both sites with `execFile` (promisified via `util.promisify` or `child_process.execFile` + manual Promise wrapper) + `Promise.race` against a hard timer. On timer expiry: send SIGTERM, then SIGKILL after 2s grace, reject with typed `JudgeMeasurementTimeout`. On spawn failure (ENOENT, EACCES): reject with typed `JudgeMeasurementSpawnFailed`.
   - `measureLlmMetricAttempt` becomes `async`; callers (`measureLlmMetric` at HEAD line 1503 area, `measureLlmMetricWithBackoff` at HEAD line 1819) `await` it.
   - `probeJudgeCliAvailability` becomes `async`; rename callers to `await probeJudgeCliAvailability(cwd)` (deferring backend-parametrization rename to R-SJET-4).

3. **Typed error classes** at `extension/src/bin/microverse-runner.ts` (module-local):
   ```typescript
   export class JudgeMeasurementTimeout extends Error {
     readonly kind = 'timeout' as const;
     constructor(msg: string, public readonly elapsed_ms: number) { super(msg); }
   }
   export class JudgeMeasurementSpawnFailed extends Error {
     readonly kind = 'spawn_failed' as const;
     constructor(msg: string, public readonly cause_code: string | null) { super(msg); }
   }
   ```

4. **Shared `classifyJudgeError` helper**: update existing helper (verified to exist at HEAD; see R-MJCP-8 trap door at `extension/src/bin/CLAUDE.md`) to recognize the new classes via `instanceof` FIRST, then fall back to existing regex on `.message` for legacy callers. Both `probeJudgeCliAvailability` and `measureLlmMetricAttempt` MUST invoke `classifyJudgeError` exactly once — no duplicate ENOENT/ETIMEDOUT regex branches in either function body.

5. **Math.max floor removal** at `microverse-runner.ts:1738`:
   - Current: `const timeout = Math.max(timeoutSeconds, DEFAULT_JUDGE_TIMEOUT);`
   - New: `const timeout = Math.max(timeoutSeconds, 1);` (defensive against zero/negative; trusts caller otherwise).
   - This is load-bearing for AC-SJET-02 (test with `timeoutSeconds: 10` must observe elapsed ≤ 12s).

6. **Kill-switch** `PICKLE_JUDGE_LEGACY_SPAWN`:
   - When `process.env['PICKLE_JUDGE_LEGACY_SPAWN'] === '1'`, BOTH judge spawn sites revert to `stdio: ['pipe', 'pipe', 'pipe']` (synchronous `execFileSync`, no typed errors, no Math.max removal). This is the emergency-rollback path documented in `docs/judge-spawn-troubleshooting.md` (T-HARDEN-DOCS).
   - The kill-switch is the only legitimate user of legacy spawn shape — production code paths must use the new shape.

7. **Trap-door entries** in `extension/src/bin/CLAUDE.md`:
   - R-SJET-1a (stdio-close): PATTERN_SHAPE forbids `stdio: \['pipe', 'pipe', 'pipe'\]` in `measureLlmMetricAttempt` or `probeJudgeCliAvailability` bodies UNLESS guarded by `PICKLE_JUDGE_LEGACY_SPAWN`.
   - R-SJET-1b (typed errors): PATTERN_SHAPE requires `instanceof JudgeMeasurementTimeout` in `classifyJudgeError` before any `/timeout/i` regex branch.

### R-SJET-3 (medium, ≤2h) — Nested-claude env isolation

**Files to create**:
- `extension/src/services/judge-spawn-env.ts` — exports `buildJudgeEnv(backend: 'claude' | 'codex', isNested: boolean): Record<string, string | undefined>`. When `isNested && backend === 'claude'`, strips `CLAUDE_CODE`, `CLAUDECODE`, `CLAUDE_API_KEY` (if `ANTHROPIC_API_KEY` is present), and replaces `XDG_RUNTIME_DIR` with a fresh tmp dir created via `fs.mkdtempSync`. Otherwise returns `backendEnvOverrides(backend)` unchanged.
- `extension/src/services/judge-spawn-env.test.js` — unit tests for both branches.

**Files to modify**:
- `extension/src/bin/microverse-runner.ts:1759` — replace `backendEnvOverrides('claude')` with `buildJudgeEnv(resolvedBackend, isNestedClaude())`. The `isNestedClaude()` helper checks for `process.env['CLAUDE_CODE']` or `process.env['CLAUDECODE']`.
- `microverse-runner.ts:1805` — same.
- `judge_measurement_attempted.gate_payload` emission — add optional `nested_claude_detected: boolean` and `pre_spawn_env_key_names: string[]` (env names redacted of values).

**Note**: `resolvedBackend` is provided by R-SJET-4's `resolveJudgeBackend` accessor. R-SJET-3 ships AFTER R-SJET-4 (depends on the resolver) OR ships with a `'claude'` literal initially and the variable replaced in R-SJET-4's diff. Sequencing in worker queue: R-SJET-1 → R-SJET-4 → R-SJET-3 → R-SJET-6.

**Anthropic API direct** (Hypothesis 3a in original PRD) is OUT OF SCOPE — file separate design PRD if needed.

### R-SJET-4 (medium, ≤2h) — judge_backend config + sticky fallback (no new event)

**Files to modify**:
- `extension/src/services/pickle-utils.ts` — add:
  - `resolveJudgeBackend(state, settings?, attempt?, lastFailure?): 'claude' | 'codex'` — precedence (mirrors `getTicketTierBudgetWithOverrides` at line 541-556):
    1. `state.flags.judge_backend_override` (when present and valid).
    2. `pickle_settings.microverse.judge_backend` (loaded via `loadPickleSettingsBag()`).
    3. Compiled default: `'claude'` (preserves historical behavior; AC-SJET-17 byte-identical claude-spawn under default).
  - `'auto'` resolves to `'claude'` on attempt 0 with no prior failure, OR to `state.judge_backend_resolved` if set, OR to `settings.microverse.judge_backend_fallback ?? 'codex'` on a typed `JudgeMeasurementTimeout`/`JudgeMeasurementSpawnFailed` from the previous attempt.
  - `getMicroverseSettings(settings: PickleSettings | null)` — typed reader; returns `{ judge_backend, judge_backend_fallback, judge_model_claude, judge_model_codex }` with known-key allowlist. No `(settings as any)` access.

- `extension/src/bin/microverse-runner.ts`:
  - **line 1745**: `buildJudgeInvocation('claude', …)` → conditional preserving the R-SCJM-5 literal:
    ```typescript
    const invocation = resolvedBackend === 'codex'
      ? buildJudgeInvocation('codex', { prompt: userPrompt, addDirs: [cwd], model: codexModel, systemPrompt: JUDGE_SYSTEM_PROMPT })
      : buildJudgeInvocation('claude', { prompt: userPrompt, addDirs: [cwd], model: claudeModel, systemPrompt: JUDGE_SYSTEM_PROMPT });
    ```
    The literal substring `buildJudgeInvocation('claude'` MUST remain present (R-SCJM-5 trap door). Grep assertion: `grep -c "buildJudgeInvocation('claude'" extension/src/bin/microverse-runner.ts` ≥ 1 after diff lands.
  - **line 1759**: `backendEnvOverrides('claude')` → `buildJudgeEnv(resolvedBackend, isNestedClaude())` (collaborates with R-SJET-3).
  - **line 1800** (probe binary): literal `'claude'` first arg → variable; rename `probeJudgeCliAvailability(cwd)` to `probeJudgeBackendAvailability(backend: 'claude' | 'codex', cwd: string)`. Update all call sites.
  - **line 1805**: `backendEnvOverrides('claude')` → `buildJudgeEnv(backend, isNestedClaude())`.
  - `measureLlmMetricWithBackoff` (line 1819 area) — fallback logic: on first typed failure from primary, switch `attempt.backend` to fallback for remaining attempts in this iteration; persist `state.judge_backend_resolved = fallback` once any iteration's fallback engages.

- `extension/src/types/index.ts:875` (`MicroverseHistoryEntry`):
  - Add `judge_backend_used?: 'claude' | 'codex'` (OPTIONAL).
  - Workers MUST NOT bump `LATEST_SCHEMA_VERSION`. Readers tolerate `undefined` via `?? 'claude'`.

- `extension/src/types/index.ts` (state interface):
  - Add `judge_backend_resolved?: 'claude' | 'codex'` to the state interface (OPTIONAL).

- `pickle_settings.json` at repo root (NOT the deployed copy):
  - Add `microverse: { judge_backend: 'claude', judge_backend_fallback: 'codex', judge_model_claude: 'claude-sonnet-4-6', judge_model_codex: 'gpt-5.4' }`. `schema_version` stays at current value.

- `extension/CLAUDE.md` (R-SCJM-5 trap-door prose) — amend to: *"`buildJudgeInvocation\('claude'` MUST appear as a literal substring in `microverse-runner.ts`. `backendEnvOverrides`/`buildJudgeEnv` MUST be called with the resolved judge backend (`resolvedBackend`); when `microverse.judge_backend` is `'claude'` (the default) or `'auto'` with no fallback engaged, this resolves to `'claude'` (preserving the historical R-SCJM-3 invariant)."* Update PATTERN_SHAPE if needed. Worker MUST NOT touch `extension/src/bin/CLAUDE.md` or `~/.claude/pickle-rick/**` paths (R-WSRC).

- `extension/tests/microverse-codex.test.js` AND `extension/tests/integration/microverse-runner-judge-failure.test.js` — update to assert BOTH branches: byte-identical claude spawn when `judge_backend: 'claude'` (default) AND codex spawn with codex-env when `judge_backend: 'codex'` (explicit pin).

### R-SJET-6 (small, ≤1h) — Integration tests + forward-created fixtures

**Files to create** (all forward-created annotations follow R-RTRC-7):

- `extension/tests/fixtures/bin/fake-claude-hang.sh` (created by R-SJET-6) — `#!/bin/bash` + portable infinite read: `while :; do sleep 86400; done` (NOT `sleep infinity` — macOS BSD doesn't accept it). Ignores SIGTERM (forces SIGKILL escalation). Writes nothing to stdout.
- `extension/tests/fixtures/bin/fake-codex-hang.sh` (created by R-SJET-6) — analogous.

- `extension/tests/integration/judge-spawn-timeout.test.js` (created by R-SJET-6) — `describe.each([['measureLlmMetricAttempt', 1758], ['probeJudgeCliAvailability', 1804]])` parametrized: inject PATH override to fake-claude-hang, assert thrown error is `instanceof JudgeMeasurementTimeout`, elapsed ≤ `(timeoutSeconds * 1000) + 2000` ms with `timeoutSeconds: 10`. AST scan asserts both function bodies invoke `classifyJudgeError` exactly once.

- `extension/tests/integration/judge-spawn-legacy-kill-switch.test.js` (created by R-SJET-6) — env `PICKLE_JUDGE_LEGACY_SPAWN=1`: asserts `_deps.execFileSync` was called with `stdio[0] === 'pipe'` (legacy shape). env unset: asserts `stdio[0] === 'ignore'` (new shape).

- `extension/tests/integration/judge-spawn-env-isolation.test.js` (created by R-SJET-6) — nested context (set `CLAUDE_CODE=1` in test env): asserts spawn env omits `CLAUDE_CODE` and includes a fresh `XDG_RUNTIME_DIR`. Clean context: asserts env preserved.

- `extension/tests/integration/auto-resume-on-all-judge-backends-exhausted.test.js` (created by R-SJET-6) — dual fake-claude-hang + fake-codex-hang fixtures: pipeline-runner exits `pipeline_phase_incomplete`; auto-resume.sh attempts at least one resume cycle before R-CNAR-4(a) stop condition fires.

- `extension/tests/integration/judge-fallback-sticky-resume.test.js` (created by R-SJET-6) — fake-claude-hang in iteration N: asserts attempt N+1 uses codex. Simulate `--resume` (relaunch runner with same session state): asserts `state.judge_backend_resolved === 'codex'` was read; runner skips claude probe entirely.

- `extension/tests/services/microverse-state-judge-backend-used-optional.test.js` (created by R-SJET-6) — load pre-R-SJET-4 `microverse.json` fixture (no `judge_backend_used` in history entries) into post-R-SJET-4 runtime: no `SchemaVersionAheadError`, no fallback-default pollution.

- `extension/tests/pickle-utils-microverse-namespace-load.test.js` (created by R-SJET-6) — load `pickle_settings.json` fixture with `microverse: { judge_backend: 'auto' }`: asserts `loadPickleSettingsBag` returns object without error; `getMicroverseSettings` returns parsed values.

- `extension/tests/integration/codex-judge-prompt-compat.test.js` (created by R-SJET-6, gated by `RUN_EXPENSIVE_TESTS=1`) — codex CLI returns parseable `JudgeResult` (shape `'full'` | `'legacy'` | `'partial'`, never `'malformed'`); score ∈ [0, 10]; ±2 tolerance vs claude on `extension/tests/fixtures/judge-compat/szechuan-sauce-baseline.json` (created by R-SJET-6).

- `extension/tests/fixtures/judge-compat/szechuan-sauce-baseline.json` (created by R-SJET-6) — known-good baseline pair (claude score, codex score) from a prior szechuan run on a stable PRD.

## Hardening ticket scope (4)

### T-HARDEN-AUTORESUME (small, ≤1h) — Pipeline-runner exit-reason mapping

**Files to modify**:
- `extension/src/bin/pipeline-runner.ts` — handle `all_judge_backends_exhausted` mirror of R-PRJT-2 finalize-gate.js path at `:2181-2269`. New transient exit_reason rewrites to `pipeline_phase_incomplete` on gate pass or `failed` on gate fail.
- `extension/src/bin/finalize-gate.js` (if separate) — recognize new exit_reason.
- `extension/scripts/auto-resume.sh` — no edit needed (R-CNAR-4(c) logic already routes `pipeline_phase_incomplete` to resume).

**Tests**: covered by `judge-spawn-timeout-pipeline-translation.test.js` (created by this ticket) and `auto-resume-on-all-judge-backends-exhausted.test.js` (created by R-SJET-6).

### T-HARDEN-DOCS (small, ≤1h) — Documentation + event catalog

**Files to create**:
- `docs/judge-spawn-troubleshooting.md` (created by T-HARDEN-DOCS) — sections:
  - § "Failure mode" — symptom, three hypothesis stack, recurrence table.
  - § "Telemetry NDJSON schema" — extended `judge_measurement_attempted.gate_payload` fields.
  - § "Emergency rollback" — `PICKLE_JUDGE_LEGACY_SPAWN=1` env-var usage.
  - § "Force re-probe" — `jq 'del(.judge_backend_resolved)' state.json | sponge state.json`.
  - § "Pre-validation probe procedure" — runs `extension/scripts/repro-judge-timeout.sh` (T-HARDEN-PROBE) and explains decision tree.
  - § "Diagnosing the next variant in seconds" — read NDJSON `mid_spawn_stdout_bytes` time series.

**Files to modify**:
- `extension/src/bin/spawn-refinement-team.ts:148-220` (ACTIVITY_EVENT_SCHEMA_SECTION) — update the `judge_measurement_attempted` row to document extended `gate_payload` fields added by R-SJET-3 + R-SJET-5+1.
- `extension/src/types/activity-events.schema.json` — extend `judge_measurement_attempted` `gate_payload` definition with new OPTIONAL fields (no `oneOf` change; existing schema-conformance test covers).
- `extension/tests/activity-event-payload.test.js` — extend `EVENT_CASES` row for `judge_measurement_attempted` to exercise new optional fields.

### T-HARDEN-PROBE (small, ≤1h) — Three-probe pre-validation script

**Files to create**:
- `extension/scripts/repro-judge-timeout.sh` (created by T-HARDEN-PROBE) — runs three probes, logs elapsed_ms + exit code per probe, prints decision-tree verdict:
  - P1: `claude -p 'echo ok' --add-dir $PWD </dev/null` from CLEAN shell (no parent claude).
  - P2: same, from NESTED shell (inside `CLAUDE_CODE=1` env).
  - P3: `codex -p 'echo ok' --model gpt-5.4 </dev/null` from clean shell.
  - All three exit 0 within 60s → bundle ships as designed.
  - P1 pass + P2 fail → H2 dominant; R-SJET-3 ship-blocker.
  - P1 fail → H1 falsified; R-SJET-1 defensive only; R-SJET-3 ship-blocker.
  - P3 fail → R-SJET-4 codex-fallback disabled; ship R-SJET-1/2/3/6 only; file successor for codex-judge.

Not a release gate — operator-optional pre-validation.

### T-HARDEN-CONFORMANCE (small, ≤1h) — Per-R-code conformance docs

Each R-SJET-* and T-HARDEN-* worker ticket emits `conformance_<ticket_id>.md` with:
- Mapped ACs (from this PRD).
- ## Diff Evidence section listing modified files (R-HCAG-3 / R-CTSF compliant; B-HCAG citation gate will enforce on the next session).
- `## Conformance Check` checklist (typecheck + test:fast + grep assertions).

T-HARDEN-CONFORMANCE owns the consolidation: verifies all 9 conformance docs exist at session close, runs the full audit suite (`cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && bash scripts/audit-*.sh && npm run test:fast && npm run test:integration`), and emits the bundle's `conformance_bundle.md` summary.

## Closer (1)

### C-SJET-CLOSER [manager] (small, ≤30m) — Bundle ship

Manager-owned residuals per R-CTSF (workers MUST NOT touch):

1. Bump `extension/package.json` + `extension/package-lock.json` from `1.75.5` → `1.75.6`.
2. `cd extension && npx tsc` — rebuild compiled JS mirrors.
3. Verify install.sh parity gate (R-AC-RVN-08 / R-PJV-6): `md5` of source TS vs compiled JS matches for the 5 most-trafficked files (`types/index.js`, `services/state-manager.js`, `bin/spawn-morty.js`, `bin/mux-runner.js`, `services/pickle-utils.js`). R-SJET-4 touches `types/index.js` directly; others unaffected.
4. `bash install.sh` — confirm log emits `install_sh_parity_check status=pass`.
5. Run full release-gate from `extension/`:
   ```
   npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && \
   bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && \
   bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && \
   bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && \
   npm run test:fast && npm run test:integration && \
   RUN_EXPENSIVE_TESTS=1 npm run test:expensive
   ```
6. Commit `chore: bump version to 1.75.6` + push to origin/main.
7. Update `prds/MASTER_PLAN.md`: B-SJET-2 closed; ships v1.75.6; B-SSDF next.
8. `gh release create v1.75.6` with release notes summarizing R-SJET-1/3/4/6 + 4 hardening tickets.

## Acceptance criteria (revised)

| ID | Criterion | Evidence | Owner |
|---|---|---|---|
| AC-SJET-01 | Both judge spawn sites (`measureLlmMetricAttempt`, `probeJudgeCliAvailability`) use `stdio[0] === 'ignore'`. | `describe.each([['measureLlmMetricAttempt'], ['probeJudgeCliAvailability']])` AST inspection; companion grep asserts total count of `stdio: ['pipe', 'pipe', 'pipe']` in `microverse-runner.ts` drops from 8 to 6 (UNLESS `PICKLE_JUDGE_LEGACY_SPAWN=1`). | R-SJET-1 |
| AC-SJET-02 | `measureLlmMetric` returns null with `failureKind: 'timeout'` within `(timeoutSeconds * 1000) + 2000` ms on a hung child. | Integration test against fake-claude-hang with `timeoutSeconds: 10`; assertion `elapsed < 12_000`. Requires AC-SJET-18 (Math.max floor removed). | R-SJET-1 + R-SJET-6 |
| AC-SJET-03 | `JudgeMeasurementTimeout` and `JudgeMeasurementSpawnFailed` are distinct typed classes; `classifyJudgeError` recognizes via `instanceof` before any regex. | Unit test on `classifyJudgeError` with both class instances + a control `ENOENT` instance. | R-SJET-1 |
| AC-SJET-04 | `pickle_settings.json.microverse.judge_backend ∈ {'claude', 'codex', 'auto'}`. `'auto'` mode falls back on first attempt's typed timeout from primary backend; 4-attempt schedule shared across backends; fallback is sticky for session lifetime. | Integration test against fake-claude-hang asserts attempt 2 uses codex (not claude); total spawn attempts = 2 (not 4). | R-SJET-4 + R-SJET-6 |
| AC-SJET-05 | On successful auto-fallback, `MicroverseHistoryEntry.judge_backend_used === 'codex'`. The two adjacent `judge_measurement_attempted` events show distinct `judge_backend` values; the SECOND has `fallback_activated: true`. | Integration test asserts (a) history `judge_backend_used: 'codex'`, (b) ≥ 2 activity events of type `judge_measurement_attempted` with distinct `gate_payload.judge_backend`. | R-SJET-4 + R-SJET-6 |
| AC-SJET-05b | When BOTH backends typed-timeout (`exit_reason: 'all_judge_backends_exhausted'`), `MicroverseHistoryEntry.judge_backend_used === 'codex'` (last attempted); activity events show both attempts with `failureKind: 'timeout'`. NO new `'both'` enum value. | Integration test against fake-claude-hang + fake-codex-hang. | R-SJET-4 + R-SJET-6 |
| AC-SJET-06 | Extended `judge_measurement_attempted.gate_payload` fields (`pre_spawn_env_key_names`, `mid_spawn_pid`, `mid_spawn_stdout_bytes`, `mid_spawn_stderr_bytes`, `time_to_first_stdout_byte_ms`, `nested_claude_detected`) emit on every spawn attempt (success or failure). Existing `EVENT_CASES` row updated. | Integration test asserts gate_payload shape. | R-SJET-3 + T-HARDEN-DOCS |
| AC-SJET-06c | Captured stdout/stderr text in `gate_payload` (any new text fields) is redacted: `/sk-[A-Za-z0-9_-]{20,}/g`, `/Bearer [A-Za-z0-9._~+/-]{20,}/g`, `\b/Users/[^/\s]+/\.claude/credentials[^"\s]*`. Replacement: `[REDACTED:<class>]`. | Unit test on redaction helper across 5 known-leak shapes. | R-SJET-3 + R-SJET-6 |
| AC-SJET-07 | DROPPED (folded into AC-SJET-02). | — | — |
| AC-SJET-08 | DROPPED (R-SJET-7 deferred). | — | — |
| AC-SJET-09 | Nested-claude env stripped: `CLAUDE_CODE`, `CLAUDECODE`, `XDG_RUNTIME_DIR` replaced with fresh tmp dir when judge spawn detects nested context. | `judge-spawn-env-isolation.test.js` (R-SJET-6). | R-SJET-3 |
| AC-SJET-11 | Dual-backend typed timeout → `exit_reason: 'all_judge_backends_exhausted'`. Pipeline-runner translates to `pipeline_phase_incomplete` via finalize-gate.js mirror of R-PRJT-2. | `auto-resume-on-all-judge-backends-exhausted.test.js` (R-SJET-6). | R-SJET-4 + T-HARDEN-AUTORESUME |
| AC-SJET-12 | When `judge_backend: 'codex'` pinned and codex CLI absent, `probeJudgeBackendAvailability('codex', cwd)` returns `kind: 'cli_missing'` within 5s; runner exits `judge_cli_missing` (terminal, NOT mapped through finalize-gate). | Integration test with codex absent from PATH. | R-SJET-4 + R-SJET-6 |
| AC-SJET-13 | Codex-judge invocations (`--model gpt-5.4`) return parseable `JudgeResult` (shape `'full'`/`'legacy'`/`'partial'`, NEVER `'malformed'`); `score ∈ [0, 10]`; ±2 tolerance vs claude on `extension/tests/fixtures/judge-compat/szechuan-sauce-baseline.json` (created by R-SJET-6). | `codex-judge-prompt-compat.test.js`, gated by `RUN_EXPENSIVE_TESTS=1`. | R-SJET-4 + R-SJET-6 |
| AC-SJET-13b | When `resolvedBackend === 'codex'`, parsed `JudgeResult` has either `violations: ViolationItem[]` OR `updateViolationLedger` no-ops on codex-shape responses. R-SLLJ-4 `compareMetric` set-ops branch fires correctly across backend swaps. | `judge-backend-fallback-violation-ledger.test.js` (created by R-SJET-6). | R-SJET-4 + R-SJET-6 |
| AC-SJET-17 | Default (`judge_backend: 'claude'`, no fallback engaged) preserves byte-identical claude spawn shape vs HEAD `7a280bdb`. | Snapshot test on `_deps.execFileSync` mock-call arrays. | R-SJET-4 + R-SJET-6 |
| AC-SJET-18 | `Math.max(timeoutSeconds, DEFAULT_JUDGE_TIMEOUT)` clamp removed at `microverse-runner.ts:1738`; replaced with `Math.max(timeoutSeconds, 1)`. AC-SJET-02 passes with `timeoutSeconds: 10`. | Grep assertion: `Math.max(timeoutSeconds, DEFAULT_JUDGE_TIMEOUT)` returns zero hits. | R-SJET-1 |
| AC-SJET-19 | Both `probeJudgeBackendAvailability` and `measureLlmMetricAttempt` throw typed instances. Both invoke `classifyJudgeError(err)` exactly once; neither contains a standalone `/timeout|etimedout/i` regex. AST scan. | `judge-spawn-timeout.test.js` `describe.each` (R-SJET-6). | R-SJET-1 |
| AC-SJET-20 | `grep -c "buildJudgeInvocation('claude'" extension/src/bin/microverse-runner.ts` ≥ 1 after R-SJET-4 lands. `extension/tests/microverse-codex.test.js` + `extension/tests/integration/microverse-runner-judge-failure.test.js` pass without modification (or both updated in the SAME diff with the trap-door amendment). | Grep + test-suite assertion under `npm run test:fast`. | R-SJET-4 |
| AC-SJET-AUTORESUME | Dual fake-claude-hang + fake-codex-hang → pipeline-runner exits `pipeline_phase_incomplete`; auto-resume.sh attempts ≥ 1 resume cycle before R-CNAR-4(a) stop fires. | `auto-resume-on-all-judge-backends-exhausted.test.js`. | T-HARDEN-AUTORESUME + R-SJET-6 |
| AC-SJET-SCHEMA-INVARIANT | Pre-R-SJET-4 `microverse.json` fixture (no `judge_backend_used` in history) loads in post-R-SJET-4 runtime: no `SchemaVersionAheadError`, no `SchemaVersionMismatchError`, no fallback-default pollution. | `microverse-state-judge-backend-used-optional.test.js` (R-SJET-6). | R-SJET-4 + R-SJET-6 |
| AC-SJET-FALLBACK-MEMO | After fallback engages, `state.judge_backend_resolved === 'codex'` persists across `--resume`. Resumed runner reads it and skips claude probe entirely. | `judge-fallback-sticky-resume.test.js` (R-SJET-6). | R-SJET-4 + R-SJET-6 |
| AC-SJET-KILL | `PICKLE_JUDGE_LEGACY_SPAWN=1` restores `stdio: ['pipe', 'pipe', 'pipe']` at both sites AND skips Math.max floor removal AND skips typed-error rewrap. Default-unset uses new shape. | `judge-spawn-legacy-kill-switch.test.js` (R-SJET-6). | R-SJET-1 + R-SJET-6 |
| AC-SJET-PROBE | (Operator-optional) `extension/scripts/repro-judge-timeout.sh` runs three probes and prints decision-tree verdict in `<= 90s` wall. NOT a release gate — pre-validation only. | Operator runs script and logs results to §Post-validation gaps. | T-HARDEN-PROBE |

## Trap doors

Each ticket's `conformance_<ticket>.md` MUST cite verifiable evidence for the relevant rows below:

- **R-SJET-1a (stdio-close)**: PATTERN_SHAPE forbids `stdio: \['pipe', 'pipe', 'pipe'\]` in `measureLlmMetricAttempt`/`probeJudgeCliAvailability` UNLESS guarded by `PICKLE_JUDGE_LEGACY_SPAWN`. ENFORCE: `extension/tests/integration/judge-spawn-legacy-kill-switch.test.js`.
- **R-SJET-1b (typed errors)**: PATTERN_SHAPE requires `instanceof JudgeMeasurementTimeout` in `classifyJudgeError` BEFORE any `/timeout/i` regex. ENFORCE: `judge-spawn-timeout.test.js`.
- **R-SJET-3 (env isolation)**: env-isolation test confirms `CLAUDE_CODE` stripped from spawn env when nested context detected; clean-shell control confirms preserved otherwise. ENFORCE: `judge-spawn-env-isolation.test.js`.
- **R-SJET-4a (judge_backend config)**: pickle_settings.json schema accepts `microverse.judge_backend: 'auto'`; non-strict loader verified; integration test confirms fallback engages on first-attempt typed timeout. ENFORCE: `pickle-utils-microverse-namespace-load.test.js`, `judge-fallback-sticky-resume.test.js`.
- **R-SJET-4b (R-SCJM-5 reconciliation)**: `grep -c "buildJudgeInvocation('claude'" extension/src/bin/microverse-runner.ts` ≥ 1. Worker MUST NOT edit `extension/CLAUDE.md` (R-WSRC ceiling); the prose amendment is OPERATOR-owned in same commit OR deferred to closer manager-tagged work. ENFORCE: `extension/tests/microverse-codex.test.js`, `extension/tests/integration/microverse-runner-judge-failure.test.js`.
- **R-SJET-6 (regression prevention)**: integration tests run under `npm run test:fast` (or `test:integration` if too slow); assert ≤ 12s elapsed under `timeoutSeconds: 10` config. ENFORCE: `judge-spawn-timeout.test.js`.

## Out of scope

- **R-SJET-7 (continue-on-judge-unmeasurable inside microverse-runner).** FULLY DEFERRED to B-SJET-3 design PRD. 3-analyst consensus: conflicts with R-PRJT-2 (pipeline-runner handles `judge_timeout` via finalize-gate) and R-MBLE-2 (`judge_timeout` excluded from `MICROVERSE_FAILURE_REASONS`). Both verified at HEAD `7a280bdb`. AC-SJET-08, `MicroverseHistoryEntry.convergence_status`, and `microverse.continue_on_judge_timeout` all dropped.
- **R-SSDF (Finding #46, codex-worker session-dir firewall conflict).** Separate PRD. Independent of R-SJET.
- **R-CCPM-1b (Finding #45, codex manager hallucinated wedge).** Separate PRD.
- **R-MJCP successor for the probe path.** R-MJCP-2 covers probe ETIMEDOUT misclassification; R-SJET only touches the measurement path. If a future occurrence exhibits hung probe, file R-MJCP-3.
- **Refactoring `measureLlmMetricWithBackoff`'s 4-attempt schedule.** Once per-attempt class is fast-fail (R-SJET-1) + fallback engaged on first failure (R-SJET-4), the 4-attempt schedule becomes a non-issue. Don't co-touch.
- **Switching to Anthropic API direct as the default judge path.** Larger surgery (auth, retry/backoff, rate-limit, streaming). Own design PRD. R-SJET-3 §a explicitly dropped.

## Worker invariants (pre-flight check)

Workers MUST verify before staging:

1. **R-MJCP probe class test passes**: `cd extension && node --test tests/bin/microverse-judge-probe.test.js` exits 0. Diff MUST NOT inadvertently break probe semantics.
2. **R-SCJM-5 literal substring preserved**: `grep -c "buildJudgeInvocation('claude'" extension/src/bin/microverse-runner.ts` ≥ 1.
3. **No LATEST_SCHEMA_VERSION bump**: `git diff extension/src/types/index.ts | grep -c 'LATEST_SCHEMA_VERSION'` = 0.
4. **No edits to deployed paths**: `git diff --name-only | grep -E '^(\\.claude/pickle-rick|~/\\.claude)' | wc -l` = 0.
5. **No state.json/pickle_settings.json/circuit_breaker.json/pipeline-status.json writes**: R-WSRC enforcement via runtime hooks.

## Post-validation gaps

To resolve before bundle close (closer-owned):

1. Run T-HARDEN-PROBE script on reproducer environment, log P1/P2/P3 elapsed + verdict in this section.
2. Verify `pickle_settings.json` source vs deployed: source at repo root (`pickle_settings.json`) updated; install.sh deploys to `~/.claude/pickle-rick/pickle_settings.json`.
3. Confirm install.sh parity gate output: `install_sh_parity_check status=pass`.
4. Verify `MicroverseHistoryEntry.judge_backend_used` is OPTIONAL in deployed `types/index.js` (`md5` parity check).
5. Decision: ship with `judge_backend: 'claude'` default (preserves current behavior); document `'auto'` as operator-recommended in `docs/judge-spawn-troubleshooting.md`. Revisit after 30 days of telemetry from R-SJET-5.
6. Run B-HCAG citation gate against R-SJET-1/3/4/6 conformance docs (gate active in next session after B-HCAG ships; not a blocker for B-SJET-2 close).

## Related findings / bundles

- **Finding #14 R-MJCP** (closed v1.73.0). Same family, different code path.
- **Finding #46 R-SSDF** (filed 2026-05-17 AM). Independent.
- **Finding #45 R-CCPM-1b** (filed 2026-05-17 AM). Independent.
- **Finding #44 R-CTSF** (closed v1.75.2). Establishes the closer-ownership-tag pattern this PRD inherits.
- **Finding #2 B-HCAG** (refined 2026-05-18, F4 deferred). Hallucinated-acceptance gate. R-SJET-1/3/4/6 conformance docs become the first input to the gate when B-HCAG ships.
- **Working Rule 1**. After B-SJET-2 ships, open P1 count = B-QSRC + B-CCPM-1b + B-SSDF = 3 (back at ceiling).
