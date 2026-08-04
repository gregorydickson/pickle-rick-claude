---
title: "R-GADEL — answer whether the Pickle-Ticket trailer covers what message inference covered, then act on the answer"
priority: P1
finding: R-GADEL
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
build_mode: attended
source_assessment: "Authored 2026-08-04 from prds/BUG-REPORT-2026-07-27-gitattr-ws3-deletion-left-no-attribution-fallback.md, regrounded at HEAD 5b4136a1 + field telemetry harvested from session 2026-08-03-2d5b3820 (LOA-2190)"
---

# R-GADEL — the attribution-fallback verdict

**Release blocker for beta.8.** The full release gate at `c457e943` returned
`GATE_RESULT=RED / FAILED_STAGE=test-integration / 10 failures`, bisected to B-GITATTR
(`00765390` 5/5 pass → `a7d6d9ec` 3 fail), **not** to R-GTDT-LAND.

## 0. Pre-launch checks (done at authoring, 2026-08-04)

- **Stale-premise check — finding is LIVE.** `scanGitLogByRefToken` / `scanGitLogByFileTouch` /
  `extractRCodeTokens` are **0 hits** in `extension/src/`. The 8 failing test files are **untouched
  since `a4e48c26`** (the deleting commit). Nothing has fixed this.
- **Green-tree precondition — GREEN at `5b4136a1`, 2026-08-04.** `cd extension && npm run test:fast`:
  `tests 7212 / pass 7209 / fail 0 / skipped 2 / todo 1`, 481 suites, 421s, exit 0. Single run on a
  quiet box (no concurrent pipeline), so no contention flakes. The failing tier is `integration`, which
  **no pipeline phase runs** — so a green fast tier is necessary but explicitly **not** sufficient here,
  and WS-C exists because of that.
- **Build mode: attended.** This bundle edits the completion-evidence / Done-stamping path. Per the
  standing dogfood rule it is built **by the pipeline**, with an operator watching the salvage seam —
  it is NOT hand-built.

## 1. What was deleted, and what survives

B-GITATTR WS-3 (`a4e48c26`, −347 lines from `ticket-completion-evidence.ts`) deleted **four**
attribution mechanisms on the thesis that the `Pickle-Ticket` trailer replaces them:

| # | Deleted mechanism | Symbols | The case it attributed |
|---|---|---|---|
| **C1** | ref-token scan | `scanGitLogByRefToken`, `guardScanHit` | commit **message** names the ticket id |
| **C2** | r_code fallback | `extractRCodeTokens`, `commitMessage` | commit **message** names an R-code token |
| **C3** | declared-file-touch | `scanGitLogByFileTouch`, `touchesDeclared`, `commitTouchedFiles`, `enumerateSiblingDeclaredFiles` | commit **touches the ticket's declared files** |
| **C4** | extension-scoped green gate | `extensionGreenGate` (`mux-runner.ts`) | separate concern; not an attribution path |

**Surviving attribution paths:** the explicit `completion_commit` frontmatter field, the
`Pickle-Ticket` trailer lookup (`readParsedTicketTrailers`), and the zero-diff arm. `EvidenceKind` is
collapsed to `'committed' | 'absent'`. `ticket-declared-files.ts` survives, pinned (3 live
non-attribution consumers).

**The deletion is itself pinned.** `extension/tests/gitattr-inference-deleted.test.js` asserts zero
occurrences of every `DELETED_SYMBOLS` member in its home file, plus anchor reconciliation across the
CLAUDE.md catalogs. **Any restore reddens that pin** and must reconcile it in the same commit.

## 2. The 10 failures

All ten enumerated as discrete `file:line` tokens — these exact strings are the keys AC-GADEL-A2
matches on, so do not reformat them:

```
tests/characterization/completion-commit-cluster/path-2-worker-autofill-belt-and-suspenders.test.js:52
tests/characterization/completion-commit-cluster/path-3-manager-drift-auto-completion-validation.test.js:76
tests/characterization/completion-commit-cluster/path-7-phantom-done-watcher-backfill.test.js:74
tests/boundary-commit-at-iteration.test.js:69
tests/boundary-commit-at-iteration.test.js:102
tests/boundary-commit-at-iteration.test.js:176
tests/doneflip-gate-all-callsites.test.js:118
tests/wuwc-reproducer.test.js:305
tests/mux-exit-path-commit.test.js:79
tests/exit-path-bystander-stash.test.js:67
```

The 8 distinct files (the `F` set referenced by AC-GADEL-B3) are those paths with `extension/`
prefixed and the `:line` suffix stripped.

