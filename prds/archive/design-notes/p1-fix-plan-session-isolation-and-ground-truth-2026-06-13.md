# Fix Plan — Session Isolation & Ground-Truth Resilience (2026-06-13)

**Status:** PLAN ONLY — do not implement. Next step is `/pickle-refine-prd` into atomic tickets.
**Author:** babysitter synthesis after the B-RRH weekend run (8 manual recoveries across 5 SIGTERMs + a multi-runner contamination + a closer takeover).
**Consolidates open findings:** #25 R-CSI, #113 R-XSIG/R-XSPA-2/R-XSMR, #111 R-RSPIN(A+B), and S1–S4 from `BUG-REPORT-2026-06-12-concurrent-pickle-session-launch-sigterms-other-repo-pipelines.md`. (Resolved siblings — R-MWIS, R-WCUC, R-ORSR family, R-GNXR, R-PRPATH-via-B-RRH — are referenced as prior art, not re-opened.)

---

## Thesis — three root causes, not ten bugs

The open findings collapse into **one operator-facing meta-defect (R0)** plus **three prevention defects (R1–R3)**. Each prevention defect is the same shape: *a decisive operation trusts a global/ambient/stale signal instead of a session-scoped ground truth.* R0 is orthogonal: *even when a failure happens, there is no sanctioned tool to recover — so the operator is forced into raw state surgery the protection hook then blocks.* Fixing the four roots closes ~9 findings, removes the cause of most weekend interventions, AND makes the residual ones a one-command operation.

| Root | One-line defect | Findings it closes | Leverage |
|---|---|---|---|
| **R0 — No first-class, hook-safe recovery primitive** | every recovery transition (re-pin, resume-from-lowest-Todo, clear in-scope partial) requires raw `state.json` surgery, which R-WSRC correctly blocks → the only recovery path is broken | META-FINDING; makes #111 R-RSPIN, #25 R-CSI, S4 *recoverable in one command*; subsumes S3-escalation | **Operator keystone** — the babysitter hand-patched state ~8× this weekend; this turns all of it into `pickle-recover <session>` |
| **R1 — Process/signal ops are GLOBAL, not session-scoped** | reaping selects targets by binary name / unfiltered PID sweep, so one session's launch kills another's runners (even cross-repo) | #25 R-CSI, #113 R-XSMR, and the *source* of #113 R-XSIG | **Prevention keystone** — eliminates the ~hourly external SIGTERM that generated ~80% of the weekend recoveries |
| **R2 — Phase completion trusts exit code / token, not ticket truth** | a phase that didn't finish can exit 0 / emit `EPIC_COMPLETED` and the pipeline advances on an incomplete bundle | #113 R-XSPA-2, S4 (codex false EPIC_COMPLETED) | **Cheapest high-value** — ONE check at the advance gate subsumes both |
| **R3 — Resume/launch trusts stale captured state, not the live repo** | pinned branch/SHA, prd_path, and readiness refs are captured once and never re-derived; readiness is blind to same-bundle forward-creation | #111 R-RSPIN-A (stale pin) + R-RSPIN-B/R-RFCB (forward-ref) | Medium — unblocks the canonical refine→feature-branch flow |

Unifying principle for the redesign: **"scope decisive operations to the session, and trust ground truth (process group, ticket frontmatter, live HEAD) over ambient signals (binary name, exit code, captured pin)."** The same principle the babysitter playbook already encodes manually (session-scoped kills, frontmatter authority, ff-only reattach). R1–R3 push *prevention* of that principle into the runtime; **R0 gives it a user-facing surface** — one hook-safe command that performs every session-scoped, ground-truth recovery transition the babysitter currently hand-rolls, so the playbook stops being a human-in-the-loop requirement.

---

## R0 — First-class, hook-safe recovery command  *(P1, operator keystone; ships independently)*

**Closes:** the META-FINDING. Makes #111 R-RSPIN, #25 R-CSI fallout, and S4 *recoverable in one command*; removes the need for the raw-`state.json` surgery that the S3-escalation showed R-WSRC (correctly) blocks.

