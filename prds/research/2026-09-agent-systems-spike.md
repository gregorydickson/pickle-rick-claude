# Research spike: how other agent systems decompose, parallelise, persist and verify

Date: 2026-09-24 · Informs: #43 (`--teams`, review partitioning), #5 (knowledge, worktree-as-proposal, state from git)

**⚠ Corpus bias (operator, 2026-09-26): every [M, this repo] TIMING is Pickle Rick building ITSELF; field phases last HOURS; timing decisions need field data (`prds/research/tools/field-timing.py`).**

**Evidence labels:** **[M]** paper or independent benchmark · **[M, this repo]** measured here, command given · **[Mv]** vendor-measured on its own system · **[C]** claim, no method · **[D]** design description.

## 1. Summary

1. **Parallel writers pay off only on cleanly split work, strongly verified, at small N.** CAID +6 to +15 points, peaking at **4 / 2 workers by benchmark** [M]. CooperBench: **68.6% → 46.5% → 30.0% from 2 to 4 agents** (unreplicated) [M]; Cursor's 20 locked agents ≈ "two or three" [Mv]. Contra: STORM's incremental merge **rose from 2 to 8 engineers** (one benchmark; §3) [M].
2. **Our bundles cap build parallelism at ~2×** [M, this repo]. Best-case median 2.0×; one wave run, width 2 once (§3).
3. **Review recall falls as defects per unit grow; aggregated passes, not lanes, recover it.** SWR-Bench: **38% → 9% from 1 to ≥5 real issues, precision flat** [M]; 10 aggregated passes double it, an agentic reviewer adds ~0 [M]; E3 saturated, E3b floored (§3).
4. **Worktree-as-proposal is the industry convergence, unproven against alternatives.** Six systems give each writer a checkout and rejectable merge [D]. CAID's test-gated merge **raised** cost and runtime [M]; disjoint work rarely interferes (1 in 834) [M]; our 67 review lanes: 0 conflicts, 0/21 dropped [M, this repo].
5. **Nobody derives state from git alone; the pattern is git plus an append-only log** (Anthropic, OpenHands, LangGraph) [D].
6. **Persistent memory evidence is weak.** VibeMemBench: **11 of 12 self-built memory pairings failed to beat memory-off**; *verified* history +1.1 to +4.5 points [M], favouring Move 2; unreplicated (Gap 5).

## 2. Comparison table

| System (source date) | Decomposition & assignment | Parallelism & conflicts | State & resume | Verification | Failure behaviour | Published measurement |
|---|---|---|---|---|---|---|
| **Claude Code agent teams** (docs, 2026-09) | Shared task list; **file-lock** self-claim | Parallel sessions; same-file edits overwrite | **Teammates lost on `/resume`**; **no team tools in `-p`** [M, this repo] | Task hooks | Lead "may stop early" | Recommends 3–5 [C] |
| **Anthropic C compiler** (2026-02-05) | `claude -p` loop per container | 16 agents, own clones; **lock-file git conflicts stop double-claims** | Git + lock files | Tests, GCC oracle | **Collapsed** on a monolithic task until re-split | ~2,000 sessions, ~$20k; builds Linux 6.9 [Mv] |
| **Anthropic long-running harness** (2025-11-26) | Feature list (200+); **one feature per session** | Single writer | Git + progress file + feature JSON | Browser tests | Premature victory | Qualitative [D] |
| **Anthropic harness design** (2026-03-24) | Planner → generator → **separate evaluator** | Single writer | Files/specs | Skeptical evaluator beats self-evaluation | Sprints **removed** later | Solo 20 min/$9 broken; harness 6 h/$200 working (n=1) [Mv] |
| **CAID** (arXiv 2603.21489, v2 2026-07) | Manager's dependency DAG | **Worktree per engineer**; manager merges; **conflicting author resolves** | Main branch | Local tests; test-gated integration | — | Commit0-Lite 53.1→59.1%; PaperBench 57.2→63.3%. Peak 4 / 2; **8 worse than 4** [M] |
| **CooperBench** (arXiv 2601.13295, 2026-01-19) | One feature per agent, shared repo, messaging | Same codebase, concurrent | — | Joint feature tests | Expectation 42%, commitment 32%, communication 26% | ~30% below solo; **2 → 3 → 4 agents: 68.6 → 46.5 → 30.0%** (46 tasks) [M] |
| **Cursor long-running agents** (2026-01-14) | Recursive planners; workers | Hundreds; **optimistic concurrency** replaced locks | Repo | Workers resolve conflicts | Locks held too long | 20 locked agents ≈ 2–3; 1M-line browser in a week [Mv] |
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
| **CrewAI** (docs, 2026-10) | Ordered, or **manager assigns and reviews** | Per-task async | One `Memory` store | Guardrails, ≤3 retries | — | None [D] |
| **AutoGen 0.4+** (docs; maintenance mode) | Round-robin, selector, swarm, graph teams | **Turn-taking, one shared context** | `save_state()` JSON | Termination conditions | — | None [D] |
| **Microsoft Agent Framework** (1.0; docs 2026-09; AutoGen successor) | Executor graph (sequential, concurrent, handoff, group chat, Magentic) | Concurrent = **same input to all, aggregated** | **Checkpoint per superstep** | Approval-gated tools | Stall limit → **reset and replan** | None [D] |
| **Magentic-One** (2024-11-04) | Task/progress ledgers | Sequential | Ledgers in context | Self-reflection | **Stall counter > 2 → replan**, not halt | ≈ SOTA on GAIA [Mv] |
| **MetaGPT** (ICLR 2024) | SOP roles, documents | Largely sequential | Documents | Runs code, feeds errors back | — | +4.2 pts HumanEval; human fixes 2.5 → 0.83 [M, older models] |
| **LangGraph** (docs) | Graph nodes | Parallel branches | **Checkpoint per step** | User-defined | Interrupt → persist → resume | None [D] |
| **OpenAI Agents SDK** (docs) | Handoffs vs agents-as-tools | — | Sessions | Guardrails | — | None [D] |

