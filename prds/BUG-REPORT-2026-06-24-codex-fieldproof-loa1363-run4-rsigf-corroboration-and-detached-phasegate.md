# BUG-REPORT 2026-06-24 — Codex field-proof (LOA-1363 Phase 2b, run 4, beta.24): R-CECX/R-PFNT facets HELD, R-SIGF corroborated, NEW detached-phase-gate residual (R-DPGT)

| | |
|---|---|
| **Date** | 2026-06-24 |
| **Run** | LOA-1363 Phase 2b — credit-rules rework (codex), **the AC-DURA-4 codex field-proof** the MASTER_PLAN was waiting on |
| **Runtime** | v2.0.0-**beta.24** (B-RPGT), source == deployed — the fixed runtime (B-DURA + B-RPGT) |
| **Backend** | codex (`gpt-5.4`) |
| **Pipeline** | `[pickle, citadel]` (anatomy/szechuan skipped); scope `branch` base `main`; 14 tickets (10 impl + e2e + 4 hardening); worker-timeout 1200s; max_iterations 500 |
| **Session** | `~/.local/share/pickle-rick/sessions/2026-06-24-7b082b20` |

## TL;DR / Verdict

This is the first codex multi-ticket run on the **fixed** runtime (beta.24) — the decisive AC-DURA-4 data point. Result is **split, and decision-changing**:

- ✅ **The completion-evidence reliability fixes HELD on codex.** R-CECX (committed-nothing / cross-iteration corruption) and R-PFNT facets **1** (two-oracle disagreement) + **2** (`oversized_no_progress` misclassification) did **NOT** recur. 14/14 tickets reached `Done` with **durable runner-authored commits** (86 commits on branch, 34 ticket-attributed), 825 valid-evidence/inferred acceptances, **zero** `oversized_no_progress` labels (7× the new `no_progress_timeout` instead), zero `done_without_commit_evidence` fatals. **These three facets convert from "pending codex proof" → "codex-PROVEN."**
- ❌ **AC-DURA-4 is NOT cleanly met.** The pipeline reported **`Pipeline finished: 0/2 phases`** and **citadel never ran**, even though the build genuinely completed (14/14 durable). The cause is **not** the original R-PFNT facets (those held) — it is a **NEW facet-3 variant (R-DPGT)** driven by **R-SIGF** (second independent reproduction).

**Bottom line: the reliability *code* is now codex-proven for the completion/oracle/label classes — the GA blocker that mattered most — but R-SIGF's deferred half is now the load-bearing failure, and it cascades through a new detached-phase-gate timing seam into the very "0/N phases → downstream skipped" symptom R-PFNT was supposed to retire.**

---

## What HELD (codex fixes field-proven)

### R-CECX (committed-nothing + cross-iteration corruption) — ✅ codex-PROVEN
- Codex workers did **not** commit-nothing. `git rev-list --count main..HEAD` = **86**; 34 ticket-attributed (`fix(<hash>)`). The durable-iteration-boundary (B-DURA T10 `e1472c37`, runner authors the commit) worked: every ticket has a `completion_commit`.
- No cross-iteration clobber observed — each next worker started from a committed tree. The "Done with code absent → later ticket rewrites shared registry from stale base" corruption did not recur.

### R-PFNT facet 1 (single evidence oracle) — ✅ codex-PROVEN
- No two-oracle disagreement, no `readEvidence()` FATAL on present-`completion_commit` frontmatter. 825 acceptances logged as `valid completion_commit evidence` / inferred, all consistent. The watcher≡flip-gate collapse (T30 `be667dee`) held.

### R-PFNT facet 2 (label split, WS-2d `b60a112e`) — ✅ codex-PROVEN
- **0** tickets labeled `oversized_no_progress`; **7** labeled `no_progress_timeout` (orders 20/30/40/100/110/120/130). The conflated label is gone; classification is correct.

---

## What RECURRED — NEW residual: R-DPGT (detached-ticket phase-gate non-terminal timing)

**Symptom:** `Pipeline finished: 0/2 phases, 106m 11s` → **citadel never started** (0 `PHASE 2/2` markers) — despite all 14 tickets ultimately `Done` with valid commits.

