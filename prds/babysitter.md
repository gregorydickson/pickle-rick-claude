# Babysitter — pickle-rick-claude master-plan driver

Two prompts live here. **The CURRENT one is directly below** (rewritten 2026-10-06
for the single-`main` line). The older cron/drain-queue variant is kept
at the bottom as **v1 (superseded)** — it references a Drain Queue table and bundle
codes that no longer match the live plan, so do not arm it without re-verifying.

---

## CURRENT PROMPT (operative, 2026-10-06 — autonomous, single `main` line)

Paste verbatim. It is written to be re-sent every tick; each tick is self-contained. Arm with
`CronCreate({ cron: "11 */2 * * *", recurring: true, prompt: <the block below> })` (every 2 hours — operator, 2026-10-08) — session-only,
auto-expires after 7 days; re-arm after a restart.

```
PICKLE-RICK PIPELINE BABYSITTER TICK (AUTONOMOUS). Scope: /Users/gregorydickson/pickle-rick-claude, branch main ONLY (the experimental branches were retired 2026-10-04; main is the only line and the deployed runtime). BINDING: this repo is open source — no client content ever (root CLAUDE.md), in PRDs, tickets, commits or issue comments; field-run issues are referenced by number and generic shape only. Each tick: read root CLAUDE.md's PRIME DIRECTIVE, the SESSION HANDOFF + QUEUE in prds/MASTER_PLAN.md, and the open GitHub issues.

MEASUREMENT RULES: resolve the live session from the newest ~/.local/share/pickle-rick/sessions/*/state.json + pipeline-runner.log + artifact mtimes (pipeline-status.json publishes only at phase boundaries); TZ=UTC for every time comparison; Node v24; capture exit codes directly; an absent, empty or zero-file result is NOT a pass; a claim is a measurement only if you named and took the observation that would falsify it. Verify a deploy BY CONTENT: `diff -rq` of extension/bin, extension/services and .claude/commands against ~/.claude/pickle-rick and ~/.claude/commands must report 0 differing.

STANDING AUTHORIZATIONS — act, do NOT ask the operator:
A. RUNTIME/PIPELINE-BREAKING BUG (deployed runtime fails to load, pipelines halt, tests damage the real ~/.claude/pickle-rick): restore first (bash install.sh from main when no runner is alive; verify the deployed runners import), then write a PRD per rule D and run /pickle-pipeline on main.
B. FINISHED BUNDLE: run prds/gate-runner.sh <log>; green ONLY if every leg prints `=== LEG_RC <leg> 0` (the runner's own exit code is not enough) and the soak's reported wall-clock is ≥ SOAK_SECONDS (grep SOAK_UNRUN). All green → git push origin main, bash install.sh, verify by content (above), update the MASTER_PLAN STATE/QUEUE rows, commit + push the doc, and post an evidence comment (--body-file) on each issue the bundle fixed, closing it. Any red leg → write a fix PRD naming each red and its cause (fix the cause, never loosen a check) and run it as a pipeline on main.
C. NEXT QUEUE ITEM: when nothing runs and the tree is green, take the next undone QUEUE item in MASTER_PLAN. If its PRD does not exist, author it (rule D), commit it on main, then launch /pickle-pipeline. Strictly sequential: never two pipelines; never commit to main while a pipeline or gate runs on it.
D. PRD AUTHORING — THE PRINCIPLE SCREEN (every ticket must pass all, or it is cut and recorded as rejected with the reason):
   1. Would the NEXT ITERATION fix this? If yes, add nothing — record it.
   2. It adds no halt, abort or launch-block condition. Gates MAY refuse a local action and withhold the success verdict; they MAY NEVER stop the pipeline.
   3. Subtract or widen before adding: name the existing rule/primitive it widens or the code it deletes; a new enumerated-set member needs a written reason no list-free formulation exists. Fill the `## Simplification Review` (prds/CLAUDE.md).
   4. A new check goes INSIDE an existing gate leg (state the leg count; 22 today) and names its falsifying control (break the watched thing → it must red).
   5. Every executable AC is RUN at HEAD before launch: it must FAIL today, and its expected value is the measured one. Grep every named symbol in src/ at HEAD.
   6. Files sections name only paths that exist (pipeline.json `paths:` silently drops absent ones — host new code/tests in existing files); a ticket that changes a shared return shape lists every exact-shape pin in all tiers; every subprocess in a new test gets `timeout: 30_000`.
   Pin `--scope-base <sha-before-the-bundle>` in pipeline.json (on main `--scope branch` resolves empty). Use refinement for behaviour/prompt-contract changes; --no-refine only for ≤ 5 named reds.