**Current anti-pattern.** Every recovery transition is operator-hand-rolled raw state surgery: `node StateManager.update` to reset `step`/`current_ticket`/`exit_reason`, re-pin `pinned_*`, delete the `pipeline-cancel` marker, fix `monitor_mode`, then relaunch. The config-protection hook (R-WSRC) blocks raw `fs.writeFileSync(state.json)` — *correctly* — but that leaves NO sanctioned recovery path, so the operator either weakens the hook (`allow_state_writes_reason`, chicken-and-egg) or routes through `update-state.js` piecemeal. There is no single tool that owns the *recovery intent*. (This entire weekend's ~8 interventions were exactly this — and every one is mechanical and scriptable.)

**Simplifying design.** Add one sanctioned, hook-permitted recovery primitive — `pickle-recover <session>` (bin) and/or `mux-runner --recover` — that performs, with NO raw config write (it writes through the same `StateManager` path the hook trusts):
1. **`--repin`**: set `pinned_branch`/`pinned_sha`/`start_commit` to the working dir's current `git HEAD`; clear `head_pin_mismatch_detail`. (Owns the R3a transition; kills R-RSPIN-A.)
2. **`--resume-from-todo`**: reset `step`→`research`, `current_ticket`→`null`, clear `exit_reason`, remove a stale `pipeline-cancel` marker, reset `pipeline-status` + `monitor_mode`, reap the session's own process group (R1), then relaunch — picking up the lowest non-`Done` ticket. (Owns the R-CSI-kill, R-XSPA-2, and S4 recovery paths.)
3. **`--clear-partial`**: path-scoped reset of an in-scope uncommitted partial (never a directory-wide `git restore`/`add -A`), after archiving it. (Owns the salvage-or-discard transition.)
4. **Idempotent + dry-run (`--plan`)**: prints the transitions it would apply and exits 0, so an operator/babysitter can preview before applying.

It composes the existing scattered primitives (`update-state.js`, `retry-ticket.js`, `setup.js --resume/--repin`, `cancel.js`, `circuit-reset.js`) behind one recovery-intent interface, and is the ONE place that's allowed (via `StateManager`, hook-permitted) to perform these mutations.

**Acceptance criteria.**
- [ ] AC-R0-1: `pickle-recover <session> --repin` sets `pinned_sha == git rev-parse HEAD` of the session working_dir with NO raw `fs.writeFileSync` (passes config-protection unmodified). Regression: run under the live hook, assert not blocked.
- [ ] AC-R0-2: `pickle-recover <session> --resume-from-todo` on a cancelled/false-completed session clears `exit_reason`/cancel-marker, resets `step`/`current_ticket`/`pipeline-status`, and relaunches to build the lowest non-`Done` ticket. Integration test over {signal-cancelled, false-EPIC_COMPLETED, premature-advanced} states.
- [ ] AC-R0-3: `--clear-partial` archives then path-scoped-clears only in-scope dirty paths; a dirty path outside scope is left untouched and reported.
- [ ] AC-R0-4: `--plan` dry-run prints the transition set and makes no change.
- [ ] AC-R0-5: the babysitter recovery playbook in `docs/` is rewritten to "run `pickle-recover`" instead of raw state edits; memory recipes point at it.

**Why R0 ships first / independently.** It has immediate value even before R1–R3 land (it codifies a proven playbook into a tool, today), and it's the lowest-risk (it only formalizes mutations the babysitter already performs by hand). R1–R3 then *reduce how often* `pickle-recover` is needed; R0 makes the residual recoveries safe and one-command. R0's `--resume-from-todo` also leans on R2's frontmatter-truth scan and `--repin` on R3a — building R0 first surfaces the exact shared helpers R2/R3 then formalize.

---

## R1 — Session-scoped process & signal isolation  *(P1, highest prevention leverage)*

**Closes:** #25 R-CSI (cross-session/cross-repo SIGTERM), #113 R-XSMR (stray-runner accumulation), removes the trigger for #113 R-XSIG (external SIGTERM mid-bundle).

**Current anti-pattern.** Setup / ownership-refresh / stale-cleanup reap runner processes by a global predicate (`pkill -f mux-runner` / `-f pipeline-runner`, or an unfiltered PID-table sweep). A new session's launch SIGTERMs every other session's runner regardless of working_dir — breaking the operator's expectation that concurrent cross-repo sessions are isolated. (The babysitter's own over-broad `pkill mux-runner` mistake this weekend is the same anti-pattern one level up — evidence the design *invites* it.)

