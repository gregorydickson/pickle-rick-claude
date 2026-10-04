# Research spike: how other agent systems decompose, parallelise, persist and verify

Date: 2026-09-24 · Scope: desk research + refinements · Informs: GitHub #43 (`--teams` / review partitioning), GitHub #5 (persistent knowledge, worktree-as-proposal, state-from-git)

**⚠ Corpus bias (operator, 2026-09-26): every [M, this repo] TIMING is Pickle Rick building ITSELF; field pickle phases last HOURS. Timing decisions need field data (`prds/research/tools/field-timing.py`).**

**Evidence labels:** **[M]** paper or independent benchmark · **[M, this repo]** measured here, command given · **[Mv]** vendor-measured on its own system · **[C]** claim, no method · **[D]** design description.

## 1. Summary

1. **Parallel writers pay off only on cleanly split work, with a strong verifier, at small N.** CAID gains +6 to +15 points (worktrees, merging manager), peaking at **4 workers on one benchmark, 2 on the other** [M]. CooperBench: **68.6% → 46.5% → 30.0% from 2 to 4 agents** (46 tasks, unreplicated) [M]; Cursor's 20 locked agents ≈ "two or three" [Mv]. The C compiler escaped a stall by **re-partitioning** [Mv]: our anatomy-park case.
2. **Our bundles cap build parallelism at ~2×, and `--teams` cannot run under the runner** [M, this repo]. File-disjoint waves: median best-case 2.0× (1.33–3.0×); one real wave run: width 2 in 1/22 waves, 27.7 min/ticket (tier mix, per-unit test gates); no team tools under `claude -p` (§3).
3. **Review recall falls as the unit grows; the published magnitude is untrustworthy; our probes saturated (E3), then floored (E3b).** Quoted F1 0.657 → 0.043: confounded. SWR-Bench: per-PR recall **38% → 9% as real issues rise from 1 to ≥5, precision flat** [M]: roughly constant finds per pass.
4. **Worktree-as-proposal is the industry convergence, unproven against alternatives.** Six systems give each writer a checkout and rejectable merge [D]. Integration cost cuts both ways: CAID's test-gated merge **raised** cost and runtime [M]; disjoint work rarely interferes (1 in 834 runs) [M]; our 60 review lanes had 0 conflicts and 0/18 dropped [M, this repo].
5. **Nobody derives state from git alone; the pattern is git plus one small append-only log** (Anthropic, OpenHands, LangGraph) [D].
6. **Persistent memory evidence is weak.** VibeMemBench: **11 of 12 self-built memory pairings failed to beat memory-off**; *verified* history +1.1 to +4.5 points [M], favouring Move 2. Unreplicated; on recall-*requiring* tasks Mem0 beats none, 97/180 vs 21/180 (Gap 5).

## 2. Comparison table

