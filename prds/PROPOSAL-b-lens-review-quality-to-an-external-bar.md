# PROPOSAL — B-LENS: review quality measured against an external bar

> **STATUS: PROPOSAL, NOT DISPATCHED.** Deliberately not referenced from `prds/MASTER_PLAN.md`.
> Nothing here is scoped into a bundle until reviewed.

**Thesis.** Our review phases are measured against criteria we wrote. `deep-pr-review-lean` is criteria
someone else wrote, applied to our output by a reviewer we do not control. Adopting its *discipline* —
not its lens list — is the difference between "we think this is good" and "this passes."

**Execution substrate: agent/teams.** The lean skill's architecture is one subagent per lens, all fired
lenses dispatched in a single message, tier assigned by task shape and never chosen by the agent.
Pickle Rick has `teams_mode` and `max_parallel` in its type system and **has never once run them**
(measured: 0 sessions in history with `teams_mode: true`). This proposal is the first real exercise of
that path, and L5 treats it as an experiment to be measured rather than a foundation to build on.

**Measured baseline (2026-09-15), szechuan-sauce-principles.md against the lean lens set:**

| lean lens | fires | our coverage | grep evidence |
|---|---|---|---|
| 1 Correctness | always | strong (anatomy-park data-flow tracing) | — |
| 2 Security | always | **excluded by operator** — met in practice | — |
| 3 Tests | always | **partial — the key heuristic absent** | `deleted or broken`: **0** |
| 4 Migrations | conditional | **ahead of the bar** (4 scored Drizzle checks) | — |
| 5 Performance | query/loop/endpoint/handler | **absent** | `N+1`: **0** |
| 6 Arch/packaging | package.json, tsconfig, exports | absent, mostly non-firing for us | `peerDep`: **0**, `exports`: **0** |
| 7 Acceptance criteria | always | partial (citadel conformance) | — |
| 8 Cleanup | always | **superset** (szechuan Part I) | — |
| 9 Hazard enumeration | trigger | absent | — |

**Ordering rationale: L0 and L0b gate everything.** L0 protects what already beats the bar; L0b
replaces theory with an inventory of what reviewers actually flag. Only then: L1 and L2 are methodology
and lift every lens at once. L3 is one sentence with
the highest yield. L4 is the one unconditional-for-us content gap. L5 is the substrate and is last
because it must be measured before anything depends on it.

---

## 🔒 ROOT L0 — PRESERVE WHAT ALREADY BEATS THE BAR (gates every other root)

**The risk this bundle carries is not that it fails. It is that "align to the external bar" reads as a
licence to replace, and we lose the parts that are already better than the bar.** Measured, we are ahead
in three places:

| ours | versus the lean lens |
|---|---|
| szechuan Part I (KISS, YAGNI, Small Functions, Guard Clauses, Cognitive Load, Self-Documenting, Elegance) | **superset** of lens 8 |
| szechuan Migration Hygiene — 4 scored Drizzle checks (CHECK-constraint drift, redundant churn, idempotency, schema drift) | **ahead** of lens 4's one-liner |
| anatomy-park subsystem data-flow tracing + trap doors with `pattern_shape` | **no lens equivalent at all** |

### AC-L0 (machine-checkable, and every other root is blocked on these)
- L0-1: `szechuan-sauce-principles.md` Part I sections are **not deleted and not reworded**. Every change
  to that file is an ADDITION, verified by diff: zero deleted lines in Parts I and II.
- L0-2: Migration Hygiene keeps **all four** scored checks with their existing severities.
- L0-3: anatomy-park's trap-door output keeps its `pattern_shape` contract and its severity scale.
- L0-4 (the real control): **replay a known past finding from each phase — it must still fire.** Pick one
  historical szechuan violation and one anatomy-park CRITICAL from our own git history, re-run the
  current prompts over that code, and assert both are still reported. **A widening that silences a
  finding we used to catch is a REGRESSION and fails this root.**
- L0-5: no root in this bundle may remove a criterion. Additions only.

**If L0-4 cannot be made to pass, STOP.** Report the silenced finding and do not land the widening. A
review that trades an existing catch for a new one is not an improvement, it is a swap we cannot see.

---

## 📊 ROOT L0b — INVENTORY WHAT REVIEWERS ACTUALLY FLAG (gates L3 and L4)

**This proposal's content roots were derived from what the skill SAYS it checks, not from what reviewers
actually find.** Those differ, and only one is evidence. Operator-raised, and correct.