`extension/CLAUDE.md` describes the completion-commit-cluster suite as **"the primary regression guard
for the 8 Done-stamping paths"** with the invariant *"These tests MUST pass on every release."*

## 3. Field evidence available to WS-A (harvested 2026-08-04, do not re-derive)

Session `2026-08-03-2d5b3820`, LOA-2190 worktree, 15 tickets, `exit_reason: completed` — the **first
real multi-ticket run with the `prepare-commit-msg` hook deployed**. Measured over its 38 commits with
`git log --format='%h %(trailers:key=Pickle-Ticket,valueonly,separator=,)'`:

| Measure | Result |
|---|---|
| Worker commits carrying exactly one trailer | **32 / 32 (100%)** |
| Multi-valued trailers | **0** — R-GTDT-LAND's rollback trigger did NOT fire |
| Commits with no trailer | 6 — **all non-worker**: 4 GitHub PR squashes by other authors, 2 operator commits |

**What this evidence does and does not establish.** It establishes that post-hook-deploy, on a real
run, the trailer channel attributed every worker commit — so C1/C2 are covered *for commits the hook
stamped*. It does **not** establish that an untagged worker commit cannot occur; that case simply did
not arise in 32 commits. Absence of occurrence is evidence, not proof.

**Counter-evidence, pre-deploy:** `b4dbd528` landed with an empty parsed trailer, and 7 consecutive
commits did the same in the prior session — all **before** the hook was deployed (ticket 20 of
R-GTDT-LAND). Any commit made before that deploy, by a path that bypasses the hook, or when the hook
fails, is untagged and now unattributable by scan.

## 4. Workstreams

### WS-GADEL-A — the coverage enumeration (gates B; produce it FIRST)

Answer, in a committed artifact: **does the trailer channel cover every case message inference
covered?** For each of C1/C2/C3, state whether the trailer covers it, **by what mechanism**, and what
happens when the hook does not fire. The §3 field evidence is an input, not the answer.

Then classify each of the 10 failures as **dead-contract** (asserts a mechanism that is genuinely
obsolete) or **live-contract** (asserts a behaviour the system still owes), with the reasoning per
test.

⛔ **Choosing "dead contract" without the enumeration is a fake green.** This is the whole deliverable.

#### Acceptance criteria
- **AC-GADEL-A1**: `prds/research/gadel-trailer-coverage-matrix.md` exists and contains the
  **Coverage table** (shape pinned in §4.5) with exactly one row per deleted case C1, C2, C3. — Verify:
  `for c in C1 C2 C3; do grep -qE "^\| $c \| (yes|no|partial) \|" prds/research/gadel-trailer-coverage-matrix.md || exit 1; done`
  — Type: test
- **AC-GADEL-A2**: the same artifact's **Verdict table** (§4.5) classifies **all 10** failures. Every
  one of the 10 `file:line` tokens listed in §2 appears in a row whose verdict cell is exactly
  `dead-contract` or `live-contract`. — Verify:
  `for t in $(grep -oE '[a-z0-9./-]+\.test\.js:[0-9]+' prds/p1-r-gadel-attribution-fallback-verdict.md | sort -u); do grep -qE "^\| \`$t\` \| (dead|live)-contract \|" prds/research/gadel-trailer-coverage-matrix.md || exit 1; done`
  — Type: test
- **AC-GADEL-A3**: the two failures the bug report flags as substantive — `guard must ATTRIBUTE-to-Done
  an untagged worker commit` and `expected committed, got honest_failure/commit-failed` — each carry an
  explicit verdict paragraph that addresses the failure **message**, not just the file. — Type:
  llm-conformance

### WS-GADEL-B — act on the verdict

Apply WS-A's classification. Two permitted shapes, chosen **per test**, not globally:

- **dead-contract** → update the test, with the reasoning recorded **in a comment on the changed
  assertion** naming the evidence that justified it.
- **live-contract** → restore a fallback for **only** the uncovered case(s). This is a partial revert
  of WS-3 and MUST be stated as such in the commit message. Restoring the full inference surface is
  out of scope — C3 (declared-file-touch) is the broadest and least selective mechanism and must not be
  restored merely because C1/C2 needed it.

#### Acceptance criteria
- **AC-GADEL-B1**: `cd extension && npm run test:integration` is **green** — Verify: exit 0 — Type: test
- **AC-GADEL-B2**: every test file changed by this bundle carries, on each modified assertion, a comment
  naming the WS-A verdict that justified the change. — Verify: for each changed `tests/**` file,
  `git diff` context shows a comment adjacent to each changed assertion — Type: llm-conformance
