# B-DRAIN13 — thirteen filed bugs, composed BY ROOT: one unref'd-settle-path class, one installer, one accounting

**Priority:** P1 (reliability)
**Type:** bundle (bug) — operator-directed 2026-08-26: "if we have 13 bugs then we should do them in one
bundle. ensure we are following the prime directive and pushing toward simplification."
**Branch:** `release/v2.1-beta`
**build_mode:** unattended.

## Thirteen PRDs are NOT thirteen tickets

Composing one ticket per PRD would be the enumerated-set mistake the PRIME DIRECTIVE's complexity
clause names. Composed **by root**, thirteen filed bugs collapse to **seven tickets** — and the largest
group is a single defect class with two INDEPENDENT PROOFS already shipped.

## 🎯 ROOT 1 — an unref'd timer that is the SOLE settle path (covers 4 filed PRDs)

**Proven twice, both at source, both with the same fix:**

| shipped | site | what it was |
|---|---|---|
| beta.16 `3b2c0205` | `monitor.ts` `writeWithWatchdog` | a wedged sink's watchdog never fired; refinement reclassified it from harness quirk to **live production wedge-escape defect** |
| 2026-08-26 `5cce7f5d` | `microverse-runner.ts` `spawnWithClosedStdin` | primary judge timeout was the sole settle path for a hung judge; unref'd |

`5cce7f5d` settled the mechanism with a **controlled experiment** — toggling only the timer's ref state
against a handle-free child:

```
node v22.23.2 | unref -> "unsettled top-level await", exit 13
node v24.19.0 | unref -> "unsettled top-level await", exit 13     <- BOTH lines fail
node v22.23.2 | ref   -> promise settles, exit 0
node v24.19.0 | ref   -> promise settles, exit 0
```

**This is not a Node-22 artifact.** In production a real `ChildProcess` handle incidentally holds the
loop, so the timeout fires only via ref-counting the function neither controls nor documents.

**Measured: 15 `.unref()` sites remain on the runner surface** — `mux-runner.ts` ×6, `spawn-morty.ts` ×5,
`microverse-runner.ts` ×3, `convergence-gate.ts` ×1. Read in context, at least three are settle paths
for a HANG:

```ts
hangGuard           = setTimeout(() => this.resolveTimeout('wall_clock'),   maxIterationSeconds*1000)
outputStallGuard    = setTimeout(() => this.resolveTimeout('output_stall'), remainingMs)
timeoutResolveTimer = setTimeout(() => this.scheduleTimeoutResolutionFinish(true), 1500)
```

**The whole-iteration wall-clock hang guard is unref'd.** If nothing else holds the loop, the guard that
exists to end a hung iteration never fires.

**Composes (as ONE root, not four):** `BUG-2026-08-12-pipeline-runner-hangs-between-phases`,
`BUG-2026-08-16-tier-hangs-at-mux-runner-suite`, `BUG-2026-08-18-timeout-e2e-serial-tier-red`,
`BUG-2026-08-12-fast-tier-marginal-spawn-timeouts`.

**This is a LEAD, not a conclusion.** Two sites are proven; the other thirteen are *shape matches*.
Refinement must establish which are genuine sole-settle-paths and which are legitimately unref'd
(a heartbeat or a kill-grace timer often SHOULD be unref'd — `measureMetricAttempt` unrefs only its
kill-grace timer and that is correct). **Do not blanket-ref every timer.**

## ROOT 2 — the installer (2 PRDs)

`BUG-2026-08-10-install-sh-destroys-its-own-source-tree` (P1, 33 installer references) and
`BUG-2026-08-20-runner-authored-commit-attribution-cluster`. Held out of B-CGSHIP deliberately as too
destructive to ride beside a feature; with no feature here, they belong together on one surface.

## ROOT 3 — verdict/accounting reaches its verdict from the wrong reading (3 PRDs)

`iteration-accounting-and-empty-diff-spin`, `success-verdict-blind-to-test-dimension`,
`mux-runner-halts-on-done-without-commit-evidence`. Same family B-VERDICT closed in the classifier:
a decision made on measurement A, reported or acted on as measurement B.

## ROOT 4 — anchors identified by position rather than identity (2 PRDs)

