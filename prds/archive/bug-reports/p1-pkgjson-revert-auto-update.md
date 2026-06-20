# PRD: Fix pkgjson Version-Only Revert (Auto-Update Path)

**Status**: Draft  
**Source**: `extension/audit/pkgjson-revert-triage-2026-05-08.md` (H-C confirmed as top candidate)  
**Ticket origin**: 8c4d691a (DIAGNOSE phase)  
**Priority**: P1 — intermittent version revert can cause schema-mismatch bugs at deploy time

## Problem

`extension/package.json:version` reverts intermittently after install. Triage (H-C, `check-update.ts`) identified the most likely root cause: `runReleaseInstallScript` (`check-update.ts:260-282`) runs `bash install.sh` with `cwd=extractDir` (a GitHub release tarball extract). This deploys the tarball's `extension/package.json` (including its version field) to `$EXTENSION_ROOT/extension/package.json`. If the developer has bumped the local source version but not yet published a GitHub release, the auto-update effectively "reverts" the deployed version to the last published release.

## Root Cause (Confirmed Hypothesis: H-C)

- `check-update.ts:268`: `spawnSync('bash', ['install.sh'], { cwd: extractDir })`
- The tarball's `install.sh` sets `SCRIPT_DIR=extractDir`; rsync deploys tarball→`$EXTENSION_ROOT`
- `pickle_settings.json` default has `auto_update_enabled: true` before the first manual `bash install.sh` run
- Manual `bash install.sh` sets `auto_update_enabled=false` — but the window before the first run allows H-C to fire

## Acceptance Criteria

- **AC-1**: When `install.sh` detects that `SRC_V != DEP_V` at deploy time AND `git diff --name-only extension/package.json` is empty (meaning the version change is NOT a committed bump), `install.sh` emits a `pkgjson_revert_forensic_captured` activity event via `log-activity.js`.
- **AC-2**: `check-update.ts:performUpgrade` verifies that the tarball's `extension/package.json:version` matches or exceeds the currently deployed version before running `install.sh` from `extractDir`. If the tarball version is lower, `performUpgrade` logs a warning and skips the upgrade.
- **AC-3**: A regression test in `extension/tests/install-pkgjson-version-trace.test.js` (or a new file) covers the "tarball version < deployed version → skip upgrade" code path in `check-update.ts`.
- **AC-4**: `extension/scripts/capture-pkgjson-revert-forensic.sh` is invoked by CI/CD (or pre-install hook) so future revert events are automatically captured without manual operator intervention.

## Atomic Fix Plan

### Step 1: Add tarball version guard to `check-update.ts:performUpgrade`

In `check-update.ts:performUpgrade` (around line 458), before calling `extractAndInstall`, inspect the tarball version against the currently deployed `$EXTENSION_ROOT/extension/package.json:version`. If the tarball version is lower, skip the upgrade, log a `pkgjson_revert_forensic_captured` event, and return `{ success: false, error: 'tarball version lower than deployed' }`.

Files: `extension/src/bin/check-update.ts`

### Step 2: Add version-revert detection to `install.sh`

After the initial `SRC_V`/`DEP_V` comparison at `install.sh:161-172`, add a check: if `SRC_V == DEP_V` but the deployed version is lower than what git shows as the last committed version (`git show HEAD:extension/package.json | jq -r .version`), emit `pkgjson_revert_forensic_captured` via `log-activity.js`.

Files: `install.sh`

### Step 3: Regression test

Add test cases to `extension/tests/install-pkgjson-version-trace.test.js` or a new test file covering:
- `performUpgrade` skips when tarball version < deployed version
- `pkgjson_revert_forensic_captured` is emitted in that scenario
- The gate_payload fields match the schema

Files: `extension/tests/install-pkgjson-version-trace.test.js`

## Regression Test Outline

1. **Unit**: Mock `extractReleaseForInspection` to return `version='1.70.0'` when deployed is `1.72.2` → assert `performUpgrade` returns `{success:false}` without calling `runReleaseInstallScript`
2. **Unit**: Mock `log-activity.js` call → assert `pkgjson_revert_forensic_captured` event emitted with correct `gate_payload`
3. **Integration**: Full `check-update` flow with a mock tarball at lower version → assert deployed version unchanged after `performUpgrade`

## Notes

- This PRD is DRAFT and not in the current bundle scope
- R-PJV-6 trap-door in `extension/CLAUDE.md` acts as the interim guard until this ships
- Forensic capture script `extension/scripts/capture-pkgjson-revert-forensic.sh` should be run on the next observed revert event to gather confirming evidence before this fix lands