| System (source date) | Decomposition & assignment | Parallelism & conflicts | State & resume | Verification | Failure behaviour | Published measurement |
|---|---|---|---|---|---|---|
| **Claude Code agent teams** (docs, live 2026-09) | Shared task list; teammates self-claim via **file locks** | Parallel sessions; same-file edits overwrite | `~/.claude/tasks/`. **Teammates not restored on `/resume`**; **no team tools in `-p`** [M, this repo] | `TaskCompleted`/`TeammateIdle` hooks | Stop on errors; lead "may stop early" | None. Recommends 3–5 [C] |
| **Anthropic C compiler** (2026-02-05) | `claude -p` loop per container; lock files | 16 agents, own clones; **lock-file git conflicts stop double-claims** | Git + lock files | Tests, GCC oracle; "verifier must be nearly perfect" | Parallelism **collapsed** on a monolithic task until re-split | ~2,000 sessions, ~$20k; builds Linux 6.9 [Mv] |
| **Anthropic long-running harness** (2025-11-26) | `feature_list.json` (200+ items); **one feature per session** | Single writer | Git + `claude-progress.txt` + feature JSON | Browser tests (Puppeteer) | Premature victory, one-shotting | Qualitative [D] |
| **Anthropic harness design** (2026-03-24) | Planner → generator → **separate evaluator** | Single writer | Files/specs | Skeptical evaluator beats self-evaluation | Sprints **removed** later | Solo 20 min/$9 broken; harness 6 h/$200 working (n=1) [Mv] |
| **CAID** (arXiv 2603.21489, v2 2026-07) | Manager's dependency DAG | **Worktree per engineer**; manager merges; **conflicting author resolves** | Main branch | Local tests; test-gated integration | — | Commit0-Lite 53.1→59.1%; PaperBench 57.2→63.3%. Peak 4 / 2; **8 worse than 4**; dearer, slower [M] |
| **CooperBench** (arXiv 2601.13295, 2026-01-19) | One feature per agent, shared repo, messaging | Same codebase, concurrent | — | Joint feature tests | Expectation 42%, commitment 32%, communication 26% | ~30% below solo; **2 → 3 → 4 agents: 68.6 → 46.5 → 30.0%** (46 tasks) [M] |
| **Cursor long-running agents** (2026-01-14) | Recursive planners; workers | Hundreds; **optimistic concurrency** replaced locks | Repo | Workers resolve conflicts | Locks held too long | 20 locked agents ≈ 2–3 [Mv]; 1M-line browser in a week [Mv] |
| **OpenAI Codex cloud** (2025-05; docs 2026) | One task per sandbox; `--attempts N` | Container per task; CLI worktrees; PRs | Repo + `AGENTS.md` | AGENTS.md checks; human review | Human retries | None public [C] |
| **GitHub Copilot coding agent** (2025-05; docs) | One issue → one draft PR | Actions VM; **pushes only to its own branches** | Branch + PR | CI + human review | Human-gated | None found |
| **Cursor 2.x parallel agents** (2025-10; docs) | Up to 8 (`/best-of-n`) or separate tasks | Worktree per agent; human merges | Worktrees | Human picks | Human-gated | None [C] |
| **Devin** (review 2025-11) | Playbooks fanned out to many Devins | VM per session | Knowledge/playbooks | Human review | Human-gated | Merge rate 34%→67% YoY, "4x faster" [Mv] |
| **Cognition guidance** (2025-06; 2026-04-22) | Manager → children, map-reduce | **"Writes stay single-threaded"** | Context engineering | Clean-context reviewer | — | Reviewer ~2 bugs/PR [Mv] |
| **OpenHands V1 SDK** (arXiv 2511.03690, 2025-11) | Agent + subagents | Sandboxed workspaces | **Event-sourced log, deterministic replay** | Benchmarks; security reviewer | Stuck detector | Fewer system-attributable failures [Mv/C] |
| **mini-SWE-agent** (README, 2025–26) | One linear loop | None | Linear history | Benchmark | — | >74% SWE-bench Verified, ~100 lines [Mv] |
| **Agentless** (arXiv 2407.01489; FSE 2025) | Localize → repair → validate | Candidate patches | None | Regression + reproduction tests | — | Beat open agents, SWE-bench Lite, $0.34–0.70/issue [M] |
| **Aider architect/editor** (2024-09-26) | Planner model + editor model | None | Git commits | Benchmark tests | — | o1-preview 79.7→85.0%; Sonnet 77.4→80.5% [Mv] |
| **Factory Code Droid** (2024) | Planner + subtasks; trajectories | Candidates chosen by tests | "HyperCode" index | Tests, linters, self-critique | — | SWE-bench Lite pass@1 31.7% → pass@6 42.7% [Mv] |
| **SWE-agent** (arXiv 2405.15793; NeurIPS 2024) | One agent; LM-tailored view/search/edit commands | None | Trajectory | **Edit rejected if lint fails** | Unresolved (n=248): 52.0% wrong/too-specific fix, 23.4% cascading failed edits | 12.47% of 2,294 (GPT-4 Turbo); Lite (n=300) 18.0% vs shell-only 11.0%; no linting −3.0 [M] |
| **CrewAI** (docs, 2026-10) | Ordered tasks, or **hierarchical manager assigns and reviews** | Per-task `async_execution`; no shared-write rule | One `Memory` store (LanceDB, `./.crewai/memory`) | Task guardrails: failure returned, retried ≤3 | — | None [D] |
| **AutoGen 0.4+ AgentChat/Core** (docs; maintenance mode) | Teams: round-robin, selector, swarm, Magentic-One, graph | **Turn-taking over one shared context** | `save_state()` → JSON per agent/team | Termination conditions | — | None [D]; successor: Microsoft Agent Framework |
| **Microsoft Agent Framework** (1.0 GA; docs 2026-09) | Executor graph; sequential, concurrent, handoff, group chat, Magentic | Concurrent = **same input to all, answers aggregated**; superstep barrier; no writer integration | **Checkpoint per superstep**; rehydration needs identical topology and executor ids | Approval-gated tools; human plan review | Magentic: stall limit → **reset and replan**; "untested" beyond Magentic-One | None found [D] |
| **Magentic-One** (2024-11-04) | Orchestrator task/progress ledgers | Sequential delegation | Ledgers in context | Self-reflection | **Stall counter > 2 → replan**, not halt | ≈ SOTA on GAIA [Mv] |
| **MetaGPT** (ICLR 2024) | SOP roles, structured documents | Largely sequential | Documents | Runs code, feeds errors back | — | +4.2 pts HumanEval; human fixes 2.5 → 0.83 [M, older models] |
| **LangGraph** (docs) | Graph nodes | Parallel branches per step | **Checkpoint per step by `thread_id`** | User-defined | Interrupt → persist → resume | None [D] |
| **OpenAI Agents SDK** (docs) | Handoffs vs agents-as-tools | — | Sessions | Guardrails | — | None [D] |

