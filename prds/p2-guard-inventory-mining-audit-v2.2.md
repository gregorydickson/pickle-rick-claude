---
title: "B-GIMA — Guard-inventory & finding-shape mining audit (v2.2, report-only): operationalize subtract-before-add"
priority: P2
finding: GIMA
status: deferred
type: tooling-audit
schema_neutral: true
target_version: v2.2.0
depends_on: "v2.0.0 reliability GA shipped AND v2.1 codegraph landed (the audit REUSES codegraph as its code-liveness substrate — see WS-GIMA-A)"
source_assessment: "2026-06-27/28 slop-gate (codeninja/slop-gate) comparative review, toolchain-wide pass. Two adversarial filters (claude agent-team + this conversation). Reliability-first / capability-second release principle."
---

# B-GIMA — Mine our own corpus to find guards to DELETE (deferred behind reliability + codegraph)

## 0. Status: DEFERRED — do not build until reliability work lands

This bundle is **parked on purpose.** Release 2 is reliability-first; this is post-GA, post-codegraph
(v2.2) tooling. It is captured now only so the analysis behind it is not lost and it is drainable
later. **Nothing here ships before the v2.0.0 reliability line and v2.1 codegraph are done.**

It is the **sole survivor** of a deep slop-gate (`codeninja/slop-gate`) comparative review. Everything
else slop-gate offers was evaluated against the whole toolchain and rejected (§3). What remains is one
**inert, report-only** tool that automates a directive we already hold by hand:
*"remove never-fired guards = the biggest lever"* (`feedback_analyze_failures_then_subtract_not_add_guards`).

## 1. Background — what the review actually found

slop-gate is a passive, event-driven Claude Code **hook plugin** (not a skill, not a loop). Its target
failure class — intent drift, scope creep, premature "done" claims — is largely a *weak-model-era*
problem that frontier models and our own v2.1 codegraph (structural-context restoration) substantially
erode. So slop-gate's **machinery** is the wrong thing to import. Two ideas survived because they are
**model-independent**:

