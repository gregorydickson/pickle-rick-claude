> **✅ ALREADY SHIPPED — verified 2026-08-24 by the mandatory stale-premise check, NOT drainable.**
> Fixed by **`cf040295`** *"fix(aafc633a): release failed_flip_suppressed hold at the shared
> exit-commit salvage seam"* (2026-08-23), which is an ancestor of HEAD. It landed AFTER this PRD's
> 3-cycle refinement (session `2026-08-22-5c53a293`, measured at HEAD `6a14d389`) and before the P0
> MCP bundle, so the PRD went stale between refinement and dispatch.
>
> **The mechanism is gone, checked in BOTH trees — not merely the R-code.** This PRD's root cause is
> the inert `resetTodo` stub at the exit-commit seam. It is no longer a stub:
>
> ```ts
> resetTodo: (i) => {
>   updateTicketFrontmatter(i.ticketId, i.sessionDir, { status: 'Todo', completion_commit: null });
> },
> ```
> (`extension/src/bin/mux-runner.ts:6481`; deployed `~/.claude/pickle-rick/extension/bin/mux-runner.js:5502`)
>
> The surrounding comment states this PRD's own refined finding back verbatim — *"this is the ONLY
> automatic Todo writer reachable from a `failed_flip_suppressed` hold … Stubbing this out strands a
> held-but-runnable ticket forever."* `archive: () => null` is deliberately RETAINED for behavior
> parity (never discard the dirty tree at this seam), which this PRD also identified as correct.
>
> **The latch chain is broken end to end:** `resetTodo` writes `Todo` → `readActiveFailedFlipHolds`
> (`:9774`) releases any hold whose status normalizes to `todo` → `resolvePreTicket` returns the
> ticket → `noRunnableTicketsRemain` is false → the L5 `empty_roster_all_failed_no_runnable` terminal
> does not fire. That is exactly the roster experiment this PRD's refinement ran, now passing.
>
> **The plural-surface concern still holds structurally and is satisfied:** `routeExitPathSalvage`
> still has 3 call sites (`:11491`, `:11584`, `:11660`) and `noRunnableTicketsRemain` still has 2
> consumers (`:9063`, `:11180`) — but all three call sites now share the ONE fixed dep set built
> inside `routeExitPathSalvage` itself, so there is no per-call-site stub left to latch.
>
> Note for future checks: the line numbers in this PRD are all stale (the P0 MCP bundle's
> anatomy-park phase made 14 commits touching `mux-runner.ts`). Checking the MECHANISM rather than the
> cited `file:line` is what settled this.

# BUG-2026-08-14 (P1) — salvage reports `reset Todo`, leaves the ticket `In Progress`, then terminates on `empty_roster_all_failed_no_runnable`

*(refined: requirements / codebase / risk-scope analysts, 3 cycles, session `2026-08-22-5c53a293`)*

## Status

Open. Branch `release/v2.1-beta`, HEAD `6a14d389`. **Scope is HALF what the authored PRD claims** — see
"Already satisfied" below.

## Root cause — ONE defect, not two, proven by execution

*(refined: codebase built the incident roster against the COMPILED runtime `extension/bin/mux-runner.js`
and ran it)*

The authored PRD names two independent root causes. Measured, they are one:

```
roster: a single In Progress ticket carrying a failed_flip_suppressed hold
  -> resolvePreTicket → null,  noRunnableTicketsRemain → true,  L5 terminal FIRES
identical roster WITHOUT the hold
  -> resolvePreTicket → "ff123456",                            terminal does NOT fire
```

**The only automatic `status: Todo` writer in the entire salvage runtime is the default `resetTodo`**
(`lib/salvage-ticket.ts:115-116`, `updateTicketFrontmatter(... { status: 'Todo' ... })`). That is
precisely the dependency the exit-commit seam stubs out:

```js
// extension/src/bin/mux-runner.ts:6459-6460
archive: () => null,
resetTodo: () => { /* exit-commit seam never resets here — parity with legacy */ },
```

**The disabled reset is what latches the hold.** The "two independent root causes" collapse to one.

That same run also **empirically proved AC-2 vacuous** and eliminated the "unparseable ticket"
mechanism that two analysts had independently filed as a P0 in cycle 2.

## The fix surface is PLURAL — every authored AC is written in the singular

*(refined: requirements, verified at HEAD)*

| symbol | sites | note |
|---|---|---|
| `routeExitPathSalvage` | **3** — `mux-runner.ts:11351` (R-MWIS-3 self-recovery), `:11444` (CPU-liveness watchdog), `:11520` (end-of-iteration exit-commit — the incident) | all three share the **single inert dep set** at `:6459-6460` |
| `noRunnableTicketsRemain` | **2** consumers — `:11040` and `:9003` (inside `advanceOrExitOnLadderExhaustion`) | only ONE writes the handoff artifact every proposed AC pins |

Fixing the seam at one call site leaves the other two latching. Any AC written in the singular
under-specifies the fix and will pass while the bug survives.

## 🚨 Already satisfied — do NOT rebuild (scope inflation drives mis-tiering and fake-green)

