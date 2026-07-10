Pickle-dot pattern reference. Read by `/pickle-dot` on demand — do NOT load this file unless `/pickle-dot` instructs you to.

## Recent Validator Changes (2026-04-14)

Three validator rules changed and one is new — read these BEFORE applying the pattern catalog. Skipping this section will cost you a validate-fix loop iteration on the very first run.

**1. NEW rule: `gate_self_retry_loop`** (ERROR severity)

Tool nodes with `reports_to_v=...` (i.e. a convergence gate inside an iterate body) MUST NOT have `retry_target=<self>`. Convergence gates measure the workspace state against a predicate (typecheck/tests/lint pass). On deterministic failure, re-running the same tool_command against unchanged code is a no-op until the FailureSignatureTracker aborts the pipeline at the transient limit (default 5).

```
// BAD — gate self-loop on deterministic failure
run_tests_api [
  shape=parallelogram,
  tool_command="cd ${WORKING_DIR}/packages/api && npm test",
  reports_to_v="mechanical.boot",
  retry_target="run_tests_api"   // ← gate_self_retry_loop ERROR
]

// GOOD — gate routes back to the fix node that produces the code it measures
run_tests_api [
  shape=parallelogram,
  tool_command="cd ${WORKING_DIR}/packages/api && npm test",
  reports_to_v="mechanical.boot",
  retry_target="fix_backend"     // ← in-body fix node
]

// ALSO GOOD — omit retry_target so iterate handler restarts the iteration
//   (only valid for body nodes when graph-level retry_target is the iterate parent —
//    see Pattern 32a, success_only_edge_without_retry exemption)
```

This rule does NOT apply to tool nodes WITHOUT `reports_to_v` (e.g. `setup_deps`, `install`, `capture_baseline`, `scaffold`). Those are legitimately transient-retry candidates and Pattern 6a still recommends `retry_target=<self>` for them.

**2. UPDATED rule: `god_node_retry_target`** (ERROR severity)

Two changes:
- **Self-references no longer count** toward the 3-referrer budget. The doc said "3+ *other* nodes" but the impl was counting self. A codergen fix node can have `retry_target=<self>` AND be the retry target for 2 other nodes without tripping.
- **Opt-in via `allow_multi_retry_target=true`** on the target node. When a fix node legitimately serves multiple gates within ONE code domain (e.g. one backend fixer with build, test, AND lint gates all measuring the same `packages/api/src/`), set this attribute on the fix node to suppress the rule. The original anti-pattern (one fixer crossing frontend AND backend AND infra) is still caught — those targets won't have the opt-in.

```
// GOOD — three backend gates routing to one backend fix node, opt-in declared
fix_backend [
  class="impl",
  allow_multi_retry_target=true,   // ← opt out of god_node rule for this domain
  retry_target="fix_backend",       // self-retry; no longer counted
  prompt="...",
  ...
]
run_build_api [retry_target="fix_backend", reports_to_v="mechanical.typecheck", ...]
run_tests_api [retry_target="fix_backend", reports_to_v="mechanical.boot", ...]
run_lint      [retry_target="fix_backend", reports_to_v="mechanical.lint", ...]
// fix_backend referrers: run_build_api + run_tests_api + run_lint = 3 — would normally fire,
// suppressed by allow_multi_retry_target=true.
```

Use sparingly. Reach for the opt-in only when the gates all measure the same code domain. If you're tempted to set it because gates span multiple categories (frontend + backend, src + infra), DON'T — split the fix node instead.

**3. UPDATED rule: `success_only_edge_without_retry`** (ERROR severity)

Now exempts nodes inside an `iterate` body cluster when graph-level `retry_target` points at the iterate parent. Reason: the engine's body-runner returns failure on dead-end nodes, the iterate handler returns FAIL, and the engine's outer-graph retry routes back to the iterate node which starts a fresh iteration. The fall-through is correct for iterate-body nodes — not "misrouted" the way the rule was previously claiming.

```
// Now valid (was previously rejected):
//   - run_lint is inside cluster_iter_body
//   - graph retry_target = "converge" (the iterate parent)
//   - run_lint has only outcome=success outgoing edges, no node-level retry_target
//   - on failure: body fails → iterate FAIL → graph retry_target → fresh iteration
```

Outside iterate bodies, the rule still fires as before.

**4. Engine semantics: iterate body fall-through (NEW knowledge)**

The iterate handler runs body nodes via a SUB-graph that contains ONLY body nodes and body-internal edges. Graph-level attributes (including `retry_target`) ARE inherited, but graph-level NODES are not. So if a body node falls through to graph-level `retry_target="converge"`, the body subgraph's `nodes.get("converge")` returns undefined, the engine throws "Stage X failed with no outgoing edge", body returns failure, iterate handler returns FAIL. The OUTER engine then catches the iterate FAIL and routes via graph-level retry_target back to converge — which starts a fresh iterate call.

So body fall-through DOES recover, but at the cost of one full iterate restart per failure. Prefer in-body retry routing (`retry_target=<fix_node_in_body>`) for tighter loops; reserve fall-through for nodes where the per-iteration fix loop isn't meaningful (e.g. a final lint gate after impl + reviewers).

The iterate handler's failure message used to say "could not be resolved or executed" for both "cluster missing" and "body run threw" — now it distinguishes them via `bodyResult.reason`. If you see "executed but a node failed without a valid in-body retry path", a body node has no fail edge and no node-level retry_target.

**5. Prompt verb pollution: `prompt_single_concern` triggers on stray verbs**

The rule scans codergen prompts for action-verb clusters (implement, test, document, deploy, analyze) and ERRORs at 3+ matches. Words you might write incidentally that count:
- `benchmark` → analyze cluster
- `deploy(ment)` → deploy cluster
- `documented`, `comment`, `docstring` → document cluster
- `analyze`, `investigate`, `profile` → analyze cluster

If your prompt is fundamentally "implement + test" (2 clusters, fine) and you toss in a phrase like "out of scope for this benchmark" or "we'll deploy separately", you've now matched 3 clusters and the rule fires. Rephrase with neutral words ("out of scope here", "shipped via a separate pipeline") or split the node.

## Recent Validator Changes (2026-04-16)

Nine validator rules added and iterate body patterns overhauled — read these BEFORE the pattern catalog. The v9 benchmark pipeline debugging session exposed 4 structural anti-patterns that burn entire retry budgets.

**1. NEW rule: `model_allowlist`** (ERROR severity)

Every `model` attr and `model_ladder` rung must be in the approved set:
- `minimax/minimax-m2.7` (impl — cheap, fast)
- `z-ai/glm-5.1` (backend review)
- `qwen/qwen3.6-plus` (frontend review)
- `xiaomi/mimo-v2-pro` (integration review)
- `x-ai/grok-4.20` (adversary)
- `google/gemini-3.1-pro-preview` (ladder fallback)

Dead models like `qwen/qwen3.6-plus:free` trip circuit breakers at runtime.

**2. NEW rule: `per_artifact_tsc_retry_loop`** (ERROR severity)

A tool node running `tsc --noEmit` with `retry_target` pointing to a diamond creates an unfixable loop. TypeScript reports errors at USE sites (e.g. service.ts), but the root cause may be at a DEFINITION site (e.g. dto.ts). The per-artifact patcher can only modify its own file.

NEVER create per-artifact tsc gates inside iterate bodies. Use:
- Semantic gates (field count, subset check, route check) for per-artifact validation
- Full-package tsc gates (`run_build_api`, `run_build_ui`) retrying to full-package fixers

**3. NEW rule: `iterate_body_context_survives_rollback`** (ERROR severity)

Context keys set by `context_on_success` inside iterate bodies survive workspace rollback. Keys used for diamond routing MUST use the `artifact_*` prefix (engine clears these on rollback). Custom keys like `status_done=true` persist after rollback, causing stale diamond routing.

**4. NEW rule: `iterate_body_gate_needs_reports_to_v`** (WARNING)

ALL tool gates inside iterate bodies MUST have `reports_to_v="mechanical.<component>"`. Without it, gate failures don't feed V_total, making the convergence function blind to regressions.

**5. NEW rule: `iterate_body_outer_edge`** (WARNING)

Edges from body nodes to nodes outside the body cluster are dead code. The iterate handler manages body→exit via the converge node.

**6. NEW rule: `iterate_body_impl_needs_model_ladder`** (WARNING)

All codergen impl nodes inside iterate bodies MUST have `model_ladder` + `ladder_advance_on="rollback"`. Without escalation, the same cheap model retries on every iteration.

Standard impl ladder (collision-free with reviewer ladders at every rung):
```
model_ladder="minimax/minimax-m2.7,minimax/minimax-m2.7,xiaomi/mimo-v2-pro,x-ai/grok-4.20,google/gemini-3.1-pro-preview"
ladder_advance_on="rollback"
```

**7. Additional rules:** `context_key_starts_with_non_identifier`, `max_visits_times_max_retries_budget`, `gate_hardcoded_path_predecessor_contract`, `codergen_unbounded_fidelity_non_iterate`, `missing_retry_path_implicit_fallback`, `tool_context_key_reference_mismatch`. Key implications:
- Context keys must start with letter or underscore (not digits/dashes)
- `max_visits × max_retries` product should stay under 15
- Gate tool_commands that check specific file paths should match the impl prompt's file contract
- Non-iterate codergen with unbounded fidelity need `context_keys` if they have retry_target

## Recent Validator Changes (2026-04-17)

Live debugging of `benchmark-backends-v9.dot` exposed three more structural traps and one missing routing pattern. Each cost a multi-hour pipeline run before the fix landed. Read this section before authoring any per-artifact iterate body.

**1. NEW rule: `reviewer_lens_valid`** (ERROR severity)

`reviewer_lens` attr on review/honest_review nodes must be one of `backend | frontend | integration`. Older rubric drafts referred to `backend_tests` and similar — those are dead. The validator rejects them now. Lens drives prompt template selection in the harness; an unrecognized value silently falls back to a generic reviewer prompt and the lens-specific findings disappear from the pool.

**2. NEW anti-pattern: silent-success trap on per-artifact gates** (no rule yet — author defensively)

Per-artifact gates that route via diamond MUST set `context_on_failure` to undo the diamond's `seeded` flag. Otherwise a silently-successful seed (hermes/claude-code returns exit 0 with no file written — known failure mode) flips `artifact_X=seeded`, the diamond locks onto the patch edge forever, the patch correctly no-ops on empty pool, the gate fails on missing file, and the loop burns the entire retry budget without ever re-running the seed.

```
// BAD — gate has no failure path; silent-success seed → unrecoverable loop
gate_controller_routes [
  shape=parallelogram,
  tool_command="bun verify-controller-routes.ts /repos/<wp>/...",
  retry_target="diamond_api_controller_mode"
  // missing both context_on_success AND context_on_failure
]

// GOOD — gate undoes the seeded flag on failure so diamond falls back to seed
gate_controller_routes [
  shape=parallelogram,
  tool_command="bun verify-controller-routes.ts /repos/<wp>/...",
  retry_target="diamond_api_controller_mode",
  context_on_success="artifact_api_controller=seeded",
  context_on_failure="artifact_api_controller=seed_failed"
]
```

The `verify_gate_needs_both_context_paths` validator rule will ERROR if you set one and not the other — both paths must be wired or neither. The diamond's patch edge is gated on `context.artifact_X=seeded`, so any value other than `seeded` (e.g. `seed_failed`) routes back to the seed branch.

**3. Contract-verify scripts must `exit 0` on a clean run**

When a verify script's exit code is consumed by the engine for routing (success → `verify_patches_landed → route_contract_violation`), the script must NOT exit 1 on the thing it's measuring. Instead, write `ATTRACTOR_CTX:<key>=<value>` to stdout and exit 0; the downstream diamond reads the key and routes by category. Reserve exit 1 for actual script crashes (bad args, parse failure, filesystem error).

Concrete case: `verify-contract.ts` originally exited 1 when violations were found, defeating the entire `route_contract_violation` design (which routes per-category to the correct fix diamond). Treat verify scripts that drive `route_*` diamonds as "always-exit-0" by default.

**4. Anti-pattern: `outcome=fail` edge on a diamond node** (no rule yet — author defensively)

Diamonds ALWAYS return SUCCESS — the conditional handler exists to select an outgoing edge based on context, not to short-circuit failures. Edges with `condition="outcome=fail"` from a diamond are dead code; they will never fire. For outcome-based routing, route directly from the upstream tool/codergen with `condition="outcome=success|fail"` edges and skip the diamond.

