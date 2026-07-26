# B-GITATTR — Git-authoritative completion attribution

**Priority:** P1
**Branch base:** `release/v2.1-beta` (post v2.1.0-beta.7)
**Thesis:** *"Did this ticket produce this commit?" is a fact git can record. Stop inferring it.*

---

## §0 AUTHOR'S RETRACTION — the filed premise was half false

This PRD supersedes MASTER_PLAN drain row 1c. **Two of its claims were regrounded at HEAD `b5ac116d`
on 2026-07-26 and one is FALSE.** Recorded here because the row's framing would have aimed the bundle
at the wrong side of the seam.

**FALSE — "make attribution git-authoritative … attribution derived from the files the ticket
declared."** That is *already shipped*. `scanGitLogByFileTouch` (R-CECB,
`ticket-completion-evidence.ts:402`) is exactly declared-file attribution, running as Pass 2 behind
the message-matched Pass 1. It is **fully wired**, not inert: `greenGate` at `mux-runner.ts:4789`
(`extensionGreenGate`), `declaredFiles` from `readDeclaredFiles(content)` at `:633`,
`siblingDeclared` at `:642`. A bundle scoped to "add file-based attribution" would have re-built
shipped code.

**TRUE, and narrower than filed — the real defect is that ticket `a3c75c96` had ZERO attribution
channels**, because the two that exist each have a precondition the refinement templates violate:

| Channel | Mechanism | Why it failed on `a3c75c96` |
|---|---|---|
| Pass 1 | `scanGitLogByRefToken` — word-boundary ticket-id / `r_code` in the commit message | `pickle-refine-prd.md` audit/harden templates specify `audit: [CRITICAL/HIGH] cross-ref — [description]` and `harden: [principle] — [description]` at **5 sites**, none carrying a ticket-hash component (contrast the fix-ticket convention `fix(pipeline-runner): 822bb80e — …`) |
| Pass 2 | `scanGitLogByFileTouch` — declared in-scope file touch | `readDeclaredFiles` (`ticket-declared-files.ts`) recognizes only `**Files to modify\|create**:` plus 4 headings. The audit template emits `**Doc files (DOC_FILES)**:` and `**Implementation files (read-only)**:`, so it returns `[]` and the `declaredFiles.length > 0` gate at `:477` **skips Pass 2 entirely** |

So the observed chain — 4 real commits land → oracle cannot attribute → evidence absent →
phantom-Done watcher reverts the Done flip (`ticket_phantom_done_corrected` +
`ticket_state_desync_detected`) → manager reopens → parked, **3× on `a3c75c96`** — is a
**label/token vocabulary mismatch between two shipped subsystems**, not an architectural gap. Every
operator Done-flip there was correctly undone by a working guard.

**Why this PRD still does the big thing rather than the small thing.** Two small fixes are available
(add the hash to 5 templates; widen the declared-files vocabulary). **Both are read-side proxy
patches** — the first depends on an LLM typing a token correctly, the second widens a regex that will
drift again the next time a template gains a label. The recurrence is template-level, so it returns on
every bundle. The subtractive fix is to record the fact at write time and delete the inference.

---

## §1 Feasibility — measured, not assumed

Workers commit via their own `git commit` in bash (prompted by `.claude/commands/*.md`); there is **no
runtime commit callsite** for worker commits to wrap. `commit --amend` is a prohibited git verb
(R-WSRC-GR), so the trailer cannot be added after the fact.

**Probe run 2026-07-26 — the mechanism works.** `core.hooksPath` injected purely through
`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` in the subprocess env, with a
`prepare-commit-msg` hook reading `PICKLE_TICKET_ID`:

```
subject:  audit: [HIGH] cross-ref — no ticket hash in this subject
result:   audit: [HIGH] cross-ref — no ticket hash in this subject
          <blank>
          Pickle-Ticket: a3c75c96
git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'  ->  a3c75c96
git config --local --get core.hooksPath                        ->  (absent)
```

Three properties this buys: the trailer lands on the *exact* subject shape that fails today; **git
itself** is the parser (`%(trailers:…)`), so attribution is a lookup; and the **target repo is
unmutated** — env-scoped config dies with the process, preserving the repo-agnostic invariant.

**The hazard that must be handled (see Risks R1):** `core.hooksPath` redirects **all** hooks, so a
target repo with its own `pre-commit` (husky, lint-staged) would silently lose it. Forwarding is a
hard requirement of WS-1, not a nicety.

