# Bug: post-rate-limit thin quota wedges a large ticket at the research→plan boundary; a concurrent peer session's dirty prds/ pollute zero-progress detection

**Filed**: 2026-06-11 (babysitter intervention #8, session 2026-06-10-f50e5c11, v2.0.0-beta.1 bundle, ticket e56ed23f / H1 orphan-chain reattach)
**Severity**: P2 — composes three already-filed bugs into a run-stranding loop; one genuinely new finding (cross-session signature pollution)
**Status**: Open

## Incident

After the B-RLAR auto-resume at 19:06Z (only ~6 min past the 19:00Z window reset → thin quota), the large H1 ticket (e56ed23f) entered a non-converging loop across iterations 62–67:

- Every iteration: worker spawns → produces `research_2026-06-11.md` + `research_review.md` → **never writes a plan** → exits `[exit-commit] gate not green — leaving uncommitted work` → respawn. `step` stuck at `plan`, no `plan_*.md` ever written, no implementation, no conformance.
- Worker logs mostly 0-byte (silent-death render) — workers dying mid-plan-phase on thin quota / circuit-breaker churn (`HALF_OPEN→CLOSED` recovered once at 19:11Z).
- `worker_artifact_progress_zero` observer fired at iter 66 ("no new review/conformance artifacts for 3 consecutive spawns"); `zero_progress_count` climbed 2→3→4 — one-to-two iterations from a **B-LERD `ladder_exhausted` run-exit** that would strand all 18 remaining Todo tickets.
- HEAD tsc green throughout — the committed tree was never the problem; the worker simply couldn't complete a lifecycle on the available quota.

## NEW finding — cross-session zero-progress signature pollution

A CONCURRENT peer pipeline (session `2026-06-11-c653c95f`, loanlight-api/LOA-1097) left two uncommitted files in THIS repo's tree (`prds/MASTER_PLAN.md` modified + `prds/BUG-REPORT-...prdpath-gap...md` untracked — legitimately filing R-PRPATH). My session's `worker_artifact_progress[e56ed23f].last_source_signature` captured those exact `git status`/`numstat` lines (the two prds/ paths plus a NUL-delimited numstat fragment). The zero-progress detector's source-change signal is therefore contaminated by an UNRELATED session's static dirty files — a constant that registers no per-iteration delta, removing source-change as a progress signal and leaving only the (also-stuck) conformance-artifact count. Two concurrent pickle pipelines sharing one git working tree cross-pollute each other's progress detection.

## Recovery applied

- Froze (killed my session's mux + pipeline-runner + workers; left peer procs/files untouched).
- Confirmed HEAD tsc green; no H1 code to lose (worker never implemented).
- Cleared poisoned `worker_artifact_progress['e56ed23f']`; re-asserted flags; relaunched. Iter 68, H1 re-attempting on now ~1h-past-reset quota.

## Fix proposal (machine-checkable)

1. **Scope the source signature to the session's own ticket paths** (AC-1): `last_source_signature` must be computed over ONLY `git status`/`numstat` entries under the current ticket's declared `Files to modify/create` (or `working_dir`), excluding any path no ticket in this session owns. Assert: an unrelated dirty file (e.g. a `prds/` file from another session) does not appear in the signature and does not affect zero-progress classification.
2. **Phase-aware no-progress** (AC-2): a worker that ADVANCED a phase (e.g. wrote research where none existed) within the iteration is "progress" even without a new conformance artifact — count research/plan emergence, not just review/conformance, for the first N iterations of a large ticket. Assert: research-then-plan-then-implement across 3 iterations is not flagged zero-progress.
3. **Rate-limit-adjacent grace** (AC-3, composes with B-RLAR): zero-progress counting is suspended for the first ≥1 iteration after a `rate_limit`/circuit-breaker recovery (thin-quota workers dying ≠ no-progress). Assert: a worker that 429-dies within K seconds of a breaker recovery does not increment `zero_progress_count`.
4. Cross-refs: **B-RLAR** (thin quota at window boundary), **B-MRSW** (silent-death mid-lifecycle), **B-LERD** (the ladder-exit this nearly triggered). This bug is the loop those three form together on a large ticket.

## Verification of recovery

- mux-runner.log 20:12:47Z: Iteration 68, current_ticket=e56ed23f, 2 workers; counter cleared.
