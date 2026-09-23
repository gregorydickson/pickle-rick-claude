# B-CGUP — codegraph is two majors behind, pinned by hand in three places

**Operator-requested 2026-09-23**, ahead of a large real-project run that will measure codegraph's value.
`@colbymchenry/codegraph` is pinned at **`0.9.9`**; npm `latest` is **`1.6.0`** (published by
2026-08-26). Nobody noticed, because the version is transcribed by hand into three places that must
agree, and nothing compares them against upstream.

## Census — measured at HEAD `77e1cfef`

| probe | result |
|---|---|
| `node -p "require('./extension/package.json').dependencies['@colbymchenry/codegraph']"` | `0.9.9` (exact pin) |
| installed `extension/node_modules/@colbymchenry/codegraph/package.json` version | `0.9.9` |
| `extension/package-lock.json` → `node_modules/@colbymchenry/codegraph` | `0.9.9` |
| `grep -c '0\.9\.9' install.sh` | **3** (`:428` comment, `:435` echo, `:436` tarball-mode `npm install …@0.9.9`) |
| deployed `~/.claude/pickle-rick/extension/node_modules/@colbymchenry/codegraph` | `0.9.9` |
| local/global codegraph on this host | **none** — no global install, no checkout. "Defer to the local version" has nothing to defer to |

### API compatibility — `0.9.9` → `1.6.0`, measured from the published `.d.ts`

The service calls exactly six members (`services/codegraph-service.ts`): `CodeGraph.init`, `CodeGraph.open`,
`close`, `indexAll`, `sync`, `buildContext`. **All six have identical signatures in `1.6.0`.** The only
removed member is `resolveReferencesBatched`, which has **0** uses in `src/` or `tests/`. `npm-sdk.js`
(the `main`) is byte-identical in size (3631 bytes) and the six platform optionalDependencies are unchanged.
`1.6.0` adds a `bin.codegraph` → `npm-shim.js`, which is exactly the file
`resolveCodegraphServeEntry` (`services/backend-spawn.ts:624`) already falls back to.

### The one behavioural change that matters: a daemon

`1.6.0` introduces a background daemon (`dist/mcp/daemon-manager.d.ts`, `CODEGRAPH_NO_DAEMON`,
`codegraph daemon` command). This repo launches `codegraph serve --mcp` with `CODEGRAPH_NO_WATCH=1`
(`backend-spawn.ts:633-635`) so that **C4's runtime `sync` is the SOLE writer** to `.codegraph/codegraph.db`.
`1.6.0`'s `watch-policy.d.ts:41` still ranks `CODEGRAPH_NO_WATCH=1` first ("explicit opt-out always wins").
**Unmeasured:** whether `serve --mcp` under `1.6.0` spawns or attaches to a daemon that outlives the worker
— a second writer, and a process the orphan reaper either kills wrongly or leaks. This PRD requires that
measurement rather than assuming it.

## The fix *(refined: requirements + codebase + risk-scope, 3 cycles)*

**Order is binding:** item 1 lands and is verified installed before items 2–3 are built or measured.
A daemon measurement against a still-`0.9.9` tree says nothing about this change.

1. **Range, not pin.** `extension/package.json` → `"@colbymchenry/codegraph": "^1.6.0"`, then
   `npm install` in `extension/` so `package-lock.json` and `node_modules` resolve `1.6.x`. Git-mode
   installs stay exact through the lockfile; tarball installs float within `^1`. Update
   `extension/data/codegraph-api-inventory.json` `_meta.version` to the resolved `1.6.x` and `_meta.pin`
   to describe the caret range. Today it says `"exact (0.9.9, no caret)"`, which this fix makes false.
   Its method-surface test (`codegraph-real-index.test.js:308-325`) skips `_meta`, so nothing else catches it.
2. **One single-writer env, not three copies — and it disables the daemon.** `CODEGRAPH_NO_WATCH: '1'` is
   set in three places today: the serve entry (`services/backend-spawn.ts:635`) and
   `services/codegraph-query-runner.ts:174` and `:235`. Collapse them into ONE exported constant
   carrying both `CODEGRAPH_NO_WATCH: '1'` and **`CODEGRAPH_NO_DAEMON: '1'`**, and use it at all three
   sites. Disabling the daemon unconditionally keeps the upgrade like-for-like: `0.9.9` had no daemon, and
   C4's runtime `sync` stays the sole index writer. **Measurement (recorded, not open-ended):** launch the
   exact serve entry against a scratch repo with the constant applied, end its parent, and record the
   codegraph process list before and after in the conformance artifact. A survivor is a finding to
   record and park; it is not a reason to halt.
3. **One version source in `install.sh`, fail-loud.** Replace the hard-coded `@0.9.9` in the tarball-mode
   `npm install` (`:435-436`) with the spec read from the deployed `extension/package.json`, and drop the
   version from the `:428` comment. The read must be GUARDED in the same posture as the self-probe at
   `:440-445`: on an unreadable file or a missing key, print a `❌ FATAL:` line naming the file, then
   `exit 1`. A bare `node -p` under `set -euo pipefail` dies with a raw stack trace, and it must never fall
   back to a literal version.
