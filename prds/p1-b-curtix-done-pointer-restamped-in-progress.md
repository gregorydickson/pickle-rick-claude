# B-CURTIX — the desync reconciler re-stamps a finished (Done/Skipped) `current_ticket` In Progress

**Autonomy root, and the first slice of #5 move 5 ("state from git").** The runner stores the live ticket in
two places: `state.current_ticket` and each ticket's frontmatter `status`. When no ticket is In Progress and
the pointer's own ticket is already finished, the per-iteration desync reconciler writes that ticket back to
`In Progress`, and a manager is spawned against finished work. This repeats every iteration. Run memory:
"Zero-diff Done-flip reverted every tick", SECOND actor. The recorded workaround is manual: move the pointer
in the same turn as the flip.

**User story.** As an operator, or a manager, who finished or skipped a ticket without a completion commit, I
want the next iteration (and `--resume`) to move on to the next pending ticket, without editing
`state.json`. *(refined: requirements c3)*

## Mechanism — measured at HEAD `31e915db`

**Four stages judge the pointer's ticket each iteration, in order** *(refined: codebase c3, risk c3; read at HEAD)*:

1. `correctPhantomDoneTickets` (`mux-runner.ts:15916`): reverts an evidence-less Done → `Todo`. It keeps a
   ticket that has committed evidence, a declared zero-diff close, or an unmeasured probe.
2. `resolvePreTicket` (`:15924`): moves off a Done pointer only when it is `attribution`-committed. This
   refuses zero-diff by construction (`ticket-completion-evidence.ts:1112`).
3. `reconcileTicketStateDesync` (`:15930`): when nothing is In Progress, returns `sync` and re-stamps the
   pointer `In Progress`. **This is the defect.**
4. R-AISLOW preskip (`:16815-16836`): already moves a Done/Skipped pointer to the next pending ticket via
   `readPreskipAdvance` → `findNextPendingTicketId`, emitting `ticket_preskipped_already_terminal`. **It
   never fires for these pointers**, because stage 3 has just rewritten the status to `in progress`.

**The reachable population** is therefore: (a) Done tickets declaring `zero_diff_intent` (watcher keeps,
attribution refuses), (b) Done tickets whose evidence probe was unmeasured, and (c) any `Skipped` pointer (the
watcher only inspects `done`). A plain commit-less Done ticket in a git repo is reverted to `Todo` by stage 1
first, and is NOT this defect.

**Resolver oracle** `resolveTicketDesyncWinner` (exported, `mux-runner.ts:1657`), pointer `aaaa1111`, tickets
`bbbb2222`/`cccc3333` `Todo`, measured at HEAD `31e915db`:

| `aaaa1111` status | HEAD result |
|---|---|
| `Done` | `{"winner":"aaaa1111","action":"sync"}` ← defect |
| `Skipped` | `{"winner":"aaaa1111","action":"sync"}` ← defect |
| `Failed` | `{"winner":"aaaa1111","action":"noop"}` (already correct) |
| all terminal (`aaaa1111` Skipped, `bbbb2222` Done) | `{"winner":"aaaa1111","action":"sync"}` ← defect |

**Liveness consequence (read, not yet executed).** For an all-terminal roster, stage 3 rewrites the pointer
`In Progress`, so `exitOnFinishedRoster` → `applyAllTicketsDoneCompletion` (`:2978`) sees a pending ticket and
returns false, and a manager is spawned on a finished ticket every pass. The epic cannot reach `success`
unattended. *(refined: all three analysts c3)*

**The resume path.** `setup.ts:977` has a character-for-character copy of `chooseInProgressWinner`
(`mux-runner.ts:1609`). Without `--force-ticket-status-sync`, resume writes no status (`applyWinnerStatusSync`
only logs, `setup.ts:986-1013`), and stage 3 re-stamps on the first iteration. With the flag, resume rewrites a
Done/Skipped/Failed pointer `In Progress` itself (`setup.ts:989-990`).

**A documented operator runbook is false because of this.** `extension/src/bin/CLAUDE.md:155-162`
("Heal-via-edit-then-resume") says that after editing a ticket to `Skipped`, `setup.js --resume` "continues to
the next ticket". At HEAD, stage 3 rewrites the Skipped ticket `In Progress`. *(refined: requirements c3)*

## Fix — the reconciler stops overriding; the EXISTING preskip advances

