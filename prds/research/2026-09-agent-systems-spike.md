# Research spike: how other agent systems decompose, parallelise, persist and verify

Date: 2026-09-24 · Informs: #43 (`--teams`, review partitioning), #5 (knowledge, worktree-as-proposal, state from git)

**⚠ Corpus bias (operator, 2026-09-26): every [M, this repo] TIMING is Pickle Rick building ITSELF; field phases last HOURS; timing decisions need field data (`prds/research/tools/field-timing.py`).**

**Evidence labels:** **[M]** paper or independent benchmark · **[M, this repo]** measured here, command given · **[Mv]** vendor-measured on its own system · **[C]** claim, no method · **[D]** design description.

## 1. Summary

1. **Parallel writers pay off only on cleanly split work, with a strong verifier, at small N.** CAID +6 to +15 points, peaking at **4 workers on one benchmark, 2 on the other** [M]. CooperBench: **68.6% → 46.5% → 30.0% from 2 to 4 agents** (46 tasks, unreplicated) [M]; Cursor's 20 locked agents ≈ "two or three" [Mv]. Contra: STORM's incremental merge **rose from 2 to 8 engineers** (one benchmark and model; §3) [M]. The C compiler escaped a stall by **re-partitioning** [Mv]: our anatomy-park case.
2. **Our bundles cap build parallelism at ~2×, and `--teams` cannot run under the runner** [M, this repo]. Best-case waves: median 2.0× (1.33–3.0×); one real wave run: width 2 in 1/22 waves, 27.7 min/ticket; no team tools under `claude -p` (§3).
3. **Review recall falls as defects per unit grow; aggregated passes, not lanes, recover it; our probes saturated (E3), then floored (E3b).** SWR-Bench: recall **38% → 9% as real issues rise from 1 to ≥5, precision flat** [M]; 10 aggregated passes double recall, an agentic reviewer adds ~0 [M] (§3).
4. **Worktree-as-proposal is the industry convergence, unproven against alternatives.** Six systems give each writer a checkout and a rejectable merge [D]. CAID's test-gated merge **raised** cost and runtime [M]; disjoint work rarely interferes (1 in 834) [M]; our 67 review lanes: 0 conflicts, 0/21 dropped [M, this repo].
5. **Nobody derives state from git alone; the pattern is git plus one append-only log** (Anthropic, OpenHands, LangGraph) [D].
6. **Persistent memory evidence is weak.** VibeMemBench: **11 of 12 self-built memory pairings failed to beat memory-off**; *verified* history +1.1 to +4.5 points [M], favouring Move 2. Unreplicated; SWE Context Bench agrees in direction (Gap 5).

## 2. Comparison table

