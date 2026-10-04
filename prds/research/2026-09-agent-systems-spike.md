# Research spike: how other agent systems decompose, parallelise, persist and verify

Date: 2026-09-24 · Scope: ~75 min desk research + refinements · Informs: GitHub #43 (`--teams` / review partitioning), GitHub #5 (persistent knowledge, worktree-as-proposal, state-from-git)

**⚠ Corpus bias (operator, 2026-09-26): every [M, this repo] TIMING here is Pickle Rick building ITSELF (small tickets, short runs); field runs last HOURS in the pickle phase alone. Build- or review-time decisions need field measurements (`prds/research/tools/field-timing.py`; results in `prds/research/tools/field-timing-results-2026-09-26.md`).**

**Evidence labels:** **[M]** measured in a paper or independent benchmark · **[M, this repo]** measured here, command given · **[Mv]** measured by the vendor on its own system · **[C]** claim, no published method · **[D]** design description only.

## 1. Summary

1. **Parallel writers pay off only on cleanly split work with a strong verifier, and the best worker count is small.** CAID gains +6 to +15 points with worktrees and a merging manager, peaking at **4 workers on one benchmark, 2 on the other** [M]. CooperBench success falls **68.6% → 46.5% → 30.0% from 2 to 4 agents** [M]; Cursor's 20 locked agents ran at "the effective throughput of two or three" [Mv]. The C compiler escaped a stall by **re-partitioning**, not adding agents [Mv]: our anatomy-park case.
2. **Our bundles cap build parallelism at ~2×, and `--teams` cannot run under the runner** [M, this repo]. File-disjoint waves: median best-case 2.0× (1.33–3.0×); the first real wave run reached width 2 in 1/22 waves; team tools are absent under `claude -p` (§3).
3. **Review recall falls as the unit grows; the published magnitude is untrustworthy; our offline probes saturated (E3), then floored (E3b).** The quoted F1 0.657 → 0.043 is confounded. SWR-Bench (FSE 2026) finds per-PR recall falling **38% → 9% as real issues per PR rise from 1 to ≥5, precision flat** [M]: a roughly constant number of finds per pass.
4. **Worktree-as-proposal is the industry convergence, unproven against alternatives.** Codex, Copilot, Cursor, Claude Code, CAID and the C compiler give each writer a checkout and a rejectable merge [D]. Integration cost cuts both ways: CAID's test-gated merge **raised** cost and runtime [M]; disjoint work rarely interferes (1 in 834 runs) [M]; our 60 review lanes had 0 conflicts and 0/18 dropped [M, this repo].
5. **Nobody derives state from git alone; the pattern is git plus one small append-only log** (Anthropic harness, OpenHands, LangGraph) [D].
6. **Persistent memory is weaker evidence than it sounds.** VibeMemBench: **11 of 12 self-built memory pairings failed to beat memory-off**; *verified* history helped +1.1 to +4.5 points [M], favouring #5's Move 2.

## 2. Comparison table

