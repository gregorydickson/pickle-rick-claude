> **✅ ALREADY SHIPPED — verified 2026-08-23 by the mandatory stale-premise check, NOT drainable.**
> The scrub this PRD asks for exists AND is applied. `PICKLE_GATE_SCRUBBED_ENV_KEYS`
> (`services/pickle-utils.ts:182`) covers every variable named here — `PICKLE_TICKET_ID_ENV_VAR`,
> `GIT_CONFIG_COUNT_ENV_VAR`, `GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM` — plus the indexed pairs via
> `GIT_CONFIG_INDEXED_ENV_KEY_RE = /^GIT_CONFIG_(KEY|VALUE)_\d+$/`.
>
> Crucially it is USED, not merely defined: `env: scrubGateEnv()` at **`spawn-morty.ts:1328`** and
> **`mux-runner.ts:750`** — both worker-gate spawn sites. A list that existed but was never referenced
> would have looked identical to a fix under a naive grep; checking the call site is what settles it.
>
> This also satisfies the PRD's own AC-3 ("reuse the existing gate-env scrub list; do not add a second
> mechanism") — it was already satisfied when the PRD was authored.
>
> **Corroborating field evidence:** session `2026-08-22-5c53a293` recorded only
> `post_final_tier_degraded:red` with NO `done_over_red_worker_gate_tests`, against six such entries in
> `2026-08-20-54c74299`. Consistent with the false-red mechanism being closed.

# BUG-2026-08-21 (P1) — worker env stamps test-fixture commits, producing FALSE worker-gate reds

## Status
Open. Observed live in session `2026-08-20-54c74299`; it drove **6 of 7 tickets** to
`done_over_red_worker_gate_tests`. The work was sound; the gate was wrong.

## What happens
Every worker/manager subprocess runs with these exported (`backend-spawn.ts`, `git-trailer-hooks.ts`):

```
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=core.hooksPath
GIT_CONFIG_VALUE_0=<session_dir>/git-trailer-hooks
PICKLE_TICKET_ID=<current ticket id>
```

That hooks path stamps `Pickle-Ticket: $PICKLE_TICKET_ID` into **any** commit created in that
environment — **including commits made by test fixtures**. A suite that builds its own fixture repo
and asserts a specific trailer value then fails with `actual: ['<live ticket id>']` /
`expected: ['<fixture id>']`.

Measured: `tests/spawn-morty-commit-attribution.test.js` → `fail 2` unscrubbed, `fail 0` scrubbed.
`tests/worker-timeout-preserves-commit.test.js` → `fail 2` unscrubbed, `pass 5` scrubbed. The
ticket's own diff (a newline normalization) cannot substitute one ticket id for another.

Scrub that proves it:
```
env -u PICKLE_TICKET_ID -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 \
    -u GIT_CONFIG_KEY_1 -u GIT_CONFIG_VALUE_1 node --test <suite>
```

## Impact
The worker gate reds on sound work, the Done-flip is suppressed, and the suppression budget is
consumed by a phantom. In this session it fired 7 times across 6 tickets and exhausted `91f5ff2b`'s
budget (2/2). Two consequences: real gate reds become indistinguishable from contamination, and a
bundle can exhaust its recovery budget without a single genuine defect.

**The diagnostic tell is a WRONG TICKET ID in the assertion diff** — no code change can produce that;
only the ambient hook can.

## Acceptance criteria
- **AC-1** The worker gate's test invocation does not inherit `PICKLE_TICKET_ID` /
  `GIT_CONFIG_*` — the gate runs the suites in a scrubbed environment.
- **AC-2** A suite that creates a fixture repo and asserts a trailer value passes identically inside
  and outside a worker session. Pin with a test.
- **AC-3** Scrubbing is applied at ONE seam (the gate's spawn env), not per-suite in test code.
  Existing env-scrub machinery is REUSED — `gate-env-scrub.test.js` and the `PICKLE_DATA_ROOT`/
  `PICKLE_DATA_DIR`/`TMUX` scrub list (`87b402b6`) already exist; extend that list, do not add a
  second mechanism.
- **AC-4** No new halt path; a contaminated read degrades to a re-run, never to a bundle failure.
- **AC-5** The trailer hooks still function for the worker's OWN commits — this must not disable
  attribution, only stop it leaking into fixture repos.

## Non-goals
Removing the trailer-hooks mechanism. Changing `PICKLE_TICKET_ID` semantics for real worker commits.

## Simplification Review
1. **Necessary?** Extend an existing scrub list — no new mechanism.
2. **Reuse?** Yes, AC-3 requires it: the gate-env scrub list already exists.
3. **Guards brittle complexity?** It removes a brittle coupling (ambient env reaching fixture repos).
4. **Subtracts?** A whole class of false reds, and the suppression-budget burn they cause.

## Related
Memory `ambient-git-config-false-gate-reds` (written by a worker in this session).
