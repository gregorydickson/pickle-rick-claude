# Research spike: how other agent systems decompose, parallelise, persist and verify

Date: 2026-09-24 · Scope: ~75 min desk research + one refinement tick · Informs: GitHub #43 (`--teams` / review partitioning), GitHub #5 (persistent knowledge, worktree-as-proposal, state-from-git)

**Evidence labels:** **[M]** measured in a paper or independent benchmark · **[M, this repo]** measured here, command given · **[Mv]** measured by the vendor on its own system (not independently reproduced) · **[C]** claim without published method · **[D]** design description only (what they built, not whether it worked).

## 1. Summary

1. **Parallel writers pay off only when the work splits cleanly and a strong verifier exists, and the best worker count is small.** The only controlled study found (CAID, Geng & Neubig, 2026) gains +6 to +15 points with isolated git worktrees and a merging manager, peaking at **4 workers on one benchmark and 2 on the other; 8 did worse than 4** [M]. Anthropic's 16-agent C compiler stalled on a monolithic task ("every agent would hit the same bug, fix that bug, and then overwrite each other's changes") and recovered by **re-partitioning**, not by adding agents [Mv]. That is our anatomy-park case: 34 passes on one `extension` lane.
2. **Our own bundles cap build parallelism at ~2×, and `--teams` cannot run under the runner at all** [M, this repo]. Past bundles split into file-disjoint waves for a median best-case build speedup of 2.0× (range 1.33–3.0×, never more than 4 tickets in a wave). Separately, the manager is launched with `claude -p`, and the agent-team tools (`TeamCreate`, `TaskCreate`, `TaskUpdate`, `TaskList`, `Agent`) are absent from the tool list in `-p` mode, even with the experimental flag set. §3 has both measurements.
3. **Review recall falls as the review unit grows, but the published magnitude is not trustworthy.** The widely quoted F1 0.657 → 0.043 (diffs <10 vs >150 lines) is **confounded**: every small-diff sample was a synthetic mutation and every large-diff sample a real PR (§3). A cleaner benchmark (SWR-Bench, FSE 2026) finds per-PR recall falling **38% → 9% as the number of real issues in a PR rises from 1 to ≥5, with precision flat** [M]. That fits a reviewer that finds a roughly constant number of issues per pass. The direction supports smaller review units; the size of the effect on *our* reviewer is unknown, and E3 is the cheapest way to measure it.
4. **Worktree-as-proposal is where the industry has converged, but no study shows it beats alternatives.** Codex cloud, the Copilot coding agent, Cursor, Claude Code `isolation: worktree`, CAID and the C compiler all give each writer its own checkout and integrate through a rejectable merge [D]. CAID alone has numbers, and its sequential, test-gated integration **raised** cost and runtime [M].
5. **Nobody derives state from git alone; the pattern is git plus one small append-only log** — Anthropic's long-running harness (git + `claude-progress.txt` + `feature_list.json`), the C compiler (git + lock files), OpenHands V1 (event-sourced log with replay), LangGraph (a checkpoint per step) [D]. The shared principle, **one authoritative record with everything else derived**, bears directly on the dual current-ticket bug.
6. **Persistent memory is weaker evidence than it sounds.** VibeMemBench (Sep 2026): **11 of 12 solver × memory pairings failed to beat memory-off** when the system built its own memory; *directly injecting verified* history helped +1.1 to +4.5 points [M]. That favours #5's Move 2 (a small curated trap-door file) over generated context caches.

## 2. Comparison table

