---
title: "B-DURA — durable iteration boundary: the runner commits the ticket's work; one oracle; Done & phase-advance derive from durable commits"
priority: P1
status: Draft (authored 2026-06-22; HEAD-grounded revision 2026-06-23 post cycle-3 refinement + R-PFNT)
schema_neutral: true
date: 2026-06-22
goal: "A multi-ticket bundle on EITHER backend (claude or codex) completes 4/4 phases hands-off: every Done ticket is backed by a durable runner-authored commit, no context-cleared worker can clobber a prior ticket's edits, a single evidence oracle governs every Done-flip, and a green build never reports 0/4."
build_protocol: self-modifying-recovery (R-PSRB) — hand-build the recovery-path tickets on claude, deploy via install.sh, then run the rest on the fixed runtime. NOT autonomously self-buildable.
composes:
  - prds/BUG-REPORT-2026-06-22-codex-backend-completion-evidence-fatal-and-cross-iteration-work-corruption.md  # R-CECX trigger
  - prds/BUG-REPORT-2026-06-23-green-build-reports-0-of-4-evidence-oracle-disagreement-and-failed-nonterminal.md  # R-PFNT
  - prds/p1-beta2-pipeline-completion-2026-06-20.md            # B-PCOMP — the fix this completes
  - prds/BUG-REPORT-2026-06-20-completion-evidence-fatal-claude-backend-strands-bystander-ticket.md  # R-CECB
  - prds/p1-design-simplification-and-autonomy-2026-06-13.md   # D1/D2 north-star
---

# B-DURA — Durable Iteration Boundary

**Release goal:** turn B-PCOMP's *"the gate trusts the branch"* into *"the branch is **made** to contain the
work, one oracle reads it, and phase-completion tells the truth about it."* A multi-ticket bundle on **either
backend** runs start→finish hands-off; every Done ticket is backed by a **durable, runner-authored commit**; a
context-cleared worker can never clobber a prior ticket's edits; and a **green build never reports 0/4.** This
is the GA-on-codex unblocker and the **subtraction** the completion-commit cluster has circled for 14
recurrences.

---

## 1. The larger sense — why this exact bug keeps coming back

This is the **14th instance of one defect class** spanning **50 days** (2026-05-04 → 2026-06-23). A
HEAD-grounded sweep of `BUG-INDEX.md` + `MASTER_PLAN-archive.md` + the archived bundles found 13 prior
incidents, of which **10 (77%) were fixed by *adding* machinery** — a new frontmatter field, a new evidence
*kind*, a new flag, a wider attribution grep, a new salvage branch, a new watcher — each closing one gap while
the next surface (a new backend, multi-ticket, async session, shared-file contention) exposed the adjacent
one.

### 1.1 The recurrence (the cluster — 14 incidents, 50 days)