| System (source date) | Decomposition & assignment | Parallelism & conflicts | State & resume | Verification | Failure behaviour | Published measurement |
|---|---|---|---|---|---|---|
| **Claude Code agent teams** (docs, 2026-09) | Shared task list; self-claim via **file locks** | Parallel sessions; same-file edits overwrite | `~/.claude/tasks/`; **not restored on `/resume`**; **no team tools in `-p`** [M, this repo] | Task hooks | Lead "may stop early" | None. Recommends 3–5 [C] |
| **Anthropic C compiler** (2026-02-05) | `claude -p` loop per container | 16 agents, own clones; **lock-file git conflicts stop double-claims** | Git + lock files | Tests, GCC oracle; "verifier must be nearly perfect" | **Collapsed** on a monolithic task until re-split | ~2,000 sessions, ~$20k; builds Linux 6.9 [Mv] |
| **Anthropic long-running harness** (2025-11-26) | Feature list (200+); **one feature per session** | Single writer | Git + progress file + feature JSON | Browser tests | Premature victory | Qualitative [D] |
| **Anthropic harness design** (2026-03-24) | Planner → generator → **separate evaluator** | Single writer | Files/specs | Skeptical evaluator beats self-evaluation | Sprints **removed** later | Solo 20 min/$9 broken; harness 6 h/$200 working (n=1) [Mv] |
| **CAID** (arXiv 2603.21489, v2 2026-07) | Manager's dependency DAG | **Worktree per engineer**; manager merges; **conflicting author resolves** | Main branch | Local tests; test-gated integration | — | Commit0-Lite 53.1→59.1%; PaperBench 57.2→63.3%. Peak 4 / 2; **8 worse than 4**; dearer, slower [M] |
| **CooperBench** (arXiv 2601.13295, 2026-01-19) | One feature per agent, shared repo, messaging | Same codebase, concurrent | — | Joint feature tests | Expectation 42%, commitment 32%, communication 26% | ~30% below solo; **2 → 3 → 4 agents: 68.6 → 46.5 → 30.0%** (46 tasks) [M] |
| **Cursor long-running agents** (2026-01-14) | Recursive planners; workers | Hundreds; **optimistic concurrency** replaced locks | Repo | Workers resolve conflicts | Locks held too long | 20 locked agents ≈ 2–3 [Mv]; 1M-line browser in a week [Mv] |
| **OpenAI Codex cloud** (2025-05; docs 2026) | One task per sandbox; `--attempts N` | Container per task; worktrees; PRs | Repo + `AGENTS.md` | Checks; human review | Human retries | None public [C] |
| **GitHub Copilot coding agent** (2025-05; docs) | One issue → one draft PR | **Pushes only to its own branches** | Branch + PR | CI + human | Human-gated | None found |
| **Cursor 2.x parallel agents** (2025-10; docs) | Up to 8 (`/best-of-n`) | Worktree per agent; human merges | Worktrees | Human picks | Human-gated | None [C] |
| **Devin** (review 2025-11) | Playbooks fanned out | VM per session | Playbooks | Human | Human-gated | Merge rate 34%→67% YoY, "4x faster" [Mv] |
| **Cognition guidance** (2025-06; 2026-04-22) | Manager → children, map-reduce | **"Writes stay single-threaded"** | Context engineering | Clean-context reviewer | — | Reviewer ~2 bugs/PR [Mv] |
| **OpenHands V1 SDK** (arXiv 2511.03690, 2025-11) | Agent + subagents | Sandboxes | **Event-sourced log, deterministic replay** | Security reviewer | Stuck detector | Fewer system-attributable failures [Mv/C] |
| **mini-SWE-agent** (README, 2025–26) | One linear loop | None | Linear history | Benchmark | — | >74% SWE-bench Verified, ~100 lines [Mv] |
| **Agentless** (arXiv 2407.01489; FSE 2025) | Localize → repair → validate | Candidate patches | None | Regression + repro tests | — | Beat open agents (Lite), $0.34–0.70/issue [M] |
| **Aider architect/editor** (2024-09-26) | Planner model + editor model | None | Git commits | Benchmark tests | — | o1-preview 79.7→85.0%; Sonnet 77.4→80.5% [Mv] |
| **Factory Code Droid** (2024) | Planner + subtasks | Candidates chosen by tests | Code index | Tests, linters, self-critique | — | SWE-bench Lite pass@1 31.7% → pass@6 42.7% [Mv] |
| **SWE-agent** (arXiv 2405.15793; NeurIPS 2024) | One agent; LM-tailored commands | None | Trajectory | **Edit rejected if lint fails** | Unresolved (n=248): 52.0% wrong fix, 23.4% cascading edits | 12.47% of 2,294; Lite 18.0% vs shell-only 11.0%; no linting −3.0 [M] |
| **CrewAI** (docs, 2026-10) | Ordered, or **manager assigns and reviews** | Per-task async; no shared-write rule | One `Memory` store | Guardrails, retried ≤3 | — | None [D] |
| **AutoGen 0.4+** (docs; maintenance mode) | Round-robin, selector, swarm, graph teams | **Turn-taking, one shared context** | `save_state()` JSON | Termination conditions | — | None [D] |
| **Microsoft Agent Framework** (1.0; docs 2026-09; AutoGen successor) | Executor graph: sequential, concurrent, handoff, group chat, Magentic | Concurrent = **same input to all, answers aggregated** | **Checkpoint per superstep**; needs identical topology to rehydrate | Approval-gated tools | Stall limit → **reset and replan** | None found [D] |
| **Magentic-One** (2024-11-04) | Task/progress ledgers | Sequential | Ledgers in context | Self-reflection | **Stall counter > 2 → replan**, not halt | ≈ SOTA on GAIA [Mv] |
| **MetaGPT** (ICLR 2024) | SOP roles, documents | Largely sequential | Documents | Runs code, feeds errors back | — | +4.2 pts HumanEval; human fixes 2.5 → 0.83 [M, older models] |
| **LangGraph** (docs) | Graph nodes | Parallel branches | **Checkpoint per step** | User-defined | Interrupt → persist → resume | None [D] |
| **OpenAI Agents SDK** (docs) | Handoffs vs agents-as-tools | — | Sessions | Guardrails | — | None [D] |

**MAST [M].** 1,600+ multi-agent traces: design 43.9%, misalignment 32.4%, verification 23.8%. Top modes: step repetition 15.7%, reasoning–action mismatch 13.2%, **not knowing when to stop 12.4%**. Fixes: +9.4 to +15.6 (ChatDev).

## 3. Findings mapped to our questions

### #43: parallel build workers, or finer review partitioning?

