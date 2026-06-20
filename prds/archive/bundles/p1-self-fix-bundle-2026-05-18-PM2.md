---
title: P1 — Self-Fix Bundle 2026-05-18 PM2 — prevent next hallucinated-tsc commit + finish R-SJET-4 properly + clear pre-existing lint debt + B-PLF launch-friction
status: Refined 2026-05-18 PM2 (3-cycle parallel refinement complete; awaiting operator launch)
filed: 2026-05-18
priority: P1
type: bug-cluster + prevention
code: R-SELFIX2
bundle: B-SELFIX2
heads_at_filing:
  - branch: main
  - sha_pre_bundle: eb4b6a72  # MASTER_PLAN docs for c1837317 recovery
  - sha_recovery: c1837317  # R-SJET-4 revert + R-PIPE-3 matcher tighten + judge-spawn-env tighten *(refined: risk-scope cycle 3 P2)*
related:
  - prds/MASTER_PLAN.md  # Open finding from today: "worker AC gate did not catch a stale tsc state on 7d44f22d"
  - prds/archive/bundles/p1-szechuan-sauce-judge-etimedout-baseline-measurement.md  # source of R-SJET-4 (this bundle pulls it forward; B-SJET-2 closer migrates to this bundle)
  - prds/archive/bundles/p2-pipeline-launch-friction-bundle-2026-05-18.md  # source of R-PSSS / R-SRGT / R-PPSD — pulled in by reference (DO NOT duplicate)
  - prds/archive/bundles/p1-self-fix-mega-campaign-2026-05-19.md  # mega-campaign that ENGAGED but then partial-shipped Phase 0 via 7d44f22d → c1837317 recovery; this bundle is the corrected continuation
findings_closed:
  - "(new) R-WACT — operator/manager commit can land broken tsc state (regression class observed in 7d44f22d)"
  - "#47 R-SJET (residual R-SJET-4 portion only — R-SJET-1/3 already shipped)"
  - "(new) R-LINT — 3 long-standing eslint errors + 1 warning block a clean release gate"
  - "#49 R-PSSS — anatomy-park/szechuan-sauce silent phase-skip (composed from B-PLF, not re-specified here)"
  - "#50 R-SRGT — scope-resolver grep timeout loop (composed from B-PLF)"
  - "#51 R-PPSD — pickle-pipeline doc drift (composed from B-PLF)"
