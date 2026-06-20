---
title: P1 — Deployed package.json:version field reverts to 1.64.0 while file content-hashes match source
status: Draft
date: 2026-05-02
priority: P1
type: bug
peer_prds:
  related:
    - prds/archive/incidents/schema-version-deploy-reversion-rca.md                    # parent: original tarball-rsync revert RCA
    - prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md # P0 lockdown bundle (release-gate, force-write kill-switch)
    - prds/p1-strip-excessive-defense-deploy-reversion.md             # follow-on strip
    - prds/archive/bundles/p2-mega-bundle-2026-05-02-pm.md                            # currently running pipeline that surfaced this
---

# PRD — Deployed package.json:version-only revert

## Why this is a new bug class (not the original deploy-reversion)

The original deploy-reversion (`prds/archive/incidents/schema-version-deploy-reversion-rca.md`) was a whole-tarball rsync reverting every file under `extension/`. Forensic evidence today shows a different pattern:

| Field | Source | Deployed | Same? |
|---|---|---|---|
| `extension/package.json:version` | `1.67.0` | reverts to `1.64.0` periodically | ❌ |
| `extension/bin/check-update.js` (md5) | `ddf594db586227599a4b5b7d3a1b527a` | `ddf594db586227599a4b5b7d3a1b527a` | ✅ |
| `~/.claude/pickle-rick/pickle_settings.json:auto_update_enabled` | `false` | `false` | ✅ |
| `~/.claude/pickle-rick/extension/package.json` mtime when revert observed | n/a | `2026-05-02 23:58` (recent) | n/a |

So:

- The `check-update.js` JS bundle is identical between source and deployed — the prior tarball-revert path is not firing.
- Kill-switch is engaged on both sides (A.14 force-write from the P0 bundle is in place).
- The `update-check.json` poisoned cache observed in Cycle 3 has been removed.
- Yet `~/.claude/pickle-rick/extension/package.json:version` periodically flips back to `1.64.0` while NOTHING ELSE under `~/.claude/pickle-rick/extension/` changes.

**Hypothesis**: a writer is touching ONLY the package.json file. Candidates:

- (H-A) A test in `extension/tests/` mutates the real deployed `~/.claude/pickle-rick/extension/package.json` because of an `EXTENSION_DIR` leak we missed (we have `EXTENSION_DIR_TEST` but a write may bypass).
- (H-B) `bash install.sh` itself isn't writing the version field — it rsyncs `extension/` from source's `extension/` dir, but `extension/package.json` in source is at `1.67.0`, so this would copy correctly. Unless the source dir has a stale checkout for some reason (worktree?).
- (H-C) A node module's `npm install` against deployed `extension/` resets package.json (e.g., a postinstall in some package).
- (H-D) Some cron entry or background task writes only the version field.
- (H-E) `gh release download` of v1.66.0 is being fetched and SOMETHING extracts only the package.json from the broken tarball into deployed.

## Reproducer

```bash
SRC_V=$(jq -r .version /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/package.json)
DEP_V=$(jq -r .version $HOME/.claude/pickle-rick/extension/package.json)
SRC_HASH=$(md5 -q /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/bin/check-update.js)
DEP_HASH=$(md5 -q $HOME/.claude/pickle-rick/extension/bin/check-update.js)
echo "src=$SRC_V dep=$DEP_V src_hash=$SRC_HASH dep_hash=$DEP_HASH"
# Expected pattern: src!=dep AND src_hash=dep_hash
```

Observe the ratio over a 24h window. With kill-switch on + A.14 force-write installed, the prior reversion class should be 0%; the package.json-only revert is 100% reproducible within ~30-60 min of any `bash install.sh`.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| R-PJV-1 | Identify the writer that mutates ONLY `~/.claude/pickle-rick/extension/package.json` (file-level fs_usage / fswatch / lsof during a fresh install + 60-min observation window) | P0 |
| R-PJV-2 | Add a runtime-validated invariant: at startup, mux-runner reads SRC_V + DEP_V; if mismatch + 3-file-hash match, emits `pkgjson_only_revert_detected` activity event with file:line evidence of the writer (post-R-PJV-1) | P1 |
| R-PJV-3 | If the writer is a known internal path (test or npm postinstall), gate it on `EXTENSION_DIR_TEST` or remove the deployed-mutation entirely | P0 |
| R-PJV-4 | If the writer is an external/system path (gh CLI cache, npm registry cache, etc.), document and add a `bin/verify-pkgjson-source.js` that compares source against deployed at every mux-runner iteration boundary | P1 |
| R-PJV-5 | Regression test: simulate the writer in a fixture; assert R-PJV-2's event fires | P1 |

## Acceptance Criteria

| AC-PJV-NN | Verification |
|---|---|
| AC-PJV-01 | `lsof`/`fs_usage` evidence in `bundle/pjv-writer.md` identifies the writer | Type: lln-conformance (manual) |
| AC-PJV-02 | If H-A (test pollution): grep -rn "EXTENSION_DIR" extension/tests/ produces no leaked writes; CI guard `scripts/audit-test-isolation.sh` fails on regression | Type: lint+test |
| AC-PJV-03 | If H-B (worktree drift): install.sh refuses to deploy from any path containing `.claude/worktrees/agent-` (already covered by AC-DR-13 — verify still in force) | Type: integration |
| AC-PJV-04 | If H-C/H-D/H-E: documented in `bundle/pjv-disposition.md` + mitigation wired | Type: integration |
| AC-PJV-05 | Reverted-pkgjson reproducer fails (no revert in 60-min window post-install) | Type: integration |

## Sequencing

1. **Diagnose first** (R-PJV-1) — without empirical evidence we'd be writing more defense-in-depth for an unidentified hypothesis. Same trap as the P0 bundle.
2. After diagnosis, fix at root (R-PJV-3 if internal, R-PJV-4 if external).
3. R-PJV-2 + R-PJV-5 are the regression guards.

## Empirical artifacts to gather

```bash
# Capture filesystem mutations during a 60-min observation
sudo fs_usage -w -f filesys 2>&1 | grep "extension/package.json" | tee /tmp/pjv-fs-usage.log &
# Capture process-level writes
sudo lsof +D ~/.claude/pickle-rick/extension/ 2>&1 | tee /tmp/pjv-lsof.log
# Tail debug.log for spawn signals
tail -f ~/.claude/pickle-rick/debug.log | grep -E "Spawning|written" | tee /tmp/pjv-debuglog.log
```

(macOS `fs_usage` may need root + SIP-allowed terminal.)

## Workaround until R-PJV-1 lands

Operator runs `bash install.sh` whenever observed drift hits. The babysit cron `2ba30074` already does this every hour at :17 for the running mega bundle pipeline.

## Cross-references

- Surfaced during mega bundle session `~/.local/share/pickle-rick/sessions/2026-05-02-fca7952b/` — drift observed 23:58 with content-hashes matching.
- Forensic timestamp: 2026-05-02 23:58 PT (UTC+0 sub-conversion).
- v1.66.0 is still GitHub-Latest with poison content — H-E candidate: something extracting just the v1.66.0 pkg.json.

— Pickle Rick out. *belch*