| System (source date) | Decomposition & assignment | Parallelism & conflicts | State & resume | Verification | Failure behaviour | Published measurement |
|---|---|---|---|---|---|---|
| **Claude Code agent teams** (docs, live 2026-09) | Lead creates a shared task list with dependencies. Teammates self-claim; **claims use file locks** | Parallel sessions. Docs: "two teammates editing the same file leads to overwrites"; assign file ownership. Optional per-agent worktree | Task list persists under `~/.claude/tasks/`. **In-process teammates are not restored on `/resume`**. **Team tools absent in `-p` mode** (docs; confirmed [M, this repo], §3) | `TaskCompleted`/`TeammateIdle` hooks (exit 2 = keep working) | Documented: teammates "stop after encountering errors", task status "can lag", lead "may stop early" | None. Recommends 3–5 teammates, 5–6 tasks each [C] |
| **Anthropic C compiler** (2026-02-05) | `while true; claude -p` loop per container; agent writes a lock file to `current_tasks/` | 16 agents, own clones, pull/merge/push to a bare upstream; **git conflicts on the lock file stop double-claims** | Git only (plus lock files and a progress doc) | Test suites, GCC as reference oracle, CI. "The verifier must be nearly perfect" | Loop keeps running. Parallelism **collapsed** on a monolithic task until re-partitioned | ~2,000 sessions, 2 weeks, ~$20k; 100k-line compiler builds Linux 6.9 [Mv] |
| **Anthropic long-running harness** (2025-11-26) | Initializer writes `feature_list.json` (200+ items); **one feature per session** | Single writer | Git + `claude-progress.txt` + feature JSON; each session smoke-tests first | End-to-end browser tests (Puppeteer) | Named failures: premature victory, one-shotting, leaving broken state | Qualitative only [D] |
| **Anthropic harness design** (2026-03-24) | Planner → generator → **separate evaluator**; early "sprint contracts" | Single writer | Files/specs | Separate skeptical evaluator (Playwright). Self-evaluation "confidently prais[es]" mediocre work | Sprints **removed** once models improved | Solo: 20 min / $9, broken; harness: 6 h / $200, working (n=1) [Mv] |
| **CAID** (arXiv 2603.21489, v2 2026-07) | Manager builds a dependency DAG, splits by file or function | **Worktree per engineer**. Manager merges; **the author of a conflicting commit resolves it** | Main branch is the single integrated state | Local tests before submit; test-gated integration | Not long-running | Commit0-Lite, Sonnet 4.5: 53.1→59.1%; PaperBench: 57.2→63.3%. Peak at 4 / 2 engineers; **8 worse than 4**; higher cost and runtime [M] |
| **OpenAI Codex cloud** (2025-05; docs 2026) | One task per sandbox; `--attempts N` best-of-N | Container per task; CLI uses worktrees; results return as PRs | Repo + `AGENTS.md` | Checks named in AGENTS.md; human PR review | Human retries | No public parallel study [C] |
| **GitHub Copilot coding agent** (2025-05; docs) | One issue → one agent → one draft PR | Isolated Actions VM; **pushes only to branches it created** | Branch + PR; review comments restart it | CI + human review | Human-gated | None found |
| **Cursor 2.x parallel agents** (2025-10; docs) | Same prompt to up to 8 agents (`/best-of-n`), or separate tasks | Worktree per agent; human picks or merges | Worktrees | Human picks | Human-gated | None [C] |
| **Devin** (review 2025-11) | Human-written playbooks fanned out to a "fleet of Devins" | VM per session | Knowledge/playbooks (unpublished) | Human code review | Human-gated | PR merge rate 34%→67% YoY, "4x faster" [Mv] |
| **Cognition multi-agent guidance** (2025-06; 2026-04-22) | Manager → children, map-reduce | **"Writes stay single-threaded"**; parallel writer swarms "don't see meaningful adoption" | Context engineering | Clean-context reviewer with a channel back to the coder | — | Reviewer ~2 bugs/PR [Mv] |
| **OpenHands V1 SDK** (arXiv 2511.03690, 2025-11) | Single agent + subagent delegation; microagents inject knowledge | Sandboxed workspaces | **Event-sourced log with deterministic replay**; condenser, stuck detector | Benchmarks; security reviewer | Stuck detection | "Substantially reduces system-attributable failures" (no number in abstract) [Mv/C] |
| **mini-SWE-agent** (README, 2025–26) | None: one linear loop | None | Linear history; each command an independent `subprocess.run` | Benchmark harness | — | >74% SWE-bench Verified in ~100 lines [Mv] |
| **Agentless** (arXiv 2407.01489; FSE 2025) | Fixed pipeline: localize → repair → validate | Samples several candidate patches | None | Regression + reproduction tests select the patch | — | Beat open agents of its time on SWE-bench Lite at $0.34–0.70/issue [M] |
| **Aider architect/editor** (2024-09-26) | Reasoning model plans, second model edits | None | Repo + git commits | Benchmark tests | — | o1-preview 79.7% → 85.0% with separate editor; Sonnet 77.4 → 80.5% [Mv] |
| **Factory Code Droid** (tech report, 2024) | Planner + subtasks; several trajectories | Parallel candidates chosen by tests | "HyperCode" index | Tests, linters, self-critique | — | SWE-bench Lite pass@1 31.7% → pass@6 42.7% [Mv] |
| **Magentic-One** (2024-11-04) | Orchestrator keeps task and progress ledgers | Sequential delegation | Ledgers in context | Orchestrator self-reflection | **Stall counter > 2 triggers a replan**, not a halt | "Statistically comparable to SOTA" on GAIA/AssistantBench [Mv] |
| **MetaGPT** (ICLR 2024) | Fixed SOP roles exchanging structured documents | Publish-subscribe, largely sequential | Documents | Runs code, feeds errors back | — | Executable feedback +4.2 pts HumanEval; human fixes 2.5 → 0.83 [M, older models] |
| **LangGraph** (docs) | Graph nodes | Parallel branches within a step | **Checkpoint per step, keyed by `thread_id`**; resumes from last good node | User-defined | Interrupt → persist → resume | None [D] |
| **OpenAI Agents SDK** (docs) | Handoffs vs agents-as-tools | — | Sessions | Guardrails | — | None [D] |

