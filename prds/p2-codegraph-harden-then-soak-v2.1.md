---
title: "B-CGHARD — Codegraph harden-then-soak (v2.1): bound the hang surface, verify-before-inject, then prove it live"
priority: P2
finding: CG-HARD
status: queued
type: bug-feature-bundle
schema_neutral: true
target_version: v2.1.0
depends_on: "none for BUILD (deploy-agnostic, v2.1 branch); SOAK RUN needs a codegraph-enabled window on the deployed runtime post v2.0 GA"
source_assessment: "2026-07-11 operator decision: keep-and-refine codegraph (supersedes the B-CGPROBE instrument build; probe demoted to optional follow-up). Grounded in the 2026-07-10 4-agent evidence audit + 2026-07-11 4-agent codebase audit."
---

# B-CGHARD — Codegraph harden-then-soak

## 0. Why this bundle, and why not the probe

The operator resolved the MASTER_PLAN ③ open decision (2026-07-11): **keep codegraph and refine
it** rather than subtract it or build the synthetic A/B efficacy instrument first. Codegraph has
never caused a live-run failure — because it has never run (zero `codegraph_context_injected`
events across all sessions; every `codegraph_session_summary` reads `injected: 0`). Its recorded
costs are cost-of-ownership (6 fix commits in 5 weeks while disabled), not run instability.

With the subtract branch off the table, the synthetic probe (B-CGPROBE) loses its main verdict
branch and its price is disproportionate: one Large build item (the whole worker-spawn harness —
`captureWorkerDiff` is a bare `spawnSync` shell) plus a ≥40-worker-spawn RUN. The cheaper, more
decision-relevant instrument is the feature itself, run live: **fix the two defects that would
actually bite in production, then enable it for a bounded soak of real pipeline reps and read the
live telemetry.** That measures the question the autonomy north star cares about — does injected
graph context help or hurt hands-off builds — using events that already exist.

Two liabilities block an honest soak today (both from the B-CGCAP evidence audit):

1. **Unraceable sync-query hang.** `searchNodes` / `getCallers` / `getImpactRadius` route through
   `runSyncQuery` (`extension/src/services/codegraph-service.ts:260`) with **no timeout race** —
   the source comments admit "query_timeout_ms claim is forfeit." These are called from the worker
   spawn path (`collectCodegraphHits` / `codegraphCallerSuffix` in
   `extension/src/bin/spawn-morty.ts:664-692`, up to 8 `searchNodes` + 3 `getCallers` per spawn).
   A wedged native call blocks the spawn-morty process and burns a full worker-timeout iteration.
2. **Stale-ref injection.** Rendered entries carry `file:line` locations from an index up to
   `staleness_max_age_minutes` (30) old. On a fast-moving repo those can point at moved/deleted
   code — injected context that *induces* the hallucinated-premise failure class it exists to
   prevent.

BUILD (WS-A, WS-B, WS-C docs) is deploy-agnostic and runs via `/pickle-pipeline` on the v2.1
branch checkout now. The SOAK RUN (WS-C protocol execution) needs the deployed runtime with
codegraph enabled — serialize behind v2.0 GA; do not perturb GA soak reps.

## 1. Workstreams

### WS-CGH-A — Bound the query hang surface (spawn path)

