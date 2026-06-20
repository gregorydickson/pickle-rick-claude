---
title: P1 bug-fix bundle — B-PTSB — phantom teams-base session leak (setup.js test invocations write active sessions into the real data root)
status: SHIPPED v1.87.0 (verify-first closed 2026-06-02) — STALE PRD; do not re-launch. Closer bb85931e (+ 496660c7 test fallout, ce4aff13 R-PTSB-3, 0b8d94ed R-PTSB-4). orphan_phantom_demoted event registered (types/index.ts:570); state-manager.ts demotes pid-null phantom on read (~L970-988); setup-teams.test.js sandboxes PICKLE_DATA_ROOT; audit-test-isolation.sh present. #75 R-PTSB DONE.
filed: 2026-05-30
priority: P1
type: bug-bundle
code: B-PTSB
composes:
  - "#75 R-PTSB — phantom teams-base \"default-off\"/\"teams-base\"/\"effort-medium-test\" sessions recur and block install.sh"
source:
  - prds/babysitter.md   # step 1 demote-phantom band-aid this bundle replaces with a root-cause fix
---

# B-PTSB — phantom-session leak root-cause fix

## Trigger

Finding #75 (R-PTSB): phantom Pickle Rick sessions recur in `~/.local/share/pickle-rick/sessions/` with the exact signature `active: true` AND `pid` null/absent AND `tmux_mode: false` AND `iteration: 0` AND `history: []`, with `original_prompt` equal to one of the literal strings `"default-off"`, `"teams-base"`, or `"effort-medium-test"`. They block `install.sh` at finalization until cancelled. The babysitter band-aids by demoting each tick (`prds/babysitter.md` step 1). This bundle is the real root-cause fix.

## Root cause (verified 2026-05-30)

Three compounding defects, confirmed by code read:

1. **Test-isolation leak (primary).** `extension/tests/setup-teams.test.js` `runSetup` (lines 24–30) invokes the real `setup.js` via `execFileSync(process.execPath, [SETUP, ...args], { env: { ...process.env, FORCE_COLOR: '0', ...extraEnv } })` **without overriding `PICKLE_DATA_ROOT`**. `setup.ts` resolves its session root through the `PICKLE_DATA_ROOT`-honoring data-dir resolver (`extension/src/services/pickle-utils.ts:383,410` → `setup.ts:112 sessionsRoot = path.join(dataDir, 'sessions')`). With no override, every gate run that executes these tests writes **real** sessions into the operator's production session dir. The three phantom `original_prompt` strings are exactly the test fixtures: `runSetup(['--task', 'default-off'])` (setup-teams.test.js:119), `runSetup(['--teams', '--task', 'teams-base'])` (line 166), and `effort-medium-test` (sibling test). Because gates run constantly, the phantoms recur relentlessly.

2. **`setup.ts` writes `active=true` with no owning pid.** `extension/src/bin/setup.ts:1029` sets `active: !config.pausedMode && !config.tmuxMode`. A `setup.js` invocation **without** `--tmux` and **without** `--paused` therefore writes `active: true`, and `pid` is never assigned (stays null). The leaked test sessions are thus "active" orphans the moment `setup.js` exits.

3. **Demotion blind spot.** `extension/src/services/state-manager.ts:469` gates auto-demotion on `shouldDemote: ageMs >= 300_000 && deadMappedPid`. A freshly-leaked phantom has `ageMs << 300_000` AND `pid == null` (no mapped pid to test as dead), so the existing `recoverStaleActiveFlag` → `getPausedOrphanDemotion` path never fires for it. The phantom persists, blocking `install.sh`, until an operator/babysitter intervenes.

## Scope / version

- **Version: MINOR** (1.86.0 → 1.87.0) IF a new activity event (`orphan_phantom_demoted`) and/or a new failure/exit reason is registered (new event = MINOR per babysitter DECISION RULES). If the closer's final diff registers no new event/flag/state-field and is purely test-isolation + audit + a guard reusing existing reasons, it is PATCH (1.86.0 → 1.86.1). The closer determines the bump from the landed diff per semver — single bump for the bundle.
- Schema-neutral: no `state.json` schema field added, no `LATEST_SCHEMA_VERSION` change. Does NOT touch the #74 schema-bump machinery.
- The runtime demotion change (R-PTSB-3) touches `state-manager.ts` `recoverStaleActiveFlag`, a hot path run on every `StateManager.read()` — the guard MUST be airtight: a real session is NEVER demoted. The full pickle lifecycle (research → plan → review) is the safety net.

## Atomic tickets

### R-PTSB-1 (medium) — Sandbox the data root for every setup.js-invoking test (stop the leak at the source)
- In `extension/tests/setup-teams.test.js`, make `runSetup` (line 24) and `runSetupExpectFail` (line 46) create a per-invocation temp dir (`fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-setup-teams-data-'))`) and pass `PICKLE_DATA_ROOT=<tmpdir>` in the child env. Clean it up in a `finally`/`after`.
- Audit ALL OTHER tests that spawn `setup.js`, `mux-runner.js`, `spawn-morty.js`, or any bin that writes a session, and apply the same `PICKLE_DATA_ROOT` sandbox. Candidates to check: `setup.test.js`, `setup-resume-*.test.js`, `setup-paused-*.test.js`, `worker-setup.test.js`, `mux-runner-*.test.js`, `crash-recovery.test.js`. Only change tests that actually invoke a session-writing bin as a subprocess.
- **AC:** after a full `npm run test:fast && npm run test:integration`, `ls ~/.local/share/pickle-rick/sessions/` (the real default data root) shows ZERO new sessions whose `original_prompt` is `default-off`/`teams-base`/`effort-medium-test`/`teams-flag`/`mp-*`/`resume-teams`/`codex-base` — i.e. no test fixture prompt leaks into the production data root. A regression assertion in `setup-teams.test.js` proves the child wrote into the tmp `PICKLE_DATA_ROOT`, not the default.

