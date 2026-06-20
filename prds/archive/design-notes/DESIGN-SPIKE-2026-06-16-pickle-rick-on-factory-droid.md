# Design Spike: Pickle Rick on a Factory.ai Droid

Date: 2026-06-16
Status: Spike (no commitment to build)
Author: agent-authored
Sources: factory.ai/product/droid-computers, docs.factory.ai/cli/getting-started/overview, plus the host-dependency surface scan of `extension/src/`.

---

## 1. TL;DR

The port **looks** shallow-to-medium (not a rebuild) **if** the load-bearing Factory claims hold — but those claims are **unverified, auth-gated assertions, not confirmed contracts**, so the spike's conclusion is conditional, not shippable as-is. A Factory **Droid Computer** is *asserted by marketing copy* to be a persistent, normal Linux/macOS host you get a terminal on (BYOM laptop / Mac Mini / cloud VM), not an ephemeral sandbox. **IF** that holds, Pickle Rick is a **lift-and-shift**: it already runs as an ordinary Node process tree, and the genuine `claude` CLI *could* be installed on the host as today's worker binary, preserving the full Claude Code hook/MCP contract. The single biggest blocker is the **hooks enforcement contract** (`config-protection.ts`, `tsc-gate.ts`, `--add-dir` containment), which is registered into `~/.claude/settings.json` and only honored when the worker IS the real `claude` CLI — so any architecture that swaps `claude -p` for `droid exec` silently drops every R-WSRC guard.