---

## §2 Workstreams

Ordered. WS-3 (the deletion) lands only after WS-1+WS-2 are proven, so a producer bug can never
strand attribution with the inference already removed.

### WS-1 — Trailer producer (write-time truth)

A pickle-managed hooks directory containing a `prepare-commit-msg` hook that appends
`Pickle-Ticket: <ticket-id>` when `PICKLE_TICKET_ID` is set and no such trailer is already present
(idempotent). `core.hooksPath` and `PICKLE_TICKET_ID` are injected via the existing worker/manager
spawn env seam (`backendEnvOverrides` / `buildWorkerInvocation`), never written to target-repo config.

**Forwarding is mandatory.** WS-1 resolves the target repo's effective pre-existing hooks directory
(`core.hooksPath` if set, else `$GIT_DIR/hooks`) and generates a forwarding stub for **every** hook
the repo already defines, so redirecting `hooksPath` cannot disable a repo's own hooks. Our
`prepare-commit-msg` appends the trailer, then execs the original if one exists, preserving its exit
code.

If the pre-existing hooks directory cannot be resolved, WS-1 **skips injection and logs** rather than
redirecting — degrading to today's read-side behavior is acceptable; silently disabling a target
repo's `pre-commit` is not.

Applies to codex as well as claude: codex runs real `git` in the real worktree and inherits the spawn
env, so repo-local hook resolution is unaffected by `--ignore-user-config` (which governs *user*
config). This is NOT the rejected reference-transaction-hook design in the `backend-spawn.ts` R-CXOR-3
trap door — that rejection was about intercepting git *verbs* for enforcement; this is a commit-message
trailer with a graceful skip.

### WS-2 — Trailer consumer

`readEvidence` gains a trailer lookup as the highest-precedence **scan** path, immediately after the
explicit `completion_commit` field and before any message inference: read
`git log --format=%H%n%(trailers:key=Pickle-Ticket,valueonly)` over the post-`startTimeEpoch` window
and attribute on an exact ticket-id match. Reuses the existing reachability
(`probeExplicitSha`/`commitExists`) and baseline-rejection (`isBaselineSha`, R-CXOR-2) guards
unchanged. A trailer naming a **different** ticket is foreign attribution and is refused, exactly as
`isForeignAttributedExplicitSha` refuses today.

### WS-3 — The subtraction (the point of the bundle)

Once WS-1+WS-2 are proven, delete the message-inference surface. Named deletions:

- `scanGitLogByRefToken`, `guardScanHit`, `extractRCodeTokens`, `commitMessage` (message matching)
- `scanGitLogByFileTouch`, `touchesDeclared`, `commitTouchedFiles`, `enumerateSiblingDeclaredFiles`
  and the `greenGate` / `declaredFiles` / `siblingDeclared` plumbing on `scanGitLog` (Pass 2)
- the evidence module's **`readDeclaredFiles` import and its two call sites** (`:385` inside
  `enumerateSiblingDeclaredFiles`, `:633` in the ctx builder) — **but NOT the module itself**

  ⚠️ **CORRECTED 2026-07-26 by refinement (cycle 3) — the original draft said "delete the whole
  `ticket-declared-files.ts` module (85 lines)" and that is WRONG.** `readDeclaredFiles` has **three
  live non-attribution consumers**: `pipeline-runner.ts:73` (used at `:555`/`:619`/`:933` — the
  crashed-ticket quarantine dirty-tree guard and scope auto-extension), `check-readiness.ts:15`
  (`:1204` — the readiness signature-caller-gap check), and `mux-runner.ts:28` (`:2074`). Deleting the
  module would break the dirty-tree guard, the readiness gate, and a mux-runner path — three
  subsystems with nothing to do with attribution. **`ticket-declared-files.ts` SURVIVES, PINNED**
  (AC-GA-8b), so a future worker "finishing the deletion" cannot silently break those guards. This is
  the beta.33 gate-overreach lesson landing on the very PRD that cited it in R4: the author grepped
  `extensionGreenGate` and did not grep `readDeclaredFiles`.
- `extensionGreenGate` (`mux-runner.ts:4738`) **and** its `import type { GateVerdict }` in the evidence
  module — **measured 2026-07-26: exactly one consumer**, the attribution ctx at `mux-runner.ts:4789`, so
  it becomes dead code the moment WS-3 lands. The `GateVerdict` *type* itself SURVIVES — it is owned by
  `lib/salvage-ticket.ts` and has unrelated consumers; only the evidence module's import goes.
  (This resolves Risk R4 by grep rather than leaving it for the worker.)

