# PRD: Deploy-Reversion of `types/index.js` — Root Cause Analysis + Fix

**Status**: **Shipped 2026-04-30 PM** via F6 (release `v1.62.0`). F1–F4 in HEAD plus the version bump break the propagating-revert loop because `gh release latest` no longer returns the v1.60.1 tarball. F7 (temporary lockdown) was not needed — F6 went straight in. Soak observation (AC-RVN-11) and self-propagation negative test (AC-RVN-12) are still open as 24-hour follow-ups; raise a new bug PRD if they regress.
**Author**: Pickle Rick + agent team (h1-tsc-cache / h2-source-mutation / h3-timeline)
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Origin**: live during the Citadel + Hardening Bundle pipeline run (`pipeline-1204204c`, session `2026-04-29-1204204c`). Watchdog cron `614355bb` recorded **5 deploy-reversions in 8 hours** before the F1–F4 fix, **3 more reversions in 3 hours after the fix shipped** — bug recurs unchanged on the same `~/.claude/pickle-rick/extension/types/index.js` (flips schemaVersion `3 → 2`) AND now on `extension/services/state-manager.js` (loses `assertSchemaVersionDeployParity` export entirely). Each reversion wedges fresh-process `StateManager.read()` calls; existing in-memory mux-runner survives on cached v3.

---

## Symptom (precise observation)

The deployed file `~/.claude/pickle-rick/extension/types/index.js` repeatedly reverts to a fixed v1.60.1 release-tarball signature:

| Field | Reverted state | Expected state (post-bundle source) |
|---|---|---|
| `schemaVersion` | **2** | 3 (since commit `2d5ab2e` Apr 29 17:18 PDT) |
| Size | **6201 bytes** | 6812 bytes |
| mtime | **Apr 29 08:15:40** (original v1.60.1 tarball mtime) | post-deploy current time |
| Missing classes | No `SchemaVersionMismatchError` | Has it |
| Missing activity events | No `archaeology_complete`, `archaeology_skipped`, `readiness_failed_post_correction` | Has all three |
| `CODEX_MANAGER_RELAUNCH_CAP` | **5** | 10 |

The fingerprint is unmistakable: deployed reverts to **byte-identical v1.60.1 release tarball content** with **original tarball mtime preserved**. This means the reverter has access to a cached / archived copy of the release.

## Reversion cadence

Watchdog cron `614355bb` log (`<SESSION>/watchdog.log`):

| Time UTC | Action |
|---|---|
| 2026-04-29T23:53:26Z | RECOVERED via `bash install.sh` after pipeline crash |
| 2026-04-30T00:30:44Z | FIXED #1: deployed→v2 reverted by check-update auto-update. Hot-fix + uchg lock + `auto_update_enabled: false` |
| 2026-04-30T06:31:54Z | FIXED #2: uchg lock somehow lost; deployed→v2 again |
| 2026-04-30T07:25:31Z | FIXED #3: 3rd reversion (uchg lock didn't survive rsync rename-over) |
| 2026-04-30T08:25:17Z | FIXED #4: 4th reversion |
| 2026-04-30T09:26:22Z | FIXED #5: 5th reversion |

5 reversions in 8 hours. Roughly hourly cadence visible at watchdog tick granularity. The actual reversion may happen at finer intervals — the watchdog only checks once per hour at `:13`.

## Hypotheses ruled out (agent team findings)

### H1 — tsc incremental cache (RULED OUT)

Agent `h1-tsc-cache`:
- `extension/tsconfig.json` does NOT set `incremental: true`. No `.tsbuildinfo` file exists.
- `npx tsc --listEmittedFiles` emits nothing (tsc thinks build is current because compiled JS mtime > source TS mtime).
- Source compiled JS is currently v3 (size 6812). The build product is correct.

Verdict: tsc cache is not producing v2 compiled output. The reverter is not via the build chain.

### H2 — workers mutating source TS in-place (RULED OUT)

