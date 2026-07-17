---
title: "B-CGHARD — Codegraph harden-then-soak (v2.1): bound the hang surface, verify-before-inject, then prove it live"
priority: P2
finding: CG-HARD
status: queued
type: bug-feature-bundle
schema_neutral: true
target_version: v2.1.0
depends_on: "none for BUILD (deploy-agnostic, v2.1 branch); SOAK RUN needs a codegraph-enabled window on the deployed runtime post v2.0 GA. Dormancy: BUILD is Done on unit evidence; soak evidence gates only B-CGCAP, not this bundle's Done. *(refined: risk-scope)*"
source_assessment: "2026-07-11 operator decision: keep-and-refine codegraph. Refined 2026-07-11 by 3-analyst × 3-cycle team (session 2026-07-11-a19aa731)."
---

# B-CGHARD — Codegraph harden-then-soak (REFINED)

## 0. Why this bundle, and why not the probe

The operator resolved the MASTER_PLAN ③ open decision (2026-07-11): **keep codegraph and refine
it**. Codegraph has never caused a live-run failure — because it has never run (zero
`codegraph_context_injected` events ever). With the subtract branch off the table, the synthetic
A/B probe loses its main verdict branch; the cheaper, decision-relevant instrument is the feature
itself run live: fix the two defects that would bite in production, then enable it for a bounded
soak of real pipeline reps and read live telemetry.

Two liabilities block an honest soak (both verified at HEAD by the refinement team):

1. **Unraceable sync-query hang.** `searchNodes`/`getCallers`/`getImpactRadius` route through
   `runSyncQuery` (`extension/src/services/codegraph-service.ts:260`) with no timeout race
   ("query_timeout_ms claim is forfeit"). Called from the worker spawn path
   (`collectCodegraphHits`/`codegraphCallerSuffix`, `extension/src/bin/spawn-morty.ts:664-692` —
   up to 8 `searchNodes` + 3 `getCallers` per spawn). A wedged native call burns a full
   worker-timeout iteration. *(refined: codebase — the SDK queries are documented SYNC in
   `extension/data/codegraph-api-inventory.json`; an in-process race is a dead branch.)*
2. **Stale-ref injection.** Rendered entries carry `file:line` from an index up to
   `staleness_max_age_minutes` (30) old — hallucination-inducing on a fast repo.

BUILD (WS-A, WS-B, WS-C docs) is deploy-agnostic, runs via `/pickle-pipeline` on the v2.1 branch.
SOAK RUN needs the deployed runtime, post v2.0 GA.

## 1. Workstreams

### WS-CGH-A — Bound the query hang surface (spawn path)