| When | Code | Backend / shape | Symptom | Fix shape |
|---|---|---|---|---|
| 05-04 | R-CCC | codex-spark, multi | worker commits but skips `completion_commit:`; phantom-Done watcher reverts real commits | **ADD** auto-fill helper + watcher path + worker ACK |
| 05-23 | R-WUWC | both, multi | worker commits real code, skips frontmatter → Done-flip fatals | **ADD** SOFT-variant gate escape hatch |
| 05-24 | R-CCQF | both, closer | `hasCompletionCommit` rejects quoted full SHA | **ADD** quote-form parser widening |
| 05-24 | R-PEDC | both, single | `exit_reason` not cleared on N+1 recovery → false `done_without_commit_evidence` | **ADD** exit-reason clear logic |
| 05-24 | R-CCRC | both, multi | 4 Done-flip paths bypass the guard; grep misses ref-codes | **ADD** ref-code grep + routing audit |
| 05-26 | R-RIC-EXPLICIT | both, single | explicit stamp in `linear_ticket_<id>.md` read as 'inferred' | **ADD** new read path |
| 05-28 | R-AFCC-STALE | both, async | cross-session false attribution (no start_time filter) | **ADD** always-apply start_time guard |
| **05-28** | **B-AFCC-DEEP** | both (architecture) | **root-cause: 6 failed-fix recurrences/30d; ~70% dead code; 8 distinct Done-stamping paths, divergent invariants** | **SUBTRACT** — delete `auto-fill-completion-commit.js` (−300 LOC), collapse paths → `TicketCompletionEvidence` oracle |
| 06-12 | B-PDBL | both, multi | inferred stamp → phantom-Done backfill loop (1.9 MB state bloat) + dirty-tree relaunch block | **ADD** backfill-once + activity cap + self-heal |
| 06-20 | **R-CECB** | claude, multi | committed-green ticket salvage-looped + fataled; bystander stranded; **recurred once per ticket ×6 in one bundle** | **SUBTRACT/REORDER** — reconcile-before-salvage, demote inferred flag (**B-PCOMP, beta.22**) |
| 06-21 | R-WSDO | both, single | 0-byte log indistinguishable from silent death | **ADD** `worker_produced_nothing` observability event |
| **06-22** | **R-CECX** | **codex, multi** | workers commit **nothing**; ticket flips **Done with code absent**; later context-cleared ticket **rewrites shared registry from stale base → throws at import** | *(this PRD — STOP adding)* |
| **06-23** | **R-PFNT** | **codex, multi** | **green build** (12 commits, 978 tests 0-fail) reports **0/4**: phantom-Done watcher ACCEPTS the same frontmatter `readEvidence()` FATALS (`kind==='absent'`); `Failed` non-terminal → 3 failed *polish* tickets atop 10 Done *build* tickets sink the phase | *(this PRD — STOP adding)* |
| **06-23** | **R-CECX run-3** | **codex, multi (LOA-1488, 17t)** | workers committed **11/12** correctly (attribution intermittent, not categorical); **one** untagged commit tripped the gate (R-CECB face on codex); **no corruption** (commits landed → no clobber — confirms the thesis); manager **exited pickle at iter 49/500 with 4 hardening tickets `Todo`, never attempted** (premature phase-queue drain) | *(this PRD — STOP adding)* |

The cluster's own reports name the trap — R-CECB: *"the same defect class the cluster has chased for ~6
failed-fix recurrences."* B-PCOMP: *"Adding a third grammar branch is the N+1 trap."* B-AFCC-DEEP: *"single
conceptual entity ('is this ticket attributably done?') split across 3+ modules with divergent invariants —
the lack of a central Interface IS the bug."*

### 1.2 The invariant that is never actually enforced

> **A ticket can be marked Done while its work is not a durable commit on the branch — and two different
> oracles can disagree about whether it is.** The Done-flip is decoupled from work durability; everything
> downstream is archaeology trying to reconstruct, after the fact, whether the work landed — by multiple
> readers that do not even agree.

B-PCOMP correctly diagnosed half of it — *"the gate validates a bookkeeping artifact instead of the repo
state"* — and made the FINISH gate **read** the branch. But it left two assumptions unexamined:

1. **That there is a commit on the branch to read** (R-CECX: codex committed nothing → reconcile-against-void
   → 0/4; *and* a later context-cleared worker clobbered an earlier ticket's uncommitted shared-file edits →
   module throws at import — a **data-integrity** defect, not a halt).
2. **That a single oracle reads it** (R-PFNT: the phantom-Done watcher accepts `completion_commit: 9adfed909`
   as *"valid completion_commit evidence"* while the flip-gate `readEvidence()` fatals the **same**
   frontmatter as `kind==='absent'` — two oracles, opposite verdicts — *and* a non-terminal `Failed` on 3
   polish tickets sinks 10 green build tickets to 0/4).

Both R-CECX faces (non-durability, cross-iteration clobber) and both R-PFNT faces (oracle disagreement,
Failed-masks-green) are the **same missing guarantee**: *Done ⟺ a single oracle confirms a durable
runner-authored commit of the ticket's diff exists, and phase-completion is computed from that, not from a
worker-written artifact or a non-terminal status.*

### 1.3 Why "make codex commit" / "add a codex default" is the wrong (N+1) framing

The tempting fixes — "the codex worker contract should run `git commit`," "default
`allow_inferred_completion_commit=true` for codex" — are fixes #14 and #15 of the same shape: they depend on
an LLM worker reliably performing a step, on a backend (codex) that **bypasses the PreToolUse hooks** (codex
scope enforcement is already runner-side for exactly this reason), and they *add* another flag. Fourteen data
points say worker-discipline-as-correctness does not hold.

