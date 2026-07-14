---
title: "R-WGVI — the worker gate verdict carries no information about the ticket: small-tier greens are vacuous, medium-tier reds are unattributable"
finding: R-WGVI
priority: P1
status: open
type: bug-report
schema_neutral: true
surfaced: "2026-07-14, building B-FOMC (the honesty bundle). The runtime that built FOM_HONEST_REPORTING_RULES violated FOM_HONEST_REPORTING_RULES."
---

# R-WGVI — a green that never ran, a red that isn't yours

## The observation (three tickets, one session, 2026-07-14-95d8f69f)

| Ticket | `complexity_tier` | `worker_gate_verdict` | `status` | What the verdict actually means |
|---|---|---|---|---|
| `33681a13` | medium | *(absent)* | Done | no verdict persisted |
| `c4ee67ff` | medium | **`red`** | **Done** | ran `test:fast` → red from a **pre-existing** failure it did not cause |
| `a460cad3` | **small** | **`green`** | Done | **`test:fast` never ran.** Green because the gate exited before the test tier |

**All three flipped Done. Not one of those verdicts says anything about the ticket's own diff.**

## Mechanism

### (a) A `small`-tier green is VACUOUS

`spawn-morty.ts:1405` — *"Pre-test exits (lint/tsc fail, narrow tier, small tier) all report the same"*. A `small`
ticket exits `runWorkerGateChecks` **before `runWorkerGateTestCommand('test:fast', …)`** (`:1423`) is ever reached.
It reports **green**.

`a460cad3` was tiered `small` and reported **green** *while the fast tier on that exact commit was RED* — the branch
carried 4 failures (`extension/CLAUDE.md` trap-door entry over the 1500-char cap, 3 assertions + 1 ENOBUFS flake).
The gate did not detect a red tier. **It did not look.**

This is, verbatim, the rule B-FOMC just shipped into every judging prompt:

> *"Silence is not success. A fast clean pass may mean the gate never fired, not that it passed."*
> — `FOM_HONEST_REPORTING_RULES`, `extension/src/services/fom-blocks.ts`

### (b) A `medium`-tier red is UNATTRIBUTABLE

The gate runs the **whole `test:fast` tier**, not the ticket's diff. So **any** pre-existing red anywhere in the
repo turns **every** medium/large ticket's gate red, regardless of what that ticket touched. `c4ee67ff`'s `red` was
caused by a trap-door entry in `extension/CLAUDE.md` — a file with **zero** commits from that ticket, last touched
by an unrelated install fix (`69829ec5`), over-cap since before the bundle existed.

A verdict that is red for someone else's debt tells you nothing about the ticket that ran it.

### (c) A `red` verdict did NOT block the Done-flip, despite the guard's stated contract

`mux-runner.ts:4568-4575` documents `readWorkerGateVerdict` as feeding a guard that refuses *"[a] Done-flip on a
non-green verdict"*, consumed via `resolveWorkerGateVerdict` (`:4641`) → `guardCompletionCommitBeforeDone` (`:4727`).
**`c4ee67ff` has `worker_gate_verdict: "red"` and `status: "Done"`.** Either the guard tolerates red, or something
overrode it.

⚠ **Honestly declared: I have NOT read the exact branch that decides this.** I traced the verdict from
`spawn-morty.ts:1483` (write) to `guardCompletionCommitBeforeDone` (read) and stopped. The **observation** —
`red` + `Done` on the same ticket — is machine-verified from the ticket frontmatter. The **mechanism** is a
hypothesis. Do not restate it as fact. (This distinction is the subject of the bundle that surfaced it.)

**Note the trap in "just make red block Done":** the fast tier was red for a pre-existing reason, so a
strictly-fail-closed guard would have **deadlocked every ticket in the bundle** at zero commits. That is why this
is a *design* defect, not a missing `if`.

## Root cause: the gate answers "is the repo green?" when the question is "did THIS ticket break anything?"

Both halves are the same defect. The gate is **unscoped**, so:
- to avoid deadlocking on inherited debt, it must tolerate red → **red means nothing**;
- to stay fast on small tickets, it skips the tier → **green means nothing**.

There is no verdict it can emit that is *about the ticket*.

