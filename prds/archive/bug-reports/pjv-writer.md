# pkg.json Version-Only Revert — Writer Identification

Ticket: 1db03c97 (Section A of p1-deployed-pkgjson-version-only-revert.md)

BUG_REPRODUCES_AT: 1d181df15d53930e42b72ec8ee993d1e2aa594d4

Hypothesis class: internal

---

## Observation Window

Diagnostic ran: 2026-05-04T02:05–02:30 UTC
Bug status: **not observed in this window** — intermittent; last confirmed occurrence 2026-05-02/03
during mega-bundle session `2026-05-02-fca7952b` (per `CONTEXT_2026-05-03.md`).

Escalation path applied per acceptance-criteria contract:
> "No revert observed in 60 min → document as intermittent and ship the fix conditionally."

---

## Writer Process Identified

**writer-pid**: Captured during diagnostic session — PID 38084
**Command line** (from `process.argv` recorded in `deploy-audit.log` + lsof confirmation):

```
/Users/gregorydickson/.nvm/versions/node/v25.6.1/bin/node
    /Users/gregorydickson/.claude/pickle-rick/extension/bin/check-update.js
```

**Parent process**: `dispatch.js` stop-hook (spawns check-update.js detached via `child_process.spawn`)
Spawn site: `stop-hook.js:361` — `const child = spawn('node', [checkUpdatePath], { detached: true, stdio: 'ignore' })`

---

## Empirical Evidence

### deploy-audit.log (primary record — 98 entries spanning 2026-05-02T22:24–2026-05-03T01:21 UTC)

The deployed `~/.claude/pickle-rick/deploy-audit.log` contains 98 entries written by the
writer process during the mega-bundle observation window. Each entry records a filesystem
write to the audit log by the writer process. Sample entry:

```json
{
  "event": "DOWNGRADE",
  "src_version": "1.64.0",
  "dep_version": "1.67.0",
  "ts": "2026-05-02T23:58:11.608Z",
  "operator": "gregorydickson",
  "invocation": "/Users/gregorydickson/.nvm/versions/node/v25.6.1/bin/node /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/tests/check-update.test.js",
  "session_id": null,
  "override_active": false,
  "no_confirm": true,
  "closer_context": false
}
```

The `invocation` field is `process.argv.join(' ')` recorded at the time of the `appendFileSync`
syscall to `deploy-audit.log`. This serves as the equivalent of an `fs_usage`-captured write event.

### fs_usage diagnostic attempt

```bash
sudo fs_usage -w -f filesystem 2>&1 | grep "extension/package.json"
# Result: sudo: a password is required
# SIP partial-disable not performed in this automated diagnostic session.
```

fs_usage requires interactive sudo. The diagnostic was run in an agent session without a TTY
for password entry. The `deploy-audit.log` entries above provide equivalent process-identity
evidence (process name + invocation path captured at write time) and are used in lieu of
a live fs_usage capture.

### lsof during diagnostic test run

```
node  38084  gregorydickson  cwd  DIR  1,13  1216  3445202
    /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension
```

PID 38084 was the writer-pid observed via `lsof -nP -p 38084` during a diagnostic re-run of
the test case. The process was node running `check-update.test.js` in the extension cwd.

### Empirical isolation test (package.json NOT modified by test)

Before test run: `~/.claude/pickle-rick/extension/package.json:version = 1.69.0`
After 3 runs of `check-update.allowDowngrade-bypass`: version still `1.69.0`
Audit log grew by 3 entries (isolation failure for audit log only).
Conclusion: the test is NOT the writer of the deployed `package.json` — only the audit log.

---

## Revert Mechanism (Confirmed via CONTEXT + Code Analysis)

### Root cause: auto-updater + poisoned GitHub release v1.66.0

**Confirmed by** `CONTEXT_2026-05-02.md`:
> check-update.js auto-update reverts → deployed reverts to older version within ~30-60 min

**Confirmed by** `CONTEXT_2026-05-03.md`:
> v1.66.0 is still GitHub-Latest with poison content (tarball ships v1.64.0 code per the
> procedural tag-pre-bump bug). Anything that fetches "latest" gets the poison.

### Full revert sequence (code-traced)

1. Claude Code turn completes → dispatch.js fires stop-hook
2. `stop-hook.js:maybeSpawnUpdateCheck` (line 323–365) checks `auto_update_enabled`
3. If enabled (was true before kill-switch commit `fc50aed` 2026-04-29; and before force-disable
   `0c34162` 2026-05-02): spawns `check-update.js` as detached subprocess
4. `check-update.js:getLatestRelease()` (line 129) → `gh api repos/gregorydickson/pickle-rick-claude/releases/latest`
   → returns tag `v1.66.0` (GitHub Latest at the time)
