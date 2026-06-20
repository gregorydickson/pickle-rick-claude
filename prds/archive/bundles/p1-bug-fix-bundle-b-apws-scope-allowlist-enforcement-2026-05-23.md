---
title: P1 — Bug-fix bundle 2026-05-23 — B-APWS scope-allowlist enforcement (regression coverage + observability)
status: Draft
filed: 2026-05-23
priority: P1
type: bug-bundle
r_code_prefix: R-APWS
composes:
  - prds/archive/bug-reports/p2-anatomy-park-worker-edits-bypass-scope-allowlist.md
related:
  - prds/MASTER_PLAN.md
  - docs/closer-ticket-manager-handoff.md
backend_constraint: any
refine: true
unattended: true
remediation_phases_required: ["citadel", "anatomy-park", "szechuan-sauce"]
---

# PRD — Bug-Fix Bundle 2026-05-23 — B-APWS Scope-Allowlist Enforcement

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Why this bundle

MASTER_PLAN.md (`prds/MASTER_PLAN.md:67`, `:127`) promotes Open Finding #11
R-APWS from P2 to **P1** on 2026-05-23 because `scope.json:allowed_paths`
enforcement is a **security boundary** — silent bypass is the worst-case
failure. The source PRD
(`prds/archive/bug-reports/p2-anatomy-park-worker-edits-bypass-scope-allowlist.md`, 2026-05-08)
documented the triggering session `2026-05-08-5d60b760`, in which the
codex anatomy-park worker leaked a single out-of-scope file
(`packages/api/src/modules/portal-appraisal/portal-appraisal.service.spec.ts`)
into commit `fe927181a` despite a strict 91-path `scope.json` allowlist.

**This bundle is REGRESSION COVERAGE + OBSERVABILITY TESTING for already-shipped work.**
F1 (preflight binary), F2 (activity event + `/pickle-status` rendering), and
F3 (worker prompt clauses) are all live at HEAD `59810646`. What is NOT live
is end-to-end regression coverage that proves the wiring continues to work,
plus a worker-prompt-ordering trap door that catches future template edits
that would silently move the preflight call out from between
"tests pass" and "git commit".

| Shipped (do NOT re-implement) | Evidence at HEAD `59810646` |
|---|---|
| F1 `check-scope-diff.js` preflight binary | `extension/src/bin/check-scope-diff.ts` (147 lines), compiled `extension/bin/check-scope-diff.js` |
| F1 unit tests (AC-APWS-1/2/3) | `extension/tests/check-scope-diff-preflight.test.js`, `extension/tests/check-scope-diff-emits-event.test.js` |
| F2 `worker_edit_outside_scope` registered | `extension/src/types/index.ts:586` in `VALID_ACTIVITY_EVENTS` |
| F2 `/pickle-status` `renderScopeDrift` | `extension/src/bin/status.ts:109` (defined) + `extension/src/bin/status.ts:190` (wired) |
| F2 first-pass output rendering test | `extension/tests/pickle-status-scope-drift.test.js` (3 tests; covers ticket-id scoping) |
| F3 anatomy-park preflight wiring | `.claude/commands/anatomy-park.md:372` Phase 2 step 4.5 |
| F3 szechuan-sauce preflight wiring | `.claude/commands/szechuan-sauce.md:396-405` Override 7 block |
| Trap-door pins | R-APWS-6 (preflight invariant), AC-APWS-1 emission (payload quartet) in `extension/CLAUDE.md` |

## Bundle thesis

> "Scope-allowlist enforcement is load-bearing; every worker commit invocation MUST be preceded by `check-scope-diff.js` and every leak event MUST surface in operator-visible telemetry. Today the gate ships; the regression coverage and `/pickle-status` rendering test do not."

If a section's fix isn't structurally aligned with that thesis, drop it.

## Backend constraint

`backend_constraint: any`. This is regression coverage for an already-shipped
gate; backend selection is irrelevant to the test surface. Operator may pass
`--backend codex` or `--backend claude` interchangeably.

## Current state vs target state

