---
title: P1 — B-AFCC-DEEP — deep root-cause analysis + remediation bundle for the autofill / Done-flip cluster (6 failed-fix recurrences in 30 days)
status: Draft
filed: 2026-05-28
priority: P1
type: bug-fix-bundle
analysis_agents: 3
composes:
  - 52   # R-WUWC — Worker-Updated-Without-Completion-commit (closed v1.78.2 — fix scope too narrow)
  - 70   # R-CCQF — completion_commit quoted-form normalization (closed v1.79.0 — bare reads remain in autofill helper)
  - 71   # R-PEDC — clearStaleDoneWithoutCommitEvidence on recovery (closed v1.79.0 — only one literal pinned)
  - 78   # R-AFCC-STALE — cross-session false attribution (STILL OPEN)
  - 83   # R-RIC-EXPLICIT — explicit completion_commit frontmatter honored (closed v1.80.3 — closer missed auto-fill importer)
related_findings:
  - R-AFCC-STAGE  # filed 2026-05-28 in prds/BUG-REPORT-2026-05-28-auto-fill-completion-commit-stage-fails-outside-repo.md (operator-reset out of MASTER_PLAN this session; needs refile under new #)
---

# B-AFCC-DEEP — autofill / Done-flip cluster root-cause analysis + remediation

## Executive summary

Six distinct ticket completion-commit bugs in 30 days. Each fix shipped correctly. Each shipped a narrow-scope trap-door pin. **Each was followed by an adjacent-mode bug discovery within days.**

| # | Code | Closed | Adjacent-mode discovered |
|---|---|---|---|
| 52 | R-WUWC | v1.78.2 | → R-CCRC-2 callsite drift caught only by next live incident |
| 70 | R-CCQF | v1.79.0 | → autofill helper still uses bare `readFrontmatterField` for the already-present check |
| 71 | R-PEDC | v1.79.0 | → only one `exit_reason` literal pinned; ~30 `recordExitReason` callsites unpaired |
| 83 | R-RIC-EXPLICIT | v1.80.3 | → R-AFCC-STAGE (today): closer never audited `auto-fill-completion-commit.ts` as an importer of the changed `hasCompletionCommit` semantics |
| 78 | R-AFCC-STALE | **OPEN** | cross-session false attribution to commits from prior sessions |
| — | R-AFCC-STAGE | filed today, operator-reset, needs refile | `stageTicketFile` `git add` throws outside-repo, swallowing autofill `action:'filled'` signal |

Three parallel agent investigations (architect / process / simplification lenses) converged on **complementary** verdicts:

- **Agent A (architect — deepening)**: the cluster is a textbook Pocock shallow-module problem — single conceptual entity ("is this ticket attributably done?") split across 3+ modules with divergent invariants. The lack of a central Interface IS the bug.
- **Agent C (simplification — deletion)**: ~70% of the defect surface is dead code racing live code. `auto-fill-completion-commit.js` duplicates `inspectPhantomDoneTicketFile`. `stageTicketFile`'s `git add` has zero downstream consumer. Path count (8 distinct Done-stampers) IS the bug.
- **Agent B (process — adjacency audit)**: each closer shipped a correct narrow fix and a correct narrow trap door — but trap doors were "one-symptom-deep instead of one-mode-class-deep". A 6-step adjacency-audit template would have caught R-AFCC-STAGE during R-RIC-EXPLICIT's closer in a 30-second grep.

**Synthesis**: all three are right. Phase remediation accordingly.

---

## The cluster — what's actually in it

**Implicated modules (cite paths from agent reports):**

- `extension/bin/auto-fill-completion-commit.js` — the helper. ~114 LOC. CLI entry point at line 111.
- `extension/bin/mux-runner.js:guardCompletionCommitBeforeDone` — the gate (lines ~2707-2765).
- `extension/bin/mux-runner.js:phantomDoneShouldKeepDone` + `correctPhantomDoneTickets` + `inspectPhantomDoneTicketFile` — the watcher (lines ~1007-1136).
- `extension/services/pickle-utils.js:hasCompletionCommit` — the read (line ~775).
- `extension/services/pickle-utils.js:findMatchingCommit` + `normalizeCompletionCommitField` — supporting normalizers.
- `extension/services/pickle-utils.js:frontmatterCompletionCommitReachable` — separate reachability check (line ~939).

**8 distinct paths that can stamp `status: Done` and/or persist `completion_commit:`** (Agent C enumeration):

