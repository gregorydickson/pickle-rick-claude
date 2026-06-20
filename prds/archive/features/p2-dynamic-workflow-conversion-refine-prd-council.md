---
title: P2 — Convert `/pickle-refine-prd` and `/council-of-ricks` fan-out cores to Claude Code Dynamic Workflows
status: Implementing — R-DWF-1 spike PASSED 2026-06-01 (verdict PROCEED, prds/archive/research/dwf-spike-findings.md); R-DWF-2..6 active. Allowlist additions (§"Why Bash ran without allowlist entries") are a deployment-time operator decision on global settings.json — documented, NOT a code blocker. codex-companion.mjs not deployed (F1) is R-DWF-4 scope.
filed: 2026-05-30
refined: 2026-05-30
priority: P2
type: feature
code: R-DWF
bundle: B-DWF
requires:
  - Dynamic Workflows enabled (Claude Code v2.1.154+, research preview, per-`/config`) — outer kill-switch
related:
  - .claude/commands/pickle-refine-prd.md         # WS-A: skill that orchestrates refinement
  - extension/src/bin/spawn-refinement-team.ts     # WS-A: subprocess fan-out orchestrator (~2100 LOC) — partially deletable (see maintenance tally)
  - extension/src/bin/refinement-watcher.ts        # WS-A: tmux monitor pane — deletable (observability trade-off, see Risk 6)
  - extension/src/services/ac-phase-gate.ts        # WS-A: gate bin — KEEP, invoke inside an agent
  - extension/src/services/graph-preflight.ts      # WS-A: gitnexus install/analyze — KEEP, invoke inside an agent
  - extension/src/types/refinement-manifest.schema.json  # WS-A: manifest contract
  - .claude/commands/council-of-ricks.md           # WS-B: 4-phase round prompt (round loop + fan-out + gate)
  - extension/src/services/council-fanout.ts        # WS-B: planFanOut — pure, but TS: ported to inline plain JS (not imported)
  - extension/src/services/council-schema.ts        # WS-B: SubagentPayload → in-script JSON-Schema literal; validateDirective stays
  - extension/src/bin/council-publish.ts            # WS-B: gh/fs CLI — stays external (script has no fs/shell)
  - extension/src/bin/mux-runner.ts                 # WS-B: round driver — RETAINED as the per-round loop owner
  - extension/src/services/backend-spawn.ts         # grounding: today's workers spawn `--dangerously-skip-permissions` (:339/:356/:440) — the allowlist baseline that changes
  - extension/src/hooks/config-protection.ts        # the R-WSRC hook — PATH-based write gate, not identity-based (crux correction)