**Mechanism (timestamps, all UTC):**
- `16:09:43.084Z` — `Phase pickle exited with code 3` → `Phase pickle hit iteration cap; 3/14 tickets remain unfinished` → listed **100 (In Progress), 110 (Todo), 130 (Todo)** → `Pipeline finished: 0/2 phases`.
- The final mux-runner lines before exit are a tight ~1.3s loop: `recovery: execute-converged-plan advanced detached 54d89f21 before terminal disposition — continuing` — i.e. the phase was **polling a detached large-tier ticket that had not reached terminal disposition**, and bailed.
- The 3 "unfinished" tickets' commits landed **AFTER** the 0/2 declaration:
  - `38e947235 be641400` (130) @ **16:13:58Z**
  - `a619be372 d848f1b3` (110) @ **16:16:44Z**
  - `8bc4e4fa4 54d89f21` (100) @ **16:19:13Z**
- So the detached workers committed valid work **4–10 min after** the phase-gate gave up and skipped citadel.

**Distinct from the shipped facet-3 fix.** B-DURA T40 (`f788aa43`) made `Failed` *terminal-for-advance under the empty-window guard*. That covers the "3 Failed polish tickets atop 10 Done → 0/4" path. It does **NOT** cover **detached tickets that are still In-Progress/non-terminal when the pickle phase hits its cap** — those are counted as "unfinished," the phase exits code 3, and downstream phases are skipped while the detached work is minutes from landing. Note `max_iterations` (500) was **not** reached (final iteration **149**) — the cap that fired is a **phase/detached-poll exhaustion, not the session budget**, and it fired while real progress was imminent.

**Proposed fix direction (reuse-first):** before a phase exits `0/N` on "unfinished" tickets, the gate should (a) check whether the "unfinished" set is entirely **detached + actively advancing** (the loop literally logs `advanced detached … before terminal disposition`) and, if so, grant a bounded grace drain keyed to the detached poll, or (b) treat a detached ticket that subsequently acquires a durable `completion_commit` as retroactively terminal for phase-advance (the evidence is the same single oracle that already works for the Done-flip). Either keeps citadel from being skipped over work that was ~minutes from terminal.

---

## ROOT DRIVER — R-SIGF (second independent reproduction)

The `no_progress_timeout` storm and the detached overrun were **not** random slowness — they trace to **out-of-fence RED**, exactly R-SIGF's predicted mode.

- The FR1/FR2/FR3 `thresholdSchema` reshapes (CRED_017 `constraints[]`, CRED_018 two-bucket, CRED_019 `alternatives[]`) changed shapes consumed by sibling spec files **outside every ticket's `MODIFIED_FILES` fence**.
- The **data-flow audit ticket (120 / `71c22d6c`) deferred verbatim:**
  > `# DEFERRED: pnpm typecheck fails in out-of-scope test/credit-rules-loa-1363.e2e-spec.ts, and pnpm test … fails in out-of-scope summary-computer.spec.ts, credit-rule-fns.spec.ts, and evaluator.spec.ts; no scoped CRITICAL/HIGH audit fix was warranted in the seven editable source files.`
- That is R-SIGF to the letter: *a changed signature/shape breaks out-of-fence callers; no fenced worker can repair them; the tree stays RED; gated tickets burn their budgets retrying → `no_progress_timeout` → iteration/recovery exhaustion → detached overrun → phase 0/N.* The LOA-1488 run-3 instance was a 14th-ctor-arg fan-out; this instance is a **threshold-schema-shape fan-out** — same class, different trigger.

R-SIGF status remains **⚠️ PARTIAL** — only the **advisory** `signature_change_caller_gap` readiness finding shipped (`a668687f`); the **full scope-auto-extension** (fence auto-extends to out-of-fence callers of a changed injected/exported **signature *or schema shape***) is **DEFERRED**. This run is the second independent demonstration that the deferred half is load-bearing: with it, the out-of-fence specs would have been co-scoped and greened; without it, the RED cascades all the way to a skipped citadel.