E. IDLE (nothing running, queue drained) → AGENT-SWARM RESEARCH TICK (operator, 2026-10-07). Skip if a research agent from an earlier tick is still running. Otherwise launch ONE background research agent on prds/research/2026-09-agent-systems-spike.md: pick ONE open gap from its §6 (rotate; never the same gap two ticks running), work from primary sources (papers, benchmarks, vendor engineering posts, source repos), label every claim with the doc's evidence tags ([M] / [M, this repo] / [Mv] / [C] / [D]), and keep the swarm framing of MASTER_PLAN "🐝 AGENT SWARMS" (attribution must survive N writers; single-writer assumptions) and the portability constraint (pickle-rick runs outside any one harness — prefer process/file/git-based coordination over harness-specific team features). The agent edits ONLY that file: replace or tighten rather than append, keep it ≤ ~4,500 words, add one Changelog line. Measurement-only experiments (§4 style) are allowed if cheap (≤ ~15 min, no pipeline launch, nothing under ~/.claude). Read its diff before committing; commit only that file on main and push — never while a pipeline or gate runs (rule C). This is the only idle work; do not invent bug work.
F. FIELD-RUN EVIDENCE: if a new client field run appears (a session whose working_dir is not this repo), record NUMBERS ONLY in MASTER_PLAN per the handoff checklist (phases /4, non_convergent/stalled_below_target, kept lane branches, ERR_MODULE_NOT_FOUND in a lane/unit, base drift, open-decision count) and log the field row via prds/research/tools/field-timing.py. Never touch, restart or install against a pipeline in another repo.
G. NEW GITHUB ISSUES: triage each new issue against rule D's screen (measure its premises at HEAD — a premise can be stale), add it to the MASTER_PLAN QUEUE as a ticket row or a recorded rejection, and compose same-surface rows into the next bundle rather than opening a new one. If an issue body carries client content, do not quote it; tell the operator.

ASK THE OPERATOR ONLY FOR: cutting a release/tag (cadence: every few days, not per bundle); deleting branches, tags or session data; changing a PRD's goal (not its mechanics); phase-order or gate-leg-count changes; anything touching client/private data; operator-deferred #43.

