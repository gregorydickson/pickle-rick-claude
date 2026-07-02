# Simplification & Fix Plan — 2026-07-02

**Operator question:** "We may be overly complex and that is why we have failed fixes." Full-corpus review
(MASTER_PLAN + BUG-INDEX + all 16 bug reports + RELIABILITY-PLAN + open PRDs + deep source review of
`extension/src`) — **verdict: CONFIRMED, with a sharper mechanism than 'too complex'.**

## The diagnosis (evidence-backed)

**The failure history is not evidence of a hard problem domain. It is evidence of three concerns
(completion, recovery, scope) each implemented 2–6 times in parallel, defended by ~137 trap-door markers /
22 audit scripts / 16 override flags — guards that themselves misfire.**

1. **Failed fixes are asymmetric fixes.** Every high-recurrence chain is a defect repaired at ONE
   site/field/oracle while its sibling stayed broken: completion-evidence cluster = 13+ recurrences in 49
   days (R-CCC→R-CCRC→R-CCQF→R-WUWC→R-PFNT→R-AICF); R-PRPATH healed `prd_path` not `start_commit` (→R-PSCG);
   B-PCOMP bystander-stash never ported to microverse rescue (→R-MACB); R-REIN's recovery fix was itself
   inert. ~75% of fixes in the recent ledger were ADDITIVE (a new EvidenceKind/flag/grep/guard beside the
   existing one).
2. **Every zero-recurrence fix was a subtraction or a single choke point.** B-PNTR (removed the bare loop),
   B-GNXR (removed the self-bricking preflight), beta.33 (deleted the forward-ref grammar after its FIFTH
   recurrence — class went silent), **B-WSPU beta.35 (deleted the detached lifecycle — the R-WPEX/R-LTDM/
   R-MWBG class died the day the parallel implementation did)**. The pattern is perfectly consistent in
   both directions.
3. **Scale itself is a defect multiplier.** 72,018 LOC of source; `mux-runner.ts` alone is 11,340 LOC
   (15.7% of everything); 175K LOC of tests (2.4:1 defense-to-product); 214 activity-event types; 23 exit
   reasons. Parallel seams hide inside a file too big to hold in one head — which is *how* twins get missed.
