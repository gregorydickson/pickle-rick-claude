# PRD: Plumbus Generative Audit Frames

## Problem

The plumbus rubric (`.claude/commands/pickle-dot-patterns.md`) is purely **enumerative**. It lists ~140 named validator rules, ~50 anti-patterns, and ~30 named patterns; the worker scans the target `.dot` file for matches against this catalog. This works fine for failure modes someone has already tripped over and named — but it cannot, by construction, surface failure modes nobody has seen yet.

The rubric's growth pattern is reactive: each recent trap class was added only after it surfaced in review. The catalog then covers named instances of the class, not the class itself — a sibling instance with different node names walks straight past the scan. Trap classes the rubric has acquired this way (dates = when the corresponding defensive entry landed in `pickle-dot-patterns.md`, not necessarily a single production incident):

- **Silent-success trap on per-artifact gates** (documented 2026-04-17): a codergen returns success without writing its artifact; the gate's `context_on_success="artifact_X=seeded"` flag flips anyway; a downstream diamond reading that flag locks onto the patch branch (which correctly no-ops on empty pool); the gate fails forever. The `verify_gate_needs_both_context_paths` validator rule (added 2026-04-16) is one mechanical instance; the asymmetric-flag class is broader.
- **Contract-verify exit-code mismatch** (documented 2026-04-17): a routing-signal tool (writes `ATTRACTOR_CTX:<key>=...` on stdout, downstream diamond consumes the key) is wired with `retry_target`-on-nonzero-exit, so the routing path is unreachable exactly when the routing matters. The script's exit-code semantics and the DOT's interpretation disagree silently.
- **Diamond locked-on-patch when pool empty + artifact seeded** (documented 2026-04-17): two outgoing `condition=` edges are simultaneously satisfiable in the same context cell; engine picks the higher-weighted edge deterministically; the lower-weighted branch is latent but never fires. The cell `(artifact=seeded, pool=non-empty)` is a latent trap the author didn't realize was reachable.
- **Drift detection blindspot** (documented 2026-04-14, addressed by the `iterate_body_with_pool_needs_drift_detection` rule and schema attrs `max_drift_iterations` / `drift_tolerance`): pool growth outruns fix rate, V_total climbs silently while the fresh-regression gate accepts every iteration. Called out here for completeness — this class is outside generative-frame scope, it requires the schema additions already tracked in `pickle-dot-patterns.md`.

The first three classes share a shape: they are *structural* properties of the `.dot` graph (asymmetric writes, cartesian-product stuck cells, tool/graph contract mismatch) that a node-by-node scan against a named-rule catalog cannot see. The fourth is listed for honesty: it's a dynamics problem, not a structural one, and sits outside what frames can catch. We want generative concepts that can flag new instances of the first three classes *before* a specific instance has been catalogued.

## Root Causes

### 1. Catalog matching ≠ structural reasoning

The rubric tells the worker "look for X." It does not tell the worker "for every node, ask question Q and report what you find." The worker can only see what it's been told to see. New trap → new rule → ship the rule → wait for the next new trap.

### 2. Context-state coupling is invisible to a node-by-node scan

Most recent failures were **interactions between two nodes** mediated by a context key. `gate_X` writes `artifact_X=seeded` on success; `diamond_X` reads it for routing. The bug isn't in either node's attrs — it's in the missing cleanup edge. A scan that walks one node at a time can't catch this. You have to walk the (writer, reader) graph of every context key.

### 3. Convergence guarantees are not proved, just hoped for

Every cycle in a `.dot` graph is an implicit promise that "this loop terminates." The current rubric checks `max_visits` exists (a budget) but doesn't check that there's any *mechanism* by which the loop's predicate becomes satisfiable. A `fix_X → gate_X → fix_X` loop where `fix_X` has no `model_ladder`, no `__pool_findings__`, and no `__fix_attempt_history` will deterministically loop until the budget bounds it — the rubric calls this "convergent" because it has a budget, but it is not.

### 4. Tool nodes have semantics the DOT can't introspect

A tool's `tool_command` is opaque to the validator. Whether `bun verify-contract.ts` exits 1 on script crash vs script-found-violations vs script-clean is invisible to any pattern-match — you have to read the script and reason about its contract. The rubric currently delegates this to the human author and is silent when they get it wrong.

## Acceptance Criteria

### A1. New rubric section: `## Generative Audit Frames`

Plumbus rubric gains a new section (placed before `## Tier 1: Always Emit`) titled `## Generative Audit Frames`. Six frames documented as named procedures the worker MUST apply during the iteration-1 edge walk, in order, before scanning for named patterns:

1. Context Key Lifecycle Trace
2. Success/Failure Symmetry
3. Edge Condition Exhaustiveness
4. Tool Exit Code Semantics Audit
5. Loop Convergence Proof Obligation
6. Counterfactual Outcome Test

Each frame has: **Procedure** (numbered steps the worker follows), **Output** (specific findings format under a `## Generative Findings` section in `gap_analysis.md`), **Severity Mapping** (how findings translate to P0–P4), **Examples** (one positive, one negative).

**Example scripts must be empirically anchored.** *(refined: codebase, risk-scope)* The rubric's Frame 4 worked example must cite a script that actually exists in `packages/attractor/scripts/` and must report that script's true LOC / exit-call count. The current PRD draft cites a fabricated 510-LOC `verify-contract.ts`; the real file is 98 LOC. Accepted replacement: `verify-controller-routes.ts` (204 LOC, 4 exit call sites at lines 66/74/81/201) as the Mode-A-LOC-gate-tripping example. Because the real routing-signal cohort is small (`verify-contract.ts` 98 LOC, `verify-patches-landed.ts` 88 LOC, `verify-e2e-passes.ts` 62 LOC — all pass Mode A cleanly), any Mode-B pedagogical example MUST be a synthesized fixture DOT (see A11) labeled `(illustrative, not wired to any production script)`. No invented LOC counts, no fabricated call-site counts.

**Header casing canonicalized.** *(refined: requirements)* Frame headers emit as `### Frame N: <Title Case Frame Name>` — no square brackets in emitted markdown. The `### [Frame N: Frame Name]` bracketed form used in A4's body template is a template placeholder, not a literal.

### A2. Worker protocol update — Plumbus Override 6

`plumbus.md` Worker Mode gains a new override:

```markdown
### Override 6: Generative Audit Pass (iteration 1, after Edge Walk)

After completing the Edge Walk (Override 2) and BEFORE pattern catalog scan, apply the six Generative Audit Frames from `pickle-dot-patterns.md § Generative Audit Frames` in order. Write findings under a `## Generative Findings` section in `gap_analysis.md` (preserve across iterations like `## Edge Map`). Findings are folded into the P0–P4 priority queue using each frame's documented severity mapping.

Skip on subsequent iterations if `## Generative Findings` already exists in `gap_analysis.md` AND its `<!-- graph-fingerprint: <sha256> -->` comment matches the current graph's fingerprint AND its `<!-- generative-audit-complete: true -->` marker is present.
```

**Write discipline — matches Override 2's `## Edge Map` handling** *(refined: codebase)*: on first run, create the `## Generative Findings` section with a `<!-- graph-fingerprint: <sha256> -->` comment on the header line AND a `<!-- generative-audit-complete: false -->` marker written immediately on entry. On clean exit, update the completion marker to `true`. On subsequent runs: if the fingerprint matches AND completion=true → SKIP. If the fingerprint differs, MERGE — preserve findings whose cited `nodeId` / `key` still exists in the graph; drop findings whose cited ids are gone (renamed/removed nodes); append new findings for nodes added since the previous run. NEVER overwrite the entire section — an iteration-2 bug that blows away iteration-1 findings loses the priority-queue state the worker has been acting on. (`plumbus.md:270` Override 2 step 4 establishes the verbatim contract: "create if missing; prepend if existing — do NOT overwrite.")

**Iteration-N ordering invariant** *(refined: requirements)*: when subsequent iterations DO run Override 6 (fingerprint mismatch), it runs in the SAME position relative to the iteration's Edge Walk and pattern scan as on iteration 1 — after Edge Walk, before pattern scan. An `## Generative Findings` section emitted from iteration N has the same file-structure position as one from iteration 1.

### A2.5. Kill-switch: PLUMBUS_GENERATIVE_AUDIT *(refined: requirements, risk-scope)*

When the environment variable `PLUMBUS_GENERATIVE_AUDIT=off` is set (or the worker is invoked with `--no-generative`), Override 6 is SKIPPED ENTIRELY: the worker proceeds directly from the Edge Walk to the pattern catalog scan, no companion script is invoked, no `## Generative Findings` section is written or read. This is explicitly a full bypass, not a partial suppression. The worker logs a single line to `state.json.activity` recording the skip (e.g. `"generative_audit: skipped (kill-switch)"`) so downstream audits can detect kill-switch use. The env var name `PLUMBUS_GENERATIVE_AUDIT` is documented in `CLAUDE.md`'s pickle-rick project section alongside existing `PLUMBUS_*` conventions.

### A3. Companion analysis script

