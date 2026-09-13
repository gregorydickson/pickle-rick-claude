# B-RATCHET — a recorded ceiling that nothing enforces is a comment

**One thesis, five roots.** beta.27 made the largest complexity debt in this codebase VISIBLE and wrote
its numbers into a review marker. That was the right first move and it is only half a ratchet: **nothing
reads those numbers.** They can grow silently, which is the same rot-green shape the marker was meant to
end.

This bundle makes the ceiling enforceable, then uses it — lowering the two carve-outs it governs, and
fixing the loop defect that makes large debt unscoreable in the first place.

All numbers below were re-measured at HEAD `6186b3a3` on 2026-09-13 by AST and by neutralising the
disables and re-running the project's own eslint config. Do not inherit them; re-measure before scoping.

**Order: R1 first** — it creates the ceiling R2 and R3 ratchet against. **R3 before R2**: it is small and
it proves the ratchet mechanism works before the large refactor leans on it.

---

## 🔒 ROOT R1 — the recorded ceiling is prose; make it a ratchet that can only go down

`mux-runner.ts` carries two review markers stating measured numbers:

```
// eslint-disable-next-line complexity -- HT-1 reviewed: measured complexity 16 against a ceiling of 15 ...
// eslint-disable-next-line max-lines-per-function, complexity -- HT-1 reviewed: measured 1690 code lines
//   against a ceiling of 120, and complexity 366 against a ceiling of 15 ...
```

**Nothing parses them.** `tests/integration/mega-bundle-e2e.test.js` greps for the literal
`HT-1 reviewed:` and never reads the figures. Measured: no script or test in the repo matches `1690` or
`complexity 366`. So the function can grow to 2000 lines and complexity 500 and every gate stays green
while the comment keeps asserting 1690.

**This is the catalog-rots-green shape**, and this file's own history is full of it: an audit that checks
a reference RESOLVES has not checked that the invariant still names the truth.

### AC-R1 (machine-checkable)
- R1-1: an audit PARSES the recorded figures from each carve-out marker, MEASURES the current values
  (AST code-line count and eslint complexity), and FAILS when a measured value EXCEEDS its recorded one.
- R1-2: the audit also fails when a marker's recorded figure is ABSENT or unparseable. A carve-out that
  stops stating its numbers must not read as compliant.
- R1-3 (ratchet direction): when a measured value is BELOW its recorded one, the audit fails with an
  instruction to lower the record. A ceiling that is never tightened is not a ratchet. This must name
  the new number so the fix is mechanical.
- R1-4 (over-trigger control): the 47 scoped disables that carry no figures are untouched and still pass.
- R1-5: the audit is wired into the release gate in root `CLAUDE.md` AND `.github/workflows/release.yml`,
  and the parity test still passes.
- R1-6 (mutation): raise a recorded figure above the measured value → R1-3 RED; edit the source so a
  measured value exceeds its record → R1-1 RED; delete a figure → R1-2 RED.

---

## ✂️ ROOT R3 — retire the smaller carve-out entirely (complexity 16 → ≤15)

`correctPhantomDoneTickets` (`mux-runner.ts:2185`) is **36 code lines, complexity 16**, one over the
ceiling of 15. It is one branch over the line, and its own marker explains the constraint:
`R-AFCC-DEEP-3B` requires `batchLoopPhantomDoneKind` to stay in this function body
(`audit-phantom-done-call-sites.sh` invariant).

**Do the small one first.** It proves R1's ratchet fires and it deletes a carve-out rather than
lowering it.

### AC-R3 (machine-checkable)
- R3-1: `correctPhantomDoneTickets` has complexity ≤15 measured by eslint, with **no disable comment**.
  The directive is DELETED, not lowered.
- R3-2: `batchLoopPhantomDoneKind` still resolves inside this function body;
  `audit-phantom-done-call-sites.sh` passes. The R-AFCC-DEEP-3B invariant is not traded away.
- R3-3 (behaviour): the phantom-Done correction suites pass unchanged. This is a STRUCTURAL change —
  no ticket disposition, ordering or activity payload may differ.
- R3-4: R1's audit no longer lists this carve-out, because it no longer exists.
- R3-5 (mutation): reintroduce the extra branch → R3-1 RED.

---

## 🪓 ROOT R2 — halve the largest function in the codebase, against the ceiling R1 creates

`runMuxRunnerMain` (`mux-runner.ts:12927`): **1690 code lines, 2202 span, complexity 366.** Ceilings are
120 and 15, so it is 14x and 24x over. It is the iteration loop that decides ticket lifecycle, salvage
and Done-flips — the function most responsible for whether a run reports the truth, and the one whose
complexity the PRIME DIRECTIVE's brittleness clause is actually about.

**Bounded target, not "reach 120".** A 14x reduction in one bundle is not reviewable and this is the
salvage path. Halve it, lower the record, and let the next bundle halve it again. The ratchet exists so
this can be finished incrementally without ever going backwards.

**Extract along the loop's own seams**, which the file already names in its docblocks: session bootstrap,
rate-limit cycle, worker spawn/await, completion-evidence evaluation, recovery ladder, epic finalize. Each
extraction is a pure move of an existing block into a named function taking explicit parameters.

### AC-R2 (machine-checkable)
- R2-1: `runMuxRunnerMain` measures **≤900 code lines and complexity ≤180**, by the same AST and eslint
  measures R1 uses.
