# Research spike: how other agent systems decompose, parallelise, persist and verify

Date: 2026-09-24 · Scope: ~75 min desk research · Informs: GitHub #43 (`--teams` / review partitioning), GitHub #5 (persistent knowledge, worktree-as-proposal, state-from-git)

**Evidence labels used throughout:** **[M]** measured in a paper or independent benchmark · **[Mv]** measured by the vendor on its own system (not independently reproduced) · **[C]** claim without published method · **[D]** design description only (tells us what they built, not whether it worked).

## 1. Summary

1. **Parallel writers pay off only when the work splits cleanly and a strong verifier exists, and the best worker count is small.** The only controlled study found (CAID, Geng & Neubig, 2026) gains +6 to +15 points with isolated git worktrees and a merging manager. Gains peak at **4 workers on one benchmark and 2 on the other; 8 workers did worse than 4** [M]. Anthropic's 16-agent C compiler ran into a hard limit when the work became one monolithic task: "every agent would hit the same bug, fix that bug, and then overwrite each other's changes". The fix was to **re-partition the work** (GCC as an oracle to split the kernel into independent pieces), not to add agents [Mv]. That is our anatomy-park case: 34 passes on one `extension` lane. **The evidence favours partition granularity over worker count.**
2. **LLM review quality falls off steeply as the review unit grows.** One 2026 study measured F1 dropping from **0.657 on diffs under 10 lines to 0.043 on diffs over 150 lines** [M, single study, 150 samples]. Cognition reports that reviewers given a *clean* context find more bugs than ones given shared history [Mv]. If this transfers, finer review partitions would improve speed *and* per-pass recall. That is a hypothesis we can test cheaply (Experiment 3).
3. **Worktree-as-proposal is where the industry has converged, but no study shows it beats alternatives.** Codex cloud, the Copilot coding agent, Cursor parallel agents, Claude Code `isolation: worktree`, CAID and the C-compiler harness all give each writer its own checkout and integrate through a branch or PR, with a merge step that can reject it [D]. CAID is the only one with numbers. It also reports that sequential integration and test gating **raised** cost and runtime even though agents ran in parallel [M].
4. **Nobody derives state from git alone. The common pattern is git plus one small append-only log.** Examples: Anthropic's long-running harness (git + `claude-progress.txt` + `feature_list.json`), the C compiler (git + lock files committed to `current_tasks/`), OpenHands V1 (event-sourced log with deterministic replay) and LangGraph (a checkpoint per step, keyed by thread) [D; OpenHands reports "substantially" fewer system failures after moving to event sourcing but gives no number in the abstract, so this is Mv/C]. The shared principle is **one authoritative record, with everything else derived from it**, which bears directly on the dual current-ticket bug.
5. **Persistent memory is weaker evidence than it sounds.** VibeMemBench (Sep 2026) found that **11 of 12 solver × memory-system pairings failed to beat a memory-off baseline** when the system built and retrieved its own memory. *Directly injecting verified* history helped by +1.1 to +4.5 points [M]. That argues for #5's Move 2 (a small, curated, committed trap-door file) over automatically generated context caches. Move 1's content-addressed cache is untested anywhere I could find.

## 2. Comparison table