- **AC-GADEL-B3** *(anti-fake-green, load-bearing)*: **no assertion is deleted or weakened to reach
  green.** The summed `assert.` count across the 8 §2 files must not fall below its value at
  `start_commit`. — Verify, from the repo root with `S=<start_commit>` and `F` the 8 paths in §2:
  ```
  before=$(for f in $F; do git show "$S:$f" | grep -c 'assert\.'; done | paste -sd+ - | bc)
  after=$(for f in $F; do grep -c 'assert\.' "$f"; done | paste -sd+ - | bc)
  test "$after" -ge "$before"
  ```
  — Type: test
- **AC-GADEL-B4**: if any symbol is restored, `gitattr-inference-deleted.test.js` is reconciled in the
  **same commit** (restored symbol removed from `DELETED_SYMBOLS`, anchors updated) and the commit
  message contains the phrase `partial revert of WS-3`. — Verify: `git log` — either zero restored
  symbols, or the reconciliation and phrase are present — Type: test
- **AC-GADEL-B5**: `extension/CLAUDE.md`'s completion-evidence trap-door anchors name no symbol that
  does not exist in source after this bundle. — Verify: `bash scripts/audit-trap-door-enforcement.sh`
  exits 0 — Type: test

### WS-GADEL-C — verification that runs the claim

This bundle claims to unblock the beta.8 tag. A ticket must **run** that claim.

#### Acceptance criteria
- **AC-GADEL-C1**: the **full release gate** is executed from `extension/` per `CLAUDE.md` and its
  verdict recorded in `prds/research/gadel-gate-run.md` with `GATE_RESULT`, the commit SHA, and — if
  red — `FAILED_STAGE` plus the **named next blocker**. — Verify: `test -f` and
  `grep -q 'GATE_RESULT=' prds/research/gadel-gate-run.md` — Type: test
- **AC-GADEL-C2**: the recorded run is at a commit **at or after** this bundle's last code commit (not
  an inherited stale log). — Verify: the SHA in the artifact is an ancestor-or-equal of HEAD and newer
  than `start_commit` — Type: test

> Run the gate **once, on a quiet box**. Overlapping runs self-inflict timeout-shaped flakes. If the
> fast tier flakes at c=8, re-run at c=4 for the authoritative verdict.

## 4.5 Interface Contracts — the two forward-created artifacts

This bundle's boundaries are **documents**, not APIs. Their shapes are contracts because ACs grep them.

### `prds/research/gadel-trailer-coverage-matrix.md` (WS-A output, WS-B input)

Two tables, both markdown, in this order. Column order is load-bearing.

**Coverage table** — exactly 3 data rows, keyed `C1`/`C2`/`C3`:

```
| Case | Covered | Covering mechanism | Behaviour when the hook does not fire |
|---|---|---|---|
| C1 | yes | `readParsedTicketTrailers` — … | … |
```

- `Case` ∈ {`C1`, `C2`, `C3`} — the §1 mechanisms, one row each, no others
- `Covered` ∈ {`yes`, `no`, `partial`} — lowercase, exact
- `Covering mechanism` names at least one **symbol in backticks**, or is the literal `none`
- `Behaviour when the hook does not fire` — prose, non-empty

**Verdict table** — exactly 10 data rows, one per §2 token:

```
| Failure | Verdict | Justification |
|---|---|---|
| `tests/boundary-commit-at-iteration.test.js:69` | live-contract | … |
```

- `Failure` — the §2 `file:line` token verbatim, in backticks
- `Verdict` ∈ {`dead-contract`, `live-contract`} — lowercase, exact
- `Justification` — one line citing a symbol in backticks or an evidence source (`§3`, a commit SHA)

### `prds/research/gadel-gate-run.md` (WS-C output)

Free-form prose, but MUST contain these keys, one per line, `KEY=value`:

```
GATE_RESULT=GREEN|RED
GATE_COMMIT=<full 40-char sha>
FAILED_STAGE=<stage name>      # required iff GATE_RESULT=RED, omitted otherwise
NEXT_BLOCKER=<name or "none">  # always present; "none" iff GREEN
```

**Errors / invariants:** a missing artifact, a verdict value outside its enum, or a `Failure` token
not matching §2 verbatim is a **hard AC failure**, not a warning. Neither artifact may be written by
WS-B — WS-A owns the matrix, WS-C owns the gate run.

## 4.6 Test Expectations

