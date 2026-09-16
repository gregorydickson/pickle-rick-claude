# B-JUDGESCOPE — the judge scores what the worker is forbidden to fix

**One root wearing two dispositions, measured 2026-09-16 at HEAD `632377d0` from three live sessions and
a 10-session census.** GitHub **#32**.

**The thesis in one line:** the szechuan judge's **admission** criteria are not the worker's **action**
criteria, so the judge can put a finding in the metric that the worker is correct to refuse — and a
target that cannot be reached exhausts the stall budget. `stalled_below_target` has fired three times and
was hiding two instances of this one shape.

**This bundle is SUBTRACTION.** It removes the distinction between "what is scored" and "what is
fixable". It adds no gate leg, no abort condition, and no third arm to any classifier.

---

## 📐 What was measured, and where

| observation | evidence |
|---|---|
| `allowed_paths` **ABSENT** in **9 of 10** on-disk microverse sessions | `microverse.json` census |
| both `stalled_below_target` runs are in that inert group | `2026-09-12-a4d141e1`, `2026-09-15-c5a7eb48` |
| …and so are **five convergences** | same census — absence is NECESSARY, not sufficient |
| worker declined for a verified reason | `tmux_iteration_{2..6}.log`, `git diff --stat` empty + blame 2026-04-29 |
| judge cited a **50-line** ceiling 4 times | iteration-2 history entry, `2026-09-12-a4d141e1` |
| the enforced ceiling is **120** code lines | `extension/eslint.config.js:20` (200 in two overrides) |
| 4 of 6 flagged functions measure **119, 49, 47, 46** | AST at the judged sha `a89b28b9` |

---

## 🚧 ROOT J1 — an OPTIONAL scope field makes the scoping guard inert in 90% of runs

`measureLlmBaseline` passes `state.allowed_paths ?? []` (`microverse-runner.ts:4081`). The prompt's
scoping clause is gated on `allowedPaths.length > 0` (`:2079`); empty takes the `else` branch, which
emits only `Target path: <prd>`. **So the clause that says *"Count ONLY violations located within these
paths"* never fires, and the judge scores the whole repository.**

The in-source comment at `:2086` already records this exact failure at larger scale — *"A judge that
scores whole-tree slop steers the worker off-scope (baseline 24 on a clean 12-file scope in session
2026-06-19-2b1e2707)"*. **R-SSOC L1 fixed the PROMPT and left the INPUT optional**, so the guard is inert
precisely when its input is missing, and **an absent `allowed_paths` is indistinguishable from "no
restriction needed."** That is the enumerated-set failure mode in its purest form: a missing member looks
exactly like a member that does not apply.

### AC-J1
- **AC-J1-1:** the szechuan microverse **derives** its review surface rather than reading an optional
  field. Name the existing derivation used (the phase already computes a review base — see the
  `scope.json` base, and `computeReviewBase` at `extension/src/services/scope-resolver.ts:612`, whose
  only current callers are `pipeline-runner.ts` and its own tests) and reuse it; do NOT add a parallel
  scope source. **Symbol verified live at HEAD `632377d0` before this row was written.**
- **AC-J1-2 (fail-CLOSED half, load-bearing):** if the surface cannot be derived, the run **must not**
  score the whole tree. It records an explicit typed reason and **continues** — per the no-stop-gates
  directive this parks and flags, it never halts. A silent fallback to unrestricted scoring is the
  defect, and re-introducing it fails this AC.
- **AC-J1-3 (negative control):** a populated surface MUST put the literal `Count ONLY violations located
  within these paths` in the judge prompt. Assert on the constructed prompt, not on the field.
- **AC-J1-4 (over-trigger control):** an in-scope, in-diff violation is **still scored**. A fix that
  scopes the judge down to nothing converges vacuously and is worse than the bug.
- **AC-J1-5 (mutation, BOTH directions):** remove the derivation ⇒ the AC-J1-3 assertion reds; widen the
  surface to the whole tree ⇒ AC-J1-4's scoped finding is joined by an out-of-scope one and that reds
  too. Under-trigger alone passes a carry-anything bug.

