---
title: P2 feature bundle — B-CGRAPH — integrate colbymchenry/codegraph as an opt-in code-intel snapshot for non-claude workers
status: Draft (design via ultracode workflow wf_aaa8652b, 2026-06-03)
filed: 2026-06-03
priority: P2
type: feature-bundle
code: B-CGRAPH
composes:
  - "R-CGRAPH — codegraph (Option-D cli-snapshot) for non-claude backends that get --ignore-user-config and cannot reach the GitNexus live MCP"
backend_constraint: any
schema_neutral: true   # additive pickle_settings fields + new activity events; no LATEST_SCHEMA_VERSION change
source:
  - "https://github.com/colbymchenry/codegraph (MIT, npm @colbymchenry/codegraph, v0.9.9 pre-1.0)"
  - "design workflow wf_aaa8652b-9e6 (10 agents: research + adversarial-verify + surface-map + shape-catalog + 4 design angles + judge + synthesis)"
sequencing:
  - "B-CXOR (codex-orphan-reset P1) MUST land first IF this is ever pipelined on the codex backend"
---

# B-CGRAPH — codegraph integration (Option-D cli-snapshot, opt-in)

## Verdict

**Integrate via cli-snapshot (Option-D), opt-in behind `enable_codegraph_snapshot: false` + a `code_intel_provider` selector defaulting to `'gitnexus'`** — additive, reversible, gated on a one-shot empirical capture of codegraph's `--json` output before the adapter builds. Do NOT make it a pipeline phase; do NOT wire it as a claude MCP server (GitNexus already owns that lane).

## What codegraph is (evidence-bound; UNVERIFIED flagged)