- **AC-CGH-A1 — no unraceable query reachable from the worker spawn path.** *(refined: all three
  analysts, cycle 2+3 convergence)* The `buildCodegraphContextSection` pipeline
  (`spawn-morty.ts:732`) is timeboxed end-to-end. Sanctioned shape, ranked:
  (i) **house query-runner child** (preferred): a forward-created runner module invoked as a child
  process that imports the SDK (`init()`/`open()` do NOT auto-watch per
  `extension/data/codegraph-api-inventory.json`), executes ALL queries for one section build in
  **one batched invocation** (up to 11 queries/spawn; per-query subprocess would pay 2 process
  starts each — batching is correctness, not optimization), preserves the
  `SearchResult={node,score}` contract, and defensively sets `CODEGRAPH_NO_WATCH=1`;
  (ii) the vendored CLI (`codegraph query|callers|impact --json`) ONLY if the research artifact
  captures its actual `--json` shape against the inventory pre-plan-approval (it keys `callers` by
  symbol NAME, not `node.id`).
  **Dead branch deleted:** "genuinely-async upstream API" does not exist (SDK queries are sync).
  **Not recommended:** reusing `serve --mcp` (default-ACTIVE watcher WRITES the db;
  `CODEGRAPH_NO_WATCH=1` is the only verified opt-out; `CODEGRAPH_NO_DAEMON=1` is NOT a watcher
  kill-switch).
  **Kill shape:** the vendored bin is a shim that `spawnSync`s the platform binary as a
  GRANDCHILD (`npm-shim.js:48`) — a plain spawn `timeout` kills the shim and leaks the wedged
  native binary. The child MUST be spawned `detached: true` and killed via the group-kill
  primitive (`killProcessGroup`, `extension/src/services/orphan-reaper.ts`, R-OMTD pattern).
  **Timeout/failure telemetry:** on timeout emit `codegraph_context_skipped` reason
  `'query_timeout'`; on crash/ENOENT/malformed-stdout emit reason `'query_failed'`; both return
  `''`, never throw, never orphan. Parent-side failure classification (shim exit≠0, grandchild
  kill, ENOENT, unparseable stdout) emits distinct `codegraph_degraded.reason` strings — the
  schema's reason is an open string, no schema edit needed.
  **Degrade-telemetry wiring (P0):** the spawn-morty service construction (`spawn-morty.ts:2501`)
  currently passes `{}` deps, so `codegraph_degraded` from the spawn path is silently dropped
  (`codegraph-service.ts:230-233` emit guard). Wire the existing activity-sink closure
  (`spawn-morty.ts:738-743`) as `{ emit }` so degrades persist to `state.json.activity`
  (`codegraph_degraded` is already in `VALID_ACTIVITY_EVENTS` and the schema).
  `codegraph_session_summary.degraded_ops` stays mux-runner-process-scoped by design; the soak
  reads spawn-path degrade evidence from per-event activity, never from `degraded_ops`.
  **Composition:** `buildContext` is already raced (`runWithTimeout`,
  `codegraph-service.ts:203-205`) — the aggregate bound composes over that plus the subprocess
  boundary; no third timer. Aggregate wall bound for the whole section build ≤
  2 × `query_timeout_ms` + `buildContext` race; happy-path p50 recorded via the existing
  `build_ms` payload field.
  **Union co-location (P0):** `'query_timeout'` + `'query_failed'` land IN THIS TICKET in all
  four homes: `CodegraphContextSkipReason` (`types/index.ts:1137`), the
  `codegraph_context_skipped.reason` enum in `activity-events.schema.json`, the hard pins + one
  new case row EACH in `codegraph-context-events-schema-conformance.test.js` (lines 76-81
  `deepEqual` the required array and exact enum — the addition reds this test until updated), and
  the emit branches. The branch-precedence comment at `spawn-morty.ts:749` gains the new reasons.
  — Type: test (a deliberately-wedged query returns within the bound with the skip event + no
  orphan process; extend `codegraph-degradation.test.js`)
