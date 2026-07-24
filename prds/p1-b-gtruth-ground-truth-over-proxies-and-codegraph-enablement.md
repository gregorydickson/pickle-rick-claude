---
title: "B-GTRUTH — ground truth over proxy signals + codegraph enablement (v2.1)"
priority: P1
finding: B-GTRUTH
composes: [B-CGEN, R-AICF, R-WGFR]
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
source_assessment: "Operator direction 2026-07-23 ('we seem to still not be reliable — focus on how to actually become less brittle') plus the empirical failure record measured the same day across ~/.local/share/pickle-rick/sessions. Combined with B-CGEN (operator-set: codegraph is the v2.1 headline feature) into ONE PRD because the codegraph efficacy soak is only trustworthy on the repaired runtime — see ## Why one PRD."
---

# B-GTRUTH — a proxy signal may never outrank recoverable ground truth

## The measured failure record (2026-07-23, not anecdote)

Scanned every session under `~/.local/share/pickle-rick/sessions`:

| Measurement | Value |
|---|---|
| Tickets carrying a `worker_gate_verdict` | 22 (12 green / **10 red**) |
| **Red-gate tickets that ended `Done` anyway** | **10 / 10 — 100%** |
| Phase halts recorded | 2, **both** `done_without_commit_evidence` |
| Those halts that were correct | **0 / 2** |
| Operator interventions required in one 6-ticket bundle | **2** |

**A verdict overridden 100% of the time is not a gate.** It is noise that charges a recovery tax:
each red runs suppression, draws down the persistent `failed_flip_suppression_cap` ledger, risks a
`reset --hard` + `git clean -fd`, and — twice in one bundle — required a human.

## Field occurrence — 2026-07-23, a real target-repo codex pipeline (post-authoring, corroborating WS-A2)

A **third** `done_without_commit_evidence` phase-halt, and the first observed OUTSIDE a self-build
session — a `/pickle-pipeline --backend codex` run against **loanlight-api** (session
`2026-07-23-e89c5c77`, the LOA-1972/1973 appraisal-flag epic, 14 tickets).

- **Symptom (verified):** pickle exited code 1 with `exit_reason: done_without_commit_evidence` after
  6 clean ticket commits (R1–R7). `pipeline-runner` then halted **all 4 phases** (`Phase pickle failed
  (exit 1) — stopping pipeline`, `0/4 phases`) — the WS-A2 phase-fatal misclassification, now confirmed
  on a real target repo. `pipeline_continue_on_phase_fail: true` did not help (it does not cover the
  build phase).
- **The in-flight ticket was genuinely mid-work, not zero-diff.** R9 was `In Progress` with a clean
  tree at exit; on recovery it committed real changes (`b224c6c25`). So this instance is the
  *committed-but-unflipped / manager-declared-done-early* flavor — WS-A1's zero-diff widening would NOT
  have covered it; only WS-A2's reroute-to-recovery does.
- **`allow_inferred_completion_commit: true` was set at launch and did NOT prevent the halt** — evidence
  that the launch-time inferred-commit allowance is not a substitute for the WS-A2 reclassification.
- **Recovery (same 4 steps as the recorded cases):** verify ground truth (`git log`) → reset
  `step`/`current_ticket` to the in-flight ticket via `update-state.js` → clear `exit_reason` → relaunch
  `launch.sh`. Resumed cleanly; R9→R6 advanced next iteration. Handled by the operator babysitter loop.

**Bearing on the bundle:** strengthens WS-A2's P1 case (not self-build-specific — it bites real
target-repo pipelines and stalls the entire review chain) and confirms WS-A1 alone is insufficient for
this flavor (a genuinely-incomplete in-flight ticket, not a zero-diff one).

## The single pattern

Five distinct incidents this session; **one shape**. A proxy signal was treated as authoritative over
ground truth that was one command away.

