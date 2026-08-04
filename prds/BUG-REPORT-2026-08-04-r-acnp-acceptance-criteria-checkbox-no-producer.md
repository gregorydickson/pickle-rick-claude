# BUG REPORT — R-ACNP: the acceptance-criteria checkbox gate is a consumer with no producer

**Priority:** P3 (MEDIUM, capture-only). No data loss, no bad commits, and — importantly — **no halt**:
the live bundle ran to `exit_reason: completed`. This is directive-2-compliant behaviour (park the item,
flag it, continue). What it costs is a *terminal mislabel* plus a diagnostically worthless reason string.
See *Escalation condition* for the shape that makes this P2.

**Code:** R-ACNP (Acceptance-Criteria No Producer).
**Backend:** both (claude-observed; nothing backend-specific in the predicate).

**Source anchor:** verified 2026-08-04 against `release/v2.1-beta`.
`hasCheckedAcceptanceCriteria` — `extension/src/bin/mux-runner.ts:2450`.
Its sole call site — `extension/src/bin/mux-runner.ts:2840`, inside `validateAutoTicketCompletion`.
Checkbox parser — `:2432` (`acceptanceCriteriaCheckboxes`), section slicer — `:2417`.
Worker AC-ownership prompt — `extension/src/bin/spawn-morty.ts:1114`.
Worker completion contract — `.claude/commands/send-to-morty.md:110`.

**Build-safety note.** This finding is about a *predicate on the auto-completion path*. Any fix touches
`validateAutoTicketCompletion` / `mux-runner.ts` completion logic, which **is** the salvage /
completion-evidence / Done-flip path — so a fix bundle is the narrow **R-PSRB hand-build exception**, not
a dogfood candidate. Do not `/pickle-pipeline` a fix for this.

---

## The defect

`hasCheckedAcceptanceCriteria` reads `- [x]` / `- [ ]` checkboxes out of a ticket's
`## Acceptance Criteria` section and requires every non-`[manager]` box to be checked:

```ts
function hasCheckedAcceptanceCriteria(content: string): boolean {
  const boxes = acceptanceCriteriaCheckboxes(content);
  if (boxes.length === 0) return false;
  return boxes
    .filter((box) => box.owner !== 'manager')
    .every((box) => box.checked);
}
```

**Nothing ever ticks those boxes.** `grep -rn "acceptanceCriteriaCheckboxes\|hasCheckedAcceptanceCriteria"
extension/src/` returns exactly two hits — the definition and the one consumer. No runtime path writes
`[x]` into a ticket's Acceptance Criteria section, and no prompt instructs the worker to:

- `spawn-morty.ts:1114` tells the worker about AC **ownership** (`[worker]`/untagged are worker-owned,
  `[manager]` items are deferred handoff work that must be listed under a `Manager Handoff` section). It
  never says to tick the box.
- `send-to-morty.md:110` says work "must **pass** acceptance criteria before you mark the ticket Done" —
  pass, not tick.

So the predicate's input is a field with no producer. The consequence is that
`validateAutoTicketCompletion`'s `{ action: 'done' }` return is, in practice, unreachable: the function
can `leave` or `skip`, but it cannot auto-complete. **It is a one-way valve.**

### The one shape that *can* auto-complete is the inverse of the one you'd want

`[].every(...)` is `true`, so a ticket whose acceptance criteria are **entirely** `[manager]`-tagged
passes the predicate (non-empty `boxes`, empty post-filter array). A ticket with zero worker-owned
criteria auto-completes; a ticket whose worker criteria are all genuinely satisfied does not.

---

## Live evidence — session `2026-08-03-2d5b3820` (LOA-2190, 15 tickets, `loanlight-api` worktree)

Ran to completion: `exit_reason: completed`, 38 iterations, 33 commits, 14 Done / 1 Skipped.

**Every ticket in the bundle has zero ticked boxes — 90 checkboxes, 0 checked:**

```
ticket    status    boxes  checked  unchecked
1029cede  Done      6      0        6
1bc5ea84  Done      7      0        7
372eddc7  Done      6      0        6
57b7433e  Done      6      0        6
58054d0c  Done      6      0        6
653b7502  Done      7      0        7
7be5124c  Done      6      0        6
987d2e4e  Done      8      0        8
98a6633f  Done      6      0        6
bcb7ae5d  Done      6      0        6
c721f502  Skipped   6      0        6
d54239c7  Done      6      0        6
ef122996  Done      6      0        6
f18abd36  Done      6      0        6
fa7f498a  Done      7      0        7
```

