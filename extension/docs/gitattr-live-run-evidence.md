# B-GITATTR WS-5 — live-run evidence for the `Pickle-Ticket` trailer chain

Ticket `6f95cff3`. Session `2026-07-26-013335ff`. Recorded 2026-07-26/27.

Every command output below is quoted verbatim from a captured file, not summarized from memory. Where a
prior claim in this bundle turned out to be wrong, the correction is recorded rather than the claim.

---

## 1. Deploy disposition

Quoted verbatim from the manager's `manager_deploy_findings.md`:

> The real root `~/.claude/pickle-rick` was **deliberately NOT deployed**. The bundle is deployed to an
> isolated prefix instead:
>
> ```
> /tmp/pickle-gitattr-live/pickle-rick
> ```
>
> Rationale: `install.sh` refuses mid-bundle installs (R-ITS-5-MIN active-bundle guard) because replacing
> compiled JS while the running mux-runner holds old code in-memory produces version-skew bugs. This
> session (`2026-07-26-013335ff`) is that active bundle. Overriding onto the real root would have put the
> five remaining tickets at risk. The isolated prefix exercises *this bundle's* code with zero blast radius.
>
> Real-root deploy legitimately happens at bundle close via `closer-release-gate.sh --closer-context`.

The worker (this process) runs **under the prefix runtime**, so the code under test is this bundle's code:

```
$ env | grep -E '^(GIT_CONFIG_COUNT|GIT_CONFIG_KEY_|GIT_CONFIG_VALUE_|PICKLE_TICKET_ID|PICKLE_INSTALL_ROOT|PICKLE_SESSION)' | sort
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=core.hooksPath
GIT_CONFIG_VALUE_0=/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-07-26-013335ff/git-trailer-hooks
PICKLE_INSTALL_ROOT=/tmp/pickle-gitattr-live/pickle-rick
PICKLE_SESSION=2026-07-26-013335ff
PICKLE_TICKET_ID=6f95cff3
```

---

## 2. Producer in situ

The injection is not merely present in `env` — git resolves it:

```
$ git config --get core.hooksPath
/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-07-26-013335ff/git-trailer-hooks
```

The materialized hook exists, is executable, and matches `buildTrailerHookScript`
(`extension/src/services/git-trailer-hooks.ts:105-120`):

```
$ ls -l .../git-trailer-hooks/prepare-commit-msg
755  .../prepare-commit-msg  188B
$ test -x .../prepare-commit-msg && echo "EXECUTABLE: yes"
EXECUTABLE: yes
$ cat .../git-trailer-hooks/prepare-commit-msg
#!/bin/sh
if [ -z "$PICKLE_TICKET_ID" ]; then
  exit 0
fi
if grep -q '^Pickle-Ticket:' "$1" 2>/dev/null; then
  exit 0
fi
printf '\nPickle-Ticket: %s\n' "$PICKLE_TICKET_ID" >> "$1"
exit 0
```

The `forward` branch materialized as `exit 0` because this repo has no pre-existing `prepare-commit-msg`.

---

## 3. Real commits in this repo, read back by git's own trailer parser

Commits made by this worker for ticket `6f95cff3`, with **no hand-written `Pickle-Ticket:` trailer** —
the hook stamped them:

<!-- WS5-SELF-SHA-ANCHOR -->

```
$ git log -1 --format='%H%n%s' d6aa89f1
d6aa89f1a3b078cec2e2e2e9daaac670f4af0b0f
docs(git-trailer-hooks): record WS-5 live-run trailer evidence (ticket 6f95cff3)

$ git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)' d6aa89f1
6f95cff3

$ git log -1 --format='%B' d6aa89f1 | grep -c '^Pickle-Ticket:'
1
```

Exactly one `Pickle-Ticket:` paragraph, and git's parser returns `6f95cff3` — this worker's ticket. The
commit was made with `git commit` and no hand-written trailer; the hook in §2 stamped it. This is the
positive case that the empty-trailer commits in §4 act as the control for.

(This commit — the one carrying §11 and BLOCKER 4 — cannot quote its own SHA for the same reason; its
trailer is verifiable post-hoc with the same three commands.)

