# BUG REPORT — Codex backend: `done_without_commit_evidence` fatal POST-B-PCOMP + cross-iteration work corruption (multi-ticket)

**Date:** 2026-06-22
**Finding code:** R-CECX (Completion-Evidence, codeX backend) — instance of the open completion-commit cluster, **recurring after B-PCOMP (v2.0.0-beta.22) on a backend/shape B-PCOMP was never field-proven against.**
**Priority:** P2 (capture-only — sanctioned recovery exists; but this is a **GA-soak data point**: it is the first live **multi-ticket** run and it is on **codex**, both of which the B-PCOMP field-proof did NOT cover)
**Status:** OPEN / capture-only (filed while babysitting a real run — LOA-1363)
**Runtime:** deployed == source == **v2.0.0-beta.22** (B-PCOMP shipped + deployed 2026-06-21). Backend **codex** (`gpt-5.4`).

**Family:** open completion-commit / Done-flip cluster — [[B-WUWC]]/[[R-CCQF]] (`done_without_commit_evidence` exit_reason), [[R-CECB]] (claude-backend sibling, 2026-06-20), [[R-AFCC]]/[[R-RIC]]/[[R-CCC]] (codex-spark workers skip `completion_commit` frontmatter), [[B-PDBL]] (inferred-completion backfill caveat). **Closely mirrors `BUG-REPORT-2026-06-20-completion-evidence-fatal-claude-backend-strands-bystander-ticket.md` (R-CECB) — but on the codex backend, post-fix, with a worse failure mode: not just "committed-but-unattributed," but committed *nothing* AND corrupted shared files across context-cleared iterations.**

## Summary
A `/pickle-pipeline --backend codex` run of a real 14-ticket additive bundle (LOA-1363, six new credit-registry rules) halted at **`Pipeline finished: 0/4 phases, 8m 50s`** with **`exit_reason=done_without_commit_evidence`**. Unlike R-CECB (which salvage-looped an already-committed ticket), here:

1. **The codex workers produced ZERO git commits.** `git log main..HEAD` was empty at halt. B-PCOMP's WS-D2 finish gate "reconciles completion against the branch" — but with no commits on the branch there is nothing to reconcile, so every ticket reads evidence-absent → fatal. **B-PCOMP closes the "committed-but-unattributed" hole; it does not close the "committed-nothing" hole on codex.**