Report each tick in 2-3 sentences: what ran, what you measured, what you changed or launched.
```

**Amended 2026-10-07:** rule E — idle ticks run agent-swarm research (operator: "when there is nothing to do, we should keep doing our agent swarm research").

**Rewritten 2026-10-06:** the 09-25 prompt carried rules C/P/S for `exp/b-lanes` / `exp/b-parallel-build`
(merge-down, beta soak, deploy-from-branch). Both branches were retired 2026-10-04, so those rules targeted
nothing. Rule D now carries the PRIME DIRECTIVE screen explicitly (operator: "tickets have to pass our
guiding principles"); the research-agent idle rule was dropped (the spike doc is not on the queue).

**Why autonomous (operator, 2026-09-25):** "I seem to be making obvious decisions, we need to update the babysitter
to keep the work going more autonomously." The loop had stalled for hours on yes/no questions the evidence had
already answered.

### Operator corrections applied to this prompt (2026-09-22)

The prompt as issued carried two stale lines. Both were measured, not assumed:

- **`branch release/v2.1-beta`** — that branch exists but is a **strict ancestor, 200 commits behind**,
  last touched 2026-09-16. Development moved to **`main`** on 2026-09-21 (see root `CLAUDE.md`).
  The line above is corrected to `main`.
- **`scratchpad gate2.sh`** — no such file. The gate runner is **`prds/gate-runner.sh <log>`**
  (22 legs, ~70 min).

### Things this loop learned the hard way

- **`ls`/`stat -f '%Sm'` print LOCAL time.** Prefix `TZ=UTC` before comparing against anything in Zulu.
- **`pipeline-status.json` only publishes at phase boundaries.** It sat frozen for a 36-hour
  anatomy-park phase. The live oracles are `state.json` + `pipeline-runner.log` + artifact mtimes.
- **Use `--body-file` for every `gh issue comment`.** Inline bodies get their backticks eaten by zsh
  command substitution; a comment was silently published with four blanked spans.
- **If the default model refuses refinement analysts, route them with `--model <id>`** on
  `/pickle-refine-prd` / `/portal-gun`, or `default_refinement_model` in `pickle_settings.json` (#46,
  shipped 2026-09-22). Measured before the fix: 12/12 spawns refused with `[reasoning_extraction]`.
- **On `main`, `--scope branch` resolves EMPTY.** Pin `--scope-base <sha-before-the-bundle>` in
  `pipeline.json` or anatomy-park reviews the whole tree (or trips `SCOPE_EMPTY_POST_BUILD`).

---

## v1 — cron/drain-queue variant (SUPERSEDED, kept for reference)

Reusable prompt for the **fully autonomous** babysitter loop. Drains the entire
pickle-rick-claude master plan with **zero operator interaction**: watches active
pipelines, finalizes AND ships completed bundles (including `git push` +
`gh release create`), and — when the dispatch queue drains — authors and launches
the next bug bundle. It never halts to ask the operator anything.

## How to arm it

Re-create as a recurring cron whose prompt **is** the checklist below (do NOT wrap
it in a model-driven `/loop` — that judges itself "done" when the queue drains and
silently self-terminates, which is the failure this file fixes).

- **Cadence:** every 30 min, off the `:00`/`:30` herd — e.g. cron `11,41 * * * *`.
- **Persistence:** session-only by default (dies when Claude exits, auto-expires
  after 7 days). Pass `durable: true` to survive restarts (persists to
  `.claude/scheduled_tasks.json`).
- **Mechanism:** `CronCreate({ cron: "11,41 * * * *", recurring: true, prompt: <the prompt below> })`.

## Authorization model

The babysitter has **standing authorization for the complete release cycle**,
including the irreversible/outward-facing steps (`git push`, `gh release create`).
It is gated only by engineering quality, not by operator approval:

- A bundle ships **only** when the full release gate is green AND the tree is clean
  AND compiled JS matches TS source.
- The release gate result is READ and confirmed green before any bump/commit/tag —
  never tag on an unread or red gate.

The only residue the babysitter may leave undrained is work that is **gated on an
external event, not on operator interaction** (e.g. #25 R-CSI forensics need a real
concurrent-session incident to analyze). When only such watch-only items remain it
logs "master plan drained" and lets the next tick re-scan — it does not ask for input.

## Provenance

Distilled from operator feedback memories:
`feedback_babysitter_scope_pickle_rick_only`,
`feedback_babysitter_author_and_launch_pending_prd`,
`feedback_launch_unattended_pipelines` (full-release-autonomy clause supersedes the
old per-release-authorization constraint),
`project_babysitter_demote_rptsb_phantom_sessions`,
`feedback_never_tag_before_gate_result`,
`feedback_closer_install_sh_bypass`,
plus the worktree/orphan-commit recovery recipes.

---

## Prompt

BABYSITTER — pickle-rick-claude master-plan driver. Goal: DRAIN THE ENTIRE master plan UNATTENDED, with zero operator interaction. Standing authorization: launch multi-hour pipelines AND ship completed bundles end to end — including `git push` and `gh release create`. You never halt to ask the operator anything. The only gate is engineering quality (a green release gate + clean tree), never operator approval.

SCOPE: pickle-rick-claude ONLY. working_dir is the checkout that actually exists on THIS host — resolve it at tick time, do NOT trust a baked-in absolute path. On the 2026-08 host it is `/Users/gregorydickson/pickle-rick-claude`; the older `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude` belongs to a different machine and does NOT exist here (arming the prompt against it silently scopes the babysitter to nothing — the did-it-RUN failure class). Verify with `ls -d` before acting. NEVER touch pipelines in other repos (especially attractor, if present) — do not track, restart, finalize, or run install.sh against them, even if they look wedged. Surface at most.

HOST MEASUREMENT PRECONDITIONS — apply these BEFORE any measurement; skipping them manufactures false reds and can trip halt condition (b) on a healthy tree.
   - **Pin the Node interpreter in every command; never trust ambient.** Prefix with `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`. The entire Node 22 line (22.12.0 AND 22.23.2) cancels ~38 fast-tier tests with "Promise resolution is still pending" — a gate run under Node 22 reads RED on a green tree. The tool shell's default `node` is still 22.12.0 (a login-shell profile fix does NOT reach it). Node 25 is unusable on this host (`dyld: libsimdjson.29.dylib not loaded`).
   - **Node 24 prints `ℹ` summary lines, not `#`.** Grep `^[ℹ#]` or you silently match nothing and read a real run as empty.
   - **Verify deploys BY CONTENT, never by version string:** `diff -rq extension/bin <install-root>/extension/bin` (and `services/`) must report 0 differing. The installer does not bump the version, so a version match proves nothing.
   - **Prove a test run actually ran.** Confirm the log has bytes. `bin/test-runner.js --tier fast` from the wrong cwd prints `[no files for tier fast]` and **exits 0** — indistinguishable from green.
   - **A process census must name top CPU consumers**, not just count pickle processes. A load-34.75 window was entirely macOS daemons (`siriknowledged`, `XprotectService`); a pickle-only census reads clean and hides it.
   - Distinguish `failed` from `empty`/`measured` at every enumeration and subprocess boundary — this is the codebase's dominant defect class, and it applies to the babysitter's own measurements too.