```
// BAD — outcome=fail edge on a diamond is unreachable
some_tool -> some_diamond [condition="outcome=success"]
some_diamond -> recover_node [condition="outcome=fail"]   // dead

// GOOD — outcome routing belongs on the tool's outgoing edges
some_tool -> next_node    [condition="outcome=success"]
some_tool -> recover_node [condition="outcome=fail"]
```

**5. NEW rule: `codergen_prompt_requires_workspace_anchor`** (WARNING severity)

Codergen prompts that reference relative project paths (`packages/`, `src/`, `lib/`) without an anchor phrase ("working directory", "relative to", "workspace", "cwd", "/repos/") trip this rule. Without an anchor, the model's cwd assumption can drift to `~/.claude/<project>/` (host bleed), `/tmp/`, or any prior session's path. Prepend "All paths below are relative to the working directory." to long codergen prompts that name relative paths.

**6. UPDATED rule: `hermes_prompt_absolute_paths`** (ERROR severity)

The original "hermes writes to $HOME on absolute paths" hypothesis was wrong — the real failure mode was hermes session memory poisoning. The rule now exempts prompts that include workspace anchor phrases, since an anchored prompt is unambiguous. If your prompt says "All paths below are relative to the working directory" near the top, absolute path mentions in the body are fine.

**7. Schema additions** — these landed for v9 and should be in your toolbox:

| Attribute | On node type | Purpose |
|:--|:--|:--|
| `max_drift_iterations` (int, default 0 = disabled) | iterate | Halt the iterate handler when the last N iterations all have `V_total > minV + drift_tolerance`. Catches plateau-and-drift cases the fresh-regression gate ignores. Validator rule `iterate_body_with_pool_needs_drift_detection` requires this on iterate bodies that have honest_review or adversary nodes. |
| `drift_tolerance` (int, default 0) | iterate | Slack above minV before a row counts as drifting. v9 uses `max_drift_iterations=2, drift_tolerance=15`. Validator rule `max_drift_less_than_max_iterations` enforces `max_drift_iterations < max_iterations`. |
| `context_on_failure` (string `key=value`) | tool, codergen | Mirror of `context_on_success` for the failure path. Critical for per-artifact gates (see #2). `ATTRACTOR_CTX:` lines from stdout still take precedence. |
| `reviewer_lens` (enum: `backend\|frontend\|integration`) | review, honest_review | Drives prompt template selection in the reviewer harness. See #1. |
| `ladder_advance_on` (csv subset of `rollback,drift,stall`) | impl codergen with `model_ladder` | Currently only `rollback` is dispatched; `drift` and `stall` are accepted for forward compatibility. |
| `allow_in_run_prompt_patch` (bool, default false) | iterate / retry_target gate | Reserved for a future diagnose-and-route meta-agent — not yet wired. Author NEVER sets to true today. |

**8. NEW Pattern: Per-Artifact Decomposition for Iterate Bodies**

The v9 architecture replaces a god-node `fix_backend` (which can't hold the full scope of all error categories simultaneously) with one diamond → seed/patch → gate chain per file. Each artifact (entity, dtos, service, controller, module, tests, ui_types, ui_lib, ...) has the same structure:

```
diamond_api_<X>_mode [shape=diamond]

impl_api_<X>_seed [
  class="impl",
  harness="hermes",
  model="minimax/minimax-m2.7",
  model_ladder="minimax/minimax-m2.7,minimax/minimax-m2.7,xiaomi/mimo-v2-pro,x-ai/grok-4.20,google/gemini-3.1-pro-preview",
  ladder_advance_on="rollback",
  retry_target="diamond_api_<X>_mode",
  context_on_success="artifact_api_<X>=seeded",
  context_on_failure="artifact_api_<X>=seed_failed",
  prompt="All paths below are relative to the working directory. Create packages/api/src/...; specify exact STRICT MODE idioms (! on non-nullable, ?: on nullable); reference TS error codes if applicable."
]

impl_api_<X>_patch [
  class="impl",
  harness="hermes",
  model="minimax/minimax-m2.7",
  model_ladder="...",
  retry_target="diamond_api_<X>_mode",
  context_keys="__pool_findings__,__last_failure_output,__fix_attempt_history",
  prompt="Update packages/api/src/...; read pool_findings filtered to source='reviewer_<X>'; HARD RULE: empty pool → return immediately with NO changes; emit PATCHES: [...] as last line."
]

gate_<artifact_check> [
  shape=parallelogram,
  tool_command="bun /app/packages/attractor/scripts/verify-<X>.ts /repos/<wp>/...",
  reports_to_v="mechanical.typecheck",
  max_retries=0,
  retry_target="diamond_api_<X>_mode",
  context_on_success="artifact_api_<X>=seeded",
  context_on_failure="artifact_api_<X>=seed_failed"
]

// Edges
diamond_api_<X>_mode -> impl_api_<X>_patch [condition="context.artifact_api_<X>=seeded", weight=2]
diamond_api_<X>_mode -> impl_api_<X>_seed [condition="context.pool_count_reviewer_<X>=empty"]
impl_api_<X>_seed  -> gate_<artifact_check> [condition="outcome=success"]
impl_api_<X>_patch -> gate_<artifact_check> [condition="outcome=success"]
gate_<artifact_check> -> diamond_api_<next>_mode [condition="outcome=success"]
```

Why it works:
- Each impl is small enough that one model can hold the full scope (no cross-category regression like the god-node fix_backend pattern).
- The diamond routes to `_patch` once `artifact_X=seeded` (handles iterations 2+); routes to `_seed` first time (or after `seed_failed` flip from a gate failure — see #2).
- The gate is a **semantic** check (field count, route count, subset, eq), NOT a per-file `tsc --noEmit` (which trips `per_artifact_tsc_retry_loop` because tsc errors have non-local root causes).
- Each phase's gate must pass before moving to the next artifact's diamond — prevents downstream artifacts being built on a broken upstream.
- The whole chain is wrapped by `route_contract_violation` later in the iterate body, which can re-enter any per-artifact diamond on a contract category match (cross-file constraint failures).

Use this pattern when you have ≥4 distinct artifact files in the same package whose contracts can be checked mechanically. For ≤3 files, the god-node pattern is fine (with `allow_multi_retry_target=true`).

## Generative Audit Frames

Apply these six frames in order during iteration-1 Edge Walk, before pattern catalog scan. Each frame has Procedure, Output, Severity Mapping, Examples (one positive, one negative).

> **Finding format canonical reference**: The raw-finding body template, per-element `analysis_mode` computation, and three-severity model (`pre_verification_severity` / `post_verification_severity` / `rendered_severity`) are specified in `plumbus.md § Finding Format` (inside Override 6). That section is the single source of truth for finding structure; the frames below specify only what to look for and how to score it.

### Frame 1: Context Key Lifecycle Trace

**Procedure:**
1. Load the engine-injected key registry (`extension/data/engine-injected-keys.json`, A6). Every key that matches `engine_keys` literally or `engine_key_patterns` as a glob is classified as **engine-written** and skipped by the orphan-writer / asymmetry checks — the engine handler is its writer. Keys matching `user_written_patterns` (e.g. `artifact_*`) are **explicitly included** in the symmetry check: they're author-convention writes, not engine writes, and the whole point of the frame is to catch the asymmetric ones.
2. Build a writer/reader matrix for every remaining context key referenced in the graph. Sources of writes: `context_on_success` attrs, `context_on_failure` attrs, `ATTRACTOR_CTX:<key>=...` lines in `tool_command` text (supplemental regex pass — the attractor parser treats tool_command as opaque text; see §Companion script architecture). Sources of reads: edge `condition="context.<key>=<value>"` clauses, `context_keys=` attrs on codergen nodes, `ATTRACTOR_CTX_<key>` references inside `tool_command` strings, prompt body text mentioning `${ATTRACTOR_CTX_*}`.
3. For every key in the matrix, classify:
   - **Orphan reader** (read by ≥1 edge or attr, never written): the key will always be undefined → that edge never fires → silent dead routing.
   - **Orphan writer** (written by ≥1 attr, never read): wasted state, OR the author intended a reader and forgot it → the routing they wanted doesn't exist.
   - **Asymmetric writer** (written on success path but never written on the failure path the diamond can reach): the silent-success-trap class.
   - **Multi-writer with conflicting values** (two `context_on_success` attrs on different nodes write the same key with different values): non-deterministic routing depending on which node ran last.
4. Emit findings per orphan/asymmetric/multi-writer key.

**Severity:**
- Orphan reader on a `condition=` edge → **P1** (anti-pattern: dead routing edge).
- Asymmetric writer where the un-written branch is reachable from a `retry_target` loop → **P0** (silent-success trap class).
- Orphan writer → **P3** (cleanup opportunity, may indicate missing reader).
- Multi-writer conflict → **P1**.

**Example (v9 trap):**
- `artifact_api_controller` had writers: `impl_api_controller_seed.context_on_success`, `impl_api_controller_patch.context_on_success`. Reader: `diamond_api_controller_mode → impl_api_controller_patch [condition="context.artifact_api_controller=seeded"]`. Asymmetric — no writer on the failure path of `gate_controller_routes` (gate's `retry_target` returned to the diamond, which still saw `seeded` → looped on patch). The fix added `gate_controller_routes.context_on_failure="artifact_api_controller=seed_failed"`.

### Frame 2: Success/Failure Symmetry

**Procedure:** For every node `N`:
1. Enumerate the state-mutating attrs `N` carries: `context_on_success`, `context_on_failure`, `commit_and_push`, `escalate_on`, `reports_to_v` writes, plus `ATTRACTOR_CTX:` writes from its tool output.
2. For each attr, ask: "If `N` reaches the **opposite** outcome (success→fail or fail→success), and the next graph traversal depends on the state this attr writes, what unwinds it?"
3. If nothing unwinds it AND a downstream routing edge depends on the state, file a finding.

**Heuristic shortcut:** any node with `context_on_success` whose key matches a downstream `condition="context.<key>=<value>"` MUST also have either `context_on_failure` writing a non-matching value OR a downstream node whose `context_on_failure` writes a non-matching value.

**Severity:** **P0** when the asymmetric state participates in a `retry_target` loop or `iterate` body routing. **P2** otherwise.

**Example:** the `verify_gate_needs_both_context_paths` validator rule (added 2026-04-16) is one mechanical instance of this frame. The frame generalizes beyond gates to any node-pair coupling.

### Frame 3: Edge Condition Exhaustiveness

**Procedure:** For every diamond and every fan-out from a tool/codergen node with multiple outgoing `condition=` edges:
1. Identify the set of context keys referenced in any outgoing edge condition.
2. Enumerate the cartesian product of values each key has been observed taking (from `context_on_success`/`_on_failure` attrs anywhere in the graph, plus `outcome ∈ {success, fail}`, plus the implicit "unset" value).
3. For each cell of the product, count matching edges:
   - **0 matches** → stuck state. Pipeline halts at the diamond with "no outgoing edge."
   - **1 match** → fine.
   - **≥2 matches with same weight** → non-deterministic routing (engine picks first by insertion order, but author probably didn't realize).
   - **≥2 matches with different weights** → fine, but worth annotating with intent in a comment.
4. Emit a finding per stuck-state cell and per nondeterministic cell.

**Severity:** Stuck states are **P0**. Nondeterministic routing is **P1**. Multi-match deterministic routing without comment is **P3**.

**Cell signature deterministic hash** *(refined: requirements P0 A7 determinism)*: `cell_signature` in the cluster_key is a SHA-256 of the cartesian-cell's key-value pairs serialized as a sorted JSON array (sorted by key name, stable across runs).

**Example (v9 trap):** `diamond_api_controller_mode` had edges:
```
-> impl_api_controller_patch [condition="context.artifact_api_controller=seeded", weight=2]
-> impl_api_controller_seed  [condition="context.pool_count_reviewer_controller=empty"]
```
Cartesian product: `(artifact ∈ {unset, seeded, seed_failed}) × (pool_count ∈ {empty, non-empty})` = 6 cells.
- `(unset, empty)` → 1 match (seed). OK.
- `(unset, non-empty)` → 0 matches. STUCK.
- `(seeded, empty)` → 2 matches with weight 2 vs default 1 → patch wins. The trap state.
- `(seeded, non-empty)` → 2 matches → patch wins. Probably intended.
- `(seed_failed, empty)` → 1 match (seed). OK.
- `(seed_failed, non-empty)` → 0 matches. STUCK.

The `(unset, non-empty)` and `(seed_failed, non-empty)` stuck-state cells were latent bugs the catalog wouldn't have flagged.

### Frame 4: Tool Exit Code Semantics Audit

**Procedure:** For every tool node:
1. Classify the tool's intended purpose by inspecting `tool_command`, `reports_to_v`, downstream edges, and (where the script is in the local repo) the script's source:
   - **Build/check tool**: exit 0 = pass, exit non-zero = real failure. Examples: `tsc --noEmit`, `npm test`, `eslint`.
   - **Routing-signal tool**: writes `ATTRACTOR_CTX:<key>=...` to stdout; the downstream diamond consumes the key; exit code should be 0 unless the script itself crashed. Examples: `verify-contract.ts` (98 LOC), `verify-patches-landed.ts` (88 LOC), `verify-e2e-passes.ts` (62 LOC) — the real current cohort.
   - **Scaffolding tool**: side-effect-only (creates files, runs migrations, installs deps). Exit code matters; output usually doesn't.
2. Cross-reference the classification against the DOT's interpretation:
   - Build/check tool with `retry_target` to a fix node → consistent.
   - Routing-signal tool with `retry_target` to a fix node AND downstream `condition="context.<routing_key>=..."` edges → **inconsistent** (the routing path is unreachable when the script exits non-zero, which is exactly when the routing matters). The verify-contract.ts trap.
   - Scaffolding tool with `reports_to_v` → suspect (scaffolding doesn't produce a convergence signal).
3. For routing-signal tools, attempt to verify the script's actual exit-code semantics. Three modes, tried in order; the first one whose gates all pass wins. Every Frame 4 finding records which mode fired as its `confidence:` tag.
   - **Mode A (`confidence: HIGH`)**: read the script and report actual semantics. Gates — ALL must hold:
     - a. Script path resolves within the current working repo (not a remote URL, not a tool binary on PATH).
     - b. File ≤ 200 LOC.
     - c. ≤ 5 call sites to `process.exit()` / `exit()` / equivalent in the detected language.
     - d. Exit codes are literal integers (no computed / variable exit codes).
     - e. Language is one of: TypeScript, JavaScript, Python, Bash. (Extendable — pick languages the LLM can reliably trace.)
   - **Mode B (`confidence: MEDIUM`)**: source unreachable or fails a Mode A gate, but `tool_command` contains heuristic hints. Recognized hints: chained `&& echo` / `|| echo` sentinels, `ATTRACTOR_CTX:<key>=` substrings embedded in `tool_command`, inline comments in the DOT adjacent to the tool node stating exit-code intent. LLM classifies heuristically using only these hints.
   - **Mode C (`confidence: LOW`)**: neither source nor hints available. The LLM emits a finding of the form "script semantics unverified; reasoning from downstream wiring only" and reports whether the routing diamond has what it needs under *both* exit-0 and exit-nonzero cases. A Mode C finding is **not auto-actionable**; the worker flags it for manual investigation in `gap_analysis.md`.

   **Gate-threshold grounding** *(refined: risk-scope R14)*: the current production cohort (98/88/62 LOC, all ≤ 5 exit calls) passes Mode A trivially. The 200-LOC gate was sized generously rather than tuned to the corpus; it remains authoritative until a real routing-signal script crosses 100 LOC, at which point the gate should be re-examined. Mode B / Mode C pedagogical examples require synthesized fixtures (A11) because no production script currently falls into them.

   **Mode C finding body template** *(refined: requirements P1)*:

   ```markdown
   ### Frame 4: Tool Exit Code Semantics Audit
   - **[P0 flagged manual-investigation]** `<tool_node>` — script semantics unverified; reasoning from downstream wiring only.
     - **Analysis mode**: llm-only
     - **Confidence**: LOW
     - **Cluster key**: `(<tool_node>)`
     - **pre_verification_severity**: P0 (manual investigation required)
     - **post_verification_severity**: P0 (manual investigation required)
     - Trace: script_path=<path>, reason=<mode-A gate that failed OR "path unreachable" OR "no source nor hints">, downstream_diamond=<diamond_node> reads keys=<[...]>, exit-0 behavior=<description>, exit-nonzero behavior=<description>.
     - **Risk**: routing may be unreachable under exit-nonzero; manual script inspection required.
     - **Suggested fix**: MANUAL — inspect `<script_path>` and confirm/correct DOT wiring.
   ```

   Log the gate outcome explicitly in `gap_analysis.md` so the rubric never looks authoritative when it's guessing:

   ```markdown
   #### Frame 4 attempt for verify-controller-routes.ts (illustrative)
   - Script path resolved: ✓ (packages/attractor/scripts/verify-controller-routes.ts)
   - Size: 204 LOC (limit 200) — ✗
   - Exit call sites: 4 (limit 5) — ✓
   - Mode A SKIPPED (size gate). Falling back to Mode B (heuristic).
   - tool_command hints: none found in any current pipeline wiring this script.
   - Falling back to Mode C.
   - Confidence: LOW.
   - Finding: routing unverified; flag for manual investigation.

   *Note: this is the real state of this script (build/check tool, not routing-signal). For a Mode-B pedagogical example of a routing-signal tool with heuristic hints, see the fixture `extension/tests/__fixtures__/plumbus-frames/frame4-mode-b.dot` which wires a synthetic tool with `tool_command="bun verify-x.ts && echo ATTRACTOR_CTX:category=..."` to demonstrate the hint-based path.*
   ```

**Severity:** Routing-signal tool with conflicting wiring → **P0** at Mode A/B confidence; **P0 flagged manual-investigation** at Mode C. Build/check tool wired as routing-signal → **P0**. Suspect scaffolding `reports_to_v` → **P2**. Severity is independent of `confidence:` — low confidence means "verify before acting," not "downgrade the bug."


### Frame 5: Loop Convergence Proof Obligation

**Procedure:** For every SCC (strongly connected component) detected via Tarjan’s algorithm on the pipeline graph:
1. Identify all context keys written within the SCC body. Cross-reference against the recognized convergence signals: `iterate`, `model_ladder`, `__pool_findings__`, `__fix_attempt_history`, `__last_failure_output`. At least one of these keys must be consumed by a routing diamond that has a finite-exit branch (an edge leading out of the SCC) and whose condition evaluates to that key.
2. Verify the finite-exit branch is reachable: the condition must evaluate to a concrete terminal value (e.g., `context.iterate=done`, `context.model_ladder=exhausted`) that the SCC body actually writes on at least one code path.
3. Verify there is no unbounded accumulation: if `__pool_findings__` or `__fix_attempt_history` is written on every iteration, confirm a guard node or diamond bounds the loop by size or count before re-entry.
4. For each `iterate` body (any subgraph dominated by an `iterate`-keyed node), apply steps 1-3 recursively.
5. Classify outcome:
   - **PROVEN**: finite-exit branch reachable, convergence key written, no unbounded accumulation.
   - **UNPROVEN**: finite-exit branch exists but convergence key is never written by SCC body — the loop may spin forever.
   - **ABSENT**: no finite-exit branch on any diamond within the SCC — infinite loop structural guarantee.

**Frame 5 severity cap:** Frame 5 severity is capped at P1 until the calibration baseline reaches ≥90% precision (PRD risk-scope R7). Do not promote Frame 5 findings above P1 before that baseline is established.

**Severity pre-cap mapping** (apply cap above):
- ABSENT → **P0** (capped P1 pre-baseline)
- UNPROVEN → **P1** (no cap change)
- PROVEN with unbounded accumulation → **P2**

**Note on iterate bodies:** Nested `iterate` bodies must each satisfy convergence independently. A parent SCC being PROVEN does not exempt a nested iterate body from its own proof obligation.

### Frame 6: Counterfactual Outcome Test

**Procedure:** For each tool node whose `tool_command` performs a state-mutating operation (file write, API call, database insert, external service invocation):
1. Construct the counterfactual: if this tool node were removed from the pipeline, what is the observable downstream difference?
2. Identify all downstream guard nodes — diamonds or verify tools that would catch a silent failure (a missing write, a dropped API response, an absent side-effect).
3. Classify the guard coverage:
   - **Direct guard**: a verify tool or diamond immediately downstream reads the artifact or response produced by the tool node and branches on its presence or correctness.
   - **Transitive guard**: a later pipeline stage would eventually surface the failure, but not immediately (e.g., a final integration test that runs after N other nodes).
   - **No guard**: the pipeline proceeds identically whether the tool node ran correctly or silently failed — the silent-failure-trap class.
4. Emit a finding for every tool node in the no-guard class, and a lower-severity note for transitive-only coverage.

**Severity:**
- No direct guard (silent-failure trap) → **P1**
- Transitive guard only (failure surfaces late) → **P2**

**Example (impl_api_controller_seed):** If `impl_api_controller_seed` writes controller stubs and the next node is `verify_contract` (which reads those stubs), `verify_contract` is a direct guard — COVERED. If instead the next node is `run_full_e2e` (which may pass even with missing stubs if defaults exist), that is transitive-only → P2 finding.

Validator rule promotion: When a Generative Audit Frame produces the same finding pattern across ≥3 distinct `.dot` files, that pattern is a candidate for promotion to a named validator rule. File an issue suggesting a new validator rule with the documented finding template. Auto-promotion is out of scope.

## Tier 1: Always Emit

**0. Isolated Workspace Commit & Push** — **MANDATORY** when `workspace="isolated"`. Without this, all code is lost on cleanup. Place AFTER `verify_final` succeeds — `commit_and_push` runs exactly once on the success path, pushing only verified working code:
```
// Branch name derived from pipeline slug + short run ID
// -B is idempotent (force-creates branch), --force handles partial prior runs pushing to the same branch
commit_and_push [shape=parallelogram, tool_command="cd ${WORKING_DIR} && BRANCH=\"attractor/${SLUG}-$(echo $ATTRACTOR_RUN_ID | cut -c1-8)\" && git checkout -B \"$BRANCH\" && git add -A && git -c user.name=attractor -c user.email=attractor@local commit -m \"feat: ${SLUG} — attractor pipeline output\" --allow-empty && git push origin \"$BRANCH\" --force 2>&1 && echo \"Pushed branch: $BRANCH\"", timeout="120s"]
```
Edges: place after `check_final` success, before `done`:
```
verify_final -> check_final
check_final -> commit_and_push [condition="outcome=success", weight=2]
check_final -> fix_all [condition="outcome=fail"]
fix_all -> verify_final
commit_and_push -> done
```
**Why this exists:** Isolated workspaces are ephemeral. `workspace_cleanup="delete"` (engine default) destroys the workspace after completion. Even with `"preserve"`, workspaces are swept after 24h. Pushing a branch is the ONLY durable way to preserve pipeline output.

Anti-pattern: `workspace="isolated"` without a `commit_and_push` node = **all work lost on completion**.
Validator rule 23 enforces this — pipelines will warn if `workspace=isolated` lacks a push node.

**0a. Dependency Setup** — first node after start. Tool node installs deps in `working_dir`:
```
setup_deps [shape=parallelogram, tool_command="cd ${WORKING_DIR} && npm install 2>&1", timeout="120s"]
start -> setup_deps -> first_impl
```
Detect package manager: `npm install`, `pnpm install`, `yarn install`, `pip install -r requirements.txt`, etc.
For repos needing pre-install steps (e.g., VPN, auth tokens), use `tool_hooks.pre` on setup_deps: `tool_hooks.pre="./scripts/pre-install.sh"`.

**0b. max_parallel=1** — ALL `shape=component` fan-out nodes MUST use `max_parallel=1`. Parallel claude processes OOM the Docker container (7GB limit).

**0c. Baseline Health Snapshot** — capture pre-existing lint/typecheck/test errors BEFORE any impl node runs. This prevents verify nodes from failing on errors the pipeline didn't introduce:
```
capture_baseline [shape=parallelogram, tool_command="cd ${WORKING_DIR} && echo '=== BASELINE ERRORS ===' && (${LINT_CMD} 2>&1 || true) | grep -c 'error' > /tmp/baseline_lint_errors.txt && (${TYPECHECK_CMD} 2>&1 || true) | grep -c 'error TS' > /tmp/baseline_ts_errors.txt && (${TEST_CMD} 2>&1 || true) | grep -cE 'fail|FAIL' > /tmp/baseline_test_errors.txt && echo \"lint=$(cat /tmp/baseline_lint_errors.txt) ts=$(cat /tmp/baseline_ts_errors.txt) test=$(cat /tmp/baseline_test_errors.txt)\" 2>&1", timeout="120s"]
```
Placed after `setup_deps`, before first impl. All verify/reverify `tool_command` values MUST use the delta-check script (Pattern 0d) instead of raw lint/typecheck/test commands.

**0e. Progress Gate** — after each impl node, verify files were actually modified. Catches stalled impls that produce no changes (common with permission errors, wrong paths, or LLM refusals). Place between impl and first lint gate:
```
check_progress [shape=parallelogram, tool_command="cd ${WORKING_DIR} && CHANGED=$(git status --porcelain | wc -l | tr -d ' ') && if [ \"$CHANGED\" -eq 0 ]; then echo 'STALL: impl produced zero file changes — retrying'; exit 1; fi && echo \"progress: $CHANGED files modified\" 2>&1", max_visits=3]
```
Wiring (extends Pattern 1 test-fix loop):
```
impl -> check_progress -> check_progress_gate [shape=diamond]
check_progress_gate -> verify_lint [condition="outcome=success", weight=2]
check_progress_gate -> impl [condition="outcome=fail"]
```
`max_visits=3` prevents infinite stall loops — after 3 zero-progress attempts, the node fails and graph-level `retry_target` (fix_all) takes over. Uses `git status --porcelain` (not `git diff --stat HEAD`) because it catches unstaged, staged, and untracked files regardless of commit state.

**0d. Delta-Aware Verification** — verify commands compare current errors against baseline. Fail ONLY on regressions (new errors introduced by pipeline), not pre-existing debt:
```
// Per-phase verify and reverify tool_command template:
tool_command="cd ${WORKING_DIR} && bash scripts/verify-delta.sh"

// The verify-delta.sh script (generated by capture_baseline or provided in repo):
// Runs lint, typecheck, test. Compares error counts against /tmp/baseline_*.txt.
// Exits 0 if no NEW errors introduced. Exits 1 if error count increased.
// Outputs: BASELINE: N, CURRENT: M, DELTA: +K or CLEAN
```
For repos without a verify-delta.sh, inline the delta logic in tool_command:
```
tool_command="cd ${WORKING_DIR} && BASELINE_TS=$(cat /tmp/baseline_ts_errors.txt 2>/dev/null || echo 0) && CURRENT_TS=$((${TYPECHECK_CMD} 2>&1 || true) | grep -c 'error TS') && BASELINE_LINT=$(cat /tmp/baseline_lint_errors.txt 2>/dev/null || echo 0) && CURRENT_LINT=$((${LINT_CMD} 2>&1 || true) | grep -c 'error') && echo \"TS baseline=$BASELINE_TS current=$CURRENT_TS\" && echo \"Lint baseline=$BASELINE_LINT current=$CURRENT_LINT\" && ${TEST_CMD} 2>&1 && [ $CURRENT_TS -le $BASELINE_TS ] && [ $CURRENT_LINT -le $BASELINE_LINT ] && echo 'DELTA: CLEAN' || (echo 'DELTA: REGRESSION' && exit 1)"
```
When baseline files don't exist (e.g., first run without capture_baseline), defaults to 0 — behaves like absolute verification. This makes delta-check backward-compatible.

**1. Test-Fix Loops** — every impl has verification routing back on failure:
```
impl -> test -> check [shape=diamond]
check -> next [condition="outcome=success", weight=2]
check -> impl [condition="outcome=fail"]
```

**2. Goal Gates** — P0/critical nodes get `goal_gate=true`. PRD acceptance criteria → `acceptance_criteria` attr + `goal_gate=true`. Prefer per-node `retry_target`. Every `goal_gate=true` node with a `retry_target` MUST also have `max_visits` (validator rule 19 enforces this — without it, the gate can retry infinitely). Recommended: `max_visits=5` for impl, `max_visits=3` for verify/conformance. Context vars: `context.tests_pass`, `context.build_status`, `context.lint_status`, `context.typecheck_status`.

**Gate Loop Invariant** — every `goal_gate=true` node MUST have a complete fail→fix→gate loop:
1. The gate has a fail edge to a dedicated fix node
2. The fix node has an unconditional edge back to the gate
3. No `goal_gate=true` without this loop — failures with no fix edge fall through to graph-level `retry_target`, which is a last-resort recovery, not a substitute for a local fix loop

**CRITICAL: `context_on_success` bridge** — every key in `acceptance_criteria` MUST be set by `context_on_success="key=value,key2=value2"` on the final verification tool node. Without this, criteria always fail → retry until engine safety limit (10 retries, then hard failure):
```
verify_final [shape=parallelogram,
    tool_command="cd ${WORKING_DIR} && ${LINT_CMD} 2>&1 && ${TYPECHECK_CMD} 2>&1 && ${TEST_CMD} 2>&1",
    goal_gate=true, retry_target="fix_all", max_visits=3,
    context_on_success="tests_pass=true,lint_status=passing,typecheck_status=passing"]
```
Do NOT put `context_on_success` on intermediate per-phase verify nodes — those use goal gates for convergence. Only the final verify_final before exit sets acceptance criteria context.

**3. Conditional Routing** — diamond nodes, 2+ edges covering all cases:
```
check [shape=diamond]
check -> a [condition="outcome=success", weight=2]
check -> b [condition="outcome=fail"]
```

**6. Max Visits** — `max_visits` on looping nodes prevents infinite convergence. Required on all `goal_gate=true` nodes with `retry_target` (validator rule 19).

**6a. Self-Retry on Critical Non-Gate Nodes** — tool nodes that aren't goal gates but whose failure would silently poison downstream nodes (e.g., `scaffold`, `verify_tracks`, `capture_baseline`) should set `retry_target="<self>"` to retry in-place before falling through to graph-level `retry_target`. Without this, a transient failure (network timeout, flaky install) skips straight to `fix_all`, which can't fix infrastructure issues.

**Critical exception (validator rule `gate_self_retry_loop`)**: tool nodes with `reports_to_v=...` (convergence gates inside an iterate body) MUST NOT have `retry_target=<self>`. These are deterministic measurement nodes — re-running them against unchanged code is a no-op until the FailureSignatureTracker structurally aborts the pipeline. Convergence gates retry through their fix node, never through themselves:
```
// BAD
run_tests_api [tool_command="npm test", reports_to_v="mechanical.boot", retry_target="run_tests_api"]
// GOOD
run_tests_api [tool_command="npm test", reports_to_v="mechanical.boot", retry_target="fix_backend"]
```
See "Recent Validator Changes (2026-04-14)" at the top of this file for the full reasoning.

**6b. No-Op Detection Warning** — the claude-code backend returns `RETRY` when a codergen node produces zero edits (`editWriteCount === 0`) and no explicit `STATUS:` marker. This means **read-only nodes** (analysis, conformance, scope check) that only read code without writing files will RETRY forever unless their prompt instructs the LLM to output `STATUS: SUCCESS` (or `FAIL`/`PARTIAL_SUCCESS`) on its own line. All review/conformance/red_team/scope_check nodes MUST include explicit STATUS output instructions in their prompts:
```
// Good — explicit STATUS marker:
conformance [class="review", prompt="... Output PASS or FAIL with unmet requirements. Then output 'STATUS: SUCCESS' if PASS, 'STATUS: FAIL' if FAIL on its own line."]

// Bad — no STATUS marker, will RETRY forever because no files are edited:
conformance [class="review", prompt="... Output PASS or FAIL with unmet requirements."]
```
**`read_only=true`** — set on all read-only codergen nodes (reviewers, conformance, bdd_scenarios, scope_check, red_team, check_coverage). The claude-code backend skips no-op detection when `read_only=true`, so 0 Edit/Write calls are expected behavior. Use BOTH `read_only=true` AND STATUS markers — `read_only` is the engine-level defense, STATUS markers are the prompt-level defense.

Exception: review ratchet merge nodes (tripleoctagon) don't need `read_only` or STATUS markers. The fan-in handler (`handlers/fan-in.ts`) has its own `execute()` that always returns `SUCCESS` — it calls the backend only to extract candidate selection text, then discards the backend's outcome. No-op detection is swallowed by the handler.

**13. Lint Gate** — separate tool node for linter, BEFORE tests. MUST be delta-aware (Pattern 0d) when repo has pre-existing lint errors:
```
verify_lint [shape=parallelogram, tool_command="cd ${WORKING_DIR} && BASELINE=$(cat /tmp/baseline_lint_errors.txt 2>/dev/null || echo 0) && CURRENT=$((${LINT_CMD} 2>&1 || true) | grep -c 'error') && echo \"lint baseline=$BASELINE current=$CURRENT\" && [ $CURRENT -le $BASELINE ] || (echo 'LINT REGRESSION' && exit 1)", max_visits=3]
```
For clean repos (no pre-existing errors), raw `${LINT_CMD}` is acceptable. Detect: `npm run lint`, `ruff check .`, `golangci-lint run`. Skip if no linter.

**14. Type-Check Gate** — separate tool node, AFTER lint, BEFORE tests. MUST be delta-aware (Pattern 0d) when repo has pre-existing type errors:
```
verify_types [shape=parallelogram, tool_command="cd ${WORKING_DIR} && BASELINE=$(cat /tmp/baseline_ts_errors.txt 2>/dev/null || echo 0) && CURRENT=$((${TYPECHECK_CMD} 2>&1 || true) | grep -c 'error TS') && echo \"typecheck baseline=$BASELINE current=$CURRENT\" && [ $CURRENT -le $BASELINE ] || (echo 'TYPECHECK REGRESSION' && exit 1)", max_visits=3]
```
Detect: `tsc --noEmit`, `mypy .`, `go vet ./...`. Skip for dynamically-typed projects.

**21. Disaggregated Verify/Fix Endgame** — replaces the god-node `fix_all` anti-pattern with isolated fix-verify pairs. The builder auto-generates this chain after all per-phase nodes:

```
audit [shape=parallelogram, tool_command="cd ${WORKING_DIR} && (npx tsc --noEmit 2>&1 || true) && (npx eslint src/ 2>&1 || true) && (npm test 2>&1 || true)", read_only=true]
verify_typecheck [shape=parallelogram, goal_gate=true, retry_target="fix_types", max_visits=5, tool_command="cd ${WORKING_DIR} && npx tsc --noEmit 2>&1", context_on_success="types_compile=true"]
fix_types [prompt="Fix ONLY TypeScript type errors. Do NOT modify test logic, lint config, or code unrelated to type errors.", class="codergen", timeout="30m", max_visits=5, allowed_paths="src/**"]
verify_lint [shape=parallelogram, goal_gate=true, retry_target="fix_lint", max_visits=5, tool_command="cd ${WORKING_DIR} && npx eslint src/ --max-warnings=-1 2>&1", context_on_success="lint_clean=true"]
fix_lint [prompt="Fix ONLY ESLint errors. Do NOT modify test files or change logic.", class="codergen", timeout="30m", max_visits=5, allowed_paths="src/**"]
verify_tests [shape=parallelogram, goal_gate=true, retry_target="fix_tests", max_visits=5, tool_command="cd ${WORKING_DIR} && npm test 2>&1", context_on_success="tests_pass=true"]
fix_tests [prompt="Fix ONLY failing tests. Do NOT delete or skip tests.", class="codergen", timeout="30m", max_visits=5, allowed_paths="src/**, tests/**"]
regression_check [shape=parallelogram, tool_command="cd ${WORKING_DIR} && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npm test 2>&1"]
quality_review [class="review", read_only=true, prompt="Review git diff for code quality. Output STATUS: SUCCESS | FAIL."]
```

**Key principle:** Each fix node's `allowed_paths` is scoped to prevent cross-category regression. `fix_types` cannot touch tests, `fix_lint` cannot change type signatures. Empirically: 6/6 AC in 8min vs 4/6 in 7h with the god-node pattern.

**Edges:** `audit → verify_typecheck → verify_lint → verify_tests → regression_check → quality_review → exit`. Each verify node has a fail→fix→verify isolated loop. `regression_check` failure re-enters at `fix_types`.

**Validator rule `pipeline_convergence_gates`**: Warns when pipelines with 3+ codergen nodes lack `goal_gate=true` or `acceptance_criteria`.

Graph-level `retry_target` points to `fix_types` (first node in the endgame chain). Optional `endgame.broadPass=true` adds an initial `fix_all` with `max_visits=2` before the chain — NOT referenced as `retry_target` by any verify node.

## Tier 2: Default (emit unless explicitly simplified)

**15. Conformance Check** — LLM gate verifying requirements against `$spec_file`. Opus (`.review` class), `goal_gate=true`:
```
conformance [class="review", read_only=true, goal_gate=true, retry_target="impl", max_visits=3, prompt="Conformance audit: read the spec file at $spec_file. Compare every requirement against the current git diff. Verify: 1) Every requirement has a corresponding code change. 2) Acceptance criteria are testable and tested. 3) No requirements silently dropped. Output PASS or FAIL with unmet requirements. Then output 'STATUS: SUCCESS' if PASS, 'STATUS: FAIL' if FAIL on its own line."]
```
`$spec_file` is interpolated by the engine from the graph-level `spec_file` attribute (like `$goal`).

**Multi-phase pipelines**: Use a dedicated `fix_conformance` node. Do NOT share `fix_all` between conformance and verify_final retry loops — their max_visits interact and cause premature crashes. See Step 3 in pickle-dot.md for the split pattern.

**16. Spec-First TDD** — write failing tests FROM spec BEFORE impl. Mandatory for `goal_gate=true` impl nodes:
```
spec_tests [class="review", timeout="15m", prompt="Write failing tests for EVERY requirement. Do NOT write production code.", goal_gate=true, retry_target="spec_tests", max_visits=5]
impl [prompt="Make all failing tests pass. Do NOT modify test files.", allowed_paths="src/**, tests/**", goal_gate=true, retry_target="impl", max_visits=8]
```

**16b. BDD Scenario Generation** — behavioral contracts before spec_tests. Emit for phases with 3+ requirements. For 1-2 requirements, spec_tests alone is sufficient:
```
bdd_scenarios [class="review", read_only=true, timeout="10m", prompt="Read the spec file at $spec_file. For each requirement, generate BDD scenarios in Given/When/Then format. Output as executable test descriptions. Do NOT implement — only define the behavioral contracts. Then output 'STATUS: SUCCESS' on its own line."]
spec_tests [class="review", timeout="15m", prompt="Read the BDD scenarios from the previous node's output. Write failing test cases that verify each scenario. Run them to confirm they fail. Do NOT write production code.", goal_gate=true, retry_target="spec_tests", max_visits=5]
impl [prompt="Make all failing tests pass. Do NOT modify test files.", allowed_paths="src/**, tests/**", escalate_on="package.json, package-lock.json, .env*, *.config.*", goal_gate=true, retry_target="impl", max_visits=8]
```
The BDD node reads `$spec_file`, generates Given/When/Then scenarios. spec_tests converts them to executable tests. impl makes them pass.

**22. Permission Scoping (allowed_paths + escalate_on)** — every codergen (box) impl node declares its file scope:
```
impl_auth [prompt="Implement JWT middleware",
    permission_mode="bypassPermissions",
    allowed_paths="src/auth/**, src/middleware/**, tests/auth/**",
    escalate_on="package.json, package-lock.json, .env*, prisma/schema.prisma"]
```
Rules:
- `allowed_paths`: derive from PRD's affected files/directories. Include source + test dirs. Use `**` for recursive matching when the scope includes subdirectories (e.g., `src/auth/**` matches `src/auth/middleware/jwt.ts`). Use `*` only for intentionally narrow single-level scopes.
- `escalate_on`: always include `package.json, package-lock.json, *.lock`, schema files (`*.prisma, *.sql, migrations/*`), config (`.env*, *.config.*`), and auth-related files.
- If PRD lacks affected-files section → emit `// WARNING: PRD lacks affected-files section` and use broad `allowed_paths="src/**, tests/**"`.
- Cross-check: after generating each impl node, verify every file path mentioned in `prompt=` text appears in `allowed_paths` (or is covered by a glob). If the prompt says "edit parser.ts" but `allowed_paths` doesn't include it, the agent will do the work and scope enforcement will throw it away — wasted tokens and time. Validator rule 26 (`prompt_files_in_allowed_paths`) catches this at submission, but fix it at generation time.
- Tool nodes (parallelogram) don't need allowed_paths — they run shell commands, not agents.
- Review/simplify/conformance nodes don't need them — they only read, not write.

**23. Defense Matrix** — comment block at top of every DOT file, after graph attributes:
```
// Defense Matrix:
//   Layer 1 (Competitive):  [YES/NO] — fan-out/fan-in for complex phases
//   Layer 2 (Guardrails):   YES — lint → typecheck → test → audit
//   Layer 3 (Spec-Driven):  [YES/PARTIAL] — spec_file, BDD contracts, conformance
//   Layer 4 (Permissions):  YES — allowed_paths on impl nodes
//   Layer 5 (Adversarial):  YES — multi-model review, red team, scope check
```
Layer 1 = YES when Pattern 18 (competing impls) or Pattern 4 (fan-out) is present. Layer 3 = YES when all of: spec_file, BDD/spec_tests, conformance are present. Use PARTIAL when BDD/spec_tests are omitted: `Layer 3 (Spec-Driven): PARTIAL — spec_file + conformance (no BDD/spec_tests)`. Layer 5 = YES when multi-model review routing or red_team is present. Layers 2 and 4 are always YES.

**19. Review Convergence Ratchet** — N consecutive clean agent team passes required. Default for all pipelines. Replaces Pattern 7.

Team composition: `correctness` + `patterns` always. Add `architecture` (>5 files), `security` (auth/data), `performance` (hot paths), `api_compatibility` (contracts). Present in Step 2b checklist for user confirmation (default: 2 consecutive passes).

Each pass = `component→tripleoctagon` fan-out. Pass K failure resets to pass 1. Fix prompts include simplification.
```
split_review_N [shape=component, max_parallel=1, join_policy="wait_all", error_policy="continue"]
reviewer_X_N [class="review", read_only=true, timeout="15m", prompt="<narrow focus> ONLY. List issues with file:line. Then output 'STATUS: SUCCESS' on its own line."]
merge_review_N [shape=tripleoctagon, class="review", timeout="10m", prompt="Consolidate. BLOCKER or ADVISORY. CLEAN or DIRTY."]  // CAN use eval_criteria for structured scoring, but defaults to LLM prompt-based merge for simplicity. Fan-in handler swallows backend outcome — no STATUS needed.
check_review_N [shape=diamond]
fix_N [prompt="Fix all BLOCKERs. Also simplify. Do NOT modify test files.", max_visits=5]
reverify_N [shape=parallelogram, tool_command="cd ${WORKING_DIR} && ..."]
check_reverify_N [shape=diamond]
// check_reverify_N -> split_review_1 [condition="outcome=success", weight=2]
// check_reverify_N -> fix_N [condition="outcome=fail"]
```

## Tier 3: Conditional (emit when PRD analysis flags them)

**4. Parallel Fan-Out/Fan-In** — when PRD has independent workstreams:
```
split [shape=component, max_parallel=1, join_policy="wait_all", error_policy="continue"]
merge [shape=tripleoctagon, prompt="Select best"]
```

**8. Security Scanning** — separate from tests. For projects with security tooling:
```
verify_security [shape=parallelogram, tool_command="npm audit --audit-level=high 2>&1"]
```

**9. Coverage Qualification** — score-based gate on new/changed code (>=80%):
```
check_coverage [read_only=true, prompt="Analyze test coverage on new/changed code. Target >=80% on new lines. Output PASS or FAIL with uncovered files. Then output 'STATUS: SUCCESS' if PASS, 'STATUS: FAIL' if FAIL on its own line.", goal_gate=true, retry_target="impl", max_visits=3, timeout="15m"]
```

**10. Scope Creep Detection** — post-implementation, before review. Opus (`.review`):
```
scope_check [class="review", read_only=true, timeout="15m", prompt="Compare git diff against prompt. Flag out-of-scope changes. Output 'STATUS: SUCCESS' if all changes are in scope, 'STATUS: FAIL' if out-of-scope changes detected on its own line."]
```

**11. Drift Detection** — in review-simplify cycles (Pattern 7 standalone only). Pattern 19 ratchet handles via reset-on-fail.

**17. Adversarial Red Team** — AFTER conformance. Ask user for security/auth/data phases:
```
red_team [class="review", read_only=true, timeout="15m", prompt="Attempt to break: invalid inputs, races, exhaustion, state corruption. Write repro tests. Then output 'STATUS: SUCCESS' if no critical vulnerabilities found, 'STATUS: FAIL' if exploits discovered on its own line.", goal_gate=true, retry_target="impl", max_visits=5]
```
Note: `retry_target="impl"` is correct here (unlike verify_final) because red_team is mid-pipeline — retry re-enters the full lint→typecheck→test→review ratchet via graph edges. verify_final is the FINAL gate where impl retry can't fix cross-phase issues.

**18. Competing Implementations** — two parallel approaches for high-complexity phases (>3 files). Ask user:
```
split_impl [shape=component, max_parallel=1, join_policy="wait_all", error_policy="continue"]
approach_minimal [prompt="MINIMAL changes — smallest diff...", timeout="30m", permission_mode="bypassPermissions", allowed_paths="<from PRD>", escalate_on="<standard>", max_visits=8]
approach_clean [prompt="CLEAN architecture — best design...", timeout="30m", permission_mode="bypassPermissions", allowed_paths="<from PRD>", escalate_on="<standard>", max_visits=8]
select_best [shape=tripleoctagon, class="critical", eval_criteria="completeness,faithfulness", eval_model="anthropic/claude-sonnet-4-6", eval_threshold=0.7, eval_max_branches=5]
```

**20. Microverse Convergence Loop** — for quantitative targets (metric optimization). Replaces standard impl→verify when the PRD has a numeric goal and a measurable metric (see pickle-dot.md Step 2 microverse detection).

**Three-way classification**: The `compare` node outputs a STATUS marker parsed by the engine into edge conditions:
- `STATUS: SUCCESS` → target met (exits loop, continues to lint/typecheck/test/review)
- `STATUS: PARTIAL_SUCCESS` → improved but target not reached (loops back to optimize)
- `STATUS: FAIL` → regressed or stalled (rollback, then retry)

`auto_status=true` enables engine-side parsing. `allow_partial=true` enables `outcome=partial_success` on diamond edges. Without these, the engine only recognizes success/fail.

**Status marker parsing** (engine regex: `/^STATUS: (SUCCESS|PARTIAL_SUCCESS|FAIL)$/m`):
- The compare node's LLM output is scanned line-by-line for a `STATUS:` marker
- If marker not found → defaults to FAIL (triggers rollback)
- If `allow_partial=true` not set on diamond → PARTIAL_SUCCESS treated as FAIL
- Prompts MUST instruct the LLM to output the exact marker: `"output 'STATUS: SUCCESS' on its own line"`

**Target and direction**: Extract from PRD. "reduce bundle to 50kb" → target=50, direction=lower. "achieve 90% coverage" → target=90, direction=higher. Embed both in the compare prompt.

**Measurement command**: Must print a number on its last line. Same command for `baseline` and `measure` nodes. See pickle-dot.md Step 2 for derivation patterns.

```
commit_baseline [shape=parallelogram, tool_command="cd ${WORKING_DIR} && git add -u && git -c user.name=attractor -c user.email=attractor@local commit -m 'microverse: baseline' --allow-empty 2>&1"]
baseline [shape=parallelogram, tool_command="cd ${WORKING_DIR} && <measurement_cmd> 2>&1"]
optimize [prompt="Make ONE targeted change toward <TARGET>. Direction: <DIRECTION>. Smallest diff. Do NOT repeat failed approaches.", timeout="30m", max_visits=8, allowed_paths="<from PRD>", escalate_on="<standard>"]
measure [shape=parallelogram, tool_command="cd ${WORKING_DIR} && <measurement_cmd> 2>&1"]
compare [class="review", read_only=true, timeout="15m", prompt="Compare measurement against target. Target: <TARGET>. Direction: <DIRECTION> (<DIRECTION> is better). If target met → STATUS: SUCCESS. If improved toward target but not met → STATUS: PARTIAL_SUCCESS. If regressed or unchanged → STATUS: FAIL. Show before/after values.", max_visits=10, auto_status=true, allow_partial=true]
check_mv [shape=diamond]
rollback [shape=parallelogram, tool_command="cd ${WORKING_DIR} && git checkout . 2>&1"]

// Three-way routing
check_mv -> next_gate [condition="outcome=success", weight=2]
check_mv -> optimize [condition="outcome=partial_success"]
check_mv -> rollback [condition="outcome=fail"]
rollback -> optimize
```

**Wiring into full pipeline**: Microverse replaces `impl → lint → typecheck → test`. On `outcome=success`, flow exits to the first post-impl gate (typically `verify_lint`):
```
start -> setup_deps -> capture_baseline -> spec_tests -> commit_baseline -> baseline -> optimize
optimize -> measure -> compare -> check_mv
check_mv -> verify_lint [condition="outcome=success", weight=2]
check_mv -> optimize [condition="outcome=partial_success"]
check_mv -> rollback [condition="outcome=fail"]
rollback -> optimize
verify_lint -> check_lint -> ... // normal review ratchet continues
```

**Do NOT use microverse for binary targets** (pass/fail, "tests must pass"). Use standard impl→verify. Microverse is for gradual convergence where PARTIAL_SUCCESS is meaningful.

**24. Manager Loop (supervisor)** — for nodes that supervise long-running external processes (CI, deploy, migration). Emit when PRD has "wait for", "monitor", or "poll" requirements:
```
mgr [shape=house, manager.poll_interval="45s", manager.max_cycles=100,
     manager.stop_condition="context.stack.child.status=completed",
     manager.actions="observe,steer,wait", manager.max_duration_ms=1800000]
```
The house node polls a child pipeline or external process. `manager.stop_condition` evaluates against RunContext. Well-known child keys: `context.stack.child.status` (`starting`, `completed`, `failed`), `context.stack.child.current_node`, `context.stack.child.completed_nodes`. `manager.actions` controls what the supervisor can do each cycle: `observe` (read status), `steer` (intervene via `manager.steer_content`), `wait` (sleep until next poll). Use `stack.child_autostart="true"` to auto-launch a child DOT pipeline.

Wiring example (CI deploy wait):
```
impl -> verify_lint -> ... -> review_ratchet -> deploy_trigger
deploy_trigger [shape=parallelogram, tool_command="cd ${WORKING_DIR} && gh workflow run deploy.yml --ref $(git rev-parse --abbrev-ref HEAD) 2>&1", timeout="60s"]
deploy_trigger -> wait_deploy
wait_deploy [shape=house, manager.poll_interval="45s", manager.max_cycles=40,
    manager.stop_condition="context.deploy_status=completed",
    manager.actions="observe,wait", manager.max_duration_ms=1800000]
wait_deploy -> check_deploy [shape=diamond]
check_deploy -> done [condition="outcome=success", weight=2]
check_deploy -> fix_all [condition="outcome=fail"]
```
Anti-pattern: `house` without `manager.stop_condition` (polls forever until max_cycles/max_duration).

**25. Catastrophic Recovery (loop_restart)** — use `loop_restart=true` on edges when incremental retry cannot recover and the pipeline needs a full context reset. This clears the RunContext and restarts from the beginning, incrementing `loop.restart.count`:
```
check_final -> setup_deps [condition="outcome=fail", loop_restart=true, label="catastrophic restart"]
```
**IMPORTANT**: Route to `setup_deps`, NOT `start` — validator rule 3 (`start_no_incoming`) rejects incoming edges on start nodes. The start node is entry-only.

Use sparingly — most failures should be handled by `retry_target` → `fix_all`. Reserve `loop_restart` for:
- Pipelines where accumulated context drift causes cascading failures
- Multi-phase pipelines where early-phase corruption propagates
- Long-running convergence pipelines that need a clean slate

Engine tracks `loop.restart.count` in RunContext — use `max_visits` on the restart target to prevent infinite restarts:
```
setup_deps [shape=parallelogram, ..., max_visits=3]  // max 3 full restarts
```

**26. Stream Lifecycle** — every `createWriteStream` or `createReadStream` must have `.end()` / `.close()` called on ALL return paths. `TextDecoder` with `{ stream: true }` must be flushed with `decoder.decode(new Uint8Array(), { stream: false })` before the function returns.

Anti-pattern:
```typescript
const stream = createWriteStream(path);
// ... use stream ...
stream.end(); // ← only called on happy path
const exitCode = await proc.exited;
if (exitCode === null) return RETRY; // ← stream leaked!
```

Fix: flush and end before any early return, or use try/finally.

**27. Optional Narrowing** — after an optional-chained guard (`obj?.method()`), bind to a local variable. Never re-access the optional chain inside the guarded block — TypeScript narrows the local but not the original expression.

Anti-pattern:
```typescript
if (config.signal?.isPaused()) {
  await config.signal.waitForResume(); // ← crash if signal is undefined
}
```

Fix:
```typescript
const signal = config.signal;
if (signal?.isPaused()) {
  await signal.waitForResume(); // ← safe, narrowed by binding
}
```

**28. Silent Failure Prevention** — every `catch` block must either re-throw, return a typed error, or emit a warning. Never return a sentinel value (empty array, null, default object) that looks like success.

Anti-pattern:
```typescript
function getChangedFiles(): Set<string> {
  try {
    const result = execSync('git diff --name-only');
    return new Set(result.toString().split('\n'));
  } catch {
    return new Set(); // ← caller thinks "no changes" — actually git is broken
  }
}
```

Fix:
```typescript
function getChangedFiles(): Set<string> | { error: string } {
  try {
    const result = execSync('git diff --name-only');
    return new Set(result.toString().split('\n'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[getChangedFiles] git failed: ${msg}`);
    return { error: msg }; // ← caller can distinguish "no results" from "broken"
  }
}
```

Also applies to: checkpoint saves with empty catch, config parsing that defaults on error, scope enforcement that silently disables on failure. The rule: callers must be able to distinguish "nothing found" from "search failed."

**29. Concurrency Safety** — for every shared resource (file, database, state object), verify behavior under simultaneous access. Emit events/callbacks AFTER state transitions, never before.

Anti-pattern (event before state):
```typescript
this.emit('RateLimitPause', { duration });  // ← consumers react
this.pauseController.pause();               // ← but pause isn't active yet!
```

Fix:
```typescript
this.pauseController.pause();               // ← state change first
this.emit('RateLimitPause', { duration });  // ← THEN notify consumers
```

Anti-pattern (shared file path in parallel):
```typescript
const logPath = `logs/${nodeId}.jsonl`;
const stream = createWriteStream(logPath, { flags: 'w' }); // ← truncates if parallel node uses same ID
```

Fix:
```typescript
const logPath = `logs/${runId}/${nodeId}.jsonl`; // ← run-scoped, no collision
const stream = createWriteStream(logPath, { flags: 'a' }); // ← append mode as defense-in-depth
```

Also applies to: workspace sweepers that don't check active runs, stall detectors that fire before first output, any `setInterval`/`setTimeout` that assumes sequential execution.

**30. Allocation Hygiene** — compile-once objects (Regex, Glob, parsed configs, template engines) must be instantiated outside hot loops. Constructor in inner loop = per-iteration allocation waste.

Anti-pattern:
```typescript
for (const file of changedFiles) {           // 10K files
  for (const pattern of patterns) {          // × 5 patterns
    const glob = new Bun.Glob(pattern);      // ← 50K Glob objects!
    if (glob.match(file)) { /* ... */ }
  }
}
```

Fix:
```typescript
const compiledGlobs = patterns.map(p => new Bun.Glob(p)); // ← compile once
for (const file of changedFiles) {
  for (const glob of compiledGlobs) {
    if (glob.match(file)) { /* ... */ }       // ← reuse, 0 allocations
  }
}
```

Detection heuristic: any `new` expression inside `for`/`while`/`.map()`/`.forEach()` where constructor arguments don't change per iteration.

**31. Node Scope Decomposition** — free-tier and mid-range models fail on broad prompts. A node that says "write 17 tests covering CRUD, validation, status transitions, and edge cases" will produce 1-3 tests. A node that says "write 5 CRUD tests" will produce 5.

**Rule: one deliverable per node.** Each codergen node should produce ONE of:
- One layer (entity OR service OR controller — not all three)
- One test category (CRUD tests OR validation tests — not both)
- One UI page (dashboard OR form OR detail — not all)
- One config file set (scaffold)

**Decomposition heuristics:**

| Signal | Split into |
|---|---|
| Prompt lists 2+ files in different layers (entity + service + controller) | One node per layer, sequential (`dependsOn` chain) |
| Prompt asks for N tests across M categories (M > 1) | One node per category, each writes its own test file |
| Prompt creates multiple UI pages/routes | One node per page (see UI rules below) |
| Prompt does setup + implementation | Separate scaffold node from impl node |
| Single file, single responsibility, or <100 lines expected output | Leave as one node — don't over-split |

**Test decomposition rules:**
- Each test node writes to its OWN file (e.g., `test/crud.e2e-spec.ts`, `test/validation.e2e-spec.ts`) — never multiple nodes writing to the same file
- Each test node targets 3-5 tests in one category for non-Anthropic providers; up to 8-10 for Opus-tier models
- The `verify_test_setup` tool node after all test nodes checks `npx jest --listTests` finds >= N files (where N = number of test nodes)
- Update endgame `verify_spec` thresholds to match: if 4 test nodes × ~4 tests each = 16 total, gate on `>= 15`
- Each test node must also follow the config belt-and-suspenders rule from Endgame Gate Prerequisites (Pattern 0a area in pickle-dot.md)

**UI decomposition rules:**
- Shared foundations first (layout, types, API client, components) in a `ui_scaffold` node
- One node per page/route — each gets "Existing: [list shared files]. Create ONLY [this page]."
- Pages depend on `ui_scaffold` but can fan-out parallel (Pattern 4) when `allowed_paths` don't overlap. `max_parallel=1` (Pattern 0b) serializes execution inside the Docker container regardless

**Interaction with Pattern 18 (Competing Impls):** If a phase uses competing implementations, do NOT also decompose within each branch — competing impls already provide redundancy via alternative approaches. Pick one approach per branch and keep it as a single node.

**Why this matters for convergence:**
- Smaller nodes have higher first-pass success rate (especially on free/weak models)
- When a node fails, the fix loop knows exactly what category broke
- Endgame fix agents can focus: "fix CRUD tests" not "fix all 17 tests"
- Total token cost increases linearly with node count, but fix-loop waste drops superlinearly. Net cost is lower for pipelines that would otherwise stall

**When NOT to split:**
- Single file changes (one component, one config update)
- Tightly coupled code where splitting creates import dependency hell
- Nodes already under 100 lines of expected output
- Phases using Pattern 18 (competing impls) — redundancy is already handled

**32. Convergence Loop via iterate (Pattern 32)** — iterative refinement with rollback detection and fixed-point convergence. Use when a PRD mentions "converge until", "iterate until", "monotonic improvement", or "fixed point".

**Detection signals:** "converge until", "iterate until clean", "review until zero findings", "monotonic improvement", "rollback on regression", "Lyapunov"

**NOT triggered by:** "iterate" alone, "quality gate" alone, or "adversarial" alone.

**Emits:** Manager node spawning multiple review passes with rollback-on-regression logic. Model diversity via `model_stylesheet` with `.impl`, `.honest_review`, `.adversary` class selectors mapping to distinct models.

**Constraints:**
- Model diversity via model_stylesheet — .impl, .honest_review, .adversary class selectors must map to distinct models
- Reviewers cover all three lenses: backend, frontend, integration
- Adversary has sealed_from_source
- until predicate from canonical set: "V_total == 0", "V_total == 0 && fixed_point", "V_total == 0 && fixed_point && reproducibility"
- harness: "hermes" or "claude-code"
- Replaces endgame chain — do NOT emit both iterate body and emitEndgameChain()
- P25 (Catastrophic Recovery) suppressed when P32 active

**Composition:**
- Pattern 0: commit_and_push after convergence
- Pattern 1: setup_deps before converge node
- Pattern 4: fan-out before converge node
- Pattern 17 (red team): suppressed — iterate adversary subsumes it

**32a. Iterate Body Retry Topology** — every node inside `cluster_iter_body` MUST have a clean retry path that stays within the body, OR be a node whose fall-through to graph-level retry_target is intentional. The body subgraph filters edges to body-internal-only at execution time, so graph-level edges from body nodes to outside nodes (e.g. `adversary_node -> fp_verify`) are silently dropped during body execution. Graph-level NODES (e.g. `converge`) are also not present in the body subgraph — fall-through via graph-level `retry_target` triggers an "engine throws inside body → body returns failure → iterate restarts" cascade that costs one full iterate iteration per failure.

**Mechanical-gate retry routing inside the body** — every gate (`reports_to_v=mechanical.*`) routes back to the fix node that produces the code it measures:
```
// Backend gates fix through fix_backend, frontend gate through fix_frontend.
fix_backend  [class="impl", retry_target="fix_backend",  allow_multi_retry_target=true, ...]
fix_frontend [class="impl", retry_target="fix_frontend", ...]
run_build_api [retry_target="fix_backend", reports_to_v="mechanical.typecheck", ...]
run_tests_api [retry_target="fix_backend", reports_to_v="mechanical.boot",      ...]
run_lint      [retry_target="fix_backend", reports_to_v="mechanical.lint",      ...]   // 3rd ref — needs allow_multi_retry_target on fix_backend
run_build_ui  [retry_target="fix_frontend", reports_to_v="mechanical.build",    ...]
```

When you have ≥3 backend gates routing to a single backend fix node, set `allow_multi_retry_target=true` on the fix node (see "Recent Validator Changes" at the top of this file). When the gates legitimately span multiple code domains, split the fixer instead — the opt-in is for one-domain god nodes, NOT for cross-domain god nodes.

**Reachability edge from converge into the body** — the validator's reachability check needs an edge from outer-graph into the body cluster, otherwise body nodes look "unreachable from start". Use a conditional reachability edge from converge to the body's first node:
```
converge -> fix_backend [weight=1, condition="outcome=success"]   // reachability-only
converge -> fp_verify   [weight=2, condition="outcome=success"]   // real forward edge — higher weight wins on success
```
The condition on the reachability edge is **deliberate**: on a converge SUCCESS the higher-weight `fp_verify` edge wins; on a converge FAIL there's no matching edge and the engine falls through to graph-level `retry_target`. Without the condition, an unconditional reachability edge would route a failed iterate straight back into the body OUTSIDE the iterate-handler context, causing duplicate execution. The validator rule `iterate_edge_needs_outcome_condition` enforces the condition.

**Install-safety on bounce-target gates** — when a downstream gate (`repro_verify`) does `rm -rf node_modules` AND its fail edge routes back to an upstream gate (`fp_verify`), the upstream gate must run `npm install` first or the bounce will fail on missing dependencies and infinite-loop with the rule `goal_gate_needs_fix_loop` requiring the back-edge:
```
// fp_verify must be install-safe because repro_verify rm -rf's node_modules
// and the goal_gate_needs_fix_loop rule requires repro_verify -> fp_verify [fail]
fp_verify [
  shape=parallelogram,
  tool_command="set -o pipefail; cd ${WORKING_DIR} && npm install 2>&1 | tail -3 && cd packages/api && npx tsc --noEmit && npm test && cd ../ui && npx tsc --noEmit && echo 'fixed-point verified'",
  goal_gate=true,
  ...
]
```
The `npm install` is idempotent (no-op when deps are already hydrated) and cheap relative to the rest of the gate.

**32b. Iterate Body Prompt Discipline — Bootstrap Preservation** — when a fix node rewrites a NestJS `main.ts` (or any entry file with a top-level promise call), it must preserve the `.catch(...)` wrapper from the scaffold. Bare `bootstrap();` triggers `@typescript-eslint/no-floating-promises` and the lint gate fails deterministically.

```
// Scaffold writes:
bootstrap().catch((err) => { console.error('bootstrap failed', err); process.exit(1); });
// Fix node prompt MUST contain an explicit instruction to preserve this:
"main.ts bootstrap call MUST end with .catch — write it exactly as bootstrap().catch((err) => { ... });
 — never as a bare bootstrap(); call. The lint gate enforces @typescript-eslint/no-floating-promises
 and a bare bootstrap() will hard-fail it. If you rewrite main.ts to add a global exception filter,
 preserve the .catch wrapper."
```

Generalizes: any pattern the scaffold establishes that the fix node could plausibly erase needs an explicit preservation instruction in the fix node's prompt. The fix node has no memory of what scaffold did beyond what's in the workspace files.

**32c. Schema Auto-Sync vs Migration Gates** — TypeORM/Prisma/Drizzle ORMs have a `synchronize` (or equivalent) flag that auto-creates tables from entity definitions. This is unsafe in production but mandatory for benchmarks/dev/test if the pipeline has no migration node:

```
// Scaffold creates packages/api/src/app.module.ts with:
TypeOrmModule.forRoot({ type: 'sqlite', database: 'data/dev.db', autoLoadEntities: true, synchronize: true })

// Fix node prompt MUST allow synchronize:true OR you must add a migration node before the test gate:
"TypeOrmModule.forRoot: keep synchronize:true for the SQLite dev/test DB. The scaffold node configures
 it that way and the e2e suite relies on auto-schema. Do NOT change it to false — there is no migration
 node in this pipeline, so the tables would never exist at test boot time
 (SQLITE_ERROR: no such table: applications)."
```
The failure mode is dramatic: tests cannot boot because tables don't exist, the test gate fails deterministically, the iterate handler iterates without convergence, and the FailureSignatureTracker eventually aborts. If you DO want production-grade migrations in the pipeline, add an explicit `run_migrations` tool node between scaffold and the first test gate — don't let the fix node "fix" synchronize without that node existing.

## Superseded (reference only)

**5. Human Gates** — `hexagon` shape maps to `wait.human` which pauses the pipeline waiting for human input via the `/pipelines/:id/questions/:qid/answer` API. **Never emit for autonomous pipelines** — the pipeline will deadlock waiting for input that never arrives. Only relevant for interactive/supervised workflows (non-default).

**7. Review-Simplify Cycle** — superseded by Pattern 19 (ratchet). Standalone fallback only.

**12. Multi-Pass Complexity** — superseded by Pattern 18 (competing impls).

## Retry Target Scoping

**Precedence** (engine resolves in order):
1. Node-level `retry_target` (highest priority)
2. Node-level `fallback_retry_target` (if retry_target unreachable)
3. Graph-level `retry_target` (applied to all goal gates without node-level override)
4. Graph-level `fallback_retry_target` (final fallback)

**Rules:**
- **Graph-level `retry_target` MUST point to `fix_all`** — not setup_deps, not per-phase impl
- **Per-node `retry_target`** on every `goal_gate=true` node
- **Fan-out branches stay within scope** — retry only to nodes in the same component→tripleoctagon pair
- Use `fallback_retry_target` when a node should prefer a scoped retry but fall back to a wider scope if unreachable (e.g., per-phase impl → fix_all)

## Anti-Patterns (NEVER)

- Linear chains without feedback loops
- `goal_gate=true` without `retry_target`
- Graph-level `retry_target` to setup_deps/start/per-phase impl (full re-run or scoped-only retry)
- Fan-out `retry_target` outside branch scope (stripped at runtime — retry is ineffective)
- `retry_target` inside a fan-out branch pointing before the component node (causes infinite recursion without engine scoping, ineffective with it — retry logic belongs at fan-in or post-merge level)
- Hexagon nodes for claude-code backend (deadlock — `hexagon` = `wait.human` which pauses the pipeline waiting for human input via API; autonomous pipelines must never wait for humans)
- Diamond without 2+ edges (stalls)
- Parallel siblings depending on each other (deadlock)
- Lint/typecheck/test bundled into one gate
- Security scanning bundled with tests
- Conformance skipped
- Impl before spec tests on critical paths
- Codergen node without `allowed_paths` (unbounded file scope — validator rule 25 warns)
- Codergen node with explicit `permission_mode="plan"` in headless pipeline (deadlock — validator rule 24 warns)
- `allowed_paths` without test directories (agent can't write tests alongside impl)
- Merge/tripleoctagon node without timeout in review ratchet (process death = indefinite pipeline stall)
- Missing `spec_file` graph attribute
- Missing defense matrix comment block
- Single review pass as final gate (use ratchet)
- Ratchet fail routing to same pass (defeats consecutive enforcement)
- Standard impl→verify for metric optimization (use microverse — see detection criteria in pickle-dot.md Step 2)
- Microverse for binary targets like "tests must pass" (use standard impl→verify — microverse needs gradual convergence)
- acceptance_criteria keys without matching `context_on_success`
- verify_final `retry_target` to per-phase impl (can't fix cross-phase issues)
- Conformance and verify_final sharing the same fix node in multi-phase pipelines (max_visits collision — verify_final retries exhaust conformance visits)
- Missing fix_all before verify_final in multi-phase pipelines
- Impl node without progress gate (Pattern 0e — stalled impls waste entire retry budgets silently)
- Verify nodes assuming clean baseline (use Pattern 0c/0d — pre-existing errors cause infinite retry loops)
- Missing capture_baseline before first impl in isolated workspace pipelines
- `workspace="isolated"` without `commit_and_push` node after check_final success (all code lost on cleanup)
- `workspace_cleanup="delete"` without a tool node that runs `git push` (pipeline output destroyed)
- Manager node without `manager.stop_condition` (polls forever)
- Codergen node without `timeout` (unbounded LLM execution = unbounded cost)
- Prompt referencing files not in `allowed_paths` (wasted session — agent edits file, scope enforcement rejects it — validator rule 26 warns)
- Read-only codergen node without explicit `STATUS: SUCCESS` in prompt (no-op detection: claude-code backend returns RETRY when `editWriteCount === 0` and no STATUS marker — causes infinite retry loop for nodes that only read/analyze code)
- `goal_gate=true` with `retry_target` but no `max_visits` (validator rule 19 — infinite retry loop)
- Fan-out (`component`) without matching fan-in (`tripleoctagon`) (validator rule 20 — pipeline stalls)
- Fan-out branch `retry_target` pointing outside its `component→tripleoctagon` scope (validator rule 17 — stripped at runtime, retry is silently ineffective)
- `goal_gate=true` tool node with `verifies="a,b,c"` whose `tool_command` neither references any of the labels textually nor uses a blanket runner (validator rule `verifies_tool_command_references` — declaration drift, gate claims to check labels it doesn't actually check)
- Codergen `prompt` or `label` containing template placeholders like `errors.field_name`, `input.foo`, `{{field}}`, or `${template.var}` (validator rule `codergen_prompt_placeholder_smell` — unresolved template syntax the agent has no way to interpret)
- >4 reviewers per team
- Broad codergen prompt spanning 2+ layers or test categories on non-Opus models (use Pattern 31 decomposition)
- Multiple test nodes writing to the same file (each test node gets its own file)
- Node scope decomposition inside competing impl branches (Pattern 18 already provides redundancy)
- Tool node with `reports_to_v=...` and `retry_target=<self>` (validator rule `gate_self_retry_loop` ERROR — convergence gates cannot self-retry; deterministic failures loop until the FailureSignatureTracker aborts. Point at the fix node upstream, or omit retry_target so the iterate handler restarts the iteration.)
- Iterate body node with success-only outgoing edges, no node-level `retry_target`, AND graph-level `retry_target` not pointing at the iterate parent (validator rule `success_only_edge_without_retry` — body nodes are exempt ONLY when graph retry_target is the iterate parent, because the engine's body-runner cannot resolve nodes outside the body subgraph)
- Three-or-more gate nodes with node-level `retry_target` pointing at one codergen fix node WITHOUT `allow_multi_retry_target=true` on the target (validator rule `god_node_retry_target` ERROR — opt in via the attribute when the gates all measure ONE code domain; split the fixer when they don't)
- Fix node prompt that rewrites a NestJS `main.ts` (or any entry file with a top-level promise) WITHOUT explicit instruction to preserve the `.catch(...)` wrapper (lint gate `@typescript-eslint/no-floating-promises` hard-fails on bare `bootstrap();` — see Pattern 32b)
- TypeORM/Prisma `synchronize:false` (or equivalent auto-schema disable) WITHOUT a `run_migrations` tool node before the first test gate (tests boot against a database with no tables — `SQLITE_ERROR: no such table` — see Pattern 32c)
- Goal gate that downstream rm -rf's `node_modules` (e.g. `repro_verify`) with a fail edge routing back to a gate that doesn't run `npm install` first (the bounce target fails on missing dependencies and the `goal_gate_needs_fix_loop` rule still requires the back-edge — see Pattern 32a "install-safety on bounce-target gates")
- Codergen `prompt` containing words from 3+ verb clusters of `prompt_single_concern` (implement/test/document/deploy/analyze) — incidental words like "benchmark", "documented", "deploy(ment)" count even when the prompt's actual concern is just impl+test. Rephrase with neutral words.
- Iterate body with no in-body retry path on a deterministic failure node — the engine throws "Stage X failed with no outgoing edge" inside the body subgraph, body returns failure, and the iterate handler's failureReason now reads "executed but a node failed without a valid in-body retry path" (post-2026-04-14 message). Add either a node-level `retry_target` to a body node or a `condition="outcome=fail"` edge to a body node.

## Deliverables & Verifies Rules

Full reference for the compact block in `pickle-dot.md` Step 3L. Three related validator rules are enforced at validate time: `deliverables_coverage`, `verifies_tool_command_references`, and `codergen_prompt_placeholder_smell`. Together they require that every declared deliverable is checked by a gate whose `tool_command` actually references it (or implicitly covers it via a blanket runner), and that codegen prompts don't leak unresolved template syntax.

### Blanket runner allowlist

If a `goal_gate` tool node's `tool_command` contains any of these substrings (case-insensitive), `verifies_tool_command_references` treats it as implicit coverage for all labels in its `verifies=` attribute — no further label matching needed.

- **Test runners**: `npm test`, `npm run test`, `yarn test`, `pnpm test`, `bun test`, `jest`, `vitest`, `mocha`, `ava`, `tap ` (trailing space), `cargo test`, `go test`, `pytest`, `rspec`
- **Typecheckers**: `npx tsc`, `tsc --`, `tsc -p`, `bun tsc`, `bun run tsc`
- **Builders**: `next build`, `nest build`, `npm run build`, `yarn build`, `pnpm build`, `npx next build`, `npx nest build`
- **Integration runners**: `curl ` (with trailing space / tab / quote)

Runtime behaviors are verified by running tests, not by grepping source. Put test-verified deliverables on test-runner gates.

### Label matching (for non-blanket commands)

For each label in `verifies=`, the rule passes if ANY of:

1. **Substring**: the label appears verbatim (case-insensitive) in `tool_command`. Example: `verifies="inline_edit"` with `tool_command="... check $X 2 'inline_edit'"` → pass.
2. **Token match**: split the label on underscore, keep tokens of length ≥ 2, and require ALL of them to appear somewhere in the command. Example: `verifies="ui_types"` with `tool_command="... ls packages/ui/lib/types.ts"` → pass (both `ui` and `types` are present).

If neither holds, the gate fails with `verifies_tool_command_references`.

### The `check $X N 'label'` pattern (MANDATORY for multi-label check gates)

When a single gate verifies multiple deliverables via explicit shell checks (not a blanket runner), use a `check` function with the label verbatim as the third positional arg. Each label appears as a literal string, satisfying rule (1) above.

```
verify_spec [
  shape=parallelogram,
  verifies="pagination,form_field_highlighting,inline_edit",
  tool_command="cd ${WORKING_DIR} && check() { if [ \"$1\" -lt \"$2\" ]; then echo \"FAIL: $3 (got $1, need $2)\"; exit 1; fi; echo \"OK: $3\"; } && PAGIN=$(grep -c 'page' app/page.tsx) && check $PAGIN 1 'pagination' && ARIA=$(grep -c 'aria-invalid' app/apply/page.tsx) && check $ARIA 3 'form_field_highlighting' && INLINE=$(grep -c 'isEditing' app/detail.tsx) && check $INLINE 2 'inline_edit'",
  goal_gate=true
]
```

### GOOD / BAD examples

```
// GOOD — blanket runner implicitly verifies every label
run_api_tests [
  shape=parallelogram,
  verifies="crud_tests,validation_tests,status_tests,crud_operations,status_transitions",
  tool_command="cd ${WORKING_DIR} && npm test 2>&1",
  goal_gate=true
]

// GOOD — labels appear as check identifiers
verify_spec [
  shape=parallelogram,
  verifies="pagination,form_field_highlighting,inline_edit",
  tool_command="cd ${WORKING_DIR} && check() { ... } && ... && check $ARIA 3 'form_field_highlighting' && ...",
  goal_gate=true
]

// BAD — verifies claims crud_operations but command has no reference and no blanket runner
verify_type_safety [
  shape=parallelogram,
  verifies="crud_operations",
  tool_command="grep -rn 'as any' src/",
  goal_gate=true
]
// → rejected by verifies_tool_command_references
// Fix: move crud_operations to a gate running `npm test`, replace the command with an explicit check, or drop the label.
```

### Placement table

| Deliverable kind | Example labels | Gate type |
|---|---|---|
| Runtime behaviors | `crud_operations`, `status_transitions`, `auth_flow`, `error_recovery` | Test-runner gate (`npm test`, `pytest`, `go test`) |
| Type / lint / build invariants | `strict_types`, `no_any`, `no_console_errors` | Typechecker / linter / builder gate (`npx tsc`, `npx eslint`, `next build`) |
| File structure artifacts | `entity`, `dto`, `service_class`, `migration_file` | Grep / check-based gate that references files or class names by path/name |
| UI presence | `pagination`, `form_field_highlighting`, `inline_edit` | Grep-based gate using the `check $X N 'label'` pattern on component files |
| Integration endpoints | `health_endpoint`, `crud_endpoint` | `curl` gate hitting the endpoint, or test-runner gate |

### Prompt placeholder smells (`codergen_prompt_placeholder_smell`)

Never emit a `codergen` node's `prompt` or `label` containing unresolved template placeholders — dotted paths like `errors.field_name`, `input.foo`, moustache `{{field}}`, or `${template.var}` substitutions that weren't expanded at DOT-build time. The validator flags these as leftover template syntax the agent has no way to interpret.

```
// BAD — template placeholder
label="Display errors.field_name next to each invalid input"

// GOOD — concrete description
label="Display the validation message from the zod error schema next to each invalid input field"

// BAD — unresolved moustache
label="Fetch {{entity}} from the API and render"

// GOOD — names the actual entity
label="Fetch the loan application record from GET /applications/:id and render its fields"
```

The distinction: template placeholders reference variables the agent can't resolve at execution time. Concrete descriptions name the actual files, fields, and entities the agent can locate by reading the code.

## Model Routing

Two tiers: `${DEFAULT_MODEL}` (impl/tools) and `${REVIEW_MODEL}` (review/conformance/red-team).

```dot
// anthropic (default):
model_stylesheet = "* { llm_model: claude-sonnet-4-6; } .critical { llm_model: claude-opus-4-6; reasoning_effort: high; } .review { llm_model: claude-opus-4-6; }"
// single non-anthropic provider:
model_stylesheet = "* { llm_model: ${DEFAULT}; llm_provider: ${PROVIDER}; } .critical { llm_model: ${REVIEW}; reasoning_effort: high; } .review { llm_model: ${REVIEW}; }"
// mixed provider (e.g., --provider qwen --review-provider anthropic):
model_stylesheet = "* { llm_model: qwen-plus; llm_provider: qwen; } .critical { llm_model: claude-opus-4-6; llm_provider: anthropic; reasoning_effort: high; } .review { llm_model: claude-opus-4-6; llm_provider: anthropic; }"
```
When `--review-provider` differs from `--provider`, `.review`/`.critical` MUST include `llm_provider` to override `*`. Per-node `llm_model`/`llm_provider` attributes override stylesheet for edge cases.

> Future: `harness` property for per-node backend routing (PRD-v3 — not yet in schema).

Provider default table: see **pickle-dot.md Step 1** (single source of truth — do not duplicate here).

## Conditions Reference

`outcome=success`, `outcome=fail`, `outcome=partial_success`, `outcome=retry`, `outcome=skipped`, `context.KEY=VALUE`, combine with `&&`.

## Shapes Reference

Mdiamond=start, Msquare=exit, box=codergen, diamond=conditional, component=fan-out, tripleoctagon=fan-in, parallelogram=tool, house=manager_loop, hexagon=wait.human (deadlocks autonomous pipelines — see Superseded §5)

Permission modes: `bypassPermissions` (default), `plan`, `acceptEdits`, `auto`, `default`, `dontAsk`. **WARNING**: `plan` requires human approval for edits — NEVER use in headless/pipeline contexts. Validator rule 24 warns on explicit `plan` mode.

## Quick Reference (beyond what patterns already cover)

**Graph attributes** (emit in digraph header):
`working_dir`, `goal`, `label`, `acceptance_criteria`, `retry_target`, `fallback_retry_target`, `default_max_retry`, `default_fidelity`, `exit_validation`, `model_stylesheet`, `spec_file`, `workspace`, `repo_url`, `repo_branch`, `workspace_cleanup`, `llm_model`, `llm_provider`, `reasoning_effort`

**Common node attributes** (all node types):
`label`, `shape`, `goal_gate`, `retry_target`, `fallback_retry_target`, `max_retries` (retry count, distinct from `max_visits`), `max_visits`, `timeout`, `fidelity`, `llm_model`, `llm_provider`, `reasoning_effort`, `thread_id`, `class`, `auto_status`, `allow_partial`

**`auto_status`** — when `true`, the engine parses `STATUS: SUCCESS|FAIL|PARTIAL_SUCCESS|RETRY|SKIPPED` from the LLM's output text (case-insensitive, must be at start of line). Without this, the engine only uses exit code / tool results to determine outcome. Required on microverse `compare` nodes and any node that needs fine-grained outcome control.

**`allow_partial`** — when `true`, enables `outcome=partial_success` on outgoing diamond edges. Without this, `PARTIAL_SUCCESS` is treated as `FAIL`. Required on microverse `check_mv` diamonds.

**`fidelity`** — controls how much prior context the engine passes to each node. Graph-level `default_fidelity` sets the baseline; per-node `fidelity` overrides. Values: `"full"` (all prior context), `"truncate"` (recent only), `"compact"` (compressed), `"summary:low"` / `"summary:medium"` / `"summary:high"` (LLM-summarized at varying detail). Use `default_fidelity = "compact"` on large pipelines (>20 nodes / >3 phases) with `fidelity = "full"` on review/conformance/fix nodes that need complete context.

**`thread_id`** — groups conversational context in the engine. In multi-phase pipelines, all impl and fix nodes within the same phase should share a `thread_id` (e.g., `thread_id="phase_1"`). This preserves conversation continuity so phase 1's fix node knows what phase 1's impl node did. Different phases use different thread_ids.

**`timeout`** — MUST be set on all codergen (box) nodes. Prevents unbounded LLM execution. Recommended: `timeout="30m"` for impl nodes, `timeout="15m"` for review/fix nodes. Tool nodes should also have timeouts (e.g., `timeout="120s"` for builds).

**`read_only`** — when `true`, the claude-code backend skips no-op detection (0 Edit/Write calls = expected, not a stuck agent). Set on all review/analysis nodes that intentionally only read code. Defense-in-depth alongside STATUS markers.

**Codergen** (box): `prompt`, `read_only`, `attachments_context_key`, `working_dir` (claude-code), `permission_mode` (claude-code), `allowed_paths`, `escalate_on`

**Tool** (parallelogram): `tool_command`, `context_on_success`, `tool_hooks.pre`, `tool_hooks.post`

**Parallel** (component): `max_parallel`, `join_policy` (`wait_all`, `first_success`, `k_of_n`, `quorum`), `error_policy` (`continue`, `fail_fast`, `ignore`), `join_k`, `join_quorum`

**Fan-in** (tripleoctagon): `prompt`, `eval_criteria`, `eval_model`, `eval_threshold`, `eval_max_branches`

**Edge attributes**: `condition`, `label`, `weight`, `fidelity`, `loop_restart`

## Convergence Fields

PhaseSpec supports structured fields that parameterize gates for tighter convergence:

### requirements: string[]
Explicit list of verifiable requirements. When provided:
- Conformance gate enumerates all requirements in its label
- BDD gate verifies N scenarios (one per requirement)
- Spec gate verifies N acceptance criteria

Example:
```
{
  name: 'auth_service',
  prompt: 'Build JWT auth with refresh, revocation, and scope validation',
  requirements: ['JWT refresh endpoint', 'token revocation', 'scope validation'],
  allowedPaths: ['src/auth/'],
}
```

### testExpectations: { count: number; isolation: boolean }
- count: expected number of tests — drives max_visits computation (Math.max(3, Math.ceil(count/3)))
- isolation: when true, emits a gate that greps for beforeEach/afterEach in test files

### uiType: 'crud' | 'dashboard' | 'form' | 'wizard'
Auto-injects UI-specific requirements unless already present:
- crud: pagination, edit form, delete action, empty state
- dashboard: data loading, refresh, error state, responsive layout
- form: field validation, error display, submit handling, success feedback
- wizard: step navigation, step validation, progress indicator, completion state

### Diagnostic: MISSING_REQUIREMENTS
Warning emitted when a phase has 4+ allowed paths but no requirements array.

## DOT Schema

Full schema: `attractor/DOT_SCHEMA.md`. Key tool attribute: `context_on_success` (sets RunContext keys on exit 0).