**Why multi-agent systems fail (MAST, NeurIPS 2025) [M].** 1,600+ traces: system design 43.9%, misalignment 32.4%, verification 23.8%. Top modes: step repetition 15.7%, reasoning–action mismatch 13.2%, **not knowing when to stop 12.4%**. Fixes: +9.4 to +15.6 points (ChatDev).

## 3. Findings mapped to our questions

### #43: parallel build workers, or finer review partitioning?

**Status.** Soak bundles run `anatomy_max_parallel_lanes: 2` (default 1); see `prds/MASTER_PLAN.md` "2.2 completion ledger".

**`--teams` is neither parallel nor runnable under the runner** [M, this repo, 2026-09-24].
- *Runnable.* The manager runs in print mode (`backend-spawn.ts`, `args.push('-p', opts.prompt)`). Claude Code 2.1.281 `claude -p "reply ok" --output-format stream-json --verbose --max-turns 1 | head -1`: **`TeamCreate`, `TaskCreate`, `TaskUpdate`, `TaskList`, `Agent` absent**, even with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- *Parallel.* `extension/templates/_pickle-manager-prompt.md:173`: "`state.max_parallel` is plumbed for a follow-up … today, treat as 1".
- **So** E2 needs an interactive manager or `-p` teams.

**Build parallelism in our bundles is small** [M, this repo, 2026-09-24]. Backticked paths in each non-hardening ticket's "**Files to modify/create**"; tickets assigned in `order` greedily to waves (after any earlier one sharing a file); speedup = tickets ÷ waves.

| Session | Impl tickets | Waves | Best-case speedup | Widest wave |
|---|---|---|---|---|
| 2026-09-17-3c7489fc | 5 | 3 | 1.67 | 3 |
| 2026-09-17-5f3aa6b4 | 4 | 3 | 1.33 | 2 |
| 2026-09-17-df5973be | 3 | 1 | 3.00 | 3 |
| 2026-09-19-4dbaed57 | 3 | 2 | 1.50 | 2 |
| 2026-09-21-7ba3aec1 | 6 | 3 | 2.00 | 4 |
| 2026-09-22-723eafe4 | 3 | 1 | 3.00 | 3 |
| 2026-09-22-a88001dd | 2 | 1 | 2.00 | 2 |

Median 2.0×, pooled 26 / 14 = **1.86×** (single-ticket, hardening-only sessions excluded); whole-field parsing and `completion_commit` agree (**≤3×, median ~1.5–2×**). Hardening stays serial: 1277 → 1031 min (−19%) at best, #43's worst bundle.

**Do declared lists predict diffs? Yes, conservatively** [M, this repo, 2026-09-26]. 16 sessions; 27/36 non-hardening tickets declare paths. Actual = `git show --name-only` over `completion_commit` plus commits naming the id.

| Measure (27 tickets) | Value |
|---|---|
| Actual files declared (recall), median / pooled | 1.00 / 0.85; 19 tickets complete |
| Declared files touched (precision), median / pooled | 0.80 / 0.73; 16 over-declare (38 files) |
| Undeclared touches, by kind | 18 in 8 tickets: tests 8, prompts 8, CLAUDE.md catalogs 2, compiled 0, source 0 |
| Undeclared touch in a same-session ticket's declared set | 1 (a CLAUDE.md catalog) |
| Same-wave ticket pairs whose actual diffs overlap | 0 of 11 |

**Implication:** lists over-declare, so 1.5–2× hides no collisions; CLAUDE.md catalogs and `.claude/**/*.md` stay shared.

