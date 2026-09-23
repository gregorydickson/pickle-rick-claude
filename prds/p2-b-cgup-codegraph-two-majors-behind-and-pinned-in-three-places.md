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

## The fix

1. **Range, not pin.** `extension/package.json` → `"@colbymchenry/codegraph": "^1.6.0"`, then
   `npm install` in `extension/` so `package-lock.json` and `node_modules` resolve `1.6.0`. Git-mode
   installs stay exact through the lockfile; tarball installs float within `^1` — the operator's
   "don't hand-pin" direction, bounded by semver.
2. **One source of truth in `install.sh`.** Replace the hard-coded `@0.9.9` in the tarball-mode
   `npm install` (`:435-436`) with a version spec READ from the deployed `extension/package.json`
   (`node -p "require('./package.json').dependencies['@colbymchenry/codegraph']"`), and delete the
   version from the `:428` comment. After this, the version lives in `package.json` alone.
3. **Close the daemon question by measurement.** Launch the exact `serve --mcp` entry
   `resolveCodegraphServeEntry` builds, against a scratch repo, then end its parent; record whether any
   codegraph process survives. If one does, add `CODEGRAPH_NO_DAEMON: '1'` to that entry's `env`
   (beside `CODEGRAPH_NO_WATCH`). If none does, add it anyway only if the measurement cannot be made
   deterministic — and record which in the ticket's conformance artifact.
4. **Stale literal pins.** Update the test assertion message at `tests/install-script.test.js:1516`
   and the `check-update.ts:16` comment so neither names `0.9.9`. Leave
   `tests/evidence/ac3-codegraph-mcp-call.md` alone — it is a dated historical record.

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
surface is unchanged; `install.sh`'s codegraph self-probe still passes in git mode.
**Errors**: an unreadable `package.json` in tarball mode must fail the install loudly (same posture as the
existing self-probe), never fall back to a literal version.

## Acceptance Criteria

- `node -p "require('./extension/package.json').dependencies['@colbymchenry/codegraph']"` prints `^1.6.0` — **measured `0.9.9` at HEAD**.
- `node -p "require('./extension/node_modules/@colbymchenry/codegraph/package.json').version"` prints a `1.6.x` version — **measured `0.9.9`**.
- `node -p "require('./extension/package-lock.json').packages['node_modules/@colbymchenry/codegraph'].version"` prints a `1.6.x` version — **measured `0.9.9`**.
- `grep -c '0\.9\.9' install.sh` returns `0` — **measured `3`**.
- `grep -rn '0\.9\.9' extension/src extension/tests/install-script.test.js | wc -l` returns `0` — **measured `2`** (`check-update.ts:16`, `install-script.test.js:1516`).
- `cd extension && ./node_modules/.bin/tsc --noEmit && npx eslint src/ --max-warnings=0` exits `0`.
- `cd extension && grep -l codegraph tests/*.test.js | xargs grep -l '@tier: fast' | xargs node bin/test-runner.js` exits `0` against `1.6.0`. **This is a REGRESSION GUARD, not a falsifier:** measured at HEAD it already exits `0` (1750 tests, 0 fail, 105s, 34 files). Two authoring traps were measured and avoided: `--tier fast` cannot be combined with positional files (the runner exits `2`), and `$(…)` expansion under zsh passes the list as ONE argument (the runner exits `1`, `Could not find`).
- The daemon measurement (fix §3) is recorded in the ticket's conformance artifact with the observed process list before and after the parent exits.
- `[manager]` `RUN_EXPENSIVE_TESTS=1 node --test tests/integration/codegraph-real-index.test.js` exits `0` on `1.6.0` (this is also covered by the release gate's `test_expensive` leg).

## FALSIFY — take these before building

- `npm view @colbymchenry/codegraph version` no longer prints `1.6.0` → retarget the range to the current latest and re-diff the six-member surface.
- Any of the six members' signatures differ in the installed `1.6.x` `.d.ts` → stop; this is no longer like-for-like.
- `grep -c 'CODEGRAPH_NO_WATCH' extension/node_modules/@colbymchenry/codegraph/dist/sync/watch-policy.d.ts` returns `0` after install → the watcher opt-out moved; the single-writer invariant must be re-derived before shipping.
