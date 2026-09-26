# Research spike: how other agent systems decompose, parallelise, persist and verify

Date: 2026-09-24 · Scope: ~75 min desk research + refinement ticks · Informs: GitHub #43 (`--teams` / review partitioning), GitHub #5 (persistent knowledge, worktree-as-proposal, state-from-git)

**Evidence labels:** **[M]** measured in a paper or independent benchmark · **[M, this repo]** measured here, command given · **[Mv]** measured by the vendor on its own system · **[C]** claim without published method · **[D]** design description only.

## 1. Summary

1. **Parallel writers pay off only when work splits cleanly and a strong verifier exists, and the best worker count is small.** CAID (2026) gains +6 to +15 points with isolated worktrees and a merging manager, peaking at **4 workers on one benchmark and 2 on the other; 8 did worse than 4** [M]. Independent data agree: CooperBench success falls **68.6% → 46.5% → 30.0% from 2 to 3 to 4 agents** [M]; Cursor's 20 lock-coordinated agents ran at "the effective throughput of two or three" [Mv]. Anthropic's 16-agent C compiler stalled on a monolithic task and recovered by **re-partitioning**, not adding agents [Mv] — our anatomy-park case (34 passes on one `extension` lane).
2. **Our bundles cap build parallelism at ~2×, and `--teams` cannot run under the runner** [M, this repo]. File-disjoint waves give a median best-case speedup of 2.0× (1.33–3.0×, no wave wider than 4); agent-team tools are absent under the `claude -p` manager (§3).
3. **Review recall falls as the unit grows, but the published magnitude is untrustworthy.** The quoted F1 0.657 → 0.043 is **confounded** (small diffs all synthetic, large all real). SWR-Bench (FSE 2026) finds per-PR recall falling **38% → 9% as real issues per PR rise from 1 to ≥5, precision flat** [M]: a roughly constant number of finds per pass.
4. **Worktree-as-proposal is the industry convergence, unproven against alternatives.** Codex cloud, Copilot, Cursor, Claude Code `isolation: worktree`, CAID and the C compiler give each writer its own checkout and a rejectable merge [D]. Integration costs are measured both ways: CAID's test-gated merge **raised** cost and runtime [M]; Cursor removed its integrator as a bottleneck [Mv]; disjoint real work rarely interferes (1 in 834 runs) [M].
5. **Nobody derives state from git alone; the pattern is git plus one small append-only log** (Anthropic's harness, the C compiler's lock files, OpenHands' event log, LangGraph checkpoints) [D]. **One authoritative record, the rest derived** bears on the dual current-ticket bug.
6. **Persistent memory is weaker evidence than it sounds.** VibeMemBench: **11 of 12 solver × memory pairings failed to beat memory-off** with self-built memory; *injecting verified* history helped +1.1 to +4.5 points [M]. That favours #5's Move 2 (a curated trap-door file) over generated caches.

## 2. Comparison table

| System (source date) | Decomposition & assignment | Parallelism & conflicts | State & resume | Verification | Failure behaviour | Published measurement |
|---|---|---|---|---|---|---|
| **Claude Code agent teams** (docs, live 2026-09) | Lead's shared task list with dependencies; teammates self-claim via **file locks** | Parallel sessions; "two teammates editing the same file leads to overwrites". Optional worktree | `~/.claude/tasks/`. **In-process teammates not restored on `/resume`**; **team tools absent in `-p`** ([M, this repo]) | `TaskCompleted`/`TeammateIdle` hooks | Teammates "stop after encountering errors"; status "can lag"; lead "may stop early" | None. Recommends 3–5 teammates [C] |
| **Anthropic C compiler** (2026-02-05) | `while true; claude -p` per container; lock file in `current_tasks/` | 16 agents, own clones, push to bare upstream; **lock-file git conflicts stop double-claims** | Git (+ lock files, progress doc) | Tests, GCC oracle, CI. "The verifier must be nearly perfect" | Parallelism **collapsed** on a monolithic task until re-partitioned | ~2,000 sessions, ~$20k; 100k-line compiler builds Linux 6.9 [Mv] |
| **Anthropic long-running harness** (2025-11-26) | `feature_list.json` (200+ items); **one feature per session** | Single writer | Git + `claude-progress.txt` + feature JSON | Browser tests (Puppeteer) | Premature victory, one-shotting, broken state | Qualitative [D] |
| **Anthropic harness design** (2026-03-24) | Planner → generator → **separate evaluator** | Single writer | Files/specs | Skeptical evaluator; self-evaluation "confidently prais[es]" mediocre work | Sprints **removed** as models improved | Solo 20 min/$9 broken; harness 6 h/$200 working (n=1) [Mv] |
| **CAID** (arXiv 2603.21489, v2 2026-07) | Manager's dependency DAG, split by file/function | **Worktree per engineer**; manager merges; **conflicting author resolves** | Main branch | Local tests; test-gated integration | — | Commit0-Lite 53.1→59.1%; PaperBench 57.2→63.3%. Peak 4 / 2; **8 worse than 4**; higher cost and runtime [M] |
| **CooperBench** (arXiv 2601.13295, 2026-01-19) | Each agent implements one feature in a shared repo, with messaging | Same codebase, concurrent | — | Joint feature tests | Expectation 42%, commitment 32%, communication 26% | Coop ~30% below solo; **2 → 3 → 4 agents: 68.6 → 46.5 → 30.0%** (46 tasks) [M] |
| **Cursor long-running agents** (2026-01-14) | Recursive planners create tasks; workers execute | Hundreds of agents; locks failed, **optimistic concurrency** kept; integrator removed | Repo | Workers resolve own conflicts | Locks held too long or never released | 20 locked agents ≈ 2–3 [Mv]; 1M-line browser in a week [Mv] |
| **OpenAI Codex cloud** (2025-05; docs 2026) | One task per sandbox; `--attempts N` | Container per task; CLI worktrees; PRs | Repo + `AGENTS.md` | AGENTS.md checks; human review | Human retries | None public [C] |
| **GitHub Copilot coding agent** (2025-05; docs) | One issue → one draft PR | Actions VM; **pushes only to its own branches** | Branch + PR | CI + human review | Human-gated | None found |
| **Cursor 2.x parallel agents** (2025-10; docs) | Up to 8 agents (`/best-of-n`) or separate tasks | Worktree per agent; human merges | Worktrees | Human picks | Human-gated | None [C] |
| **Devin** (review 2025-11) | Playbooks fanned out to a "fleet of Devins" | VM per session | Knowledge/playbooks | Human review | Human-gated | Merge rate 34%→67% YoY, "4x faster" [Mv] |
| **Cognition guidance** (2025-06; 2026-04-22) | Manager → children, map-reduce | **"Writes stay single-threaded"**; writer swarms "don't see meaningful adoption" | Context engineering | Clean-context reviewer with channel to coder | — | Reviewer ~2 bugs/PR [Mv] |
| **OpenHands V1 SDK** (arXiv 2511.03690, 2025-11) | Agent + subagents; microagents | Sandboxed workspaces | **Event-sourced log, deterministic replay**; stuck detector | Benchmarks; security reviewer | Stuck detection | "Substantially reduces system-attributable failures" [Mv/C] |
| **mini-SWE-agent** (README, 2025–26) | One linear loop | None | Linear history; independent `subprocess.run` | Benchmark | — | >74% SWE-bench Verified in ~100 lines [Mv] |
| **Agentless** (arXiv 2407.01489; FSE 2025) | Localize → repair → validate | Candidate patches | None | Regression + reproduction tests | — | Beat open agents on SWE-bench Lite at $0.34–0.70/issue [M] |
| **Aider architect/editor** (2024-09-26) | Planner model + editor model | None | Git commits | Benchmark tests | — | o1-preview 79.7→85.0%; Sonnet 77.4→80.5% [Mv] |
| **Factory Code Droid** (2024) | Planner + subtasks; trajectories | Candidates chosen by tests | "HyperCode" index | Tests, linters, self-critique | — | SWE-bench Lite pass@1 31.7% → pass@6 42.7% [Mv] |
| **Magentic-One** (2024-11-04) | Orchestrator task/progress ledgers | Sequential delegation | Ledgers in context | Self-reflection | **Stall counter > 2 → replan**, not halt | "Statistically comparable to SOTA" on GAIA/AssistantBench [Mv] |
| **MetaGPT** (ICLR 2024) | SOP roles, structured documents | Largely sequential | Documents | Runs code, feeds errors back | — | +4.2 pts HumanEval; human fixes 2.5 → 0.83 [M, older models] |
| **LangGraph** (docs) | Graph nodes | Parallel branches per step | **Checkpoint per step by `thread_id`** | User-defined | Interrupt → persist → resume | None [D] |
| **OpenAI Agents SDK** (docs) | Handoffs vs agents-as-tools | — | Sessions | Guardrails | — | None [D] |

**Why multi-agent systems fail (MAST, NeurIPS 2025) [M].** 1,600+ traces: system design 43.9%, inter-agent misalignment 32.4%, task verification 23.8%. Top modes: step repetition (15.7%), reasoning–action mismatch (13.2%), **not knowing when to stop (12.4%)**, incorrect verification (9.1%), missing verification (8.2%). Targeted fixes gave +9.4 to +15.6 points on ChatDev.

## 3. Findings mapped to our questions

### #43: parallel build workers, or finer review partitioning?

**Status (2026-09-26).** Deployed `v2.2.0-beta.1` runs soak bundles with `anatomy_max_parallel_lanes: 2` (deployed `pipeline-runner.js:124`, default 1; verified by grepping the deployed `package.json` and runner). Results land in the "2.2 beta soak ledger" in `prds/MASTER_PLAN.md`, empty at this writing.

**`--teams` is neither parallel nor runnable under the runner as built** [M, this repo, 2026-09-24].
- *Runnable.* The manager runs in print mode (`extension/src/services/backend-spawn.ts`, `args.push('-p', opts.prompt)`). From `/tmp`, Claude Code 2.1.281: `claude -p "reply ok" --output-format stream-json --verbose --max-turns 1 | head -1`, reading the init line's `tools`. **`TeamCreate`, `TeamDelete`, `TaskCreate`, `TaskUpdate`, `TaskList` and `Agent` are absent; `Task` and `SendMessage` present**, also with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. The Teams Mode prompt calls tools that do not exist in that mode.
- *Parallel.* `extension/templates/_pickle-manager-prompt.md:173`: "`state.max_parallel` is plumbed for a follow-up … today, treat as 1".
- **Consequence.** E2 needs an interactive manager or a `-p`-compatible teams path.

**Build parallelism in our bundles is small** [M, this repo, 2026-09-24]. For each session under `~/.local/share/pickle-rick/sessions` (13; 12 with tickets), I parsed backticked paths in each non-hardening ticket's "**Files to modify/create**:" block and assigned tickets in `order` greedily to waves (a ticket follows any earlier ticket sharing a file; no file list conflicts with everything). Speedup = tickets ÷ waves.

| Session | Impl tickets | Waves | Best-case speedup | Widest wave |
|---|---|---|---|---|
| 2026-09-17-3c7489fc | 5 | 3 | 1.67 | 3 |
| 2026-09-17-5f3aa6b4 | 4 | 3 | 1.33 | 2 |
| 2026-09-17-df5973be | 3 | 1 | 3.00 | 3 |
| 2026-09-19-4dbaed57 | 3 | 2 | 1.50 | 2 |
| 2026-09-21-7ba3aec1 | 6 | 3 | 2.00 | 4 |
| 2026-09-22-723eafe4 | 3 | 1 | 3.00 | 3 |
| 2026-09-22-a88001dd | 2 | 1 | 2.00 | 2 |

Median 2.0×, pooled 26 / 14 = **1.86×** (single-ticket and hardening-only sessions excluded). A whole-field parse gives 1.25, 1.00, 3.00, 1.50, 1.50, 3.00, 2.00; a `completion_commit` cross-check gives 2.5, 1.33, 1.5, 3.0, 3.0, 3.0, 2.0. **Every method bounds build parallelism at ≤3×, median ~1.5–2×.** Hardening stays serial, and the build share caps the gain at 1277 → 1031 min (−19%) on #43's worst bundle.

**Do declared lists predict diffs? Yes, conservatively** [M, this repo, 2026-09-26]. The 16 current sessions (the three 09-17 wave-table sessions no longer exist): 36 non-hardening tickets, 1 skipped (no commit), 27 of the rest declaring paths (8 lack a usable field). Declared = backticked file paths in the whole "Files to modify/create" field; actual = `git show --name-only --format=` over `completion_commit` plus `git log --all --grep=<id>` commits with the id in the *subject*, minus compiled mirrors and session artifacts.

| Measure (27 tickets) | Value |
|---|---|
| Actual files that were declared (recall), median / pooled | 1.00 / 0.85; 19 tickets complete |
| Declared files touched (precision), median / pooled | 0.80 / 0.73; 16 tickets over-declare (38 files) |
| Undeclared touches, by kind | 18 in 8 tickets: tests 8, command/agent prompts 8, CLAUDE.md catalogs 2, compiled 0, source 0 |
| Undeclared touch in another same-session ticket's declared set | 1 (a CLAUDE.md catalog) |
| Same-wave ticket pairs whose actual diffs overlap | 0 of 11 |

Matching message *bodies* too keeps the medians but raises hidden collisions to 8 and same-wave overlaps to 3, every extra from another ticket's commit or a PRD edit merely *mentioning* the id. **Implication:** lists over-declare more than they under-declare, so the wave table errs toward serializing; its 1.5–2× is not inflated by hidden collisions, though on 11 same-wave pairs. A file-disjoint scheduler should still treat CLAUDE.md catalogs and `.claude/**/*.md` as shared.

**How many concurrent units? Independent evidence on the knee** (primary sources read 2026-09-26):
- **CooperBench (Khatua et al., 2026-01-19)** [M]. Agents building features concurrently in one repo, with messaging, succeed ~30% less than one agent doing both; on 46 tasks, "68.6% with 2 agents to 46.5% with 3 agents and further to 30.0% with 4 agents". The failures are coordination failures, i.e. costs of *coupled* work.
- **Cursor (2026-01-14)** [Mv]. "Twenty agents would slow down to the effective throughput of two or three" under locks; optimistic concurrency replaced them, and "an integrator role for quality control created more bottlenecks than it solved".
- **Claim Plane (Nikolaev, 2026-08-02)** [M, single author]. On 30 CooperBench pairs × 3 seeds, pre-write admission lifted pair success 23.3% → 50.0% and integration success to 96.7%, but serialized 96.7% of executions: reliability bought with the wall-clock gain.
- **Passes Alone, Fails Together (Xia, Wu & Park, 2026-09-21)** [M]. Two agents on 417 real Django PR pairs: 1 interference in 834 runs; on constructed tasks sharing helpers, 97%; a message describing the concurrent change recovered 82%.
- **Destefanis & Aste (2026-08-17)** [M]: messaging grows "close to quadratically" with agent count over 1,902 runs. **Kim et al. (v3 2026-04-08)** [M]: gains from +80.8% (decomposable) to −70.0% (sequential planning). **AgenticFlict (v2 2026-05-12)** [M]: 27.67% of 107K simulated agent-PR merges conflict — a base rate, not a slope in N.
- **Read-out for lanes.** Every measured 2→3 curve on *coupled* work declines; CAID's second benchmark peaked at 2. None measures **file-disjoint, non-messaging review lanes with cherry-pick integration**; the closest (1/834 on disjoint real PRs) says our N is bounded by cherry-pick collisions and rate limits, not coordination. **2 lanes is the defensible start; go to 3 only on the soak's own conflict and dropped-lane rate.**

**The anatomy-park stall is the C-compiler stall.** `discoverSubsystems` (`extension/src/bin/pipeline-runner.ts:471`) makes each top-level directory one subsystem, so all of `extension/` is one lane on `main`. Anthropic re-partitioned [Mv].

**Review-size literature** (primary sources re-read 2026-09-24):
- **Kumar et al. (2026-04-09): confounded.** Synthetic diffs "median 5 lines, max 40"; real PRs 20–500 lines (median 117). The <10-line bin (n=92) is all synthetic, the >50-line bins (n=34, 14) all real; F1 0.847 synthetic vs 0.066 real; one model (Haiku 4.5); the 10–50 bin (n=10) was *best*. **Not used as evidence** [M, confounded].
- **SWR-Bench (Zeng et al., 2025-09-01; FSE 2026): clean.** Gemini-2.5-Pro PR-Review by ground-truth issue count N: recall 38.35% (N=1, 266 PRs) → 24.46 → 16.07 → 11.76 → **8.88% (N≥5, 22 PRs)**, precision flat at 29.6–44.1% [M]. My arithmetic: ~0.4–0.5 finds per PR at every N. Our accumulated diffs are the many-issue case.
- **Sense and Sensitivity (Štorek et al., v5 2026-07-10; ACL 2026): mechanism.** Across 10 LLMs, semantic recall of code drops a median 92.73% as the snippet moves to the middle of a long context; lexical recall does not [M; understanding, not review].
- **Sun et al. (2025-08): weak.** Hunk-level AI comments addressed 43.9% vs 13.9% file-level; "addressed" is not recall [M, confounded].
- **Implication.** Direction supported twice; magnitude does not transfer. If finds per pass are fixed, **passes-to-clean scale with defect count, not partition size**; finer partitions save wall-clock only through concurrency, which the soak measures.

**Strength.** Moderate-to-strong for "partition first, keep N small"; weak for recall gains from finer units. `--teams` adds vendor-documented halt/stall paths (lost on `/resume`, lagging status, teammates stopping on errors).

### #5 Move 4: worktree-as-proposal

- **Evidence.** Strong design convergence [D]. CAID's **manager-owned merge, conflicting author resolves** is close to #5's accept/reject gate. The C compiler uses git's push conflict *as the lock*; Cursor found optimistic concurrency more robust than locks [Mv].
- **What nobody claims.** No source measures isolation reducing defects versus trunk commits plus scope fences; the benefit is structural (rejection is free). Costs are measured: sequential integration made CAID slower and dearer [M]; conflict-preventing admission serialized nearly everything (Claim Plane) [M].
- **Strength.** Design consensus plus cost measurements. "It deletes our five enforcement mechanisms" is a hypothesis until prototyped.

### #5 Move 5: state from git

- **Evidence.** Every durable system surveyed keeps **one** authoritative record and derives the rest [D]; none keeps a 47-field mutable blob duplicating git.
- **Relevance.** The smallest Move 5 derives current ticket from trailer commits + frontmatter status, removing the two-sources-of-truth bug. E4 measures it.

### #5 Moves 1–2: persistent knowledge

- **Evidence.** Self-built memory: 11/12 pairings failed to beat none [M]; curated, verified experience +1.1 to +4.5 [M]; subtask-level memory +4.7 [M, single paper]. Vendors use **small curated files loaded every session** (`AGENTS.md`, CLAUDE.md, playbooks) [D].
- **Implication.** Move 2 (a committed trap-door file, 20–40 lines per directory) is the supported version; judge Move 1 (tree-hash-keyed cache) on orientation time only.

### The ~300-minute review toll

- **Separate reviewers work** (Anthropic harness design, Cognition, MAST) [Mv/M]; our separate phases match the field.
- **Our unit differs.** We review an accumulated subsystem diff in serial loops; the field reviews one PR with a channel to the author. SWR-Bench's fixed finds-per-pass predicts our long tails.
- **Two supported cuts:** concurrent smaller units at small N; explicit per-unit stop conditions (MAST).
- **Harnesses shrank as models improved** (Anthropic dropped sprints; mini-SWE-agent, Agentless).

## 4. Experiments (measurement only)

**E3. Offline review-recall probe — run 2026-09-24: INCONCLUSIVE, instrument saturated** [M, this repo; reproduction in `prds/research/e3/E3-results.md`].
- **Design.** B-INVENTED diff `f36ea11e..3ae1d57a` (`extension/src` + `extension/tests`, 7,083 diff lines), the real anatomy-park Phase-1 prompt, `claude-opus-5-5`, 20 single-line mutations. Arms: (a) whole diff, k=20; (b) four directory partitions, k=20 total; (c) whole diff, k=5; 3 repeats each; 18 calls, 0 refusals. **Bar:** (b)/(a) recall ≥1.5× at ≤1.25× false positives → unit size matters; (c) ≫ (a) with flat finds-per-pass → SWR-Bench shape.
- **Recall.** (a) 0.80 (0.70 / 0.95 / 0.75); (b) 0.90 (×3); (c) 1.00 (×3). Zero false positives.
- **Read-out.** b/a = 1.125×, below the bar. Finds-per-pass tracked k (16 at k=20, 5 at k=5). One pass found 14–19 of 20: too easy for either hypothesis to bind.
- **The one signal: tests.** The whole-diff pass reported nothing in `extension/tests` in 2 of 3 repeats (4/15 hits); its partition recovered them (12/15). Source files did slightly worse partitioned. This supports tests as their own lane (B-LANES constraint 2), not the broader recall claim.
- **E3b.** Revert real historical fixes instead of planting mutations: the no-mutation control surfaced findings no mutated run reported, so planted defects crowd out real ones.

**E1. Finer anatomy-park partition.** Roster one level deeper (`extension/src/bin`, `…/services`, `…/hooks`, `extension/tests`, …) on a findings-heavy bundle, against B-INVENTED (34 passes / 995 min, one lane). **Success:** largest lane ≤ 50% of baseline passes, wall-clock −25% or better, findings fixed not lower. **Falsified if** Σ passes ≈ 34+ with no wall-clock drop. The `v2.2.0-beta.1` soak now runs this with 2 concurrent lanes.

**E2. `--teams` — blocked** under the `-p` manager. If unblocked: < 27 min/ticket **and** zero interventions, `--max-parallel` capped at 3.

**E4. Derive current ticket from git and replay it.** Over all sessions, compute it from `git log` trailers plus frontmatter status (read-only) and compare with `state.json.current_ticket` per iteration. **Success:** ≥ 95% agreement, every disagreement traced to a known drift bug. **Falsified if** git lacks needed state (e.g. in-flight tickets with no commit); that names the minimum log to keep.

## 5. Sources (date = publication date, or access date for living docs)

- Claude Code docs, "Orchestrate teams of Claude Code sessions" — https://code.claude.com/docs/en/agent-teams (accessed 2026-09-24)
- Anthropic, "Building a C compiler with a team of parallel Claudes" — https://www.anthropic.com/engineering/building-c-compiler (2026-02-05)
- Anthropic, "Effective harnesses for long-running agents" — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (2025-11-26)
- Anthropic, "Harness design for long-running application development" — https://www.anthropic.com/engineering/harness-design-long-running-apps (2026-03-24)
- Anthropic, "How we built our multi-agent research system" — https://www.anthropic.com/engineering/multi-agent-research-system (2025-06; not re-read, see §6)
- Geng & Neubig, CAID — https://arxiv.org/abs/2603.21489 (v2 2026-07)
- Khatua et al., "CooperBench" — https://arxiv.org/abs/2601.13295 (2026-01-19; scaling figures from the HTML full text, read 2026-09-26)
- Cursor, "Scaling long-running autonomous coding" — https://cursor.com/blog/scaling-agents (2026-01-14)
- Nikolaev, "Claim Plane: Reliability Gains and the Limits of Selective Concurrency for Parallel Coding Agents" — https://arxiv.org/abs/2608.00947 (2026-08-02)
- Xia, Wu & Park, "Passes Alone, Fails Together" — https://arxiv.org/abs/2609.25396 (2026-09-21)
- Destefanis & Aste, "When Agents Coordinate" — https://arxiv.org/abs/2608.16801 (2026-08-17)
- Kim et al., "Towards a Science of Scaling Agent Systems" — https://arxiv.org/abs/2512.08296 (2025-12-09; v3 2026-04-08)
- Ogenrwot & Businge, "AgenticFlict" — https://arxiv.org/abs/2604.03551 (2026-04-04; v2 2026-05-12)
- Cemri et al., MAST — https://arxiv.org/abs/2503.13657 (v3 2025-10; NeurIPS 2025)
- Kumar, Bararia & Raj, "Bigger Isn't Always Better" — https://arxiv.org/abs/2606.15689 (2026-04-09; §3, §4.5 re-read 2026-09-24)
- Zeng et al., "SWR-Bench" — https://arxiv.org/abs/2509.01494 (2025-09-01; FSE 2026; Table 5 read 2026-09-24)
- Štorek et al., "Sense and Sensitivity" — https://arxiv.org/abs/2505.13353 (v5 2026-07-10; ACL 2026)
- Sun et al., "Does AI Code Review Lead to Code Changes?" — https://arxiv.org/abs/2508.18771 (2025-08)
- VibeMemBench — https://arxiv.org/abs/2609.23570 (2026-09-20)
- "Structurally Aligned Subtask-Level Memory for Software Engineering Agents" — https://arxiv.org/abs/2602.21611 (2026-02)
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

Exact figures were checked against primary text except the Anthropic research-system figures (§6).

## 6. Open research gaps

1. **Systems not covered:** CrewAI, Sweep, AutoGen beyond Magentic-One; SWE-agent's ACI-paper numbers not re-verified.
2. **Anthropic research-system figures are second-hand** (+90.2% over single-agent, ~15× tokens, tokens explain ~80% of variance); research, not coding; unused in any conclusion.
3. **(Narrowed 2026-09-26.) The worker-count knee is no longer single-study, but no study measures review lanes.** CAID, CooperBench and Cursor put the knee at 2–4 for *coupled writers*. None measures file-disjoint, non-communicating review lanes integrated by cherry-pick; only the beta soak can.
4. **Review-unit size vs defect count is unseparated.** No study varies diff size at a fixed real-defect count on real code. SWR-Bench varies count; Kumar et al. confound size with synthetic-vs-real; E3 saturated; E3b is next.
5. **Single-study [M] results:** subtask-level memory (+4.7), VibeMemBench's 11/12, MetaGPT on older models, Sun et al. (confounded), Claim Plane (single author, 30 pairs), CooperBench's 2/3/4 curve (46 tasks).
6. **Unmeasured repo claims:** whether each lifecycle phase earns its ~3 min; whether a `-p`-compatible teams path would survive `/resume` and hands-off runs. *(Narrowed 2026-09-26: declared lists vs diffs is measured in #43; open only at larger n.)*
7. **(New.) Cherry-pick integration cost.** No source reports a conflict or dropped-lane rate for concurrent review lanes; the soak ledger's "lane outcomes" column is the first measurement.

## Changelog

- 2026-09-24 — Added §6. Measured here: agent-team tools absent under `claude -p` and the Teams block sequential (`--teams` neither parallel nor runnable); build-wave speedup median 2.0× / pooled 1.86× over 7 bundles. Withdrew the confounded 0.657→0.043 figure for SWR-Bench and Sense and Sensitivity. E3 redesigned; E2 blocked.
- 2026-09-24 — E3 run: inconclusive (saturated); b/a 1.125×; whole-diff review missed test files in 2/3 repeats, partitioning recovered them. E3b proposed.
- 2026-09-26 — Narrowed gap 3 (worker-count knee) with CooperBench (2→3→4 agents: 68.6→46.5→30.0%), Cursor (20 locked agents ≈ 2–3), Claim Plane, Passes Alone Fails Together (1/834 on disjoint real PRs), Destefanis & Aste, Kim et al., AgenticFlict. Conclusion: start at 2 lanes, move to 3 only on soak conflict data; E2 cap lowered to 3. Added the `v2.2.0-beta.1` soak note to #43 and gap 7; tightened prose to under 4,000 words.
- 2026-09-26 — Gap 6 narrowed: declared lists vs diffs over 27 tickets (recall 1.00 median, precision 0.80; 1 hidden collision; 0/11 same-wave overlaps); the wave table's 1.5–2× holds, conservatively.
