# R-GTDT-LAND — land the scope-blocked trailer-oracle fix

**Priority:** P1 (release blocker for B-GITATTR)
**Branch base:** `release/v2.1-beta`
**Thesis:** *The engineering is done and mutation-verified. The blocker is a scope fence. Land it.*

---

## §1 What this bundle is, and what it is NOT

B-GITATTR's central deliverable — trailer attribution — **does not work for the common commit shape.**
Anatomy-park iteration 4 found the root cause, implemented the fix, mutation-verified each half RED, and
then **correctly reverted it** because landing it required editing a file outside `scope.json`.

**This bundle exists solely to land that verified work with the right file in scope.** It is not a
redesign. If the worker finds itself re-architecting, it has misread the ticket.

## §2 The confirmed defect

**Producer and consumer read two different oracles.**

- Producer — `reconcileWorkerCommitAttribution` / `maybeAmendTicketTrailer` (`src/bin/spawn-morty.ts`):
  its already-attributed guard tests a **word-boundary regex over raw `%B`**.
- Consumer — `scanGitLogByTrailer` (`src/services/ticket-completion-evidence.ts`): reads git's
  **parsed trailer view** (`%(trailers:key=Pickle-Ticket,valueonly)`).

git parses trailers from the **last paragraph only**. So a ticket id appearing anywhere as **prose**
satisfies the producer's guard → the stamp is skipped → no parsed trailer exists → evidence reads
`absent` → the Done-flip refuses `done_without_commit_evidence`. **That is the exact failure B-GITATTR
exists to eliminate, reproduced by B-GITATTR's own fix.**

**Verified live at HEAD** — 7 consecutive commits on this branch, each carrying prose `(ticket 6b7c3b82)`
and an EMPTY parsed trailer:

```
316a84e0  1f6e9005  ad78ab07  9c549191  732aaf44  3c3499ac  cea3c316
```

This is the **common** case: worker commit conventions routinely write `(ticket <hash>)` or
`fix(<hash>):` in the subject.

**Second half (HIGH, AP-EXT-ITER4-02):** the `-m message -m trailer` amend opens a **new paragraph**,
demoting pre-existing trailers (`Co-Authored-By`, `Signed-off-by`, `Resolves`) to body prose. Fix is to
write through `git interpret-trailers --if-exists addIfDifferentNeighbor` so the stamp joins the existing
trailer block.

**Why nobody noticed:** after B-GITATTR WS-3 deleted message inference, the explicit `completion_commit`
frontmatter field (R-RIC-EXPLICIT) **silently covered** for the inert trailer channel — 8/10 tickets in
session `2026-07-26-013335ff` went Done on the explicit path while the new mechanism did nothing. An older
mechanism masking a new one's failure is why every green signal in that run overstates the trailer's
health. Silence was not success.

## §3 The work

A verified patch exists:

```
~/.local/share/pickle-rick/sessions/2026-07-26-013335ff/extension/AP-EXT-ITER4-01-verified-fix.patch
```

15 KB, three files, ~194 added / ~14 removed:

| File | Change |
|---|---|
| `extension/src/bin/spawn-morty.ts` | canonical source — `readParsedTicketTrailers` (consumer's oracle) + `buildTrailerAmendedMessage` (interpret-trailers writer) |
| `extension/bin/spawn-morty.js` | compiled mirror, must match `npx tsc` output |
| `extension/tests/spawn-morty-commit-attribution.test.js` | **the file that was out of scope** — replaces the bug-asserting test |

The test rewrite is the crux. It currently encodes the bug as the contract:

```js
test('tip already word-boundary-tagged with the ticket id is NOT amended', …)   // asserts the BUG
```

and becomes:

```js
test('a PROSE-only ticket-id mention is not attribution — the tip IS amended', …)
test('a real parsed Pickle-Ticket trailer DOES suppress the amend (idempotent)', …)
```

⚠️ **The patch was cut at 00:41Z; HEAD has since moved ~15 anatomy-park commits.** Apply it as a
**starting point, not gospel** — if it does not apply cleanly, re-derive the change against current HEAD.
Do NOT force-apply, and do NOT hand-edit the compiled `.js` independently of the `.ts` (recompile with
`npx tsc` from `extension/` and let parity fall out).

## §4 Scope — the whole reason this bundle exists

`scope.json` `allowed_paths` **MUST** include the files below. The prior session had 313 allowed paths and
`extension/tests/spawn-morty-commit-attribution.test.js` was **not** among them, which is what blocked the
fix.

**Use an EXPLICIT allowlist, not `--scope branch`** *(refinement P0-3 — my original plan was `--scope
branch`; an explicit list is tighter and makes the one file that matters impossible to omit silently)*:

```
extension/src/bin/spawn-morty.ts
extension/bin/spawn-morty.js
extension/tests/spawn-morty-commit-attribution.test.js
extension/src/bin/CLAUDE.md
# conditional PAIR — add BOTH or NEITHER, only if serialization proves necessary:
#   extension/tests/integration/.serial-tests.json
#   extension/tests/integration/.serial-tests.reasons.json
```

**Verify the test file is present in `scope.json` BEFORE the first ticket runs** — that check is the entire
reason this bundle exists.

## §5 Acceptance criteria

- **AC-LAND-1** A commit whose subject mentions the ticket id in prose but carries no parsed trailer **IS**
  amended, and afterwards `git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'` returns exactly
  the ticket id — Verify: `cd extension && node bin/test-runner.js tests/spawn-morty-commit-attribution.test.js` — Type: test
- **AC-LAND-2** A commit already carrying a **real parsed** `Pickle-Ticket` trailer is NOT amended, and the
  trailer is not duplicated — Verify: same command — Type: test
- **AC-LAND-3** Stamping a commit that already has `Co-Authored-By` leaves that trailer **still parsed as a
  trailer** (not demoted to prose) — Verify: same command — Type: test
- **AC-LAND-4** The bug-asserting test is **gone**: no test asserts that a word-boundary prose match
  suppresses the stamp — Verify: grep the test file for `NOT amended` returns only the real-trailer case — Type: test
- **AC-LAND-5** Both halves mutation-verified RED: revert the parsed-view guard → AC-LAND-1 fails; revert
  the interpret-trailers writer → AC-LAND-3 fails. Confirm each mutation actually landed by grepping the
  mutated line — Type: llm-conformance
- **AC-LAND-6** Compiled mirror matches source — Verify: `cd extension && npx tsc && git diff --exit-code extension/bin/spawn-morty.js` — Type: test
- **AC-LAND-7** Full fast tier green — Verify: `cd extension && npm run test:fast` — Type: test
- **AC-LAND-8** Type + lint clean — Verify: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1` — Type: test
- **AC-LAND-10** A commit already carrying a `Pickle-Ticket` trailer naming a **different** ticket id ends
  with exactly **one** parsed `Pickle-Ticket` value, and `scanGitLogByTrailer` resolves it. Assert through
  `%(trailers:key=Pickle-Ticket,valueonly)` returning a **single line** — never `%B` — Verify:
  `cd extension && node bin/test-runner.js tests/spawn-morty-commit-attribution.test.js` — Type: test

  *Added by refinement (R5): the fix as written **regresses the different-id case**. Do not land without
  this AC.*

- **AC-LAND-9** `[manager]` **Field evidence that isolates the path under test.** Make a commit whose
  subject mentions a ticket id in prose only, **with `PICKLE_TICKET_ID` unset / the `GIT_CONFIG_*`
  fragment removed**, and show the **amend path** adds the parsed trailer. Quote the real SHA and the
  `%(trailers:…)` output — Type: llm-conformance

  ⚠️ **REWRITTEN by refinement (R4) — the original was TAUTOLOGICAL and I would have shipped it.** It read
  *"after `bash install.sh`, make a commit … and show it acquires a parsed trailer."* Post-deploy the
  **hook** stamps at `prepare-commit-msg`, *before* `reconcileWorkerCommitAttribution` runs, and a
  correctly-fixed guard then **skips** by idempotence. So the original AC **goes green whether this fix is
  correct, wrong, or absent** — it measures the hook, not the amend path it claims to verify. The probe
  must suppress the hook to isolate the fallback arm, and it is `[manager]`-owned because the deploy is.

## §6 Simplification Review

1. **Necessary?** Yes — without it B-GITATTR's deliverable is inert. **It adds no new mechanism**: it
   replaces a raw-`%B` regex with a read the consumer already performs.
2. **Reuse instead of add?** Yes, entirely. The parsed-trailer read is the **same oracle**
   `scanGitLogByTrailer` already uses, and the writer is git's own `interpret-trailers` rather than
   hand-rolled string surgery.
3. **Guards existing brittle complexity?** It **removes** the brittleness: two divergent oracles collapse
   into one. The hand-rolled `-m message -m trailer` append is deleted in favour of the tool that
   understands trailer blocks.
4. **What does it subtract?** One divergent oracle, one hand-rolled message-append path, and one test that
   asserted a bug as a contract.

## §7 Risks

**R1 — the deploy is MANAGER-OWNED, between-tickets, and is a THREE-change hot-swap.** *(rewritten by
refinement — the original under-stated this as a mitigated catch-22.)*

`bash install.sh` is a **Worker Forbidden Op with no override flag** — a worker must never run it, and an
unattended run therefore **cannot self-heal onto the fixed runtime**. Worse, the deployed tree
(`~/.claude/pickle-rick/extension`, mtime 2026-07-26 13:43) **predates the entire trailer-hook channel**:
`services/git-trailer-hooks.js` is **absent** and `services/backend-spawn.js` has **0**
`materializeTrailerHooks` / `PICKLE_TICKET_ID` references.

So a single `install.sh` lands three things at once:
1. this amend fix,
2. `a7d6d9ec`'s `--git-common-dir` widening, and
3. the **first-ever** deployment of a `prepare-commit-msg` hook that rewrites the message of **every**
   subsequent worker commit.

**Deploy only BETWEEN tickets, never mid-ticket**, and record the pre-deploy state first.
**Rollback:** if post-deploy worker commits show absent, empty, or multi-valued `Pickle-Ticket` trailers,
**halt the run and re-deploy the prior tree** rather than letting the pipeline continue on an unvalidated
commit path.

*Catch-22 residual (unchanged, and now better understood):* the explicit `completion_commit` path is
unaffected, so completion stays reachable. But see the **honesty clause** below — a Done-flip proves the
worker completed, not that the trailer channel works.

**R2 — patch staleness. ✅ CHECKED at HEAD `a7d6d9ec`:** `git apply --check` exits **0** — it still applies
despite ~20 intervening commits. Re-verify before applying rather than trusting this line; do not force.

**R3 — a third writer. ✅ RESOLVED WITH EVIDENCE by refinement.** Exactly **two** producers exist:
`spawn-morty.ts` (this fix) and `git-trailer-hooks.ts` (`prepare-commit-msg`, **already on the parsed
oracle** — it was correct all along). No third writer in `extension/src/`. **Why the correct hook did not
stamp `316a84e0…cea3c316`: it had never been deployed** — deployed `backend-spawn.js` (mtime 2026-07-26
13:43) carries 0 hook references, and the 7 commits were authored 21:49–22:15 the same day. §2's
single-root-cause attribution therefore stands, with this nuance: the hook is the primary producer and is
already correct; this fix corrects the **fallback amend arm**.

**R5 — the fix regresses the different-id case.** Pinned by **AC-LAND-10**. Do not land without it.

**R6 — `git interpret-trailers` dependency.** Core git (local 2.53.0);
`--if-exists addIfDifferentNeighbor` is long established. Low risk and a fallback is retained — but **the
fallback arm is untested (P1)**; cover it or state explicitly that it is not.

**Honesty clause (carry into the closing report).** The explicit `completion_commit` path is unaffected, so
a Done-flip in this bundle proves the **worker completed** — it does **not** prove the trailer channel
works. Only AC-LAND-9's isolated probe does that.

## §8 Green-tree precondition

Fast tier must be green on the launch commit, and the B-GITATTR pipeline must have **fully exited** — do
not launch this while that session still holds the branch.

---

## §9 Refinement Record *(3 cycles × 3 analysts, session `2026-07-27-5b2cefc5`, `all_success`)*

`ac_shape_smells: 0` — the AC-shape lesson from B-GITATTR's AC-GA-8 held. But the analysts found four
substantive defects, all folded into §4/§5/§7 above rather than appended:

1. **AC-LAND-9 was TAUTOLOGICAL** (R4). It would have gone green whether the fix was correct, wrong, or
   absent, because post-deploy the *hook* stamps before the amend path ever runs. Rewritten to suppress
   the hook and isolate the arm under test. **This is the second consecutive PRD where refinement caught a
   defective AC of mine** — AC-GA-8's drifting enumeration, now AC-LAND-9's wrong measurement target.
2. **R5 — the fix regresses the different-id case.** New AC-LAND-10 pins it.
3. **R1 badly under-stated.** `install.sh` is a Worker Forbidden Op with no override, the deployed tree
   predates the whole hook channel, and one deploy is a **three-change hot-swap** including the
   first-ever `prepare-commit-msg` that rewrites every subsequent worker commit. Now manager-owned,
   between-tickets, with an explicit rollback.
4. **R3 resolved with evidence, not a grep instruction.** Exactly two producers; the hook was already
   correct and simply **never deployed** — which explains the 7 trailer-less commits without weakening §2.

**Also adopted:** `complexity_tier: medium`, never `small` — `small` skips `test:fast` in the worker gate,
which would disarm the gate on the one bundle that must not ship unverified.

**Honesty clause** (from the risk analyst, carried into §7): a Done-flip here proves the worker completed,
not that the trailer channel works.