**Honest scope of the deletion.** The two modules total **1,209 lines** (`ticket-completion-evidence.ts`
1,124 + `ticket-declared-files.ts` 85). WS-3 removes the *inference* subset, not the file. **Explicitly
NOT deleted** (orthogonal, load-bearing): the explicit-field path (R-RIC-EXPLICIT), reachability probes,
baseline rejection (R-CXOR-2), `persistEvidence`, the zero-diff arm (B-GTRUTH WS-A1), the R-CWGE
worker-gate verdict, `evaluateCompletionEvidence`'s ladder, and the 2-state `EvidenceKind`. A
line-count target is deliberately NOT an AC — the AC is the named-symbol list above.

**Backward compatibility is time-bounded, not permanent.** Attribution only ever asks about commits
made after the session's `start_commit`/`startTimeEpoch`, so a session started *after* deploy sees only
trailered commits. The scan is therefore genuinely deletable rather than needing an indefinite
fallback. The one exposed case — a session in flight across the deploy — is an accepted, operator-visible
degradation (Risks R2), not a supported mode.

### WS-4 — R-NSG-AJBE sibling parity, and widen the invariant that missed it

Confirmed verbatim at `pipeline-runner.ts`: on an **exit-0 (passing)** finalize-gate,
`runJudgeTimeoutFinalizeGate` (`:4066`) does `counters.completed++` → `{action:'continue'}`, while
`runAllBackendsExhaustedFinalizeGate` (`:4101`) does `reportPhaseIncomplete` →
`{action:'break', phaseIncomplete:true}`. Same passing gate, opposite dispositions — the
B-NOSTOP-GATES ONE RULE violated in the 6th function that bundle's 5-site inventory never named.
Make it match its sibling (~3 lines).

**The generalization matters more than the 3 lines.** B-NOSTOP-GATES shipped the right instrument —
AC-NSG-5b, an invariant test that no incomplete-reason reaches `dispatchHaltAction` — and AJBE survived
because the invariant's *reach* excluded the recovery-gate return paths. WS-4 extends AC-NSG-5b to cover
every `PhaseIterationOutcome` producer, so the next sibling cannot survive by living in an unenumerated
function. Fixing sites is not the deliverable; the invariant's coverage is.

### WS-5 — Verification that RUNS it

A ticket that executes a real pipeline on this repo and asserts from the run's own artifacts that a
commit authored under the **unchanged** audit/harden template (no ticket-hash in the subject)
attributes by trailer, with **no** `ticket_phantom_done_corrected` / `ticket_state_desync_detected`
for that ticket, and names the next blocker if one appears. A green unit suite is not evidence that the
recurrence is dead; the recurrence was only ever observed in a live run.

---

## §3 Simplification Review

**WS-1 — necessary?** Yes; it is the only write-time truth source, and it is the *sole* addition in the
bundle. **Reuse?** Yes — the existing spawn-env seam (`backendEnvOverrides`); no new config surface, no
target-repo mutation, no new state field. **Guards brittle complexity?** It replaces the brittleness
rather than guarding it: the templates stop being load-bearing. **Subtracts?** Enables WS-3.

**WS-2 — necessary?** Yes, minimal: one lookup branch. **Reuse?** Yes — existing reachability,
baseline-rejection and foreign-attribution guards, unchanged. **Guards brittle complexity?** No; it
*replaces* two inference passes. **Subtracts?** Makes WS-3 possible.

**WS-3 — necessary?** Pure removal — the ideal case, no justification required. **Subtracts?** The
entire message-inference surface plus one whole module.

**WS-4 — necessary?** No new code; a 3-line disposition change plus widened invariant *coverage* (not a
new gate). **Guards brittle complexity?** It removes a halt path — the same subtraction B-NOSTOP-GATES
made. **Subtracts?** One `break` path, and the class of "residual site survives a per-site fix."

**WS-5 — necessary?** Verification only, no production code.

**Net:** one addition (WS-1 producer), two replacements (WS-2, WS-4), one substantial deletion (WS-3).
The system ends flatter: attribution goes from a two-pass inference engine with sibling-ambiguity
resolution to a git trailer lookup.

---

## §4 Acceptance criteria (machine-checkable)