**Status.** Soak bundles run `anatomy_max_parallel_lanes: 2` (default 1; `prds/MASTER_PLAN.md` "2.2 completion ledger").

**`--teams` is neither parallel nor runnable under the runner** [M, this repo, 2026-09-24].
- *Runnable.* The manager runs in print mode (`backend-spawn.ts`, `args.push('-p', opts.prompt)`). Claude Code 2.1.281 `claude -p "reply ok" --output-format stream-json --verbose --max-turns 1 | head -1`: **`TeamCreate`, `TaskCreate`, `TaskUpdate`, `TaskList`, `Agent` absent**, even with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- *Parallel.* `extension/templates/_pickle-manager-prompt.md:173`: "`state.max_parallel` is plumbed for a follow-up … today, treat as 1".
- **So** E2 needs an interactive manager or `-p` teams.

**Build parallelism in our bundles is small** [M, this repo, 2026-09-24]. Backticked paths in each non-hardening ticket's "**Files to modify/create**"; tickets placed greedily in `order` after any earlier one sharing a file; speedup = tickets ÷ waves.

| Session | Impl tickets | Waves | Best-case speedup | Widest wave |
|---|---|---|---|---|
| 2026-09-17-3c7489fc | 5 | 3 | 1.67 | 3 |
| 2026-09-17-5f3aa6b4 | 4 | 3 | 1.33 | 2 |
| 2026-09-17-df5973be | 3 | 1 | 3.00 | 3 |
| 2026-09-19-4dbaed57 | 3 | 2 | 1.50 | 2 |
| 2026-09-21-7ba3aec1 | 6 | 3 | 2.00 | 4 |
| 2026-09-22-723eafe4 | 3 | 1 | 3.00 | 3 |
| 2026-09-22-a88001dd | 2 | 1 | 2.00 | 2 |

Median 2.0×, pooled 26 / 14 = **1.86×** (single-ticket, hardening-only sessions out); whole-field parsing and `completion_commit` agree (**≤3×, median ~1.5–2×**). Hardening stays serial: 1277 → 1031 min (−19%) at best.

**Do declared lists predict diffs? Yes, conservatively** [M, this repo, 2026-09-26]. 16 sessions; 27/36 non-hardening tickets declare paths. Actual = `git show --name-only` over `completion_commit` plus commits naming the id.

| Measure (27 tickets) | Value |
|---|---|
| Actual files declared (recall), median / pooled | 1.00 / 0.85; 19 tickets complete |
| Declared files touched (precision), median / pooled | 0.80 / 0.73; 16 over-declare (38 files) |
| Undeclared touches, by kind | 18 in 8 tickets: tests 8, prompts 8, CLAUDE.md catalogs 2, compiled 0, source 0 |
| Undeclared touch in a same-session ticket's declared set | 1 (a CLAUDE.md catalog) |
| Same-wave pairs with overlapping actual diffs | 0 of 11 |

**Implication:** lists over-declare, so 1.5–2× hides no collisions; catalogs and `.claude/**/*.md` stay shared.

**First real wave run: width 2 once** [M, this repo, 2026-10-04; one run]. `2026-10-02-be104839` (B-MEGA), `max_parallel_tickets: 2`: 23 tickets, 22 waves, widths 1×21 + 2×1 (`pickle waves:` lines; `field-timing.py` agrees).
- **Reliability.** 22/23 integrated; 1/23 (`unmapped`, no attributable commit) finished by serial fallback. 0 conflicts, 0 halts.
- **Why width stayed 1.** Deployed `planTicketWave` replayed over declared files reproduces all 22 widths: 19/22 adjacent pairs overlap (11 only via `.claude/**`, `CLAUDE.md`), 2 lack `parallel_safe`. All-safe ceiling 1.10×.
- **Speed.** **27.7 min/ticket** (636.0 min; serial: E2 bar <27, field 20–27, `2026-10-03-2868b847` 8.3).
- **Read-out.** Reliability held; shared-surface bundles cannot split into waves.

