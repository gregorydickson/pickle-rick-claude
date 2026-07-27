# BUG REPORT 2026-07-26 — two defects observed live during the B-GITATTR self-build

**Session:** `2026-07-26-013335ff` · **Branch:** `release/v2.1-beta` · **Phase:** pickle (1/4), 8/10 tickets Done
**Observed by:** operator progress check at 21:44 CDT, ~5h30m into the run.

Both defects were found by inspecting the running pipeline's own artifacts, not by a test. Filed per the
standing rule that a loop failure gets a bug PRD + MASTER_PLAN row so recoveries become drainable.

**First, a correction to avoid a false trail:** an initial `pgrep -c -f "pipeline-runner.js"` returned `0`
and read as a dead runner. That was wrong — the full chain is intact and 5h30m old:
`launch.sh → pipeline-runner 21833 → mux-runner 22267 → claude manager 40783 → spawn-morty → claude worker`.
A `pipeline-runner.log` frozen at the `PHASE 1/4` header is **normal** — it only writes on phase
transitions. Do not treat either signal as a death without walking the ancestry.

---

## R-GTDT — a commit can carry TWO `Pickle-Ticket` trailers, the second one garbage

### Evidence

Of 8 trailered commits in this run, 7 carry exactly one trailer. One does not:

```
271587ae trailers=2  Pickle-Ticket: a026c5cc   Pickle-Ticket: ticket-model-recovered-off
```

`git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)' 271587ae` → `ticket-model-recovered-off`.

Two distinct problems in one commit:

1. **Idempotence failed.** AC-GA-1 requires exactly one trailer and AC-GA-2 requires the hook to no-op when
   `^Pickle-Ticket:` is already present. Two trailers landed anyway.
2. **The second value is not a ticket id.** `ticket-model-recovered-off` appears **nowhere** in
   `extension/src/` (grep returns nothing), so it is not a code identifier that leaked. It is a
   flag/state-shaped string that reached `PICKLE_TICKET_ID`.

### ⚠️ MECHANISM CORRECTED 2026-07-27 — the suspicion below was WRONG, and the truth is worse

Anatomy-park iteration 4 found the real root cause independently (`71d75cc8`), and I verified it at HEAD.
**Keep the symptom, discard the "suspected mechanism" paragraph that follows.**

**The real defect: producer and consumer read two different oracles.**
`maybeAmendTicketTrailer`'s already-attributed guard tests a **word-boundary regex over raw `%B`**. The
consumer `scanGitLogByTrailer` reads **git's PARSED trailer view** — and git parses trailers from the
**last paragraph only**. So a ticket id appearing anywhere as **prose** satisfies the producer's guard, the
stamp is skipped, no parsed trailer exists, evidence reads `absent`, and the Done-flip refuses
`done_without_commit_evidence` — **the exact failure this bundle exists to eliminate, reproduced by the
bundle's own fix.**

**Verified live at HEAD** — 7 consecutive commits on this branch, every one carrying prose
`(ticket 6b7c3b82)` and an EMPTY parsed trailer:

```
316a84e0 1f6e9005 ad78ab07 9c549191 732aaf44 3c3499ac cea3c316
   parsed_trailer=[EMPTY]   prose=[ticket 6b7c3b82]      (all 7)
```

This is the **common** case, not an edge case: worker commit conventions routinely put `(ticket <hash>)` or
`fix(<hash>):` in the subject. On exactly those commits the producer stamps nothing.

**Why 8/10 tickets still went Done anyway — and why that is the dangerous part.** After ticket 50 deleted
message inference, the trailer was supposed to be the attribution channel. It was largely inert, and the
**explicit `completion_commit` frontmatter field (R-RIC-EXPLICIT) silently covered for it.** An older
mechanism masked the new one's failure, so every green signal in this run overstates how well the trailer
works. Silence was not success.

**Second half of the same theme:** the `-m message -m trailer` amend opens a new paragraph, **demoting
pre-existing trailers** (`Co-Authored-By`, `Signed-off-by`) to body prose — reproduced end-to-end. That is
also the true source of the `271587ae` double-trailer symptom below.

### The fix exists, is mutation-verified, and CANNOT LAND — scope-fenced

One uniform oracle (parsed-view guard + `git interpret-trailers`), each half independently
mutation-verified RED. Preserved at:

```
<SESSION_ROOT>/extension/AP-EXT-ITER4-01-verified-fix.patch   (15 KB)
```

It was reverted per the Phase-2 scope-preflight protocol because
`extension/tests/spawn-morty-commit-attribution.test.js:116` **asserts the bug as the contract** —

```js
test('tip already word-boundary-tagged with the ticket id is NOT amended', …)
```

— and that file is **absent from all 313 `allowed_paths`** in this session's `scope.json` (verified).
The worker behaved correctly: it refused to edit out of scope and cataloged an honest OPEN GAP with
`ENFORCE: none` rather than claiming a false one.

**RELEASE BLOCKER.** This bundle's central deliverable does not work for the common commit shape. It must
be resolved before B-GITATTR can be called done — the fix is written, so the remaining work is landing it,
not designing it.

