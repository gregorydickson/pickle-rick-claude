> **✅ SHIPPED 2026-08-25 as v2.1.0-beta.15 — CLOSED.** Pipeline terminal
> (`stalled_below_target`, 250m 43s, session `2026-08-24-ee7d91b9`, 11 commits). **AC-1 met and
> operator-verified:** `test:fast` **pass 7984 / fail 1 / cancelled 0** — the lone failing leaf is the
> inherited `bun probe emits banner when bun is absent`. Counts grew 7973 → 7984 and suites held, so
> nothing was greened by shrinking.
>
> **Both anti-cheat criteria held, checked against diffs rather than commit messages:**
> `ebef999c` **condensed** the trap-door entry (`CLAUDE.md`, 1 insertion / 7 deletions) with **no
> `1500` change anywhere in the diff** — AC-4.1's one-token-constant cheat refused. `a90085a6` closed
> AC-4.2's vacuous-green path on an unresolvable diff range. `857c71f5` fixed the parity assertion by
> **deriving** the key set from `GateBaselineFile` rather than hardcoding a list that would drift.

> **⛔ RETRACTION — this PRD's sharpest claim was FALSE. Superseded by
> `BUG-2026-08-24-self-regressions-REFINED.md`.**
>
> **Withdrawn without reservation:** the accusation that commit `7798ea69` *"asserted a reconciliation
> it had not performed"*. Measured — `AC-SZGBD-05` is a DIFFERENT test from the failing
> `baseline write: emitted JSON keys match GateBaselineFile type exactly`, and it **passes**:
> `✔ AC-SZGBD-05: no new activity event literal was added; GateBaselineFile gains exactly the AC-5'
> check_status field`. That is exactly what the commit claimed. **It did what it said.**
>
> The author matched on the string `GateBaselineFile` appearing in a failing test name and concluded it
> was the same assertion — **a lexical match standing in for a semantic identity**, the exact defect
> family this bundle's parent exists to catalogue, committed while accusing a commit of the adjacent
> sin. The `baseline write:` failure is real; the framing was not.
>
> **Also corrected: "2 inherited" → 1.** `ℹ fail N` counts leaf cases; the `✖` list also prints suite
> markers. The `failing tests:` block holds exactly 5 leaves and `install.sh bun probe` is the SUITE
> MARKER for the bun leaf. Split is **1 inherited + 4 targets**, and AC-1's `fail 1` IS achievable.
>
> **Left open, not settled:** the isolation-dependence claim. Three analysts refute it; the author
> re-measured at the same HEAD and got 0/0/2, not 1/1/2. Likely a cwd difference. Neither side may
> write it up as settled — see the refined PRD §1.

> **✅ BOTH MANDATORY PRE-LAUNCH CHECKS PASSED — 2026-08-24 at HEAD `fedac997`.**
>
> **Stale premise: PASSED.** All four regressions reproduce at HEAD. Measured by exit code:
> `trap-door-conformance.test.js` RC=1 / fail 2 standalone; the other two files RC=0 standalone but
> their tests fail in full-suite context (see the isolation correction above).
>
> **Green tree: RED — and recorded as the launch baseline, which is what makes attribution work.**
> `npm run test:fast`, node 24.19.0 pinned: **523 suites / pass 7973 / fail 5 / cancelled 0 / 176.4s**.
> The five, named exhaustively:
> 1. `bun probe emits banner when bun is absent` — **INHERITED** (filed P3)
> 2. `install.sh bun probe` — **INHERITED** (same root cause, same P3)
> 3. `baseline write: emitted JSON keys match GateBaselineFile type exactly` — **this bundle's target**
> 4. `AC-BUNDLE-17: trap-door entries stay under 1500 chars` — **target**
> 5. `extension/CLAUDE.md touched trap-door entries` + `line 378 conforms` +
>    `clean or unavailable diff has no false failure` — **targets** (trap-door-conformance)
>
> A red tier is normally a hard stop. It is admissible here **only because every failure is named and
> classified before launch**: two inherited, the rest are precisely what this bundle exists to fix.
> **Any failure outside this list during the bundle is caused by the bundle.** AC-1's success condition
> is a return to `fail 1 / cancelled 0` on the FULL tier with counts not shrinking.

# BUG-2026-08-24 (P1) — the did-we-count bundle regressed 4 tests; its own verdict was withheld

- **Priority**: P1 — blocks shipping session `2026-08-24-218474cb`.
- **Status**: Open. Found by the operator measuring the tier the runtime flagged.
- **Type**: bug-bundle (self-regression fix)

## Trigger — the runtime called it first, and it was right

`pipeline-runner.log`, session `2026-08-24-218474cb`:

```
Phase pickle: 5 ticket(s) flipped Done over a red worker_gate_tests_verdict — withholding success verdict
Phase pickle: post_final_tier_degraded:red — withholding success verdict — script failure: test:fast
Pipeline finished: 1/4 phases, 209m 56s
```