**How many concurrent units?** (primary sources, 2026-09-26)
- **CooperBench** [M], **Cursor** [Mv]: §2 (*coupled* work); Cursor's integrator "created more bottlenecks than it solved".
- **Claim Plane** [M, single author]. 30 CooperBench pairs: pre-write admission 23.3% → 50.0%, serializing 96.7% of executions.
- **Passes Alone, Fails Together** [M]. 417 real Django PR pairs, two agents: 1 interference in 834 runs; 97% of tasks share helpers.
- **Destefanis & Aste** [M]: messaging "close to quadratically". **Kim et al.** [M]: +80.8% (decomposable) to −70.0% (sequential); single ≥ multi at matched compute, reasoning tasks (Tran & Kiela; Jwalapuram et al.) [M]. **AgenticFlict** [M]: 27.67% of agent-PR merges conflict; **Xu et al.** [M]: 19.8% same- vs 41.7% cross-agent (747 pairs).
- **STORM** [M]. Shared state, incremental conflict resolution: 2 → 4 → 8 engineers 38.2 → 46.4 → 69.7% (Commit0-Lite, 16 repos, Sonnet 4.6); its worktree baseline (CAID-style) not run at 8.
- **Anthropic research system** [Mv]: +90.2% over single-agent at ~15× tokens; coding parallelizes less.
- **Read-out for lanes.** Every measured 2→3 curve on *coupled*, deferred-merge work declines (CAID peaked at 2 once); STORM's incremental merge did not (HYPOTHESIS: the knee is merge timing); none covers **cherry-picked review lanes**. **Start at 2; go to 3 only on the soak's own conflict and dropped-lane rate**.

**Cherry-pick integration: 0 conflicts, 0 dropped, small n** [M, this repo, 2026-10-07; `lanes.json`, logs]: 16 sessions, cap 2.
- **67 lanes**, all integrated; 21 committed (63 commits, 63/63 `git patch-id` matches). Dropped **0/21** (one-sided 95% exact bound 1 − 0.05^(1/n): 13%).
- **Contested picks** (onto a tree an earlier pick moved): 0/9 conflicts (bound 28%). Not disjoint: 36/128 touches outside the lane.
- **`integration_check`** (36 lanes from `face240c`): green 13 (every committing lane), null 23; 31 earlier lack it: **a gap**.
- **Wall-clock** (last lane end → `verdict`): 3.4–11.3 s (new sessions 5.1–5.7 s), ≤1.5% of the lanes span (span now first lane start → `verdict`; the 10-04 figure, ≤0.81%, used a different span, so the rise is method, not cost). **Negligible at N=2; bounds 13% / 28% do not license N=3.**
- **Attribution survives** [24 `lanes.json` commits, patch-id matched, `git show -s`]: message byte-identical 24/24 (3/3 trailers); author, author date, committer 24/24; committer date rewritten. Limits: one human identity (author proves nothing about agents); no ticket trailers; no squash.

**The anatomy-park stall is the C-compiler stall:** `discoverSubsystems` (`pipeline-runner.ts:471`) makes `extension/` one lane.

**Review-size literature** (re-read 2026-09-24):
- **Kumar et al.: confounded** (synthetic small bins, real large); **not used.**
- **SWR-Bench: clean.** Recall 38.35% (N=1 issue, 266 PRs) → **8.88% (N≥5, 22 PRs)**, precision flat [M]: ~0.4–0.5 finds per PR at every N; our diffs are the many-issue case.
- **Štorek et al.: mechanism.** 10 LLMs: semantic code recall drops a median 92.73% mid-context [M; not review].
- **Implication.** Direction supported twice; magnitude not. If finds per pass are fixed, **passes-to-clean scale with defect count, not partition size**; finer partitions save only wall-clock.

