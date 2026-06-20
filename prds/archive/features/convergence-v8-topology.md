---
title: Convergence v8 Topology in dot-builder
author: Greg Dickson
contributors: Pickle Rick, Requirements Analyst Morty, Codebase Context Analyst Morty, Risk & Scope Auditor Morty
status: Refined
complexity_tier: large
created: 2026-04-14
refined: 2026-04-14
---

# PRD: Convergence v8 Topology in dot-builder (Refined)

## 0. Cycle 3 Amendments — READ THIS FIRST

Three parallel refinement analyses (`analysis_requirements.md`, `analysis_codebase.md`, `analysis_risk-scope.md`) consolidated the following changes vs. the original PRD. In case of conflict, this section wins.

### 0.1 Scope authority rule (replaces §4.1, §4.3 literal claims)

**`§4.3 "exactly two areas change in dot-builder.ts" is categorically false.** The original PRD understates required edit sites by 3×. The authoritative list lives in §4.1 below and includes **8 distinct line ranges in `dot-builder.ts`** plus `sync-schema.test.js`.

**Scope authority rule**: if implementation requires touching a file or line range NOT listed in §4.1, STOP and revise this PRD. No silent scope expansion. *(refined: risk-scope, codebase)*

**File-pair review rule**: `extension/src/types/attractor-schema.fallback.ts` and `extension/tests/sync-schema.test.js:215-297` MUST be modified in the same commit. A commit touching one without the other is an automatic review block. *(refined: risk-scope, codebase)*

### 0.2 Three new critical findings

- **InternalSpec.convergence is a 5-field local type** at `dot-builder.ts:891`. Both the fluent `.convergence()` method (L1034–1044) AND `fromSpec()` JSON parser (L945–958) funnel through this type. Extending the public `ConvergenceSpec` in `types/index.ts` alone is a no-op — all three choke points must patch in series. *(refined: codebase)*

- **`grRule6` is called at L1126 with `{}` for acceptance_criteria in convergence mode**. After un-suppressing `acceptance_criteria` emission, the emit path sees the merged map but the validate path sees `{}` — silent divergence. Required fix: pass `{ fp_pass: 'true', repro_pass: 'true', ...acceptanceCriteria }` in convergence mode. *(refined: codebase)*

- **Model-diversity enforcement at L1082–1107 is bypassable via direct `model=` attrs**. Existing check only inspects `modelStylesheet.overrides`. With the new `fixBackend.model`, `reviewers.backendModel`, etc. fields, a caller can duplicate models silently. Required fix: extend check to audit direct model attrs collected from `nodeMap`. *(refined: codebase)*

### 0.3 `done` vs `exit` dual-terminal (P0 escalation)

`dot-builder.ts:2068` unconditionally emits `exit [shape=Msquare]`. Benchmark-v8 has no `exit` node — `done` is the sole terminal. If implementer follows §1.2.1 literally without gating L2068, the graph has **two terminal nodes** (one orphaned). **Fix (option 2, recommended)**: gate L2068 on `!hasConvergence`, emit `done [shape=Msquare]` from the new convergence body. **AC-STRUCT-7** (below) asserts `exit` is absent and `done` is the sole `shape=Msquare`. *(refined: codebase, risk-scope)*

### 0.4 AC16 is impossible — replaced by AC-REWRITE-1

Original AC16 ("existing tests pass unchanged") cannot hold — 7 tests in `dot-builder-iterate.test.js` reference `iter_impl`/`iter_review_*`/`iter_adversary` or default `max_visits=20`/`timeout=60m`, all of which change in v8. Replaced with the 7-test rewrite allowlist (§5.5.1 below). Implementer who refuses to rewrite these will write a new "fix" that undoes the post-chain — catastrophic silent regression. *(refined: risk-scope, codebase)*

### 0.5 US5 is a ghost requirement

US5 names "existing callers (`spawn-refinement-team`, microverse loops)" but grep-verification (2026-04-14) confirms NO production code constructs `ConvergenceSpec` outside `dot-builder-iterate.test.js:makeConvergenceSpec`. US5 rewritten below; §1.4.3 back-compat rationale stripped to a one-sentence note. *(refined: requirements, risk-scope)*

### 0.6 Empty goal throws (new invariant)

§1.4.2 un-suppresses graph-level `goal=<spec.goal>` in convergence mode. Reviewer prompts use it as the honest-review lens anchor. If `spec.goal` is empty/undefined, reviewers lose their anchor and quality degrades silently. **Fix**: builder throws synchronously in convergence mode when `!spec.goal || spec.goal.trim().length === 0`. New AC-GOAL-2 asserts the throw. *(refined: risk-scope, requirements)*

### 0.7 `spec.workingDir` undefined behavior — pick one

Original PRD was silent on undefined `workingDir`. **Fix**: fall back to literal `${WORKING_DIR}` shell-var placeholder (matches existing convention at `dot-builder.ts:1308`). Substitution is scoped to command constants ONLY, NEVER applied to prompt strings. AC-SUB-2/4 enforce. *(refined: risk-scope)*

### 0.8 Attractor schema fallback — confirmed ADD list (replaces §1.4.4)

Verified missing (node bucket L27–68 of `attractor-schema.fallback.ts`):
- `convergence_epsilon` — number — used on `converge`
- `context_on_failure` — string — used on `fp_verify`, `repro_verify`
- `context_keys` — string — used on `fix_backend`, `fix_frontend`

Verified missing (edge bucket L100–104):
- `weight` — number — used on `converge → fix_backend [weight=1]`, `converge → fp_verify [weight=2]`
- (recommended) `label` — string — close pre-existing drift at 6 call sites

Already present (DO NOT re-add): `max_iterations` (L58), `reports_to_v` (L62), `allow_multi_retry_target` (L67), `reviewer_lens` (L55), `sealed_from_source` (L56), `harness` (L57). *(refined: codebase)*

### 0.9 Node IDs are public API

Add to §4.1: "Node IDs `{fix_backend, fix_frontend, run_build_api, run_tests_api, run_build_ui, run_lint, review_be, review_fe, review_int, adversary_node, fp_verify, repro_verify, done, converge}` are part of the public test contract; renaming requires a major version bump." *(refined: requirements, risk-scope)*

---

## 1. Context (unchanged sections)

Sections 1.1, 1.2, 1.2.1, 1.3, 1.5, 1.6 from the original PRD remain authoritative for topology/validator rules/pattern refs. Reference: `prd.md` at session root.

### 1.4.1 Current code the PRD touches — REPLACED

See §4.1 authoritative edit-site list.

### 1.4.2 Graph-attr block — CLARIFIED

In convergence mode, emit:
- `goal = <spec.goal>` (unsuppressed — non-empty required, see §0.6)
- `retry_target = "converge"`
- `acceptance_criteria = <merged>` where merged = `{ fp_pass: 'true', repro_pass: 'true', ...spec.acceptanceCriteria }` — **built-ins always win**, caller keys pass through for non-conflict keys, sorted by key. The emitted string format is `context.KEY=VAL && context.KEY2=VAL2 && ...` in sorted-by-key order.

### 1.4.3 `impl` field — REWRITTEN

> The `impl` field stays in `ConvergenceSpec` so `dot-builder-iterate.test.js:makeConvergenceSpec` continues to compile. No production code constructs `ConvergenceSpec` directly (grep-verified 2026-04-14). In v8 mode the `impl.prompt` field is dead-on-arrival; `impl.harness` is still honored as the default harness for `fix_backend`/`fix_frontend` when `fixBackend.harness`/`fixFrontend.harness` is not set.

### 1.4.4 attractor-schema.fallback.ts — see §0.8

---

## 2. User Stories

### US1 (refined)

As a `DotBuilder.fromSpec()` API consumer, I want to pass `convergence: { until: "V_total == 0 && fixed_point && reproducibility" }` with a non-empty `goal` and get a DOT that satisfies all §5 ACs and passes `attractor validate` with 0 ERROR when reachable per AC-INT-1. *(refined: requirements)*

### US2

As a pipeline author overriding one field (e.g. `fixBackend.model`), I want to set only that field and keep all other defaults. (Unchanged.)

### US3 (refined)

As a test author asserting on generated DOT structure, I want stable node IDs (`fix_backend`, `fix_frontend`, `run_build_api`, etc.). These IDs are part of the public test contract; renaming requires a major version bump. *(refined: requirements, risk-scope)*

### US4

As a reviewer of a generated DOT, I want the emitted graph to pass `bun packages/attractor/src/cli.ts validate <file>` with 0 ERROR diagnostics when attractor is reachable. (Unchanged.)

### US5 (rewritten — see §0.5)

As the author of `dot-builder-iterate.test.js:makeConvergenceSpec`, I want my minimal `ConvergenceSpec` (only `until` + `impl`) to keep compiling — the `impl` field stays in the type to avoid a test-fixture rewrite on an otherwise-unused field. This is the SOLE back-compat obligation. *(refined: requirements)*

### US6

As a non-convergence pipeline user, I want zero behavioral change. (Unchanged.)

---

## 3. Parameterization

### 3.1 Extended `ConvergenceSpec` — unchanged from original

**Precedence note (new)**: `direct attr > modelStylesheet.overrides > DEFAULT_*_MODEL`. When a caller sets BOTH `fixBackend.model='X'` AND `modelStylesheet.overrides=[{selector:'.impl',model:'Y'}]`, the direct attr wins. *(refined: codebase)*

### 3.2 `convergence-defaults.ts` — new file per original §3.2, plus:

Add constants: `DEFAULT_FIX_BACKEND_HARNESS = 'hermes'`, `DEFAULT_FIX_FRONTEND_HARNESS = 'hermes'`.

Add inline doc comment above `DEFAULT_CONVERGENCE_EPSILON`: `// unit: sum of V_* findings at which convergence is declared; see attractor validator V_total definition`.