- **AC-GA-1** A commit made by a worker subprocess with `PICKLE_TICKET_ID` set carries exactly one
  `Pickle-Ticket: <id>` trailer, readable via
  `git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'`. Type: test
- **AC-GA-2** The hook is idempotent: a message already carrying `Pickle-Ticket:` is unchanged (no
  duplicate trailer). Type: test
- **AC-GA-3** No target-repo mutation: after a worker commit, `git config --local --get core.hooksPath`
  is absent (or byte-identical to its pre-session value). Type: test
- **AC-GA-4** Hook forwarding: a target repo with a pre-existing `pre-commit` **and**
  `prepare-commit-msg` still executes both, and their non-zero exit codes still block the commit.
  Type: test
- **AC-GA-5** Unresolvable pre-existing hooks dir → injection skipped, one log line emitted, commit
  proceeds without a trailer. Type: test
- **AC-GA-6** `readEvidence` attributes a commit whose subject contains **no** ticket-id and **no**
  `r_code`, solely via its trailer, returning `kind:'committed'`. Type: test
- **AC-GA-7** A trailer naming a different ticket is refused as foreign attribution (parity with
  `isForeignAttributedExplicitSha`). Type: test
- **AC-GA-8** **Every** symbol in the deletion set is absent **from its own home module** — NOT from the
  whole tree. The set is declared **once** as a `DELETED_SYMBOLS` array of `{ symbol, homeFile }` pairs
  in the test, asserted via `describe.each(DELETED_SYMBOLS)`, one case per member, no hand-maintained
  alternation regex. Members, all module-private: `scanGitLogByRefToken`, `guardScanHit`,
  `extractRCodeTokens`, `commitMessage`, `scanGitLogByFileTouch`, `touchesDeclared`,
  `commitTouchedFiles`, `enumerateSiblingDeclaredFiles` → home `src/services/ticket-completion-evidence.ts`;
  `extensionGreenGate` → home `src/bin/mux-runner.ts`. Type: test

  ⚠️ **Per-file scoping is load-bearing, not stylistic — a whole-tree grep is UNSATISFIABLE here.**
  Measured 2026-07-26: `commitMessage` is a **name collision**, not a shared symbol —
  `microverse-runner.ts:3534` uses it as a local `const` holding a git subject and `bundle-finalize.ts`
  uses it as a DTO field/parameter name, both unrelated to the evidence module's private
  `commitMessage(workingDir, sha)` at `:265`. A whole-tree absence assertion would order the deletion of
  a field name and a local variable in two innocent modules. Every member here is module-private, so the
  home-file invariant is both satisfiable and the one that actually means "the inference is gone".

  *Shape rationale (refinement `ac_shape_smells`, AC-GA-8):* the first draft enumerated 7 symbols in a
  single alternation grep with no universal quantifier — and §2's list had **already drifted** from §4's,
  adding four symbols the AC omitted. Enumeration in two places is the drift. One quantified invariant
  over one declared set replaces both. Collapsed to a single parametrized ticket rather than fanned out
  per symbol: the predicate is identical across members and one deletion commit removes all or none, so
  per-symbol tickets would strand intermediates behind a non-compiling tree.

- **AC-GA-8b** **Survival pin (the counterweight to AC-GA-8):** `extension/src/services/ticket-declared-files.ts`
  **still exists**, still exports `readDeclaredFiles`, and still has **at least 3 importer files** in
  `extension/src/` outside `ticket-completion-evidence.ts` — currently `pipeline-runner.ts`,
  `check-readiness.ts`, `mux-runner.ts`. Only the evidence module's import and its two call sites are
  removed. Type: test

- **AC-GA-8c** **Trap-door reconciliation.** `extension/src/services/CLAUDE.md` contains no `ENFORCE:` or
  `PATTERN_SHAPE:` anchor naming a deleted symbol; the R-CECB declared-file-touch trap-door entry is
  removed or rewritten to describe the trailer contract instead. Verify:
  `bash extension/scripts/audit-trap-door-enforcement.sh` passes and a grep of
  `src/services/CLAUDE.md` for each `DELETED_SYMBOLS` member returns `0`. Type: test

  *Why this is an AC and not cleanup:* `enumerateSiblingDeclaredFiles` currently appears once in
  `src/services/CLAUDE.md` as a live trap-door anchor. Deleting the code without reconciling that entry
  leaves an ENFORCE anchor pointing at a symbol that no longer exists — which `audit-trap-door-enforcement.sh`
  and citadel's trap-door-coverage analyzer both read. That is exactly the orphan-anchor finding class
  that burned 3 citadel remediation cycles for 0 commits on the `AP-RMS-*` anchors in the beta.7 run. A
  deletion that leaves its own doc anchors dangling manufactures the noise it should be removing.