| Proxy | Claims to measure | Actually fired on | Ground truth (cheap, and correct) |
|---|---|---|---|
| `tokenPresent` | worker did the work | model forgot to narrate | artifacts + git edits — **B-WDSUB fixed** |
| `ANALYSIS_DONE` | analyst produced analysis | same | fresh artifact on disk — **B-WDSUB fixed** |
| `done_without_commit_evidence` | ticket is complete | committed-but-unflipped; **verification ticket with nothing to commit** | `git log`, artifacts — **OPEN, WS-A1/A2** |
| `worker_gate_verdict: red` | the change is sound | `pnpm` absent from PATH | isolated test run — **OPEN, WS-A3** |
| anatomy `exit 1` → *"completed successfully"* | phase outcome | non-convergence | the disposition itself — **B-NONSTOP fixed** |

B-WDSUB closed two instances. **This bundle closes the class**, then ships codegraph on top of it.

> **Full site inventory:** [`RELIABILITY-INVENTORY-2026-07-23-proxy-over-ground-truth.md`](RELIABILITY-INVENTORY-2026-07-23-proxy-over-ground-truth.md)
> — six parallel auditors, one invariant (*git working-tree state is the sole authority on completion; every
> other signal is advisory*). Headline: the system is **already ~85% git-authoritative**; the destruction
> surface is **~7 concrete sites, not 94**, and the 94 recovery recipes are the *symptom* of those leaks —
> each historically patched with a new proxy instead of closing the leak. Track A here ships the inventory's
> **Tier 1** (A+B → WS-A1/WS-A2, today's incident, pure subtraction) and **Tier 2** (C → the R-WDTF class,
> already closed by B-WDSUB); the inventory's **Tier 4** structural enabler (a real `ExitReason` enum so a
> single git-consultation guard can live at the `StateManager` choke-point) and **Tier 3** design-conflict
> sites are scoped OUT of this bundle and left as the inventory's recommended follow-on sequencing.

## Why one PRD (the ordering constraint that justifies batching)

Codegraph's enablement is only as trustworthy as the soak that measures it — and a soak verdict read
through the proxies above measures nothing. Track A must be **built, gated, and DEPLOYED** before the
Track C soak runs. A running pipeline executes the **deployed** JS, so Track A's fixes do not help this
bundle's own run — they help the soak that follows the deploy. One PRD makes that sequencing a hard
constraint instead of a hope. One release gate covers all of it.

---

# TRACK A — reliability (subtractive; must deploy before Track C)

## WS-A1 — make "complete, no diff" a representable outcome

**The defect.** Every completion predicate in the runtime assumes a commit exists.
`evaluateCompletionEvidence` (`services/ticket-completion-evidence.ts:838`) is sha-centric —
`refuseAbsent` when there is no sha. So a ticket that **correctly** produces no diff is
structurally unrepresentable as complete.

**Observed twice, and the workaround is a forgery.** Ticket `8784c6cb` (compiled-mirror parity) did its
job perfectly — verified 0 drift files, `tokenPresent` gone from both trees, `readiness_halt` gone from
both — and therefore had **nothing to commit**, so the phase halted. The documented precedent is worse:
B-FOMC's zero-diff manager tickets (**R-AICF**) were recovered by fabricating **empty marker commits**
naming the ticket. *The proxy is so load-bearing that operators forge the evidence it demands.*

**The fix.** A ticket may declare a zero-diff intent (verification / audit / already-satisfied). Such a
ticket is complete when its lifecycle artifacts exist and its gate did not fail — no commit required, no
marker commit fabricated. Verification, audit, parity, and "already fixed upstream" tickets stop being
second-class.

**Subtraction paid:** deletes the empty-marker-commit ritual and the class of wedge it works around.

**Do NOT** weaken the commit requirement for ordinary implementation tickets — that is the anti-fake-green
intent of AC-MWMO-D2-8 and it must survive (B-GSUB guardrail).

## WS-A2 — reroute `done_without_commit_evidence` to the recovery path that already exists

**This is a one-line classification fix, NOT new machinery.** Verified 2026-07-23: the runtime already
has three working recovery layers, and the wedge bypassed all of them.

| Layer | Mechanism | Status this session |
|---|---|---|
| Ticket | `failed_flip_suppressed` / salvage / reconcile | **fired 5/5, every one `outcome: success`** — caught each pnpm false-red, saw fresh artifacts, preserved the work |
| Child-stall | `child_mux_runner_wedge_detected`, `child_mux_runner_heartbeat_ms` (60 s) | armed — but detects a **hung** child, and ours did not hang |
| Phase | `isFatalPhaseFailure` → `false` → `recordRecoverablePhaseFailure(..., 'continue')` (`pipeline-runner.ts:4109`) | **works** — this is the path anatomy-park took in the B-NONSTOP run |