**Gap 4: passes, tools or lanes on real defects?** (2026-10-07)
- **More independent passes raise recall** [M]. SWR-Bench, n aggregated reviews: recall 13.91% → **30.44% at n=10** (F1 +43.67%). c-CRAB (234 real comments): best agentic tool 32.1%, four unioned 41.5%.
- **Tools alone do not** [M]. SWR-Bench: SWE-agent-style reviewer 20.93%, one prompt 20.39%. CR-Bench Reflexion: recall +5.8/+9.2 points, signal-to-noise 5.11 → 1.95 / 2.89 → 0.91. Contra: Cursor's "largest gains" came from going agentic, 0.2 → 0.5 resolved bugs/PR [Mv; no recall].
- **Finds scale with the reviewer** [Mv]. Anthropic Code Review adds agents with PR size: 0.5 issues/PR under 50 lines, 7.5 over 1,000; no recall.
- **Ceiling:** shipped reviewers find 18–33% of real defects [M].
- **Read-out.** Buy recall with **more independent passes per lane plus one aggregator**, not more lanes; lanes buy wall-clock (and E3's tests-lane signal). Passes are readers feeding one writer: attribution-safe. **Falsified by** a study holding real-defect count fixed where lanes beat equal-pass whole-diff review ≥1.5×.

**Strength.** Moderate-to-strong for "partition first, keep N small" (CooperBench unreplicated; STORM contra); moderate for passes over lanes (no study fixes defect count).

### #5 Move 4: worktree-as-proposal

- **Evidence.** Design convergence [D]. CAID's **manager-owned merge** ≈ #5's accept/reject gate; the C compiler's push conflicts *are the lock* [Mv].
- **Unclaimed.** No source measures isolation reducing defects vs trunk plus fences. Costs: CAID slower, dearer; Claim Plane serialized ~all [M].
- **Strength.** Consensus plus cost data; "deletes our five enforcement mechanisms" is HYPOTHESIS.

### Gap 8: harness-agnostic coordination (2026-10-07)

Every cross-CLI orchestrator found uses only processes, files, git [D].

| Our single-writer assumption | Harness-neutral pattern | Source |
|---|---|---|
| Spawn lock | Lock the **claim**, not the spawn: TTL lease under a git ref, or a lock file whose push conflict is the lock | grite [M, synthetic]; C compiler [Mv]; agent teams [D] |
| `state.json` single writer | Keep it; workers **append** actor-stamped events, one projector | grite: last-writer-wins file drops concurrent writes, git-ref log none [M, synthetic]; OpenHands [D] |
| Sequential attribution ledgers | Actor id **in the artifact**: commit trailer, author suffix, or revision-keyed trace record | Aider `(aider)`; Agent Trace 0.1.0 [D] |
| Per-ticket scope fence | **Worktree + branch per writer**: diff the branch, not the iteration window | claude-squad, Vibe Kanban, Conductor, Codex, Claude Code `isolation: worktree`, Copilot [D] |

- **Measured cost: one study.** grite (seeded op-generators, not LLMs): at N=32 duplicate work 78% (none) → 64% (locks only) → **0% (locks + shared log)**; goodput 2.33 → 3.84 → 8.00 tasks/round; cross-actor overwrites 410 → 138 → 48 [M]. Locks alone barely help.
- **Read-out.** The babysitter false record (MASTER_PLAN "🐝 AGENT SWARMS") was two writers in one checkout and window. Worktree per writer plus a commit trailer makes attribution a property of the commit, not timing; `state.json` stays single-writer.

### #5 Move 5: state from git

- **Evidence.** Durable systems keep **one** authoritative record [D]; none duplicates git in a 47-field blob. Next: E4.

### #5 Moves 1–2: persistent knowledge

- **Evidence.** Self-built memory 11/12 fail to beat none; verified experience +1.1 to +4.5; subtask memory +4.7 [M]; none independently replicated (Gap 5). Vendors load **small curated files every session** (`AGENTS.md`, CLAUDE.md) [D].
- **Implication.** Move 2 (committed trap-door file, 20–40 lines per directory) is supported; judge Move 1 on orientation time.

### The ~300-minute review toll

- **Separate reviewers work** (Anthropic, Cognition, MAST) [Mv/M]; ours review one accumulated diff serially.
- **Supported cuts:** smaller concurrent units at small N; per-unit stop conditions (MAST); for recall, aggregated passes, not lanes (Gap 4).

**Does each worker phase earn its time? Review phases are nearly free** [M, this repo, 2026-09-26]. 65 tickets, 10 sessions (09-19 → 09-25). Phase = gap between consecutive artifact *births* from the first `worker_session_*.log`; respawn-spanning intervals dropped (12 tickets). "Changed" = review artifacts read by hand, plus post-review edits.

| Phase | n | Median | Changed |
|---|---|---|---|
| Research | 62 | 2.2 min | (produces input) |
| Research Review | 65 | 4 s | 0/65 (all APPROVED, unedited) |
| Plan | 65 | 11 s | (produces input) |
| Plan Review | 65 | 1 s | 1/65 (plan amended) |
| Implement + Spec Conformance | 57 | 2.8 min (1.0 + 1.9 where split, n=32) | Conformance: 5/65 closed a failed criterion |
| Code Review | 65 | 5 s | 8/65 fixed a defect |
| Simplify | 38 | 0 s | 11/38 changed (+4 unclear); 27 no artifact |
| Whole worker spawn(s) | 65 | 6.7 min | 95% inside intervals (53 single-spawn) |

**Limits.** Write time is not thinking time (25–33/65 reviews landed ≤2 s after their subject); change counts are lower bounds.

**Finding.** "~3 min per phase" fails: review/simplify cost <1 min of 6.7; Research and Implement/Conformance ~75%. Research/Plan Review (0/65, 1/65): merge candidates (HYPOTHESIS). Conformance, Code Review, Simplify change 8%, 12%, ≥29% at near-zero cost. On `2026-09-21-7ba3aec1` 17 worker spawns sum to 262 of the pickle phase's 524 min.

**Where the rest of the pickle phase goes: test gates, not managers** [M, this repo, 2026-10-04; 15 sessions, 09-26 → 10-04]. Each pickle-phase second gets one label, by priority: worker (`worker_session_*.log` birth → mtime, or → `worker_produced_nothing` if empty) > worker gate (→ `worker_lint_gate_passed`/`worker_gate_failed`) > tail gate (prior `mux-runner.log` line → `between-ticket fast gate`) > gap (`wasted_iter` → `iteration_start`) > manager (rest of a mux window) > wave. Min/ticket:

| Session | Tickets L/M/S | Pickle | Worker | Worker gate | Tail gate | Manager | Gaps + wave |
|---|---|---|---|---|---|---|---|
| be104839, waves | 5/13/5 | 27.7 | 10.3 | 5.8 | 7.9 | 3.6 | 0.1 |
| 2868b847, serial | 0/9/10 | 8.3 | 2.4 | 3.7 | 0.8 | 1.3 | 0.0 |
| 03d1f8d2, serial | 7/5/1 | 16.9 | 6.5 | 6.9 | 0.6 | 2.9 | 0.0 |

- **Fixed costs.** Tail gate (between-ticket `test:fast` + post-final tier): 7.1–7.7 min per runner session, all 13 serial sessions; each wave unit is one (24 runs, median 7.6). Worker gate: median 7.4–7.9 min per medium/large ticket, ~0 for small (`test:fast` tier-skipped). Gaps ≤0.2 min per session; unit create/integrate 2.1 min over 22 waves.
- **27.7 vs 8.3.** Of the 19.3 min/ticket gap: worker +7.9 (large median 19.3 min vs 7.3 elsewhere, n=5 / 9; three empty-log spawns, 17.8 min each; non-empty logs 184.9 min), tail gate +7.0 (one per unit), manager +2.3, worker gate +2.0 (non-small 78% vs 47%), create/integrate +0.1. **Tier mix plus per-unit tail gates; not manager or worktree time.** HYPOTHESIS: serial B-MEGA ≈ 20 min/ticket (636 − 181 + 7.5), near 03d1f8d2's 16.9.
- **Falsified by** a wave run whose per-unit tail gate is not ≈7.5 min, or a serial bundle ≥75% non-small at ≤10 min/ticket. **Limits:** manager time is a residual; one wave run.
- **Lever.** A width-1 wave pays ~7.6 min of tail gate for nothing.

## 4. Experiments (measurement only)

**E3. Offline review-recall probe, 2026-09-24: INCONCLUSIVE, saturated** [M, this repo; `prds/research/e3/E3-results.md`].
- **Design.** B-INVENTED diff `f36ea11e..3ae1d57a` (7,083 lines), anatomy-park Phase-1 prompt, `claude-opus-5-5`, 20 one-line mutations. Arms: (a) whole, k=20; (b) four directory partitions; (c) whole, k=5; 3 repeats. **Bar:** (b)/(a) recall ≥1.5× at ≤1.25× false positives.
- **Result.** Recall (a) 0.80, (b) 0.90, (c) 1.00, zero false positives; b/a = 1.125×, below the bar; one pass found 14–19/20.
- **Signal: tests.** Whole-diff passes found nothing in `extension/tests` in 2/3 repeats (4/15 hits); the tests partition 12/15.

**E3b. Real reverted defects, 2026-09-26: INCONCLUSIVE, floored** [M, this repo; `prds/research/e3b/E3b-results.md`].
- **Design.** 12 real single-file fixes reversed into `12ffe132..1ad3f505` (14,812 lines). E3's prompt, model, bar; (b) = `resolve-scope` lanes; 16 calls, 0 refusals; k=0 silent.
- **Recall 0.00 in all 9 arm-repeats**; each pass emitted 1–3 *other* findings.
- **Read-out.** One no-tools pass cannot separate size from defect count (§3 Gap 4).

**E1. Finer anatomy-park partition** vs B-INVENTED (34 passes / 995 min, one lane). **Success:** largest lane ≤ 50% of baseline passes, wall-clock ≤ −25%. **Falsified if** Σ passes ≈ 34+ with no wall-clock drop.

**E2. `--teams`: blocked** under `-p`. Bar: < 27 min/ticket, zero interventions, `--max-parallel` ≤ 3.

**E4. Derive current ticket from git.** Trailers plus frontmatter status vs `state.json.current_ticket` per iteration. **Success:** ≥ 95% agreement, each miss a known drift bug. **Falsified if** git lacks needed state.

## 5. Sources (published; living docs accessed 2026-09-24 unless noted)

- Docs: Claude Code agent teams https://code.claude.com/docs/en/agent-teams; mini-SWE-agent https://github.com/SWE-agent/mini-swe-agent; Cursor worktrees https://cursor.com/docs/configuration/worktrees; LangGraph https://docs.langchain.com/oss/python/langgraph/interrupts; OpenAI Agents SDK https://openai.github.io/openai-agents-python/multi_agent/
- Anthropic: C compiler https://www.anthropic.com/engineering/building-c-compiler (2026-02-05); long-running harnesses https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (2025-11-26); harness design https://www.anthropic.com/engineering/harness-design-long-running-apps (2026-03-24); research system https://www.anthropic.com/engineering/multi-agent-research-system (2025-06-13; read 2026-09-26)
- Geng & Neubig, CAID https://arxiv.org/abs/2603.21489 (v2 2026-07)
- Khatua et al., CooperBench https://arxiv.org/abs/2601.13295 (2026-01-19; read 2026-09-26)
- Cursor, scaling agents https://cursor.com/blog/scaling-agents (2026-01-14)
- Nikolaev, Claim Plane https://arxiv.org/abs/2608.00947 (2026-08-02)
- Xia, Wu & Park, Passes Alone https://arxiv.org/abs/2609.25396 (2026-09-21)
- Destefanis & Aste https://arxiv.org/abs/2608.16801 (2026-08-17)
- Kim et al. https://arxiv.org/abs/2512.08296 (2025-12-09; v3 2026-04-08)
- Ogenrwot & Businge, AgenticFlict https://arxiv.org/abs/2604.03551 (2026-04-04; v2 2026-05-12)
- Xu, Subramonian & Karthik https://arxiv.org/abs/2607.04697 (v2 2026-07-07; abstract)
- Cemri et al., MAST https://arxiv.org/abs/2503.13657 (v3 2025-10; NeurIPS 2025)
- Kumar, Bararia & Raj https://arxiv.org/abs/2606.15689 (2026-04-09)
- Zeng et al., SWR-Bench https://arxiv.org/abs/2509.01494 (2025-09-01; FSE 2026)
- Štorek et al. https://arxiv.org/abs/2505.13353 (v5 2026-07-10; ACL 2026)
- Sun et al. https://arxiv.org/abs/2508.18771 (2025-08)
- VibeMemBench https://arxiv.org/abs/2609.23570 (2026-09-20)
- Shen et al., subtask memory https://arxiv.org/abs/2602.21611 (2026-02)
- Cognition https://cognition.com/blog/dont-build-multi-agents (2025-06); https://cognition.com/blog/multi-agents-working (2026-04-22); https://cognition.com/blog/devin-annual-performance-review-2025 (2025-11)
- OpenHands SDK https://arxiv.org/abs/2511.03690 (2025-11; MLSys 2026)
- Xia et al., Agentless https://arxiv.org/abs/2407.01489 (2024-07; FSE 2025)
- Aider architect https://aider.chat/2024/09/26/architect.html (2024-09-26)
- Factory Code Droid https://factory.com/news/code-droid-technical-report (2024)
- OpenAI Codex https://openai.com/index/introducing-codex/ (2025-05); https://developers.openai.com/codex/cloud
- GitHub Copilot agent https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/ (2025-05); https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent
- Yang et al., SWE-agent https://arxiv.org/abs/2405.15793 (v3 2024-11-11; NeurIPS 2024; read 2026-10-04)
- Accessed 2026-10-04: CrewAI https://docs.crewai.com/en/concepts/processes (+ tasks, memory); AutoGen https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html (+ state.html); Sweep https://github.com/sweepai/sweep; Microsoft Agent Framework https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints (+ orchestration)
- Accessed 2026-10-04 (Gap 5): Singh, "DreamBench-SWE" https://arxiv.org/abs/2608.20664 (2026-08-21); Nikolaev, Claim Plane pilot https://arxiv.org/abs/2607.21909 (2026-07-24); Chowdhury et al. https://arxiv.org/abs/2604.03196 (MSR 2026); Cynthia et al. https://arxiv.org/abs/2607.21997 (2026-07-24); Kim et al., Destefanis & Aste full text; CooperBench, Sun et al. version listings
- Accessed 2026-10-07 (Gap 4): SWR-Bench v2 https://arxiv.org/abs/2509.01494 (2026-06-05); Zhang et al., c-CRAB https://arxiv.org/abs/2603.23448 (v2 2026-03-30); Pereira et al., CR-Bench https://arxiv.org/abs/2603.11078 (2026-03-10); Cursor, Bugbot https://cursor.com/blog/building-bugbot (2026-01-15); Anthropic, Code Review https://claude.com/blog/code-review (2026-03-09)
- Accessed 2026-10-07 (Gap 8): Sarkar, grite https://arxiv.org/abs/2606.19616 (2026-06-17); Agent Trace 0.1.0 https://agent-trace.dev/ (2026-01); Aider https://aider.chat/docs/git.html; claude-squad https://github.com/smtg-ai/claude-squad; Vibe Kanban https://github.com/BloopAI/vibe-kanban; Conductor https://www.conductor.build/docs/concepts/git-worktrees; Codex https://learn.chatgpt.com/docs/environments/git-worktrees; Claude Code https://code.claude.com/docs/en/sub-agents; MCP Agent Mail https://github.com/Dicklesworthstone/mcp_agent_mail; beads https://github.com/steveyegge/beads
- Accessed 2026-10-07 (Gap 5): Liu et al., STORM https://arxiv.org/abs/2605.20563 (2026-05-19); Liu et al., E2EDev https://arxiv.org/abs/2510.14509 (v4 2026-04-16); Tran & Kiela https://arxiv.org/abs/2604.02460 (2026-04-02); Jwalapuram et al. https://arxiv.org/abs/2606.13003 (v2 2026-06-13); Zhu et al., SWE Context Bench https://arxiv.org/abs/2602.08316 (v3 2026-05-06); Cemri et al., AdaMAST https://arxiv.org/abs/2607.16387 (2026-07-17); no new versions: CooperBench, Kim et al., Claim Plane, Destefanis & Aste, VibeMemBench
- Magentic-One https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ (2024-11-04)
- Hong et al., MetaGPT https://arxiv.org/abs/2308.00352 (ICLR 2024)

Figures checked against primary text.

## 6. Open research gaps

- **Gap 1.** **(Closed 2026-10-04.)** SWE-agent measured (§2); CrewAI, AutoGen, Agent Framework unmeasured; Sweep discontinued.
- **Gap 3.** **(Narrowed 2026-10-04.)** The knee is 2–4 for *coupled writers* under deferred merge (CAID, CooperBench, Cursor; STORM contra, Gap 5); review lanes: Gap 7. Open: build-wave speed (needs disjoint files).
- **Gap 4.** **(Narrowed 2026-10-07.) Review-unit size vs defect count.** Planted mutations saturate (E3, 14–19/20); real reverted defects floor (E3b, 0/12); literature favours aggregated passes over tools (§3) [M]. Open: no study fixes real-defect count while varying diff size or lanes; an aggregated, tool-using E3b rerun (arms a/b, equal passes) is unrun.
- **Gap 5.** **(Re-checked 2026-10-07: none independently replicated.)** *Contradicted* [M]: MetaGPT +4.2 (E2EDev, unadapted GPT-4o: ~50% HumanEval, ~30% renamed the function). *Countered, not re-run:* the small-N knee (CooperBench, none above 2; CAID 8 < 4), by STORM (§3). *Direction only:* Kim et al. (−2.1% to −14.9%, SWE-bench Verified subsets) by Tran & Kiela, Jwalapuram et al. (reasoning, not code); VibeMemBench (11/12; targets kept only where injected history helped) by SWE Context Bench (filtered retrieval helps, unfiltered little or negative; earlier). *Single:* subtask memory (+4.7); DreamBench-SWE (recall-*requiring*: Mem0 97/180 vs none 21/180); Claim Plane (own pilot); MAST (AdaMAST: same group); Destefanis & Aste (synthetic): split spec 10/10 at 2–8 agents, eight-step chain 0/10 at 8: decline tracks coupling; Sun et al. (confounded; Chowdhury: 12/13 review agents' signal ratio <60%; Cynthia: 54.8–72.9% *marked* resolved).
- **Gap 6.** **(Narrowed 2026-10-04.)** Measured (§3): declared lists, phase cost, test gates. Open: manager time; a wave run at width >1; `-p` teams under `/resume`.
- **Gap 7.** **(Narrowed 2026-10-07.) Cherry-pick integration cost.** 0 conflicts, 0/21 dropped (§3). Open: small n (bounds 13% / 28%; contested picks stuck at 9), one repo, N=2.
- **Gap 8.** **(Narrowed 2026-10-07.) Harness-agnostic multi-writer coordination.** Answered by design (§3) [D]; only cost data synthetic (grite) [M]. Open: attribution accuracy and lease overhead with real LLM writers at N>2; squash.

## Changelog

- 2026-09-24 — §6; `--teams` unrunnable under `-p`; E3 saturated.
- 2026-09-26 — Gaps 3, 4, 6 narrowed; Gap 2 closed; Gap 7 added; E3b floored.
- 2026-10-02 — Gap 7 first lane census; Xu et al.
- 2026-10-04 — Gaps 3, 6, 7 refreshed; Gap 1 closed; Gap 5 re-checked.
- 2026-10-07 — Gaps 4, 8 narrowed; Gap 7 re-censused (attribution survives cherry-pick); Gap 5 re-checked (MetaGPT contradicted; STORM counters the small-N knee; none replicated).
