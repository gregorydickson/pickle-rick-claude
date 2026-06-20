# PRD: Large-Tier Ticket Stall — Root Cause & Recovery

**Status**: Draft (2026-04-27)
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension that runs autonomous engineering loops (PRD → Breakdown → Research → Plan → Implement → Verify → Review → Simplify). Multi-iteration tmux orchestration via `mux-runner.ts`. Two backends: `claude` (default) and `codex` (OpenAI Codex CLI). Source at `extension/src/`, compiled to `extension/{bin,services,hooks,types}/`, deployed to `~/.claude/pickle-rick/` via `bash install.sh` from repo root.
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, no feature branches.
**Working directory at PRD authoring time**: HEAD `bd3ad27` (`docs(master-plan): stash session — T0 done, paused on T1, v1.56.0–v1.56.4 shipped`).

---

## ⚡ HANDOFF — READ FIRST IF YOU JUST PICKED THIS UP

You are inheriting a paused multi-day refactoring epic.

**The epic**: `prds/archive/bundles/god-functions-remediation.md` (refined SHA `1658d81`) — split 13 god functions across 11 files in `extension/src/`. 20 atomic tickets. Living session at `~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/`. Tracker doc: `prds/MASTER_PLAN.md`.

**Where the epic stands**:
- T0 (`6f3e3f01` — pre-refactor scaffolding) is `Done`. Committed at HEAD.
- T1 (`f068af3f` — Split `_emitDot` in `extension/src/services/dot-builder.ts` into 6 topology helpers + 8 tests) is `Todo`. Research and plan artifacts exist on disk at `~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/f068af3f/{research_2026-04-26.md,plan_2026-04-26.md}` with both reviews APPROVED.
- T2–T15 + 4 hardening tickets are `Todo`.

**This PRD**: T1 stalled the codex backend. This document specifies the fix for that stall. Implement the three atomic tickets in §Tickets, ship as a release, then resume the god-fn epic per `prds/MASTER_PLAN.md` §4.

