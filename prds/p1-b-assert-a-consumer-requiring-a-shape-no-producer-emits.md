# B-ASSERT — a consumer requiring a shape no producer emits

**One root, measured at HEAD `359cbdcc`.** B-BUGZERO's Z1 made the Done-flip execute a ticket's
acceptance assertion and park on failure. It works, and it is reachable on the recovery route. Its
extractor requires the command in **backticks**:

```
EXECUTABLE_ASSERTION_RE = /`([^`\n]+)`[ \t]+(exits|returns)[ \t]+`?(\d+)\b/g
```

That requirement is deliberate. The PRD's own non-goal forbids inferring runnable commands from prose,
because inference is how this bug class is created. **The problem is not the contract. It is that
nothing tells anyone to satisfy it.**

**Measured:**

| measurement | result |
|---|---|
| real session tickets with an `## Acceptance Criteria` section | 8 |
| of those, carrying a backticked `exits`/`returns` assertion | **5** |
| still unguarded at the Done-flip | **3** |
| authoring paths that INSTRUCT or EMIT the backticked form | **0** |

The five that comply do so by convention or accident, not instruction. So coverage is a coin-flip per
ticket, and it can silently fall to zero without any code changing.

**This is the `R-ACNP` shape again** — a consumer with no producer — one release after that row was
struck. The consumer is correct, well-scoped and tested. It is simply waiting on a shape the authoring
side was never asked to produce.

**Order: O1 first.** O2's census is meaningless until a producer exists to measure.

---

## ✍️ ROOT O1 — teach the authoring paths to emit the executable-assertion form

Acceptance criteria are authored in `.claude/commands/pickle-prd.md`,
`.claude/commands/pickle-refine-prd.md` and `extension/src/bin/spawn-refinement-team.ts`. None of them
mentions the backticked `exits` / `returns` form.

### AC-O1 (machine-checkable)
- O1-1: every authoring path that emits or instructs an `## Acceptance Criteria` section documents the
  executable-assertion form with a worked example whose command is backticked.
- O1-2: the documented form is EXACTLY what `EXECUTABLE_ASSERTION_RE` accepts. Assert this by extracting
  the example out of each authoring doc and running the real extractor over it — not by eyeballing the
  regex. A worked example the consumer cannot parse is worse than none.
- O1-3: the instruction is explicit that a prose criterion is still VALID and simply unguarded. This
  must not read as "every criterion must be a command", which would push authors to invent commands.
- O1-4 (mutation): change the documented example so the extractor no longer matches it; O1-2 goes RED.

---

## 📊 ROOT O2 — gate the producer/consumer coverage so it cannot silently drift

Coverage is currently 5-in-8 and nothing measures it. If an authoring change stops emitting the form,
every new ticket becomes unguarded and no test notices.

### AC-O2 (machine-checkable)
- O2-1: an audit measures, over the repo's own ticket corpus, the fraction of `## Acceptance Criteria`
  sections carrying an extractor-parsable assertion, and reports the figure.
- O2-2: the audit FAILS when that fraction falls below a recorded floor, and the floor is RECORDED
  (the ratchet shape already used by `audit-recorded-ceilings.sh`) so it can only be raised.
- O2-3 (over-trigger control): tickets with no acceptance section at all are excluded from the
  denominator. They are not failures, they are out of scope.
- O2-4: the audit is wired into the release gate and the workflow, and the parity test passes.
- O2-5 (mutation): strip the backticks from a corpus ticket; O2-2 goes RED.

**Non-goal:** do NOT set the floor at 100%. A prose criterion is legitimate (O1-3). The floor records
where coverage actually is and ratchets from there.

---

## 🗂 ROOT O3 — disposition the row honestly, whichever way it lands

`R-ORSR-2`'s probe uses an UNBACKTICKED fixture and reports OPEN. It is right to: a residual genuinely
remains today.

### AC-O3 (machine-checkable)
- O3-1: once O1 and O2 land, the row is re-measured and dispositioned with the mechanism cited.
- O3-2: if a residual remains, the row STAYS open and its probe keeps reporting OPEN. **Do NOT close
  this row by backticking the probe's fixture** — that hides the gap instead of closing it.
- O3-3: the ledger three-way consistency check still agrees (stated count, audit-confirmed probes, raw
  open headings).

---

## 🛡 PRIME DIRECTIVE compliance

O2 adds an audit, which refuses a COMMIT and never a run. No halt, no abort condition, no phase-loop
break. O1 is documentation that makes an existing consumer reachable.

The subtraction here is conceptual and real: today a reader must hold "the guard exists, but only fires
on a shape nobody is told to write." After O1 there is one rule — write the assertion this way and it is
enforced — and O2 stops that rule decaying silently.

## Non-goals

- Do NOT widen the extractor to accept unbackticked prose. That is the inference this class forbids.
- Do NOT require every criterion to be executable (O1-3).
- Do NOT set the O2 floor at 100% or backdate it.
- Do NOT close `R-ORSR-2` by editing its probe fixture (O3-2).