**First real wave run: width 2 once** [M, this repo, 2026-10-04; one run]. `2026-10-02-be104839` (B-MEGA), `max_parallel_tickets: 2`: 23 tickets, 22 waves, widths 1×21 + 2×1 (`pickle waves:` lines; `field-timing.py` agrees).
- **Reliability.** 22/23 members integrated; 1/23 had no attributable commit (`unmapped`); serial fallback finished it (44 min). 0 conflicts, 0 halts; `wave_member_failed_then_serial_done` 0 (counts `parallel_safe` members only).
- **Why width stayed 1.** Deployed `planTicketWave`, replayed over declared files, reproduces all 22 widths. Of 22 adjacent pairs, 19 overlap (11 only via the global markers `.claude/**`, `CLAUDE.md`), 2 lack `parallel_safe` (absent on 14/23), 1 eligible. All-safe ceiling: 21 waves (1.10×), as the §3 greedy method.
- **Speed.** **27.7 min/ticket** (636.0 min; serial: E2 bar <27, field 20–27, `2026-10-03-2868b847` 8.3); decomposed below ("Where the rest…").
- **Read-out.** Reliability held; shared-surface bundles pack tickets waves cannot split.

**How many concurrent units? The knee** (primary sources, 2026-09-26):
- **CooperBench (Khatua et al., 2026-01-19)** [M]. ~30% below one agent; 2 → 4 agents as above, *coupled* work.
- **Cursor (2026-01-14)** [Mv]. Locked, "twenty agents would slow down to the effective throughput of two or three"; an integrator "created more bottlenecks than it solved".
- **Claim Plane (Nikolaev, 2026-08-02)** [M, single author]. 30 CooperBench pairs: pre-write admission 23.3% → 50.0% success, serializing 96.7% of executions.
- **Passes Alone, Fails Together (Xia, Wu & Park, 2026-09-21)** [M]. 417 real Django PR pairs, two agents: 1 interference in 834 runs; 97% of tasks share helpers.
- **Destefanis & Aste** [M]: messaging grows "close to quadratically". **Kim et al.** [M]: +80.8% (decomposable) to −70.0% (sequential). **AgenticFlict** [M]: 27.67% of simulated agent-PR merges conflict; **Xu et al.** [M]: 19.8% intra- vs 41.7% cross-agent, 747 co-active PR pairs.
- **Anthropic research system (2025-06-13)** [Mv; eval unpublished]. Beat single-agent Opus 4 "by 90.2%" at "about 15× more tokens than chats"; tokens "explain 80% of the variance"; coding is less parallelizable.
- **Read-out for lanes.** Every measured 2→3 curve on *coupled* work declines (CAID peaked at 2 on one benchmark); none covers **cherry-picked review lanes**. **Start at 2; go to 3 only on the soak's own conflict and dropped-lane rate**.

**Cherry-pick integration: 0 conflicts, 0 dropped lanes, small n** [M, this repo, 2026-10-04]. All `archive/lanes.json` (11 on disk, 09-27 → 10-03), `anatomy lanes:` log lines, and `2026-09-26-23989a13`/`-bcd24b6d` (16 lanes, 34 commits; pruned, carried from the 10-02 census): 13 sessions, cap 2.
- **Outcomes, 60 lane runs:** integrated 60; every failure outcome 0 (logs agree; no kept branch).
- **Committed vs integrated:** 18/60 lanes committed (59 commits), 18/18 integrated; 59/59 have a `git patch-id` match off-lane (25 re-checked). Dropped-lane rate **0/18** (one-sided 95% upper bound 15%).
- **Contested picks** (onto a tree an earlier pick moved; 6 sessions): 0/9 conflicts (upper bound 28%). Not disjoint: 30/114 file touches fell outside the lane directory.
- **`integration_check`** exists from `2026-10-01-face240c` (6 sessions, 29 lanes): green 10 (every committing lane), null 19 (no commits), unavailable 0. The 31 earlier lanes lack it: **a measurement gap, not 31 greens**.
- **Wall-clock** (last lane end → `verdict`): 3.4–11.3 s over 9 picking sessions (median 6.2 s); 0.4 s without picks (4); ≤0.81% of the lanes span. **Negligible at N=2; bounds 15% / 28% do not license N=3.**

**The anatomy-park stall is the C-compiler stall.** `discoverSubsystems` (`pipeline-runner.ts:471`) makes `extension/` one lane.