**Worker commit is *intermittent*, which is worse than categorical (R-CECX run-3, LOA-1488).** That run's
workers committed **11 of 12** tickets correctly, with hash-tagged subjects *and* `completion_commit`
frontmatter — yet the phase still halted 0/4, because **one** untagged commit tripped the gate (the R-CECB
"committed-but-unattributed" face, recurring on codex post-B-PCOMP). Intermittent worker-discipline cannot be
gated reliably from the worker side; the runner must make durability **and** attribution deterministic.
Run-3 also **confirms the corruption thesis**: because the workers committed, there was **no** cross-iteration
clobber — the missing commit *is* the corruption cause, so making the commit always exist makes the corruption
structurally impossible.

The honest fix inverts the layer: **stop inferring durability after the fact; enforce it at the boundary, read
it through one oracle, and derive phase-completion from it.** The runner — which already commits gate-passing
work on the *exit* path (`commitGatePassingDeliverableOnExitPath`, `extension/src/bin/mux-runner.ts:4936`) and
already captures a per-iteration HEAD baseline (`preIterSha`, `mux-runner.ts:9932`) — must commit at the
**normal** boundary too. Then there is always a commit, always authored and attributed by the *runner*, read
by *one* oracle, and the entire evidence-archaeology layer collapses.

### 1.4 Why the two prior *subtraction* attempts didn't hold (and why B-DURA is different)

B-AFCC-DEEP and B-PCOMP are the only two of fourteen that touched the root, and each **consolidated the
*reading* of completion state without making the *writing* of the commit a runner-enforced precondition:**

- **B-AFCC-DEEP (05-28)** collapsed 8 Done-stamping *readers* into one `TicketCompletionEvidence` oracle and
  deleted 300 LOC — but left the **commit produced by the worker**. A clean oracle still returns *absent* when
  the worker never committed (R-CECX) or committed un-attributably (R-CECB).
- **B-PCOMP (06-20)** made the oracle **read the branch** — right, and it fixed R-CECB — but "read the branch"
  assumes the branch has the work (R-CECX) and that the watcher and the flip-gate are the *same* oracle
  (R-PFNT proves they are not).

**The invariant has been in the codebase the whole time — on the wrong side of the boundary.**
`.claude/commands/send-to-morty.md:102` already mandates: *"NEVER flip status: Done before the commit
exists."* It is **worker-discipline prose** — and fourteen incidents prove LLM workers (both backends) don't
honor it, and codex bypasses the hooks that might enforce it. B-DURA's single move is to **relocate that
existing invariant from worker-prose to runner-code**: the runner makes the commit exist, one oracle reads it,
phase-advance honors it.

---

## 2. The fix — one structural invariant, three derived guarantees

> **THE INVARIANT (B-DURA):** At every normal iteration boundary, the runner commits the ticket's gate-passing
> dirty work as a single runner-authored, ticket-attributed commit that moves HEAD off the per-iteration
> baseline `preIterSha` — *or* the ticket does not flip Done and context is not cleared. **One** oracle
> (`readEvidence`) reads that commit; phase-completion is computed from terminal ticket states, never masked by
> a non-terminal `Failed`.

### 2.1 Workstreams (all symbols re-verified at HEAD `54a8c68d`)

**WS-1 — Promote commit-at-boundary from the exit path to the normal path (load-bearing).**
`commitGatePassingDeliverableOnExitPath` (`mux-runner.ts:4936`) already commits a green dirty deliverable with
an attributable subject; today it fires only on salvage/cap/fatal exit. Lift the *same* primitive into the
per-iteration boundary: after a ticket's gate passes and **before context is cleared**, if HEAD has not moved
this iteration, the runner commits the gate-green dirty tree under the current ticket.
- **Baseline is `preIterSha`** — the HEAD SHA captured by `readHeadCommit(iterWorkingDir)` at
  `mux-runner.ts:9932` immediately before the worker spawn (NOT `state.start_commit` @2497, which false-passes
  every iteration ≥2; NOT `iterationStartMs` @2293-2297, a timestamp filter).