**MAST [M].** 1,600+ multi-agent traces: design 43.9%, misalignment 32.4%, verification 23.8%; **not knowing when to stop 12.4%**. Fixes: +9.4 to +15.6 (ChatDev).

## 3. Findings mapped to our questions

### #43: parallel build workers, or finer review partitioning?

**Status.** Soak bundles run `anatomy_max_parallel_lanes: 2` (default 1).

**`--teams` was neither parallel nor runnable under the runner** [M, this repo, 2026-09-24]. Claude Code 2.1.281 `claude -p "reply ok" --output-format stream-json --verbose --max-turns 1 | head -1` lists **no team tools** (`TeamCreate`, `Agent`), even with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; the manager prompt treated `state.max_parallel` as 1.

**Build parallelism in our bundles is small** [M, this repo, 2026-09-24]. Backticked "**Files to modify/create**" paths per non-hardening ticket; greedy waves in `order`; speedup = tickets ÷ waves.

Tickets/waves: 3c7489fc 5/3, 5f3aa6b4 4/3, df5973be 3/1, 4dbaed57 3/2, 7ba3aec1 6/3, 723eafe4 3/1, a88001dd 2/1 (widest 2–4): median 2.0×, pooled 26 / 14 = **1.86×**; whole-field parsing and `completion_commit` agree (≤3×). Hardening stays serial (−19% at best).

**Do declared lists predict diffs? Yes, conservatively** [M, this repo, 2026-09-26]. 16 sessions; 27/36 non-hardening tickets declare paths. Actual = `git show --name-only` over `completion_commit` plus commits naming the id.

Recall median 1.00 / pooled 0.85, 19 complete; precision 0.80 / 0.73, 16 over-declare (38 files). Undeclared touches: 18 in 8 tickets (tests 8, prompts 8, catalogs 2, source 0), 1 inside a same-session ticket's set. **Same-wave pairs with overlapping actual diffs: 0 of 11.**

**First real wave run: width 2 once** [M, this repo, 2026-10-04]. `2026-10-02-be104839` (B-MEGA), `max_parallel_tickets: 2`: 23 tickets, 22 waves (`pickle waves:` lines; `field-timing.py` agrees).
- **Reliability.** 22/23 integrated; 1 (`unmapped`) by serial fallback. 0 conflicts, 0 halts.
- **Why width stayed 1.** Deployed `planTicketWave` reproduces all 22 widths: 19/22 adjacent pairs overlap (11 via `.claude/**`, `CLAUDE.md` only), 2 lack `parallel_safe`; ceiling 1.10×.
- **Speed.** **27.7 min/ticket** (636.0 min; serial: E2 bar <27, field 20–27, 2868b847 8.3).