Run this checklist each tick:

1. DEMOTE PHANTOMS — scan ~/.local/share/pickle-rick/sessions for R-PTSB phantom sessions (active=true AND pid null/absent AND tmux_mode=false AND iteration=0 AND history empty). Demote each: set active=false, exit_reason='orphan-phantom-demoted-by-babysitter'. Guard on the FULL signature so a real session is never demoted. They block install.sh at finalization. [R-PTSB-3 runtime safety net: state-manager.ts recoverStaleActiveFlag now auto-demotes pid-null phantoms on every state read; this babysitter scan is defense-in-depth, not the primary mechanism.]

2. CHECK ACTIVE PIPELINE — find live pickle-rick-claude mux-runners + most-recent state.json. If a pipeline is genuinely active and progressing (state.json mtime fresh, iteration advancing), leave it alone, just log status. If wedged (no progress, orphaned/own commit, reset-off-HEAD), check artifact mtimes BEFORE declaring Failed, then apply the documented recovery recipe (ff-only reattach `git merge --ff-only <sha>` or path-scoped `git restore --source <sha>`). Do not escalate spurious Failed flips.

3. FINALIZE + SHIP COMPLETED BUNDLE — if a bundle finished (all tickets Done + closer ran): run the FULL release gate from extension/ (tsc --noEmit, eslint --max-warnings=-1, tsc, all audit-*.sh scripts, test:fast, test:integration, RUN_EXPENSIVE_TESTS=1 test:expensive). READ the gate output and CONFIRM GREEN before doing anything else — never bump/commit/tag on an unread or red gate. If red: fix the drift (recompile so JS matches TS, sync stale tests to landed behavior) and re-run; do NOT ship red. When green: commit residuals, bump extension/package.json per semver (single bump per bundle), commit `chore: bump version to X.Y.Z`, `bash install.sh` (set state.flags.allow_install_sh_reason if a closer hook blocks it, then clear it), verify `git status` is clean and compiled JS matches TS, then `git push` AND `gh release create vX.Y.Z`. You ARE authorized for push + release — do not pause for operator approval. **Inherited failures do NOT make the gate red for ship purposes** — a failure is inherited only if it is already filed as a bug PRD in `prds/` and reproduces on the pre-bundle tree. Two are currently filed and standing (verify against `prds/MASTER_PLAN.md` each tick, do not trust this list): `install-bun-probe` (P3 — fails BECAUSE bun is installed at `/opt/homebrew/bin`, which its substring `PATH` filter cannot see) and `extension-wiring` `deploy smoke` (P2 — the installer `rm -f`s the very path the test asserts, so re-running the installer GUARANTEES the failure). Record them as inherited and ship; any OTHER failure is caused by the bundle in flight and must be fixed before shipping.

