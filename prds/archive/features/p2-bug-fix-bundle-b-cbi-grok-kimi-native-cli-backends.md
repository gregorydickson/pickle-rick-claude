---
title: P2 feature bundle — B-CBI — grok + kimi native-CLI (Shape-B) backends
status: Draft
filed: 2026-06-02
priority: P2
type: bug-bundle
code: B-CBI
composes:
  - "R-CBI — native-CLI Shape-B backend contract; instances grok + kimi (per prds/archive/features/p2-cli-backend-integration-pattern.md)"
backend_constraint: any
schema_neutral: true   # adds new Backend enum values + state fields (forward-compatible); no LATEST_SCHEMA_VERSION-breaking change
source:
  - prds/archive/features/p2-cli-backend-integration-pattern.md   # R-CBI contract (C1–C8, INV-SWARM-OFF, INV-MCP-DEFER, per-instance measurement template)
  - prds/MASTER_PLAN.md   # drain row 17
---

# B-CBI — grok + kimi native-CLI (Shape-B) backends

> Drain-ready instantiation of the **R-CBI contract** (`prds/archive/features/p2-cli-backend-integration-pattern.md`) for two installed CLIs: **grok 0.2.17** (`~/.local/bin/grok`, xAI Grok Build) and **kimi 1.38.0** (`~/.local/bin/kimi`, MoonshotAI). Shape-B = native third-party CLI with a `claude -p`-style one-shot mode, parallel to `codex`/`hermes`. Each instance is **measure-first** (Working Rule 8): a diagnostic ticket captures the real `--help` surface before the implementation ticket writes the builder. The runtime keeps explicit per-backend `if (backend === 'X')` branches (the audit-enforced trap door in `extension/src/services/CLAUDE.md` — a generic registry is a non-goal).

## Trigger

MASTER_PLAN drain row 17 (R-CBI, grok + kimi). Both CLIs are installed and unwired (`grep "'grok'|'kimi'" extension/src/services/backend-spawn.ts extension/src/types/index.ts` → 0). Follows the shipped `hermes` (B-HERMES) and `deepseek` (B-DSEK v1.92.0) backend pattern.

## Cross-cutting invariants (inherited from R-CBI — apply to BOTH instances)

- **INV-SWARM-OFF** — a ticket worker's backend internal swarm is OFF by default; pickle owns orchestration. Each instance's measurement (C8) MUST find the disable flag and the implementation MUST pass it so a ticket worker runs single-agent. If a CLI's swarm is not suppressible, that instance ships worker-only with a documented caveat (or is dropped — does NOT change the contract).
- **INV-MCP-DEFER** — MCP forwarding out of scope; inherit codex-level isolation. Measurement records whether a `--mcp-config` equivalent exists (for the later per-instance follow-up).
- **INV-TRANSPARENT** — honest backend identity (`'grok'` / `'kimi'`) throughout state, logs, metrics, jar — never masquerade as claude/codex.

## Atomic tickets

> Each instance's measurement ticket (X-1) is **diagnostic-only** and gates its implementation ticket (X-2). A measurement that finds the CLI lacks a required contract capability (C1 one-shot, C5 exit semantics) re-scopes or drops THAT instance without blocking the other.

### R-CBI-GROK-1 (small) — Measure grok CLI surface *(diagnostic; do first for grok)*
- **Scope:** run `grok --help` (and subcommand help as needed) on the installed `grok 0.2.17`. Write `prds/archive/research/r-cbi-grok-cli-surface.md` (forward-created) with verbatim `--help` output answering contract C1–C8: C1 one-shot/headless flag (operator-reported `--output-format streaming-json`, `claude -p`-style — confirm), C2 prompt-passing, C3 stream/output envelope spelling, C4 `--model` strings (candidate `grok-code-fast-1`), C5 exit semantics, C6 `--ignore-user-config` equiv, C7 auth-failure stderr, C8 native-swarm surface + **the exact disable flag** (INV-SWARM-OFF).
- **AC-GROK-1:** `prds/archive/research/r-cbi-grok-cli-surface.md` exists with a `## Contract answers` table covering C1–C8, each with verbatim CLI evidence; `grep -cE "C[1-8]" prds/archive/research/r-cbi-grok-cli-surface.md` ≥ 8. Records the one-shot invocation string + swarm-disable flag (or "none found").

