# Codegraph Hardening → Default-On (B-CGH) — 2026-06-14 *(refined)*

**Status:** REFINED — build via `/pickle-pipeline`. Start commit: `afdce5ec`.
**Goal:** harden the v2.0 codegraph integration so it can ship **default-ON** with confidence — instrument it for efficacy, validate efficacy with a controlled A/B, harden cost + degradation, then flip the default **only if the measurement earns it**.
**Backend:** claude (control-flow + settings + test edits; not codex).

*(refined: requirements + codebase + risk-scope analysts, 3 cycles, session 2026-06-14-a0321981)*

## Why now

Codegraph (`@colbymchenry/codegraph@0.9.9`, pinned exact at `extension/package.json:42`) shipped in **v2.0.0-beta.3**, is **genuinely wired** but **default-OFF and never exercised in a real pipeline** — efficacy unproven. This bundle measures it, then turns it on if the measurement is non-negative.

**HEAD-verified wiring (2026-06-14, commit `afdce5ec`):**
- `extension/src/bin/setup.ts` `runCodegraphIndexAtSetup` (`:198`) — indexes the repo at session start; awaited fail-open at `:1699`; early-returns unless `enabled && index_at_setup`; honors `PICKLE_CODEGRAPH=off`. `cgResolveIndexAction` (`:168`) returns `'full' | 'sync' | 'noop'` (`:172`) — **there is no `'index'` member**.
- `extension/src/bin/spawn-morty.ts` `buildCodegraphContextSection` (`:717`) — injects a `## Code Graph Context` block into the worker prompt; **never throws**. Interface `CodegraphContextOptions` (`:646-652`) is exactly `{tier, title, ticketContent, service, settings}` — **no emit hook, no sessionDir, no ticketId**. Four `return ''` sites: `:719` (`!settings.enabled || !service || !tierUsesGraphContext(tier)` — collapses THREE conditions), `:722` (`terms.length === 0`), `:725` (`ranked.length === 0`), `:729` (`entries.length === 0`). Success return `:731` (`renderCodegraphSection(...)`).
- `extension/src/services/backend-spawn.ts` — wires `codegraph serve --mcp` for workers, but `buildWorkerMcpConfig` hard short-circuits `if (settings?.expose_mcp_to_workers !== true) return passthrough();` (`:479`). **`expose_mcp_to_workers` stays `false` this bundle**, so the `serve --mcp` handshake never runs under this flip.
- `extension/src/services/pickle-utils.ts` `resolveCodegraphSettings` (`:794`) — compiled defaults `enabled:false`, `index_at_setup:false`, `expose_mcp_to_workers:false`.
- Activity primitive in scope at the inject call site is `writeActivityEntry` (`spawn-morty.ts:34`), which **does NOT auto-stamp `ts`** (unlike `logActivity`) — the iter-7/8/9 + R-CCPM-1 regression class.
- Existing events `codegraph_index_built` / `_index_failed` / `_sync_completed` / `_degraded` / `_session_summary` are functional telemetry; **none measures efficacy**. `codegraph_index_built` already carries `gate_payload.{files_indexed, duration_ms}` (`activity-events.schema.json:1488-1502`); the comment at `src/types/index.ts:990-991` saying these have "no dedicated payload" is **stale and wrong**.

## Sequencing & Flip Gate (CORRECTED — the load-bearing structural fix)

**CGH-1 is NOT a CGH-6 predecessor.** It hardens the `serve --mcp` handshake, which is gated on `expose_mcp_to_workers` (`backend-spawn.ts:479`) — kept `false` this bundle. A flaky CGH-1 must not block this flip; a green CGH-1 does not authorize it. CGH-1 is **parallel test-hygiene + future-`expose_mcp`-flip prep**.

**CGH-6 flips `enabled`+`index_at_setup` UNCONDITIONALLY in this bundle** (operator decision 2026-06-14). Order: CGH-2 (instrument) + CGH-1 (hygiene, parallel) → CGH-3 (build measurement substrate) → CGH-4/5 (cost/degradation) → **CGH-6 LAST**.

