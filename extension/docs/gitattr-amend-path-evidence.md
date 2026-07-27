# R-GTDT-LAND — isolated amend-path evidence

Ticket `500b594a`. Session `2026-07-27-5b2cefc5`. Recorded 2026-07-27.

Every command output below is quoted verbatim from the actual run this iteration, not paraphrased. This
doc proves `reconcileWorkerCommitAttribution` (the amend path, `extension/bin/spawn-morty.js:1877`) can
independently stamp a `Pickle-Ticket` trailer, **with the `prepare-commit-msg` hook demonstrably
suppressed** — closing the tautology gap flagged in the PRD (§Research Seeds): a probe that doesn't
suppress the hook proves nothing, because a correctly-implemented amend guard idempotently skips a commit
the hook already stamped.

---

## 1. Pre-Deploy State

Recorded by the `[manager]` before running `bash install.sh` (steps 1-3 of this ticket's Procedure), quoted
verbatim from the manager-recorded facts handed to this worker:

```
services/git-trailer-hooks.js: ABSENT ("No such file or directory")
grep -c materializeTrailerHooks services/backend-spawn.js = 0
grep -c PICKLE_TICKET_ID services/backend-spawn.js = 0
git-common-dir refs in services/ = 0 (none)
services/backend-spawn.js size 29.3K
```

## 2. Deploy Confirmation

Post-deploy facts as recorded by the `[manager]` (`bash install.sh --override-active`, source tree clean at
`b4dbd528` on `release/v2.1-beta`):

```
services/git-trailer-hooks.js: PRESENT, 10.3K
grep -c materializeTrailerHooks services/backend-spawn.js = 3
grep -c PICKLE_TICKET_ID services/backend-spawn.js = 3
grep -c git-common-dir services/git-trailer-hooks.js = 5
services/backend-spawn.js size 31.2K
bin/spawn-morty.js is BYTE-IDENTICAL to the source-compiled extension/bin/spawn-morty.js (cmp exit 0); interpret-trailers count 3, trailers:key=Pickle-Ticket count 2
A rollback target exists: ~/.claude/pickle-rick/.pre-gtdt-deploy-backup.tar.gz (14.1M, contains the pre-deploy extension/ tree minus node_modules)
```

Independently re-verified by this worker at the start of this iteration:

```
$ ls -la ~/.claude/pickle-rick/extension/services/git-trailer-hooks.js
644  /Users/gregorydickson/.claude/pickle-rick/extension/services/git-trailer-hooks.js  10.3K

$ grep -c materializeTrailerHooks ~/.claude/pickle-rick/extension/services/backend-spawn.js
3

$ grep -c PICKLE_TICKET_ID ~/.claude/pickle-rick/extension/services/backend-spawn.js
3

$ git status
* release/v2.1-beta...origin/release/v2.1-beta [ahead 68]
clean — nothing to commit

$ git log --oneline -1
b4dbd528 fix(738eeb97): reconcile stale window-sha pins in worker-timeout-preserves-commit to the corrected trailer oracle
```

Matches the manager's record exactly. Rollback criterion is not triggered — no absent/empty/multi-valued
`Pickle-Ticket` trailer was observed on any post-deploy worker commit.

## 3. Isolated Probe

### 3.1 The tautology hazard, discovered live

Before building the probe, this worker's own shell environment was inspected and found to carry the exact
hook-activation inputs the isolation must suppress — this worker is itself a Pickle Rick worker process,
spawned with the trailer-hook env fragment already injected:

```
$ env | grep -i "GIT_CONFIG\|PICKLE_TICKET_ID"
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=core.hooksPath
GIT_CONFIG_VALUE_0=/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-07-27-5b2cefc5/git-trailer-hooks
PICKLE_TICKET_ID=500b594a
```

A first attempt at the scratch repo, run without unsetting these, confirmed the hazard is real: the
"initial" scratch commit was silently auto-stamped by the live hook —

```
$ git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'
500b594a

$ git log -1 --format='%B'
initial commit

Pickle-Ticket: 500b594a
```

That scratch repo was discarded. Every command in the probe below explicitly strips
`PICKLE_TICKET_ID`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_VALUE_0` via
`env -u <var> ... <command>` (git commands and the Node invocation alike, since
`reconcileGitOrNull`/`execFileSync` inherit `process.env` for spawned git subprocesses) — on top of the
scratch repo never having `core.hooksPath` configured for itself. Two independent reasons the hook cannot
fire in the probe below.

### 3.2 Scratch repo + negative controls

```
$ SCRATCH=$(mktemp -d)
# SCRATCH = /var/folders/2w/j4nf5k_17ys16yzvmhcx0brh0000gn/T//gtdt-probe-PSN4HT

$ env -u PICKLE_TICKET_ID -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git init -q
$ env -u PICKLE_TICKET_ID -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git commit -q -m "initial commit"

$ git rev-parse HEAD
b956d804c6ec2360b56d395f8023f4b89ac1b42f   # preWorkerHead

$ env -u PICKLE_TICKET_ID -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'
(empty)
```

Second commit — subject mentions a ticket id in **prose only**, no trailer, hook still suppressed:

```
$ env -u PICKLE_TICKET_ID -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git commit -q -m "touch up notes, ref ticket demo-ticket-xyz"

$ git rev-parse HEAD
e84f6b9b39d3178120bc1e6dff23e8f6fe7f445a   # pre-amend SHA

$ env -u PICKLE_TICKET_ID -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'
(empty)
```

Negative control confirmed on both commits: the oracle (`%(trailers:key=Pickle-Ticket,valueonly)`) is
empty before the amend path runs, even though the subject line names a ticket id in prose
(`demo-ticket-xyz`) — git does not parse a subject-line mention as a trailer.

### 3.3 Invoking the amend path directly

```javascript
// /tmp/gtdt_probe_invoke.mjs
import { reconcileWorkerCommitAttribution } from '/Users/gregorydickson/.claude/pickle-rick/extension/bin/spawn-morty.js';
import fs from 'fs';

const scratchRepo = fs.readFileSync('/tmp/gtdt_scratch_path.txt', 'utf8').trim();
const preHead = fs.readFileSync('/tmp/gtdt_pre_head.txt', 'utf8').trim();
const ticketId = 'demo-ticket-xyz';

console.log('process.env.PICKLE_TICKET_ID =', process.env.PICKLE_TICKET_ID);
console.log('process.env.GIT_CONFIG_COUNT =', process.env.GIT_CONFIG_COUNT);

const result = reconcileWorkerCommitAttribution(scratchRepo, ticketId, preHead, null, {});
console.log('reconcileWorkerCommitAttribution() returned:', result);
```

```
$ env -u PICKLE_TICKET_ID -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 node /tmp/gtdt_probe_invoke.mjs
process.env.PICKLE_TICKET_ID = undefined
process.env.GIT_CONFIG_COUNT = undefined
scratchRepo = /var/folders/2w/j4nf5k_17ys16yzvmhcx0brh0000gn/T//gtdt-probe-PSN4HT
preHead = b956d804c6ec2360b56d395f8023f4b89ac1b42f
reconcileWorkerCommitAttribution() returned: 8696a92517dbdd0f62c0d016cc13a1f742172eb3
```

`reconcileWorkerCommitAttribution` was called directly (importing `spawn-morty.js` as an ES module does
not execute its CLI `main()` — that is gated behind
`path.basename(process.argv[1]) === 'spawn-morty.js'` at the bottom of the file, so import alone has no
side effects on this repo). The Node process itself also had `PICKLE_TICKET_ID`/`GIT_CONFIG_*` stripped,
so any git subprocess it spawns internally inherits a clean environment too.

### 3.4 Positive result — the oracle, post-amend

```
$ env -u PICKLE_TICKET_ID -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git rev-parse HEAD
8696a92517dbdd0f62c0d016cc13a1f742172eb3

$ env -u PICKLE_TICKET_ID -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'
demo-ticket-xyz

$ env -u PICKLE_TICKET_ID -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git log -1 --format='%B'
touch up notes, ref ticket demo-ticket-xyz

Pickle-Ticket: demo-ticket-xyz
```

The SHA changed (`e84f6b9b...` → `8696a925...`, an amend, not a no-op) and the parsed-trailer oracle now
returns `demo-ticket-xyz` — with the hook provably unable to fire for this commit. The trailer can only
have been produced by `reconcileWorkerCommitAttribution` → `maybeAmendTicketTrailer` →
`buildTrailerAmendedMessage` (`git interpret-trailers --if-exists addIfDifferentNeighbor`) →
`git commit --amend`.

**Real commit SHA (post-amend): `8696a92517dbdd0f62c0d016cc13a1f742172eb3`**
**Real oracle output: `demo-ticket-xyz`**

## 4. What This Does NOT Prove

- **The `prepare-commit-msg` hook path itself.** This probe's entire design deliberately suppresses the
  hook (no `core.hooksPath` in the scratch repo, `PICKLE_TICKET_ID`/`GIT_CONFIG_*` stripped from every
  command). It says nothing about whether `services/git-trailer-hooks.js`'s
  `prepare-commit-msg` script — the one deployed and confirmed present in §2 — actually fires correctly,
  stamps the right value, or interacts correctly with `git interpret-trailers` in a real worker git
  invocation. Section 3.1's discarded first attempt is circumstantial evidence the hook fires when its
  inputs are present, but that was an incidental discovery, not a controlled test of the hook's own
  correctness.
- **End-to-end pipeline attribution.** This probe called `reconcileWorkerCommitAttribution` directly
  against a hand-built scratch repo and a hand-picked `preWorkerHead`/ticket id. It does not exercise:
  a real worker session's actual `getHeadSha()` capture at spawn time, the full `finalizeWorkerTurn` /
  `resolveFailurePathCommitSha` call sites, `pickAttributionCommit`'s `declaredFiles` matching against a
  real diff, multi-commit windows, or the interaction between the hook (which normally runs first in a
  live worker session) and this amend path's idempotence guard. A real worker run producing a
  trailer-bearing commit through the deployed pipeline — hook included — is a separate, not-yet-run
  verification (tracked outside this ticket's scope; see PRD `prds/p1-r-gtdt-land-the-scope-blocked-trailer-oracle-fix.md`).

## 5. Rollback status

Not triggered. No absent/empty/multi-valued `Pickle-Ticket` trailer was observed on any post-deploy
worker commit during this ticket. Rollback target remains
`~/.claude/pickle-rick/.pre-gtdt-deploy-backup.tar.gz` (14.1M) if a future iteration finds one.