**How many concurrent units?**
- **CooperBench** [M], **Cursor** [Mv]: §2 (*coupled*).
- **Claim Plane** [M, Single]: admission 23.3% → 50.0% (30 pairs), serializing 96.7%: no speedup.
- **Passes Alone, Fails Together** [M, Single]: 1 interference in 834 runs (417 Django PR pairs, two agents); constructed coupled pairs 97%, a concurrent-change message recovers 82%.
- **Destefanis & Aste** [M]: messaging "close to quadratically". **Kim et al.** [M]: +80.8% (decomposable) to −70.0% (sequential). Agent-PR merges conflict 27.67% (**AgenticFlict**), 19.8% same- vs 41.7% cross-agent (**Xu et al.**, 747 pairs) [M].
- **STORM** [M]. Incremental conflict resolution: 2 → 4 → 8 engineers 38.2 → 46.4 → 69.7% (Commit0-Lite) at flat wall-clock (~13 h; minutes per point beat worktrees 5/6, single agent 2/6); CAID-style baseline not run at 8.
- **Anthropic research system** [Mv]: +90.2%, ~15× tokens, time −90%; coding parallelizes less [C].
- **Build wall-clock, net of merge** (2026-10-11/12) [M]. CAID runtime 1.15–1.23× single at 2, 1.59–2.54× at 4. Co-Coder (28 greenfield tasks): per file 0.99× / 1.56×, cohesion 1.81× / 2.10×. DeLM ≤2.49×. **SquidAgent** (greenfield, width unstated): 2.6× vs Claude Code, slower than two multi-agent baselines; parallelizes only when critical path plus overheads beats serial.
- **Read-out.** Coupled, deferred-merge curves decline past 2–4; STORM's write-time detection did not (HYPOTHESIS: merge timing); none covers cherry-picked lanes. **Start at 2; go to 3 only on the soak's conflict and dropped-lane rate**.

**Cherry-pick integration: 0 conflicts, 0 dropped, small n** [M, this repo, 2026-10-07; `lanes.json`, logs]: 16 sessions, cap 2.
- **67 lanes**, all integrated; 21 committed (63 commits, 63/63 `git patch-id` matches). Dropped **0/21** (95% bound 13%).
- **Contested picks** (onto a tree an earlier pick moved): 0/9 conflicts (bound 28%); 36/128 touches outside the lane.
- **`integration_check`** (36 lanes from `face240c`): green 13 (every committing lane), null 23; 31 earlier lack it.
- **Wall-clock** (last lane end → `verdict`): 3.4–11.3 s, ≤1.5% of lanes span: **negligible at N=2.**
- **N=3/4 replay** [M, this repo, 2026-10-12; scratch `replay.py`: 91 triples, 67 quads of disjoint file-sharing consecutive tickets, cherry-picked onto their base in every order]: original order clean; **48/91 (53%), 42/67 (63%) conflict in another**; 35%/39% per reorder; every clean order rebuilds the original tree. Sequential tickets: a coupling bound, not a lane rate.
- **Clean ≠ correct** [M]. Brun et al. (1,694 merges, 3 projects): 16% textual; **133/1,428 clean merges (9.3%) broke build or tests** (its "33%" counts conflicts). Shen et al. (117,218 Java merges): 13.6% textual, 0.1% build/test (lower bound). Uber SubmitQueue: ~40% problem odds at 16 concurrent changes [Mv; secondary].
- **Attribution survives** [24 `lanes.json` commits, patch-id matched, `git show -s`]: message (3/3 trailers), author, author date, committer 24/24; committer date rewritten. Limits: one human identity, no ticket trailers (Gap 8).

**Anatomy-park's stall is the C compiler's:** `discoverSubsystems` (`pipeline-runner.ts:471`) makes `extension/` one lane.

**Review-size literature:**
- **Kumar et al.: confounded** (synthetic small bins, real large); not used.
- **SWR-Bench.** Recall 38.35% (N=1 issue, 266 PRs) → **8.88% (N≥5, 22 PRs)**, precision flat [M]: ~0.4–0.5 finds per PR at every N; our diffs are the many-issue case.