**Why the measurement substrate still ships:** the efficacy probe/fixtures/protocol (CGH-3) cannot run in-flight (CGH-2's `codegraph_context_injected` event isn't in the running runtime until `install.sh` redeploys — R-WSRC bootstrap). They ship as the **post-install safety net**: after deploy, the operator runs the probe (`prds/archive/research/codegraph-ab-protocol.md` procedure) and records `efficacy_delta` + sign-off in `prds/research/codegraph-efficacy-baseline.md`. **If the post-install measurement shows `efficacy_delta <= 0`, trigger the revert-the-default follow-up** (flip defaults back to false). `efficacy_delta > 0` = keep default-on. This makes the flip reversible-on-evidence rather than gated-pre-flip.

## Workstreams

### CGH-1 — Stabilize the `codegraph-real-index` test (P2, parallel test-hygiene — NOT a default-on blocker)
The real flake driver is the 60s race guard, not parallel load (the test is already serial).
- **AC-CGH-1-1 (verify-first):** confirm `tests/integration/codegraph-real-index.test.js` remains in `extension/tests/integration/.serial-tests.json` (currently line 39, reason `subprocess-spawn-timing`); `bash scripts/audit-test-isolation.sh` passes. (Already shipped — this is a guard against regression, not new work.)
- **AC-CGH-1-2:** raise `HANDSHAKE_TIMEOUT_MS` (`codegraph-real-index.test.js:33`, currently `60_000`) to `150_000` (≥ `index_timeout_ms` 120000 + handshake margin) so **both** stages — C0 `:191-192` and C7 `:270-271` — clear under serial run on a loaded host. NOT a `spawnSync` timeout (none exists in this guard). Test green 5/5 in the expensive tier.
- **AC-CGH-1-3:** the `codegraph serve --mcp` startup has a bounded retry/backoff so a slow first handshake degrades to `codegraph_degraded` (fail-open) rather than hanging. (Future-`expose_mcp` prep; keep minimal.)