| System (source date) | Decomposition & assignment | Parallelism & conflicts | State & resume | Verification | Failure behaviour | Published measurement |
|---|---|---|---|---|---|---|
| **Claude Code agent teams** (docs, live 2026-09) | Shared task list; teammates self-claim via **file locks** | Parallel sessions; same-file edits overwrite | `~/.claude/tasks/`. **Teammates not restored on `/resume`**; **team tools absent in `-p`** ([M, this repo]) | `TaskCompleted`/`TeammateIdle` hooks | Stop on errors; lead "may stop early" | None. Recommends 3–5 [C] |
| **Anthropic C compiler** (2026-02-05) | `claude -p` loop per container; lock files | 16 agents, own clones; **lock-file git conflicts stop double-claims** | Git + lock files | Tests, GCC oracle; "verifier must be nearly perfect" | Parallelism **collapsed** on a monolithic task until re-partitioned | ~2,000 sessions, ~$20k; builds Linux 6.9 [Mv] |
| **Anthropic long-running harness** (2025-11-26) | `feature_list.json` (200+ items); **one feature per session** | Single writer | Git + `claude-progress.txt` + feature JSON | Browser tests (Puppeteer) | Premature victory, one-shotting | Qualitative [D] |
| **Anthropic harness design** (2026-03-24) | Planner → generator → **separate evaluator** | Single writer | Files/specs | Skeptical evaluator beats self-evaluation | Sprints **removed** later | Solo 20 min/$9 broken; harness 6 h/$200 working (n=1) [Mv] |
| **CAID** (arXiv 2603.21489, v2 2026-07) | Manager's dependency DAG | **Worktree per engineer**; manager merges; **conflicting author resolves** | Main branch | Local tests; test-gated integration | — | Commit0-Lite 53.1→59.1%; PaperBench 57.2→63.3%. Peak 4 / 2; **8 worse than 4**; higher cost and runtime [M] |
| **CooperBench** (arXiv 2601.13295, 2026-01-19) | One feature per agent, shared repo, messaging | Same codebase, concurrent | — | Joint feature tests | Expectation 42%, commitment 32%, communication 26% | Coop ~30% below solo; **2 → 3 → 4 agents: 68.6 → 46.5 → 30.0%** (46 tasks) [M] |
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
| **Magentic-One** (2024-11-04) | Orchestrator task/progress ledgers | Sequential delegation | Ledgers in context | Self-reflection | **Stall counter > 2 → replan**, not halt | ≈ SOTA on GAIA [Mv] |
| **MetaGPT** (ICLR 2024) | SOP roles, structured documents | Largely sequential | Documents | Runs code, feeds errors back | — | +4.2 pts HumanEval; human fixes 2.5 → 0.83 [M, older models] |
| **LangGraph** (docs) | Graph nodes | Parallel branches per step | **Checkpoint per step by `thread_id`** | User-defined | Interrupt → persist → resume | None [D] |
| **OpenAI Agents SDK** (docs) | Handoffs vs agents-as-tools | — | Sessions | Guardrails | — | None [D] |

**Why multi-agent systems fail (MAST, NeurIPS 2025) [M].** 1,600+ traces: system design 43.9%, inter-agent misalignment 32.4%, verification 23.8%. Top modes: step repetition (15.7%), reasoning–action mismatch (13.2%), **not knowing when to stop (12.4%)**. Fixes gave +9.4 to +15.6 points on ChatDev.

## 3. Findings mapped to our questions

### #43: parallel build workers, or finer review partitioning?

**Status.** Soak bundles run `anatomy_max_parallel_lanes: 2` (default 1); results: `prds/MASTER_PLAN.md` "2.2 completion ledger".

**`--teams` is neither parallel nor runnable under the runner as built** [M, this repo, 2026-09-24].
- *Runnable.* The manager runs in print mode (`backend-spawn.ts`, `args.push('-p', opts.prompt)`). Claude Code 2.1.281, `claude -p "reply ok" --output-format stream-json --verbose --max-turns 1 | head -1`: **`TeamCreate`, `TaskCreate`, `TaskUpdate`, `TaskList`, `Agent` absent** from `tools`, even with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- *Parallel.* `extension/templates/_pickle-manager-prompt.md:173`: "`state.max_parallel` is plumbed for a follow-up … today, treat as 1".
- **Consequence.** E2 needs an interactive manager or a `-p` teams path.

**Build parallelism in our bundles is small** [M, this repo, 2026-09-24]. Backticked paths in each non-hardening ticket's "**Files to modify/create**" block; tickets assigned in `order` greedily to waves (a ticket follows any earlier one sharing a file); speedup = tickets ÷ waves.