**Simplifying design.**
1. **Tag every spawned runner/worker with its session:** `setpgid` into a session process group AND an env stamp `PICKLE_SESSION=<session-hash>` (+ `PICKLE_WORKING_DIR`). One spawn helper owns this; all spawns route through it.
2. **Every kill/reap/cleanup site targets the session's own group/stamp ONLY** — never a bare binary name or unfiltered sweep. Resolve targets from the session's own `state.json` pid + process-group, or filter candidate pids by `PICKLE_SESSION` env.
3. **One invariant + trap door:** *"a session's lifecycle may signal ONLY processes in its own session group; it MUST NOT signal a process whose working_dir/session differs."*
4. **Relaunch reaps the full session group** (fixes R-XSMR — no orphan strays survive a relaunch to compound into N competing runners).

**Acceptance criteria.**
- [ ] AC-R1-1: `git grep -nE "pkill|killall|process\.kill|kill -|spawnSync\('kill'" extension/src` — every hit is session-scoped (group id or session-filtered pid), asserted by a per-site regression.
- [ ] AC-R1-2: integration test — long-lived `mux-runner` for session S1 (working_dir W1); run `setup.js`/launch for S2 (W2 ≠ W1); assert S1 alive and `state(S1).exit_reason == null`.
- [ ] AC-R1-3: relaunch of a session with 2 pre-existing strays in its group leaves exactly one runner chain afterward; no process from another session is touched.
- [ ] AC-R1-4: documented invariant + trap door in `extension/src/bin/CLAUDE.md`.

**Why this is the keystone.** The weekend "recurring external SIGTERM ~hourly" was R-CSI: each concurrent pickle launch in another repo killed B-RRH's runner. R-XSPA-2 (premature advance) and R-XSMR (contamination) were *downstream consequences* of those kills. Fix R1 and the SIGTERMs stop, the salvages stop, and R-XSIG (no-auto-resume) becomes moot.

---

## R2 — Ticket-frontmatter is the single source of truth for phase completion  *(P1, cheapest high-value)*

**Closes:** #113 R-XSPA-2 (signal-shutdown exits 0 → premature advance), S4 (codex false `EPIC_COMPLETED` with tickets Todo).

**Current anti-pattern.** `pipeline-runner` decides "pickle complete → advance to citadel" from the phase runner's **exit code** (R-XSPA-2: signal-shutdown exits 0) or a **completion token** (S4: `EPIC_COMPLETED` with 9/12 Todo, breaker CLOSED). Both let an incomplete bundle advance. The C1/C2 fix only closed the *non-zero-exit* half.

**Simplifying design.** Make the **phase-advance gate** re-read ground truth, independent of how the phase exited:
- Before advancing pickle→citadel (on ANY exit — 0, signal, `EPIC_COMPLETED`, max-turns), re-scan every `linear_ticket_*.md`. **If any non-`Done` ticket remains, the phase is incomplete:** stamp `pipeline_phase_incomplete`, do NOT advance, never report `completed successfully`.
- This is one predicate at one site (the phase-advance decision in `runPhaseIteration`/`finalizePipeline`). It subsumes R-XSPA-2 and S4 and is robust to *future* exit-path variants (the recurring class).
- Belt-and-suspenders for R2-specifically: the signal-shutdown handler should still stamp `pipeline_phase_incomplete` when pending tickets remain (so `auto-resume.sh` can auto-recover instead of stopping on `exit_reason=failed`) — but the advance gate is the authoritative backstop.

**Acceptance criteria.**
- [ ] AC-R2-1: integration test — SIGTERM the pickle mux-runner mid-bundle (tickets Todo); assert pipeline-runner does NOT enter citadel/anatomy-park and stamps `pipeline_phase_incomplete`.
- [ ] AC-R2-2: integration test (codex) — manager emits `EPIC_COMPLETED` with ≥1 Todo ticket + breaker CLOSED; assert `MANAGER_FALSE_EPIC_COMPLETED` logged, loop continues, phase never reports success.
- [ ] AC-R2-3: the advance decision reads ticket frontmatter (not exit code / token) as the authority; unit test over {exit 0, exit 1, signal, EPIC_COMPLETED} × {all Done, some Todo}.
- [ ] AC-R2-4: signal-shutdown with pending tickets stamps `pipeline_phase_incomplete` (not bare `failed`) so `auto-resume.sh` R-CNAR-4(c) auto-recovers.

Aligns with the existing **Resume-time ticket runnability contract** (frontmatter authoritative) — this extends that same authority to the phase-advance decision.

---

## R3 — Re-derive environment-coupled state from ground truth at resume/launch  *(P1 on recurrence)*

**Closes:** #111 R-RSPIN-A (stale branch/SHA pin), R-RSPIN-B/R-RFCB (same-bundle forward-ref readiness rejection). Prior art: R-PRPATH (stale prd_path — already fixed by B-RRH D3/D4/D5; same class).