CodeGraph (`colbymchenry/codegraph`, MIT, npm `@colbymchenry/codegraph`) — local-first: tree-sitter AST → on-disk SQLite graph at `.codegraph/codegraph.db` (FTS5 index). Single binary = CLI + library + MCP server.
- **CLI verbs** (commander@^14, documented): `init`, `index`, `sync`, `status`, `query <s>`, `callers <sym>`, `callees <sym>`, **`impact <sym>`**, **`affected [files]`**, `serve --mcp`.
- **Artifacts**: symbols, call/import/inheritance edges, transitive impact radius, and **affected-test-file tracing** (the net-new vs GitNexus's per-symbol slice).
- Search is **FTS5 keyword/structural only — NO embeddings** ("semantic" = AST/structural).
- Maturity: active (pushed 2026-06-03, ~407 commits), MIT, real vitest suite, lean 10-dep tree, **v0.9.9 pre-1.0**. `engines.node ">=20 <25"`; `curl|sh` installer bundles its own Node.

**UNVERIFIED — confirm before the adapter ticket builds:** (1) exact `impact/affected --json` output shape (documented, not byte-verified — the adapter rests on this); (2) host Node-25 vs `engines.node ">=20 <25"` (`npm i -g` may refuse; bundled `curl|sh` sidesteps); (3) MCP tool names (irrelevant — not taking the MCP lane); (4) **benchmark numbers are marketing + internally inconsistent (README 16/58 vs docs 57/71 vs package.json 94/77) — do NOT cite as justification.**

## Why / value over the existing GitNexus integration

For the **claude** backend: **marginal** — GitNexus already serves a live MCP graph (`buildGitNexusMcpConfig`, `spawn-morty.ts:621`).

The real win is **non-claude backends.** codex/grok/kimi spawn with `--ignore-user-config` (`backend-spawn.ts:479`) → no MCP; today they get only a per-worker `npx gitnexus impact` text slice on the worker's timeout budget. codegraph's `affected`/`impact --json` is pre-computed **once at setup**, dropped into a session-root artifact every non-claude worker reads as a plain file — **off the timeout budget**, including affected-test-file tracing GitNexus doesn't pre-compute. That is codegraph earning its place, not duplicating GitNexus.

## Recommended shape + exact attach points

Mirror the Option-D `runMcpSnapshot` precedent (NOT the MCP lane). Three additive surfaces:
1. **`extension/src/services/codegraph-preflight.ts`** (clone `graph-preflight.ts`): `ensureCodegraphIndex(repoRoot, opts?)` with injectable `detectFn`/`installFn`/`indexFn` (like `EnsureGraphOpts`, `graph-preflight.ts:22-26`), `PINNED_CODEGRAPH_VERSION='0.9.9'`, finite timeouts, advisory `{available,degraded,reason,dbPath}` that **never throws** (`graph-preflight.ts:62-65`). New events `codegraph_preflight_completed`/`_degraded`.
2. **Setup snapshot writer** — extend Option-D path `setup.ts:104-147` (the `runMcpSnapshot` loop, `setup.ts:118`); gated `runCodegraphSnapshot` writes `${SESSION_ROOT}/mcp-context/codegraph-impact.json`. Test seam = the existing `McpSnapshotFetchFn` (`setup.ts:90-93`, prod no-op `setup.ts:1410`).
3. **Worker slice** — `buildCodegraphContextSlice(...)` next to `buildGraphContextSlice` (`spawn-morty.ts:690-704`), injected only in the **non-claude branch** of `buildWorkerPrompt` (`spawn-morty.ts:601-607`). Claude branch untouched.

Selector + gates (grafted from runner-up designs):
- `pickle_settings.code_intel_provider: 'gitnexus'|'codegraph'|'both'`, default `'gitnexus'` — the single overlap knob (invalid → falls back to gitnexus).
- `pickle_settings.enable_codegraph_snapshot: bool`, default `false` — kill switch (mirrors `enable_graph_preflight`).
- `--no-codegraph` CLI flag (mirrors `--no-graph`).

## GitNexus overlap resolution

Mutually exclusive by default via `code_intel_provider`: `'gitnexus'` (default) → codegraph paths dead, zero behavior change; `'codegraph'` → non-claude text slice sourced from codegraph snapshot, GitNexus claude MCP lane untouched; `'both'` → only legal pairing is GitNexus-MCP-for-claude + codegraph-snapshot-for-non-claude, with a single-`# GRAPH CONTEXT`-block assertion (never two blocks in one prompt).

## Atomic tickets

- **CG-0 (BLOCKER — do first): empirical `--json` capture.** Run `codegraph init && index` then `impact <sym> --json` + `affected <file> --json` on a throwaway repo; record verbatim stdout schema + the working install path (bundled `curl|sh` vs `npm i -g`) + host Node version into this PRD. **No adapter ticket starts until this lands.**
- **CG-1: `codegraph-preflight.ts` service** — `ensureCodegraphIndex` exported, injectable seams, `PINNED_CODEGRAPH_VERSION==='0.9.9'`, finite `spawnSync` timeouts, returns `degraded:true` (never throws) incl. malformed `--json`, emits the two events; in services Module Export Catalog; `extension/tests/services/codegraph-preflight.test.js` covers success + each degrade path.
- **CG-2: defensive parse + slice builder** — `parseCodegraphImpact(stdout)` returns empty slice (not throw) for non-conforming JSON; formatter caps length; test: garbage → `{slice:'',degraded:true}`.
- **CG-3: setup snapshot writer** — gated `enable_codegraph_snapshot===true && code_intel_provider!=='gitnexus'`; writes `codegraph-impact.json`; best-effort (failure never blocks setup); idempotent except `--resume` past threshold; tested via `McpSnapshotFetchFn` seam.
- **CG-4: non-claude worker prompt injection** — `buildCodegraphContextSlice` only in non-claude branch; claude branch unchanged; `'both'` → exactly one `# GRAPH CONTEXT` block; snapshot test claude vs codex under each provider.
- **CG-5: settings + flags** — `code_intel_provider` default `'gitnexus'`, `enable_codegraph_snapshot` default `false`, `--no-codegraph`, invalid value → gitnexus; no `LATEST_SCHEMA_VERSION` bump.
- **CG-6: skill + docs** — `.claude/skills/codegraph/` + README per the Documentation Rule. No pipeline phase.
- **C-CGRAPH-CLOSER [manager]** — full gate, MINOR bump (new events/settings), install.sh, push, release, MASTER_PLAN repoint.

## Risks

UNVERIFIED `--json` schema (highest — CG-0 gates it; defensive-degrade contains it) · Node-25 install friction (prefer bundled `curl|sh`) · pre-1.0 CLI instability (hard-pin + degrade) · two on-disk indexes under `'both'` (confirm `.codegraph/` gitignored) · benchmark claims are marketing (justification is the architectural gap, not percentages).

## Sequencing

1. **B-CXOR (codex-orphan-reset P1) first** if ever pipelined on codex. 2. CG-0 (blocker). 3. CG-1→CG-2. 4. CG-5. 5. CG-3→CG-4. 6. CG-6. Ship default-off; flip on per-session for codex/grok/kimi once CG-0 confirms the schema.

— Pickle Rick out. *belch*