---

## 🚧 ROOT J2 — the judge INVENTS a threshold the repo does not enforce

In `2026-09-12-a4d141e1` the judge scored **6** against `baseline_score: 2` and the iteration was
**reverted**. Four of its six violations cite *"the 50-line hard limit."* **There is no 50-line limit
here.** `szechuan-sauce-principles.md:113` correctly defers to *"the enforced `max-lines-per-function`
rule in `extension/eslint.config.js`"*, and that rule is **120** code lines. Measured by AST at the
judged sha: `buildCitadelAuditReport` **119**, `reapOrphanedManagersAtIterationStart` **49**,
`bootstrapSessionResources` **47**, `checkPartialLifecycleExit` **46** — every one under the ceiling.

**Strip the four and the score is 2 — equal to baseline, `tolerance: 0, direction: lower` ⇒ `held`.** No
regression, and the revert that discarded that iteration's work was unnecessary.

**The judge's MEASUREMENTS were exact** — it reported `runMuxRunnerMain` at "~2202 lines" at
`mux-runner.ts:12911`, and the AST says span **2202** at line **12911**. Only the comparison was invented.
The principles file is correct and must not be "fixed"; the defect is that a prose deferral to a config
file leaves the judge to supply the number.

### AC-J2
- **AC-J2-1:** the number the judge compares against is **derived from `eslint.config.js`** and reaches
  the judge as a value, not as a prose pointer. One source of truth, one fewer number to keep in sync.
- **AC-J2-2:** the two override ceilings (**200**) are represented, not flattened to the base 120. A
  single global number re-creates the same false-positive class with a different constant.
- **AC-J2-3 (negative control):** a function at **119** code lines is NOT scored as a violation; one at
  **121** is. Assert both sides — a one-sided test passes a matcher that flags everything.
- **AC-J2-4 (replay):** replay the six violations from `2026-09-12-a4d141e1` iteration 2. Exactly **two**
  survive (`runMuxRunnerMain`, and the module-size finding under its own rule). If four still survive,
  the derivation did not reach scoring.
- **AC-J2-5:** derive from the config, never from a copy. A number transcribed into a prompt template or
  a comment is the rot this repo files under "a number in a comment."

---

## 🚧 ROOT J3 — a finding outside the reviewable surface must never ENTER the metric

J1 constrains what the judge is asked for; J3 is the fail-closed half at the boundary where its answer is
consumed. Both ledger entries in `2026-09-15-c5a7eb48` were `first_seen_iter: 1, last_seen_iter: 1`, in
files whose offending lines blame to **2026-04-29** — months before the bundle. They entered
`violation_ledger`, set the metric above target, and stayed there for the whole stall window.

### AC-J3
- **AC-J3-1:** a returned finding whose locator lies outside the derived surface is **dropped before
  scoring** and before it reaches `violation_ledger`, with a count of drops recorded.
- **AC-J3-2:** "outside the surface" is decided per-LINE, not per-FILE. The measured case is a
  **pre-existing line in an in-scope file** — a path-level test admits it and this AC is vacuous without
  the line axis.
- **AC-J3-3 (over-trigger control):** a violation on a line the bundle actually touched is kept. Drop
  everything and the metric converges on an empty set.
- **AC-J3-4:** the drop count is reported in the phase artifact. A silent filter is how a scope bug
  becomes invisible instead of fixed.

---

## 🚧 ROOT J4 — `stalled_below_target` cannot say WHICH stall it is

Three firings, two distinct mechanisms, one string. The two incrementers of `stall_counter` are
`recordIteration` (`microverse-state.ts:376`, appends history) and `recordStall` (`:401`, deliberately
does not). So a full counter over an **empty** history is five `recordStall` calls — a fact that took
reading two source functions and five log lines to recover, three occurrences after the first.

**This earns a permanent record under the standing test** — it is not a transient red the next iteration
would surface; it rotted silently and indefinitely across three bundles and cost the diagnosis each time.

### AC-J4
- **AC-J4-1:** the exit records which mechanism exhausted the budget — scored-regression vs no-commit
  stall — and for the no-commit case, the `classifyStall` verdict already computed at
  `microverse-runner.ts:5010`. **It is already emitted; route it to the artifact.**
