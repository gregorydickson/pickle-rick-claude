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
that path, and L6 treats it as an experiment to be measured rather than a foundation to build on.

**Measured baseline (2026-09-15), szechuan-sauce-principles.md against the lean lens set:**

| lean lens | fires | our coverage | grep evidence |
|---|---|---|---|
| 1 Correctness | always | strong (anatomy-park data-flow tracing) | — |
| 2 Security | always | **excluded by operator** — met in practice | — |
| 3 Tests | always | **partial — the key heuristic absent** | `deleted or broken`: **0** |
| 4 Migrations | conditional | **ahead of the bar** (4 scored Drizzle checks) | — |
| 5 Performance | query/loop/endpoint/handler | absent — **and CUT on evidence** | `N+1`: **0**, but **1 of 342** real findings |
| 6 Arch/packaging | package.json, tsconfig, exports | absent, mostly non-firing for us | `peerDep`: **0**, `exports`: **0** |
| 7 Acceptance criteria | always | partial (citadel conformance) | **45 of 342 (13%) — largest category** |
| 8 Cleanup | always | **superset** (szechuan Part I) | — |
| 9 Hazard enumeration | trigger | absent | — |

**Ordering rationale: L0 and L0b gate everything.** L0 protects what already beats the bar; L0b
replaces theory with an inventory of what reviewers actually flag. Only then: L1 and L2 are methodology
and lift every lens at once. L3 is one sentence with
the highest yield. L4 is the one unconditional-for-us content gap. L6 is the substrate and is last
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

## 📊 ROOT L0b — INVENTORY WHAT REVIEWERS ACTUALLY FLAG ✅ **EXECUTED 2026-09-15** (gates L3, L4, L5)

**This proposal's content roots were derived from what the skill SAYS it checks, not from what reviewers
actually find.** Those differ, and only one is evidence. Operator-raised, and correct.

A private plugin script fetches all three review surfaces (review bodies, inline comments, issue
comments) grouped by reviewer. Run it across a sample of recent merged PRs **in the private repo whose
reviews are the external bar** and classify every finding by lens. Neither the repo nor the findings are
named here — the corpus is INTERNAL and lives outside this one (root `CLAUDE.md`, no-client-data rule).
**Only counts cross the boundary.**

### ✅ RESULT — the inventory ran, and it rewrote this proposal's content roots

Corpus: 4 months (2026-05-15 → 09-15), 649 merged PRs, 1,609 reviews. **714 blocking bullets across
199 reviews, of which 342 are findings** (bolded lead; the rest are evidence lines, CI links, line
counts). Re-derived independently at 342 before being used here. **The corpus is INTERNAL and lives
outside this repo** — see the no-client-data rule in root `CLAUDE.md`. Numbers only, below.

| category | findings | disposition |
|---|---|---|
| acceptance criteria unmet | **45 (13%)** | **promoted to ROOT L4**, replacing performance |
| guard inert / gates nothing | **23 (6%)** | confirms L3's hunt targets |
| comment bloat / density | **19 (5%)** | **NEW ROOT L5** — in no lens and in none of my roots |
| performance | **1 (<1%)** | **L4 CUT** |

**Two corrections this forced, and they are load-bearing:**
- **Lens distribution is NOT derivable from this corpus.** Only 7 of 308 structured reviews name a
  lens at all; output is organised by SEVERITY, not by lens. Any "which lens fires most" claim from
  this data is unfounded — including ones I would like to make.
- **Counting lens *mentions* is not counting *findings*.** A lens that runs clean still prints. The
  original grep evidence in the table above measures our principles file's vocabulary, not reviewer
  behaviour, and the two were conflated.

**Honest scope limits (AC-L0b-5).** `reviews.ndjson` holds review BODIES only — findings raised
purely as inline comments are undercounted. Two keyword taxonomies each left ~62% unmatched, and that
residue is dominated by DOMAIN correctness defects with no analogue in this repo. So the three
promoted categories are a FLOOR on what reviewers flag, not a taxonomy.

**Why this gates L3, L4 and L5:** L4 proposes a performance lens on the strength of `grep -ic 'N+1'`
returning **0** in our principles file. That measures what we do not check. It does NOT measure whether
reviewers keep finding performance defects in our output. Those are different claims and I conflated
them.

