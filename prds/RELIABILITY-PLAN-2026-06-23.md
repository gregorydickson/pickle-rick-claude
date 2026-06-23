# Pickle Rick Reliability Plan — collapse the machinery, break the self-build trap

**Date:** 2026-06-23 · **Status:** REVISED post Codex review · **FIRST WAVE SHIPPED v2.0.0-beta.23** (B-DURA core M1 + M3-phase-advance + the subtraction; R-REIN; WS-2 run-blockers; WS-5 advisory audit — all deployed). · **Author:** babysitter session
**Evidence base:** full issue inventory (BUG-INDEX 126KB + MASTER_PLAN + archive + 5 recent bug reports + trap-door audit).

> **Execution status (2026-06-23):** §3 steps 1, 3, 4, 5 are **SHIPPED in beta.23** (see MASTER_PLAN B-DURA row).
> **NOT done:** §3 step 2 — the **codex AC-DURA-4 field-proof** (the decisive evidence; operator-deferred);
> the review-phase gate gaps (R-RPGT/R-S529, a separate GA-blocking 0/4 cause); R-SIGF full scope-auto-extension
> (only the advisory flag shipped); the wide oracle characterization net. The plan's central claim — that fixing
> M1 at the root + collapsing the oracle is the right cut — is *built but not field-validated on codex*.

> **Revision note (Codex critique folded in — full review in Appendix A).** The original draft made
> **M5 (self-build trap) the master defect** and centered **WS-4 (shadow-runtime / staged self-deploy)**.
> Codex rejected that: the loud June 22–23 failures are **runtime-truthfulness bugs** (Failed-as-pending,
> premature queue drain, signature fan-out, missing-toolchain) that a shadow runtime would *not* fix, and
> adding a second runtime/deploy mechanism **violates this plan's own subtract-first rule.** Changes applied:
> **(1)** M5 demoted to an *operational constraint*; **WS-4 cut as a build investment** → replaced by
> "freeze autonomous self-build for recovery bundles + formalize the hand-build protocol" (zero new
> machinery). **(2)** Codex multi-ticket validation moved to **immediately after WS-1**, not last.
> **(3)** Primary metric changed to **hands-off soak truthfulness + manual-intervention rate**; trap-door
> count demoted to secondary. **(4)** The previously scoped-out run-blockers (parseable file fences,
> signature-caller fan-out, recovery-refund, toolchain fail-fast, premature-drain) **pulled into the
> program.** **(5)** **B-DURA's AC-DURA-1..9 adopted as the execution contract**, with a wide oracle
> characterization net.

---

## 0. The diagnosis in one sentence

Pickle Rick is unreliable because its **completion / recovery / scope machinery has accreted into overlapping,
mutually-disagreeing guards** — **233 trap-doors, ~75% of recent fixes additive** — and **the system cannot
safely refactor that machinery on itself** (R-PSRB). So every fix to the #1 bug-source subsystem needs a
hand-build, and the machinery stays the #1 bug-source. **Reliability = collapse the machinery to single
invariants, delete the scaffolding, and break the self-build trap** — not add a 234th guard.

### The numbers (from the inventory)
- **41 distinct incidents** across the project's life. **Completion + salvage + recovery = 54%** of them.
- The **completion-evidence cluster alone = 22%** (13+ recurrences in 49 days). Every "fix" left a new seam.
- **233 named trap-doors**, 308 ENFORCE tests, 22 audit scripts. Recent ledger: **~75% additive, 25%
  subtractive** — the system is getting *more* guarded, not simpler.
- **GA-soak matrix:** claude single-ticket 4/4 ✅; claude multi-ticket not run; **codex multi-ticket 0-for-3.**

---

## 1. The five structural meta-defects (root causes, not bugs)