**Cross-cutting [M] evidence on why multi-agent systems fail (MAST, arXiv 2503.13657, NeurIPS 2025).** 1,600+ annotated traces from 7 frameworks: system design 43.9%, inter-agent misalignment 32.4%, task verification 23.8%. Top modes: step repetition (15.7%), reasoning–action mismatch (13.2%), **not knowing when to stop (12.4%)**, incorrect verification (9.1%), missing verification (8.2%). Targeted fixes gave +9.4 to +15.6 points on ChatDev but "not all failure modes are resolved".

## 3. Findings mapped to our questions

### #43: parallel build workers, or finer review partitioning?

**`--teams` is neither parallel nor runnable under the runner as built** [M, this repo, 2026-09-24].
- *Runnable.* The pipeline launches its manager in print mode (`extension/src/services/backend-spawn.ts`, `args.push('-p', opts.prompt)`, six call sites). Measured from `/tmp` with Claude Code 2.1.281: `claude -p "reply ok" --model claude-sonnet-5 --output-format stream-json --verbose --max-turns 1 2>/dev/null | head -1`, then read the init line's `tools` array. **`TeamCreate`, `TeamDelete`, `TaskCreate`, `TaskUpdate`, `TaskList` and `Agent` are absent; `Task` and `SendMessage` are present.** The same held with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. The tool count varied between runs (33, 25, 33); the 8-tool difference was entirely `claude.ai` connector MCP tools that had not yet attached at init. The built-in set was identical in every run. The Teams Mode block of the manager prompt calls `TeamCreate`, `TaskCreate` and `Agent`, none of which exist in that mode.
- *Parallel.* The same block is sequential by instruction: `extension/templates/_pickle-manager-prompt.md:173` reads "`state.max_parallel` is plumbed for a follow-up … today, treat as 1".
- **Consequence for #43.** E2 below cannot run as specified. Running it first requires either an interactive (non-`-p`) manager or a teams implementation built on tools that `-p` does expose.

**Build parallelism in our own bundles is small** [M, this repo, 2026-09-24]. For every session under `~/.local/share/pickle-rick/sessions` (13; 12 with tickets), I took the non-hardening tickets (titles not starting Harden/Audit/Wire), parsed the backticked paths in each "**Files to modify/create**:" block (continuation lines included), and assigned tickets in `order` greedily to waves. A ticket goes after any earlier ticket it shares a file with; a ticket with no file list conflicts with everything. Speedup = implementation tickets ÷ waves.

| Session | Impl tickets | Waves | Best-case speedup | Widest wave |
|---|---|---|---|---|
| 2026-09-17-3c7489fc | 5 | 3 | 1.67 | 3 |
| 2026-09-17-5f3aa6b4 | 4 | 3 | 1.33 | 2 |
| 2026-09-17-df5973be | 3 | 1 | 3.00 | 3 |
| 2026-09-19-4dbaed57 | 3 | 2 | 1.50 | 2 |
| 2026-09-21-7ba3aec1 | 6 | 3 | 2.00 | 4 |
| 2026-09-22-723eafe4 | 3 | 1 | 3.00 | 3 |
| 2026-09-22-a88001dd | 2 | 1 | 2.00 | 2 |

