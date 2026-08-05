# BUG REPORT 2026-08-05 — R-EROS: an In-Progress ticket is reported as "all-Failed" and stamped `recovery_exhausted`

**Priority:** P1
**Found:** by the B-OFFREPO build itself, session `2026-08-04-183319b4`, pickle phase, 2026-08-05T04:27:24Z.
**Status:** open, unfixed. Nothing reverted; tree clean at diagnosis time.

---

## What happened

The pickle phase ended at **3/4 tickets Done** with the fourth left `In Progress`, and stamped
`exit_reason: recovery_exhausted` — a recovery-ladder terminal that is a member of `isFailureExit`
(so `auto-resume.sh` stops on it).

Verbatim from `mux-runner.log`, four consecutive lines:

```
04:27:23.908Z Phantom-Done watcher kept ticket ada5c584 Done — valid completion_commit evidence
04:27:23.947Z Phantom-Done watcher kept ticket 0454370b Done — valid completion_commit evidence
04:27:23.979Z Phantom-Done watcher kept ticket 8d44f715 Done — valid completion_commit evidence
04:27:24.081Z empty roster (all-Failed, no runnable ticket) — honest terminal recovery_exhausted before runIteration.
```

**The roster contained zero Failed tickets.** Three were Done with verified completion evidence — the
runtime said so itself, 173 milliseconds earlier. The fourth, `69cdb73b`, was `In Progress` and carried
`completion_commit: 1434c446…`, a full lifecycle artifact set, and `worker_gate_verdict: green`.

## Root cause — the predicate proves less than the call site claims

`extension/src/bin/mux-runner.ts:1245`:

```ts
export function noRunnableTicketsRemain(sessionDir: string): boolean {
  const tickets = collectTickets(sessionDir);
  if (tickets.length === 0) return false;
  return findNextPendingTicketId(sessionDir) === null;
}
```

It establishes exactly one fact: **no ticket is PENDING.** It says nothing about Failed.

The call site (`:9903`) infers a much stronger state, and its comment states the inference explicitly:

```ts
if (!preTicket && noRunnableTicketsRemain(sessionDir)) {
  // W4b empty-roster resolution: all-Done already exited above via
  // applyAllTicketsDoneCompletion (→ completion). Reaching here means the
  // roster is all-Failed with no runnable Todo — the honest ladder terminal
  // `recovery_exhausted` …
  log('empty roster (all-Failed, no runnable ticket) — honest terminal recovery_exhausted before runIteration.');
```

The reasoning is *"all-Done exited earlier, therefore what remains is all-Failed."* That disjunction is
incomplete. **`In Progress` is neither Done nor pending**, so a roster of 3 Done + 1 In Progress
satisfies `noRunnableTicketsRemain`, fails the all-Done exit, and falls into the all-Failed branch —
which is false.

## The stranding, which is the real defect underneath

Ticket `69cdb73b` is **neither runnable nor terminal**:

- not pending → `findNextPendingTicketId` will never re-select it,
- not Done/Failed/Skipped → no terminal path claims it,
- but it holds a `completion_commit` and fresh artifacts, so work exists.

The runner cannot finish it and cannot re-enter it. The phase's only remaining move is to declare the
roster spent. **The stranding is the failure; `recovery_exhausted` is the misdescription of it.**

This is the same shape as [[R-ACNP]] (a ticket stamped Skipped, and Skipped is terminal, so
`isPendingMuxTicket` never re-selects it) — a ticket parked in a status the selector cannot reach.
There, the terminal status was the trap; here, the *non*-terminal status is.

## Second finding — the gate failure payload is content-free

All three `worker_gate_failed` events in this session carry the same evidence:

```json
{"gate_phase": "test:fast",
 "failures": [{"name": "npm run test:fast", "file": "",
               "message": "> pickle-rick-scripts@2.1.0-beta.7 pretest:fast"}]}
```

`> pickle-rick-scripts@2.1.0-beta.7 pretest:fast` is **npm's banner line** — the first line of stdout,
not the failure. No test name, no file, no assertion. A verdict of `red` is recorded with evidence that
cannot identify what went red, so no downstream consumer or operator can act on it, and nobody can tell
a real red from a harness stumble. This is [[R-WGVI]] ("the worker gate verdict carries no information
about the ticket") recurring in the *failure payload* rather than the verdict.

Note the interaction: `failed_flip_suppressed` correctly refused to flip these tickets Failed on
`fresh_artifacts` evidence — so the honest-work protection worked. But the red it suppressed was itself
uninterpretable.

## What was NOT wrong

- **The pipeline did not halt.** `Phase pickle exited with code 1 (non-fatal) — continuing to citadel`,
  and citadel later logged `remediation cap (3) exhausted with 17 finding(s) still open — continuing
  pipeline (no halt)`. All four phases ran; 489m; 23 commits; clean tree.
  [[B-NOSTOP-GATES]] behaved exactly as shipped.
- **No work was lost.** Three tickets Done with verified completion commits; the stranded ticket's work
  is committed at `1434c446`.

## Candidate fix — subtractive

Per directive 4 (stop adding oracle cases) the fix is **not** a new "in-progress" branch in the ladder.
Two options, in preference order:

1. **Make the message and the reason match the predicate.** `noRunnableTicketsRemain` proves
   "no pending ticket" — say that, and stamp a reason that means it. `recovery_exhausted` asserts the
   recovery ladder was exhausted, which never happened here: the `recovery_attempts` ledger holds two
   `failed_flip_suppressed` entries at **1/2**, and zero silent-death respawns. Stamping a
   recovery-class terminal for a non-recovery condition mis-routes `auto-resume.sh`.
2. **Close the stranding at its source** — an In-Progress ticket with completion evidence should be
   reconciled by the existing evidence oracle (`evaluateCompletionEvidence` /
   `reconcileTicketTruth`) before the roster is judged, not left in a status no selector can reach.
   REUSE those; do not add a third disposition.

**Do NOT** make the roster check fail-closed or halt earlier — the non-halting behaviour above is
correct and must be preserved.

## Reproduction

Any bundle where a ticket ends a phase `In Progress` with all others Done. Observed here on the
B-OFFREPO build, which is the first bundle to leave a ticket in that state since
[[B-NOSTOP-GATES]] shipped.
