# B-CURTIX — a Done `current_ticket` is re-stamped In Progress by the desync reconciler

**Autonomy root, and the first slice of #5 move 5 ("state from git").** The runner stores the live ticket in
two places: `state.current_ticket` and each ticket's frontmatter `status`. When they disagree, the
ticket-state desync reconciler picks a winner. When NO ticket is In Progress, the winner falls back to the
stored pointer, **even when that ticket's own frontmatter says `Done`**. The reconciler then writes it back
to `In Progress`. A ticket that finished stays unfinished on every relaunch, however many times it is
re-flipped. Run memory: "Zero-diff Done-flip reverted every tick", SECOND actor. The recorded workaround is
manual: move the pointer in the same turn as the flip.

## Mechanism — measured at HEAD `a18958a2`

The exported oracle `resolveTicketDesyncWinner` (`extension/src/bin/mux-runner.ts`) against a temp
session with tickets `aaaa1111` (order 10, `Done`), `bbbb2222` (20, `Todo`), `cccc3333` (30, `Todo`) and
`state.current_ticket = aaaa1111`:

```
{"winner":"aaaa1111","action":"sync"}      // action sync == write In Progress onto a Done ticket
```

The fallback is in `chooseInProgressWinner`:

```
if (currentTicket && inProgress.some(t => t.id === currentTicket)) return currentTicket;
return inProgress.find(t => !!t.id)?.id ?? currentTicket;   // <- stale pointer, status never consulted
```

**The function exists TWICE, word for word:** `extension/src/bin/mux-runner.ts:1609` (per-iteration
reconciler `reconcileTicketStateDesync`) and `extension/src/bin/setup.ts:977` (resume reconciler
`reconcileTicketStateDesyncOnResume`). Both carry the defect.

## Census — why this is a slice, not a removal of `current_ticket`

`current_ticket` has **310** references across **20** source files and **238** test files. The manager
prompt writes it (`update-state.js current_ticket <ID>`), and the per-ticket budget caches key on it.
Deleting the field is a different, much larger bundle. This bundle removes the **disagreement**: the pointer
may still exist, but it can no longer override a terminal frontmatter status.

## Fix — collapse, then use the one existing rule

1. **One chooser.** Replace both copies of `chooseInProgressWinner` with a single shared implementation.
   Put it in a service module both callers already import (e.g. `extension/src/services/pickle-utils.ts`,
   home of `collectTickets`/`TicketInfo`), not in `mux-runner.ts` — `setup.ts` must not import the runner.
2. **The fallback asks the frontmatter.** When no ticket is In Progress, the winner is the stored pointer
   ONLY if that ticket is still pending. Otherwise it is the next pending ticket under the SAME rule the
   runner already uses to pick work (`findNextPendingTicketId` in `mux-runner.ts`: `collectTickets` order,
   `isPendingMuxTicket`, excluding terminal no-progress Failed flips and active failed-flip holds). Move
   that rule next to the chooser so both reconcilers share it. **Do not write a new selection rule.**
3. **No pending ticket left → winner `null`**, and both reconcilers already treat `null` as no write.
4. **Leave `shouldSkipDesyncSync` alone, and evaluate it BEFORE the new fallback.** Current ticket
   `Failed` → noop, and `Done` with a manager-handoff snapshot → noop, **with `winner` still equal to the
   stored pointer**. The existing fixture `done-with-manager-handoff` in
   `tests/mux-runner-reconcile-refactor-parity.test.js` pins `expectedWinner: 'ticket-done'`, and the closer
   handoff relies on it (`docs/closer-ticket-manager-handoff.md`). The new fallback applies only on the
   `sync` path.

When the winner changes, the pointer moves (both reconcilers already write `current_ticket = winner` and
clear the per-ticket cache fields). That is the manual workaround, done by the runtime.

## Files

- `extension/src/services/pickle-utils.ts` (or the shared service chosen in step 1)
- `extension/src/bin/mux-runner.ts`
- `extension/src/bin/setup.ts`
- `extension/tests/mux-runner-reconcile-refactor-parity.test.js`: the only test covering
  `resolveTicketDesyncWinner`. **Its `resolveLegacy` function is a hand-copied mirror of the OLD rule**,
  including the `?? currentTicket` fallback. A Done-without-handoff fixture added to that parity loop would
  compare the fixed resolver against the defect. Add the AC1/AC2 cases as SEPARATE `test(...)` blocks that
  assert the expected winner directly; leave the existing parity fixtures passing unchanged.
- `extension/tests/mux-runner.test.js` (`desync.event` at ~:3121) and `extension/tests/setup*.test.js`
  for the resume path (AC4). Do not create a new test file.

## Acceptance criteria

Each predicate was run at HEAD `a18958a2` and fails there.

1. **The oracle.** For the three-ticket session above, `resolveTicketDesyncWinner` returns
   `{"winner":"bbbb2222","action":"sync"}` (measured at HEAD: `{"winner":"aaaa1111","action":"sync"}`).
   Add this as a test case in the existing desync test file.
2. **All tickets terminal.** Same session with every ticket `Done` or `Skipped` and the pointer on a `Done`
   ticket → no ticket frontmatter is written and `current_ticket` is not set to a Done ticket's id.
3. **Unchanged cases (negative controls, must still pass as before):** pointer on a ticket that IS
   In Progress → `noop`; current ticket `Failed` → `noop`; `Done` + manager-handoff snapshot → `noop`;
   two tickets In Progress → the pointer's ticket wins and the other is set to `Todo`.
4. **The resume path gets the same answer.** A test drives `setup.js --resume` (or the resume reconciler
   through its existing test seam) on the three-ticket session and asserts `current_ticket` becomes
   `bbbb2222` and `aaaa1111` stays `Done`.
5. **One copy.** `grep -rn "function chooseInProgressWinner" extension/src | wc -l` → `1`
   (measured at HEAD: `2`).
6. `cd extension && ./node_modules/.bin/tsc --noEmit && npx eslint src/ --max-warnings=0` exits 0, and the
   touched test files pass under BOTH Node 22 (CI's engine) and Node 24.

**Falsifying control for AC1:** restore the `?? currentTicket` fallback and AC1 must fail.

## Simplification Review

- **Necessary?** Yes: the runtime currently needs an operator to move a pointer by hand to keep a
  ticket Done, and the prime directive's first measure is completing hands-off.
- **Subtraction:** −1 duplicate function, −1 divergent fallback rule. No new state, flag, env var, gate leg,
  exit reason or classifier.

## Out of scope

Removing `state.current_ticket`, changing the manager prompt, or the per-ticket budget caches.
