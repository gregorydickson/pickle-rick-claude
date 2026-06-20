---
title: P2 feature bundle — B-MFW — forward MCP servers into Morty worker / refinement subprocesses
status: Draft
filed: 2026-06-02
priority: P2
type: bug-bundle
code: B-MFW
composes:
  - "R-MFW — workers/managers/refinement subprocesses spawned by pickle-rick-claude have NO MCP access (Linear-blindness); now unblocked since R-CBI shipped v1.93.0"
backend_constraint: any
schema_neutral: true   # adds pickle_settings fields + a new activity event + --mcp-config forwarding (forward-compatible); no LATEST_SCHEMA_VERSION change
source:
  - prds/archive/bug-reports/p2-mcp-forwarding-to-workers.md   # AUTHORITATIVE spec: FR-1..5, AC-1..9, ranked Options A–E, implementation order R-MFW-1..7
  - prds/MASTER_PLAN.md   # deferred-integration bucket → promoted on operator backend-depth demand 2026-06-02
---

# B-MFW — forward MCP servers into Morty worker / refinement subprocesses

> Drain-ready instantiation of **R-MFW** (`prds/archive/bug-reports/p2-mcp-forwarding-to-workers.md` — the authoritative spec; FR-1..5, AC-1..9, ranked Options A–E). Every backend shipped to date (claude/codex/hermes/deepseek/grok/kimi) spawns ticket workers, managers, and refinement analysts with **no MCP access** — a worker told to "implement LOA-789" cannot read the Linear ticket to recover dropped specificity (worked example: the codex iter-1 transcript that states verbatim *"no Linear MCP access is available in this session"*). This was deliberately gated on **R-MFW + R-CBI both shipping**; R-CBI shipped **v1.93.0**, so R-MFW is now unblocked. It is orthogonal to which new CLI we add next — it improves all six existing backends at once.

## Trigger

Promoted from the deferred-integration bucket on operator backend-depth demand (2026-06-02). Unblocked: `grep -c "buildKimiWorkerInvocation\|buildGrokWorkerInvocation" extension/src/services/backend-spawn.ts` ≥ 2 confirms R-CBI landed. Currently `grep -c "mcp-config" extension/src/services/backend-spawn.ts` → 0 (no forwarding exists).

## Root cause (per source PRD — confirm in research)

Worker/manager invocations are built by `build*WorkerInvocation` / `build*ManagerInvocation` in `backend-spawn.ts`. The claude path never passes `--mcp-config`; the codex path passes `--ignore-user-config` (which also suppresses MCP). Refinement analysts inherit the same MCP-blind spawn. So no subprocess can reach the operator's authenticated MCP servers (Linear, etc.), and a worker's last escape hatch when refinement drops detail — fetch the source-of-truth ticket directly — is unreachable.

## Cross-cutting invariants