1. Worker explicit stamp via `updateTicketFrontmatter` (`spawn-morty.js:956-958`)
2. Worker post-stamp belt-and-suspenders `autoFillCompletionCommit` (`spawn-morty.js:966`)
3. Manager drift → `applyAutoTicketCompletionValidation` (`mux-runner.js:1635`)
4. Manager `EPIC_COMPLETED` → guard → `markTicketDone` (no autofill)
5. Three more guard-routed Done flips at `mux-runner.js:4694, 5083, 5159`
6. Phantom-Done watcher *reverts* Done→Todo (`mux-runner.js:1007-1062`)
7. Phantom-Done watcher *backfills* `completion_commit_inferred:` (`mux-runner.js:1089-1136`)
8. Operator salvage edit (manual frontmatter edit, documented bypass)

Paths 2 and 7 are **functionally identical inferred-backfill helpers separated only by which field name they write**. Paths 6 and 7 are **opposite-direction watchers operating on the same input**.

**Six things the caller currently must know** (Agent A enumeration) to use this surface correctly:

1. Which of the 3 seams to call (different invariants in each)
2. Whether to set `state.flags.allow_inferred_completion_commit` (only the gate respects it)
3. Whether to call `clearStaleDoneWithoutCommitEvidence` afterwards (only after a successful gate; the watcher doesn't)
4. Whether to call `autoFillCompletionCommit` afterwards (only after `markTicketDone` because the writer requires `status=Done`)
5. That `stageTicketFile` will throw outside a git repo (R-AFCC-STAGE)
6. That `start_time_epoch` filtering only happens if `statePath` was passed (R-AFCC-STALE)

That is not an Interface — it is a documentation graveyard.

---

## The three-lens verdict

### Architect lens (Agent A)

Apply the Deletion Test: deleting `auto-fill-completion-commit.js` does NOT collapse complexity because the read side (`hasCompletionCommit`) and the classify/write side and the phantom-Done watcher are all doing the same conceptual work twice with subtly divergent rules. **Five fields disagree** across the three pseudo-seams: source-of-truth, quote normalization, `inferred` semantics, stale-evidence guard, failure mode of writeback.

Proposed deepened module — **`TicketCompletionEvidence`** with 5 entry points:

```ts
readEvidence(ctx): { kind: 'explicit'|'inferred-fresh'|'inferred-stale'|'absent', sha? }
persistEvidence(ctx, sha, opts: { stage: 'best-effort'|'required' }): PersistResult
gateForDoneFlip(ctx, policy): GateDecision
gateForPhantomDoneRevert(ctx, policy): RevertDecision
recordPostGateOutcome(statePath, decision): void
```

R-AFCC-STAGE becomes a `stage: 'best-effort'` flag — non-repo workingDir is a legitimate state, not an exception. R-AFCC-STALE becomes a first-class return variant. Three policies on one gate replace three callsites with implicit invariants.

**Verdict: deepening required, but only after deletion (else deep module + shallow predecessors coexist — the current state).**

### Simplification lens (Agent C)

70/25/5 simplification-vs-architecture-vs-process. Three concrete deletions (~-300 LOC):

1. **Delete `extension/src/bin/auto-fill-completion-commit.ts` + `extension/bin/auto-fill-completion-commit.js`** (114 LOC each). Move the 4-line inferred→explicit upsert into `guardCompletionCommitBeforeDone` where it already lives inside a `try/catch`. Eliminate the dead `stageTicketFile` `git add` entirely — every `git diff --cached` consumer treats the index as a progress sentinel, never as input to a subsequent commit. The staged ticket file has zero downstream reader.
2. **Collapse `inspectPhantomDoneTicketFile` into `correctPhantomDoneTickets` as a single revert-or-backfill switch.** One unified loop: *if inferred, persist; if absent, revert; if explicit-and-reachable, keep.* Eliminates the keep-vs-revert asymmetry that R-PDWR / R-CCR-1 / R-RIC-EXPLICIT-2/4 are all band-aids over.
3. **Push reachability into `hasCompletionCommit`'s explicit branch** (the `git cat-file -e` originally specified in R-CCC-5 but never built). Now `hasCompletionCommit` returns four states (`explicit-reachable / inferred / absent / unreachable`). `phantomDoneShouldKeepDone` collapses to a 1-line check. `frontmatterCompletionCommitReachable` (pickle-utils.js:939) becomes deletable.

**Verdict honestly stress-tested**:

- Worker-fsync race is real (folding doesn't fix it — needs a barrier in `updateTicketFrontmatter`, separate work)
- `auto-fill-completion-commit.js` is a CLI entry point — deletion needs a deprecation cycle or shim
- `inspectPhantomDoneTicketFile` catches operator-salvage drift the guard doesn't — defense-in-depth lane needs structural replacement, not pure deletion
- `completion_commit_inferred:` has forensic-audit value (records *how* SHA was discovered)

**Verdict: delete first, then deepen.**

### Process lens (Agent B)

Each closer shipped a correct narrow fix:

- **R-WUWC closer** did not walk other Done-flip callsites → R-CCRC-2 surfaced at the 5th callsite
- **R-CCQF closer** did not grep other readers of `completion_commit` field directly → autofill helper still uses bare `readFrontmatterField`
- **R-PEDC closer** did not enumerate `recordExitReason` callsites → only one of ~30 paired with a stale-clear
- **R-RIC-EXPLICIT closer** did not list importers of `hasCompletionCommit` → autofill helper missing from cross-reference → R-AFCC-STAGE

Proposed standing template — **`R-CLOSER-ADJACENCY-AUDIT`** — 6-step checklist every closer in this area MUST execute and record in the closer commit body:

1. **Adjacent-path enumeration** — `rg -n '<patched-fn>\(' extension/src/ extension/tests/`
2. **Adjacent-mode enumeration** — `rg -nE 'throw |execFileSync|spawnSync|readFileSync' <patched-file>`
3. **Trap-door delta** — paste invariant; confirm symptom AND each adjacent-mode covered
4. **Cross-module importer check** — `rg -n 'from .*<patched-module>' extension/src/`
5. **Stamp-pair parity** — count `recordExitReason` vs `clearStale*` callsites
6. **Pre-flight context grep** — `rg -n "execFileSync\(['\"]git['\"]" <patched-file>` + written caller-context note

`audit-trap-door-enforcement.sh` greps the closer commit body for `## Adjacency audit (R-CLOSER-ADJACENCY-AUDIT)` section with each Y/N answered; missing section blocks at commit time.

**Verdict: process gap dominantly — A stricter closer-audit template alone WOULD have caught R-AFCC-STAGE during R-RIC-EXPLICIT's closer in 30 seconds (steps 4 + 6 both fire on this case). The recurrence pattern is the signature of missing process, not missing architecture.**

---

## Synthesis — phased remediation

The three lenses are complementary phases of one bundle. Sequence matters:

| Phase | Lens | Scope | Risk |
|---|---|---|---|
| **1. Cromulons safety net** | Architect prerequisite | Characterization tests asserting ALL 9 known paths' current observable behaviour through `hasCompletionCommit` / guard / watcher | Without this, the deepen reopens #52 R-WUWC (data-loss class) |
| **2. Adjacency-audit closer template** | Process — standing change | Land `R-CLOSER-ADJACENCY-AUDIT` template + grep enforcement in `audit-trap-door-enforcement.sh`. Applies to ALL future closers (not just B-AFCC-DEEP). | Low — template is a doc + a grep script |
| **3. Delete the dead code** | Simplification | Per Agent C: delete `auto-fill-completion-commit.js`, collapse watcher into one resolver, push reachability into `hasCompletionCommit`. ~-300 LOC, -3 trap doors. Add deprecation shim for the CLI entry point. | Worker-fsync race remains (separate work). CLI shim needed for backwards compat. |
| **4. Deepen what remains** | Architect | After deletion, refactor the remaining concentrated logic into the `TicketCompletionEvidence` 5-entry-point shape. Run `/death-crystal --interface TicketCompletionEvidence` to explore alternatives. | Need #2 cromulons net + #3 deletion shipped first, else compounds. |

This is the **B-AFCC-DEEP** bundle.

---

## Acceptance Criteria

- **AC-AFCC-DEEP-01**: characterization test suite at `extension/tests/characterization/completion-commit-cluster/` asserts current observable behaviour through ALL 8 enumerated Done-stamping paths PLUS the 4 known SHA quote-forms PLUS the 3 evidence sources (`explicit` / `inferred` / `absent`). Passes against current `main`.
- **AC-AFCC-DEEP-02**: `R-CLOSER-ADJACENCY-AUDIT` template added to `.claude/commands/citadel.md` (or a sibling `closer-template.md` referenced from each bundle PRD's closer ticket). `extension/scripts/audit-trap-door-enforcement.sh` greps every closer commit body in the cluster for a `## Adjacency audit (R-CLOSER-ADJACENCY-AUDIT)` section with each of the 6 Y/N items answered; missing section = release gate red.
- **AC-AFCC-DEEP-03**: `auto-fill-completion-commit.js` + `.ts` removed. CLI entry point preserved as a thin shim that calls `guardCompletionCommitBeforeDone` and exits with the same JSON-formatted result shape; shim emits a `cli_deprecated` activity event when invoked.
- **AC-AFCC-DEEP-04**: `inspectPhantomDoneTicketFile` collapsed into `correctPhantomDoneTickets`; single revert-or-backfill loop with explicit decision matrix (explicit-reachable=keep / inferred=persist+keep / absent=revert / unreachable=revert).
- **AC-AFCC-DEEP-05**: `hasCompletionCommit` return shape adds a fourth `kind: 'unreachable'` for `explicit` SHAs that `git cat-file -e` cannot verify. `frontmatterCompletionCommitReachable` removed (now subsumed). `phantomDoneShouldKeepDone` collapses to a single boolean check on the new return shape.
- **AC-AFCC-DEEP-06**: `TicketCompletionEvidence` module exists at `extension/src/services/ticket-completion-evidence.ts` with the 5 entry points proposed by Agent A. All callsites of `hasCompletionCommit` + `autoFillCompletionCommit` + `inspectPhantomDoneTicketFile` migrated to call the new module. Old function bodies retained only as deprecated re-export shims for one minor version.
- **AC-AFCC-DEEP-07**: 3 new trap doors pinned per Agent B's delta — `R-AFCC-STAGE` (containment), `R-AFCC-WRITE-OBSERVABILITY` (write-vs-stage telemetry split), `R-AFCC-CALLER-ENUMERATION` (closer-audit pin requiring callsite count grep). All three pinned in `extension/CLAUDE.md` AND enforced by `audit-trap-door-enforcement.sh`.
- **AC-AFCC-DEEP-08**: After all phases ship, the characterization suite from AC-AFCC-DEEP-01 STILL PASSES UNCHANGED. (The whole point: behaviour preserved; surface reduced.)
- **AC-AFCC-DEEP-09**: No `LATEST_SCHEMA_VERSION` bump (schema-neutral, dodges #74 R-WSWA).
- **AC-AFCC-DEEP-10**: Release gate full run from clean clone exits 0. No regression in #52 R-WUWC reproducer test.

---

## Tickets

**Phase 1 — Cromulons safety net (~3 tickets, must ship first):**

- **R-AFCC-DEEP-1A** — Enumerate all 8 Done-stamping paths in a single decision-matrix fixture. Map each path to a synthetic session-dir fixture + expected observable end-state. Write the README documenting "what each path is and how it can fail."
- **R-AFCC-DEEP-1B** — Implement `extension/tests/characterization/completion-commit-cluster/*.test.js` (`@tier: integration`). One file per path. Each test asserts current behaviour without prescribing it (Feathers-style: this is what it DOES, not what it SHOULD do).
- **R-AFCC-DEEP-1C** — Add the suite to `npm run test:integration` and verify it passes against current `main`. Pin its existence in `extension/CLAUDE.md` under a new `## Characterization Safety Nets` section.

**Phase 2 — Adjacency-audit closer template (~2 tickets, ships in parallel with Phase 1):**

- **R-AFCC-DEEP-2A** — Add `R-CLOSER-ADJACENCY-AUDIT` template to `.claude/commands/citadel.md` (or to a new `.claude/commands/closer-template.md` referenced from existing closer skill prompts). Six-step checklist per Agent B spec. Pin in `extension/CLAUDE.md`.
- **R-AFCC-DEEP-2B** — Wire `extension/scripts/audit-trap-door-enforcement.sh` to grep closer commit bodies for `## Adjacency audit (R-CLOSER-ADJACENCY-AUDIT)` section presence + 6 Y/N items. Missing = exit 1.

**Phase 3 — Deletion (~3 tickets, must follow Phase 1):**

- **R-AFCC-DEEP-3A** — Delete `extension/src/bin/auto-fill-completion-commit.ts` and compiled `.js`. Inline the 4-line upsert into `guardCompletionCommitBeforeDone`. Update all 3 callsites (`mux-runner.ts:1946`, `mux-runner.ts:3107`, `spawn-morty.ts:1163`). Remove `stageTicketFile` entirely (no consumer of the staged file). Preserve CLI entry point as a deprecation shim.
- **R-AFCC-DEEP-3B** — Collapse `inspectPhantomDoneTicketFile` into `correctPhantomDoneTickets` as a single revert-or-backfill switch. Delete `insertCompletionCommitField` if it loses all callers. Migrate `completion_commit_inferred:` writes to use the unified field-name convention (decision: write `completion_commit:` directly with a `source: 'inferred'` annotation in a sibling field if the forensic-audit-value claim is real).
- **R-AFCC-DEEP-3C** — Push reachability check (`git cat-file -e`) into `hasCompletionCommit`'s explicit branch. Add `kind: 'unreachable'` return variant. Delete `frontmatterCompletionCommitReachable` (now subsumed). Collapse `phantomDoneShouldKeepDone` to 1-line check.

**Phase 4 — Deepen what remains (~3 tickets, must follow Phase 3):**

- **R-AFCC-DEEP-4A** — Create `extension/src/services/ticket-completion-evidence.ts` with the 5 entry points from Agent A. Make `hasCompletionCommit` + the inlined guard upsert + the collapsed watcher loop call the new module instead of duplicating their logic. Keep old function names as deprecated re-export shims.
- **R-AFCC-DEEP-4B** — Run `/death-crystal --interface ticket-completion-evidence` against the new module (this exercises the death-crystal skill from the V1 ship as its first real customer). Compare proposed interfaces; refactor toward the chosen synthesis.
- **R-AFCC-DEEP-4C** — Pin 3 new trap doors per Agent B's R-AFCC-* delta (containment, observability split, caller-enumeration). Add `R-AFCC-DEEP-CONSOLIDATED` master trap door pointing at `ticket-completion-evidence.ts` as the single oracle.

**Closer:** `R-AFCC-DEEP-CLOSER` — full release gate + verify characterization suite STILL passes (the invariant). Version bump 1.81.x → 1.82.0 if Phase 4 lands with `/death-crystal` (combined MINOR), or 1.81.x → 1.81.2 if Phase 4 deferred (PATCH-only). Bumps `bash install.sh` deferred until all phases land. `gh release create`.

---

## Risks / Open Questions

1. **`/death-crystal` doesn't exist yet** — Phase 4 depends on shipping the R-DC feature epic first. **Recommendation**: ship Phase 1 + 2 + 3 of B-AFCC-DEEP first (these don't need death-crystal). Phase 4 unlocks after R-DC v1.82.0. If R-DC is delayed, Phase 4 can use morty-debater-architect as a substitute interface-design facilitator.
2. **Worker-fsync race** — Agent C honestly flagged this is NOT addressed by deletion. Separate work needed in `updateTicketFrontmatter`. **Recommendation**: file as R-FSYNC-1 under a new B-FSYNC bundle. Not in B-AFCC-DEEP scope.
3. **CLI entry-point external consumers** — the deprecation shim approach should work, but Phase 3A should grep all `*.md` runbooks under `prds/` AND `docs/` AND any operator-facing scripts for `auto-fill-completion-commit` invocations before deletion.
4. **R-AFCC-STAGE finding refile** — the bug report at `prds/BUG-REPORT-2026-05-28-auto-fill-completion-commit-stage-fails-outside-repo.md` was operator-reset earlier this session and no longer exists on disk. The bug it described IS still real (confirmed by Agent C's stress-test of the `stageTicketFile` codepath). **Recommendation**: this PRD subsumes R-AFCC-STAGE. The fix lives in R-AFCC-DEEP-3A (delete the helper entirely → bug surface vanishes). Re-filing as a separate finding is unnecessary unless this bundle slips.
5. **`completion_commit_inferred` field decision** — Agent A says collapse; Agent C says keep for forensic value. Resolution: R-AFCC-DEEP-3B owns the decision. Default to Agent A's collapse (single field with `source` discriminator) unless real audit-trail consumers are identified.

---

## Total ticket count

| Phase | Tickets | Why |
|---|---|---|
| 1 — Cromulons safety net | 3 | Must ship first; no behaviour change |
| 2 — Adjacency-audit template | 2 | Standing process change; parallel to Phase 1 |
| 3 — Deletion | 3 | -300 LOC, -3 trap doors; needs Phase 1 |
| 4 — Deepen | 3 | Needs Phase 3 + R-DC `/death-crystal` |
| Closer | 1 | Release gate + version bump |

**Total: 12 tickets + closer.**

Dispatch order: 2 → 1 → 3 → 4 → closer. (Phase 2 first because it's a doc + script change with zero risk; Phase 1 second because it's the safety net; Phases 3 + 4 are the actual remediation.)

## Closer

`R-AFCC-DEEP-CLOSER` — release gate + characterization-suite invariant check + version bump. Phase 4 lands the bump; Phases 1-3 are intermediate.