ship_target: v1.76.0  # *(refined: risk-scope cycle 3 — semver corrected from v1.75.6 patch; bundle adds new PreToolUse hook + StateFlags field + 4 activity events + microverse namespace → minor bump per extension/CLAUDE.md§Versioning)*
ship_strategy: |
  Co-ship as v1.76.0. R-WACT lands FIRST (Phase 0) so subsequent tickets
  cannot regress tsc state. R-SJET-4 then R-LINT in parallel-ish (different
  files, no scope overlap). B-PLF tickets composed by reference: refinement
  reads the source PRD and emits the same atomic tickets it already lists.
  Single closer covers all four R-codes + the B-PLF closer work that
  p2-pipeline-launch-friction-bundle-2026-05-18.md§C-PLF-CLOSER already
  defined (B-PLF's own C-PLF-CLOSER is now SUPERSEDED by C-SELFIX2-CLOSER —
  noted in p2 PRD's ship_strategy).
size_note: |
  Bundle exceeds Working Rule 1 "≤3 R-codes" by design — the prevention
  ticket (R-WACT) MUST ship before the others to close the regression class.
  Per-R-code blast radius is small and the four sub-bundles touch disjoint
  files. Refinement produces ~22 tickets after Cycle 2/3 enrichment.
  *(refined: risk-scope cycle 3)* — If a future split is filed, R-WACT-1
  AND R-WACT-2 MUST land in `main` BEFORE any B-SELFIX2-B ticket refines
  (B-SELFIX2-B refinement precondition: `R-WACT-1` status == `Done` in main).
  No regression-class commit can land in the gap between A and B without
  the gate.
---

# R-SELFIX2 — Self-Fix Bundle Round 2 (Prevention + Finish R-SJET-4 + Lint Debt + B-PLF)

**Author**: pickle-rick session 2026-05-18 PM2, post-`c1837317` recovery.
**Project**: pickle-rick-claude
**Repo**: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude`

## Why this bundle exists

The 2026-05-18 PM "mega self-fix campaign" `prds/archive/bundles/p1-self-fix-mega-campaign-2026-05-19.md` launched, completed R-PIPE-1/2 cleanly, then Phase 0 commit `7d44f22d` ALSO committed half-finished WIP R-SJET-4 code that broke `tsc --noEmit` (TS2305 imports of `resolveJudgeBackend` / `getMicroverseSettings` from `pickle-utils.ts` — symbols that don't exist anywhere). That commit additionally violated the enforced R-SCJM-5 trap door by inserting a `buildJudgeInvocation('codex'` backend ternary on the judge spawn path. Three protected test files crashed on module load. `c1837317` recovered (revert SJET-4 + tighten R-PIPE-3 matcher + tighten judge-spawn-env env pruning) and shipped R-PIPE-3/4 + R-SJET-3 cleanly.

The recovery exposed **one new regression class** worth a dedicated prevention ticket, **one half-finished feature** (R-SJET-4) worth finishing properly, **pre-existing lint debt** that has been quietly blocking a green release gate, and **three operator-reported launch-friction bugs** (#49/#50/#51) that the mega-campaign's Phase 3 was supposed to address but never reached.

This bundle is the corrected continuation.

## Symptom + cost

| Class | Symptom | Cost |
|---|---|---|
| R-WACT | Operator/manager can commit a state where `npx tsc --noEmit` fails. Recovery requires a second commit + reverify + re-deploy. | 7d44f22d → c1837317: ~30m operator time + agent fix-team to recover. Recurs on any commit that includes a worker patch the operator stages by hand. |
| R-SJET-4 | Judge ETIMEDOUTs on codex worker backend / nested-claude with no operator escape hatch. `pickle_settings.json` cannot pin the judge to codex even on codex-only accounts. | Per B-SJET-2: 3 observed sessions, 1h 51m wasted, 2 useful commits stranded before judge died. |
| R-LINT | Release gate `npx eslint src/ --max-warnings=-1` exits 1: 3 errors (2× complexity 23, 1× no-useless-assignment) + 1 warning (no-sync-in-async). Required gate per CLAUDE.md "Build & Test". | Every release run trips the gate. Operator either ignores (drift) or hand-overrides (regression risk). |
| B-PLF | Empty/doc-only `--scope branch` launches silently no-op anatomy-park/szechuan-sauce; scope-resolver wedges on empty diff with grep ETIMEDOUT spam; skill docs reference deprecated skip-flag names. | Per B-PLF source PRD: every operator launch on a doc-first branch hits the cluster. |

## User Stories *(refined: requirements cycle 2/3 HELD P0 — one story per R-code)*

- **US-WACT (Operator/Manager)**: As a manager committing changes (mine or a worker-authored patch I'm staging), I need any `git commit` that would land a broken `npx tsc --noEmit` state to be BLOCKED at PreToolUse, so that I cannot recreate the 7d44f22d → c1837317 recovery cycle. When tsc fails, the block message MUST tell me (a) error count, (b) top-3 errors with file:line:col, (c) the exact manager override CLI invocation, and (d) that the override auto-clears on the next successful commit.
- **US-SJET-4 (Operator on a codex-only account)**: As an operator running pickle on a ChatGPT account, I need `pickle_settings.json` to let me pin the microverse judge to codex (or to fall back automatically when claude judge times out), so that judge ETIMEDOUTs in iteration N do not strand 2 useful commits and 1h 51m of work. I MUST also be protected from accidentally pinning a claude-family model under codex (silent false-convergence).
- **US-LINT (Release manager)**: As the release-gate manager, I need `npx eslint src/ --max-warnings=-1` to exit 0 against a clean tree, so that the release-gate audit completes without manual `--no-error-on-unmatched-pattern` overrides.
- **US-PLF (Operator launching a doc-only branch)**: As an operator launching `/pickle-pipeline --scope branch` against a docs-only diff, I need anatomy-park and szechuan-sauce to print a top-level WARN explaining the empty-scope skip, and the scope-resolver to short-circuit in <100ms (no grep ETIMEDOUT spam), so I do not waste 30m reading raw logs to discover the phase was a silent no-op.

## Critical User Journeys *(refined: requirements cycle 2 HELD P0)*

- **CUJ-WACT-1**: Manager stages a worker patch + runs `git commit -m "fix: R-WACT-1"`. tsc-gate validates the staged tree compiles. Result: commit proceeds (≤8s p95 on warm cache).
- **CUJ-WACT-2**: Manager stages a half-finished patch with TS2305 (missing-import) error. Commit attempt → tsc-gate emits `tsc_gate_failed` with `failure_kind: 'compile_error'`, blocks with operator-readable reason, surfaces override CLI.
- **CUJ-WACT-3**: Manager has a legitimate emergency revert. Runs `node extension/bin/update-state.js --set-flag allow_tsc_failed_reason='emergency revert' <session_dir>` (or the documented two-flag StateManager.update chain per US-WACT), then `git commit -m "revert: foo"`. tsc-gate emits `tsc_gate_override_used`, allows commit. Next successful commit consumes flag → emits `tsc_gate_override_consumed`.
- **CUJ-WACT-4**: Operator runs `git log` / `git diff` / `git show` / `git rev-parse`. tsc-gate predicate returns false; handler exits `approve()` in ≤5ms with no IO.
- **CUJ-WACT-5**: tsc hangs (broken tsconfig). tsc-gate inner timeout fires at 8s (`min(8000, PICKLE_DISPATCH_TIMEOUT_MS - 1000)`); emits `tsc_gate_failed` with `failure_kind: 'timeout'`; explicit `block()` (no fail-open).

## Functional Requirements Table *(refined: requirements cycle 2 HELD P0)*

| ID | Requirement | Source Ticket | Verify |
|---|---|---|---|
| FR-WACT-01 | PreToolUse hook MUST block `git commit` when staged-tree `tsc --noEmit` fails | R-WACT-1 | `node --test extension/tests/tsc-gate.test.js` |
| FR-WACT-02 | Hook MUST honor `state.flags.allow_tsc_failed_reason` manager override | R-WACT-1 | Override test in tsc-gate.test.js |
| FR-WACT-03 | Hook MUST skip when staged diff has no tsc-trigger files (`.ts/.tsx/.mts/.cts/package.json/tsconfig.json/package-lock.json`) | R-WACT-1 | Skip-predicate test |
| FR-WACT-04 | Hook MUST emit `tsc_gate_failed` / `tsc_gate_override_used` / `tsc_gate_override_consumed` / `tsc_gate_crashed` activity events | R-WACT-1 | Activity-event schema test |
| FR-WACT-05 | `bash install.sh` MUST install the deployed `tsc-gate.js` and register it in `.claude/settings.json` | R-WACT-2 | install.sh parity stage + AC-WACT-07a/b |
| FR-SJET-4-01 | `pickle-utils.ts` MUST export `resolveJudgeBackend` and `getMicroverseSettings` | R-SJET-4-PRE | Test file passes |
| FR-SJET-4-02 | `pickle_settings.json` MUST contain a `microverse` namespace with 4 keys | R-SJET-4-PRE | `node -e "require('./pickle_settings.json').microverse"` |
| FR-SJET-4-03 | `microverse-runner.ts` judge spawn site MUST remain unconditional `buildJudgeInvocation('claude', …)` | R-SJET-4-RUNNER | `grep -c "buildJudgeInvocation('claude'" microverse-runner.ts` == 1 |
| FR-LINT-01 | `npx eslint src/ --max-warnings=-1` MUST exit 0 | R-LINT-1/2/3 | Release-gate audit |
| FR-PLF-01..07 | (composed verbatim from B-PLF source PRD AC-PLF-01..07 — see §Phase 3) | R-PSSS-1/2/3, R-SRGT-1/2, R-PPSD-1, T-HARDEN-PLF-TESTS | per ticket |

## Risks *(refined: risk-scope cycle 3 — inlined 19-row table verbatim)*

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| RISK-WACT-FAIL-OPEN | tsc-gate hook crashes silently, bypasses gate | Med | High (regression class returns) | AC-WACT-13 asserts `tsc_gate_crashed` activity event (failure_kind=`crashed`) |
| RISK-WACT-WATCHDOG-PREEMPT | dispatch.js 10s watchdog fires before tsc finishes, gate fails open | High | High | Cap tsc-gate timeout at 8s (`min(8000, WATCHDOG_MS - 1000)`); per-handler env override `PICKLE_TSC_GATE_TIMEOUT_MS` |
| RISK-WACT-STAGED-VS-WORKING | tsc reads working tree; misses staged-only content; misses NEW staged files (7d44f22d defect was new-symbol import) | High | High | `git checkout-index --prefix --stage=0` + `git show :<path>` for ADDED files; never `git stash`; never touch working tree |
| RISK-WACT-RECURSIVE-BOOTSTRAP | Override flag requires StateFlags schema change that itself transits tsc-gate; deploy ordering matters | Med | High | Sequence: StateFlags + microverse namespace + handler in one bundle; manager runs the FIRST `bash install.sh` post-bundle; documented two-flag StateManager.update chain available as fallback |
| RISK-SCJM-5-TERNARY-REGRESSION | R-SJET-4-RUNNER ternary re-introduces c1837317-reverted defect (codex rejects claude-sonnet-4-6 → silent false-convergence) | High | Critical (re-creates 7d44f22d failure mode + silent judge corruption) | UNCONDITIONAL `buildJudgeInvocation('claude', …)` at judge spawn site; codex paths route only to worker-iteration backends; test asserts argv contains `'claude'` even when `state.backend = 'codex'` |
| RISK-STATEFLAGS-SCHEMA-DRIFT | StateFlags `allow_tsc_failed_reason` field not declared in source `types/index.ts`; type-check fails when handler reads it | Med | Med | `StateFlags` has `[key: string]: unknown;` index signature → type-level fine; named field added in R-WACT-1 for discoverability *(refined: codebase cycle 3 — demoted from P0 to docs/discoverability; type-level fine without named field)* |
| RISK-MICROVERSE-NAMESPACE-MISSING | `pickle_settings.json` has no `microverse` namespace; `getMicroverseSettings` reads `undefined` everywhere at runtime | High | Med | R-SJET-4-PRE explicitly adds `extension/pickle_settings.json` to "Files to modify" with namespace + 4 keys |
| RISK-SEMVER-MISCALL | v1.75.5 → v1.75.6 patch bump miscategorizes bundle that adds hooks + state flags + activity events | Low | Med (semver drift over time = operator confusion) | C-SELFIX2-CLOSER bumps to v1.76.0 (minor) |
| RISK-BUNDLE-SPLIT-PREVENTION-GAP | If refinement splits, R-WACT (prevention) lands in A and R-SJET-4 (regression risk) lands in B; gap period has no prevention | Med | High | Split predicate REQUIRES `R-WACT-1 in main` as B-SELFIX2-B refinement precondition |
| RISK-WACT-LATENCY | tsc --noEmit adds >5s to every operator commit | Med | Med | AC-WACT-PERF-01 records P95; trigger-token predicate keeps non-TS commits fast |
| RISK-WACT-DEPLOY-MISS | R-WACT-1 ships but install.sh deploy parity missed → silent no-op gate | Low | High | C-SELFIX2-CLOSER step 2 mandatory; AC-WACT-06/07a/b in closer scope |
| RISK-OVERRIDE-PERSIST | `allow_tsc_failed_reason` persists across sessions, gate becomes theater | Med | Med | AC-WACT-09 auto-clear-on-next-success + `tsc_gate_override_consumed` activity event |
| RISK-PLF-DRIFT | B-PLF source PRD edited between draft and refinement → scope drift | Low | Med | Pin source PRD SHA (eb4b6a72) + inline AC content verbatim (both layers) |
| RISK-LINT-TRAPDOOR-REGRESS | Helper extraction in R-LINT-1/2 breaks an unrelated trap door, only caught at closer | Med | High | AC-LINT-1-04 / AC-LINT-2-03 run `audit-trap-door-enforcement.sh` per ticket |
| RISK-TSC-TIMEOUT-FALSE | tsc 8s timeout fires on cold-cache or large fixture, gate falsely blocks | Low | Low | Override flag exists; 8s chosen to respect watchdog |
| RISK-PLUGIN-COLLISION | Operator Husky/.git/hooks/pre-commit double-invokes tsc, breaches watchdog | Low (none in repo) | Med | Closer release notes call out suppression |
| RISK-LINE-NUMBER-DRIFT | R-LINT-2 line anchors invalidated by R-SJET-4-RUNNER's prior land | Med | Low | Replace line numbers with function-name anchors |
| RISK-PLF-AC-NONVERIFIABLE | AC-SELFIX2-07 references AC-PLF-* not in this PRD; cannot be mechanically validated | Med | Med | Inline AC-PLF-* IDs verbatim |
| RISK-SKIP-PREDICATE-EVASION | A commit touching only `package.json` (new typed dep with conflicts) passes the skip; tsc-fail lands | Med | Med | Skip predicate extends to TRIGGER tokens: `.ts/.tsx/.mts/.cts/package.json/tsconfig.json/package-lock.json` |

## Atomic ticket scope (NEW content; B-PLF tickets composed by reference)

### Phase 0 — Prevention (MUST land first)

#### R-WACT-1 (medium, ≤2h) — PreToolUse `git commit` tsc gate

**Goal**: Prevent any `git commit` (operator, manager, or worker) from landing when `npx tsc --noEmit` in `extension/` exits non-zero on the **staged tree** (NOT the working tree). *(refined: risk-scope cycle 2/3 P0; codebase cycle 3 P0)*

**Files to create**:
- `extension/src/hooks/handlers/tsc-gate.ts` (forward-created by R-WACT-1) — new PreToolUse handler. Pattern after `extension/src/hooks/handlers/config-protection.ts`. Triggers on `tool_name === 'Bash'` with `tool_input.command` matching the git-commit predicate.
- `extension/tests/tsc-gate.test.js` (forward-created by R-WACT-1) — regression tests including `describe.each` over the 8 git-commit invocation variants.
- `extension/tests/fixtures/tsc-gate/broken-import.ts` (forward-created by R-WACT-1) — fixture with `import { resolveJudgeBackend } from './nonexistent.js';` producing TS2305.
- `extension/tests/fixtures/tsc-gate/clean.ts` (forward-created by R-WACT-1) — fixture that compiles clean.
- `extension/tests/fixtures/tsc-gate/staged-addition.ts` (forward-created by R-WACT-1) — fixture that exercises staged-NEW-file path (the 7d44f22d defect class). *(refined: risk-scope cycle 3 P0)*
- `extension/tests/fixtures/tsc-gate/hang-tsconfig.json` (forward-created by R-WACT-1) — fixture that makes tsc hang for the timeout AC.
- `extension/tests/fixtures/tsc-gate-replay-7d44f22d.patch` (forward-created by R-WACT-1) — `git format-patch -1 7d44f22dd05e5d` capture committed to the test corpus. *(refined: requirements cycle 2/3 HELD P1)*

**Git-commit predicate** *(refined: requirements cycle 2 AC-WACT-03c collapse + codebase cycle 3 P1 — extend predicate)*:

```ts
function isGitCommitCommand(command: string): boolean {
  if (!command) return false;
  // Strip cd-prefix: "cd <path> && git commit" / "cd <path>; git commit"
  let normalized = command.trim();
  normalized = normalized.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '');
  const tokens = normalized.split(/\s+/);
  let i = 0;
  if (tokens[i] !== 'git') return false;
  i++;
  // Skip `-c key=val` (config-on-command), `-C <path>`, `--git-dir=...`, `--work-tree=...`
  while (i < tokens.length) {
    if (tokens[i] === '-c' && i + 1 < tokens.length) { i += 2; continue; }
    if (tokens[i] === '-C' && i + 1 < tokens.length) { i += 2; continue; }
    if (/^--git-dir=/.test(tokens[i])) { i++; continue; }
    if (/^--work-tree=/.test(tokens[i])) { i++; continue; }
    break;
  }
  return tokens[i] === 'commit';
}
```

Note: `isGitCommitCommand` (forward-created by R-WACT-1) is a private predicate in `tsc-gate.ts`. Command-substitution / `eval` / pipelined forms (`if git commit; then …`) are declared OUT OF SCOPE; documented limitation. *(refined: codebase cycle 3 P1)*

**Skip predicate (REQUIRED to keep operator commits fast)** *(refined: risk-scope cycle 3 P1 — extended trigger set)*:

```ts
function shouldRunTsc(stagedFiles: string[]): boolean {
  const TRIGGER_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
  const TRIGGER_FILENAMES = ['package.json', 'tsconfig.json', 'package-lock.json'];
  return stagedFiles.some(f =>
    TRIGGER_EXTENSIONS.some(ext => f.endsWith(ext)) ||
    TRIGGER_FILENAMES.includes(path.basename(f))
  );
}
```

Skip-predicate runs BEFORE any IO; for non-git-commit commands the handler exits `approve()` within ≤5ms of dispatch entry.

**Staged-tree isolation contract** (REQUIRED — picks `checkout-index --prefix`; forbids `git stash` in hook context) *(refined: risk-scope cycle 2/3 P0; codebase cycle 3 P0)*:

```ts
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-gate-'));
try {
  execFileSync('git', ['checkout-index', `--prefix=${tmpdir}/`, '-a', '--stage=0'], { timeout: 5000 });
  // Handle staged-NEW (added) files — checkout-index --prefix doesn't include them by default
  const addedFiles = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=A'], { encoding: 'utf8', timeout: 2000 }).trim().split('\n').filter(Boolean);
  for (const p of addedFiles) {
    const blob = execFileSync('git', ['show', `:${p}`], { encoding: 'utf8', timeout: 2000 });
    fs.mkdirSync(path.dirname(`${tmpdir}/${p}`), { recursive: true });
    fs.writeFileSync(`${tmpdir}/${p}`, blob);
  }
  const tscBudgetMs = Math.min(8_000, (Number(process.env.PICKLE_DISPATCH_TIMEOUT_MS) || 10_000) - 1000);
  const tscResult = spawnSync('npx', ['tsc', '--noEmit'], { cwd: `${tmpdir}/extension`, timeout: tscBudgetMs });
  // ... compile_error / timeout / setup_error / crashed / approve paths
} finally {
  fs.rmSync(tmpdir, { recursive: true, force: true });
}
```

Forbidden: `git stash push --keep-index`. Rationale: if dispatch.js watchdog fires `process.exit(0)` mid-stash, operator's untracked files are silently stashed with no `git stash pop` ever run.

**Watchdog budget contract** *(refined: codebase cycle 2/3 P0; risk-scope cycle 2/3 P0)*: dispatch.js arms a 10s watchdog at `extension/hooks/dispatch.js:47` (env `PICKLE_DISPATCH_TIMEOUT_MS`, default 10000ms). On expiry, dispatch.js calls `approve()` + `process.exit(0)` — structurally fail-open. tsc-gate inner tsc invocation MUST cap at `Math.min(8000, Number(process.env.PICKLE_TSC_GATE_TIMEOUT_MS) || 8000)` to stay under the dispatch watchdog with 2s safety margin. On tsc-gate inner timeout: emit `tsc_gate_failed` with `gate_payload.failure_kind: 'timeout'` and `block()` — explicit block, NOT fail-open.

**Files to modify**:
- `extension/hooks/dispatch.js` — register `tsc-gate` handler. Matches the existing `config-protection` registration pattern (`HANDLERS_DIR/tsc-gate.js`).
- `extension/src/types/index.ts` — register `tsc_gate_failed`, `tsc_gate_override_used`, `tsc_gate_override_consumed`, `tsc_gate_crashed` in `VALID_ACTIVITY_EVENTS`. *(refined: requirements cycle 2/3 — 4 events; codebase cycle 3 — 5-touchpoint conformance per R-PDD-oneOf)*
- `extension/src/types/index.ts` (`StateFlags` interface) — add `allow_tsc_failed_reason?: string` for discoverability + JSDoc *(refined: requirements cycle 3 P0; codebase cycle 3 — type-level fine without named field but adding it for clarity)*:
  ```ts
  /**
   * Manager-only emergency-revert escape hatch for the R-WACT tsc-gate.
   * Trimmed non-empty string approves a single subsequent commit despite
   * tsc errors; auto-cleared after consumption. Set via documented
   * StateManager.update chain (manager context only).
   * Emits activity events tsc_gate_override_used (on consume) and
   * tsc_gate_override_consumed (on auto-clear).
   */
  allow_tsc_failed_reason?: string;
  ```
- `extension/src/types/activity-events.schema.json` — schema definitions for all 4 events with their `gate_payload` shape; add to `oneOf`. Per R-PDD-oneOf 5-touchpoint conformance. Each `gate_payload` includes `failure_kind` enum `["compile_error", "timeout", "cold_cache_timeout", "setup_error", "crashed"]`. *(refined: risk-scope cycle 3 P1 — reconciled enum)*
- `extension/src/bin/spawn-refinement-team.ts` — update `ACTIVITY_EVENT_SCHEMA_SECTION` for the 4 new events.
- `extension/tests/activity-event-payload.test.js` — add cases for the 4 new events to `EVENT_CASES`.
- `extension/CLAUDE.md` — add to "## ⛔ Worker Forbidden Ops" table: row "tsc errors at commit time | `allow_tsc_failed_reason` (manager-only) | `tsc-gate.ts` hook".
- `extension/src/hooks/CLAUDE.md` — new trap door entry for `handlers/tsc-gate.ts`: INVARIANT (the predicate match), PATTERN_SHAPE (`isGitCommitCommand`), ENFORCE (test file).

**Interface Contracts**:
- **Inputs**: `{ tool_name: 'Bash', tool_input: { command: string }, session_dir?: string }` (PreToolUse hook payload).
- **Outputs**: `{ decision: 'approve' | 'block', reason?: string }` to stdout as JSON (matches `config-protection.ts` contract).
- **Errors**: handler-internal throw → emit `tsc_gate_crashed` activity event + call `approve()` per CLAUDE.md fail-open contract (closer reviews).
- **Invariants**: handler MUST exit within `Math.min(8000, PICKLE_DISPATCH_TIMEOUT_MS - 1000)` ms; MUST NOT touch the working tree (read-only via `checkout-index --prefix`); MUST NOT use `git stash`.

**Acceptance criteria**:
- AC-WACT-01: `npx eslint extension/src/hooks/handlers/tsc-gate.ts --max-warnings=-1` exit 0 — Verify: `npx eslint extension/src/hooks/handlers/tsc-gate.ts --max-warnings=-1` — Type: lint
- AC-WACT-02: `npx tsc --noEmit` from `extension/` exit 0 after diff lands — Verify: `cd extension && npx tsc --noEmit` — Type: typecheck
- AC-WACT-03 (parametrized over 8 git-commit invocation forms via `describe.each`) *(refined: requirements cycle 3 — collapsed per manifest ac_shape_smell)*:
  ```js
  describe.each([
    ['git commit'],
    ['git -c user.email=x commit'],
    ['git -C extension commit'],
    ['git --git-dir=extension/.git commit'],
    ['cd extension && git commit'],
    ['git commit --amend'],
    ['git commit --fixup HEAD'],
    ['git commit --squash HEAD'],
  ])('predicate matches %s', (cmd) => {
    it('isGitCommitCommand returns true', () => assert.equal(isGitCommitCommand(cmd), true));
  });
  ```
  — Verify: `node --test extension/tests/tsc-gate.test.js` — Type: test
- AC-WACT-03-NEG: `isGitCommitCommand('git log')`, `'git diff'`, `'git show'`, `'git rev-parse'`, `'gh pr create --title foo'`, `'gh pr merge --auto'` all return false — Verify: same test file — Type: test *(refined: requirements cycle 3 P1)*
- AC-WACT-03-CASES (handler behavior, distinct CUJs not collapsible per manifest):
  - case 1 (compile_error block): Blocks `git commit` on `broken-import.ts` staged fixture; emits `tsc_gate_failed` with `failure_kind: 'compile_error'`, `error_count: 1`, `sample_errors[0]` matches `/TS2305/`.
  - case 2 (approve clean): Approves `git commit` on `clean.ts` staged fixture.
  - case 3 (skip non-trigger): Approves when staged diff has only `.md` / `.sh` / `.json (non-trigger)` files.
  - case 4 (override): Approves with `state.flags.allow_tsc_failed_reason='emergency revert'`; emits `tsc_gate_override_used`.
  - case 5 (override-consumed): After case-4 approval, next successful commit emits `tsc_gate_override_consumed`; flag cleared from state. *(refined: requirements cycle 2 HELD P0)*
  - case 6 (timeout block): Blocks on `hang-tsconfig.json` fixture at 8s; emits `failure_kind: 'timeout'`.
  - case 7 (setup_error): Blocks with `failure_kind: 'setup_error'` when `tsconfig.json` is invalid JSON.
  - case 8 (crashed fail-open): Handler-internal throw emits `tsc_gate_crashed` + `approve()` per fail-open contract.
  — Verify: `node --test extension/tests/tsc-gate.test.js` — Type: test
- AC-WACT-04: 7d44f22d-replay fixture — apply `extension/tests/fixtures/tsc-gate-replay-7d44f22d.patch` to a clean tree in tmpdir via `git apply --check`, stage, attempt `git commit`, MUST be blocked — Verify: same test file — Type: test
- AC-WACT-04a: Apply the FULL 7d44f22d patch (not just tsc-relevant subset); run `node --test` on the 3 cascade-crash test files; assert tsc-gate blocks the underlying commit so cascade is unreachable in practice *(refined: codebase cycle 3 P0)* — Verify: same test file — Type: test
- AC-WACT-04b: 7d44f22d-replay fixture covers BOTH staged-modifications AND staged-additions cases *(refined: risk-scope cycle 3 P0)* — Verify: same test file — Type: test
- AC-WACT-05: deployed `~/.claude/pickle-rick/extension/hooks/handlers/tsc-gate.js` exists and is executable after `bash install.sh` — Verify: `[ -x ~/.claude/pickle-rick/extension/hooks/handlers/tsc-gate.js ] && echo OK` — Type: lint
- AC-WACT-PERF-01: P95 dispatch-to-approve elapsed ≤ 100ms for `ls -la` (non-trigger Bash) over 100 invocations *(refined: codebase cycle 3 P0)* — Verify: bench fixture in test file — Type: test
- AC-WACT-12a: `PICKLE_TSC_GATE_TIMEOUT_MS=100` triggers `block` with `failure_kind: 'timeout'` against hung-tsc fixture *(refined: risk-scope cycle 3 P0)* — Verify: same test file — Type: test
- AC-WACT-12b: `PICKLE_DISPATCH_TIMEOUT_MS=10000` AND `PICKLE_TSC_GATE_TIMEOUT_MS=15000` → handler exits with `block` at ≤10s (watchdog dominance) — Verify: same test file — Type: test
- AC-WACT-MSG-01: Block reason on compile_error matches regex `/^R-WACT: tsc --noEmit failed with \d+ errors\.\nFirst 3 errors:\n(  .+\n){1,3}\nManager override:[\s\S]*\(auto-cleared after next successful commit\)/m` *(refined: requirements cycle 3 P1)* — Verify: snapshot test on 7d44f22d-replay — Type: test
- AC-WACT-STAGED-01: `grep -nF 'git checkout-index --prefix' extension/src/hooks/handlers/tsc-gate.ts` ≥1 match; `grep -nF 'git stash' extension/src/hooks/handlers/tsc-gate.ts` 0 matches *(refined: requirements cycle 3 P0)* — Verify: shell — Type: lint
- AC-WACT-STATEFLAGS-01: `npx tsc --noEmit` exit 0 with handler reading `state.flags.allow_tsc_failed_reason` — Verify: `cd extension && npx tsc --noEmit` — Type: typecheck

**Trap-door amendment to `extension/CLAUDE.md` "## Required Patterns"**:
> Hook decisions: `"approve"` or `"block"` only (never `"allow"`)
> tsc gate decisions: tsc invocation MUST pass `timeout: min(8000, PICKLE_DISPATCH_TIMEOUT_MS - 1000)`; on timeout, fall through to `block` with `failure_kind: 'timeout'` (do NOT silently approve).

**Out of scope for R-WACT-1**:
- Caching tsc results across commits — file a follow-up if the 5-10s commit latency is annoying.
- Running eslint at commit time — separate ticket (consider R-WACT-3 follow-up).
- `update-state.js --set-flag` CLI ergonomics — descoped to R-WACT-1.5 follow-up (v1.77.0); current bundle uses documented two-flag StateManager.update chain for manager override ingress. *(refined: risk-scope cycle 3 P1 — descoped)*
- Command-substitution / `eval` / pipelined invocation forms (`if git commit; then …`) — documented limitation.

---

#### R-WACT-2 (small, ≤30m) — install.sh installs tsc-gate hook + `.claude/settings.json` source edit + parity check

**Goal**: ensure the deployed `~/.claude/pickle-rick/extension/hooks/handlers/tsc-gate.js` is installed and registered as a PreToolUse hook so it actually fires. *(refined: codebase cycle 2/3 P0; risk-scope cycle 2/3 P0)*

**Files to modify**:
- `install.sh` — add `tsc-gate.js` to the rsync manifest + chmod loop (R-ICM-1 glob already covers `extension/hooks/handlers/`, so this MAY be no-op; verify with the parity check at deploy).
- The MD5 parity gate at the end of `install.sh` — add `extension/hooks/handlers/tsc-gate.js` to the parity check (extend the loop to cover all files in `extension/hooks/handlers/*.js`).
- `.claude/settings.json` (root SOURCE — NOT `~/.claude/settings.json`) — append a SECOND PreToolUse group with matcher `"Bash"` and command `node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js tsc-gate`. The existing first group (matcher `"Write|Edit|Bash"`, command config-protection) is preserved unchanged. *(refined: codebase cycle 2/3 P0)*

**Hook registration strategy / double-dispatch tradeoff** *(refined: codebase cycle 3 P0)*: Adding a second PreToolUse group means every Bash tool invocation triggers two dispatch.js processes serially — config-protection first, tsc-gate second. Per-invocation overhead increases by ~50-150ms for unrelated commands. Mitigation: R-WACT-1's tsc-gate.ts short-circuits within ≤5ms of dispatch entry for any non-trigger command (skip-predicate runs BEFORE any IO).

**Interface Contracts**:
- **Inputs**: state of repo after R-WACT-1 ticket lands.
- **Outputs**: deployed `~/.claude/pickle-rick/extension/hooks/handlers/tsc-gate.js` executable + matching MD5 with source; `~/.claude/settings.json` PreToolUse group present.
- **Errors**: install.sh parity gate fails → exit 1, manager fixes before tagging release.
- **Invariants**: install.sh MUST NOT delete the existing config-protection group; merge MUST be additive.

**Acceptance**:
- AC-WACT-06: `bash install.sh` from a fresh `~/.claude/pickle-rick` clean state installs the gate; deployed `~/.claude/pickle-rick/extension/hooks/handlers/tsc-gate.js` is executable and identical MD5 to source — Verify: `md5sum extension/hooks/handlers/tsc-gate.js ~/.claude/pickle-rick/extension/hooks/handlers/tsc-gate.js` — Type: test
- AC-WACT-07a (worker-verifiable): `git diff HEAD~1..HEAD -- .claude/settings.json` shows a new PreToolUse group with matcher `"Bash"` and command containing `tsc-gate` — Verify: `git diff HEAD~1..HEAD -- .claude/settings.json | grep tsc-gate` — Type: test *(refined: requirements cycle 3 P0)*
- AC-WACT-07b (closer-verifiable): After `bash install.sh`, `jq '.hooks.PreToolUse[] | select(.matcher == "Bash") | .hooks[].command' ~/.claude/settings.json` outputs a string containing `tsc-gate` — Verify: jq command — Type: test

---

### Phase 1 — Finish R-SJET-4 properly

R-SJET-4 is fully specified in `prds/archive/bundles/p1-szechuan-sauce-judge-etimedout-baseline-measurement.md` lines 191-227. This bundle pulls that ticket forward AS WRITTEN with one CRITICAL amendment: the judge spawn site stays UNCONDITIONAL `'claude'` per the c1837317 recovery commit runtime contract. *(refined: risk-scope cycle 2/3 P0; codebase cycle 3 P0)*

#### R-SJET-4-PRE (small, ≤30m) — `pickle-utils.ts` helpers FIRST + `pickle_settings.json` namespace

**Why split out**: The `7d44f22d` failure mode was importing `resolveJudgeBackend` / `getMicroverseSettings` from `pickle-utils.ts` BEFORE those functions existed. Splitting the helper definition into its own ticket lets refinement enforce a strict dependency order: the helpers MUST land before any caller imports them. R-SJET-4-PRE ALSO lands the `pickle_settings.json` `microverse` namespace so the helpers have something to read at runtime. *(refined: risk-scope cycle 3 P0)*

**Files to modify**:
- `extension/src/services/pickle-utils.ts` — add the two exports as specified at p1-szechuan-sauce-judge-etimedout-baseline-measurement.md§R-SJET-4 lines 194-200:
  - `resolveJudgeBackend(state, settings?, attempt?, lastFailure?): 'claude' | 'codex'` (forward-created by R-SJET-4-PRE) — precedence:
    1. `state.flags.judge_backend_override` when present + valid.
    2. `pickle_settings.microverse.judge_backend` (via `loadPickleSettingsBag()`).
    3. Compiled default: `'claude'` (preserves R-SCJM-3 invariant).
    - `'auto'` resolves to `'claude'` on attempt 0 with no prior failure, OR `state.judge_backend_resolved` if set, OR `settings.microverse.judge_backend_fallback ?? 'codex'` on prior `JudgeMeasurementTimeout`/`JudgeMeasurementSpawnFailed`.
  - `getMicroverseSettings(settings: PickleSettings | null)` (forward-created by R-SJET-4-PRE) — typed reader; returns `{ judge_backend, judge_backend_fallback, judge_model_claude, judge_model_codex }` with known-key allowlist. NO `(settings as any)` access.
- `pickle_settings.json` (repo root, source — NOT the deployed copy) — add top-level `microverse` namespace *(refined: risk-scope cycle 3 P0)*:
  ```json
  "microverse": {
    "judge_backend": "claude",
    "judge_backend_fallback": "codex",
    "judge_model_claude": "claude-sonnet-4-6",
    "judge_model_codex": "gpt-5.4"
  }
  ```
  `schema_version` stays at 2 (backward-compat).
- `extension/tests/pickle-utils.test.js` — add ≥4 tests:
  - Default (no settings, no state) → `'claude'`.
  - `state.flags.judge_backend_override = 'codex'` → `'codex'`.
  - `'auto'` resolves to `'claude'` on attempt 0.
  - `'auto'` with `state.judge_backend_resolved = 'codex'` → `'codex'`.

**Interface Contracts**:
- **Inputs**: `resolveJudgeBackend(state: State, settings?: PickleSettings | null, attempt?: number, lastFailure?: JudgeMeasurementError): 'claude' | 'codex'`; `getMicroverseSettings(settings: PickleSettings | null): { judge_backend, judge_backend_fallback, judge_model_claude, judge_model_codex }`.
- **Outputs**: typed `'claude' | 'codex'` (resolveJudgeBackend); typed config object (getMicroverseSettings).
- **Errors**: None thrown — defaults applied on missing/null settings.
- **Invariants**: Default-config path MUST resolve to `'claude'`; `schema_version` MUST stay at 2; no `(settings as any)`.

**Acceptance**:
- AC-SJET-4-PRE-01: `npx tsc --noEmit` exit 0 — Verify: `cd extension && npx tsc --noEmit` — Type: typecheck
- AC-SJET-4-PRE-02: `npx eslint src/services/pickle-utils.ts` exit 0 — Verify: `npx eslint extension/src/services/pickle-utils.ts` — Type: lint
- AC-SJET-4-PRE-03: `node --test extension/tests/pickle-utils.test.js` exit 0 — Verify: `node --test extension/tests/pickle-utils.test.js` — Type: test
- AC-SJET-4-PRE-04: positive grep — `grep -n "^export function resolveJudgeBackend\|^export function getMicroverseSettings" extension/src/services/pickle-utils.ts` returns ≥2 hits *(refined: requirements cycle 2/3 HELD P1 — replace negative AC with positive)* — Verify: shell — Type: lint
- AC-SJET-4-PRE-05: `node -e "const s = JSON.parse(require('fs').readFileSync('pickle_settings.json', 'utf8')); if (s.microverse?.judge_backend !== 'claude') process.exit(1);"` exit 0 *(refined: risk-scope cycle 3 P0)* — Verify: node one-liner — Type: test
- AC-SJET-4-PRE-06: `schema_version` of `pickle_settings.json` is `2` BOTH before AND after this ticket lands (no bump) *(refined: codebase cycle 3 P1)* — Verify: `grep schema_version pickle_settings.json` — Type: lint

#### R-SJET-4-RUNNER (medium, ≤2h) — wire helpers into `microverse-runner.ts` WITHOUT weakening R-SCJM-5

**R-SCJM-5 trap-door enforcement (REVISED — supersedes any prior PRD draft language; supersedes source PRD lines 191-227 for the JUDGE spawn site only)** *(refined: risk-scope cycle 2/3 P0; codebase cycle 3 P0; requirements cycle 3 P0)*:

c1837317's commit message documents that the R-SCJM-5 trap door's RUNTIME purpose is: "codex on ChatGPT accounts rejects claude-sonnet-4-6 and produces silent false-convergence." Therefore, the JUDGE spawn site at `extension/src/bin/microverse-runner.ts:1785` MUST remain an **UNCONDITIONAL** `buildJudgeInvocation('claude', …)` literal call. R-SJET-4 helpers `resolveJudgeBackend` / `getMicroverseSettings` RESOLVE WORKER-ITERATION BACKEND ONLY — they do NOT participate in the judge spawn path. Workers may use codex; judges may not.

No ternary at the judge call site. No conditional inside the `buildJudgeInvocation('claude', …)` argument. The R-SJET-4 source PRD's ternary form (lines 203-208) is SUPERSEDED for the judge site.

**Files to modify** (function-name anchors, NOT line numbers — *refined: risk-scope cycle 3 P1*):
- `extension/src/bin/microverse-runner.ts` — `measureLlmMetricAttempt` function: judge spawn site keeps unconditional `buildJudgeInvocation('claude', ...)`. `probeJudgeCliAvailability(cwd)` renamed to `probeJudgeBackendAvailability(backend: 'claude' | 'codex', cwd: string)` (callers updated).
- `extension/src/bin/microverse-runner.ts` — `measureLlmMetricWithBackoff` function: fallback logic on first typed failure from primary worker-iteration backend, switch `attempt.backend` to fallback for remaining attempts in this iteration; persist `state.judge_backend_resolved = fallback` (worker-iteration sense only). Judge spawn UNAFFECTED.
- `extension/src/types/index.ts` — `MicroverseHistoryEntry.judge_backend_used?: 'claude' | 'codex'` (OPTIONAL, backward-compat); `State.judge_backend_resolved?: 'claude' | 'codex'` (OPTIONAL). Workers MUST NOT bump `LATEST_SCHEMA_VERSION`.
- `extension/CLAUDE.md` (R-SCJM-5 trap-door INVARIANT text) — keep current text intact (the no-ternary rule STAYS); add a NEW paragraph clarifying that worker-iteration `resolveJudgeBackend` exists but does NOT cross into the judge spawn path. *(refined: risk-scope cycle 3 P0 — supersedes source PRD line 217 prose that would relax the rule)*
- `extension/tests/microverse-codex.test.js` — keep the existing UNCONDITIONAL `assert.equal(captured.cmd, 'claude', …)` assertion when `state.backend = 'codex'` (this is the dynamic guard from c1837317; per Cycle 3 P0, DO NOT rewrite to config-conditional).
- `extension/tests/integration/microverse-runner-judge-failure.test.js` — symmetric: judge spawn still asserts `'claude'` unconditionally.

**Interface Contracts**:
- **Inputs**: state, settings; worker-iteration attempt context.
- **Outputs**: `measureLlmMetricAttempt` returns judge result; on judge spawn site, `buildJudgeInvocation('claude', ...)` is invoked with worker-iteration cwd; on probe site, `probeJudgeBackendAvailability(backend, cwd)`.
- **Errors**: typed `JudgeMeasurementTimeout` / `JudgeMeasurementSpawnFailed` on judge failure → fallback engages for worker-iteration backend only.
- **Invariants**:
  - `grep -c "buildJudgeInvocation('claude'" extension/src/bin/microverse-runner.ts` == 1 (the judge site, UNCONDITIONAL).
  - `grep -nE '\?\s*buildJudgeInvocation' extension/src/bin/microverse-runner.ts` returns 0 matches.
  - Default-config behavioral test (`microverse-codex.test.js`) unchanged.

**Acceptance**:
- AC-SJET-4-RUNNER-01: `npx tsc --noEmit` exit 0 — Verify: `cd extension && npx tsc --noEmit` — Type: typecheck
- AC-SJET-4-RUNNER-02: `npx eslint src/bin/microverse-runner.ts` exit 0 — Verify: shell — Type: lint
- AC-SJET-4-RUNNER-Bundle-01 (R-SCJM-5 literal-grep): `grep -c "buildJudgeInvocation('claude'" extension/src/bin/microverse-runner.ts` == 1 *(refined: risk-scope cycle 3 P2 — count clarified as exactly 1 at the judge site)* — Verify: shell — Type: lint
- AC-SJET-4-RUNNER-CONTRACT-01: `grep -nE '\?\s*buildJudgeInvocation' extension/src/bin/microverse-runner.ts` returns 0 matches; PR description cites c1837317 commit message verbatim *(refined: requirements cycle 3 P0)* — Verify: shell — Type: lint
- AC-SJET-4-RUNNER-Bundle-03 (semantic argv test): when `state.backend = 'codex'` AND `resolvedBackend = 'codex'`, the judge spawn site STILL invokes `buildJudgeInvocation('claude', …)` — assert via `argv[]` capture from a fake-codex CLI fixture *(refined: requirements cycle 2/3 HELD P0)* — Verify: `node --test extension/tests/microverse-codex.test.js` — Type: test
- AC-SJET-4-RUNNER-Bundle-04: default `pickle_settings.json` (no `microverse.judge_backend` key OR `judge_backend: 'claude'`) routes judge to claude — assert via integration test with `state.backend = 'codex'` AND empty microverse settings → `captured.cmd === 'claude'` *(refined: codebase cycle 3 P0)* — Verify: test file — Type: test
- AC-SJET-4-RUNNER-Bundle-05: `probeJudgeCliAvailability\b` returns 0 matches after this ticket lands (renamed to `probeJudgeBackendAvailability`) *(refined: codebase cycle 3 P2)* — Verify: shell — Type: lint

#### R-SJET-4-TESTS (small, ≤1h) — Integration tests pulled forward from R-SJET-6

**Files to create** (composed from R-SJET-6 in source PRD lines 229-252; pulling ONLY the subset relevant to R-SJET-4):
- `extension/tests/integration/judge-fallback-sticky-resume.test.js` (forward-created by R-SJET-4-TESTS) — fake-claude-hang in iteration N: asserts attempt N+1 uses codex for the WORKER backend only (judge stays claude). Simulates `--resume`: asserts `state.judge_backend_resolved === 'codex'` was read in worker-iteration sense; runner skips claude probe for worker iteration but judge always probes claude.
- `extension/tests/services/microverse-state-judge-backend-used-optional.test.js` (forward-created by R-SJET-4-TESTS) — pre-R-SJET-4 `microverse.json` fixture loads cleanly in post-R-SJET-4 runtime; `judge_backend_used` is optional.
- `extension/tests/pickle-utils-microverse-namespace-load.test.js` (forward-created by R-SJET-4-TESTS) — `pickle_settings.json` fixture with `microverse.judge_backend: 'auto'` loads via `loadPickleSettingsBag` + `getMicroverseSettings` without error.

The remaining R-SJET-6 tickets are **out of scope for this bundle**; ship with B-SJET-3 follow-up.

**Interface Contracts**:
- **Inputs**: test runner state; mock judge spawn captures.
- **Outputs**: pass/fail via `node --test`.
- **Errors**: test assertion failures.
- **Invariants**: tests MUST exercise only the worker-iteration backend resolution path; judge spawn assertion stays unconditional `'claude'`.

**Acceptance**:
- AC-SJET-4-TESTS-01: All three test files exit 0 under `node --test` — Verify: `node --test extension/tests/integration/judge-fallback-sticky-resume.test.js extension/tests/services/microverse-state-judge-backend-used-optional.test.js extension/tests/pickle-utils-microverse-namespace-load.test.js` — Type: test

---

### Phase 2 — Lint debt

#### R-LINT-1 (small, ≤30m) — `mux-runner.ts:reconcileTicketStateDesync` complexity reduction

**Function-name anchors** *(refined: risk-scope cycle 3 P1 — replace line numbers with function names)*:

**Files to modify**:
- `extension/src/bin/mux-runner.ts` — extract helpers from `reconcileTicketStateDesync` to bring complexity from 23 → ≤15. Suggested decomposition: extract the four-way frontmatter/state-current-ticket reconciliation logic into a separate `resolveTicketDesyncWinner(state, frontmatterStatuses): { winner, action }` helper; main function orchestrates.
- `extension/src/bin/mux-runner.ts` — remove the no-useless-assignment on `currentPhase` (assignment is unreachable / overwritten before use).
- `extension/tests/mux-runner-reconcile-refactor-parity.test.js` (forward-created by R-LINT-1) *(refined: requirements/codebase cycle 2/3 P1)* — pre/post-refactor parity test exercising 4 short-circuit fixtures + 1 desync-detected fixture per Codebase analyst recommendation #4.

**Trap-door respect**: R-LINT-1's extraction MUST preserve the four short-circuits at `tickets.length === 0`, `alreadySynced`, `inProgress.length === 0 && status === 'failed'`, `inProgress.length === 0 && status === 'done' && hasManagerHandoff` and their emission order (short-circuits 3 and 4 do NOT emit `ticket_state_desync_detected`).

**Interface Contracts**:
- **Inputs**: state, frontmatterStatuses (per-ticket).
- **Outputs**: `{ winner: TicketID, action: 'sync' | 'noop' }` from `resolveTicketDesyncWinner`; main function preserves existing return shape `readRunnerState(statePath)`.
- **Errors**: same as pre-refactor (no new throws).
- **Invariants**: 4 short-circuits + their order preserved; `ticket_state_desync_detected` emitted only on the desync path (cases other than 3, 4).

**Acceptance**:
- AC-LINT-1-01: `npx eslint extension/src/bin/mux-runner.ts -f stylish` shows 0 errors (down from 2) — Verify: shell — Type: lint
- AC-LINT-1-02: `node --test extension/tests/setup-resume-ticket-status-preserved.test.js` exit 0 — Verify: shell — Type: test
- AC-LINT-1-03: `node --test extension/tests/mux-runner-reconcile-refactor-parity.test.js` exit 0 — Verify: shell — Type: test
- AC-LINT-1-04: `bash extension/scripts/audit-trap-door-enforcement.sh` exit 0 *(refined: codebase cycle 3 P1)* — Verify: shell — Type: lint

#### R-LINT-2 (small, ≤30m) — `microverse-runner.ts:measureLlmMetricWithBackoff` complexity reduction (AFTER R-SJET-4-RUNNER)

**Files to modify**:
- `extension/src/bin/microverse-runner.ts` (function `measureLlmMetricWithBackoff`) — extract: probe-classification block → `classifyProbeOutcome(probe)`; backoff-loop body → `runJudgeBackoffAttempt(...)`; aggregate-failure switch — already factored, leave alone.

**Order constraint**: MUST land AFTER R-SJET-4-RUNNER (same function; otherwise refactors get clobbered).

**Acceptance**:
- AC-LINT-2-01: `npx eslint extension/src/bin/microverse-runner.ts -f stylish` shows 0 complexity errors — Verify: shell — Type: lint
- AC-LINT-2-02: Function complexity ≤15 (or ≤18 if measured post-R-SJET-4-RUNNER per codebase cycle 3 expansion) — Verify: eslint report — Type: lint
- AC-LINT-2-03: `bash extension/scripts/audit-trap-door-enforcement.sh` exit 0 — Verify: shell — Type: lint
- AC-LINT-2-04: All trap-door tests for microverse-runner.ts pass (R-SCJM-5, R-MBLE-1/7/8, R-PRJT-2, R-SJET-1a/1b) — Verify: `node --test extension/tests/microverse-codex.test.js extension/tests/microverse-runner*.test.js` — Type: test

#### R-LINT-3 (small, ≤15m) — `spawn-morty.ts:988` sync-fs-in-async warning

**Files to modify**:
- `extension/src/bin/spawn-morty.ts:988` — replace `fs.existsSync()` inside the async function with `pathExists(path)` helper from `extension/src/services/pickle-utils.ts` (verified to exist at ~line 1100 per codebase cycle 3). Or `await fs.promises.access().then(() => true).catch(() => false)` if `pathExists` doesn't fit the signature.

**Acceptance**:
- AC-LINT-3-01: `npx eslint extension/src/bin/spawn-morty.ts` shows 0 warnings and 0 errors — Verify: shell — Type: lint

---

### Phase 3 — Launch friction (composed from B-PLF source PRD)

**Composition contract**: Tickets composed verbatim from `prds/archive/bundles/p2-pipeline-launch-friction-bundle-2026-05-18.md` (sha `eb4b6a72`, captured 2026-05-18) *(refined: requirements cycle 2/3 HELD P0 — inline AC content verbatim instead of line-reference)*.

#### R-PSSS-1 (small, ≤30m) — anatomy-park empty-scope WARN

**Files to modify** (source: B-PLF§R-PSSS-1 lines 61-75):
- `extension/src/bin/anatomy-park.ts` — locate the `setup returned false` / `scope filter excluded all subsystems` branch; before returning false, emit top-level WARN to `${SESSION_ROOT}/anatomy-park-runner.log` AND `${SESSION_ROOT}/state.json.activity`:
  ```
  ⚠ anatomy-park did not run: scope=<mode> produced 0 in-scope subsystems.
    Branch diff contained: <comma-list of file paths>
    Hint: this phase inspects code subsystems; doc-only diffs do not qualify.
  ```
- Add `anatomy_park_empty_scope_skip` (forward-created by R-PSSS-1) to `VALID_ACTIVITY_EVENTS` + `extension/src/types/activity-events.schema.json` (5-touchpoint per R-PDD-oneOf).

**Acceptance** (AC-PLF-01 verbatim):
- AC-PLF-01: anatomy-park emits top-level WARN + activity event on empty-scope skip — Verify: fixture launch on docs-only diff, log + `jq` on state.json.activity — Type: test

#### R-PSSS-2 (small, ≤30m) — szechuan-sauce empty-scope WARN

**Files to modify** (source: B-PLF§R-PSSS-2 lines 77-83):
- `extension/src/bin/szechuan-sauce.ts` — symmetric fix to R-PSSS-1; `szechuan_sauce_empty_scope_skip` (forward-created by R-PSSS-2) registered in 5 touchpoints.

**Acceptance** (AC-PLF-02 verbatim):
- AC-PLF-02: szechuan-sauce emits top-level WARN + activity event on empty-scope skip — Verify: symmetric to AC-PLF-01 — Type: test

#### R-PSSS-3 (small, ≤30m) — `pipeline-status.json` `skip_reason` field [operator-launched]

**Owner**: `extension/src/bin/pipeline-runner.ts` ONLY (existing `pipeline-status.json` writer per trap-door `src/bin/pipeline-runner.ts (status)`) *(refined: codebase cycle 2/3 P0)*.

**Files to modify** (source: B-PLF§R-PSSS-3 lines 85-94):
- `extension/src/bin/pipeline-runner.ts` — extend `pipeline-status.json` per-phase record to include `skip_reason` (string enum: `"empty_scope"`, `"config_disabled"`, `"prerequisite_failed"`, `null`). Writes via existing tmp-rename pattern; NO `fs.writeFileSync` to `pipeline-status.json` added in any other file.
- Final pipeline report line renders e.g. `anatomy-park ⏭ (empty scope)`.

**Acceptance** (AC-PLF-03 verbatim):
- AC-PLF-03: pipeline-status.json records `skip_reason` per phase; final report renders disposition — Verify: integration fixture (doc-only diff) → `jq '.phases.anatomy_park.skip_reason'` == `"empty_scope"` — Type: test
- AC-PSSS-3-OWNER: `grep -n "writeFileSync.*pipeline-status" extension/src/` shows matches ONLY in `pipeline-runner.ts` — Verify: shell — Type: lint

#### R-SRGT-1 (small, ≤30m) — scope-resolver empty-diff short-circuit

**Files to modify** (source: B-PLF§R-SRGT-1 lines 96-109):
- `extension/src/services/scope-resolver.ts` — when initial file set is empty:
  ```ts
  if (initialFileSet.size === 0) {
    log.info('scope-resolver: empty initial diff; skipping import walk');
    return { allowed: [], scope_resolved_at: new Date().toISOString() };
  }
  ```
  No grep, no subprocess, no retries.

**Acceptance** (AC-PLF-04 verbatim):
- AC-PLF-04: scope-resolver short-circuits on empty diff (<100ms, no grep spawn) — Verify: unit test + instrumentation — Type: test

#### R-SRGT-2 (small, ≤30m) — scope-resolver grep timeout caps

**Files to modify** (source: B-PLF§R-SRGT-2 lines 111-120):
- `extension/src/services/scope-resolver.ts` — defensive caps on grep import-walk: per-grep 5s timeout; 3 retries per target; 60s total wall-clock.

**Acceptance** (AC-PLF-05 verbatim):
- AC-PLF-05: scope-resolver grep cap (5s / 3 retries / 60s total) fires correctly — Verify: unit test with slow-grep mock — Type: test

#### R-PPSD-1 (small, ≤15m, DOC-ONLY) — `pickle-pipeline.md` skip-flag doc update

**Files to modify** (source: B-PLF§R-PPSD-1 lines 122-145):
- `extension/.claude/commands/pickle-pipeline.md` § "Skip-flag overrides" — document unified `skip_quality_gates_reason` flag as primary; legacy `skip_readiness_reason`/`skip_ticket_audit_reason` clearly labeled as legacy.
- `extension/.claude/commands/pickle-tmux.md` § "Skip-flag overrides" if it has the same drift.

**Acceptance** (AC-PLF-06 verbatim):
- AC-PLF-06: pickle-pipeline skill docs reference `skip_quality_gates_reason` as primary; legacy flags labeled — Verify: `grep "skip_quality_gates_reason" extension/.claude/commands/pickle-pipeline.md` AND `grep "skip_readiness_reason" extension/.claude/commands/pickle-pipeline.md | grep -i legacy` — Type: test

#### T-HARDEN-PLF-TESTS (small, ≤30m) — integration tests for empty-diff / doc-only-diff launch

**Files to create** (source: B-PLF§T-HARDEN-PLF-TESTS lines 149-160):
- `extension/tests/integration/pipeline-launch-friction.test.js` (forward-created by T-HARDEN-PLF-TESTS).

**Coverage**:
1. Branch with 0 commits ahead → scope-resolver returns empty allowlist in <100ms; pipeline-status.json records `pickle.skip_reason: "empty_scope"` if applicable.
2. Branch with `docs/foo.md` only → anatomy-park emits `anatomy_park_empty_scope_skip` activity event; final report distinguishes skip type.
3. Branch with intentionally-slow grep target → scope-resolver R-SRGT-2 caps fire correctly.

**Acceptance** (AC-PLF-07 verbatim):
- AC-PLF-07: integration test suite covers all three launch-friction fixtures — Verify: `npm run test:integration` — Type: test

---

## Hardening

### T-HARDEN-SELFIX2-WACT-DEPLOY (small, ≤30m) — deploy-lifecycle soak coverage for tsc-gate

**Files to modify**:
- `extension/tests/integration/deploy-lifecycle-soak.test.js` — add a soak case: after `bash install.sh`, run a fixture commit that touches a .ts file with a deliberately-broken type; assert the deployed `tsc-gate` hook blocks the commit with `tsc_gate_failed` activity event.

**Interface Contracts**:
- **Inputs**: `SOAK_SECONDS >= 1800` env, `RUN_EXPENSIVE_TESTS=1`.
- **Outputs**: pass/fail via `node --test`.
- **Errors**: SOAK_SECONDS precondition <1800 → test throws.
- **Invariants**: new tsc-gate case adds ≤120s to total soak runtime; structured as a sub-test within the existing 1800s loop, not a separate top-level test *(refined: codebase cycle 3 P1; risk-scope cycle 3 P1)*.

**Acceptance**:
- AC-HARDEN-WACT-DEPLOY-01: `RUN_EXPENSIVE_TESTS=1 npm run test:expensive` exit 0 with the new soak case — Verify: shell — Type: test
- AC-HARDEN-WACT-DEPLOY-02: soak test honors `SOAK_SECONDS >= 1800` precondition; new tsc-gate case is sub-test within the soak loop — Verify: test file inspection — Type: lint

---

## Closer

### C-SELFIX2-CLOSER [manager] (small, ≤45m) — bundle ship

**Manager-owned work**:
1. [manager] `cd extension && npx tsc` rebuild all compiled mirrors per `extension/CLAUDE.md§Source of Truth` *(refined: codebase cycle 3 P2; risk-scope cycle 3 P2 — replaced manual enumeration with whole-tree rebuild)*.
2. [manager] `bash install.sh` parity check (R-WSRC).
3. [worker-runnable, manager-supervised] Full release-gate audit per `extension/CLAUDE.md§Build & Test`:
   ```
   npx tsc --noEmit && \
   npx eslint src/ --max-warnings=-1 && \
   bash scripts/audit-test-tiers.sh && \
   bash scripts/audit-test-isolation.sh && \
   bash scripts/audit-fix-commits.sh && \
   bash scripts/audit-bundle-thesis.sh && \
   bash scripts/audit-quarantine.sh && \
   bash scripts/audit-trap-door-enforcement.sh && \
   npm run test:fast && \
   npm run test:integration && \
   RUN_EXPENSIVE_TESTS=1 npm run test:expensive
   ```
4. [manager] Bump `extension/package.json` 1.75.5 → **1.76.0** (minor — new PreToolUse hook + StateFlags field + 4 activity events + microverse namespace per CLAUDE.md§Versioning) *(refined: risk-scope cycle 3 P0)*. Commit `chore: bump version to 1.76.0`.
5. [manager] `gh release create v1.76.0` with release notes covering all four R-codes + composed B-PLF. Call out potential Husky/.git/hooks/pre-commit collision (RISK-PLUGIN-COLLISION) and operator suppression guidance.
6. [manager] `prds/MASTER_PLAN.md` update: mark R-WACT / R-SJET-4 (residual) / R-LINT / R-PSSS / R-SRGT / R-PPSD findings closed; add the bundle row; note B-SJET-2 closer migrated (owes R-SJET-6 remainder + 4 T-HARDEN + C-SJET-CLOSER → B-SJET-3 follow-up).

**Per R-CTSF**: every release/install/tag/publish AC line tagged `[manager]`; release-gate audit lines tagged `[worker-runnable]`.

---

## Wiring ticket (Step 7d Skip Gate fires — library variant) *(refined: skill Step 7d — multi-module integration)*

### R-SELFIX2-WIRE (small, ≤30m) — end-to-end integration on v1.76.0-eve tree

**Why this exists**: Bundle touches `extension/src/hooks/` + `extension/src/bin/` + `extension/src/services/` + `extension/src/types/` + `extension/tests/` + `extension/.claude/commands/` + repo-root `pickle_settings.json` + repo-root `.claude/settings.json`. Library variant — no runnable application to spawn; verification is via the release-gate audit pipeline.

**Files to verify** (no NEW writes): the union of all `Files to modify` / `Files to create` from R-WACT-1, R-WACT-2, R-SJET-4-PRE, R-SJET-4-RUNNER, R-SJET-4-TESTS, R-LINT-1/2/3, R-PSSS-1/2/3, R-SRGT-1/2, R-PPSD-1, T-HARDEN-PLF-TESTS, T-HARDEN-SELFIX2-WACT-DEPLOY.

**Acceptance**:
- AC-WIRE-01: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1` exit 0 — Verify: shell — Type: typecheck
- AC-WIRE-02: `npm run test:fast && npm run test:integration` exit 0 — Verify: shell — Type: test
- AC-WIRE-03: `git diff --name-only main..HEAD` includes all expected per-ticket files — Verify: shell — Type: lint

---

## Acceptance criteria (bundle-level)

| ID | Criterion | Evidence |
|---|---|---|
| AC-SELFIX2-01 | R-WACT-1 hook installed and blocks broken-tsc commits | tsc-gate.test.js + 7d44f22d replay fixture |
| AC-SELFIX2-02 | R-WACT-2 deploy parity: install.sh installs tsc-gate.js executable + parity-checked; `.claude/settings.json` source committed | install.sh parity stage exit 0; jq on deployed |
| AC-SELFIX2-03 | R-SJET-4 helpers exist in pickle-utils.ts with passing tests; microverse namespace in pickle_settings.json | pickle-utils.test.js exit 0; node -e check |
| AC-SELFIX2-04 | R-SJET-4 runner wiring lands WITHOUT violating R-SCJM-5 literal-grep (judge stays unconditional `'claude'`) | `grep -c "buildJudgeInvocation('claude'" extension/src/bin/microverse-runner.ts` == 1; `grep -nE '\?\s*buildJudgeInvocation'` == 0 |
| AC-SELFIX2-05 | R-SJET-4 fallback-sticky-resume integration tests pass | judge-fallback-sticky-resume.test.js exit 0 |
| AC-SELFIX2-06 | R-LINT 4 errors + 1 warning resolved | `npx eslint extension/src/ --max-warnings=-1` exit 0 |
| AC-SELFIX2-07 | B-PLF composed tickets all shipped under this bundle — all 7 AC-PLF-01..07 IDs pass *(refined: requirements cycle 2/3 HELD P2 — concrete count)* | per-ticket assertions |
| AC-SELFIX2-08 | Full release gate green (all 8 audit scripts + 3 test tiers) | release gate command exit 0 |
| AC-SELFIX2-09 | v1.76.0 tagged + released *(refined: risk-scope cycle 3 P0)* | `gh release view v1.76.0` |
| AC-SELFIX2-10 | MASTER_PLAN updated with closed findings + bundle row | git log + grep MASTER_PLAN |
| AC-SELFIX2-MIRROR-01 | Every worker ticket editing `extension/src/**/*.ts` includes matching `extension/{services,bin,types,hooks}/**/*.js` mirror rebuilt in the SAME patch *(refined: requirements cycle 3 P1)* | `git diff --name-only HEAD~<N>..HEAD` shows .ts/.js pairs |
| AC-SELFIX2-CLOSER | Bundle shipped end-to-end with operator deploy verification | `bash install.sh` source/deployed MD5 parity passes |

## Out of scope

- **R-SJET-6 remainder** (fake-claude-hang fixture, judge-spawn-timeout test, legacy-kill-switch test, env-isolation test, auto-resume integration test, codex-judge-prompt-compat test) — files B-SJET-3 follow-up.
- **R-SSDF** (szechuan-sauce session-dir firewall) — mega-campaign Phase 2; separate bundle.
- **R-CSI forensics** — mega-campaign Phase 4; separate bundle.
- **B-PIPE-FIX residual** (T-HARDEN-PIPE-EVENTS, C-PIPE-CLOSER) — folded into C-SELFIX2-CLOSER's release-notes-and-MASTER-PLAN work.
- **Pre-commit hook for non-tsc gates** (eslint, prettier, etc.) — file as R-WACT-3 follow-up if operator wants.
- **`update-state.js --set-flag` CLI ergonomics** — R-WACT-1.5 follow-up (v1.77.0); current bundle uses documented two-flag StateManager.update chain *(refined: risk-scope cycle 3 P1 — descoped)*.
- **R-SJET-4-MODEL-GUARD** (refuse judge spawn when `judge_backend === 'codex'` AND `judge_model` matches `/^claude-/`) — codebase cycle 3 recommended sibling; NOT included because Cycle 3 hardened R-SJET-4-RUNNER keeps judge unconditional `'claude'`, making the guard redundant.

## Implementation strategy

**Phase order** (refinement MUST honor):
1. **R-WACT-1** ships FIRST and is verified green before any other ticket commits. Non-negotiable.
2. **R-WACT-2** deploy parity ships immediately after R-WACT-1.
3. **R-SJET-4-PRE** (helpers + pickle_settings.json microverse namespace) lands before R-SJET-4-RUNNER.
4. **R-SJET-4-RUNNER** + **R-LINT-1** + **R-LINT-3** + **R-PPSD-1** (doc-only) ship in any order — different files, no overlap.
5. **R-LINT-2** ships AFTER R-SJET-4-RUNNER (same function).
6. **R-PSSS-1/2/3 + R-SRGT-1/2 + T-HARDEN-PLF-TESTS** ship in B-PLF order from source PRD.
7. **R-SJET-4-TESTS** ships AFTER R-SJET-4-RUNNER.
8. **T-HARDEN-SELFIX2-WACT-DEPLOY** ships once all worker tickets land.
9. **R-SELFIX2-WIRE** integration verification.
10. **4 T-SELFIX2-* hardening tickets** (Code Quality / Dataflow Audit / Test Quality / Cross-Reference) after wiring.
11. **C-SELFIX2-CLOSER** ships last.

**Backend**: Prefer claude for hook-handler work (R-WACT-1) and judge-related work (R-SJET-4) — both need consistent reasoning across complex types and trap-door invariants. Codex acceptable for pure TS edits in R-LINT helpers and B-PLF wiring, R-PPSD-1 (docs).

**Tier hints**: R-WACT-1 medium; R-WACT-2 small; R-SJET-4-PRE small; R-SJET-4-RUNNER medium; R-SJET-4-TESTS small; R-LINT-1/2/3 small each; B-PLF composed tickets small; T-HARDEN-SELFIX2-WACT-DEPLOY small; R-SELFIX2-WIRE small; 4 hardening medium-large each; C-SELFIX2-CLOSER small (≤45m, manager).

## Post-validation gaps

1. Run a deliberate "operator commits half-finished ticket" scenario after R-WACT-1 ships; confirm the gate fires and the 7d44f22d failure mode cannot recur.
2. Confirm R-SJET-4 fallback sticky-resume works on a real codex-only environment — fake-hang fixtures alone may not exercise the codex spawn path.
3. Watch one real `/pickle-pipeline --scope branch` on a doc-only diff after R-PSSS / R-SRGT land; confirm WARN is operator-visible and scope-resolver short-circuits within 100ms.
4. Verify R-LINT-1 / R-LINT-2 helper extractions don't regress any trap-door tests (R-SRTS-1, R-SCJM-5, R-MBLE-*, R-PRJT-2, R-SJET-1a/1b).
5. Confirm dispatch.js double-dispatch (config-protection + tsc-gate) does not blow operator commit p95 latency budget for non-trigger Bash commands (AC-WACT-PERF-01) *(refined: codebase cycle 3 P0)*.

## Related findings / bundles

- **`p1-self-fix-mega-campaign-2026-05-19.md`** — partial-shipped Phase 0 (R-PIPE-3/4 + R-SJET-3 via 7d44f22d + c1837317). This bundle is the corrected continuation.
- **`p1-szechuan-sauce-judge-etimedout-baseline-measurement.md`** — source of R-SJET-4 spec; this bundle pulls R-SJET-4 forward with the c1837317-supersession of the judge-site ternary.
- **`p2-pipeline-launch-friction-bundle-2026-05-18.md`** — source of R-PSSS / R-SRGT / R-PPSD specs (sha eb4b6a72); pulled forward by reference. `C-PLF-CLOSER` SUPERSEDED by `C-SELFIX2-CLOSER`.
- **c1837317 commit** — also tightened `extension/src/services/judge-spawn-env.ts`; this bundle does NOT re-edit that file *(refined: risk-scope cycle 3 P2 — refinement should know)*.
- **Open finding from c1837317 review** — "worker AC gate did not catch a stale tsc state on 7d44f22d" — R-WACT-1 closes this with the hook-based gate.

## R-WSRC compliance check (worker forbidden ops)

All worker tickets in this bundle:
- Do NOT write to `state.json` / `pickle_settings.json` / `circuit_breaker.json` / `pipeline-status.json` directly — except R-PSSS-3 which extends `pipeline-status.json` schema; that ticket is operator-launched (`[operator-launched]` tag), routed through the existing `pipeline-runner.ts` writer (NOT raw `fs.writeFileSync`).
- Do NOT bump `LATEST_SCHEMA_VERSION`. R-SJET-4 OPTIONAL field adds only; pre-bump readers tolerate `undefined`.
- Do NOT run `bash install.sh` from worker context — R-WACT-2 deploy parity work is manager-owned at C-SELFIX2-CLOSER.
- Do NOT touch `~/.claude/pickle-rick/**` — all edits in `extension/src/` + `extension/.claude/commands/` + `extension/tests/` + repo-root `pickle_settings.json` + repo-root `.claude/settings.json`.

C-SELFIX2-CLOSER is manager-owned [manager] per R-CTSF.

---

## Implementation Task Breakdown

| Order | ID | Title | Priority | Tier | Files |
|---:|---|---|---|---|---|
| 10 | R-WACT-1 | PreToolUse git-commit tsc gate (parametrized over 8 invocation forms) | High | medium | `extension/src/hooks/handlers/tsc-gate.ts`, `extension/tests/tsc-gate.test.js`, fixtures, `extension/src/types/index.ts`, `extension/src/types/activity-events.schema.json`, `extension/CLAUDE.md`, `extension/src/hooks/CLAUDE.md` |
| 20 | R-WACT-2 | install.sh + .claude/settings.json registration + parity | High | small | `install.sh`, `.claude/settings.json` |
| 30 | R-SJET-4-PRE | pickle-utils.ts helpers + pickle_settings.json microverse namespace | High | small | `extension/src/services/pickle-utils.ts`, `pickle_settings.json`, `extension/tests/pickle-utils.test.js` |
| 40 | R-LINT-1 | mux-runner.ts reconcileTicketStateDesync complexity + parity harness | Medium | small | `extension/src/bin/mux-runner.ts`, `extension/tests/mux-runner-reconcile-refactor-parity.test.js` |
| 50 | R-LINT-3 | spawn-morty.ts sync-fs-in-async warning | Medium | small | `extension/src/bin/spawn-morty.ts` |
| 60 | R-PPSD-1 | pickle-pipeline.md skip-flag doc update (DOC-ONLY) | Medium | small | `extension/.claude/commands/pickle-pipeline.md`, `extension/.claude/commands/pickle-tmux.md` |
| 70 | R-SJET-4-RUNNER | microverse-runner.ts wiring (judge stays unconditional 'claude') | High | medium | `extension/src/bin/microverse-runner.ts`, `extension/src/types/index.ts`, `extension/CLAUDE.md`, `extension/tests/microverse-codex.test.js`, `extension/tests/integration/microverse-runner-judge-failure.test.js` |
| 80 | R-LINT-2 | microverse-runner.ts measureLlmMetricWithBackoff complexity (AFTER R-SJET-4-RUNNER) | Medium | small | `extension/src/bin/microverse-runner.ts` |
| 90 | R-SJET-4-TESTS | 3 integration test files | Medium | small | 3 forward-created test files |
| 100 | R-PSSS-1 | anatomy-park empty-scope WARN + activity event | Medium | small | `extension/src/bin/anatomy-park.ts`, `extension/src/types/index.ts`, `extension/src/types/activity-events.schema.json` |
| 110 | R-PSSS-2 | szechuan-sauce empty-scope WARN | Medium | small | `extension/src/bin/szechuan-sauce.ts`, types touchpoints |
| 120 | R-PSSS-3 | pipeline-status.json skip_reason field [operator-launched] | Medium | small | `extension/src/bin/pipeline-runner.ts` only |
| 130 | R-SRGT-1 | scope-resolver empty-diff short-circuit | Medium | small | `extension/src/services/scope-resolver.ts` |
| 140 | R-SRGT-2 | scope-resolver grep timeout caps (5s/3retry/60s) | Medium | small | `extension/src/services/scope-resolver.ts` |
| 150 | T-HARDEN-PLF-TESTS | empty-diff / doc-only-diff integration tests | Medium | small | `extension/tests/integration/pipeline-launch-friction.test.js` |
| 170 | T-HARDEN-SELFIX2-WACT-DEPLOY | deploy-lifecycle soak coverage for tsc-gate | Medium | small | `extension/tests/integration/deploy-lifecycle-soak.test.js` |
| 180 | R-SELFIX2-WIRE | end-to-end integration verification (library variant) | Medium | small | (verification only — no new writes) |
| 190 | T-SELFIX2-CODE-QUALITY | Code Quality Hardening (Step 7e Ticket 1) | Medium | large | MODIFIED_FILES across all impl tickets |
| 200 | T-SELFIX2-DATAFLOW-AUDIT | Data Flow Audit three-phase (Step 7e Ticket 2) | Medium | large | impl tickets' boundaries |
| 210 | T-SELFIX2-TEST-QUALITY | Test Quality Hardening (Step 7e Ticket 3) | Medium | large | test files across all impl tickets |
| 220 | T-SELFIX2-CROSSREF-AUDIT | Cross-Reference Consistency Audit (Step 7e Ticket 4) | Medium | medium | docs + impl |
| 230 | C-SELFIX2-CLOSER | Bundle ship (release v1.76.0) [manager] | High | small | `extension/package.json`, install.sh, gh release, `prds/MASTER_PLAN.md` |

**Drafted by**: pickle-rick session 2026-05-18 PM2, refined 3-cycle (requirements / codebase / risk-scope) parallel analysis. Refinement complete; awaiting operator launch via `/pickle-tmux` or `/pickle-pipeline`.