4. **Every stale literal, not two.** Measured at HEAD, **7** files outside `tests/evidence/` name `0.9.9`:
   `install.sh`, `src/bin/check-update.ts`, its COMPILED and executed copy `bin/check-update.js` (spawned by
   `stop-hook.ts:673`), `tests/check-update.test.js`, `tests/install-script.test.js`,
   `tests/integration/codegraph-real-index.test.js`, and `data/codegraph-api-inventory.json`. Regenerate
   compiled JS with a full `./node_modules/.bin/tsc` (not `--noEmit`). Leave
   `tests/evidence/ac3-codegraph-mcp-call.md` alone: it is a dated record.

## Simplification Review

1. **Necessary?** Yes — the operator is about to measure codegraph on a large run; measuring a
   two-majors-stale build would attribute upstream's age to our integration.
2. **Reuse instead of add?** Reuses the existing loader, serve entry, self-probe and fail-open wrapper
   unchanged. No new module, gate leg, setting or state field.
3. **Guarding brittle complexity?** The brittle thing is the version transcribed into `install.sh`
   twice. The fix deletes those copies rather than adding a check that they agree.
4. **Subtraction.** Three hand-maintained version sites collapse to one (`package.json`).

**Green-tree precondition:** release gate 22/22 green on `170485f5` (run `20260922T235419Z-47982`);
every commit since is docs-only.

## Non-goals

- **No codegraph-update notifier.** `check-update.ts` is Pickle Rick's own self-updater; polling npm
  for a dependency adds network machinery for what `npm outdated` already answers.
- **No "prefer a locally installed codegraph" resolution.** None exists on this host, and two
  resolvable versions is two behaviours to test.
- **Do not change `codegraph` settings defaults** (`context_max_bytes` etc.). Retune after the big run
  measures them — every injection today sits at the 8192 cap, which is a finding for later, not this bundle.
- **Do not adopt new `1.6.0` APIs** (`isIndexStale`, `getIndexState`, …) here. This bundle is a
  like-for-like upgrade; adopting them is a separate decision.

## Interface Contracts

**Inputs**: `extension/package.json` dependency spec.
**Outputs**: `node_modules/@colbymchenry/codegraph` at `1.6.x`; `install.sh` tarball mode installs the
spec read from `package.json`; the serve MCP entry's `env` carries `CODEGRAPH_NO_WATCH: '1'` and, if the
daemon measurement requires it, `CODEGRAPH_NO_DAEMON: '1'`.
**Invariants**: every existing codegraph test passes unchanged in intent; the service's six-member call
surface is unchanged; `install.sh`'s codegraph self-probe still passes in git mode; exactly ONE source
defines the codegraph child env, and it carries both `CODEGRAPH_NO_WATCH` and `CODEGRAPH_NO_DAEMON`.
**Errors**: an unreadable `package.json` in tarball mode must fail the install loudly (same posture as the
existing self-probe), never fall back to a literal version.

## Acceptance Criteria *(refined — every predicate run at HEAD `445df646`)*