- **AC-J4-2:** this is **not** a new exit reason and **not** a new abort condition. `EXIT_REASONS` gains
  no member; `stalled_below_target` gains a cause field. Adding a member here is the exact habit the
  PRIME DIRECTIVE indicts.
- **AC-J4-3 (evidence):** replay both live runs. `2026-09-12-a4d141e1` ⇒ scored-regression;
  `2026-09-15-c5a7eb48` ⇒ no-commit × 5. If both render the same, the field is decoration.

---

## 🚧 ROOT J5 — prove or delete the `clean_pass` arm

`isProvablyNoOpIteration` (`:4970`) returns true when `preIterSha === postIterSha` and no owned dirty
paths, and its verdict **precedes both classifier arms** (`:4992`), so `clean_pass` is **unreachable
whenever the tree is clean** — which is every zero-commit iteration. Its docblock is honest about why:
it closed a real fake-green where a blocked worker's *"nothing to fix"* prose returned `'converged'` over
a repo that built nothing.

**But it collapses two states.** "Blocked worker produced nothing" and "worker correctly dropped every
out-of-scope finding" are the same observable, and both resolve to `stall`. **Once J1+J3 land, the second
state cannot arise** — so this root's deliverable is a MEASUREMENT and then a deletion or a proof, not a
third arm.

### AC-J5
- **AC-J5-1:** determine whether `clean_pass` is reachable at all after J1+J3. Name the concrete state
  that reaches it, or record that none does.
- **AC-J5-2:** if unreachable, **delete it** and the branch that feeds it. Dead code that reads as a
  safety net is worse than no net.
- **AC-J5-3:** if reachable, pin the reaching state with a test, and pin that a blocked worker's prose
  does NOT reach it — the fake-green the override was added for must stay closed. Verify by mutation in
  both directions.
- **AC-J5-4:** do NOT add an arm. If the honest answer needs one, stop and report instead of growing the
  classifier — three arms is how this layer got to +41% classifiers against zero build failures.

---

## 🛡 PRIME DIRECTIVE compliance

- **No halt, no abort, no phase-loop break.** AC-J1-2 parks and flags; nothing here can stop a run.
- **No new gate leg.** Gate-leg discipline Q1-Q4 are not engaged because no leg is proposed.
- **`EXIT_REASONS` gains nothing** (AC-J4-2). State count goes DOWN if J5 deletes.
- **Subtraction is the fix in four of five roots:** one scope source instead of two (J1), one ceiling
  source instead of a prose pointer plus a guessed number (J2), one admission boundary (J3), and a
  deletion (J5). Only J4 adds, and it adds a FIELD to an existing reason, not a member to a set.
- **Would the next iteration have caught it?** No — and that is the whole argument. This shape has
  survived three bundles precisely because each firing looked like a fresh one-off.

## Non-goals

- Do NOT "fix" `szechuan-sauce-principles.md` — it already defers correctly (J2).
- Do NOT make `stalled_below_target` halt. It is a threshold behaving as designed.
- Do NOT add a third arm to `handleNoCommitStall` (AC-J5-4).
- Do NOT scope the judge so narrowly that it converges on an empty set (AC-J1-4, AC-J3-3).
- Do NOT treat the two pruned sessions named in `MASTER_PLAN`'s ROOT S as pending evidence; their traces
  are gone and the comparison was taken against two newer runs instead.

## Simplification Review

**Necessary?** J1 and J3 are one boundary seen from two sides and MUST be verified as one — if a single
derivation can serve both, that is the answer and J3 becomes a test rather than a code path. Collapse
them if the implementation allows; keep them separate only if the consuming site is genuinely elsewhere.

**J2 is the cheapest and most isolated** — one number, one source, two controls — and it independently
un-blocks a real reverted iteration. It is the right first ticket.

**J5 is the only root that may end in zero diff.** That is a success, not a gap: record
`zero_diff_intent: already-satisfied` if J1+J3 make `clean_pass` reachable for its real purpose.
