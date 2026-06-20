# PRD: Pipeline Graph Intelligence (GitNexus Embedding)

- **Epic code:** R-PGI
- **Priority:** P2
- **Date:** 2026-05-21
- **Status:** Draft (pending refinement)
- **Target repo:** `pickle-rick-claude` (`extension/src/`, `.claude/commands/`)
- **Related:** `prds/archive/features/p2-proportional-intent-aware-pipeline-2026-05-21.md` (R-PIAP) —
  R-PGI's graph-query layer is an optional input to R-PIAP's tier classifier
  (R-PIAP-A5); the coupling is one-directional and non-blocking.

## Problem Statement

The pipeline flies blind on code structure. Workers explore via raw `Grep`/`Glob`,
plan changes without knowing blast radius, and the refinement team sizes tickets
on keyword heuristics with no dependency data. A code-graph (GitNexus) would
sharpen research, planning, ticket sizing, and scope-fencing — but the existing
GitNexus "integration" is **wired on paper and dead in practice**, across three
broken layers:

1. **The prompt layer fires conditionally on a missing artifact.**
   `spawn-morty.ts:474` adds a `# GITNEXUS CODE INTELLIGENCE` block to the
   worker prompt — but only when `hasGitNexusIndex(repoRoot)` finds a
   `.gitnexus/` directory. No pipeline stage ever *creates* that directory, so
   the block never fires.

2. **The CLI is not installed and cannot be relied upon.**
   `which gitnexus` returns nothing. `npx gitnexus@latest` fails on Node 25
   (`Cannot destructure property 'package' of 'node.target'`). Nothing in the
   pipeline runs `gitnexus analyze`.

3. **The MCP server is disabled and mis-pathed, and workers never receive it.**
   `~/.claude.json` defines a `gitnexus` MCP server but lists it in
   `disabledMcpServers`; the project-scoped copy points at a stale path
   (`loanlight/pickle-rick-claude`, while the repo is at
   `loanlight/pickle-rick/pickle-rick-claude`). `spawn-morty.ts` never passes
   `--mcp-config` to spawned workers — the worker tool inventory contains
   `linear` + `chrome-devtools` MCP only, never `gitnexus`.

**Net:** the pipeline contains an instruction to use tools that are disabled,
uninstallable, mis-pathed, and unindexed.

### Capability split (decisive constraint)

The GitNexus **CLI** (`analyze`/`status`/`clean`/`wiki`/`list`) only **builds and
manages** the index — it **cannot query** the graph. The intelligence tools
(`query`/`context`/`impact`/`detect_changes`/`cypher`) are **MCP-only**. The CLI
writes `.gitnexus/`; the MCP server reads it. `gitnexus analyze` additionally
**regenerates the repo's `CLAUDE.md`/`AGENTS.md`** from the graph — graph-derived
text context that every worker auto-loads regardless of backend, with no MCP.

| Job | Tool | Current status |
|---|---|---|
| Build / refresh the graph (`.gitnexus/`) | **CLI** `gitnexus analyze` | never run |
| Graph-derived `CLAUDE.md`/`AGENTS.md` context | **CLI** (side effect of `analyze`) | never produced |
| Query the graph (`impact`/`context`/`cypher`) | **MCP** | disabled, not provisioned |

## Goals

- A **graph-preflight** stage that ensures GitNexus is installed and the graph
  is fresh before refinement, the build, and each hardening phase.
- The preflight **degrades gracefully** — install or analyze failure logs a
  warning and the pipeline continues without the graph; never a hard block.
- Workers consume graph intelligence through a **pickle-rick-owned path**
  (direct `.gitnexus/` read), backend-agnostic — not dependent on Claude MCP
  plumbing — with MCP-for-claude as a documented fallback.
- Ticket sizing, research, and planning get real structural data instead of
  keyword guesses.

## Non-Goals

- Reimplementing GitNexus or its graph builder.
- Generating wikis (`gitnexus wiki`).
- Embedding-based semantic search (`analyze --embeddings`).
- Changing the 4-phase pipeline orchestration.

## Locked Design Decisions

| Decision | Choice |
|---|---|
| Build mechanism | **CLI** `gitnexus analyze` in a preflight stage |
| Install strategy | **Preflight auto-installs a pinned, verified version** if absent |
| Reindex cadence | **Before each entry point** — refinement, build, each hardening phase |
| Worker consumption | **Direct `.gitnexus/` read** (target, backend-agnostic); MCP-for-claude is the documented fallback if the format spike (R-PGI-5) proves it infeasible |
| Failure mode | **Graceful degradation** — never block the pipeline on GitNexus |

