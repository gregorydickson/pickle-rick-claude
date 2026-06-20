# Pickle Rick pipeline bug report — 2026-05-21

**Reporter:** gregory@loanlight.com
**Session:** `~/.local/share/pickle-rick/sessions/2026-05-21-408aea8e`
**Pipeline:** `/pickle-pipeline docs/prd-loa-701-split-hardening.md` (refined, `--scope branch`, backend claude) — target `/Users/gregorydickson/loanlight/loanlight-api/packages/api`, a large monorepo package.
**Outcome:** PICKLE phase died at 1m 0s on `READINESS HALT: check-readiness exited 1`. Operator triaged the 15 findings: **1 was a genuine ticket defect** (fixed), **14 were checker false-positives**. Operator fixed the real defect, set `state.flags.skip_quality_gates_reason` for the rest, relaunched — the second launch advanced past readiness into pickle worker dispatch (ticket `c0686bff` spawned).
**Severity:** S3 — on a large target repo the readiness gate fails for reasons unrelated to ticket quality; the escape hatch works but the gate is effectively unusable without it, so it stops being a gate.
**Relation to prior reports:** Same subsystem as `BUG-REPORT-2026-05-19-readiness-absolute-path-outside-target.md` (Finding #57 R-RPRA) and `BUG-REPORT-2026-05-20-b-flake-babysit-session.md` Bug 7 (**Finding #64 R-RHFP** — "READINESS HALT false-positive surface is broad", which already names `performance` wall-budget timeouts). **BUG #1 + #3 below are fresh, sharper evidence for the existing #64 R-RHFP** (a non-empty-diff, large-repo repro with the exact mechanism pinned). **BUG #2 (external-package SDK symbols) is a genuinely new facet not in #50 / #57 / #64** and is proposed as a new finding. The grep-resolver perf root also touches **Finding #50 R-SRGT** (`scope-resolver` grep-timeout loop — #50 frames the trigger as an *empty* branch diff; this run had a non-empty 39-path diff, so the timeout has a second trigger: a large repo with many symbol refs).

---

## TL;DR

`check-readiness.ts` halted the pipeline with `status:fail`. Of 15 findings:

- **1 real defect** — `appraisal.processor.spec.ts` cited under a non-existent `__tests__/` subdir in 3 tickets (path-drift). The gate **correctly** caught this; operator fixed it. The gate works here.
- **8 `performance` findings** — "Contract resolution wall budget exceeded; remaining refs were not checked." The checker ran 67s, blew its **60s shared wall budget**, and emitted a *gate-blocking* finding for every ticket it did not get to. **A finding that means "the checker did not check this" is treated as a ticket defect.** → **BUG #1**.
- **4 `contract` findings** — `JobGetResponse.result`, `client.job.cancel`, `job.cancel` are `reductoai` SDK symbols in `node_modules`; `resolveSymbolRef` only resolves repo symbols → false "does not resolve". → **BUG #2**.
- **2 `contract` findings** — `appraisal.reducto.subschema_cancel_failed`, `appraisal.reducto.split_source_mix` are telemetry-event name literals the tickets **introduce by design**; extracted as contract refs and flagged. → **BUG #3**.

The genuine defect would have been a 30-second fix-and-relaunch. The 14 false-positives turned a working gate into a halt that *only* clears via the skip flag.

---

## BUG #1 (primary) — the contract-resolution wall budget emits gate-blocking `performance` findings when the checker is too slow

### Evidence

`check-readiness` stderr during the run, ~20×:

```
scope-resolver import walk: grep timeout status=null signal=SIGTERM error=ETIMEDOUT
```

Final result: `{"status":"fail", ..., "elapsed_ms":67476}` with 8 findings of:

```json
{"kind":"performance","analyst":"codebase",
 "message":"Contract resolution wall budget exceeded; remaining refs were not checked",
 "detail":"<symbol>"}
```

across tickets `6cf87175`, `875d0efc`, `93259c7e`, `9d951b52`, `b0414c19`,
`b6eaedbd`, `c0686bff`, `d4376804`.

### Root cause

`extension/src/bin/check-readiness.ts`:

- `DEFAULT_MAX_WALL_MS = 60_000` (`:85`).
- `createResolverCache` sets `deadline = Date.now() + maxWallMs` (`:388`) — **one shared deadline for the whole run**, created once and threaded through every ticket (`:976`, `:981`).
- In `findReadinessFindings` (`:466-490`): per contract ref, `if (Date.now() > cache.deadline)` → push a `kind:'performance'` finding and `break` (`:469-479`).
- That `performance` finding lands in the same `findings[]` array as real defects and drives `status:fail`.

So on a large repo, the per-symbol grep resolver (`scope-resolver.ts`, which is timing out per-grep with `SIGTERM`/`ETIMEDOUT`) is slow enough that the **single 60s budget is exhausted partway through the ticket set**. Every ticket whose contract-resolution starts after the deadline emits one blocking `performance` finding. The gate then fails — **because the checker could not finish in 60s**, not because any ticket is defective.

This is worst exactly where the gate matters most: large/old target repos, where the grep resolver is slowest and the ticket count is highest.

### Proposed fix

A `performance:wall_budget_exceeded` finding is **self-evidently not a ticket
defect** — it is the checker reporting its own incompleteness. It must not
contribute to `status:fail`. Options (pick one, S3):

1. **Demote `performance` findings to advisory** — exclude `kind:'performance'`
   from the blocking set; still surface them in the readiness doc as "N refs
   unverified — checker budget" so the operator sees coverage gaps.
2. **Treat budget-exceeded as a distinct non-fail exit** — e.g. exit code 3
   `readiness_incomplete`, which the pipeline-runner treats like the existing
   skip path (proceed with an audit breadcrumb) rather than `HALT`.
3. Additionally: the grep resolver's per-call `SIGTERM`/`ETIMEDOUT` thrash
   suggests `scope-resolver.ts` should cache misses and/or batch greps; 67s for
   ~40 symbol refs is the deeper perf problem. But (1)/(2) is the gate-behavior
   fix and should ship first.

---

## BUG #2 (secondary) — external-package (node_modules) symbols flagged as unresolved contracts

### Evidence

```json
{"kind":"contract","detail":"JobGetResponse.result"}
{"kind":"contract","detail":"client.job.cancel"}
{"kind":"contract","detail":"job.cancel"}
```

`JobGetResponse` / `client.job.cancel` are real, current `reductoai@0.15.0`
SDK symbols (`node_modules/reductoai/resources/job.d.ts`). The tickets
reference them legitimately — the work *uses* the Reducto SDK.

### Root cause

`resolveSymbolRef` (`check-readiness.ts`, via `scope-resolver.ts`) resolves
symbols **inside the target repo only**. A ticket that names any third-party
SDK API trips a `contract` finding. The `.readiness-allowlist.json` escape
hatch exists but requires a human to pre-curate every external API a ticket
might cite — unscalable for any ticket set that integrates an SDK.

### Proposed fix

When a contract ref does not resolve in-repo, attempt resolution against
`node_modules/**/*.d.ts` (the ref's first segment → package name heuristic:
`client.job.cancel` → look for a `reductoai`-style client; `JobGetResponse.X`
→ exported type) **before** emitting a `contract` finding. If still
unresolved, downgrade an *external-looking* ref (dotted, matches an installed
package's type surface) to advisory rather than blocking. At minimum, document
in `/pickle-refine-prd` Step 7c that SDK symbols must be allowlisted.

---

## BUG #3 (tertiary) — telemetry-event name literals a ticket introduces are extracted as contract refs

### Evidence

```json
{"kind":"contract","detail":"appraisal.reducto.subschema_cancel_failed"}
{"kind":"contract","detail":"appraisal.reducto.split_source_mix"}
```

Both are **new** structured-log event names that tickets `1c17d65a` (T2) and
`564be2c3` (T12) create — each ticket's Solution explicitly says "emit a new
`appraisal.reducto.*` event". They cannot resolve because they do not exist
yet *by design*.

### Root cause

`extractContractReferences` picks up dotted backticked identifiers; a
telemetry-event string literal (`appraisal.reducto.split_source_mix`) is
indistinguishable from a symbol ref. The forward-create annotation mechanism
(F1, v1.75.5 — `(forward-created by ticket <hash>)`) would suppress these, but:

1. The `/pickle-refine-prd` Step 7c ticket template does **not** prompt the
   author to annotate new event names, so it is an easy authoring miss (it was
   missed here — operator-authored tickets).
2. An event-name *string literal* is arguably not a "contract" that
   symbol-resolution should apply to at all.

### Proposed fix

Either (a) teach `extractContractReferences` to skip refs that match a
telemetry-event shape (`<ns>.<ns>.<snake_case>` appearing inside a
`logger.log`/event context, or simply any all-lowercase dotted literal that is
not a `Type.member` PascalCase ref), or (b) add a line to the Step 7c template
instructing authors to annotate ticket-introduced event names with the
forward-create annotation. (a) is more robust.

---

## What the operator did to recover

1. Fixed the one real defect — corrected `appraisal.processor.spec.ts`'s path
   in tickets `c0686bff`, `9d951b52`, `fd774b8e` (it is a sibling of
   `appraisal.processor.ts`, not under `__tests__/`).
2. Re-ran `check-readiness` — confirmed the remaining 14 findings are all
   BUG #1/#2/#3 false-positives.
3. Set `state.flags.skip_quality_gates_reason` with a per-finding audit-trail
   reason.
4. Reset `state.json` (`step=research`, `current_ticket=c0686bff` — the failed
   run had advanced it to `step=completed`/`current_ticket=null`; **note**:
   a halted-at-readiness run should arguably NOT mark state `completed`).
5. Relaunched — second launch cleared readiness and dispatched the first
   pickle worker.

### Minor observation (not a numbered bug)

After `Phase pickle failed (exit 1)`, `state.json` was left `step:completed,
current_ticket:null`. A pipeline that halted at the readiness gate without
running a single worker has not "completed" anything; the operator had to
manually reset state before relaunch. Consider leaving `step` untouched (or
`research`) on a readiness HALT.

---

## Proposed findings

| Facet | Disposition | Severity |
|---|---|---|
| BUG #1 — `performance:wall_budget_exceeded` findings block the gate (checker fails the gate for its own slowness) | **Fresh evidence for existing Finding #64 R-RHFP** — append this repro; #64 already names "`performance` wall-budget timeouts". The fix (demote `performance` to non-blocking) belongs in the R-RHFP / B-BABYSIT-FIX work. | S3 |
| BUG #2 — external-package (node_modules) SDK symbols flagged as unresolved `contract` findings | **NEW — propose Finding #65 R-RCEX.** Not covered by #50 / #57 / #64. `resolveSymbolRef` has no node_modules resolution; `.readiness-allowlist.json` requires per-API manual curation. | S3 |
| BUG #3 — ticket-introduced telemetry-event name literals extracted as contract refs | **Fold into #64 R-RHFP** (same false-positive-extraction class) — the fix is `extractContractReferences` skipping event-name-shaped literals, or a Step 7c template line. | S4 |
| grep-resolver `SIGTERM`/`ETIMEDOUT` thrash (the perf root of BUG #1) | **Touches Finding #50 R-SRGT** — #50's fix (per-grep + total-retry caps) should also cover the non-empty-diff large-repo case seen here. | S3 |

Suggested handling: **#64 R-RHFP** is already queued for **B-BABYSIT-FIX**;
BUG #1 + #3 ride along as additional repro. **Propose #65 R-RCEX** as a new
P3 finding for the external-package gap, foldable into the same
`check-readiness` contract-resolution hardening work (it is one `resolveSymbolRef`
change). The single highest-value fix is demoting `kind:'performance'` out of
the blocking set — that alone turns this run's halt into a pass.

## Repro

1. `/pickle-pipeline` (or `/pickle-tmux`) on a refined PRD with ~16 tickets
   targeting a large monorepo package (`loanlight-api/packages/api`).
2. Tickets that legitimately cite third-party SDK symbols and introduce new
   structured-log events.
3. PICKLE phase halts at `READINESS HALT: check-readiness exited 1` within
   ~1-2 min; `elapsed_ms` ≈ 60-70s; findings include `kind:'performance'`
   "wall budget exceeded" rows.