**The defect is one line.** `pipeline-runner.ts:2801` hardcodes
`if (runnerState.exit_reason === 'done_without_commit_evidence') return true;` — classifying a
**ticket-scoped** condition as **phase-fatal**, which bypasses the recoverable path 1300 lines below it.

**The fix:** route `done_without_commit_evidence` to `recordRecoverablePhaseFailure(..., 'continue')`
when the bundle's other tickets are terminal and their work is present — park the ambiguous ticket,
report it, continue. Narrow `isHaltExit` (`bin/mux-runner.ts:4370`) accordingly.

**Measured blast radius of getting this wrong:** both halts occurred with **5 of 6 tickets `Done`** and
the sixth's work verifiably complete on disk. Launch 3 then completed the entire pickle phase in
**1.06 seconds** — proving there was no work left. The pipeline had been halting over bookkeeping while
holding finished work.

**Subtraction paid:** removes a reason from the phase-fatal surface; adds nothing. The recovery it routes
to already exists and is already exercised.

**Do NOT** demote genuinely phase-level reasons (`cancelled`, `limit`, schema-ahead) — only ticket-scoped ones.

## WS-A3 — the gate must measure the code, not the ambient environment

**The defect.** `tests/services/convergence-gate.test.js` plants a `pnpm-lock.yaml` and shells out to
`pnpm test`. When `pnpm` is absent from a worker-gate subprocess's PATH the gate returns `red`, and the
assertion reads `'red' !== 'green'` — indistinguishable from a real regression. Diagnosed live this
session; `convergence-gate.ts` and its test were **untouched** by all 40 commits.

**REUSE, not new machinery.** A toolchain precondition already exists: `toolchain_unavailable`
(`bin/mux-runner.ts:9316`) fails loudly when a target repo has `package.json` but no `node_modules`.
It simply does not cover the **binaries the gate itself invokes**. Extend that existing check to assert
them once, at session start, and fail loudly — instead of N false reds, one per ticket.

**Then decide the verdict question with data.** 10/10 red-gate tickets ended `Done`. Either the gate is
wrong, or it is right and we systematically ship over red — **both are unacceptable, and the second is
worse.** This workstream MUST NOT pre-decide: measure the gate's true-positive rate across the session
record, then either repair the input or stop computing a verdict nobody honours. Report the number even
if it argues for keeping the gate exactly as it is.

**Subtraction paid:** removes the environment as an input to a code-quality verdict.

## WS-A4 — external liveness (DEFERRED — measure before building)

**The one genuine gap: nothing watches a pipeline that has cleanly EXITED.** All three recovery layers
above are *in-process*; a dead process cannot monitor itself. That gap is what cost **9 h 35 m of dead
time (63% of elapsed wall-clock)** in the B-WDSUB run — two halts sat unnoticed for 2 h 24 m and 7 h 12 m.

**Do NOT build a supervisor in this bundle.** WS-A1 + WS-A2 remove both *known* wedge causes; a watchdog
built now is insurance against a problem being deleted in the same PRD, and a guard wrapped around guards
is the documented anti-pattern ([[feedback_analyze_failures_then_subtract_not_add_guards]]).

**Sequence instead:** ship A1–A3, then run one **unattended** bundle and measure whether it still stalls.
Only if it does:
- The watchdog **must be external** to the runtime — an in-process watcher dies with the process it watches.
- It needs no new state: `pipeline-status.json` already carries `status` + `updated_at`. "status is not
  `running`/`completed` **and** `updated_at` is stale" is a ~10-line check, not a subsystem.
- The natural home is the **babysitter**, which already exists and already drains the MASTER_PLAN queue —
  extend it to check pipeline liveness rather than inventing a supervisor.

---

# TRACK B — codegraph enablement (the v2.1 headline feature)

> ⚠ **Additive by explicit operator decision**, not by THE LENS. Recorded so this bundle does not
> silently violate the subtraction criterion. THE LENS still governs *how* it lands.

## WS-B1 — delete the `!isResume` shortcut (subtractive)