4. **The defensive lattice is self-reinforcing.** 4 of 22 audit scripts are orphans that NEVER execute;
   the trap-door catalog is policed by three parallel enforcers (a shell audit re-implements a test's regex);
   the same invariant (state-write, install.sh, AC-shape) is guarded 2–3×; one gate (readiness) has THREE
   bypass routes. New failures get a new guard instead of a collapsed seam — the ~75%-additive trend.

**Doctrine (already in MASTER_PLAN, now with proof): fix at the seam, not the site; subtract before add;
pin every collapse with a call-site-count audit so divergence fails the gate.**

## ⚠ Premise corrections (verified against source 2026-07-02 — read before authoring B-1SEAM)

- **`allow_inferred_completion_commit` DOES NOT EXIST in source.** Deleted by B-DURA T60 (beta.23,
  `05650df1`); `check-no-inferred-completion-flag.sh` + `allow-inferred-completion-commit-deleted.test.js`
  pin its absence. The R-AICF bug report attributes the 3-oracle disagreement to this flag — impossible; the
  flag set at LOA-1078 launch was inert JSON. The REAL live divergence: `readEvidence()` is already the
  single evidence *function*, but its 6 decision call-sites apply DIFFERENT policy —
  only `guardCompletionCommitBeforeDone` (`mux-runner.ts:4697`) applies baseline-SHA rejection (`:4714`) +
  worker-gate fail-closed verdict (`:4769`). The phantom-Done watcher (`ticket-completion-evidence.ts:626`),
  R-PDUP twin auto-close (`mux-runner.ts:1427`), salvage attribution (`mux-runner.ts:5358`), auto-fill
  (`auto-fill-completion-commit.ts:75`), and `validateAutoTicketCompletion` (`mux-runner.ts:2792`) apply
  NONE of that policy. A red-gated or baseline SHA is refused by one oracle and accepted/back-filled by the
  others. B-1SEAM WS-1 must open with a mechanism trace of session `2026-07-01-9e922602` against these 6
  sites — not the flag.
- **B-RSHM premises spot-checked:** `chain_meeseeks` is LIVE (read `mux-runner.ts:7484,11004`, set
  `setup.ts:1101`) — the PRD correctly treats it as feature-subtraction, not dead-branch delete. `detached:`
  still appears in `spawn-morty.ts:2105` + `pipeline-runner.ts:1211` — those are the R-OMTD orphan-reap
  spawn mode, NOT B-WSPU residue; do not grep-and-delete.
- **5 shipped PRDs still sit un-archived in `prds/`** (B-PXBO, B-MWBG, B-RELHYG, B-SSVR, B-WSPU) — the
  stale-open-finding hazard. Archive with the B-CWGE lesson: grep gate/test paths that read each PRD and
  move them together.

## The plan

### Phase 0 — Correct the record (docs-only, this session)
1. This document + MASTER_PLAN premise correction for B-1SEAM WS-1 (done alongside this doc).
2. Delete drifted `allow_inferred_completion_commit` prose from `extension/CLAUDE.md`/trap-door docs at the
   next code bundle (it references a deleted flag as if live).
3. Archive the 5 shipped PRDs + fold `master-plan-rows/aec0cda1.md` (grep gate inputs first — f009608d lesson).

### Phase 1 — B-1SEAM (P1): collapse the completion seam — THE fix for the #1 class (22% of incidents)
Author from the 3 bug reports + the corrected mechanism. One thesis: *one predicate, all sites, pinned.*
- **WS-1 (R-AICF, R-PSRB HAND-BUILD, claude):** lift baseline-SHA rejection + worker-gate verdict +
  frontmatter-`completion_commit` resolution into ONE completion predicate (wrapper around `readEvidence`);
  route ALL 6 call-sites through it; pin with a call-site-count audit (R-AFCC-CALLER-ENUMERATION pattern).
  PLUS the root-cause subtraction for the codex trigger: **deterministic post-commit hash-tag trailer
  injection in the worker wrapper** (kills the ~1-in-4 untagged codex commit at the source — no flag, no
  per-oracle teaching). Prefer DELETING per-site policy code over adding predicate parameters.
- **WS-2 (R-PSCG, pipeline-safe):** ONE `healPipelineRequiredFields` helper healing BOTH `prd_path` AND
  `start_commit` (merge-base recompute when unset + git cwd); `setup --resume` recompute; WARN on non-git
  cwd. Replaces the two asymmetric branches — net code shrink.
- **WS-3 (R-MACB, pipeline-safe):** extract ONE shared dirty-tree salvage helper (owned-paths-only +
  `stashUnattributableRemainder`) used by the mux-runner exit path (`mux-runner.ts:5201/5156`), microverse
  `autoRescueDirtyTree` (`microverse-runner.ts:3613`), AND the microverse preflight; pin all call-sites.
  Deletes the unsafe parallel impl rather than patching its arguments.

### Phase 2 — R-CXHANG (P2): codex orphan reaper (PRD ready)
The one justified ADD (re-invokes existing `killProcessTree`/`reapChildSubtree`). Unblocks a clean codex
soak; sequence immediately after B-1SEAM.

### Phase 3 — Subtraction wave (bundle as B-RSHM+ or two small bundles)
- **B-RSHM as authored** (stop-hook dead branches + chain_meeseeks retirement; premises re-verified above).
- **NEW: guard-layer prune** (from the defensive-machinery inventory; zero-to-low blast radius first):
  a. DELETE the 4 orphan audits (`audit-mux-runner-callers.sh`, `audit-pkgjson-writers.sh`,
     `audit-runtime-imports.sh`, `audit-test-add-dir-containment.sh`) — never executed by any gate or test.
  b. DELETE `audit-subtract-before-add.sh` (self-labeled advisory; the discipline lives in prds/CLAUDE.md)
     and `audit-skip-flag-unification.sh` (a guard policing the shape of other guards).
  c. Demote `audit-design-ground-truth.sh` out of the release gate (zero catches since 2026-04); keep the
     citadel stale-reference/crossfile audits that cover the same drift.
  d. Collapse trap-door enforcement to ONE implementation (fold the shell regex into
     `trap-door-conformance.test.js`); merge `allowlist-dead-entry-detector.ts` into
     `audit-readiness-allowlist.sh` (one owner per invariant).
  e. Collapse the 3 readiness-bypass routes onto `skip_quality_gates_reason` (drop standalone
     `skip_readiness_reason` read + `PICKLE_SIGF=advisory` demotion route); retire the near-vestigial
     `skip_ticket_audit_reason` + never-emitted `ticket_audit_failed` event.
  f. Remove the 2 legacy-revert kill-switches on a greenfield project: `PICKLE_CITADEL_MECHANICAL`,
     `PICKLE_RECOVERY_CONSOLIDATION` (16 wired sites of dual-path branching — a whole parallel behavior
     surface kept alive for a rollback nobody will do).
  g. Collapse `codex-manager-relaunch.ts` into `manager-relaunch.ts` (same 4-symbol shape, both called);
     drop the `evaluateCodexManagerRelaunch` alias. Prune write-only flags (`bundle_bootstrap_mode`,
     `backend_flip_reason_ts`) after reader-grep.
- **Structural (operator sign-off, after the above soak):** extract the ~1.5k-LOC completion-oracle cluster
  out of `mux-runner.ts` to live beside `ticket-completion-evidence.ts` — not a rewrite, a co-location move
  so the seam is one screen, twins become visible, and the R-PSRB hand-build surface shrinks. This is the
  down-payment on shrinking the 11.3k-LOC file; no other decomposition until this proves out.

### Phase 4 — GA gate (unchanged, now credible)
Field-soak on the simplified runtime: 1–2 claude reps + ≥1 codex rep post-R-CXHANG. The bar stays the north
star: N bundles hands-off in a row. Then B-GA drops `-beta`. B-CGCAP (v2.1) / B-GIMA (v2.2) stay deferred.

### Explicitly deferred / rejected
- Full mux-runner decomposition beyond the completion-cluster move (churn risk > payoff now).
- 214-activity-event consolidation (cosmetic; fold opportunistically).
- Monitor/TUI subtraction (~19 trap-doors, cosmetic surface) — candidate only if it bites.
- Any new gate/guard machinery to "enforce simplification" — the call-site-count audits pinning each
  collapsed seam are the ONLY new checks this plan permits.

## Why this pushes toward complete autonomous execution
The two autonomy blockers are (a) fixes that don't stick — closed by seam-collapse + pinned call-sites
(Phase 1) — and (b) the machine drowning in its own defenses: false-firing gates, orphan guards, dual paths,
and a self-build trap whose surface shrinks as the salvage/completion cluster gets smaller and co-located
(Phase 3). Every phase makes the system SMALLER; the only additions are one reaper invocation and the
seam-pinning audits. That is the same shape as every fix in this codebase's history that actually held.