Add inline doc comment block distinguishing `max_iterations` (per-iterate-loop count; default 6) from `max_visits` (per-node visit budget; default 5). *(refined: risk-scope)*

### 3.3, 3.5 — unchanged but reference by content, not line

Reference default prompts in `benchmark-backends-v8.dot` by content ("the string assigned to `fix_backend.prompt`"), not by line number. *(refined: risk-scope)*

### 3.4 Mechanical gates — `workingDir` handling clarified

When `spec.workingDir` is set, substitute `/repos/benchmark` → `spec.workingDir` in the 6 default command constants ONLY. When `spec.workingDir` is undefined, substitute `/repos/benchmark` → literal `${WORKING_DIR}` (shell-var placeholder). **Substitution NEVER applies to prompt strings, reviewer prompts, or adversary prompts**, regardless of whether they contain `/repos/benchmark`. *(refined: risk-scope, requirements)*

### 3.6 fp/repro defaults — caller-owns-install-safety contract added

**Caller override contract**: When a caller supplies `fpVerify.toolCommand`, they own install-safety. The builder does NOT parse, validate, or inject `npm install`. If a caller override omits install-safety, the `repro_verify → fp_verify [fail]` bounce will infinite-loop on missing modules until `converge.max_visits=5` is exhausted. This is a documented known failure mode — NOT a builder bug. *(refined: risk-scope)*