### AC-L0b (machine-checkable)
- L0b-1: findings from the sampled PRs are classified by lens, with counts per category.
- L0b-2: **L3, L4 and L5 adopt only categories the inventory supports.** A category with no observed
  findings is dropped from this bundle, whatever the skill's lens list says. ✅ **L4 (performance)
  was cut under this clause.**
- L0b-3: categories the inventory surfaces that are NOT in the lens list are reported as candidates. The
  inventory may promote something neither of us considered. ✅ **It did: comment density, now ROOT L5.**
- L0b-4: the sample size and selection are stated, and the classification is reproducible from the dump.
- L0b-5 (honesty control): if the inventory is too small or too noisy to support a conclusion, SAY SO
  and leave L3/L4 unscoped rather than adopting on a weak signal. ✅ **Exercised: lens distribution is
  reported as NOT derivable, and the taxonomy as incomplete, rather than rounded up to a conclusion.**

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

**The inventory backs this independently:** *guard inert / gates nothing* is **23 of 342 (6%)**, the
second-largest category. L3 was proposed off a grep; it survives on evidence.

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

## ✅ ROOT L4 — ACCEPTANCE CRITERIA, the largest measured category (replaces the cut performance root)

**The performance root that stood here is CUT.** It was proposed on `grep -ic 'N+1'` returning **0** in
our principles file — a measurement of what we do not check, not of what reviewers find. The L0b
inventory falsified it: performance is **1 of 342 findings** in four months (a deliberately loose
re-grep over the same corpus for `N+1|performance|slow query|index scan` returns **3 of 342**, still
under 1%). A root that would fire on most of our diffs and catch under 1% of what reviewers flag is
coverage we do not need — which is the enumeration habit the PRIME DIRECTIVE names.

**What the inventory promoted in its place:** *acceptance criteria unmet* is the **largest identifiable
category at 45 of 342 (13%)** — three times the next one. This is L0b-3 doing its job: the data promoted
a category neither the skill's lens list nor my reading ranked first.

**We are not starting from zero here, and that is the risk.** Citadel already runs a post-implementation
conformance audit against the PRD, and `audit-acceptance-assertion-coverage` is a gate leg. So the
question is NOT "add an acceptance check" — it is **why a surface we already audit is still the largest
blocking category in someone else's review of our work.** Answer that before writing a line of prompt.

### AC-L4
- L4-1 (diagnosis FIRST, and it gates the rest): sample the 45 and classify each as (a) the criterion
  was never checked, (b) it was checked and the check passed wrongly, or (c) the criterion itself was
  absent or unfalsifiable. **Each branch has a different fix and only (a) is a coverage gap.** If (c)
  dominates, the defect is in PRD authoring, not in review, and this root re-scopes there.
- L4-2: the adopted change is a **widening** of citadel's existing conformance section or of
  `audit-acceptance-assertion-coverage`'s predicate — not a new gate leg, not a new review section.
  Name the leg considered and why it could not stretch (root `CLAUDE.md`, gate-leg discipline Q1).
- L4-3 (negative control): a ticket whose criteria are met and asserted is NOT flagged. Over-triggering
  on the largest category would flood every review with the thing we are least able to ignore.
- L4-4 (replay): replay over our own known conformance misses (citadel advisory findings are on disk for
  the B-MEGADRAIN run, `citadel_advisory_findings: 134`) flags them; replay over a clean ticket does not.
- L4-5 (honesty control): if L4-1 shows citadel already catches these in OUR repo and the 45 are
  domain-specific criteria of the private repo with no pickle-rick analogue, **say so and cut this root
  too.** The
  inventory is evidence from another codebase's reviewers; transferability is a claim, not a given.

---

## 💬 ROOT L5 — COMMENT DENSITY, the gap neither of us proposed

**The inventory surfaced a category the lens list does not carry: comment bloat / density, 19 of 342
(6%).**

### ⛔ CORRECTION 2026-09-16 — my premise was WRONG. szechuan already checks this.

I wrote that *"szechuan does not measure it at all."* Grepped at HEAD, that is false —
`szechuan-sauce-principles.md` carries it in **four** places:

| line | text |
|---|---|
| `:25` | `Comments explaining "what"` → Self-Documenting Code → *Rename to be obvious* |
| `:26` | `Stale/wrong comments` → Documentation Discipline → *Delete or fix* |
| `:130` | **Comment Balance**: *"Delete comments that restate code. Keep comments that explain WHY, warn of consequences, or mark TODOs with context"* |
| `:243` | `Comment-heavy code` → Self-Documenting → *Rename, restructure* |

**Third time this session I asserted an absence without grepping the file** (after the cut B-JUDGESCOPE
J2 and the false backup claim). The check exists and is well-stated.

### ✅ The REAL root (operator-sharpened 2026-09-16): density is a SMELL, and the file mis-tiers it as STYLE

**Comment density is an anti-pattern because it usually means the code should be rewritten so the
comments are not needed.** The remedy is to change the CODE, not the comment. The principles file
**already knows this** — and then files it under Style anyway. Measured:

| smell | principle | remedy | tier |
|---|---|---|---|
| Deep nesting (3+ levels) | Guard Clauses, Cognitive Load | Early returns | **P2 Maintainability** (`:60`) |
| Copy-pasted code (3+ times) | DRY | Extract shared function | **P2 Maintainability** (`:60`) |
| Comments explaining "what" (`:25`) | Self-Documenting Code | **Rename to be obvious** | **P4 Optional / Style** (`:62`) |
| Comment-heavy code (`:243`) | Self-Documenting | **Rename, restructure** | **P4 Optional / Style** (`:62`) |

**Identical remedy SHAPE — restructure the code — and a two-tier severity gap.** The smell table carries
no severity column of its own, so severity comes entirely from `:57-62`, and there the entry reads
*"comment cleanup"*. Compounding it, `:94` puts *"comment wording"* **Out of Scope** outright, next to
"naming taste, spacing, bracket religion".

**The miscategorisation is in the WORDING, and that is why it is cheap to fix.** *"Comment cleanup"* and
*"comment wording"* both describe **editing the comment** — which really is a P4 style nit and really is
out of scope. The actual finding is **editing the code**, which is P2 and squarely in scope. The file
tiers the wrong remedy.

**Consequence today:** a reviewer following the file correctly finds comment-heavy code, correctly reads
the remedy as "rename, restructure", then correctly declines to act because the severity table calls it
optional style and the scope section excludes it. **19 of 342 findings from the external bar say that is
the wrong call.**

**And it compounds for us specifically:** an LLM writing code narrates it, so we generate the smell at a
rate a human-authored codebase does not.

**Why this matters more for us than for a human-authored codebase:** an LLM writing code narrates it. We
generate comments at a rate a human reviewer does not, so a P4 tier that is never reached compounds.

### AC-L5 (rewritten against the real root)
- **AC-L5-1:** the change is a **severity/scope edit to existing rules**, not a new dimension. Do NOT add
  a Part IV and do NOT add a scored dimension — the check is already there.
- **AC-L5-2 (the actual change):** separate the two remedies that are currently conflated.
  **Editing the comment** stays P4 Style and stays out of scope. **Restructuring code that needed the
  comment** moves to **P2 Maintainability**, alongside deep nesting and DRY, whose remedies are the same
  shape. Concretely: `:62` stops saying "comment cleanup", `:60` gains the restructure case, and `:94`'s
  exclusion is narrowed to comment *wording* so it no longer swallows density.
- **AC-L5-2b (the finding must name the CODE):** a raised finding says which function to restructure and
  why the comment is evidence for it. A finding whose remedy is "delete this comment" has not been
  promoted — it has just been re-tiered, and it will produce exactly the P4 noise this root must avoid.
- **AC-L5-3 (negative control, load-bearing):** a docblock recording a non-obvious WHY — a measured
  limit, a trap-door invariant, a `pattern_shape` — is NOT flagged. `:130`'s existing Comment Balance
  wording already protects these; **any edit that breaks that protection is a regression, and L0-4's
  replay must catch it.**
- **AC-L5-4 (mutation, both directions):** a comment restating its own line is flagged; one recording a
  measured limit is not. Under-trigger alone passes a carry-anything rule.
- **AC-L5-5:** replay over the szechuan corpus and report how many EXISTING comments a raised severity
  would flag. If the number is large this is a one-time cleanup plus a standing check, and that must be
  said before it lands, not discovered mid-bundle.

**Why it belongs and the performance root did not:** it is 19x the observed rate of the root it displaces,
it fires on every diff we produce, and we generate comments at a rate a human reviewer does not — an LLM
writing code narrates it. This is a gap our production method creates.