1. **In `resolveTicketDesyncWinner`**: when no ticket is In Progress and `state.current_ticket` names a ticket
   whose frontmatter is terminal (`Done`, `Skipped` via the existing `isTerminalTicketStatus` at `:3250`, or
   `Failed` as today), return `{ winner: <pointer>, action: 'noop' }`. Use `isTerminalTicketStatus`, not a new
   status spelling. This makes `hasManagerHandoffSnapshot` (`:1629`) and the Done branch of
   `shouldSkipDesyncSync` (`:1649`) dead: Done is `noop` with or without a snapshot. **Delete them.**
2. **Preskip then advances the pointer in the same pass**, through its existing `findNextPendingTicketId`.
   No new selection rule.
3. **Preskip resets `step`.** Today it calls `updateMuxLifecycleState(statePath, { currentTicket: nextPending })`
   with no `step`, so the next head's `maxLifecycleStep` keeps the finished ticket's later step (e.g. `review`)
   for the new ticket. Pass `step: inferTicketLifecycleStep(sessionDir, nextPending, 'research')` (`:2535`).
   This latent defect already exists for the Done+handoff path at HEAD; the fix widens its population.
   *(refined: codebase c3)*
4. **`setup.ts` deletes its local `chooseInProgressWinner` and calls the exported `resolveTicketDesyncWinner`**
   over a status `Map`. Build the map with one exported helper `readTicketStatusMap(sessionDir)` in
   `mux-runner.ts`, used by BOTH reconcilers: it replaces the inline loop at `reconcileTicketStateDesync`
   `:1716-1724`. `setup.ts:11` already imports `./mux-runner.js`. **No symbol moves to `pickle-utils.ts`.**
5. **`--force-ticket-status-sync` contract:** the flag forces a PENDING winner to `In Progress`. It never
   resurrects a terminal pointer: Done/Skipped/Failed on resume is `noop`, no write and no event, with or
   without the flag. The sanctioned way to revive a Failed ticket is `/pickle-retry`.

When no ticket is In Progress and nothing is pending, the reconciler returns `noop` and
`applyAllTicketsDoneCompletion` completes the epic on that same pass.

## Files

- `extension/src/bin/mux-runner.ts`: resolver branch, delete `hasManagerHandoffSnapshot` + the Done arm of
  `shouldSkipDesyncSync`, preskip `step`, export `readTicketStatusMap`
- `extension/src/bin/setup.ts`: delete local `chooseInProgressWinner`; the resume reconciler calls the shared resolver
- `extension/src/bin/CLAUDE.md`: `:155-162` heal runbook and force-flag paragraph; R-SRTS-1 clause (`~:166`),
  INVARIANT gains "on a non-terminal winner"; Module Export Catalog row for `readTicketStatusMap`
- `extension/tests/mux-runner-reconcile-refactor-parity.test.js`: its `resolveLegacy` is a hand-copied mirror
  of the OLD rule. Add the new cases as SEPARATE `test(...)` blocks asserting expected values directly; keep
  the existing five parity fixtures passing unchanged.
- `extension/tests/setup-resume-ticket-status-preserved.test.js`: re-fixture AC-SRTS-1 cases onto a `Todo`
  pointer (they currently use a one-ticket Skipped fixture, `:98`, `:137`)
- `extension/tests/aislow-preskip-no-spawn.test.js` or `extension/tests/mux-runner-main-loop-behaviour.test.js`:
  the loop-level test that drives reconcile + preskip together via `driveMuxRunnerMain` (`:16761`)

Do not create a new test file.

## Fixture rule for every loop-level AC

Use a `Skipped` pointer, or a Done ticket declaring `zero_diff_intent: already-satisfied` with
`complexity_tier: medium` and that tier's lifecycle artifacts and no `completion_commit`. **Never** a plain
commit-less Done in a git repo: stage 1 reverts it to `Todo` both before and after the fix. Resolver-level
ACs use a pure `Map` and are immune.

## Acceptance criteria

1. **Resolver.** `resolveTicketDesyncWinner` with the three-ticket `Map` and pointer `aaaa1111`:
   `Done` → `{"winner":"aaaa1111","action":"noop"}`; `Skipped` → `{"winner":"aaaa1111","action":"noop"}`
   (both measured `sync` at HEAD); `Failed` → `noop` (unchanged). Falsifying control: restore `sync` for a
   terminal pointer and this test reds.