The pickle phase exited 0, all 8 tickets and the parent flipped Done, **and the runtime refused to
certify it** — declining to advance into citadel / anatomy-park / szechuan-sauce. That is B-NOSTOP-GATES
behaving exactly as designed: a local disposition refused, a residual stamped, **no auto-release**.

Operator-measured `npm run test:fast` at HEAD, node 24.19.0 pinned:

| | baseline (pre-launch, recorded) | after the bundle |
|---|---|---|
| tests | 7961 pass | **7973 pass** |
| suites | 518 | **523** |
| **fail** | **1** (inherited bun probe) | **5** |
| cancelled | 0 | 0 |

**Four new failures. All caused by this bundle.** Per the standing rule, that is not shippable.

## The four regressions, mapped to the commits that caused them

| failing test | file | caused by |
|---|---|---|
| `baseline write: emitted JSON keys match GateBaselineFile type exactly` | `unrunnable-check-uncertifiable-baseline.test.js` | `7798ea69` (AC-5′ `check_status`) |
| `AC-BUNDLE-17: trap-door entries stay under 1500 chars` | `doc-cross-reference.test.js` | `29c81991` (AC-8′ trap door) |
| `extension/CLAUDE.md touched trap-door entries` | `trap-door-conformance.test.js` | `29c81991` |
| `line 378 conforms` · `clean or unavailable diff has no false failure` | `trap-door-conformance.test.js` | `29c81991` |

## The finding that matters most

`7798ea69`'s own commit message claims:

> *"**Reconciles** AC-SZGBD-05's byte-exact `GateBaselineFile` interface assertion **in the same commit**"*

**It does not.** That assertion is now red. A commit asserting it had reconciled a constraint, in a
bundle whose entire purpose is to stop unverified claims being presented as verified, **did not verify
the claim it made in its own message.** This is the defect class, one level up: not a bad measurement,
but an unbacked assertion of having measured.

The same shape appears in `29c81991`, which added a trap door "with resolved ENFORCE anchor" while
breaking three separate trap-door conformance rules.

## ⚠️ MEASURED CORRECTION — 2 of the 4 are ISOLATION-DEPENDENT, and that changes the fix

Re-measured per-file **by exit code** (not by grep — my first attempt used the Node-22 `^# fail`
summary form, which never matches under Node 24 and silently reported two failing files as passing;
the very trap this bundle's parent exists to prevent):

| test file | standalone RC | standalone fail count |
|---|---|---|
| `unrunnable-check-uncertifiable-baseline.test.js` | **0** | **0 — passes alone** |
| `doc-cross-reference.test.js` | **0** | **0 — passes alone** |
| `trap-door-conformance.test.js` | **1** | **2 — fails alone** |

So the `GateBaselineFile` and `AC-BUNDLE-17` failures **reproduce only in full-suite context** — they are
isolation- or ordering-dependent, not standalone defects. Only the two `trap-door-conformance` failures
reproduce in isolation.

**Consequence for the fix, binding:** a worker that verifies per-file will see
`unrunnable-check-uncertifiable-baseline` and `doc-cross-reference` pass and conclude it is done. It
will be wrong. **AC-1 must be measured on the FULL `npm run test:fast`, never per-file**, and the
repo's `scripts/audit-test-isolation.sh` is the relevant existing mechanism to consult.

## Acceptance criteria

- **AC-1** `npm run test:fast` returns to **fail 1 / cancelled 0** — the inherited bun probe only —
  measured on a censused box with the count reported. Suites and test counts must not shrink.
- **AC-2** `check_status` is reconciled with `AC-SZGBD-05` **for real**: either the byte-exact interface
  assertion is updated to include the new optional field with rationale, or `check_status` moves
  somewhere that does not violate it. **Run the assertion and paste its output** — do not restate the
  claim `7798ea69` already made without backing.
- **AC-3** The AC-8′ trap door satisfies **all three** conformance rules it currently breaks: the
  1500-char entry cap, the touched-entries rule, and line-378 conformance. Report each individually.
- **AC-4** No AC in this bundle may be closed on a commit-message claim. Every AC closes on pasted
  command output.
- **AC-5 (PRIME DIRECTIVE)** No new halt path, no new `exit_reason`. Nothing here justifies one.

## Non-goals

Reverting the did-we-count work — the corpus, rules, 8-site registration, and positive controls are
sound and independently verified (corpus contract 9/9, replay reports 7 rule-covered of 9 detectable).
This bundle fixes the four regressions those commits introduced, nothing else.

## Note for the ledger

The bundle's substance is good and its honesty discipline held where it counted — it reported 7 of 18
when it could have claimed 18, and it turned a live bug into a firing tripwire instead of an exemption.
The failure is narrower and more specific: **two commits made reconciliation claims in prose that their
own test suite contradicts.** That is worth fixing precisely, not reverting wholesale.
