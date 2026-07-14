# BUG — the AC-shape gate rejects DERIVED `describe.each`, and rewards the hand-enumeration it exists to prevent

**Filed:** 2026-07-14 · **Hit while:** babysitting `/pickle-pipeline` refinement for LOA-1763 (loanlight-api)
**Component:** `extension/bin/spawn-refinement-team.js` — `isParametrizedTicket` / `DESCRIBE_EACH_RE`
**Severity:** HIGH — the gate is **unsatisfiable** for correctly-written ACs, and satisfying it **degrades the PRD**.
**Status:** CAPTURE-ONLY (no fix attempted; the LOA-1763 run overrode the gate with a documented reason)

## The defect

`spawn-refinement-team.js:943`:

```js
const DESCRIBE_EACH_RE = /describe\.each\s*\(\s*\[/s;   // ← requires a literal `[`
```

The gate accepts a ticket as "collapsed" only if its text matches `describe.each(` **immediately followed by `[`** — i.e. an **inline array literal**:

```ts
describe.each([["a"], ["b"], ["c"]])(...)     // ✅ PASSES the gate
```

It **rejects** the derived form:

```ts
describe.each(OVERLAY_INPUT_KEYS)(...)        // ❌ FAILS the gate — no `[`
describe.each(APPLY_SURFACES)(...)            // ❌ FAILS
describe.each(ALL_RULE_ENGINES)(...)          // ❌ FAILS
```

## Why this is backwards

**The derived form is strictly better, and it is the form the gate's own purpose demands.**

An inline array literal is a **hand-copied enumeration of the target set**. It drifts silently the moment the
source of truth gains a member — which is *precisely* the class of defect the AC-shape gate exists to catch.
`describe.each(EXPORTED_CONST)` derives the set from the source of truth, so a new member is covered with zero
test edits and an uncovered member **fails CI**.

In the LOA-1763 run this was not academic. The refinement analysts themselves repeatedly demanded the derived
form — *"derive the list from the exported registry; hand-copying it under-covers, as the prior AC did"* — and
then the gate **rejected their own tickets** for using it. Six of nine tickets failed the collapse check while
being *more* correct than the shape the gate wanted.

The PRD under review had an explicit, load-bearing rule: **"derive the invariant, never enumerate the
instances."** Satisfying the gate would have required violating it.

## Secondary: the quantifier regex is narrow

`spawn-refinement-team.js:941`:

```js
const UNIVERSAL_QUANTIFIER_RE = /\b(?:all|every|for any|each)\b/i;
```

It misses the most natural universal phrasings for a **negative** invariant, which is the shape most safety
ACs take:

* `"NO rule emits a row on an axis with zero writers"` — **not matched** (`no` absent)
* `"a FAIL never renders below a PASS"` — **not matched** (`never` absent)
* `"no partially-applied lender is ever launch-ready"` — **not matched**

`no`, `never`, and bare `any` should be members. A negative universal is still a universal.

## Repro

1. Author a ticket whose `acceptance_test` is `describe.each(SOME_EXPORTED_CONST)("%s", …)`.
2. Give it a universal-quantifier title.
3. Run `spawn-refinement-team.js` with any `ac_shape_smells` entry pointing at it.
4. ⇒ `single-ticket collapse lacks a universal-quantifier title or describe.each([...]) acceptance test`

## Suggested fix

```js
// Accept BOTH the inline literal and the derived form.
const DESCRIBE_EACH_RE = /describe\.each\s*\(\s*[[A-Za-z_$]/s;
const UNIVERSAL_QUANTIFIER_RE = /\b(?:all|every|each|any|no|never|for any)\b/i;
```

**Better still: PREFER the derived form.** A gate that wants invariants over enumerations should treat
`describe.each([literal, literal])` as the *weaker* signal, not the only accepted one — it is a hand-copied
list, and hand-copied lists are what the gate exists to stamp out.

## Impact observed

LOA-1763's refinement ran **five rounds**. The gate blocked all five. Smell counts went 7 → 10 → 14 → 9 → 9,
and by rounds 4–5 the analysts had stopped finding shape problems and were finding genuine correctness bugs
(a CHECK constraint that would reject the first INSERT; a migration that ships without ever running; a
destructive UPDATE with no recorded prior value; a duplicate of an already-shipped `credit_rules.loan_program_id`
mechanism). **The gate's blocking was therefore load-bearing and valuable** — but its *stated* pass condition
was never reachable, so "refine until the gate is clean" is not a terminating instruction today.
