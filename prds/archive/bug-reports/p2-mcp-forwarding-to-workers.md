---
title: P2 — Forward user-level MCP servers into Morty worker / refinement subprocesses
status: Draft
filed: 2026-05-15
priority: P2
type: bug-design-gap
r_code_prefix: R-MFW
backend_constraint: any
related:
  - prds/p1-bug-fix-bundle-theme-a-refinement-quality.md  # R-PSU — /pickle-standup hard-depends on Linear MCP being reachable from workers
  - prds/p1-bug-fix-bundle-2026-05-10.md                  # R-CCNW — Linear-ticket integration in citadel bundle assumes workers can hit Linear MCP
---

# P2 — Workers spawned by pickle-rick-claude have no MCP access

## Symptom (concrete evidence from operator session 2026-05-14)

Operator launched `/pickle-pipeline LOA-789 --backend codex` against the LOA-789 worktree. LOA-789 in Linear lists **eight specific income-approach fields by name** (`gross_annual_rent`, `vacancy_factor`, `effective_gross_income`, `operating_expenses`, `net_operating_income`, `additional_income_type`, `additional_income_amount`, `rent_includes_utilities`).

Pipeline completed 30 commits. **Not one of the 8 named fields was implemented as specified.** Workers shipped 6 different fields and silently inverted scope.

Root-cause trace:

1. `setup.js --task "<text>"` baked the 8 field names into the kickoff prompt.
2. During iter 1 of the pickle phase, the manager self-drafted a PRD (no `prd.md` existed in the session root) — the drafted PRD still enumerated all 8 fields.
3. PRD refinement split the work into 2 atomic tickets (`82f9fcb0` and `503b985b`); **the refined tickets dropped the 8 field names**, leaving only the phrase "the eight deferred income-approach fields."
4. Morty workers read the refined ticket files. Codex's iter-1 transcript states verbatim:

   > "The Linear ticket summary in `original_prompt` is sufficient as the canonical requirements source because **no Linear MCP access is available in this session**."

5. Workers reinterpreted "deferred" ambiguously, sided with an existing schema comment ("Frame A: if not on PDF, not in schema"), and built 6 different fields.

The MCP gap was not the sole cause — refinement also lost the enumeration — but the worker's last available escape hatch (fetch the ticket directly from Linear MCP) was unreachable, so it had no way to recover the dropped specificity.

## Root cause

`extension/src/services/backend-spawn.ts` builds every worker / manager / judge subprocess invocation. It **never** passes `--mcp-config` to `claude` or any MCP-equivalent flag to `codex`. The four invocation builders:

- `buildClaudeWorkerInvocation` (`backend-spawn.ts:283-297`) — passes `--dangerously-skip-permissions`, `--add-dir`, `--output-format`, `--model`, `-p`. No `--mcp-config`.
- `buildClaudeManagerInvocation` (`backend-spawn.ts:299-312`) — same, plus `--no-session-persistence` / `--output-format stream-json`. No `--mcp-config`.
- `buildCodexInvocation` (`backend-spawn.ts:314-339`) — passes `--ignore-rules` and **`--ignore-user-config`**, which actively *strips* `~/.codex/config.toml` (the canonical MCP config location for codex).
- `buildHermesWorkerInvocation` (`backend-spawn.ts:341-357`) — also passes `--ignore-user-config`.

Hard evidence:

- Only **one** mention of "MCP" exists across all of `extension/src/`: `spawn-morty.ts:466`, and it is *instructional text in the worker prompt* ("This repo has a GitNexus knowledge graph index. Use these MCP tools..."). There is no plumbing.
- `claude --help` confirms `--mcp-config <configs...>` is the supported flag; without it, a subprocess `claude -p` invocation does NOT inherit the parent process's resolved MCP set.
- `codex exec --ignore-user-config` is documented as "Do not load `$CODEX_HOME/config.toml`", which is where codex MCP servers are configured.