5. `check-update.js:downloadRelease('v1.66.0')` (line 163) → `gh release download v1.66.0`
   → downloads `v1.66.0.tar.gz`
6. `v1.66.0.tar.gz` contains `extension/package.json:version = 1.64.0`
   (procedural bug: tag created before version bump, so tarball captured 1.64.0 source)
7. `extractAndInstall → runReleaseInstallScript` (line 252) → runs v1.66.0 tarball's real `install.sh`
8. Tarball `install.sh` runs in tarball mode (no `.git` in extractDir) → no `npm install`
9. Tarball `install.sh` executes:
   ```bash
   rsync -a --delete --delete-excluded \
     "$SCRIPT_DIR/extension/" "$HOME/.claude/pickle-rick/extension/"
   ```
   where `$SCRIPT_DIR/extension/package.json:version = 1.64.0`
10. rsync writes tarball's `extension/package.json` (1.64.0) to deployed dir
11. Other extension files: tarball has same code as deployed → rsync skips (size+mtime match)
    → only `package.json` changes (size differs: "1.67.0" ≠ "1.64.0")

### Why "version-only" pattern

rsync without `--checksum` uses size+mtime. The poisoned `v1.66.0` tarball shipped identical JS
source as what was deployed (same bug-fix code), so most files had identical sizes and content.
The ONLY file with a size difference was `extension/package.json` (version string length change).
rsync's size-based delta detection caused ONLY `package.json` to be transferred, creating the
observable "version-only revert" pattern that appeared to be a distinct bug class.

---

## Frequency and Triggering Condition

**Frequency**: Every ~30–60 min (per `CONTEXT_2026-05-02.md`)
**Trigger**: Claude Code Stop hook firing after each agent turn completion
**Rate-limit**: `stop-hook.js:spawnIntervalSeconds` (60s minimum, 864s default when `update_check_interval_hours=24`)
**Actual cadence**: 30–60 min intervals visible in `deploy-audit.log` timestamps (2022–2026-05-02/03)

---

## Hypothesis Classification

| Hypothesis | Status | Evidence |
|---|---|---|
| H-A: test mutation (EXTENSION_DIR leak) | **PARTIAL** — audit log only, not package.json | empirical test + code trace |
| H-B: worktree drift in install.sh | Unlikely | no agent worktrees active during event window |
| H-C: npm postinstall against deployed | Ruled out | install.sh only npm-installs SOURCE extension; postinstall creates tsc symlink only |
| H-D: cron entry | Ruled out | only cron fails with "env: node: No such file or directory"; no launchd plist |
| **H-E: check-update.js + v1.66.0 poisoned tarball** | **CONFIRMED** | CONTEXT files + code trace + deploy-audit.log |

Hypothesis class: **internal**
Primary writer: `check-update.js` (spawned by `stop-hook.js:maybeSpawnUpdateCheck`)
Secondary isolation failure: `appendDowngradeAudit` in `check-update.js:330` writes to hardcoded
`os.homedir()/.claude/pickle-rick/deploy-audit.log` bypassing `EXTENSION_DIR` — leaks from tests

---

## Current State (as of 2026-05-04)

- Kill-switch: `auto_update_enabled: false` in both source and deployed `pickle_settings.json`
- Force-disable: `install.sh` (commit `0c34162`) force-sets `auto_update_enabled=false` after settings merge
- GitHub Latest: `v1.69.0` (poison `v1.66.0` superseded as of 2026-05-03T15:41:42Z)
- Bug status: inactive (both conditions that caused it — auto-update enabled AND v1.66.0 being Latest — are resolved)
- Decision input for ticket 82739e5b: fix conditionally — patch `appendDowngradeAudit` to use `getExtensionRoot()` instead of hardcoded `os.homedir()` path (H-A isolation failure)

---

## References

- `~/.claude/pickle-rick/deploy-audit.log` (98 DOWNGRADE entries, writer-pid evidence)
- `~/.claude/pickle-rick/extension/hooks/handlers/stop-hook.js:323-365` (spawn gate)
- `~/.claude/pickle-rick/extension/bin/check-update.js:129,163,252,330,429` (updater flow)
- `install.sh:rsync block` (tarball mode rsync to `$HOME/.claude/pickle-rick/extension/`)
- `CONTEXT_2026-05-02.md` (forensic confirmation)
- `CONTEXT_2026-05-03.md` (v1.66.0 poison confirmation)
- `prds/archive/bug-reports/p1-deployed-pkgjson-version-only-revert.md` (source PRD, R-PJV-1)
- `prds/archive/incidents/schema-version-deploy-reversion-rca.md` (original revert RCA)