- **INV-SANDBOX-JUDGE** — judges stay sandboxed: `buildJudgeInvocation` (claude AND codex) MUST NOT gain `--mcp-config` or codex MCP injection (AC-4). MCP forwarding is for workers/managers/refinement only.
- **INV-IGNORE-USER-CONFIG** — the codex `--ignore-user-config` flag is NEVER removed to add MCP (Option C is REJECTED — it reintroduces FM-4). Codex MCP arrives via `-c` injection (Option B) or the snapshot fallback (Option D), guarded by the AC-8 trap door.
- **INV-MCP-OPT-IN** — forwarding is operator-opt-in via `pickle_settings.json::worker_mcp_config_path` (a subset of the operator's MCP config — read-only Linear, no Slack-write, etc.); the flag is OMITTED entirely when no MCP config resolves at any precedence layer (no `--mcp-config undefined`).

## Atomic tickets

> Each ticket's research phase MUST confirm the exact call site + the chosen Option before editing. The source PRD's AC-1..9 are the conformance bar.

### R-MFW-1 (small) — settings schema + defaults
- **Scope:** add `worker_mcp_config_path` (string, optional) and `worker_mcp_snapshot_servers` (string[], default `[]`) to the `pickle_settings.json` schema + defaults; document in `pickle-rick-claude/CLAUDE.md` settings table. Edit source `pickle_settings.json`, not the deployed copy.
- **AC-MFW-1:** the two fields exist in source `pickle_settings.json` + its schema; `grep -c "worker_mcp_config_path" pickle_settings.json` ≥ 1; CLAUDE.md settings table documents both.

### R-MFW-2 (medium) — claude `--mcp-config` forwarding (Option A, PREFERRED)
- **Scope:** in `buildClaudeWorkerInvocation` + `buildClaudeManagerInvocation` (`backend-spawn.ts`), resolve the MCP config via precedence [`pickle_settings.worker_mcp_config_path` → `~/.claude.json` if present → omit] and append `--mcp-config <resolved>` when one resolves; omit cleanly when none.
- **AC-MFW-2:** satisfies source **AC-1** (override path) + **AC-2** (default precedence + clean omission) — unit tests in `extension/tests/services/backend-spawn-mcp.test.js` (forward-created).

### R-MFW-3 (medium) — codex MCP injection (Option B; Option D stub fallback)
- **Scope:** research codex `-c mcp.servers.*=…` (or `--config`) injection feasibility WITHOUT removing `--ignore-user-config`; implement Option B if the surface supports it, else stub the hook so Option D (R-MFW-4) covers codex. Keep `--ignore-user-config` (INV-IGNORE-USER-CONFIG).
- **AC-MFW-3:** satisfies source **AC-3** — `buildCodexInvocation` still includes `--ignore-user-config` AND the resolved codex MCP-injection mechanism (or a documented Option-D-fallback stub). Unit test.

### R-MFW-4 (medium) — setup-time MCP snapshot (Option D, FR-4)
- **Scope:** at `setup.js` session-init, for each server in `worker_mcp_snapshot_servers` (default-allowlist Linear), snapshot the relevant fetched data into `${SESSION_ROOT}/mcp-context/<server>.json` (e.g. `mcp__plugin_linear_linear__get_issue(<ticket-id>)` → `linear-ticket.json`); once per session, refresh on `--resume` only if older than 24h. Workers can read these even without live MCP.
- **AC-MFW-4:** satisfies source **AC-7** — integration test `extension/tests/integration/mcp-snapshot.test.js` (forward-created) asserts `${SESSION_ROOT}/mcp-context/linear-ticket.json` exists with valid JSON containing the ticket title + description.

### R-MFW-5 (small) — refinement subprocess forwarding (FR-5)
- **Scope:** wire the same MCP-forwarding contract through `spawn-refinement-team.ts` (refinement is force-claude, so Option A applies directly). Analysts can read Linear when resolving ambiguous enumerations — closing the LOA-789 loss mode at its origin.
- **AC-MFW-5:** refinement-analyst invocation includes `--mcp-config <resolved>` when one resolves; covered by a unit test asserting the refinement spawn path forwards MCP.

### R-MFW-6 (small) — `worker_mcp_config_resolved` activity event
- **Scope:** emit `worker_mcp_config_resolved` exactly once per worker/manager/refinement spawn from the invocation builders; add the schema entry in `extension/src/types/activity-events.schema.json`.
- **AC-MFW-6:** satisfies source **AC-6** — event emitted once per spawn AND passes the schema check in `extension/tests/activity-event-payload.test.js`.

### R-MFW-7 (medium) — real-subprocess MCP integration test + trap door
- **Scope:** add the AC-5 integration test (real `claude -p` worker against a fixture MCP config registering a synthetic echo MCP; worker invokes it and writes the response to `${SESSION_ROOT}/<ticket>/mcp-probe.txt`); add the AC-8 trap door in `extension/src/services/CLAUDE.md` for `backend-spawn.ts` (invariant: worker/manager invocations MUST include MCP forwarding when an MCP config is resolvable; PATTERN_SHAPE `--mcp-config` literal in `buildClaudeWorkerInvocation`; ENFORCE → AC-1/2/3/4).
- **AC-MFW-7-1:** satisfies source **AC-5** — `extension/tests/integration/worker-mcp-access.test.js` (forward-created, gated on `RUN_EXPENSIVE_TESTS=1`) passes.
- **AC-MFW-7-2:** satisfies source **AC-8** — trap door present + enforced by `audit-trap-door-enforcement.sh`.

### C-MFW-CLOSER [manager] — Ship B-MFW
- **Scope:** FULL release gate from `extension/`, **MINOR** bump (`1.93.0 → 1.94.0`; new settings fields + new `worker_mcp_config_resolved` event + `--mcp-config` forwarding surface — forward-compatible, schema-neutral), `bash install.sh`, push, `gh release create`, repoint MASTER_PLAN closing R-MFW.
- **AC-CLOSER-1:** Full gate GREEN (tsc --noEmit, eslint --max-warnings=-1, tsc, all audit-*.sh, test:fast, test:integration, RUN_EXPENSIVE_TESTS=1 test:expensive) — READ + confirm before bump/tag. (Satisfies source **AC-9** + the expensive AC-5 tier.)
- **AC-CLOSER-2:** `extension/package.json:version` = `1.94.0`; commit subject `chore(C-MFW-CLOSER): ship B-MFW — bump 1.94.0 + close R-MFW`.
- **AC-CLOSER-3:** `bash install.sh` exits 0; `git status` clean at tag time; compiled JS matches TS.
- **AC-CLOSER-4:** `git push` succeeds; `gh release create v1.94.0` succeeds (verify with `gh release list`).
- **AC-CLOSER-5:** `prds/MASTER_PLAN.md` marks B-MFW SHIPPED. Verify: `grep -c "B-MFW.*SHIPPED" prds/MASTER_PLAN.md` ≥ 1.

## Acceptance (bundle-level)

- Worker/manager/refinement subprocesses receive operator-opt-in MCP forwarding (claude `--mcp-config`; codex `-c` injection or snapshot fallback; refinement force-claude path) with judges still sandboxed (INV-SANDBOX-JUDGE) and `--ignore-user-config` intact (INV-IGNORE-USER-CONFIG); the `worker_mcp_config_resolved` event + AC-8 trap door land; the LOA-789 Linear-blindness loss mode is closed at the refinement origin; release gate green; shipped via `gh release create`; MASTER_PLAN repointed (R-MFW closed). Unblocks the citadel NEW-T6 Linear-integration + R-PTG-7 work that was hard-blocked on this.

— Pickle Rick out. *belch*
