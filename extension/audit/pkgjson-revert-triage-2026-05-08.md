# pkgjson Version-Only Revert — Hypothesis Triage

**Date**: 2026-05-08  
**Ticket**: 8c4d691a (R-PJV-3)  
**Analyst**: Morty worker (Pickle Rick extension)  
**Status**: TRIAGE COMPLETE — follow-up fix PRD filed as `prds/archive/bug-reports/p1-pkgjson-revert-auto-update.md`

## Problem Statement

`extension/package.json:version` reverts to a previous value intermittently after install. Only the `version` field changes; content fields (`scripts`, `devDependencies`, etc.) remain current. No forensic data has been captured during an actual revert event as of this triage date.

## Hypothesis Results

| Hypothesis | Label | Status | Evidence Anchor |
|---|---|---|---|
| H-A | npm install accidental write | `inconclusive` | No `npm version`/`npm install` call in install.sh; `postinstall` only creates symlink (`extension/package.json:~5-9`); npm ci does not modify package.json |
| H-B | install.sh jq merge bug | `disproven` | All jq ops in install.sh touch only `settings.json`/`pickle_settings.json`; source `extension/package.json` is read-only (`install.sh:161`); rsync direction is always src→deployed |
| H-C | auto-update path | `inconclusive (top candidate)` | `check-update.ts:268` runs `bash install.sh` with `cwd=extractDir` (tarball extract); tarball deploys to `$EXTENSION_ROOT` and may overwrite deployed `package.json:version`; mechanism confirmed in code |
| H-D | cron sampler residue | `disproven` | Commit `c2ec3cf1` stripped all cron/sampler code; `install-script.test.js:~342` asserts `doesNotMatch(/crontab/)` and `doesNotMatch(/deploy-baseline[.]json/)` |
| H-E | external editor reformat | `inconclusive` | VS Code/Cursor format-on-save or git-revert-on-branch-switch is plausible; no direct evidence; explains version-only change if editor restores from git stash |

## Hypothesis Details

### H-A: npm install accidental write — `inconclusive`

**Mechanism**: `npm install` can normalize `package.json` in some configurations. `npm ci` does not.  
**Evidence against**: The `postinstall` script in `extension/package.json` only creates a `tsc` symlink (`extension/package.json:~5`). No `npm version`, `npm audit fix`, or `npm install` calls exist in `install.sh`. The test suite uses `npm ci` (deterministic). No evidence of manual `npm install` invocations that would trigger normalization.  
**Why inconclusive**: Cannot rule out operator running `npm install` manually in `extension/` directory.

### H-B: install.sh jq merge bug — `disproven`

**Mechanism**: A jq merge operation could accidentally write deployed version back to source.  
**Evidence against**: `install.sh:161` reads `SRC_V` from source `extension/package.json` via `read_package_version` — read-only. All jq write operations are limited to `settings.json` (`install.sh:~530-580`) and `pickle_settings.json` (`install.sh:~390-410`). rsync direction is always `$SCRIPT_DIR/extension/ → $EXTENSION_ROOT/extension/` (source-to-deployed). `DEPLOYED_V` at `install.sh:361` is read-only for update-cache hygiene.  
**Verdict**: No code path in install.sh writes to source `extension/package.json`.

### H-C: auto-update path — `inconclusive (top candidate)`

**Mechanism**: `check-update.ts:runReleaseInstallScript` (line 260-282) runs `spawnSync('bash', ['install.sh'], { cwd: extractDir })` where `extractDir` is a temp directory populated from a GitHub release tarball. This invocation deploys the tarball's content (including its `extension/package.json`) to `$EXTENSION_ROOT`. If the tarball's version is lower than the current source (e.g., developer bumped source to `1.72.2` but last GitHub release was `1.72.1`), the deployed `extension/package.json:version` would appear to "revert".  
**Why it explains the pattern**: "version field alone changes, content fields stay current" — the tarball content is nearly identical to source (same code) but may have an older version. The intermittent nature matches the fact that `install.sh` sets `auto_update_enabled=false` on every manual run (`install.sh:~395`), so the window is only between release publication and the next manual `bash install.sh` invocation.  
**Evidence for**: Mechanism confirmed in `check-update.ts:260-282`. `pickle_settings.json` default has `auto_update_enabled: true` (before manual install.sh runs).  
**Evidence against**: The deployed-vs-source revert would affect DEPLOYED `extension/package.json`, not the source repo — unless the operator's observation conflates source and deployed.

### H-D: cron sampler residue — `disproven`

**Mechanism**: A cron job or parity sampler from earlier versions could periodically overwrite `extension/package.json`.  
**Evidence against**: Commit `c2ec3cf1` (`chore: strip deploy parity cron sampler`) removed `bin/verify-deploy-parity.js`, `extension/tests/verify-deploy-parity.test.js`, and cron invocations from `extension/package.json:test` script. `extension/tests/install-script.test.js` at the "deploy parity sampler stripped" describe block explicitly asserts `doesNotMatch(src, /crontab/)`, `doesNotMatch(src, /deploy-baseline[.]json/)`, `doesNotMatch(src, /verify-deploy-parity[.]js/)`, `doesNotMatch(src, /--uninstall-cron/)`.  
**Verdict**: Fully stripped and guarded by regression test.

### H-E: external editor (Cursor/VS Code) — `inconclusive`

**Mechanism**: Cursor/VS Code with git integration can restore files to their last committed state during branch switch or when `git stash pop` produces conflicts.  
**Evidence for**: Explains version-only change (if editor restores only the version field from a cached git state or undo buffer). The `extension/package.json` is not in `.gitignore` so git operations affect it.  
**Evidence against**: No `.vscode/settings.json` or Cursor config that would trigger this. A typical format-on-save wouldn't change the version field.  
**Why inconclusive**: Cannot rule out operator workflow where IDE was open during a `git pull` or branch switch that conflicted on the version bump.

## Top Hypothesis: H-C (auto-update path)

The mechanism is code-confirmed. The intermittent nature, the version-field-only change, and the fact that `auto_update_enabled` is `true` by default (before first manual install run) all support H-C as the most likely root cause. A forensic capture during the next revert event will confirm or refute.

## Next Steps

See `prds/archive/bug-reports/p1-pkgjson-revert-auto-update.md` for the follow-up fix PRD.  
Run `extension/scripts/capture-pkgjson-revert-forensic.sh` immediately if another revert is observed.