| Session | Impl tickets | Waves | Best-case speedup | Widest wave |
|---|---|---|---|---|
| 2026-09-17-3c7489fc | 5 | 3 | 1.67 | 3 |
| 2026-09-17-5f3aa6b4 | 4 | 3 | 1.33 | 2 |
| 2026-09-17-df5973be | 3 | 1 | 3.00 | 3 |
| 2026-09-19-4dbaed57 | 3 | 2 | 1.50 | 2 |
| 2026-09-21-7ba3aec1 | 6 | 3 | 2.00 | 4 |
| 2026-09-22-723eafe4 | 3 | 1 | 3.00 | 3 |
| 2026-09-22-a88001dd | 2 | 1 | 2.00 | 2 |

Median 2.0×, pooled 26 / 14 = **1.86×** (single-ticket, hardening-only sessions excluded); whole-field parsing and a `completion_commit` cross-check agree (**≤3×, median ~1.5–2×**). Hardening stays serial: the gain caps at 1277 → 1031 min (−19%) on #43's worst bundle.

**Do declared lists predict diffs? Yes, conservatively** [M, this repo, 2026-09-26]. 16 sessions: 27 of 36 non-hardening tickets declare paths. Actual = `git show --name-only` over `completion_commit` plus commits naming the id in the subject, minus mirrors and artifacts.

| Measure (27 tickets) | Value |
|---|---|
| Actual files that were declared (recall), median / pooled | 1.00 / 0.85; 19 tickets complete |
| Declared files touched (precision), median / pooled | 0.80 / 0.73; 16 tickets over-declare (38 files) |
| Undeclared touches, by kind | 18 in 8 tickets: tests 8, command/agent prompts 8, CLAUDE.md catalogs 2, compiled 0, source 0 |
| Undeclared touch in a same-session ticket's declared set | 1 (a CLAUDE.md catalog) |
| Same-wave ticket pairs whose actual diffs overlap | 0 of 11 |

**Implication:** lists over-declare, so the wave table errs toward serializing; its 1.5–2× is not inflated by hidden collisions. A scheduler should still treat CLAUDE.md catalogs and `.claude/**/*.md` as shared.

**First real wave run: width 2 once, speed unmeasurable** [M, this repo, 2026-10-04; one run]. `2026-10-02-be104839` (B-MEGA), `max_parallel_tickets: 2`: 23 tickets, 22 waves, widths 1×21 + 2×1 (`pickle waves:` lines; `field-timing.py` agrees).
- **Reliability.** 22/23 members integrated; 1/23 was picked with no attributable commit (`unmapped`); its zero-progress wave fell back to serial, which finished it (44 min). 0 conflicts, 0 halts; `wave_member_failed_then_serial_done` 0 (counts `parallel_safe` members only).
- **Why width stayed 1.** The deployed `planTicketWave`, replayed over the declared files, reproduces all 22 widths. Of 22 adjacent pairs, 19 overlap (11 only via the global markers `.claude/**`, `CLAUDE.md`), 2 lack `parallel_safe` (absent on 14/23), 1 eligible. All-safe ceiling: 21 waves (1.10×), as the §3 greedy method.
- **Speed.** Pickle 636.0 min, **27.7 min/ticket** (5 large, 13 medium, 5 small); worker spawns 184.9 min (29%); implementation sub-phase 189.8 min. Serial: E2 bar <27, field 20–27, `2026-10-03-2868b847` 8.3 (19 tickets, none large); the gap is tier mix or unit overhead (HYPOTHESIS).
- **Read-out.** Reliability held. Composing by shared surface (CLAUDE.md rule) packs exactly the tickets waves cannot split.