The `--ignore-rules` / `--ignore-user-config` flags are intentional (see `backend-spawn.ts:320-328` comment-block — they prevent FM-4 "stall-on-imaginary-worker" caused by stale `~/.codex/AGENTS.md` rules). The bypass is correct for *rules*; it is wrong for *MCP servers*.

## Affected workflows

| Caller | Linear/MCP dependency | Impact |
|--------|----------------------|--------|
| `/pickle-standup` (`.claude/commands/pickle-standup.md`) | Hard — line 1 says "Linear-keyed standup from Pickle Rick activity + Linear MCP cross-reference"; line 17 says "Use the Linear MCP — do NOT regex commits as your primary source"; lines 20, 41 invoke `mcp__plugin_linear_linear__list_issues` and `__get_issue`. | If `pickle-standup` ever runs under a Morty subprocess (e.g. from a chained `/pickle-pipeline`), the Linear cross-reference fails silently and the standup regresses to commit-message regex (the exact pathology Rule 7 of the standup prompt was designed to avoid). |
| Pickle-pipeline workers asked to implement a Linear ticket | Soft — operator prompts often say "implement LOA-789" and the codex iter-1 transcript above shows workers *want* to read Linear when uncertain. | Refiner-dropped enumeration becomes irrecoverable. The LOA-789 session is the worked example. |
| Citadel bundle (`prds/citadel-hardening-bundle.md` NEW-T6 — "Linear ticket integration") | Hard — designed to create/transition Linear tickets per pipeline ticket and emit Linear comments at bundle-end. | When implemented, the Linear MCP calls will be made from the citadel phase's subprocess, which has no MCP access. NEW-T6 cannot ship until R-MFW lands. |
| R-PTG-7 (per-ticket worker test gate, Linear-comment attribution) | Hard — "depends on Linear MCP integration already in place." | Same as above. |
| Future workflows depending on Google Drive / Notion / Attio / Slack / GitHub / Postman MCPs the operator has installed | Hard — none are forwarded today. | All silently degrade. |

## Functional requirements

