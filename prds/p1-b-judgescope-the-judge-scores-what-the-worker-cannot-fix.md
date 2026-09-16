# B-JUDGESCOPE — the judge scores a surface the worker cannot act on

**REVISION 2, 2026-09-16, after a 3-analyst × 3-cycle refinement pass that falsified one of the two
original roots and every "control" in the first draft.** Read the **Refinement Corrections** section
before scoping anything: the first draft would have shipped a **zero-diff green**.

**Thesis.** The szechuan judge's **admission** criteria are not the worker's **action** criteria, so the
judge can put a finding in the metric that the worker is correct to refuse. A target that cannot be
reached exhausts the stall budget and the run exits `stalled_below_target`. GitHub **#32**.

**This bundle is SUBTRACTION**: it removes the distinction between *what is scored* and *what is
fixable*. No gate leg, no abort condition, no new `EXIT_REASONS` member, no third classifier arm.

---

## ⛔ REFINEMENT CORRECTIONS — read first, these are retractions of my own draft

### ❌ ROOT J2 IS CUT. It was GitHub #22, and #22 is CLOSED and FIXED.

The original J2 ("the judge invents a 50-line ceiling") was read out of session `2026-09-12-a4d141e1`
and was **real in that artifact**. It was also already diagnosed, fixed and pinned three days earlier:

| | UTC |
|---|---|
| the judged iteration (`history[0].timestamp`) | `2026-09-13T04:07:10Z` |
| `7c1085ad` *"give the szechuan judge the enforced 120-code-line ceiling (M4, GitHub #22)"* | `2026-09-13T12:32:15Z` |

**The judge ran 8h25m BEFORE the fix.** Verified independently, not taken from the analyst:
`enforcedSizeCeilings()` (`tests/szechuan-sauce.test.js:143`) **imports `eslint.config.js`**; M4-1 pins
that the principles file states the enforced ceiling and every per-file exception; M4-4 is the negative
pin that no prompt states a 50-line limit; `node bin/test-runner.js tests/szechuan-sauce.test.js` ⇒
**61 pass / 0 fail**, re-run at HEAD today. `szechuan-sauce-principles.md:17` now reads
*"Function > 120 code lines (200 in the two eslint override files)."*