**Current anti-pattern.** State captured at session creation (`pinned_branch`, `pinned_sha`, `start_commit`, `prd_path`) is trusted on `--resume` even when the world moved (checked out a feature branch; `prd_refined.md` now exists). And `check-readiness` resolves refs against current HEAD with no awareness that a lower-`order` ticket in the *same bundle* forward-creates them.

**Simplifying design.**
- **R3a — re-pin on resume:** `setup.js --resume` re-derives `pinned_branch`/`pinned_sha` from the working dir's current `git HEAD` when they differ from the stored pin (resolving the dirty-tree-guard ↔ HEAD-mismatch-guard catch-22). Provide an explicit `--repin` / documented path; dirty-tree guard copy names it.
- **R3b — bundle-aware readiness:** `check-readiness` treats a ref as resolved if a lower-`order` ticket in the same bundle declares it in `Files to modify/create`, even unannotated. AND/OR the Step 7e hardening-ticket template auto-annotates forward-created `MODIFIED_FILES` with the canonical `(created by ticket <hash>)`; the decomposer never emits the non-canonical `(ticket <hash>)`.

**Acceptance criteria.**
- [ ] AC-R3a-1: integration test — create session on branch A, checkout B + commit, `setup.js --resume --tmux`; assert `state.pinned_sha == git rev-parse HEAD`.
- [ ] AC-R3a-2: a documented re-pin mechanism exists + is referenced in the `/pickle-pipeline` branch/scope section; dirty-tree guard copy names it.
- [ ] AC-R3b-1: bundle where ticket order 70 references a file declared by ticket order 10 → `check-readiness` exits 0 (no skip-flag needed).
- [ ] AC-R3b-2: decompose a forward-creating bundle; every hardening-ticket `MODIFIED_FILES` path resolves or carries the canonical annotation; a lint finds no bare `(ticket <8hex>)` forward-refs.

---

## Hygiene fixes (narrower; bundle alongside or defer)

- **S1 — scoped staging:** worker/closer commits stage ONLY ticket-declared paths; never `git add -A`/`git add .` (B1 swept 22 untracked PRDs onto a feature branch → PR pollution). Same "scope destructive ops" principle as R1. *(High value, small.)*
- **S2 — whole-repo typecheck on interface change:** a build that changes an exported type/interface runs a repo-wide `tsc` before pickle reports success (R-ORSR-6 appears regressed / uncovered for the `scope:branch` path). *(Medium.)*
- **S3 — config-protection blocks writes only:** the hook blocks mutating ops (`>`/`tee`/`sed -i`/`rm`/`fs.writeFileSync`) against protected configs but NEVER read-only access (`cat`/`stat`/`node require`/glob), and NEVER rejects a whole compound command for one offending sub-token (block the write, let co-located `tmux`/`git` run). Document the sanctioned `update-state.js` recovery path (can set nested `flags.*`, `pinned_sha`, pipeline-status). *(Medium; directly impaired babysitter monitoring all weekend — S3 is why reads kept false-blocking.)*

---

## Recommended sequencing

1. **R0 first** (operator keystone — codifies the proven recovery playbook into a hook-safe tool *today*; lowest risk; makes every residual failure a one-command fix while R1–R3 are built). Surfaces the shared helpers R2/R3 formalize.
2. **R1 next** (prevention keystone — stops the SIGTERM storm; makes every other recovery rarer). Highest prevention leverage per ticket.
3. **R2** (cheap, one-site, defense-in-depth that survives future exit-path variants; `pickle-recover --resume-from-todo` reuses its frontmatter-truth scan).
4. **R3 + S1** (unblock the canonical refine→feature-branch flow; `--repin` shares R3a; stop PR pollution).
5. **S2, S3** (hygiene; S3 directly unblocks babysitter monitoring; can ride R1/R2's bundle).

Estimated as a single mega-bundle (B-RRH-style) of ~6 workstreams, or two P1 bundles: **B-A = R0+R1+R2** ("recovery primitive + session isolation + completion truth" — the autonomy core); **B-B = R3+S1+S2+S3** ("launch/resume ground truth + hygiene"). Refinement decides the split. R0 is independently shippable if the operator wants the recovery tool in hand before the larger bundle.

**DO NOT IMPLEMENT.** Next action: `/pickle-refine-prd` this file into atomic, machine-checkable tickets, then route through the standard pipeline once the concurrent weekend pickles have cleared and beta.3 has shipped.