**Read these in order before starting**:
1. This PRD (you're reading it)
2. `prds/MASTER_PLAN.md` (epic state of play)
3. `prds/archive/bundles/god-functions-remediation.md` (the epic itself)
4. `~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/f068af3f/plan_2026-04-26.md` (the T1 plan codex never executed — proof the planning phase isn't the bottleneck)
5. `extension/src/bin/mux-runner.ts` lines containing the strings `Circuit breaker tripped` and `No progress in` — that's the code this PRD modifies
6. `.claude/commands/send-to-morty.md` and `.claude/commands/send-to-morty-review.md` — the worker prompts this PRD modifies

---

## 1. Problem

After 5 PRC infrastructure fixes (v1.56.0–v1.56.4) cleared the way for T0 to complete, the god-fn epic relaunch stalled on T1. The codex worker burned 5 iterations of research/plan re-analysis and committed zero code. Mux-runner's circuit breaker (separate from the EPIC_COMPLETED recovery shipped in v1.56.4) correctly identified the stall and exited. **No bug fired, no token confusion, no test flake — codex just couldn't make progress within the iteration budget on a large-tier ticket.**

This is the next blocker for the epic. Without resolving it, every large-tier ticket (T1–T5, T9, plus the 4 hardening tickets — 9 of the remaining 19) risks the same fate.

### The five PRC releases shipped during T0 (context — already in main, do not re-do)

| Version | SHA(s) | What it fixed |
|---|---|---|
| v1.56.0 | `47dd1a8`, `8ab6c87`, `e89f93a` | Phase template misroute on resume; clean-tree exclusion for `prds/`/`docs/`; microverse pre-flight exclusion; auto-commit untracked rescue. Also moved `MASTER_PLAN.md` into `prds/`. |
| v1.56.1 | `8f127ee` | Worker prompt "Write ONLY to `${TICKET_DIR}`" — codex took literally and refused all repo writes. Disambiguated to authorize Steps 5+8 to write to project tree. |
| v1.56.2 | `f82012c` | 38 timing-sensitive tests bumped 3–5x to survive load when codex runs concurrent tool calls. |
| v1.56.3 | `3cb670d`, `07f65db` | Morty workers leaked orchestrator promise tokens upstream. Added `FORBIDDEN_WORKER_TOKENS` + runtime scrub in `spawn-morty.ts` finalize-time + prompt-level forbidden list. Plus T0 smoke fixture corrections. |
| v1.56.4 | `853b860`, `aa18e5c` | Manager itself misuses `EPIC_COMPLETED`. Replaced fail-loud guard with `evaluateEpicCompletion()` 4-arm recovery state machine. Counter persists in `state.false_epic_completed_count`. **Recorded 18 successful recoveries during T0.** |

### Concrete failure (T1 timeline, all UTC, derived from `pipeline-runner.log`)

```
04:26:57   T0 marked Done by model — skipping validation; advanced to T1
04:26:58   --- Iteration 4 (state.iteration=1) ---     [T1 iter 1]
04:34:52   --- Iteration 5 (state.iteration=1) ---     [T1 iter 2]
04:39:18   --- Iteration 6 (state.iteration=1) ---     [T1 iter 3]
04:45:44   --- Iteration 7 (state.iteration=1) ---     [T1 iter 4]
04:51:19   --- Iteration 8 (state.iteration=1) ---     [T1 iter 5]
04:55:06   Circuit breaker tripped: No progress in 5 iterations
04:55:06   Phase pickle exited with code 1
```

T1 ran 5 iterations in 28m 9s. Six worker session logs at `~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/f068af3f/` (sizes 14K–421K) collectively show codex doing extensive `Read` calls on `extension/src/services/dot-builder.ts` lines 1237–2260 (the `_emitDot` body) and ticket-dir files, but **zero `Edit`/`Write` against `extension/src/`**. No commits. The plan that was already on disk (`plan_2026-04-26.md`) was approved by `plan_review.md` (`APPROVED`) yesterday — codex never reached its Phase 1 ("Introduce instance-backed transient emission state and promote four local helper closures").

### Why v1.56.4's recovery mechanism does NOT solve this

v1.56.4 recovers from the manager **lying** about completion (false EPIC_COMPLETED). T1's stall is the manager **honestly stuck** doing real (analytical) work that doesn't translate to commits. The `evaluateEpicCompletion()` state machine has nothing to recover from — no false EPIC_COMPLETED was emitted, the worker just kept reading. Different failure class, different fix needed.

---

## 2. Root Cause

Three compounding causes, ordered by criticality:

### RC-1 — Circuit-breaker budget is uniform across complexity tiers

`extension/src/bin/mux-runner.ts` trips the circuit breaker after 5 iterations of no progress. "Progress" is defined as a commit landed (`getHeadSha` changes) or `state.iteration` advancing. The budget is 5 for every ticket — T0 (medium tier, 0 new tests, scaffold-only) and T1 (large tier, 8 new tests, 905-LOC extraction) both get 5.

T0 made first-commit progress in iteration 2. T1 evidently needs at least 8–12 iterations on codex to even reach implementation. The budget is starving large-tier work.

The PRD frontmatter for every ticket already declares `complexity_tier: large|medium|small|trivial` and `min_new_tests: N` (see e.g. `~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/f068af3f/linear_ticket_f068af3f.md`):
```yaml
complexity_tier: large
order: 20
min_new_tests: 8
fixture_dependencies: ["dot-builder/golden-*.dot"]
file_dependencies: ["T10 (e54eebf6)", "T11 (e2e6e1cc)"]
trap_door_risk: false
```

Neither field influences runtime behavior. The information is descriptive metadata, not load-bearing.

### RC-2 — No iteration-level continuity for codex workers

Each iteration spawns a fresh codex CLI subprocess via `mux-runner.ts`'s outer loop. Codex CLI invocations don't share session state. The worker prompt (`pickle.md` for the manager, `send-to-morty.md` for per-ticket workers) tells the worker to "read `state.json` + ticket files," but does NOT explicitly tell it to **resume mid-lifecycle if research/plan artifacts already exist on disk with APPROVED reviews**.

Result: every iteration on the same ticket re-traverses Steps 1–4 (Research → Research Review → Plan → Plan Review) before reaching Step 5 (Implement). On large-tier tickets where Steps 1–4 alone consume 5+ minutes per iteration on codex, the worker never reaches Step 5 within the 5-iteration budget.

This is observable in T1's logs. From `worker_session_56147.log` last 30 lines: the worker is reading `dot-builder.ts` lines 1272–2260 (the body of `_emitDot`) — research-mode behavior. Earlier worker sessions (44950, 46006, 48512, 51162, 53952) show the same pattern.

### RC-3 — Worker prompt doesn't fast-path approved phases

`.claude/commands/send-to-morty.md` Step 1 currently reads:
```
### 1. Research
What IS, not SHOULD BE. No solutioning. Every claim = `file:line` ref.
- Read `${TICKET_DIR}/linear_ticket_${TICKET_ID}.md`
- **Glob**, **Grep** (not bash grep), **Read** to trace code
- Write `${TICKET_DIR}/research_[date].md`: Summary, Context (file:line), Findings, Constraints
```

If a `research_*.md` already exists with an APPROVED `research_review.md`, the worker should skip directly to Step 3 (Plan) or Step 5 (Implement) depending on which subsequent reviews exist. Currently the worker re-does Step 1 from scratch on each iteration, wasting the most expensive part of the lifecycle (semantic understanding of the codebase) and disproportionately hurting large-tier tickets.

---

## 3. Goals

1. **Survive large-tier tickets.** T1–T5, T9, and the 4 hardening tickets must reach completion without manual intervention on the codex backend.
2. **Don't change recovery semantics for true stalls.** A worker that genuinely loops without making progress (e.g. infinite tool-call cycle) should still trip the circuit breaker.
3. **Don't break small/medium/trivial tickets.** T6–T8 (medium), T10–T13 (small), T14 (trivial) currently work; the budget bump must not relax detection on those.
4. **Honor existing artifacts.** A worker resuming a ticket with APPROVED research/plan should jump to Step 5, not redo Steps 1–4.

## Non-goals

- Not addressing codex's general inclination to over-analyze. That's a model-behavior property; we mitigate around it via budget + fast-path.
- Not switching backend defaults. The recommendation in `prds/MASTER_PLAN.md` §4 (claude for T1, codex for T2+) stands as a tactical workaround independent of this PRD landing.
- Not fixing existing iteration-event semantics if buggy; those are separate.
- Not adding per-ticket `circuit_breaker_iterations: N` overrides — keep the policy tier-driven for now (R2 below).

---

## 4. Approach

Three coordinated fixes, all in this PRD's three tickets (§7).

### A) Tier-aware circuit-breaker budget — `extension/src/bin/mux-runner.ts`

Read the current ticket's `complexity_tier` from its `linear_ticket_<id>.md` frontmatter. Map to per-tier no-progress budgets:

| Tier | No-progress budget (iterations) |
|---|---|
| `trivial` | 3 |
| `small` | 4 |
| `medium` | 5 (current default — preserves AC7) |
| `large` | 12 |
| (unknown / missing / malformed) | 5 (current default — backwards-compatible) |

Implementation:
- Add helper `getCircuitBreakerBudget(state, sessionDir): { tier: string; budget: number }` in `mux-runner.ts`. Reads `state.current_ticket`, opens `${sessionDir}/${current_ticket}/linear_ticket_${current_ticket}.md`, parses frontmatter line `complexity_tier: <value>`, returns `{ tier, budget }`.
- Cache the result on `state.current_ticket_tier` (string) and `state.current_ticket_budget` (number) so it isn't recomputed every iteration. Recompute only when `state.current_ticket` changes.
- Update the existing circuit-breaker trip site (search `extension/src/bin/mux-runner.ts` for the literal `No progress in`).
- Update the trip log message format to include tier and budget:
  ```
  Circuit breaker tripped: No progress in 12 iterations (tier: large, budget: 12)
  ```
- Extend the State type in `extension/src/types/index.ts` with the two new optional fields. Update `state-manager.ts` if it has an allowlist of writable keys (similar to the agent-team pattern from this debugging session).

### B) Iteration continuity — fast-path approved phases — `.claude/commands/send-to-morty.md`

Add a "Resume Detection" block immediately after `## Init` and before `## Session Knowledge Transfer`:

```markdown
## Resume Detection (run BEFORE Step 1)

Before starting Step 1, glob `${TICKET_DIR}` and decide which lifecycle step to enter.
The previous worker may have completed approved phases — do NOT re-do them.

| Files in `${TICKET_DIR}`                                                  | Enter at step  |
|---------------------------------------------------------------------------|----------------|
| (none, or `research_*.md` missing)                                        | 1 (Research)   |
| `research_*.md` exists; `research_review.md` says `APPROVED`; no `plan_*.md` | 3 (Plan)       |
| `plan_*.md` exists; `plan_review.md` says `APPROVED`; no implementation diff | 5 (Implement)  |
| Implementation diff exists; no `conformance_*.md`                         | 6 (Conformance)|
| `conformance_*.md` says `ALL_PASS`; no `code_review_*.md`                 | 7 (Code Review)|
| `code_review_*.md` says `PASS`; no Simplify pass evidence                 | 8 (Simplify)   |

Stale-review guard: if a review file's mtime is older than the parent ticket file's
`updated:` frontmatter date, treat the review as stale and re-do that phase from scratch.

Rejected reviews (`NEEDS REVISION` or `REJECTED`): re-do the failed phase from scratch.
```

Apply the analogous block to `.claude/commands/send-to-morty-review.md` adapted for that prompt's lifecycle (Research review → Plan review → Conformance audit etc.).

**IMPORTANT for the codex literal-bleed class** (per `prds/MASTER_PLAN.md` §8 Bug-Class Observations): make this block the FIRST instruction the worker encounters after Init. State the rule positively ("Enter at step N if ...") rather than negatively ("don't re-do approved phases") because codex is more reliable at executing positive instructions than at suppressing default behavior.

### C) Activity event for diagnosis (deferred — see T-D below)

Out of scope for v1 of this PRD's implementation. Documented here so the next iteration of stall detection has a foundation.

---

## 5. Acceptance Criteria

| AC | Type | Verification command / observation |
|---|---|---|
| AC1 | unit test | `extension/tests/mux-runner-circuit-breaker.test.js` (new): setup state with `current_ticket_tier='large'`, simulate 5 no-progress iterations, assert NO trip; simulate 12, assert trip. Use the same test fixture pattern as `mux-runner-stall.test.js`. |
| AC2 | unit test | Same suite: ticket file with no `complexity_tier` frontmatter line, simulate 5 no-progress iterations, assert trip (matches current default). Also test malformed frontmatter (e.g. `complexity_tier: bogus`). |
| AC3 | integration test | `extension/tests/send-to-morty-resume.test.js` (new): tmpdir with `research_*.md` + `research_review.md` (`APPROVED`) + `plan_*.md` + `plan_review.md` (`APPROVED`), run a stub worker harness that records the first file write, assert the first write is to a Step 5+ artifact (NOT a fresh `research_*.md`). |
| AC4 | integration test | Same suite: tmpdir with `research_*.md` + `research_review.md` (`REJECTED`), assert worker re-writes `research_*.md`. |
| AC5 | manual | Inspect the trip log line on a real run: must match regex `Circuit breaker tripped: No progress in \d+ iterations \(tier: \w+, budget: \d+\)`. |
| AC6 | end-to-end | With T-A and T-B deployed, relaunch the god-fn epic per `prds/MASTER_PLAN.md` §4 Option A on `--backend codex`. T1 must reach `status: "Done"` within ≤90 minutes wall-clock. |
| AC7 | unit test | Tier=`small` 4 iters no trip, 5 iters trip. Tier=`medium` 4 iters no trip, 5 iters trip. Tier=`trivial` 2 iters no trip, 3 iters trip. Confirms small/medium/trivial budgets unchanged for trivial / preserve current behavior for medium. |

**AC6 is the load-bearing one.** If the fixes don't unstick T1 in the field, this PRD failed regardless of unit-test green. Plan extra iterations on T-A/T-B if AC6 doesn't hold first time.

---

## 6. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Tier inflation — somebody marks a small ticket `large` to dodge the budget | Tier is set once at refinement time and rarely changed. If observed, lint at refinement time via `pickle-refine-prd` review (out of scope for this PRD). |
| R2 | 12-iteration budget might still be insufficient for very-large refactors | If observed, escalate per-ticket via a `circuit_breaker_iterations: N` frontmatter override. Out of scope for first cut. |
| R3 | Fast-path skips a step that SHOULD have been re-done due to fixture/code drift | Stale-review guard: if review file mtime older than ticket `updated:` frontmatter date, treat as stale and re-do (see Approach §B). |
| R4 | Codex still ignores the resume detection block (literal-bleed class — see `MASTER_PLAN.md` §8.2) | Belt-and-suspenders: make resume detection the FIRST step in the prompt with positive ("Enter at step N if X") rather than negative ("don't re-do") wording. |
| R5 | Tier lookup adds I/O to the mux-runner hot path | Cache once per ticket-change. Ticket files are <10K, frontmatter is the first ~20 lines, lookup is O(1) after cache hit. |
| R6 | Resume detection conflicts with `send-to-morty-review.md` | Apply analogous fast-path to the review worker prompt as part of T-B. |
| R7 | The fast-path itself becomes a vector for codex hallucination — codex claims a phase is "approved" when it isn't | Keep the determinism in the prompt (table-driven entry decision) and add the stale-mtime guard. Worker can't bypass the table; it can only act on facts on disk. |

---

## 7. Tickets (atomic, in dependency order)

### T-A: Tier-aware circuit-breaker budget

**Scope**:
- Add `getCircuitBreakerBudget(state, sessionDir): { tier: string; budget: number }` helper to `extension/src/bin/mux-runner.ts`.
- Cache `tier` and `budget` on `state.current_ticket_tier` (string) and `state.current_ticket_budget` (number).
- Update the circuit-breaker trip site (find via `grep -n 'No progress in' extension/src/bin/mux-runner.ts`) to use the dynamic budget.
- Update trip log message to include tier and budget.
- Extend `extension/src/types/index.ts` State type with the two new optional fields.
- Update `extension/src/services/state-manager.ts` if its writable-key allowlist exists.

**Tests**: `extension/tests/mux-runner-circuit-breaker.test.js` — new file. Cover all five tiers + missing tier + malformed tier. Pattern after the existing `mux-runner-stall.test.js`.

**Files**:
- `extension/src/bin/mux-runner.ts`
- `extension/src/types/index.ts`
- `extension/src/services/state-manager.ts` (only if allowlist needs updating)
- `extension/tests/mux-runner-circuit-breaker.test.js` (new)
- `extension/package.json` (test registration — append the new test file to the test script per existing convention; alphabetize at T14 of the god-fn epic, NOT here)

**Verify**:
```bash
cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test
```

**AC**: AC1, AC2, AC5, AC7.

### T-B: Worker resume detection

**Scope**:
- Add the Resume Detection block to `.claude/commands/send-to-morty.md` per Approach §B above. Place it AFTER `## Init` and BEFORE `## Session Knowledge Transfer`. State rules positively.
- Add the analogous block to `.claude/commands/send-to-morty-review.md` adapted for the review worker's lifecycle.
- Implement stale-review handling in the prompt's table: if review file mtime older than ticket `updated:` frontmatter date, mark as stale and re-do that phase.

**Tests**: `extension/tests/send-to-morty-resume.test.js` — new file. Write tmpdir fixtures with various artifact combinations:
- (a) empty dir → first write is `research_*.md`
- (b) approved research only → first write is `plan_*.md`
- (c) approved research + approved plan, no diff → first write is to `extension/src/` (or any path outside `${TICKET_DIR}`)
- (d) rejected research → first write is `research_*.md` (re-do)
- (e) approved research with stale mtime → first write is `research_*.md` (re-do)

Run a stub worker that records its first write to any file. Use the existing `worker-setup.test.js` fixture pattern.

**Files**:
- `.claude/commands/send-to-morty.md`
- `.claude/commands/send-to-morty-review.md`
- `extension/tests/send-to-morty-resume.test.js` (new)
- `extension/package.json` (test registration)

**Verify**:
```bash
cd extension && npm test
bash install.sh  # deploys updated .claude/commands/*.md to ~/.claude/commands/
grep -A 20 'Resume Detection' ~/.claude/commands/send-to-morty.md  # verify deployed
```

**AC**: AC3, AC4.

### T-C: End-to-end verification

**Scope**: relaunch the god-fn epic on codex backend with T-A and T-B deployed. Confirm T1 lands within 90 minutes; confirm at least one other large-tier ticket (T2 or T3) also lands in the same run.

**No code change** — this is the load-bearing manual verification. If it fails, T-A and T-B need iteration.

**Reproduction commands** (exact bash to relaunch — based on `prds/MASTER_PLAN.md` §4):

```bash
SESSION_ROOT=~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b
WORKING_DIR=/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
SESSION_NAME=pipeline-9152e64b

# Verify clean tree (only untracked prds/bmad-inspired-hardening.md is acceptable)
git -C "$WORKING_DIR" status --short

# Reset live state for clean T1 attempt
node "$HOME/.claude/pickle-rick/extension/bin/update-state.js" start_time_epoch "$(date +%s)" "$SESSION_ROOT"
node "$HOME/.claude/pickle-rick/extension/bin/update-state.js" iteration 0 "$SESSION_ROOT"
node "$HOME/.claude/pickle-rick/extension/bin/update-state.js" step research "$SESSION_ROOT"
node "$HOME/.claude/pickle-rick/extension/bin/update-state.js" current_ticket f068af3f "$SESSION_ROOT"
rm -f "$SESSION_ROOT/anatomy-park.json" "$SESSION_ROOT/szechuan-sauce.json" "$SESSION_ROOT/pipeline-cancel"

# Reset T1 ticket status to Todo (it's already Todo per stash, but be explicit)
sed -i '' 's/^status: "In Progress"$/status: "Todo"/' "$SESSION_ROOT/f068af3f/linear_ticket_f068af3f.md"

# Launch
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
tmux new-session -d -s "$SESSION_NAME" -c "$WORKING_DIR"
tmux send-keys -t "$SESSION_NAME":0 \
  "node \$HOME/.claude/pickle-rick/extension/bin/pipeline-runner.js $SESSION_ROOT 2>&1 | tee -a $SESSION_ROOT/pipeline-runner.log; echo PIPELINE_EXIT=\$?; read" Enter
tmux attach -t "$SESSION_NAME"
```

Watch for: T1's `status:` flips to `"Done"`, mux-runner advances to T2, AC5 trip-log format appears in `pipeline-runner.log`.

**AC**: AC6.

### T-D (deferred follow-up): `iteration_phase_entered` activity event

**Scope**: emit `iteration_phase_entered` activity event from `mux-runner.ts` when a step transition is detected (compare current `state.step` to previous iteration's). Not required for AC6 but builds the data substrate for future stall-detection refinements (e.g. "worker spent N iterations in research without advancing").

**Out of scope for v1 of this PRD.** Track separately if pursued.

---

## 8. Release & verification

After T-A and T-B ship:
- Bump version: `1.56.4 → 1.57.0` (minor — new state fields, new logging format, new test files, new prompt block).
- Commit format: per repo convention. Standard message format from this debugging session:
  ```
  fix(mux-runner): tier-aware circuit-breaker budget + worker resume detection

  <body>

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- Tag and release via `gh release create v1.57.0 --target main --title "v1.57.0 — Large-tier stall recovery" --notes "..."`.
- Update `prds/MASTER_PLAN.md` §4 Resume Strategy: add a fifth option (now-recommended) — "codex with tier-aware budget" — and downgrade the "hand-execute T1 with claude" recommendation to a fallback.

## 9. Out of scope (handoff debt)

These items came up during the analysis but are NOT this PRD's job. Track them separately:

- The 18 `MANAGER_FALSE_EPIC_COMPLETED` markers from the T0 run — correctly recovered by v1.56.4, didn't block T0. Residual codex-behavior issue. Track separately if frequency increases on subsequent runs.
- The 4 test files codex modified during T0 retries (`backend-spawn.test.js`, `mux-runner.test.js`, `timeout-happy-path.test.js`, `integration/timeout-e2e.test.js`) plus `REFACTOR_BASELINE.md` — captured in commit `361dd02` (`test: stabilize T0 baseline verification`). Codex's mid-iteration scratch work that happens to also be useful test hardening.
- General advisability of codex backend for this codebase — strategic decision; this PRD addresses the immediate technical blocker. The bug-class observations in `prds/MASTER_PLAN.md` §8 are the canonical record.
- The pre-refinement T14 version target (1.55.0) is now stale — already shipped for unrelated agent-teams work in commit `4eb1779`. T14 needs its bump target reset at landing time per `prds/MASTER_PLAN.md` §5 footer.

---

## 10. Quick reference

```
Repo root:                      /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
Active session dir:             ~/.local/share/pickle-rick/sessions/2026-04-25-9152e64b/
Master plan:                    prds/MASTER_PLAN.md
Refined epic PRD:               prds/archive/bundles/god-functions-remediation.md (SHA 1658d81)
T1 staged research:             $SESSION_ROOT/f068af3f/research_2026-04-26.md
T1 staged plan:                 $SESSION_ROOT/f068af3f/plan_2026-04-26.md
Pipeline log (history):         $SESSION_ROOT/pipeline-runner.log
This PRD's home:                prds/archive/bundles/large-tier-stall-recovery.md
Latest release before this PRD: v1.56.4 — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.56.4
Build & test gate:              cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test
Deploy:                         bash install.sh   (from repo root)
```