2. **Cross-iteration work corruption (new, worse than stranding).** Iteration 1 (ticket `2d238c23`, R1/`CRED_017`) *did* implement the rule — iteration log shows `CRED_017` ×15 + `payment-history.ts` ×8 — and the runner flipped it **Done**. But with no commit, that work was not durable. Iteration 3 (ticket `f0c49e67`, R2/`CRED_018`), running from a cleared context, **rewrote the shared registry files from the stale 16-rule base**, dropping R1 entirely. End state on disk:
   - `payment-history.ts`: **no `CRED_017`** (R1's work gone) — yet ticket marked Done.
   - `rule-registry.ts`: imports/array reference **only `CRED_018`** (not `CRED_017`).
   - `rule-fn-registry.ts`: integrity floor bumped to **`mapSize < 18`** while only **17** rules exist (16 base + `CRED_018`) → **the module throws at import** (`expected >= 18 entries, got 17`).
   - All of it **uncommitted** and internally inconsistent.

   i.e. a ticket can be marked **Done** while its code is **absent**, and a later ticket can silently delete an earlier ticket's edits to a shared file because nothing was committed at the iteration boundary.

## Repro (real run)
- Session `2026-06-22-b6b75d07` (`pipeline-b6b75d07`), backend=codex, scope=branch, worktree `~/loanlight/loa-1363-worktree`, 14 serial tickets (10 impl/wiring + 4 hardening), additive (new rule files + shared registry edits + an additive optional schema field).
- `pipeline-runner.log`: `PHASE 1/4: PICKLE (backend=codex)` → `Phase pickle exited with code 0` → `Phase pickle exited but 13/14 tickets remain pending (1 Done) — not all-tickets-terminal` → `exit_reason=done_without_commit_evidence` → `Pipeline finished: 0/4 phases, 8m 50s`.
- iteration logs: `tmux_iteration_1.log` (R1, CRED_017 worked), `tmux_iteration_3.log` (R2, CRED_018 worked); **no commits in either**. `git log main..HEAD` empty throughout.

## Root cause (hypothesis)
Two compounding gaps, both downstream of "codex workers don't commit":
1. **Codex phase workers do not reliably run the per-ticket `git commit` step** (no commit at all, not merely a non-attributable subject as in R-CECB). The worker prompt/runtime for backend=codex does not enforce/verify a commit before the iteration ends.
2. **No commit at the iteration boundary → context-cleared workers operate on an unstable tree.** B-PCOMP's "bystander stash-not-commit" (`aff2cfd4`) protects dirty work from the *salvage archiver*, but does nothing when a *later* worker rewrites a shared file (`rule-registry.ts`/`rule-fn-registry.ts`) from a stale base — the earlier ticket's uncommitted edits to that same file are clobbered, not stashed. The Done-flip is not gated on the edit being durable.

Net: B-PCOMP was field-proven on **claude, single-ticket** (R-WSDO, 4/4 hands-off). The **codex** path and the **multi-ticket shared-file-contention** path were both unproven — and both fail here.

## Impact
- **Codex backend is currently non-viable for hands-off multi-ticket builds** at beta.22 — the build phase produces nothing durable and halts 0/4.
- **Silent correctness hazard:** a ticket flips Done with its code absent; a later ticket can delete an earlier ticket's shared-file edits; the tree can be left in a state that throws at import — all uncommitted, so a naive "resume" reproduces the corruption.

## Recovery used (sanctioned)
1. Diagnosed via `pipeline-runner.log` (`done_without_commit_evidence`) + `git log main..HEAD` (empty) + grep of `tmux_iteration_*.log` (work was done) + inspecting the inconsistent tree (floor 18 / 17 rules / no CRED_017).
2. `git checkout --` the three corrupted tracked files back to the clean 16-rule base; removed the orphan `public-records.spec.ts`; kept untracked docs.
3. Reset ticket frontmatter `status: Done|In Progress → Todo` for R1/R2.
4. Set `state.flags.allow_inferred_completion_commit=true` (per `reference_pickle_commit_evidence_fatal`) so the runner commits each ticket's verified dirty work itself — both satisfying the evidence gate and making work durable across context clears.
5. Relaunched the pipeline; PHASE 1/4 restarted clean.

## Proposed fix direction (capture-only — do NOT auto-fix)
- **Codex worker must commit-or-fail per ticket:** the backend=codex worker contract should run (and verify) a per-ticket `git commit` with an attributable subject/`completion_commit` frontmatter before signalling completion; if the tree is dirty-but-uncommitted at worker exit, the runner should commit it (inferred) **before** clearing context for the next ticket — not only at the salvage path.
- **Gate Done-flip on durability:** a ticket should not flip Done if its declared `Files to modify/create` show no diff vs the pre-iteration tree (catches "marked Done, code absent").
- **Consider defaulting `allow_inferred_completion_commit=true` when backend=codex** (or auto-enable on first `done_without_commit_evidence`), since codex workers demonstrably under-commit.
- **Shared-file contention guard:** when a later ticket edits a file an earlier (uncommitted) ticket touched, base the edit on the accumulated tree, not the original base (the missing commit is the real cause — fixing #1 fixes this).

## GA-soak relevance
This is a **GA field-soak intervention record** (the MASTER_PLAN's active work item). It is the **first live multi-ticket** bundle and the **first codex** run — the two coverage gaps the B-PCOMP write-up explicitly called out as unproven. Result: **B-PCOMP does NOT hold on codex multi-ticket.** GA (drop `-beta`) should not proceed on codex until R-CECX is closed or codex is documented as claude-only for hands-off runs.

---

## Run 3 corroboration — LOA-1488 (2026-06-23, codex multi-ticket, 17 tickets) — *refines root cause*

Third live `/pickle-pipeline --backend codex` GA-soak run (session `2026-06-22-27298c24`, `pipeline-27298c24`, worktree `~/loanlight/loanlight-api-wt-loa1488`, scope=branch, 17 tickets = 9 impl + 3 AC-smell + 1 wiring + 4 hardening). Same headline symptom as R-CECX/R-PFNT: `Phase pickle exited with code 0` → `5/17 tickets remain pending (12 Done) — not all-tickets-terminal` → `exit_reason=done_without_commit_evidence` → `Pipeline finished: 0/4 phases, 174m 28s`, no advance to citadel.

**But the failure shape diverges from R-CECX in ways that matter for B-DURA's root cause:**

1. **Codex workers DID commit — 11/12 with correct hash-tagged subjects AND `completion_commit` frontmatter.** `git log main..HEAD` was NOT empty (contra R-CECX): `feat(c1205644):`, `fix(8197e399):`, … through order 110, all attributable. The cross-repo octy ticket (`f763d367`) even committed correctly in the *octy* repo (`729c6af fix(f763d367):`). So "codex workers don't reliably commit" is **intermittent, not categorical** — here it was 11/12. The B-DURA hypothesis ("codex under-commits") holds only weakly on this run; the durable-boundary invariant is still the right fix, but the failure here was NOT "committed nothing."

2. **Exactly ONE ticket tripped the evidence gate** (`20d38069`, order 120): work was genuinely committed (`6901ef035 test: verify statement analyzer emission matrix`) but the subject **omitted the `(hash)` tag** and no `completion_commit` frontmatter was written → classified evidence-absent → contributed to the `done_without_commit_evidence` halt. This is the R-CECB "committed-but-unattributed" face, recurring on codex post-B-PCOMP — i.e. B-PCOMP's branch-reconciliation finish gate still can't attribute a real commit whose subject lacks the tag.

3. **No cross-iteration corruption this run.** The 12 Done tickets are durable and internally consistent (typecheck clean on the worktree HEAD); no "Done with code absent," no shared-file clobber. The corruption face of R-CECX did not reproduce — plausibly because the workers committed, which is exactly B-DURA's thesis (the missing commit *is* the corruption cause; when commits land, no clobber).

4. **Premature manager exit left GENUINE unstarted work, not just an evidence mirage.** Of the 5 non-terminal tickets: 1 wiring (In Progress, no commit) + **4 hardening tickets still `Todo`, never attempted**. The codex manager exited at **iteration 49 of max 500** — nowhere near the iteration budget — leaving real work undone. This is the R-PFNT "phase exits with non-terminal tickets" facet, but here the tickets were legitimately incomplete (not green-but-misgated). Suggests a second, distinct defect: **the codex manager terminates the pickle phase before draining the ticket queue**, independent of the evidence-attribution bug.

**Recovery (verified, same family as R-CECX):** backfilled `20d38069` `completion_commit: "6901ef035"`; reset wiring `87913c5f` status `In Progress→Todo`; set `state.flags.allow_inferred_completion_commit=true`; relaunched → PHASE 1 resumed clean at the wiring ticket, scope re-resolved 1→26 files.

**Matrix update:** GA-soak codex multi-ticket auto-advance now **0-for-3** — BUT run 3 is the first where the *build itself* largely succeeded (12/17 durable, correct attribution on 11). The blocker is narrowing from "codex produces nothing" → "(a) one-off missed-tag attribution + (b) premature phase-queue drain." B-DURA's runner-authored-commit-at-every-boundary closes (a); **(b) (premature manager exit at iter 49/500 with Todos remaining) may need a separate AC** — recommend B-DURA add an explicit "phase does not exit while non-Failed Todo/In-Progress tickets remain and iteration budget is unspent" invariant.

### Run-3 follow-up — operator (babysitter) interventions, 2026-06-23 — *three NEW facets*

While babysitting run 3 (LOA-1488) to completion, three failure facets surfaced that are NOT covered by R-CECX/R-PFNT and warrant capture:

1. **Out-of-scope sibling-spec breakage from a DI constructor addition (NEW defect class).** Ticket 60 correctly added `StatementAnalyzerHealthService` as the 14th `LangGraphService` constructor injection. But sibling agent spec `appraisalEvaluation/buildAppraisalEvaluationGraph.spec.ts` instantiates `new LangGraphService(...)` positionally with 13 mocks → `tsc` RED ("Expected 14 arguments, but got 13") at 6 call sites. That file is **outside the port's MODIFIED_FILES scope fence**, so no fenced worker could fix it; the build stayed RED, which in turn **failed the hardening tickets' typecheck gates** (they kept reporting `oversized_no_progress`/Failed — a misleading symptom; the real cause was the unfixable out-of-scope compile error). **Lesson:** when a ticket changes a shared/injected signature, the scope fence MUST auto-extend to all positional callers of that symbol (esp. `new <Class>(`/factory call sites in specs), or readiness must flag "signature-change without caller co-scope." Recommend adding to the 7-class audit (registration-co-location's sibling: *signature-change-caller-fanout*).

2. **`recovery_exhausted` immediately on a status-reset retry (per-ticket budget not refunded).** Resetting a Failed ticket's frontmatter `status → Todo` and relaunching does NOT reset the per-ticket recovery counter → the phase re-exits `exit_reason=recovery_exhausted` in ~2s without re-attempting. So the documented "reset to Todo + relaunch" recovery is INERT once a ticket has exhausted its recovery ladder. Operators must either refund the per-ticket counter (location unclear in state) or fall through to the R-PFNT drop-pickle path.

3. **Benign branch-race / moved-base → polluted `scope=branch` (NEW recovery technique).** `main` advanced mid-run (LOA-1359 `#2266` merged while the build ran), so `scope=branch base=main` computed a phantom **10,111-deletion** diff (all of LOA-1359's credit-rules code shown as "missing from this branch"). The review phases would have choked on it. **Recovery that worked WITHOUT a rebase:** pin `pipeline.json.scope_base` to the **merge-base SHA** (`git merge-base main HEAD`) instead of `main` → scope resolved to the true 28-file port diff; citadel/anatomy/szechuan run clean. Recommend the runner auto-detect "base ref moved since session start (`start_commit`)" and pin scope to the original branch point (or `start_commit`) rather than live `main`.

**Outcome:** build fixed green (arity commit `ccad8c39e`, operator-authored, out-of-fence), scope re-pinned, pickle dropped (15/17 done; 2 hardening tickets abandoned to recovery_exhausted — their data-flow/test-quality intent is largely covered by anatomy-park + szechuan), pipeline advanced to CITADEL. The 2 abandoned hardening tickets are the residual cost of facets 1+2.

### Run-3 follow-up #2 — review-phase type regression + transient-529 szechuan abort (2026-06-23)

Two more facets surfaced finishing the LOA-1488 review phases (citadel ✅ → anatomy-park ✅, 13+ HIGH run-lifecycle fixes → szechuan):

4. **Review-phase commit reintroduced a build-RED type regression that the phase's own gate never caught.** anatomy-park's "fix success handoff runId loss" refactor wrapped `handleStatementAnalyzerSuccess` in `.then()` closures, which **lose TypeScript's outer `final.runId !== undefined` narrowing** → `runId: string | undefined` vs the discriminated return's required `string` (tsc RED, 3 sites in `langgraph.service.ts`). It slipped through because **szechuan aborted on a transient API error BEFORE its finalize-gate ran** (see facet 5), so the ungated handoff commit's type error was never gate-checked. Operator fix `f8f5d753d`: bind `const runId: string = final.runId` after the guard, use it inside the closures. **Lesson:** per-iteration gates that run typecheck must run even on phase-abort paths, or a phase that aborts mid-flight can leave the tree RED with an un-gated commit. (Sibling of R-SIGF — both are review/build-phase commits breaking the build in ways the fenced/aborted gates miss.)

5. **Transient `API Error: 529 Overloaded` → `baseline_unmeasurable_unrecoverable` aborts the whole szechuan phase (no retry-with-backoff-past-4).** szechuan's microverse measures its quality metric via an LLM call ("LLM baseline metric: 4"); a 529 burst exhausted 4 attempts and the phase exited `baseline_unmeasurable_unrecoverable`, aborting `2/3 phases` with no finalize-gate. A server-side 529 is transient and should not terminate a 3-hour pipeline — the metric measurement needs longer/exponential backoff or a resumable park (like the rate-limit park elsewhere), not a hard 4-attempt abort. Operator recovery (verified): once the API recovered, reset `microverse.json`, set `pipeline.json.phases=["szechuan-sauce"]` (citadel+anatomy already green), relaunch → szechuan re-entered active. **Recommend:** treat 529/Overloaded in the microverse metric path as park-and-retry (reuse the B-RRH rate-limit park), not `baseline_unmeasurable_unrecoverable`.

6. **szechuan deslop converged GREEN on its LLM metric while leaving the tree tsc/lint-RED (2026-06-23).** szechuan KISS/DRY commits dropped a mock's `Promise.resolve` wrapper and made an e2e `runId` nullable at an `eq()` call site → 3 tsc errors, committed because szechuan's convergence gate measures an LLM quality score, NOT `tsc`/`eslint`. Same root as facet 4 (R-SIGF family): review/cleanup phases MUST run typecheck+lint as a hard gate before committing, or "converged/complete" ships a red tree. Operator green-up: restore Promise wrapping + `runId!` (guarded by the preceding `expect(runId).toBeTruthy()`).