## The subtractive fix (per W5b — do NOT add a third escape hatch)

**Scope the gate to the ticket's diff, or delete the verdict.** Candidate shapes, cheapest first:

1. **Baseline subtraction** (REUSE — this primitive already exists). `convergence-gate.ts` already does
   `assertBaselineFresh` + **baseline subtraction** for the microverse loop: measure the metric at the ticket's
   `start_commit`, and count only *new* failures. A ticket inherits a red tier and is judged on the **delta**.
   Pre-existing failures stop being the worker's problem, and a genuinely-new break still fails closed.
   **This is the fix. It reuses a shipped mechanism and adds no flag.**
2. **Then `small` can stop skipping.** The reason `small` skips `test:fast` is cost. With baseline subtraction, the
   honest cheap option is to run the tier and subtract — or, if that is still too slow, **persist
   `worker_gate_verdict: "not_run"`** instead of `"green"`. A gate that didn't look must not say "green."
   **`"not_run"` is the minimum acceptable fix even if nothing else lands.**

**What NOT to do:** do not add a `skip_worker_gate_reason` flag, and do not fail-closed on raw red (see the deadlock
trap above). Both add resistance around a flaky input instead of fixing the input
([[feedback_subtract_flaky_gate_input_not_add_resistance]]).

## Acceptance criteria

- `AC-WGVI-1`: a `small`-tier ticket that does not run `test:fast` **never** persists `worker_gate_verdict: "green"`.
  It persists `"not_run"` (or runs the tier). Verify: unit test over `runWorkerGateChecks` with `tier='small'`.
- `AC-WGVI-2`: a ticket whose diff introduces **no new** `test:fast` failures gets `green` **even on a repo with
  pre-existing failures** (baseline subtraction against `start_commit`). Verify: fixture repo with one pre-existing
  red test + a clean ticket diff → `green`.
- `AC-WGVI-3`: a ticket whose diff introduces a **new** failure gets `red` and its Done-flip is **refused**.
  Verify: same fixture + a ticket diff that breaks a test → `red`, Done refused.
- `AC-WGVI-4`: the `red` + `Done` combination observed in `c4ee67ff` is **impossible** — a regression test asserts
  no ticket can hold `worker_gate_verdict: "red"` and `status: "Done"` simultaneously.

## Simplification Review (subtract-before-add)

1. **Is the addition necessary at all?** AC-WGVI-1 is a **one-word change** (`"green"` → `"not_run"`) — arguably a
   pure subtraction of a lie. AC-WGVI-2 adds baseline subtraction to the worker gate.
2. **Can it REUSE instead of ADD?** **Yes — and it must.** `convergence-gate.ts` already implements baseline
   subtraction + `assertBaselineFresh` for the microverse loop. Do not write a second one. If its contract does not
   fit, the research phase MUST print both contracts side by side and state the delta (the `prds/CLAUDE.md`
   contract-match rule).
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** Yes. The `small`-tier skip is a
   **performance hack that produces a false green**. The honest subtraction is to stop emitting `green` from a gate
   that did not run — not to add a flag explaining when green means green.
4. **What can this issue SUBTRACT?** The `small`-tier pre-test exit's **false green** (a lie, deleted). Possibly the
   whole tier-conditional gate branch, if baseline subtraction makes the tier cheap enough to always run.

## Risks

- **Fail-closed naïvely and every bundle deadlocks on inherited debt.** See the trap above. Baseline subtraction is
  what makes fail-closed safe.
- **`start_commit` is destroyed by the build** ([[feedback_prelaunch_residual_check_stale_findings]] / the
  Recoverability rule in `prds/CLAUDE.md`). Check whether a **co-stamped** field (e.g. `pinned_sha`) already holds
  the baseline before adding a new one.

## Related

- Surfaced while building [[B-FOMC]]; the vacuous-green is a live instance of the very rule B-FOMC shipped.
- [[R-PLGR]] — the pre-launch check never asks whether the tree is green, which is *why* the bundle inherited red.
- [[project_codex_soak_worker_gate_not_enforced_revert]] — a prior instance of "the worker gate is not enforced →
  Done over red." **This is the same disease with a measured mechanism.**