| # | Meta-defect | Mechanism | Evidence |
|---|---|---|---|
| **M1** | **Multiple oracles for one truth** (completion) | phantom-Done watcher, flip-gate `readEvidence`, and the salvage path each read the same frontmatter and can disagree | R-PFNT: watcher ACCEPTS `completion_commit:9adfed909`, flip-gate FATALS the *same* ticket as `absent` |
| **M2** | **Scope fence under/over-extends unpredictably** | fence is author-specified prose, not synthesized; readiness validates *contracts*, worker validates *files* — two universes | R-SIGF (signature change breaks an out-of-fence caller → build RED), R-DPMC (module omitted), R-SSOC (over-extend) |
| **M3** | **Recovery state-machine sprawl** | multiple entry/exit points + overlapping budgets + escape hatches that bypass each other + **inert recovery paths** | R-REIN (reset→Todo doesn't refund the ladder → `recovery_exhausted` in 2s), R-SLEAK (no session GC), 5 `allow_*`/`skip_*` flags |
| **M4** | **Guards stack on brittle guards** | when a guard false-positives, the reflex is a second escape hatch, not removing the guard; subtract-before-add is advisory prose, unenforced | readiness-too-strict → `skip_readiness_reason`; watcher reverts commits → `allow_inferred_completion_commit` |
| **M5** | **The self-build trap (R-PSRB)** | a bundle editing recovery machinery can't build autonomously — the deployed *pre-fix* runtime salvage-resets the ticket building the fix; and the running mux-runner executes the OLD compiled `.js` so the fix can't self-activate | B-PCOMP hand-built; this session's B-DURA hand-built; **structural, not a bug** |

**M5 is the master defect.** It is *why* M1–M3 persist: the subsystem that generates 54% of incidents is the
one the system cannot safely refactor on itself, so its complexity can only ever grow by hand. Break M5 and the
others become drainable autonomously.

---

## 2. The strategy: one invariant per defect, then delete the scaffolding

For each meta-defect, define the single invariant, **build the replacement, prove it, then subtract** the
machinery it makes redundant. Success is measured in **net trap-doors removed**, not bugs patched.

### WS-1 — One completion oracle (M1) — *largely BUILT (B-DURA)*
**Invariant:** *Done ⟺ one `readEvidence` confirms a durable, runner-authored commit of the ticket's diff
exists; the phantom-Done watcher, the flip-gate, and the salvage path all call that one function;
phase-advance derives from it.*

- **DONE & verified (B-DURA T10–T50, on `b-dura`, unmerged):** runner authors the boundary commit (T10);
  7-site Done-flip gate (T20); watcher ≡ flip-gate via shared baseline resolution (T30); `Failed` terminal
  for phase-advance under the empty-window guard (T40); no premature queue drain (T50). 238/238 tests, audits
  green.
- **REMAINING (B-DURA T60–T70, post-deploy):** **delete** `allow_inferred_completion_commit`, collapse
  `EvidenceKind` 4→2, narrow the R-CCRC fuzzy grep (keep file-touch), delete the `@deprecated hasCompletionCommit`
  shim + the dead `'unreachable'` variant, retire the B-PDBL backfill loop.
- **SUBTRACTION:** ~5 flags/kinds + a backfill-loop class + a deprecated shim; consolidate ~35 completion
  trap-doors toward one documented invariant + one ENFORCE test.

### WS-2 — One scope-fence source (M2)
**Invariant:** *the scope fence is synthesized from dependency analysis (a changed signature auto-includes its
positional callers; a registerable symbol auto-includes its registry), and readiness + the worker read the
SAME fence.*

- PRD template emits a concrete `## Files to modify/create` section (not Research-Seeds prose) — closes the
  R-PFNT "monitor can't parse scope → oversized misclassification."
- Scope auto-extends to positional callers of a changed injected/exported signature (R-SIGF); readiness flags
  signature-change-without-caller-co-scope.
- Collapse the readiness-contract-universe vs worker-files-universe duality into one fence object.
- **SUBTRACTION:** removes a whole class of "out-of-fence compile-RED" stalls; one fence, not two validators.

### WS-3 — One recovery model (M3)
**Invariant:** *one entry (status→Todo), one per-ticket budget that an explicit reset REFUNDS, one terminal
exit (`recovery_exhausted`).*

- **R-REIN:** refund the per-ticket recovery counter on explicit status-reset (makes the documented recovery
  non-inert). Recovery-machinery → **fold into B-DURA's remaining build.**
- Unify the overlapping `allow_*`/`skip_*` escape hatches onto the single surface (extend the W1a
  `skip_quality_gates_reason` consolidation to the `allow_*` family).
- **R-SLEAK:** session-GC for `active:false` stale sessions + an accurate contention gauge
  (`ps -eo command | grep '/claude '`, not `pgrep -f claude`).
- **SUBTRACTION:** collapse multiple budgets/hatches to one; delete leaked-session accumulation.

### WS-4 — Contain the self-build trap (M5) — *operational constraint, NOT a build investment* (revised)
**Codex verdict: WS-4-as-a-new-mechanism is cut.** A shadow runtime / staged self-deploy is *additive
machinery on the exact subsystem whose pathology is too many overlapping mechanisms* — it would let the same
runtime-truthfulness defects run somewhere else, not fix them. The reliable, subtract-first answer already
exists as practice:

- **Freeze autonomous self-build for recovery-machinery bundles.** Make `build_protocol: self-modifying-recovery`
  a **required** front-matter field for any bundle touching the salvage/completion/recovery/scope set, and have
  readiness/the pipeline **refuse to autonomously build** such a bundle — it must be hand-built on claude,
  deployed via `install.sh`, then resumed (exactly what B-PCOMP and B-DURA did). This **removes the R-PSRB
  class with zero new machinery.**
- **Revisit an automated self-build mechanism only post-GA**, once the ordinary runtime is demonstrably
  trustworthy (the soak metric below is green) — and only if the manual protocol proves to be the actual
  bottleneck. Until then it is a deferred capability, not a reliability fix.

*(Original WS-4 shadow-runtime/self-deploy proposal retained in git history for the post-GA revisit; it is
explicitly NOT in the reliability program.)*

### WS-5 — Enforce subtract-before-add (M4) — governance → code-gate
**Invariant:** *no bundle increases net machinery without justification; the trap-door count trends down.*

- Bundle-close code-gate: any new `skip_*`/`allow_*` flag or trap-door MUST cite the guard it removes/loosens.
- Surface **net-trap-door-delta** as a release signal (a positive delta is a yellow flag, not auto-block).
- **SUBTRACTION:** turns the advisory W5b prose into a measured, enforced trend.

### WS-6 — Codex parity (M5-adjacent) — *after the core lands*
- B-DURA already makes durability **runner-side / backend-agnostic** → fixes most codex symptoms structurally.
- Then: codex worker-template parity (per-ticket commit + attributable subject) and codex-derived
  manager/watchdog tuning (not transposed from claude).
- **Gate GA-on-codex on a green multi-ticket soak**; until then document codex as claude-assisted only.

---

## 3. Sequencing (revised — codex validation moved forward)

1. **Merge B-DURA core to `main`** (verified T10–T50). Deploy gated only on the live LOA-1363/1488 soaks
   finishing so `install.sh` doesn't redeploy under them. → closes M1 + M3-phase-advance.
2. **Prove the core on codex IMMEDIATELY** (Codex change #2). Re-run the LOA-1363/1488 multi-ticket bundle on
   `--backend codex` per **AC-DURA-4** the moment the core is deployed — codex multi-ticket is the loudest
   failure (0-for-3); the core invariants must be proven against it *first*, not in a final parity phase. A
   red here reshapes everything downstream.
3. **B-DURA T60–T70 + R-REIN + a wide oracle characterization net** on the fixed runtime → completes the M1
   subtraction + M3 recovery-refund. The net must cover the known evidence edge-shapes: quoted/full-SHA
   (R-CCQF), ref-code fallback (R-CCRC), inferred-fresh auto-promote (R-WUWC), untagged-but-real worker commit
   (AC-DURA-8) — *not* a single ENFORCE test (Codex change #5).
4. **WS-2 scope-fence + the pulled-in run-blockers** (Codex change #4): parseable `## Files to modify/create`
   fence in the refine template, signature-caller fan-out auto-extension (R-SIGF), toolchain fail-fast
   (missing `node_modules` → fail in 1 iteration, not 30), and the `oversized_no_progress` →
   `scope_unresolvable`/`no_progress_timeout` split. These are run-blockers, not polish.
5. **WS-5 subtract-before-add gate** — makes the trend self-policing.
6. **WS-3 session-GC / contention-gauge (R-SLEAK)** + remaining hygiene.
7. **Deferred post-GA:** an automated self-build mechanism (old WS-4) — only if the hand-build protocol proves
   to be the bottleneck after the runtime is trustworthy.

---

## 4. Success metrics (revised — truthfulness/intervention primary, trap-doors secondary)

**Primary (Codex change #3) — hands-off soak truthfulness + manual-intervention rate, split by backend ×
bundle-shape.** Count only runs that finish **truthfully**: `4/4` phases, **zero operator interventions**,
**zero false `done_without_commit_evidence`**, no exit while non-`Failed` Todo/In-Progress tickets remain
(per AC-DURA-4/6/7/9). This measures the exact failures the bug reports describe — it is a *lagging* indicator
of reliability, unlike trap-door count.
- **GA gate:** ≥3 truthful hands-off runs incl. ≥1 multi-ticket on **both** claude and codex; zero new
  completion-class seam across the soak; manual-intervention rate → 0.

**Secondary (leading indicators):**
- **Net trap-door count trend** — a *technical-debt* leading indicator, NOT a primary gate (it is gameable by
  rename/merge/delete-doc, so it can improve while behavior stays broken). Watch the trend; don't gate on it.
- **Mean-time-between completion-cluster incidents** rises from "days" to "not observed across the soak."

**Execution contract (Codex change #5):** each workstream adopts explicit ACs in the shape of **B-DURA's
AC-DURA-1..9** (machine-checkable, both-backend) — "done" is defined per workstream up front, not verified
after the fact.

---

## 5. The honest meta-point (for the reviewer to attack)

The conventional read is "fix R-CECX/R-PFNT/R-REIN/R-SIGF and ship GA." This plan asserts the deeper read:
**those four are symptoms of M1–M3, and M1–M3 persist because of M5.** The highest-leverage work is therefore
**WS-4 (break the self-build trap)** and **WS-1/WS-5 (collapse + enforce subtraction)** — not draining the four
bugs individually. If that prioritization is wrong — if WS-4 is over-engineering and the pragmatic path is
"just drain the four and tune codex" — the review should say so, with reasoning.

### Specific claims to stress-test
1. Is M5 really the master defect, or a rationalization to avoid the grind of draining M1–M3 bug-by-bug?
2. Is the WS-4 shadow-runtime/self-deploy mechanism worth the complexity it *adds* (does it violate this very
   plan's subtract-first principle)?
3. Does collapsing 3 oracles to 1 (WS-1) risk a single-point-of-failure that's *less* robust than 3
   cross-checking approximations?
4. Is "trap-door count trends down" a sound reliability metric, or a vanity metric that could be gamed?
5. Is the sequencing right — should codex parity (WS-6) come *before* WS-4/WS-5 since codex 0-for-3 is the
   loudest current failure?

> **These five were answered by Codex (Appendix A): #1 M5-master FLAWED, #2 WS-4 FLAWED (cut), #3 oracle
> collapse SOUND (but needs a wide net), #4 trap-door metric FLAWED (replace), #5 codex-last FLAWED (move
> forward). All five rulings are folded into §1–§4 above.**

---

## Appendix A — Codex (gpt-5.4) adversarial review, verbatim

> **Verdict: SHIP WITH CHANGES.** Keep WS-1/B-DURA as the core (most evidence-backed). Required changes:
> **(1)** Demote M5 from "master defect" to "operational constraint"; freeze autonomous self-build for
> recovery bundles; formalize the claude hand-build protocol; **cut or defer WS-4.** **(2)** Move codex
> multi-ticket validation forward — every core invariant re-proven on codex immediately after WS-1 lands,
> not deferred to a final parity phase. **(3)** Replace trap-door trend as the primary gate metric with
> hands-off soak truthfulness/intervention metrics; keep the count as a secondary leading indicator.
> **(4)** Pull the scoped-out run blockers into the program: parseable file fences, signature-caller
> fan-out, recovery refund on reset, toolchain fail-fast, premature queue-drain prevention. **(5)** Adopt
> B-DURA's AC-DURA-1..9 as the execution contract, not after-the-fact verification.
>
> *Missing surfaces flagged:* plan-level test strategy / per-workstream ACs; upstream refinement-authoring
> quality (parseable fences + signature fan-out are blockers, not side issues); observability/fail-fast gaps
> that burn unattended time (missing `node_modules` → ~30 iters of churn; oversized misclassification); and a
> first-class **manual-intervention-rate** metric — "until that rate is a first-class metric, autonomy is
> aspirational."
>
> *On the oracle collapse (WS-1):* SOUND, but if `readEvidence` is wrong the system fails on already-known
> edge shapes (R-CCQF quoted-SHA, R-CCRC ref-code, R-WUWC inferred-fresh, AC-DURA-8 untagged-real-commit) —
> the collapse needs a wide characterization net, not one ENFORCE test.
>
> *On M5:* "a real constraint, but calling it the master defect is a rationalization. The live evidence is
> dominated by run-time truthfulness failures … a shadow runtime would not fix any of those. It would let
> the same defects run somewhere else." *Best idea: the durable boundary + one oracle. Worst idea: turning
> self-build automation into the centerpiece before the ordinary runtime is trustworthy.*