`ac6-guard-identifies-abort-sites-by-LINE-NUMBER` and `audit-regex-exec-false-positive-and-frb10-cap`.
Same family as the eleven anatomy Criticals in beta.18, where every guard independently reimplemented
"find the real exec" POSITIONALLY.

## Singletons (2 PRDs)

`reaper-worker-shape-gate-and-audit-red`, `empty-diff-skip-unreaches-two-fixtures`.

## 🛡 PRIME DIRECTIVE COMPLIANCE — stated explicitly because this bundle is large

- **No new halt path, no new `exit_reason`, no new abort condition.** ROOT 1 makes hang guards ACTUALLY
  FIRE, which is the opposite of adding a stop: today a hung iteration can run forever because its
  guard was unref'd. Fixing it makes the run *terminate its own stuck work and continue*.
- **Every gate stays continue-and-flag.** Nothing here converts a measurement into a halt.
- **Simplification is the method, not a side effect.** Thirteen PRDs → seven tickets → four roots. ROOT 1
  is one rule applied to a swept set, not fifteen independent patches.

## Acceptance criteria

- **AC-D1** Every `.unref()` on a timer that is a SOLE settle path is removed; each remaining `.unref()`
  carries an in-source comment naming why that timer is safe to unref (heartbeat, kill-grace, etc.).
  Pin with a test asserting the settle path fires with no other handle holding the loop — the shape
  `5cce7f5d` used.
- **AC-D2 — RETRACTED AND REPLACED. The iteration cap was never the constraint; I built a ticket on a
  log line I had not verified.** Measured on the B-CGSHIP session state:

  | field | value |
  |---|---|
  | `max_iterations` | **500** |
  | `iteration` at stop | **6** |
  | `current_ticket_max_iterations` | **None** (no per-ticket budget set) |
  | mux-runner exit | **code 0** — a clean exit, not a cap exit |

  **Nothing capped anything.** The phase reported `hit iteration cap` because of this, at
  `bin/pipeline-runner.ts:3846`:

  ```ts
  const cause = priorExitReason === null || priorExitReason === 'iteration_cap_exhausted'
    ? 'hit iteration cap'
    : `exited (exit_reason=${priorExitReason})`;
  ```

  **`priorExitReason === null` renders as `hit iteration cap`.** An ABSENT exit reason is reported as a
  SPECIFIC cause — the codebase's dominant defect class, in the line that misdirects the reader. The
  in-source comment already calls the old form "the historically misleading hardcoded string"; the
  `null` arm is the surviving half of that same bug.

  **The real defect is upstream and still unexplained: mux-runner exited 0 while ticket `f2b3cf76` was
  `In Progress`,** stranding it. That is what strands work in large bundles — not the cap.

  **AC-D2′ (replaces it):**
  1. A `null` `priorExitReason` MUST NOT render as `hit iteration cap`. Report the absence as an
     absence (`exited with no recorded exit_reason`). Pin with a test.
  2. Establish why the roster loop exits 0 with a ticket `In Progress`, and make that disposition
     either impossible or named. No new halt path — park the ticket and continue.
  3. **Do NOT raise the cap.** 500 global with no per-ticket budget is not a constraint on large PRDs,
     and raising it would have "fixed" a bound that never bound anything.
- **AC-D3..D7** Lift the ACs of the composed PRDs as written; several are already 3-cycle refined.
- **AC-D8 (report-only, non-gating)** Tiers do not regress. Baseline recorded at launch. There are NO
  inherited failures — beta.17 retired both — so ANY failure is attributable to this bundle.

## Non-goals

- Blanket-ref'ing every timer. A heartbeat that holds the loop open forever is a NEW hang.
- Re-pinning Node lines around the symptom. Both lines fail identically; fix at source.

## Simplification Review

1. **Necessary?** Thirteen filed defects; four roots.
2. **Reuse?** ROOT 1 reuses the rule and test shape already proven twice in-tree.
3. **Guards brittle complexity?** It REMOVES a class where a guard's own firing was conditional on
   unrelated ref-counting.
4. **Subtracts?** Up to 15 unref'd settle paths, four separately-filed hang bugs, and nine PRD rows.
