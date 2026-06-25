# BUG-REPORT 2026-06-24 — Codex LOA-1588 (CRED_017 dispute detection): R-DPGT 2nd independent repro (detached large-tier overrun) + no-op-audit evidence misattribution

| | |
|---|---|
| **Date** | 2026-06-24 |
| **Run** | LOA-1588 Phase 1 — credit active-dispute detection (CRED_017), full pipeline (refine→build→anatomy-park→szechuan) |
| **Runtime** | v2.0.0-**beta.24** (B-RPGT), source == deployed — same fixed runtime as the LOA-1363 run-4 field-proof |
| **Backend** | codex |
| **Pipeline** | `[pickle, anatomy-park, szechuan-sauce]` (citadel intentionally omitted by operator); scope `branch` base `main`; 9 tickets (5 impl + 1 e2e wiring + 3 large-tier hardening); worker-timeout 2400s; max_iterations 0 (∞) |
| **Session** | `~/.local/share/pickle-rick/sessions/2026-06-24-dd431484` |

> **Correction note (same-day):** an earlier draft of this report (filename `…rdpgt-2nd-repro-failed-not-terminal-for-advance.md`, now deleted) claimed the mechanism was the "`Failed`-counted-as-pending / B-DURA T40" variant and that the tickets "failed honestly." That was based on a **transient mid-overrun snapshot** (status `Failed` at the 22:37 phase-exit). The correct, evidence-backed mechanism is **R-DPGT detached-worker overrun** (below). The tickets ultimately reached `Done` with green commits 7–12 min after the runner exited.

## TL;DR / Verdict

Clean **2nd independent repro of [[R-DPGT]]** — the *same* detached-in-flight mechanism as LOA-1363 run-4, on a different bundle:

- ✅ **Build + completion-evidence + green HELD.** All 9 tickets reached `Done` with durable runner/worker-authored commits; **HEAD typechecks clean (`tsc --noEmit` exit 0)**, including the large unreviewed detached refactor. **R-DOTR did NOT recur** (no Done-over-red).
- ❌ **`Pipeline finished: 0/4 phases, 76m 47s` — anatomy-park + szechuan never ran.** The 3 trailing **large-tier** hardening tickets were detached workers (B-WPEX-AUTO). At the pickle no-progress/cap the runner marked them `Failed`, declared `0/4`, and **exited** — but the detached workers were **still running**; they finished and committed **7–12 min after** the `0/4` declaration. Downstream review phases were already skipped.
- ⚠️ **NEW sub-finding — no-op-audit evidence misattribution.** `ca933c63` (data-flow audit) legitimately produced **no diff** (it found nothing to fix), yet was flipped `Done` with `completion_commit: c253c6c6` — which is **`89c654f7`'s** e2e commit (`fix(89c654f7): add dispute full-path e2e`), a *different* ticket. A no-op audit ticket borrowed an unrelated ticket's hash as its completion evidence.

**Bottom line: R-DPGT detached-overrun reproduces a 2nd time and is the load-bearing "0/N → downstream skipped" cause here; the completion oracle additionally accepts a foreign commit hash as a no-op ticket's evidence.**

---

## Timeline (UTC — runner finished 22:37:50Z)

| Event | UTC | Δ vs finish |
|---|---|---|
| `c253c6c6` `fix(89c654f7): add dispute full-path e2e` (T6, legit) | 22:34:14 | −3m |
| **Runner: `Phase pickle … 3/9 tickets remain pending (6 Done)`; `recovery_exhausted`; `Pipeline finished: 0/4 phases`** | **22:37:50** | 0 |
| `d3dbdef27` `fix(4a8bb626): harden dispute detection tests` (detached) | 22:44:50 | **+7m** |
| `9b6d58f3` `fix(f5c58f4b): split credit dispute helpers` (detached, **648+/497−** across `credit-text-generator.ts` + `summary-computer.ts`) | 22:50:03 | **+12m** |