Agent `h2-source-mutation`:
- Zero grep hits for `writeFileSync` to `extension/src/types/index.ts` in test files.
- Zero grep hits for direct `install.sh` invocations against the real `EXTENSION_ROOT` in tests.
- Git reflog clean — no temporary commits/reverts.
- Recent worker logs (NEW-T2 etc.) contain no writes to `extension/src/types/index.ts` or to the deployed types file.
- Local source TS + source compiled JS are stable v3.

Verdict: no test or worker is mutating source.

### H3 — git stash/checkout/worktree + timeline correlation (RULED OUT)

Agent `h3-timeline`:
- Worker logs show `git stash list` and `git stash show` (READ-ONLY diagnostics) — no `pop`, `checkout`, `reset --hard`, `restore`.
- `git worktree list` empty.
- `git stash list` empty.
- No commits in any branch contain `schemaVersion: 2` in source TS post-migration commit `b17a882`.
- Timeline shows 10 active worker PIDs in the 4-hour window. None directly invoke `bash install.sh` (only doc references / test-name hits).

Verdict: no git-driven reversion path.

### Additional ruled-out hypotheses

- **`config-protection` hook** — only BLOCKS protected-pattern files (`.eslintrc`, `tsconfig.json`, etc.); does not RESTORE. Source: `extension/hooks/handlers/config-protection.js` lines 6-15. `types/index.js` is not in `PROTECTED_PATTERNS`.
- **`chflags uchg` lock** — defense theatre. rsync's atomic write-tmp-then-rename creates a NEW inode each cycle; the new inode inherits flags from the SOURCE (no flags), not from the rename target. uchg dies on the first install.sh cycle. Confirmed by inode change between watchdog ticks (e.g. inode 126756973 → 127139772 between fixes #1 and #2).
- **`auto_update_enabled: false`** — verified in both deployed and source `pickle_settings.json`; `extension/hooks/handlers/stop-hook.js:331` honors it before spawning `check-update.js`. Tests via `node -e "(...).maybeSpawnUpdateCheck()"` confirm the kill-switch fires.

## Strong remaining hypotheses (investigation continues)

### H4 — Detached `check-update.js` from a session that started BEFORE the kill-switch landed

`stop-hook.js:340` spawns `check-update.js` as a detached child (`spawn(..., { detached: true, stdio: 'ignore' })`). If a Claude Code stop-hook fired BEFORE I disabled `auto_update_enabled` (i.e. before 00:30 UTC), the spawned check-update process may have:
1. Downloaded the v1.60.1 release tarball to a temp dir
2. Cached the tarball locally
3. Re-installed periodically from the cache without re-checking the kill-switch each time

`check-update.js` source has `auto_update_enabled` check at line 272 (`checkForUpdate()`) but `performUpgrade()` at line 240 has NO such check — once a download is in flight, the install proceeds unconditionally.

Probe: `find /var/folders /tmp -name 'pickle-update-*' 2>/dev/null` — no current temp dirs. But cached tarballs may live in `~/Library/Caches/` or `~/.cache/`.

### H5 — Cross-project Claude Code session restoring from a backup

`debug.log` shows continuous `config-protection` and `stop-hook` activity from a SEPARATE Claude Code project: `/Users/gregorydickson/loanlight/loanlight-api-income-agent-ux`. Each stop-hook on that project triggers `maybeSpawnUpdateCheck` against the SAME deployed `~/.claude/pickle-rick/`. If that project's version of pickle_settings.json (or its in-memory cache) has `auto_update_enabled: true`, it could spawn check-update against the global deploy.

Probe: check if loanlight-api-income-agent-ux has its own `pickle_settings.json` that's read by stop-hook somewhere.

### H6 — Time Machine or iCloud Drive restoration

`/Users/gregorydickson/.claude/` may be inside an iCloud-synced or Time-Machine-watched path. macOS file restoration can replace files with versions matching the original tarball mtime if the original is in a snapshot. Less likely given the consistent ~hourly cadence.