**Two premises load-bear Architecture B and are BOTH unverified (auth-gated):** (1) Computer persistence / absence of a hard idle/wall-clock cap below pipeline length [OQ-1], and (2) the genuine `claude` CLI installs AND honors the PreToolUse BLOCK contract on a Computer [OQ-4]. Until M0+M2+M3+M4 pass, the honest recommendation is **BYOM-only** (your own Mac Mini / VM removes premise 1's unknown entirely), with cloud-Computer B held behind verification. **Verdict: Architecture B is the architecturally sound target and honors subtract-before-add — but it is recommendable only AFTER M0/M2/M3/M4 pass. Until then: pin to BYOM, do not ship cloud B.** Architecture A (droid-as-backend) remains an optional, later, lossy adapter — and is additionally disqualified on nested-agent token cost (§5-A).

---

## 2. What a Factory droid actually is

Two distinct products share the "droid" name. Disambiguating them is the whole spike.

### 2a. The `droid` CLI (coding agent)

**Sourcing caveat (read first):** this session fetched only two URLs — the droid-computers product page and the cli getting-started/overview. The fine-grained flag, output-envelope, and FS-path detail below is **more specific than a getting-started overview plausibly contains**, so anything not literally on those two pages is INFERRED / model-prior, NOT verified doc fact. Items below are tagged `[VERIFIED]` (on a fetched page) or `[INFERRED]` (must be confirmed against an exact doc URL before any load-bearing use). The reviewer could not distinguish fetched fact from prior here — that ambiguity is itself a defect to close in M0.

- `[VERIFIED]` Installable binary (`curl` / `npm` / PowerShell). `droid` = interactive TUI; `droid exec [prompt]` = headless one-shot — the direct analog of `claude -p`. Supports `-f prompt.md` and stdin piping.
- `[VERIFIED]` **Runs directly on the host. No built-in OS-level sandbox** — Factory *recommends* but does not *enforce* Docker/VM isolation. Good for us (no jail to fight); means we self-isolate.
- `[INFERRED]` Output formats: `-o text|json|stream-jsonrpc`. JSON carries `type`/`result`/`session_id`; stream-jsonrpc is newline-delimited over stdin/stdout. **This `-o stream-jsonrpc` envelope detail load-bears Architecture A's shim — A cannot be costed until it is verified against an exact doc URL.**
- `[INFERRED]` Autonomy: default read-only; `--auto low|medium|high` (high = git push, deploy, docker, migrations); `--skip-permissions-unsafe` removes all guardrails (intended for disposable containers).
- `[INFERRED]` Sessions: `--session-id` continue, `--fork` branch, `--tag`, `--log-group-id`. Transcripts at `~/.factory/projects/<project>/<session-id>.jsonl`.
- `[INFERRED]` Config: `~/.factory/settings.json` (+ project `.factory/settings.json`), `~/.factory/mcp.json`, `.factory/{skills,droids,hooks}/`, project `AGENTS.md`. Hooks under `.factory/hooks/` run with user creds — **Factory's own hook system, NOT Claude Code hooks** (this last point — that `.factory/hooks` ≠ Claude Code PreToolUse — is the structurally important claim and must be confirmed, not assumed).
- `[INFERRED]` Scans `~/.claude/agents/` and `~/.claude/skills/` for importable content (a Claude Code interop hint).

### 2b. Droid Computers (the deployment target)

**Every claim in this subsection is ASSERTED BY MARKETING COPY and UNVERIFIED for your tier/region/timeout.** The product page describes a *feature*; it is not a verified contract for the specific Computer you would run a multi-hour pipeline on. The persistence claim is the literal foundation of Architecture B (a multi-hour pipeline must outlive idle windows + disconnect), so it is the #1 thing M0 must confirm — see OQ-1. Do not treat any of the below as established until M0 passes.

- *(marketing, unverified)* "Persistent machines for remotely orchestrating Droids." Spin up in Factory's cloud OR turn your own machine into one (BYOM).
- *(marketing, unverified)* Claimed **NOT ephemeral**: "every Droid gets a persistent machine, not an ephemeral sandbox that rebuilds each session," with "full filesystem and memory snapshots, so local services can continue running as if they never paused." **The marketing copy says nothing about idle/wall-clock/max-lifetime caps — OQ-1 concedes these are unconfirmed, and a hard cap below pipeline length would invalidate B on cloud.**
- *(marketing, unverified)* Retains installed packages, files, running services, config between sessions. SSH/IDE integration (droid computer ssh as a VS Code Remote-SSH ProxyCommand).
- *(marketing, unverified)* Headline use case: hours-long async / always-on background work — *would* directly match a multi-hour Pickle pipeline IF the no-hard-cap persistence holds.

### Model story
- **BYOK Anthropic Claude is first-class** *(this `customModels` / `~/.factory/settings.json` shape is [INFERRED] per §2a — confirm in M0)*: `"provider":"anthropic"`, `baseUrl: https://api.anthropic.com/v1`, `apiKey: ${ANTHROPIC_API_KEY}` — native Anthropic Messages API, not an OpenAI-compat shim. Auto prompt-caching. NB: this configures the *droid agent's* model — under Architecture B the worker is the genuine `claude` CLI with its own auth, so this `customModels` block is an A-path concern, not a B-path one.
- Also OpenAI/Gemini/Bedrock/Azure/Groq/OpenRouter/Ollama/custom. Only Anthropic+OpenAI "fully tested and benchmarked"; <30B models discouraged. *(model-list [INFERRED].)*
- **CLIProxyAPI bridge is Architecture-A-ONLY.** The community OAuth→API-key pattern (Claude Max/Code subscription into droid, avoiding pay-per-token) is a droid-*agent* convenience. **Under B it is irrelevant** — the genuine `claude` CLI worker authenticates itself; do not scope this into the B plan.
- **Secrets provisioning is UNSPECIFIED and is a blocker for cloud B.** Neither this spike nor the milestones address how `ANTHROPIC_API_KEY`, the Linear/GitHub MCP creds, and the `claude` CLI OAuth/subscription auth get onto a *cloud* Computer securely (vs. a BYOM host where they already live locally). This is a further reason to pin to BYOM until M0+M1 settle it — see M1.

### Background-process support
- Persistent compute + memory snapshots + "always-on agents running in the cloud." Experimental `allowBackgroundProcesses` + ACP daemon mode (v0.56.0+).
- **CONTRADICTION in sources:** one doc asserts `droid exec` itself "cannot spawn long-lived background processes ... single-run executor." Resolution: run the outer loop as a plain OS/tmux process *on* the Computer, not as a child the droid agent supervises.

### OPEN QUESTIONS (docs do not answer — flagged, not guessed)
- **[OQ-1]** app.factory.ai/settings/droid-computers is auth-gated and was NOT verified this session: provisioning, OS image, sizing, **wall-clock / idle / max-lifetime caps**, and pricing are unconfirmed.
- **[OQ-2]** Cloud Computer OS: Linux-only or also persistent macOS? (BYOM mentions Mac Mini; cloud image unspecified.) Matters for macOS-specific behavior (`stat -f`, `md5`, `osascript`).
- **[OQ-3]** Whether a multi-hour outer loop survives as a child of the droid agent vs. only as an independent OS process — not definitively documented.
- **[OQ-4]** Whether the genuine `claude` CLI can be installed and run as a worker on a Computer — inference (it's a normal host), unverified by Factory docs.
- **[OQ-5]** MCP forwarding parity between Pickle's `worker_mcp_config` snapshot model and `~/.factory/mcp.json`.
- **[OQ-6]** Concurrency/quotas for many parallel workers (`claude -p` or `droid exec`) on one Computer.

---

## 3. Pickle Rick's host-dependency surface

### 3a. Hard couplings (the cost of the port)

| Coupling | Where | Why it bites |
|---|---|---|
| **Hooks enforcement contract** (#1 blocker) | `install.sh:611-710` jq-merges Stop/PreToolUse/PostToolUse hooks into `~/.claude/settings.json`; `extension/hooks/dispatch.ts:177-186` parses `{decision:'approve'\|'block'}` (never `'allow'`), fail-open via 10s watchdog (`dispatch.ts:65`) | The entire worker-forbidden-ops layer (`config-protection.ts` state.json/install.sh/git-reset blocks, `tsc-gate.ts`, `--add-dir` containment) only fires when the worker is the real `claude` CLI. No PreToolUse-equivalent on a droid host = every R-WSRC guard gone. |
| **`claude` CLI as manager AND judge** | manager spawn `mux-runner.ts:3136` (`claude -p --output-format stream-json --max-turns N --no-session-persistence`); judge hard-pinned `buildJudgeInvocation('claude',...)` `backend-spawn.ts:700,706-716` (R-SCJM-5 trap door); `install.sh:289` warns if absent | A replacement CLI must honor `-p`/one-shot, `stream-json`, `--max-turns`, `--add-dir`, `--no-session-persistence`, and read-only judge mode (`--allowedTools Read,Glob,Grep`) or both the manager loop and the convergence judge break. |
| **stream-json + promise-token protocol** | manager `streamJson:true`; classification reads result event `num_turns`/`turn_count` (`detectManagerMaxTurnsExit`); `promise-tokens.ts` scrubs orchestrator tokens, workers emit only `<promise>I AM DONE</promise>` | A droid CLI emitting a different envelope silently mis-classifies clean completions as errors (R-ICDM-1 class). |
| **600s Bash-tool ceiling (headless path only)** | `mux-runner.ts:2951-2977` `routeLargeTierTicket` refuses large-tier through foreground spawn-morty (SIGKILL at 600s → 0-byte log), routes to persistent-REPL `/pickle-tmux` | Ceiling applies to the **headless non-tmux path** where a Claude session's manager calls spawn-morty as a Bash tool. **The `/pickle-tmux` path already spawns the manager via Node `child_process.spawn` (`mux-runner.ts:3136`), NOT as a Bash tool — so it already evades the ceiling today, no droid needed.** A droid changes nothing here. The subtraction opportunity is real but scoped to the headless path and is port-independent. **See §5/§6 correction.** |
| **MCP config forwarding** | `--mcp-config <path>` claude-only (`backend-spawn.ts:538,559`); codex already can't (`:564-599`) | Droid needs its own MCP-injection or workers lose Linear/GitHub. |
| **Ambient Claude config FS** | `install.sh:291-298` aborts if `~/.claude/settings.json` absent ("Run claude at least once first"); `backend-spawn` reads `~/.claude.json` as default MCP fallback | Runtime assumes the Claude Code config filesystem exists. |
| **POSIX FS session store** | DATA ROOT `getDataRoot()` `pickle-utils.ts:406` (`~/.local/share/pickle-rick`); atomic `state.json.tmp.<pid>`→rename, dead-pid demotion `recoverable-json.ts`; setpgid via `detached:true` `backend-spawn.ts:804` | Needs POSIX atomic rename + process groups. Fine on Linux/macOS; not win32. |
| **tmux outer loop** | `pickle-tmux.md:30,84,91` (`tmux -V`, `new-session`, `send-keys`); 4-pane monitor `pickle-utils.ts:2120-2236` | The context-clearing loop runs inside a tmux pane. **Opportunity, see §5.** |

### 3b. Already-portable parts (the reuse surface)

- **Backend adapter Seam** — `backend-spawn.ts` is the sole module mapping `Backend` enum → `SpawnInvocation {cmd,args,backend,env}` (`:102-107`). Factories `buildWorkerInvocation` (`:507`), `buildManagerInvocation` (`:517`), `buildJudgeInvocation` (`:700`). Resolution precedence is backend-agnostic (`resolveBackend :219`, `resolveWorkerBackendFromState :243`). Spawn sites consume only the abstraction (`mux-runner.ts:3136`, `spawn-morty.ts:2069`). **Adding `'droid'` = new enum member + 3 builders; spawn sites unchanged.**
- **state.json lifecycle machine** — `state-manager.ts` + `types/index.ts State`: pure Node/FS, no Claude/tmux dep. Schema migration, atomic transactions, tmp-recovery, dead-pid demotion all host-agnostic on POSIX. Lifecycle steps/phases are data.
- **Skills as prompt templates** — every `/pickle-*`, `meeseeks.md`, `send-to-morty.md`, `_pickle-manager-prompt.md` is plain markdown via `composeManagerPromptFromSkill`. Portable to any capable agent CLI. `command_template` is a string in state.json.
- **Orchestration control flow** — mux-runner ticket selection, cap/timeout/circuit-breaker, `ticket-completion-evidence.ts` oracle, relaunch policy, pipeline-runner phase sequencing — Node logic over state.json + git, model invoked only through the abstract spawn invocation.
- **Reporters** — `metrics.ts`, `standup.ts`, `status.ts` read activity JSONL + git log; no harness coupling.
- **Relocatable roots** — `getDataRoot()` / `getExtensionRoot()` already env-overridable (`PICKLE_DATA_ROOT`, `EXTENSION_DIR`/`PICKLE_INSTALL_ROOT`); `install.sh --prefix` supports non-canonical deploy.

---

## 4. Gap analysis

Pivotal axis: **droid-as-agent (agent-in-agent)** vs **droid-as-compute (programmable host)**. Both columns below.

| Pickle host dependency | Droid-as-compute provides it? | Droid-as-agent provides it? | Porting effort |
|---|---|---|---|
| `node` on PATH | YES (normal host) | YES | none |
| `tmux`, `git`, `vim` | YES ("drops cleanly into vim, tmux, shell") | YES | none |
| `jq`, `rsync` | YES (install on host) | YES | none |
| genuine `claude` CLI worker | **UNVERIFIED — gated on M2/M3** (inference: normal host) [OQ-4] | NO — would be `droid exec` | none (B, if M2/M3 pass) / **rebuild** (A) |
| Hooks contract (PreToolUse block) | **UNVERIFIED — gated on M2** (assumed via real `claude`) | **NO** — `.factory/hooks/` ≠ Claude Code hooks, no equivalent BLOCK-before-tool | none (B, if M2 passes) / **rebuild** (A) |
| stream-json + promise tokens | **UNVERIFIED — gated on M3** (assumed real `claude` emits it) | NO — droid envelope differs | none (B, if M3 passes) / **shim+rebuild** (A) |
| `--add-dir` sandbox containment | **UNVERIFIED — gated on M2** (assumed real `claude`) | NO (agent project-dir scope, not OS) | none (B, if M2 passes) / **rebuild** (A) |
| read-only judge mode | YES (`--allowedTools`, real claude) | partial (`--auto` low ≈ read-only, unverified) | none (B) / **shim** (A) |
| MCP forwarding to workers | YES (`--mcp-config`, real claude) | partial (`~/.factory/mcp.json`) [OQ-5] | none (B) / **shim** (A) |
| `~/.claude/settings.json` pre-exists | gated on M1 (run `claude` once) | N/A | none (B) |
| POSIX atomic rename + pgroups | YES (Linux/macOS) [OQ-2] | YES | none |
| `@colbymchenry/codegraph` native | YES (install per-platform) | YES | shim (platform binding) / `PICKLE_CODEGRAPH=off` |
| 600s foreground-tool ceiling | **N/A — no Claude harness above the loop** | inherited from droid agent runtime [OQ-3] | **deletable** (B) / unknown (A) |
| multi-hour outer loop survives | YES (tmux/daemon on Computer) | contested [OQ-3] | none (B) / risk (A) |
| Anthropic model access | YES (real `claude` + key) | YES (BYOK first-class) | none |

**Read:** under droid-as-compute (B) almost every cell is "none" **once M2/M3 confirm the real-`claude` premises** — the Computer is *asserted to be* just a Linux box. Under droid-as-agent (A) the hooks/stream-json/containment trio is "rebuild," exactly the codex precedent: codex bypasses the hook layer (R-CXOR-3) and had to add a post-iteration `detectAndRecoverHeadRegression` git audit as a *replacement* enforcement mechanism. That audit is the template for ANY non-Claude worker — and the proof that dropping the hook contract is real, not theoretical, work. A carries the *additional* nested-agent cost penalty (§5-A) the table does not capture: agent-in-agent multiplies LLM context billing per lifecycle step.

---

## 5. Deployment architectures

### Architecture A — Droid as a new Pickle backend
`droid exec` replaces `claude -p` workers; mux-runner / state machine / pipeline stay.

- **Changes:** add `'droid'` to `BACKENDS` (`types/index.ts`); add `buildDroidWorkerInvocation` / manager / judge (`backend-spawn.ts`); map `-p`→`droid exec`, `--output-format stream-json`→`-o stream-jsonrpc` (envelope shim), `--max-turns`/`--no-session-persistence`/`--add-dir`→nearest droid flags or NO-OP; build a **replacement enforcement gate** (port codex's `detectAndRecoverHeadRegression` git-regression audit, since PreToolUse blocking is gone); build a droid MCP-injection path.
- **Reused:** orchestration control flow, state.json machine, skills, reporters.
- **Effort:** medium-high. The classifier/judge/scrubber all assume Claude Code semantics — "swap cmd='claude'→'droid' is necessary but NOT sufficient."
- **Risk:** HIGH. Loses every hook-enforced R-WSRC guard, the tsc-gate, and `--add-dir` containment; reintroduces the silent-misclassification (R-ICDM-1) and head-regression (R-CXOR) failure classes. Net: ADDS a parallel enforcement layer instead of reusing one. Against the repo's subtract-before-add discipline.
- **Independent disqualifier — nested-agent token blowup.** A droid is itself an LLM agent. Running Pickle *as* an A-backend on the droid agent means the lifecycle nests LLM contexts: `droid-agent (outer) → manager (droid exec) → worker (droid exec) → judge (droid exec)`, each a full LLM context billed independently. That is potentially **N× the token cost** of B (where the manager/worker/judge are plain `claude -p` processes the droid agent never wraps) for **zero capability benefit over B**. A is not merely "lossy on enforcement" — it is architecturally the wrong shape (agent-in-agent) and likely cost-prohibitive. Even if A were ever pursued for a non-Anthropic model, it must run the workers as direct OS processes (droid-as-compute), never nested under a supervising droid agent. This cost analysis, not just the enforcement gap, is why A is rejected as the primary path.

### Architecture B — Pickle inside a Droid Computer (droid-as-compute) ★
The Computer is just a persistent Linux host. Install `node`, `tmux`, `git`, `jq`, `rsync`, the **genuine `claude` CLI**, run `claude` once to seed `~/.claude/settings.json`, then `bash install.sh`. Run Pickle exactly as today; the droid agent is ignored (or used only as a human convenience for ad-hoc tasks).

- **Changes:** essentially **zero code**. Provisioning + a bootstrap script. Optionally relocate roots via `PICKLE_DATA_ROOT` / `--prefix` if the Computer's home layout warrants it (already supported, no code change).
- **Reused:** EVERYTHING. Full Claude Code hook fidelity, stream-json, `--add-dir`, MCP forwarding, promise tokens, judge isolation — all intact because the worker IS the real `claude`.
- **Effort:** low *if the gates pass*. Mostly ops + verifying [OQ-1..OQ-4] + provisioning secrets.
- **Risk:** LOW **only conditionally** — B is NOT recommendable until **M0 (caps/OS/persistence) + M2 (hooks fire with real claude) + M3 (stream-json classifies correctly) + M4 (multi-hour survival)** all pass. Two of B's premises are auth-gated unknowns printed elsewhere as facts: the persistence/idle-cap claim [OQ-1] and "genuine `claude` honors the hook BLOCK contract on this host" [OQ-4]. Additional unpriced risk: **secrets provisioning onto a cloud Computer** (see Model story) is unspecified. **Until all four gates pass, pin to BYOM** (your own Mac Mini / VM): it removes [OQ-1] entirely and keeps secrets local. Residual after gates: macOS-vs-Linux image [OQ-2] for `stat -f`/`md5`/`osascript` paths (all already have Linux fallbacks in `install.sh:41-50,527,567`).

### Architecture C — Droid-native reimplementation
Lifecycle steps → droid specs (`--use-spec`, `--mission` worker+validator); skills → `.factory/{droids,skills,hooks}`; state.json → droid sessions.

- **Changes:** rewrite the orchestration layer in droid primitives.
- **Reused:** the PRD/skill *prose* and the lifecycle *concept* only.
- **Effort:** REBUILD. Discards `state-manager.ts`, the completion-evidence oracle, circuit-breaker, recovery state machine, metrics — years of incident-hardening encoded in MEMORY.md.
- **Risk:** VERY HIGH, no payoff that B doesn't already deliver. Reject.

---

## 6. Recommended path + spike plan

**Recommend Architecture B as the target — conditional on M0/M2/M3/M4, BYOM until then.** It honors subtract-before-add: it reuses the entire existing runtime (including the hook contract that is the #1 blocker for every other option) and adds nothing but a host. It is the only option that preserves R-WSRC enforcement for free. The recommendation's *direction* is firm; its *confidence* is gated — do not provision a cloud Computer for production pipelines until the four milestones pass; use BYOM in the interim. A is a *later, optional* lossy adapter to evaluate only if a concrete need arises to run droid-native workers (e.g. a non-Anthropic model); even then it must port a codex-style replacement gate **and** avoid the nested-agent shape (§5-A).

**Subtraction opportunities (call out, don't auto-do) — and an important correction about which are droid-specific:**
- The tmux context-clearing outer loop exists because the orchestrating Claude Code session can't clear its own context. On a Droid Computer the mux-runner can run as a **plain daemon / systemd unit / detached tmux** with no interactive Claude session above it — the loop already spawns amnesiac `claude -p` managers (`--no-session-persistence`), so tmux becomes pure observability, not a correctness dependency. Candidate to DELETE the harness-above-the-loop assumption.
- **CORRECTION — the 600s-ceiling subtraction is mostly NOT a droid unlock; it already exists today via tmux.** Verified: under `/pickle-tmux`, mux-runner already runs as an OS process in a tmux pane and spawns the manager via Node `child_process.spawn` (`mux-runner.ts:3136`) — **not** as a Claude Bash tool call. The 600s ceiling and the `routeLargeTierTicket` / R-WPEX large-tier machinery (`mux-runner.ts:2951-2977`) apply to the **headless, non-tmux path**, where a *Claude session's manager* invokes spawn-morty as a foreground Bash *tool*. A Droid Computer therefore changes **nothing** about the tmux path that already evades the ceiling. The genuine subtraction — deleting the ceiling and its silent-death recovery machinery — is scoped to the **headless-manager path only**, and it is a candidate cleanup **independent of this port** (do it on Claude Code today), NOT a droid-specific payoff. The earlier framing of this as "the highest-value cleanup the port enables" was a misread of where the ceiling lives and is retracted here.

### Spike milestones (scope/sequence/exit-criteria; no time estimates per repo rule)

- **M0 — Verify the unknowns.** Authenticate to app.factory.ai, provision one Droid Computer (cloud or BYOM). Exit: [OQ-1] caps + OS image documented; [OQ-2] OS confirmed; SSH terminal reachable.
- **M1 — Host bootstrap + secrets provisioning.** On the Computer: install node24+, tmux, git, jq, rsync, `claude` CLI; provision secrets — `ANTHROPIC_API_KEY` (or `claude` OAuth/subscription auth), Linear/GitHub MCP creds — and document the secure path used (env injection / secret store / BYOM-local), since cloud-Computer secret handling is otherwise unspecified; `claude` once to seed `~/.claude/settings.json`; clone repo; `cd extension && npm ci && bash ../install.sh`. Exit: secrets reachable to a worker, `install.sh` completes (hooks jq-merged, codegraph resolved or `PICKLE_CODEGRAPH=off`), `node bin/setup.js --help` runs.
- **M2 — Hook smoke test.** Confirm the Claude Code hook contract fires on the Computer: trigger a worker-forbidden op (e.g. attempted `state.json` write) and assert `config-protection.ts` BLOCKs. Exit: a known R-WSRC violation is blocked, proving [OQ-4] (real `claude` worker honors hooks on this host).
- **M3 — Smallest end-to-end proof: one ticket, one phase.** A trivial single-file PRD through `/pickle-tmux` → setup → mux-runner → one manager iteration → one spawn-morty worker → green gate → `<promise>I AM DONE</promise>` → ticket frontmatter flips Done. Exit: state.json shows the ticket Done with a real `completion_commit`; `tmux_iteration_1.log` shows stream-json classified as success (not R-ICDM-1 misclassify).
- **M4 — Multi-hour survival.** Run a small multi-ticket bundle to completion as a detached process; verify it survives past any idle window and across a session disconnect (the persistence claim). Exit: pipeline reaches EPIC_COMPLETED with no external SIGTERM; [OQ-3] resolved.
- **M5 (optional, gated, NOT droid-specific) — Headless-path subtraction proof.** This validates a cleanup to the **headless non-tmux manager path** (where spawn-morty is a Claude Bash tool subject to the 600s ceiling); the tmux path already spawns workers as OS children (`mux-runner.ts:3136`) and never had the ceiling, so this milestone is runnable on Claude Code today and is not a payoff the port unlocks. Run a headless manager as a top-level OS process (not as a Bash tool call) and confirm large-tier tickets no longer hit the 600s ceiling. Exit: a large-tier ticket completes via the headless path without R-WPEX routing — evidence to later DELETE `routeLargeTierTicket` from the headless path.

**Stop criteria / gate to recommendability:** B is recommendable for production **only after M0+M2+M3+M4 all pass**; until then the standing recommendation is BYOM-only. If M2 fails (hooks don't fire on the Computer with real `claude`), B's core thesis is wrong → re-scope to A with a ported enforcement gate (and accept its nested-agent cost). If M0 reveals a hard wall-clock/idle cap below pipeline length, pin to BYOM permanently for cloud. If M3 shows stream-json misclassification, B needs the same envelope-handling work A would — re-evaluate.

---

## 7. Risks & open questions

- **[OQ-1] Cloud Computer caps/pricing/OS image unverified** (auth-gated). A hard wall-clock or idle timeout below multi-hour pipeline length is the top risk to B. Mitigation: BYOM (your own Mac Mini / VM) removes the unknown entirely.
- **[OQ-2] Linux vs macOS cloud image.** macOS-specific paths (`stat -f`, `md5`, `osascript`, `flock` fallback) already have Linux fallbacks (`install.sh:41-50,234-249,527,567`) — low risk either way, but verify.
- **[OQ-3] Backgrounding contradiction.** Run the loop as an independent OS process, never as a droid-agent child. M4 settles it empirically.
- **[OQ-4] Genuine `claude` as worker on the Computer** — inference, settled by M2/M3.
- **[OQ-5] MCP snapshot parity** — only matters if driving through the droid agent (A); under B, `--mcp-config` works unchanged.
- **[OQ-6] Worker concurrency quotas** on one Computer — unknown; affects parallel-worker throughput, not correctness.
- **Architecture-A residual risk (if ever pursued):** dropping the hook contract reintroduces the R-ICDM-1 (stream-json misclassify) and R-CXOR (head-regression) classes; requires porting codex's `detectAndRecoverHeadRegression` replacement gate. Documented, not free. **Plus the nested-agent token blowup (§5-A):** running A under a supervising droid agent nests LLM contexts (outer agent → manager → worker → judge), potentially N× the cost of B — independently disqualifying.
- **[OQ-7] Doc-grounding gap (NEW).** Most §2a flag/output/path detail is [INFERRED], not fetched from the two cited URLs (§2a sourcing caveat). The `-o stream-jsonrpc` envelope and `.factory/hooks` ≠ Claude-Code-hooks claims load-bear A's shim and the §4 "rebuild" verdict respectively. Resolve in M0 by citing exact doc URLs per flag.
- **[OQ-8] Secrets provisioning on a cloud Computer (NEW).** How `ANTHROPIC_API_KEY` / MCP creds / `claude` auth land securely on a cloud Computer is unspecified. BYOM sidesteps it; M1 must document the cloud path.
- **codegraph native binding** must resolve on the Computer's platform or deploy aborts; `PICKLE_CODEGRAPH=off` is the escape hatch for the spike.
- **Security note:** the droid CLI has NO OS-level sandbox by default; if the agent is used at all on the same Computer, self-isolate (dedicated VM/user). Under B this is moot — Pickle's own hook layer is the boundary.