| System (source date) | Decomposition & assignment | Parallelism & conflicts | State & resume | Verification | Failure behaviour | Published measurement |
|---|---|---|---|---|---|---|
| **Claude Code agent teams** (docs, live 2026-09) | Lead creates a shared task list with dependencies. Teammates self-claim; **claims use file locks** | Parallel sessions. Docs: "two teammates editing the same file leads to overwrites"; assign file ownership. Optional per-agent worktree | Task list persists under `~/.claude/tasks/`. **In-process teammates are not restored on `/resume`**. Not available in `-p` mode | `TaskCompleted`/`TeammateIdle` hooks (exit 2 = keep working) | Documented: teammates "stop after encountering errors", task status "can lag", lead "may stop early" | None. Recommends 3–5 teammates, 5–6 tasks each [C] |
| **Anthropic C compiler** (2026-02-05) | Infinite `while true; claude -p` loop per container. Agent picks a task and writes a lock file to `current_tasks/` | 16 agents, each with its own clone. Pull/merge/push to a bare upstream; **git conflicts on the lock file stop double-claims**; Claude resolves merges | Git only (plus lock files and a progress doc) | Existing test suites, GCC as a reference oracle, CI. "The verifier must be nearly perfect" | Loop keeps running. Parallelism **collapsed** on a monolithic task until it was re-partitioned | ~2,000 sessions, 2 weeks, ~$20k; 100k-line compiler builds Linux 6.9 [Mv] |
| **Anthropic long-running harness** (2025-11-26) | Initializer writes `feature_list.json` (200+ items); coding agent does **one feature per session** | Single writer | Git + `claude-progress.txt` + feature JSON. Each session reads log and git, runs `init.sh`, smoke-tests first | End-to-end tests through the browser (Puppeteer) | Named failures: premature victory, one-shotting, leaving broken state | Qualitative only [D] |
| **Anthropic harness design** (2026-03-24) | Planner → generator → **separate evaluator**; early on, "sprint contracts" agreed before building | Single writer | Files/specs | Separate skeptical evaluator (Playwright). Self-evaluation "confidently prais[es]" mediocre work | Sprints **removed** once models improved | Solo run: 20 min / $9, broken result; harness: 6 h / $200, working result (n=1 anecdote) [Mv] |
| **CAID** (arXiv 2603.21489, v2 2026-07) | Manager builds a dependency DAG and splits by file (or by function) | **Each engineer gets its own worktree**. Manager merges to main; **the author of a conflicting commit resolves it** | Main branch is the single integrated state | Engineers run local tests before submitting; test-gated integration | Not a long-running system | Commit0-Lite, Sonnet 4.5: 53.1→59.1%; PaperBench: 57.2→63.3%. Peak at 4 / 2 engineers; **8 worse than 4**; higher cost and runtime [M] |
| **OpenAI Codex cloud** (2025-05; docs 2026) | One task per sandbox, human-assigned; `--attempts N` for best-of-N | One container per task; CLI uses worktrees; results come back as PRs/diffs | Repo + `AGENTS.md` | Runs the checks named in AGENTS.md; human reviews the PR | Task fails and a human retries | No public parallel study [C] |
| **GitHub Copilot coding agent** (2025-05; docs) | One issue → one agent → one draft PR | Isolated Actions VM; **can push only to branches it created** | Branch + PR; human review comments restart it | CI + human review | Human-gated | No public figures found |
| **Cursor 2.x parallel agents** (2025-10; docs) | Same prompt to up to 8 agents/models (`/best-of-n`), or separate tasks | One worktree per agent; human picks or merges | Worktrees | Human picks | Human-gated | None [C] |
| **Devin** (review 2025-11) | Human-written "playbooks" fanned out to a "fleet of Devins" | One VM per session | Knowledge/playbooks (details not published) | Human code review | Human-gated | PR merge rate 34%→67% year on year, "4x faster" [Mv] |
| **Cognition multi-agent guidance** (2025-06; 2026-04-22) | Manager → children, map-reduce | **"Writes stay single-threaded"**; parallel writer swarms "don't see meaningful adoption" | Context engineering | Clean-context reviewer loop, with a channel back to the coder to prevent looping and scope creep | — | Reviewer ~2 bugs/PR [Mv] |
| **OpenHands V1 SDK** (arXiv 2511.03690, 2025-11) | Single agent + subagent delegation; microagents inject knowledge | Sandboxed workspaces | **Event-sourced log with deterministic replay**; condenser, stuck detector | Benchmarks; security reviewer | Stuck detection | V1 "substantially reduces system-attributable failures" (no number in abstract) [Mv/C] |
| **mini-SWE-agent** (README, 2025–26) | None: a single linear loop | None | Linear message history; each command is an independent `subprocess.run` | Benchmark harness | — | >74% on SWE-bench Verified in ~100 lines [Mv] |
| **Agentless** (arXiv 2407.01489; FSE 2025) | Fixed pipeline: localize → repair → validate | Samples multiple candidate patches | None | Regression and reproduction tests select the patch | — | Beat the open agents of its time on SWE-bench Lite at $0.34–0.70/issue [M] |
| **Aider architect/editor** (2024-09-26) | Reasoning model plans, a second model edits | None | Repo + git commits | Benchmark tests | — | o1-preview alone 79.7% → with a separate editor 85.0%; Sonnet 77.4 → 80.5% [Mv] |
| **Factory Code Droid** (tech report, 2024) | Planner + subtasks; several trajectories | Parallel candidate trajectories, chosen using tests | Knowledge droid / "HyperCode" index | Tests (existing + generated), linters, self-critique | — | SWE-bench Lite pass@1 31.7% → pass@6 42.7% [Mv] |
| **Magentic-One** (2024-11-04) | Orchestrator keeps a task ledger (facts/plan) and a progress ledger | Sequential delegation | Ledgers held in context | Orchestrator self-reflection | **Stall counter > 2 triggers a replan** instead of a halt | "Statistically comparable to SOTA" on GAIA/AssistantBench [Mv] |
| **MetaGPT** (ICLR 2024) | Fixed SOP roles (PM → architect → engineer → QA) exchanging structured documents | Publish-subscribe, largely sequential | Documents | Runs the code and feeds errors back | — | Executable feedback added +4.2 pts HumanEval; human fixes 2.5 (ChatDev) → 0.83 [M, older models] |
| **LangGraph** (docs) | Graph nodes | Parallel branches within a step | **A checkpoint per step, keyed by `thread_id`**; resumes from the last successful node | User-defined | Interrupt → persist → resume | None [D] |
| **OpenAI Agents SDK** (docs) | Handoffs (control transfers) vs agents-as-tools (orchestrator keeps control) | — | Sessions | Guardrails | — | None [D] |