### R-PTSB-2 (medium) — Enforce test data-root isolation in the audit gate
- Extend `extension/scripts/audit-test-isolation.sh` to FAIL when a test file invokes a session-writing bin (`setup.js`/`mux-runner.js`/`spawn-morty.js`/`jar-runner.js`) via `execFileSync`/`spawnSync`/`execSync`/`spawn` WITHOUT a `PICKLE_DATA_ROOT` sandbox in the child `env`. Use the same window-scan approach already in the script.
- Add a fixture under `extension/tests/fixtures/audit-test-isolation/` proving the detector trips on an un-sandboxed setup.js invocation and passes on a sandboxed one.
- **AC:** `bash scripts/audit-test-isolation.sh` exits 0 on the fixed tree; injecting an un-sandboxed `setup.js` subprocess call into a fixture makes it exit non-zero with a clear message naming the file:line.

### R-PTSB-3 (medium) — Runtime defense: stamp an owning pid + demote the pid-null phantom signature on read
- **Owning-pid stamp:** in `extension/src/bin/setup.ts` around line 1029, when writing `active: true`, also set `pid: process.pid` so a leaked/orphaned active session becomes a demotable orphan the instant its creating process exits (the existing `deadMappedPid` path can then reclaim it). Do not set pid when `active` is false.
- **Pid-null phantom demotion:** in `extension/src/services/state-manager.ts`, extend `getPausedOrphanDemotion`/`recoverStaleActiveFlag` so the R-PTSB signature — `active === true && (pid == null) && tmux_mode === false && iteration === 0 && Array.isArray(history) && history.length === 0` — is demoted to `active: false` with `exit_reason: 'orphan_phantom_demoted'` on the next `StateManager.read()`, **bypassing the 300_000 ms age gate** (a pid-null phantom has no owning process to wait on). Register `orphan_phantom_demoted` in `VALID_ACTIVITY_EVENTS`/`EVENT_NAMES`/`activity-events.schema.json` if a new event is emitted.
- **Airtight guard — a real session is NEVER demoted:** the demotion fires ONLY on the FULL conjunctive signature above. Any one of `pid != null`, `tmux_mode === true`, `iteration > 0`, or `history.length > 0` exempts the session. Add explicit negative test cases for each exempting condition.
- Rebuild the deployed `extension/bin/setup.js` + `extension/services/state-manager.js` in the same change (deploy parity).
- **AC:** a fixture phantom (`active:true, pid:null, tmux_mode:false, iteration:0, history:[]`) is demoted to `active:false`/`exit_reason:'orphan_phantom_demoted'` on the first `StateManager.read()` regardless of mtime age; FOUR negative fixtures (pid set / tmux_mode true / iteration>0 / history non-empty) are each left untouched; `state-manager.test.js` + `resolve-state-paused-orphan-demote.test.js` green.

### R-PTSB-4 (small) — Trap-door pin + babysitter band-aid retirement note
- Pin the phantom-leak invariant in `extension/src/bin/CLAUDE.md` (or the nearest owning CLAUDE.md): tests that invoke session-writing bins MUST sandbox `PICKLE_DATA_ROOT`; `setup.ts` stamps `pid` on active write; the pid-null phantom signature is auto-demoted on read. ENFORCE: `audit-test-isolation.sh` + `state-manager.test.js`.
- Update `prds/babysitter.md` step 1 to note the demotion is now a runtime safety net (R-PTSB-3) and the manual band-aid is defense-in-depth, not the primary mechanism.
- **AC:** `bash scripts/audit-trap-door-enforcement.sh` passes with the new pin; the referenced ENFORCE test files exist.

### C-PTSB-CLOSER [manager] — Ship
- Run the FULL release gate from `extension/` (tsc --noEmit, eslint --max-warnings=-1, tsc, all audit-*.sh, test:fast, test:integration, RUN_EXPENSIVE_TESTS=1 test:expensive). Confirm GREEN.
- Determine the semver bump from the landed diff (MINOR if `orphan_phantom_demoted` event registered; else PATCH), bump `extension/package.json`, commit `chore(C-PTSB-CLOSER): ship B-PTSB — bump X.Y.Z + repoint MASTER_PLAN`.
- `bash install.sh`, verify clean tree + deployed JS matches source, `git push`, `gh release create vX.Y.Z`.
- Mark MASTER_PLAN B-PTSB SHIPPED (drain-queue row removed, Status version updated), close finding #75.

## Acceptance (bundle-level)

- No test fixture prompt leaks into the real `~/.local/share/pickle-rick/sessions/` after a full gate run (R-PTSB-1).
- `audit-test-isolation.sh` enforces the sandbox going forward (R-PTSB-2).
- Any pid-null phantom that does slip through is auto-demoted on read, and `setup.ts` stamps an owning pid so orphans self-reclaim (R-PTSB-3).
- A real active session (interactive `/pickle`, tmux, or any session with progress) is provably never demoted (R-PTSB-3 negative tests).
- Release gate green, clean tree, shipped through `gh release create` (C-PTSB-CLOSER).
