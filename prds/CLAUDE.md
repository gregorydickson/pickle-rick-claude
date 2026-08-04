# PRD Authoring Guide

This file documents conventions for authors writing PRDs and tickets under `prds/`.

---

## Simplification Review (subtract-before-add) — REQUIRED in every bug/feature-bundle PRD

The recurring failure of this codebase is **two-pronged**: we keep *adding* complexity (new guards,
gates, escape hatches, recovery recipes), and the complexity we already added is *brittle* (it
false-positives, so we band-aid it instead of removing it — e.g. R-ATBG, the over-strict ticket-audit
gate). A fix that adds a guard around a brittle guard makes both worse. This section forces the
subtraction question **before** tickets lock the approach. It is the authoring-time arm of the W5b
`subtract-before-add` governance in `extension/CLAUDE.md` — and, true to that rule, it is a **doc
discipline, not a new runtime gate** (do not build enforcement machinery to police simplification).

Every bundle PRD MUST carry a `## Simplification Review` section answering all four, per workstream:

1. **Is the addition necessary at all?** State what new code/guard/flag/state-field the workstream
   adds. If it adds nothing (pure removal/reconcile), say so — that is the ideal and needs no further
   justification.
2. **Can it REUSE instead of ADD?** Is there an existing primitive (`salvageTicket`,
   `reconcileTicketTruth`, the R-RTRC-4 path normalizer, the unified `skip_quality_gates_reason`, an
   eslint/prettier autofix, the existing implement-loop) that already does this? Adding a parallel
   mechanism beside an existing one is the smell. Name the reuse or justify why it cannot.
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** If the bug is "an
   existing gate/guard false-blocks," the default fix is to **loosen or remove that gate**, NOT add a
   second escape hatch around it (two hatches for one guard = the guard is wrong). Identify the brittle
   thing this issue touches and whether the honest fix is to delete/demote it.
4. **What can this issue SUBTRACT?** Every bundle should leave the system *smaller or flatter* where it
   can — a removed flag, a collapsed code path, a demoted-to-advisory check, a deleted dead branch.
   State the subtraction, or explicitly record "no subtraction available" with a reason.

**Worked contrast (from the 2026-06-16 issue review):**
- `R-ATBG` ✅ — pure subtraction: reuse the existing R-RTRC-4 normalizer, cap noise, demote a warning to
  advisory. No new machinery.
- `B-GA` WS-1 ✅ — subtraction: flip the source default + reconcile docs; defer the whole propagation
  mechanism rather than build it.
- `B-GA` WS-2 ⚠️ — challenge before building: rung-3 clean-tree recovery could **re-queue to `Todo` and
  reuse the existing implement loop** instead of a new executor branch; R-WPEX could
  **phase-decompose** (removing the >600s silent-death class) instead of adding a tmux router around it.
- `B-CGCAP` ⚠️ — the install.sh propagation **sidecar is new machinery**; the simpler subtraction is to
  force-override codegraph defaults like `auto_update_enabled` already does, or default-on fresh
  installs only.
- `B-CSOR` ⚠️ — a finding-classifier + hand-fix class for one construct is new machinery; the
  subtraction is to leave brace-free-`if` to **eslint/prettier autofix** (existing tooling).

A PRD whose `## Simplification Review` only ever answers "necessary, no reuse, no subtraction" for every
workstream is a red flag that the author skipped the challenge — reviewers should push back.

---

## Skip-Flag Conventions

When a PRD or ticket needs to bypass the readiness gate and/or the ticket-audit gate, use the **unified** flag only:

```
state.flags.skip_quality_gates_reason: "<non-empty reason string>"
```

A non-empty trimmed string in `skip_quality_gates_reason` is the **single operator-facing quality-gate bypass surface** (W1a). It bypasses every quality gate with one flag:

- the readiness gate (R-QGSK-1),
- the ticket-audit gate (R-TAQ-3),
- the bundle-bootstrap exemption (R-BUNDLE-1 — allowlisted sessions write this flag, not the legacy per-gate reasons), and
- the refinement **AC-shape gate** (`spawn-refinement-team.ts`) — the `--skip-ac-shape-gate "<reason>"` CLI flag folds into the same surface.

The reason is recorded as an audit-trail activity event.

### Single surface — no legacy flags

`skip_quality_gates_reason` is the ONLY quality-gate skip flag. The retired per-gate flags (`skip_readiness_reason`, `skip_ticket_audit_reason`), their read-time fallback, the read-time auto-migration, and the `skip_flag_legacy_used` event were deleted in the guard-layer prune (item e) — both gates they bypassed are advisory (R-GATE-ADVISORY), so the bypass only silences advisory findings. Old sessions may still carry the retired keys in `state.flags`; they are **inert** (never read, never migrated, schema-neutral). PRDs and tickets **MUST** cite `skip_quality_gates_reason` only.

- **AC-shape gate** — an explicit `--skip-ac-shape-gate "<reason>"` CLI override wins over the persisted unified flag; otherwise the unified flag bypasses the gate.

### NOT a quality-gate flag (scoped out)

`state.flags.skip_smoke_gate_reason` (R-CNAR-6) bypasses the **spark-codex backend health gate**, not a quality gate. It is a **distinct** flag and is intentionally NOT collapsed into `skip_quality_gates_reason`.