- **AC-CGH-A1 — no unraceable query reachable from the worker spawn path.** The
  `buildCodegraphContextSection` pipeline (`spawn-morty.ts:732`) must be timeboxed end-to-end with
  a finite bound: a wedged codegraph query may cost at most the configured timeout, never a full
  worker iteration. The sync in-process path (`runSyncQuery`, `codegraph-service.ts:260`) must no
  longer be reachable from spawn-morty. Sanctioned shapes (worker research picks): isolate query
  execution behind a killable subprocess boundary using the house `spawnSync`/`spawn` +
  finite-`timeout` pattern (bin subsystem invariant #3), or race a genuinely-async upstream API if
  the vendored SDK exposes one (an in-process `Promise.race` over a sync call is NOT acceptable —
  a blocked event loop never yields to the timer). On timeout: emit `codegraph_context_skipped`
  (reason per AC-CGH-B2's union), return `''`, never throw, never leave an orphan process (kill on
  timeout). — Type: test (`extension/tests/codegraph-degradation.test.js` extension or a new
  fast-tier test proving a deliberately-wedged query returns within the bound with a skip event)
- **AC-CGH-A2 — SUBTRACT `CodegraphService.getImpactRadius`.** It has zero production callers:
  spawn-morty uses only `searchNodes`/`getCallers`/`buildContext`;
  `check-scope-diff.ts:9` declares its own injected `ImpactRadiusService` seam that the CLI never
  wires (fail-open, tests inject fakes); the worker MCP lane (`backend-spawn.ts:431-506`) spawns
  `codegraph serve --mcp` as a separate process and does not import the service. Delete the method
  and its interface member; update `codegraph-service.test.js` pins. — Type: test
  (`grep -c "getImpactRadius" extension/src/services/codegraph-service.ts` == 0)
- **AC-CGH-A3 — `runSyncQuery` deleted or unreachable.** After A1/A2, prefer deleting
  `runSyncQuery` outright. If any caller legitimately remains, it must be enumerated in the ticket's
  research artifact with its timebox stated — "documented residual sync caller" is the fallback, not
  the default. — Type: test (grep: `runSyncQuery` absent from `codegraph-service.ts`, or the
  residual-caller justification present in the shipped diff)

### WS-CGH-B — Verify-before-inject (staleness truthfulness)

- **AC-CGH-B1 — every injected location resolves against the working tree at injection time.**
  Before `renderCodegraphSection`, each entry with a `file` (and optional `line`) location is
  verified: the file exists in the working tree, and when a line is present, `1 <= line <= <file
  line count>`. Non-resolving entries are dropped. If ALL entries drop, the branch is a productive
  skip (no injection, no `codegraph_context_injected` — preserves the b1089e97 injection-truthfulness
  trap door in `extension/src/bin/CLAUDE.md`). The check is local and cheap (fs stat + line count);
  do NOT import the check-readiness resolver machinery for this. — Type: test
  (`codegraph-context-section.test.js` cases: stale-file entry dropped, stale-line entry dropped,
  all-stale → skip + no injected event)
- **AC-CGH-B2 — `stale_refs` skip reason + staleness telemetry.** Add `'stale_refs'` to
  `CodegraphContextSkipReason` (`extension/src/types/index.ts:1137`) and emit it on the all-dropped
  branch of B1 and the timeout branch of A1 may reuse it or add `'query_timeout'` (worker decides;
  every added member lands in `activity-events.schema.json` + `activity-event-payload.test.js` in
  the same ticket — the R-WSE-2/iter-7/iter-8 producer/schema-disconnect class is the known trap).
  The `codegraph_context_injected` payload gains an optional `dropped_stale` integer (count of
  entries dropped by B1) so the soak can measure staleness pressure on injections that still fire.
  Schema-neutral for `state.json` (activity payloads only, no state schema bump). — Type: test
  (schema conformance + payload tests)

### WS-CGH-C — Soak readiness + protocol (RUN is a post-GA operator step)

- **AC-CGH-C1 — soak protocol documented, no new machinery.** The PRD's `## Soak protocol` section
  below is reconciled into `README.md`'s Code Graph section (~line 468) as the operator runbook.
  NO new aggregation script: the existing `codegraph_session_summary` event already aggregates
  injected/skipped cross-process via `countCodegraphContextEvents` (`mux-runner.ts`, b1089e97 trap
  door), and per-injection detail lives in `state.json.activity`. — Type: artifact (README section)
- **AC-CGH-C2 — soak baseline artifact (forward-created at RUN time).**
  `prds/research/codegraph-soak-baseline.md` records, for ≥5 real pipeline reps with codegraph
  enabled vs the trailing disabled GA-soak reps: injected/skipped/degraded counts, bytes + build_ms
  per injection, `dropped_stale` totals, and per-rep worker outcomes (gate verdicts, iterations per
  ticket, hands-off completion). Verdict tree: measured help → B-CGCAP default-on path proceeds on
  live evidence · measured harm → revisit subtraction · neutral → stays opt-in, MCP lane and probe
  stay shelved. — Type: artifact (forward-created; NOT part of the BUILD gate)
- **AC-CGH-C3 — setup index cost bound re-verified, not rebuilt.** The soak window uses
  `index_at_setup: true`; confirm the existing bound holds — `runCodegraphIndexAtSetup`
  (`setup.ts:1762`) honors `index_timeout_ms` (120s floor 5000) and fails open with
  `codegraph_index_failed`. Existing coverage (`codegraph-index-cost.test.js`,
  `setup-codegraph-index.test.js`) is the evidence; extend only if a gap is found. — Type: test
  (existing tests green; no new code expected)

## 2. Soak protocol (operator runbook — executed post-GA)

1. Deploy the v2.1 line (or cherry-picked hardening) via `bash install.sh`; confirm
   `codegraph-degradation` + `codegraph-context-section` tests green in the deployed gate.
2. Flip `pickle_settings.json` `codegraph.enabled: true`, `index_at_setup: true` (source settings,
   then `bash install.sh` — never hand-edit the deployed copy). `PICKLE_CODEGRAPH=off` remains the
   one-step kill-switch.
3. Run ≥5 real bundle reps through `/pickle-pipeline` (normal drain-queue payloads, not synthetic
   corpus tickets).
4. Read telemetry per session: `codegraph_session_summary` (injected/skipped/degraded),
   per-injection `codegraph_context_injected` payloads (`bytes`, `build_ms`, `dropped_stale`), and
   the standard run outcomes (worker gate verdicts, iterations/ticket, hands-off completion).
5. Record `prds/research/codegraph-soak-baseline.md` per AC-CGH-C2 and take the verdict to the
   B-CGCAP row.

## 3. Simplification Review (subtract-before-add)

**WS-CGH-A** — (1) Necessary? Yes: the hang surface is real, admitted in-source ("claim is
forfeit"), and un-timeboxable in-process because the upstream calls are sync — a blocked event
loop cannot be raced. (2) Reuse? Yes: the house finite-`timeout` subprocess pattern (bin subsystem
invariant #3, enforced by existing audits) and the existing skip-event surface; no new
gate/flag/state field. (3) Guarding brittle complexity that should be subtracted? Partly — and it
IS subtracted: A2 deletes the dead `getImpactRadius`, A3 targets `runSyncQuery` itself for
deletion rather than wrapping it. (4) Subtraction: two service methods/paths deleted; the
"forfeited-claim" comment class disappears.

**WS-CGH-B** — (1) Necessary? Yes: stale `file:line` injection is hallucination-inducing, the
opposite of the feature's purpose. (2) Reuse? The check is deliberately local (fs stat + line
count) — importing the check-readiness resolver for this would be the over-engineering smell;
the skip/emit surface is reused as-is. (3) Brittle-complexity check: the alternative pure
subtraction (drop `file:line` suffixes entirely) was considered and rejected — location is the
value proposition of the section; verify-then-inject keeps it honest instead of deleting it.
(4) Subtraction: none beyond dropped stale entries; recorded as "no subtraction available" with
the above reason.

**WS-CGH-C** — (1) Adds no runtime code: protocol doc + forward-created artifact. (2) Reuses the
b1089e97 session-summary aggregation instead of a new report script. (3)/(4) Pure reuse/doc — the
ideal case. The one deliberate non-build: the synthetic probe stays a stub (see out-of-scope)
rather than being either finished or deleted — finishing it duplicates what the soak measures
more cheaply; deleting it forecloses the optional follow-up the operator kept open.

## 4. Out of scope

- **B-CGPROBE probe build/run** — demoted to optional follow-up (operator decision 2026-07-11);
  the stub (`codegraph-efficacy-probe.ts`) and its corpus stay as-is. Revisit only if soak
  telemetry is ambiguous.
- **Default-on flip + propagation + supply-chain policy** — B-CGCAP, still evidence-gated; the
  soak baseline becomes its evidence input.
- **`expose_mcp_to_workers` flip** — stays `false` (C0-gated, B-CGCAP WS-E).
- **Any change to the `## Code Graph Context` section format, term derivation, or tier gating** —
  hardening only; format changes would confound the soak baseline.