---

## 4. Scope

### 4.1 In scope — CYCLE 3 AUTHORITATIVE EDIT-SITE LIST

Replaces original §4.1 verbatim.

- `extension/src/services/dot-builder.ts`:
  - **L891** — extend `InternalSpec.convergence` local type to include all new optional `ConvergenceSpec` fields (fixBackend, fixFrontend, mechanicalGates, reviewers, adversary, fpVerify, reproVerify, convergenceEpsilon, maxIterations)
  - **L945–958** — extend `fromSpec()` JSON parser to read every new optional field
  - **L1034–1044** — extend fluent `convergence()` method body to copy every new field through to `this._spec.convergence`
  - **L1082–1107** — extend model-diversity check to audit direct `model=` attrs from `nodeMap` (not just `modelStylesheet.overrides`)
  - **L1126** — change `grRule6` call in convergence mode from `{}` to `{ fp_pass: 'true', repro_pass: 'true', ...acceptanceCriteria }`
  - **L1220–1255** — un-suppress graph-level `goal`, `retry_target="converge"`, `acceptance_criteria` in convergence mode; DELETE stale comments at L1221–1223 and L1249; throw on empty `spec.goal`
  - **L1519–1594** — replace convergence body emit with v8 topology (PRESERVE `applied.add('P32')`)
  - **L2042–2065** — rewrite `workspace=isolated` rewiring for v8 post-chain — target `repro_verify → done` as anchor, rewire to `repro_verify → commit_and_push → done`
  - **L2068** — gate unconditional `exit` emit on `!hasConvergence`