- R2-2: its recorded figures are updated to the NEW measured values, and R1's audit passes against them.
- R2-3 (behaviour, the load-bearing AC): this is a STRUCTURAL change only. Every extraction is
  behaviour-preserving; no exit reason, disposition, activity event, ordering or state write may differ.
  The full fast and integration tiers pass unchanged.
- R2-4: each extracted helper is individually under the 120/15 ceilings and carries NO disable.
  Extraction that merely relocates the violation fails this AC.
- R2-5: the `eslint-disable` on `runMuxRunnerMain` still names exactly the rules it trades away and
  still carries its (now lower) figures.
- R2-6 (mutation): a behavioural mutation inside any extracted helper must red an existing suite. If an
  extraction is not covered by anything, say so in the ticket rather than claiming it is safe.

**Non-goal:** do NOT change any decision the loop makes. If an extraction reveals a defect, FILE it and
leave the behaviour intact — a bug fix hidden inside a 1690-line refactor is unreviewable.

---

## 📉 ROOT R4 — an unresolvable ledger entry guarantees a stall (GitHub #23)

The szechuan metric is the count of open ledger entries, and an entry leaves only when fully resolved.
An entry no single iteration can finish therefore can never move the metric.

Measured across two runs in the same week:

| | stalled | converged |
|---|---|---|
| session | `2026-09-12-a4d141e1` | `2026-09-13-d2e834e1` |
| exit | `stalled_below_target`, 6 iters, 15m | `converged`, 9 iters, 29m |
| largest entry | **1690 code lines, complexity 366** | 88 lines |
| szechuan commits | **1**, touching NO ledger entry | **8**, each closing a named entry |
| final ledger | 6 | **0** |

`buildCitadelAuditReport` is the control: unresolved at 122 lines in the stalled run, split successfully
in the converged one. It was never intractable — it was starved behind an entry no iteration can finish.

**#22 does not solve this.** It removed the three FALSE entries (46/47/49 code lines against a ceiling of
120). The same ledger would then hold roughly one real entry — `runMuxRunnerMain` — and stall just as
certainly, with less noise.

**The disposition also misattributes.** `stalled_below_target` reads as "the worker could not make
progress". In the stalled run the worker's constraint was that the only scoreable item needed a
multi-session refactor.

### AC-R4 (machine-checkable)
- R4-1: measurable partial progress on an entry (code lines or complexity falling between iterations)
  counts as progress, so the metric is not pinned by an entry that is genuinely shrinking.
- R4-2 (negative control): a worker that produces no change still stalls. The point is to separate *made
  no progress* from *made progress the metric cannot see* — not to make stalling impossible.
- R4-3: when the remaining entries are ones the loop has repeatedly failed to move, the disposition says
  so instead of emitting a bare `stalled_below_target` that blames the worker.
- R4-4: replaying the two sessions above, the stalled run reports the new disposition and the converged
  run still converges unchanged.
- R4-5 (mutation): remove the partial-progress term → R4-1 RED, R4-2 GREEN.

---

## 🧱 ROOT R5 — the 3232-line catch-all module, one bounded split

`services/pickle-utils.ts` is **3232 lines with 128 exports**, bundling terminal formatting, ticket
management, tier classification, settings loading and environment utilities. It was a med-severity entry
on the stalled run's ledger and went unresolved.

**Bounded:** extract the TWO most cohesive concerns into their own modules. Do not attempt a full
decomposition, and do not renumber the world.

### AC-R5 (machine-checkable)
- R5-1: at least two cohesive concerns are extracted into named modules; `pickle-utils.ts` drops below
  **2600 lines**.
- R5-2 (structural only): every moved symbol keeps its name and behaviour. Re-exports preserve existing
  import paths, or every call site is updated in the same commit — no import may break.
- R5-3: the Module Export Catalog entries for the affected modules are regenerated and correct, and the
  catalog audits pass.
- R5-4 (behaviour): full fast and integration tiers pass unchanged.
- R5-5: no extracted module carries a new disable or exceeds the 120/15 ceilings.

---

## 🛡 PRIME DIRECTIVE compliance

R1 adds an audit, which is a gate that can refuse a COMMIT, never a run. Nothing here adds a halt, an
abort condition, or a phase-loop break. R4 makes a disposition MORE accurate and explicitly keeps the
stall reachable.

R2, R3 and R5 are the brittleness clause applied directly: complexity 366 in the function that decides
Done-flips is the single largest "distinct states a reader must hold" in this codebase.

R1 is the enumerated-liability fix — a hand-written number in a comment is a list of one that has
already proven it can drift, and R1-3 makes the drift impossible in both directions.

## Non-goals

- Do NOT change any decision `runMuxRunnerMain` makes (R2 non-goal). File defects found; fix them later.
- Do NOT aim `runMuxRunnerMain` at 120 in this bundle. R2-1 is the bounded target; the ratchet finishes it.
- Do NOT lower a carve-out by widening a ceiling. R1-1 fails such a diff.
- Do NOT fully decompose `pickle-utils.ts`. R5-1 is the bounded target.
- Do NOT make stalling unreachable (R4-2).

## Simplification Review

Named subtractions: one carve-out DELETED outright (R3); roughly 790 code lines and 186 complexity
removed from one function (R2); at least 632 lines out of a catch-all module (R5); one unenforced prose
number replaced by a measured, monotone ceiling (R1).

R4 adds a term to a comparison, which is the one addition here, and it removes a false attribution in
exchange. The metric currently reports "the worker made no progress" for a case where the worker made
progress the metric could not see, and this codebase's dominant defect class is exactly that: a
measurement that cannot distinguish absent from failed.