2. **Loop, advance.** Session with `aaaa1111` `Skipped` (pointer), `bbbb2222`/`cccc3333` `Todo`,
   `state.step: 'review'`. One `driveMuxRunnerMain` pass: `aaaa1111` still reads `Skipped`;
   `state.current_ticket === 'bbbb2222'`; `state.step === 'research'`; `ticket_preskipped_already_terminal`
   emitted with `gate_payload.next_ticket_id === 'bbbb2222'`; no manager spawned against `aaaa1111`.
   HEAD expectation (measure first in Research): `aaaa1111` rewritten `In Progress`.
3. **Loop, liveness.** All tickets terminal, pointer on a `Skipped` ticket: within two passes the run
   completes via `applyAllTicketsDoneCompletion` with zero manager spawns and no ticket file bytes changed.
   **Measure at HEAD first; if HEAD already completes, drop this AC and record why in the research artifact.**
4. **Resume.** (a) Discriminating: `setup.js --resume --force-ticket-status-sync` on the three-ticket session
   with pointer `aaaa1111` `Skipped` leaves `aaaa1111` `Skipped` (HEAD: rewritten `In Progress`).
   (b) Negative control: without the flag, no ticket file changes (identical at HEAD). (c) AC-SRTS-1 cases on
   a `Todo` pointer still rewrite `Todo → In Progress` under the flag and still emit
   `setup_resume_overrode_ticket_status`.
5. **Unchanged cases (negative controls):** pointer on an In Progress ticket → `noop`; two tickets
   In Progress → the pointer's ticket wins and the other becomes `Todo`; null pointer → no frontmatter write;
   the five existing parity fixtures pass unchanged.
6. **One chooser.** `grep -rn "function chooseInProgressWinner" extension/src | wc -l` returns `1` (HEAD: `2`),
   and `grep -c "resolveTicketDesyncWinner" extension/src/bin/setup.ts` returns at least `1` (HEAD: `0`).
7. `cd extension && ./node_modules/.bin/tsc --noEmit && npx eslint src/ --max-warnings=0` exits 0; the touched
   test files pass under Node 24, and under Node 22 (`/opt/homebrew/opt/node@22/bin/node --test <file>`; CI's
   engine) — record the Node 22 leg UNRUN only if that binary is absent.

## Risks

- **Fixture population.** Loop-level ACs read false-red or fake-green unless the fixture follows the rule above.
- **Preskip becomes load-bearing.** Its existing pins never drive the reconciler with it; AC2 is that
  co-drive and must not be dropped for cost.
- **Iteration cost.** Each preskip `continue` consumes one iteration without a spawn; bounded by ticket count.
  Accepted under the loop doctrine.
- **R-SRTS-1 contract change.** The force flag no longer revives Done/Skipped/Failed pointers.
- **Closer residual (hypothesis).** A Done closer without a handoff snapshot now gets `noop` then preskip.
  `resolveCloserTerminalStep` runs in the head before preskip, so it still sees the original pointer. Research
  must run one loop pass on that fixture and record the pointer and closer state, or keep this as a stated
  hypothesis.

## Simplification Review

- **Necessary?** Yes: an operator must hand-move a pointer to keep a ticket finished, and an all-terminal
  roster cannot complete unattended.
- **Reuse:** the existing preskip and `findNextPendingTicketId` do the advancing; `isTerminalTicketStatus`
  does the classification. No new selection rule, state field, flag, env var, gate leg or exit reason.
- **Subtraction:** −1 duplicate `chooseInProgressWinner`, −`hasManagerHandoffSnapshot`, −1 branch of
  `shouldSkipDesyncSync`, −1 inline status-map loop. The reconciler stops being a second authority over
  terminal pointers.

## Out of scope

Removing `state.current_ticket`; changing the manager prompt; de-duplicating the status normalizers
(`mux-runner.ts:1605`, `:3246`, `setup.ts:964`, `retry-ticket.ts:21`); the unused `findFirstPendingTicket`
export (`:1911`, a later subtraction candidate).

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | 90cec64b | Reconciler returns noop on a terminal current_ticket; preskip advances and resets step; resume shares the resolver | High | HEAD builds | AC1–AC7 green | mux-runner.ts, setup.ts, src/bin/CLAUDE.md, 3 test files |
| 20 | 3bc0ab23 | Harden: code quality review | High | 10 done | 0 P0–P1 | same set |
| 30 | c9d78d84 | Audit: data flow integrity | High | 20 done | 0 CRITICAL/HIGH | same set |
| 40 | 4617ee82 | Harden: test quality review | High | 30 done | every AC mapped | 3 test files |
| 50 | e150b459 | Audit: cross-reference consistency | High | 40 done | 0 CRITICAL/HIGH | src/bin/CLAUDE.md |