### R-CBI-GROK-2 (medium) — Implement grok backend *(depends GROK-1)*
- **Scope:** add `'grok'` to `Backend` + `BACKENDS` (`types/index.ts`); add `buildGrokWorkerInvocation` mirroring `buildHermesWorkerInvocation` (backend-spawn.ts) using the measured one-shot args + swarm-disable flag; wire `--backend grok` / `PICKLE_BACKEND=grok` + `state.grok_model`; reject `--teams` for grok (non-claude); ensure the 4 spawn sites dispatch grok via the generic `buildWorkerInvocation(backend)` path; add output-classification branch if grok's stdout differs.
- **AC-GROK-2-1:** `grep -c "'grok'" extension/src/types/index.ts` ≥ 2 (Backend + BACKENDS); `buildGrokWorkerInvocation` present in `backend-spawn.ts`.
- **AC-GROK-2-2:** a test (`extension/tests/grok-*.test.js` forward-created) asserts `buildWorkerInvocation('grok', …)` returns the measured `{cmd:'grok', args:[…one-shot…, swarm-off]}`; `--teams --backend grok` is rejected.
- **AC-GROK-2-3:** `npm run test:fast` green with the grok tests.

### R-CBI-KIMI-1 (small) — Measure kimi CLI surface *(diagnostic; do first for kimi)*
- **Scope:** run `kimi --help` on the installed `kimi 1.38.0`. Write `prds/archive/research/r-cbi-kimi-cli-surface.md` (forward-created) answering C1–C8 with verbatim evidence — especially C8 (kimi K2.5/K2.6 ships an **Agent Swarm**; record scale, client- vs server-side, worktree behavior, and the disable flag per INV-SWARM-OFF; if the swarm is server-side/opaque and not suppressible, note that grok worker-only path or Shape-D research-delegate consideration).
- **AC-KIMI-1:** `prds/archive/research/r-cbi-kimi-cli-surface.md` exists with the `## Contract answers` C1–C8 table + verbatim evidence; `grep -cE "C[1-8]" …` ≥ 8; explicitly records the swarm posture + disable flag.

### R-CBI-KIMI-2 (medium) — Implement kimi backend *(depends KIMI-1)*
- **Scope:** add `'kimi'` to `Backend`+`BACKENDS`; `buildKimiWorkerInvocation` from the measured surface (with swarm OFF per INV-SWARM-OFF); wire `--backend kimi` + `state.kimi_model`; reject `--teams`; generic dispatch at the 4 spawn sites; output-classification branch if needed. If KIMI-1 finds the swarm non-suppressible, implement worker-only single-agent with the documented caveat.
- **AC-KIMI-2-1:** `grep -c "'kimi'" extension/src/types/index.ts` ≥ 2; `buildKimiWorkerInvocation` present.
- **AC-KIMI-2-2:** a test asserts `buildWorkerInvocation('kimi', …)` returns the measured invocation with the swarm-disable flag; `--teams --backend kimi` rejected.
- **AC-KIMI-2-3:** `npm run test:fast` green with the kimi tests.

### C-CBI-CLOSER [manager] — Ship B-CBI
- **Scope:** FULL release gate from `extension/`, **MINOR** bump (`1.92.2 → 1.93.0`; new `grok`+`kimi` backends), `bash install.sh`, push, `gh release create`, repoint MASTER_PLAN closing R-CBI (row 17).
- **AC-CLOSER-1:** Full gate GREEN (tsc --noEmit, eslint --max-warnings=-1, tsc, all audit-*.sh, test:fast, test:integration, RUN_EXPENSIVE_TESTS=1 test:expensive) — READ + confirm before bump/tag.
- **AC-CLOSER-2:** `extension/package.json:version` = `1.93.0`; commit subject `chore(C-CBI-CLOSER): ship B-CBI — bump 1.93.0 + close R-CBI (grok+kimi)`.
- **AC-CLOSER-3:** `bash install.sh` exits 0; `git status` clean at tag time; compiled JS matches TS.
- **AC-CLOSER-4:** `git push` succeeds; `gh release create v1.93.0` succeeds (verify with `gh release list`).
- **AC-CLOSER-5:** `prds/MASTER_PLAN.md` marks B-CBI SHIPPED. Verify: `grep -c "B-CBI.*SHIPPED" prds/MASTER_PLAN.md` ≥ 1.

## Acceptance (bundle-level)

- `grok` and `kimi` are first-class Shape-B backends (measured surface → builder → wiring → tests), each with its internal swarm OFF for ticket workers (INV-SWARM-OFF) and honest identity (INV-TRANSPARENT); release gate green; shipped via `gh release create`; MASTER_PLAN repointed (R-CBI closed). A measurement that drops one instance ships the other + documents the drop.

— Pickle Rick out. *belch*