## Architecture

A shared **`graph-preflight`** module (`extension/src/services/graph-preflight.ts`)
exposes one entry point, `ensureGraph(repoRoot, opts)`, returning a
`GraphPreflightResult`, that **never throws**. It:

1. Detects whether the `gitnexus` CLI is available; installs the pinned version
   if not.
2. Runs `gitnexus analyze` against `repoRoot` (refresh per cadence).
3. Returns `{ available, indexPath, symbolCount, staleness, degraded, reason }`.

Every entry point calls `ensureGraph` before doing work. Consumption is staged:
the preflight (R-PGI-1..4) is independently shippable and valuable on its own
(it refreshes the graph-derived `CLAUDE.md`/`AGENTS.md` every worker loads); the
direct-read query layer (R-PGI-6..7) is gated on the format spike (R-PGI-5).

## Requirements

**R-PGI-1 — `graph-preflight` module.**
Add `extension/src/services/graph-preflight.ts` exposing `ensureGraph`. It never
throws; every failure path resolves to `{ available: false, degraded: true,
reason }`. All external commands run under an explicit `spawnSync` timeout (per
the repo's trap-door invariant). Emits a `graph_preflight_completed` activity
event with the result.

**R-PGI-2 — Wire the preflight into entry points.**
`ensureGraph` is invoked before work in: `spawn-refinement-team.ts` (before
refinement), the `/pickle` + `/pickle-tmux` build setup path (`setup.ts`), and
`pipeline-runner.ts` before **each** hardening phase (citadel, anatomy-park,
szechuan-sauce). A `--no-graph` flag and an `enable_graph_preflight`
`pickle_settings.json` key allow opt-out.

**R-PGI-3 — Pinned auto-install.**
When the CLI is absent, the preflight installs a **pinned, verified** GitNexus
version (recorded as a constant / `pickle_settings.json` key — not `@latest`,
which broke on Node 25). The install runs once per host and is cached;
subsequent runs detect the existing binary and skip install.

**R-PGI-4 — Graceful degradation contract.**
If install or `analyze` fails, the preflight logs a single structured warning,
emits `graph_preflight_degraded`, and returns `degraded: true`. All downstream
consumers treat `available: false` as "no graph" and proceed normally.
`hasGitNexusIndex()` remains the gate for the worker-prompt block.

**R-PGI-5 — `.gitnexus/` format research spike.**
Run `gitnexus analyze` on a real repo and characterize the `.gitnexus/` store:
storage engine (SQLite / embedded graph DB / JSON), schema stability, and
whether pickle-rick can read it directly without the MCP server. Output: a
written finding that decides R-PGI-6's implementation path. **Gates R-PGI-6/7.**

**R-PGI-6 — Graph-query layer.**
*If R-PGI-5 finds `.gitnexus/` directly readable:* add
`extension/src/services/graph-query.ts` with backend-agnostic functions —
`getImpact(symbol)`, `getContext(symbol)`, `getClusters()`,
`getProcessTrace(name)` — reading `.gitnexus/` directly.
*If the spike finds the format unstable/opaque:* fall back to provisioning the
`gitnexus` MCP server to claude-backend workers (`spawn-morty.ts` passes
`--mcp-config`), and document that codex-backend workers receive only the
`analyze`-refreshed text context.

**R-PGI-7 — Per-ticket graph context injection.**
Once a ticket's scope is known, inject a compact impact/dependency slice into
the worker prompt — callers, callees, blast radius of the symbols the ticket
modifies. The worker-prompt block at `spawn-morty.ts:474` is updated to describe
the available path accurately rather than naming MCP tools unconditionally.

**R-PGI-8 — Refinement & sizing consume the graph.**
`spawn-refinement-team.ts` passes graph data (cluster membership, symbol
fan-out) to the analysts, and exposes it to the R-PIAP-A5 tier classifier as an
**optional** input: a ticket touching a high-fan-out symbol sizes up. The
classifier MUST still function with `available: false` (heuristics-only).

**R-PGI-9 — Documentation.**
`README.md` documents the graph-preflight stage, the `--no-graph` flag, the
`enable_graph_preflight` setting, and the degradation behavior.

## Acceptance Criteria

- **AC-PGI-1-1:** A unit test asserts `ensureGraph` returns `degraded: true`
  (never throws) when the `gitnexus` binary is absent and install is stubbed to fail.
- **AC-PGI-1-2:** A test asserts every `spawnSync`/`spawn` call in
  `graph-preflight.ts` passes an explicit `timeout`.
- **AC-PGI-1-3:** A test asserts a `graph_preflight_completed` activity event is
  written and validates against `activity-events.schema.json`.
- **AC-PGI-2-1:** Tests assert `ensureGraph` is invoked before work in
  `spawn-refinement-team.ts`, the build setup path, and before each hardening
  phase in `pipeline-runner.ts`.
- **AC-PGI-2-2:** A test asserts `--no-graph` / `enable_graph_preflight: false`
  skips the preflight entirely.
- **AC-PGI-3-1:** A test asserts the install command targets a pinned version
  string, never `@latest`.
- **AC-PGI-4-1:** An integration test asserts a pipeline run completes normally
  when `gitnexus` is unavailable (degraded preflight), and that the worker
  prompt contains **no** GitNexus block in that run.
- **AC-PGI-5-1:** The spike produces a written finding stating the `.gitnexus/`
  format and the chosen R-PGI-6 path.
- **AC-PGI-6-1:** The chosen consumption path has a test: direct-read functions
  return expected nodes/edges for a fixture index, **or** the MCP fallback test
  asserts `spawn-morty.ts` passes a `gitnexus` `--mcp-config` to claude workers.
- **AC-PGI-7-1:** A test asserts a ticket with known scope receives an
  impact/dependency slice in its worker prompt when the graph is available.
- **AC-PGI-8-1:** A test asserts the R-PIAP-A5 tier classifier produces a valid
  tier with graph input `available: false` (heuristics-only fallback intact).

## Affected Surfaces

| File | Change |
|---|---|
| `extension/src/services/graph-preflight.ts` *(new)* | `ensureGraph`, install, analyze, degradation |
| `extension/src/services/graph-query.ts` *(new, R-PGI-6 path-dependent)* | direct `.gitnexus/` read |
| `extension/src/bin/spawn-refinement-team.ts` | call preflight; feed graph to analysts + classifier |
| `extension/src/bin/setup.ts` | call preflight before the build |
| `extension/src/bin/pipeline-runner.ts` | call preflight before each hardening phase |
| `extension/src/bin/spawn-morty.ts` | per-ticket graph slice injection; correct the `:474` prompt block |
| `extension/src/types/index.ts` + `activity-events.schema.json` | `graph_preflight_completed` / `graph_preflight_degraded` events |
| `pickle_settings.json` | `enable_graph_preflight`, pinned-version key |
| `README.md` | document the preflight stage and flags |

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `gitnexus` install is flaky (already failed on Node 25) | Pinned verified version; install once and cache; graceful degradation means a failed install never blocks a run |
| `.gitnexus/` format is opaque or unstable | R-PGI-5 spike decides before R-PGI-6 is built; MCP-for-claude is the pre-agreed fallback |
| Graph goes stale mid-phase (16 tickets land during pickle) | Per-entry-point reindex refreshes before each hardening phase; intra-pickle staleness is accepted |
| `analyze` is slow on large repos | `--no-graph` opt-out; preflight runs once per phase, not per ticket; analyze is incremental unless `--force` |
| GitNexus regenerates `CLAUDE.md` and clobbers hand-written content | The spike must confirm `analyze`'s `CLAUDE.md` behavior; if it overwrites, pin GitNexus output to `AGENTS.md` only or a separate file |

## Out of Scope

- `gitnexus wiki` generation and embedding-based semantic search.
- Mutating the user's `~/.claude.json` (the stale path + `disabledMcpServers`
  entry) — noted as a known issue, relevant only if the MCP fallback path is taken.
- Multi-repo graph federation across the `loanlight/` workspace.

## Sequencing

1. **R-PGI-1 to R-PGI-4** (preflight + degradation) — independently shippable;
   delivers the `analyze`-refreshed `CLAUDE.md`/`AGENTS.md` context to all
   workers with zero MCP.
2. **R-PGI-5** (format spike) — gates the consumption layer.
3. **R-PGI-6 to R-PGI-8** (query layer, injection, sizing) — built on the spike's verdict.
4. **R-PGI-9** (docs) — alongside each shipped stage.