### Superseded suspicion (retained to show the correction)

`271587ae`'s own commit body says the worker used `git commit --trailer`. If git applies `--trailer` via
`interpret-trailers` **after** `prepare-commit-msg` runs, the hook's `^Pickle-Ticket:` idempotence check
looks at a message that does not yet contain the `--trailer` value, appends its own, and both survive. The
guard is structurally blind to a trailer git adds later in the same commit.

**Partially self-caught already.** Two later commits in this same run appear to address this class:
`2717dd7f` *"audit: [CRITICAL] stop the trailer stamp from orphaning pre-existing…"* and `c3f82776`
*"fix: stamp the trailer with git interpret-trailers so pre-existing t…"*. `c3f82776` itself carries
exactly one trailer. So the bundle's own data-flow audit (ticket `b34ec6d7`) caught the double-stamp and
routed the producer through `interpret-trailers`.

**What is NOT explained by that fix, and is the live residual:** where `ticket-model-recovered-off` came
from. A double-stamp explains *two* trailers; it does not explain a *garbage value*. Something wrote a
non-ticket string into `PICKLE_TICKET_ID`. Until that source is found, the producer can stamp a value the
consumer will never match — silent mis-attribution, the exact failure mode this bundle exists to remove.

### Why it matters

A trailer is only worth replacing inference with if it is trustworthy. A garbage or duplicated trailer is
strictly worse than message inference, because the consumer *believes* it. If the consumer reads the last
trailer, `271587ae` attributes to a ticket that does not exist.

### Fix direction (subtractive first)

- Find the `PICKLE_TICKET_ID` writer that can emit a non-hash value; constrain it at the source rather than
  sanitizing at the hook. A validation regex in the hook is a second guard around a wrong input.
- Add a producer AC: the stamped value MUST match `^[0-9a-f]{8}$`; a non-conforming id is a hard skip
  (stamp nothing) rather than a stamped-anyway.
- Add a consumer AC: a commit carrying ≥2 `Pickle-Ticket` trailers is **ambiguous → attribute to NEITHER**,
  mirroring the existing `scanGitLogByFileTouch` ambiguity rule. Never silently take the first or last.

---

## R-DSPW — the manager spawns a SECOND worker for a ticket while the first is still alive

### Evidence

Two concurrent `spawn-morty.js` processes for the same ticket `6b7c3b82`, both descending from the **same**
manager, so this is not a dual-runner/orphan situation:

```
 8332  ppid 7989   etime 13:40   spawn-morty.js "Harden: test quality review…"  --ticket-id 6b7c3b82
 4478  ppid 4128   etime 03:04   spawn-morty.js "Harden: test quality review…"  --ticket-id 6b7c3b82

both →  zsh → 40783 claude manager → 22267 mux-runner → 21833 pipeline-runner   (one shared chain)
```

The runner pane shows the manager's own decision:
`{"type":"system","subtype":"task_started","description":"Re-spawn Morty for 6b7c3b82 to resume"}`

So the manager decided to re-spawn a worker to "resume" ticket `6b7c3b82` **without reaping the worker
already running it**. The older worker is 13m40s in; the newer is 3m04s in. Both hold the same ticket
directory.

### Why it matters

Two live workers on one ticket race on: the ticket file's frontmatter (status / `completion_commit`), the
lifecycle artifacts in the ticket dir, the git index, and `PICKLE_TICKET_ID`-stamped commits. Plausible
consequences include interleaved commits, a lost artifact write, and a Done flip racing a still-working
worker. This is a contention class distinct from the known dual-`pipeline-runner` recipe
(`project_dual_pipeline_runner_orphan_contends_on_shared_state`) — there the two trees are separate; here
one manager knowingly created the second worker.

### Open question the fix must answer

Why did the manager judge the ticket in need of "resume" while its worker was alive and only 10 minutes in?
Candidates worth checking before proposing a fix: a liveness probe keyed on artifact mtime rather than
process liveness; a silent-death detector firing on a worker that is merely slow; or a re-spawn path that
never consults `isProcessAlive` on the recorded worker pid.

### Fix direction (subtractive first)

- Before any re-spawn-to-resume, check whether a `spawn-morty` for that ticket id is **provably alive**
  (positive pid liveness, the `orphan-reaper` precedent). Alive → do not spawn; extend the wait.
- Prefer removing whatever heuristic declared the live worker dead over adding a new "is there already a
  worker" guard beside it — two guards for one decision is the smell.

---

## Disposition

Both filed, neither fixed. The run was **not** interrupted: the pipeline is healthy at 8/10 Done and
intervening on a live 5h30m run risks destroying verified work for a defect that is already recorded.
R-DSPW's duplicate worker is left running deliberately — reaping the wrong one of two live workers is the
more expensive mistake.

**Verification note for whoever drains these:** R-GTDT's double-stamp half may already be fixed by
`2717dd7f` + `c3f82776`. Grep HEAD before building — this repo's ledger drifts, and a fix landing mid-run
is exactly the case that produces a stale finding.