| Sub-fix | Acceptance criterion | HEAD state | Gap |
|---|---|---|---|
| F1 preflight | AC-APWS-1 (preflight binary + activity event) | GREEN — both unit tests pass; trap door R-APWS-6 pinned | none |
| F1 preflight | AC-APWS-2 (four cases: no-scope / fully-in / partial-out / fully-out) | GREEN — 5 cases in `check-scope-diff-preflight.test.js` (also: empty-staged, missing-allowed_paths) | none |
| F1 preflight | AC-APWS-3 (payload quartet `{scope_json_path, staged_paths_outside_scope, head_ref, suggested_remediation}`) | GREEN — `check-scope-diff-emits-event.test.js` covers all four fields | none |
| F2 event | AC-APWS-4 (`worker_edit_outside_scope` in `VALID_ACTIVITY_EVENTS`) | GREEN — `extension/src/types/index.ts:586` | none |
| F2 status | AC-APWS-5 (`/pickle-status` renders deviations when events exist; empty otherwise) | PARTIAL — `pickle-status-scope-drift.test.js` covers 3 cases but the exact contract ("Scope drift: N edit(s) outside scope.json — tickets: <ids>") has no assertion on the digit + plural form, and the cross-session isolation case relies on JSONL filename heuristics that may regress silently | **TIGHTEN** — assert digit-count + plural form + exact prefix string |
| F3 anatomy-park clause | AC-APWS-6 (Phase 2 step 4.5 present + deploys via `install.sh`) | GREEN (string check) — `anatomy-park.md:372` exists | **HARDEN** — ordering invariant ("4.5 between tests-pass and git commit") has no trap door |
| F3 szechuan-sauce clause | AC-APWS-6 analog | GREEN (string check) — `szechuan-sauce.md:396` exists | **HARDEN** — same ordering invariant gap |
| F3 worker simulation | AC-APWS-7 (end-to-end: synthesize session + scope.json, drop out-of-scope commit, run binary, assert exit 1 + event) | **MISSING** — `anatomy-park-scope.test.js` has zero `check-scope-diff` matches; `szechuan-scope.test.js` has zero matches | **WRITE** — both files need the worker-simulation regression case |

## Bundle-level acceptance criteria

Wrapper-level checks. Per-ticket ACs live on each refinement output ticket.

- [ ] **AC-BUNDLE-APWS-01** — `extension/tests/anatomy-park-scope.test.js` gains a worker-simulation test that:
  1. Initializes a temp git repo with three allowed-path prefixes in `scope.json` (`alpha/`, `beta/`, `gamma/`).
  2. Stages one in-scope file (`alpha/x.ts`) and one out-of-scope file (`outside/leaked.ts`).
  3. Spawns `extension/bin/check-scope-diff.js --scope-json <path> --ticket-id <id>` against the temp repo.
  4. Asserts `status === 1` and `stdout` parses to `{status: 'outside_scope', staged_paths_outside_scope: [..., 'outside/leaked.ts']}`.
  5. Asserts a `worker_edit_outside_scope` activity event was appended to the test's `PICKLE_DATA_ROOT/activity/<today>.jsonl` with `gate_payload.staged_paths_outside_scope` including `outside/leaked.ts` and `ticket_id` matching the input.
  Test runs in `@tier: fast`. Uses isolated `PICKLE_DATA_ROOT=<tmpdir>` so it never touches the user's real activity log.

- [ ] **AC-BUNDLE-APWS-02** — `extension/tests/szechuan-scope.test.js` gains a structurally identical worker-simulation test (same shape, same assertions) so that the `szechuan-sauce.md:396` wiring is proven functionally equivalent to the anatomy-park preflight call. Same tier, same isolation.

- [ ] **AC-BUNDLE-APWS-03** — New file `extension/tests/pickle-status-scope-deviations.test.js` (`@tier: fast`) covers `renderScopeDrift` output contract end-to-end:
  - Case A: zero `worker_edit_outside_scope` events for session tickets → output does NOT contain the literal substring `Scope drift:` (no extra blank line either).
  - Case B: exactly 1 event for a session ticket → output contains a line matching `/^Scope drift: 1 edit\(s\) outside scope\.json — tickets: <ticket_id>$/m`.
  - Case C: 3 events across 2 distinct session tickets → output contains `Scope drift: 3 edit(s) outside scope.json — tickets: <id_a>, <id_b>` (order-insensitive comma list).
  - Case D: 2 events whose `ticket_id` is NOT in the session's `collectTickets` result → output does NOT contain `Scope drift:` (cross-session isolation).
  The new file is additive to the existing `pickle-status-scope-drift.test.js`; both must remain green.

- [ ] **AC-BUNDLE-APWS-04** — New file `extension/tests/scope-preflight-ordering.test.js` (`@tier: fast`) enforces the worker-prompt ordering invariant. It reads `.claude/commands/anatomy-park.md` and `.claude/commands/szechuan-sauce.md` from source and asserts, for each file:
  - The literal `node "$HOME/.claude/pickle-rick/extension/bin/check-scope-diff.js"` invocation appears at least once.
  - For anatomy-park.md: the regex `/4\.\s+\*\*Run the full test suite\*\*[\s\S]*?check-scope-diff\.js[\s\S]*?git commit/` matches (step 4 tests → 4.5 preflight → commit, in order). Reject if `git commit` appears before `check-scope-diff.js` after the matched step-4 anchor.
  - For szechuan-sauce.md: the regex `/Scope preflight[\s\S]*?check-scope-diff\.js[\s\S]*?Exit 0\*\*:\s*proceed with commit/` matches (preflight block precedes the "proceed with commit" branch).