- **AC-GA-9** `runAllBackendsExhaustedFinalizeGate` returns `{action:'continue'}` on gate exit 0 and
  increments `counters.completed`, matching `runJudgeTimeoutFinalizeGate`. Type: test
- **AC-GA-10** AC-NSG-5b's widened form asserts that **no** `PhaseIterationOutcome` producer in
  `pipeline-runner.ts` returns `action:'break'` for a passing gate or for any reason in
  `INCOMPLETE_EXIT_REASONS`. Type: test
- **AC-GA-11** Live-run evidence (WS-5): a pipeline run on this repo shows an audit/harden-template
  commit attributed by trailer, with zero `ticket_phantom_done_corrected` for that ticket. Type:
  llm-conformance
- **AC-GA-12** Release gate green: `npx tsc --noEmit`, `eslint --max-warnings=-1`, the 9 audit
  scripts, `test:fast:budget`, `test:integration`. Type: test

---

## §4b Interface Contracts

**Producer — the `prepare-commit-msg` hook**
- **Inputs:** `$1: string` — path to the commit-message file (git-supplied). Env `PICKLE_TICKET_ID: string`
  (8-char hex ticket id); absent or empty → no-op `exit 0`.
- **Outputs:** the message file with `\nPickle-Ticket: <id>\n` appended exactly once.
- **Errors:** when a pre-existing `prepare-commit-msg` is present it is exec'd *after* the append and
  **its** exit code is returned verbatim — a non-zero pre-existing hook must still abort the commit.
- **Invariants:** idempotent (an existing `^Pickle-Ticket:` line yields no second trailer); never writes
  target-repo config; absent env leaves the message byte-identical.

**Producer — env injection at spawn**
- **Inputs:** `workingDir: string`, `ticketId: string`.
- **Outputs:** env fragment `{ GIT_CONFIG_COUNT, GIT_CONFIG_KEY_<n>: 'core.hooksPath',
  GIT_CONFIG_VALUE_<n>: <managed hooks dir>, PICKLE_TICKET_ID }`. **Must compose with an inherited
  `GIT_CONFIG_COUNT`** — append at index `n = existing count` and increment, never hardcode index `0`,
  or an inherited git env-config entry is silently clobbered.
- **Errors:** pre-existing hooks dir unresolvable → return **no** fragment and log; never a partial
  injection (hooksPath set without `PICKLE_TICKET_ID`, or vice versa).
- **Invariants:** no target-repo mutation; a forwarding stub exists for **every** hook name present in
  the repo's original hooks dir.

**Consumer — trailer lookup**
- **Inputs:** `{ workingDir: string, ticketId: string, startTimeEpoch?: number | null }`.
- **Outputs:** `{ sha: string } | null`.
- **Errors:** any git failure → `null` (best-effort, never throws — matches the existing scan contract).
- **Invariants:** exact ticket-id match only; a trailer naming a **different** ticket is refused as
  foreign attribution; reachability (`commitExists`) and baseline rejection (`isBaselineSha`) still apply.

## §4c Test Expectations

