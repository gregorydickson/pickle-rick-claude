# pkg.json Version-Only Revert — Disposition

Disposition: internal writer confirmed.

Root cause:
- `stop-hook` could launch `check-update.js`
- `check-update.js` could install a release tarball whose `extension/package.json` version lagged the source tag

Mitigation in code:
- downgrade/install guards remain in place
- mux-runner now verifies source vs deployed `package.json` against three compiled-file hashes
- a true version-only revert emits `pkgjson_only_revert_detected` with hash evidence and the writer evidence path

Residual risk:
- this guard detects and records the drift; it does not auto-rewrite the deployed file
- if a future external writer mutates both `package.json` and compiled JS, it will surface as `pkgjson_full_drift_detected`
# pkg.json Version-Only Revert — Writer Identification

Primary writer: `extension/bin/check-update.js`, spawned by the stop-hook update path.

Observed revert path:
- stop hook spawns `check-update.js`
- `check-update.js` downloads the GitHub "latest" release
- the poisoned `v1.66.0` tarball carried `extension/package.json` at `1.64.0`
- tarball `install.sh` rsynced that `package.json` into the deployed install

Why this looked version-only:
- the deployed JS payload matched the shipped source closely enough that rsync skipped most files
- `extension/package.json` had the version-string delta, so it was the visible rewrite

Source evidence lives in [prds/archive/bug-reports/pjv-writer.md](/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/prds/archive/bug-reports/pjv-writer.md).