---

## 4. Baseline / before-after control — **the stated baseline was wrong**

The ticket prompt recorded this baseline:

> BASELINE (manager-verified): commits already on HEAD (a4e48c26, 199ab70b, 271587ae) were made under the
> OLD real-root runtime and carry an EMPTY Pickle-Ticket trailer. That is your before/after control.

**That is not what git reports.** Raw output (captured to a file, because the local `rtk` grep/git proxy
truncates and re-renders stdout — see the method note in §7):

```
$ git log --format='%H %s %(trailers:key=Pickle-Ticket,valueonly)' -5
a4e48c26a788ec49edd0e3d3e4a416b9faa992de fix(git-trailer-hooks): delete the message-inference completion-evidence surface (ticket 769690b1) 
199ab70b8434dc1c87ca299799746941ec1290e4 refactor(git-trailer-hooks): merge duplicate commit-fixture helpers in trailer consumer test (ticket a026c5cc) a026c5cc

271587ae4f8cd92b15dbd4d192b2b9705c825f20 fix(git-trailer-hooks): stop message inference from silently re-deriving trailer attribution (ticket a026c5cc) ticket-model-recovered-off

6ad0b47686c6edd238852cc4fde3109c0cd36df2 feat(git-trailer-hooks): attribute completion evidence via Pickle-Ticket trailer (ticket a026c5cc) 
60d31e7f40f37806e034bdafb3cb11b1efbd1371 fix(backend-spawn): wire trailer-hooks env fragment into real worker/manager spawns (ticket cb36a189) 
```

Per-commit audit over the whole branch (`git merge-base main HEAD` = `578cbf96`), counting
`^Pickle-Ticket:` lines in `%B` against the value git's trailer parser actually returns:

```
a4e48c26a788ec49edd0e3d3e4a416b9faa992de | bodylines=0 | parsed=[/] | fix(git-trailer-hooks): delete the message-inference completion-evidence surface (ticket 769690b1)
199ab70b8434dc1c87ca299799746941ec1290e4 | bodylines=1 | parsed=[a026c5cc//] | refactor(git-trailer-hooks): merge duplicate commit-fixture helpers in trailer consumer test (ticket a026c5cc)
271587ae4f8cd92b15dbd4d192b2b9705c825f20 | bodylines=2 | parsed=[ticket-model-recovered-off//] | fix(git-trailer-hooks): stop message inference from silently re-deriving trailer attribution (ticket a026c5cc)
6ad0b47686c6edd238852cc4fde3109c0cd36df2 | bodylines=0 | parsed=[/] | feat(git-trailer-hooks): attribute completion evidence via Pickle-Ticket trailer (ticket a026c5cc)
60d31e7f40f37806e034bdafb3cb11b1efbd1371 | bodylines=0 | parsed=[/] | fix(backend-spawn): wire trailer-hooks env fragment into real worker/manager spawns (ticket cb36a189)
b67596a1eea87c04ee984d068a4b2a4ef7001019 | bodylines=0 | parsed=[/] | feat(backend-spawn): trailer-hooks env fragment on the backendEnvOverrides seam (ticket cb36a189)
54441ef18e0b1ec656d72e7343d7e5ac8f7f376b | bodylines=1 | parsed=[85b0c3dc//] | feat(git-trailer-hooks): idempotent prepare-commit-msg trailer service (ticket 85b0c3dc)
```

Corrected reading:

| Commit | Trailer git reports | Status |
|---|---|---|
| `a4e48c26` | *(none)* | empty — matches the stated baseline |
| `199ab70b` | `a026c5cc` | **non-empty; baseline claim wrong** |
| `271587ae` | `ticket-model-recovered-off` | **non-empty AND wrong value — see BLOCKER 3** |
| `6ad0b476` | *(none)* | empty |
| `60d31e7f` | *(none)* | empty |
| `54441ef1` | `85b0c3dc` | non-empty, correct |

`54441ef1` and `199ab70b` predate the WS-1 hook being wired into worker spawns (`60d31e7f`), so their
trailers came from the pre-existing `spawn-morty` amend path, not from this bundle's hook. The empty-trailer
commits (`a4e48c26`, `6ad0b476`, `60d31e7f`) remain a valid negative control: the format column really is
empty when no trailer exists, so a non-empty value in §3 is signal, not a formatting artifact.