non_conflicts:
  - B-PNTR (`prds/archive/bundles/p2-remove-non-tmux-pickle-loop.md`) — `/pickle-refine-prd` is EXPLICITLY KEPT there (title + :17/:45/:119); council not in its removal set. Open verify before slotting: R-DWF-5 edits `mux-runner.ts`; confirm B-PNTR's template-repoint (R-PNTR-2) does not refactor the same per-iteration call site.
  - B-ACSG (#84, refine-prd AC-shape gate oscillation) — POTENTIAL LOGIC COLLISION, not just file-touch: R-DWF-2 retires the fenced `## ac_shape_smells` parse path that B-ACSG may be hardening. Must be reconciled (supersede or confirm compatible), see Risk 7.
---

# R-DWF — Dynamic Workflow conversion of the two fan-out/converge subsystems

> **Refinement note (2026-05-30):** This PRD was reviewed by a 4-lens agent team (skeptic / API-correctness / codebase-grounding / PRD-editor). Their findings **inverted the original crux**: the R-WSRC concern is path-based (writes pass regardless of caller) — the real gate is the **Bash allowlist delta** (§"The real gate"). All API/code-sketch errors, the worktree-isolation misuse, and the internal contradictions they found are folded in below. See §Appendix: Research Provenance.

## Why (strategic context)

Claude Code now ships **dynamic workflows** (research preview, v2.1.154+): a JavaScript orchestration script the runtime executes in the background, where the loop/branching/intermediate results live in **script variables** instead of the orchestrator's context window — only the final return lands in context. Workflows also encode *quality patterns*, not just scale: schema-validated structured returns (retry-on-mismatch at the tool layer), adversarial cross-check, judge panels.

Two pickle-rick subsystems are textbook fan-out/converge shapes that today carry bespoke subprocess plumbing pickle-rick maintains itself:

- **`/pickle-refine-prd`** — 3 analyst Mortys × N cycles, `Promise.all` barrier, cross-cycle context fed via files on disk.
- **`/council-of-ricks`** — per-round parallel `Agent` fan-out across categories × branches, schema'd payloads, a Codex adversarial challenge, autonomous approval gate.

Both are **judge/analysis-heavy and low edit-risk** (council never edits code; refinement's edits are artifact/ticket authoring under the session dir). They are the safest, highest-fit candidates to migrate.

This PRD is the **research deliverable**. It designs the conversions and front-loads the de-risking work. **It does not authorize implementation** beyond the gating spike (R-DWF-1) until that spike's findings are reviewed.

## Why not status quo, and why not full conversion (hybrid justification)

The reviewers flagged that a partial conversion produces a **three-orchestration-model system** (subprocess via mux-runner + native-Agent teams + workflows) and that this cost must be paid honestly:

- **Why not keep status quo?** The subprocess fan-out reimplements concurrency, timeout/kill, and barrier semantics by hand (`spawn-refinement-team.ts` ~2100 LOC; council's "single-message Agent fan-out"). Workflows give schema-validated returns and a maintained scheduler for free, and are the primitive Anthropic certifies for the headless `claude -p` context pickle-rick is consolidating on (B-PNTR's tmux-only direction).
- **Why not full conversion?** Two hard runtime limits forbid it: workflows have **no mid-run user input** (refinement's readiness interview, the per-round approval loop) and the script has **no fs/shell** (all artifact writes + gate bins must run inside agents). So the loop, the interview, and state ownership stay outside the workflow by construction.
- **Maintenance honesty:** "~2100 LOC largely deletable" is overstated. Deletable: the subprocess/timeout/kill/barrier plumbing + the watcher. **Surviving (relocated into agent prompts, which are harder to unit-test than TS):** manifest enrichment + composes-chain resolution, the gate-bin invocations, the manifest schema, ticket authoring. The net is a smaller but **prompt-heavier** surface. This trade is accepted deliberately; R-DWF tickets keep the surviving logic in testable bins invoked *by* agents rather than reimplemented *in* prompts wherever possible.

## The dynamic-workflow primitive — constraints that shape every ticket

1. **No filesystem or shell access from the workflow script itself.** Only spawned agents read/write/run commands. → Every artifact write and every gate-bin invocation MUST be done by an agent.
2. **No mid-run user input.** Only agent permission prompts can pause a run. → Interactive readiness interviews and approval gates stay *outside* the workflow.
3. **Concurrency cap: ≤ `min(16, cores−2)` concurrent agents** (≤16 only on a ≥18-core box; lower on smaller machines); **≤1000 total per run.** `parallel()`/`pipeline()` accept any count; excess queue. → Council's sharded `xxl` fan-out (up to ~91 subagents/round) batches under the cap; per-round wall-time grows.
4. **Script body is deterministic-restricted:** `Date.now()`, `Math.random()`, argless `new Date()` are unavailable (they break resume). Agents are unrestricted. (Both subsystems already do all timestamp/PID/random work inside agents/bins — verified.)
5. **Script is plain JS, not TS** — no type annotations/interfaces/generics, **no module imports** (no fs). → `planFanOut` and every schema must be **inlined as plain-JS literals**, not imported from `.ts`/compiled `.js`.
6. **Script shape:** after `export const meta = {...}` (pure literal), the body is **top-level statements**; `agent`/`parallel`/`pipeline`/`log`/`phase` are **ambient functions** and `args`/`budget` are **ambient globals**. There is **no `export default async function(){…}` wrapper** and hooks are not parameters. The final top-level `return` is the only value that lands in context.
7. **Workflow subagents run `acceptEdits` + inherit the user's allowlist**; they are always **Claude** subagents (no codex-backed workflow agent exists; `model` selects a tier — sonnet/opus/haiku — not a backend).
8. **Resumable within the SAME session only.** Exiting/crashing Claude Code restarts the workflow fresh next session — intermediate script state is lost (see Risk 5).

## The real gate (corrected crux): Bash allowlist delta, not R-WSRC write-classification

The original framing — "workflow agents are worker-classified and may be blocked from writing artifacts" — is **wrong**, per `config-protection.ts`:

- The state/settings/install.sh write gate (`evaluateStateWriteGate`, `isBashInstallBlockedByRWSRC`) is **PATH-based, not identity-based.** It fires for *any* caller whose tool-call targets a protected path, and passes for *everyone* on unprotected paths. Protected set = `{state.json, circuit_breaker.json, pipeline-status.json, pickle_settings.json (+ .tmp.*), ~/.claude/pickle-rick/**}`. **`refinement_manifest.json`, `council-directive.json`, `analysis_*.md`, `linear_ticket_*.md`, `*-summary.md` are NOT in it** → artifact writes pass for any caller, including a workflow agent.
- The **only identity-gated** check is the git-verb blocker (`isGitVerbBlockedByRWSRCGR`), which blocks 9 git verbs **only when `PICKLE_ROLE ∈ {worker, refinement-worker}`**. A runtime-spawned workflow subagent does **not** have `PICKLE_ROLE` set (pickle-rick injects it via its own spawn env), so it is not even subject to the git block.

**Therefore the artifact-write probe is a formality, and the bundle is *safer* than originally framed. The actual gate is the permission delta:** today's workers spawn with `--dangerously-skip-permissions` (`backend-spawn.ts:339/356/440`) — *all* prompts skipped. Workflow agents run `acceptEdits` + the user's allowlist, which is **strictly more restrictive for Bash** exactly where the value lives: the gate-bin shell-outs (`check-readiness.js`, `gitnexus analyze`, `node codex-companion.mjs adversarial-review`, `gt`/`gh`). If those aren't allowlisted, a headless run with no human approver **denies or hangs**. R-DWF-1 must prove these run headless under the allowlist (and document the allowlist additions needed before launch).

Secondary, non-identity checks to confirm in the spike: `tsc-gate.ts` blocks git-commit-class Bash when tsc fails (fires on any active-session caller — matters only if an agent commits; council never commits, refinement only writes artifacts), and the hook only arms when `loadResolvedState()` resolves an active session for the cwd (confirm a workflow subagent shares that hook context).

---

## Survivors vs. targets

| Surface | Disposition |
|---|---|
| `extension/src/bin/spawn-refinement-team.ts` (subprocess/timeout/kill/barrier) | **REMOVE post-soak** (R-DWF-3; behind kill-switch until then) |
| `extension/src/bin/refinement-watcher.ts` (tmux pane) | **REMOVE** (observability trade-off, Risk 6) |
| refinement enrichment / composes-chain / manifest schema / gate bins | **KEEP** — invoked *by* agents |
| `extension/src/services/council-fanout.ts` `planFanOut` | **KEEP** logic, **PORT to inline plain JS** (TS, can't import) |
| `extension/src/services/council-schema.ts` `validateSubagentPayload` | superseded in-flow by the in-script JSON-Schema literal; **`validateDirective` STAYS** (publisher calls it) |
| `extension/src/bin/council-publish.ts` | **KEEP** as external post-run CLI (gh/fs) |
| `extension/src/services/ac-phase-gate.ts`, `graph-preflight.ts` | **KEEP** — invoked *by* agents |
| `extension/src/bin/mux-runner.ts` | **KEEP** — round/loop/state owner |

---

## Workstream A — `/pickle-refine-prd`

### A. Current architecture (verified, file:line)

- **Skill-driven.** `.claude/commands/pickle-refine-prd.md` conducts: locate PRD, Step 2 verification-readiness gate (interactive interview if PARTIAL/MISSING, `:32-61`), `setup.js` session creation (`:71`), optional tmux watcher pane (`:78-83`), spawn the analyst binary (`:88`), then synthesize `prd_refined.md` (Step 6), decompose + author tickets (Step 7a–7e), advance state (7g), optional auto-launch (Step 11).
- **Orchestrator binary** `spawn-refinement-team.ts` (launched ONLY at `pickle-refine-prd.md:88`; `pipeline-runner.ts:565/570` only READS the manifest for a preflight count). Fan-out = 3 roles `requirements|codebase|risk-scope` (`:302-306`), barriered via `Promise.all` (`:1110-1118`); each a `claude -p` subprocess. **Default 3 cycles** sequential (`:935-939`); cycle N+1 feeds prior `analysis_*.md` back via `loadPreviousAnalyses` (`:1061-1074`) + `crossRefSection` (`:636-668`). Backend claude-forced (`REFINEMENT_BACKEND='claude'` const `:27`; `PICKLE_REFINEMENT_LOCK:'1'` set in `buildRefinementEnv` `:96`).
- **Structured outputs:** `refinement/analysis_{role}.md` (free-form + a `## ac_shape_smells` fenced-JSON tail, `:674-716`; parsed `:348`), `refinement_manifest.json` (`RefinementManifest`, atomic `.tmp.<pid>`+rename `:2025-2034`), `refinement/symbol_audit.md`.
- **Gates:** AC-phase gate **pre-refinement runs in `orchestrateCycles` (`:1158`)**, **post-refinement in `main()` (`:2132`)**; symbol-audit (`:2127-2129`), AC-shape (`:2130-2131`), readiness (`check-readiness.js`, `:2140`), graph preflight (`ensureGraph`, `:2113`).
- **State writes:** orchestrator appends one activity entry per worker (`worker_backend_resolved`, `:776-783`) as a *manager*; lifecycle/session writes are `setup.js`/`update-state.js` from the *skill*.
- **Watcher** `refinement-watcher.ts` — read-only TUI (only `sm.read` + `process.stdout.write`; zero writes/spawns across 310 lines).

### B. Workflow design (target)

Convert **the analyst fan-out + cross-cycle loop + synthesis** to a workflow; keep the **Step 2 readiness interview** and **Steps 7–11** at skill level. The cycle loop lives in the script body; cross-cycle context flows through **script variables** — deleting the `analysis_*.md` round-trip + `loadPreviousAnalyses`. `schema`-validated returns replace the fenced-JSON convention (subject to Risk 7 / B-ACSG reconciliation). **All artifact writes target the absolute session dir** (under `~/.local/share/pickle-rick/sessions/...`), never a repo/worktree-relative path. **No `isolation:'worktree'`** — these are read-only-analysis + session-dir-write agents; a worktree provides no isolation (writes land outside it anyway) and would strip `node_modules`/compiled JS/the gitnexus index the gate bins need.

```js
export const meta = {
  name: 'refine-prd',
  description: 'Decompose a PRD into atomic, verification-ready tickets via a parallel analyst team',
  phases: ['analyze', 'synthesize', 'decompose', 'gate'],
};
// All schemas are in-script JSON-Schema literals (no TS import). All *Prompt helpers are in-script JS.
const AnalysisSchema = { /* { role, executive_summary, p0_gaps[], ac_shape_smells[], markdown_body } */ };
const { prdPath, sessionDir, workingDir, cycles = 3 } = args;          // args is an ambient global
const ROLES = ['requirements', 'codebase', 'risk-scope'];
let prior = null, analyses;
for (let c = 1; c <= cycles; c++) {                                    // cross-cycle loop in script vars
  phase('analyze');
  analyses = (await parallel(ROLES.map((role) => () =>
    agent(analystPrompt(role, prdPath, workingDir, c, prior),
      { label: `analyst-${role}-c${c}`, phase: 'analyze', schema: AnalysisSchema })))
  ).filter(Boolean);                                                   // failed thunk → null; drop or detect
  if (analyses.length < ROLES.length) log(`cycle ${c}: ${ROLES.length - analyses.length} analyst(s) failed`);
  prior = analyses;
}
phase('synthesize');                                                   // agent WRITES prd_refined.md + manifest to the session dir
const synth = await agent(synthPrompt(prdPath, sessionDir, analyses),
  { label: 'synthesize', phase: 'synthesize', schema: SynthSchema });
phase('decompose');                                                    // each ticket authored + self-audited
const tickets = (await pipeline(synth.tickets,
  (t) => agent(ticketAuthorPrompt(t, sessionDir, workingDir), { phase: 'decompose' }),
  (authored, t) => agent(ticketAuditPrompt(authored, t), { phase: 'decompose' }))).filter(Boolean);
phase('gate');                                                         // agent runs the existing hardened bins via Bash
const gate = await agent(gatePrompt(sessionDir, workingDir),
  { label: 'gate', phase: 'gate', schema: GateSchema });
return { sessionDir, ticketCount: tickets.length, gate };              // only this lands in context
```

### C. Delete vs. keep — see the Survivors table. Notes: relocate every disk write (manifest, `prd_refined.md`, `linear_ticket_*.md`, symbol audit) and every gate bin INTO agents; `setup.js`/`update-state.js` stay skill-level (R-WSRC). Schemas/prompt-builders are in-script JS (no TS import).

### D. Recommendation: **partial conversion** — analyst fan-out + synthesis first (R-DWF-2); ticket authoring + gates as a *second* workflow later (fs-write + gate-relocation friction). Readiness interview stays skill-level (no mid-run input).

---

## Workstream B — `/council-of-ricks`

### A. Current architecture (verified, file:line)

- **Rides mux-runner; one iteration = one round.** Setup (`council-of-ricks.md:180-194`) calls `setup.js --tmux ... --command-template council-of-ricks.md` then `mux-runner.js`. Mode by `--resume` in `$ARGUMENTS` (`:10`). The per-round loop is **external** (mux-runner re-invokes with `--resume`, context cleared between rounds).
- **Writes `state.json`** via `setup.js`/`update-state.js` (`:215-218`); reads `min_iterations` for the gate. **Judge-only — never edits code** (`:5`).
- **4 phases/round (`:227-309`):** A historical brief (serial, writes `round-<N>/historical-brief.md`); B category team (parallel `Agent`, 8 unconditional B1–B6,B8,B9 + conditional B7); C branch team (parallel, *same `Agent` batch as B* `:289`, one `C_correctness` per non-trunk branch + one `C_codex` if `codex_enabled`); D synthesis (conf<80 prefilter → dedupe by `file:line` → severity sort → write `council-directive.json` atomic + `.md` + append summary).
- **Fan-out planner** `planFanOut` (`council-fanout.ts:29-77`): `SHARDED_TIERS={l,xl,xxl}` (`:27`) emit one spec per `(branch × unconditional_category)` = `8×#branches` B-specs + one `C_correctness` per non-trunk branch + `C_codex`; `{xs,s,m}` = 8 stack-wide. **10-branch `xxl` = 80 + 10 + 1 = 91 specs** (matches the prompt's "single message").
- **Schemas:** `SubagentPayload` (`council-schema.ts:79-87`, 11 `KNOWN_CATEGORIES` `:63-75`), `validateSubagentPayload` (`:288-317`); `validateDirective` (`:200-238`) consumed by `council-publish.ts:187`.
- **Codex phase (`:311-332`):** `C_codex` is an **ordinary Claude subagent that shells out** to `codex-companion.mjs adversarial-review` (`:323`) per branch (sequential checkout) — NOT a codex-backed agent.
- **Approval gate (Step 16, `:398-404`):** `THE_CITADEL_APPROVES` is **fully autonomous** — `round >= min_iterations` AND last TWO `## Round N:` headers both end `— clean round.` AND no unconditional category skipped across both AND zero P0/P1 across both. **No human-in-the-loop.**

### B. Workflow design (target): **convert the inside of a round; keep mux-runner as the round driver.**

One round = one **top-level** Workflow invocation (NOT a nested `workflow()` call — nesting shares the parent's 1000-agent counter; independent top-level invocations reset it). mux-runner inspects the returned summary/directive, evaluates the 4-condition gate, decides re-invoke vs. stop — as today. `planFanOut` is **ported to an inline plain-JS function** (type annotations + `KnownCategory` import stripped); `SUBAGENT_PAYLOAD_SCHEMA` is authored as an in-script JSON-Schema literal (expressing `skip_reason` non-empty iff `status==skipped` via `if/then`, `line>=1`, `confidence∈[0,100]`). No `isolation:'worktree'` (judge-only agents; council agents should be tool-constrained to forbid repo `Edit`/`Write` — see Risk 8).

```js
export const meta = {
  name: 'council-round',
  description: 'One Council of Ricks review round over a Graphite stack',
  phases: ['A-historical', 'B-categories', 'C-branches', 'C-codex', 'D-synthesis'],
};
const SUBAGENT_PAYLOAD_SCHEMA = { /* in-script literal mirroring council-schema SubagentPayload */ };
function planFanOut(input) { /* ported inline plain JS — no TS, no import */ }
const { branches, stackTier, codexEnabled, hasMigrationJournal, round, sessionFiles } = args;
phase('A-historical');
const brief = await agent(historicalPrompt(branches, sessionFiles), { label: 'historical', phase: 'A-historical' }); // agent runs git/gh, writes brief
phase('B-categories');
const specs = planFanOut({ stackTier, branches, codexEnabled: false, hasMigrationJournal });
const bc = (await parallel(specs.map((s) => () =>
  agent(subagentPrompt(s, brief, sessionFiles),
    { label: `${s.category}:${s.branch ?? 'stack'}`,
      phase: s.category.startsWith('C') ? 'C-branches' : 'B-categories',
      schema: SUBAGENT_PAYLOAD_SCHEMA })))).filter(Boolean);            // barrier; failed → null; filter
if (bc.length < specs.length) log(`round ${round}: ${specs.length - bc.length} of ${specs.length} specs failed/capped`);
let codex = null;
if (codexEnabled) { phase('C-codex');
  codex = await agent(codexSweepPrompt(branches, sessionFiles), { label: 'C_codex', phase: 'C-codex', schema: SUBAGENT_PAYLOAD_SCHEMA }); }
phase('D-synthesis');                                                  // agent writes directive + appends summary
return await agent(synthesisPrompt(bc, codex, round, sessionFiles), { label: 'synthesis', phase: 'D-synthesis' });
```

### C. Delete vs. keep — see Survivors table. Move every Phase-A/D fs write + git/gh/codex shell-out INTO agents (B/C already are; A's git/gh and D's directive write must be delegated).

### D. Recommendation: **partial conversion** — convert the inside of a round; **retain mux-runner** as round/loop/state owner. Biggest blockers: the **allowlist delta** (gate bins / `codex-companion.mjs`) and **cross-round statefulness + the `min(16,cores−2)` cap vs. the 91-spec sharded fan-out** (the gate itself is autonomous, not human-gated).

---

## Atomic ticket scope

> **R-DWF-1 (hard gate) is ✅ COMPLETE — spike PASSED 2026-06-01 (verdict PROCEED, all 6 probes PASS; `prds/archive/research/dwf-spike-findings.md`). GATE CLEARED.** R-DWF-2 (WS-A) and R-DWF-4 (WS-B) are now ACTIVE and mutually independent (may run in parallel). **Do NOT re-run R-DWF-1** — its deliverable is committed. Active implementation tickets: R-DWF-2, R-DWF-3 (soak-gated), R-DWF-4, R-DWF-5, R-DWF-6.

### R-DWF-1 — ✅ COMPLETE (spike PASSED 2026-06-01, PROCEED) — Gating spike: prove workflow agents run headless under the allowlist + batch correctly
Build a throwaway (un-shipped) workflow exercising the riskiest capabilities **headless and against the real session-dir path** (a scratch-dir/interactive pass would falsely greenlight — the production runs are `claude -p` with no human approver):
- **artifact-write** (formality): an agent writes `refinement/analysis_<role>.md` + `refinement_manifest.json` under a real session dir; assert no `config-protection.ts` block.
- **gate-bin-shell** (THE gate): an agent shells `check-readiness.js`, `gitnexus analyze`, `node codex-companion.mjs adversarial-review` (or `--help`), and `gt`/`gh` **headless** under `acceptEdits` + the user's allowlist; record each as PASS (ran) / FAIL (denied/hung). Document the exact allowlist entries required.
- **schema-return-retry**: an agent returns a `schema`-validated object; a deliberate mismatch triggers a retry; the validated object lands in the launching context.
- **state-write-firewall**: assert no `state.json` write originates from a workflow agent.
- **batch-throughput**: a 33-thunk `parallel()` (simulating an `xl`/`xxl` shard) completes with all 33 results collected across `≤min(16,cores−2)`-wide batches; record wall-time vs. today's single-message fan-out.
- **backend-confirm**: confirm workflow agents are always Claude (no `model`/backend pin needed; resolves Open-Q).
- **Acceptance / trap door (R-DWF-SPIKE-VERDICT):** `prds/archive/research/dwf-spike-findings.md` (forward-created) contains a `## Probe results` table with one row per probe above, each ending `PASS`/`FAIL` with the verbatim hook/permission outcome. `grep -cE '\| *(PASS|FAIL) *\|' prds/archive/research/dwf-spike-findings.md` ≥ 6. A `FAIL` on `gate-bin-shell` or `batch-throughput` flips this PRD's frontmatter to `status: Shelved` and that file is the sole deliverable (R-DWF-2..6 not started).

### R-DWF-2 — WS-A: refine-prd analyst-fan-out workflow (depends R-DWF-1 PASS)
- `.claude/workflows/refine-analyze.js` (forward-created): the 3-role × N-cycle `parallel()` loop with an in-script `AnalysisSchema`; analysts Write `analysis_<role>.md` to the session dir; a synthesis agent reads the three and returns the manifest shape. No `isolation:'worktree'`, no `model`. Skill `pickle-refine-prd.md` Steps 4–6 launch this workflow and consume its return in place of the `MANIFEST=` stdout parse; Steps 0–3 + 7–11 unchanged.
- **Acceptance / trap door (R-DWF-CROSSCYCLE-VARS):** `extension/tests/refine-analyze-workflow.test.js` (forward-created) runs the workflow on a fixture PRD and asserts (a) exactly `3 × cycles` schema-valid `AnalysisSchema` objects; (b) cycle N+1 prompts embed cycle-N findings AND no `analysis_*.md` is read between cycles (fs-read spy or prompt inspection); (c) the emitted manifest validates against `refinement-manifest.schema.json` (ajv exit 0). Static: `grep -rn "loadPreviousAnalyses" extension/src` returns nothing.

### R-DWF-3 — WS-A: retire the subprocess orchestrator + watcher (depends R-DWF-2 **+ one green soak**)
- Until the soak passes, `spawn-refinement-team.ts` stays behind a kill-switch: `PICKLE_REFINE_WORKFLOW=off` forces the legacy subprocess path. R-DWF-3 removes the legacy path + `refinement-watcher.ts` + the skill tmux block **only after** the workflow path runs green end-to-end on a real PRD.
- **Acceptance / trap door (R-DWF-NO-SUBPROCESS):** `git ls-files extension/src/bin/spawn-refinement-team.ts extension/src/bin/refinement-watcher.ts` is empty; `grep -rn "claude -p\|PICKLE_REFINEMENT_LOCK" .claude/workflows/refine-*.js extension/src/bin` returns no refinement subprocess; `bash scripts/audit-runtime-imports.sh` reports no orphaned imports; the full lint+test gate (CLAUDE.md command) exits 0.

### R-DWF-4 — WS-B: SubagentPayload→JSON-Schema literal + single-round workflow (depends R-DWF-1 PASS)
- **R-DWF-4a:** author `SUBAGENT_PAYLOAD_SCHEMA` (in-script JSON-Schema literal) + a parity test. **R-DWF-4b:** `.claude/workflows/council-round.js` runs ONE round via `parallel()` over the inlined `planFanOut` with `schema`, the historical agent, the codex-sweep agent, and a synthesis agent that writes `council-directive.json` + appends the summary. Council agents tool-constrained: no repo `Edit`/`Write`.
- **Acceptance / trap door (R-DWF-SCHEMA-PARITY):** `extension/tests/council-round-schema-parity.test.js` (forward-created) asserts every fixture payload accepted by `validateSubagentPayload` validates against `SUBAGENT_PAYLOAD_SCHEMA` and vice-versa. An integration test runs `council-round.js` on an `m`-tier 2-branch fixture (8 stack-wide + 2 C = ~10 specs, under the cap) and asserts the emitted `council-directive.json` passes `validateDirective` and the summary line matches `/^## Round \d+: .* — (clean round\.|\d+ issues)/`.

### R-DWF-5 — WS-B: mux-runner round-driver integration + sharded-tier batching (depends R-DWF-4)
- mux-runner invokes `council-round.js` per iteration as an independent top-level run, reads the returned summary/directive, evaluates Step 16 unchanged.
- **Acceptance / trap door (R-DWF-BATCH-COVERAGE):** an integration test drives a simulated `xl` 4-branch stack; assert `planFanOut` emits **N = 8×4 + (#non-trunk branches) C-specs** (compute and pin N from the fixture — do NOT hard-code; for 4 non-trunk branches N = 32 + 4 = 36, +1 if codex); the workflow collects exactly N payloads (`returned.filter(Boolean).length === specs.length`); no batch exceeds `min(16,cores−2)` concurrent; any capped batch emits a `log()` line (no silent under-coverage); the two-clean-rounds gate transitions stop/continue across two consecutive invocations; `council-publish.js` is invoked exactly once post-final-round.

### R-DWF-6 — Docs + README (depends R-DWF-3 + R-DWF-5)
- **Acceptance (R-DWF-DOCS):** `README.md` documents the workflow-backed refine/council paths + both kill-switches; `bash scripts/audit-subsystem-claude-md.sh` passes; `grep -rn "spawn-refinement-team\|refinement-watcher" README.md docs/` returns nothing stale.

## Acceptance criteria (consolidated)

| ID | Criterion | Evidence | Owner |
|---|---|---|---|
| AC-DWF-01 | Spike report records PASS/FAIL for all 6 probes headless + real-session-dir; FAIL on gate-bin-shell or batch-throughput shelves the bundle. | `prds/archive/research/dwf-spike-findings.md` + grep ≥6. | R-DWF-1 |
| AC-DWF-02 | 3×N schema-valid analyses, cross-cycle via script vars (no `analysis_*.md` re-read), manifest contract intact. | `refine-analyze-workflow.test.js` + grep + ajv. | R-DWF-2 |
| AC-DWF-03 | No refinement `claude -p`/tmux pane; gate green; no orphaned imports; legacy path gated by `PICKLE_REFINE_WORKFLOW` until removed. | `git ls-files` + audit + gate. | R-DWF-3 |
| AC-DWF-04 | In-script schema ↔ `validateSubagentPayload` round-trip parity; m-tier round → `validateDirective`-valid directive. | parity unit test + integration test. | R-DWF-4 |
| AC-DWF-05 | xl 4-branch round collects all N=planFanOut(N) specs ≤cap-wide; capped batches `log()`'d; gate fires across 2 rounds; publish once. | integration test. | R-DWF-5 |
| AC-DWF-06 | README + command docs describe workflow paths + kill-switches; docs-drift audit passes. | audit + grep. | R-DWF-6 |
| AC-DWF-07 | Schema-neutral: no `LATEST_SCHEMA_VERSION` bump in the bundle diff. | `git diff` on the schema constant = empty. | R-DWF-3/5 |

## Trap doors
- **R-DWF-SPIKE-VERDICT** (R-DWF-1) — probe table records PASS/FAIL headless; FAIL on gate-bin-shell/batch-throughput shelves the bundle.
- **R-DWF-CROSSCYCLE-VARS** (R-DWF-2) — `loadPreviousAnalyses` + the `analysis_*.md` cross-cycle re-read retired; cross-cycle context flows only through script vars.
- **R-DWF-NO-SUBPROCESS** (R-DWF-3) — no `claude -p` refinement subprocess, no `refinement-watcher` tmux pane survive.
- **R-DWF-SCHEMA-PARITY** (R-DWF-4) — `validateSubagentPayload` and the in-script JSON-Schema literal accept the identical payload set (round-trip).
- **R-DWF-BATCH-COVERAGE** (R-DWF-5) — sharded fan-out collects every spec across ≤cap-wide batches; any capped batch is `log()`'d.
- **R-DWF-STATE-FIREWALL** (all) — no `state.json` write originates from a workflow agent (probed R-DWF-1; standing invariant).
- **R-DWF-NO-REPO-EDIT** (R-DWF-4) — council workflow agents are tool-constrained to forbid repo `Edit`/`Write` (judge-only invariant preserved under `acceptEdits`).

## Schema impact
**Schema-neutral — no `LATEST_SCHEMA_VERSION` bump (AC-DWF-07).** Neither conversion adds a `state.json` field; `refinement_manifest.json` and `council-directive.json` keep their existing contracts. State mutation stays at the skill/mux-runner layer. Self-deploys from a clean no-active-pipeline state.

## Rollback / kill-switch
- **`PICKLE_REFINE_WORKFLOW`** (`off` → legacy subprocess refinement; default workflow once R-DWF-2 lands) — survives until R-DWF-3's post-soak deletion.
- **`PICKLE_COUNCIL_WORKFLOW`** (`off` → legacy per-round `Agent` fan-out via mux-runner; default workflow once R-DWF-4 lands).
- The dynamic-workflow feature flag (`/config`) is the outer kill-switch: if the runtime disables workflows, both skills fall back to the retained subprocess/Agent paths until R-DWF-3 lands.
- Post-deletion rollback = `git revert` of the bundle (schema-neutral → no migration to unwind).

## Non-goals / out of scope
- Converting the core ticket lifecycle (`/pickle-tmux`, `morty-phase-*`), `/pickle-microverse` (needs fs rollback the script can't do), `/meeseeks`, `/szechuan-sauce`, `/pickle-debate`, `/death-crystal`.
- Folding the council per-round loop or refinement approval into a single workflow (forbidden by no-mid-run-input + cross-round state + the 1000-agent cap).
- Removing the autonomous council gate or the refinement readiness interview; any `state.json` write from a workflow agent; retiring mux-runner.

## Risks
| # | Risk | Mitigation |
|---|---|---|
| 1 | **Bash allowlist delta** — workflow agents (`acceptEdits`+allowlist) are more restrictive than today's `--dangerously-skip-permissions` exactly at the gate-bin/codex shell-outs; headless run with no approver denies/hangs. | **R-DWF-1's `gate-bin-shell` probe is THE gate.** Document + add required allowlist entries before launch. (Artifact-write is a formality — path-based hook passes any caller.) |
| 2 | `min(16,cores−2)` cap vs. council's 91-spec sharded `xxl` fan-out — wall-time balloon + "all specs ran" semantics. | R-DWF-1 `batch-throughput` probe (pre-build); R-DWF-5 verifies batching + `log()`s capped batches. One top-level run/round resets the 1000 cap (do NOT use nested `workflow()`). |
| 3 | Crash recovery / resumability regression — workflow resume is same-session-only; a Claude Code exit/crash mid-cycle/round loses all intermediate work (today checkpointed in state.json). | One-cycle/one-round granularity keeps blast radius to a single unit; mux-runner re-invokes from the last *returned* round; synth/gate agents checkpoint to the session dir. Explicitly accepted as a regression for sub-round granularity. |
| 4 | Schema-validation retry = full agent RE-RUN (tokens+latency); today's fenced-JSON parse is a cheap local re-parse/repair. | Keep schemas permissive (include `markdown_body`); cap retries; consider a local-repair fallback for the analyst payload. |
| 5 | Observability regression — deleting `refinement-watcher` assumes `/workflows` UI replaces it, but that UI is only in the launching session; headless mux-runner runs get no live panes. | Document what headless operators get (final return + `log()` lines only); weigh the loss; optionally have the synth agent append a progress line to a tailable session file. |
| 6 | Council agents run `acceptEdits` with repo access — a misbehaving judge/synth agent could silently `Edit` code (the worker git-reset block does NOT apply — no `PICKLE_ROLE`). | **R-DWF-NO-REPO-EDIT** — tool-constrain council workflow agents (no repo `Edit`/`Write`). |
| 7 | **B-ACSG logic collision** — R-DWF-2 retires the `## ac_shape_smells` fenced-JSON path (`spawn-refinement-team.ts:107-139`, parser `:348`) that B-ACSG (#84) may be hardening. | Reconcile before slotting: R-DWF supersedes B-ACSG's matcher work, or confirm the schema field is compatible. Sequence R-DWF *after* B-ACSG resolves, and treat as a logic merge, not file ordering. |
| 8 | Dynamic Workflows is a research preview (flagged, v2.1.154+). | Bundle gated on the flag; kill-switches retain subprocess/Agent paths; keep legacy until R-DWF-3 soak passes. |
| 9 | mux-runner call-site collision with B-PNTR (R-DWF-5 edits mux-runner; B-PNTR repoints the manager template). | Confirmed low (trap-door audit shows no B-PNTR mux-runner round-loop entry); verify the exact call site before slotting. |

## Open questions (for refinement)
1. Does R-DWF-1 pass on this machine's hook + allowlist config? (Everything downstream depends on the `gate-bin-shell` + `batch-throughput` probes.)
2. Should refine ticket-authoring (Steps 7–9) become a *second* workflow, or stay skill-level permanently? (Research leans: second workflow later; not in v1.)
3. ~~Backend pin~~ — **RESOLVED:** workflow agents are always Claude subagents; the `PICKLE_REFINEMENT_LOCK` claude-force is auto-satisfied. No `model`/backend pin needed.
4. For council, thin standalone driver vs. threading the workflow call through mux-runner's existing loop?
5. Does R-DWF-2's schema field supersede or merely coexist with B-ACSG's AC-shape matcher hardening? (Risk 7.)

## Proposed drain-queue placement (operator to slot — ledger NOT edited by this PRD)
- **Bundle B-DWF, P2, feature.** Per "drain bugs before features," below the open P1/P2 bug bundles. Slot **after B-PNTR lands** (tmux-only/`_pickle-manager-prompt.md` settled; verify the mux-runner call site, Risk 9) and **after B-ACSG resolves** (Risk 7 logic collision — not just file-touch). **Refinement strongly recommended pre-launch.**

## Appendix: Research provenance
Two parallel read-only research agents (2026-05-30) deep-read both subsystems + backing TS and produced cited conversion designs; a second 4-lens agent team (skeptic / API-correctness / codebase-grounding / PRD-editor) then refined this document. Material corrections from the refinement pass: the R-WSRC crux is **path-based, not identity-based** (writes pass any caller — the real gate is the Bash allowlist delta vs `--dangerously-skip-permissions`); the code sketches required the ambient top-level shape (no `export default`); `isolation:'worktree'` was dropped (breaks gate bins, no isolation benefit); `model:'claude'` is invalid (workflow agents are always Claude); `planFanOut`/schemas must be inlined as plain JS (no TS import); the cap is `min(16,cores−2)`; and three internal contradictions (Risk-5↔R-DWF-3, worktree↔cross-agent-read, the spec-count arithmetic) were resolved. Citations were independently verified against HEAD (minor drift only: PRE-AC-phase-gate is in `orchestrateCycles` not `main()`; `council-publish` calls `validateDirective` at `:187`; `:27` is the `REFINEMENT_BACKEND` const, the `PICKLE_REFINEMENT_LOCK` literal is at `:96`).