**Not covered, for lack of usable primary material in the time box:** CrewAI, Sweep, and AutoGen beyond Magentic-One. For SWE-agent I relied on mini-SWE-agent's README and did not re-verify the numbers in the original ACI paper.

**Cross-cutting [M] evidence on why multi-agent systems fail (MAST, arXiv 2503.13657, NeurIPS 2025).** Source: 1,600+ annotated traces from 7 frameworks. Failures split into system design 43.9%, inter-agent misalignment 32.4% and task verification 23.8%. The most common failure modes were step repetition (15.7%), reasoning–action mismatch (13.2%), **not knowing when to stop (12.4%)**, incorrect verification (9.1%) and missing or incomplete verification (8.2%). Targeted prompt and topology fixes gave +9.4 to +15.6 points on ChatDev but "not all failure modes are resolved".

## 3. Findings mapped to our questions

### #43: parallel build workers, or finer review partitioning?

**What the evidence suggests.** The two levers are not symmetric.

- **Parallel build workers.** Expect modest gains with a low ceiling. In CAID, the best parallel setting roughly matched our `--max-parallel` default only on the more decomposable benchmark (4). More workers made results *worse*, and integration cost ate part of the saving [M]. Cognition's position is that parallel *writers* remain the pattern that doesn't stick [Mv/C].
- **Our own numbers cap the build lever.** Issue #43 already measured this: on the worst bundle, perfect build parallelism takes 1277 min down to 1031 min (−19%).
- **The anatomy-park stall is structurally the C-compiler kernel stall.** One monolithic lane kept every pass serial. Anthropic's fix was to partition, not to add agents [Mv]. Our partitioner makes this likely to recur: `discoverSubsystems` (`extension/src/bin/pipeline-runner.ts:471`) names a subsystem after a top-level directory or workspace package. For this repo that means the entire `extension/` tree is one lane.
- **The diff-size result points the same way.** F1 0.657 → 0.043 [M, single study] suggests a smaller review unit could find the real defects in fewer passes, not just run in parallel. It could also cut the "step repetition" and "not knowing when to stop" failure modes MAST ranks first and third.

**Reliability risks specific to `--teams`.** These come from the vendor docs, so they are design facts, not measurements. Agent teams are **experimental** and **unavailable in `-p` mode**. **In-process teammates do not survive `/resume`**, task status "can lag" and block dependent tasks, and teammates "stop after encountering errors". Each of these is a halt or stall path in a system whose prime directive ranks completion first. Any `--teams` measurement run should count these events explicitly, not just record wall-clock time.

**Strength.** Moderate for "partition before parallelise": one controlled paper, one detailed vendor case study, one review-quality study, and our own dated phase table. Weak for any specific worker count on our workload.

### #5 Move 4: worktree-as-proposal

- **Evidence.** Strong convergence in design [D] across Codex, Copilot, Cursor, Claude Code, CAID and the C compiler. The only measured implementation (CAID) uses **manager-owned merges, with the conflicting author responsible for resolution**. That is close to #5's "accept or reject" gate. The C compiler shows a lighter-weight option: shared upstream, and git's own push conflict *as the lock*.
- **What nobody claims.** No source measures that worktree isolation reduces defects compared with trunk commits plus scope fences. The benefit is structural: rejecting a proposal costs nothing, and scope violations become "not merged".
- **The cost side is measured.** Sequential integration made CAID slower and more expensive than its parallel phase alone [M].
- **Strength.** Design consensus (strong) plus one measurement (moderate). Treat "it deletes our five enforcement mechanisms" as a hypothesis until a prototype shows it.