- [ ] **AC-BUNDLE-APWS-05** — Trap-door audit (`bash extension/scripts/audit-trap-door-enforcement.sh`) exits 0; the two pre-existing R-APWS trap doors (R-APWS-6 preflight, AC-APWS-1 emission) MUST stay green AND three new trap-door entries land in `extension/CLAUDE.md`:
  1. `.claude/commands/anatomy-park.md` Phase 2 step 4.5 ordering — ENFORCE `extension/tests/scope-preflight-ordering.test.js`. PATTERN_SHAPE: `step 4 test-suite anchor must precede check-scope-diff.js invocation must precede git commit`.
  2. `.claude/commands/szechuan-sauce.md` Override 7 scope-preflight ordering — ENFORCE same test file. PATTERN_SHAPE: `'Scope preflight' heading must precede check-scope-diff.js must precede 'proceed with commit' branch`.
  3. `src/bin/status.ts` `renderScopeDrift` output contract — INVARIANT: when ≥1 `worker_edit_outside_scope` event matches a session ticket, output line MUST match `/^Scope drift: \d+ edit\(s\) outside scope\.json — tickets: .+$/m`; zero matching events → no `Scope drift:` line printed. ENFORCE `extension/tests/pickle-status-scope-deviations.test.js`. PATTERN_SHAPE: `console\.log\(\`Scope drift: \$\{driftEvents\.length\} edit\(s\) outside scope\.json — tickets: \$\{` at the only emission site in `status.ts`.

- [ ] **AC-BUNDLE-APWS-06** — Closer commit body lists Finding #11 (R-APWS / B-APWS) as **closed** in `prds/MASTER_PLAN.md`, with the bookkeeping rules from `docs/closer-ticket-manager-handoff.md`: move the row out of P1 Open Findings into `## Closed since last update (2026-05-23)`, drop the corresponding `Active Queue` row #2 (B-APWS), and renumber Active Queue entries below.

## Trap-door touchpoints

**TOUCHES (must stay green after this bundle):**

- `extension/CLAUDE.md` R-APWS-6 `src/bin/check-scope-diff.ts` preflight INVARIANT — ENFORCE `extension/tests/check-scope-diff-preflight.test.js`. If this regresses, the bundle fails the audit.
- `extension/CLAUDE.md` AC-APWS-1 emission INVARIANT — ENFORCE `extension/tests/check-scope-diff-emits-event.test.js`. Same gate.

**ADDS (must be pinned in `extension/CLAUDE.md` at closer time):**

- Anatomy-park worker-prompt ordering — see AC-BUNDLE-APWS-05 entry 1.
- Szechuan-sauce worker-prompt ordering — entry 2.
- `renderScopeDrift` output-contract — entry 3.

**PATTERN_SHAPE drift note:** The source PRD's proposed PATTERN_SHAPE
("anatomy-park.md Phase 2 ordering — `git commit` MUST follow `check-scope-diff.js` MUST follow tests-pass")
matches reality but is too coarse to fail on a future refactor that, e.g.,
moves the preflight into Phase 2.5. The trap door registered by this bundle
anchors on the literal step-4 test-suite heading and the literal `git commit`
token within the same Phase-2 region — that's the actual breakage shape.

## Ticket sizing (sketch — refinement decomposes into atomic units)

Each ticket ≤30 min, ≤5 files, ≤4 ACs, single-touchpoint. R-APWS numbering
continues from the already-shipped R-APWS-6.

