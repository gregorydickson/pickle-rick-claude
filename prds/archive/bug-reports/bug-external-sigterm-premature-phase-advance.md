# Bug: external SIGTERM to the pickle phase makes pipeline-runner advance through citadel+anatomy on a partially-built bundle

**Filed**: 2026-06-12 (babysitter intervention #10, session 2026-06-10-f50e5c11, v2.0.0-beta.1 bundle)
**Severity**: P1 — a single stray signal silently abandons unbuilt tickets AND runs review phases against an incomplete bundle; recurring (2nd occurrence in 2.5h)
**Status**: Open

## Incident (2nd external-SIGTERM event; 1st = B-XCOF at 23:42Z)

At 01:58:13Z the mux received `Received SIGTERM — deactivating session` (no operator command issued — same unexplained external-signal source as B-XCOF). The mux exited; pipeline-runner read `Phase pickle exited with code 0` and — because exit-0 is indistinguishable from "all tickets Done" — advanced:
`PHASE 2/4 CITADEL` (ran, 258-finding report) → `PHASE 3/4 ANATOMY-PARK` (discovered subsystems, began review).

But the build was only **16/25** (15 Done + C6 in-flight): tickets C7, C9, C10, **R1 (the release itself)**, wiring, and all 4 review tickets were still Todo. So citadel + anatomy-park ran against a 60%-built bundle, and the run would have "completed" the pipeline without ever building the release or the review hammers.

Compounding: the anatomy-park/microverse runner found C6's uncommitted dirty tree, auto-committed it as `fcac8752` ("microverse: auto-commit dirty tree before start"), then reset HEAD back to C5 (`3a6ab8a0`) — orphaning C6's complete, gate-green work (check-scope-diff.ts +43, compiled +35, 247-line test; 17/17 green).

## Recovery applied

- Stopped the misdirected anatomy-park phase + pipeline-runner + workers.
- ff-only reattached C6's orphan `fcac8752`; verified tsc + 17/17 tests; amended the generic auto-commit message to a proper `feat(72193d53)` (→ `46db064a`); marked C6 Done.
- Reset `state.step` anatomy-park→research, `current_ticket=null`, `active=true`; relaunched. pipeline-runner re-entered PHASE 1 PICKLE; building resumed at C7 (c1d5ba67), iter 4. 16/25 Done.

## Fix proposal (machine-checkable)

1. **AC-1 — pickle-phase completion must be gated on all-tickets-Done, not mux exit code.** After the pickle phase's mux exits, pipeline-runner MUST read the ticket frontmatter set; if ANY ticket is Todo/In-Progress/Failed, treat the phase as INCOMPLETE (re-run pickle or halt for recovery) rather than advancing to citadel. Assert: a mux killed by SIGTERM with ≥1 Todo ticket does not advance the pipeline to PHASE 2.
2. **AC-2 — signal-driven mux exit is distinguishable from clean completion.** The mux must exit non-zero (or write a `pickle_incomplete` sentinel) when deactivated by a signal with tickets remaining, so pipeline-runner can tell "killed" from "done". Assert: SIGTERM-deactivation with Todo tickets → non-zero exit / sentinel; pipeline-runner does not phase-advance.
3. **AC-3 — anatomy/microverse auto-commit must not orphan the committed work.** The "auto-commit dirty tree before start" path must NOT be followed by a reset that discards it; or it must run only when the pickle phase genuinely completed. Composes with H1 (`detectAndRecoverHeadRegression`) and B-XCOF AC-2 (never reset off a ticket commit).
4. Cross-refs: **B-XCOF** (1st external-cancel/orphan event), **B-LERD** (premature run-strand family), H1 (auto-reattach, built-but-undeployed). The external-SIGTERM SOURCE is unidentified (recurs every ~2.5h — possibly a system/cron/terminal signal); the runtime cannot stop the signal but MUST refuse to advance phases on an incomplete build.

## Verification of recovery

- HEAD `46db064a` (C6 reattached + remessaged); tsc + 17/17 C6 tests green.
- pipeline-runner.log 02:12:47Z: PHASE 1/4 PICKLE re-entered; mux iter 4, current_ticket=c1d5ba67 (C7); 16 Done / 9 Todo / 0 Failed.

## RECURRENCE 2026-06-12 — repro on the B-RRH fix bundle's own run (session 2026-06-12-8f02855b)

**Irony:** B-XSPA bit the very bundle building its fix. The C1/C2 fix (gate pickle-completion on all-tickets-Done) is `d680804e` (committed `cb23c3fc`) — but it's source-only, not deployed, so the running pipeline-runner still had the bug.

- Pickle phase "exited with code 0" at 16:58Z with only **5/21 tickets committed** (A0, A, C1/C2, C3, C4); pipeline-runner read exit-0 as completion → advanced PHASE 2 CITADEL (77 findings) → PHASE 3 ANATOMY-PARK (discovered 2 subsystems, microverse setup). The anatomy/microverse runner auto-committed the dead pickle phase's dirty tree as `44e4b515 "microverse: auto-commit dirty tree before start"` (real C1/C2 follow-up work on pipeline-runner.ts + rrh-pickle-incomplete.test.js — preserved at HEAD, NOT yet reset/orphaned because the babysitter froze it before the microverse worker ran).
- **NEW wrinkle vs the original incident:** the mux exited **code 0** (clean), not SIGTERM/143 — so the trigger was NOT an external signal this time. The mux decided it was "done" at 5/21 (false-terminal: likely a false EPIC_COMPLETED or an R-ORSR/breaker terminal exit-0 after the iter-6–9 silent-worker-death churn). AC-C1 (gate on all-tickets-Done, not exit code) covers this REGARDLESS of why the mux exited — reinforces that C1 must not trust exit code at all.
- **Babysitter recovery:** killed the session procs (pipeline-runner + microverse-runner + anatomy worker + watchers, session-scoped) before the microverse reset; reconciled C4 (`84f79bfc`, committed `acaef709` but frontmatter still Todo) → Done w/ completion_commit; reset `state.step` anatomy-park→research + `current_ticket`→`a3f87133` (C5, lowest-order Todo) + `active=true`; relaunched → pipeline-runner re-entered PHASE 1 PICKLE, building C5. No orphaned ticket deliverable (clean log chain; 10 danglings were superseded intermediates).
- **Watch:** stale `citadel_report.json` / `anatomy-park.json` / `microverse.json` from the premature run will be regenerated when pickle re-completes and the pipeline re-reaches those phases.