**How many concurrent units? Evidence on the knee** (primary sources, 2026-09-26):
- **CooperBench (Khatua et al., 2026-01-19)** [M]. Concurrent agents in one repo succeed ~30% less than one; 46 tasks: 68.6% → 46.5% → 30.0% from 2 to 4 agents, *coupled* work.
- **Cursor (2026-01-14)** [Mv]. Under locks "twenty agents would slow down to the effective throughput of two or three"; an integrator "created more bottlenecks than it solved".
- **Claim Plane (Nikolaev, 2026-08-02)** [M, single author]. 30 CooperBench pairs: pre-write admission lifted success 23.3% → 50.0% but serialized 96.7% of executions.
- **Passes Alone, Fails Together (Xia, Wu & Park, 2026-09-21)** [M]. Two agents, 417 real Django PR pairs: 1 interference in 834 runs; 97% on tasks sharing helpers.
- **Destefanis & Aste** [M]: messaging grows "close to quadratically". **Kim et al.** [M]: +80.8% (decomposable) to −70.0% (sequential). **AgenticFlict** [M]: 27.67% of simulated agent-PR merges conflict; **Xu et al.** [M]: 19.8% intra- vs 41.7% cross-agent on 747 co-active PR pairs.
- **Anthropic research system (2025-06-13)** [Mv; eval unpublished]. Opus 4 lead + Sonnet 4 subagents "outperformed single-agent Claude Opus 4 by 90.2%" at "about 15× more tokens than chats"; token usage "explains 80% of the variance" on BrowseComp; "most coding tasks involve fewer truly parallelizable tasks than research".
- **Read-out for lanes.** Every measured 2→3 curve on *coupled* work declines; CAID's second benchmark peaked at 2. None measures **cherry-picked review lanes**. **Start at 2; go to 3 only on the soak's own conflict and dropped-lane rate** (below).

**Cherry-pick integration: 0 conflicts, 0 dropped lanes, small n** [M, this repo, 2026-10-04]. All `archive/lanes.json` (11 on disk, 09-27 → 10-03) plus `anatomy lanes:` log lines, plus `2026-09-26-23989a13`/`-bcd24b6d` (16 lanes, 34 commits; pruned since, carried from the 10-02 census): 13 sessions, cap 2.
- **Outcomes, 60 lane runs:** integrated 60; conflict, integration_red, integration_ff_failed, non_convergent, cancelled 0 (logs agree; no kept branch).
- **Committed vs integrated:** 18/60 lanes committed (59 commits), 18/18 integrated; 59/59 commits have a `git patch-id` equivalent on a non-lane branch (the 25 on disk re-checked). Dropped-lane rate **0/18** (exact one-sided 95% upper bound 15%).
- **Contested picks** (onto a tree an earlier pick moved; 6 sessions): 0/9 conflicts (upper bound 28%). Not disjoint by construction: 30/114 file touches fell outside the lane directory (mirrors, catalogs); three `bcd24b6d` lanes edited one CLAUDE.md.
- **`integration_check`** exists only after B-LANES-UNCHECKED/B-ATTRIB-L (6 sessions, 29 lanes, from `2026-10-01-face240c`): green 10 (every committing lane), null 19 (no commits), unavailable 0. The 31 earlier lanes lack it: **a measurement gap, not 31 greens**; their `commits` may omit unintegrated work (moot: all integrated).
- **Wall-clock** (last lane end → `verdict`): 3.4–11.3 s over 9 picking sessions (median 6.2 s, 7 on disk); 0.4 s without picks (4); ≤0.81% of the lanes span. **Negligible at N=2; bounds of 15% / 28% do not yet license N=3.**

**The anatomy-park stall is the C-compiler stall.** `discoverSubsystems` (`extension/src/bin/pipeline-runner.ts:471`) makes all of `extension/` one lane on `main`.