| R-code | Tier | Scope | Files | ACs |
|---|---|---|---|---|
| **R-APWS-7** | medium | Worker-simulation regression in anatomy-park test | `extension/tests/anatomy-park-scope.test.js` (1 file) | AC-BUNDLE-APWS-01 (5 assertions) |
| **R-APWS-8** | medium | Worker-simulation regression in szechuan-sauce test | `extension/tests/szechuan-scope.test.js` (1 file) | AC-BUNDLE-APWS-02 (5 assertions) |
| **R-APWS-9** | small | `renderScopeDrift` output-contract test | `extension/tests/pickle-status-scope-deviations.test.js` (1 new file) | AC-BUNDLE-APWS-03 (4 cases A-D) |
| **R-APWS-10** | small | Worker-prompt ordering trap door | `extension/tests/scope-preflight-ordering.test.js` (1 new file) + `extension/CLAUDE.md` (3 new trap-door entries) | AC-BUNDLE-APWS-04 + AC-BUNDLE-APWS-05 |
| **R-APWS-11-CLOSER** | small | MASTER_PLAN bookkeeping + release gate + install | `prds/MASTER_PLAN.md` (close #11 + drop B-APWS Active Queue row + renumber) | AC-BUNDLE-APWS-06 |

Refinement may further split R-APWS-7 / R-APWS-8 if either exceeds the 30-min
cap (e.g., if git-init fixture setup is itself non-trivial).

## Pre-flight checklist

Before the pipeline launches:

1. Working tree clean. Only untracked PRDs are tolerated; no in-flight worker edits.
2. HEAD on `main`. Latest commit at preflight time: `59810646`.
3. No prior pipeline session attached: `tmux ls | grep -E '^(pipeline|monitor-aux|refine)-' | head -1` returns empty.
4. Each ticket's worker MUST write `scope.json` fixtures to an isolated `tmpdir`-scoped session root and MUST set `PICKLE_DATA_ROOT` to a tmpdir before exercising `logActivity` — the test must NEVER write to the operator's real `~/.local/share/pickle-rick/activity/*.jsonl`.
5. The R-APWS-6 + AC-APWS-1 trap doors at `extension/CLAUDE.md` MUST be present (sanity check before launching: `grep -c "R-APWS" extension/CLAUDE.md` ≥ 2).

## Risk Register

- **R1 — Existing F1 may have undiscovered edge-case gaps.** The bundle's worker-simulation tests use deliberately simple inputs (literal-prefix `allowed_paths`, no glob patterns, no renames). If, while writing AC-BUNDLE-APWS-01/02, the worker discovers that `check-scope-diff.ts:isPathInScope` mis-handles globs, renamed files (`git diff --name-status` R-class), or paths with leading `./`, that's a real bug — file a follow-up `R-APWS-12` ticket. DO NOT widen scope mid-bundle; this bundle's contract is regression coverage of the SHIPPED behavior.
- **R2 — Activity-log JSONL schema drift.** `renderScopeDrift` parses raw JSONL via `JSON.parse(line)` (`extension/src/bin/status.ts:135`) and reads `ev.event === 'worker_edit_outside_scope'` plus `ev.ticket_id`. The new AC-BUNDLE-APWS-03 fixture MUST emit lines whose top-level shape matches `activity-events.schema.json:worker_edit_outside_scope` exactly — same regression class as iter-7/8/9 `ticket_audit_failed` / `time_cap_disabled_default` / `worker_partial_lifecycle_exit` events. Synthetic fixtures MUST stamp `ts: new Date().toISOString()` and `source: 'pickle'` to match the producer.
- **R3 — `renderScopeDrift` output string drift.** The source PRD specifies output as `"Deviations: N files in M commits"`. HEAD reality (`status.ts:148`) is `"Scope drift: N edit(s) outside scope.json — tickets: <ids>"`. This bundle codifies the HEAD output as the contract. Anyone tempted to "fix" `status.ts` to match the source PRD must instead update the source PRD or file a follow-up. AC-BUNDLE-APWS-05 entry 3 enforces this.

## Closer behavior

- **Patch bump only** (regression coverage; no behavioral change). Source `extension/package.json` from current `1.78.1` to `1.78.2`.
- Run canonical release gate from `extension/`:
  `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`.
- `bash install.sh --closer-context`; verify md5-parity between source and deploy.
- MASTER_PLAN bookkeeping per `docs/closer-ticket-manager-handoff.md`:
  - Move `| 11 | R-APWS | … |` row out of P1 Open Findings (line 67) into `## Closed since last update (2026-05-23)`.
  - Delete `| 2 | **B-APWS** | NEXT (new) | … |` row from `Active Queue` (line 127) and renumber rows 3+ accordingly.
  - Add a one-liner to the `Closed since last update` section: `#11 R-APWS — scope-allowlist enforcement regression coverage + observability test landed; preflight, event, and status-drift rendering now end-to-end-tested. Bundle ships under v1.78.2.`
- Closer commit body lists `#11 R-APWS / B-APWS closed` in the commit description.

## What this bundle does NOT do

- Does NOT extend scope enforcement to citadel or pickle phases — `prds/archive/bug-reports/p2-anatomy-park-worker-edits-bypass-scope-allowlist.md` "Out of scope" already declares this as future work.
- Does NOT auto-widen scope on cross-scope coupling discovery — that's a policy question deferred by the source PRD.
- Does NOT change the existing `check-scope-diff.js` behavior — adds regression coverage and ordering trap doors only.
- Does NOT modify the source PRD `p2-anatomy-park-worker-edits-bypass-scope-allowlist.md` (per worker forbidden ops; PRDs in `prds/` are change-tracked separately).
- Does NOT touch the deployed `~/.claude/pickle-rick/` tree directly — all edits go through `extension/src/` → `bash install.sh`.

## Triggering session

Will be assigned at launch via
`/pickle-pipeline prds/archive/bundles/p1-bug-fix-bundle-b-apws-scope-allowlist-enforcement-2026-05-23.md`.
Session ID format: `2026-05-23-<8-char-hash>`. Expected duration short
(<60 min) — three small + two medium tickets, no heavy fixtures beyond
temp git repos.