> **Scope note for the auto-extension design:** LOA-1488 showed the fan-out via a changed *ctor/exported signature*; this run shows it via a changed *zod `thresholdSchema` shape* consumed by seed fixtures in sibling specs. The auto-extension (or the readiness blocker) must cover **schema-shape consumers**, not only positional/type callers.

---

## AC-DURA-4 disposition

**Partial pass.** The completion-evidence reliability classes (R-CECX, R-PFNT facets 1+2) are **codex-proven HELD** — the long-standing codex 🔴 on *those* facets converts to evidence. But the literal AC-DURA-4 criterion ("a live codex multi-ticket run completes **N/N phases**") is **NOT met**: phases finished **0/2**, citadel skipped. The failure is downstream of the fixed facets (R-SIGF → R-DPGT), not a regression of them.

**Recommended AC-DURA-4 revision:** split the criterion. (a) *Completion-evidence soak* — **MET on codex** this run. (b) *Phase-completion soak* (N/N phases, downstream phases actually run) — **NOT met**; blocked on R-SIGF full auto-extension + the new R-DPGT detached-phase-gate grace.

---

## Priority recommendations

1. **R-SIGF full scope-auto-extension → promote toward P1.** It is now the **load-bearing** open reliability item: two independent codex reproductions, and it cascades into phase-skip. Extend the design to cover **schema-shape consumers** (zod `thresholdSchema`/seed-fixture sites), not just positional/type callers.
2. **R-DPGT (NEW) → file P2.** Detached, actively-advancing tickets non-terminal at the pickle iteration/detached-poll cap → phase exits `0/N` and skips downstream while the work lands minutes later. Reuse the single evidence oracle for retroactive-terminal, or a bounded detached grace-drain.
3. **Update the codex scorecard:** 🔴 0-for-3 → **🟡 partial** — completion-evidence facets proven on codex; phase-completion blocked on R-SIGF/R-DPGT.

---

## Evidence appendix

**Ticket outcomes (all Done; `<reason>` = failed_reason recorded despite Done via durable commit):**

| Order | ID | Status | completion_commit | reason |
|---|---|---|---|---|
| 10 | 716522f0 | Done | d13027891 | |
| 20 | eb02a473 | Done | cac22716b | no_progress_timeout |
| 30 | 5b3d0fdd | Done | 657f9d43e | no_progress_timeout |
| 40 | 8d67708c | Done | 1dadeb7f6 | no_progress_timeout |
| 50 | 7693771a | Done | a69ad64d8 | |
| 60 | d71dec1d | Done | 353ca78ac | |
| 70 | a85fde31 | Done | 205b341b6 | |
| 80 | 92f76e7c | Done | 04687b154 | |
| 90 | 8267409f | Done | 14d3811e8 | |
| 100 | 54d89f21 | Done | 8bc4e4fa4 | no_progress_timeout (committed 16:19Z, after 0/2 decl) |
| 110 | d848f1b3 | Done | a619be372 | no_progress_timeout (committed 16:16Z, after 0/2 decl) |
| 120 | 71c22d6c | Done | f045a9663 | no_progress_timeout (deferred out-of-fence RED) |
| 130 | be641400 | Done | 38e947235 | no_progress_timeout (committed 16:13Z, after 0/2 decl) |
| 140 | 433a879c | Done | 1b84616c3 | |

**Counts:** 86 branch commits / 34 ticket-attributed · 825 valid-evidence acceptances · 7× `no_progress_timeout` · **0× `oversized_no_progress`** · pickle exit code 3 @ iter 149/500 · run 106m11s · citadel: never started.

**Unrelated confound (documented, not pickle's fault):** early tickets lost worker budget to a stale **GitNexus** directive in the repo's `AGENTS.md`/`CLAUDE.md` (auto-injected `npx gitnexus analyze`, which stalled). Removed mid-run (binary + both md blocks + index + skills + MCP server + PATH no-op shim). This *inflated* the early `no_progress_timeout` count but is an external repo-config issue, not a pickle defect; the R-SIGF out-of-fence RED is independent and persisted after gitnexus removal.
