---
title: P2 feature bundle — B-GEMINI — gemini native-CLI (Shape-B) backend
status: Draft
filed: 2026-06-02
priority: P2
type: bug-bundle
code: B-GEMINI
composes:
  - "R-CBI-GEMINI — native-CLI Shape-B backend contract; instance gemini (per prds/archive/features/p2-cli-backend-integration-pattern.md)"
backend_constraint: any
schema_neutral: true   # adds one Backend enum value + state.gemini_model (forward-compatible); no LATEST_SCHEMA_VERSION-breaking change
source:
  - prds/archive/features/p2-cli-backend-integration-pattern.md   # R-CBI contract (C1–C8, INV-SWARM-OFF, INV-MCP-DEFER, INV-TRANSPARENT, per-instance measurement template)
  - prds/MASTER_PLAN.md   # drain row 20 (deferred-integration bucket → promoted on operator backend-depth demand)
---

# B-GEMINI — gemini native-CLI (Shape-B) backend

> Drain-ready instantiation of the **R-CBI contract** (`prds/archive/features/p2-cli-backend-integration-pattern.md`) for the installed **gemini 0.32.1** CLI (`~/.nvm/.../bin/gemini`, Google Gemini CLI). Shape-B = native third-party CLI with a `claude -p`-style one-shot mode, parallel to `codex`/`hermes`/`grok`/`kimi`. **Measure-first** (Working Rule 8): a diagnostic ticket captures the real `--help` surface before the implementation ticket writes the builder. The runtime keeps explicit per-backend `if (backend === 'X')` branches (the audit-enforced trap door in `extension/src/services/CLAUDE.md` — a generic registry is a non-goal). Follows the shipped `grok` + `kimi` (B-CBI v1.93.0) pattern exactly.

## Trigger

MASTER_PLAN drain row 20 (R-CBI-GEMINI). gemini is installed and unwired: `command -v gemini` → `~/.nvm/versions/node/v25.6.1/bin/gemini` (0.32.1); `grep -c "'gemini'" extension/src/services/backend-spawn.ts extension/src/types/index.ts` → 0. Promoted from the deferred-integration bucket on operator backend-depth demand (2026-06-02), the canonical next Shape-B `instances:` entry after grok+kimi.

## Cross-cutting invariants (inherited from R-CBI)

- **INV-SWARM-OFF** — a ticket worker's backend internal swarm is OFF by default; pickle owns orchestration. The measurement (C8) MUST find gemini's sub-agent/swarm surface and the disable flag, and the implementation MUST pass it so a ticket worker runs single-agent. If gemini's swarm is not suppressible, ship worker-only with a documented caveat.
- **INV-MCP-DEFER** — MCP forwarding inherits codex-level isolation; measurement records whether a `--mcp-config`/`--allowed-mcp-server-names` equivalent exists (for a later per-instance R-MFW follow-up, now that B-MFW v1.94.0 shipped).
- **INV-TRANSPARENT** — honest backend identity (`'gemini'`) throughout state, logs, metrics, jar — never masquerade as claude/codex.

## Atomic tickets

> The measurement ticket (GEMINI-1) is **diagnostic-only** and gates the implementation ticket (GEMINI-2). A measurement that finds gemini lacks a required contract capability (C1 one-shot, C5 exit semantics) re-scopes or drops the instance.

### R-CBI-GEMINI-1 (small) — Measure gemini CLI surface *(diagnostic; do first)*
- **Scope:** run `gemini --help` (and subcommand help as needed) on the installed `gemini 0.32.1`. Write `prds/archive/research/r-cbi-gemini-cli-surface.md` (forward-created) with verbatim `--help` output answering contract C1–C8: C1 one-shot/headless flag (candidate `-p`/`--prompt`, `claude -p`-style — confirm), C2 prompt-passing, C3 stream/output envelope spelling (candidate `--output-format json`), C4 `--model` strings (candidates `gemini-2.5-pro`, `gemini-2.5-flash`), C5 exit semantics, C6 `--ignore-user-config`/`--no-config` equiv, C7 auth-failure stderr, C8 native sub-agent/swarm surface + **the exact disable flag** (INV-SWARM-OFF; candidate `--yolo` auto-approve vs sub-agent posture — record precisely).
- **AC-GEMINI-1:** `prds/archive/research/r-cbi-gemini-cli-surface.md` exists with a `## Contract answers` table covering C1–C8, each with verbatim CLI evidence; `grep -cE "C[1-8]" prds/archive/research/r-cbi-gemini-cli-surface.md` ≥ 8. Records the one-shot invocation string + swarm-disable flag (or "none found"), and whether an MCP-injection flag exists (INV-MCP-DEFER note).