**Review-size literature** (primary sources re-read 2026-09-24):
- **Kumar et al. (2026-04-09): confounded.** <10-line bin (n=92) synthetic, >50-line bins (n=34, 14) real; F1 0.847 vs 0.066. **Not used.**
- **SWR-Bench (Zeng et al., 2025-09-01; FSE 2026): clean.** Recall 38.35% (N=1 issue, 266 PRs) → **8.88% (N≥5, 22 PRs)**, precision flat [M]: ~0.4–0.5 finds per PR at every N; our diffs are the many-issue case.
- **Sense and Sensitivity (Štorek et al., v5 2026-07-10; ACL 2026): mechanism.** 10 LLMs: semantic code recall drops a median 92.73% mid-context [M; not review].
- **Implication.** Direction supported twice; magnitude does not. If finds per pass are fixed, **passes-to-clean scale with defect count, not partition size**; finer partitions save only wall-clock.

**Strength.** Moderate-to-strong for "partition first, keep N small" (CooperBench's curve unreplicated); weak for finer-unit recall (E3, E3b).

### #5 Move 4: worktree-as-proposal

- **Evidence.** Design convergence [D]. CAID's **manager-owned merge** ≈ #5's accept/reject gate; the C compiler uses push conflicts *as the lock* [Mv].
- **Unclaimed.** No source measures isolation reducing defects versus trunk plus scope fences; the benefit is structural (free rejection). Costs: CAID slower, dearer; Claim Plane serialized ~all [M].
- **Strength.** Consensus plus cost data; "it deletes our five enforcement mechanisms" is HYPOTHESIS.

### #5 Move 5: state from git

- **Evidence.** Durable systems keep **one** authoritative record [D]; none duplicates git in a 47-field blob. Smallest step: E4.

### #5 Moves 1–2: persistent knowledge

- **Evidence.** Self-built memory: 11/12 pairings failed to beat none [M]; verified experience +1.1 to +4.5 [M]; subtask memory +4.7 [M, single paper]; none replicated (Gap 5). Vendors load **small curated files every session** (`AGENTS.md`, CLAUDE.md) [D].
- **Implication.** Move 2 (committed trap-door file, 20–40 lines per directory) is supported; judge Move 1 (tree-hash cache) on orientation time.

### The ~300-minute review toll

- **Separate reviewers work** (Anthropic, Cognition, MAST) [Mv/M]; ours review one accumulated diff serially.
- **Supported cuts:** smaller concurrent units at small N; per-unit stop conditions (MAST).

**Does each worker phase earn its time? The review phases are nearly free** [M, this repo, 2026-09-26]. 65 tickets, 10 sessions (09-19 → 09-25). Phase = gap between consecutive artifact *birth* times from the first `worker_session_*.log`; respawn-spanning intervals dropped (12 tickets). "Changed" = review artifacts read by hand plus post-review source edits.

| Phase | n | Median | Changed something |
|---|---|---|---|
| Research | 62 | 2.2 min | (produces input) |
| Research Review | 65 | 4 s | 0/65: all APPROVED, none edited after |
| Plan | 65 | 11 s | (produces input) |
| Plan Review | 65 | 1 s | 1/65: one plan amended before approval |
| Implement + Spec Conformance | 57 | 2.8 min (1.0 + 1.9 where split, n=32) | Conformance: 5/65 closed a failing criterion |
| Code Review | 65 | 5 s | 8/65 fixed a defect in-phase |
| Simplify | 38 | 0 s | 11/38 applied a change (+4 unclear); 27 wrote no artifact |
| Whole worker spawn(s) | 65 | 6.7 min | 95% inside these intervals (53 single-spawn) |

**Limits.** Write time is not thinking time: in 25–33/65 tickets a review landed ≤2 s after its subject (Research Review + Plan + Plan Review median 0.38 min; Code Review + Simplify 0.14). Change counts are lower bounds.

**Finding.** The "~3 min per phase" premise fails: review/simplify phases cost <1 min of 6.7; Research and Implement/Conformance ~75%. Research Review and Plan Review rarely change anything (0/65, 1/65): merge candidates (HYPOTHESIS). Spec Conformance, Code Review, Simplify change something in 8%, 12%, ≥29% of tickets at near-zero cost. On `2026-09-21-7ba3aec1` 17 worker spawns sum to 262 of the pickle phase's 524 min.

**Where the rest of the pickle phase goes: test gates, not managers** [M, this repo, 2026-10-04; 15 sessions, 09-26 → 10-04]. Each pickle-phase second gets one label, by priority: worker (`worker_session_*.log` birth → mtime, or → `worker_produced_nothing` if empty) > worker gate (→ `worker_lint_gate_passed`/`worker_gate_failed`) > tail gate (prior `mux-runner.log` line → `between-ticket fast gate`) > gap (`wasted_iter` → `iteration_start`) > manager (rest of a mux window) > wave. Min/ticket:

| Session | Tickets L/M/S | Pickle | Worker | Worker gate | Tail gate | Manager | Gaps + wave |
|---|---|---|---|---|---|---|---|
| be104839, waves | 5/13/5 | 27.7 | 10.3 | 5.8 | 7.9 | 3.6 | 0.1 |
| 2868b847, serial | 0/9/10 | 8.3 | 2.4 | 3.7 | 0.8 | 1.3 | 0.0 |
| 03d1f8d2, serial | 7/5/1 | 16.9 | 6.5 | 6.9 | 0.6 | 2.9 | 0.0 |

- **Fixed costs.** Tail gate (between-ticket `test:fast` + post-final tier): 7.1–7.7 min per runner session, all 13 serial sessions; each wave unit is one (24 runs, median 7.6). Worker gate: median 7.4–7.9 min per medium/large ticket, ~0 for small (`test:fast` tier-skipped). Gaps ≤0.2 min per session; unit create/integrate 2.1 min over 22 waves.
- **27.7 vs 8.3.** Of the 19.3 min/ticket gap: worker +7.9 (large median 19.3 min vs 7.3 elsewhere, n=5 / 9; three empty-log spawns, 17.8 min each; non-empty logs 184.9 min), tail gate +7.0 (one per unit), manager +2.3, worker gate +2.0 (non-small 78% vs 47%), create/integrate +0.1. **Tier mix plus per-unit tail gates; not manager or worktree time.** HYPOTHESIS: serial B-MEGA ≈ 20 min/ticket (636 − 181 + 7.5), near 03d1f8d2's 16.9.
- **Falsified by** a wave run whose per-unit tail gate is not ≈7.5 min, or a serial bundle ≥75% non-small at ≤10 min/ticket. **Limits:** later phases overwrite `tmux_iteration_*.log` (manager is a residual); mtime matched the stop-hook 6/6; one wave run.
- **Lever.** A width-1 wave pays a ~7.6 min tail gate for no concurrency.

## 4. Experiments (measurement only)

**E3. Offline review-recall probe — run 2026-09-24: INCONCLUSIVE, saturated** [M, this repo; `prds/research/e3/E3-results.md`].
- **Design.** B-INVENTED diff `f36ea11e..3ae1d57a` (7,083 lines), anatomy-park Phase-1 prompt, `claude-opus-5-5`, 20 one-line mutations. Arms: (a) whole, k=20; (b) four directory partitions; (c) whole, k=5; 3 repeats. **Bar:** (b)/(a) recall ≥1.5× at ≤1.25× false positives.
- **Result.** Recall (a) 0.80, (b) 0.90, (c) 1.00, zero false positives; b/a = 1.125×, below the bar; one pass found 14–19/20.
- **Signal: tests.** Whole-diff passes reported nothing in `extension/tests` in 2/3 repeats (4/15 hits); the tests partition recovered 12/15.

**E3b. Real reverted defects — run 2026-09-26: INCONCLUSIVE, floored** [M, this repo; `prds/research/e3b/E3b-results.md`].
- **Design.** 12 real single-file fixes reversed into `12ffe132..1ad3f505` (14,812 lines). E3's prompt, model, bar; (b) = `resolve-scope` lanes; 16 calls, 0 refusals; k=0 silent.
- **Recall 0.00 in all 9 arm-repeats**; each pass emitted 1–3 *other* findings.
- **Read-out.** One no-tools pass cannot separate size from defect count.

**E1. Finer anatomy-park partition.** Roster one level deeper on a findings-heavy bundle vs B-INVENTED (34 passes / 995 min, one lane). **Success:** largest lane ≤ 50% of baseline passes, wall-clock ≤ −25%, findings fixed not lower. **Falsified if** Σ passes ≈ 34+ with no wall-clock drop. The soak runs it at 2 lanes.

**E2. `--teams` — blocked** under `-p`. Bar: < 27 min/ticket, zero interventions, `--max-parallel` ≤ 3.

**E4. Derive current ticket from git.** Trailers plus frontmatter status vs `state.json.current_ticket` per iteration. **Success:** ≥ 95% agreement, each miss a known drift bug. **Falsified if** git lacks needed state.

## 5. Sources (publication date; living docs accessed 2026-09-24 unless noted)

- Claude Code agent teams docs — https://code.claude.com/docs/en/agent-teams
- Anthropic, "Building a C compiler with a team of parallel Claudes" — https://www.anthropic.com/engineering/building-c-compiler (2026-02-05)
- Anthropic, "Effective harnesses for long-running agents" — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (2025-11-26)
- Anthropic, "Harness design for long-running application development" — https://www.anthropic.com/engineering/harness-design-long-running-apps (2026-03-24)
- Anthropic, "How we built our multi-agent research system" — https://www.anthropic.com/engineering/multi-agent-research-system (2025-06-13; read 2026-09-26)
- Geng & Neubig, CAID — https://arxiv.org/abs/2603.21489 (v2 2026-07)
- Khatua et al., "CooperBench" — https://arxiv.org/abs/2601.13295 (2026-01-19; full text read 2026-09-26)
- Cursor, "Scaling long-running autonomous coding" — https://cursor.com/blog/scaling-agents (2026-01-14)
- Nikolaev, "Claim Plane" — https://arxiv.org/abs/2608.00947 (2026-08-02)
- Xia, Wu & Park, "Passes Alone, Fails Together" — https://arxiv.org/abs/2609.25396 (2026-09-21)
- Destefanis & Aste, "When Agents Coordinate" — https://arxiv.org/abs/2608.16801 (2026-08-17)
- Kim et al., "Towards a Science of Scaling Agent Systems" — https://arxiv.org/abs/2512.08296 (2025-12-09; v3 2026-04-08)
- Ogenrwot & Businge, "AgenticFlict" — https://arxiv.org/abs/2604.03551 (2026-04-04; v2 2026-05-12)
- Xu, Subramonian & Karthik, "AI Agent Pull Requests on GitHub" — https://arxiv.org/abs/2607.04697 (v2 2026-07-07; abstract read 2026-10-02)
- Cemri et al., MAST — https://arxiv.org/abs/2503.13657 (v3 2025-10; NeurIPS 2025)
- Kumar, Bararia & Raj, "Bigger Isn't Always Better" — https://arxiv.org/abs/2606.15689 (2026-04-09; §3, §4.5 re-read 2026-09-24)
- Zeng et al., "SWR-Bench" — https://arxiv.org/abs/2509.01494 (2025-09-01; FSE 2026; Table 5 read 2026-09-24)
- Štorek et al., "Sense and Sensitivity" — https://arxiv.org/abs/2505.13353 (v5 2026-07-10; ACL 2026)
- Sun et al., "Does AI Code Review Lead to Code Changes?" — https://arxiv.org/abs/2508.18771 (2025-08)
- VibeMemBench — https://arxiv.org/abs/2609.23570 (2026-09-20)
- "Subtask-Level Memory for SWE Agents" — https://arxiv.org/abs/2602.21611 (2026-02)
- Cognition — https://cognition.com/blog/dont-build-multi-agents (2025-06); https://cognition.com/blog/multi-agents-working (2026-04-22); https://cognition.com/blog/devin-annual-performance-review-2025 (2025-11)
- OpenHands Software Agent SDK — https://arxiv.org/abs/2511.03690 (2025-11; rev. 2026-04; MLSys 2026)
- mini-SWE-agent README — https://github.com/SWE-agent/mini-swe-agent
- Xia et al., "Agentless" — https://arxiv.org/abs/2407.01489 (2024-07; FSE 2025)
- Aider architect — https://aider.chat/2024/09/26/architect.html (2024-09-26)
- Factory Code Droid report — https://factory.com/news/code-droid-technical-report (2024; undated)
- OpenAI Codex — https://openai.com/index/introducing-codex/ (2025-05); https://developers.openai.com/codex/cloud
- GitHub Copilot agent — https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/ (2025-05); https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent
- Cursor worktrees docs — https://cursor.com/docs/configuration/worktrees
- Yang et al., "SWE-agent" — https://arxiv.org/abs/2405.15793 (v3 2024-11-11; NeurIPS 2024; Table 1, §5 read 2026-10-04)
- Accessed 2026-10-04: CrewAI https://docs.crewai.com/en/concepts/processes (+ tasks, memory); AutoGen https://github.com/microsoft/autogen, https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html (+ state.html); Sweep https://github.com/sweepai/sweep; Microsoft Agent Framework https://github.com/microsoft/agent-framework, https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints (+ orchestrations/concurrent, orchestrations/magentic, concepts/workflows/builder-and-execution, state)
- Accessed 2026-10-04 (Gap 5): Singh, "DreamBench-SWE" https://arxiv.org/abs/2608.20664 (2026-08-21); Nikolaev, Claim Plane pilot https://arxiv.org/abs/2607.21909 (2026-07-24); Chowdhury et al. https://arxiv.org/abs/2604.03196 (MSR 2026); Cynthia et al. https://arxiv.org/abs/2607.21997 (2026-07-24); Kim et al., Destefanis & Aste full text; CooperBench, Sun et al. version listings
- Magentic-One — https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ (2024-11-04)
- Hong et al., "MetaGPT" — https://arxiv.org/abs/2308.00352 (ICLR 2024)
- LangGraph docs — https://docs.langchain.com/oss/python/langgraph/interrupts
- OpenAI Agents SDK — https://openai.github.io/openai-agents-python/multi_agent/

Figures checked against primary text.

## 6. Open research gaps

- **Gap 1.** **(Closed 2026-10-04.)** SWE-agent per the paper (§2, 2024 models; the abstract's "+10.7 points" is vs shell-only *without demonstrations*, 7.33%). CrewAI, AutoGen 0.4+, Microsoft Agent Framework: no measurements, no writer integration [D]. Sweep pivoted to JetBrains (last push 2025-09-18).
- **Gap 3.** **(Narrowed 2026-10-04.) The knee is multi-study; our units barely measured.** CAID, CooperBench, Cursor: 2–4 for *coupled writers*; review lanes: Gap 7; one build-wave run, width 2 in 1/22 waves. Open: build-wave speed, which needs disjoint declared files.
- **Gap 4.** **(Narrowed 2026-09-26.) Review-unit size vs defect count.** No study fixes real-defect count while varying diff size. Probes bracket it: planted mutations saturate (E3, 14–19/20), real reverted defects floor (E3b, 0/12). Open: a tool-using, multi-pass reviewer on real defects.
- **Gap 5.** **(Re-checked 2026-10-04: none replicated or corrected.) Single-study [M]:** subtask memory (+4.7, SWE-bench Verified): nothing found. VibeMemBench (11/12; 111 tasks): nothing found; contrast: DreamBench-SWE (one author; recall-*requiring* tasks), hosted Mem0 97/180 vs none 21/180 [M]. MetaGPT (+4.2 HumanEval, 2023 models): no re-run; Kim et al.: multi-agent −2.1% to −14.9% vs single (SWE-bench Verified, 20-instance subsets) [M]. Sun et al. (22,000+ comments; confounded): other metrics only: Chowdhury (3,109 PRs) 12/13 review agents' signal ratio <60%; Cynthia (54,713 comments) 54.8–72.9% of threads *marked* resolved [M]. Claim Plane (30 pairs): only the author's 6-pair pilot. CooperBench 2/3/4 (46 tasks): no re-run above 2 agents; Destefanis & Aste (synthetic, 10 runs/cell): split spec 10/10 at 2–8 agents, eight-step chain 9/10 at 2 and 4, 0/10 at 8 [M]: decline tracks coupling.
- **Gap 6.** **(Narrowed 2026-10-04.) Unmeasured repo claims.** Measured (§3): declared lists vs diffs, per-phase cost, the non-worker half (test gates). Open: what main-session manager time contains; a wave run at width >1; whether a `-p` teams path survives `/resume`.
- **Gap 7.** **(Narrowed 2026-10-04, not closed.) Cherry-pick integration cost.** 60 lane runs: 0 conflicts, 0/18 dropped, ≤11.3 s (§3). Open: small n (upper bounds 15%; 28% over 9 contested picks), one repo at N=2, 31 pre-10-01 lanes lack `integration_check`.

## Changelog

- 2026-09-24 — §6 added; `--teams` unrunnable under `-p`; E3 saturated.
- 2026-09-26 — Gaps 3, 4, 6 narrowed; Gap 2 closed; Gap 7 added; E3b floored.
- 2026-10-02 — Gap 7 narrowed (first lane census); Xu et al. added.
- 2026-10-04 — Gap 7 refreshed; Gap 3 first wave run; Gap 6 pickle-phase decomposition; Gap 1 closed (SWE-agent verified, CrewAI, AutoGen 0.4+, Microsoft Agent Framework; Sweep out); Gap 5 re-checked (no replications). Numbers in the body.