- `node -p "require('./extension/package.json').dependencies['@colbymchenry/codegraph']"` prints `^1.6.0` — **measured `0.9.9`**.
- `node -p "require('./extension/node_modules/@colbymchenry/codegraph/package.json').version"` prints a `1.6.x` version — **measured `0.9.9`**.
- `node -p "require('./extension/package-lock.json').packages['node_modules/@colbymchenry/codegraph'].version"` prints a `1.6.x` version — **measured `0.9.9`**.
- `node -p "require('./extension/data/codegraph-api-inventory.json')._meta.pin"` does not contain `no caret` — **measured `exact (0.9.9, no caret)`**.
- From `extension/`: `grep -rlE '0\\?\.9\\?\.9' src bin tests data scripts ../install.sh | grep -v 'tests/evidence/' | wc -l` returns `0` — **measured `7` files / 13 lines**. The `\\?` matters: `tests/install-script.test.js:1515` pins the version as the REGEX `0\.9\.9`, which a plain `grep '0\.9\.9'` cannot see, and that assertion goes red the moment `install.sh` changes. It must be rewritten to assert the derived spec, not a version.
- `grep -rc 'CODEGRAPH_NO_DAEMON' extension/src | grep -v ':0' | wc -l` returns a value `>= 1` — **measured `0`**.
- `grep -rn "CODEGRAPH_NO_WATCH: '1'" extension/src | wc -l` returns `1`, the single constant — **measured `2`** (`backend-spawn.ts:635`, `codegraph-query-runner.ts:174`; `:235` assigns `process.env` and must use the constant too).
- `cd extension && ./node_modules/.bin/tsc --noEmit && npx eslint src/ --max-warnings=0` exits `0`.
- `cd extension && grep -l codegraph tests/*.test.js | xargs grep -l '@tier: fast' | xargs node bin/test-runner.js` exits `0` against `1.6.x`. **This is a REGRESSION GUARD, not a falsifier:** it already exits `0` at HEAD (1750 tests, 0 fail, 105s, 34 files). Two measured traps: `--tier fast` cannot be combined with positional files (the runner exits `2`), and a `$(…)` list under zsh arrives as ONE argument (the runner exits `1`).
- The daemon measurement (fix §2) is in the ticket's conformance artifact: the process list before and after the parent exits.
- `[manager]` `RUN_EXPENSIVE_TESTS=1 node --test tests/integration/codegraph-real-index.test.js` exits `0` on `1.6.x` (also covered by the release gate's `test_expensive` leg).

## Risks

- **Install size.** Measured unpacked: `1.6.0` is about 54% larger than `0.9.9` (analyst figures: 289.5 MB vs 188.2 MB).
  `check-update.ts`'s `INSTALL_SCRIPT_TIMEOUT_MS = 600_000` was tuned against a ~95s `0.9.9` tarball
  install. It likely still fits, but the release gate's soak and tarball tests are the check.
- **Rollback.** Git mode: revert the bundle's commits and re-run `install.sh`; the lockfile restores
  `0.9.9` exactly. A caret range cannot float BELOW `1.6.0`, so rollback is only by revert.
- **Upstream float in tarball mode.** A future `1.x` reaches tarball users without a source change. This
  is accepted by operator direction; the lockfile keeps git-mode measurements attributable.

## FALSIFY

**Before building** (pre-build, on the current tree):
- `npm view @colbymchenry/codegraph version` no longer prints `1.6.0` → retarget the range to the current
  latest and re-diff the six-member surface before continuing.

**After fix item 1 installs** (mid-ticket, against the installed `1.6.x`):
- Any of the six members' signatures differ in the installed `.d.ts` → the upgrade is no longer
  like-for-like. **Record it in the conformance artifact, do NOT flip the ticket Done, and continue.**
  This is a parked finding, never a halt (root CLAUDE.md: a measurement verdict is never a crash floor).
- `grep -c 'CODEGRAPH_NO_WATCH' extension/node_modules/@colbymchenry/codegraph/dist/sync/watch-policy.d.ts`
  returns `0` → the watcher opt-out moved. Park the same way; the single-writer invariant must be
  re-derived before this ships.

---

# Refinement Record *(3 roles × 3 cycles on `--model claude-sonnet-5`, 9/9 written, 0 refusals, 2026-09-23)*

Every finding below was re-verified against HEAD before being applied.

| # | analyst | finding | disposition |
|---|---|---|---|
| 1 | codebase, risk-scope | the stale-pin surface is **7** files, not 2, including the compiled, executed `bin/check-update.js` and `data/codegraph-api-inventory.json` (`_meta.pin` would read "no caret" after the fix) | **applied**: fix §4 lists all 7; the AC greps all of them; measured 7 |
| 2 | requirements, risk-scope | FALSIFY's "stop" contradicts the no-halt rule, and its header claimed pre-build for a post-install check | **applied**: split into pre-build and post-install; the disposition is park-and-continue |
| 3 | requirements | the Errors invariant (fail loud) was not implemented by a bare `node -p` under `set -euo pipefail` | **applied**: guarded `❌ FATAL:` read, same posture as the `:440-445` self-probe |
| 4 | requirements | fix §3 (daemon) silently depended on item 1 having landed | **applied**: binding order |
| 5 | risk-scope | the daemon "measurement" was open-ended investigation in a like-for-like PRD | **applied, as a subtraction**: set `CODEGRAPH_NO_DAEMON=1` unconditionally through one constant that replaces 3 hand-copied `NO_WATCH` sites; the measurement is now a recorded check, not an investigation |
| 6 | requirements, risk-scope | no rollback path; install size grew | **applied**: Risks section |

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---:|---|---|---|---|---|---|
| 10 | d8e11473 | Upgrade codegraph to `^1.6.0`; re-verify the API inventory | High | clean tree | 1.6.x installed + locked; inventory describes it | `package.json`, `package-lock.json`, `data/codegraph-api-inventory.json` |
| 20 | 3629050d | One single-writer env constant that also disables the daemon | High | d8e11473 Done | 1 definition, 3 sites; daemon survivor measured | `services/backend-spawn.ts`, `services/codegraph-query-runner.ts` (+ compiled), 2 tests |
| 30 | 96495ad7 | `install.sh` reads the version from package.json; clear stale literals | High | d8e11473 Done | version lives in package.json only | `install.sh`, `check-update.ts` (+ compiled), 3 tests |
| 40 | 7c54c91b | Harden: code quality review of the B-CGUP diff | High | all above | zero P0–P1 | all of the above |
| 50 | 642f1fb0 | Audit: data flow integrity for the B-CGUP diff | High | all above | zero CRITICAL/HIGH | source + install.sh |
| 60 | f1320133 | Harden: test quality review of the B-CGUP diff | High | all above | every AC mapped | test files |

The cross-reference audit ticket is omitted: no doc or command files are modified.