| AC | Test file | `@tier:` | Assertion |
|:---|:---|:---|:---|
| AC-GA-1 | `extension/tests/integration/gitattr-trailer-producer.test.js` | integration (serial) | real `git commit` in a temp repo yields exactly one trailer, readable via `%(trailers:key=Pickle-Ticket,valueonly)` |
| AC-GA-2 | same | integration (serial) | a message already carrying the trailer ends with trailer count `== 1` |
| AC-GA-3 | same | integration (serial) | `git config --local --get core.hooksPath` absent after the commit |
| AC-GA-4 | `extension/tests/integration/gitattr-hook-forwarding.test.js` | integration (serial) | pre-existing `pre-commit` **and** `prepare-commit-msg` both execute; a non-zero pre-existing hook aborts the commit |
| AC-GA-5 | same | integration (serial) | unresolvable hooks dir → no injection, one log line, commit succeeds trailer-less |
| AC-GA-6 | `extension/tests/integration/gitattr-trailer-consumer.test.js` | integration (serial) | a subject with no ticket-id and no `r_code` attributes via trailer, `kind === 'committed'` |
| AC-GA-7 | same | integration (serial) | a trailer naming a different ticket is refused as foreign attribution |
| AC-GA-8 | `extension/tests/gitattr-inference-deleted.test.js` | fast | `describe.each(DELETED_SYMBOLS)` — one case per symbol, each asserting zero occurrences in `extension/src/`; the set is declared once in this file |
| AC-GA-8b | same | fast | `ticket-declared-files.ts` exists, exports `readDeclaredFiles`, and has ≥3 importer files outside the evidence module |
| AC-GA-8c | same | fast | no `DELETED_SYMBOLS` member appears in `src/services/CLAUDE.md`; `audit-trap-door-enforcement.sh` passes |
| AC-GA-9 | `extension/tests/nostop-gates-sibling-parity.test.js` | fast | `runAllBackendsExhaustedFinalizeGate` returns `action:'continue'` and increments `counters.completed` on gate exit 0 |
| AC-GA-10 | `extension/tests/nostop-gates-invariant.test.js` (widen existing) | fast | every `PhaseIterationOutcome` producer is enumerated; none returns `break` for a passing gate or an `INCOMPLETE_EXIT_REASONS` reason |
| AC-GA-11 | WS-5 live run | n/a | session artifacts show trailer attribution and zero `ticket_phantom_done_corrected` for the ticket |

**Mandatory tiering constraint.** Every test above that spawns real `git` is subprocess-heavy and MUST be
`@tier: integration` **and** listed in `extension/tests/integration/.serial-tests.json`, with a matching
entry in `.serial-tests.reasons.json` (class: `subprocess-spawn-timing`). A `@tier: fast` git-spawning
test will starve at `--test-concurrency=8` and trip `audit-subprocess-heavy-tests.sh`. Per the
serial-manifest hygiene principle: never shrink a spawn timeout to make a load-starved test pass.

---

## §5 Risks

**R1 — `core.hooksPath` disables a target repo's own hooks.** The main hazard; a husky/lint-staged repo
would silently lose `pre-commit`. Mitigated by mandatory forwarding stubs (AC-GA-4) and skip-on-unresolvable
(AC-GA-5). **Accepted residual:** a hook added to the target repo *mid-session* is not picked up until the
next session.

**R2 — a session in flight across the deploy** has untrailered commits and (post-WS-3) no scan fallback.
Accepted and operator-visible: such a ticket falls to the explicit-field path or parks with a residual
event. Not a supported mode; the alternative is keeping the inference forever, which is the bundle's whole
target.

**R3 — trailer forgery.** A worker could type `Pickle-Ticket:` by hand. Not a regression: the worker can
already type its own ticket-id into a subject today. Corroboration (reachability, baseline rejection,
R-CWGE verdict) is unchanged, and the hook's idempotence check deliberately does not police authorship.

**R4 — WS-3 deletes a symbol with a surviving non-attribution consumer.** ⚠️ **This risk FIRED during
refinement, inside this PRD.** The author grepped `extensionGreenGate` (1 consumer → safely deletable,
still true) and did **not** grep `readDeclaredFiles`, which has **3** live non-attribution consumers.
The draft consequently ordered the deletion of a module that the dirty-tree guard, the readiness gate,
and a mux-runner path all depend on. Caught by refinement cycle 3; WS-3's scope is corrected above and
AC-GA-8b now pins the module's survival.

**The generalizable lesson — naming a risk is not discharging it.** R4 was written, cited the right
precedent (beta.33: grep other-export pins before deleting), and was then marked RESOLVED on the
strength of a grep of *one* of the symbols in its own deletion list. Any AC asserting a symbol's absence
MUST be paired with an importer-count grep of every member of the set, and the discharge evidence must
name each symbol checked. `GateVerdict` stays (owned by `lib/salvage-ticket.ts`).

---

## §6 Build protocol

**Not** an R-PSRB self-modifying-recovery bundle. WS-1/WS-2/WS-4 touch spawn env, the completion-evidence
*read* path, and phase-exit routing — the running pipeline executes deployed JS, so the source diff is
inert until `install.sh`. WS-3's deletion lands after WS-1/WS-2 are proven.

**Green-tree precondition:** the fast tier must be green on the launch commit. Satisfied at
`62657aff` (5/5 runs, 0 failures) with the two subsequent commits verified inert (version bump +
docs). Re-confirm once at rest before launch.
