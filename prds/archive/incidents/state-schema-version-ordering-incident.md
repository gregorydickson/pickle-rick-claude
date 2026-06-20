# PRD: State Schema-Version Ordering Incident + Fix

**Status**: SHIPPED via v1.62.0 + v1.62.1 (2026-04-30) — AC-SSV-05 (topo-sort by `depends_on` in pipeline-runner) shipped via `2319cee`; AC-SSV-07 (monitor stdout backpressure watchdog + EXCEEDED indicator) shipped via `643caa5`; AC-SSV-08 (deploy/source schema-version parity test + `assertSchemaVersionDeployParity`) shipped via `9f39b7f`. AC-SSV-04 (NEW-T2 lowered) and AC-SSV-06 (actionable schema-mismatch error) not yet verifiably shipped — track as residual follow-up.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Origin**: live during the Citadel + Hardening Bundle pipeline run (`pipeline-1204204c`, session `2026-04-29-1204204c`). Discovered when the user reported: "the upper-left pane in the monitor often stops updating".

---

## Problem

The Citadel + Hardening Bundle pipeline ran C-T0 (`Citadel: Session-state schema migration`, order=200) before NEW-T2 (`v2→v3 state migration rollback path`, order=300). NEW-T2 was specifically authored to be the safety net against a v3 state file being read by a v2-aware deployment — but `pipeline-runner` sorts tickets by numeric `order` and ignored the `links: parent: C-T0` dependency expressed in `prd_refined.md`. Result: C-T0 stamped `state.json.schema_version: 3` while every monitor pane and hook still ran the v2-capped deployed `StateManager`. Every read threw `SCHEMA_MISMATCH`. Watchers entered the catch-path and froze on `Awaiting signal...`. The dashboard pane (top-left, `monitor.js`) on `pipeline-1204204c` never recovered until manual intervention.

## Symptoms (observed)

1. **Top-left monitor pane** stuck on `Awaiting signal...` indefinitely — the message rendered every 2s but no real data ever appeared.
2. **All four watcher panes** silently stale: each watcher reads `state.json` via `StateManager.read()` and they all failed identically.
3. **Pipeline-runner kept advancing** — the runner uses its own state-write path (which can write but bypasses the read-schema-validate path on writeback in some branches), so the pipeline did not stall. Recent commits (`2d5ab2e`, `a24c202`, `4798e3c`, `53ddf81`) shipped while the monitor was wedged.
4. **`process.stdout.write` on `monitor.js` blocked** when the pty buffer filled with repeated clear-screen-plus-message output. The old monitor process (PID 23280) ignored `Ctrl-C` because it was blocked in the `write()` syscall, not running JS — required `kill -9`.

## Root Cause (three layers)

### L1 — Decomposition ordering bug (mine)

In `prd_refined.md` §Sequencing I noted:

> NEW-T2 is intentionally placed at order=300 in the table but should be evaluated as a hard prerequisite of citadel-T0 by `pipeline-runner` (sequencing-aware enqueuer). The order-number alone is informational; explicit `links: [parent: citadel-T0]` carries the dependency.

This claim is **false against the actual runtime**. `pipeline-runner` sorts tickets by `order` (numeric ascending) and does not consult `links`. Therefore C-T0 (200) ran before NEW-T2 (300). NEW-T2's purpose was preempted by its own ordering.

### L2 — `pipeline-runner` ignores `links` (architectural)

The `links:` field on each compact ticket is metadata for human readers and the parent-ticket aggregator. The runner has no DAG awareness — it is a flat priority queue keyed on numeric `order`. This is fine for fully-ordered work, but breaks the moment a ticket expresses a "must happen before" dependency that the order-number violates. The schema migration pattern (NEW-T2 → C-T0 must hold) is a canonical example.

### L3 — Source TS shipped v3 in advance of deploy (operational)

After C-T0 committed `2d5ab2e` ("feat: add citadel state metadata migration"), the source TS at `extension/src/types/index.ts:96` set `schemaVersion: 3` and `state-manager.ts` migration logic supported v3. But `bash install.sh` was never run after the bump, so the deployed `~/.claude/pickle-rick/extension/services/state-manager.js` and `types/index.js` retained v2. The system briefly held an asymmetric state: source = v3, deployed = v2, and the running pipeline was writing v3 state files that the deployed reader rejected.