### #5 Move 5: state from git

- **Evidence.** Every durable system surveyed keeps **one** authoritative record and derives the rest: git + progress log (Anthropic), git + lock files (C compiler), an event log (OpenHands), per-step checkpoints (LangGraph) [D]. None of them keeps a 47-field mutable blob that duplicates information git also holds.
- **Relevance to the recent bug.** The two-sources-of-truth bug for "current ticket" is exactly what this pattern avoids. The smallest version of Move 5 is to make "current ticket" *derived* (from ticket-trailer commits plus frontmatter status) rather than *stored*.
- **Strength.** Design description only; OpenHands' failure-reduction claim has no published figure. Experiment 4 below measures it on our own corpus.

### #5 Moves 1–2: persistent knowledge

- **Evidence.** The strongest data is against automatically built memory: 11/12 pairings failed to beat no memory [M]. Curated, verified experience injected directly helped a little (+1.1 to +4.5 points) [M]. Subtask-level memory gave +4.7 points on SWE-bench Verified [M, single paper].
- **Vendor designs.** Vendors persist knowledge through **small human- or agent-curated files loaded every session** (`AGENTS.md`, CLAUDE.md, microagents, Devin playbooks) [D]. None of them persists automatically regenerated prose.
- **Implication.** Move 2 (a committed trap-door file of 20–40 lines per directory) is the version the evidence supports. Move 1 (a tree-hash-keyed archaeology cache) should be judged on whether it saves orientation time, since its quality benefit is unsupported.
- **Strength.** Moderate against automatic memory; weak for any specific format.

### The ~300-minute review toll

- **Separate reviewers work.** The strongest cross-source result is that a **separate** evaluator beats self-review (Anthropic harness design; Cognition's reviewer loop; MAST's finding that systems with explicit verifiers fail less) [Mv/M]. Our separate review phases are consistent with the field.
- **What we do differently is the review unit.** We review an accumulated whole-subsystem diff in serial convergence loops. The field reviews small units (one PR or task), with a feedback channel to the author.
- **Two supported ways to cut the toll without removing review.** (a) Smaller review units, so passes converge faster and can run concurrently. (b) Explicit stop conditions per unit, since MAST ranks not knowing when to stop third.
- **Harnesses have shrunk as models improved.** Anthropic dropped sprints; mini-SWE-agent and Agentless are competitive with far less machinery. That supports auditing whether every phase of the 8-phase per-ticket lifecycle still earns its ~3 min. This spike did not measure that.

## 4. Experiments (measurement only; no implementation in this spike)

**E1. Finer anatomy-park partition, run once.**
- **Change.** Point anatomy-park's subsystem roster one level deeper for this repo (e.g. `extension/src/bin`, `extension/src/services`, `extension/src/hooks`, `extension/tests`, …) on the next findings-heavy bundle. Rotation stays sequential.
- **Measure.** Passes-to-first-clean per lane and total anatomy-park wall-clock, against the B-INVENTED baseline (34 passes / 995 min on one lane).
- **Success.** The largest single lane needs ≤ 50% of the baseline pass count, and total phase wall-clock falls ≥ 25%, with total findings fixed not lower than a same-bundle-size baseline.
- **Falsified if** pass counts simply redistribute (Σ passes ≈ 34+) with no wall-clock drop. In that case partitioning helps only when combined with concurrency; test concurrency next.