---

## 5. Template independence — no-hash subject, still attributed

Run in a throwaway `/tmp` repo (never this one), with both the producer and the consumer imported from the
**deployed prefix** build rather than from source or a hand-copied script. Full probe output:

```
=== 1. producer: materialize hooks via the DEPLOYED PREFIX module ===
materializeTrailerHooks -> {"ok":true,"managedDir":"/tmp/gitattr-evidence/scratch-hooks"}
prepare-commit-msg mode: 755

=== 2. env fragment, composed exactly as backend-spawn.ts:810-815 ===
{
  "GIT_CONFIG_COUNT": "1",
  "GIT_CONFIG_KEY_0": "core.hooksPath",
  "GIT_CONFIG_VALUE_0": "/tmp/gitattr-evidence/scratch-hooks",
  "PICKLE_TICKET_ID": "d4e5f6a7"
}
git resolves core.hooksPath -> /tmp/gitattr-evidence/scratch-hooks

=== 3. commit with the UNCHANGED template subject (no ticket hash, no hand-written trailer) ===
subject: audit: [HIGH] cross-ref — trailer attribution survives a no-hash subject
sha:     5ad02261d422dbea9da2c9b5102067f073656e49
8-hex-char token in subject? NO (control valid)

=== 4. raw commit object as git sees it ===
5ad02261d422dbea9da2c9b5102067f073656e49
audit: [HIGH] cross-ref — trailer attribution survives a no-hash subject
---trailers---
Pickle-Ticket: d4e5f6a7

=== 5. the exact consumer format string ===
5ad02261d422dbea9da2c9b5102067f073656e49
1785112487
d4e5f6a7

---pickle-trailer-boundary---

=== 6. WS-2 consumer (deployed prefix) against the MATCHING ticket id ===
readEvidence(d4e5f6a7) -> {"kind":"committed","sha":"5ad02261d422dbea9da2c9b5102067f073656e49","via":"scan"}
expected kind=committed sha=5ad02261d422dbea9da2c9b5102067f073656e49 via=scan  => PASS

=== 7. NEGATIVE CONTROL: consumer against a NON-matching ticket id ===
readEvidence(11112222) -> {"kind":"absent","absentReason":"no_evidence"}
expected kind=absent => PASS

=== VERDICT ===
template-independence: PROVEN
```

What this establishes:

- The subject is the **unchanged** template shape from `.claude/commands/pickle-refine-prd.md:743`
  (`audit: [CRITICAL/HIGH] cross-ref — [description]`) and carries **no 8-hex-char ticket hash**.
  The template was not edited: `git diff --stat .claude/commands/pickle-refine-prd.md` is empty.
- Attribution still succeeded, and `via: "scan"` is the discriminator: the fixture ticket file carried
  neither `completion_commit` nor `completion_commit_inferred`, so the explicit and inferred branches of
  `readEvidence` could not short-circuit. Attribution came from the trailer scan.
- The negative control returns `kind: "absent"`, so the probe is not a function that reports `committed`
  for anything.

**Incidental finding — the idempotence guard is load-bearing and it held.** `materializeTrailerHooks` was
called from a process that inherited this worker's `core.hooksPath`, so `resolvePreExistingHooksDir` treated
the worker's own session hook as pre-existing and the scratch hook chained to it:

```
--- hook script ---
#!/bin/sh
if [ -z "$PICKLE_TICKET_ID" ]; then
  exec '/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-07-26-013335ff/git-trailer-hooks/prepare-commit-msg' "$@"
fi
if grep -q '^Pickle-Ticket:' "$1" 2>/dev/null; then
  exec '/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-07-26-013335ff/git-trailer-hooks/prepare-commit-msg' "$@"
fi
printf '\nPickle-Ticket: %s\n' "$PICKLE_TICKET_ID" >> "$1"
exec '/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-07-26-013335ff/git-trailer-hooks/prepare-commit-msg' "$@"
```