- `extension/src/services/convergence-defaults.ts` — NEW file per §3.2 (with the harness constants and doc comments added in Cycle 3)

- `extension/src/types/index.ts` L407–416 — extend exported `ConvergenceSpec` per §3.1

- `extension/src/types/attractor-schema.fallback.ts` — CONFIRMED ADDS per §0.8:
  - node bucket: `convergence_epsilon` (number), `context_on_failure` (string), `context_keys` (string)
  - edge bucket: `weight` (number), and recommended `label` (string) to close pre-existing drift

- **`extension/tests/sync-schema.test.js` L215–297** — update `fullSchema` fixture with matching attrs (FILE-PAIR LOCKSTEP with fallback.ts)

- `extension/tests/dot-builder-patterns.test.js` — NEW tests per §5.2

- `extension/tests/dot-builder-bdd.test.js` — NEW scenarios per §5.3

- `extension/tests/dot-builder-iterate.test.js` — REQUIRED REWRITES per §5.5.1 (exactly 7 tests, line-exact)

- `extension/tests/__helpers__/dot-parse.js` — NEW test helper returning `{ nodes: Map<id, attrs>, edges: Set<[from, to, attrs]>, graphAttrs: Record<string, string> }`. All structural ACs consume parsed form, not raw substring matches. *(refined: requirements)*

- `extension/tests/__fixtures__/non-convergence-baseline-{minimal,phases,isolated}.dot` — 3 NEW snapshot fixtures for AC-SNAP-1 non-convergence regression gate.

**Public contract sentence**: Node IDs `{fix_backend, fix_frontend, run_build_api, run_tests_api, run_build_ui, run_lint, review_be, review_fe, review_int, adversary_node, fp_verify, repro_verify, done, converge}` are part of the public test contract; renaming requires a major version bump.

### 4.2 Out of scope — unchanged + additions

(Original list stands.) Additions:
- Stack-specific default prompts (e.g. `convergence-defaults-python.ts`) — separate PRD required. *(refined: risk-scope)*
- Model version freshness — defaults track benchmark-v8 at PRD time; newer models require a separate update. *(refined: risk-scope)*
- `preflightPromptPaths` exemption — convergence body nodes are exempt because they are not `phases[]` members. *(refined: codebase)*

### 4.3 Do NOT — unchanged + additions

(Original list stands.) Additions:
- Do NOT emit BOTH `done` and `exit` in convergence mode. In convergence mode, `exit` must not appear; `done` is the sole terminal (L2068 gated on `!hasConvergence`).
- Do NOT apply `/repos/benchmark` → `${spec.workingDir}` substitution to ANY prompt string — only to the 6 default command constants.
- Do NOT touch any `extension/src/services/**` file not listed in §4.1.
- Do NOT re-add `max_iterations` to `attractor-schema.fallback.ts` — already present at L58.
- Do NOT include line-number references to `benchmark-backends-v8.dot` in shipped code/comments — reference by content. *(refined: risk-scope)*

---

## 5. Acceptance Criteria Matrix (REPLACES original §5.1–§5.5)

All criteria are machine-checkable. Tests live in `extension/tests/dot-builder-patterns.test.js` unless marked `[BDD]` (→ `dot-builder-bdd.test.js`) or `[ITER-REWRITE]` (→ `dot-builder-iterate.test.js`). Structural ACs consume the `parseDot()` helper from `extension/tests/__helpers__/dot-parse.js`.

### 5.1 Build gate