**Review-size literature** (primary sources re-read 2026-09-24):
- **Kumar et al. (2026-04-09): confounded.** The <10-line bin (n=92) is all synthetic, the >50-line bins (n=34, 14) all real; F1 0.847 vs 0.066; one model. **Not used.**
- **SWR-Bench (Zeng et al., 2025-09-01; FSE 2026): clean.** Recall 38.35% (N=1 issue, 266 PRs) → **8.88% (N≥5, 22 PRs)**, precision flat [M]: ~0.4–0.5 finds per PR at every N; our accumulated diffs are the many-issue case.
- **Sense and Sensitivity (Štorek et al., v5 2026-07-10; ACL 2026): mechanism.** Across 10 LLMs, semantic code recall drops a median 92.73% mid-context [M; not review].
- **Implication.** Direction supported twice; magnitude does not transfer. If finds per pass are fixed, **passes-to-clean scale with defect count, not partition size**; finer partitions save only wall-clock, via concurrency.

**Strength.** Moderate-to-strong for "partition first, keep N small"; weak for recall gains from finer units (E3, E3b).

### #5 Move 4: worktree-as-proposal

- **Evidence.** Strong design convergence [D]. CAID's **manager-owned merge** ≈ #5's accept/reject gate; the C compiler uses git's push conflict *as the lock* [Mv].
- **What nobody claims.** No source measures isolation reducing defects versus trunk commits plus scope fences; the benefit is structural (rejection is free). Costs are measured: CAID slower, dearer; Claim Plane serialized nearly everything [M].
- **Strength.** Design consensus plus cost data; "it deletes our five enforcement mechanisms" is a hypothesis.

### #5 Move 5: state from git

- **Evidence.** Durable systems keep **one** authoritative record and derive the rest [D]; none duplicates git in a 47-field blob.
- **Relevance.** The smallest Move 5 derives current ticket from trailers + frontmatter; E4 measures it.

### #5 Moves 1–2: persistent knowledge

- **Evidence.** Self-built memory: 11/12 pairings failed to beat none [M]; verified experience +1.1 to +4.5 [M]; subtask-level memory +4.7 [M, single paper]. Vendors load **small curated files every session** (`AGENTS.md`, CLAUDE.md, playbooks) [D].
- **Implication.** Move 2 (a committed trap-door file, 20–40 lines per directory) is the supported version; judge Move 1 (tree-hash cache) on orientation time.

### The ~300-minute review toll

- **Separate reviewers work** (Anthropic harness design, Cognition, MAST) [Mv/M]; ours review an accumulated subsystem diff in serial loops.
- **Two supported cuts:** concurrent smaller units at small N; per-unit stop conditions (MAST).

**Does each worker phase earn its time? The review phases are nearly free** [M, this repo, 2026-09-26]. 65 tickets, 10 sessions (09-19 → 09-25). Phase = gap between consecutive artifact *birth* times from the first `worker_session_*.log`; intervals spanning a respawn dropped (12 tickets). "Changed" = review artifacts read by hand plus sources edited after review.

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

**Limits.** Write time is not thinking time: in 25–33/65 tickets a review landed ≤2 s after its subject (combined spans: Research Review + Plan + Plan Review median 0.38 min; Code Review + Simplify 0.14 min). Change counts are lower bounds.

**Finding.** The "~3 min per phase" premise fails: the four review/simplify phases cost <1 min of 6.7; Research and Implement/Conformance are ~75%. Research Review and Plan Review rarely change anything (0/65, 1/65): merge candidates for fewer states (HYPOTHESIS). Spec Conformance, Code Review and Simplify change something in 8%, 12%, ≥29% of tickets at near-zero cost. On `2026-09-21-7ba3aec1` 17 worker spawns sum to 262 of the pickle phase's 524 min; the rest is manager, gates, relaunches.

## 4. Experiments (measurement only)

