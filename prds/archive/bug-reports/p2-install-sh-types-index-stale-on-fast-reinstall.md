---
status: draft
priority: P2
filed: 2026-05-05
slot: 1q
forensic_origin: bundle session 2026-05-04-f416c6cc run #2 (28-min run, 16:59→17:28 local) + run #5 (live forensic 2026-05-05 02:35 local — confirmed structural, not transient)
priority_reassessment_note: severity rises from P2 to "P1 candidate" after run #5 forensic — see ## Severity update below
---

# PRD: install.sh `types/index.js` Stale-on-Fast-Reinstall — Activity-Event Drop

**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`

## Problem

The first `bash install.sh` after the R-CNAR-1 + R-XBL-2 commits left the deployed file `~/.claude/pickle-rick/extension/types/index.js` **md5-mismatched against the source** `extension/src/types/index.ts` after compilation. Specifically, the deployed copy was missing **8 new activity events** including `worker_spawn_backend_resolved`, `paused_session_orphan_demoted`, `worker_spawn_backend_override`, and 5 others added in the same commit batch.

Effect: `state-manager.ts` validates incoming activity events against `VALID_ACTIVITY_EVENTS` exported from the deployed `types/index.js`. Because the deployed copy was stale, every event of those 8 types was rejected with the warning:

```
WARN: ignoring unknown activity event: worker_spawn_backend_resolved
```

For the **entire 28-minute run #2**, the SoT-audit instrumentation R-XBL-1/-2 was added to ship was silently dropped. Forensic visibility into the very bug class the deploy was for was zero.

Re-running `bash install.sh` manually resolved the parity gap in ~3 seconds. The deploy itself is fast; the gap was in **what install.sh assumed had already happened before rsync ran**.

## Hypotheses on root cause (one or both)

1. **TSC incremental cache miss.** `npx tsc` was run before install.sh, but the source mtime and the cached `.tsbuildinfo` mtime were the same second. TSC's incremental rebuild logic skipped recompilation. The `extension/types/index.js` on disk was the previous build. install.sh's rsync then deployed the previous build.
2. **Source-file edit + `.tsbuildinfo` race.** Editor wrote the new TS source, but `.tsbuildinfo` had a slightly later mtime (from a prior tsc run that didn't finish writing the .js). Subsequent `npx tsc` saw the cache as fresher than the source and skipped the rebuild.

Either way, **install.sh trusts that the compiled JS in `extension/types/index.js` matches `extension/src/types/index.ts`**. That trust is unverified.

## Proposal

Two-layer fix:

1. **Force-rebuild before deploy** — install.sh deletes `extension/types/index.js` (or all of `extension/types/`, `services/`, `bin/`, `hooks/`) before running `npx tsc`. TSC has no choice but to regenerate from source.
2. **Post-rsync md5-parity probe** — install.sh ends with an md5 comparison of source-vs-deployed for the 5 most-trafficked compiled files (`types/index.js`, `services/state-manager.js`, `bin/spawn-morty.js`, `bin/mux-runner.js`, `services/pickle-utils.js`). Mismatch = exit 1 with the diff list.

The probe is the safety net; the force-rebuild prevents the gap upstream.

## Requirements

### R-ITS-1 — Force-rebuild step
- `install.sh` adds a step **before** `npx tsc`:
  ```bash
  rm -f extension/types/index.js extension/services/*.js extension/bin/*.js extension/hooks/*.js extension/lib/*.js extension/.tsbuildinfo 2>/dev/null || true
  ```
- This guarantees `npx tsc` regenerates from source regardless of cache state.

### R-ITS-2 — Post-rsync md5-parity probe
- After the rsync step, install.sh runs:
  ```bash
  for f in types/index.js services/state-manager.js bin/spawn-morty.js bin/mux-runner.js services/pickle-utils.js; do
    src_md5=$(md5sum "extension/$f" 2>/dev/null | awk '{print $1}')
    dst_md5=$(md5sum "$DEPLOY_ROOT/extension/$f" 2>/dev/null | awk '{print $1}')
    [ "$src_md5" = "$dst_md5" ] || { echo "FAIL: md5 mismatch on $f"; exit 1; }
  done
  ```
- Probe is opt-out via `INSTALL_SKIP_PARITY=1` for emergency manual deploys.
- Default behavior: parity check is mandatory; mismatch exits non-zero; install.sh prints the diff list.

### R-ITS-3 — install.sh activity event
- New event `install_sh_parity_check` emitted with payload `{ files_checked: [...], mismatches: [], status: 'pass'|'fail' }`.
- Registered in `VALID_ACTIVITY_EVENTS` + `activity-events.schema.json`.
- Logged via the deploy-side activity-logger so postmortems have evidence of which install.sh runs verified parity.

### R-ITS-4 — Trap-door + invariant
- Add to `extension/CLAUDE.md` (root) `## Trap Doors`:
  > `scripts/install.sh` (parity gate) — INVARIANT: after rsync, install.sh MD5-compares source-vs-deployed for the 5 most-trafficked compiled files; mismatch exits 1 and refuses to leave a partial deploy. BREAKS: silent activity-event drop, schema-mismatch class bugs. ENFORCE: `extension/tests/install-script.test.js` (parity gate test).
- Add the parity gate test that simulates a stale deployed copy and asserts install.sh exits 1.

## Acceptance Criteria

- **AC-ITS-01** — `install.sh` removes compiled JS files before `npx tsc`; verified by inspecting the script and by a test that introspects `install.sh` content.
- **AC-ITS-02** — Post-rsync md5-parity probe runs and exits 1 on mismatch; verified by simulation test that mocks one of the 5 files with stale content.
- **AC-ITS-03** — `INSTALL_SKIP_PARITY=1` opt-out works (parity probe skipped); verified by env-flag test.
- **AC-ITS-04** — `install_sh_parity_check` event registered in `VALID_ACTIVITY_EVENTS` and `activity-events.schema.json`.
- **AC-ITS-05** — Trap-door entry exists for `install.sh (parity gate)` with INVARIANT/BREAKS/ENFORCE.
- **AC-ITS-06** — Regression: a synthetic test that replays the run #2 conditions (stale deployed `types/index.js`) asserts install.sh refuses to complete + flags the mismatch.

## Severity update — 2026-05-05 mid-day live forensic (run #5)

The original filing characterized this as a **transient TSC cache race** affecting one 28-minute run. Live re-investigation during run #5 (02:35 local) shows the gap is **structural, not transient**, and worse than originally documented:

### Observed state across the 5 most-trafficked files

```
DRIFT  types/index.js              src=7a4ce9f0  dst=f01a910e
DRIFT  services/state-manager.js   src=61d6e119  dst=c0ea25ff
DRIFT  bin/spawn-morty.js          src=9c3d2bc5  dst=d1e68707
DRIFT  bin/mux-runner.js           src=991bb0a6  dst=d377d027
DRIFT  services/pickle-utils.js    src=039b27a6  dst=90397575
```

**All 5 files DRIFT.** Deployed copy mtimes for all 5: **`May 3 10:41:42`** — predates the entire bundle 2026-05-04 + every subsequent commit (R-XBL-1 through R-CNAR-1).

### Compounding consequences observed live

1. **`worker_spawn_backend_resolved` appears in TS source + compiled, but NOT in deployed.** Monitor.js fresh-spawn dashboard logs `WARN: ignoring unknown activity event worker_spawn_backend_resolved` 5+ times within seconds — every R-XBL-1 instrumentation event is silently dropped by deployed state-manager.

2. **The cap-split fix `6be334b1` (R-CNAR-1 part 2) is NOT deployed.** This is the supposedly-live fix the entire run #5 launch was predicated on. The runner pid 76888 has been running on May-3-era `bin/mux-runner.js` for 1h+. The bug-not-biting is purely luck (`state.max_iterations=500` is far above any tier ceiling, so per-ticket-budget overwriting global cap hasn't yet exited). A single 60-iter `large` ticket passing through `applyTicketTierBudget` could trip this at any moment.

3. **`bash install.sh` was claimed to run at run #5 launch** per `CONTEXT_2026-05-05.md` ("1 `bash install.sh` re-deploy (md5 parity restore)"), but the deploy mtime contradicts. Either the install.sh was run against a different deploy root, OR the rsync skipped because TS hadn't recompiled at the rsync moment (the original 1q hypothesis), OR the install.sh wasn't actually run despite operator intent. The doc-vs-disk gap is its own forensic class — operators cannot trust their own bootstrap notes.

### Why the gap goes structural

Deploy is **never the worker's job**. Worker prompts at `extension/src/bin/spawn-morty.ts:436` cover `commit + completion_commit:` but say nothing about deploy. The closer ticket `bdbf368d` runs `install.sh` as part of `closer-release-gate.sh` — but that fires **once at end of bundle**. So an entire 62-ticket bundle runs against pre-bundle deploys; every ticket's instrumentation events are dropped; every ticket's logic fix is invisible to the running runner.

The structural fix is wider than R-ITS-1/2:

- **R-ITS-5 (NEW): mid-bundle deploy guardrail.** `mux-runner.ts` at iteration_start checks deployed-vs-source md5 parity for the 5 hot files. Drift > N iterations → emit `deploy_parity_drift` event, log a one-line operator-actionable warning, and (option A) auto-spawn `install.sh` after current ticket; (option B) refuse to advance to next iteration until operator runs install.sh. Recommend option A with a kill-switch (`PICKLE_AUTO_REDEPLOY=off`) for paranoid operators.
- **R-ITS-6 (NEW): run-#5-style postmortem entry on bundle close.** Closer captures pre-deploy and post-deploy md5 manifests + diff so the bundle's release notes can list "this bundle's instrumentation was/wasn't visible until commit X" facts.

### Severity reassessment

The original P2 framing assumed "operator notices and re-runs install.sh." Run #5 forensic shows: **the operator DOES re-run install.sh and STILL gets the wrong deployed state** (per CONTEXT_2026-05-05.md vs disk reality). The user-visible failure mode is "monitor not updating" → operator investigates → discovers deploy is 2 days stale → realizes most of the bundle's "shipped" work wasn't actually live. Promote to **P1** at refinement Cycle 1. R-ITS-5 makes auto-redeploy the default; this PRD becomes the deploy-parity keystone for future bundles.

## Notes

- This bug is sister to AC-RVN-08 ("schema_version deploy parity") — but AC-RVN-08 only catches version-string drift, not the broader class of compiled-output drift.
- Slot 1q **must land before** the next bundle's first run; otherwise the next bundle launches with the same risk vector for any TS source edits made between PRD merge and pipeline launch.
- Cycle 1 should validate which 5 files are actually the "most-trafficked" — an audit of `extension/CLAUDE.md` invariant ENFORCE references would surface the right list. Cycle 1 should also re-evaluate the P2→P1 promotion in light of run #5 forensic.
- Cycle 2 should consider whether all `.js` outputs should be md5-checked or just a hot-path subset (LOC tradeoff). Also: should R-ITS-5's auto-redeploy fire mid-ticket or only at ticket boundaries? Mid-ticket risks file-replace-during-require race; ticket-boundary is safer but slower to react.
- Cycle 3 should confirm install.sh's existing typescript-symlink check (R-DTS-1, shipped) doesn't conflict with the new force-rebuild order.
- Run #5 live evidence: deploy mtime `May 3 10:41:42` across all 5 hot files; compiled `extension/types/index.js` mtime `May 5 02:29:43` (R-CNAR-1 worker recompile); TS source `extension/src/types/index.ts` mtime `May 4 17:49:59`. R-ITS-2 parity probe would have caught this in 2 seconds at any point in the last 1h+ of run #5.