| Criterion | Test file | Description | Assertion |
|:---|:---|:---|:---|
| AC-GADEL-A1 | *(artifact grep, no test file)* | Coverage table well-formed | 3 rows, each `C[123]` with an enum verdict |
| AC-GADEL-A2 | *(artifact grep, no test file)* | Verdict table complete | all 10 §2 tokens present with an enum verdict |
| AC-GADEL-B1 | the 8 §2 files | integration tier green | `npm run test:integration` exits 0 |
| AC-GADEL-B3 | the 8 §2 files | assertion floor holds | summed `assert.` count ≥ value at `start_commit` |
| AC-GADEL-B4 | `extension/tests/gitattr-inference-deleted.test.js` | deletion pin reconciled | zero restored symbols, or pin updated in the same commit |
| AC-GADEL-B5 | `extension/CLAUDE.md` | trap-door anchors resolve | `audit-trap-door-enforcement.sh` exits 0 |
| AC-GADEL-C1 | *(artifact grep, no test file)* | gate verdict recorded | `GATE_RESULT=` and `NEXT_BLOCKER=` present |

## 5. Simplification Review

**WS-GADEL-A**
1. **Necessary?** Yes, and it adds no runtime code — it produces a decision artifact. The bug report is
   explicit that answering the question *is* the deliverable.
2. **REUSE not ADD?** Reuses the existing evidence: the deleting commit's own message enumerates the
   four mechanisms, and the §3 field telemetry is already harvested. No new instrument.
3. **Guards brittle complexity?** It interrogates a deletion rather than defending it — the honest
   posture. The brittle thing is the *unexamined* assumption that one channel replaced four.
4. **SUBTRACTS:** nothing yet; it decides what may be subtracted permanently (if all three cases are
   covered, 10 tests stop asserting a dead contract and the deletion is confirmed as a genuine −347).

**WS-GADEL-B**
1. **Necessary?** Yes — the gate is red and beta.8 is not taggable.
2. **REUSE not ADD?** The dead-contract arm adds nothing. The live-contract arm restores **existing,
   deleted** code rather than writing a new mechanism — restoration is cheaper and better-tested than
   invention.
3. **Guards brittle complexity?** This is the guard-rewriting trap named directly: rewriting a suite to
   match current behaviour is how R-GTDT was born, where a test encoded the bug as the contract.
   AC-GADEL-B3 is the structural defence — you cannot reach green by deleting assertions.
4. **SUBTRACTS:** best case, 10 stale assertions and a confirmed −347 LOC. Worst case, a **narrow**
   partial revert — and even then C3 stays deleted, so the net subtraction survives.

**WS-GADEL-C**
1. **Necessary?** Yes. A bundle claiming to unblock a tag that never runs the gate is a claim, not a fix.
2. **REUSE not ADD?** Reuses the documented release-gate command verbatim. No new harness.
3. **Guards brittle complexity?** It closes the exact structural blind spot that let this land: no
   pipeline phase runs `test:integration`, so only a full gate can see this class.
4. **SUBTRACTS:** no code. Subtracts the possibility of a second undetected tier-boundary regression.

## 6. Risks

- **R1 — the worker rewrites guards to green.** The dominant risk; a worker optimises for green.
  Mitigated structurally by AC-GADEL-B3 (assertion count cannot fall) and AC-GADEL-B2 (per-assertion
  justification), not by prose.
- **R2 — over-restoration.** Restoring all four mechanisms would undo a legitimate −347 subtraction.
  Bounded by WS-B's per-case rule and the explicit C3 carve-out.
- **R3 — the enumeration concludes "covered" on thin evidence.** §3 states its own limits; AC-GADEL-A3
  forces the untagged-commit case to be argued rather than assumed.
- **R4 — an unrelated inherited red in the integration tier.** If AC-GADEL-B1 fails on a failure not in
  the §2 list, record it as inherited (naming the commit that introduced it) rather than absorbing it
  into this bundle.

## 7. Implementation Task Breakdown

| Order | Title | Tier | Files |
|---|---|---|---|
| 10 | WS-GADEL-A: enumerate trailer coverage for C1/C2/C3 and classify all 10 failures | medium | `prds/research/gadel-trailer-coverage-matrix.md` |
| 20 | WS-GADEL-B: apply the per-test verdict (updates with recorded reasoning and/or narrow fallback restore) | large | `extension/src/services/ticket-completion-evidence.ts`, `extension/tests/**`, `extension/CLAUDE.md` |
| 30 | WS-GADEL-C: run the full release gate and record the verdict + next blocker | small | `prds/research/gadel-gate-run.md` |
