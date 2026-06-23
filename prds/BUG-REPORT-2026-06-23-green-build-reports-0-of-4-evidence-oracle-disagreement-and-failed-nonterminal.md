# BUG REPORT — A fully-green build reports `0/4 phases`: evidence-oracle disagreement (phantom-Done watcher vs flip-gate) + `Failed`/`oversized_no_progress` polish tickets are non-terminal for phase advance

**Date:** 2026-06-23
**Finding code:** R-PFNT (Phase-Finish Non-Terminal) — completion-commit cluster, **post-B-PCOMP, codex multi-ticket.** Sibling of [[R-CECX]] (same session, later failure mode).
**Priority:** P1 (capture-only — recovery exists — but this is the **second** GA-soak run on codex multi-ticket and it ALSO finished `0/4` despite a complete, verified build; B-PCOMP's "ground-truth finish gate" does not hold here)
**Status:** OPEN / capture-only (filed while babysitting LOA-1363)
**Runtime:** deployed == source == **v2.0.0-beta.22** (B-PCOMP live). Backend **codex** (`gpt-5.4`). Session `2026-06-22-b6b75d07`, worktree `~/loanlight/loa-1363-worktree`, 14-ticket additive bundle (10 build/integration + 4 `large`-tier hardening reviews).

**Family:** completion-commit / Done-flip cluster — [[B-WUWC]]/[[R-CCQF]] (`done_without_commit_evidence`), [[R-CECB]] (claude finish-gate salvage), [[R-CECX]] (codex no-commit + corruption, earlier in THIS session). B-PCOMP (beta.22) claimed to collapse the finish gate to a single ground-truth `readEvidence` oracle reconciling against the branch; **this report shows the oracle is NOT single — two code paths disagree on the same frontmatter.**

## Summary
The build phase produced a **complete, independently-verified-green** deliverable — **12 commits**, `pnpm typecheck` clean package-wide, **978 credit-pipeline + registry tests passing (0 failed)**, all 22 changed files lint-clean — yet the pipeline reported **`Pipeline finished: 0/4 phases, 132m 24s`** and never ran phases 2–4 (citadel / anatomy-park / szechuan-sauce). Three compounding defects:

### Defect 1 (headline) — evidence-oracle disagreement: phantom-Done watcher ACCEPTS, flip-gate FATALS, same ticket, same frontmatter
Integration ticket `b17cc3fe` frontmatter at halt: `status: "Done"`, `completion_commit: "9adfed90990949ab7bde354392679563af6f1fbf"` (a real commit, `LOA-1363 integrate credit registry rules`). The two finish-gate oracles disagree:
- **Phantom-Done watcher** (iters 67, 68, 69): `Phantom-Done watcher kept ticket b17cc3fe Done — valid completion_commit evidence` (×3).
- **Flip-gate `readEvidence()`** (iter 69): `[fatal] ticket b17cc3fe cannot flip Done: readEvidence().kind === 'absent' (expected 'explicit'); worker did not produce an attributable git commit. Edit ticket frontmatter to include completion_commit: <sha>.`

The fatal instructs the operator to add a `completion_commit` that is **already present and which the sibling watcher reads as valid.** B-PCOMP's WS-D2 was supposed to make `readEvidence` the single oracle; here the phantom-Done watcher and the flip-gate use **different** evidence logic. Likely cause: `readEvidence` requires the *commit subject* to be hash/ref-attributable (the integration commit subject `LOA-1363 integrate credit registry rules` carries no ticket hash), and does NOT honor the explicit `completion_commit:` frontmatter field that the phantom-Done watcher honors. Two oracles, one truth, opposite verdicts.

### Defect 2 — `wmw-auto-skip` flips every detached `large`-tier review ticket to `Failed/oversized_no_progress`
All three `large`-tier hardening tickets run **detached** (B-WPEX-AUTO large-tier path) and were auto-skipped by the worker-monitor watchdog after 5 zero-progress polls:
```
[wmw-auto-skip] detached 4693a2fe: 5/5 consecutive zero-progress polls — flipping to Failed/oversized_no_progress
[wmw-auto-skip] detached 985c75ef: 5/5 consecutive zero-progress polls — flipping to Failed/oversized_no_progress
[wmw-auto-skip] detached 39ce66e2: 5/5 consecutive zero-progress polls — flipping to Failed/oversized_no_progress
```
The "oversized" label is a **misclassification**: the manager's own diagnosis was `Failed: scope fence is unclear because the ticket lacks a dedicated 'Files to modify' / 'Files to create' section; MODIFIED_FILES appears only in prose under Research Seeds … the worker stalled on scope ambiguity, not a runtime wedge.` The watchdog cannot distinguish "long legitimate review" / "scope-ambiguity stall" / "genuinely oversized" — it reports them all as `oversized_no_progress` after a fixed 5-poll zero-progress window. (Authoring contribution: the **hardening-ticket template** in `pickle-refine-prd.md` Step 7e ships `MODIFIED_FILES`/`AFFECTED_SUBSYSTEMS` as **prose placeholders under Research Seeds with no dedicated `## Files to modify/create` section** — the scope-fence resolver has nothing to parse. The template should emit a concrete per-file fence.)

### Defect 3 — `Failed` is non-terminal for phase advancement → green build masked as `0/4`
`Phase pickle exited but 4/14 tickets remain pending (10 Done) — not all-tickets-terminal, marking phase incomplete (not advancing)` → `exit_reason=done_without_commit_evidence` → `Pipeline finished: 0/4 phases`. The 4 "pending" = 3 `Failed` (watchdog-skipped polish) + 1 `In Progress`. **`Failed` is a terminal state by definition** (the runtime gave up on it), but the phase-advance gate counts it as "pending," so 3 failed *review-polish* tickets — atop 10 Done, verified-green *build* tickets — prevent the pipeline from ever advancing to citadel/anatomy/szechuan. A bundle can never finish if any single ticket terminalizes `Failed`, regardless of whether the substantive work is complete.

## Impact
- **A correct, fully-tested deliverable is reported as a total failure (`0/4 phases`)** and the entire review/cleanup half of the pipeline (citadel + anatomy-park + szechuan-sauce) silently never runs. An unattended operator reading `0/4` would conclude the build failed; it did not (12 commits, 978 tests green).
- Burned **132 minutes** and ~30 of 69 iterations on watchdog churn + the deps-blocked Done↔Skipped flip-flop (see context note), then halted with a fatal whose remedy ("add completion_commit") is already satisfied.
- B-PCOMP's headline guarantee ("zero `done_without_commit_evidence`, ground-truth finish gate") is **false on codex multi-ticket** for the second time this session (R-CECX was the first failure mode; R-PFNT is the second).

## Repro (real run)
Session `2026-06-22-b6b75d07`, backend codex, scope branch, 14-ticket bundle. `mux-runner.log`: 3× `wmw-auto-skip … Failed/oversized_no_progress`; 3× `Phantom-Done watcher kept b17cc3fe Done — valid completion_commit evidence`; then `[fatal] b17cc3fe … readEvidence().kind === 'absent'`. `pipeline-runner.log`: `Phase pickle exited but 4/14 tickets remain pending (10 Done) … Pipeline finished: 0/4 phases, 132m 24s`. Independent verification at halt: `pnpm typecheck` clean, `pnpm test --testPathPattern='credit-pipeline|registry.spec'` = 978 passed / 0 failed, `eslint` on all 22 changed files clean.

## Root cause (hypotheses)
1. **Two evidence oracles.** The phantom-Done watcher honors `completion_commit:` frontmatter; the flip-gate `readEvidence()` requires an attributable commit *subject* and ignores/under-reads the frontmatter field. B-PCOMP unified the *salvage* path on `readEvidence` but the phantom-Done watcher and the flip-gate did not converge on one oracle.
2. **Watchdog conflates three failure shapes** under `oversized_no_progress` (legitimate-long / scope-ambiguity / truly-oversized), and `large`-tier detached workers emit no per-poll progress signal the watchdog can read.
3. **Phase-advance gate treats `Failed` as non-terminal.** "all-tickets-terminal" should accept `Failed` as terminal (or, at minimum, advance to downstream phases when all *non-Failed* tickets are Done and the branch diff is non-empty).

## Recovery used (sanctioned)
Build is green and independently verified, so: (a) confirmed `typecheck`/tests/lint green directly; (b) to run the rest of the pipeline, **drop the already-complete `pickle` phase from `pipeline.json` and relaunch** `phases: ["citadel","anatomy-park","szechuan-sauce"]` against the branch diff (sidesteps all three finish-gate defects); the 4 hardening review tickets are redundant with citadel/anatomy/szechuan and are left terminalized.

## Proposed fix direction (capture-only — do NOT auto-fix)
- **One oracle.** Make the phantom-Done watcher and the flip-gate call the SAME `readEvidence`; have `readEvidence` honor explicit `completion_commit:` frontmatter as `kind: 'explicit'` (it is the operator/runtime-recorded source of truth) — a present, valid `completion_commit` must never produce `kind: 'absent'`.
- **Advance on terminal.** Treat `Failed` as terminal for phase advancement; advance to downstream phases when every non-`Failed` ticket is Done and the branch diff is non-empty (don't let polish-ticket failure mask a green build). Report `N/4 phases` against phases actually attempted, and surface "build complete, P review tickets failed" distinctly from "build failed."
- **Classify the stall.** Split `oversized_no_progress` into `scope_unresolvable` (no parseable file fence) vs `no_progress_timeout`; the former should hard-fail fast with the parse reason, not burn 5 polls.
- **Template fix (authoring).** `pickle-refine-prd.md` Step 7e hardening tickets must emit a concrete `## Files to modify/create` fence (expanded `MODIFIED_FILES`), not a prose placeholder under Research Seeds.

## Context note (interacts, separately known)
~Iterations 1–~30 burned on a Done↔Skipped flip-flop because the worktree had **no `node_modules`** (`.npmrc` needs `GITHUB_PACKAGES_TOKEN`), so `tsc/jest/tsx` were absent and every AC "blocked" → workers marked Done on static-only, manager reverted to Skipped, repeat. (Operator pre-install fixes it — `worktree_pickle_autonomous_runs` memory — but pickle should **fail fast on absent toolchain** rather than loop ~30 iterations flip-flopping.)

## GA-soak relevance
Second GA-soak codex multi-ticket run (after R-CECX); **also finished `0/4` on a green build.** GA (drop `-beta`) on codex is blocked on R-CECX **and** R-PFNT. The claude-backend single-ticket proof (R-WSDO) remains the only green hands-off field-proof; the multi-ticket + codex matrix is 0-for-2.