- **FR-1**: `buildClaudeWorkerInvocation` and `buildClaudeManagerInvocation` MUST pass `--mcp-config <path>` to the spawned `claude` subprocess when a valid MCP config exists at the resolution path. The resolution path is, in precedence order: (a) `pickle_settings.json::worker_mcp_config_path` (operator override); (b) `$PICKLE_MCP_CONFIG` env var; (c) `~/.claude.json` (current claude default).
- **FR-2**: `buildCodexInvocation` MUST continue to pass `--ignore-user-config` (preserving the R-CCPL / FM-4 rule isolation) BUT MUST also pass codex's MCP-config equivalent (`-c mcp.servers.<name>.command=...` via `-c key=value` overrides, or whatever the documented codex MCP injection path is at codex CLI's current contract). If codex CLI provides no programmatic way to inject MCP servers while bypassing user config, fall back to FR-4 (snapshot to session root) and document the limitation.
- **FR-3**: `buildHermesWorkerInvocation` MUST follow the codex pattern (FR-2) — preserve `--ignore-user-config` rule isolation but forward MCP servers if hermes CLI exposes a flag for it.
- **FR-4** (defense-in-depth, also a fallback for FR-2/FR-3 if the CLI doesn't expose MCP injection): At `setup.js` session-init time, snapshot operator-configured MCP server *bundles* of interest (default allowlist: Linear; operator-extensible via `pickle_settings.json::worker_mcp_snapshot_servers`) into `${SESSION_ROOT}/mcp-context/<server>.json` as fetched data (e.g. for a Linear ticket task, snapshot `mcp__plugin_linear_linear__get_issue(<ticket-id>)` into `${SESSION_ROOT}/mcp-context/linear-ticket.json`). Workers can read these files even without live MCP. Snapshot is taken once per session; refresh on `--resume` only if older than 24h.
- **FR-5**: `extension/src/bin/spawn-refinement-team.ts` MUST inherit the same MCP forwarding as worker spawns. The refinement team's source-AC validation could legitimately benefit from Linear lookups; today it can't make them.
- **FR-6**: Judge invocations (`buildJudgeInvocation`) MUST NOT receive MCP servers. Judges are read-only graders; MCP write access would violate the read-only-sandbox contract enforced at `backend-spawn.ts:378-424`.
- **FR-7**: All four invocation builders MUST emit a `worker_mcp_config_resolved` activity event with payload `{ source: 'pickle_settings' | 'env' | 'default' | 'snapshot' | 'none', path: string | null, servers: string[] }` so operators can audit which MCPs each worker got.

## Machine-checkable acceptance criteria

- **AC-1**: A test under `extension/tests/services/backend-spawn-mcp.test.js` invokes `buildClaudeWorkerInvocation({prompt: 'x', addDirs: []})` with `pickle_settings.json::worker_mcp_config_path = '/tmp/fixture-mcp.json'` and asserts `--mcp-config /tmp/fixture-mcp.json` appears in the returned `args` array. Type: unit.
- **AC-2**: Same test, default-precedence case: with no override flags set, asserts `--mcp-config <resolved-default>` appears in args when `~/.claude.json` exists; asserts the flag is OMITTED (no `--mcp-config undefined`) when no MCP config file exists at any precedence layer. Type: unit.
- **AC-3**: A test asserts `buildCodexInvocation` still includes `--ignore-user-config` AND includes the resolved codex MCP-injection mechanism (whatever FR-2 chose). Type: unit.
- **AC-4**: A test asserts `buildJudgeInvocation` (both claude and codex paths) does NOT include `--mcp-config` or any codex MCP injection — judges stay sandboxed. Type: unit.
- **AC-5**: An integration test under `extension/tests/integration/worker-mcp-access.test.js` spawns a real `claude -p` worker against a fixture MCP config that registers a synthetic test-only MCP server (e.g. an `echo` MCP). The worker prompt asks it to invoke the test MCP and write the response to a file under `${SESSION_ROOT}/<ticket>/mcp-probe.txt`. Test asserts the file exists and contains the expected echo response. Type: integration (gated on `RUN_EXPENSIVE_TESTS=1`).
- **AC-6**: A test asserts `worker_mcp_config_resolved` activity events are emitted exactly once per worker spawn AND that the event passes the activity-event schema check in `extension/tests/activity-event-payload.test.js`. Type: test.
- **AC-7**: A test under `extension/tests/integration/mcp-snapshot.test.js` exercises FR-4: launches a session via `setup.js` with `pickle_settings.json::worker_mcp_snapshot_servers = ['linear']` and a synthetic ticket ID, asserts `${SESSION_ROOT}/mcp-context/linear-ticket.json` exists with valid JSON containing the ticket's title and description. Type: integration.
- **AC-8**: A new trap door is added in `extension/src/services/CLAUDE.md` for `backend-spawn.ts` with the invariant that worker/manager invocations MUST include MCP forwarding when an MCP config is resolvable. ENFORCE points at AC-1/AC-2/AC-3/AC-4. PATTERN_SHAPE: `--mcp-config` literal in `buildClaudeWorkerInvocation` body. Type: test (covered by `extension/tests/audit-trap-door-enforcement` audit).
- **AC-9**: Release gate passes — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npm run test:fast && npm run test:integration`. Type: test.

## Proposed solutions (ranked)

### Option A — Forward `--mcp-config` from operator config (PREFERRED, covers FR-1)

- `buildClaudeWorkerInvocation` / `buildClaudeManagerInvocation` resolve MCP config path and pass `--mcp-config`.
- Pros: Minimal code change; uses the official claude CLI contract; workers get live MCP (Linear is fresh, not stale snapshot); covers all configured MCPs not just Linear.
- Cons: Only solves the claude backend. Codex needs Option B or D.
- Risk: User's `~/.claude.json` might contain MCP servers that ARE NOT idempotent / safe for parallel worker spawns (e.g. an MCP that writes to a shared resource). Mitigate via `pickle_settings.json::worker_mcp_config_path` operator override pointing at a curated worker-safe MCP config subset.

### Option B — Codex MCP injection via `-c key=value` overrides (covers FR-2)

- Investigate whether codex CLI supports `-c mcp.servers.<name>.command=<...>` overrides that survive `--ignore-user-config`.
- If yes: emit one `-c` flag per snapshot server. Same as `-c reasoning.effort=` already done at `backend-spawn.ts:336`.
- If no: fall back to Option D for codex.
- Pros / cons same as Option A for codex.

### Option C — Drop `--ignore-user-config` from codex spawn (REJECTED)

- Would restore `~/.codex/config.toml` MCP visibility.
- Rejected because `--ignore-user-config` is a load-bearing rule-isolation fix (R-CCPL / FM-4); dropping it reintroduces "stall-on-imaginary-worker" pathology documented in the comment block at `backend-spawn.ts:320-328`. Do not undo that.

### Option D — Snapshot Linear (and other MCP server data) into session root at setup time (covers FR-4, fallback for B if codex blocks injection)

- `setup.js` calls operator's local `claude` once via subprocess with `--mcp-config` and a prompt to dump the configured-MCP responses for known servers into `${SESSION_ROOT}/mcp-context/`.
- Workers read JSON files, not live MCPs.
- Pros: Works for *any* worker backend regardless of CLI MCP support; the snapshot is the operator's "voice"; safe under parallel spawn (read-only files).
- Cons: Stale — if a Linear ticket is edited mid-pipeline, the snapshot doesn't update. Limited to MCPs/queries we explicitly know about up front.
- Combined with Option A/B, this becomes the safety net.

### Option E — Inline-bake MCP fetch results into refinement output (PARTIAL)

- During refinement, the team explicitly invokes Linear MCP (via Option A on the claude backend, since refinement is force-claude) and inlines the *full ticket body* into each `linear_ticket_<hash>.md` file's frontmatter.
- This solves the specific LOA-789 enumeration-drop failure mode without solving the broader gap.
- Should ship as a defense-in-depth complement to A/B/D, not as the primary fix. Filed as **R-MFW-followup** (see Implementation order below).

## Non-goals

- Authenticating MCPs that require OAuth tokens on the worker's behalf. Operators bring their own resolved auth (the existing `~/.claude.json` already includes resolved tokens for OAuth-authed MCPs).
- Implementing a new MCP transport / shim layer. Use the existing claude/codex CLI contracts.
- Solving the upstream refiner-dropped-enumeration bug. That is a SEPARATE design gap and warrants its own PRD (filed as `prds/p2-refinement-team-drops-source-prd-enumerations.md` follow-up — to be authored separately). R-MFW reduces the blast radius of refinement enumeration drops by giving workers a live escape hatch; it does not eliminate the root cause.
- Changing `--ignore-rules` / `--ignore-user-config` behavior for the codex *rules* surface. Only MCP servers are forwarded.
- Forwarding MCPs to judge invocations. Judges stay read-only-sandboxed (FR-6).

## Risks / concerns

- **Security boundary**: Forwarding MCP servers to subprocess workers transitively grants the workers the operator's authenticated MCP scopes. A worker that exfiltrates data via Linear MCP could leak ticket content. Mitigate: operators can configure `pickle_settings.json::worker_mcp_config_path` to a *subset* of their personal MCP config (read-only Linear only, no Slack write, etc).
- **Parallelism safety**: Multiple workers spawning the same MCP server in parallel can collide if the server has shared state. The MCP protocol's per-process server lifecycle already addresses this (each subprocess `claude` spawns its own MCP server child), but worth a parallel-spawn integration test.
- **Codex limitation**: If codex CLI doesn't expose MCP injection while honoring `--ignore-user-config`, we lose live MCP access on the codex backend. Option D snapshot is the fallback. The PRD ships even with the codex gap because Option A still covers claude-backend pipelines (the majority).
- **`--ignore-user-config` regression**: A future refactor that adds MCP forwarding by *removing* `--ignore-user-config` would reintroduce FM-4. Guarded by the trap-door in AC-8.
- **Snapshot staleness (Option D)**: Operators editing a Linear ticket mid-pipeline won't see the update reflected in the snapshot. Document the staleness window in the operator runbook; consider `--refresh-mcp-snapshot` on `setup.js --resume`.

## Why P2 (not P1)

- P1 reserved for pipeline-killer regressions (e.g. R-PHC continue-on-phase-fail, R-PTG worker test gate). MCP gap is a **scope-inversion enabler**, not a process killer: pipelines still complete; they just complete the wrong work when refinement loses information that only the source-of-truth (Linear) preserves.
- P3 too low — LOA-789 shipped 30 useless commits and operator wall-clock cost was hours of triage. This is more expensive than typical P3 ergonomics bugs.
- Pair opportunistically with R-FRA / R-QGSK (the next state-manager/quality-gate touch). Citadel NEW-T6 and R-PTG-7 will both need this *before* they can ship, so R-MFW is a hard prereq for those bundles.

## Implementation order

- **R-MFW-1**: Add `worker_mcp_config_path`, `worker_mcp_snapshot_servers` to `pickle_settings.json` schema and `pickle_settings.json` defaults; document in `pickle-rick-claude/CLAUDE.md` env-var/settings table.
- **R-MFW-2**: Implement Option A (claude `--mcp-config` forwarding) in `buildClaudeWorkerInvocation` + `buildClaudeManagerInvocation`. Unit tests AC-1, AC-2.
- **R-MFW-3**: Investigate codex `-c mcp.servers.*=...` injection feasibility; implement Option B if available, else stub for Option D. Unit test AC-3.
- **R-MFW-4**: Implement Option D snapshot path in `setup.js` for the operator-configured allowlist (default: Linear). Integration test AC-7.
- **R-MFW-5**: Wire MCP forwarding through `spawn-refinement-team.ts` (FR-5). Same forwarding contract as workers.
- **R-MFW-6**: Emit `worker_mcp_config_resolved` activity event from all four invocation builders. Schema entry in `extension/src/types/activity-events.schema.json`. Schema test AC-6.
- **R-MFW-7**: Integration test AC-5 (real claude subprocess against fixture MCP server, gated on `RUN_EXPENSIVE_TESTS=1`).
- **R-MFW-8**: Trap door + ENFORCE wiring in `extension/src/services/CLAUDE.md` (AC-8).
- **R-MFW-followup** (separate PRD): Refinement team inlines full Linear ticket body into `linear_ticket_<hash>.md` frontmatter (Option E). Defense-in-depth against MCP-unavailable execution paths.

## References

- LOA-789 failure session: operator-attached transcript shows `"no Linear MCP access is available in this session"` from codex iter-1 worker output.
- `extension/src/services/backend-spawn.ts:283-357` — four invocation builders, none pass MCP config.
- `extension/src/bin/spawn-morty.ts:466` — only "MCP" mention in extension source, instructional text in prompt only.
- `claude --help` — `--mcp-config <configs...>` is the supported flag; without it, subprocess does NOT inherit parent claude's MCP set.
- `codex exec --help` — `--ignore-user-config` strips `~/.codex/config.toml`.
- `.claude/commands/pickle-standup.md:1,17,20,41` — hard Linear MCP dependency in shipping command prompt.
- Related queued PRDs that hard-depend on this: `prds/citadel-hardening-bundle.md` NEW-T6, `prds/archive/bug-reports/p1-per-ticket-worker-no-test-gate-cross-ticket-regressions.md` R-PTG-7.
