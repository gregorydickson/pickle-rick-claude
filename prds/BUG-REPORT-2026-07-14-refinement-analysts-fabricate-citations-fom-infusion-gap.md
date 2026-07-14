---
title: "R-RAFC — the refinement analysts fabricate file:line citations, and nothing verifies them"
finding: R-RAFC
priority: P2
status: open
type: bug-report
schema_neutral: true
surfaced: "2026-07-14, refining B-RLH (the anti-fabrication bundle). The analysis team fabricated a citation INTO the PRD whose thesis is that citations must be checkable."
---

# R-RAFC — the analysts assert with file:line precision, and nothing checks them

## The incident

While refining **B-RLH** — the bundle whose entire thesis is *"a review phase must not report success it did
not earn,"* whose WS-1 deletes a citadel arm for citing `"is banned by CLAUDE.md"` (a rule that exists in no
CLAUDE.md) — the **refinement analyst team emitted a fabricated citation**, and it was **copied into the PRD and
committed** (`17bfbf4f`).

**The fabricated claim** (cycle-3 `analysis_risk-scope.md`, P1-5 → PRD WS-5 correction):

> "…plus an export-inventory pin (`src/services/CLAUDE.md:56`) and **two trap-door INVARIANTs policed by the
> release gate** (`audit-trap-door-enforcement.sh`)."

**Verified false, 2026-07-14:**
- `grep -c "ac-phase-gate\|ac_phase\|AC_PHASE" extension/scripts/audit-trap-door-enforcement.sh` → **0**. That
  audit polices `mux-runner.ts`, `spawn-morty.ts`, `microverse-runner.ts`, `ticket-completion-evidence.ts`,
  `auto-fill-completion-commit.ts` — **never** `ac-phase-gate.ts`.
- `grep -ciE "trap.?door|INVARIANT" extension/src/services/ac-phase-gate.ts` → **0**.

A cycle-4 analyst **caught it** and named the mechanism precisely: *"The anti-fabrication bundle fabricated a
citation, and the refinement loop is the emitter. This is R-BCFR's exact shape reproduced one level up the
stack."* It is right.

**This was not the only one.** A cycle-2 analyst asserted `microverseExitCode` is *"typed against `ExitReason`, a
DIFFERENT union from `MicroverseExitReason`"*. It is a **local alias** (`microverse-runner.ts:84`:
`type ExitReason = MicroverseExitReason;`). The cycle-3 analyst self-retracted it, noting — correctly — that *"a
builder told 'wrong union' would hunt for a type mismatch that does not exist, find nothing, and conclude the
risk was imaginary."*

**Both fabrications were caught only by a LATER CYCLE.** Cross-cycle corroboration is the sole functioning
verifier, and it is emergent, not designed.

## Root cause — the prompt mandates precision and forbids nothing

`extension/src/bin/spawn-refinement-team.ts:569` instructs every analyst:

> "Use **file:line references for every codebase claim**."

It demands citation precision. It does **not** require the analyst to *verify* the citation, and there is no
instruction anywhere in that file against asserting an unverified mechanism. Grep it for the FOM's core content:

| Surface | evidence-hierarchy / ground-truth / anti-fabrication hits |
|---|---|
| `spawn-morty.ts` (the **implementer** worker) | **5 — INFUSED** |
| `spawn-refinement-team.ts` (the **analyst** workers) | **0 — NOT INFUSED** |
| `.claude/commands/*.md` | **3 of ~30 infused** (`pickle-standup`, `plumbus`, `send-to-morty`) |
| `persona.md` (appended into every project's CLAUDE.md, in context on **every turn of every session in every repo**) | **0** |
| `docs/FABLE_OPERATING_MANUAL.md` | exists; referenced by ~nothing; not deployed |

**This is a FABLE-INFUSION GAP, not a fable-infusion symptom.** The FOM's evidence hierarchy — *prefer ground
truth; verify before asserting; a confident citation is not a checked one* — is precisely the antidote to this
failure class, and it reached the worker that **builds** while skipping the workers that **analyze**. The
analysts are exactly where the fabrication happened.

## The one existing verifier checks the wrong thing, and is advisory

`checkAnalystOutputPaths` → `analyst_path_not_verified` (`spawn-refinement-team.ts:2142-2149`) is the only
mechanism that inspects analyst output. It checks **that a cited path exists**. It does NOT check:
- that the cited **line** contains what the analyst says it contains,
- that a claimed **grep result** ("0 hits", "27 hits across 6 files") is real,
- that a claimed **relationship** ("policed by `audit-trap-door-enforcement.sh`") exists at all.

Every fabrication above cites a **real file**. All three would sail through it.

And it is **advisory**: it emitted **44 warnings on this very run**, wrote them to
`refinement_manifest.json#ticket_quality_warnings` with `ticket_id: ""` (unattributed), printed a count to
stderr, and **blocked nothing, down-weighted nothing, and attributed nothing to the analyst that emitted it.**

**A warning nobody reads is the same shape as the bug the bundle is fixing.**

## Why this is P2 and not cosmetic

The refinement analyses are the **direct input to ticket decomposition**. A fabricated citation becomes a
ticket's Research Seed, becomes a worker's premise, becomes a build against a mechanism that does not exist —
the `hallucinated-premise` defect class the ticket checklist *already names* (`prds/CLAUDE.md`), arriving through
the one door nobody is watching. Here, it reached a committed PRD in one hop.

## Fix — subtract-before-add, and it is repo-agnostic

**REUSE, do not add machinery.** Two moves, in priority order:

1. **WS-A (the infusion gap — the root cause).** Infuse the analyst prompt in
   `spawn-refinement-team.ts` with the same evidence-hierarchy block `spawn-morty.ts` already carries (5 hits) —
   *verify a citation before you assert it; an unverified mechanism is a hypothesis, label it as one; a claimed
   grep result must be a grep you actually ran.* This is **prompt text reuse from a shipped surface**, not new
   code. Extend the mandate at `:569` from *"use file:line references"* to *"use file:line references **you have
   verified**; mark anything unverified as a hypothesis."*
   **Also infuse `persona.md`** — it is the ONE surface where infusion cost is O(1) and reach is 100% (every
   session, every repo, including target repos). It currently carries **zero** FOM content. 3–5 lines.

2. **WS-B (make the existing verifier earn its keep — REUSE `checkAnalystOutputPaths`).** It already parses
   analyst output for citations. Widen it from *path-exists* to *claim-checkable*: for a `file:line` citation,
   assert the file exists **and has that line**; **attribute** each warning to the emitting analyst+cycle
   (`ticket_id: ""` today) so a repeat fabricator is visible. Keep it advisory — per W5b, do **not** build a
   fabrication gate; make the signal legible and let the next cycle use it. The cross-cycle catch already works;
   this feeds it.

**Explicitly NOT in scope (subtract-before-add):** a new "citation verifier" service, a fabrication gate, or a
blocking check. The system already caught both fabrications via cross-cycle review. The defect is that the
analysts were never *told* to verify, and that the existing warning is unattributed and unread.

## Repo-agnosticism note

This fix is **invariant-preserving** ([[feedback_pickle_rick_must_be_repo_agnostic_invariant]]): it adds no
per-repo knowledge. An analyst that verifies its citations before asserting them behaves identically on
pickle-rick-claude, loanlight-api, or a Python repo. `persona.md` infusion in particular reaches **every target
repo** — the outward-facing goal.

## Corroborating evidence on disk

- Session: `~/.local/share/pickle-rick/sessions/2026-07-14-ef12a95a/`
- Round-1 analyses (3 cycles, the fabrications): `refinement_round1/analysis_*.md`
- Round-2 analysis that CAUGHT the fabrication: `refinement/analysis_risk-scope.md` §1
- 44 unattributed path warnings: `refinement_manifest.round1.json#ticket_quality_warnings`
- The fabricated citation as committed: `17bfbf4f` (reverted by the follow-up commit)

## Related

[[R-BCFR]] (same shape, one level down: a citadel arm citing a rule that exists nowhere) · [[R-FOMH]] (the fable
residuals) · [[B-RLH]] (the bundle being refined when this surfaced) · the `hallucinated-premise` class in
`prds/CLAUDE.md`'s ticket failure-mode checklist.