### Source of truth

- Runtime call site: `mux-runner.ts:resolveQualityGateSkipReason` — reads the unified flag only.
- AC-shape fold-in: `spawn-refinement-team.ts:runAcShapeEnforcement` — honors the CLI flag then the unified state flag.
- Tests: `extension/tests/one-skip-surface.test.js` (single-surface invariants + retired-key inertness).

---

## Self-modifying-recovery bundles (R-PSRB attended protocol)

**NEVER hand-build. ALWAYS run a pipeline** (see `CLAUDE.md` → "NEVER hand-build"). The hand-build
exception that used to live in this section was **deleted by operator decision 2026-08-04**. There is
no bundle in this repo that is built by hand — the salvage path least of all, because it is the code
we have the least evidence about.

**The hazard is real.** For bundles editing the **salvage / completion-evidence / Done-flip path** —
`mux-runner.ts` salvage/no-progress logic, `salvage-ticket.ts`, `reconcile-ticket-truth.ts`,
`ticket-completion-evidence.ts` — the deployed (pre-fix) runtime applies that same logic to the worker
building the fix and can salvage-reset / fatal it (**R-PSRB**, B-PCOMP 2026-06-21:
`prds/BUG-REPORT-2026-06-21-pipeline-self-referential-build-catch22-and-orphan-mux.md`).

**Protocol for a genuine salvage-path bundle — run it ATTENDED:**
1. Flag the PRD `build_mode: attended` and name the seam the deployed bug lives on.
2. Launch normally (`/pickle-pipeline`). Do not tier-dodge, do not split the build, do not hand-apply
   the load-bearing ticket.
3. Watch that seam. If the deployed bug bites the worker, **recover the wedge and record it** — that
   wedge is a field-grade defect report on the exact code the bundle is fixing, and it is worth more
   than the time it costs. Standing recovery recipes apply (commit verified work before any respawn;
   never unscoped `git restore`).
4. Optionally `install.sh`-deploy mid-bundle once the fix lands, so remaining tickets run on the
   repaired runtime. That is a deploy choice, not a build path.

**Precedent:** B-RASO (beta.43) shipped a salvage-path fix through an attended pipeline. B-GTRUTH's
self-build hit the very WS-A2 wedge it shipped the fix for, was recovered clean, and the wedge became
the bundle's strongest corroborating evidence. Non-salvage bundles (spawn-gate, routing, phase-exit,
scope-fence, refinement, features) are pipeline-safe and run **unattended** — a running pipeline
executes deployed JS, not your source diff, which lands only at `install.sh`.

---

## Pre-launch stale-premise check (MANDATORY — earned by B-PSCG, 2026-07-12)

Before authoring or launching any bug/fix bundle, grep HEAD **and the deployed tree**
(`~/.claude/pickle-rick/extension/`) for the finding's most distinctive artifact — its log
string, guard, or R-code annotation. A finding is "open" only if its artifacts are ABSENT from
both. B-PSCG was authored, refined, and nearly launched for a fix that had shipped ten days
earlier (`2bbf5770`) — one grep would have caught it.

Two further authoring rules, same provenance:
- **Recoverability line.** A PRD that HEALS a state field must state: *"is this value still
  recoverable at the seam where the heal fires?"* (`prd_path`: yes — time-invariant.
  `start_commit`: no — the build destroys it; and check whether a CO-STAMPED field already
  holds it, e.g. `pinned_sha`.)
- **Contract-match artifact.** When a Simplification Review mandates reuse of a primitive
  ("REUSE if its contract fits"), the research phase MUST print both contracts side by side and
  assert the match IN THE RESEARCH ARTIFACT. An unanswered mandatory check in a shipped PRD is
  a process failure. (B-PSCG asked the question, nobody answered it, and a review-base
  primitive shipped as a session baseline — 97 commits wrong.)

## Green-tree precondition (MANDATORY — earned by R-WGVI/R-PLGR, 2026-07-15)

The stale-premise check above asks *"is this fix still needed?"* It never asks *"is the ground I'm building
on solid?"* — and B-FOMC launched onto a branch whose fast tier was already red (a trap-door entry over its
char cap, red since before the bundle existed). Every worker then inherited a gate that was red for a reason
it did not cause, and **no downstream gate verdict could be attributed** (R-WGVI: the unattributable-red and
the vacuous-green both trace to launching onto un-green ground).

**Before launching any bug/fix bundle, the release-gate fast tier MUST be green on the launch commit:**

```
cd extension && npm run test:fast
```

- A red tier is a **HARD STOP**. Either fix it first, or explicitly record the failures as *inherited*
  (name the commit that introduced them, per the stale-premise discipline) before launching — a bundle
  launched onto a red tree cannot tell its own breakage from the debt it inherited.
- Run the check **once on a quiet box**. Overlapping `test:fast` runs self-inflict timeout-shaped flakes in
  the `runGate`/hang-guard suite; a lone re-run at rest is authoritative (cf. the c=8 concurrency-flake note).
- This is a **doc-discipline precondition, not a new blocking gate** — do not build launch-blocking machinery
  to enforce it (that would false-block on a genuine flake, e.g. the `spawnSync ps ENOBUFS` case already
  living in the tier). Same posture as the Simplification Review: a rule authors follow, not a runtime lock.
