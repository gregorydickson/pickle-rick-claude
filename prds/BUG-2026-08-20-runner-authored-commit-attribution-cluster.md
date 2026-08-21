# BUG-2026-08-20 (P0) — in-process trailer producers send UNTERMINATED input to `interpret-trailers`

*(refined: requirements / codebase / risk-scope analysts, 3 cycles, session `2026-08-20-54c74299`)*

## Status

Open. Branch `release/v2.1-beta`, HEAD `5ca07b7d`. **15 failures across 10 suites**, one shared
signature *(refined: codebase — measured blast radius, up from the authored 12/8)*. A runner that
cannot attribute its own commit cannot flip a ticket Done, so the work is stranded. Reliability
defect; first under the PRIME DIRECTIVE.

## Root cause — MEASURED, and NOT what the authored PRD claimed

*(refined: all three analysts, cycle 3, by measurement — this REFUTES the authored "single-line
message / no body" statement, which was an incomplete generalization from one example.)*

`git interpret-trailers` opens a new trailer paragraph **only when the input message ends in a
newline**. Given unterminated input it appends the trailer to the final line, and git parses trailers
from the LAST paragraph only — so `%(trailers:key=Pickle-Ticket,valueonly)` returns EMPTY.
**A body is not required; a terminating newline is — and the damage is conditional on paragraph shape.**

Measured (git 2.39.5), all inputs unterminated:

| input shape | `Pickle-Ticket` | pre-existing `Co-Authored-By` |
|---|---|---|
| single paragraph (subject only) | **EMPTY** | — |
| subject + BODY paragraph | **EMPTY** | — |
| subject + EXISTING trailer paragraph | `a1b2c3d4` | preserved |

The defect fires **iff** the input is unterminated **AND** its last paragraph is not already a trailer
block. That single fact explains the observed distribution — it is why
`spawn-morty-commit-attribution.test.js` fails 2 of 14 rather than all 14.

**TWO in-process producers send unterminated input, both confirmed live by controlled experiment:**

1. **`stampPickleTicketTrailer`** (`mux-runner.ts:5891`), reached from `commitAndContinueDoneFlip`
   (`:5971`) and `executeConvergedPlanAdapter`'s `commitPhase` (`:6697`). Both callers pass single-line
   template literals. Fixing the shared producer fixes both call sites.
2. **`buildTrailerAmendedMessage`** (`spawn-morty.ts:2372`), whose input is
   `reconcileGitOrNull(['log','-1','--format=%B',sha])` — and **`reconcileGit` ends in `.trim()`**
   (`spawn-morty.ts:2304`), stripping the newline `%B` supplies. This producer never calls
   `stampPickleTicketTrailer`. An isolation run patching only `mux-runner` leaves this suite at
   `fail 2` while every other cluster suite goes green — **so it is LIVE, not latent.**

**Normalize the INPUT only.** Both helpers `.trim()` their **output** (`silentDeathGit`,
`mux-runner.ts:9261`; `reconcileGit`, `spawn-morty.ts:2304`), so a newline appended to the *result* is
silently erased.

**A glued commit is a PERMANENT FIXPOINT** *(refined: risk-scope, cycle 3 — this analyst withdrew the
same risk in cycle 2 on a reasoned claim and re-established it by measurement)*. `--if-exists
addIfDifferentNeighbor` cannot dedupe a line git does not parse as a trailer: re-stamping an
unterminated glued message appends a SECOND glued `Pickle-Ticket:` line and still reads **0 values**.
The worker-side amend path therefore **cannot repair an already-glued commit, ever** — which is why
producer 2 is a scope REQUIREMENT, not a nice-to-have: the amend path is the only backfill mechanism
that exists. Backfill of existing history stays out of scope, but becomes *possible* only after this fix.

## Scope — 15 failures, 10 suites

| Suite | fails | tier |
|---|---|---|
| `tests/runner-authored-trailer.test.js` | 3 | integration |
| `tests/spawn-morty-commit-attribution.test.js` | 2 | integration |
| `tests/boundary-commit-at-iteration.test.js` | 2 | integration |
| `tests/mux-runner-fix-b.test.js` | 1 | integration |
| `tests/mux-exit-path-commit.test.js` | 1 | integration |
| `tests/exit-path-bystander-stash.test.js` | 1 | integration |
| `tests/integration/pipeline-completion-handsoff-e2e.test.js` (`AC-PCOMP-4`) | 1 | integration |
| `tests/worker-timeout-preserves-commit.test.js` (AC-WDTFTO-1-1, 1-3) | 2 | **fast** |
| `tests/worker-gate-not-run-invariant.test.js` (AC-1) | 1 | **fast** |
| **`tests/integration/extension-wiring.test.js`** | 1 | **OUT OF SCOPE — distinct cause, proven** |

*(refined: codebase — the last two fast-tier suites were authored as NON-GOALS; both go green under the
same 2-line normalization with no additional code, so the authored PRD would have sent a worker to file
a separate bundle for defects this bundle already repairs.)*

## What is ALREADY excluded — do not re-litigate

A full environmental sweep was completed 2026-08-20 before this bundle was authored. Re-deriving any of
it is wasted iteration:

- **NOT Node** — Node 24.19.0 removed all 51 cancellations across the three tiers; these survive it. The
  whole Node 22 line (22.12.0 AND 22.23.2) cancels 38 fast-tier tests.
- **NOT pnpm** — pnpm 11.22.0 fixed 8 separate `runGate` failures; these survive it.
- **NOT ripgrep, NOT tmux** — both installed; these survive both.
- **NOT the git version** — git 2.39.5 round-trips a `Pickle-Ticket` trailer correctly.
- **NOT git config** — no `trailer.*`, `hooks`, `gpg`, or `template` keys, global or local.
- **NOT the hook mechanism** — a hand-built `prepare-commit-msg` hook via `core.hooksPath` stamps and
  reads back correctly on this box. The hook path uses `--in-place` over an already-normalized
  `COMMIT_EDITMSG` and is **OUT of scope**; a regression test asserts it is unaffected.
- **NOT a regression from recent commits** — all suites fail identically at `f45812e1`, the sha
  `MASTER_PLAN.md` records as the first fully green measurement on this branch. Treat the
  non-reproducibility of that baseline as a separate finding; do not chase it here.

## Interface Contracts

**`stampPickleTicketTrailer(workingDir: string, message: string, ticketId: string): string`**
- **Inputs**: repo path; a commit message that MAY lack a trailing newline and MAY be single-paragraph;
  an 8-char ticket id.
- **Output**: a message whose `Pickle-Ticket` trailer is readable by
  `git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'` for ALL input shapes.
- **Invariants**: empty/whitespace ticket id → message unchanged (no valueless trailer); no double
  stamping; **on the PRIMARY arm**, pre-existing trailers (`Co-Authored-By`, `Signed-off-by`) remain
  PARSED, not demoted.
- **Degraded arm is OUT of scope** *(refined: requirements P0 #4)*. Neither arm is currently "right":
  the degraded `\n\n`-append arm is newline-INSENSITIVE but **demotes every pre-existing trailer**; the
  primary arm preserves trailers but is newline-SENSITIVE. `src/bin/CLAUDE.md:111` records that
  reverting to the two-`-m` append was **mutation-verified RED**. **Do NOT promote the degraded arm.**

**`buildTrailerAmendedMessage`** (`spawn-morty.ts:2372`)
- **Inputs**: `reconcileGitOrNull(['log','-1','--format=%B',sha])` — already `.trim()`-ed at
  `spawn-morty.ts:2304`, hence unterminated.
- **Output/Invariants**: as above. **REQUIRED here: newline normalization. STILL FORBIDDEN here: a
  blank-id guard** — `src/bin/CLAUDE.md:206` (ticket `7ec1c96c`) rules it dead code over an unreachable
  input (`spawn-morty.ts:411` already rejects a blank `--ticket-id`). These are DIFFERENT edits to the
  same function; do not let the prohibition on one suppress the other.

**`commitAndContinueDoneFlip(input): { ok: boolean; sha?: string }`**
- **Invariants**: `ok:true` REQUIRES a commit whose trailer the consumer's reader can parse. The
  fail-closed refusal on a genuinely unattributable commit is UNCHANGED — anchored to
  **`guardCompletionCommitBeforeDone` (`mux-runner.ts:5485`, called at `:5996`)**, NOT to `:6164`, which
  is merely the exit-commit wrapper's *report* of the refusal *(refined: requirements P0 #7)*.

## Verification Strategy

**Measurement preconditions, not gates** *(refined: requirements P0 #6 — PRIME DIRECTIVE)*: take
measurements under `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` (v24.19.0 + pnpm 11.22.0) on a
censused idle box (process census + load average recorded alongside the result). If the box cannot meet
these conditions, the run **records the reason, flags a residual, and proceeds on AC-1..AC-6**. No
measurement verdict halts the run or fails the bundle.

```bash
# the seven in-scope integration suites + the two fast-tier suites
node --test tests/runner-authored-trailer.test.js
node --test tests/spawn-morty-commit-attribution.test.js
node --test tests/boundary-commit-at-iteration.test.js
node --test tests/mux-runner-fix-b.test.js
node --test tests/mux-exit-path-commit.test.js
node --test tests/exit-path-bystander-stash.test.js
node --test tests/integration/pipeline-completion-handsoff-e2e.test.js
node --test tests/worker-timeout-preserves-commit.test.js
node --test tests/worker-gate-not-run-invariant.test.js

npm run test:integration:parallel && npm run test:integration:serial
node bin/test-runner.js --tier fast --test-concurrency=8
npx tsc --noEmit && npx eslint src/ --max-warnings=-1
```

Oracle for AC-1, runnable against any candidate commit:
```bash
git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'   # MUST print the ticket id
```

Negative control for AC-4: revert the `\n` normalization in a scratch worktree, `npx tsc`, re-run.

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-1a | `tests/runner-authored-trailer.test.js` | single paragraph / subject only, unterminated | trailer PARSES via `%(trailers:...)` |
| AC-1b | `tests/runner-authored-trailer.test.js` | **subject + BODY paragraph, unterminated** — covered by NO test today, and the common shape of a real worker commit | trailer PARSES |
| AC-1c | `tests/runner-authored-trailer.test.js` | subject + EXISTING trailer paragraph | `Pickle-Ticket` parses AND `Co-Authored-By` stays PARSED |
| AC-1d | `tests/spawn-morty-commit-attribution.test.js` | `buildTrailerAmendedMessage` over a `.trim()`-ed `%B` feed | trailer PARSES; prose-only id is NOT attribution |
| AC-2 | `tests/runner-authored-trailer.test.js` | guard satisfiable — evidence committed | `result.ok === true`, `sha` matches HEAD, `completion_commit` in ticket frontmatter |
| AC-4 | `tests/integration/pipeline-completion-handsoff-e2e.test.js` | `AC-PCOMP-4` 4/4 hands-off completion | every ticket has `completion_commit`, no `Todo` reset, `state.json` byte-identical |
| AC-6 | `tests/runner-authored-trailer.test.js` | degraded arm with a pre-existing trailer | `Pickle-Ticket` PARSES; `Co-Authored-By` demotion asserted as the DOCUMENTED trade, not silently unobserved |
| AC-5 | `tests/nostop-gates-*.test.js` | no new halt path | no new `exit_reason` member |

## Acceptance criteria

- **AC-1** For **every** in-process trailer producer — `stampPickleTicketTrailer` (`mux-runner.ts:5891`,
  covering both call sites `:5971` and `:6697`) and `buildTrailerAmendedMessage` (`spawn-morty.ts:2372`)
  — the resulting commit's `Pickle-Ticket` trailer reads back via
  `%(trailers:key=Pickle-Ticket,valueonly)` as the ticket id, for **each** message shape — (a) single
  paragraph, (b) **subject + body**, (c) subject + existing trailer paragraph — **with and without** a
  trailing newline. The `prepare-commit-msg` hook path is already correct and OUT of scope; a regression
  test asserts it is unaffected.
- **AC-2** `result.ok === true` and `completion_commit` is stamped into the **ticket frontmatter** (via
  `updateTicketFrontmatter`, `services/git-utils.ts` — **not** a `state.json` write, so no Forbidden-Op
  override is required). The fail-closed refusal at `guardCompletionCommitBeforeDone`
  (`mux-runner.ts:5485`) is UNCHANGED.
- **AC-3** One trailer-stamping **policy** applied at every producer: normalize the message to end in
  exactly one `\n` on the **input** to `interpret-trailers`. **The two `mux-runner` call sites are
  PRESERVED, not merged** — `runner-authored-trailer.test.js` asserts `total - definitions === 2` and
  cross-checks the `src/bin/CLAUDE.md` PATTERN_SHAPE count of 3. AC-3 means "no **THIRD** stamping
  mechanism", NOT "merge the existing two". The in-process arm MUST NOT be routed through
  `git-trailer-hooks.ts` (it exports only `materializeTrailerHooks`, a subprocess hook fragment).
  Extracting a shared helper is PERMITTED but NOT REQUIRED.
- **AC-4** The **nine** in-scope suites pass, and each fails when the normalization is reverted
  (negative control above). Primary evidence is `AC-PCOMP-4`. `extension-wiring.test.js` is OUT of scope
  — its split is a **PASS** for this bundle, not a failure.
- **AC-5** No new `exit_reason`, no new abort condition, no new halt path (PRIME DIRECTIVE).
- **AC-6** The degraded arm and idempotence tests still pass; the degraded arm's trailer demotion is
  asserted as the documented trade. No double-stamping becomes possible.
- **AC-7 (report-only, non-gating)** Fast tier: `cancelled 0` and no regression; the only expected
  movement is `worker-timeout-preserves-commit` `fail 2 → 0` and `worker-gate-not-run-invariant`
  `fail 1 → 0`. All eight original cluster suites are `@tier: integration`, so the fast tier contains
  zero of them.
- **AC-8 (report-only, non-gating)** `test:integration:parallel` and `test:integration:serial` both
  `cancelled 0`, with the seven in-scope integration suites passing.

## Non-goals

- **`tests/integration/extension-wiring.test.js` `deploy smoke`** — OUT, **distinct cause proven by
  experiment** (the only suite that does not move under the fix). `:47` asserts the top-level
  `~/.claude/agents/morty-gate-remediator.md`, but `install.sh:619-621` deploys managed agents to
  `$AGENTS_DIR/.pickle-managed` and **`install.sh:646` `rm -f`s the top-level copy**. `bash install.sh`
  cannot fix it — it is the operation that guarantees the absence. File separately.
- **The bun probe** (`tests/install-bun-probe.test.js`) — test-isolation defect: it strips `PATH`
  entries containing `"bun"`, which misses Homebrew's `/opt/homebrew/bin`. File separately.
- **The Node pin inconsistency** — `engines.node`/`release.yml` pin `22.x` (38 tests cancel) while
  `ci.yml`/`stability-gate.yml` use `24`. Real release-gate defect. File separately.
- **The MCP fallback defect** — `resolveMcpConfigWithLayer` passes `~/.claude.json` to
  `claude --mcp-config` without checking it contains `mcpServers`, killing every worker spawn on a
  machine with no user-scoped MCP. File separately (higher severity than this bundle).
- **Backfilling already-glued commits in history.** Possible only after this fix; not attempted here.
- **Promoting the degraded arm to primary** — mutation-verified RED (`src/bin/CLAUDE.md:111`).
- Re-running the environmental sweep.

## Execution posture

**UNATTENDED.** The deployed runtime is `2.1.0-beta.10`, which already carries the
`done_without_commit_evidence` park fix, so the R-PSRB catch-22 that forced ATTENDED on the prior bundle
no longer applies. The pipeline executes DEPLOYED JS, not the source diff.

## Simplification Review

1. **Is the addition necessary?** Minimal: normalize the input to end in exactly one `\n` at two
   producers. Measured as a **2-line diff across 2 source files**. No new guard, flag, or state field.
2. **Can it REUSE instead of ADD?** The policy is one line at each producer. A `services/git-utils.ts`
   shared helper is PERMITTED but grows the ticket allowlist from 4 files to 6 — the codebase analyst
   **retracted** its own cycle-2 recommendation for that seam after measuring. Inline is the smaller change.
3. **Does it guard EXISTING brittle complexity that should be SUBTRACTED?** No. The completion guard is
   correct — it refuses an unattributable commit accurately. The honest fix is upstream at the producer.
   Do NOT add an escape hatch around the guard.
4. **What can this SUBTRACT?** No structural subtraction available: the two `mux-runner` call sites are
   pinned by an anchor test and must NOT be merged. Recorded as "no subtraction available" with reason.
   The bundle instead removes a **silent** failure mode — attribution that looks present in `%B` but is
   invisible to the parser.

## Implementation Task Breakdown

| Order | ID | Title | Priority | Tier | Entry | Exit | Files |
|---|---|---|---|---|---|---|---|
| 10 | `7c91858f` | Normalize interpret-trailers input newline in `stampPickleTicketTrailer` | High | medium | clean tree at start_commit | `runner-authored-trailer` 13/13 | `mux-runner.ts`, `runner-authored-trailer.test.js` |
| 20 | `87b562c2` | Normalize interpret-trailers input newline in `buildTrailerAmendedMessage` | High | medium | `7c91858f` Done | `spawn-morty-commit-attribution` 14/14 | `spawn-morty.ts`, `spawn-morty-commit-attribution.test.js` |
| 30 | `9b3c4549` | Record tier evidence for the bundle | Medium | small | `7c91858f`,`87b562c2` Done | evidence doc committed | `docs/bug-2026-08-20-trailer-normalization-evidence.md` |
| 40 | `294c6ed6` | Harden: code quality review | High | medium | all prior Done | zero P0-P1 in MODIFIED_FILES | bundle diff |
| 50 | `f168caeb` | Audit: data flow integrity | High | medium | all prior Done | zero CRITICAL/HIGH | bundle diff |
| 60 | `01be73ae` | Harden: test quality review | High | medium | all prior Done | every AC mapped to a test | test files |
| 70 | `91f5ff2b` | Audit: cross-reference consistency | High | medium | all prior Done | zero CRITICAL/HIGH cross-ref | doc files |

**Wiring ticket: SKIPPED** — the 7d skip gate fires at ≤2 implementation tickets (this bundle has 2),
and the scope is a single policy applied at two producers, not cross-module integration.

**Hardening tiers stamped `medium`, not the template's `large`** — an upward mis-tier runs red-main
gates that can wipe edits, and this branch carries known-red suites outside the bundle. The real diff
is ~2 source lines plus tests across 5 files.