4. DRIVE THE MASTER PLAN — if there is NO active pickle-rick-claude pipeline, do NOT stop. The **live Drain Queue table + the Open Findings tables in `prds/MASTER_PLAN.md` are the SINGLE source of truth** for what remains to drain — re-read them every tick. NEVER trust a hardcoded candidate list (this file included): the queue churns on every release, so a baked-in list silently rots into already-shipped work. Selection is mechanical:
   - A row is DRAINABLE unless its status/notes cell contains any of: `✅ SHIPPED`, `✅ ALREADY SHIPPED`, `✅ CLOSED`, `✅ DONE`, `✅ RESOLVED`, `done`, `⏸️ SHELVED`, `shelved`, `⏸️ MONITOR`, `watch-only`, `external-event-gated`, `operator-deferred`. A `~~strikethrough~~` `#` also means shipped/closed.
   - Identify rows by **bundle code** (`B-XXXX`) + the **Pri** column, NOT by the `#` column — the `#` column has duplicate/colliding values (e.g. rows 30–33 each appear twice: once shipped, once open), so "take the top `#`" is unsafe.
   - Among drainable rows pick the next in dispatch order: **bug bundles before feature epics, then P1 > P2 > P3**; within a tier, top-of-table first.
   - A drainable Open Finding with NO Drain-Queue bundle yet (e.g. #110 R-PRPATH) is authored into a bundle PRD from its `prds/BUG-REPORT-*.md` / finding text, then launched (see the sub-bullets below).
   - Current snapshot (2026-06-12 — a hint, NOT authority; verify against the live table): **P1 bugs** B-PDBL, B-XSPA, B-RLAR, B-LERD, plus #110 R-PRPATH (no bundle PRD yet → author it); **P2 bugs** B-V2RG, B-XCOF, B-HRPW, B-MRSW, B-RFCB. No actionable feature epics remain. Watch-only (skip): B-WPEX #108 (repro-gated), B-CSI #25 (external-event-gated), B-CCDC (operator-deferred).
   For the chosen bundle:
   - If a launchable PRD already exists in prds/ → launch via /pickle-tmux (setup.js --tmux --task <prd> + tmux new-session + mux-runner.js).
   - If NO PRD exists but the open-finding text / a prds/BUG-REPORT-*.md source carries machine-checkable ACs → AUTHOR the bundle PRD non-interactively, matching the existing prds/p{1,2}-bug-fix-bundle-*.md format (frontmatter: title/status/priority/type: bug-bundle/composes; Trigger; root cause; machine-checkable ACs lifted from the finding; ticket classes; closer ticket). Commit the PRD + the MASTER_PLAN dispatch repoint, then launch. Do NOT invoke the interactive /pickle-prd (it stalls unattended). Only run /pickle-refine-prd if the source lacks decomposable ACs.
   - A schema-bump bundle is fully drainable like any other: the `schema_version` bump happens INSIDE the bundle via the schema-migration ticket + `_internalSchemaBump` flag (per `extension/CLAUDE.md`). The old "restart mux-runner" caveat only applies mid-run — you launch from a clean no-active-pipeline state, so the fresh runner loads the new schema; no operator restart needed.

DECISION RULES — resolve these AUTONOMOUSLY; they are NEVER a reason to halt. If you catch yourself wanting to ask the operator a "should I…?" question, the answer is one of these rules — apply it and proceed:
   - **Version bump (semver):** PATCH = fixes/refactors only; MINOR = new commands/flags/events/state fields — INCLUDING a `schema_version` increment whose `normalizeV<N>StateDefaults` forward-migration keeps old `state.json` readable (backward-compatible); MAJOR = only a change that makes existing `state.json` unreadable by the new code, or removes/renames a CLI arg or hook contract. A forward-migrated schema bump is MINOR, not MAJOR.
   - **Bundle/finding overlap:** when a finding (#code) is composed by two queued bundles, the EARLIER drain-queue row OWNS it; recompose the later bundle to its remaining findings and repoint MASTER_PLAN in the same commit. Never ask which bundle owns shared work.
   - **Schema migrations** are normal drainable work via the schema-migration ticket + `_internalSchemaBump` flag (per `extension/CLAUDE.md` Worker Forbidden Ops); they are NEVER a halt reason. The full release gate + closer are the safety net before any release.
   - The ONLY two halt conditions: (a) every actionable bundle is shipped and only external-event-gated watch-only items remain (#25 R-CSI), or (b) the release gate is RED and you cannot make it green. `git push` + `gh release create` are pre-authorized. Anything else is a rule to encode, not a question to ask.

5. LOG — `node ~/.claude/pickle-rick/extension/bin/log-activity.js review "babysit tick: <one-line decision>"`.

NEVER halt for operator interaction. The ONLY residue you may leave undrained is work gated on an EXTERNAL EVENT (not operator approval): #25 R-CSI / B-CSI forensics need a real concurrent-session destructive-command incident to analyze — skip these as watch-only and continue. When every actionable bundle is shipped and only such watch-only items remain, LOG "master plan drained" and let the next tick re-scan. A 'drained' dispatch queue is NEVER a stop condition — drained means author + launch + ship the next bundle. Keep working until the entire master plan is drained.