A new mechanical companion script ships with the extension, following the existing `extension/src/*.ts` → compiled `extension/bin/*.js` convention (install.sh's rsync step excludes `src/`, so only the compiled JS is deployed).

- **Source**: `extension/src/plumbus-frame-analyzer.ts` *(refined: codebase — keep path under `extension/src/`, compiled output in `extension/bin/`. Prior drafts cited `extension/src/bin/…` which is not a real path in this tree.)*
- **Compiled output**: `extension/bin/plumbus-frame-analyzer.js`
- **Install.sh**: must add `chmod +x "$EXTENSION_ROOT/extension/bin/plumbus-frame-analyzer.js"` alongside the other bin entries.
- **Runtime**: `node` for the analyzer process itself (the extension's deployed tree is Node-only). BUT the analyzer shells out to `bun` to invoke a sibling helper in the attractor repo for DOT parsing — see below. *(refined: codebase, risk-scope)*

**Runtime strategy — bun shellout** *(refined: codebase P0 #2, risk-scope R0/R15)*: the attractor parser (`packages/attractor/src/parser.ts`) uses bun-specific `.ts` import specifiers and is NOT executable by Node via dynamic `import()`. A naive `import()` from the analyzer deadlocks at parse time. The accepted runtime strategy:

1. A sibling attractor PR ships `packages/attractor/scripts/dump-graph.ts` (≤30 LOC) — a thin wrapper that imports the parser's `parse()` function and writes the resulting `Graph` JSON to stdout.
2. The extension analyzer invokes `bun packages/attractor/scripts/dump-graph.ts <target.dot>` via `spawnSync`, captures JSON stdout, then runs its deterministic analyses on that JSON.
3. If `bun --version` fails OR `dump-graph.ts` is not present OR `dump-graph.ts` exits non-zero OR its stdout is not valid JSON OR the JSON is missing required top-level keys: the analyzer exits 2, prints a single-line diagnostic to stderr, and the worker tags all Frame 1/3/5 findings as `analysis_mode: llm-only` + runs the A7 verification pass.

**Attractor discovery target** *(refined: codebase)*: discovery uses the three-step pattern from `plumbus.md:49-52` (`$ATTRACTOR_ROOT` env var → `../attractor/` relative → `find ~/loanlight -maxdepth 2` wildcard), probing for `packages/attractor/src/cli.ts` (proven-working check, mirrors plumbus's validator discovery). The analyzer then invokes `bun $ATTRACTOR_ROOT/packages/attractor/scripts/dump-graph.ts <target>`.

**Vendoring parser is rejected** *(refined: risk-scope R15)*: vendoring ~570 LOC of parser in the extension duplicates logic, invites drift, and doubles the registry/analyzer contract surface.

**Node-version floor** *(refined: codebase P1)*: analyzer code targets `engines.node: ">=20.0.0"` per `extension/package.json:6`. Do NOT use Node 21+ APIs (`Promise.withResolvers`, `ReadableStream.from`, `structuredClone` overrides). Tarjan's SCC can be hand-rolled with 2015-era JS.

**`${EXTENSION_ROOT}` substitution** *(refined: codebase)*: the worker substitutes `${EXTENSION_ROOT}` → `$HOME/.claude/pickle-rick` before the analyzer command runs, matching the substitution convention already used for `${ATTRACTOR_ROOT}` and `${TARGET}` in existing plumbus overrides (see `plumbus.md:49-57`).

**Output schema** (closed set — additional top-level keys are a contract violation):
```json
{
  "context_keys": [{ "key": "artifact_api_controller", "writers": [...], "readers": [...] }],
  "diamond_routing": [{ "diamond": "diamond_api_controller_mode", "covered_states": [...], "stuck_states": [...] }],
  "cycles": [{ "scc_nodes": [...], "convergence_signal": "iterate" | "model_ladder" | "fix_attempt_history" | null }]
}
```

**Analyzer output contract test** *(refined: risk-scope R0)*: a dedicated contract test asserts the analyzer's JSON shape against a pinned fixture of `dump-graph.ts`'s output. If attractor's `dump-graph.ts` changes its JSON contract, this test fails loudly instead of the analyzer silently breaking in the field.

### A4. Findings format consistency

Every Generative Audit Frame finding carries structured tags plus the standard body:

- **`analysis_mode: mechanical | llm-assisted | llm-only`** — how the finding was produced, **computed per finding keyed off the specific graph element** *(refined: requirements, codebase)*:
  - Frame 1/2 findings about key K: `mechanical` iff the companion-script `context_keys` array contains a row for K with non-empty writers/readers AND the LLM applied no severity judgment beyond the frame's Severity Mapping; `llm-assisted` iff the row exists and the LLM applied judgment; `llm-only` iff the row is absent or empty (script did not cover this key).
  - Frame 3 findings about diamond D: same rule, keyed on `diamond_routing[D]` row presence.
  - Frame 5 findings about SCC S: same rule, keyed on `cycles[S]` row presence.
  - Frames 4 and 6 are ALWAYS `llm-only` by design.

  This per-element computation closes the partial-coverage carve-out: A7 verification runs even when the companion script is overall-successful but failed to cover a specific element. The enum is **closed** — a finding tagged with a fourth value fails parse.

- **Three severity fields** *(refined: requirements P0, risk-scope R9)*:
  - `pre_verification_severity` — the frame's raw verdict from its Severity Mapping section. Independent of `analysis_mode`. Recorded once per finding; never modified after emission.
  - `post_verification_severity` — post-A7-verification severity. Equals `pre_verification_severity` unless A7 verification disagreed, in which case equals P3. The worker's priority queue consumes `post_verification_severity`.
  - `rendered_severity` — the severity displayed in emitted markdown: equals `pre_verification_severity` at the raw-finding bullet level (`- **[priority]**`) and equals `post_verification_severity` (max-by-impact across cluster members) in the cluster header's `**Cluster severity:**` line. A reader who sees a raw finding at P0 with post_verification_severity P3 can cross-reference the `### Verification disagreement` block.

  Max-by-impact ordering is pinned: `P0 > P1 > P2 > P3 > P4` (lower integer = higher severity). `max(P0, P1) = P0`.

- **`confidence: HIGH | MEDIUM | LOW`** — Frame-4-specific, omitted for other frames. Reflects which of Frame 4's three analysis modes the worker was able to execute (see Frame 4 procedure below). Severity is independent of `confidence:` — low confidence means "verify before acting," not "downgrade the bug."

- **`cluster_key`** — a tuple declared per frame (A5) that identifies which findings describe the same underlying defect.

- **`finding_subclass`** — Frame-1-specific, records which of the four Frame 1 classes fired: `orphan_reader | orphan_writer | asymmetric_writer | multi_writer_conflict`. *(refined: codebase P1, risk-scope R16)* A single `(node, key)` pair may satisfy multiple classes; Frame 1 emits ONE finding per `(node, key)` with the highest-severity class label per the precedence `asymmetric_writer > multi_writer_conflict > orphan_reader > orphan_writer`.

Raw finding body (one per finding, pre-cluster):

```markdown
### Frame N: Frame Name
- **[pre_verification_severity]** `nodeId(s)` — frame-specific finding statement.
  - **Analysis mode**: mechanical | llm-assisted | llm-only
  - **Confidence**: HIGH | MEDIUM | LOW  *(Frame 4 only)*
  - **Finding subclass**: orphan_reader | orphan_writer | asymmetric_writer | multi_writer_conflict  *(Frame 1 only)*
  - **Cluster key**: `<frame-declared tuple>`
  - **pre_verification_severity**: Pn
  - **post_verification_severity**: Pn  *(equals pre_ unless A7 disagreed)*
  - **Trace**: <which keys/edges/states triggered this>
  - **Risk**: <what could go wrong if unfixed>
  - **Suggested fix**: <surgical proposed edit>
```

### A5. Finding clusters

Raw findings with matching `cluster_key` collapse into one bullet in `gap_analysis.md` under a `### Multi-frame finding: <cluster_key>` header. Each frame's lens appears as a sub-bullet. Cluster severity = `max(member post_verification_severity)` under the P0>P1>P2>P3>P4 ordering. The worker's priority queue references **clusters**, not raw findings — fix once, all lenses clear on re-walk.

**Solo-finding emission** *(refined: requirements P0)*: a raw finding whose `cluster_key` matches no other finding is emitted WITHOUT the `### Multi-frame finding:` wrapper — it appears as a plain `### Frame N: <Frame Name>` bullet. The worker's priority queue treats this bullet as if it were a single-member cluster with `cluster post_verification_severity = finding.post_verification_severity`. The cluster wrapper is ONLY emitted when ≥2 raw findings share a cluster_key.

**Intra-frame cluster disambiguation** *(refined: requirements P1, risk-scope R16)*: the effective cluster_key used for collapse is `(frame_id, finding_subclass, tuple)`, not `tuple` alone. This prevents the edge case where a single `(node, key)` legitimately triggers both an orphan-reader and a writer finding in Frame 1 — they would string-match as the same tuple but describe different defect classes. Cross-frame collapse continues to use `tuple` alone (Frame 1's asymmetric_writer and Frame 2's symmetry finding on the same `(node, key)` do cluster).

Per-frame `cluster_key` shapes:
- Frame 1: `(reader_node, key)` for orphan-reader findings; `(node, key)` for writer findings (asymmetric / orphan-writer / multi-writer-conflict)
- Frame 2: `(node, key)`
- Frame 3: `(diamond_node, cell_signature)` where `cell_signature` = stable hash of the cartesian cell's key-value pairs sorted by key name (deterministic across runs)
- Frame 4: `(tool_node)`
- Frame 5: `(scc_representative_node)` = lowest-ID node in the SCC
- Frame 6: `(node, artifact_path)` — rarely clusters with 1/2

**Cluster fix-selection precedence** *(refined: requirements P0 #6, risk-scope R16)*:

| Frame combination | Winning fix | Rationale |
|---|---|---|
| F1 only | Frame 1's writer/reader edit | — |
| F2 only | Frame 2's symmetry edit | — |
| F3 only (stuck cell) | Frame 3's cartesian-cell fix | — |
| F4 only | Frame 4's tool-wiring fix | — |
| F5 only | Frame 5's convergence-signal add | — |
| F6 only | Frame 6's direct-guard add | — |
| F1 + F2 | Frame 2's symmetry edit | Symmetry subsumes F1's orphan-reader fix |
| F1 + F2 + F6 | Frame 2's symmetry edit | As above; F6's direct-guard may be redundant |
| F2 + F4 | Frame 4's tool-wiring fix | Tool contract ambiguity causes the symmetry gap |
| F1 + F3 | Frame 3's cartesian-cell fix | Stuck cell is the observable; F1 is upstream |
| F3 + F5 | Frame 5's convergence-signal add | Plateau loop produces stuck cells; convergence is root |
| Any other combination | Highest-severity member's fix, with `### Cluster fix-selection warning` comment | Fail-soft to preserve the signal without silent misrouting |

Concrete rollup:

```markdown
### Multi-frame finding: gate_controller_routes / artifact_api_controller
- **[F1: P0, mechanical, subclass=asymmetric_writer]** Asymmetric writer — only success path writes `artifact_api_controller=seeded`.
- **[F2: P0, llm-assisted]** Missing `context_on_failure` paired with `context_on_success` on the seed.
- **[F6: P1, llm-only]** Seed relies on downstream gate as ONLY counterfactual guard.
- **Cluster severity**: P0
- **Suggested fix (root cause)**: Add `context_on_failure="artifact_api_controller=seed_failed"` to `gate_controller_routes`.  *(selected per F1+F2+F6 rule)*
```

No severity promotion for cluster size — max-severity carries the weight, and inflating on cluster cardinality would re-introduce the noise-inflation problem dedup is meant to kill.

### A6. Engine-injected key registry

A new static data file `extension/data/engine-injected-keys.json` enumerates context keys the attractor engine writes (or the iterate/tool handlers write) without the author declaring `context_on_success` / `context_on_failure`. Frame 1 loads the registry and classifies any matching key as engine-written, suppressing false-positive "orphan writer" findings.

**Deployment-location rationale** *(refined: codebase P0)*: `extension/data/` is a new top-level subdirectory under `extension/` (joining `bin/`, `src/`, `tests/`, `hooks/`, `scripts/`, `services/`, `layouts/`, `types/`, `eslint-plugin-pickle/`). Use for read-only static JSON consumed by analyzers at runtime. Future static data (severity tables, auto-pattern rules, etc.) also lands here. The existing `rsync -a --delete --delete-excluded` at `install.sh:55-61` deploys it automatically — **no install.sh change is required for A6's file deployment**. No `chmod +x` needed (JSON is not executable); adding one would be confusing and wrong. `CLAUDE.md`'s pickle-rick project section gains a one-liner documenting that analyzer-consumed static JSON lives under `extension/data/`.

**Registry schema — versioned** *(refined: requirements P1, risk-scope R2)*:

```json
{
  "schema_version": 1,
  "engine_keys": ["outcome", "current_node", "workspace.path", "runId", "graph.goal", "tool.output"],
  "engine_key_patterns": [
    "pool_count_reviewer_*",
    "__last_failure_*",
    "__pool_findings__",
    "__fix_attempt_history",
    "__ladder_position.*"
  ],
  "user_written_patterns": [
    "artifact_*"
  ]
}
```

Loaders (analyzer + worker) MUST read `schema_version` and reject incompatible versions with a clear error rather than silently mis-parsing.

The `user_written_patterns` section is important: `artifact_*` keys are *not* engine-written — they follow an author convention (`context_on_success="artifact_X=seeded"`). Frame 1/2 MUST check user-written symmetry on these. The registry distinguishes user-written-by-convention from engine-written-by-handler so the symmetry check fires on the first class and stays silent on the second.

**Registry DRI** *(refined: risk-scope R2)*: a named GitHub handle (not a role) owns `engine-injected-keys.json`. A contract test walks attractor source for literal `context_on_*=`/`ATTRACTOR_CTX:` writes and asserts that every discovered key matches either `engine_keys` (literal) or `engine_key_patterns` (glob) or `user_written_patterns` (user-convention). Drift = test fail. The DRI handle is selected at PR review time and recorded in the PR description.

Deployed location: `~/.claude/pickle-rick/extension/data/engine-injected-keys.json`. Both `plumbus-frame-analyzer.js` (mechanical Frame 1 path) and the plumbus worker (LLM-only Frame 1 path) read from this file so the classification is consistent across analysis modes.

### A7. Worker verification protocol for `llm-only` findings

When a finding's `analysis_mode` is `llm-only`, the worker runs a verification pass before queueing it for fix:

1. **Frame 1 / 2 llm-only**: re-derive the writer/reader set for just the key named in the finding by grepping `context_on_success`, `context_on_failure`, and `condition="context.<key>..."` across all nodes. Confirm the asymmetry/orphan holds.
2. **Frame 3 llm-only**: re-enumerate the cartesian product for just the one diamond named in the finding; confirm the cited stuck/nondeterministic cell holds.
3. **Frame 5 llm-only**: re-walk just the one SCC named in the finding; confirm no member has any recognized convergence signal from the registry.

**Verification comparison is structural, not textual** *(refined: requirements P0)*. The re-derived writer set, reader set, cartesian-cell set, or SCC membership is compared against the original finding's recorded set using sorted-set equality:

```
JSON.stringify([...verification_result].sort()) === JSON.stringify([...original.members].sort())
```

String-literal or order-sensitive comparison is FORBIDDEN. The original finding MUST record its set in the same sorted-list form for this comparison to be well-defined. Two runs of A7 against the same DOT against the same llm-only finding MUST produce identical verdicts.

If verification confirms → set `post_verification_severity = pre_verification_severity`. If verification disagrees → set `post_verification_severity = P3` and write a `### Verification disagreement` block in `gap_analysis.md` recording both the original finding and the verification result. This adds one targeted re-check per llm-only finding but prevents blanket confidence loss across the audit pass.

**`llm-assisted` coverage** *(refined: requirements, risk-scope R13)*: `llm-assisted` findings are NOT verified by A7. This is an explicit accepted tradeoff — a finding where the JSON substrate was present and the LLM made a judgment on top of it has a narrower attack surface than a `llm-only` finding. The operational definition (per-element `analysis_mode` computation in A4) ensures that findings whose specific graph element is absent from the JSON get tagged `llm-only` and go through A7.

Frames 4 and 6 are LLM-only by design (no companion-script mechanical path exists); their verification is the built-in procedure's guardrails (Frame 4's Mode A/B/C gate inside the Frame 4 procedure, Frame 6's direct-vs-transitive-guard heuristic), not an extra A7 pass.

### A8. Validator rule promotion path

When a Generative Audit Frame produces the same finding pattern across ≥3 distinct `.dot` files, that pattern is a candidate for promotion to a named validator rule. The PRD does NOT auto-promote (out of scope) but the rubric documents the path: "If you see this finding repeatedly across pipelines, file an issue suggesting a new validator rule with the documented finding template."

### A9. Test registration & hygiene gate *(refined: requirements, codebase, risk-scope R1)*

**Problem context**: `extension/package.json:13` is a hand-maintained `node --test` invocation with ~60 explicit file paths and no glob pattern. Running `ls extension/tests/*.test.js` vs `jq -r '.scripts.test' package.json` today shows **seven** test files on disk that are NOT registered (`complexity-tier.test.js`, `config-protection.test.js`, `dot-builder-bdd.test.js`, `dot-builder-type-contracts.test.js`, `feature-flags.test.js`, `init-microverse.test.js`, `task-notes-truncation.test.js`) — an 11% silent-skip rate on the extant codebase. A new `plumbus-frame-analyzer.test.js` joins that cohort by default, which would invalidate every `type: test` AC row in this PRD.

**Required gates**:

1. `tests/plumbus-frame-analyzer.test.js` MUST be registered in `extension/package.json`'s `test` script.
2. The test MUST actually run and emit TAP pass lines (a registered-but-empty test file must not silently pass).
3. A hygiene gate ships in this PRD that asserts NO test file under `extension/tests/` is silently unregistered. This closes the currently-broken 11%-silent-skip backlog permanently.

### A10. Crash-recovery and partial-run handling *(refined: requirements P1)*

**CUJ-4 (analyzer crashes mid-run)**: when the companion analyzer crashes (unhandled exception, OOM, SIGKILL) or exceeds the Frame 5 wall-time budget (see R5), the worker MUST:

1. Abort Override 6's mechanical path.
2. Tag every Frame 1/3/5 finding for the remainder of this iteration as `analysis_mode: llm-only`.
3. Run A7 verification on those findings.
4. Write the `## Generative Findings` section with `<!-- generative-audit-complete: false -->` set.
5. Log `"generative_audit: degraded (analyzer_crash)"` to `state.json.activity`.

**CUJ-5 (re-run after partial previous run)**: the skip-logic in A2 requires BOTH a fingerprint match AND `generative-audit-complete: true`. A section with `completion: false` MUST be treated as stale and re-audited on the next iteration — a partial run never becomes permanent.

**CUJ-6 (bun unavailable on PATH)** *(refined: codebase, risk-scope R15)*: when `bun --version` fails at analyzer startup, the analyzer exits 2 with a single-line stderr diagnostic. The worker caps `pre_verification_severity` at P2 for Frame 1/3/5 findings (derived via llm-only), runs A7 unconditionally, and ensures `post_verification_severity ∈ {P2, P3}` (never P0 or P1 from this path). Install-time warning in `install.sh` elevates to an explicit banner: "Plumbus generative audit is running in degraded mode. Install bun for full analysis."

### A11. Calibration fixture set *(refined: requirements, codebase, risk-scope R6/R7)*

A calibration fixture set ships in `extension/tests/__fixtures__/plumbus-frames/` (double-underscore `__fixtures__` is the codebase convention; `extension/tests/dot-builder-bdd.test.js:768` confirms the access pattern is `path.join(__dirname, '__fixtures__')`).

Required fixtures (minimum six):

- `frame1-asymmetric-writer.dot` + `frame1-asymmetric-writer.golden.json`
- `frame1-orphan-reader.dot` + golden
- `frame2-symmetry-gap.dot` + golden
- `frame3-stuck-cell.dot` + golden
- `frame3-nondeterministic-cell.dot` + golden
- `frame5-no-convergence-signal.dot` + golden
- `frame4-mode-b.dot` — synthesized fixture with `tool_command` containing `ATTRACTOR_CTX:category=...` hints, labeled `(illustrative, not wired to any production script)` to exercise Mode B's hint-based path
- `frame4-mode-a.dot` — pointing at the real `verify-controller-routes.ts` for the Mode-A-LOC-gate-tripping example

**Pass/fail criterion** *(refined: requirements)*: on each of the above fixtures, Frames 1/2/3/5 MUST produce EXACTLY the findings listed in the corresponding `.golden.json` (zero false positives, zero false negatives — exact match). Enum-closure on `analysis_mode` is also asserted.

**Production-pipeline baseline** *(refined: risk-scope R7)*: a CI step walks every shipped attractor pipeline `.dot` file and runs the analyzer. Frame 5 (the noisiest LLM-only per Risk-Scope analysis) MUST produce ZERO P0 findings against currently-green pipelines (no false-positive P0 storm). P1/P2 findings are advisory in this gate. If a currently-green pipeline produces a new P0 on first install, the PR fails.

### A12. Graph fingerprint algorithm & storage *(refined: requirements P0, codebase P0, risk-scope R8)*

**Algorithm**: `sha256(JSON.stringify({nodes: sortedNodeIds, edges: sortedEdgeTripleList, edgeAttrs: sortedEdgeAttributeMap}))`. Including sorted edge attributes is deliberate: attr-only edits (condition, weight, tool_command changes) MUST force re-audit — they are exactly the class of edit Frame 3 is designed to catch. *(conflict: requirements C2's fingerprint algorithm excluded edge attributes; risk-scope R8 argued for inclusion; adopting the stricter inclusion.)*

**Storage — exclusive** *(refined: codebase, requirements)*: the fingerprint is persisted ONLY in `gap_analysis.md` via the header comment `<!-- graph-fingerprint: <sha256> -->`. It is NEVER cached in the deployed extension tree. `install.sh:55-61`'s `rsync --delete-excluded` would wipe any cache stored there, re-triggering full audits on every reinstall — a silent fragility class we explicitly forbid.

**Parser regex**: the comment-extraction parser matches exactly `^<!-- graph-fingerprint: ([a-f0-9]{64}) -->$` — no leading whitespace tolerance, no alternative field order. A second comment pattern `^<!-- generative-audit-complete: (true|false) -->$` tracks completion.

## Verification Strategy

Machine-checkable verification per acceptance criterion. Each row is a single runnable check; "Type" classifies the check for the worker's conformance matrix.

| AC | Check | Command / Assertion | Type |
|---|---|---|---|
| A1 | Rubric has six named frames under `## Generative Audit Frames` | `grep -c '^### Frame [1-6]:' .claude/commands/pickle-dot-patterns.md` returns `6` | lint |
| A1 | Section placed before `## Tier 1: Always Emit` | `awk '/^## Tier 1: Always Emit/{t=NR} /^## Generative Audit Frames/{g=NR} END{exit !(g>0 && t>0 && g<t)}' .claude/commands/pickle-dot-patterns.md` exits 0 | lint |
| A1 | Frame 4 worked example cites a real script at its true LOC | `wc -l packages/attractor/scripts/verify-controller-routes.ts` matches the LOC count stated in the rubric body within ±2 *(refined: codebase, risk-scope)* | lint |
| A1 | Frame headers render as `### Frame N: <Title Case Name>` with no square brackets *(refined: requirements)* | `grep -E '^### \[Frame' .claude/commands/pickle-dot-patterns.md` returns no matches | lint |
| A2 | Plumbus worker has Override 6 | `grep -c '^### Override 6: Generative Audit Pass' .claude/commands/plumbus.md` returns ≥ 1 | lint |
| A2 | Override 6 references the rubric section | Plumbus Override 6 body contains the string `pickle-dot-patterns.md § Generative Audit Frames` | lint |
| A2 | Override 6 merge contract documented *(refined: codebase)* | Plumbus Override 6 body contains `MERGE` AND `create if missing; prepend if existing` | lint |
| A2 | Merge behavior verified | Fixture test: run Override 6 against DOT-v1, then DOT-v2 (adds nodes but preserves nodes from v1). Assert findings from v1 that still apply appear in merged section AND new findings from v2's nodes are appended. *(refined: codebase)* | test |
| A2 | Fingerprint is persisted ONLY in gap_analysis.md, never in the deployed extension tree *(refined: codebase, requirements)* | Test: after Override 6 runs, assert `grep -c '<!-- graph-fingerprint:' ${SESSION_ROOT}/gap_analysis.md` ≥ 1 AND `find ~/.claude/pickle-rick/extension -name '*fingerprint*'` returns zero results. | integration |
| A2 | Fingerprint comment regex pins exactly *(refined: requirements)* | Parser regex literal is `^<!-- graph-fingerprint: ([a-f0-9]{64}) -->$` — enforced via unit test with edge-case inputs (leading whitespace, alternative casing, missing hex chars). | test |
| A2 | Partial runs re-trigger on next iteration *(refined: requirements)* | Fixture test: simulate a crashed Override 6 (partial findings, `completion=false`). Re-run worker. Assert Override 6 re-executes (not skipped). | test |
| A2 | Iteration-N ordering invariant *(refined: requirements)* | Fixture test: run iteration 1, modify graph, run iteration 2. Assert `## Generative Findings` section in iteration 2's `gap_analysis.md` appears AFTER `## Edge Map` and BEFORE pattern-scan results, matching iteration 1's position. | test |
| A2.5 | Kill-switch bypasses Override 6 entirely *(refined: requirements, risk-scope)* | Fixture test: run plumbus with `PLUMBUS_GENERATIVE_AUDIT=off`. Assert (a) no process named plumbus-frame-analyzer appears in the process tree, (b) no `## Generative Findings` header is written, (c) state.json.activity contains a `"generative_audit: skipped (kill-switch)"` entry. | integration |
| A2.5 | Kill-switch documented in CLAUDE.md *(refined: risk-scope)* | `grep -c 'PLUMBUS_GENERATIVE_AUDIT' CLAUDE.md` returns ≥ 1 | lint |
| A3 | Companion script source exists and compiles | `test -f extension/src/plumbus-frame-analyzer.ts && npx tsc --noEmit` passes | typecheck |
| A3 | Compiled JS is deployed to `extension/bin/` after `bash install.sh` | `test -x ~/.claude/pickle-rick/extension/bin/plumbus-frame-analyzer.js` | integration |
| A3 | Script produces the documented JSON schema | `node extension/bin/plumbus-frame-analyzer.js tests/__fixtures__/plumbus-frames/frame1-asymmetric-writer.dot \| jq 'has("context_keys") and has("diamond_routing") and has("cycles")'` returns `true` | test |
| A3 | Schema is CLOSED (no extra top-level keys) *(refined: codebase)* | `node extension/bin/plumbus-frame-analyzer.js <fixture> \| jq 'keys \| length == 3'` returns `true` | test |
| A3 | Schema is validated by a test | `node --test extension/tests/plumbus-frame-analyzer.test.js` passes with ≥ 1 test asserting each top-level key | test |
| A3 | Bun-shellout path used (no Node `import()` of attractor parser) *(refined: codebase, risk-scope)* | `grep -c 'spawnSync.*bun' extension/src/plumbus-frame-analyzer.ts` returns ≥ 1 AND `grep -c "import(" extension/src/plumbus-frame-analyzer.ts \| grep 'attractor'` returns 0 | lint |
| A3 | Analyzer exits 2 and emits llm-only fallback when bun is unavailable *(refined: risk-scope)* | Fixture test: invoke analyzer with `PATH` stripped of bun. Assert exit code 2, stderr diagnostic present, worker's resulting `gap_analysis.md` tags Frame 1/3/5 findings as `analysis_mode: llm-only`. | test |
| A3 | Analyzer-output contract test against pinned dump-graph.ts JSON *(refined: risk-scope R0)* | `node --test extension/tests/plumbus-frame-analyzer-contract.test.js` passes; the test feeds a pinned fixture of `dump-graph.ts` output and asserts analyzer produces expected JSON shape. | test |
| A3 | Node 20 API floor respected *(refined: codebase)* | Test: `grep -E '(Promise\.withResolvers\|ReadableStream\.from)' extension/src/plumbus-frame-analyzer.ts` returns no matches | lint |
| A4 | Every raw finding carries the required tags | Test parses a sample `gap_analysis.md` generated by a fixture run and asserts every finding bullet contains `Analysis mode:`, `Cluster key:`, `pre_verification_severity:`, `post_verification_severity:`; Frame 4 findings additionally contain `Confidence:`; Frame 1 findings additionally contain `Finding subclass:` | test |
| A4 | `analysis_mode` enum is closed *(refined: requirements, risk-scope)* | Fixture with a finding tagged `Analysis mode: foo` fails parse with a clear error | test |
| A4 | `analysis_mode` is computed per-element, not per-frame *(refined: requirements)* | Fixture test: analyzer JSON includes context_keys for K1 but not K2 (same Frame 1). Assert finding about K1 tags `mechanical`/`llm-assisted`; finding about K2 tags `llm-only` + triggers A7 | test |
| A4 | Three-severity model is rendered correctly *(refined: requirements, risk-scope)* | Fixture test: llm-only P0 finding with verification disagreement → assert raw bullet renders `- **[P0]**` (pre_), cluster header renders `**Cluster severity:** P3` (max of post_), queue consumer sees P3. | test |
| A4 | Max-by-impact severity ordering *(refined: requirements)* | Unit test: `maxSeverity(['P0', 'P1']) === 'P0'`, `maxSeverity(['P3', 'P1', 'P4']) === 'P1'` | test |
| A4 | `## Generative Findings` emitted as H2 *(refined: requirements)* | `grep -c '^## Generative Findings' ${SESSION_ROOT}/gap_analysis.md` ≥ 1 AND `grep -c '^### Generative Findings\|^#### Generative Findings' ${SESSION_ROOT}/gap_analysis.md` equals 0 | lint |
| A5 | Clustering collapses co-firing findings | Fixture test: feed three mock findings with matching `cluster_key` → output has exactly one `### Multi-frame finding:` block with three sub-bullets | test |
| A5 | Cluster severity = max(member post_verification_severity) *(refined: requirements, risk-scope)* | Fixture test: mixed P0/P1/P2 cluster → cluster header reports P0 | test |
| A5 | Single-member clusters emit as plain raw-finding bullets *(refined: requirements)* | Fixture test: one raw finding with unique cluster_key → gap_analysis.md contains `### Frame N:` but no `### Multi-frame finding:` wrapper | test |
| A5 | Effective cluster_key is `(frame_id, finding_subclass, tuple)` within-frame, `tuple` cross-frame *(refined: requirements, codebase, risk-scope R16)* | Fixture test: construct two Frame 1 findings on same `(node, key)` with different subclasses → they do NOT cluster. Construct Frame 1 asymmetric_writer + Frame 2 symmetry on same tuple → they DO cluster. | test |
| A5 | Cluster fix-selection precedence table enforced *(refined: requirements, risk-scope R16)* | Fixture test: F1+F2+F6 cluster → emitted `Suggested fix (root cause)` is the Frame 2 symmetry edit. F1+F3 cluster → Frame 3 cartesian-cell fix. Any combination not in the table → `### Cluster fix-selection warning` comment AND fix taken from highest-severity member. | test |
| A5 | Frame 1 highest-severity-subclass precedence *(refined: codebase P1)* | Unit test: `(node, K)` satisfies both asymmetric_writer (P0) and orphan_writer (P3) → single emitted finding carries `finding_subclass: asymmetric_writer` | test |
| A6 | Registry file ships and validates | `test -f extension/data/engine-injected-keys.json && jq -e '.schema_version and .engine_keys and .engine_key_patterns and .user_written_patterns' extension/data/engine-injected-keys.json` | lint |
| A6 | Registry `schema_version` is introspected by loaders *(refined: requirements, risk-scope R2)* | Unit test: load the registry with an unknown `schema_version` → loader throws a clear `schema_version` error; analyzer exits 2 | test |
| A6 | Registry is deployed by install.sh *(no explicit copy step needed; rides along with rsync)* *(refined: codebase)* | `test -f ~/.claude/pickle-rick/extension/data/engine-injected-keys.json` after `bash install.sh` | integration |
| A6 | No `chmod +x` applied to registry file *(refined: codebase)* | `grep -c "chmod +x.*engine-injected-keys.json" install.sh` returns 0 | lint |
| A6 | Analyzer loads the registry before running Frame 1 | Test: replace registry with a custom fixture that marks `test_key_*` as engine-written; analyzer output for a DOT using `test_key_foo` does NOT emit an orphan-writer finding | test |
| A6 | Registry contract test: every attractor `context_on_*=` / `ATTRACTOR_CTX:` key matches a registry entry *(refined: risk-scope R2)* | CI step: walk attractor source for literal context writes; assert each key matches `engine_keys`, `engine_key_patterns`, or `user_written_patterns`. Any unmatched key fails the test with the key name. | integration |
| A7 | Verification protocol documented in plumbus.md | `grep -c 'Verification protocol\|analysis_mode' .claude/commands/plumbus.md` returns ≥ 1 | lint |
| A7 | llm-only findings carry an `analysis_mode` tag | Fixture run with companion script absent → every Frame 1/3/5 finding has `Analysis mode: llm-only` | test |
| A7 | A7 verification is deterministic across runs *(refined: requirements)* | Test: run A7 twice against the same llm-only finding against the same DOT; assert verdict (confirm / disagree) is identical both runs. Uses sorted-set structural equality, not string comparison. | test |
| A7 | A7 structural-equality comparison is used *(refined: requirements)* | Unit test: verification_result=[N3, N1, N5] and original.members=[N1, N3, N5] → verdict=confirm (not disagree) | test |
| A7 | llm-assisted findings skip A7 as accepted tradeoff *(refined: risk-scope R13)* | Fixture test: llm-assisted finding with deliberately-wrong content → A7 is NOT invoked; finding queues at `pre_verification_severity` | test |
| A8 | Rubric documents the promotion path | `grep -c 'Validator rule promotion' .claude/commands/pickle-dot-patterns.md` returns ≥ 1 | lint |
| A9 | plumbus-frame-analyzer.test.js registered in npm test *(refined: requirements, codebase, risk-scope R1)* | `jq -r '.scripts.test' extension/package.json \| grep -c 'plumbus-frame-analyzer.test.js'` returns ≥ 1 | lint |
| A9 | Test actually runs and emits TAP pass lines *(refined: codebase)* | `node --test extension/tests/plumbus-frame-analyzer.test.js 2>&1 \| grep -c '^ok '` returns ≥ 1 | test |
| A9 | No test file is silently unregistered *(refined: codebase, risk-scope — hygiene gate closes 11% backlog)* | `comm -23 <(ls extension/tests/*.test.js \| sort) <(jq -r '.scripts.test' extension/package.json \| tr ' ' '\n' \| grep 'tests/.*\\.test\\.js' \| sort -u)` is empty | lint |
| A10 | Analyzer-crash fallback tagged as llm-only + A7 *(refined: requirements)* | Fixture test: inject `throw new Error()` into analyzer mid-run → worker's gap_analysis.md for Frame 1/3/5 carries `analysis_mode: llm-only` AND `post_verification_severity` present on all findings | test |
| A10 | Partial-run completion marker enforced *(refined: requirements)* | Fixture test: simulated crash → `<!-- generative-audit-complete: false -->` present; clean run → marker updated to `true` | test |
| A10 | bun-absent install warning emitted *(refined: codebase, risk-scope R15)* | Test: invoke `install.sh` with bun stripped from PATH → stdout contains explicit banner "Plumbus generative audit is running in degraded mode" | integration |
| A11 | Calibration fixtures exist in `__fixtures__/plumbus-frames/` *(refined: codebase, risk-scope)* | `test -d extension/tests/__fixtures__/plumbus-frames && ls extension/tests/__fixtures__/plumbus-frames/*.dot \| wc -l` returns ≥ 6 | lint |
| A11 | Each fixture has a golden JSON *(refined: risk-scope)* | For each `fixture.dot` in `__fixtures__/plumbus-frames/`, `test -f "${fixture%.dot}.golden.json"` | lint |
| A11 | Calibration fixture golden match is exact *(refined: requirements, risk-scope)* | Test: run analyzer against every fixture; analyzer output EXACTLY matches golden JSON (zero FP, zero FN). Diff test asserts equality. | test |
| A11 | Frame 5 produces zero false-positive P0s on shipped pipelines *(refined: risk-scope R7)* | CI step: for each `f` in `attractor/pipelines/*.dot` (or equivalent production-pipeline dir): run analyzer; assert zero Frame 5 findings at severity P0. | integration |
| A12 | Fingerprint algorithm includes sorted edge attributes *(refined: requirements, risk-scope R8)* | Unit test: two graphs identical except for one edge's `condition=` value produce DIFFERENT fingerprints | test |
| A12 | Fingerprint is reproducible across runs *(refined: requirements)* | Unit test: compute fingerprint twice against same graph → identical sha256 | test |
| Global | Extension build + tests green after all changes | `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` exits 0 | build |
| Global | Install smoke | `bash install.sh` exits 0 with no new warnings beyond baseline | integration |

Any ticket that modifies files affecting an AC above MUST cite the corresponding row in its acceptance-criteria table so the conformance check has a concrete command to run.

## Implementation Notes

### Frame 1: Context Key Lifecycle Trace

**Procedure:**
1. Load the engine-injected key registry (`extension/data/engine-injected-keys.json`, A6). Verify `schema_version` is supported; abort to degraded mode if not. Every key that matches `engine_keys` literally or `engine_key_patterns` as a glob is classified as **engine-written** and skipped by the orphan-writer / asymmetry checks — the engine handler is its writer. Keys matching `user_written_patterns` (e.g. `artifact_*`) are **explicitly included** in the symmetry check: they're author-convention writes, not engine writes, and the whole point of the frame is to catch the asymmetric ones.
2. Build a writer/reader matrix for every remaining context key referenced in the graph. Sources of writes: `context_on_success` attrs, `context_on_failure` attrs, `ATTRACTOR_CTX:<key>=...` lines in `tool_command` text (supplemental regex pass — the attractor parser treats tool_command as opaque text; see §Companion script architecture). Sources of reads: edge `condition="context.<key>=<value>"` clauses, `context_keys=` attrs on codergen nodes, `ATTRACTOR_CTX_<key>` references inside `tool_command` strings, prompt body text mentioning `${ATTRACTOR_CTX_*}`.
3. For every key in the matrix, classify (single finding per `(node, key)`, highest-severity class wins per precedence `asymmetric_writer > multi_writer_conflict > orphan_reader > orphan_writer`):
   - **Orphan reader** (read by ≥1 edge or attr, never written): the key will always be undefined → that edge never fires → silent dead routing.
   - **Orphan writer** (written by ≥1 attr, never read): wasted state, OR the author intended a reader and forgot it → the routing they wanted doesn't exist.
   - **Asymmetric writer** (written on success path but never written on the failure path the diamond can reach): the silent-success-trap class.
   - **Multi-writer with conflicting values** (two `context_on_success` attrs on different nodes write the same key with different values): non-deterministic routing depending on which node ran last.
4. Emit findings per orphan/asymmetric/multi-writer key, tagged with `finding_subclass`.

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
     - **Trace**: script_path=<path>, reason=<mode-A gate that failed OR "path unreachable" OR "no source nor hints">, downstream_diamond=<diamond_node> reads keys=<[...]>, exit-0 behavior=<description>, exit-nonzero behavior=<description>.
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

**Procedure:** Run Tarjan's SCC on the directed graph. For every non-trivial SCC (size ≥ 2 or self-loop):
1. Identify the SCC's "convergence signal" — the mechanism by which a strict subset of the SCC's nodes can produce a different outcome on iteration N+1 than on iteration N. Recognized signals (mechanical only — the attractor parser does not expose inline DOT comments, so comment-based convergence markers are not detectable; a future `convergence_proof="..."` attribute is a cleaner way to let authors suppress false-positives and is tracked as a follow-up rather than a frame feature):
   - SCC contains an `iterate` node (`class="iterate"`) with `convergence_epsilon > 0` and `until` predicate.
   - SCC contains a codergen node with `model_ladder` + `ladder_advance_on=rollback`.
   - Any SCC member's `context_keys=` attr includes `__pool_findings__` (pool grows; fix scope changes per iteration).
   - Any SCC member's `context_keys=` attr includes `__fix_attempt_history` (fix node sees prior failed attempts).
   - Any SCC member's `context_keys=` attr includes `__last_failure_output` (failure-driven loop — fix node sees the last tool's stderr/stdout). Legitimate pattern; without this check, every retry loop would false-positive.
2. If NO signal is found, file a finding: the SCC is a budget-bounded loop with no information-injection mechanism — it will deterministically plateau until `max_visits` ends it.

**Frame 5 severity cap for calibration** *(refined: risk-scope R7)*: until the calibration baseline demonstrates ≥90% precision (see A11), Frame 5 severity is capped at **P1** regardless of the computed severity below. The P0 tier is unlocked only after precision is measured.

**Severity (pre-cap):**
- SCC with no convergence signal AND on a `retry_target` path (budget-bounded plateau — the loop will deterministically run to `max_visits` while producing zero new signal per iteration; wastes the full budget silently) → **P0**.
- SCC with no convergence signal NOT on a `retry_target` path (no amplifier effect; plateau is visible to the author on the first re-entry) → **P1**.
- SCC with `model_ladder` only (no fresh information per iteration beyond model swap) → **P2** (works but burns budget; flag as "budget-bounded ladder loop").

**Note on iterate bodies:** the iterate handler's body subgraph IS itself a convergence mechanism (V_total descent, drift detection). So an SCC entirely within an iterate body, contained by an iterate parent with `convergence_epsilon` set, satisfies the proof obligation by construction.

### Frame 6: Counterfactual Outcome Test

**Procedure:** For every node `N`:
1. Construct the counterfactual: "What if `N` returned SUCCESS without producing its expected side effect?" (For codergen: file not written / file written incorrectly. For tool: script no-op'd. For reviewer: no findings emitted despite real defects.)
2. Identify the downstream guards that would catch this:
   - Tool node downstream that mechanically checks the artifact (`gate_X` reading the file).
   - `allowed_paths` post-execution check (engine verifies files written are within the allowlist; does NOT verify they were written).
   - A future `expected_paths` attribute (proposed in [open question 1](#open-questions)) that would assert minimum files written.
   - Reviewer in a downstream phase that would flag the missing artifact.
3. If the only guard is "the next codergen would notice" (i.e., a transitive guard, not a direct one), file a finding: silent-failure trap class.

**Severity:** No direct guard → **P1**. Transitive guard only → **P2** (works in happy path, fails open under silent regress).

**Example:** `impl_api_controller_seed` returning success-with-no-file was caught only by `gate_controller_routes` reading the file path — but the gate's failure didn't unwind the artifact flag (Frame 2's symmetry issue), so the catch became a trap. Frame 6 flags the seed node for relying on a downstream gate as its ONLY counterfactual guard, and Frame 2 flags the gate for failing to unwind.

### Companion script architecture

Source at `extension/src/plumbus-frame-analyzer.ts`, compiled (by the existing `npx tsc` step in `install.sh`) to `extension/bin/plumbus-frame-analyzer.js`, deployed to `~/.claude/pickle-rick/extension/bin/plumbus-frame-analyzer.js`.

**Shared types** *(refined: codebase P2)*: if TypeScript types (`AnalyzerOutput`, `ContextKeyRow`, `DiamondRoutingRow`, `CycleRow`) are extracted for reuse, they land in `extension/types/plumbus-frame-analyzer.ts` per existing top-level convention.

**Test helpers** *(refined: codebase P2)*: shared fixture loaders / DOT-parsing helpers for the analyzer tests land in `extension/tests/__helpers__/` per existing convention — NOT a new `extension/tests/helpers/` or inline-in-the-test-file.

**Discovery & parsing** *(refined: codebase P0)*:

- Discovers the attractor clone using the same three-step pattern `plumbus.md` uses for the validator: `$ATTRACTOR_ROOT` env var → `../attractor/` relative path → `find ~/loanlight -maxdepth 2` wildcard. Discovery-target probe: `$ATTRACTOR_ROOT/packages/attractor/src/cli.ts` (proven-working check; if the CLI is present, the sibling `parser.ts` and the `scripts/dump-graph.ts` helper are present).
- Invokes `bun $ATTRACTOR_ROOT/packages/attractor/scripts/dump-graph.ts <target.dot>` via Node's `spawnSync`, captures stdout, parses to JSON.
- `dump-graph.ts` (≤30 LOC) ships in a sibling attractor PR. It imports `parse()` from `packages/attractor/src/parser.ts` and `Graph`/`Node`/`Edge` from `packages/attractor/src/types.ts`, then writes `JSON.stringify(graph)` to stdout. The extension and attractor PRs land together or the extension's analyzer-output contract test fails loudly.

**Failure classes** (all trigger analyzer exit 2 + worker llm-only fallback + A7):
- `bun --version` exits non-zero (bun not on PATH).
- `$ATTRACTOR_ROOT/packages/attractor/src/cli.ts` not found after discovery.
- `$ATTRACTOR_ROOT/packages/attractor/scripts/dump-graph.ts` not found.
- `dump-graph.ts` exits non-zero.
- `dump-graph.ts` stdout is not valid JSON.
- JSON is missing required top-level keys (`nodes`, `edges`).

**Worker-side `${EXTENSION_ROOT}` substitution** *(refined: codebase)*: the worker substitutes `${EXTENSION_ROOT}` → `$HOME/.claude/pickle-rick` before the analyzer command runs, matching the substitution convention already used for `${ATTRACTOR_ROOT}` and `${TARGET}` in existing plumbus overrides (see `plumbus.md:49-57`).

**Deterministic analyses** performed after parse:

  - **Context key matrix** (Frame 1, 2): walks all nodes, builds writers/readers per key, returns the matrix. Note: `ATTRACTOR_CTX:<key>=...` patterns inside `tool_command` strings and `${ATTRACTOR_CTX_*}` references inside prompt-body text are opaque to the attractor parser — the analyzer performs a supplementary regex pass over those string fields to populate the matrix.
  - **Diamond routing exhaustiveness** (Frame 3): walks all diamonds and outcome-multi-fan-out tool nodes, enumerates the cartesian product (capped per R5 performance budget), returns the per-cell match count.
  - **SCC + convergence signals** (Frame 5): Tarjan's SCC (hand-rolled inline, ~80 LOC — extension has zero runtime deps and we want to keep it that way, modulo the new bun soft-dep per R15), annotate each SCC with detected convergence signals. Node 20+ APIs only.

- Outputs JSON to stdout in the schema in A3.

**Performance sub-budget** *(refined: risk-scope R5)*: `bun_spawn ≤ 500ms (cold) / ≤ 100ms (hot), parse ≤ 1s (200-node graph), analysis ≤ 8s`. Total wall-time cap 10s. Exceed the analysis budget for a specific frame → that frame's findings degrade to llm-only for this run + A7; whole pass never aborts. Cartesian-cell enumeration capped at 256 cells per diamond (graphs exceeding the cap are rare; when they occur, emit a finding "diamond too complex to enumerate mechanically" and fall back to llm-only for that diamond).

The plumbus worker invokes this once per iteration-1 audit:
```bash
node "${EXTENSION_ROOT}/extension/bin/plumbus-frame-analyzer.js" "${TARGET}" > "${SESSION_ROOT}/frame-analysis.json"
```
Then references the JSON in its prompt context when applying frames 1, 3, 5. Frames 2, 4, 6 are LLM-only (require reasoning about intent and counterfactuals — no purely mechanical analysis suffices).

### Runtime Dependency Policy Change *(refined: risk-scope R15)*

Prior to this PRD, the extension deployed tree (`~/.claude/pickle-rick/extension/`) had zero runtime dependencies beyond `node` and a pre-installed `claude` CLI (`install.sh:18`). This PRD adds `bun` as a soft runtime dependency: the companion analyzer shells out to `bun` via `spawnSync` to invoke `dump-graph.ts` in the sibling attractor repo. Tradeoffs accepted:

- On bun-absent machines, the analyzer exits 2 and the worker falls back to `llm-only` mode (A10, R10). Users are notified via an install banner AND a per-run log line.
- No alternative runtime (tsx, ts-node) is accepted as a substitute because `parser.ts` uses bun-specific `.ts` import specifiers.
- Vendoring the parser is rejected (duplicate-logic maintenance cost).

Impacts `install.sh`: add `bun --version` probe alongside `claude --version` at `install.sh:18`. Emit warning (not error) on failure, matching the existing soft-dep pattern. `CLAUDE.md`'s pickle-rick project section gains a one-liner updating the dep policy.

### Backwards compatibility

- The new rubric section is purely additive; existing patterns and rules are unchanged.
- Plumbus Override 6 is gated on `## Generative Findings` fingerprint match AND completion marker, so re-runs against partially-analyzed sessions don't re-do the work — and partial runs re-trigger rather than becoming permanent.
- The companion script falls back gracefully per A3 / A10: if the script can't execute (bun missing, attractor clone missing, `dump-graph.ts` missing, crash, budget exceeded), the worker logs a notice, exits the analyzer with code 2, and tags Frame 1/3/5 findings as `analysis_mode: llm-only` + runs A7 verification. The phrase "reduced confidence" from prior PRD drafts is retired; `confidence:` is a Frame-4-specific tag; `analysis_mode` + A7 are the correct mechanism for script-unavailable paths.

## Risks & Mitigations *(refined: risk-scope — paste-ready block)*

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R0 | A3's `import()` path does not execute on Node. | Certain (as initially specified) | Blocking | Adopt bun-shellout path: analyzer spawns `bun packages/attractor/scripts/dump-graph.ts <target>`. Sibling attractor PR ships `dump-graph.ts` (≤30 LOC). Extension gains soft `bun` dependency. Both PRs land together; analyzer-output contract test gates divergence. |
| R1 | New test file silently unregistered in `extension/package.json` hardcoded test list. | Certain (default) | High | A9 lint-row: `jq -r '.scripts.test' extension/package.json \| grep -c plumbus-frame-analyzer.test.js` ≥ 1, PLUS hygiene gate asserting no `extension/tests/*.test.js` is unregistered, PLUS TAP-line check that the test actually ran. |
| R2 | `engine-injected-keys.json` drifts behind attractor engine handlers. | High | Medium | DRI named in A6 (concrete GitHub handle at PR review time). Contract test walks attractor source for literal `context_on_*=`/`ATTRACTOR_CTX:` writes; asserts registry coverage OR `user_written_patterns` match. Registry carries `schema_version`; loaders reject incompatible versions. |
| R3 | `bun` not on PATH in CI. | High | Medium | CI workflow installs bun as precondition for `integration` and `test` rows. Unit tests mock the subprocess on bun-absent local dev. |
| R4 | No kill-switch for Override 6; bad ship requires five-file rollback. | Medium | High | A2.5: `PLUMBUS_GENERATIVE_AUDIT=off` env var or `--no-generative` flag; one-line check in Override 6 body; full bypass (no companion script, no section written); audit-trail entry in `state.json.activity`; documented in `CLAUDE.md`. |
| R5 | Analyzer wall-time unbounded on pathological graphs. | Low–Medium | Medium | Sub-budget: `bun_spawn ≤ 500ms (cold), parse ≤ 1s (200-node graph), analysis ≤ 8s`. Per-frame fallback to llm-only on overflow; whole-pass never aborts. Cartesian cap 256 cells per diamond. |
| R6 | LLM-only frames (2, 4, 6) produce high false-positive rate on unfamiliar graphs. | Medium | Medium | Calibration set (A11): ≥6 fixtures + golden outputs + CI baseline on every shipped attractor pipeline. PR fails if a currently-green pipeline produces a new P0. |
| R7 | Frame 5's recognized-signal list misses legitimate loop patterns (escalate_on, time-based, self-heal). | Medium | Medium | Precision ≥ 90% baseline required before Frame 5 P0s are queue-consumable. Frame 5 severity capped at P1 until baseline measured. |
| R8 | Fingerprint hashes structure only; attr-only edits (weight, condition, tool_command) do not re-trigger audit. | Medium | Medium | A12: include sorted edge attributes in fingerprint. Accept the noise cost; attr edits are exactly the edits the frames should re-audit. |
| R9 | `analysis_mode` / A7 produce two severity models. | Certain (as originally written) | Medium | A4 three-field split: `pre_verification_severity`, `post_verification_severity`, `rendered_severity`. Queue consumes `post_`. All three appear in every finding. |
| R10 | "Applies manually" on companion-script unavailability is unspecified. | Certain | Medium | A10: on companion-script failure OR bun absence OR script non-zero exit OR invalid JSON: all Frame 1/3/5 findings carry `pre_verification_severity` capped at P2, A7 mandatory, `post_verification_severity` ∈ {P2, P3} (never P0 or P1 from this path). |
| R11 | `confidence` tag never aggregated; Mode-A gate drifts vestigial. | Low | Low | `/pickle-metrics` counter; alert at 30% Mode C ratio. *(P2 follow-up; cross-PRD tracking.)* |
| R12 | Frame 6 deterministic-mode activation ungated on attractor version. | Low | Low | Runtime check at Frame 6 entry: `expected_paths` present on ≥1 node AND attractor engine supports it. Cross-PRD dependency on sibling attractor `expected_paths` PRD; NOT an AC in this PRD's scope. |
| R13 | `analysis_mode: llm-assisted` has undefined verification semantics; same finding tagged two ways bypasses or triggers A7 non-deterministically. | Medium | Medium–High | A4 per-element operational definition (JSON present + LLM judgment = `llm-assisted`; JSON absent = `llm-only`; JSON present + copy-verbatim = `mechanical`). A7 explicitly does NOT verify `llm-assisted` findings — accepted tradeoff documented in A7. |
| R14 | Mode A's 200-LOC / ≤5-exit gate is empirically fabricated; thresholds have no grounding in the real routing-signal corpus (98/88/62 LOC). | Medium | Medium | Gate retained for headroom; Frame 4's rubric body annotates the empirical anchor explicitly. Mode B/C pedagogical examples ship via synthesized fixtures (A11), not invented production scripts. Re-examine gate if a real routing-signal script crosses 100 LOC. |
| R15 | `bun` as silent runtime dependency inverts extension's zero-runtime-deps posture. | Certain | Medium | Runtime Dependency Policy Change subsection in Implementation Notes accepts bun as a new runtime dep. Install-time warning elevated to explicit banner on bun absence. `CLAUDE.md` one-liner updating the dep policy. |
| R16 | Cluster fix-selection ambiguous when frames co-fire in unspecified combinations; wrong-fix-wins keeps secondary findings alive on re-walk. | Medium | Medium | A5 precedence table for every documented 2-frame combination; fail-soft to highest-severity member's fix with `### Cluster fix-selection warning` comment for un-tabulated combinations. |

### Risk invariants

- No frame ships at P0 without a calibration fixture demonstrating ≥1 true-positive AND ≥1 clean-on-known-good fixture.
- No risk-mitigation test is valid until it is registered in `extension/package.json`'s `test` script.
- The priority queue consumes `post_verification_severity`, never `pre_verification_severity`.
- Bun availability must be checked on worker startup; worker falls back to a documented degraded mode on absence, never silently.
- Every kill-switch-bypass path (R4) leaves audit trail in `gap_analysis.md` so future analysts can reconstruct what was skipped.

## Open Questions — Resolutions

All original open questions resolved during validation. Kept here as decision record rather than live questions.

1. **`expected_paths` codergen attribute** → **Resolved: ship as sibling attractor PRD.** Opt-in, comma-separated paths. Post-codergen, the engine walks `expected_paths`, checks existence in workspace, and on miss converts outcome to FAIL with `failure_reason="expected_path_missing: <path>"` and populates `__last_failure_output` so `retry_target` sees the gap. Paired validator rule `expected_paths_subset_of_allowed_paths` enforces that every expected path is writable per the allowlist (otherwise the gate is unsatisfiable by construction). Patch-style nodes that legitimately no-op stay opt-out. Tracked at `attractor/docs/prd/expected-paths-codergen-attribute.md`. Plumbus Frame 6 ships LLM-only; deterministic mode lights up automatically when the attractor attribute lands and authors start declaring it (see §Priority P2). Cross-PRD dependency tracked in R12.

2. **Frame 1 engine-prefix handling** → **Resolved via A6 registry.** Ship `extension/data/engine-injected-keys.json` with `schema_version`, `engine_keys` (literal), `engine_key_patterns` (glob), and `user_written_patterns` (the `artifact_*` class the engine does NOT auto-set — author convention writes them via `context_on_success`). Frame 1 and Frame 2 both load the registry so the classification is consistent. Side benefit: centralizes documentation of engine-injected keys that is currently scattered across handler trap-doors.

3. **Promote `scc_without_convergence_signal` to a validator rule** → **Resolved: yes, file a follow-up ticket.** Mechanical signals only (the set in Frame 5 step 1 — `iterate`/`model_ladder`/`__pool_findings__`/`__fix_attempt_history`/`__last_failure_output`). Severity **WARNING** (not ERROR) to acknowledge false-positive risk on legitimate-but-unusual loops. Suppression path is a future `convergence_proof="..."` codergen/iterate attribute — out of scope here, follow-up ticket in the attractor validator track.

4. **Frame 4 source-access limitation** → **Resolved via the three-mode gate in the Frame 4 procedure.** `confidence: HIGH | MEDIUM | LOW` tag records which mode fired. Rubric logs the gate outcome explicitly in `gap_analysis.md` so the rubric never looks authoritative when it's guessing. Mode C findings are flagged manual-investigation, not auto-actionable. Mode C finding body template is now documented verbatim in the Frame 4 procedure (R14 implications logged).

5. **Frame interaction (multi-lens echo vs dedup)** → **Resolved via A5 clustering.** Not a binary "dedup vs keep separate" — cluster. Each frame emits raw findings with a `cluster_key`; findings with matching keys collapse into one `### Multi-frame finding` bullet with lenses as sub-bullets. Cluster severity = max(member post_verification_severity) under max-by-impact ordering. Worker priority queue references clusters, not raw findings — fix once, all lenses clear on re-walk. Single-member clusters emit as plain bullets. Educational benefit of three-lens reporting preserved; noise-inflation of three-times-fixing-the-same-bug eliminated.

### Surfaced During Validation — Also Resolved

6. **Dedup ordering rule** (validation question) → folded into A5 fix-selection precedence table. Every documented 2-frame combination has a winning fix; un-tabulated combinations fail-soft to highest-severity member with a warning comment.

7. **Frame 4 step 3 feasibility gate** (validation question) → folded into Q4 / Frame 4 procedure. The five Mode A gates (path resolves in-repo, ≤200 LOC, ≤5 exit call sites, literal exit codes, recognized language) ARE the feasibility gate. When Mode A's gates fail the worker drops to Mode B or C — no pretending Mode-A precision the worker couldn't actually produce. Gate thresholds are empirically un-grounded in the current corpus (R14); Mode B/C examples use synthesized fixtures.

8. **Degraded mode when companion script is unavailable** (validation question) → folded into A4 `analysis_mode:` + A7 verification protocol + A10 crash-recovery CUJs. The bug's truth value is independent of how it was found, so severity does NOT downgrade when the analyzer is missing (with the one exception in A10/R10: capping at P2 when analyzer failed wholesale, because full-coverage confidence is unrecoverable). Finding is tagged `analysis_mode: llm-only`, and the worker runs a targeted A7 verification pass before acting. If verification confirms → act at original severity. If verification disagrees → downgrade to P3 and record the disagreement. This preserves high-signal findings even without the companion script.

9. **Kill-switch semantics** (surfaced by requirements + risk-scope) → resolved via A2.5. Full bypass, not partial suppression. Documented in `CLAUDE.md`.

10. **Test-registration gap** (surfaced by all three analysts) → resolved via A9. Three AC rows: registration lint, TAP-line test-ran check, codebase-wide hygiene gate.

11. **Runtime strategy for parser import** (surfaced by codebase + risk-scope) → resolved via A3 bun-shellout + `dump-graph.ts` helper + R15 policy change + R10 degraded mode.

12. **Graph fingerprint persistence** (surfaced by requirements + codebase) → resolved via A12. Fingerprint lives ONLY in `gap_analysis.md`; forbidden in extension tree; include sorted edge attributes to catch attr-only edits.

## Priority

**P0** — ship Frames 1 (Context Key Lifecycle), 2 (Symmetry), 3 (Edge Exhaustiveness), and 4 (Exit Code), PLUS the infrastructure that makes them verifiable: bun-shellout runtime (A3 resolution), test-registration hygiene gate (A9), calibration fixture set (A11), kill-switch (A2.5), three-severity model (A4), structural A7 comparison, graph fingerprint (A12). Coverage mapping against §Problem:

| Trap class | Frames that fire | Notes |
|---|---|---|
| Silent-success trap (asymmetric flag) | 1 (P0 asymmetric writer) + 2 (P0 missing failure unwinding) | Multi-lens by design; collapses into a single `### Multi-frame finding` cluster per A5 (precedence: Frame 2's symmetry edit wins as root fix) |
| Contract-verify exit-code mismatch | 4 (P0 routing-signal tool with retry_target) | Frame 4 is the only frame that reasons about tool contracts |
| Diamond locked-on-patch (stuck/latent cells) | 3 (P0 stuck cell, P1 nondeterministic overlap) | Frame 1+2 do NOT catch this — it's a cartesian-product property, not a key-lifecycle property |
| Drift detection blindspot | none — out of scope | Dynamics/convergence class; addressed by attractor schema additions in `pickle-dot-patterns.md`, not by generative frames |

Companion script ships in the P0 batch so the LLM isn't doing Tarjan's SCC or cartesian-product enumeration in its head. Bun-shellout runtime strategy is P0-blocking (A3's Node `import()` path does not execute; no analyzer works until the shellout lands).

**P1** — Frame 5 (Loop Convergence Proof Obligation). Mechanical (Tarjan's SCC is already computed for Frame 3's companion-script output), high-signal on the budget-bounded-plateau class. Severity capped at P1 until precision-baseline calibration (R7). Not blocking the §Problem fixes but hardens the loop-design surface; ship once P0 is stable and authors are using the audit pass.

**P2** — Frame 6 (Counterfactual Outcome). Ships in LLM-only mode immediately (no dependency on attractor changes); deterministic mode lights up automatically once the `expected_paths` codergen attribute lands via the sibling attractor PRD (`attractor/docs/prd/expected-paths-codergen-attribute.md`, Q1). Frame 6 does NOT block on that PRD — the LLM-only path is good enough to catch the silent-failure-trap class when paired with Frame 2's symmetry check via A5 clustering. `/pickle-metrics` aggregation of `analysis_mode`/`confidence` tags (R11) is also P2 follow-up.

Out-of-scope: auto-promoting Generative Findings to named validator rules; teaching the rubric to suggest the precise validator-rule code for a finding pattern; cross-pipeline learning of the kind described in `docs/prd/self-healing-diagnose-route.md` Phase 3 over in attractor; the drift-detection class (lives in the attractor schema track); cross-PRD wiring of `expected_paths` deterministic-mode gate (R12; sibling attractor PRD owns the version-introspection method).


## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | fffab56a | Create engine-injected-keys.json registry file | High | None | Registry JSON present with schema_version 1 | extension/data/engine-injected-keys.json |
| 20 | 9e0711ec | Build engine-injected-keys.json loader with schema_version validation | High | Ticket 10 | `loadEngineKeysRegistry`/`isEngineWritten`/`isUserWritten` exported and tested | extension/src/lib/engine-keys-registry.ts, extension/types/engine-keys-registry.ts, extension/tests/engine-keys-registry.test.js |
| 30 | fce05d7b | Scaffold plumbus-frame-analyzer.ts: CLI, argv, JSON output shape, attractor discovery | High | None | Analyzer CLI emits closed-schema JSON with empty arrays | extension/src/plumbus-frame-analyzer.ts, extension/types/plumbus-frame-analyzer.ts, extension/tests/plumbus-frame-analyzer.test.js |
| 40 | 0e7da428 | Wire bun-shellout to dump-graph.ts in plumbus-frame-analyzer | High | Ticket 30 | spawnSync bun path with 6-class failure handling, exit 2 on any failure | extension/src/plumbus-frame-analyzer.ts, extension/tests/plumbus-frame-analyzer-bun.test.js |
| 50 | 38cc1617 | Build Frame 1 context-key writer/reader matrix with engine-key filtering | High | Tickets 20, 40 | `context_keys` array populated; engine-written keys filtered | extension/src/plumbus-frame-analyzer.ts, extension/src/lib/context-key-matrix.ts (optional), extension/tests/context-key-matrix.test.js |
| 60 | 16a290ac | Add tool_command regex pass for ATTRACTOR_CTX: writes and reads | High | Ticket 50 | tool_command + prompt writes/reads merged into matrix | extension/src/plumbus-frame-analyzer.ts, extension/tests/context-key-matrix.test.js |
| 70 | cf8180b0 | Build Frame 3 cartesian-product diamond routing analysis | High | Ticket 60 | `diamond_routing` populated with cells + cap marker | extension/src/plumbus-frame-analyzer.ts, extension/src/lib/diamond-routing.ts (optional), extension/tests/diamond-routing.test.js |
| 80 | 75681ae3 | Build Frame 5 SCC + convergence-signal detection (Tarjan inline) | High | Ticket 70 | `cycles` populated with iterative Tarjan + signal classification | extension/src/plumbus-frame-analyzer.ts, extension/src/lib/tarjan-scc.ts, extension/tests/tarjan-scc.test.js, extension/tests/cycles-convergence.test.js |
| 90 | cf2e3ae3 | Pin analyzer-output contract test against dump-graph.ts JSON fixture | High | Ticket 80 | Contract test + pinned fixture JSON + fake-bun.sh in place | extension/tests/__fixtures__/plumbus-frames/dump-graph-output.pinned.json, extension/tests/__fixtures__/plumbus-frames/fake-bun.sh, extension/tests/plumbus-frame-analyzer-contract.test.js |
| 100 | 7014a3ff | Add Generative Audit Frames section header + Frames 1-2 to rubric | High | None | Rubric section + Frames 1-2 present above Tier 1 | .claude/commands/pickle-dot-patterns.md |
| 110 | 7e4f59d4 | Append Frames 3-4 to Generative Audit Frames rubric section | High | Ticket 100 | Frames 3-4 present; Frame 4 cites verify-controller-routes.ts at 204 LOC | .claude/commands/pickle-dot-patterns.md |
| 120 | d6b5d00a | Append Frames 5-6 + A8 promotion path to Generative Audit Frames rubric | High | Ticket 110 | All six frames + A8 paragraph present | .claude/commands/pickle-dot-patterns.md |
| 130 | a618e7c0 | Add Plumbus Override 6 with merge discipline + fingerprint storage | High | Ticket 120 | Override 6 with merge + fingerprint algo + exclusivity | .claude/commands/plumbus.md, extension/src/lib/verification-comparator.ts (if co-extracted), extension/tests/fingerprint-regex.test.js |
| 140 | 244456ec | Add PLUMBUS_GENERATIVE_AUDIT kill-switch to Override 6 | High | Ticket 130 | Full-bypass kill-switch + CLAUDE.md entry + fixture test | .claude/commands/plumbus.md, CLAUDE.md, extension/tests/kill-switch.test.js |
| 150 | 5f2c4847 | Document A7 worker verification protocol for llm-only findings | High | Ticket 140 | A7 block + structuralEqual helper + unit tests | .claude/commands/plumbus.md, extension/src/lib/verification-comparator.ts, extension/tests/verification-comparator.test.js |
| 160 | e1ece2af | Document finding format + three-severity model in Plumbus/rubric | High | Ticket 150 | Finding-body template + three-severity model + maxSeverity helper | .claude/commands/plumbus.md, extension/src/lib/severity.ts, extension/tests/severity.test.js |
| 170 | 0abb96fc | Document finding clustering + fix-selection precedence | High | Ticket 160 | Cluster rendering block + selectFix helper + table-driven tests | .claude/commands/plumbus.md, extension/src/lib/cluster-fix-selector.ts, extension/tests/cluster-fix-selector.test.js |
| 180 | 0c909acf | Update install.sh: bun probe + banner, analyzer chmod +x | High | Ticket 30 | chmod on analyzer + bun banner + no chmod on registry | install.sh, extension/tests/install-bun-probe.test.js |
| 190 | bdd5ec68 | Ship calibration fixtures + test registration hygiene gate | High | Tickets 90, 170 | 8 fixtures + 6+ goldens + hygiene gate + all tests registered | extension/tests/__fixtures__/plumbus-frames/*.dot, *.golden.json; extension/package.json; extension/tests/test-registration-hygiene.test.js; extension/tests/plumbus-frame-analyzer-calibration.test.js |
| 200 | 595c9941 | Wire: integrate frames, analyzer, registry, and rubric into plumbus pipeline end-to-end | High | All tickets 10-190 | Four integration tests pass; npm test green end-to-end | extension/tests/plumbus-generative-audit.integration.test.js, extension/tests/engine-keys-registry-coverage.test.js, extension/tests/plumbus-ci-pipeline-baseline.test.js, extension/tests/plumbus-iteration-merge.test.js, extension/package.json |
| 210 | b2ec8192 | Hardening: Code Quality review of all modified files | Medium | Ticket 200 | ESLint clean; no `any`; no dead code; CLAUDE.md patterns applied | All MODIFIED_FILES |
| 220 | 119b2b08 | Hardening: Data Flow audit across analyzer → worker → gap_analysis.md | Medium | Ticket 200 | Three trace tests pass deterministically | extension/tests/data-flow-trace-{a,b,c}.test.js |
| 230 | 98b3f270 | Hardening: Test Quality review of all new test files | Medium | Ticket 200 | Every test emits TAP pass lines; no unsanctioned .skip/.only | All TEST_FILES; extension/tests/test-quality-hygiene.test.js |
| 240 | 6d197ab9 | Hardening: Cross-Reference audit across rubric, plumbus, CLAUDE.md, README | Medium | Ticket 200 | Canonical names consistent; README updated; cross-ref test green | .claude/commands/pickle-dot-patterns.md, .claude/commands/plumbus.md, CLAUDE.md, README.md, extension/tests/doc-cross-reference.test.js |