The five single-ticket sessions score 1.0 trivially, and one session had only hardening tickets. Across the seven multi-ticket bundles the median is 2.0× and the pooled figure is 26 tickets / 14 waves = **1.86×**. **This differs from the figures quoted in the brief** (1.0, 1.0, 3.0, 1.5, 1.5, 3.0, 2.0; three sessions differ), most likely because of how multi-line and prose file lists are parsed. A third parse (the whole `Files to modify/create` field up to the next bold label or heading, backticked paths only) gives 1.25, 1.00, 3.00, 1.50, 1.50, 3.00, 2.00. **All three methods bound build parallelism at ≤3× per bundle with a median of ~1.5–2×; the conclusion does not depend on which parse is right.** Reading only the first line of each block gives 1.25 for 3c7489fc, which still does not reproduce 1.0. A cross-check using each ticket's `completion_commit` file list gives 2.5, 1.33, 1.5, 3.0, 3.0, 3.0, 2.0. That source undercounts, because a ticket can span commits, but it lands in the same 1.3–3× band. Two caveats: declared file lists are plans, not diffs, and hardening tickets review the whole combined diff, so they stay serial. **Speedups apply only to the build share of a bundle.** Issue #43's own figure puts that ceiling at 1277 → 1031 min (−19%) on the worst bundle. No wave was wider than 4, which matches CAID's 2–4 knee.

**The anatomy-park stall is structurally the C-compiler kernel stall.** `discoverSubsystems` (`extension/src/bin/pipeline-runner.ts:471`) names a subsystem after a top-level directory or workspace package, so all of `extension/` is one lane. Anthropic's fix was to partition, not to add agents [Mv].

**What the review-size literature supports, and what it does not** (primary sources re-read 2026-09-24):
- **Kumar et al. (arXiv 2606.15689, 2026-04-09): confounded.** The paper's own text: synthetic diffs "median 5 lines, max 40"; real PRs were selected at 20–500 lines (median 117). So the <10-line bin (n=92) is all synthetic and the >50-line bins (n=34, n=14) are all real. The paper separately reports F1 0.847 synthetic vs 0.066 real. The bins are also from one model (Haiku 4.5), and the 10–50 bin (n=10) was the *best*. The 15× drop therefore cannot be attributed to diff size, and **this spike no longer uses it as evidence** [M, but confounded].
- **SWR-Bench (Zeng et al., arXiv 2509.01494, 2025-09-01; FSE 2026): a clean real-PR measurement.** PR-Review with Gemini-2.5-Pro, by number of ground-truth issues N: recall 38.35% (N=1, 266 PRs) → 24.46 → 16.07 → 11.76 → **8.88% (N≥5, 22 PRs)**, with precision flat at 29.6–44.1% [M]. My arithmetic on those figures: expected issues found per PR stays at about 0.4–0.5 across all N. A pass finds a roughly *fixed number* of issues, so recall falls as issues accumulate. Our accumulated bundle diffs are the many-issue case.
- **Štorek et al., "Sense and Sensitivity" (arXiv 2505.13353, v5 2026-07-10; ACL 2026): mechanism.** Across 10 LLMs, lexical recall is position-independent, but semantic recall of code drops by a median of 92.73% as the relevant snippet moves to the middle of a long context [M; code understanding, not review].
- **Sun et al. (arXiv 2508.18771, 2025-08): weak field signal.** Across 178 repositories, comments from hunk-level AI review actions were addressed in 43.9% of cases vs 13.9% for file-level ones. Tool and model differ between the groups (gpt-4 vs gpt-4o-mini), and "addressed" measures usefulness, not recall [M, confounded].
- **Implication.** The direction ("a big accumulated diff gets low per-pass recall") has two independent supports. The magnitude does not transfer. SWR-Bench also points at a different lever: if each pass finds a roughly fixed number of issues, **passes-to-clean scale with defect count, not partition size**. Finer partitions would then cut wall-clock only through concurrency. That is E1's falsifier branch, so E3 must separate the two variables (below).

