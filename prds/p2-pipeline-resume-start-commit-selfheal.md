---
title: "B-PSCG — Symmetric start_commit self-heal: paused-PRD → resume → pipeline must reach citadel"
priority: P2
finding: R-PSCG
status: superseded
superseded_by: "R-SCPIN (p2-start-commit-adopt-pinned-sha.md); shipped-as 2bbf5770 with a live defect"
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
depends_on: "none (deploy-agnostic BUILD)"
source_assessment: "prds/BUG-REPORT-2026-07-02-pipeline-resume-start-commit-gap-citadel-hardfail.md (live incident session 2026-07-01-04e99002 — 170-min build completed, then citadel exit 1, review tail never ran)"
---

# B-PSCG — pipeline resume start_commit self-heal

## 0. Status — SUPERSEDED, with a live P0 carried forward (refinement 2026-07-12, 3×3 cycles)

These branches shipped 2026-07-02 in `2bbf5770` and are live in the deployed tree. **Do not
re-implement — a diff that adds these branches is a regression.** But the bundle does NOT close
clean: AC-PSCG-1/2 adopt `computeBaselineStartCommit` = `merge-base(<default>, HEAD)`, which is
NOT what `start_commit` means (`setup.ts:1414/:1432` stamp HEAD-at-session-start — the same SHA
as `pinned_sha`). On `experiment/fable-operating-manual` the two differ by 97 commits / 154
files, and citadel's remediator WRITES code against that range. Successor: **R-SCPIN**
(`prds/p2-start-commit-adopt-pinned-sha.md`). Authoring lesson (owned): this PRD itself violated
the pre-launch stale-premise grep — one grep for the heal's log string would have shown it
shipped ten days earlier.

## 0. The defect

Exact mirror of the shipped R-PRPATH fix: the citadel preflight
(`extension/src/bin/pipeline-runner.ts`, compiled `:2062-2075` region) self-heals a missing
`prd_path` when `start_commit` is present, but has NO inverse branch — `prd_path` present +
`start_commit` unset still hard-fails the phase. Origin: `setup.js --paused` in a non-git cwd
(the LoanLight-normal case — `loanlight/` root is not a repo) never computes `start_commit`, and
`--resume` never recomputes it even when the resume cwd IS a git repo. Result: a flawless
multi-hour build, then `citadel: missing state.prd_path or state.start_commit — failing phase`,
review tail skipped, "1/4 phases". Deterministic reproduction in the bug report.

## 1. Workstreams (ACs adopted from the capture — reuse-first, no new machinery)

- **AC-PSCG-1 — symmetric self-heal at the citadel preflight.** When `prdPath` is present,
  `state.start_commit` unset, and the target IS a git repo: adopt a computed base
  (`git merge-base <default-branch> HEAD`, fork-point tolerated) instead of hard-failing; log
  `citadel: self-healed missing state.start_commit — adopted <sha>` mirroring the existing
  `prd_path` heal. The hard-fail remains ONLY for the both-absent / non-repo cases. — Type: test
  (fixture: session with prd_path set, start_commit unset, worktree on a feature branch → citadel
  phase starts; no `exit 1`)
- **AC-PSCG-2 — fix at the origin: `--resume` recomputes.** `setup.js --resume` recomputes
  `state.start_commit` when unset AND the effective working_dir is a git repo (same computation
  as initial setup). — Type: test (`--paused` in non-git tmp cwd → `--resume` in a git fixture →
  `jq -r .start_commit state.json` is a resolvable commit)
- **AC-PSCG-3 — loud deferral, not silent.** `setup.js --paused` in a non-git cwd WARNs that
  `start_commit` is deferred to resume. — Type: test (stderr warn asserted; later resume in a
  git repo backfills it)
- **AC-PSCG-4 — end-to-end regression.** Scripted `--paused`(non-git) → refine-artifacts staged →
  `--resume`(git fixture) → pipeline reaches PHASE 2 CITADEL without the missing-start_commit
  failure. — Type: test (integration tier; respect `.serial-tests.json` rules if
  subprocess-heavy)

## 2. Out of scope

- Any change to the R-PRPATH `prd_path` heal itself (extend beside it, don't rewrite it).
- Scope-resolver base computation (`computeBaselineStartCommit` exists — REUSE it if its
  contract fits; do not fork a second base-computation).
- Citadel behavior beyond the preflight fields.

## Simplification Review (subtract-before-add)

(1) Adds two small branches + one warn — no new gate/flag/state field; the state field
(`start_commit`) already exists. (2) REUSE: mirrors the existing R-PRPATH self-heal pattern at
the same callsite; base computation should reuse `computeBaselineStartCommit`
(`services/scope-resolver.ts`) rather than a new git invocation if its semantics match — the
research phase MUST check this first. (3) The brittle thing is the asymmetric hard-fail — this
bundle SOFTENS it to symmetric self-heal rather than adding an escape hatch around it. (4)
Subtraction: the hard-fail branch's reachable surface shrinks to genuinely-unrecoverable cases;
no flag added.

## Risks

- Wrong adopted base silently scopes citadel/anatomy diff reviews too wide/narrow — mitigation:
  the heal logs the adopted sha loudly and AC-PSCG-4 pins the merge-base shape.
- Recompute-on-resume must not OVERWRITE a legitimately-set start_commit (only fill when unset).
