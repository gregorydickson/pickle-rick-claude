---
title: "R-PLGR — the mandated pre-launch check asks 'is the fix still needed?' and never 'is the ground green?', so bundles launch onto a red tree"
finding: R-PLGR
priority: P2
status: open
type: bug-report
schema_neutral: true
surfaced: "2026-07-14, launching B-FOMC. The pre-launch check passed cleanly and the branch was already red."
---

# R-PLGR — the pre-launch check verifies the premise and not the ground

## What happened

`prds/CLAUDE.md` mandates a **Pre-launch stale-premise check** (earned by B-PSCG, 2026-07-12):

> *"Before authoring or launching any bug/fix bundle, grep HEAD **and the deployed tree** for the finding's most
> distinctive artifact — its log string, guard, or R-code annotation. A finding is 'open' only if its artifacts are
> ABSENT from both."*

For B-FOMC I ran it. It passed cleanly: `FOM_EVIDENCE_RULES` absent from source and the deployed tree, the shape
test absent, the AC-FOMC-3 regression pin green. **Premise confirmed. I launched a ten-ticket bundle.**

**The branch was already RED.** At `ca6636f8` — the exact commit I checked — line 138 of `extension/CLAUDE.md` was
**1662 chars against a 1500-char cap**, failing `tests/trap-door-conformance.test.js` (3 assertions) **and**
`scripts/audit-trap-door-enforcement.sh`. **Both sit on the release gate.** The entry had been over-cap since
`69829ec5`, long before B-FOMC existed.

## Why it matters (it is not cosmetic — it corrupts every downstream signal)

Every worker in the bundle then inherited a gate that was red for a reason it did not cause:

- `c4ee67ff` (medium) ran `test:fast`, got **red**, and flipped **Done** anyway — an **unattributable** verdict.
- `a460cad3` (small) **skipped** `test:fast` and reported **green** — a **vacuous** verdict.

Both are [[R-WGVI]]. **R-PLGR is what put the red there in the first place.** A bundle that launches onto a red tree
cannot distinguish its own breakage from the debt it inherited, and every gate verdict downstream is noise. The
closer then eats a blocker it did not create, at the most expensive possible moment — tag time.

## Root cause

The check asks exactly one question: **"is this fix still needed?"** (has the finding already shipped?). It never
asks the other one: **"is the ground I am building on solid?"** Those are different questions and the protocol only
encodes the first.

The gap is small, cheap to close, and the cost of leaving it open is paid by every ticket in every bundle.

## The fix — one line in the protocol, one command at launch

Add a **green-tree precondition** to `prds/CLAUDE.md`'s pre-launch section, and make it a hard stop:

> **Green-tree precondition (MANDATORY).** Before launching, the release-gate fast tier MUST be green on the launch
> commit:
> ```
> cd extension && npm run test:fast
> ```
> A red tier is a **HARD STOP**. Fix it (or explicitly record the failures as inherited, with the commit that
> introduced them) **before** launching. **A bundle launched onto a red tree cannot attribute its own gate
> verdicts.** Record the launch commit's tier result in the session so the closer can subtract the baseline.

**Where to enforce it** (cheapest first, and *one* of these — not all three):

1. **Doc-only** (`prds/CLAUDE.md`) — the same discipline arm as the Simplification Review. Zero machinery.
   **Recommended.**
2. **`setup.js` warns** at session bootstrap if `test:fast` is red, and writes the failing test names into the
   session so the closer can subtract them. Small, and it is the same data [[R-WGVI]] needs for baseline subtraction.
3. ~~A launch gate that blocks~~ — **NO.** That is a new blocking gate, and it would refuse launch on a flake
   (cf. the ENOBUFS failure sitting in the same tier). Advisory + recorded, not blocking.

## Acceptance criteria

- `AC-PLGR-1`: `prds/CLAUDE.md`'s pre-launch section carries the green-tree precondition with the exact command.
  Verify: `grep -q 'Green-tree precondition' prds/CLAUDE.md`.
- `AC-PLGR-2` *(if option 2 is taken)*: launching onto a red fast tier records the failing test names in the session
  and emits an activity breadcrumb. It does **not** block. Verify: fixture with one red test → breadcrumb present,
  launch proceeds.
- `AC-PLGR-3`: the recorded baseline is consumable by [[R-WGVI]]'s baseline subtraction (same shape, one producer).

## Simplification Review (subtract-before-add)

1. **Is the addition necessary at all?** Option 1 adds **nothing** — it is a doc line. Option 2 adds one bootstrap
   check that writes data [[R-WGVI]] already needs.
2. **Can it REUSE instead of ADD?** Yes. The gate command already exists (`npm run test:fast`), and the recorded
   baseline is the **same artifact** R-WGVI's baseline subtraction consumes. **One producer, two consumers — do not
   build a second baseline.**
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** No new guard. It explicitly
   **refuses** to add a blocking launch gate — that would false-block on the ENOBUFS flake already living in the
   tier, which is the R-WGFR antipattern exactly.
4. **What can this issue SUBTRACT?** It removes an entire class of *unattributable* downstream signal. Every gate
   verdict in a bundle becomes interpretable, which is the precondition for [[R-WGVI]] fixing them at all.

## Recoverability line (per prds/CLAUDE.md)

N/A — no state field is healed. The launch-commit tier result is **time-variant** and must be captured **at launch**
(the build destroys the tree state); check whether `pinned_sha` / `start_commit` already co-stamps the commit before
adding a new field.

## Related

- [[R-WGVI]] — the downstream damage. R-PLGR puts the red there; R-WGVI is why nobody could tell.
- B-PSCG (2026-07-12) — earned the *stale-premise* half of this check. This is its missing twin.
- [[feedback_prelaunch_residual_check_stale_findings]] — the memory encoding the half we already had.