`plugins/ll/scripts/pr-reviews` fetches all three review surfaces (review bodies, inline comments, issue
comments) grouped by reviewer, with `--dump`. Run it across a sample of recent merged
`loanlight-engineering/loanlight-api` PRs and classify every finding by lens.

**Why this gates L3 and L4:** L4 proposes a performance lens on the strength of `grep -ic 'N+1'`
returning **0** in our principles file. That measures what we do not check. It does NOT measure whether
reviewers keep finding performance defects in our output. Those are different claims and I conflated
them.

### AC-L0b (machine-checkable)
- L0b-1: findings from the sampled PRs are classified by lens, with counts per category.
- L0b-2: **L3 and L4 adopt only categories the inventory supports.** A category with no observed
  findings is dropped from this bundle, whatever the skill's lens list says.
- L0b-3: categories the inventory surfaces that are NOT in the lens list are reported as candidates. The
  inventory may promote something neither of us considered.
- L0b-4: the sample size and selection are stated, and the classification is reproducible from the dump.
- L0b-5 (honesty control): if the inventory is too small or too noisy to support a conclusion, SAY SO
  and leave L3/L4 unscoped rather than adopting on a weak signal.

---

## 🔦 ROOT L1 — make non-coverage visible (the roster line)

The lean skill prints, **before dispatch and again after return**, one line per lens:
`lens · tier · fired|not fired · status · count`, where a non-fired lens prints
`not fired (trigger: <what would fire it>)`. Its stated reason is our own recurring disease:

> *"Absorbing lenses inline is how this skill degrades: coverage shrinks while the verdict still reads
> as exhaustive."*

That is the fixture-scanning audit (#26), the stale ledger rows, and the gate leg that could not see its
own subject — one shape, three incidents, all this month. **A review that does not say what it did not
look at is indistinguishable from one that looked at everything.**

### AC-L1
- L1-1: every review phase emits a roster, both before and after, naming each lens, whether it fired,
  and on a non-fire the trigger that would have fired it.
- L1-2: the roster is a FLOOR, not a cap — running fewer than the fired set is reported as a defect in
  the run's own output, not silently.
- L1-3 (negative control): a run where every lens fires still prints the roster. The roster is not an
  exception report.
- L1-4: the roster reaches the phase artifact, not only the log, so a later reader can audit coverage.
- L1-5 (mutation): suppress one lens; L1-2 reports it. If the run still reads exhaustive, the root failed.

---

## 🧾 ROOT L2 — the claim and provenance discipline

Lean's return contract requires, per candidate finding: a locator (`file:line` **with the line quoted**,
or a PR/ticket/comment id, or the command with its excerpt and exit status), a one-line claim, a concrete
failure scenario as inputs/state → wrong result, the evidence actually read, and **provenance claims
listed separately, each marked `established`** with the search or the quoted assigning line. Anything
carrying `[unverified — do not cite as fact]` goes to a separate `unverified_questions` list, *whole*.

**We hand-derive this constantly and pay for it when we forget.** This month: an absence claim from a
grep that scanned the wrong root; a "fixed" row whose probe was never run; a count asserted from a
census that matched its own prompt text. Each was recoverable because someone re-measured. The discipline
makes re-measuring unnecessary.

### AC-L2
- L2-1: the reviewer return contract requires locator + failure scenario + evidence-read + separately
  listed provenance claims, each marked `established` with its search or quoted line.
- L2-2: absence claims ("no caller", "unused", "no read site") are rejected without a recorded search.
- L2-3: `[unverified]` items are carried in their own list and never counted as findings.
- L2-4 (negative control): a well-evidenced finding passes unchanged. This must not become a tax that
  suppresses real findings.
- L2-5 (mutation): submit a finding whose provenance is unestablished; it must be rejected or routed to
  `unverified_questions`, not counted.

---

## 🧪 ROOT L3 — one sentence, highest yield

Szechuan's Test Quality says tests must "assert on observable behavior, not implementation details" and
flags tautological assertions. It never asks the lean skill's question:

> **"Would this fail if the feature were deleted or broken?"**

Nor does it hunt inert guards, phantom/unreachable paths, coverage that gates nothing, or **guards
narrower than their name**. Measured: `grep -ic 'deleted or broken'` → **0**.

This is the cheapest high-value change on the list and it is the one that catches a green proving
nothing — which is the failure this codebase produces most often.