**Gap 4: passes, tools or lanes on real defects?** (2026-10-07; 2026-10-12)
- **More independent passes raise recall** [M]. SWR-Bench, n aggregated reviews: recall 13.91% → **30.44% at n=10** (F1 +43.67%). c-CRAB (234 real comments): best agentic tool 32.1%, four unioned 41.5%. ICML 2025 industrial study (45 real-fault bugs) [M, Single]: 1 → 3 reviewers plus meta-reviewer, key-bug inclusion +4.4 to +8.9 points; sliced context 39.3 vs diff-only 23.7.
- **Tools alone do not** [M]. SWR-Bench: agentic reviewer 20.93%, one prompt 20.39%. CR-Bench Reflexion: recall +5.8/+9.2, signal-to-noise 5.11 → 1.95 / 2.89 → 0.91. Contra: Cursor's "largest gains" came from going agentic, 0.2 → 0.5 resolved bugs/PR [Mv; no recall].
- **Nor does whole-file context** [M, Single]. SWE-PRBench (8 models, 100 real PRs, one pass): file content lowered all 8 scores (Sonnet 4.6 0.190 → 0.135); no size breakdown.
- **Finds scale with the reviewer** [Mv]. Anthropic Code Review scales agents to PR size: 0.5 issues/PR under 50 lines, 7.5 over 1,000; no recall. GitHub ReviewBench, merged independent runs: online recall +13.6%, precision +8.0% (relative).
- **Volume dilutes a fixed planted set** [M, Single, planted]. PRWeaver (208 synthesized attacks): per-PR review 50–60% amid 24 benign PRs, whole-window 16–22% (~3×, unequal calls); splitting the attack ≤5 points.
- **Our review fixes are flat in size** [M, this repo, 2026-10-12; scratch `census.py`: `git log --first-parent --numstat` over `extension/{src,tests,templates}`, `.claude/commands`; bundle = ≥3 build commits, then `anatomy-park:`/`szechuan-sauce:` commits; n=100]. Fix commits: median 5 / 5 / 4.5 per tercile (625 / 1,296 / 6,142 build lines), Spearman 0.09; per kLOC 10.1 → 3.2 → 0.8. Fixes ≠ defects (no recall denominator); fits a fixed per-pass find budget (HYPOTHESIS).
- **Ceiling:** shipped reviewers find 18–33% of real defects [M].
- **Read-out.** Buy recall with **more independent passes plus one aggregator**, not lanes or wider context; lanes buy wall-clock (and E3's tests signal). Passes are readers feeding one writer: attribution-safe. **Falsified by** a study holding real-defect count fixed where lanes beat equal-pass whole-diff review ≥1.5×; PRWeaver's planted ~3×: untouched.

**Strength.** Moderate-to-strong for "partition first, keep N small" (STORM contra); moderate for passes over lanes.

### #5 Move 4: worktree-as-proposal

- Design convergence [D]; CAID's **manager-owned merge** ≈ #5's accept/reject gate; the C compiler's push conflicts *are the lock* [Mv]. No source measures isolation reducing defects vs trunk plus fences; Claim Plane serialized ~all [M]. "Deletes our five enforcement mechanisms" is HYPOTHESIS.

### Gap 8: harness-agnostic coordination (2026-10-07; 2026-10-12)

Cross-CLI orchestrators use processes, files, git [D]:
- **Spawn lock → lock the claim** (git-ref lease or lock file): grite [M, synthetic]; C compiler [Mv]. **`state.json` keeps one writer**; workers append actor-stamped events (grite: a last-writer-wins file drops concurrent writes [M, synthetic]; OpenHands [D]).
- **Ledgers → actor id in the commit** (trailer, author suffix): Aider, Agent Trace, kernel `Assisted-by:` (model only) [D]. **Scope fence → worktree + branch per writer**: claude-squad, Vibe Kanban, Conductor, Codex, Claude Code, Copilot [D].

**Lease cost.** grite (op-generators), N=32: duplicate work 78% → 64% (locks) → **0% (+ shared log)** [M, Single]. CoAgent: 2PL/OCC "surrender nearly all concurrency gains" [M, Single, abstract]. Ours [M, this repo, 2026-10-12; scratch `lease.py` (uncommitted): 50 zero-hold cycles/process]: `mkdir` ≤0.04 ms median at N=1–8; `git update-ref` create-only lease **11.9 / 26.4 / 41.5 / 57.5 / 139 ms at N=1/2/3/4/8** (p95 466 ms); one claim per 6.7-min spawn: <0.05%.

**Attribution through integration** [M, this repo, 2026-10-12; scratch `attrib.sh`: N=3, 4 worktrees, 2 commits each, author + trailer + note]. Lines blamed correctly: merge, cherry-pick, rebase **30/30, 40/40**; `merge --squash` **0/30, 0/40**. Every author as `Co-authored-by` (GitHub's default [D]): still 0/40; per-writer squash plus trailer, 40/40. **Carriers** [M, this repo; `prov.sh`, git 2.39.5, N=3 × 2 commits]: cherry-pick (±`-x`), rebase keep trailer, author 6/6, notes 0/6 (rebase with `notes.rewriteRef` 6/6; cherry-pick ignores it [D]); default-message `merge --squash`: none. A 590k-commit census missed `refs/notes/ai`, unfetched by default [M, Nesbitt].

**N>2 LLM writers: none.** AgentRoom N=2; AgenTag identifies *product* (F1 0.96, 5 agents) [M, Single], not the instance.

### #5 Move 5: state from git

- Durable systems keep **one** authoritative record [D]; none duplicates git in a 47-field blob (E4).

### #5 Moves 1–2: persistent knowledge

- §1 item 6, Gap 5; subtask memory +4.7 [M]. Vendors load **small curated files every session** [D]. Move 2 (committed trap-door file, 20–40 lines per directory) is supported; judge Move 1 on orientation time.

### The ~300-minute review toll

- **Separate reviewers work** (Anthropic, Cognition, MAST) [Mv/M]. **Supported cuts:** per-unit stop conditions (MAST); recall: Gap 4.

**Does each worker phase earn its time? Review phases are nearly free** [M, this repo, 2026-09-26]. 65 tickets, 10 sessions (09-19 → 09-25). Phase = gap between consecutive artifact *births* from the first `worker_session_*.log`; respawn-spanning intervals dropped (12 tickets); "changed" read by hand.

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

**Finding** (write time ≠ thinking time: 25–33/65 reviews landed ≤2 s after their subject). Review/simplify cost <1 min of 6.7; Research plus Implement ~75%. Research/Plan Review: merge candidates (HYPOTHESIS).

**Where the rest of the pickle phase goes: test gates, not managers** [M, this repo, 2026-10-04; 15 sessions, 09-26 → 10-04]. Each pickle-phase second gets one label, by priority: worker (`worker_session_*.log` birth → mtime) > worker gate (→ `worker_lint_gate_passed`/`worker_gate_failed`) > tail gate (→ `between-ticket fast gate`) > gap > manager (rest of a mux window) > wave. Min/ticket:

| Session | Tickets L/M/S | Pickle | Worker | Worker gate | Tail gate | Manager | Gaps + wave |
|---|---|---|---|---|---|---|---|
| be104839, waves | 5/13/5 | 27.7 | 10.3 | 5.8 | 7.9 | 3.6 | 0.1 |
| 2868b847, serial | 0/9/10 | 8.3 | 2.4 | 3.7 | 0.8 | 1.3 | 0.0 |
| 03d1f8d2, serial | 7/5/1 | 16.9 | 6.5 | 6.9 | 0.6 | 2.9 | 0.0 |

- **Fixed costs.** Tail gate (`test:fast` + post-final tier): 7.1–7.7 min per runner session; one per wave unit (median 7.6). Worker gate: median 7.4–7.9 min per medium/large ticket, ~0 small. Gaps, unit create/integrate: ≤2.1 min per run.
- **27.7 vs 8.3.** Of the 19.3 min/ticket gap: worker +7.9 (large tickets; three 17.8-min empty-log spawns), tail gate +7.0, manager +2.3, worker gate +2.0: **tier mix plus per-unit tail gates.** HYPOTHESIS: serial B-MEGA ≈ 20 min/ticket.
- **Falsified by** a per-unit tail gate ≠ ≈7.5 min, or a serial ≥75%-non-small bundle at ≤10 min/ticket.
- **Manager time, direct** [M, this repo, 2026-10-11; manager `duration_ms`/`duration_api_ms`; `field-timing.py`]. 4 serial sessions, 54 tickets: **76.0 of 990.3 pickle min (7.7%), 1.4 min/ticket** (0.9–3.1), 70% model time; workers 36%; 56% neither (gates: HYPOTHESIS). 0 subagents in 84 manager spawns.
- **Break-even width: a MODEL.** *w* units of worker + worker gate *t* take ≈ *t* + 9.7 min (tail gate 7.6 + create/integrate ≤2.1) vs *w*·*t* serial: break-even *w* = 1 + 9.7/*t* = **2.6** (*t* 6.1, 2868b847), **1.7** (13.4, 03d1f8d2), **1.6** (16.1, be104839); width 2 gives 0.77–1.25×, width 4 1.5–2.5×. Tier CPU contention ignored (HYPOTHESIS: lowers the curve).
- **Since 10-04** [M, this repo, 2026-10-12; `field-timing.py`, 10 sessions, 66 tickets]: **0 wave runs**; four ≥9-ticket bundles 5.2–15.1 worker min/ticket (gates excluded): break-even ≤1.6–2.9.

## 4. Experiments (measurement only)

**E3. Offline review-recall probe, 2026-09-24: INCONCLUSIVE, saturated** [M, this repo; `prds/research/e3/E3-results.md`].
- **Design.** B-INVENTED diff (7,083 lines), 20 one-line mutations. Arms: (a) whole, k=20; (b) four directory partitions; (c) whole, k=5; 3 repeats. **Bar:** (b)/(a) recall ≥1.5×, false positives ≤1.25×.
- **Result.** Recall (a) 0.80, (b) 0.90, (c) 1.00, zero false positives; b/a = 1.125×, below the bar; one pass found 14–19/20.
- **Signal: tests.** Whole-diff passes found 4/15 in `extension/tests` (nothing in 2/3 repeats); the tests partition 12/15.

**E3b. Real reverted defects, 2026-09-26: INCONCLUSIVE, floored** [M, this repo; `prds/research/e3b/E3b-results.md`].
- **Design.** 12 real single-file fixes reversed into a 14,812-line diff; E3's prompt, model, bar; (b) = `resolve-scope` lanes; 16 calls, 0 refusals; k=0 silent.
- **Recall 0.00 in all 9 arm-repeats**; each pass emitted 1–3 *other* findings.
- **Read-out.** One no-tools pass cannot separate size from defect count.

**E1. Finer anatomy-park partition** vs B-INVENTED (34 passes / 995 min, one lane). **Success:** largest lane ≤50% of baseline passes, wall-clock ≤−25%. **Falsified if** Σ passes ≈34+ with no wall-clock drop.

**E2. `--teams`:** deleted (B-LANES); bar was <27 min/ticket.

**E4. Derive current ticket from git** (trailers plus frontmatter vs `state.json.current_ticket`). **Success:** ≥95% agreement, each miss a known drift bug.

## 5. Sources (published; living docs accessed 2026-09-24 unless noted)

- Docs: Claude Code agent teams https://code.claude.com/docs/en/agent-teams; mini-SWE-agent https://github.com/SWE-agent/mini-swe-agent; Cursor worktrees https://cursor.com/docs/configuration/worktrees; LangGraph https://docs.langchain.com/oss/python/langgraph/interrupts; OpenAI Agents SDK https://openai.github.io/openai-agents-python/multi_agent/
- Anthropic: C compiler https://www.anthropic.com/engineering/building-c-compiler (2026-02-05); long-running harnesses https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (2025-11-26); harness design https://www.anthropic.com/engineering/harness-design-long-running-apps (2026-03-24); research system https://www.anthropic.com/engineering/multi-agent-research-system (2025-06-13)
- Geng & Neubig, CAID https://arxiv.org/abs/2603.21489 (v2 2026-07)
- Khatua et al., CooperBench https://arxiv.org/abs/2601.13295 (2026-01-19)
- Cursor, scaling agents https://cursor.com/blog/scaling-agents (2026-01-14)
- Nikolaev, Claim Plane https://arxiv.org/abs/2608.00947 (2026-08-02)
- Xia, Wu & Park, Passes Alone https://arxiv.org/abs/2609.25396 (2026-09-21)
- Destefanis & Aste https://arxiv.org/abs/2608.16801 (2026-08-17)
- Kim et al. https://arxiv.org/abs/2512.08296 (2025-12-09; v3 2026-04-08)
- Ogenrwot & Businge, AgenticFlict https://arxiv.org/abs/2604.03551 (2026-04-04; v2 2026-05-12)
- Xu, Subramonian & Karthik https://arxiv.org/abs/2607.04697 (v2 2026-07-07; abstract)
- Cemri et al., MAST https://arxiv.org/abs/2503.13657 (v3 2025-10; NeurIPS 2025)
- Kumar, Bararia & Raj https://arxiv.org/abs/2606.15689 (2026-04-09)
- Zeng et al., SWR-Bench https://arxiv.org/abs/2509.01494 (2025-09-01; v2 2026-06-05; FSE 2026)
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
- Yang et al., SWE-agent https://arxiv.org/abs/2405.15793 (v3 2024-11-11; NeurIPS 2024)
- Accessed 2026-10-04: CrewAI https://docs.crewai.com/en/concepts/processes; AutoGen https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html; Sweep https://github.com/sweepai/sweep; Microsoft Agent Framework https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints
- Accessed 2026-10-04 (Gap 5): Singh, "DreamBench-SWE" https://arxiv.org/abs/2608.20664 (2026-08-21); Nikolaev, Claim Plane pilot https://arxiv.org/abs/2607.21909 (2026-07-24); Chowdhury et al. https://arxiv.org/abs/2604.03196 (MSR 2026); Cynthia et al. https://arxiv.org/abs/2607.21997 (2026-07-24)
- Accessed 2026-10-07 (Gap 4): Zhang et al., c-CRAB https://arxiv.org/abs/2603.23448 (v2 2026-03-30); Pereira et al., CR-Bench https://arxiv.org/abs/2603.11078 (2026-03-10); Cursor, Bugbot https://cursor.com/blog/building-bugbot (2026-01-15); Anthropic, Code Review https://claude.com/blog/code-review (2026-03-09)
- Accessed 2026-10-07 (Gap 8): Sarkar, grite https://arxiv.org/abs/2606.19616 (2026-06-17); Agent Trace 0.1.0 https://agent-trace.dev/ (2026-01); Aider https://aider.chat/docs/git.html; claude-squad https://github.com/smtg-ai/claude-squad; Vibe Kanban https://github.com/BloopAI/vibe-kanban; Conductor https://www.conductor.build/docs/concepts/git-worktrees; Codex https://learn.chatgpt.com/docs/environments/git-worktrees; Claude Code https://code.claude.com/docs/en/sub-agents; MCP Agent Mail https://github.com/Dicklesworthstone/mcp_agent_mail; beads https://github.com/steveyegge/beads
- Accessed 2026-10-12 (Gap 8): CoAgent https://arxiv.org/abs/2606.15376 (2026-06-13); AgentRoom https://arxiv.org/abs/2608.23740 (2026-08-24); AgenTag https://arxiv.org/abs/2608.00966 (2026-08-02); Nesbitt https://nesbitt.io/2026/08/06/a-year-of-ai-disclosure-in-critical-packages.html; GitHub https://github.blog/changelog/2019-12-19-improved-attribution-when-squashing-commits/; git notes https://git-scm.com/docs/git-notes; Linux kernel https://docs.kernel.org/process/coding-assistants.html
- Accessed 2026-10-12 (Gap 4): defect-focused review https://arxiv.org/abs/2505.17928 (v2 2025-05-28; ICML 2025); Kumar, SWE-PRBench https://arxiv.org/abs/2603.26130 (2026-03-27)
- Accessed 2026-10-12 (Gap 4, 2nd): Wang et al., PRWeaver https://arxiv.org/abs/2608.02693 (2026-08-03); GitHub, ReviewBench https://github.blog/ai-and-ml/github-copilot/reviewbench-an-open-benchmark-for-ai-code-review/ (2026-10-05)
- Accessed 2026-10-12 (Gap 7): Brun et al. https://homes.cs.washington.edu/~mernst/pubs/vc-conflicts-fse2011.pdf (FSE 2011); Shen et al. https://people.cs.vt.edu/~gulzar/assets/pdf/tosem22_merge.pdf (TOSEM 2022); SubmitQueue https://blog.acolyer.org/2019/04/18/keeping-master-green-at-scale/; Menezes et al. https://journals-sol.sbc.org.br/index.php/jserd/article/view/1911 (JSERD 2021)
- Accessed 2026-10-12 (Gap 5): Muku, NP-Bench https://arxiv.org/abs/2610.07261 (2026-10-05); Hsu et al., OpenCollab https://arxiv.org/abs/2609.38345 (v2 2026-10-09); Liu et al., MAScope https://arxiv.org/abs/2610.10126 (2026-10-07)
- Accessed 2026-10-11 (Gap 3): Yang et al., Co-Coder https://arxiv.org/abs/2606.00953 (2026-05-31); Mao et al., DeLM https://arxiv.org/abs/2606.10662 (v3 2026-10-04)
- Accessed 2026-10-12 (Gap 3): Lin et al., SquidAgent https://arxiv.org/abs/2610.08647 (2026-10-06; NeurIPS 2026)
- Accessed 2026-10-07 (Gap 5): Liu et al., STORM https://arxiv.org/abs/2605.20563 (2026-05-19); Liu et al., E2EDev https://arxiv.org/abs/2510.14509 (v4 2026-04-16); Tran & Kiela https://arxiv.org/abs/2604.02460 (2026-04-02); Jwalapuram et al. https://arxiv.org/abs/2606.13003 (v2 2026-06-13); Zhu et al., SWE Context Bench https://arxiv.org/abs/2602.08316 (v3 2026-05-06); Cemri et al., AdaMAST https://arxiv.org/abs/2607.16387 (2026-07-17)
- Magentic-One https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ (2024-11-04)
- Hong et al., MetaGPT https://arxiv.org/abs/2308.00352 (ICLR 2024)

Figures checked against primary text.

## 6. Open research gaps

- **Gap 1.** **(Closed 2026-10-04.)** SWE-agent measured (§2); the rest unmeasured; Sweep discontinued.
- **Gap 3.** **(Narrowed 2026-10-12.)** Knee 2–4 for *coupled writers* under deferred merge; STORM's write-time detection holds to 8 [M]; lanes: Gap 7. *Build speed:* ≤2.6×, no width sweep [M]; break-even width 1.6–2.9 [M, this repo]. Open: a width >1 wave run.
- **Gap 4.** **(Narrowed 2026-10-12.) Review-unit size vs defect count.** E3 saturates, E3b floors; aggregated passes beat tools and whole-file context [M]; planted-set dilution ~3× [M, Single]; fixes per bundle ~5 at 625–6,142 build lines [M, this repo]. Open: no study fixes real-defect count while varying size or lanes; the aggregated, tool-using E3b rerun is unrun.
- **Gap 5.** **(Re-checked 2026-10-12: unreplicated, unrevised.)** *Contradicted* [M]: MetaGPT +4.2 (E2EDev, unadapted GPT-4o: ~50% HumanEval, ~30% renamed the function). *Countered:* small-N knee (STORM). NP-Bench [M, Single, author's planner] tests no knee: one hot file, n−1 conflicts by construction; disjoint scopes 0 at N=2–8. *Direction only:* Kim et al. (−2.1% to −14.9%, SWE-bench Verified) by Tran & Kiela, Jwalapuram et al. (reasoning); OpenCollab [M, Single] does neither: teams +5.6 to −16.7 vs single (SWE-bench Pro, ~36 tasks); Duo (best-of-2, 1.2–5.1× tokens) +3.4 to +9.7. VibeMemBench (11/12) by SWE Context Bench (filtered retrieval helps). *Single* [M]: subtask memory (+4.7; DreamBench's non-fidelity stand-in at floor); DreamBench-SWE (Mem0 97/180 vs none 21/180; same config 20/180 in fold 1, unexplained); Claim Plane; MAST (AdaMAST same group; MAScope reuses its labels); Destefanis & Aste (synthetic; split spec 10/10 at 2–8 agents, eight-step chain 0/10 at 8); Sun et al. (confounded; Chowdhury: 12/13 review agents' signal ratio <60%; Cynthia: 54.8–72.9% *marked* resolved).
- **Gap 6.** **(Closed 2026-10-12.)** Measured: §3; `-p` teams deleted (B-LANES; 103 runner inits lack `TeamCreate` [M, this repo]); width: Gap 3.
- **Gap 7.** **(Narrowed 2026-10-12.) Cherry-pick integration cost.** Lanes 0/9 contested, 0/21 dropped (N=2); replay order-dependent 53%/63% at N=3/4 [M, this repo]; clean merges break build/tests 0.1–9.3% [M]; human conflicts 9.8% of 182,273 merges, 6.6/29.5/43.0/59.1% at 1–3/4–10/11–30/>30 merged-in committers (Menezes; size-confounded) [M]. Open: lanes at N≥3 (bounds 13%/28%); agent studies past N=2 constructed (NP-Bench); one repo.
- **Gap 8.** **(Narrowed 2026-10-12.) Harness-agnostic multi-writer coordination.** Design answered [D]; per-writer commits keep blame 40/40, trailers 6/6; squash 0; lease ≤139 ms at N=8 [M, this repo]. Open: real LLM writers at N>2; lanes stamp no ticket trailer.

## Changelog

- 2026-09-24 — §6; `--teams` unrunnable under `-p`; E3 saturated.
- 2026-09-26 — Gaps 3, 4, 6 narrowed; Gap 2 closed; Gap 7 added; E3b floored.
- 2026-10-02 — Gap 7 first lane census; Xu et al.
- 2026-10-04 — Gaps 3, 6, 7 refreshed; Gap 1 closed; Gap 5 re-checked.
- 2026-10-07 — Gaps 4, 8 narrowed; Gap 7 re-censused; Gap 5 re-checked.
- 2026-10-11 — Gaps 3, 6 narrowed.
- 2026-10-12 — Gaps 3, 4, 7, 8 narrowed; Gap 6 closed; Gap 5 re-checked twice; DreamBench Mem0 unstable across folds.