### CGH-2 — Efficacy instrumentation (P1, prerequisite for measurement — the big ticket)
Add the events that tie what-got-injected to outcomes. **This AC was unsatisfiable as originally written** — fixed below.
- **AC-CGH-2-1 (emit plumbing):** extend `CodegraphContextOptions` (`spawn-morty.ts:646-652`) with `sessionDir: string` + `ticketId: string`; thread at the call site (`:2272`) — `sessionDir = path.dirname(args.statePath)` (the activity dir, **NOT** `runtime.sessionWorkingDir` which is the indexed repo), `ticketId = args.ticketId`. Define typed `CodegraphContextInjectedPayload` / `CodegraphContextSkippedPayload` beside `CodegraphSessionSummaryPayload` (`src/types/index.ts:1040`).
- **AC-CGH-2-2 (skip events, branch-split):** split `:719` into three guarded returns → `disabled` / `no_service` / `non_graph_tier`. `:722`→`no_terms`; `:725` ∪ `:729`→`zero_hits`. **Drop `degraded`** (unobservable here — surfaced by the service-layer `codegraph_degraded`). Emit `codegraph_context_skipped {reason, ts}` from each early return **EXCEPT the steady-state `disabled` branch** (suppress to avoid per-spawn log flooding while default stays OFF). Precedence (top wins): `disabled` → `no_service` → `non_graph_tier` → `no_terms` → `zero_hits`. `describe.each` asserts exactly one `codegraph_context_skipped` per emitting branch with the expected reason + `ts` present.
- **AC-CGH-2-3 (happy-path injected event — NEW, was missing):** the success path (`:731`) emits exactly one `codegraph_context_injected` with `{ticket, tier, terms_count, hits_count, bytes, build_ms, ts}` — `terms_count` = `deriveCodegraphTerms` length, `hits_count` = ranked-hits length, `bytes` = **post-cap** length of `renderCodegraphSection(...)`, `build_ms` = finite non-negative duration wrapping the body, `ticket` = `ticketId`, `tier` = resolved tier. A dedicated happy-path fixture asserts it (NOT covered by 2-2's skip sweep).
- **AC-CGH-2-4 (`ts` stamp + registration):** both events MUST pass `ts: new Date().toISOString()` explicitly to `writeActivityEntry` (it does NOT auto-stamp). Register across **all SIX touchpoints**: `VALID_ACTIVITY_EVENTS` source `src/types/index.ts:759-763`; compiled mirror `extension/types/index.js:304-308` (install.sh MD5 parity gate); `activity-events.schema.json` definitions (`:1488-1558` region); top-level `oneOf` `$ref` (`:1803-1807`); `EVENT_CASES` `activity-event-payload.test.js:799-843`; `ALL_EVENTS` `:1232-1236`. Add `codegraph-context-events-schema-conformance.test.js` (forward-created, mirroring `worker-partial-lifecycle-exit-schema-conformance.test.js`) that drop-field-asserts `ts` is required and validates against the top-level `oneOf`. Extend `codegraph_session_summary` to aggregate injected/skipped counts.

### CGH-3 — Efficacy A/B harness + measurement (P1, the actual validation)
Tests prove it runs; this proves it helps. **Depends on CGH-2's events being Ajv-valid + emittable.**
- **AC-CGH-3-1 (probe harness + scoring):** create `extension/src/bin/codegraph-efficacy-probe.ts` (forward-created) → compiled `extension/bin/codegraph-efficacy-probe.js` (forward-created), carrying the `bin/` CLI-guard (§1 `extension/src/bin/CLAUDE.md`), a finite `spawnSync` timeout (§3), and module-export-catalog entry (§4). For a fixed corpus it builds the worker prompt WITH and WITHOUT `## Code Graph Context`, runs the worker on both, and scores: (a) **hallucinated ref** = a backticked path/symbol in the diff failing the **same resolver as `path_not_verified`**; (b) **right consumer files** = Jaccard overlap between the worker diff's touched files and the fixture's hand-labeled `expected_consumer_files`; (c) **gate-pass** = the **full worker conformance gate** (named explicitly, not tsc-only). Emits one `codegraph_efficacy_sample` per ticket (registered across the same SIX touchpoints + conformance test).
- **AC-CGH-3-2 (A/B protocol doc — artifact-checkable):** create `prds/archive/research/codegraph-ab-protocol.md` (forward-created) with (i) a numbered run procedure (same bundle, same baseline, on vs off), (ii) the named substrate metrics each with its defining event/source — `path_not_verified` count, no-progress count, `pickle-metrics` tokens + wall-clock, citadel finding count, anatomy-park finding count, closer sibling-test-drift count — and (iii) a `## Results` table with one row per metric and a signed-delta column. AC: file exists and contains a `## Results` table with the six named metric rows.
- **AC-CGH-3-3 (corpus):** commit ≥5 self-contained, cross-file-heavy fixture tickets under `extension/tests/fixtures/codegraph-efficacy/` (forward-created), each carrying `expected_consumer_files: string[]` (the AC-CGH-3-1 oracle) + a one-line cross-file justification. Do NOT reference the pruned R-DSAN session artifacts (not in this repo).

### CGH-3-MEASURE — Post-install efficacy measurement (P1, the post-hoc safety net — NOT an in-bundle build ticket)
This is a documented **post-install operator procedure**, not a worker ticket — the probe cannot run until CGH-2's events are deployed. After this bundle ships, the operator runs `node extension/bin/codegraph-efficacy-probe.js --tickets extension/tests/fixtures/codegraph-efficacy/` over the corpus × ≥3 reps each, with an A/A control to establish a noise band, and records in `prds/research/codegraph-efficacy-baseline.md` (forward-created — created by the operator post-install, NOT a build ticket): the signed scalar `efficacy_delta` (sign convention **positive = codegraph helps**), the A/A noise band, per-ticket samples, and a sign-off line. **If `efficacy_delta <= 0`, trigger the revert-the-default follow-up (flip defaults back to false).** The full procedure lives in `prds/archive/research/codegraph-ab-protocol.md` (built by CGH-3b).

### CGH-4 — Index-at-setup cost + staleness correctness (P2)
- **AC-CGH-4-1 (verify-first + comment fix):** verify `codegraph-service.ts:157` populates `codegraph_index_built.gate_payload.{files_indexed, duration_ms}` (already in schema); add coverage if absent. **Correct the stale comment at `src/types/index.ts:990-991`** which falsely says these events carry "no dedicated payload."
- **AC-CGH-4-2 (warm vs cold — CORRECTED enum):** (a) on a warm resume, `cgResolveIndexAction(true, dbPath, staleMs)` (`setup.ts:168`) returns `'noop'` or `'sync'`, **never `'full'`** (the union has no `'index'` member — asserting `!== 'index'` is vacuous). (b) on a fresh (non-resume) launch the awaited `runCodegraphIndexAtSetup` (`:1699`) completes a `'full'` index within `index_timeout_ms` (120000) and fails open on timeout/error without blocking the launch.
- **AC-CGH-4-3 (concurrent DB — lock contention, the production NORM):** verify the C7 single-writer `sync` discipline (`CODEGRAPH_NO_WATCH=1`, `backend-spawn.ts:442`) across two concurrent sessions on one repo: no `.codegraph/codegraph.db` corruption (post-run DB opens + returns expected node count), AND on a busy DB the second session **skips + emits `codegraph_degraded`, NEVER blocks setup**.

### CGH-5 — Graceful-degradation hardening (P2)
Default-on means failures must NEVER block a launch or a worker.
- **AC-CGH-5-1:** `describe.each([['index-failure'],['binary-unresolvable'],['read-only-fs']])` asserts setup completes + worker spawns with no `## Code Graph Context` + `codegraph_degraded` emitted, one fixture per mode. **Drop the `serve-mcp-merge-fail` leg** — unreachable while `expose_mcp_to_workers:false` (`backend-spawn.ts:479`); it belongs to the future-flip workstream.
- **AC-CGH-5-2:** `PICKLE_CODEGRAPH=off` fully short-circuits every path (kill-switch trap door) — a dedicated fixture asserts no index, no events, no `## Code Graph Context`.

### CGH-6 — Flip the default ON (P1, the finish line — unconditional flip per operator decision; CGH-2/3/4/5 land first)
- **AC-CGH-6-1:** `resolveCodegraphSettings` compiled defaults → `enabled:true`, `index_at_setup:true`; **`expose_mcp_to_workers` stays `false`** (separate future flip, gated on CGH-1).
- **AC-CGH-6-2:** `pickle_settings.json:codegraph` mirrors the new defaults.
- **AC-CGH-6-3 (FOUR doc surfaces + DEFAULTS test):** update `tests/codegraph-settings.test.js` `DEFAULTS` (`:36+`; `:44/:47/:50` assert equality — they go red otherwise) AND all four doc surfaces: `extension/CLAUDE.md` settings table, `extension/src/bin/CLAUDE.md`, the root `pickle-rick-claude/CLAUDE.md` Settings section, and its `PICKLE_CODEGRAPH` env-var table.
- **AC-CGH-6-4 (`[manager]` smoke — separate post-install run):** a real `/pickle-pipeline` smoke (a **SEPARATE post-install follow-up**, NEVER this bundle's own in-flight run — the new events aren't in the running runtime until `install.sh` redeploys; R-WSRC bootstrap) shows `codegraph_index_built` + ≥1 `codegraph_context_injected` with non-zero hits. **Inconclusive-on-zero-hits** (re-run against a designated known-cross-file ticket, or defer + record) — inconclusive is NOT a pass.

## Risks & Mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Every FRESH launch pays a full index on the awaited critical path (`cgResolveIndexAction` returns `'full'` on `!isResume` + on absent DB) | High (common launch shape) | Med | AC-CGH-4-2(b): cold `'full'` index ≤ `index_timeout_ms` (120000), awaited fail-open (`setup.ts:1698`); `PICKLE_CODEGRAPH=off`; warm RESUME returns `'noop'`/`'sync'` |
| Efficacy A/B is model-noise, not signal (n≥5 stochastic runs) | High | High | AC-CGH-3-G1: ≥3 reps/ticket + A/A control noise band; flip requires `efficacy_delta > 0` strict; named operator sign-off |
| `@colbymchenry/codegraph@0.9.9` (pre-1.0) load-bearing by default | Med | High | Already pinned exact (`package.json:42`); `resolveCodegraphServeEntry`/service fail-open on binary-unresolvable; revert-default field follow-up documented |
| Concurrent multi-tmux sessions on shared `.codegraph/codegraph.db` (the operating NORM) | Med (norm) | High | C7 single-writer (`CODEGRAPH_NO_WATCH=1`); AC-CGH-4-3: lock-contention = skip + `codegraph_degraded`, NEVER block launch |
| Self-referential smoke contaminated by mid-flight `install.sh` redeploy (R-WSRC) | Med | Med | AC-CGH-6-4 smoke = SEPARATE post-install run; inconclusive-on-zero-hits |
| Warm cache git-untracked (`.git/info/exclude`, `setup.ts:160-165`) → `git clean -fdx`/fresh worktree wipes it → next launch `'full'` re-index | Med | Low | Documented expected fail-open re-index (NOT corruption); `cgApplyGitExclude` re-applies on next setup |

## Hidden Assumptions
1. `.codegraph/codegraph.db` persists across resume (working-dir storage + `.git/info/exclude`) and survives `pruneOldSessions`, but NOT `git clean -fdx`/fresh-worktree (expected fail-open re-index, not corruption).
2. Worker-LLM diff scoring is a valid proxy for "helps."
3. n≥5 fixtures × ≥3 reps is adequate signal (re-evaluate against the A/A band).
4. The efficacy corpus is committed fixtures, not ephemeral R-DSAN session artifacts.
5. `cgResolveIndexAction` returns `'full'` on every non-resume launch by design.

## Non-Goals
- Enabling `expose_mcp_to_workers` by default (gated on CGH-1; separate decision).
- Replacing/upgrading `@colbymchenry/codegraph` (0.9.9 stays, already pinned exact).
- Improving `deriveCodegraphTerms` relevance beyond what CGH-3 measurement surfaces (follow-up if the A/B shows weak hits).
- A revert-the-default field rollback is documented as a follow-up (not built here): flip defaults back to false if the field run regresses, since `PICKLE_CODEGRAPH=off` is per-invocation only.

## Implementation Task Breakdown
| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | fe4b545f | Stabilize codegraph-real-index test | Med | at afdce5ec | test green 5/5 expensive tier | codegraph-real-index.test.js, codegraph-service.ts |
| 20 | b1089e97 | Instrument buildCodegraphContextSection (injected/skipped events) | High | afdce5ec | events Ajv-valid, 6 touchpoints | spawn-morty.ts, types/index.ts(+mirror), activity-events.schema.json, activity-event-payload.test.js, +conformance test |
| 30 | 61d02c4e | Efficacy probe harness + codegraph_efficacy_sample | High | after b1089e97 | CLI-guarded probe + event | codegraph-efficacy-probe.ts/.js, +test, types/schema |
| 40 | 934a72b3 | Corpus fixtures + A/B protocol doc | High | afdce5ec | ≥5 fixtures + protocol Results table | tests/fixtures/codegraph-efficacy/, prds/archive/research/codegraph-ab-protocol.md |
| 50 | 7b967729 | Index cost + staleness correctness | Med | afdce5ec | warm/cold/concurrent covered, comment fixed | setup-related tests, codegraph-service.ts, types/index.ts |
| 60 | e72edc1a | Graceful-degradation fixtures | Med | afdce5ec | fail-open per mode + kill-switch | codegraph-degradation.test.js |
| 70 | 484b7f6b | Flip default ON | High | after CGH-1..5 | enabled+index_at_setup true, 4 docs synced | pickle-utils.ts, pickle_settings.json, codegraph-settings.test.js, 4 doc surfaces |
| 80 | 7a931f4a | Harden: code quality | High | after CGH-1..6 | zero P0-P1 | all B-CGH MODIFIED_FILES |
| 90 | 2c315007 | Audit: data flow | High | after 7a931f4a | zero CRITICAL/HIGH | all B-CGH MODIFIED_FILES |
| 100 | 2f7bc655 | Harden: test quality | High | after 2c315007 | every AC mapped | all B-CGH test files |
| 110 | 9615c32c | Audit: cross-reference consistency | High | after 2f7bc655 | 4 surfaces agree | B-CGH doc files |

**Post-install (operator, not a build ticket):** run `extension/bin/codegraph-efficacy-probe.js` per `prds/archive/research/codegraph-ab-protocol.md`, record `efficacy_delta` + sign-off in `prds/research/codegraph-efficacy-baseline.md`; if `delta <= 0` trigger the revert-the-default follow-up. Run the CGH-6-4 smoke as a SEPARATE post-install `/pickle-pipeline`.