- **Idempotent no-op via HEAD-movement, not tree-dirtiness:** "already committed" = `postIterSha !== preIterSha`
  (`postIterSha = readHeadCommit` at iteration end, `mux-runner.ts:10593-10598`). Untracked
  `research_*.md`/`plan_*.md` artifacts leaving the tree dirty must NOT defeat the no-op — key on HEAD
  movement (`mux-runner.ts:2515` `wasted` signal), reusing the `${preIterSha}..HEAD` diff helper
  `hasScopedIterationWindowCommit` (`mux-runner.ts:8211`). **Reuse the committer; change *when* it runs.**
- **Worker-already-committed-but-untagged (R-CECX run-3 / R-CECB face):** when HEAD *did* move this iteration
  (`postIterSha !== preIterSha`) but the worker's commit subject lacks the `(hash)` tag and no
  `completion_commit:` frontmatter exists, the runner must **attribute** that existing commit — back-fill
  `completion_commit` from the `preIterSha..HEAD` window (the commit whose diff touches the ticket's declared
  files; WS-6's single-oracle Pass-2 `scanGitLogByFileTouch`) — **not** create a second commit. The boundary
  step is: *if HEAD moved, attribute; else if gate-green dirty, commit; else honest-failure.*

**WS-2 — Gate every Done-flip on a durable commit (close the "committed-nothing" + "two oracles" holes).**
A ticket may flip Done only if a runner-authored commit moving HEAD off `preIterSha` and touching the ticket's
declared files exists. The predicate must hold at **all 7** Done-flip paths — the 6 literal
`guardCompletionCommitBeforeDone` call sites (`mux-runner.ts:2601, 4764, 6937, 10491, 10976, 11051`) plus the
7th, `commitAndContinueDoneFlip` (~`mux-runner.ts:4701`). (R-CCRC was literally *"4 paths bypass the guard"* —
the regression net is a `describe.each` over the 7-site set; note 10491/10976 are already baseline-aware via
`previousTicketStartCommit` @9388.) **No new oracle:** the guard reads `readEvidence`, which WS-6 makes the
single authority.

**WS-3 — SUBTRACT the evidence-archaeology layer (the whole point).** Once WS-1/WS-2/WS-6 guarantee a
runner-authored commit always exists and one oracle reads it, the inference machinery has no job. Deletion
surface pinned at HEAD (all writers+readers of a flag drop in ONE ticket — half-state risk):
- **Delete `allow_inferred_completion_commit`** — writers `mux-runner.ts:2605, 4770` (recovery branches),
  readers `mux-runner.ts:4486, 7683` + `ticket-completion-evidence.ts:540`, doc-comments `mux-runner.ts:1148,
  4334` + `ticket-completion-evidence.ts:103`. (B-PCOMP *demoted* it; B-DURA *deletes* it.)
- **Collapse `EvidenceKind`** (`ticket-completion-evidence.ts:46`) `explicit | inferred-fresh | inferred-stale
  | absent` → **`committed | absent`** (removes ≥2 variants; drop the `persist-inferred`/stale-keep branches).
- **Narrow Pass-1 only:** `scanGitLog` is two passes — Pass-1 `scanGitLogByRefToken`
  (`ticket-completion-evidence.ts:365`, the R-CCRC fuzzy widening → narrow) and Pass-2 `scanGitLogByFileTouch`
  (`:275`, the **R-CECB declared-file-touch correctness path — MUST NOT be removed**).
- **Free subtractions (zero behavior change):** delete the `@deprecated R-AFCC-DEEP-4A`
  `hasCompletionCommit` shim (`extension/src/services/pickle-utils.ts:1185`, callers already migrated to
  `readEvidence`) and the dead `'unreachable'` variant of `CompletionCommitEvidence['source']`
  (`pickle-utils.ts:1051`).
- **Reduce the phantom-Done backfill watcher surface (B-PDBL)** — with no inferred path, the backfill-loop
  class disappears.

**WS-4 — Reinforce (do not rely on) the worker stamp.** Keep `.claude/commands/send-to-morty.md:102`'s
commit mandate, make it backend-agnostic, so the happy path needs no boundary back-fill. Belt-and-suspenders;
the runner is the suspenders.

**WS-5 — Hands-off e2e regression net, both backends, multi-ticket, shared-file contention.** Extend the
B-PCOMP AC-PCOMP-4 e2e to drive a **≥4-ticket** bundle where (a) workers commit nothing (codex shape) and (b)
two tickets edit the **same shared file** across a context clear. Assert: all tickets Done, each backed by a
distinct runner commit, the shared file contains **both** edits (no clobber), the tree imports clean, and the
pipeline reports **4/4** (not 0/4). The regression that would have caught both R-CECX and R-PFNT.

**WS-6 — One oracle; honest phase-completion (R-PFNT).** Collapse the finish-gate to a single oracle and make
phase-advance truthful:
- **One `readEvidence` oracle, frontmatter honored as `committed`.** The phantom-Done watcher and the
  flip-gate MUST call the same `readEvidence`; a present `completion_commit:` whose SHA is git-reachable reads
  `committed` everywhere (kills the R-PFNT "accept here, fatal there on the same frontmatter" split).
- **`Failed` is terminal for phase-advance.** A phase advances when every **non-`Failed`** ticket is Done and
  the branch diff is non-empty — a green build of N tickets is **not** sunk to 0/4 by K `Failed` polish
  tickets. (Out of scope, tracked as a sibling: the `wmw-auto-skip` `oversized_no_progress` *misclassification*
  that produced those spurious `Failed`s, and the Step-7e refinement-template fence — different subsystems;
  see §5.)
- **No premature phase-queue drain (R-CECX run-3 defect b).** The pickle phase MUST NOT exit while any
  **non-`Failed`** ticket is still `Todo`/`In Progress` AND the iteration budget is unspent. LOA-1488's manager
  exited at **iter 49/500** with 4 hardening tickets never attempted → 0/4. The phase-completion predicate is:
  *advance only when every ticket is terminal (`Done` or `Failed`); otherwise, with budget remaining, keep
  draining the queue.* This is distinct from the evidence-attribution bug — a real "exits with work undone"
  defect — and pairs naturally with the `Failed`-terminal rule as the two halves of an honest phase-completion
  predicate.

### 2.2 No-clobber is by commit, not by attribution (AC-DURA-2 mechanism)
`partitionExitPathDirtyByOwnership` (`mux-runner.ts:4848`) marks a path `foreign` only if it lives under
another ticket's session-dir prefix — source under `extension/src/**` is **never** under a session dir, so it
is unconditionally `owned`. Therefore no-clobber is achieved by **committing the entire gate-green dirty source
tree under the current ticket at every boundary** (so no sibling source crosses a context-clear uncommitted),
with the boundary commit's staged paths constrained to ⊆ the current ticket's declared allowlist, and any
genuinely foreign residue routed through `stashUnattributableRemainder` (`mux-runner.ts:4891` →
`refs/pickle/salvage/<session>`, called @4970/4980), never committed under the failing ticket.

---

## 3. Definition of done — the actual release gate

- **AC-DURA-1 (durability):** a ≥4-ticket additive bundle whose workers commit **nothing** runs to
  all-tickets-Done with **0 `done_without_commit_evidence` fatals**; every Done ticket has a distinct
  runner-authored commit (HEAD moved off its `preIterSha`) containing its declared file diff.
- **AC-DURA-2 (isolation / no clobber):** in a bundle where ticket B edits a shared file ticket A already
  edited across a context clear, the final file contains **both** edits and the tree imports clean; the
  boundary commit's staged paths ⊆ the current ticket's allowlist. (Direct R-CECX regression.)
- **AC-DURA-3 (honest failure — universal-quantifier invariant):** **for *every* Done-flip path** (the 6
  `guardCompletionCommitBeforeDone` call sites + `commitAndContinueDoneFlip`), a ticket is refused Done **and**
  context is **not** cleared when, after the WS-1 boundary-commit attempt, HEAD did not move
  (`postIterSha === preIterSha`) and the tree is clean — i.e. genuinely nothing was produced (the R-CECX
  shape). Verify: `describe.each` over the 7-site set. This governs the **normal boundary only** and MUST NOT
  alter the recovery-path zero-diff terminal at `mux-runner.ts:5302-5310` (AC-GA-REC-4, `execute-converged-plan`
  adapter, keyed on `isWorkingTreeDirty===false` → already-realized → terminal-Done). A bundle that routes a
  nothing-produced ticket to Done, OR an already-realized ticket to honest-failure, fails this AC.
- **AC-DURA-4 (both backends):** AC-DURA-1..3 hold on **both** `--backend claude` and `--backend codex` — the
  codex LOA-1363 re-run completes 4/4.
- **AC-DURA-5 (subtraction — REQUIRED, net-negative):** `allow_inferred_completion_commit` deleted (all
  writers+readers); `EvidenceKind` reduced ≥2 variants; `@deprecated hasCompletionCommit` shim + dead
  `'unreachable'` variant deleted; Pass-1 ref-token grep narrowed (Pass-2 file-touch retained); net flags +
  grammar branches added **< 0**. A diff that only adds is a failed bundle.
- **AC-DURA-6 (one oracle, honest phases — R-PFNT):** the phantom-Done watcher and the Done-flip gate return
  the **same** verdict for the same frontmatter (no accept-vs-fatal split); a phase with N Done green tickets +
  K `Failed` tickets and a non-empty branch diff advances (reports its true phase count), never 0/4.
- **AC-DURA-7 (no premature drain — R-CECX run-3 defect b):** the pickle phase does **not** exit while any
  non-`Failed` ticket is `Todo`/`In Progress` and the iteration budget is unspent; it advances only when every
  ticket is terminal. Verify: a synthetic phase with an unattempted `Todo` hardening ticket and budget
  remaining keeps draining rather than reporting 0/4.
- **AC-DURA-8 (attribution of an untagged worker commit — R-CECX run-3):** a ticket whose worker committed
  (HEAD moved off `preIterSha`) with a subject lacking the `(hash)` tag and no `completion_commit:` frontmatter
  is **attributed** (back-filled from the `preIterSha..HEAD` file-touch), reaches Done, and is **not**
  re-committed or fataled.
- **AC-DURA-9 (e2e net):** WS-5's multi-ticket, both-backend, shared-file, reports-4/4 e2e is green on the
  local gate.

---

## 4. ## Simplification Review (subtract-before-add — required)

1. **Necessary at all?** WS-1 adds **no** committer (relocates `commitGatePassingDeliverableOnExitPath`).
   WS-2 adds one gate predicate (durable-commit-exists) that **replaces** the multi-kind evidence policy. WS-3
   is **pure subtraction**. WS-6 **merges two oracles into one** (net-negative) + one phase-advance predicate.
   WS-5/7 add tests (the point — we cannot currently prove cross-iteration durability or honest phase-count).
   Only genuinely new surface: the boundary-commit *call site*, reusing the exit committer and `preIterSha`.
2. **Reuse vs add?** Reuse `commitGatePassingDeliverableOnExitPath`, `preIterSha`/`postIterSha`/
   `hasScopedIterationWindowCommit`, `readEvidence`, `partitionExitPathDirtyByOwnership`,
   `stashUnattributableRemainder`, the existing Done-flip guard. The thesis is *reuse the exit committer at the
   normal boundary* and *make the watcher call the gate's oracle* — the opposite of a parallel mechanism.
3. **Guards brittle complexity that should be subtracted?** Yes, and it **subtracts it**: the brittle things
   are `allow_inferred_completion_commit`, the `inferred-*` kinds, the R-CCRC fuzzy grep, the B-PDBL backfill
   loop, the `@deprecated` shim, and the *two-oracle* disagreement. We delete/merge them — no eighth guard.
4. **What does it subtract?** A whole inference layer + one of two oracles: a flag (all sites), ≥2 evidence
   kinds, a fuzzy grep widening, a backfill-loop class, a deprecated shim, a dead union variant, the
   per-ticket back-fill recovery ritual, the worker-discipline-as-correctness dependence on **both** backends,
   and the watcher-vs-gate split. The pipeline gets **one invariant deep**: *Done ⟺ one oracle confirms a
   runner-authored commit of the ticket's diff exists; phases count terminal Done over that.*

---

## 5. Sequencing, risk, scope-out, and build protocol

- **Order:** WS-1 → WS-2 → WS-6 (durability + gate + single oracle/honest-advance) land first and are
  field-proven on a real multi-ticket bundle; **only then** WS-3 subtracts the now-dead inference layer;
  WS-4/WS-5/WS-7 ride along. Never subtract before the replacement is proven.
- **Touch points (repo-rooted):** `extension/src/bin/mux-runner.ts` (boundary commit @~9932/10593, the 7
  Done-flip guard sites, salvage path, phase-advance); `extension/src/services/ticket-completion-evidence.ts`
  (EvidenceKind collapse, single `readEvidence`, scanGitLog Pass-1 narrow); `extension/src/services/
  pickle-utils.ts` (delete shim @1185 + dead union @1051); `extension/src/lib/salvage-ticket.ts` +
  `extension/src/lib/reconcile-ticket-truth.ts`; `.claude/commands/send-to-morty.md:102` (WS-4); the
  integration e2e harness (WS-5). `schema_neutral: true` — deleting a best-effort flag read is not a schema
  bump.
- **Risk — boundary commit of not-green work:** commit **only** after the ticket gate passes (the precondition
  `commitGatePassingDeliverableOnExitPath` already enforces); a not-green ticket takes AC-DURA-3
  honest-failure.
- **Risk — over-attribution:** eliminated — the runner authors the commit for exactly the
  `preIterSha`→`postIterSha` diff of the current ticket.
- **Risk — flag-deletion atomicity / mid-flight recovery sessions:** the two `allow_inferred_completion_commit`
  writers (2605/4770) are in recovery branches; deleting them changes the recovery state machine for any
  session mid-flight at `install.sh` time. WS-3 must (a) drop all writers+readers atomically in one ticket and
  (b) add an explicit pre-deploy check that no active session has the flag persisted in its live `state.json`
  (the R-PSRB serialized deploy makes this safe — make the check explicit).
- **Scope-out (tracked as a sibling, not in B-DURA):** R-PFNT's `wmw-auto-skip`
  `oversized_no_progress`-misclassification (split → `scope_unresolvable`/`no_progress_timeout`) and the
  Step-7e refinement-template `## Files to modify/create` fence + toolchain fail-fast — different subsystems
  (auto-skip classifier, refinement skill); keeping them out keeps the recovery-machinery hand-build focused.
- **⚠️ BUILD PROTOCOL (R-PSRB self-referential catch-22):** this bundle edits the salvage/no-progress/
  completion machinery the deployed runtime is *running*. Per `prds/CLAUDE.md` + the B-PCOMP precedent it
  **cannot be built by an autonomous `/pickle-pipeline`** — the pre-fix runtime salvage-resets/fatals the
  ticket building the fix. Load-bearing WS-1/WS-2/WS-6 tickets MUST be **hand-built in-process** (agent team,
  atomic per-ticket commits), then `install.sh`-deployed, so WS-3/4/5 run on the fixed runtime.
- **⚠️ BACKEND:** build on **claude**, not codex. Codex is the *trigger* (under-commits, bypasses hooks) and
  the *thing to field-prove against after the fix* (re-run LOA-1363 = AC-DURA-4) — not a safe build backend
  for the recovery machinery.

---

## 6. Why this is the GA path

GA was gated on **field-soak repeatability**, and the ledger now reads *1 clean (claude, single-ticket) +
codex 0-for-3* (LOA-1363 run-1 → R-CECX, run-2 → R-PFNT, run-3 → narrowed residual). R-CECX and R-PFNT are
not scattered new bugs — they are the **same seam that has broken every hands-off run for fourteen
recurrences**, finally exposed on the one shape (codex × multi-ticket × shared-file) that B-PCOMP's single
live proof never covered. Enforcing durability at the boundary, collapsing to one oracle, and making
phase-advance honest is the smallest change that (a) closes the committed-nothing hole, (b) makes
cross-iteration corruption structurally impossible, (c) stops a green build reporting 0/4, and (d) lets us
**delete** the inference layer and one of two oracles instead of growing them a fifteenth branch. That is
reliability and simplification and autonomy in one move — the last completion-class seam between beta.22 and
dropping `-beta` on **both** backends.

---

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | 5c8c74bc | Commit the ticket's gate-passing work at every iteration boundary | High | HEAD 54a8c68d; build on claude | Normal-boundary commit/attribute/honest-fail; every Done backed by a runner commit off preIterSha; `boundary_commit_resolved` emitted; deployed via install.sh | extension/src/bin/mux-runner.ts, extension/src/services/ticket-completion-evidence.ts, extension/src/types/index.ts, extension/tests/boundary-commit-at-iteration.test.js (forward-created) |
| 20 | b125e0a8 | All 7 Done-flip paths gate on a durable runner-authored boundary commit (parametrized) | High | T10 committed AND deployed | 7 sites share one durable-commit predicate via readEvidence; recovery terminal :5302-5310 unchanged; deployed | extension/src/bin/mux-runner.ts, extension/tests/doneflip-gate-all-callsites.test.js (forward-created) |
| 30 | 7c58d4cb | One readEvidence oracle: phantom-Done watcher and flip-gate agree on the same frontmatter | High | T20 committed AND deployed | Watcher ≡ gate verdict; present+reachable completion_commit reads committed everywhere; deployed | extension/src/services/ticket-completion-evidence.ts, extension/src/bin/mux-runner.ts, extension/tests/one-readevidence-oracle.test.js (forward-created) |
| 40 | df0bd2c1 | Failed is terminal-for-phase-advance under one guarded predicate at all 4 count/classification sites — runnability site unchanged | High | T30 committed AND deployed | 4 count sites share the conjunctive guard; green build never 0/4; isPendingMuxTicket unchanged; no parallel state set; deployed | extension/src/bin/mux-runner.ts, extension/src/lib/reconcile-ticket-truth.ts, extension/tests/failed-terminal-all-count-sites.test.js (forward-created) |
| 50 | 7c18fa59 | Pickle phase does not drain its queue prematurely | High | T40 committed AND deployed | Phase advances only when every ticket terminal; keeps draining with budget remaining; deployed | extension/src/bin/mux-runner.ts, extension/tests/no-premature-drain.test.js (forward-created) |
| 60 | 96b31211 | Delete allow_inferred_completion_commit (all writers, readers, comments) atomically | High | T10–T50 committed AND deployed via install.sh | Flag fully deleted in one commit; pre-deploy live-state check present | extension/src/bin/mux-runner.ts, extension/src/services/ticket-completion-evidence.ts, extension/tests/allow-inferred-completion-commit-deleted.test.js (forward-created) |
| 70 | 314093f7 | Collapse EvidenceKind to {committed,absent}; narrow Pass-1 grep; delete deprecated shim + dead variant | High | T10–T50 deployed AND T60 | EvidenceKind ≤2 variants; Pass-2 retained; shim + dead variant deleted; net-negative delta | extension/src/services/ticket-completion-evidence.ts, extension/src/services/pickle-utils.ts, extension/tests/evidence-kind-collapse.test.js (forward-created) |
| 80 | 89d45b17 | Make the worker completion-commit mandate backend-agnostic | Medium | HEAD 54a8c68d | Backend-agnostic mandate present; README in sync | .claude/commands/send-to-morty.md, README.md |
| 90 | b499487d | Wire: hands-off e2e — multi-ticket, both backends, shared-file, reports 4/4 | High | ALL prior (T10–T80); T10–T50 deployed | Multi-ticket both-backend shared-file e2e green; all Done; 4/4 not 0/4; no clobber | extension/tests/integration/pipeline-completion-handsoff-e2e.test.js (forward-created) |
| 100 | bd42a5fc | Harden: code quality review of durable iteration boundary | High | All prior complete; suite passes | Zero P0-P1 violations in MODIFIED_FILES; atomic harden commits | extension/src/bin/mux-runner.ts, extension/src/services/ticket-completion-evidence.ts, extension/src/services/pickle-utils.ts, extension/src/lib/reconcile-ticket-truth.ts, extension/src/lib/salvage-ticket.ts, .claude/commands/send-to-morty.md, test files |
| 110 | 6397a0e2 | Audit: data flow integrity for durable iteration boundary | High | All prior incl. code-quality hardening complete | Zero CRITICAL+HIGH data-flow findings or trap-door-documented | extension/src/bin, extension/src/services, extension/src/lib, .claude/commands + test files |
| 120 | c37f67c2 | Harden: test quality review of durable iteration boundary | High | All prior complete; suite passes | Every AC mapped to a test; zero P0-P1 assertion gaps | extension/tests/* (all bundle test files) |
| 130 | b81b9e7e | Audit: cross-reference consistency for durable iteration boundary | High | All prior complete; suite passes | Zero CRITICAL+HIGH cross-ref mismatches; commands deployed [manager] | .claude/commands/send-to-morty.md, README.md, CLAUDE.md, extension/CLAUDE.md + MODIFIED_FILES |