`cgResolveIndexAction` (`bin/setup.ts`):

```ts
if (!isResume) return 'full';                  // every fresh session: FULL index
const ageMs = Date.now() - fs.statSync(dbPath).mtimeMs;
return ageMs >= staleMs ? 'sync' : 'noop';     // only ever reached on --resume
```

The freshness check is **dead code on the launch path** — a fresh pipeline in a repo holding a
ten-minute-old `.codegraph/codegraph.db` still pays a full re-index. Delete the shortcut; let freshness
govern every path. Cold repo → `full`; recent db → `sync` (30 s cap) or `noop` (free).

## WS-B2 — `sync()` at key points (the accuracy fix, not a speed fix)

A pipeline mutates the repo it is indexing: the B-WDSUB run landed **8 commits in ~9 h**. An index taken
once at setup is stale by ticket three, so later workers receive context describing a repo that no longer
exists — and the staleness is **silent**, because `buildContext` still returns something.

Call the existing `CodegraphService.sync()` (already bounded by `sync_timeout_ms`, 30 s) at
post-ticket-commit and phase transitions.

> ⛔ **Do NOT spawn a detached indexer.** That reintroduces the failure class [[B-WSPU]] deleted
> (~1000 LOC; detached workers silently died — the field evidence was a detached worker dying while
> building its own deletion). A background index racing `buildContext`'s 5 s query also fails *quietly*:
> the service degrades rather than crashes, so workers silently receive thinner context.

## WS-B3 — the enablement itself

| # | Change | Why |
|---|---|---|
| 1 | **`install.sh:529`** — drop `.codegraph.enabled = false \| .codegraph.index_at_setup = false` from the MANAGED_KEYS jq | **Load-bearing.** Without it every deploy re-disables the feature and a source flip is INERT. Keep the other two managed keys. |
| 2 | `pickle_settings.json` — `enabled: true`, `index_at_setup: true` | The flip itself |
| 3 | **Invert two guard tests** — `codegraph-default-optin.test.js` (AC-GA-CG-1) + `codegraph-docs-optin-parity.test.js` (AC-GA-CG-2) | Both **WILL red**. **Invert, do not delete** — they become the guard that codegraph stays ON. |
| 4 | Docs — CLAUDE.md settings row + README two-lane split; **retire Tune-Back CUJ #2** | CUJ #2 existed only to work around MANAGED_KEYS |
| 5 | **Keep `PICKLE_CODEGRAPH=off`** | The kill-switch is the escape hatch |
| 6 | **`expose_mcp_to_workers` stays `false`** | Two-lane split (`4e641a88`): the injected-context lane is NOT the interactive MCP lane |

**Prior art:** `3bab38f2` (06-14) flipped it ON; `b5a4f5b0` (06-16, B-GA) flipped it back — verbatim
rationale *"matching deployed reality."* **No defect forced it off**; it was a source/deployed consistency
fix during **2.0** GA-readiness. Re-enabling on the **2.1** line is coherent with that.

## WS-B4 — conditional: warm the index inside the existing session-scoped service

**Only if WS-B1 + WS-B2 leave setup too slow.** `mux-runner.ts:9268` already creates a session-scoped
`CodegraphService`, documented *"fail-open — never blocks session start"*, that lives for the whole run.
Start the warm index there and let it run concurrently with ticket 1; `spawn-morty`'s `buildContext`
already degrades when the graph is not ready. **Async without a new lifecycle** — in-process, on a process
that already outlives the work. If WS-B1/B2 suffice, **drop this workstream** (B-CGHARD precedent:
already-satisfied workstreams are dropped, not built).

---

# TRACK C — the soak (runs LAST, post-deploy)

## WS-C1 — codegraph efficacy soak on the repaired runtime

Existing probes to reuse: `codegraph-efficacy-probe.test.js`, `codegraph-index-cost.test.js`.

**Evidence status:** codegraph *has* run — **91 `codegraph_context_injected`** + 19 syncs across 5
sessions (2026-07-16/17) — but **all of it predates the 2026-07-18 B-CGHARD harvester fix**, so none of it
measures the shipping configuration.