**Method failure, recorded because it will recur:** I re-grepped the mechanism **inside the session
artifact**, which by construction still shows the pre-fix world, and called that re-grounding. A session
artifact is a **snapshot**; the repo moves under it. Date the artifact, then `git log -S` the blamed
surface, then search closed issues by MECHANISM (not title — #22's title was nearly my own words).

### ⚠ The first draft's controls were green at unmodified HEAD

Measured by the requirements analyst and reproduced: `buildJudgePrompt({goal,cwd,allowedPaths:['a.ts']})`
**already** contains `Count ONLY violations located within these paths` and already lists `- a.ts`. Both
"executable-form" criteria were **true at birth**. The assertions hand-construct `allowedPaths` and pass
it straight into `buildJudgePrompt`, so **the derivation lives upstream of the call under test and the
test is structurally blind to whether it exists.** Deleting the derivation entirely would not red them.

**Census of the first draft: 16 of 21 ACs pinned — and the unpinned ones were all three root
MECHANISMS.** Every control pinned, not one mechanism. That is the shape of a bundle that goes green
without doing anything. **Every AC below that asserts a mechanism must exercise the REAL call path.**

### ⚠ n=0 — the scoped judge path has NEVER produced a score in production

Measured across every on-disk session: **scored iterations with scope populated: 0. With scope absent: 5.**
The single session with `allowed_paths` populated (`2026-09-09-e959390b`, 633 paths) exited
`baseline_unmeasurable_unrecoverable` with an empty history. **So J1 is a first-ever production
activation, not the restoration of a working path**, and must be scoped and risked as such.

---

## 📐 What was measured, and where

| observation | evidence |
|---|---|
| `allowed_paths` **ABSENT** in **9 of 10** on-disk microverse sessions | `microverse.json` census, vendored |
| both `stalled_below_target` runs are in that inert group | `2026-09-12-a4d141e1`, `2026-09-15-c5a7eb48` |
| …and so are **five convergences** | absence is NECESSARY, not sufficient |
| scored iterations under a populated scope | **0** |
| worker declined for a verified reason | `tmux_iteration_{2..6}.log`: `git diff --stat` empty, blame 2026-04-29 |
| the scoping clause is gated on a non-empty array | `microverse-runner.ts:2079` |
| …and its absence is a DOCUMENTED default, not an oversight | `:2052` — *empty/absent ⇒ whole-tree behaviour preserved* |

---

## 🗄 PERISHABLE EVIDENCE — vendor BEFORE dispatch (blocking)

`pruneOldSessions(sessionsRoot, maxAgeDays = 7)` (`pickle-utils.ts:1381`) deletes any session with
`active !== true`. All three corpora are `active: false`.

| session | deleted at (UTC) | what dies with it |
|---|---|---|
| `2026-09-09-e959390b` | **2026-09-16T10:46:29Z** | the 9-of-10 census; the ONLY populated-scope sample |
| `2026-09-12-a4d141e1` | 2026-09-20 | the scored-regression shape for J4 |
| `2026-09-15-c5a7eb48` | 2026-09-22 | the no-commit shape for J4 |

**An AC whose evidence is deleted reds as a missing directory — indistinguishable from a real
regression.** A copy has been taken to `~/pickle-rick-evidence/allowed-paths-census-2026-09-16/`
(352K, outside the repo, beyond `pruneOldSessions`' reach) — **so the deadline is already met and
AC-V-1 can vendor from that copy rather than racing the prune.** It is a stopgap, not a fixture: nothing
in the repo reads it and nothing pins its shape.

- **AC-V-1 (blocking, do first):** vendor the minimal artifacts into `extension/tests/fixtures/` —
  `microverse.json` per session plus the two `tmux_iteration_*.log` files J4 replays. Nothing else.
- **AC-V-2:** every replay AC reads the **vendored** copy. A test that reads
  `~/.local/share/pickle-rick/sessions/` is a test with a deletion date.
- **AC-V-3 (anti-vacuity):** each vendored fixture is asserted **non-empty and shape-checked** before
  use, so a truncated or missing fixture reds loudly instead of yielding an empty finding set.
- **AC-V-4:** the vendored artifacts are this repo's own session output. Confirm no client content
  before committing (root `CLAUDE.md`, binding rule).

**Note the irony, and take it seriously:** dispatching this bundle is itself what runs the clock out.

---

## 🚧 ROOT J1 — scoping is OPT-IN, so the guard is inert in 90% of runs

`measureLlmBaseline` passes `state.allowed_paths ?? []` (`microverse-runner.ts:4081`). The prompt's
scoping clause is gated on `allowedPaths.length > 0` (`:2079`); empty takes the `else` branch, which
emits only `Target path: <prd>`. **So *"Count ONLY violations located within these paths"* never fires
and the judge scores the whole repository.**

**This is a DEFAULT, not an oversight.** The field's docblock (`:2052`) states that empty or absent means
an unscoped run in which whole-tree behaviour is preserved. Scoping shipped opt-in; in 9 of 10 live
sessions nothing opted in. **The defect is that the safe behaviour is the one behind the flag.**
Inverting the default is the subtraction; adding a check that the flag was set would be the addition.

The in-source comment at `:2086` already records the same failure at larger scale — *"A judge that
scores whole-tree slop steers the worker off-scope (baseline 24 on a clean 12-file scope in session
2026-06-19-2b1e2707)."* R-SSOC L1 fixed the PROMPT and left the INPUT optional.

### AC-J1
- **AC-J1-1 (the mechanism; ONE named producer):** the szechuan microverse derives its review surface
  from a **single named producer that returns a PATH SET**. **Do NOT use `computeReviewBase`
  (`scope-resolver.ts:612`) for this** — it returns a base **ref**, its degenerate order returns
  `headSha` with a warn (⇒ empty diff ⇒ empty paths, the exact input that means "unrestricted"), and the
  contract's output is `{paths, base}`. It remains correct where `setupScope` already calls it
  (`pipeline-runner.ts:769`, guarded); it must not decide the **surface**. Name the producer in the
  ticket and justify it against `scope.json`'s existing writer.
- **AC-J1-2 (fail-CLOSED):** a surface that cannot be derived records a **typed reason** and the run
  **continues** (no-stop-gates). It MUST NOT fall back to an empty array — empty currently means
  unrestricted, so reusing it re-creates the bug.
- **AC-J1-3 (mechanism pin — this is the one that matters):** assert on a prompt produced by the **REAL
  call path** (the production caller that reaches `buildJudgePrompt`), with the derivation in place and
  **no hand-constructed `allowedPaths`**. A literal-fed assertion cannot observe the derivation and is
  green at HEAD today.
- **AC-J1-4 (over-trigger control):** an in-scope, in-diff violation is still scored. A fix that scopes
  the judge to nothing converges vacuously and is worse than the bug.
- **AC-J1-5 (mutation, BOTH directions, against AC-J1-3):** delete the derivation ⇒ AC-J1-3 **must**
  red. Widen the surface to the whole tree ⇒ AC-J1-4's out-of-scope case must red. *If deleting the
  derivation leaves AC-J1-3 green, the pin is wired to nothing and the ticket is not done.*
- **AC-J1-6 (the self-defeating risk — NEW, from refinement):** populating scope changes **commit**
  behaviour, not just scoring. `preflightAutoCommit` (`:3996`) filters by scope
  (*"Out-of-scope changes must NOT abort the run and must NOT be committed"*), `listOwnedDirtyPaths`
  (`:4942`) filters by `scope.json`, and the per-iteration auto-commit (`:5062`) stages that same owned
  set. **Today, unscoped, all owned dirt is committed; after J1 out-of-scope edits become disowned and
  salvage-anchored, the iteration registers ZERO commits, and the no-commit path draws down
  `stall_counter` — manufacturing the very stalls this bundle drains.** Pin that an **in-scope-only diff
  auto-commits identically before and after**, and state per-consumer whether the out-of-scope change is
  intended. Not speculative: `e959390b` iteration 17 shows the rescue firing for real.
- **AC-J1-7 (reachability, NEW):** J1 makes `isCodeFreeScope` (`pipeline-runner.ts:2227`) reachable for the first time. Determine
  whether a scoped-but-code-free run now **skips phases** that previously ran, and pin the answer.

---

## ❌ ROOT J2 — CUT

See **Refinement Corrections**. Already delivered by `7c1085ad` under GitHub #22 and pinned by M4-1..M4-4.
**`zero_diff_intent: already-satisfied`.** Do not budget a ticket, a corpus or a review pass for it.

---

## 🚧 ROOT J3 — an out-of-surface finding must never ENTER the metric

J1 constrains what the judge is asked for; J3 is the fail-closed half where its answer is consumed. Both
ledger entries in `2026-09-15-c5a7eb48` were `first_seen_iter: 1, last_seen_iter: 1`, in files whose
offending lines blame to **2026-04-29** — months before the bundle. They entered `violation_ledger`, set
the metric above target, and stayed for the whole stall window.

### AC-J3
- **AC-J3-1 (the mechanism):** a returned finding whose locator lies outside the derived surface is
  **dropped before scoring and before it reaches `violation_ledger`**, with a drop count recorded.
  Pin this on the real consume path, not on a hand-built finding list.
- **AC-J3-2:** "outside the surface" is decided **per-LINE**, not per-file. The measured case is a
  pre-existing line in an **in-scope file**; a path-level test admits it and leaves this AC vacuous.
- **AC-J3-3 (over-trigger control):** a violation on a line the bundle actually touched is kept.
- **AC-J3-4:** the drop count reaches the phase artifact. A silent filter turns a scope bug invisible.
- **AC-J3-5 (collapse check — answer before building):** if J1's producer can serve this boundary
  directly, J3 is a TEST, not a second code path. **Collapse them unless the consuming site is genuinely
  elsewhere**, and say which in the ticket.

---

## 🚧 ROOT J4 — `stalled_below_target` cannot say WHICH stall it is

Three firings, two mechanisms, one string. `recordIteration` (`microverse-state.ts:371`) appends history
and bumps the counter together; `recordStall` (`:401`) bumps it and deliberately writes no history entry.

### ⚠ The first draft's discriminator was WRONG BY CONSTRUCTION — do not restore it

It said *"`recordStall`-only ⇒ no-commit; `recordIteration` ⇒ scored-regression."* Refinement falsified
it on four counts, all re-checkable in the source:

1. `recordIteration` appends **unconditionally** and resets `stall_counter` **only** on
   `action === 'accept' && classification === 'improved'`. So `history.length > 0` means *"something was
   scored"*, **not** *"a regression exhausted the budget."* A run of 4 improving iterations then 5
   no-commit stalls renders **scored-regression** while naming a mechanism that contributed zero.
2. **The classification domain is THREE-valued** — `'improved' | 'held' | 'regressed'` — and `held`
   increments the counter while being neither. A two-valued field cannot represent it.
3. **The draft contradicted itself:** the cut J2 computed that `a4d141e1` iteration 2 is `held`, while
   AC-J4-3 demanded that same session render **scored-regression**.
4. **The derivation source was unnamed and the candidates disagree on the corpus.** `a4d141e1` has
   `history[0].classification: 'regressed'` but **`iteration_regressions: 0`** (`c5a7eb48` also 0).
   Derive from `history.length` and the old AC-J4-3 passes; derive from the purpose-named
   `iteration_regressions` and it reds. Two reasonable workers ship opposite behaviour, both claiming
   the AC.

### AC-J4
- **AC-J4-1:** the recorded cause is derived from **one named field**, stated in the ticket, and its
  domain covers **all three** classifications plus the no-commit case. Name the field and justify it
  against the disagreeing candidates above.
- **AC-J4-2:** **not** a new exit reason and **not** a new abort condition. `stalled_below_target` gains
  a cause; `EXIT_REASONS` gains nothing. **Assert the member COUNT**, not merely the absence of a string.
- **AC-J4-3 (replay, and it needs an input the corpus lacks):** `findUnmovableLedgerEntries` (`:4925`)
  computes `windowStart = iteration - stall_counter + 1`, but `convergence` persists only
  `{stall_limit, stall_counter, history}` — **no `iteration`**. For `c5a7eb48`, whose history is empty,
  the final iteration number exists **nowhere in the artifact**. So AC-J4-1 must **also persist the
  inputs its cause was derived from**, or the next operator re-runs exactly the forensics J4 exists to
  eliminate. Replay both vendored sessions; they must not render the same cause.
- **AC-J4-4 (earns its permanence):** this rots silently and indefinitely — three bundles, two
  mechanisms, one string, each firing diagnosed from scratch. That is the standing test for a permanent
  record; a transient red would not qualify.

---

## 🚧 ROOT J5 — prove or delete the `clean_pass` arm

`isProvablyNoOpIteration` (`:4970`) returns true when `preIterSha === postIterSha` and no owned dirty
paths, and precedes both classifier arms (`:4992`) — so `clean_pass` is **unreachable whenever the tree
is clean**, which is every zero-commit iteration. Its docblock is honest: it closed a real fake-green
where a blocked worker's *"nothing to fix"* prose returned `'converged'` over a repo that built nothing.

**But it collapses two states.** "Blocked worker produced nothing" and "worker correctly dropped every
out-of-scope finding" are the same observable. Once J1+J3 land, the second cannot arise.

### AC-J5
- **AC-J5-1:** after J1+J3, name the concrete state that reaches `clean_pass`, or record that none does.
- **AC-J5-2:** if unreachable, **delete it and its feeding branch.** Dead code that reads as a safety net
  is worse than no net.
- **AC-J5-3:** if reachable, pin the reaching state, and pin that a blocked worker's prose does **not**
  reach it — the fake-green must stay closed. Mutate both directions.
- **AC-J5-4 (pinned, was unpinned):** **do NOT add an arm.** Assert the arm count of
  `handleNoCommitStall` is unchanged. If the honest answer needs a third, stop and report instead.

---

## 🔌 Interface Contracts

All seams are **already exported**, so every AC is pinnable with no new export and no test-only seam.
Verified at HEAD `3f6bda2e`.

| symbol | location | signature |
|---|---|---|
| `buildJudgePrompt` | `microverse-runner.ts:2059` | `(input: JudgePromptInput) => string` |
| `classifyStall` | `microverse-runner.ts:1812` | `(input: StallClassifierInput) => <classification>` |
| `classifyNoCommitExit` | `microverse-runner.ts:1869` | `(iterLogFile: string) => NoCommitExitClassification` |
| `recordIteration` | `microverse-state.ts:371` | `(state, entry, classification?) => MicroverseSessionState` |
| `recordStall` | `microverse-state.ts:402` | `(state) => MicroverseSessionState` |

**J1/J3 — the review surface.**
- **Output:** `{ paths: string[], base: string }`, `paths` non-empty on success.
- **Errors:** derivation failure returns a typed reason, **never** an empty array.
- **Invariant:** the prompt built by the **production call path** contains
  `Count ONLY violations located within these paths` on a normal scoped run. The fix must make the left
  side true in production — not weaken the assertion.

**J4 — the stall cause.**
- **Output:** a cause whose domain covers `improved | held | regressed | no-commit`, plus the inputs it
  was derived from (including the iteration number, which is not currently persisted).
- **Invariant:** `EXIT_REASONS.length` unchanged.

---

## 🧪 Verification Strategy

| what | command |
|---|---|
| types | `./node_modules/.bin/tsc --noEmit` |
| lint | `./node_modules/.bin/eslint src/ --max-warnings=0` |
| compile before running tests (tests import compiled JS) | `./node_modules/.bin/tsc` |
| suites this bundle touches | `node bin/test-runner.js tests/microverse-convergence.test.js tests/microverse-stall-resilience.test.js tests/microverse-disposition-map.test.js tests/microverse-helpers.test.js --test-concurrency=1` |
| full non-expensive gate | the `&&` chain in root `CLAUDE.md` |

**No executable-form criteria are offered, deliberately.** The first draft's two were **true at
unmodified HEAD** and could not distinguish "the fix landed" from "nothing happened" — the same vacuity
the draft correctly refused elsewhere, arrived at from the opposite direction. **The skill permits
prose. Only add an executable form that is FALSE at HEAD and TRUE after the fix**, and prove the first
half before writing it down. (`./node_modules/.bin/tsc`, never `npx tsc` — `npx tsc` exits 0 without
typechecking.)

---

## 📋 Test Expectations

**Rule for this table, learned the hard way: a row that hand-constructs the mechanism's input cannot pin
the mechanism.** Mechanism rows are marked ▶ and must run the production call path.

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| ▶ AC-J1-1/J1-3 | `tests/microverse-helpers.test.js` | prompt via the REAL call path | a scoped production run's prompt contains `Count ONLY violations located within these paths`; **no literal `allowedPaths` in the test** |
| AC-J1-4 | `tests/microverse-helpers.test.js` | over-trigger control | an in-scope, in-diff violation is still scored |
| AC-J1-5 | `tests/microverse-helpers.test.js` | mutation, both directions | deleting the derivation reds the ▶ row; widening to whole-tree reds AC-J1-4 |
| AC-J1-2 | `tests/microverse-stall-resilience.test.js` | underivable surface parks | typed reason recorded, run continues, no `EXIT_REASONS` member added |
| AC-J1-6 | `tests/microverse-convergence.test.js` | commit behaviour unchanged for in-scope diffs | an in-scope-only dirty tree auto-commits identically before and after |
| AC-J1-7 | `tests/microverse-convergence.test.js` | `isCodeFreeScope` reachability | a scoped code-free run's phase-skip behaviour is pinned either way |
| ▶ AC-J3-1 | `tests/microverse-convergence.test.js` | drop on the real consume path | an out-of-surface finding never reaches `violation_ledger` |
| AC-J3-2 | `tests/microverse-convergence.test.js` | per-LINE, not per-file | a pre-existing line in an IN-SCOPE file is dropped |
| AC-J3-3 | `tests/microverse-convergence.test.js` | over-trigger control | a violation on a touched line is kept |
| AC-J3-4 | `tests/microverse-disposition-map.test.js` | drop count reported | phase artifact carries the count |
| ▶ AC-J4-1 | `tests/microverse-disposition-map.test.js` | cause from ONE named field | domain covers improved/held/regressed/no-commit |
| AC-J4-2 | `tests/microverse-disposition-map.test.js` | no new exit reason | `EXIT_REASONS.length` unchanged — assert the COUNT |
| AC-J4-3 | `tests/microverse-disposition-map.test.js` | replay both VENDORED sessions | the two render different causes; derivation inputs persisted |
| AC-J5-1/2/3 | `tests/microverse-stall-resilience.test.js` | `clean_pass` reachability | a named reaching state is pinned, or the arm is deleted and the fake-green stays closed |
| AC-J5-4 | `tests/microverse-stall-resilience.test.js` | no third arm | `handleNoCommitStall`'s arm count unchanged |
| AC-V-1/2/3 | all of the above | fixtures are vendored and shape-checked | no test reads `~/.local/share/pickle-rick/sessions/` |

---

## 🛡 PRIME DIRECTIVE compliance

- **No halt, no abort, no phase-loop break.** AC-J1-2 parks and flags.
- **No new gate leg**, so gate-leg discipline Q1–Q4 are not engaged.
- **`EXIT_REASONS` gains nothing** (AC-J4-2); state count FALLS if J5 deletes.
- **Subtraction in three of four surviving roots:** one scope source (J1), one admission boundary (J3),
  a deletion (J5). J4 adds a FIELD to an existing reason, not a member to a set.
- **Would the next iteration have caught it?** No. J1 has survived because each firing looked fresh.
  J2 is the counter-example and is cut accordingly — the next iteration DID catch that one, three days
  before I filed it.

## Non-goals

- Do NOT rebuild J2. It is landed, pinned and closed.
- Do NOT "fix" `szechuan-sauce-principles.md` — it states the enforced ceiling correctly.
- Do NOT make `stalled_below_target` halt; it is a threshold behaving as designed.
- Do NOT add a third arm to `handleNoCommitStall` (AC-J5-4).
- Do NOT scope the judge so narrowly it converges on an empty set (AC-J1-4, AC-J3-3).
- Do NOT write a test that reads a live session directory (AC-V-2).
- Do NOT treat the two pruned sessions named in `MASTER_PLAN`'s ROOT S as pending evidence.

## Simplification Review

**J1 and J3 are one boundary seen from two sides.** AC-J3-5 forces that question before either is built;
collapse them if one producer serves both.

**J1 is the whole bundle now.** With J2 cut, J3 possibly collapsing into J1, J4 a field, and J5 a
deletion, this is a small bundle by the sizing directive — and that is the honest size. **Do not pad it
back to five roots.** Compose additional same-surface work from the drain queue if more is wanted;
inventing roots to hit a ticket count is the enumeration habit wearing a schedule.

**The biggest risk is not a bug, it is a vacuous green.** Sixteen of twenty-one ACs in the first draft
were pinned by controls that could not observe the mechanism. Every ▶ row exists because of that.

---

## Implementation Task Breakdown

*(refined: 2 analyst passes × 3 cycles, 2026-09-15/16)*

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | `e4c14d0a` | Vendor the three corpora as shape-checked fixtures | High | none | replay corpora in-repo, loader throws on missing/empty | `extension/tests/fixtures/microverse-corpora/**` |
| 20 | `db605b05` | Derive the surface from ONE named producer, fail-closed | High | 10 | one producer; underivable ⇒ typed reason, run continues | `microverse-runner.ts` |
| 30 | `c1adb389` | Pin the derivation through the REAL call path | High | 20 | assertion reds when the derivation is deleted | `microverse-helpers.test.js`, `microverse-convergence.test.js` |
| 40 | `ac655b46` | Decide and pin WHICH surface version is authoritative | High | 20 | one lifetime, stated and pinned | `microverse-state.ts`, `microverse-runner.ts` |
| 50 | `446b99dd` | Pin that scoping does not change in-scope commit behaviour | High | 20, 10 | in-scope diffs commit identically before/after | `microverse-convergence.test.js` |
| 60 | `51d7d765` | Pin `isCodeFreeScope` reachability under a scoped run | Medium | 20 | skip behaviour measured and pinned | `pipeline-runner.ts`, `microverse-convergence.test.js` |
| 70 | `da44ff00` | Drop out-of-surface findings before scoring, per LINE | High | 20, 30, 10 | out-of-surface findings never reach the ledger — or collapsed into 20 | `microverse-runner.ts` |
| 80 | `cfc530c6` | `stalled_below_target` gains a cause from ONE named field | High | 10 | cause + derivation inputs persisted; `EXIT_REASONS` count unchanged | `microverse-state.ts`, `microverse-runner.ts` |
| 90 | `79686819` | Prove or delete the `clean_pass` arm | Medium | 20, 70 | arm deleted, or pinned to a named reachable state | `microverse-runner.ts` |
| 100 | `2c1c30a0` | Wiring | High | all above | one real call path: scoped prompt, filtered ledger, attributed exit | all bundle files |
| 110 | `49d03e6a` | Harden: code quality | High | 100 | zero P0-P1 | all bundle files |
| 120 | `b419a06f` | Audit: data flow integrity | High | 110 | zero CRITICAL/HIGH, or trap doors | all bundle files |
| 130 | `e562164b` | Harden: test quality (the vacuity audit) | High | 120 | every mechanism assertion proven able to red | bundle test files |
| 140 | `985897cd` | Audit: cross-reference consistency | High | 130 | catalogs match their modules | `src/bin/CLAUDE.md`, `src/services/CLAUDE.md` |

**Sizing note, stated rather than padded:** 9 implementation tickets + wiring + 4 hardening = **14**.
Root J2 was CUT as already-satisfied (GitHub #22) rather than kept to inflate the count.