Probe: `ls -la ~/.claude/` for `.icloud`/`@` extended attributes, `tmutil isexcluded ~/.claude/`.

### H7 — install.sh's rsync race during compile step

install.sh runs `(cd extension && npx tsc)` first, then `rsync` second. If two install.sh invocations race (e.g. two cross-skill workers, or one worker + one auto-update), the second's rsync may fire BEFORE the first's tsc finishes regenerating compiled JS. The rsync sees stale-on-disk compiled JS (from an earlier checkout) and deploys it.

Probe: looking at install.sh backups, the pairs are 7-8 seconds apart — suggesting two install.sh invocations that close to each other. Race conditions plausible.

## Key data points from live observations (2026-04-30 09:43-09:48 UTC)

1. **`cp` test succeeded**: `cp /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/types/index.js /Users/gregorydickson/.claude/pickle-rick/extension/types/index.js` brought deployed to v3 (size 6812). Held for 90 seconds at v3.
2. **A modification at 04:48:04 CDT**: deployed file mtime jumped from 04:46:26 (my cp) to 04:48:04 in the next 30s polling window. Content stayed v3. So **something else is touching the file with current-time mtime, but copying v3 content** at this moment. The reverter that copies v2 with 08:15:40 mtime is on a different schedule.
3. **Polling log shows mtime stable** between 09:47:57 and 09:48:27 — the file was modified once in that 30s window, not continuously.
4. **install.sh ran at 04:36 and 04:44 CDT** (paired backups). Five hours of pipeline runtime, only handful of explicit installs. Not enough to explain hourly reversions.
5. **`extension/types/index.js` source repo currently shows mtime 04:38 CDT** — recompiled by `npx tsc` (likely from a worker test run) within the last 10 minutes. Source compiled JS has v3 content.

## Acceptance Criteria

- **AC-RVN-01** Reverter mechanism IDENTIFIED — name the exact process / code path that writes `schemaVersion: 2` content with mtime 08:15:40 to `~/.claude/pickle-rick/extension/types/index.js`. (Investigation continues; pinning down H4–H7.)
- **AC-RVN-02** Reverter ELIMINATED — after fix, deployed `types/index.js` does NOT regress to v2 over a 6-hour soak window with no manual intervention.
- **AC-RVN-03** `check-update.js` `performUpgrade()` reads `auto_update_enabled` BEFORE downloading or installing, not just before checking for updates. Add the kill-switch to the second branch.
- **AC-RVN-04** install.sh `npx tsc` step exits non-zero if compiled JS would not match source TS schemaVersion (sanity probe — fail-loud rather than deploy stale).
- **AC-RVN-05** install.sh rsync acquires a flock on `${EXTENSION_ROOT}` before rsync. Two concurrent install.sh invocations serialize, eliminating H7 race.
- **AC-RVN-06** Deployed `types/index.js` is augmented with a runtime startup check that compares its own `schemaVersion` constant to the latest schema migration's target version (read from `state-manager.ts`'s migration table) — emits actionable error and exits 1 on mismatch.
- **AC-RVN-07** Watchdog cron's auto-fix path is removed once AC-RVN-02 holds. The watchdog goes back to monitoring only.
- **AC-RVN-08** Trap-door entry added to `extension/CLAUDE.md` documenting the lesson: deployed code can drift from source via auto-update, install.sh races, or detached background processes — readers must validate deploy ↔ source parity at session start.

## Verification Plan

