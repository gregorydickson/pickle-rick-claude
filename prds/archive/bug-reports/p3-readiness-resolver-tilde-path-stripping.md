---
title: P3 — check-readiness resolver strips tilde-prefix from runtime paths, falsely flagging deploy verification
status: Draft
filed: 2026-05-10
priority: P3
type: bug-resolver
---

# PRD — Readiness resolver tilde-stripping bug

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Symptom

Bundle 2026-05-10 session `2026-05-10-84ad0873` readiness report flagged tilde-prefixed runtime deploy paths as unresolved `file_path` findings:

```
- file_path in 4dcf9b43/linear_ticket_4dcf9b43.md
  - Referenced ticket file path does not resolve: `claude/pickle-rick/extension/bin/monitor.js`
- file_path in 4dcf9b43/linear_ticket_4dcf9b43.md
  - Referenced ticket file path does not resolve: `claude/pickle-rick/extension/bin/pipeline-runner.js`
- file_path in 010f5c8b/linear_ticket_010f5c8b.md
  - Referenced ticket file path does not resolve: `claude/pickle-rick/extension/lib/monitor-respawn.js`
```

The originating ticket text was `~/.claude/pickle-rick/extension/bin/monitor.js` (with tilde prefix — runtime deploy path verified by R-CLOSER-3 via `bash install.sh` parity check). The readiness resolver stripped the leading `~/.` to `claude/pickle-rick/...`, then attempted to resolve as a repo-relative path, found nothing, and emitted a `file_path` finding.

## Root cause

`extractContractReferences` in `extension/src/bin/check-readiness.ts` likely normalizes paths via `path.posix.normalize` or similar without distinguishing tilde-prefix (home-relative) paths from repo-relative paths. Result: `~/.claude/...` becomes `claude/...` after the `~/` segment is dropped (or treated as a literal directory and stripped further).

Confirmation: check `extractContractReferences` for path normalization logic; verify it preserves tilde prefix or skips tilde-prefix tokens entirely.

## Fix Requirements

- **R-RTPS-1** (R-MUST): `extractContractReferences` MUST recognize tilde-prefix paths (`~/`, `$HOME/`, `${HOME}/`) and either (a) skip them entirely (they're runtime paths, not source-tree paths) OR (b) resolve them via `path.resolve(os.homedir(), rest)` and check existence against the absolute path, not the repo-relative path.

- **R-RTPS-2** (R-MUST): Regression test `extension/tests/check-readiness-tilde-paths.test.js` covers (a) `~/.claude/foo.js` skipped/resolved correctly; (b) `$HOME/foo.js` same; (c) `${HOME}/foo.js` same; (d) repo-relative `extension/foo.js` still resolves via `git ls-files` as today.

- **R-RTPS-3** (R-SHOULD): Trap-door entry pinned at `extension/src/bin/check-readiness.ts` documenting the tilde-handling invariant. ENFORCE: regression test from R-RTPS-2.

- **R-RTPS-4** (R-MAY): Consider extending `extractForwardRefAnnotations` to also strip annotations of the form `(deployed at <runtime-path>)` when the runtime path is tilde-prefixed — would let R-CLOSER-3 author tickets that explicitly distinguish source-build paths from deploy paths.

## Severity

P3 — workaround exists (rewrite tickets to use repo-relative `extension/...` paths only; runtime paths verified inside the deploy ticket's bash command rather than backticked). The leak is **noise in the readiness report**, not a real failure: R-CLOSER-3's actual deploy verification happens via shell-out (`md5sum`, `test -x`) which doesn't go through the resolver.

Climbs to P2 if a future ticket cites `~/.claude/...` as the **only** location of a critical file (no source-tree counterpart) and the false-positive masks a real drift.

## Sister findings

- R-RTRC-1..7 (extension/src/bin/check-readiness.ts) — forward-ref handling. Tilde stripping is a separate path-normalization bug, not a forward-ref bug.

## Triggering session

`2026-05-10-84ad0873` — bundle 2026-05-10. Tickets `010f5c8b` (R-CLOSER-3) and `4dcf9b43` (wiring) cite tilde-prefix runtime paths for md5 parity verification and CLI smoke tests. Readiness resolver flagged 7 of these as nonexistent paths.