### AC-L5
- L5-1: added by **widening szechuan Part I** — one scored dimension alongside Self-Documenting, not a
  Part IV and not a new phase. (Gate-leg discipline Q1: prefer widening.)
- L5-2: the check is stated as a question about the comment's INFORMATION, not its count. A line-count
  threshold is the enumerated-set shape in miniature and will red a well-commented public contract.
- L5-3 (negative control, load-bearing here): a docblock that records a non-obvious WHY — a measured
  limit, a trap-door invariant, a `pattern_shape` — is NOT flagged. This repo's own `CLAUDE.md` entries
  and trap-door catalogs are exactly the comments that must survive; a root that strips them is a
  regression that L0's replay must catch.
- L5-4 (mutation): inject a comment that restates its own line; it is flagged. Inject one that records a
  measured limit; it is not. **Both directions, or the check is carry-anything.**
- L5-5: replay over the szechuan corpus reports how many existing comments it would flag. If the number
  is large, this is a one-time cleanup with a standing check, and that must be said before it lands —
  not discovered mid-bundle.

---

## 🤖 ROOT L6 — lens-per-subagent on teams mode (EXPERIMENT, measured before adopted)

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

### AC-L6
- L6-1: one real bundle runs with `teams_mode: true` and a lens-per-subagent review phase.
- L6-2: the report names, with numbers: wall clock vs baseline, findings gained, **findings LOST**, and
  contention incidents. A speed win that loses findings is a regression and must be reported as one.
- L6-3: tier is assigned by task shape in a printed table and **never chosen by the agent**.
- L6-4 (the risk this root must answer): parallel execution multiplies tier contention. We have **two
  filed occurrences** of contention producing a red that does not reproduce (#28). L6 reports the
  contention rate under parallelism; if it rises, that is the finding.
- L6-5: no phase-loop change. Teams mode is opt-in and the sequential path remains the default until
  L6-2's numbers justify otherwise.

**Non-goal:** do NOT make teams mode the default in this bundle. It has never run; the first outcome of
running it is data, not adoption.

---

## 🛡 PRIME DIRECTIVE compliance

**No new gate legs.** Every root widens an existing prompt or adds a reporting line. Yesterday's
directive constrains the release gate's audit list — an enumerated set a reader must hold — and a
reviewer's criteria are not that. L3-2, L4-2 and L5-1 all specify widening over new sections — and L4-2 must name the gate leg it
considered widening and why it could not stretch, which is gate-leg-discipline Q1 applied to our own
proposal rather than to someone else's.

Nothing adds a halt, an abort condition, or a phase-loop break. L6-5 keeps the sequential path default.

L1 is a subtraction in the sense the directive names: it removes the ambiguity between "looked and found
nothing" and "did not look."

## Non-goals

- Do NOT adopt lens 2 (security) — operator reports it is met in practice.
- Do NOT adopt lens 5 (performance) — **1 of 342 findings**. Cut by its own evidence root.
- Do NOT adopt lens 6 (packaging) — conditional, rarely fires on our diffs.
- Do NOT add a gate leg for any of this.
- Do NOT make teams mode default (L6-5).
- Do NOT let L2 become a tax that suppresses real findings (L2-4).
- Do NOT claim we "pass deep-pr-review" — that is unknowable until real work is reviewed by it. This
  bundle closes measured gaps; it does not predict a verdict.

## Simplification Review

L1 and L2 are the whole value. Both replace a convention maintained by memory with a contract enforced
at the return boundary — the same move that worked for the executable-assertion form and failed when it
was only documented.

L3, L4 and L5 are single-section widenings. L6 deletes nothing and is explicitly an experiment.

**L0b cut a root of mine and promoted one neither of us proposed.** That is the whole argument for
gating content roots on an inventory: the performance root read as obviously right and was worth
under 1%, and comment density — which an LLM-authored codebase produces at a rate a human reviewer
does not — was invisible until the findings were counted.

**What this proposal deliberately does NOT do:** add the five missing lenses one per gap. That is the
guard-per-finding pattern, and the gate grew 10 → 13 audits in a week doing exactly it. **Three** lenses are
now excluded on evidence — security and packaging on operator report, performance on its own
inventory — and every adopted root is adopted by widening.