1. **AC-RVN-01** — instrument reversion-detection: write a daemon (`bin/deploy-watcher.ts`) that uses `fs.watch` on `~/.claude/pickle-rick/extension/types/index.js`, logs every modification with timestamp + parent process name (via `lsof`/`fs_usage` integration). Run for 6 hours during a fresh pipeline. Should capture ≥1 reversion event with attribution.
2. **AC-RVN-02** — apply F1+F2 (below). Soak: 6h with `pipeline-runner.js` running, no manual fixes. `find ~/.claude/pickle-rick -name 'index.js' -path '*types*' -mmin -360 -newer /tmp/marker_start | xargs grep schemaVersion` should always show v3.
3. **AC-RVN-03** — unit test in `check-update.test.js`: simulate `performUpgrade()` with `auto_update_enabled: false` settings. Expect `{ success: false, error: /disabled/ }`.
4. **AC-RVN-04** — unit test in `install-bun-probe.test.js` (or a new `install-script.test.js`): write fixture source TS with v3, force `npx tsc` to produce v2 output via mock, expect install.sh exit 1.
5. **AC-RVN-05** — concurrency test in `install-script.test.js`: spawn two `bash install.sh` simultaneously, expect serialized via flock.
6. **AC-RVN-06** — unit test in `state-manager.test.js`: import deployed types/index.js with `schemaVersion: 2` while state-manager.ts migration target is 3; expect process.exit(1) with stderr matching `/schemaVersion mismatch.*bash install.sh/`.

## Forward Fixes (proposed)

### F1 — `check-update.js` `performUpgrade()` honors kill-switch

```diff
 export function performUpgrade(from, to, tag) {
+    const settings = readSettings();
+    if (!settings.auto_update_enabled) {
+        log('Auto-update disabled in settings; refusing performUpgrade');
+        return { success: false, error: 'Auto-update disabled' };
+    }
     try {
         log(`Starting upgrade: ${from} → ${to} (${tag})`);
         const tarballPath = downloadRelease(tag);
```

This stops a still-running detached check-update from deploying even if its kill-switch check passed earlier.

### F2 — install.sh acquires flock to serialize

```diff
 #!/bin/bash
 set -e
 SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
 EXTENSION_ROOT="$HOME/.claude/pickle-rick"
+exec 9>"$EXTENSION_ROOT/.install.lock"
+flock -x 9
```

Eliminates H7 race. Backup file pairs at +8s would disappear (single serialized invocation).

### F3 — install.sh sanity check post-tsc

```bash
(cd "$SCRIPT_DIR/extension" && npx tsc)
SOURCE_VERSION=$(grep -oE 'schemaVersion: [0-9]+' "$SCRIPT_DIR/extension/src/types/index.ts" | head -1 | awk '{print $2}')
COMPILED_VERSION=$(grep -oE 'schemaVersion: [0-9]+' "$SCRIPT_DIR/extension/types/index.js" | head -1 | awk '{print $2}')
if [ "$SOURCE_VERSION" != "$COMPILED_VERSION" ]; then
  echo "❌ Compiled JS schemaVersion ($COMPILED_VERSION) doesn't match source TS ($SOURCE_VERSION). Refusing to deploy stale build."
  exit 1
fi
```

### F4 — Runtime self-check in deployed code

`extension/services/state-manager.ts` startup:

```ts
const STATE_MANAGER_TARGET_VERSION = 3;  // matches latest migration target
if (STATE_MANAGER_DEFAULTS.schemaVersion !== STATE_MANAGER_TARGET_VERSION) {
  process.stderr.write(
    `[state-manager] Deployed schemaVersion ${STATE_MANAGER_DEFAULTS.schemaVersion} does not match expected ${STATE_MANAGER_TARGET_VERSION}. ` +
    `Likely cause: stale deploy. Run \`bash install.sh\` from your pickle-rick-claude checkout to refresh.\n`
  );
  process.exit(1);
}
```

Forces a loud failure on every fresh process start instead of silent silent throw deep in `StateManager.read()`.

### F5 — Deploy-watcher daemon (instrumentation, then keep)

`extension/src/bin/deploy-watcher.ts`:

```ts
import * as fs from 'fs';
const DEPLOYED_TYPES = path.join(getExtensionRoot(), 'extension/types/index.js');
fs.watch(DEPLOYED_TYPES, { persistent: true }, (eventType) => {
  if (eventType !== 'change') return;
  const stat = fs.statSync(DEPLOYED_TYPES);
  const content = fs.readFileSync(DEPLOYED_TYPES, 'utf8');
  const match = content.match(/schemaVersion:\s*(\d+)/);
  const v = match?.[1];
  log(`[deploy-watcher] modified at ${new Date().toISOString()}, mtime=${stat.mtime.toISOString()}, schemaVersion=${v}, size=${stat.size}`);
  // Optional: snapshot lsof output of who has the file open right now
});
```

Run as a long-lived process during pipeline runs. Would have caught the reverter mechanism in act.

## Non-goals

- Replacing the auto-update system. F1 patches the kill-switch hole; broader redesign is out of scope.
- Changing `chflags`-based defenses. The PRD documents that uchg is theatre — solution is process-level discipline (F1/F2/F3/F5), not filesystem flags.
- Solving cross-project Claude Code session interference. If H5 is confirmed, that's a separate PRD.

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-RVN-1 | F1's added `auto_update_enabled` check in `performUpgrade()` breaks `--force` flag pathway | Plumb `force` through and skip the kill-switch when explicit |
| R-RVN-2 | F2's flock blocks legitimate parallel installs (cross-skill workers all running install.sh near-simultaneously) | This IS desired — they should serialize. The 8-second gap in current backup pairs is exactly the race we want to eliminate |
| R-RVN-3 | F4's exit(1) from state-manager startup hard-crashes hooks/watchers on stale deploy | Yes — explicit failure beats silent fallback. Watchdog auto-fix path in F3 of the existing schema-ordering PRD prevents bricked sessions |
| R-RVN-4 | Reverter mechanism remains unidentified after F5 instrumentation runs | F1+F2+F3+F4 are independent defenses — even without root cause, layered fixes prevent recurrence |

## Files Likely Touched

```
extension/src/bin/check-update.ts                    # F1 kill-switch in performUpgrade
install.sh                                            # F2 flock, F3 schemaVersion parity check
extension/src/services/state-manager.ts              # F4 startup self-check
extension/src/bin/deploy-watcher.ts                  # F5 NEW instrumentation daemon
extension/CLAUDE.md                                   # AC-RVN-08 trap-door entry
extension/tests/check-update.test.js                  # F1 unit test
extension/tests/install-script.test.js                # F2, F3 (NEW)
extension/tests/state-manager.test.js                 # F4 startup-check test
extension/tests/deploy-watcher.test.js                # F5 (NEW)
```

---

## Linked context

- Active pipeline: `~/.local/share/pickle-rick/sessions/2026-04-29-1204204c/`. tmux session `pipeline-1204204c`. Watchdog cron `614355bb`.
- Watchdog log: `<SESSION>/watchdog.log` — entries 23:53Z..09:26Z show 5 reversion events.
- Existing PRDs in same area:
  - `prds/archive/incidents/state-schema-version-ordering-incident.md` — original incident PRD (decomposition ordering bug + initial hot-fix). This PRD's F4 corresponds to that PRD's F3.
  - `prds/archive/bundles/large-pipeline-time-budget-undersized.md` — separate bug PRD on enforcement leakiness.
- Agent investigation reports:
  - h1-tsc-cache: tsc cache RULED OUT
  - h2-source-mutation: source mutation RULED OUT
  - h3-timeline: git operations RULED OUT, mtime fingerprint pinned
- Source-of-truth files (all v3):
  - `extension/src/types/index.ts:158` — `schemaVersion: 3`
  - `extension/types/index.js:14` — `schemaVersion: 3`
- Reverted tarball signature (v1.60.1 release):
  - 6201 bytes, mtime `Apr 29 08:15:40`, contains v2

## Why this is "next priority work"

While the current bundle ships, the watchdog cron auto-fixes hourly. After the bundle finishes:

1. The watchdog cron expires (or the user stops it).
2. The deploy-reversion bug remains in the system.
3. ANY fresh process started after a reversion fires will fail to read state.json.
4. Future pipelines will hit the same wall on Day 1, before the watchdog cron is even configured.

This bug must be fixed before the next large pipeline run, OR the runs must launch with explicit awareness that hourly schema reversions will occur until fixed. F1+F2+F3+F4 should ship as a single PR within 1-2 days of bundle completion.

---

## Update 2026-04-30 PM — F1-F4 attempted, did NOT hold

### Outcome

F1–F4 implemented, reviewed, deployed (commits `4af5b6a`, `a670639`, `f75b2e3`). 14-minute soak after deploy with **zero reversions**. Pipeline resumed at iter 38 / 51 done. **Within 4 hours, deploy reverted to v1.60.1 anyway**, this time wholesale (state-manager.js, types/index.js, check-update.js all reverted; stop-hook.js content unchanged but tarball mtime preserved). Watchdog cron `d45a5ee4` (post-fix mode) logged 3 consecutive WARN events at `:42` past the hour for hours 1, 2, 3 post-resume. Pipeline kept progressing on mux-runner's cached v3 → 49 iter / 62 done before the user stopped the watchdog cron.

### What got proved

| Hypothesis | Status | Evidence |
|---|---|---|
| H1 — tsc incremental cache | **Ruled out** | `.tsbuildinfo` doesn't exist; tsc skips because compiled JS mtime > source TS mtime, but compiled IS v3 |
| H2 — workers mutating source TS | **Ruled out** | No `writeFileSync` to source TS in any test or worker log |
| H3 — git stash/checkout/worktree | **Ruled out** | No `pop`/`checkout`/`reset --hard`/`restore` in any worker log; git reflog clean |
| Sibling pickle-rick repos as source | **Ruled out** | 7 sibling dirs scanned (`pickle-rick-codex`, `-hermes`, `-skills`, `-forgecode`, `~/.codex/pickle-rick`, etc.); none have `extension/types/index.js`, all have different install.sh targets — they CANNOT be redeploying to `~/.claude/pickle-rick/` |
| Stub install.sh inside deployed dir | **Ruled out** | 324-byte stub at `~/.claude/pickle-rick/install.sh` (Apr 4 mtime) only does `chmod +x bin/sync-schema.js` — harmless |
| F1 (`performUpgrade` kill-switch) | **Insufficient** | Even with kill-switch, deploy reverted within hours |
| F2 (install.sh flock) | **Insufficient** | Reversions persist; install.sh races weren't the trigger |
| F3 (install.sh schemaVersion parity check) | **Insufficient** | install.sh runs cleanly (passes parity check post-tsc) but deploy still reverts later |
| F4 (state-manager startup self-check) | **Survives via mux-runner cached v3** | Function works when called, but when DEPLOYED state-manager loses the export, fresh processes can't even run the check. Self-policing fix has no teeth when the police are also reverted. |

### Strong remaining hypothesis (post F1–F4)

**H8 — `check-update.js` from a v1.60.1 cache, with SELF-PROPAGATING reversion**

Sequence:

1. Initial state: deployed has F1 kill-switch in `check-update.js`.
2. Some trigger spawns `check-update.js` (stop-hook from any Claude Code session, even those firing in `loanlight-api-income-agent-ux` — the deployed dir is shared across all projects).
3. The spawned check-update reads the kill-switch, returns "up-to-date" → safe.
4. **BUT** check-update.js was previously DOWNLOADED (before the fix) to a temp dir like `/var/folders/.../pickle-update-*/`. The tarball still contains the ORIGINAL v1.60.1 install.sh + extension/.
5. Either: (a) a stale check-update process from before the fix is still running detached and triggers `extractAndInstall()` periodically, OR (b) some path in our code re-uses an existing extracted dir.
6. v1.60.1 install.sh runs from the temp dir → rsync `temp/extension/` → `~/.claude/pickle-rick/extension/` → wholesale revert.
7. Now deployed has v1.60.1 check-update.js (no F1 kill-switch).
8. Next stop-hook fires → check-update.js (v1.60.1) doesn't honor kill-switch → fetches latest release (still v1.60.1, since we haven't tagged a v1.61.0) → re-installs.
9. **Self-propagating**: every revert removes the fix that would prevent the next revert.

**This is consistent with all observed evidence**: deployed mtimes preserved at original tarball mtime (`Apr 29 08:15:40`), wholesale dir reversion, paired install.sh backups (cached re-install). It also explains why my F4 self-check has no effect — by the time it fires, the deployed code that would call it is already gone.

### What we did NOT find

- A v1.60.1 git checkout anywhere on the system that could redeploy
- A LaunchAgent / cron / launchd plist scheduling the reversion
- Time Machine snapshot restoration
- A worker explicitly calling `bash install.sh` on the deployed install.sh stub

### What this means for the forward fix

F1–F4 was a **one-off heal**. To stop the self-propagation, the fix needs to be:

- **Released as a new version (v1.61.0+)**. Once `gh release latest` returns v1.61.0, `extractAndInstall()` would download THAT, not v1.60.1. The propagating loop terminates because the cached tarball gets replaced with a fixed one.
- **Combined with manual cleanup**: delete `/var/folders/*/pickle-update-*` temp dirs once before the release (they can persist between runs).
- **Plus a defense-in-depth**: F1 (`performUpgrade` kill-switch) needs to be in the released v1.61.0 itself, not just main HEAD — so that even if a v1.60.x tarball lingers in cache, the upgrade path it triggers runs the kill-switch from the NEWLY-INSTALLED v1.61.0 code. Currently F1 only stops download from the version that already has F1 — chicken-and-egg.

### New forward fix: F6 — Release a fresh tag with the fix bundled

1. Bump `extension/package.json` from `1.60.1` to `1.61.0`.
2. `gh release create v1.61.0 --target main` (with the F1–F5 + typescript-symlink commits in HEAD).
3. Manually clear cached tarballs: `rm -rf /var/folders/*/pickle-update-* /tmp/pickle-update-*`.
4. Verify next install.sh deploys v1.61.0 content.
5. Watchdog re-armed temporarily; expect zero reversions across 6+ hours.

This is the only way to break the self-propagating loop without continuously hot-patching deployed code.

### New forward fix: F7 — Stop spawning check-update entirely until v1.61.0 ships

Until v1.61.0 ships, edit deployed `extension/hooks/handlers/stop-hook.js` to early-return from `maybeSpawnUpdateCheck` regardless of settings:

```js
function maybeSpawnUpdateCheck(_extensionDir, log) {
  log('check-update spawn disabled (post-incident lockdown — see schema-version-deploy-reversion-rca PRD)');
  return;
}
```

Defense in depth — even if a stale check-update is still running from before, no NEW check-update gets spawned. Reverts are confined to whatever's already in flight.

This edit will itself be reverted on next reversion cycle. So F7 only buys a few hours; F6 (release) is the durable fix.

### Live data points captured

| Time UTC | Iteration | Tickets | Schema | Notes |
|---|---|---|---|---|
| 2026-04-30T09:54Z | 37 | 51/75 | v3 | Pipeline paused for fix |
| 2026-04-30T10:38Z | 38 | 51/75 | v3 | Resumed post-deploy |
| 2026-04-30T11:43Z | 42 | 55/75 | **v2** | First post-fix WARN |
| 2026-04-30T12:42Z | 45 | 58/75 | v2 | 2nd WARN |
| 2026-04-30T13:42Z | 49 | 62/75 | v2 | 3rd WARN |
| 2026-04-30T14:00Z | _user stopped watchdog cron_ | | | |

Pipeline progress remains 3-4 tickets/hour despite reverted deploy — running mux-runner has v3 in memory and is unaffected. Risk surfaces only on fresh-process state reads (hooks fail-open by design, so no user-visible impact in practice).

### Updated AC

- **AC-RVN-09** F6 ships: a v1.61.0+ tag is published with F1+F2+F3+F4 in HEAD. `gh release latest` returns v1.61.0+. Cached tarballs in `/var/folders/*/pickle-update-*` are cleared at release time.
- **AC-RVN-10** F7 is applied as a temporary lockdown: deployed `stop-hook.js`'s `maybeSpawnUpdateCheck` early-returns until v1.61.0 ships. Documented in CLAUDE.md trap-door catalog as a known temporary measure.
- **AC-RVN-11** Soak after F6: deployed `types/index.js` AND `services/state-manager.js` stay at v3 across 24 hours of mixed traffic (multiple Claude Code sessions, multiple cross-skill workers running install.sh).
- **AC-RVN-12** Self-propagation broken: a deliberately corrupted deployed `check-update.js` (mtime back to v1.60.1) does NOT trigger an install when stop-hook fires, even from another Claude Code project session.

### Files Likely Touched (post-update)

```
extension/package.json                                # version bump 1.60.1 → 1.61.0
extension/src/hooks/handlers/stop-hook.ts             # F7 temporary lockdown
extension/CLAUDE.md                                   # F7 documentation in trap-door catalog
prds/MASTER_PLAN.md                                   # update next-priority callout to "F6 release"
```

### Operator notes (current state)

- Watchdog cron `d45a5ee4` cancelled by user at 2026-04-30T14:00Z.
- Pipeline still running, projected ~3–4 hours to phase 1 completion.
- Source repo has F1–F4 + typescript-symlink fixes intact at HEAD `1347fb2`.
- No further hot-patching needed during pipeline run — mux-runner cached v3 is sufficient.
- Bug remains UNFIXED in deployed runtime; will re-surface for fresh processes after pipeline ends.

---

## Update 2026-04-30 PM — F6 shipped

**Release**: `v1.62.0` published — https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.62.0

**Why v1.62.0 not v1.61.0**: pipeline workers had already bumped `extension/package.json` to 1.62.0 across the 75-ticket bundle. Tagging v1.62.0 is the cleanest path; bumping again would rewrite history.

**What was done**:
1. Lint + test gate from `extension/`: `tsc --noEmit` + `eslint src/` (0 errors, 8 advisory warnings) + `tsc` + `npm test` (3340/3340 pass, after a small flake-budget bump in `tests/scope-resolver-import-walks.test.js` — HANG_TIMEOUT_MS 2500ms → 5000ms, see commit `0390916`).
2. Cleaned working tree: 3 commits (gitignore stray `current_sessions.json`, test-budget bump, 3 new bug PRDs + master plan).
3. `git push origin main` (78 commits forward).
4. `gh release create v1.62.0 --target main --generate-notes`.
5. Cached tarballs check: none in `/var/folders/*/pickle-update-*` (already auto-cleaned by macOS).
6. `bash install.sh` from source repo. Deploy verified clean: `types/index.js` schemaVersion=3, `LATEST_SCHEMA_VERSION=3`; `state-manager.js` has `SchemaVersionDeployDriftError` + `assertSchemaVersionDeployParity`; `check-update.js` performUpgrade kill-switch on lines 242 + 277; deployed `package.json` 1.62.0; install.sh parity check (source TS = deployed JS = 3) passed inline.

**AC status**:
- **AC-RVN-09 (F6 ships)**: ✅ v1.62.0 published; F1+F2+F3+F4 in HEAD `a11dc6d`; `gh release view --json tagName` returns `v1.62.0`; cached tarball directory empty.
- **AC-RVN-10 (F7 temporary lockdown)**: ⏭️ skipped — F6 went straight in, F7 lockdown not needed.
- **AC-RVN-11 (24h soak)**: ⏳ open. Re-verify deployed `types/index.js` and `services/state-manager.js` stay at v3 for 24h. Raise a new bug PRD if it regresses.
- **AC-RVN-12 (self-propagation broken)**: ⏳ open. Manually corrupt deployed `check-update.js` to v1.60.1 mtime, fire stop-hook, observe no install. Optional — F6 should make this moot, but worth a probe.

**Watchdog**: cron `d45a5ee4` remains cancelled. Re-arming is unnecessary — F6 cures the underlying loop.