The runner's `3/9 remain pending` set was, at that instant, three detached large-tier workers still executing. They committed real green work after the gate gave up — citadel/anatomy/szechuan never saw it. (LOA-1363 run-4's overrun was 4–10 min; here 7–12 min — same class.)

### Corroborating state
- `state.recovery_attempts`: `auto-split` fired ×3 (iter 24/31/38), each `outcome: failed, reason: "no_work_produced — falling through to existing oversized_no_progress Failed-flip [backend=codex;mode=worker]"`. So the **`oversized_no_progress` Failed-flip path is implicated** even though the ticket frontmatter records `failed_reason: no_progress_timeout` — a label/flip seam worth a glance.
- Final frontmatter: all three carry **both** `status: Done` **and** a stale `failed_reason: no_progress_timeout` (the Failed-flip set the reason; the later detached completion flipped status to Done but did not clear the reason).

## Why R-DPGT, not the "Failed-non-terminal/T40" variant
The mid-run `Failed` was transient. The tickets were never *terminally* `Failed` — their detached workers were in-flight and subsequently produced durable `completion_commit`s, flipping them to `Done`. This is precisely the **detached-ticket non-terminal-at-cap** case the existing R-DPGT row names (B-DURA T40's empty-window fix makes *Failed* terminal-for-advance but does NOT cover *detached-in-flight-at-cap*). This run **corroborates R-DPGT directly** rather than introducing a new variant.

## Contributing (not a runtime bug)
- **Decomposition (mine):** the 3 hardening tickets were large-tier "review ALL 8 files, ≤3 cycles" — long enough to still be detached-running at the cap, and **redundant** with the anatomy-park + szechuan phases they then blocked. Lesson: on codex, prefer the review phases over large review-all hardening tickets, or size hardening per-file so each finishes before the cap.
- **Pre-existing repo RED:** 390 prettier errors in `packages/api/src/database/schema/missing-appraisal-templates-db-evaluation.spec.ts` (on `main`, unrelated) fail repo-wide `lint:quiet` — gate friction; workers correctly deferred.

## Proposed fixes (reuse-first — align with existing R-DPGT row)
1. **Detached grace-drain at cap** (primary, = R-DPGT row's direction): before exiting `0/N` on an "unfinished" set that is entirely detached+advancing, grant a bounded grace-drain keyed to the existing detached poll; OR treat a detached ticket that later acquires a durable `completion_commit` as retroactively terminal-for-advance (reuse the single `readEvidence` oracle). No new machinery.
2. **Evidence-oracle: reject foreign-ticket completion_commit** — a no-op/audit ticket flipping `Done` should record an explicit *no-change* disposition, not another ticket's hash. Tighten the oracle so `completion_commit` must be authored *for this ticket* (or be a sanctioned no-op marker), closing the `ca933c63 → c253c6c6` misattribution.
3. **Soft trailing hardening** — let trailing hardening tickets be non-blocking so their detached overrun never gates downstream review phases (which do the same cleanup).

## Cross-refs
- [[R-DPGT]] — **2nd independent repro**, same detached-overrun mechanism (LOA-1363 run-4 = 1st).
- [[R-DOTR]] — did **NOT** recur (HEAD `tsc` green) — useful negative.
- **B-DURA T40** — NOT implicated here (the tickets were not terminally `Failed`); correcting my earlier mis-file.
- R-PFNT facet-2 / `oversized_no_progress` label — the `recovery_attempts` reason string still routes through "oversized_no_progress Failed-flip"; verify the WS-2d split (`b60a112e`) fully covers the auto-split fall-through path.

## Artifacts
- Session `~/.local/share/pickle-rick/sessions/2026-06-24-dd431484/`: `pipeline-runner.log` (22:37:50Z `0/4`), `f5c58f4b/worker_session_44421.log` (APPROVED research + live edits at the cap), `TOOLING_DEFECT.md` (operator capture).
- Branch `gregory/loa-1588-…`: 8 ticket-attributed commits; HEAD `tsc --noEmit` exit 0.
