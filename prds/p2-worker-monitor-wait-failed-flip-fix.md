---
title: "B-WMFF — Fix the worker monitor-wait Failed-flip class: synchronous gate confirmation + completion-shape breadcrumb"
priority: P2
finding: R-WMFF
status: queued
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
depends_on: "none (deploy-agnostic BUILD; prompt-layer + additive telemetry)"
source_assessment: "Live incident 2026-07-11, session 2026-07-11-a19aa731 ticket 6317933b — see prds/BUG-REPORT-2026-07-11-worker-monitor-wait-failed-flip-orphans-verified-work.md"
---

# B-WMFF — worker monitor-wait Failed-flip fix

## 0. The defect (from the capture)

A hardening worker completed a verified diff, then parked "waiting on the test:fast monitor
event before finalizing conformance and committing." Inside a `claude -p` worker no waker exists
for a background/monitor wait; the worker idled to budget death, the ticket flipped Failed with
the verified work UNCOMMITTED, and the flip left ZERO activity-event trail (the R-WSE-2
partial-lifecycle predicate is correctly silent — all artifacts existed; exit-path salvage
correctly refused — no gate verdict existed because the gate never ran). Recovery cost an
operator assist (`3d36ff2c`).

Two legs. The third candidate (widening exit-path salvage) is REJECTED per subtract-before-add —
tighten the worker contract instead of adding a second rescue branch.

## 1. Workstreams

### WS-WMFF-1 — Prompt-layer: gate confirmation is synchronous, commit-first near budget

- **AC-WMFF-1A** — `.claude/commands/send-to-morty.md` (the worker lifecycle prompt) gains an
  explicit rule in the Implement/Conformance phase guidance: test/gate confirmation commands run
  SYNCHRONOUSLY in the worker's own turn — a worker MUST NOT background, monitor-poll, or
  otherwise await an external event for its own `test:fast`/lint/tsc confirmation (no waker
  exists in `claude -p`). — Type: lint
  (`grep -qi "synchron" .claude/commands/send-to-morty.md && grep -qiE "never.*(background|monitor).*(gate|test)" .claude/commands/send-to-morty.md`
  — exact phrasing worker's choice; both greps must hit)
- **AC-WMFF-1B** — the same file gains the commit-first rule: when the verified diff is green on
  the deterministic dimensions (tsc+eslint) and the remaining confirmation is the test tier, the
  worker COMMITS FIRST and lets the runner-side gate verdict (R-CWGE `runWorkerGate` before
  completion-commit acceptance, R-WGFR recompute) own final verification — an uncommitted
  verified diff at budget death is strictly worse than a committed one awaiting gate. — Type:
  lint (`grep -qi "commit.first" .claude/commands/send-to-morty.md`)
- **AC-WMFF-1C** — README documentation-rule compliance: no command was added/removed, so
  README needs no change; assert docs-parity tests stay green. — Type: test
  (`cd extension && npm run test:fast` scoped run green)

### WS-WMFF-2 — One breadcrumb event for the complete-but-uncommitted terminal shape

- **AC-WMFF-2A** — `worker_produced_everything_but_commit` emitted from the mux-runner
  post-iteration check region (alongside the existing R-WSDO `worker_produced_nothing` check,
  same best-effort try/catch pattern): fires when a ticket flips Failed while (a) the required
  artifact prefixes for its tier are ALL present (reuse `findMissingPrefixes` /
  `requiredTierArtifactPrefixes` from `services/artifact-validation.ts` — build NO new artifact
  scanner), and (b) the working tree carries an in-scope dirty diff or an unreferenced fresh
  commit exists in the iteration window. Observability ONLY — no reap/salvage/status behavior
  change. Mutual exclusion: never double-emits with `worker_produced_nothing` (disjoint
  predicates by construction). — Type: test
- **AC-WMFF-2B** — R-WSE-2 co-location discipline: event registered in
  `VALID_ACTIVITY_EVENTS` (`extension/src/types/index.ts`), schema definition in
  `activity-events.schema.json` with explicit `ts` stamped by the producer
  (`writeActivityEntry` does NOT auto-stamp — the known producer/schema-disconnect class), and
  `activity-event-payload.test.js` coverage — all in the SAME ticket as the emit. — Type: test
- **AC-WMFF-2C** — payload carries `{ ticket, gate_payload: { artifacts_present: true,
  dirty_in_scope_paths: string[], window_commit: string|null } }` so the babysitter can execute
  the standing commit-before-respawn recovery from the event alone. — Type: test

## 2. Out of scope

- Exit-path salvage widening (REJECTED — leg 3 of the capture; two rescue branches for one
  contract is the smell).
- Any change to `runWorkerGate`, completion-evidence, or Done-flip logic (R-PSRB salvage-path
  adjacency — this bundle is additive telemetry + prompt text only).
- Retro-fixing the 6317933b incident (already recovered, `3d36ff2c`).

## Simplification Review (subtract-before-add)

**WS-1** — (1) Adds prompt text only; no runtime code, no flag, no gate. (2) Reuses the existing
runner-side gate (R-CWGE/R-WGFR) as the verification owner instead of strengthening worker-side
verification — that IS the reuse. (3) The brittle thing (worker self-gating via background
waits) is subtracted behaviorally by forbidding it. (4) Subtraction: the worker's redundant
self-wait pattern is removed from the contract.

**WS-2** — (1) One additive event; justified because the incident was telemetrically INVISIBLE
(zero trail). (2) Reuses `artifact-validation.ts` helpers and the R-WSDO check region/pattern —
no new scanner, no new check phase. (3) Does not guard anything — pure breadcrumb. (4) No
subtraction available; recorded (the alternative — salvage widening — was itself the rejected
addition).

## Risks

- Prompt-text rules are advisory to the model (prose failed before — R-QGSK-3); accepted here
  because the breadcrumb (WS-2) makes violations visible and the runner gate already owns
  verification. If recurrence continues post-fix, the NEXT step is hook-level, evidence-first.
- The breadcrumb predicate must not misfire on legitimately-Failed tickets with stale artifacts
  from a prior attempt: window-scope the dirty/commit check to the current iteration.