**Reliability risks of `--teams`** (vendor docs; design facts, not measurements): experimental; in-process teammates do not survive `/resume`; task status "can lag"; teammates "stop after encountering errors". Each is a halt or stall path in a system that ranks completion first.

**Strength.** Moderate for "partition before parallelise" (CAID, the C compiler, SWR-Bench, our wave table). Weak for any specific worker count or recall gain on our workload.

### #5 Move 4: worktree-as-proposal

- **Evidence.** Strong design convergence [D]. The only measured implementation (CAID) uses **manager-owned merges, with the conflicting author resolving the conflict**, which is close to #5's accept/reject gate. The C compiler shows a lighter option: git's own push conflict *as the lock*.
- **What nobody claims.** No source measures that worktree isolation reduces defects compared with trunk commits plus scope fences. The benefit is structural: rejecting a proposal costs nothing, and a scope violation becomes "not merged". The cost side is measured: sequential integration made CAID slower and dearer [M].
- **Strength.** Design consensus plus one measurement. "It deletes our five enforcement mechanisms" remains a hypothesis until a prototype shows it.

### #5 Move 5: state from git

- **Evidence.** Every durable system surveyed keeps **one** authoritative record and derives the rest [D]. None keeps a 47-field mutable blob that duplicates what git holds.
- **Relevance.** The two-sources-of-truth "current ticket" bug is exactly what this pattern avoids. The smallest version of Move 5 is to make current ticket *derived* (ticket-trailer commits + frontmatter status) rather than *stored*.
- **Strength.** Design description only; E4 measures it on our corpus.

### #5 Moves 1–2: persistent knowledge

- **Evidence.** Automatically built memory: 11/12 pairings failed to beat no memory [M]. Curated, verified experience helped +1.1 to +4.5 points [M]. Subtask-level memory gave +4.7 on SWE-bench Verified [M, single paper]. Vendors persist knowledge through **small curated files loaded every session** (`AGENTS.md`, CLAUDE.md, microagents, playbooks) [D].
- **Implication.** Move 2 (a committed trap-door file, 20–40 lines per directory) is the supported version. Judge Move 1 (tree-hash-keyed archaeology cache) on orientation time saved only; its quality benefit is unsupported.

### The ~300-minute review toll

- **Separate reviewers work.** A **separate** evaluator beats self-review (Anthropic harness design, Cognition, MAST) [Mv/M]. Our separate review phases match the field.
- **What we do differently is the unit.** We review an accumulated whole-subsystem diff in serial loops; the field reviews one PR or task, with a channel back to the author. SWR-Bench's fixed-finds-per-pass shape predicts exactly our long convergence tails.
- **Two supported ways to cut the toll.** (a) Smaller units run concurrently. (b) Explicit per-unit stop conditions (MAST ranks not knowing when to stop third).
- **Harnesses have shrunk as models improved** (Anthropic dropped sprints; mini-SWE-agent and Agentless compete with little machinery). Whether each phase of the 8-phase lifecycle earns its ~3 min is unmeasured.

## 4. Experiments (measurement only; no implementation in this spike)

**E3 result (run 2026-09-24): INCONCLUSIVE, instrument saturated** [M, this repo; details and reproduction in `prds/research/e3/E3-results.md`].
- **Setup.** B-INVENTED diff `f36ea11e..3ae1d57a` (`extension/src` + `extension/tests`, 7,083 diff lines); the real anatomy-park Phase-1 prompt; `claude-opus-5-5`; 20 hand-written single-line mutations; 3 repeats per arm; 18 calls, 0 refusals.
- **Recall.** (a) whole diff: 0.80 (0.70 / 0.95 / 0.75). (b) four partitions: 0.90 (0.90 ×3). (c) whole diff at k=5: 1.00 (×3). Zero false positives in every call.
- **Read-out.** b/a = 1.125×, below the 1.5× bar. Found-per-pass tracked k (16 at k=20, 5 at k=5), not the flat SWR-Bench shape. A single pass found 14–19 of 20, so the planted defects were too easy for either hypothesis to bind.
- **The one signal: tests.** The whole-diff pass reported nothing in `extension/tests` in 2 of 3 repeats (4/15 hits), while its own partition recovered them (12/15). On source files, partitioning did slightly worse. This supports keeping tests as their own reviewed lane (B-LANES constraint 2), not the broader recall claim.
- **Next probe (E3b).** Re-introduce REAL past defects by reverting historical fix commits, not synthetic mutations. The no-mutation control call surfaced findings that no mutated run reported, so planted defects crowd out real ones and the zero-false-positive count says nothing about precision.

