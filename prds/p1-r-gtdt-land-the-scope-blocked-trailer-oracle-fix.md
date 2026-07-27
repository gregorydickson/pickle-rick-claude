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

`scope.json` `allowed_paths` **MUST** include all three files above. The prior session had 313 allowed
paths and `extension/tests/spawn-morty-commit-attribution.test.js` was **not** among them, which is what
blocked the fix. Launch with `--scope branch` so the full branch diff is in scope; verify the test file is
present before the first ticket runs.

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
- **AC-LAND-9** **Field evidence, not just unit green:** after `bash install.sh`, make a commit whose
  subject mentions a ticket id in prose only, and show it acquires a parsed trailer. Quote the real SHA and
  the `%(trailers:...)` output — Type: llm-conformance

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

**R1 — R-PSRB-shaped catch-22, mitigated but real.** This edits the completion-attribution path, and the
**deployed** runtime carries the buggy producer (ticket 60 ran `install.sh`). So the worker building this
fix is subject to the very defect it is fixing: its own commits will mention the ticket id in prose, not
get stamped, and could hit `done_without_commit_evidence`.

*Mitigation, in order:* the explicit `completion_commit` field path (R-RIC-EXPLICIT) is unaffected and
covered 8/10 tickets in the prior run, so completion remains reachable. If the worker does wedge, the
recovery is the standard one — verify ground truth, commit the verified work, clear `exit_reason` via
`setup.js --resume`, relaunch. Consider `bash install.sh` immediately after the fix ticket lands so any
later ticket runs on the fixed runtime.

**R2 — patch staleness.** Cut ~15 commits ago; may not apply cleanly. Re-derive rather than force.

**R3 — a third caller.** `reconcileWorkerCommitAttribution` is one producer; if another site stamps
trailers, it needs the same oracle. Grep for `Pickle-Ticket` writers before declaring done — the lesson
from R-NSG-AJBE and R-MVPARK in this same bundle is that a fix landing on *the callers we enumerated* is
how these survive.

## §8 Green-tree precondition

Fast tier must be green on the launch commit, and the B-GITATTR pipeline must have **fully exited** — do
not launch this while that session still holds the branch.