**Hard preconditions (the reason this is one PRD):**
1. Track A built, gated, **and deployed** (`install.sh`) — the soak must run on the repaired runtime.
2. Pin the observed setup-index cost (`codegraph-index-cost.test.js`) before shipping.
3. Confirm a missing/incompatible native binary **degrades** rather than crashes
   (`codegraph-degradation.test.js`) — on-by-default makes that path load-bearing for every install.

**Record the number even if it argues against the feature.** Per
[[feedback_verify_the_outcome_not_the_mechanism]], a soak that cannot produce a disconfirming result is
not a measurement.

---

## Non-Goals

- **`persistWorkerOutcomeStatus` is NOT edited.** `spawn-morty.ts:1996`'s `completion_commit: null` write
  is adjacent to this work and remains out of scope — it is the narrow R-PSRB completion-evidence path.
- **`src/lib/salvage-ticket.ts` is NOT edited**, and the dead `backfillDone` wiring is not restored here
  (filed separately as R-SBFD).
- **`ticket-completion-evidence.ts` is CONSUMED, not edited** — WS-A1 changes the *caller's* notion of
  acceptable completion, not the oracle's internals. Keeps this bundle off the R-PSRB path.
- **No exit-reason value is renamed or removed** beyond narrowing the `isHaltExit` membership in WS-A2.
- **`expose_mcp_to_workers` stays `false`** — separate C0-gated flip.
- **The off-repo fake-green at `runWorkerGate:1673` is NOT fixed here.**

## Simplification Review (subtract-before-add)

1. **Track A adds no mechanism.** WS-A1 widens an existing completion notion and **deletes the
   marker-commit ritual**; WS-A2 **shrinks** `isHaltExit`; WS-A3 **extends an existing precondition**
   (`toolchain_unavailable`) and removes the environment as a gate input. Track B is additive **by
   declared operator decision**, and even there WS-B1 is a pure deletion.
2. **REUSE:** WS-A1 consumes `evaluateCompletionEvidence` rather than adding a predicate. WS-A3 reuses
   `toolchain_unavailable`. WS-B2 reuses `CodegraphService.sync()`. WS-B4 reuses the session-scoped
   service that already exists. WS-C1 reuses two existing probes.
3. **The brittle thing being subtracted** is the whole proxy-over-ground-truth family: a narrative token,
   a commit count, and an ambient binary each outranking evidence on disk. Every fix removes the proxy's
   authority rather than wrapping it in a second guard.
4. **Net shape:** Track A is net-negative LOC. Track B is net-positive by decision, and its own WS-B1 is
   negative. **Do not delete a guard that fires correctly** — WS-A3 must report its measurement even when
   it argues for keeping the gate.

## Risks

- **Track A's fixes do not protect this bundle's own run.** The pipeline executes deployed JS; source
  edits land only at `install.sh`. Expect this run to hit the same wedges — budget for interventions and
  recover with the documented recipe (verify ground truth → flip → clear `exit_reason` → relaunch).
- **Bundle size.** B-WDSUB was 6 tickets and required 2 interventions. This is larger. Keep Track A tight
  and ordered first; if refinement produces an unwieldy count, split Track C into a follow-up rather than
  padding the run.
- **WS-A1 over-subtraction** — if zero-diff completion is too permissive, a genuinely failed ticket reads
  as complete. Bound it: the declaration must be explicit in the ticket, and artifacts + non-failing gate
  are still required.
- **WS-A2 under-halting** — parking instead of halting could let a run continue past a condition that
  genuinely should stop it. Phase-level reasons must remain fatal; only ticket-scoped ones are demoted.
- **Codegraph on-by-default makes the native dep load-bearing** on every install and every platform.

## Build-time reminders

- Branch `release/v2.1-beta`. Baseline = the beta.5 release commit (after B-WDSUB ships).
- **Compiled-mirror co-scoping is MANDATORY** — `install.sh:389` rsyncs with `--exclude='src'`, so
  `extension/bin/*.js` IS the deployed runtime. Every ticket allowlist names both trees. A src-only commit
  passes every grep AC green while the runtime keeps the bug.
- Launch with `--szechuan-max-iterations 500 --anatomy-max-iterations 500`.
- **Track A tickets must be ordered before Track B**, and **WS-C1 must run after deploy** — not inside the
  build phase.