**E3. Offline review-recall probe (cheapest; run first).**
- **Setup.** Take a past bundle's accumulated `extension/` diff and inject known mutations with the existing mutation tooling.
- **Arms.** (a) whole diff, k=20; (b) the same diff split into four directory partitions, k=20 in total; (c) whole diff, k=5. Three repeats each, using the anatomy-park review prompt.
- **Measure.** Recall, false positives, and absolute mutations found per pass.
- **Read-out.** If (b) > (a) on recall by ≥1.5× at ≤1.25× the false positives, unit size matters: go to E1. If instead (c)'s recall ≫ (a)'s while found-per-pass stays flat across arms, the SWR-Bench shape holds: defect count drives passes, and partitioning pays only through concurrency.

**E1. Finer anatomy-park partition, run once.** Point the subsystem roster one level deeper (`extension/src/bin`, `…/services`, `…/hooks`, `extension/tests`, …) on the next findings-heavy bundle, rotating sequentially. Measure passes-to-first-clean per lane and phase wall-clock against B-INVENTED (34 passes / 995 min, one lane). **Success:** the largest lane needs ≤ 50% of the baseline passes and wall-clock falls ≥ 25%, with findings fixed not lower. **Falsified if** Σ passes ≈ 34+ with no wall-clock drop; then test concurrency.

**E2. The `--teams` measurement #43 specifies — blocked.** It cannot run under the `-p` manager (§3). If it is unblocked, record pickle-phase min/ticket plus early-stopped teammates, stuck statuses, manual interventions and same-file overlaps. **Success:** < 27 min/ticket **and** zero interventions. Given the wave table, cap `--max-parallel` at 3–4.

**E4. Derive current ticket from git and replay it.** Over all surviving sessions, compute current ticket from `git log` trailers plus frontmatter status (read-only script, outside the runtime) and compare with `state.json.current_ticket` at each recorded iteration. **Success:** ≥ 95% agreement, with every disagreement traced to a known drift bug. **Falsified if** git genuinely lacks needed state (e.g. in-flight tickets with no commit); that lists the minimum log to keep.

## 5. Sources (date = publication date, or access date for living docs)

