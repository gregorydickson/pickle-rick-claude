# BUG-2026-08-24 (P1) — did-we-count bundle self-regressions — REFINED

Refined 2026-08-24, 3 roles × 2 cycles, session `2026-08-24-ee7d91b9`, all measurements at HEAD
`68abb241`, node 24.19.0, **adjudicated by exit code**. All three analysts retracted or inverted at
least one of their own cycle-1 claims. So does the author.

## 0. RETRACTIONS — the authored PRD's sharpest claim was FALSE

**RETRACTED: "commit `7798ea69` asserted a reconciliation it had not performed."** That accusation is
wrong and is withdrawn without reservation.

Measured: `AC-SZGBD-05` is a **different test** from the failing `baseline write: emitted JSON keys
match GateBaselineFile type exactly`, and it **passes**:

```
✔ AC-SZGBD-05: no new activity event literal was added;
  GateBaselineFile gains exactly the AC-5' check_status field
```

That is precisely the reconciliation the commit claimed. **It performed it.** The author matched on the
string `GateBaselineFile` appearing in a failing test name and concluded it was the same assertion the
commit named — **a lexical match standing in for a semantic identity**, which is the exact defect family
this bundle's parent exists to catalogue. Committed while accusing a commit of the adjacent sin.

The `baseline write:` failure is real and still in scope. The *framing* — that a commit lied — is not.

**RETRACTED: "2 inherited."** The authored pre-launch record named `bun probe emits banner when bun is
absent` AND `install.sh bun probe` as two inherited failures. Measured: `ℹ fail 5` counts **leaf test
cases**; Node's `✖` list also prints **suite markers**. The `failing tests:` block contains exactly 5
leaves, and `install.sh bun probe` is the **suite marker** for the first. **Inherited = 1.**

Consequence: **AC-1's `fail 1` target is achievable**, and the corrected split is **1 inherited + 4
targets**, not 2 + 3.

## 1. DISPUTED, and deliberately left disputed — isolation-dependence

The authored PRD asserted 2 of 4 regressions are isolation-dependent. All three analysts refuted it
("all four reproduce standalone, 1+1+2"). The author **re-measured at the same HEAD and could not
reproduce their result**:

| file (run from `extension/`) | author RC | author fail | analysts |
|---|---|---|---|
| `unrunnable-check-uncertifiable-baseline.test.js` | 0 | 0 | 1 |
| `doc-cross-reference.test.js` | 0 | 0 | 1 |
| `trap-door-conformance.test.js` | 1 | 2 | 2 |

Both cannot be right. The likely difference is **cwd** — these tests read files by relative path, and
`npm run test:fast` runs from `extension/`. **This is not settled and must not be written up as settled
by either side.**

**It is also moot for the success criterion**, which is why it is not blocking: AC-1 is measured on the
FULL tier, where the observed state is unambiguous. Ticket 1 resolves the dispute *for the record* by
running each file from both cwds and reporting all four numbers.

## 2. Acceptance criteria

- **AC-1 (binding, full tier only).** `npm run test:fast` from `extension/`, node 24 pinned, returns
  **`fail 1` / `cancelled 0`** — the inherited `bun probe emits banner when bun is absent` leaf only.
  Suites ≥ 523 and pass-count ≥ 7973: **nothing may be greened by shrinking**. Report the `ℹ` summary
  block verbatim. **Per-file verification is forbidden as evidence** — see §1.
- **AC-2 (`baseline write:` assertion).** Fix the failing `baseline write: emitted JSON keys match
  GateBaselineFile type exactly`. Note `AC-SZGBD-05` is **green and must stay green** — do not "fix" it.
  Paste both test lines.
- **AC-3 (universal quantifier — reshaped per the AC-shape gate).**
  **Title:** *All trap-door entries in `extension/CLAUDE.md` conform to the entry-length rule.*
  **Acceptance test:** `describe.each([...])` over every trap-door entry, asserting each is under its
  cap. Analysts measured that the two `trap-door-conformance` failures print the **byte-identical**
  payload `length: line 378 trap-door entry is 5301 chars` — i.e. **one rule, one entry**, not three
  rules. **Establish the actual cap and unit before changing anything** (cycle-2 measured 3002 chars
  single-line vs 5301 multi-line, and reported the two 1500-char caps are **nested, not independent**).
- **AC-4 (anti-vacuous-green, binding).** Two named cheats are **forbidden** and each must be shown not
  to have been used:
  1. **The one-token constant.** Raising the 1500-char cap greens three tests without fixing anything.
     If the cap is changed at all, justify the new number against the measured entry length and say so.
  2. **The unreachable-tag vacuous path.** An unresolvable git tag makes `bad revision` get swallowed
     and **zero** dynamic conformance tests generate — a clean paste with nothing verified. Report the
     **count of conformance tests actually generated**, not just their pass status.
- **AC-5 (no AC closes on a claim).** Every AC closes on pasted command output. No AC may be closed by
  restating a commit message — the authored PRD's own retraction in §0 is the worked example.
- **AC-6 (PRIME DIRECTIVE).** No new halt path, no new `exit_reason`.

## 3. Non-goals

Reverting the did-we-count work (corpus 9/9, replay honestly reporting 7 of 9 detectable, `2c857117`
as a firing tripwire — all independently verified). Re-litigating `AC-SZGBD-05`. Raising a cap to pass
a test.

## 4. Risks

| # | risk | mitigation |
|---|---|---|
| R1 | Cap raised as a one-token constant; three tests green, nothing fixed | AC-4.1 |
| R2 | Unreachable tag ⇒ zero dynamic tests ⇒ vacuous clean paste | AC-4.2 (report the count) |
| R3 | Per-file verification declares victory while the tier stays red | AC-1 forbids it as evidence |
| R4 | `AC-SZGBD-05` "fixed" though it is green | AC-2 names it must stay green |
| R5 | Author's isolation claim or analysts' refutation written up as settled | §1 keeps it open; ticket 1 measures both cwds |
| R6 | Counting leaves vs suite markers again | AC-1 pins the `ℹ` summary as the unit |

## 5. Assumptions

- `ℹ fail N` counts leaf cases and the `✖` list includes suite markers (measured this cycle: 5 leaves
  in the `failing tests:` block against `ℹ fail 5`).
- The gate's execution cwd is `extension/`.

## 6. Decomposition — `complexity_tier: medium`

| # | ticket | ACs |
|---|---|---|
| 1 | Settle the isolation dispute: run all 3 files from both cwds, report 4 numbers | §1, AC-1 |
| 2 | Fix the `baseline write:` assertion; prove `AC-SZGBD-05` stays green | AC-2 |
| 3 | All trap-door entries conform to the entry-length rule (`describe.each`) | AC-3, AC-4.1 |
| 4 | Report the generated-conformance-test count; close the vacuous path | AC-4.2 |
| 5 | Closer: full tier to `fail 1 / cancelled 0`, counts not shrinking, `ℹ` block pasted | AC-1, AC-5 |