- **AC-BUILD-1**: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` — all four commands exit 0, no new eslint warnings.

### 5.2 Structural (via `parseDot()`)

- **AC-STRUCT-1 (node set)**: `cluster_iter_body` contains EXACTLY these 10 nodes: `{fix_backend, fix_frontend, run_build_api, run_tests_api, run_build_ui, run_lint, review_be, review_fe, review_int, adversary_node}`. Set equality, not subset.
- **AC-STRUCT-2 (body edges)**: Body edge set equals exactly the 9-edge chain (`fix_backend→fix_frontend→run_build_api→run_tests_api→run_build_ui→run_lint→review_be→review_fe→review_int→adversary_node`). Every edge has `condition="outcome=success"`.
- **AC-STRUCT-3 (retry targeting)**: `{run_build_api, run_tests_api, run_lint}` carry `retry_target="fix_backend"`. `{run_build_ui}` carries `retry_target="fix_frontend"`. `adversary_node` has NO `retry_target`. `fix_backend` has `allow_multi_retry_target=true`. `fix_frontend` does NOT.
- **AC-STRUCT-4 (gate self-retry clean)**: For every node with `reports_to_v=...`, `retry_target !== <self id>`.
- **AC-STRUCT-5 (post-chain)**: Edges `adversary_node → fp_verify`, `fp_verify → repro_verify [outcome=success]`, `repro_verify → done [outcome=success]`, `fp_verify → converge [outcome=fail]`, `repro_verify → fp_verify [outcome=fail]` all present. `fp_verify` has `context_on_success="fp_pass=true"` AND `context_on_failure="fp_pass=false"`. Same for `repro_verify` with `repro_pass`.
- **AC-STRUCT-6 (reachability)**: `converge → fix_backend [weight=1, condition="outcome=success"]` AND `converge → fp_verify [weight=2, condition="outcome=success"]` both present.
- **AC-STRUCT-7 (single terminal = done, no exit)**: In convergence mode the generated DOT contains EXACTLY ONE node with `shape=Msquare` and that node's id is `done`. Assert `/shape=Msquare/g` match count === 1. Assert `exit` node ABSENT (no line matching `^  exit \[`). Assert `repro_verify → done` edge present.
- **AC-STRUCT-8 (graph attrs)**: Graph block contains `retry_target="converge"`, `goal="<spec.goal>"`, `acceptance_criteria` containing both `context.fp_pass=true` and `context.repro_pass=true`.
- **AC-STRUCT-9 (converge node defaults)**: `converge` block contains `max_iterations=6`, `max_visits=5`, `convergence_epsilon=100`, `timeout="21600s"`, `until=<spec.until>`.
- **AC-STRUCT-10 (context_keys)**: `fix_backend` and `fix_frontend` blocks both contain `context_keys="__pool_findings__,__last_failure_output,__fix_attempt_history"`.
- **AC-STRUCT-11 (old nodes absent)**: Output contains NONE of `iter_impl`, `iter_review_be`, `iter_review_fe`, `iter_review_int`, `iter_adversary`, `quality_review` (line-anchored match `^  <id> \[`).

### 5.3 Merge-order & override

- **AC-MERGE-1 (built-ins alone)**: No `spec.acceptanceCriteria` → graph attr equals `context.fp_pass=true && context.repro_pass=true` exactly.
- **AC-MERGE-2 (built-ins + one custom, sorted)**: `{ custom_key: 'custom_val' }` → graph attr equals `context.custom_key=custom_val && context.fp_pass=true && context.repro_pass=true` (sorted: c < f < r).
- **AC-MERGE-3 (built-ins win on collision)**: `{ fp_pass: 'false' }` → graph attr equals `context.fp_pass=true && context.repro_pass=true` — caller's value silently dropped, builder MUST NOT throw.
- **AC-MERGE-4 (mixed multi-key)**: `{ fp_pass: 'false', repro_pass: 'false', zeta: 'z', alpha: 'a' }` → `context.alpha=a && context.fp_pass=true && context.repro_pass=true && context.zeta=z`.

### 5.4 Override precedence

- **AC-OVERRIDE-1 (fixBackend.model fluent)**: `new DotBuilder(...).convergence({ fixBackend: { model: 'claude-sonnet-4-6' }, ... }).build()` → `fix_backend.model="claude-sonnet-4-6"`. Default: `"minimax/minimax-m2.7"`. Tests BOTH the fluent API and the `fromSpec()` JSON path (see AC-OVERRIDE-6).
- **AC-OVERRIDE-2a/b/c (harness cascade)**: (a) `fixBackend.harness='claude-code'` → `fix_backend.harness="claude-code"`. (b) `fixBackend.harness` unset + `impl.harness='claude-code'` → `fix_backend.harness="claude-code"`. (c) both unset → `fix_backend.harness="hermes"` (default).
- **AC-OVERRIDE-3a/b/c (sealedFromSource three-level cascade)**: (a) `adversary.sealedFromSource='A'` wins over (b) top-level `sealedFromSource='B'` which wins over (c) the default constant.
- **AC-OVERRIDE-4 (maxIterations/maxVisits independent)**: `convergence.maxIterations=10, maxVisits=3` → `converge` block contains `max_iterations=10` AND `max_visits=3` (both, independently).
- **AC-OVERRIDE-5 (convergenceEpsilon)**: `convergence.convergenceEpsilon=50` → `convergence_epsilon=50`. Unset → `convergence_epsilon=100`.
- **AC-OVERRIDE-6 (fromSpec JSON round-trip)**: `DotBuilder.fromSpec({ ..., convergence: { until, impl, fixBackend: { model: 'X', harness: 'Y' }, mechanicalGates: { buildApiCmd: 'Z' }, ... } }).build()` → emitted DOT reflects ALL override values. This AC is load-bearing because it's the only gate that catches JSON-parser drops.
- **AC-OVERRIDE-7 (direct-attr > modelStylesheet)**: `fixBackend.model='X'` + `modelStylesheet.overrides=[{selector:'.impl', model:'Y'}]` → `fix_backend.model="X"` (direct wins).
- **AC-OVERRIDE-8 (model-diversity check on direct attrs)**: `fixBackend.model='M'` + `reviewers.backendModel='M'` → `.build()` throws `DUPLICATE_MODEL` (direct attrs audited).

### 5.5 Substitution boundary

- **AC-SUB-1 (positive command sub)**: `workingDir='/foo/bar'` → `run_build_api.tool_command` contains `/foo/bar/packages/api`, does NOT contain `/repos/benchmark`.
- **AC-SUB-2 (prompts never substituted)**: `workingDir='/foo/bar'` + default reviewer prompts → `review_be.prompt` byte-equals `DEFAULT_REVIEW_BE_PROMPT` (imported). No substitution applied to ANY prompt string.
- **AC-SUB-3 (caller override bypass)**: `mechanicalGates.buildApiCmd='cd /custom && make'` → `run_build_api.tool_command` byte-equals the override.
- **AC-SUB-4 (undefined workingDir → placeholder)**: `spec.workingDir` unset → `run_build_api.tool_command` contains literal `${WORKING_DIR}`.

### 5.6 Install-safety

- **AC-INSTALL-1 (default ordering)**: Default `fp_verify.tool_command` — let `iInstall = cmd.search(/\bnpm install\b/), iTsc = cmd.search(/\bnpx tsc\b/), iTest = cmd.search(/\bnpm test\b/)`. Assert `iInstall >= 0 && iInstall < iTsc && iInstall < iTest`. Same for `repro_verify.tool_command` (install comes after `rm -rf` but before tsc/test).
- **AC-INSTALL-2 (override bypass)**: Caller override `'echo hi'` → emitted verbatim, no ordering check applied.

### 5.7 Goal gate

- **AC-GOAL-1 (non-empty)**: Non-empty `spec.goal` + convergence → graph block contains `goal="<spec.goal>"`.
- **AC-GOAL-2 (empty fails)**: Empty/unset/whitespace-only `spec.goal` + convergence → `.build()` throws synchronously with message matching `/goal.*required.*convergence/i`. No DOT output.

### 5.8 Validator-rule local proxies

- **AC-GATE-1** (god_node_retry_target): subsumed by AC-STRUCT-3.
- **AC-GATE-2** (gate_self_retry_loop): subsumed by AC-STRUCT-4.
- **AC-GATE-3** (success_only_edge_without_retry): graph `retry_target="converge"` present (AC-STRUCT-8); non-body nodes `fp_verify`/`repro_verify` have both `outcome=success` and `outcome=fail` outgoing edges (AC-STRUCT-5).
- **AC-GATE-4** (goal_gate_needs_fix_loop): subsumed by AC-STRUCT-5 (fail edges present).
- **AC-GATE-5** (iterate_edge_needs_outcome_condition): subsumed by AC-STRUCT-6.

### 5.9 Pattern tracking

- **AC-PATTERN-1**: `builder.patternsApplied` includes `'P32'` after a convergence build.

### 5.10 Non-convergence regression (snapshot)

- **AC-SNAP-1 [BDD]**: Three fixtures at `extension/tests/__fixtures__/non-convergence-baseline-{minimal,phases,isolated}.dot` — generated from current `main` HEAD in a pre-PRD commit. Test reads each, asserts `generateDot(spec) === readFile(fixture)` byte-for-byte. Fixtures are regenerated ONLY in a separate `chore: regenerate ...` commit. The `isolated` fixture exercises `workspace='isolated'` WITHOUT convergence.

### 5.11 Attractor integration gate (observable skip)

- **AC-INT-1 (runs when reachable)**: If `/Users/gregorydickson/loanlight/attractor/packages/attractor/src/cli.ts` exists (via `fs.existsSync`) AND `spawnSync('bun', ['--version'])` exits 0 within 2000ms, write minimal convergence DOT to tempfile, run `bun <cli> validate <tempfile>`. Assert exit code 0 AND stdout matches `/\b0 errors?\b/i`. Test records timestamp to `extension/.last-attractor-run`.
- **AC-INT-2 (observable skip)**: If attractor NOT reachable, `test.skip('attractor unreachable: <reason>')` AND emit stderr warning including last-run timestamp. If last run > 7 days ago or absent, warning includes literal string `attractor gate has been skipped for >7 days — investigate before merging`.

### 5.12 Test rewrite allowlist (§5.5.1 per Codebase Analyst)

- **AC-REWRITE-1**: Exactly 7 tests in `extension/tests/dot-builder-iterate.test.js` are rewritten per the table below. No other test file has a `git diff` except the new/extended ones listed in §4.1.

| # | Test | Lines | Current | v8 rewrite |
|---|------|-------|---------|------------|
| 1 | AC3 basic emission | 20–29 | `iter_impl`, `iter_review_{be,fe,int}`, `iter_adversary` substrings | v8 10-node set via `parseDot().nodes` |
| 2 | AC6 reviewer lenses | 31–43 | finds `iter_review_*` lines, asserts lens attrs | finds `review_{be,fe,int}` lines, same lens assertions |
| 3 | AC8 P0/isolated | 108–120 | `quality_review → commit_and_push → exit` chain | `repro_verify → commit_and_push → done` chain |
| 4 | AC15 ordering | 122–128 | `indexOf('setup_deps') < indexOf('converge')` — broken by graph-level `retry_target="converge"` | line-anchored: `dot.search(/^  setup_deps \[/m) < dot.search(/^  converge \[/m)` |
| 5 | node ID stability | 130–138 | `expectedIds = ['iter_impl', ...]` | `expectedIds = ['fix_backend', 'fix_frontend', 'run_build_api', 'run_tests_api', 'run_build_ui', 'run_lint', 'review_be', 'review_fe', 'review_int', 'adversary_node']` |
| 6 | default max_visits/timeout | 145–149 | `max_visits="20"`, `timeout="60m"` | `max_visits="5"`, `timeout="21600s"` |
| 7 | P1-1 regression | 151–161 | counts `quality_review → exit` (0), `commit_and_push → exit` (1) | counts `repro_verify → done` direct (0, removed by rewire), `commit_and_push → done` (1) |

**Tests that stay UNCHANGED (explicitly DO-NOT-REWRITE)**: AC5/AC11 duplicate model L55–74, AC7 sealed_from_source L45–53, AC13 invalid until L76–86, AC12 endgame suppressed L88–96, AC14 P25 suppressed L98–106, P32 L140–143, explicit maxVisits override L163–170, explicit timeout override L172–178, minimal until predicate L180–184, three distinct models L186–200.

### 5.13 Builder sanity

- **AC-SANITY-1**: `new DotBuilder().slug('test').goal('Non-empty goal').convergence({until:'V_total == 0', impl:{harness:'hermes', prompt:''}}).build()` returns a non-empty string containing `digraph` without throwing.

### 5.14 Compound scenario (from codebase analysis)

- **AC-COMPOUND-1 (workspace=isolated + stylesheet + convergence)**: Build a DOT with `workspace='isolated'`, `modelStylesheet.overrides=[.impl→opus, .honest_review→haiku, .adversary→sonnet]`, and `convergence.until='V_total == 0 && fixed_point && reproducibility'`. Assert: all 10 body nodes present, `repro_verify → commit_and_push → done` rewire present (not `→ exit`), no `DUPLICATE_MODEL` throw, `patternsApplied` contains BOTH `P0` AND `P32`.

---

## 6. Test Plan (unchanged)

Original §6 steps 1–10 still apply, with the addition: before writing the ACs, create `extension/tests/__helpers__/dot-parse.js`. All structural ACs consume parsed form.

---

## 7. References (unchanged)

See original PRD §7.

---

## 8. Risks & Mitigations

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | §4.1/§4.3 scope understates required edit sites by 3× | **Critical** | §0.1 scope authority rule + §4.1 8-line-range list. |
| 2 | AC16 "existing tests unchanged" impossible; 7 tests must be rewritten | **Critical** | §5.12 AC-REWRITE-1 allowlist with exact line numbers. |
| 3 | `sync-schema.test.js` fixture drift → silent CI failure | **Critical** | File-pair review rule (§0.1) + explicit test fixture in §4.1. |
| 4 | `done` vs `exit` dual-terminal unreachability | **Critical** | L2068 gate on `!hasConvergence` + AC-STRUCT-7. |
| 5 | `InternalSpec.convergence` L891 silently drops fields | **Critical** | L891 + L1034–1044 in §4.1; AC-OVERRIDE-1 exercises fluent path. |
| 6 | `grRule6` L1126 passes `{}` in convergence mode | **Critical** | L1126 in §4.1 edit list; pass merged ac map. |
| 7 | Model-diversity bypassable via direct attrs | High | L1082–1107 in §4.1; AC-OVERRIDE-8. |
| 8 | Empty `spec.goal` silent quality degradation | High | AC-GOAL-2 (synchronous throw). |
| 9 | `spec.workingDir` undefined-behavior unspecified | High | §3.4 `${WORKING_DIR}` placeholder; AC-SUB-4. |
| 10 | Attractor schema fallback drift | High | §0.8 confirmed ADD list (4 attrs). |
| 11 | `/repos/benchmark` sub corrupts prompts | Medium | AC-SUB-2 (prompts never substituted). |
| 12 | Caller override of `fpVerify.toolCommand` infinite loops | Medium | §3.6 caller-owns-install-safety contract. |
| 13 | `max_iterations` vs `max_visits` ambiguity | Medium | §3.2 inline definition block. |
| 14 | `benchmark-backends-v8.dot` line-number drift | Medium | Reference by content, not line. |
| 15 | `convergence-defaults.ts` becomes junk drawer | Low | §4.2 non-goal: stack-specific defaults in separate files. |
| 16 | `impl.prompt` dead field | Low | §1.4.3 documents; no production callers. |

---

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|:---|:---|:---|:---|:---|:---|:---|
| 10 | T1 | Data layer: defaults, types, schema, sync-schema fixture | High | Refined PRD approved | All 4 data files compile; sync-schema test passes | `convergence-defaults.ts`, `types/index.ts`, `attractor-schema.fallback.ts`, `sync-schema.test.js` |
| 20 | T2 | Builder logic: spec threading, graph attrs, body emit | High | T1 complete | AC-STRUCT-1..11, AC-MERGE-1..4, AC-OVERRIDE-1..8, AC-GOAL-1..2 pass | `dot-builder.ts` L891, L945–958, L1034–1044, L1082–1107, L1126, L1220–1255, L1519–1594 |
| 30 | T3 | Terminal topology: workspace-isolated + done/exit gating | High | T2 complete | AC-STRUCT-7, AC-COMPOUND-1 pass | `dot-builder.ts` L2042–2068 |
| 40 | T4 | Tests: parseDot helper + new suites + 7-test rewrite + snapshots | High | T3 complete | All §5 ACs pass, full build gate green | `dot-parse.js`, `dot-builder-patterns.test.js`, `dot-builder-bdd.test.js`, `dot-builder-iterate.test.js`, `__fixtures__/*.dot` |
| 50 | H1 | Harden: code quality review of convergence v8 | High | T4 complete | Zero P0/P1 violations | All MODIFIED_FILES |
| 60 | H2 | Audit: data flow integrity for convergence v8 | High | H1 complete | Zero CRITICAL/HIGH findings | All MODIFIED_FILES |
| 70 | H3 | Harden: test quality review of convergence v8 | High | H2 complete | Every AC mapped to test; zero weak assertions | All TEST_FILES |
| 80 | H4 | Audit: cross-reference consistency | High | H3 complete | Zero CRITICAL/HIGH cross-ref mismatches | All DOC + source files |