Fourteen tickets shipped `Done` on identical checkbox evidence to the one that was Skipped. They reached
Done through the *explicit* path — worker/manager flips `status: Done` with a `completion_commit`, gated
by `guardCompletionCommitBeforeDone` — which never consults `hasCheckedAcceptanceCriteria`.

`c721f502` was the only ticket nobody flipped Done (correctly — its remaining criteria needed a live paid
Reducto run the worker is prohibited from executing). It therefore fell to the safety net, which logged:

```
[2026-08-04T03:53:46.575Z] Marked ticket c721f502 as Skipped (acceptance_criteria_not_checked)
```

### Why the reason string is the actual harm

`acceptance_criteria_not_checked` is **true of all fifteen tickets**. It does not distinguish the ticket
that legitimately could not complete from the fourteen that shipped. An operator triaging that log line
is pointed at the checkboxes — which are irrelevant — instead of at the real cause, which is recorded
correctly one directory over in `c721f502/conformance_2026-08-03.md`:

```
## Manager Handoff
The following `[manager]`-owned acceptance criteria remain, all requiring the live paid run
this worker is prohibited from executing: …
```

The worker behaved **well** here: it completed both worker-owned deliverables, verified them (including
running the literal `rg` command from its own `[worker]` AC and reporting the expected result), wrote
`ALL_PASS (worker-owned criteria)`, and explicitly refused to fabricate the paid-run numbers — the
baseline doc ships `PENDING PAID RUN` placeholders and its notes record *"No number was invented."* The
gate then labelled that ticket with a reason that describes none of it.

---

## Why this is a subtraction, not another oracle case

Per **OPERATOR DIRECTIVE 4** ("Stop the fix-treadmill… STOP adding oracle cases"), the wrong fix is to
teach the predicate about paid runs, or to add a producer that ticks boxes, or to add a
`skip_ac_checkbox_reason` flag. All three make the completion oracle smarter, which is the treadmill.

The candidate subtraction: **delete `hasCheckedAcceptanceCriteria` and its call site.** Justification —
it is inert on the path that ships work (14/14 Done despite 0 ticked boxes), its `done` arm is
unreachable, and its only reachable effect is to attach a misleading terminal reason. The AC-satisfaction
question is already owned by evidence that *does* have producers: `worker_gate_verdict` (R-CWGE),
`completion_commit` attribution (R-CCQF / B-GITATTR trailer), and the conformance artifact's
`## Manager Handoff` block (`hasSubstantiveManagerHandoff`, `mux-runner.ts:4873`).

Note the adjacent mechanism that *is* well-formed and did not fire here: `evaluateCloserTerminalState`
(`:4936`) raises `manager_handoff_pending` when a ticket is **Done** *and* its conformance carries a
substantive Manager Handoff section. `c721f502` had the Manager Handoff section but was never Done, so
that path was unreachable. If a replacement disposition is wanted for "worker-complete, manager residual
outstanding", that predicate — not the checkboxes — is where it belongs.

---

## Escalation condition (what makes this P2)

A ticket whose implementation fully landed and committed, but whose Done-flip the manager missed, falls
to `validateAutoTicketCompletion`. Because the `done` arm is unreachable, that ticket is stamped
**Skipped** — and `Skipped` is terminal (`isTerminalTicketStatus`, `:2412`), so `isPendingMuxTicket`
(`:1063`) will never re-select it. Real, committed, green work would be permanently marked as skipped
with a reason that does not describe it.

**Not observed in this session** — `c721f502`'s work genuinely was incomplete. Filed as the escalation
trigger, not as a confirmed occurrence. Confirming it needs a session where the explicit Done-flip is
missed on a ticket whose commit landed.

## Reproduction

1. Author a ticket with at least one `[worker]` or untagged acceptance criterion.
2. Let a worker complete it without editing the `## Acceptance Criteria` checkboxes (the default — no
   prompt instructs otherwise).
3. Ensure nothing flips the ticket `Done` explicitly, so `validateAutoTicketCompletion` runs.
4. Observe `Marked ticket <id> as Skipped (acceptance_criteria_not_checked)` regardless of whether the
   worker-owned criteria are actually satisfied.

## Workaround

None needed for throughput — the pipeline does not halt. For triage, ignore the
`acceptance_criteria_not_checked` reason entirely and read the ticket's `conformance_*.md`
`## Manager Handoff` section, which carries the real disposition.
