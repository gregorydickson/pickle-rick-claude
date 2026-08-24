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
