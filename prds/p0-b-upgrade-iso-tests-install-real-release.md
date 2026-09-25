# B-UPGRADE-ISO — a test run installs the real latest release over the deployed runtime

**PRIME DIRECTIVE, P0.** Running the integration tier on this machine can empty the deployed
`~/.claude/pickle-rick/extension/node_modules`. After that, every pipeline launch dies at module load
(`ERR_MODULE_NOT_FOUND: Cannot find package 'typescript'`). This happened twice on 2026-09-25: once during a gate
run, and once reproduced on purpose. The integration tier still reported **0 failures** both times.

## Mechanism (measured at HEAD `8e7c94f9`, 2026-09-25)

- `extension/tests/check-update.test.js` stubs `gh` per test by prepending a fake `bin` dir to `PATH`. Some
  cases run with no stub active. With a recording, refusing `gh` first on `PATH`, one run of the file makes
  **7 real `gh` calls**: `gh api …/releases/latest` (twice), `gh release download v999.0.0` (twice),
  `gh release download v999.999.999-nonexistent`, and **`gh release download <EMPTY TAG> -R
  gregorydickson/pickle-rick-claude`**.
- `downloadRelease("")` (`extension/src/bin/check-update.ts`) spawns `gh release download "" …`. With an empty
  tag, `gh` downloads the **latest real release**. Measured: `downloadRelease("")` returned a path to
  `pickle-rick-2.1.1.tar.gz`.
- `runReleaseInstallScript` then runs that release's real `install.sh` with the inherited `HOME` and no
  `--prefix`. It reinstalls over the real `~/.claude/pickle-rick`, rebuilds `node_modules`, and dies partway
  through, leaving it empty.
- The same tests also append to the real `~/.claude/pickle-rick/deploy-audit.log` (`appendDowngradeAudit`
  reads `PICKLE_INSTALL_ROOT` or `os.homedir()`).
- It became reachable when `v2.1.1` published an installable release. It depends on network timing, so it
  does not fire on every run.

## Fix

1. **The product guard:** `downloadRelease(tag)` rejects an empty or whitespace-only tag. It logs, returns `null`,
   and never spawns `gh`. A missing tag must never mean "latest".
2. **Test isolation for the whole file:** `check-update.test.js` sets up, before any test runs and restored
   after, a sandbox `HOME`, a sandbox `PICKLE_INSTALL_ROOT`, and a **refusing `gh`** first on `PATH`. The refusing
   `gh` records every call and exits 1. Existing per-test stubs prepend their own `bin` dir, so they still win.
   No test in the file can reach the network or the real install root.
3. Do not change `install.sh` or the upgrade flow beyond (1).

## Files

- `extension/src/bin/check-update.ts` (+ compiled `extension/bin/check-update.js`)
- `extension/tests/check-update.test.js`
- `extension/tests/integration/check-update-extraction-containment.test.js`, only if it shares the gap (research
  measures it with the same recording-`gh` method)

## Acceptance criteria

1. **Zero real `gh` calls.** Run `node bin/test-runner.js tests/check-update.test.js --test-concurrency=1` from
   `extension/` with a recording, refusing `gh` first on `PATH`: the recording has **0** lines (HEAD: 7). Also
   add this as a test inside the file: a file-level `after` hook asserts the sandbox `gh` recorded no call
   that no per-test stub answered.
2. **Empty tag refused.** `downloadRelease('')` and `downloadRelease('  ')` return `null` and spawn nothing
   (HEAD: downloads `pickle-rick-2.1.1.tar.gz`). The test asserts that no `gh` invocation was recorded.
3. **Real install root untouched.** Across one run of the file, the real `~/.claude/pickle-rick/deploy-audit.log`
   line count and the real `~/.claude/pickle-rick/extension/node_modules` listing are unchanged (HEAD: the
   audit log grows).
4. All `check-update.test.js` cases pass; `./node_modules/.bin/tsc --noEmit` and
   `npx eslint src/ --max-warnings=0` exit 0.

## Simplification Review

One guard on a real product bug (an empty tag silently means "latest"), plus one file-level sandbox that replaces
per-test discipline. No gate leg, no new env var.

## Out of scope

Changing the self-upgrade flow; `install.sh`.