**E3. Offline review-recall probe — run 2026-09-24: INCONCLUSIVE, instrument saturated** [M, this repo; reproduction in `prds/research/e3/E3-results.md`].
- **Design.** B-INVENTED diff `f36ea11e..3ae1d57a` (7,083 lines), anatomy-park Phase-1 prompt, `claude-opus-5-5`, 20 single-line mutations. Arms: (a) whole diff, k=20; (b) four directory partitions; (c) whole, k=5; 3 repeats. **Bar:** (b)/(a) recall ≥1.5× at ≤1.25× false positives.
- **Result.** Recall (a) 0.80, (b) 0.90, (c) 1.00, zero false positives; b/a = 1.125×, below the bar. One pass found 14–19/20: too easy.
- **The one signal: tests.** Whole-diff passes reported nothing in `extension/tests` in 2 of 3 repeats (4/15 hits); the tests partition recovered 12/15: tests as their own lane (B-LANES constraint 2).

**E3b. Real reverted defects — run 2026-09-26: INCONCLUSIVE, instrument at its floor** [M, this repo; `prds/research/e3b/E3b-results.md`].
- **Design.** 12 real single-file fixes reversed into bundle `12ffe132..1ad3f505` (14,812 lines). E3's prompt, model, bar; (b) = the beta's `resolve-scope` lanes. 16 calls, 0 refusals; k=0 control silent.
- **Recall 0.00 in all 9 arm-repeats**; each pass emitted 1–3 *other* findings.
- **Read-out.** Saturation inverted to a floor; a no-tools single pass cannot separate unit size from defect count.

**E1. Finer anatomy-park partition.** Roster one level deeper on a findings-heavy bundle vs B-INVENTED (34 passes / 995 min, one lane). **Success:** largest lane ≤ 50% of baseline passes, wall-clock −25% or better, findings fixed not lower. **Falsified if** Σ passes ≈ 34+ with no wall-clock drop. The soak runs this at 2 lanes.

**E2. `--teams` — blocked** under the `-p` manager. If unblocked: < 27 min/ticket, zero interventions, `--max-parallel` ≤ 3.

**E4. Derive current ticket from git.** From `git log` trailers plus frontmatter status, vs `state.json.current_ticket` per iteration. **Success:** ≥ 95% agreement, each disagreement a known drift bug. **Falsified if** git lacks needed state (name the minimum log to keep).

## 5. Sources (date = publication date, or access date for living docs)

- Claude Code docs, "Orchestrate teams of Claude Code sessions" — https://code.claude.com/docs/en/agent-teams (accessed 2026-09-24)
- Anthropic, "Building a C compiler with a team of parallel Claudes" — https://www.anthropic.com/engineering/building-c-compiler (2026-02-05)
- Anthropic, "Effective harnesses for long-running agents" — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (2025-11-26)
- Anthropic, "Harness design for long-running application development" — https://www.anthropic.com/engineering/harness-design-long-running-apps (2026-03-24)
- Anthropic, "How we built our multi-agent research system" — https://www.anthropic.com/engineering/multi-agent-research-system (2025-06-13; read from the primary page 2026-09-26)
- Geng & Neubig, CAID — https://arxiv.org/abs/2603.21489 (v2 2026-07)
- Khatua et al., "CooperBench" — https://arxiv.org/abs/2601.13295 (2026-01-19; scaling figures from the HTML full text, read 2026-09-26)
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
- Cognition, "Don't Build Multi-Agents" — https://cognition.com/blog/dont-build-multi-agents (2025-06); "Multi-Agents: What's Actually Working" — https://cognition.com/blog/multi-agents-working (2026-04-22); "Devin's 2025 Performance Review" — https://cognition.com/blog/devin-annual-performance-review-2025 (2025-11)
- OpenHands Software Agent SDK — https://arxiv.org/abs/2511.03690 (2025-11; rev. 2026-04; MLSys 2026)
- mini-SWE-agent README — https://github.com/SWE-agent/mini-swe-agent (accessed 2026-09-24)
- Xia et al., "Agentless" — https://arxiv.org/abs/2407.01489 (2024-07; FSE 2025)
- Aider, "Separating code reasoning and editing" — https://aider.chat/2024/09/26/architect.html (2024-09-26)
- Factory, "Code Droid: A Technical Report" — https://factory.com/news/code-droid-technical-report (2024; undated)
- OpenAI, "Introducing Codex" — https://openai.com/index/introducing-codex/ (2025-05); Codex cloud docs — https://developers.openai.com/codex/cloud (accessed 2026-09-24)
- GitHub, "Meet the new coding agent" — https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/ (2025-05); cloud agent docs — https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent (accessed 2026-09-24)
- Cursor worktrees docs — https://cursor.com/docs/configuration/worktrees (accessed 2026-09-24)
- Microsoft Research, "Magentic-One" — https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ (2024-11-04)
- Hong et al., "MetaGPT" — https://arxiv.org/abs/2308.00352 (ICLR 2024)
- LangGraph interrupts/persistence docs — https://docs.langchain.com/oss/python/langgraph/interrupts (accessed 2026-09-24)
- OpenAI Agents SDK, "Agent orchestration" — https://openai.github.io/openai-agents-python/multi_agent/ (accessed 2026-09-24)

