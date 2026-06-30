# B-MWBG (runtime half) — detached-worker gate is budget-based, not large-tier-only

| | |
|---|---|
| **Bundle** | B-MWBG (runtime half) |
| **Priority** | P1 — blocks autonomous medium-tier bundles (the dominant ticket tier) |
| **Class** | Bug-fix — worker-spawn / recovery machinery |
| **Closes** | [[R-MWBG]] runtime half (half-1 manager-prompt foreground discipline already SHIPPED beta.29 `795e539e`) |
| **Backends** | claude (the pickle manager is `claude -p`; the gap is backend-agnostic) |
| **Build protocol** | **NORMAL PIPELINE — R-PSRB does NOT apply.** This edit is to the detached-worker *spawn gate*, not the salvage/completion-evidence path, so it does not corrupt the in-flight worker building it; and the running pipeline executes the **deployed beta.29 compiled JS**, not the source — the diff has zero mid-run effect (it takes effect only after the closer's `install.sh`). The one residual risk — the deployed "medium has no detached path" bug biting a *medium*-tier fix ticket — is dissolved by pinning the load-bearing ticket **`complexity_tier: large`** (beta.29 routes large through the verified-working detached lifecycle). Run via `/pickle-pipeline --scope branch`; no hand-build. |

## Problem

The sanctioned detached-worker lifecycle (B-WPEX-AUTO: `spawnDetachedLargeTierWorker` →
`state.detached_worker` → the orchestrator poll/re-attach loop → `routeLargeTierTicket` fallback)
exists so a worker whose budget exceeds the **600s Bash-tool ceiling** survives turn-end. But its
spawn/poll gate is a **static tier proxy**, not the real condition:

- Spawn gate (`extension/src/bin/mux-runner.ts:~10766`): `state.current_ticket_tier === 'large' && largeTierDetachedEnabled(...) && apTicketId && !state.detached_worker`.
- Poll/re-attach gate (`extension/src/bin/mux-runner.ts:~10803`): matches the current ticket against `state.detached_worker.ticket_id` only when `state.current_ticket_tier === 'large'`.

The per-tier budget table (`extension/src/services/pickle-utils.ts:505-509`, `TICKET_TIER_BUDGETS`) is:

| tier | `worker_timeout_seconds` | exceeds 600s ceiling? | has detached path today? |
|---|---|---|---|
| trivial | 300 | no | n/a |
| small | 600 | no (== ceiling) | n/a |
| **medium** | **3600** | **YES** | **NO ← the gap** |
| large | 4800 | yes | yes |

So **medium-tier workers (3600s) provably cannot complete in a 600s foreground Bash spawn, yet have
no sanctioned ceiling-survival path.** The pickle `claude -p` manager, facing a medium spawn it knows
will exceed 600s, improvised one — Bash `run_in_background` + end-its-turn — which a `-p` subprocess
does not survive (the worker is reaped at turn-end → 0-byte log → `done_without_commit_evidence`
refusal → `pipeline_phase_incomplete` 0/4). That is the R-MWBG incident (B-SIGF 2026-06-29,
ticket `be536995`). Half-1 (manager prompt) tells the manager not to do this; **the runtime half
removes the tension at its root**: any tier whose resolved budget exceeds the ceiling routes through
the *same shipped* detached lifecycle the orchestrator already owns — the manager never has to choose.

**Fix shape (reuse-first):** replace the `tier === 'large'` literal at both gates with a single
budget-based predicate `state.worker_timeout_seconds > BASH_TOOL_CEILING_SECONDS`. Reuse the entire
existing detached lifecycle unchanged — no new state field, no new oracle, no new spawn path.

---

## Workstream

### WS-1 — detached gate keys on resolved worker-timeout vs the Bash ceiling, not tier

Introduce one named constant `BASH_TOOL_CEILING_SECONDS = 600` and one shared predicate (e.g.
`workerTimeoutExceedsBashCeiling(state)` returning `resolvedWorkerTimeoutSeconds(state) > BASH_TOOL_CEILING_SECONDS`,
reusing the already-resolved `state.worker_timeout_seconds` / `TICKET_TIER_BUDGETS` mapping — do NOT
recompute the tier table). Consume the predicate at BOTH gates in place of `state.current_ticket_tier === 'large'`.
The kill-switch (`largeTierDetachedEnabled` / `PICKLE_LARGE_TIER_DETACHED=off`), the spawn helper
(`spawnDetachedLargeTierWorker`), the `state.detached_worker` shape, the poll/re-attach loop, the
`routeLargeTierTicket` fallback, and the `shouldForceDetachForLargeTier` / `PICKLE_LARGE_TIER_DETACHED_WORKER`
subtree-reap marker are all reused **verbatim**.

**Acceptance criteria (machine-checkable):**

- `AC-MWBG-1` — The detached **spawn** gate (`mux-runner.ts` ~:10766) no longer contains the literal
  `state.current_ticket_tier === 'large'`; it calls the shared predicate. Unit test: a **medium**-tier
  ticket (`worker_timeout_seconds = 3600`) with the lifecycle enabled and `!state.detached_worker`
  routes to `spawnDetachedLargeTierWorker` — asserts a `large_tier_worker_spawned` activity event and a
  populated `state.detached_worker` for the medium ticket.
- `AC-MWBG-2` — The **poll/re-attach** gate (`mux-runner.ts` ~:10803) uses the SAME predicate: a medium
  detached worker is matched and polled (not abandoned). Test: with `state.detached_worker.ticket_id`
  set for a medium ticket and the process alive, the poll branch is entered and emits
  `large_tier_worker_poll`.
- `AC-MWBG-3` — Sub-ceiling tiers are unchanged: a **small** (`600`, `== ceiling`, NOT `>`) and a
  **trivial** (`300`) ticket do NOT take the detached path (predicate false). Test asserts no
  `spawnDetachedLargeTierWorker` / no `state.detached_worker` write for small/trivial.
- `AC-MWBG-4` — Single source for the threshold: `grep` proves exactly one definition of
  `BASH_TOOL_CEILING_SECONDS` (or equivalent named constant) and that both gates reference it — no
  duplicated magic `600`.
- `AC-MWBG-5` — Kill-switch parity: `PICKLE_LARGE_TIER_DETACHED=off` reverts **all** ceiling-exceeding
  tiers (medium AND large) to the synchronous `routeLargeTierTicket` fallback. Test asserts a medium
  ticket falls back to the interactive route when the flag is off.
- `AC-MWBG-6` — Subtract-before-add: `grep` proves no new `state` field, no second spawn path, no new
  oracle — the change reuses `spawnDetachedLargeTierWorker` + `state.detached_worker` + the existing
  poll loop. `audit-subtract-before-add.sh` stays green.
- `AC-MWBG-7` — Regression: the existing large-tier detached integration suite
  (`extension/tests/integration/large-tier-detached-*.test.js`, `large-tier-routing-fallback.test.js`,
  `large-tier-resume-reattach.test.js`) passes unchanged — large-tier behavior is a strict superset.
- `AC-MWBG-8` — Docs: the `PICKLE_LARGE_TIER_DETACHED` env-var row in `extension/CLAUDE.md` and the
  detached-lifecycle architecture note state the gate is **budget-based** (any tier whose
  `worker_timeout` exceeds the 600s Bash ceiling), not large-tier-only. Per the Documentation Rule,
  update `README.md` if it describes the gate.

---

## Out of scope (explicit, evidence-backed)

- **The 4 large-tier worker DEATHS in B-SIGF (`0b9b2319`/`c6051d64`/`34f29e44`/`b5db0cb6`, 0-byte/116-byte
  logs).** VERIFIED from session `2026-06-29-e68fda19`: these tickets routed through the detached
  lifecycle **correctly** (`large_tier_worker_spawned` + `large_tier_worker_poll` bursts +
  `ticket_ladder_exhausted` clean advance ~8 min post-spawn). Their worker logs carry the
  process-cancellation signature (`"SessionEnd hook … Hook cancelled"`, `"no stdin data received in 3s"`)
  under the incident-time **five_hour rate utilization 0.95** wall. This is the R-WSE / rate-limit
  worker-cancellation class — **NOT a detached-path code defect** (the lifecycle spawned, polled, and
  advanced as designed). The MASTER_PLAN hand-wave ("the large detached lifecycle is itself failing,
  uncovered by beta.28") is **corrected by this evidence** and is therefore out of scope for B-MWBG.
- **Renaming the `largeTier*` symbols / `PICKLE_LARGE_TIER_DETACHED` env var / `large_tier_worker_*`
  activity events** to ceiling-based names. Semantically tempting (the gate is no longer large-only) but
  pure churn with kill-switch-contract + activity-event-count-audit blast radius. The semantic broadening
  is captured in the doc comment + AC-MWBG-8; an optional rename is a separate follow-up, not this
  atomic bug fix.
- **The small-tier exactly-at-600s boundary.** Small budget `== 600` (not `>`), so a small worker that
  ran its full budget would hit the ceiling at the boundary. Empirically small workers finish well under
  budget; keeping the predicate strictly `>` minimizes blast radius. Revisit only on a real
  small-tier-at-ceiling repro.

---

## Simplification Review (subtract-before-add)

Per `prds/CLAUDE.md`, answering all four.

**WS-1:**
1. *Necessary?* Adds one named constant + one shared predicate, replacing a literal. Necessary — medium
   tier has no ceiling-survival path, which is the root of the R-MWBG manager-improvisation death.
2. *Reuse not add?* **Yes — near-total reuse.** The entire detached lifecycle (`spawnDetachedLargeTierWorker`,
   `state.detached_worker`, the poll/re-attach loop, the fallback, the subtree-reap marker) is consumed
   verbatim; the predicate reads the already-resolved `state.worker_timeout_seconds` from the existing
   `TICKET_TIER_BUDGETS` mapping. The only genuinely-new token is the `BASH_TOOL_CEILING_SECONDS`
   constant — which *names* a value the system already depends on implicitly.
3. *Guards brittle complexity?* The brittle thing is `tier === 'large'` used as a **proxy** for "exceeds
   the ceiling." The fix **replaces** the proxy with the real condition rather than guarding it — no second
   gate around the first.
4. *Subtract?* Subtracts the implicit coupling "only `large` exceeds the ceiling." Collapses a tier-as-proxy
   into the actual budget-vs-ceiling truth — flatter, and self-correcting if the tier budget table ever
   changes again.

---

## Build sequencing & tiers

- Single workstream, single load-bearing edit (two gate conditions + a shared predicate + a constant) +
  its unit tests + the doc/CLAUDE.md update.
- **Complexity tier:** the load-bearing implementation ticket is pinned **`large`** (NOT medium — a
  medium ticket would hit the very deployed bug it fixes and die on the pre-fix runtime; large rides the
  verified-working detached lifecycle on beta.29). The doc/CLAUDE.md ticket is `small`/`trivial`
  (foreground-safe, well under 600s). Repro-first within the pipeline: the implementation ticket's plan
  writes a RED unit test proving a medium ticket is NOT routed detached today, then makes it GREEN by
  broadening the gate. Built by a normal `/pickle-pipeline --scope branch` run — no hand-build.

## Closer

- Single semver bump at the closer: **PATCH within the beta line → `v2.0.0-beta.30`** (behavior fix; no
  new flag/command/event/state field/schema change → not MINOR per the DECISION RULES).
- Full local release gate from `extension/` GREEN before tag: `npx tsc --noEmit && npx eslint src/
  --max-warnings=-1 && npx tsc && <all audit-*.sh incl. audit-subtract-before-add.sh> && npm run
  test:fast:budget && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`.
- Commit residuals → bump → `chore: bump version to 2.0.0-beta.30` → `bash install.sh` (set
  `state.flags.allow_install_sh_reason` if a closer hook blocks, then clear) → verify clean tree + JS
  matches TS → `git push` → `gh release create v2.0.0-beta.30`. Ship on the local gate; CI-green is
  hygiene, not a release gate.

---

## ⛔ Rebuild Notes — first attempt REVERTED at the closer (2026-06-29)

The first build (commit `0cbc49c1`, session `2026-06-29-e7f5b7e1`) shipped a clean-looking diff (swap
`tier === 'large'` → `workerTimeoutExceedsBashCeiling(state)`) but **the full release gate caught a
deterministic 9-test regression in `mux-runner.test.js`** (command_template rejection, SIGTERM signal
attribution, desync reconciliation, iteration-persistence-before-manager-spawn). REVERTED to restore
green main; re-queued for a proper rebuild.

**Why the simple budget-predicate is WRONG (root cause, verified):**
1. `readTicketBudgetForState` → `sessionRunnerBudget` returns **`tier: 'medium'` + `worker_timeout_seconds`
   = the session default (e.g. 1200)** for the **no-ticket / prd / breakdown** case. So
   `applyTicketTierBudget` stamps `current_ticket_tier='medium'` and
   `current_ticket_worker_timeout_seconds=1200` during phases where NO ticket is active.
2. A ticket with **no explicit `complexity_tier`** also resolves to the **medium** default (3600s).
3. Therefore gating on **any** of `worker_timeout_seconds`, `current_ticket_worker_timeout_seconds`, OR
   `current_ticket_tier ∈ {medium,large}` fires during the prd phase AND for every default-tier ticket —
   routing them through the detached / `routeLargeTierTicket` path, which **bypasses the `runIteration`
   path** (command_template validation, manager spawn, desync reconciliation, iteration persistence,
   signal attribution). The old `=== 'large'` gate dodged ALL of this only because the fallback/default
   tier is `medium`, never `large`.
4. The detached lifecycle (`spawnDetachedLargeTierWorker` + poll + disposition) was built for LARGE
   tickets and **does not preserve the `runIteration`-path invariants** for medium tickets.

**Why the build didn't catch it:** the implementation ticket was tiered **`small`** to dodge the
deployed R-MWBG bug — but a `small`-tier worker gate **SKIPS `test:fast`** (R-PTG-2 contract), so
`mux-runner.test.js` never ran during the build. The regression only surfaced at the closer's full gate.

**Rebuild direction (the scope is bigger than originally written — needs design + operator sign-off):**
- The runtime half is NOT a one-line gate swap. It requires EITHER (A) making the detached lifecycle
  preserve every `runIteration`-path invariant for medium tickets (large additive work), OR (B) a gate
  that fires ONLY for an **active ticket whose EXPLICIT frontmatter tier** exceeds the ceiling (never the
  `sessionRunnerBudget` fallback, never a default-tier ticket) AND verified detached-path correctness for
  medium. Both need the full `mux-runner.test.js` as the per-ticket gate.
- **Build as a `medium`-tier ticket** (NOT small) so the worker gate runs `test:fast` and catches this
  class during the build. With half-1 shipped, the deployed manager foregrounds + re-spawns-resumes a
  medium worker, so a medium build ticket survives on the deployed runtime.
- **Reconsider priority:** half-1 (manager foreground-spawn + resume-on-cutoff, shipped beta.29) already
  removes the ORIGINAL R-MWBG death (manager Bash-backgrounding). The runtime half is now a
  larger/riskier change for a smaller marginal gain — DE-PRIORITIZE behind a real repro that half-1
  doesn't cover.

## ✅ Rebuild — SHIPPED v2.0.0-beta.31 (2026-06-29, interactive, operator-signed-off; fix `64fb7e12`)

**Chosen: option (B), sharpened — gate on the EXPLICIT frontmatter tier, REUSE the existing detached
lifecycle (no option-A peer rewrite, no new state field/path).** The detached lifecycle is not
large-specific (`spawnDetachedLargeTierWorker` takes `workerTimeoutSec` as a param; poll/disposition run
the generic `salvageTicket` oracle), so widening it to medium needs only a correct gate — not a rewrite.

The ONLY thing the reverted attempt got wrong was trusting `state.current_ticket_tier` (which carries the
`sessionRunnerBudget` `medium` fallback for the prd/no-ticket phase AND for default-tier tickets). The fix
reads the tier the way `resolveCreditEarlyPhases` already does — straight from the ticket frontmatter —
and rejects a missing/invalid field BEFORE budget resolution (which would normalize an absent tier to
`medium`). So the prd phase (no ticket) and a default-tier ticket (no field) both yield `false` → they
stay on the in-process `runIteration` path with its invariants intact. That is exactly why the reverted
9-test `mux-runner.test.js` regression does NOT recur.

**Diff (all in `extension/src/bin/mux-runner.ts`):**
- NEW exported `tierExceedsBashCeiling(state, sessionDir, ticketId)` + `BASH_TOOL_CEILING_SECONDS = 600`
  (placed by `largeTierDetachedEnabled`). Reads explicit `complexity_tier`; valid-tier guard before
  `getTicketTierBudgetWithOverrides`; `true` iff resolved `worker_timeout_seconds > 600`. Fail-open false.
- Both poll-loop detached gates (spawn + poll) OR the helper into the existing `=== 'large'` check.
- The recovery re-execution seam (`spawnImplementPass`) routes explicit-medium-over-ceiling detached too
  (was bounded to a 600s implement pass).
- Deliberately LEFT the kill-switch/spawn-fail fallback (`routeLargeTierTicket` vs `runIteration`) alone:
  with detached off or a failed spawn, medium degrades gracefully to in-process `runIteration`.

**Tier mapping (TICKET_TIER_BUDGETS):** trivial 300s / small 600s / medium 3600s / large 4800s — so
`>600` cleanly includes explicit medium+large and excludes small+trivial.

**Verification:** `tsc --noEmit` clean; eslint clean (pre-existing warnings only); `mux-runner.test.js`
**201/201** (the revert suite); large-tier integration 27/28 (the 1 fail = `AC-R-WPEXA-1b` real-subprocess
pipe-survival timing flake, **3/3 green in isolation**, untouched spawn mechanism); NEW pinning test
`tests/r-mwbg-tier-exceeds-bash-ceiling.test.js` green (explicit medium/large → detached; prd/default/junk/
missing → in-process). JS recompiled to match TS. Built on the in-process path (spawn-gate edit, R-PSRB N/A).