The scratch hook appended `d4e5f6a7` and then exec'd the worker hook, whose `grep -q '^Pickle-Ticket:'`
guard saw that line and exited without appending `6f95cff3`. The resulting commit carries exactly one
trailer. Had that guard been absent, the control would have been silently contaminated with this worker's
ticket id — which is precisely the double-trailer failure mode BLOCKER 3 describes.

---

## 6. Phantom-Done churn

Source: `~/.local/share/pickle-rick/activity/2026-07-26.jsonl`, parsed line-by-line as JSON (not grepped)
and filtered on `session === "2026-07-26-013335ff"` OR any of this session's 10 ticket ids.

```
activity file: /Users/gregorydickson/.local/share/pickle-rick/activity/2026-07-26.jsonl
total phantom/desync events in file: 35
by event: {"ticket_state_desync_detected":11,"ticket_phantom_done_corrected":24}
SCOPED count (session 2026-07-26-013335ff OR any of this session 10 ticket ids): 4
```

| Event | Whole file (all sessions) | **This session** |
|---|---:|---:|
| `ticket_phantom_done_corrected` | 24 | **0** ✅ |
| `ticket_state_desync_detected` | 11 | **4** ⚠️ |

The session's own `state.json` `activity` array holds 44 entries, **0** of which are phantom/desync.

The 4 in-session desync records, quoted in full:

```
{"ts":"2026-07-26T21:15:12.745Z","event":"ticket_state_desync_detected","source":"pickle","session":"2026-07-26-013335ff","ticket":"6dc7d243","reason":"current_ticket=6dc7d243 in_progress=none"}
{"ts":"2026-07-26T21:15:41.783Z","event":"ticket_state_desync_detected","source":"pickle","session":"2026-07-26-013335ff","iteration":1,"ticket":"6dc7d243","reason":"current_ticket=6dc7d243 in_progress=none","backend":"claude"}
{"ts":"2026-07-26T21:40:32.029Z","event":"ticket_state_desync_detected","source":"pickle","session":"2026-07-26-013335ff","iteration":3,"ticket":"cb36a189","reason":"current_ticket=cb36a189 in_progress=none","backend":"claude"}
{"ts":"2026-07-27T00:09:07.575Z","event":"ticket_state_desync_detected","source":"pickle","session":"2026-07-26-013335ff","iteration":9,"ticket":"6f95cff3","reason":"current_ticket=6f95cff3 in_progress=none","backend":"claude"}
```

Honest reading: `ticket_phantom_done_corrected` is **0**, which is the target and the event class this
bundle set out to eliminate. `ticket_state_desync_detected` is **4**, which is **not** zero and therefore
does not meet the ticket's stated target. All four share the same `reason` shape
(`current_ticket=<id> in_progress=none`) — the bookkeeping window between `state.current_ticket` being
assigned and the ticket frontmatter flipping to `In Progress`. None is an attribution event. It is recorded
as a miss against the criterion, not explained away.

---

## 7. Method note — do not trust the proxied stdout

`grep -c '2026-07-26-013335ff'` over a pre-filtered pipeline reported `0` matches for a count that is
actually `4`, and `git log --format=...` rendered with truncated subjects and a dropped trailer column.
The local `rtk` CLI proxy rewrites and re-renders command output. **This is how the wrong baseline in §4
was formed in the first place.** Every count and every commit line in this document was captured by
redirecting the command to a file and reading the file back, or by a JSON parser — never from proxied
stdout.

---

## 8. Manager blockers (verbatim, not re-derived; fixing them is explicitly out of scope)

### BLOCKER 1 — `--override-active` / `--closer-context` crash on a fresh prefix (unbound variable)