### R-CBI-GEMINI-2 (medium) — Implement gemini backend *(depends GEMINI-1)*
- **Scope:** add `'gemini'` to `Backend` + `BACKENDS` (`types/index.ts`); add `buildGeminiWorkerInvocation` mirroring `buildGrokWorkerInvocation` (backend-spawn.ts) using the measured one-shot args + swarm-disable flag; add `resolveGeminiModel` + `state.gemini_model`; wire `--backend gemini` / `PICKLE_BACKEND=gemini`; add a `gemini_binary_missing` ENOENT handler mirroring grok/kimi; reject `--teams` for gemini (non-claude); ensure the 4 spawn sites dispatch gemini via the generic `buildWorkerInvocation(backend)` path; add an output-classification branch if gemini's stdout envelope differs.
- **AC-GEMINI-2-1:** `grep -c "'gemini'" extension/src/types/index.ts` ≥ 2 (Backend + BACKENDS); `buildGeminiWorkerInvocation` + `resolveGeminiModel` present in `backend-spawn.ts`.
- **AC-GEMINI-2-2:** a test (`extension/tests/gemini-backend.test.js` forward-created, mirroring `grok-backend.test.js`) asserts `buildWorkerInvocation('gemini', …)` returns the measured `{cmd:'gemini', args:[…one-shot…, swarm-off]}`; `--teams --backend gemini` is rejected; `gemini_binary_missing` ENOENT path covered.
- **AC-GEMINI-2-3:** the new State field carries an `INVARIANT:` clause in `extension/CLAUDE.md` (the AC-BUNDLE gap B-CBI's closer had to fix-forward — do it in-ticket here); `npm run test:fast` green with the gemini tests.

### C-GEMINI-CLOSER [manager] — Ship B-GEMINI
- **Scope:** FULL release gate from `extension/`, **MINOR** bump (`1.94.0 → 1.95.0`; new `gemini` backend), `bash install.sh`, push, `gh release create`, repoint MASTER_PLAN closing R-CBI-GEMINI (row 20).
- **AC-CLOSER-1:** Full gate GREEN (tsc --noEmit, eslint --max-warnings=-1, tsc, all audit-*.sh, test:fast, test:integration, RUN_EXPENSIVE_TESTS=1 test:expensive) — READ + confirm before bump/tag.
- **AC-CLOSER-2:** `extension/package.json:version` = `1.95.0`; commit subject `chore(C-GEMINI-CLOSER): ship B-GEMINI — bump 1.95.0 + close R-CBI-GEMINI`.
- **AC-CLOSER-3:** `bash install.sh` exits 0; `git status` clean at tag time; compiled JS matches TS.
- **AC-CLOSER-4:** `git push` succeeds; `gh release create v1.95.0` succeeds (verify with `gh release list`).
- **AC-CLOSER-5:** `prds/MASTER_PLAN.md` marks B-GEMINI SHIPPED. Verify: `grep -c "B-GEMINI.*SHIPPED" prds/MASTER_PLAN.md` ≥ 1.

## Acceptance (bundle-level)

- `gemini` is a first-class Shape-B backend (measured surface → builder → wiring → tests), with its internal swarm OFF for ticket workers (INV-SWARM-OFF) and honest identity (INV-TRANSPARENT); release gate green; shipped via `gh release create`; MASTER_PLAN repointed (R-CBI-GEMINI closed). A measurement that drops the instance documents the drop without changing the contract.

— Pickle Rick out. *belch*