- Claude Code docs, "Orchestrate teams of Claude Code sessions" — https://code.claude.com/docs/en/agent-teams (accessed 2026-09-24)
- Anthropic, "Building a C compiler with a team of parallel Claudes" — https://www.anthropic.com/engineering/building-c-compiler (2026-02-05)
- Anthropic, "Effective harnesses for long-running agents" — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (2025-11-26)
- Anthropic, "Harness design for long-running application development" — https://www.anthropic.com/engineering/harness-design-long-running-apps (2026-03-24)
- Anthropic, "How we built our multi-agent research system" — https://www.anthropic.com/engineering/multi-agent-research-system (2025-06; figures not re-read from primary, see §6)
- Geng & Neubig, CAID — https://arxiv.org/abs/2603.21489 (v2 2026-07)
- Cemri et al., MAST — https://arxiv.org/abs/2503.13657 (v3 2025-10; NeurIPS 2025)
- Kumar, Bararia & Raj, "Bigger Isn't Always Better: A Comparative Evaluation of LLMs for Automated Code Review" — https://arxiv.org/abs/2606.15689 (2026-04-09; §4.5 and §3 re-read 2026-09-24)
- Zeng et al., "SWR-Bench: Assessing LLM Performance in Real-World Code Review Comment Generation" — https://arxiv.org/abs/2509.01494 (2025-09-01; FSE 2026; Table 5 read 2026-09-24)
- Štorek et al., "Sense and Sensitivity: Examining the Influence of Semantic Recall on Long Context Code Understanding" — https://arxiv.org/abs/2505.13353 (v5 2026-07-10; ACL 2026)
- Sun et al., "Does AI Code Review Lead to Code Changes? A Case Study of GitHub Actions" — https://arxiv.org/abs/2508.18771 (2025-08)
- VibeMemBench — https://arxiv.org/abs/2609.23570 (2026-09-20)
- "Structurally Aligned Subtask-Level Memory for Software Engineering Agents" — https://arxiv.org/abs/2602.21611 (2026-02)
- Cognition, "Don't Build Multi-Agents" — https://cognition.com/blog/dont-build-multi-agents (2025-06); "Multi-Agents: What's Actually Working" — https://cognition.com/blog/multi-agents-working (2026-04-22); "Devin's 2025 Performance Review" — https://cognition.com/blog/devin-annual-performance-review-2025 (2025-11)
- OpenHands Software Agent SDK — https://arxiv.org/abs/2511.03690 (2025-11; rev. 2026-04; MLSys 2026)
- mini-SWE-agent README — https://github.com/SWE-agent/mini-swe-agent (accessed 2026-09-24)
- Xia et al., "Agentless" — https://arxiv.org/abs/2407.01489 (2024-07; FSE 2025)
- Aider, "Separating code reasoning and editing" — https://aider.chat/2024/09/26/architect.html (2024-09-26)
- Factory, "Code Droid: A Technical Report" — https://factory.com/news/code-droid-technical-report (2024; undated page)
- OpenAI, "Introducing Codex" — https://openai.com/index/introducing-codex/ (2025-05); Codex cloud docs — https://developers.openai.com/codex/cloud (accessed 2026-09-24)
- GitHub, "Meet the new coding agent" — https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/ (2025-05); cloud agent docs — https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent (accessed 2026-09-24)
- Cursor worktrees docs — https://cursor.com/docs/configuration/worktrees (accessed 2026-09-24)
- Microsoft Research, "Magentic-One" — https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ (2024-11-04)
- Hong et al., "MetaGPT" — https://arxiv.org/abs/2308.00352 (ICLR 2024)
- LangGraph interrupts/persistence docs — https://docs.langchain.com/oss/python/langgraph/interrupts (accessed 2026-09-24)
- OpenAI Agents SDK, "Agent orchestration" — https://openai.github.io/openai-agents-python/multi_agent/ (accessed 2026-09-24)

Pages were read through a summarising fetch tool. Every exact figure was checked against the primary page's text, except the Anthropic research-system figures (§6).

## 6. Open research gaps

1. **Systems not covered:** CrewAI, Sweep, AutoGen beyond Magentic-One. SWE-agent's ACI-paper numbers were not re-verified (mini-SWE-agent's README was used instead).
2. **Anthropic multi-agent research-system figures are second-hand:** +90.2% over single-agent, ~15× tokens, token usage explains ~80% of variance. These came from secondary summaries, and the task is research, not coding. They are not used in any conclusion above.
3. **CAID's worker-count knee (4 / 2) is a single study** on two benchmarks with one model family. Our wave table agrees in range, but only on declared file lists.
4. **Review-unit size vs defect count is unseparated.** No study found varies diff size while holding the number of real defects fixed, on real code. SWR-Bench varies count; Kumar et al. confound size with synthetic-vs-real. E3 arm (c) is designed to separate them.
5. **Single-study [M] results still standing:** subtask-level memory (+4.7), VibeMemBench's 11/12, MetaGPT on older models, Sun et al.'s hunk-level addressing rate (tool and model confounded).
6. **Unmeasured claims about this repo:** whether each lifecycle phase earns its ~3 min; whether declared file lists match actual ticket diffs (the `completion_commit` cross-check is partial); whether a non-`-p` or `-p`-compatible teams path would survive `/resume` and hands-off runs.

## Changelog

- 2026-09-24 — Added §6 from the report's caveats. Measured in this repo: agent-team tools absent under `claude -p` and the Teams block sequential, so `--teams` is neither parallel nor runnable as built; a best-case build-wave speedup of median 2.0× / pooled 1.86× over 7 bundles (differs from the brief's figures in 3 sessions). Closed the diff-size gap from primary sources: the 0.657→0.043 figure is confounded with synthetic vs real samples and is withdrawn as evidence; SWR-Bench (recall 38%→9% as issues per PR rise, precision flat) and Sense and Sensitivity replace it. E3 redesigned to separate unit size from defect count; E2 marked blocked.
- 2026-09-24 — E3 run: inconclusive (saturated); b/a recall 1.125×; whole-diff review skipped test files in 2/3 repeats, partitioning recovered them. E3b (reverted real fixes) proposed.
