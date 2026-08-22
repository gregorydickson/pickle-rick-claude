# Babysitter — pickle-rick-claude master-plan driver

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

Run this checklist each tick:

1. DEMOTE PHANTOMS — scan ~/.local/share/pickle-rick/sessions for R-PTSB phantom sessions (active=true AND pid null/absent AND tmux_mode=false AND iteration=0 AND history empty). Demote each: set active=false, exit_reason='orphan-phantom-demoted-by-babysitter'. Guard on the FULL signature so a real session is never demoted. They block install.sh at finalization. [R-PTSB-3 runtime safety net: state-manager.ts recoverStaleActiveFlag now auto-demotes pid-null phantoms on every state read; this babysitter scan is defense-in-depth, not the primary mechanism.]

2. CHECK ACTIVE PIPELINE — find live pickle-rick-claude mux-runners + most-recent state.json. If a pipeline is genuinely active and progressing (state.json mtime fresh, iteration advancing), leave it alone, just log status. If wedged (no progress, orphaned/own commit, reset-off-HEAD), check artifact mtimes BEFORE declaring Failed, then apply the documented recovery recipe (ff-only reattach `git merge --ff-only <sha>` or path-scoped `git restore --source <sha>`). Do not escalate spurious Failed flips.

3. FINALIZE + SHIP COMPLETED BUNDLE — if a bundle finished (all tickets Done + closer ran): run the FULL release gate from extension/ (tsc --noEmit, eslint --max-warnings=-1, tsc, all audit-*.sh scripts, test:fast, test:integration, RUN_EXPENSIVE_TESTS=1 test:expensive). READ the gate output and CONFIRM GREEN before doing anything else — never bump/commit/tag on an unread or red gate. If red: fix the drift (recompile so JS matches TS, sync stale tests to landed behavior) and re-run; do NOT ship red. When green: commit residuals, bump extension/package.json per semver (single bump per bundle), commit `chore: bump version to X.Y.Z`, `bash install.sh` (set state.flags.allow_install_sh_reason if a closer hook blocks it, then clear it), verify `git status` is clean and compiled JS matches TS, then `git push` AND `gh release create vX.Y.Z`. You ARE authorized for push + release — do not pause for operator approval.

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