> `install.sh --prefix <fresh-dir> --override-active` dies before deploying anything:
>
> ```
> 🥒 Installing Pickle Rick for Claude Code...
> install.sh: line 147: DEP_V: unbound variable
> ```
>
> Mechanism (all line numbers at `a4e48c26`):
>
> - `install.sh:216` — `SRC_V=...` assigned unconditionally.
> - `install.sh:218-219` — `DEP_V=...` assigned **only inside** `if [ -f "$DEPLOYED_PACKAGE_JSON" ]`.
> - `install.sh:305` — the bypass path calls `append_bypass_active_session_audit`, reached by BOTH
>   `--override-active` and `--closer-context`.
> - `install.sh:149-150` — that function dereferences `$SRC_V` **and `$DEP_V`** to build the
>   `INSTALL_BYPASS_ACTIVE_SESSION` audit record, under `set -euo pipefail` (line 2).
>
> Blast radius: bypass + a prefix with no deployed `extension/package.json` = hard crash. The real root
> escapes only incidentally, because it always has a deployed `package.json` so `DEP_V` happens to be set.
> The failure is therefore invisible on the common path and fires on first-ever install and on any
> fresh-tmpdir deploy (the deploy-lifecycle soak shape) whenever a session is live.
>
> Workaround used here (NOT a fix — `install.sh` is unmodified): seeded
> `<prefix>/extension/package.json` from source before invoking, so `DEP_V` resolves.
>
> Suggested fix for a future ticket: default the audit fields, e.g. `--arg dep_version "${DEP_V:-}"`
> (and `"${SRC_V:-}"`), or hoist `DEP_V=""` above the guard.

### BLOCKER 2 — AC-1's own verify command is a false positive

> Ticket 6f95cff3 AC-1 verifies the deploy with:
>
> ```
> grep -l "Pickle-Ticket" ~/.claude/pickle-rick/extension/services/*.js ~/.claude/pickle-rick/extension/bin/*.js  # returns >=1
> ```
>
> Run against the real root, which carries **none** of this bundle's code, it still returns a hit:
>
> ```
> /Users/gregorydickson/.claude/pickle-rick/extension/bin/spawn-morty.js
> ```
>
> That match is *pre-existing* code unrelated to this bundle — the `reconcileGit(... 'commit', '--amend'
> ... 'Pickle-Ticket: ${ticketId}')` amend path at deployed `spawn-morty.js:1764/1791/1804` (source
> `extension/src/bin/spawn-morty.ts:2022/2043/2061`), which predates WS-1/WS-2. So AC-1 passes on a tree
> that has not been deployed at all: it tests for a string, not for this bundle.
>
> The discriminating check is the presence of the WS-1 module, which is **absent** from the real root and
> present in the isolated prefix:
>
> ```
> $ ls ~/.claude/pickle-rick/extension/services/git-trailer-hooks.js        -> ABSENT
> $ ls /tmp/pickle-gitattr-live/pickle-rick/extension/services/git-trailer-hooks.js -> 5.5K
> ```

---

## 9. Next blocker