1. **Evidence-gating** (don't trust a "done" claim without accumulated validation evidence). This maps
   onto our completion oracle and our *active P1 reliability bugs* (R-CWGE worker-gate-not-enforced,
   R-DOTR Done-over-RED). **It belongs to release-2 reliability, NOT here** — see §3. It is
   orchestrator-side, so codegraph does not fix it.
2. **Corpus mining + curator** (rank recurring mistakes; retire now-enforced / never-fired patterns).
   This is history-archaeology over *our own* corpus — independent of model version and of codegraph's
   code index. **This bundle is that, and only that.**

We already produce the raw material: trap-door catalog in `extension/CLAUDE.md` (enforced by
`audit-trap-door-enforcement.sh` + `citadel/trap-doors-section.ts`), `prds/BUG-INDEX.md`,
`prds/MASTER_PLAN.md`, per-session `anatomy-park.json` / `gap_analysis.md` / `dropped_findings.md`, and
the activity JSONL. Nothing cross-session distills it into "what should we REMOVE." That is the gap.

## 2. Workstreams

### WS-GIMA-A — The report-only mining script (the whole bundle)

A standalone, **manually-invoked, report-only** Node script. No hook, no runtime wiring, no state
writes, no skill-prompt change, **no auto-write to CLAUDE.md or any gate.** Its only output is a
markdown report a human reads.

- **AC-GIMA-1 — inert by construction.** `extension/scripts/mine-finding-shapes.js` (forward-created)
  has a CLI guard, is invoked by hand (sibling to the `audit-*` scripts, NOT added to the build/test
  gate), writes only to a single report path under the scratchpad/report dir, and performs **zero**
  writes to `extension/CLAUDE.md`, `state.json`, `pickle_settings.json`, or any trap-door section. —
  Type: test (assert no write outside the report path; assert not referenced by `npm test` / audit
  chain)
- **AC-GIMA-2 — three sections, SUBTRACT-first ordering.** The report emits, in this order:
  (a) **DELETE candidates** — trap doors in the catalog that never recur in any session's
  `findings_history` = never-fired guards;
  (b) **JUDGE-CALIBRATION** — findings repeatedly dropped at `conf<80` across sessions (the
  judge-is-the-metric blind spot, `feedback_szechuan_judge_credited_finding_is_the_metric`);
  (c) **ADD candidates** — recurring un-guarded shapes, **human sort-hint only**, never a gate. —
  Type: test (snapshot over a fixture corpus under `extension/tests/fixtures/`)
- **AC-GIMA-3 — "never fired" means no-evidence-of-firing, NOT proven-dead.** Every DELETE candidate is
  computed as *absence of recorded firing* across the session corpus, **corroborated** by a codegraph
  query that the guard's `ENFORCE:` target is still present/reachable, and is emitted with an explicit
  `requires human confirmation + test-coverage check before removal` flag. The tool never asserts a
  guard is safe to delete; it produces a ranked human worklist. — Type: test
- **AC-GIMA-4 — ingest the conf<80 drop corpus.** The JUDGE-CALIBRATION section reads
  `dropped_findings.md` and `gap_analysis.md` `## Dropped Candidates` across sessions (not just
  `findings_history`, which by construction omits what the judge silently dropped). — Type: test
- **AC-GIMA-A5 — REUSE codegraph + the existing trap-door extractor; build NO new scanner.** The
  code-liveness half ("is this guard's `ENFORCE:` target still in the code") queries **codegraph (v2.1)**
  rather than rolling an AST/grep scanner; trap-door parsing imports the existing
  `citadel/trap-doors-section.ts` extractor rather than re-implementing it. — Type: test (import
  assertions; no new extraction logic) — **this is the subtraction that justifies the v2.1 dependency**

## 3. Out of scope (explicitly rejected — do not re-litigate)

Captured so a future author does not re-import these. All were evaluated toolchain-wide and rejected:

- **Evidence-gating as code → belongs to RELEASE 2, not here.** The R-CWGE / R-DOTR fix is P1 reliability
  work happening on its own merits. slop-gate contributes only a *framing* (collapse the 5 divergent
  `markTicketDone` seams into one evidence-gated transition; wire the worker-gate tsc/lint/test verdict
  in as evidence). That framing is a **one-paragraph note in the R-CWGE/R-DOTR bug PRD — zero code from
  this review.** Must be done as a *seam collapse* (subtractive), never as "add a 6th guard" (that is
  R-APNC guard-piling).
- **Advisory-nudge hook layer** — net-new runtime machinery; the drift class it targets is the dated,
  weak-model problem that v2.1 codegraph already erodes.
- **Forbidden / deny-glob scope tier** — net-new enforcement primitive (`scope-resolver` is allowlist-only
  by design); no incident motivates it. Revisit only on a cited repro.
- **Runtime semantic-intent drift detection** — net-new, reliability-risky, and codegraph's structural
  context restoration is the better answer to that class.
- **`dismissals.jsonl` cross-run suppressor** — silent suppressor that re-opens the judge-drops-findings
  failure family; contradicts "the principle is the filter, not the history."
- **Append-only pattern repo** — directly contradicts our governance (trap doors are *remove-when-enforced*,
  the opposite of append-only).
- **Auto-append of this tool's output** into any CLAUDE.md trap-door section or runtime gate — the moment
  the report becomes an action, it crosses from inert audit into guard-seeding. Forbidden.

## 4. Simplification Review (subtract-before-add)

**Per WS-GIMA-A (the only workstream):**

1. **Is the addition necessary at all?** It adds **one report-only script** and a fixture. It adds no
   runtime, no hook, no state field, no config, no skill-prompt change. Its *purpose* is to find things
   to **remove** (never-fired guards) and a metric to **fix** (conf<80 drops). It is the rare addition
   whose telos is subtraction.
2. **Can it REUSE instead of ADD?** Yes, and it MUST (AC-GIMA-A5): trap-door parsing reuses
   `citadel/trap-doors-section.ts`; code-liveness reuses **codegraph (v2.1)** instead of a new scanner.
   Building a second code-scanner beside codegraph is the smell this bundle is explicitly designed to
   avoid — which is the whole reason it is sequenced *after* v2.1, not merely *calendar-after*.
3. **Does it guard EXISTING brittle complexity that should be SUBTRACTED?** It guards nothing. It is the
   instrument that *finds* the brittle, never-fired complexity (our ~400-entry trap-door catalog) so a
   human can subtract it. It serves the subtract directive rather than adding a guard around it.
4. **What can this issue SUBTRACT?** Indirectly, a great deal: its DELETE section is a standing worklist
   of guards to retire — operationalizing `B-GSUB` (currently deferred, discovered only via field-soak).
   Directly, it subtracts nothing at author time (it is a tool, not a removal).

**KILL-CRITERIA (the guardrail — non-negotiable).** This bundle exists to *reduce* surface, so it must
never grow it. If, during implementation, any workstream:
- adds a hook, a runtime wire-in, a `state.json` / `pickle_settings.json` field, or a new config surface; or
- auto-writes to `extension/CLAUDE.md`, any trap-door section, or any gate; or
- is added to the `npm test` / audit chain as an enforcing check (it is report-only, human-read);

…then it has **failed the subtract-before-add test and MUST NOT ship.** A "mining tool" that becomes a
guard-seeder or a new gate is the exact machinery this review rejected (§3). Report-only, human-in-the-loop,
or dead.

## 5. Notes

- Sequencing rationale is a **design dependency, not a calendar one**: the code-liveness half of the
  audit is a codegraph query, so building before v2.1 means building a throwaway scanner (anti-subtract).
- Name the script for *analysis*, not for trap-door-seeding (`mine-finding-shapes.js`), to resist the
  scope-creep toward auto-append.
- Thin-corpus caveat: only ~9 `anatomy-park.json` across ~27 sessions today, mostly one project. Treat
  recurrence ranking as a human sort-hint, never a threshold; tag findings by repo/subsystem before any
  cross-project generalization.
- The higher-value finding of the whole slop-gate review is the **evidence-gating framing for
  R-CWGE/R-DOTR** (§3) — that is release-2 reliability and is intentionally NOT in this bundle.
- A codex adversarial review of this PRD was requested and is **deferred with the rest of the work.**
