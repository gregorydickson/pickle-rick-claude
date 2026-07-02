# BUG REPORT — `allow_inferred_completion_commit` unhonored by phantom-Done watcher / `readEvidence()` → 3-oracle disagreement strands codex bundle 0/4

- **Date:** 2026-07-02
- **Finding code:** **R-AICF** (capture-only) — corroborates + reopens **[[R-CCC]]** (codex workers skip completion_commit contract → phantom-Done reverts real commits) and **[[B-PDBL]]** (inferred completion_commit + phantom-Done).
- **Severity:** P1 (strands an otherwise-clean multi-ticket codex bundle; pipeline ends 0/4 phases with 4/16 tickets committed).
- **Backend:** codex (`--backend codex`). **Not reproduced on claude** (claude workers hash-tag reliably).
- **Surfaced:** babysitting the LOA-1078 resilience-layer pipeline. Session `2026-07-01-9e922602`, 16-ticket additive bundle, worktree `loanlight/loa-1078-worktree`.
- **Mode:** capture-only (per babysitter contract). No fix implemented.

## One-line

`allow_inferred_completion_commit=true` was set at launch and **honored by `done-guard`** but **NOT by the `phantom-Done watcher` nor the `readEvidence()` Done-flip fatal** — so a codex worker's real-but-non-hash-tagged commit produces a live 3-oracle disagreement that resets the ticket to Todo, then FATALs the pickle phase, stranding 12/16 tickets.

## Environment / launch flags (both confirmed honored)

`state.flags` at launch:
- `allow_inferred_completion_commit: true`
- `skip_quality_gates_reason: "monorepo path-drift … + forward-created files …"`

Both gate-skips fired correctly (`mux-runner.log:17-18, 39-40` — readiness + ticket-audit bypassed). So the flags ARE read; the defect is scoped to which subsystems consult the *inferred-commit* flag.

## What the codex workers produced (git log, `main..HEAD`)

```
822fb2b16 fix(96c1e7c5): add queued appraisal run readers      ← tagged ✓ (ticket 40)
224678f39 Add Reducto Redis circuit store                      ← NO hash tag ✗ (ticket 30 / c46045a6)
4418a8c5e fix(c870b3e0): consolidate retry backoff sites       ← tagged ✓ (ticket 20)
7cdb0c415 feat(36390dcd): add shared resilience module         ← tagged ✓ (ticket 10)
```

**3 of 4 codex commits followed the `<type>(<hash>): …` attribution convention; ticket 30's did not.** The work is real and committed (files present, tests pass) — only the commit *message* lacks the `(c46045a6)` tag. This is the R-CCC contract violation, reproduced on the current codex build.

## The 3-oracle disagreement (mux-runner.log, one iteration apart)

All three fire on the SAME ticket `c46045a6` with the SAME git state:

| line | oracle | verdict |
|---|---|---|
| `:89` | **done-guard** | `ticket c46045a6 is Done with completion evidence — counter reset, advancing without charge` ✅ accepts |
| `:92` | **phantom-Done watcher** | `Corrected phantom Done ticket c46045a6 back to Todo (no completion commit found)` ❌ reverts |
| `:95` | **readEvidence() Done-flip** | `[fatal] ticket c46045a6 cannot flip Done: readEvidence().kind === 'absent' (expected 'committed'); worker did not produce an attributable git commit.` ❌ FATAL |

`done-guard` honors the inferred-commit flag (or the frontmatter `completion_commit`); the other two scan `git log` for a message containing the ticket hash, find none, and ignore both the flag and the frontmatter `completion_commit: 224678f3…` field that IS present on the ticket. The fatal aborts the pickle phase.

## Downstream effect

```
pipeline-runner.log:
  Phase pickle exited with code 0
  Phase pickle exited but 12/16 tickets remain pending (4 Done) — not all-tickets-terminal, marking phase incomplete (not advancing)
  Phase pickle exited (exit_reason=done_without_commit_evidence); 12/16 tickets remain unfinished.
  Pipeline finished: 0/4 phases, 60m 55s
```

The runner correctly refuses to advance to citadel (good — the incomplete-bundle guard works), but the *cause* of the incompleteness is the oracle disagreement, not real missing work.

## Second proof on relaunch (the frontmatter field is ignored)

On operator relaunch (`mux-runner.log:114`, 2026-07-02 12:01) the phantom-Done watcher **again** reset `c46045a6` to Todo — *even though the ticket frontmatter now carries `completion_commit: 224678f39759e1da6ac8bc01ad5d71691a4e7228` and `status: Done`*. This confirms the watcher validates by scanning git-log commit messages for the hash tag ONLY, ignoring (a) the frontmatter `completion_commit` sha and (b) `allow_inferred_completion_commit`.

## Compounding: salvage churn burned ~11 iterations for 4 tickets

`mux-runner.log` iterations 6, 7, 11 show repeated `[salvage] <hash>: failing -> archived diff + reset Todo` + `[boundary-commit] … pre-stashed N out-of-allowlist path(s) to salvage ref` (e.g. `:60-62, :66-68, :83-85`). Codex workers wrote outside the per-file allowlist (e.g. ticket 20 needed `common/resilience/retry.ts` which its allowlist under-scoped; ticket 30 stashed 2 out-of-allowlist paths). Combined with the evidence-oracle fatal, 15 iterations produced only 4 Done tickets before the phase aborted.

## Repro conditions

1. `--backend codex`, multi-ticket bundle.
2. `allow_inferred_completion_commit=true` set.
3. At least one codex worker commits real in-scope work with a message lacking the `(<ticket-hash>)` tag (happens ~1-in-4 empirically).
4. → `done-guard` accepts, `phantom-Done watcher` reverts, `readEvidence()` FATALs → pickle phase ends `done_without_commit_evidence` → pipeline 0/N phases.

## Suggested fix direction (capture-only — do NOT implement here)

Unify the three evidence oracles behind ONE `readEvidence()` that, when `allow_inferred_completion_commit=true`, accepts as "committed" a ticket whose frontmatter `completion_commit` sha resolves to a real commit touching in-scope (allowlisted) files — even if the commit message lacks the hash tag. The `phantom-Done watcher` and the Done-flip fatal MUST consult the same predicate `done-guard` already uses. Root-cause alternative (preferred per the SUBTRACT-brittle-features strategy): make codex workers' commit-tagging deterministic (post-commit trailer injection by the worker wrapper) so all three oracles agree without a flag. Corroborates R-CCC-1 (2026-05-05, archived as fixed) — **the fix did not survive the codex backend with the inferred flag on.**

## Cross-refs

[[R-CCC]] · [[B-PDBL]] · evidence-oracle-disagreement class (`BUG-REPORT-2026-06-23-green-build-reports-0-of-4-evidence-oracle-disagreement-and-failed-nonterminal.md`) · codex completion-evidence class (`BUG-REPORT-2026-06-22-codex-backend-completion-evidence-fatal-and-cross-iteration-work-corruption.md`).
