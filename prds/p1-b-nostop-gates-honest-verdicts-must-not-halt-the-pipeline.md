---
title: "B-NOSTOP-GATES — an honest verdict may never halt the pipeline"
priority: P1
finding: B-NOSTOP-GATES
composes: []
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
self_modifying_recovery: true   # WS-2 edits the completion-evidence / Done-flip stamper (R-PSRB path) — pipelined + ATTENDED per B-RASO precedent, NOT hand-built
source_assessment: "OPERATOR DIRECTIVES 2026-07-25 (MASTER_PLAN top), directive 4. Grounded 2026-07-25 at HEAD f9739caa against the live wedge in session 2026-07-25-38095284 (R-WDTF-TO), whose every artifact is on disk and quoted verbatim below. Two MASTER_PLAN premises were CORRECTED while grounding — see §0."
---

# B-NOSTOP-GATES — separate the VERDICT from the DISPOSITION

**One-line thesis:** [[B-NONSTOP]] (beta.5) successfully made the runner *honest* — it now reports
"did NOT converge" where it used to claim success. This bundle fixes what that honesty cost us:
**every honest negative verdict was wired to `{action:'break'}`.** The runner stopped lying and
started stopping. Directive 2 names the consequence exactly — *a quality gate that STOPS the system
takes quality to ZERO.*

The fix is **not** a smarter completion oracle (directive 4 forbids that — we have tried it four
times). It is a control-flow subtraction, and it reduces to **ONE RULE**:

> **Honesty is a REPORTING property. Halting is a DISPOSITION. They are not the same wire.**
> A completion / disposition / quality verdict may set `exit_reason`, may refuse a LOCAL action
> (don't flip THIS ticket Done, don't ship THIS commit), and MUST record a human-review residual.
> **It may never break the phase loop.** The pipeline halts only when it *cannot physically
> continue*: `fatal`, `state_schema_version_ahead`, `state_working_dir_missing`,
> `toolchain_unavailable`, iteration/budget cap, operator cancel. That set is **closed** — a
> quality verdict is never admitted to it.

**One rule, not a classification table.** An earlier draft of this PRD sorted each halt site into
CONTINUE-vs-HALT by hand — including "a phase that made zero progress may still halt." That is the
treadmill at a smaller scale: a per-site special-case matrix that the next incident extends. It is
also wrong on its own terms. *"Zero progress"* is a **reporting** fact — say it loudly, refuse the
success panel, park the tickets — and then **run the review phases anyway**, because citadel /
anatomy-park / szechuan-sauce operate on the tree, not on the roster, and a stopped pipeline delivers
nothing at all. Stopping never converted a bad build into a good one; it only ever converted a
partial build into no build.

---

## §0 — PREMISE CORRECTIONS made while grounding (the ledger was wrong twice)

Per [[feedback_reground_the_ledger_before_building_from_it]], every claim below was re-grepped at
HEAD `f9739caa`. Two MASTER_PLAN entries did not survive:

| # | MASTER_PLAN premise | Verdict at HEAD | Correction (the build follows THIS) |
|---|---|---|---|
| C1 | "F9 = zero-diff arm has **no producer wired yet** — latent P1, forward-pinned by a test"; drain table: "Parked latent … inert-by-construction (refuses safely)" | **PREMISE TRUE, INFERENCE FALSE — and the distinction is the whole point.** "Producer" means a **WRITER** of the `zero_diff_intent` frontmatter field, and there genuinely is none in production — deliberately, pinned by `tests/zero-diff-completion-arm.test.js:397` ("READ-ONLY in production"), because both corroborating conditions (lifecycle artifacts, worker gate) are worker-producible, so a runtime writer would let a worker **self-certify a commit-less Done**. That premise is correct and must be preserved. **But the inference "therefore latent / inert / parked" is false:** the declaration arrives from a human or refinement-time author — which is exactly what the pin says makes the arm safe — so the arm is **routinely reached in real bundles**. Ticket `7af891d4` carried `zero_diff_intent: audit`, the arm was reached, and its (correct) refusal **stopped a 4-phase pipeline at 0/4**. | The arm is **live and correctly implemented**; only its CONSEQUENCE is catastrophic, which is WS-1's job, not the oracle's. WS-2 targets the foreign-SHA stamper. **Hard constraint: WS-2 MUST NOT add a production WRITER of `zero_diff_intent`** — see WS-2 "Authorship constraint". *(Author's note: an earlier draft of this row claimed "the producer IS wired," citing `mux-runner.ts:4792` — that is the sanctioned **read**, not a producer. The ledger was right about the mechanism; wrong only about the consequence.)* |
| C2 | "the completion oracle refusing a legitimate zero-diff ticket (F9)" is the halt (B-NOSTOP-GATES queue note, halt site (b)) | **Mis-attributed.** `zeroDiffAccept` refusing on `foreign_attribution` is **correct and deliberate** (`ticket-completion-evidence.ts:961-971`: *"Hard-absent evidence … is NEVER laundered by a declaration: a zero-diff ticket has no business carrying a stamp at all"*). The oracle is the only component in the chain that behaved correctly. | **Do not touch `zeroDiffAccept`'s hard-absent guard.** The bug is upstream (a stamper wrote a foreign SHA — WS-2) and downstream (an all-terminal roster still broke the loop — WS-1). Adding a laundering path here would be exactly the directive-4 treadmill. |

**What this means for scope:** the queue note framed this bundle as "make the oracle's halts
continue." Grounding says the oracle's *refusal* was right; only its **consequence** was wrong. This
bundle therefore edits **control flow and one stamper**, and leaves the evidence ladder alone.

---

## The measured wedge — session `2026-07-25-38095284`, verbatim from disk

The R-WDTF-TO bundle **finished its work** and the pipeline **reported zero phases complete**.
Every line below is quoted from the session on disk, not reconstructed.

**Roster ground truth** (`<session>/<hash>/rick_ticket_<hash>.md`, all six):

```
33f4960b  status: "Done"      4404d032  status: "Done"      47ddf936  status: "Done"
7af891d4  status: "Done"      89da513d  status: "Done"      ef394937  status: "Done"
```

**The pipeline log, in full — two lines, the entire run:**

```
[2026-07-25T22:27:48.462Z] Phase pickle exited with code 3
[2026-07-25T22:27:48.465Z] Phase pickle exited (exit_reason=done_without_commit_evidence); 0/6 tickets remain unfinished.
```

`0/6 tickets remain unfinished` — **and it stamped `pipeline_phase_incomplete` and broke anyway.**
6/6 Done, 6 commits landed (incl. a CRITICAL and a HIGH audit fix), `tsc`+`eslint` green,
**0/4 phases reported, citadel + anatomy-park + szechuan-sauce never ran.** Review-phase quality: zero.

### The causal chain (each link grep-verified, in execution order)

| # | Site | What happens | Correct? |
|---|---|---|---|
| 1 | a `persistEvidence` seam — **primary hypothesis `promoteOnceAndReprobe` (`ticket-completion-evidence.ts:876`, R-WUWC promote-once)**, secondary `maybeAutoCloseSplitOriginal` (`mux-runner.ts:1507`) | Writes an **EXPLICIT** `completion_commit` onto ticket `7af891d4`, which declared `zero_diff_intent: audit` (i.e. declared it would produce **no commit of its own**). **The stamp MOVED during the run:** observed as `fc4f44f1…` (ticket `33f4960b`'s commit) at 22:17Z, and `0bde4711…` (`audit(ef394937): …`) at close — i.e. it tracked *advancing HEAD*, not a stable twin. | ❌ **WS-2** |
| 2 | `ticket-completion-evidence.ts:576-580` (`isForeignAttributedExplicitSha`, R-OMA) | The message word-boundary-names a DIFFERENT ticket (`ef394937`) → `{kind:'absent', absentReason:'foreign_attribution'}`. | ✅ correct |
| 3 | `ticket-completion-evidence.ts:970` (`zeroDiffAccept` first guard) | `foreign_attribution` is hard-absent → **refuses to launder it** → falls to `refuseAbsent` (`:1035`). | ✅ **correct — do not touch** |
| 4 | mux-runner exit map | `done_without_commit_evidence` → exit code **3** (PhaseIncomplete), per B-GTRUTH WS-A2. | ✅ correct |
| 5 | `pipeline-runner.ts:3527` (`reportPhaseIncomplete` skip branch) | Skip is gated on **`statusUnfinished > 0`**. All six tickets were Done → `statusUnfinished === 0` → **the skip branch is unreachable** → falls through to the genuine stamp. | ❌ **WS-1** |
| 6 | `pipeline-runner.ts:3546` → `:4100` (`resolvePhaseIncompleteOutcome`) | `reportPhaseIncomplete` returns `true` → `{action:'break', phaseIncomplete:true}`. **Pipeline over.** | ❌ **WS-1** |

**Read link 5 twice.** The `statusUnfinished > 0` conjunct was added (B-PXBO) so that *non-ticket*
incompleteness would still be reported. Its side effect is that the **best possible roster state —
every ticket Done — is the one state that cannot reach the skip.** A fully-successful phase and a
phase with a non-ticket failure are indistinguishable there, and both halt.

### Why this is the fourth patch, not the first

`reportPhaseIncomplete` already carries: the pure status filter, the B-PXBO oracle re-resolution
(`resolveUnfinishedTickets:3486`), the `statusUnfinished` gate, the B-GTRUTH WS-A2 observable
boolean, and `resolvePhaseIncompleteOutcome`'s roster re-check. Five refinements to one predicate,
**each one added a new way to stop.** This is the treadmill directive 4 names. The bundle's job is
to make the predicate's answer *not matter* to the loop.

---

## Halt-site inventory — the sweep surface (grep-verified at HEAD `f9739caa`)

Research MUST re-derive this table (line numbers drift); it is the starting roster, not the answer.
Apply the ONE RULE to every row — the middle column is the *verdict being reported*, which survives;
the right column is the *disposition*, which becomes CONTINUE unless the runner cannot physically proceed.

| Site | Verdict it reports (KEEP) | Disposition |
|---|---|---|
| `pipeline-runner.ts:3546` `reportPhaseIncomplete` stamp | `pipeline_phase_incomplete` | keep the stamp, **drop the break** |
| `pipeline-runner.ts:4100`,`:4105` `resolvePhaseIncompleteOutcome` | stamp true / `pendingAfterOracle > 0` | CONTINUE |
| `pipeline-runner.ts:3668` graduation gate `phase_no_progress` | 0 Done of N, 0 commits — **report LOUDLY, refuse the success panel** | CONTINUE (see below) |
| `pipeline-runner.ts:3672` graduation gate `pendingCount > 0` | N pending | CONTINUE |
| `pipeline-runner.ts:4270` `maybeStampPickleIncompleteRobust` | sentinel present | CONTINUE |
| `pipeline-runner.ts:2806` `isFatalPhaseFailure` — `countCommitsSince === 0` | zero commits all phase | CONTINUE |
| `pipeline-runner.ts:2808-2821` anatomy/szechuan microverse reasons | judge timeout / exhausted / unmeasurable-transient — **unrunnable, not failed** (cf. B-RGATE's "unrunnable ≠ red") | CONTINUE |
| `mux-runner.ts:4420` `FAILURE_EXIT_REASONS` / `:4443` `INCOMPLETE_EXIT_REASONS` | classifier membership | audit against the three-classifier lockstep comment (`:4405`); membership drives the PANEL, not the loop |
| `pipeline-runner.ts:2805` `isFatalPhaseFailure` — `!startCommit` | missing baseline | **HALT** — cannot compute a diff; physically cannot proceed |
| `pipeline-runner.ts:2823`,`:2825` — default `true` / `catch → true` | unknown phase / unreadable state | **HALT**, but must LOG which arm fired (today it is silent) |
| `pipeline-runner.ts:2840` `shouldHaltAfterPhase` strict | `pipeline_continue_on_phase_fail === false` | **HALT** — explicit operator opt-in, the one sanctioned override; leave it alone |
| microverse `rate_limit_exhausted` | budget exhausted | **HALT** (budget cap is in the closed set) |
| `mux-runner.ts` `executeBoundedEscape` (`gate: () => 'failing'`) | bounded terminal escape | **verify at research time** — drain item 4 (Tier-3-F). In scope ONLY if it halts a phase; if it merely skips a ticket it stays out (own PRD). |

### On the two "fake-green guards" — the correction the guiding principle forces

`phase_no_progress` and `countCommitsSince === 0` are **anti-fake-green guards**, and they stay — as
**reporting**. Their job is to prevent the runner *claiming success* over an empty build, and that job
is done entirely by `deriveCompletionVerdict` / `INCOMPLETE_EXIT_REASONS` / the panel (B-NONSTOP WS-2).
Breaking the phase loop was never what made them honest; it is a second, separable effect that costs
us every downstream review phase. **AC-NS-6 and AC-MWMO-D2-8 survive intact, re-pinned against the
verdict and the panel instead of against the break** — see AC-NS-3. Any reviewer reading "we relaxed
the fake-green guard" has misread this: the guard's *assertion* is unchanged and newly test-pinned;
only its authority over the loop is removed.

---

# WS-1 — an all-terminal roster may not break the loop (the core subtraction)

**Defect:** links 5-6 above. `statusUnfinished === 0 && unfinished.length === 0` — the healthiest
possible roster — falls through to the stamp and the break.

**Fix (subtractive, control-flow only):** the PhaseIncomplete route reports honestly and **advances**
when the roster is fully terminal. Concretely: `reportPhaseIncomplete` keeps stamping (honesty is
B-NONSTOP's win — do not regress it), and `resolvePhaseIncompleteOutcome` stops converting that stamp
into `{action:'break'}` when no ticket is genuinely unfinished AND no ticket is status-runnable. The
residual is flagged for a human (WS-3), the phase advances, citadel/anatomy/szechuan run.

**Acceptance (machine-checkable):**
- **AC-NS-1** Fixture: 6 tickets all `status: Done`, mux exit code 3, `exit_reason=done_without_commit_evidence`. `runPhaseIteration` returns an outcome whose `action` is **not** `'break'`, and the pipeline reaches the citadel phase. Asserted on the outcome object, not on a log string.
- **AC-NS-2** The same fixture still records `exit_reason` ∈ {`pipeline_phase_incomplete`, `done_without_commit_evidence`} in `state.json` — the verdict is preserved, only the disposition changed. (Pins "we did not fix this by lying.")
- **AC-NS-3** Anti-fake-green pin, **re-aimed at the verdict**: fixture with **0 Done of 6** and **0 commits since `start_commit`** (a) stamps an incomplete `exit_reason`, (b) `deriveCompletionVerdict` does **not** return a success/"Complete" verdict, and (c) the phase **still advances**. AC-NS-6 / AC-MWMO-D2-8 are re-expressed as assertions on (a)+(b) — assert the verdict and the panel, never the `break`.
- **AC-NS-4** A status-runnable roster (3 Done, 3 `Todo`) does **not** silently advance *as if complete*: it parks the 3 runnable tickets with a residual (WS-3) and reports `pipeline_phase_incomplete`. **The B-PXBO / R-ICP-2 exit-3 contract is preserved at the EXIT CODE, not by breaking early** — `pipeline-runner-halt-on-incomplete.test.js` must be updated deliberately, not deleted, and the ticket artifact must show the old and new assertion side by side with a one-line rationale.
- **AC-NS-5** Exit code on the AC-NS-1 and AC-NS-4 paths is **0 or 3, never 1** — `auto-resume.sh` keys retry on 3 (see the `resolvePhaseIncompleteOutcome` docstring warning: an exit-1 here silently converts a resumable race into a dead session).
- **AC-NS-5b** No quality/completion verdict reaches `dispatchHaltAction` (`:4024`): assert that for every reason in `INCOMPLETE_EXIT_REASONS` ∪ {`pipeline_phase_incomplete`, `phase_no_progress`}, `shouldHaltAfterPhase` returns `false`. This is the ONE RULE as a single machine-checkable invariant — prefer it over per-site tests.

**Simplification Review:**
1. *Necessary?* Adds **no** state field, flag, or guard. Deletes/relaxes one conjunct and one `break`. Pure removal.
2. *Reuse?* Yes — reuses the existing `PhaseIterationOutcome` union and `recordExitReason`. No parallel mechanism.
3. *Guards brittle complexity?* Yes, and it **subtracts** it: five stacked refinements of one predicate is the brittleness. We stop refining the predicate and cut its authority over the loop instead.
4. *Subtracts?* One conjunct (`statusUnfinished > 0`) and one control-flow edge. Net LOC negative.

---

# WS-2 — stop stamping a foreign SHA onto a ticket that declared it has none

**Defect:** link 1. A `persistEvidence` seam wrote an **EXPLICIT** `completion_commit` onto a ticket
that had declared it would produce none. R-OMA then correctly rejected it as foreign — the stamp
**manufactured** the hard-absent condition that stopped the run.

**The stamp MOVED, which identifies the seam.** Recorded at `fc4f44f1…` (ticket `33f4960b`'s commit)
at 22:17Z and `0bde4711…` (`audit(ef394937): …`) at close: it tracked *advancing HEAD*. A twin-borrow
would have been stable, so the **primary hypothesis is `promoteOnceAndReprobe`**
(`ticket-completion-evidence.ts:872-884`, R-WUWC promote-once), not the split-twin path.

**And that exposes the real inconsistency — the two arms disagree about the same SHA.**
`promoteOnceAndReprobe` is reached ONLY when `isAcceptedEvidence(evidence)` is already true: the
**scan** arm ACCEPTED that SHA as this ticket's evidence. Promote-once then persists it into the
explicit field, and on the next read the **explicit** arm applies R-OMA (`:576`) and REJECTS the very
same SHA as hard-absent. **One arm's accepted evidence becomes the other arm's positive
mis-attribution.** Nothing about the ticket changed — only which arm read it. That is the bug: not
"the oracle is too strict" but "the oracle's two arms hold contradictory attribution rules, and
promote-once is the wire that converts an acceptance into a refusal."

Already filed: [[project_zero_diff_ticket_stamped_foreign_completion_commit]], which predicted
*"R-OMA hard-absent would REFUSE its Done-flip."* **It just did, in the field, and it cost 3 phases.**

**Fix (subtractive — one rule, applied to whichever seam research confirms):** *never promote a SHA to
EXPLICIT that the explicit arm would reject.* Two candidate subtractions, and research picks by
evidence, not preference:
- **(a) preferred — don't write it:** a ticket DECLARING a recognized `zero_diff_intent` is never a
  promote/borrow target. No stamp, and `zeroDiffAccept` evaluates it on its declaration + lifecycle
  artifacts, which is exactly what it is built for and what it would have accepted.
- **(b) if (a) proves too narrow** (i.e. undeclared tickets hit the same promote→reject flip): apply the
  R-OMA foreign check **in the scan arm too**, so a foreign SHA is never accepted as scan evidence in
  the first place. This *unifies* the two arms rather than adding a third rule — strictly simplifying.

### Authorship constraint — HARD, do not trip this pin

`tests/zero-diff-completion-arm.test.js:397` asserts `zero_diff_intent` is **READ-ONLY in
production**: the only sanctioned occurrence in `src/` is `readFrontmatterField(<x>, 'zero_diff_intent')`.
The reason is exactly this bundle's own thesis — a worker writes its own lifecycle artifacts and runs
its own gate, so a runtime **writer** of the declaration would let a worker **self-certify a
commit-less Done**. That is the self-certification beta.6 removed from the commit-count proxy; do not
re-introduce it here.

- **WS-2 adds NO writer of `zero_diff_intent`.** Fix (a) is a **read** — implement it by calling the
  existing `readDeclaredZeroDiffIntent` (`mux-runner.ts:4806`), whose call site contains no
  `zero_diff_intent` literal and therefore does not extend the pin's scan surface.
- **AC-NS-8b:** `tests/zero-diff-completion-arm.test.js` (both F9 pins) stays green **unmodified**. If
  a ticket believes it must extend the sanctioned set, that is a STOP — escalate to the operator
  rather than editing the pin. The test's own message says: *"Do not simply delete this assertion."*

**Research MUST answer, in the artifact:** which seam actually wrote it (instrument or replay — the
moving-SHA observation above is the discriminator), and whether the promote→reject flip reproduces for
an **undeclared** ticket. If it does, the defect is wider than zero-diff and (b) is the fix.

**Acceptance:**
- **AC-NS-7** Fixture: ticket declaring `zero_diff_intent: audit` + a Done sibling with a commit naming the sibling. After the phantom-Done/auto-close pass, the declared ticket's frontmatter has **no** `completion_commit`, and `evaluateCompletionEvidence` returns `{ok: true, via: 'zero-diff'}`.
- **AC-NS-8** `zeroDiffAccept`'s `baseline_sha`/`foreign_attribution` hard-absent guard is **unchanged** — assert the guard's behavior directly (a declared zero-diff ticket that IS carrying a foreign SHA still refuses). Laundering is not the fix.
- **AC-NS-9** Negative pin: a genuine split original **without** a `zero_diff_intent` declaration still auto-closes with the twin's SHA (R-PDUP unchanged; the 20MB-state infinite-loop guard — EXPLICIT never `_inferred` — survives).
- **AC-NS-10** Regression pin on the real shape: reconstruct the `7af891d4` frontmatter as a fixture; the end-to-end oracle verdict is committed-or-zero-diff, **not** `absent`.
- **AC-NS-10b** **Arm-agreement invariant** (the general statement of this defect): for any SHA `S` and ticket `T`, if the scan arm accepts `S` as `T`'s evidence, then persisting `S` as `T`'s EXPLICIT `completion_commit` and re-reading MUST NOT yield `absent`. Property-style test over a small fixture matrix (own-commit / foreign-commit / baseline / unreachable). **This one assertion would have caught the wedge**, and it pins fix (a) and (b) equally — it is the AC to write first.

**Simplification Review:**
1. *Necessary?* Adds a skip condition (one predicate) on an existing write. No new state/flag.
2. *Reuse?* Reuses `readDeclaredZeroDiffIntent` (`mux-runner.ts:4806`) — already wired, C1 above. **Explicitly rejected:** widening `ownAttributionTokens` to launder the borrow — that guards a brittle path with a second hatch (Q3 smell) and defeats R-OMA's purpose.
3. *Guards brittle complexity?* It **removes an input** to a brittle path rather than teaching the path to tolerate it — [[feedback_subtract_flaky_gate_input_not_add_resistance]] applied to the oracle's input.
4. *Subtracts?* A frontmatter write that should never have happened. Fewer stamps, fewer foreign-attribution refusals downstream.

---

# WS-3 — the residual surface: output-with-flags must be auditable

Directive 2 requires *park the item, flag it for a human, and CONTINUE.* WS-1/WS-2 deliver the
continue. Without a flag, a continuing pipeline silently advances over an unaccounted ticket — which
is fake-green, the thing we spent beta.5 killing. This WS is what makes "continue" honest rather
than lax.

**Fix (reuse only — no new machinery):** each parked verdict emits ONE activity event through the
existing `logActivity` surface naming the ticket, the phase, and the verdict, and the phase's
completion panel reports the parked count. **No new state field, no new file, no new gate.**

**Acceptance:**
- **AC-NS-11** The AC-NS-1 fixture emits exactly one activity event per parked ticket, carrying `{ticket_id, phase, verdict/exit_reason}`; asserted on the parsed event object.
- **AC-NS-12** The end-of-run completion panel states the parked count and does **not** render an unqualified "Complete" when it is > 0 (reuses `deriveCompletionVerdict` / `INCOMPLETE_EXIT_REASONS` — B-NONSTOP WS-2's honesty gate stays authoritative).
- **AC-NS-13** Zero parked items ⇒ panel output byte-identical to today's clean-run panel (no cosmetic churn).

**Simplification Review:**
1. *Necessary?* Yes — it is the "flag" half of directive 2; without it WS-1 is a fake-green regression.
2. *Reuse?* `logActivity` + `deriveCompletionVerdict`, both shipped. A new residual ledger file would be new machinery — **rejected**.
3. *Guards brittle complexity?* Neutral.
4. *Subtracts?* No subtraction available — this is the minimum honest reporting for a non-stopping pipeline. Recorded per the authoring rule.

---

# WS-4 — verification: RUN the claim

Per [[feedback_add_a_verification_ticket_that_runs_the_claim]] and the R11 precedent (beta.4, where a
PRD's "unblocks X" claim was verified and turned out **wrong in two ways**): a bundle asserting "the
pipeline no longer halts on an honest verdict" must **run a pipeline** and record what actually
happened, including the NEXT blocker.

**Acceptance:**
- **AC-NS-14** Replay the wedged fixture (session `2026-07-25-38095284`'s roster shape) through `pipeline-runner` end-to-end and record, in the ticket artifact, the phase count reached. Must be **> 1** (pre-fix: 0/4).
- **AC-NS-15** The artifact NAMES the next blocker encountered (or states "none reached") and whether it is CONTINUE-class (a WS-1 miss — file it) or CRASH-FLOOR-class (correct). **A "no next blocker, all green" verdict without a named phase count is not acceptance.**
- **AC-NS-16** The artifact states, explicitly, whether the halt-site inventory table above was found COMPLETE at research time, listing any site found that this PRD missed. Ledger drift runs ~2-in-6; this AC assumes this PRD is wrong somewhere.

**Simplification Review:** pure verification, adds no product code. Subtraction: n/a (verification ticket).

---

---

# Interface Contracts

## The type IS the bug (WS-1)

```ts
// pipeline-runner.ts:3852 — CURRENT
type PhaseIterationOutcome =
  | { action: 'continue' }
  | { action: 'break'; phaseIncomplete?: boolean };   // <-- 'incomplete' EXISTS ONLY ON 'break'
```

`phaseIncomplete` is reachable only on the `'break'` arm, and `:3846` turns it into the process exit
code (`if (phaseIncomplete) process.exit(PhaseIncomplete /* 3 */)`). **"This phase is incomplete" and
"stop the pipeline" are the same field.** The verdict/disposition split is therefore not a metaphor —
it is a one-line type widening:

```ts
// TARGET — the minimal change that makes the rule expressible
type PhaseIterationOutcome =
  | { action: 'continue'; phaseIncomplete?: boolean }   // report incomplete AND advance
  | { action: 'break'; phaseIncomplete?: boolean };     // unchanged (crash floor only)
```

The session's final exit code then derives from **whether any phase reported incomplete**, not from
which arm ended the loop. No new state field, no new file: the accumulator is a local in the phase
loop, and `exit_reason` on disk is already the durable record.

| Symbol | Contract |
|---|---|
| `reportPhaseIncomplete(runtime, phase)` | `-> boolean`. UNCHANGED semantics: `true` = stamped `pipeline_phase_incomplete`. Callers may no longer treat `true` as "break". |
| `resolvePhaseIncompleteOutcome(runtime, rawPhase, exitCode, log)` | `-> PhaseIterationOutcome \| null`. Returns `{action:'continue', phaseIncomplete:true}` when the roster is fully terminal; `null` to fall through; `{action:'break'}` only for crash-floor reasons. |
| `shouldHaltAfterPhase(phase, exitCode, runtime)` | `-> boolean`. MUST return `false` for every reason in `INCOMPLETE_EXIT_REASONS` ∪ {`pipeline_phase_incomplete`, `phase_no_progress`}. This is the invariant of AC-NS-5b. |
| `evaluateCompletionEvidence(ctx)` | **UNCHANGED.** Success arm keeps non-nullable `sha` (or `via:'zero-diff'`); `zeroDiffAccept`'s hard-absent guard is untouched. |
| `readDeclaredZeroDiffIntent(sessionDir, ticketId)` | `-> string \| null`. Read-only. WS-2 reuses it; adds NO writer of `zero_diff_intent`. |
| Exit codes | `0` Success, `1` Failure, `3` PhaseIncomplete. A quality verdict yields **0 or 3, never 1** (`auto-resume.sh` keys retry on 3). |
| Residual event (WS-3) | `logActivity({event, source:'pickle', ticket_id, phase, reason})` — existing surface, no new schema. |

---

# Verification Strategy

All commands run from `extension/`. Single-file form is `node bin/test-runner.js <file>` — **never bare
`node --test <file>`**, which drops `node_modules/.bin` from PATH and fabricates failures
([[project_node_test_single_file_repro_fabricates_failures]]).

| AC | Verify command | Type |
|---|---|---|
| AC-NS-1 | `node bin/test-runner.js tests/nostop-gates-phase-loop.test.js` | test |
| AC-NS-2 | `node bin/test-runner.js tests/nostop-gates-phase-loop.test.js --grep "exit_reason preserved"` | test |
| AC-NS-3 | `node bin/test-runner.js tests/pipeline-nonstop-halt-guard.test.js tests/nostop-gates-phase-loop.test.js` | test |
| AC-NS-4 | `node bin/test-runner.js tests/pipeline-runner-halt-on-incomplete.test.js` | test |
| AC-NS-5 | `node bin/test-runner.js tests/nostop-gates-phase-loop.test.js --grep "exit code"` | test |
| **AC-NS-5b** | `node bin/test-runner.js tests/halt-or-recover-choke-point.test.js tests/nostop-gates-invariant.test.js` | test |
| AC-NS-7 | `node bin/test-runner.js tests/nostop-gates-zero-diff-stamp.test.js` | test |
| AC-NS-8 | `node bin/test-runner.js tests/zero-diff-completion-arm.test.js` | test |
| AC-NS-8b | `git diff --exit-code HEAD -- tests/zero-diff-completion-arm.test.js` (**must exit 0** — the F9 pins stay byte-identical) | lint |
| AC-NS-9 | `node bin/test-runner.js tests/nostop-gates-zero-diff-stamp.test.js --grep "split original"` | test |
| AC-NS-10 | `node bin/test-runner.js tests/nostop-gates-zero-diff-stamp.test.js --grep "7af891d4"` | test |
| AC-NS-10b | `node bin/test-runner.js tests/nostop-gates-arm-agreement.test.js` | test |
| AC-NS-11 | `node bin/test-runner.js tests/nostop-gates-residual.test.js` | test |
| AC-NS-12 | `node bin/test-runner.js tests/pipeline-finalize-honesty.test.js tests/nostop-gates-residual.test.js` | test |
| AC-NS-13 | `node bin/test-runner.js tests/nostop-gates-residual.test.js --grep "byte-identical"` | test |
| AC-NS-14/15/16 | artifact review — the ticket artifact must contain the phase count reached, the named next blocker, and the inventory-completeness statement | llm-conformance |
| ALL (gate) | `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npm run test:fast && npm run test:integration` | typecheck+lint+test |

**Test-file naming is a proposal, not a constraint** — refinement may fold these into existing suites.
What is fixed: every AC above has a runnable command, and AC-NS-5b + AC-NS-10b are the two invariant
tests that must exist somewhere.

---

# Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-NS-1 | `tests/nostop-gates-phase-loop.test.js` | 6/6 Done roster, mux exit 3, `done_without_commit_evidence` | Outcome object's `action !== 'break'`; citadel phase is reached |
| AC-NS-2 | `tests/nostop-gates-phase-loop.test.js` | Same fixture, verdict durability | `state.json.exit_reason` ∈ {`pipeline_phase_incomplete`,`done_without_commit_evidence`} |
| AC-NS-3 | `tests/nostop-gates-phase-loop.test.js` | 0 Done / 0 commits — anti-fake-green | Stamps incomplete AND `deriveCompletionVerdict()` is not success AND phase advances |
| AC-NS-4 | `tests/pipeline-runner-halt-on-incomplete.test.js` | 3 Done / 3 Todo runnable roster | 3 tickets parked with residuals; `pipeline_phase_incomplete` reported; exit 3 |
| AC-NS-5 | `tests/nostop-gates-phase-loop.test.js` | Exit-code mapping on the quality-verdict path | Exit code ∈ {0,3}; **never 1** |
| **AC-NS-5b** | `tests/nostop-gates-invariant.test.js` | THE one rule, as one test | `∀ r ∈ INCOMPLETE_EXIT_REASONS ∪ {pipeline_phase_incomplete, phase_no_progress}: shouldHaltAfterPhase(...) === false` |
| AC-NS-7 | `tests/nostop-gates-zero-diff-stamp.test.js` | Declared-zero-diff ticket + Done sibling w/ commit naming the sibling | No `completion_commit` in frontmatter; oracle returns `{ok:true, via:'zero-diff'}` |
| AC-NS-8 | `tests/zero-diff-completion-arm.test.js` | Hard-absent guard is not laundered | Declared zero-diff ticket carrying a foreign SHA still refuses |
| AC-NS-8b | `tests/zero-diff-completion-arm.test.js` | Both F9 pins survive unmodified | `git diff --exit-code` on the file exits 0 |
| AC-NS-9 | `tests/nostop-gates-zero-diff-stamp.test.js` | Genuine split original, no declaration | Still auto-closes with twin's SHA; field is EXPLICIT, never `_inferred` |
| AC-NS-10 | `tests/nostop-gates-zero-diff-stamp.test.js` | Field replay of the real wedge frontmatter | End-to-end verdict is committed-or-zero-diff, not `absent` |
| **AC-NS-10b** | `tests/nostop-gates-arm-agreement.test.js` | Scan-arm/explicit-arm agreement, over a fixture matrix (own / foreign / baseline / unreachable) | If scan accepts `S` for `T`, persisting `S` as `T`'s explicit SHA and re-reading never yields `absent` |
| AC-NS-11 | `tests/nostop-gates-residual.test.js` | Residual emission on the parked path | Exactly one activity event per parked ticket, carrying `{ticket_id, phase, verdict}` |
| AC-NS-12 | `tests/pipeline-finalize-honesty.test.js` | Panel honesty with parked items | Panel states parked count; no unqualified "Complete" when count > 0 |
| AC-NS-13 | `tests/nostop-gates-residual.test.js` | Zero-parked cosmetic neutrality | Panel output byte-identical to the clean-run baseline |

---

## Build protocol

- **`self_modifying_recovery: true`** — WS-2 edits the completion-evidence / Done-flip stamper, which
  is squarely the R-PSRB salvage path (`prds/CLAUDE.md` → *Self-modifying-recovery bundles*). Per
  [[feedback_never_hand_build_always_pipeline]] and the **B-RASO precedent** (beta.43 — the first
  R-PSRB salvage-path fix shipped via an ATTENDED pipeline), this is **pipelined + attended**, NOT
  hand-built. Budget operator interventions; expect the deployed pre-fix runtime to apply the very
  logic being fixed to the workers fixing it. **WS-1 is pipeline-safe** (pipeline-runner control
  flow — the run executes deployed JS) and should be **ordered first** so a wedge mid-bundle still
  leaves the core subtraction landed.
- **Ticket order:** WS-1 → WS-3 → WS-2 → WS-4. (WS-3 before WS-2 so the residual surface exists
  before the attended salvage-path work starts producing residuals.)
- **Tickets come from refinement**, not from this PRD — [[feedback_never_hand_author_tickets_refinement_produces_them]].
  Expect refinement to correct premises here; §0 shows this author already got two ledger claims
  wrong, and the B-GTRUTH refinement corrected **ten**.
- **Green-tree precondition** (`prds/CLAUDE.md`, MANDATORY): `cd extension && npm run test:fast`
  green on the launch commit, run once on a quiet box. Record inherited failures with the commit that
  introduced them before launching.
- **Pre-launch stale-premise check:** already performed for this PRD at HEAD `f9739caa` (§0 + the
  inventory table are its output). Re-grep the deployed tree (`~/.claude/pickle-rick/extension/`) at
  launch — beta.6 is deployed and its WS-A2 changes are live, which is *why* the wedge took the
  exit-3 route rather than the old exit-1 route.

## OPERATOR DECISIONS 2026-07-25 (binding for this bundle)

1. **R-WDTF-TO is FOLDED into this bundle — ONE release gate ships both as beta.7.** This bundle
   builds on top of R-WDTF-TO's 6 commits, already on `release/v2.1-beta`. Precedent: beta.5 batched
   B-NONSTOP + B-WDSUB *"so one release gate covers both — the gate is the expensive serialized step,
   the build is not."* Consequence: **R-WDTF-TO's review phases are not skipped** — once WS-1 lands,
   relaunch them and they run on the repaired runtime. Ordering constraint only; WS-1 does not touch
   R-WDTF-TO's diff. **No separate beta.7-for-R-WDTF-TO gate.**
2. **Launch NOW, unattended, WS-1 FIRST.** WS-1/WS-3 are pipeline-safe (pipeline-runner control flow
   + `logActivity` — the run executes DEPLOYED JS, not this source diff, which lands only at
   `install.sh`). Ordering WS-1 first means a mid-bundle wedge on WS-2 still leaves the core halt
   subtraction landed and committed. **WS-2 remains the R-PSRB salvage-path ticket** — it may wedge
   unattended; that is accepted, and the recovery is the standard one (verify ground truth → commit
   before relaunch → `setup --resume` to clear `exit_reason` → relaunch), per
   [[project_bgtruth_selfbuild_hit_own_wsa2_wedge_recovered]]. Refinement MUST NOT reorder WS-2 ahead
   of WS-1.

## Non-goals

- No new completion-oracle case, no new evidence arm, no laundering of hard-absent evidence (directive 4).
- No weakening of what the anti-fake-green guards **assert** (`phase_no_progress`,
  `countCommitsSince === 0`) or of the honesty panel. Only their authority over the phase loop is
  removed — see "On the two fake-green guards" above and AC-NS-3.
- **No per-site halt-classification matrix.** If the build produces a table of "these verdicts halt,
  these continue," it has reproduced the treadmill. One rule, one invariant test (AC-NS-5b).
- No change to `state.json` schema (`schema_neutral: true`).
- **B-RGATE is NOT in scope** (drain item 2) — the *release* gate's environment-vs-code problem is a
  sibling thesis one level up, and its "unrunnable ≠ red" class is referenced here only as a naming
  precedent for the judge-unmeasurable rows.
- The `git log` maxBuffer CLASS (drain item 3) stays its own PRD.