- **AC-CGH-A2 — SUBTRACT `CodegraphService.getImpactRadius`.** Zero production callers
  (spawn-morty uses `searchNodes`/`getCallers`/`buildContext`; `check-scope-diff.ts:9` declares
  its own injected `ImpactRadiusService` seam — DIFFERENT interface, never wired by the CLI,
  fail-open; the worker MCP lane is a separate process). *(refined: codebase — full sweep: 11
  files reference the name; 6 touched test files enter the allowlist:*
  `codegraph-service.test.js`, `codegraph-degradation.test.js`, `codegraph-index-cost.test.js`,
  `integration/codegraph-real-index.test.js`, `integration/setup-codegraph-index.test.js`,
  `integration/v2-end-to-end.test.js`; *3 DO-NOT-TOUCH:* `check-scope-diff.ts`,
  `check-scope-diff-impact.test.js`, `rrh-forward-ref-coverage.test.js` *(same-name traps —
  different seam + fixture literal).* The never-wired `ImpactRadiusService` seam stays (it is
  check-scope-diff's own advisory surface, out of this bundle's scope) — recorded here per the
  Simplification Review. — Type: test
  (`! grep -q getImpactRadius extension/src/services/codegraph-service.ts`)
- **AC-CGH-A3 — `runSyncQuery` DELETED.** *(refined: requirements + risk-scope — the disjunction
  is collapsed; the complete caller set is `codegraph-service.ts:211/216/221`, all deleted or
  re-routed by A1+A2, so no legitimate residual exists and "documented residual" was fig-leaf
  surface.)* Deletion is the only passing outcome. `close()` is explicitly out of scope. — Type:
  test (`! grep -q runSyncQuery extension/src/services/codegraph-service.ts`)

### WS-CGH-B — Verify-before-inject (staleness truthfulness)

- **AC-CGH-B1 — node-level verification before rendering.** *(refined: codebase — the PRD's
  original render-level hook was wrong: `renderCodegraphSection(entries: string[])` at
  `spawn-morty.ts:598` receives location-baked strings; string-level verification would freeze
  the display format into a parse contract.)* Verification runs at NODE level inside/around
  `buildCodegraphEntries` (`spawn-morty.ts:695`) BEFORE `nodeLocation` renders: for each ranked
  node with `file|filePath`, verify the repo-relative path (resolved from the worker's
  `working_dir`) exists; when `line|startLine` present, `1 <= line <= <file line count>` (files
  >5MB: existence check only). Non-resolving nodes are dropped.
  **Disambiguation predicate (P0):** `ranked.length > 0` with zero surviving located nodes →
  skip reason `'stale_refs'` — NEVER the existing `zero_hits` branches (`spawn-morty.ts:762,770`);
  a genuinely empty `ranked` stays `zero_hits`. Location-less `Summary:` entries survive only
  when ≥1 located entry survived; all-located-dropped + Summary present → productive skip
  (`stale_refs`), no injected event.
  **b1089e97 pin preservation (P1):** the filter inserts UPSTREAM of the frozen PATTERN_SHAPE
  region — the empty-RENDER branch (`if (section.length === 0) { emitSkipped('zero_hits')`,
  `spawn-morty.ts:770`) is preserved untouched; its literal and the
  `codegraph-context-section.test.js` pins MUST NOT be weakened. Update the `extension/src/bin/CLAUDE.md`
  b1089e97 ENFORCE prose to name BOTH branches in the same ticket.
  **Freshness residual (stated):** content drift within surviving files is undetected — a file
  edited since indexing that kept its line count passes while the symbol moved; the bound remains
  `staleness_max_age_minutes`. `dropped_stale: 0` therefore under-counts true staleness.
  — Type: test (4 named cases EXTENDING the existing `codegraph-context-section.test.js`:
  stale-file dropped; stale-line dropped; all-stale → `stale_refs` skip + no injected event;
  all-located-dropped + Summary present → `stale_refs` skip)
- **AC-CGH-B2 — `stale_refs` + `dropped_stale` on BOTH branches.** *(refined: requirements P0 —
  as originally spec'd the staleness metric was anti-correlated with staleness: the all-dropped
  branch carried no count.)* Additions, all in THIS ticket (co-scoped with B1):
  (a) `'stale_refs'` in all four homes (union `types/index.ts:1137`, schema enum, conformance-test
  pins + case row in `codegraph-context-events-schema-conformance.test.js`, emit branch);
  (b) `dropped_stale` (integer ≥0) on the `codegraph_context_injected` payload — THREE co-edit
  sites: explicit schema property, `CodegraphContextInjectedPayload` (`types/index.ts:1140`), and
  a test asserting the schema names the property (both event definitions are OPEN objects — an
  emit-only change validates silently and never becomes contract);
  (c) `dropped_stale` ALSO on the `stale_refs`-reason `codegraph_context_skipped` emit (= full
  entry count) with its explicit schema property — C2's "dropped_stale totals" = sum across BOTH
  event types;
  (d) optional `ticket` (string) added to `codegraph_context_skipped` for per-rep attribution
  (the conformance test's `required` pin tolerates optional additions).
  — Type: test (schema conformance + payload tests; `activity-event-payload.test.js` +
  `codegraph-context-events-schema-conformance.test.js`)

### WS-CGH-D — Fix the INPUT terms (NEW 2026-07-17; **blocks WS-CGH-C's soak and [[B-CGCAP]]'s verdict**)

**Thesis: WS-CGH-B verifies the OUTPUT entries, but the INPUT terms are already noise — so B can
faithfully verify garbage, and a soak on today's path measures how well we look up the word
`return`.** This is the missing upstream workstream.

**Mechanism** — `deriveCodegraphTerms` (`extension/src/bin/spawn-morty.ts:584-602`) harvests **every
backticked span from title + full ticket body, in DOCUMENT ORDER**, appends title words ≥4 chars,
then `.slice(0, max)` with `max = CODEGRAPH_MAX_TERMS` (8). **The first eight backticks win** — and in
a well-cited ticket those are file paths and `file.ts:NNNN` line refs. **The better the citation
discipline, the worse the payload.**

**EVIDENCE — the actual terms injected into the R-MWMO bundle (2026-07-17, run against the real
harvester on the real tickets; session `2026-07-16-6fe9b904`):**

| Ticket | Terms actually sent | Real code symbols |
|---|---|---|
| `de25ce90` | `!guard.ok`, `extension/src/bin/mux-runner.ts`, `done_without_commit_evidence`, **`return`**, **`while (true)`**, **`:9287`**, **`:~11300`**, **`:~11345`** | ~1 of 8 (3 are bare line numbers; 2 are keywords) |
| `be604d1d` | path, **`:3693`**, `done_without_commit_evidence`, `'failed'`, **`:3688-3691`**, **`:3786-3790`**, + **two ~100-char PROSE SENTENCES** (`zero commits since baseline ${shortSha} — no build progress this run`, and the strict-phase-policy string) | **0 of 8** |
| `a5f8cf4f` | `isFatalPhaseFailure`, `finalizePhaseSuccess`, `maybeStampPhaseGraduation`, + 5 line-refs/expressions | **3 of 8 — the best of the bundle** |
| `a3812edd` | `safeDeactivate` + `applyAutoTicketCompletionValidation({...});` (symbol with `({...});` glued on — will not resolve), rest paths/keywords/fragments | ~1 of 8 |

**`hits_count` IS NOT A VALUE METRIC — it is a NOISE metric, and the soak must not use it.** The
run logged `hits_count` 122–185 and `bytes` 8130–8141 (i.e. **filling the 8192 cap**) while
`index_status: healthy`, `degraded_ops: 0`, `skipped: 0`. But **`return` occurs 859× in
`mux-runner.ts` alone** — a keyword term produces enormous hit counts and zero information. **A green
session summary (`injected: 11, skipped: 0, degraded: 0`) is exactly the "silence is not success"
shape this repo keeps relearning:** every telemetry field says healthy while the payload is junk.

**Fix shape — DECIDE IN REFINEMENT, do not pre-commit. Candidates:**
1. **Filter (necessary, not sufficient):** drop bare line-refs (`^:?~?\d+(-\d+)?\+?$`), language
   keywords (`return`, `break`, `while`, …), and over-long spans (a ~100-char prose sentence is never
   a symbol). Cheap, mechanical, high yield — `be604d1d` goes 0 → several.
2. **Rank, don't take-first (this is the actual root).** `slice(0, 8)` over **document order** is the
   bug: relevance is unrelated to position. Prefer identifier-shaped tokens, then dedupe, then cap.
3. **Strip call/expression noise** so `applyAutoTicketCompletionValidation({...});` → the bare symbol.
4. **Consider REUSE over new machinery** (`prds/CLAUDE.md` Q2): `check-readiness.ts:525`
   `resolveSymbolRef` / `countUnresolvedReferences` already decide "is this token a real symbol?" —
   **name the reuse or justify why it cannot be used.** A bespoke tokenizer beside an existing
   resolver is the smell this repo keeps paying for.

**ACs must verify the OUTCOME, not the mechanism** ([[feedback_verify_the_outcome_not_the_mechanism]]):
- **AC-CGH-D1** — for EVERY ticket in a fixture set drawn from REAL shipped tickets (use the R-MWMO
  five — they are adversarial by construction: citation-dense), **≥N of the derived terms resolve to
  a real symbol**, and **zero** are bare line-refs, keywords, or >40-char spans. Pin `be604d1d`
  (today: 0 symbols) as the regression case — **it must fail before the fix**.
- **AC-CGH-D2** — the injected section for a ticket whose terms are all noise is **not emitted**
  (or is emitted with an honest skip reason), rather than burning 8KB of worker context. Today it
  emits 8141 bytes of it.
- **AC-CGH-D3** — the soak/telemetry records **distinct RESOLVED SYMBOLS**, not `hits_count`. A metric
  that rises when a term matches `return` 859× is measuring the wrong thing.

**⚠ SEQUENCING (binding): WS-CGH-D lands BEFORE the WS-CGH-C soak RUN.** A soak on today's payload
returns "injected: N" for N restatements of the ticket's own file list plus the word `return`, and
[[B-CGCAP]] would flip a hollow verdict on it — in EITHER direction.

### WS-CGH-C — Soak readiness + protocol (RUN is a post-GA operator step)

- **AC-CGH-C1 — soak runbook documented with honest semantics, no new machinery.** The `## Soak
  protocol` section below is reconciled into `README.md`'s Code Graph section (header at
  `README.md:464`) as `### Soak protocol`. NO new aggregation script (session-summary aggregation
  via `countCodegraphContextEvents` already exists). **Owner clause (grep-checkable):** the same
  diff adds a MASTER_PLAN Drain Queue row for the soak RUN (post-GA trigger, GA-serialization
  stated). — Type: artifact (README section + MASTER_PLAN row)
- **AC-CGH-C2 — soak baseline artifact (forward-created at RUN time; NOT a build ticket).**
  `prds/research/codegraph-soak-baseline.md` records per rep: injected/skipped-by-reason counts,
  bytes + build_ms per injection, `dropped_stale` totals (summed across BOTH event types),
  spawn-path degrade evidence read from per-event `state.json.activity` (`codegraph_degraded`,
  `query_timeout` skips — NEVER from `degraded_ops`, which is mux-runner-process-scoped), worker
  outcomes (gate verdicts, iterations/ticket, hands-off completion) — identical fields for both
  arms, disabled-arm outcomes read from the same per-session `state.json`/history (the disabled
  arm's codegraph telemetry is empty BY DESIGN — emit-suppressed; absence of events is not
  absence of effect).
  **Verdict tree (downgraded — N=5 heterogeneous reps cannot support an efficacy claim):**
  - GATING (machine-checkable): cost/stability predicates — no spawn-path stall exceeding the A1
    aggregate bound; no leaked native process; setup index within `index_timeout_ms`; no
    rep-aborting degrade cascade. Any violation → **harm** (mid-rep: freeze the session per the
    standing scoped-kill recipe, discard the rep as `harm (aborted, rep discarded)`).
  - NON-GATING (directional only): outcome deltas vs the comparison arm, per-rep confounders
    recorded. Labeled **cross-version, directional at best** unless ≥2 contemporaneous disabled
    reps ran on the SAME deploy.
  - **Exposure floor (P0):** a rep counts toward the ≥5 only if ≥1 graph-tier ticket spawned with
    codegraph enabled; total injections across counted reps < 10 → verdict **no-exposure
    (inconclusive)** — extend the soak window; NEVER map zero exposure to "neutral."
  - help → B-CGCAP proceeds on live evidence · harm → revisit subtraction · neutral (with
    exposure floor met) → stays opt-in.
  — Type: artifact (forward-created at RUN)
- **AC-CGH-C3 — setup index cost bound re-verified, not rebuilt.** `runCodegraphIndexAtSetup`
  (defined `setup.ts:204`, callsite `setup.ts:1762`) honors `index_timeout_ms`, fails open with
  `codegraph_index_failed`. Gap-detection method: run the existing tests
  (`codegraph-index-cost.test.js`, `integration/setup-codegraph-index.test.js`) — green = done;
  extend only on an actual gap. — Type: test (existing tests green)
  **Re-verified 2026-07-11 (ticket ef611d8a) on the post-909bf131/8321922b/2e632f9a tree:**
  `codegraph-index-cost.test.js` 7/7 green, `integration/setup-codegraph-index.test.js` 15/15
  green, `tsc --noEmit` clean. No gap vs. the timeout/fail-open contract (CGH4-T4b,
  AC-C4-FAIL directly exercise it); zero source diffs.

## 2. Soak protocol (operator runbook — executed post-GA; reconciled into README by C1)

1. Deploy the v2.1 line via `bash install.sh` — **pin and record the exact tag/SHA in the
   artifact** (no "or cherry-picked" ambiguity). Confirm the deployed gate green: from
   `extension/`, `npm run test:fast` (deploy-soak variants need `PICKLE_INSTALL_ROOT` off-`$HOME`).
2. **Precondition: no active pipeline session.** Flip source `pickle_settings.json`
   `codegraph.enabled: true`, `index_at_setup: true`, then `bash install.sh`. Never hand-edit the
   deployed copy.
3. Run ≥5 real bundle reps through `/pickle-pipeline` (normal drain-queue payloads). **Rep
   validity:** a rep counts only if ≥1 graph-tier ticket spawned with codegraph enabled. **Run ≥2
   contemporaneous DISABLED reps on the same deploy** as the primary comparison arm (trailing GA
   reps are context only).
4. **Abort semantics (honest):** `PICKLE_CODEGRAPH=off` is a PER-SESSION kill-switch — env is
   read at process construction (`codegraph-service.ts:146`) and cannot reach a running session;
   set it in the launching shell for the NEXT rep. Mid-rep abort = freeze the session (scoped
   kills per the standing recipe) and discard the rep; the deployed-settings edit and mid-run
   `install.sh` are forbidden surfaces, NOT abort levers.
5. Read telemetry per session dir: `codegraph_session_summary` for injected/skipped;
   per-event `state.json.activity` for `codegraph_degraded` + `query_timeout`/`query_failed`/
   `stale_refs` skips (with `dropped_stale`); standard run outcomes for both arms.
6. Record `prds/research/codegraph-soak-baseline.md` per AC-CGH-C2; take the verdict to B-CGCAP.
7. **Exit:** restore the pre-soak line (checkout the recorded GA tag → `bash install.sh`) or
   explicitly record the decision to stay on v2.1.

## Risks *(refined: risk-scope — paste-ready register, cycle 3)*

- Runtime-version confound: enabled soak reps run the v2.1 deploy; the trailing disabled baseline
  ran v2.0 GA — deltas attribute the whole v2.1 diff to codegraph. Mitigation: pin the exact
  deploy SHA in the artifact; run ≥2 contemporaneous disabled reps on the SAME deploy as the
  primary comparison arm; label the GA-trailing comparison directional-only.
- Kill-switch semantics: PICKLE_CODEGRAPH is read at process construction; it cannot reach a
  running session. It is a per-SESSION switch (next rep). Mid-rep abort = freeze the session and
  discard the rep; the deployed-settings edit and mid-run install.sh are forbidden surfaces and
  are NOT abort levers.
- Serve-watcher writer-ownership: serve --mcp runs a default-active watcher that WRITES the db;
  reused as the query boundary it mutates staleness state mid-soak. Mitigation: prefer the
  SDK-embedded runner (init/open never auto-watch); if serve is reused, mandate
  CODEGRAPH_NO_WATCH=1 (NOT CODEGRAPH_NO_DAEMON=1 — verified not a watcher kill-switch).
- Query-boundary feasibility: SDK queries are sync-only (async-race shape is dead); the vendored
  CLI exists (query|callers|impact --json) but keys callers by name and its JSON shape is
  unrecorded; the vendored bin shims to a grandchild, so plain spawn timeouts leak the native
  binary. Mitigation: house runner + detached group-kill; research artifact settles the shape
  pre-plan-approval, citing codegraph-api-inventory.json.
- Happy-path latency: up to 11 queries/spawn; per-query subprocess pays SDK open each time.
  Mitigation: one batched subprocess per section build; p50 budget; build_ms is the measure.
- Soak validity: N=5 heterogeneous reps cannot support an efficacy verdict. Mitigation: gating
  cost/stability predicates; efficacy directional-only; per-rep confounders recorded; exposure
  floor with a no-exposure verdict branch.
- Orphaned RUN: no owner/trigger post-GA. Mitigation: MASTER_PLAN Drain Queue row created in
  WS-CGH-C1; dormancy line decouples bundle-Done from the soak.
- Residual staleness: B1 catches dangling refs only; content drift within surviving files is
  undetected (bounded only by staleness_max_age_minutes).

## 3. Simplification Review (subtract-before-add)

**WS-CGH-A** — (1) Necessary: the hang surface is real and un-timeboxable in-process (SDK queries
are sync; a blocked event loop cannot be raced). (2) Reuse: house finite-timeout subprocess
pattern + `killProcessGroup` (R-OMTD) + existing skip-event surface; no new gate/flag/state
field. (3)+(4) Subtracts: `getImpactRadius` (dead), `runSyncQuery` (deleted outright — the
"documented residual" fallback was itself subtracted in refinement), the dead async-API option
branch. The `ImpactRadiusService` seam in check-scope-diff is KEPT: it is that module's own
advisory surface, not codegraph-service scope.

**WS-CGH-B** — (1) Necessary: stale `file:line` injection is hallucination-inducing. (2) Reuse:
local fs stat + line count (deliberately NOT the check-readiness resolver); existing skip/emit
surface. (3) The pure-subtraction alternative (drop `file:line` entirely) rejected — location is
the section's value. (4) No subtraction available; recorded. Refinement moved the hook from
render-level to node-level, REMOVING a would-be parse contract on the display format.

**WS-CGH-C** — Pure protocol/doc + forward-created artifact; reuses session-summary aggregation;
no new script. The probe stays a stub (not finished, not deleted — optional follow-up).

## 4. Out of scope

- B-CGPROBE probe build/run (stub + corpus stay as-is; optional follow-up iff soak ambiguous).
- Default-on flip + propagation + supply-chain policy (B-CGCAP; soak baseline is its evidence).
- `expose_mcp_to_workers` flip (stays false, C0-gated).
- Any change to the `## Code Graph Context` section format, term derivation, or tier gating.
- `CodegraphService.close()` (A3 names it out of scope).

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|:---|:---|:---|:---|:---|:---|:---|
| 10 | 909bf131 | Bound query hang surface: batched subprocess runner + group-kill + degrade wiring + query_timeout/query_failed; delete runSyncQuery | High | clean tree | no unraceable spawn-path query; runSyncQuery gone | codegraph-service.ts, spawn-morty.ts, types/index.ts, activity-events.schema.json, codegraph-query-runner.ts (new), 3 test files |
| 20 | 8321922b | Subtract CodegraphService.getImpactRadius (zero prod callers) + test-pin sweep | High | 909bf131 done | getImpactRadius absent from service | codegraph-service.ts + 6 test files (3 DO-NOT-TOUCH pinned) |
| 30 | 2e632f9a | Verify-before-inject: node-level staleness filter + stale_refs + dropped_stale both branches | High | 909bf131, 8321922b | every injected file:line resolves at injection time | spawn-morty.ts, types/index.ts, schema, bin/CLAUDE.md, 3 test files |
| 40 | 6f562114 | README ### Soak protocol (honest semantics) + MASTER_PLAN soak-RUN row | Medium | 909bf131, 2e632f9a | runbook executable from README alone | README.md, prds/MASTER_PLAN.md |
| 50 | ef611d8a | Re-verify setup index cost bound via existing tests | Medium | A-tickets done | green evidence recorded | (tests only on proven gap) |
| 60 | 6317933b | Harden: code quality review of the bundle diff | High | all impl done | zero P0-P1 violations | bundle diff files |
| 70 | a53a1db1 | Audit: data flow integrity (subprocess round-trip, counts, precedence) | High | 6317933b | zero CRITICAL/HIGH or trap-doored | bundle diff files |
| 80 | fc240dc2 | Harden: test quality review of the bundle test surface | High | a53a1db1 | zero P0-P1 assertion gaps; all ACs mapped | bundle test files |
| 90 | 23f36f46 | Audit: cross-reference consistency (docs ↔ telemetry names) | High | fc240dc2 | zero CRITICAL/HIGH doc mismatches | README.md, bin/CLAUDE.md, MASTER_PLAN.md, PRD |

Wiring ticket: SKIPPED — co-location mandates make each ticket self-integrating; no cross-ticket module handoff.