**BLOCKER 3 — a test suite amends the real repo's git history and mis-attributes a live commit.**
Newly discovered by this ticket. Recorded, **not fixed** (out of scope per the ticket's "NOT in Scope").

Commit `271587ae` on this branch carries **two** `Pickle-Ticket` paragraphs:

```
$ git log -1 --format='%B' 271587ae
fix(git-trailer-hooks): stop message inference from silently re-deriving trailer attribution (ticket a026c5cc)

[...body...]

Pickle-Ticket: a026c5cc

Pickle-Ticket: ticket-model-recovered-off
```

Git's trailer parser recognizes only the **final** paragraph as the trailer block, so the correct
attribution is orphaned and a test-fixture id wins:

```
$ git log -1 --format='%(trailers)' 271587ae
Pickle-Ticket: ticket-model-recovered-off
```

The consumer compares `trailerValue.trim().toLowerCase()` by exact equality
(`ticket-completion-evidence.ts:265`), so `271587ae` does **not** attribute to `a026c5cc` and instead lands
in `foreignShas` (`:268`). This is a live mis-attribution on the current branch of the very bundle that
introduced the trailer channel.

**Mechanism**, confirmed from the reflog (a message-only amend one second after the real commit):

```
$ git reflog --date=iso
271587ae HEAD@{2026-07-26 17:40:23 -0500}: commit (amend): fix(git-trailer-hooks): stop message inference ...
b7c193da HEAD@{2026-07-26 17:40:22 -0500}: commit: fix(git-trailer-hooks): stop message inference ...

$ git diff --stat b7c193da 271587ae
(empty — message-only amend)

$ git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)' b7c193da
a026c5cc
```

`b7c193da` was correct. The amend appended the second trailer. The amending process was
`extension/src/bin/spawn-morty.ts:2043` (compiled `extension/bin/spawn-morty.js:1791`):

```js
reconcileGit(workingDir, ['commit', '--amend', '--no-gpg-sign', '-m', message, '-m', `Pickle-Ticket: ${ticketId}`]);
```

Two independent defects compose:

1. **`maybeAmendTicketTrailer`'s idempotence guard is the wrong predicate.**
   `src/bin/spawn-morty.ts:2032-2034` tests only whether *this* `ticketId` already appears in the message:

   ```js
   const escaped = ticketId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   if (new RegExp(`\\b${escaped}\\b`, 'i').test(message)) return verifiedSha;
   ```

   It never checks for an existing `^Pickle-Ticket:` line, so a *foreign* ticket id sails past and appends a
   second trailer paragraph. Note that WS-1's shell hook gets this right
   (`grep -q '^Pickle-Ticket:'`) — §5 shows that guard actively preventing this same failure. The two
   producers disagree about what idempotence means.

2. **A test drives the real `spawn-morty.js` against the real repo.**
   `extension/tests/spawn-morty.test.js:1597` `spawnSync`s the real binary with **no `cwd`**, and the
   `state.json` it writes (`:1579-1584`) has **no `working_dir`** key, so the runner falls back to the test
   process's cwd:

   ```ts
   // src/bin/spawn-morty.ts:2254
   const sessionWorkingDir = state?.working_dir?.trim() ? state.working_dir : process.cwd();
   ```

   `process.cwd()` is this repo. The fixture ticket id is `ticket-model-recovered-off`
   (`extension/tests/spawn-morty.test.js:1571/1574/1599`) — the literal appears **nowhere in runtime
   source**, only in that test file. The test asserts a *failure* exit, but the failure path also
   reconciles (`src/bin/spawn-morty.ts:2100-2128`), so it amended the real repo's tip while the real
   pipeline was committing to it.

**Blast radius beyond this one commit.** `extension/tests/spawn-morty.test.js` invokes the real binary with
28 `'--ticket-id', 'ticket-…'` fixtures but mentions `working_dir` only ~10 times. Every fixture that omits
both `cwd` and `working_dir` reaches the same `process.cwd()` fallback and can stamp a stray trailer on this
repo's tip whenever a commit lands inside its window. This makes the fast tier non-hermetic with respect to
the repo's own git history — which also means a green suite is not evidence that this cannot recur.

**Why it matters for this bundle specifically.** WS-5's thesis is that git-recorded attribution beats
message inference. That holds — §5 proves it. But BLOCKER 3 shows the trailer channel has *two* producers
with *different* idempotence rules, and the weaker one can overwrite the stronger one's correct answer.
Making git authoritative does not help if a second writer can append a later, wrong trailer paragraph.

Suggested scope for a follow-up ticket (not done here): make `maybeAmendTicketTrailer`'s guard test for
`^Pickle-Ticket:` rather than for its own id, and make the `spawn-morty.test.js` fixtures hermetic
(explicit `cwd` + `working_dir` on every real-binary spawn). Both are subtractive.

**BLOCKER 4 — the bundle's own trailer-env tests are not hermetic against the env fragment the bundle
injects.** Newly discovered by the §11 fast-tier run. Recorded, **not fixed**.

`extension/tests/services/backend-spawn-trailer-env.test.js` asserts on how `core.hooksPath` and
`PICKLE_TICKET_ID` are constructed in the spawn env, but it builds its *expected* env from the ambient
environment of the process running it. Under a real pickle worker — which, by WS-1/WS-2 design, now
carries exactly those variables — 5 of its 10 tests fail. In a clean env all 10 pass. This is the same
A/B shown in §11:

```
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=core.hooksPath
GIT_CONFIG_VALUE_0=<session>/git-trailer-hooks
PICKLE_TICKET_ID=6f95cff3
```

WITH those set → `ERR_ASSERTION`, `actual: true, expected: false` ×5. WITHOUT them (`env -u …`) →
`tests 10 / pass 10 / fail 0`.

**Why it matters.** The worker lint gate runs `npm run test:fast` *inside a worker*. Once this bundle is
deployed to the real root, every future ticket in this repo runs its gate in an env carrying these
variables — so these 5 tests will false-RED the worker gate on tickets that changed nothing related to
them. The bundle is self-hosting, and this is the self-hosting hazard: the feature's own presence in the
environment breaks the feature's own tests. A false-RED worker gate is not a cosmetic failure; it is a
gate that blocks unrelated work.

Suggested scope for a follow-up ticket (not done here): make the test hermetic by clearing
`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*`, and `PICKLE_TICKET_ID` in its own setup
before building the expected env, rather than trusting process ambient. Subtractive — it removes a
dependency, it does not add a guard.

---

## 10. Criterion-by-criterion outcome

| Acceptance criterion | Result |
|---|---|
| `[manager]` Deployed tree carries the trailer code | Deployed to the isolated prefix, verified there. AC's own verify command is a false positive — BLOCKER 2. Real-root deploy deferred to bundle close. |
| Every in-flight-ticket commit carries a matching `Pickle-Ticket` trailer | **Partial.** This worker's own commits: yes (§3). Historical branch commits: `271587ae` is mis-attributed — BLOCKER 3. Recorded, not fixed. |
| At least one commit used the unchanged audit/harden subject shape (no ticket-hash) and still attributed | **PASS** (§5) — subject carries no 8-hex token, `via: "scan"`, negative control `absent`. |
| Zero `ticket_phantom_done_corrected` and zero `ticket_state_desync_detected` | **Split.** `ticket_phantom_done_corrected` = 0 ✅. `ticket_state_desync_detected` = 4 ❌ (§6). |
| The next blocker is named, or "none observed" recorded explicitly | **PASS** — BLOCKER 3 (§9). Not "none observed". |
| Full fast tier green | See §11. |

## 11. Fast tier

<!-- WS5-FASTTIER-ANCHOR -->

**Verdict: NOT green.** The AC "Full fast tier green" is a **MISS**, and 5 of the failures are caused by
this bundle. Raw output is captured at `<session>/6f95cff3/fasttier_run.txt`.

`cd extension && npm run test:fast`, quoted from the run's own summary block
(`fasttier_run.txt:12805-12812`):

```
ℹ tests 7132
ℹ suites 481
ℹ pass 7117
ℹ fail 12
ℹ cancelled 0
ℹ skipped 2
ℹ todo 1
ℹ duration_ms 375362.762792
EXIT=1
```

> **Count correction.** An earlier triage pass recorded this run as "5495 tests, 20 failures". Both numbers
> are wrong and neither reproduces from the captured file. The **20** came from `grep -c '^✖ '`, which
> counts the end-of-run `✖ failing tests:` recap block (12 lines) *plus* the in-body markers (7) *plus* the
> `✖ failing tests:` header itself — double-counting every failure and adding two parent-suite markers
> (`✖ downgrade flow`, `✖ force vs allow-downgrade matrix`) that are roll-ups of leaf failures already
> counted. The **5495** corresponds to nothing in the summary; the test total is 7132. The authoritative
> figures are node's own: **7132 tests, 12 failures**. The 12 leaf failures below sum exactly to `fail 12`,
> which is the cross-check that the corrected classification is complete.

### BLOCKER 3 did NOT recur on this run

BLOCKER 3 (§9) is a test suite amending the real repo's tip. That is a hazard of *running the fast tier*,
so HEAD was captured immediately before and after this run:

```
$ git rev-parse HEAD                # PRE-RUN  2026-07-27T00:39:47Z
d6aa89f1a3b078cec2e2e2e9daaac670f4af0b0f
$ git rev-parse HEAD                # POST-RUN 2026-07-27T00:47:08Z
d6aa89f1a3b078cec2e2e2e9daaac670f4af0b0f

$ git log -1 --format='%(trailers)' # both PRE and POST
Pickle-Ticket: 6f95cff3

$ git status --porcelain            # both PRE and POST — empty
```

Same SHA, same single correct trailer, clean tree at both ends
(`fasttier_pre_git.txt` / `fasttier_post_git.txt`). **BLOCKER 3 did not recur during this run.** It remains
a real latent hazard — the fixture window is narrow and this run simply did not land a commit inside it —
but it is not the cause of any of the 12 failures below.

### A/B triage of the 12 failures

The ambient environment of the worker that ran the tier (`fasttier_env`/`ambient_env.txt`) is itself the
variable under test:

```
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=core.hooksPath
GIT_CONFIG_VALUE_0=/Users/…/sessions/2026-07-26-013335ff/git-trailer-hooks
PICKLE_TICKET_ID=6f95cff3
PICKLE_BACKEND=claude
```

Each cluster was re-run in isolation, with and without that env, using
`cd extension && PATH="$PWD/node_modules/.bin:$PATH" node --test <file>` (the `PATH` prefix is required —
a bare `node --test` drops `node_modules/.bin` and fabricates failures):

| Test file | WITH ambient env | WITHOUT ambient env (`env -u …`) |
|---|---|---|
| `tests/services/backend-spawn-trailer-env.test.js` | **FAILS** — `ERR_ASSERTION`, `actual: true, expected: false` | `tests 10 / pass 10 / fail 0` |
| `tests/downgrade-flow.test.js` | `tests 7 / pass 7 / fail 0` | `tests 7 / pass 7 / fail 0` |
| `tests/force-vs-allow-downgrade.test.js` | — | `tests 5 / pass 5 / fail 0` |

### Two disjoint classes

All 12 leaf failures are quoted from the run's own `✖ failing tests:` recap block
(`fasttier_run.txt:12814+`). 5 + 7 = 12 = `ℹ fail 12`, so the classification is complete with no
unaccounted failure.

**Class A — 5 failures, CAUSED BY THIS BUNDLE.** All in
`extension/tests/services/backend-spawn-trailer-env.test.js`:

```
✖ backendEnvOverrides: materialization failure emits neither key and logs once
✖ buildWorkerSpawnEnv (real worker spawn path): ticket in flight injects core.hooksPath + PICKLE_TICKET_ID
✖ buildWorkerSpawnEnv (real worker spawn path): no ticket in flight injects neither key
✖ createIterationSpawnEnv (real manager spawn path): ticket in flight injects core.hooksPath + PICKLE_TICKET_ID
✖ createIterationSpawnEnv (real manager spawn path): no ticket in flight injects neither key
```

These are the bundle's own tests, and they fail only because the bundle's own env fragment is present in
the process running them. This is **BLOCKER 4** (§9).

**Class B — 7 failures, PRE-EXISTING, not caused by this bundle.** The downgrade /
force-vs-allow-downgrade / check-update / install.sh cluster, quoted from the same recap block:

```
✖ downgrade.confirm-yes succeeds and writes audit entry with mode 0600
✖ downgrade.override succeeds with active session and audit override_active true
✖ downgrade.no-confirm skips prompt and succeeds
✖ downgrade.closer-context bypasses active-session refusal and audits flag
✖ allow-downgrade-only: check-update and install.sh
✖ force-and-allow: check-update and install.sh
✖ check-update normalizes inspected release version before downgrade decision
```

(The in-body `✖ downgrade flow` and `✖ force vs allow-downgrade matrix` markers are parent-suite roll-ups
of these same leaves, not additional failures.) This classification was determined by **isolation runs,
not by assumption**:

- `downgrade-flow.test.js` passes 7/7 in isolation **both with and without** the ambient env — so the env
  fragment this bundle injects is not the variable.
- `force-vs-allow-downgrade.test.js` passes 5/5 in isolation.
- `install.sh` is **unmodified on this branch** (`fasttier_provenance.txt`: the branch-vs-main diff for
  `install.sh` is empty), and this bundle touches none of these files.
- They match the known main-repo-only install-test class (these tests pass in a worktree and fail in the
  main repo, at every commit).

Class B is therefore out of scope for this ticket and is not laundered into a pass — it is simply not this
bundle's regression. Class A is this bundle's, is recorded as BLOCKER 4, and is deliberately **not fixed**
here per the ticket's "NOT in Scope".