### AC-L3
- L3-1: the Test Quality section carries the deleted-or-broken question and the four hunt targets.
- L3-2: added by **widening** the existing section, not by adding a Part IV. (Yesterday's directive:
  prefer widening; a new section is an enumeration member.)
- L3-3 (negative control): a test that would genuinely fail on deletion is NOT flagged. Over-triggering
  here would flood every review.
- L3-4: replay over a known inert guard from our own history flags it; replay over a known-good suite
  does not.

---

## ⚡ ROOT L4 — the one content gap that fires on our diffs

Performance is **entirely absent**: `grep -ic 'N+1'` → 0. In the lean roster it fires whenever the diff
touches a query, loop, endpoint, or handler — which describes most pickle-rick bundles.

Packaging (lens 6) is deliberately **not** in this proposal: it fires on `package.json`/`tsconfig`/
`exports` changes, which our bundles rarely touch. Adding it now would be coverage we do not need,
which is the enumeration habit.

### AC-L4
- L4-1: Part III gains N+1 patterns, unbounded queries, and hot-path work, by widening.
- L4-2 (negative control): a bounded query with a limit is not flagged.
- L4-3: replay over a known N+1 in any accessible corpus flags it; a clean loop does not.

---

## 🤖 ROOT L5 — lens-per-subagent on teams mode (EXPERIMENT, measured before adopted)

Lean's engine is one subagent per lens, **all fired lenses dispatched in a single message**, tier fixed
by task shape and printed — *"an agent may never choose its own"* — with pattern-matching/enumeration on
a small model and correctness judgment on the session model.

Pickle Rick has the substrate and has never used it. **`teams_mode: true` appears in 0 of all sessions
ever run.** `max_parallel` is documented in the manager prompt as *"plumbed for a follow-up… today,
treat as 1."*

**This root's deliverable is a MEASUREMENT, not an architecture.** Run one real bundle with teams mode
and a lens-per-subagent review, and report: wall clock vs the sequential baseline, findings found that
the sequential review missed, findings the sequential review found that this missed, and contention
incidents.

### AC-L5
- L5-1: one real bundle runs with `teams_mode: true` and a lens-per-subagent review phase.
- L5-2: the report names, with numbers: wall clock vs baseline, findings gained, **findings LOST**, and
  contention incidents. A speed win that loses findings is a regression and must be reported as one.
- L5-3: tier is assigned by task shape in a printed table and **never chosen by the agent**.
- L5-4 (the risk this root must answer): parallel execution multiplies tier contention. We have **two
  filed occurrences** of contention producing a red that does not reproduce (#28). L5 reports the
  contention rate under parallelism; if it rises, that is the finding.
- L5-5: no phase-loop change. Teams mode is opt-in and the sequential path remains the default until
  L5-2's numbers justify otherwise.

**Non-goal:** do NOT make teams mode the default in this bundle. It has never run; the first outcome of
running it is data, not adoption.

---

## 🛡 PRIME DIRECTIVE compliance

**No new gate legs.** Every root widens an existing prompt or adds a reporting line. Yesterday's
directive constrains the release gate's audit list — an enumerated set a reader must hold — and a
reviewer's criteria are not that. L3-2 and L4-1 both specify widening over new sections.

Nothing adds a halt, an abort condition, or a phase-loop break. L5-5 keeps the sequential path default.

L1 is a subtraction in the sense the directive names: it removes the ambiguity between "looked and found
nothing" and "did not look."

## Non-goals

- Do NOT adopt lens 2 (security) — operator reports it is met in practice.
- Do NOT adopt lens 6 (packaging) — conditional, rarely fires on our diffs.
- Do NOT add a gate leg for any of this.
- Do NOT make teams mode default (L5-5).
- Do NOT let L2 become a tax that suppresses real findings (L2-4).
- Do NOT claim we "pass deep-pr-review" — that is unknowable until real work is reviewed by it. This
  bundle closes measured gaps; it does not predict a verdict.

## Simplification Review

L1 and L2 are the whole value. Both replace a convention maintained by memory with a contract enforced
at the return boundary — the same move that worked for the executable-assertion form and failed when it
was only documented.

L3 and L4 are single-section widenings. L5 deletes nothing and is explicitly an experiment.

**What this proposal deliberately does NOT do:** add the five missing lenses one per gap. That is the
guard-per-finding pattern, and the gate grew 10 → 13 audits in a week doing exactly it. Two lenses are
excluded on evidence, and the two adopted are adopted by widening.