**E2. The `--teams` measurement #43 already specifies, plus reliability counters.**
- **Run.** One bundle with `--teams --max-parallel 5`.
- **Record.** Pickle-phase minutes per ticket, **plus**: teammates that stopped early, stuck task statuses, manual interventions, same-file overlaps, and whether the run completed hands-off.
- **Success.** Under 27 min/ticket (issue #43's falsifier) **and** zero manual interventions.
- **Also report** the max-parallel level at which overlaps appear. CAID suggests the knee is at 2–4.

**E3. Offline review-recall probe for the diff-size effect (cheapest; run before E1).**
- **Setup.** Take a past bundle's accumulated `extension/` diff and inject k=20 known mutations with the existing mutation tooling.
- **Arms.** Run the anatomy-park review prompt once over (a) the whole-subsystem diff and (b) the same diff split into four directory partitions.
- **Measure.** Mutation recall and false positives per arm, 3 repeats each.
- **Success.** Arm (b) recall ≥ 1.5× arm (a) at a false-positive rate no worse than 1.25×.
- **Falsified if** recall is flat. That would mean the 0.657→0.043 result does not transfer to our reviewer, and E1 should be judged on wall-clock alone.

**E4. Derive current ticket from git and replay it against the recorded value.**
- **Setup.** Over all surviving session directories, compute "current ticket" from `git log` ticket trailers plus ticket frontmatter status, using a read-only script outside the runtime.
- **Measure.** Compare with `state.json.current_ticket` at each recorded iteration and classify every disagreement.
- **Success (for pursuing the derived-state direction).** ≥ 95% agreement, **and** every disagreement traces to a known state-drift bug rather than to information git cannot hold.
- **Falsified if** there are disagreements where git genuinely lacks the needed state (e.g. in-flight tickets with no commit yet). That would list the minimum log we must keep beside git.

## 5. Sources (date = publication date, or access date for living docs)

- Claude Code docs, "Orchestrate teams of Claude Code sessions" — https://code.claude.com/docs/en/agent-teams (accessed 2026-09-24)
- Anthropic, "Building a C compiler with a team of parallel Claudes" — https://www.anthropic.com/engineering/building-c-compiler (2026-02-05)
- Anthropic, "Effective harnesses for long-running agents" — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (2025-11-26)
- Anthropic, "Harness design for long-running application development" — https://www.anthropic.com/engineering/harness-design-long-running-apps (2026-03-24)
- Anthropic, "How we built our multi-agent research system" — https://www.anthropic.com/engineering/multi-agent-research-system (2025-06; figures quoted via secondary summaries and not re-read from the primary source: +90.2% over single-agent on internal research eval, ~15× tokens, token usage explains ~80% of variance. Research task, not coding.)
- Geng & Neubig, "Effective Strategies for Asynchronous Software Engineering Agents" (CAID) — https://arxiv.org/abs/2603.21489 (v2 2026-07)
- Cemri et al., "Why Do Multi-Agent LLM Systems Fail?" (MAST) — https://arxiv.org/abs/2503.13657 (v3 2025-10; NeurIPS 2025)
- "Bigger Isn't Always Better: A Comparative Evaluation of LLMs for Automated Code Review" — https://arxiv.org/abs/2606.15689 (2026-04)
- VibeMemBench — https://arxiv.org/abs/2609.23570 (2026-09-20)
- "Structurally Aligned Subtask-Level Memory for Software Engineering Agents" — https://arxiv.org/abs/2602.21611 (2026-02)
- Cognition, "Don't Build Multi-Agents" — https://cognition.com/blog/dont-build-multi-agents (2025-06)
- Cognition, "Multi-Agents: What's Actually Working" — https://cognition.com/blog/multi-agents-working (2026-04-22)
- Cognition, "Devin's 2025 Performance Review" — https://cognition.com/blog/devin-annual-performance-review-2025 (2025-11)
- OpenHands Software Agent SDK — https://arxiv.org/abs/2511.03690 (2025-11; rev. 2026-04; MLSys 2026)
- mini-SWE-agent README — https://github.com/SWE-agent/mini-swe-agent (accessed 2026-09-24)
- Xia et al., "Agentless" — https://arxiv.org/abs/2407.01489 (2024-07; FSE 2025)
- Aider, "Separating code reasoning and editing" — https://aider.chat/2024/09/26/architect.html (2024-09-26)
- Factory, "Code Droid: A Technical Report" — https://factory.com/news/code-droid-technical-report (2024; page undated)
- OpenAI, "Introducing Codex" — https://openai.com/index/introducing-codex/ (2025-05) and Codex cloud docs — https://developers.openai.com/codex/cloud (accessed 2026-09-24)
- GitHub, "Meet the new coding agent" — https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/ (2025-05) and cloud agent docs — https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent (accessed 2026-09-24)
- Cursor worktrees docs — https://cursor.com/docs/configuration/worktrees (accessed 2026-09-24)
- Microsoft Research, "Magentic-One" — https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ (2024-11-04)
- Hong et al., "MetaGPT" — https://arxiv.org/abs/2308.00352 (ICLR 2024)
- LangGraph interrupts/persistence docs — https://docs.langchain.com/oss/python/langgraph/interrupts (accessed 2026-09-24)
- OpenAI Agents SDK, "Agent orchestration" — https://openai.github.io/openai-agents-python/multi_agent/ (accessed 2026-09-24)

**Caveats.** Several [M] results come from a single study, often on older models. Vendor numbers ([Mv]) have no published method. Pages were read through a summarising fetch tool; exact figures quoted above were each checked against the primary page's text, except the Anthropic research-system figures noted in the sources list.
