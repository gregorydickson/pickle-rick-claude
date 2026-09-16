# B-ROUTABLE — a findings channel is only as good as its locator

**Five roots. Two repair instruments (#35, #36); three are the cheap half of [[B-LENS]] that the operator
constraint left standing.** All five are edits to existing code, sentences or table cells — **no new
artifact, contract, list or required output**, per the binding constraint that the review phases stay
simple because they work by iterating.

**Why now:** L7 ("the loops should fix all issues they find") is blocked on its channels being
trustworthy. Two of three have been rate-checked and both are broken; the third is healthy. This bundle
repairs the two. **It also field-verifies #33/#34**, which are deployed as of `2.2.0-beta.1` but have
never run.

### The rate-check that produced this bundle

| channel | raw findings | verdict |
|---|---:|---|
| citadel `trap_door_coverage` | 163 | **82% false** — #34, fix built, unverified in field |
| skeptic | 283 | **73% false by construction** — R1 below |
| anatomy `dropped_findings.md` | 37 | **healthy — 37 of 37 state a reason.** Nothing to fix |

**Correction to the earlier headline, recorded because it was wrong:** "~197 defects found and not
fixed" was inflated by two broken instruments. The genuinely routable population is **~30 per run**.

---

## 🚧 ROOT R1 — the skeptic counts a file and its own build output as duplication (#36)

`skeptic-lens.ts:107-114` emits `cross-file-repetition-exhaustiveness` when a function name appears in
**2 changed files**, recording `file: files[0]` and **no `line` field at all**.

**Measured across every `skeptic_findings.json` on disk:**

| | count | share |
|---|---:|---:|
| total findings | 283 | |
| `cross-file-repetition` saying *"defined in 2 changed files"*, naming a `.js`/`.ts` | **206** | 73% |
| findings with **no line number** | 208 | 73% |
| naming **generated** output (`extension/bin/`, `extension/services/`) | 222 | 78% |
| naming editable source (`extension/src/**`) | 43 | 15% |

**The two files are a module and its own compiled twin.** `extension/bin/*.js` is tracked;
`tsconfig.json` is `rootDir: src`, `outDir: .`; and every commit touching a `.ts` touches its `.js`
(`408571c2`, `6dcc14f0`: `src.ts=1 compiled.js=1`). `writeSkepticSink` (`audit-runner.ts:98`) passes
`walkDiff(diffRange).changedFiles` straight in, and the lens has **zero** path filtering —
`grep -cE 'src/|generated|outDir' skeptic-lens.ts` → **0**.

**So `function foo` in `mux-runner.ts` and `function foo` in `mux-runner.js` is reported as duplication.
It is not duplication, it is compilation.** A false positive by construction, not a tuning problem.

### AC-R1
- **AC-R1-1 (the mechanism):** generated paths are excluded from the lens's input. Decide and state
  WHERE — filtering `changedFiles` in `writeSkepticSink` keeps the lens pure; filtering inside the lens
  puts the knowledge where the finding is made. **One place, named in the commit.**
- **AC-R1-2 (BOTH halves — the load-bearing one):** the 206 clear **and** the 43 source-targeted
  findings remain. **A filter that also clears the 43 has disabled the lens, not fixed it.** Assert both.
- **AC-R1-3:** a finding that survives names a path under `extension/src/**` (or `extension/tests/**`),
  never a generated one.
- **AC-R1-4 (the missing locator):** `cross-file-repetition` carries no `line`. Either it gains one, or
  it states why a cross-file finding has none — **a finding with no locator cannot be routed to a fixer,
  which is the whole point of the channel.**
- **AC-R1-5 (mutation, both directions):** remove the filter ⇒ AC-R1-2's first half reds. Widen it to
  exclude `src/` too ⇒ the second half reds.
- **AC-R1-6:** `writeSkepticSink` swallows all failures by design (*"report-only: failures never surface
  to the pipeline"*). **Keep that.** This root must not make the skeptic able to fail a phase.

---

## 🚧 ROOT R2 — the judge's parse failure discards the output its success path keeps (#35)

`microverse-runner.ts:2859`:

```ts
function judgeAttemptFromOutput(output: string): JudgeMeasurementAttempt {
  const score = extractScore(output);
  if (score === null) {
    return { metric: null, failureKind: 'failed',
             message: 'judge output did not contain a numeric score' };   // `output` in scope, dropped
  }
  return { metric: { raw: output, score } };                              // success KEEPS it
}
```

This ended the last run: szechuan exited `metric_unmeasurable_unrecoverable` after 4 attempts, and **what
the judge actually said is recorded nowhere** — not in the log, not in `microverse.json`
(`failure_history: []`), not in any session file. One message covers three different bugs: empty output,
prose with no number, or a shape `extractScore` rejects.

`emitJudgeParseDiagnostic` (`:2249`) already captures `raw_output_truncated_512`, but its guard fires
only on a **JSON** parse error, so this path never reaches it.

### AC-R2
- **AC-R2-1 (the mechanism):** the failure carries a truncated copy of `output`, the way the success
  branch already carries it. Reuse the existing 512-char convention rather than inventing a second one.
- **AC-R2-2:** the three causes are distinguishable **from the artifact alone** — empty output is not
  reported identically to prose-without-a-number.
- **AC-R2-3 (mutation, both directions):** judge returns prose with no number ⇒ the recorded failure
  contains that prose. Judge returns a valid score ⇒ no failure record is written at all.
- **AC-R2-4:** the success path is byte-identical to today. This is an attribution fix.
- **AC-R2-5 (out of scope, deliberately):** whether 4 failed attempts *should* end the phase is a
  threshold behaving as documented. **Record the question; do not change it.**

---

## 🔒 ROOT R3 — the preservation replay (B-LENS L0). **Gates R4 and R5; run it FIRST.**

Three places where we are ahead of the external bar: szechuan Part I is a **superset** of lens 8;
Migration Hygiene's four scored Drizzle checks are **ahead** of lens 4; anatomy-park's subsystem
data-flow tracing has **no lens equivalent**. The risk this bundle carries is that "align to the bar"
reads as a licence to replace.

### AC-R3
- **AC-R3-1:** every change to `szechuan-sauce-principles.md` in this bundle is an **ADDITION or a
  re-tier**. Zero deleted lines in Parts I and II — verified by diff.
- **AC-R3-2:** Migration Hygiene keeps all four scored checks at their existing severities.
- **AC-R3-3 (the real control):** pick one historical szechuan violation and one anatomy-park CRITICAL
  from our own git history, re-run the current prompts over that code, and assert **both still fire**.
- **AC-R3-4:** **if AC-R3-3 cannot be made to pass, STOP and report the silenced finding.** A widening
  that trades an existing catch for a new one is a regression wearing an improvement's clothes.

---

## 🧪 ROOT R4 — one sentence: would this test fail if the feature were deleted? (B-LENS L3)

Szechuan's Test Quality asks for assertions on observable behaviour and flags tautologies. It never asks
the question that catches a green proving nothing. Measured: `grep -ic 'deleted or broken'
szechuan-sauce-principles.md` → **0**; `grep -ic 'inert'` → **0**.

Backed independently by the review inventory: *guard inert / gates nothing* is **23 of 342 (6%)**, the
second-largest category.

### AC-R4
- **AC-R4-1:** the Test Quality section carries the deleted-or-broken question and the inert-guard hunt.
- **AC-R4-2:** added by **widening the existing section** — not a new Part, not a new phase.
- **AC-R4-3 (negative control):** a test that would genuinely fail on deletion is NOT flagged.
  Over-triggering here floods every review.
- **AC-R4-4 (replay):** it flags a known inert guard from our own history and does not flag a known-good
  suite.

---

## 💬 ROOT R5 — comment density is a SMELL the file mis-tiers as STYLE (B-LENS L5)

The principles file already finds it and then files it under Style. Measured:

| smell | remedy | tier |
|---|---|---|
| Deep nesting (3+) | Early returns | **P2 Maintainability** (`:60`) |
| Copy-pasted code (3+) | Extract shared function | **P2 Maintainability** (`:60`) |
| Comments explaining "what" (`:25`) | **Rename to be obvious** | **P4 Optional/Style** (`:62`) |
| Comment-heavy code (`:243`) | **Rename, restructure** | **P4 Optional/Style** (`:62`) |

Identical remedy shape — restructure the code — and a two-tier gap. `:94` then puts *"comment wording"*
Out of Scope outright. **The miscategorisation is in the WORDING:** *"comment cleanup"* and *"comment
wording"* describe editing the COMMENT, which really is P4 and really is out of scope; the actual finding
is editing the CODE, which is P2 and in scope. Independently: comment bloat is **19 of 342 (5%)** of real
findings, and an LLM-authored codebase generates the smell at a rate a human-authored one does not.

### AC-R5
- **AC-R5-1:** a **severity/scope edit to existing rules.** No new dimension, no Part IV — the check
  exists.
- **AC-R5-2:** `:62` stops saying "comment cleanup"; `:60` gains the restructure case; `:94`'s exclusion
  narrows to comment *wording* so it stops swallowing density.
- **AC-R5-3 (the finding must name the CODE):** a raised finding says which function to restructure and
  why the comment is evidence. **A finding whose remedy is "delete this comment" has been re-tiered, not
  promoted**, and produces exactly the P4 noise this root must avoid.
- **AC-R5-4 (negative control, load-bearing):** a docblock recording a non-obvious WHY — a measured
  limit, a trap-door invariant, a `pattern_shape` — is NOT flagged. R3's replay must catch any edit that
  breaks this.
- **AC-R5-5:** replay and report how many EXISTING comments the re-tier would flag. If the number is
  large this is a one-time cleanup plus a standing check, and that must be **said before it lands**.

---

## 🛡 PRIME DIRECTIVE compliance

- **No halt, no abort, no phase-loop break.** AC-R1-6 explicitly preserves the skeptic's report-only
  swallow.
- **No new gate leg.** R1/R2 repair existing instruments; R4/R5 edit existing prose and tiers.
- **`EXIT_REASONS` gains nothing.**
- **Every root is an edit, not an addition** — the operator constraint on the review phases.
- **Would the next iteration have caught these?** No. #36 has been emitting 73% construction-artifacts
  since the lens shipped, which reads more reassuring the longer it runs.

## Non-goals

- Do NOT wire any channel into the fixing loop — that is L7, and it waits for these repairs to be
  **verified in a run**, not merely built.
- Do NOT change whether 4 failed judge attempts end the phase (AC-R2-5).
- Do NOT make the skeptic able to fail a phase (AC-R1-6).
- Do NOT touch `dropped_findings.md` — measured healthy, 37 of 37 justified.
- Do NOT rebuild B-LENS L1 or L2. They were cut for adding per-pass cost and a rejection path.

## Simplification Review

**R1 is a filter and its two controls. R2 is one field carried into a failure.** R4 is a sentence, R5 is
three table cells, R3 is a control that runs once outside the loop. If any root grows a module, an
artifact or a contract, stop and re-scope — that growth is the signal, not a detail.

**The risk is a vacuous green, twice over:** AC-R1-2 (a filter that clears everything) and AC-R5-4 (a
re-tier that strips the docblocks worth keeping). Both are asserted in both directions on purpose.
