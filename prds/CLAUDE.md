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

## Forward-Reference Annotation Grammar

When a ticket or PRD references a file path that does not yet exist at `HEAD` (because a sibling ticket in the same bundle will create it), you **must** annotate the backticked path with one of the three canonical forms below. These annotations tell `check-readiness.ts`, `audit-ticket-bundle.ts`, and the pre-flight audit script (`audit-ticket-forward-refs.sh`) that the path is intentionally forward-created, not a typo.

**Regex source of truth**: `extension/src/services/forward-ref-annotation.ts` (R-FRA-6 module — `FORWARD_REF_ANNOTATION_RE`). Enforcement points are in `extension/CLAUDE.md` under trap doors R-RTRC-1, R-RTRC-2, R-RTRC-7, and R-FRA-6.

### Rules

- The annotation goes **outside** the backticks (after the closing backtick).
- There must be **exactly one ASCII space** between the closing backtick and the opening parenthesis.
- Ticket hashes must match `/^[A-Za-z0-9]{6,12}$/` (8-char short SHA or ticket-dir basename are both accepted).

### Form 1 — `(forward-created)`

Use when **this ticket** creates the file and no upstream ticket hash exists yet.

```
`path/to/new-file.ts` (forward-created)
```

**Worked example** (ticket that creates a new service module):

> Files to create:
> - `extension/src/services/forward-ref-annotation.ts` (forward-created)

---

### Form 2 — `(created by ticket <8hex>)`

Use when a **specific upstream ticket** in the same bundle creates the file. Replace `<8hex>` with that ticket's 8-character id.

```
`path/to/new-file.ts` (created by ticket <8hex>)
```

**Worked example** (ticket that consumes a module created by ticket `a1b2c3d4`):

> Files to modify:
> - `extension/src/bin/check-readiness.ts` — import from `extension/src/services/forward-ref-annotation.ts` (created by ticket a1b2c3d4)

---

### Form 3 — `(introduced by ticket <8hex>)`

Synonym of Form 2. Accepted for natural prose flow when "introduced" reads more clearly than "created".

```
`path/to/new-file.ts` (introduced by ticket <8hex>)
```

**Worked example** (same scenario as Form 2, prose variant):

> The predicate in `extension/src/services/forward-ref-annotation.ts` (introduced by ticket a1b2c3d4) must be imported by both `check-readiness.ts` and `audit-ticket-bundle.ts`.

---

### Cross-links

The enforcement points that validate these annotations at runtime are documented as trap doors in `extension/CLAUDE.md`:

- **R-RTRC-1** — `spawn-refinement-team.ts` `PATH_VERIFICATION_PROMPT_SECTION`: analysts receive the same grammar at refinement time.
- **R-RTRC-2** — `check-readiness.ts` `extractContractReferences`: annotated paths are suppressed from `path_not_verified` findings.
- **R-RTRC-7** — `check-readiness.ts` annotation schema: canonical separator, hash, and alias rules.
- **R-FRA-6** — `extension/src/services/forward-ref-annotation.ts`: single source for `FORWARD_REF_ANNOTATION_RE`; both `check-readiness.ts` and `audit-ticket-bundle.ts` import from it.
- **R-FRA-2** — `extension/scripts/audit-ticket-forward-refs.sh`: pre-flight script delegates to the same module.
- **R-FRA-1** — `.claude/commands/pickle-refine-prd.md` Step 7c: refinement skill shows the same reminder.
- **R-RTRC-7 / R-TAQ-2** — `audit-ticket-bundle.ts` `checkPathDrift`: bundle audit accepts the same forms.

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

### Conflict-resolution rule (unified wins)

When BOTH the unified flag and a legacy/CLI per-gate flag are present, the **unified `skip_quality_gates_reason` wins**:

- **Read time** — `mux-runner.ts:resolveQualityGateSkipReason` reads the unified flag first; a per-callsite legacy field is consulted **only** when the unified flag is empty.
- **Migration** — `state-manager.ts:migrateLegacySkipQualityGatesFlags` is one-way: when the unified flag is already set it **drops** both legacy fields; when it is empty it **promotes** the first non-empty legacy reason (readiness over ticket-audit) into the unified flag and drops both legacy fields.
- **AC-shape gate** — an explicit `--skip-ac-shape-gate "<reason>"` CLI override wins over the persisted unified flag; otherwise the unified flag bypasses the gate.

### Legacy flags (deprecated — do not use in new tickets)

| Legacy field | Replaces |
|---|---|
| `state.flags.skip_readiness_reason` | readiness gate only |
| `state.flags.skip_ticket_audit_reason` | ticket-audit gate only |

Both legacy flags still work at runtime: `mux-runner.ts` reads them as a fallback (R-QGSK-2) with a deprecation warning, and `state-manager.ts` auto-migrates them into `skip_quality_gates_reason` on the first state read (R-QGSK-3). New PRDs and tickets **MUST** cite `skip_quality_gates_reason`; legacy fields will be removed in a future schema version.

### NOT a quality-gate flag (scoped out)

`state.flags.skip_smoke_gate_reason` (R-CNAR-6) bypasses the **spark-codex backend health gate**, not a quality gate. It is a **distinct** flag and is intentionally NOT collapsed into `skip_quality_gates_reason`.

### Kill-switch

`PICKLE_RECOVERY_CONSOLIDATION=off` reverts the bundle-bootstrap exemption to the legacy per-gate dual-write and disables the AC-shape unified-flag fold-in (CLI flag only). Default (unset / any other value) keeps the single-surface behavior active.

### Source of truth

- Runtime call site: `mux-runner.ts:resolveQualityGateSkipReason` — reads unified flag first, falls back to per-callsite legacy field with `skip_flag_legacy_used` activity event.
- Migration: `state-manager.ts:migrateLegacySkipQualityGatesFlags` — one-way promotion on every `StateManager.read()`.
- AC-shape fold-in: `spawn-refinement-team.ts:runAcShapeEnforcement` — honors the CLI flag then the unified state flag.
- Tests: `extension/tests/state-manager-skip-flags-migration.test.js` (AC-4 a..e), `extension/tests/one-skip-surface.test.js` (W1a single-surface invariants).

---

## Self-modifying-recovery bundles (R-PSRB build protocol)

**Dogfood by default (see `CLAUDE.md` → Dogfood).** Hand-build is the NARROW exception below, not the rule for any mux-runner edit.

The catch-22 applies ONLY to the **salvage / completion-evidence / Done-flip path** — `mux-runner.ts`
salvage/no-progress logic, `salvage-ticket.ts`, `reconcile-ticket-truth.ts`,
`ticket-completion-evidence.ts`. The deployed (pre-fix) runtime applies that same logic to the worker
building the fix and salvage-resets / fatals it (**R-PSRB**, B-PCOMP 2026-06-21:
`prds/BUG-REPORT-2026-06-21-pipeline-self-referential-build-catch22-and-orphan-mux.md`). Spawn-gate /
routing / phase-exit / scope-fence edits are pipeline-safe — the running pipeline executes deployed JS,
not your source diff (lands only at `install.sh`).

**Protocol for a genuine salvage-path bundle:** flag it self-modifying-recovery; hand-build the
load-bearing recovery-path tickets in-process (or build then `install.sh`-deploy incrementally so the
rest runs on the fixed runtime). First try to dissolve it: tier the load-bearing ticket so it dodges the
deployed bug (e.g. `large` → detached path). Non-salvage tickets build normally.