*(refined: risk-scope)*

- **AC-2** — green on arrival; proven vacuous by the roster experiment above.
- **AC-3 and AC-6** — both already enforced by `tests/ac6-operator-surface-guard.test.js`, which shipped
  in **v2.1.0-beta.11**.

The authored PRD presents six work items where **two** exist. Building the other four would produce
green checkmarks over code that already had them.

## ⚠️ Two authored ACs are satisfiable WITHOUT fixing anything

*(refined: requirements — retracting its own cycle-2 ACs)*

AC-7's *"reaches a selectable state"* and AC-9's *"flips to a terminal status"* are both satisfied by a
**`Failed`** flip, which:
- does **NOT** release the hold — release requires exactly `todo` (`mux-runner.ts:9713`), and
- leaves the ticket **still selectable**, because `isPendingMuxTicket` (`:1449`) admits `Failed`.

Any replacement AC must assert the frontmatter status is exactly `todo`, never "terminal" or
"selectable".

## ⚠️ `recovery_exhausted` is NOT a bug — do not "fix" it

*(refined: risk-scope)* The authored PRD assumes `recovery_exhausted` is an unwanted terminal. The code
says it is the **designed CUJ-1 handoff**, hard-gated at `bin/pickle-recover.ts:40`. It is the
operator's only sanctioned escape hatch **from the very terminal this PRD is about**. Removing or
weakening it would delete the recovery path while claiming to fix recovery.

## Acceptance criteria

- **AC-1** For **every** `routeExitPathSalvage` call site (`:11351`, `:11444`, `:11520`), a ticket whose
  salvage reports `reset Todo` has frontmatter status **exactly `todo`** afterwards. Assert the literal
  status string, not "terminal" and not "selectable".
- **AC-2** For **every** `noRunnableTicketsRemain` consumer (`:11040`, `:9003`), a roster whose only
  `In Progress` ticket carried a now-released hold does NOT reach
  `empty_roster_all_failed_no_runnable`. Reproduce with the executed roster shape above.
- **AC-3** The hold-release path is exercised at the **shared dep set** (`:6459-6460`), not patched per
  call site — one seam, three callers.
- **AC-4** `recovery_exhausted` and the `pickle-recover.ts:40` gate are **unchanged**. A test pins that
  the CUJ-1 handoff still fires and is still reachable.
- **AC-5** No new `exit_reason`, no new abort condition, no new halt path (PRIME DIRECTIVE). The
  authored PRD's own AC-3 already forbade a new `exit_reason`; that constraint stands.
- **AC-6 (report-only, non-gating)** Tiers do not regress: `cancelled 0`, and the only failures are the
  two filed inherited ones (`install-bun-probe`, `extension-wiring` deploy smoke).

## Verification Strategy

Node 24 + pnpm on PATH; censused idle box recording load average **and top CPU consumers by name**.

```bash
cd extension
node --test tests/salvage-ticket-matrix.test.js tests/start-commit-salvage-guards.test.js
node bin/test-runner.js --tier fast --test-concurrency=8
npm run test:integration:parallel && npm run test:integration:serial
npx tsc --noEmit && npx eslint src/ --max-warnings=-1
```

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-1 | `tests/salvage-ticket-matrix.test.js` | each of the 3 call sites after a `reset Todo` salvage | frontmatter status is exactly `todo` |
| AC-2 | new | incident roster: lone In Progress + released hold | terminal does NOT fire, at both consumers |
| AC-3 | new | the shared dep set releases the hold | one seam covers all three callers |
| AC-4 | `tests/recovery-exhausted-terminal.test.js` | CUJ-1 handoff intact | `pickle-recover.ts:40` gate still fires |

## Non-goals

- Rebuilding AC-2/AC-3/AC-6 from the authored PRD — already satisfied (see above).
- Touching `recovery_exhausted` or the `pickle-recover` gate beyond pinning them.
- Any new `exit_reason`.

## Execution posture

**ATTENDED-EQUIVALENT CAUTION, run UNATTENDED.** This edits `lib/salvage-ticket.ts` — the single choke
point for **every** fail / cancel / timeout / exit seam AND for `pickle-recover`, the operator's only
escape hatch from this terminal. `src/lib/CLAUDE.md` records a **prior recurrence of this exact bug
class in this exact file**. The deployed runtime is `2.1.0-beta.11` and content-identical to source, so
the R-PSRB catch-22 does not apply — but a regression here removes the recovery path itself. Every
change must keep the `recover` arm demonstrably reachable (AC-4).

## Simplification Review

1. **Necessary?** The fix is to stop stubbing out an existing writer — a **subtraction of a no-op**, not
   new machinery.
2. **Reuse?** `resetTodo` already exists and already does the right thing (`salvage-ticket.ts:115-116`).
   The bug is that one seam replaces it with `() => {}`. Reuse the default; do not write a second
   reset path.
3. **Guards brittle complexity?** It removes a divergence — a seam whose comment says *"parity with
   legacy"* while producing a latch the other seams do not have.
4. **Subtracts?** One stubbed dependency, one latched hold, and four AC work items that do not exist.
