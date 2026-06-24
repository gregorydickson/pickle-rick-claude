---
title: "B-DSAN2 — Design Ground-Truth & Validation-Proportionality (R-DSAN efficacy follow-up)"
status: PLAN
priority: P1
type: bug-bundle
composes: [R-DSAN-residual, R-RGO-115, R-PPA-116, R-CPRO, R-XSPA-2-113]
created: 2026-06-14
reviewed_by: [requirements-testability, codebase-grounding, risk-adversarial, codex-adversarial]
source_prds:
  - prds/p1-design-simplification-and-autonomy-2026-06-13.md
  - prds/archive/bug-reports/BUG-REPORT-2026-06-14-readiness-gate-overblocks-pipeline.md
  - prds/archive/bug-reports/BUG-REPORT-2026-06-14-premature-phase-advance-and-green-ticket-gate-starvation.md
---

# B-DSAN2 — Design Ground-Truth & Validation-Proportionality

## Why now (the thesis)

R-DSAN shipped in **v2.0.0-beta.3** this morning (close-out `e65f219f`, 07:54Z) and the **very next pipeline (B-CGH, 08:08Z) hit three fresh bugs of exactly the classes R-DSAN targeted** (B-RGO #115 readiness over-block / D1; B-PPA #116 premature-advance + gate-starvation / D2; R-CPRO config-protection read-block / D1). Root cause of the recurrence: R-DSAN's W1/W2/W4 were **de-scoped during the B-RRH merge into thin deltas** — the D3 simplification-debt failure it warned about. The promise *"consolidate the seams so seam N+1 inherits the fix"* did not hold because **there is no machine-enforced single chokepoint for completion/validation authority** — every new seam re-invents a proxy (codex P0 finding).

This bundle does R-DSAN's job for real and **proves it holds**: ground every completion/validation decision in ground truth, route them through the EXISTING canonical machinery (not a parallel guard), and add a **source-grep invariant** that fails the build if any future seam bypasses it.

> **Review note (4 reviewers, all anchors verified at HEAD).** Corrections folded: (a) `haltOrRecover` does NOT exist as a general primitive — only codex-scoped `haltOrRecoverCodexNoProgress` (`mux-runner.ts:4896`); the real primitives are `reconcileTicketTruth` (`src/lib/reconcile-ticket-truth.ts:84`) + `salvageTicket` (`src/lib/salvage-ticket.ts:117`). (b) Pickle completion ALREADY has an all-tickets-terminal path via `evaluateEpicCompletion` (`mux-runner.ts:1929`) + `applyAllTicketsDoneCompletion` (`:4014`) — AC-A1 integrates with it, no parallel guard. (c) The c=8 `check-flake-budget` is NOT in `runWorkerGate` (`spawn-morty.ts`) — AC-A3 must name the real call site or be struck. (d) config-protection over-block lives in `isBashTargetingConfig`/`detectTargetedConfigFile` (the line-877 read-or-write gate), NOT `detectBashStateWriteTarget` (already write-only). (e) `buildBundleCreationIndex` has TWO impls (`check-readiness.ts:379` + `audit-ticket-bundle.ts:370`).

## Non-Goals
- Reverting shipped R-DSAN code (additive grounding only). Touching B-CGH (in flight; drains after). New features. New `state.flags` skip surfaces (forbidden — `audit-skip-flag-unification.sh`).

## Workstreams

### WS-A — Ground-truth completion (closes B-PPA #116 + folds #113 R-XSPA-2; fixes D2)
- **AC-A1 (integrate, don't duplicate):** pickle-phase success is decided ONLY by the existing completion state machine — `evaluateEpicCompletion` / `applyAllTicketsDoneCompletion` keyed on **all tickets terminal** (`Done`/`Skipped`; zero `Todo`/`In Progress` via `findPendingNonCurrentTickets`). `pipeline-runner` MUST NOT treat a raw mux exit-0 as success when pending tickets remain → stamps `pipeline_phase_incomplete` (exit 3, `PipelineRunnerExitCode.PhaseIncomplete`). This is the SAME guard that #113 R-XSPA-2 needs for the signal path — **one `findPendingNonCurrentTickets`-based check covers both clean-exit AND signal exit; #113 folds into this AC, no second guard.** Verify: `extension/tests/pipeline-runner-halt-on-incomplete.test.js` (extend) — mux exit-0 with ≥1 pending → `pipeline_phase_incomplete`, no advance.
- **AC-A2 (mux):** `mux-runner` MUST NOT exit 0 with pending tickets — a clean manager exit (end_turn/max-turns) with pending routes through `evaluateManagerRelaunch` (R-MMTR-3); only `evaluateEpicCompletion`-confirmed all-terminal exits 0. Verify: `mux-runner` exit-path test asserting the `evaluateEpicCompletion` decision gates exit 0.
- **AC-A3 (de-flake the per-ticket completion gate — REAL call site required):** the c=8 `check-flake-budget` (`test:fast:budget`) is NOT in `runWorkerGate`; the starvation came from a per-ticket/between-ticket invocation. Refinement MUST first locate the actual call site (candidates: `runBetweenTicketFastGate`/`runBetweenTicketFastTests` in `mux-runner.ts`, or the manager prompt template) and EITHER remove the c=8 budget from the per-ticket loop (it is a once-per-bundle release/CI gate) OR, if none exists, strike this AC. Per-ticket completion keys on the deterministic `runWorkerGate` (`tsc`+`eslint`+`test:fast`), never a flake probe. Verify: grep the located call site shows no `--test-concurrency=8`/`check-flake-budget` in the per-ticket path; a ticket green on `runWorkerGate` completes. **If no per-ticket flake-budget call site is found, this AC resolves as "confirmed absent" + a regression locking it absent.**
- **AC-A4 (bounded terminal escape — prevents the never-advance twin-wedge):** when AC-A1 holds an incomplete phase across N consecutive no-progress relaunches (no ticket-state delta), force the unreclaimable `In Progress` ticket to a terminal disposition via `salvageTicket`/`reconcileTicketTruth` (drawing down the persistent `recovery_attempts` ledger so it survives relaunch) and advance/halt deterministically — never spin. Verify: regression — exit-0-with-unreclaimable-In-Progress → bounded escape to terminal, pipeline advances or halts deterministically, does NOT loop.

### WS-B — Proportional validation: symmetric suppression (closes B-RGO #115; fixes D1)
- **AC-B1 (suffix-symmetric suppression, BOTH impls):** forward-created suppression mirrors `resolvePathRef`'s `(?:^|/)<ref>$` suffix-match — `extension/tests/X` declared suppresses a `tests/X` reference and vice versa — in BOTH `buildBundleCreationIndex` impls (`check-readiness.ts:379` AND `audit-ticket-bundle.ts:370`) for gate parity (R-FRA-6). Teeth: a ref matching no declared/HEAD suffix still flags. Verify: extend `check-readiness-forward-ref-fixture.test.js` with the B-CGH `tests/X`↔`extension/tests/X` shape (both directions + the genuine-phantom negative).
- **AC-B2 (repo-prefix normalize):** `<repo>/x` → `x` when `<repo> === basename(repoRoot)` before resolution. Verify: fixture with the B-CGH `pickle-rick-claude/CLAUDE.md` shape resolves.
- **AC-B3 (NO advisory tier — collapse it):** `ReadinessFinding` has no `confidence` field; do NOT invent one and do NOT blanket-advisory the `file_path` kind. A `file_path` finding is hard-halt ONLY when its ref suffix-matches no declared-forward-created AND no HEAD path (a true phantom); otherwise AC-B1/B2 auto-suppress it. `contract`/phantom kinds stay hard-halt. This is the entire graduated behavior — deterministic, no third class. Verify: fixture — suffix-matching forward-created ref → suppressed (exit 0); genuine phantom path → hard-halt (exit 2).
- **AC-B4 (observability ONLY, non-blocking):** add a readiness false-positive counter to the W5c `/pickle-metrics` dashboard, fed by a new activity event emitted when a prior readiness finding is suppressed on a re-run after a no-behavior ticket edit. This is NOT the fix (the fix is AC-B1/B2/B3 loosening) — it only catches the NEXT over-broad guard. Verify: `metrics.ts` test mirroring `buildSkipFlagBudgetReport`; the event name is named in the AC.

### WS-C — Config-protection: write-aware config gate (R-CPRO; fixes D1)
- **AC-C1 (name the real detector, make it write-aware):** the over-block is `detectTargetedConfigFile`→`isBashTargetingConfig` (the line-877 gate that blocks ANY token matching a protected file/glob, read OR write). Make config-file matches write-aware — block only when a write redirect (`>`/`>>`/`>&`/`>|`)/`tee`/`cp`/`mv`/`rsync`/editor targets the protected path (reuse `detectBashStateWriteTarget`'s write-detection). Read-only commands (`grep`/`ls`/`stat`/`cat` over the data root or a config basename) are approved. Verify: unit test asserts `detectTargetedConfigFile` returns null for read-only commands.
- **AC-C2 (regression):** approved — `grep -l '...' sessions/*/state.json`, `ls -lt $S/`, `stat $S/state.json`, `cat tsconfig.json`; blocked — `echo x > .../state.json`, `cp x .../pickle_settings.json`, `tee tsconfig.json`. Verify: `config-protection.test.js` cases.

### WS-D — Make the design durable (the meta-fix that R-DSAN missed)
- **AC-D1 (seam-coverage table, zero doc-only bypass for the 3 incident seams):** a checked-in `extension/docs/completion-validation-seams.md` enumerating each WS-A/B/C seam × {routed-through-canonical-authority | documented-exception}. The three incident seams (pickle clean-exit completion, readiness forward-ref suppression, config-protection read) MUST route through canonical authority — **zero doc-only exits allowed for these three**. Scope to the real primitives (`reconcileTicketTruth`/`salvageTicket` + the `evaluateEpicCompletion`/`applyAllTicketsDoneCompletion` machinery + pipeline-runner halt); note `haltOrRecover` is codex-only. Verify: grep asserts the three seams call the canonical functions.
- **AC-D2 (single-owner regression corpus):** ONE committed corpus under `extension/tests/` encoding all three incidents as **fail-without-fix** tests (premature-advance exit-0-with-pending; readiness suffix-asymmetry false-positive; config-protection read-block). WS-A4/B/C ACs reference these fixtures rather than re-declaring them (no double-ownership). Each test MUST fail on today's HEAD and pass only after the fix.
- **AC-D3 (enforcement spine — source-grep, not stub-satisfiable):** `extension/scripts/audit-design-ground-truth.sh`, wired into the CLAUDE.md gate command + `ci.yml` + `release.yml`, FAILS the build on any of the three proxies appearing as source patterns: (i) a pickle/phase success keyed on a raw mux exit code outside `evaluateEpicCompletion`, (ii) `check-flake-budget`/`--test-concurrency=8` in the per-ticket path, (iii) exact-string-only forward-ref membership (suffix-match absent) in either `buildBundleCreationIndex`.
- **AC-D4 (codex P0 — completion-authority single-source-of-truth invariant):** a trap-door invariant in `extension/CLAUDE.md` + a regression test (`completion-authority-single-source.test.js`) that FAILS if any success/terminal `status: Done`/`Skipped` or phase-success outcome is produced outside the canonical `evaluateEpicCompletion`/`applyAllTicketsDoneCompletion` (+ `guardCompletionCommitBeforeDone`) authority. Without this, the bug class migrates to the next new file — this is what makes B-DSAN2 durable where R-DSAN was hollowed.

### WS-E — Governance: re-ship de-scoped remnants, no new guards (fixes D3)
- **AC-E1 (enumerate + ship absent W1/W5 items):** refinement diffs the R-DSAN PRD's W1/W5 AC list against HEAD and produces ONE ticket per item still absent (each with its own oracle). Enumerated, not "verify against the list."
- **AC-E2 (subtract-before-add compliance, observability only):** WS-B/WS-C ARE the subtraction (loosen the over-blocking guards). AC-E2 adds NO new guard, NO new `state.flags` field, NO new skip surface — assert via `audit-skip-flag-unification.sh`. The B4 metric is the only addition and is non-blocking.

## Pre-launch / pre-ship verification (anti-inert-ship)
After the build, grep HEAD: `isBashTargetingConfig` (must be write-aware), the `file_path` hard-halt filter in `check-readiness.ts` (must be suffix-predicate), both `buildBundleCreationIndex` impls (must suffix-match), and `audit-design-ground-truth.sh` (must exist + be gate-wired). If any is unchanged → the bundle shipped inert; do not release.

## Risks
| Risk | Mitigation |
|---|---|
| Loosening readiness/config-protection hides a real defect | Teeth preserved (genuine phantom → hard-halt AC-B3; protected-file WRITES still blocked AC-C1); fail-without-fix corpus (D2) proves both directions |
| All-tickets-terminal creates a never-advance wedge (twin of #116) | AC-A4 bounded terminal escape via `salvageTicket`+`recovery_attempts` ledger; `Skipped` counts terminal |
| B-DSAN2 itself gets de-scoped like R-DSAN | AC-D3 source-grep gate + AC-D4 invariant fail the build if the fix is inert; pre-launch grep checklist |
| AC-A3 targets a non-existent call site | AC-A3 requires locating the real site first, else resolves as "confirmed absent + locked" |
| Overlap with #113 R-XSPA-2 | AC-A1 supersedes it (one guard, both paths); close #113 as folded |

schema_neutral: true. Backend: claude. Drain order: WS-A → WS-B → WS-C → WS-D (D4 invariant last, gates the rest) → WS-E → closer.