This is the exact failure class **AC-BUNDLE-16** (NEW-T2's AC: "v3-on-v2 incompatibility produces a recoverable, operator-actionable error") was designed to make explicit and recoverable. Without NEW-T2 yet shipped, the failure surfaced as a silent monitor freeze with no actionable error message — the worst of all worlds.

---

## Fix Applied (Option D — Hot-Patch Deployed Reader)

Edit to `~/.claude/pickle-rick/extension/types/index.js`:

```js
export const STATE_MANAGER_DEFAULTS = {
    maxLockRetries: 10,
    baseLockDelayMs: 100,
    lockJitter: true,
    staleLockTimeoutMs: 30_000,
    // HOT-FIX 2026-04-29: bumped 2 → 3 to tolerate state.json written by the
    // in-flight C-T0 (Citadel session-state schema migration) ticket. Source
    // change pending; this deployed copy will be overwritten on next install.sh.
    // See prds/archive/incidents/state-schema-version-ordering-incident.md.
    schemaVersion: 3,
};
```

Then force-killed the wedged `monitor.js` (PID 23280, blocked on `stdout.write`) and relaunched all four watchers via `tmux send-keys`. New processes captured `schemaVersion: 3` at construction. Monitor pane resumed normal updates within 4s.

**Why D** (ranked):
- **D — bump deployed reader cap** (chosen): zero work loss, no pipeline restart, hot-deployable in seconds. Source TS already had v3, so the deployed file was the only out-of-date artifact; the hot-fix is now consistent with source.
- A — patch state.json schema_version 3→2: cat-and-mouse — C-T0 worker re-bumps it within seconds.
- B — wait for C-T0 + `bash install.sh`: monitor stays wedged for ~10–30 minutes during the citadel run.
- C — kill pipeline + fix ordering + restart: loses ~3 hours of in-flight progress.

## Forward Fixes (separate tickets)

### F1 — Land NEW-T2 with retroactive AC-BUNDLE-16 verification

NEW-T2's order should be **lowered to ~50** (between NEW-T5 at 30 and A-T1 at 40) so it ships before any v3-writing ticket. Its AC remains: "v3-on-v2 incompatibility produces recoverable, operator-actionable error." Verification: simulate v3 state file + v2 deployed reader → reader exits with stderr message "v3 fields present, deployment is v2; restore newer install via `bash install.sh` or drop fields with `--force-downgrade`" instead of a silent throw.

### F2 — `pipeline-runner` honors `links: parent: <key>` as a hard sort fence

Update `pipeline-runner` enqueuer to do a topological sort on `links` first, then break ties by `order`. Concrete: load `decomposition_manifest.json`, build a Map<key, depends_on[]>, perform Kahn's algorithm, emit tickets in dependency-respecting order. If a cycle exists, halt with actionable error. Add a regression fixture: ticket A at order=200 with `depends_on: [B]`, ticket B at order=300 → expected execution order is B then A.

### F3 — `bash install.sh` runs implicitly on `state.json.schema_version` mismatch

When `pipeline-runner` (or any runner) detects that the file's `schema_version` exceeds the deployed `STATE_MANAGER_DEFAULTS.schemaVersion`, halt with an actionable error pointing at `bash install.sh`. Do not throw silently from inside `StateManager.read()`. This is exactly NEW-T2's AC-BUNDLE-16 written one layer up.

### F4 — `monitor.js` SIGINT must work even under stdout backpressure

The wedged monitor process needed `kill -9` because its event loop was stuck inside `process.stdout.write` (synchronous when the pty buffer is full). The SIGINT handler couldn't run. Mitigation: use `process.stdout.write(buf, callback)` with a watchdog that detects backpressure and triggers `process.exit(1)` if no callback fires within ~5s. Alternative: switch to non-blocking writes via `fs.write` against `/dev/tty` with O_NONBLOCK, drop frames on EAGAIN.

### F5 — Trap-door entry for `STATE_MANAGER_DEFAULTS.schemaVersion`

Add an INVARIANT entry to `extension/CLAUDE.md` for the schemaVersion constant:

> `src/types/index.ts` (schemaVersion) — INVARIANT: deployed `STATE_MANAGER_DEFAULTS.schemaVersion` must be ≥ the schema version that any in-tree migration writes. BREAKS: state-writes from new code are unreadable by the deployed reader; every consumer (monitor, hooks, status, watchers) sees `SCHEMA_MISMATCH` and freezes. ENFORCE: extension/tests/state-schema-version-deploy-parity.test.js.

The enforce test reads source TS's schemaVersion + every migration's target version, asserts deployed JS matches source, and runs in CI before any deploy.

---

## Acceptance Criteria

- **AC-SSV-01** Hot-fix is verified: top-left monitor pane (`pipeline-1204204c:1.0`) shows live ticket data (Project, Phase, Iteration, Current, Tickets list, Recent output) and refreshes every 2s. _Status: **Done** at 2026-04-29 18:11 PDT._
- **AC-SSV-02** All four watcher panes show `pane_current_command = node` and are reading state without throwing. _Status: **Done**._
- **AC-SSV-03** Source TS at `extension/src/types/index.ts` and deployed JS at `~/.claude/pickle-rick/extension/types/index.js` agree on `schemaVersion`. _Status: **Done** (both = 3)._
- **AC-SSV-04** F1 ships: NEW-T2 lowered to order ~50 in `decomposition_manifest.json` and an integration test exercises v3-on-v2 → actionable error.
- **AC-SSV-05** F2 ships: `pipeline-runner` respects `links: depends_on` as a hard fence; regression fixture asserts a 200-after-300 dependency executes 300 first.
- **AC-SSV-06** F3 ships: any reader that detects `schema_version > deployed.schemaVersion` exits with stderr message naming `bash install.sh` and the offending file path. No silent throws.
- **AC-SSV-07** F4 ships: `monitor.js` exits within 5s of SIGINT even when stdout is backpressured.
- **AC-SSV-08** F5 ships: trap-door entry added; enforce test asserts deployed/source schemaVersion parity in CI.

## Verification Plan

1. **AC-SSV-01..03 (already verified)** — `tmux capture-pane -t pipeline-1204204c:1.0 -p` shows dashboard. `node -e 'sm.read(...)'` succeeds. `diff` between `extension/src/types/index.ts:96` and `~/.claude/pickle-rick/extension/types/index.js:14` shows agreement.
2. **AC-SSV-04** — write `extension/tests/integration/state-schema-version-rollback.test.js` that constructs a session with `schema_version: 3` and runs `pipeline-runner` against a `STATE_MANAGER_DEFAULTS.schemaVersion: 2` shim. Expect exit code != 0 and stderr matching `/v3.*deployment is v2/`.
3. **AC-SSV-05** — write `extension/tests/pipeline-runner-link-ordering.test.js` with two tickets: `A` at `order: 200, depends_on: ['B']`, `B` at `order: 300`. Drive `pipeline-runner.enqueue()` and assert returned queue is `[B, A]`.
4. **AC-SSV-06** — manually point reader at a v3 state file with v2 deployed cap; expect actionable stderr message naming `bash install.sh`.
5. **AC-SSV-07** — start `monitor.js` against a session, fill its pty buffer (`yes | head -c 100000 > /dev/tty`), send SIGINT; expect process to exit within 5s.
6. **AC-SSV-08** — run new test in `npm test`, assert deployed/source parity check passes.

## Non-goals

- Rewriting `pipeline-runner` into a full DAG executor. F2 only adds topological-sort respecting `depends_on`; ticket-level concurrency, fan-out, retry policies stay out of scope.
- Re-architecting how `StateManager` migrations work. F3 wraps the existing throw with a structured error; the migration code itself stays put.
- Changing the deployed-vs-source contract. F5 codifies it as a trap-door, but the underlying "bash install.sh canonically deploys" rule is unchanged.

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-SSV-1 | Hot-fixed deployed `types/index.js` is overwritten on next `bash install.sh` if source and deployed drift further. | Source TS already at v3, so install.sh now produces the same output. After this incident, source is the single source of truth (per project CLAUDE.md). |
| R-SSV-2 | F2 changes pipeline-runner ordering semantics; existing PRDs assume strict numeric order. | Add regression test that assets numeric order is the tiebreaker, not the primary. Document in `decomposition_manifest.json` schema. |
| R-SSV-3 | F4's stdout watchdog may force-exit a slow but otherwise healthy monitor. | 5s threshold is well above normal render time (~50–200ms with 75 tickets). Make it configurable via `MONITOR_STDOUT_WATCHDOG_MS`. |
| R-SSV-4 | F5's CI check could false-positive if a migration is in-progress and source TS is mid-update. | Test reads only the deployed value vs the highest declared `schema_version` in `state-manager.ts` migrations table; mid-PR drift in source is fine as long as `bash install.sh` runs before merge. |
| R-SSV-5 | Other readers may have similar in-process state caches that don't see hot-fixed deployed files. | Re-emergence path: process restart. Document in trap-door (F5) that hot-patches require watcher restart. |

## Files Likely Touched (for forward fixes)

```
extension/src/bin/pipeline-runner.ts                              # F2: links-aware enqueuer
extension/src/services/state-manager.ts                            # F3: actionable schema-mismatch error
extension/src/bin/monitor.ts                                       # F4: stdout watchdog
extension/CLAUDE.md                                                # F5: trap-door entry
extension/tests/integration/state-schema-version-rollback.test.js  # F1, F3
extension/tests/pipeline-runner-link-ordering.test.js              # F2
extension/tests/monitor-stdout-watchdog.test.js                    # F4
extension/tests/state-schema-version-deploy-parity.test.js         # F5
```

---

## Linked Context

- Active pipeline: tmux session `pipeline-1204204c`, session dir `~/.local/share/pickle-rick/sessions/2026-04-29-1204204c/`.
- Refined PRD: `prds/citadel-hardening-bundle.md` §Sequencing (the false claim that prompted the ordering bug).
- C-T0 commit: `2d5ab2e` ("feat: add citadel state metadata migration") — the ticket that wrote `schema_version: 3`.
- Hot-fix in deployed code: `~/.claude/pickle-rick/extension/types/index.js` line 14 — bumped `schemaVersion: 2 → 3`.
- Source-of-truth file: `extension/src/types/index.ts:96` — already at v3 from C-T0.
- Relevant ACs preempted: AC-BUNDLE-15 (phase-ordered AC firing, NEW-T4), AC-BUNDLE-16 (v3-on-v2 actionable, NEW-T2).
- Trap-door file: `extension/CLAUDE.md` (target for F5 invariant addition).
- Watcher-pane-recovery (just shipped: A-T1..A-T4) is **not** the right fix for this — that PRD explicitly excludes pane 0 (monitor.js). The watchers it recovers are panes 1/2/3.
- Master plan reference: `prds/MASTER_PLAN.md` §2.2 (Citadel + Hardening Bundle launch session) — incident note added.