Figures checked against primary text.

## 6. Open research gaps

- **Gap 1.** **Not covered:** CrewAI, Sweep, AutoGen beyond Magentic-One; SWE-agent's ACI numbers unverified.
- **Gap 3.** **(Narrowed 2026-10-04.) The knee is multi-study; our own units barely measured.** CAID, CooperBench, Cursor: 2–4 for *coupled writers*; the soak measures review lanes (Gap 7); one build-wave run reached width 2 in 1/22 waves (1/23 serial fallback). Open: build-wave speed, which needs disjoint declared files.
- **Gap 4.** **(Narrowed 2026-09-26.) Review-unit size vs defect count.** No study varies diff size at a fixed real-defect count. Probes bracket it: planted mutations saturate (E3, 14–19/20), real reverted defects floor (E3b, 0/12). Open: a tool-using, multi-pass reviewer on real defects.
- **Gap 5.** **Single-study [M]:** subtask memory (+4.7), VibeMemBench 11/12, MetaGPT (older models), Sun et al. (confounded), Claim Plane (30 pairs), CooperBench 2/3/4 (46 tasks).
- **Gap 6.** **(Narrowed 2026-09-26.) Unmeasured repo claims.** Measured: declared lists vs diffs, per-phase cost. Open: the non-worker half of the pickle phase; whether a `-p` teams path survives `/resume` and hands-off runs.
- **Gap 7.** **(Narrowed 2026-10-04, not closed.) Cherry-pick integration cost.** 60 lane runs, 13 sessions: 0 conflicts, 0/18 committing lanes dropped, integration ≤11.3 s [M, this repo]. Open: small n (upper bounds 15%; 28% over 9 contested picks), one repo at N=2, no `integration_check` on 31 pre-10-01 lanes.

## Changelog

- 2026-09-24 — Added §6; `--teams` unrunnable under `-p`; wave speedup 2.0×; F1 replaced; E2 blocked. E3: saturated; whole-diff missed tests 2/3.
- 2026-09-26 — Gap 3 narrowed (seven sources): start at 2 lanes; E2 cap 3; gap 7 added. Gap 2 closed: research-system figures [Mv]. Gap 6 narrowed: declared lists over 27 tickets (1.5–2× holds); per-phase cost over 65 tickets (review/simplify <1 min of 6.7). E3b: recall 0.00 on 12 real defects; Gap 4 narrowed.
- 2026-10-02 — Gap 7 narrowed: 39 lane runs / 9 sessions, 0 conflicts, 0/11 dropped, integration 3.4–11.2 s; pre-10-01 rows lack `integration_check`. Added Xu et al.
- 2026-10-04 — Gap 7: 60 lane runs / 13 sessions, 0 conflicts, 0/18 dropped (≤15%). Gap 3 narrowed: first wave run width 2 in 1/22 waves (declared files overlap), 27.7 min/ticket.
