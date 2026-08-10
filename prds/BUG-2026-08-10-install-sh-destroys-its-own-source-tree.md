# BUG — install.sh destroys the source tree it builds from

**Status:** ready to launch
**Branch:** `release/v2.1-beta`
**Launch commit:** `45cda0bd`
**Build mode:** unattended (does not touch the salvage / completion-evidence / Done-flip path)

---

## Problem

`install.sh` deletes every compiled `.js` under `extension/` that has a `.ts` twin, then recompiles —
always in `$SCRIPT_DIR/extension`, which is the **real repository**, regardless of `--prefix`:

```sh
# install.sh:343-353
echo "🗑  Force-cleaning compiled JS (R-ITS-1: prevents stale-tsc-cache drift)..."
while IFS= read -r tsfile; do
  rel="${tsfile#"$SCRIPT_DIR/extension/src/"}"
  jsfile="$SCRIPT_DIR/extension/${rel%.ts}.js"
  rm -f "$jsfile" 2>/dev/null || true
done < <(find "$SCRIPT_DIR/extension/src" -type f -name "*.ts" ! -name "*.d.ts" 2>/dev/null)
rm -f "$SCRIPT_DIR/extension/.tsbuildinfo" 2>/dev/null || true
echo "🔨 Compiling TypeScript..."
(cd "$SCRIPT_DIR/extension" && npx tsc)
```

`--prefix` sandboxes the rsync **destination**. It does not sandbox the **build**. For the 10-30 s of
that recompile, roughly 130 modules do not exist on disk. Any process importing them in that window
fails with `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`.

### Measured blast radius (2026-08-10, this branch, load ~40)

`tests/integration/install-excludes-working-dir-state.test.js` runs `install.sh --prefix <tmp>` and is
**not** listed in `extension/tests/integration/.serial-tests.json`, unlike all five other install
tests. Running the integration parallel sub-tier at `--test-concurrency=4`:

| | |
|---|---|
| tests | 341 |
| fail | 87 |
| of which collateral (`ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`) | **86** |
| of which real | 1 (`INV-CODEX-RECOVERY-ADVANCED`, known, out of scope here) |

The serial sub-tier, run immediately after on the same box, was **591/591 pass, `SER_EXIT=0`** — it is
concurrency, not load, that produces the failures.

The three audit preflights were all green (`AUDIT_TIERS=0`, `AUDIT_ISO=0`, `AUDIT_SUBPROC=0`).
`audit-test-isolation.sh` cannot catch this: the test itself writes nothing to the repo. `install.sh`
does.

This is the previously-catalogued "integration test deletes compiled tree" symptom, now attributed to
its cause.

## Pre-launch stale-premise check

- `install.sh:343-353` — force-clean loop present at `HEAD` (`45cda0bd`), unguarded. **Open.**
- `extension/tests/integration/.serial-tests.json` at `HEAD` — 62 entries,
  `install-excludes-working-dir-state.test.js` **absent**. **Open.**
- `extension/CLAUDE.md` `PICKLE_INSTALL_ROOT` row — still documents an `install.sh` deploy-prefix
  override that `install.sh:33` unconditionally clobbers. **Open.**
- `install.sh` is not a deployed artifact, so there is no deployed-tree arm to this check.

## Green-tree precondition

Measured on `45cda0bd`, 2026-08-10, box at load 25-40 (a game and a VM running):

```
npm run test:fast   7481 tests, 7476 pass, 2 fail, 2 skipped, FAST_EXIT=1, 693 s
```

Both failures are timing-shaped, not logic:

| Test | Observed | Budget |
|---|---|---|
| `readRecoverableJsonObject readdirSync bound: 10k decoys + 1 matching tmp under 50ms` | 10106 ms | 50 ms |
| `spawn-morty: recovers orphan tmp backend state before routing worker CLI` | 45030 ms | timeout-shaped |

Re-run alone at `--test-concurrency=1` with `node_modules/.bin` on `PATH`: **68/68 pass, 0 fail**, at
load 40. They are c=8 contention flakes, not inherited breakage — no introducing commit to name.

The precondition is therefore satisfied **with this caveat recorded**, not claimed clean. If a worker
sees either test red, that is the known flake and not this bundle's doing.

## Interface Contracts

`install.sh` is a shell entry point, not a typed module. Its contract is stated in terms of
filesystem effects, which is what this bundle changes.

**Inputs**
- `--prefix <dir>` — deploy destination. Absent → `$HOME/.claude/pickle-rick`.
- `--no-confirm` — suppress interactive confirmation.
- `PICKLE_INSTALL_ROOT` (env) — **not** an input to `install.sh`; `install.sh:33` overwrites it
  unconditionally. It is an input to the deployed runtime hook path only. WS-C2 corrects the docs.

**Outputs**
- Deploy tree at the resolved prefix: `<prefix>/extension/**`, `<prefix>/../commands/*.md`,
  `<prefix>/pickle_settings.json`, `<prefix>/persona.md`.
- Exit 0 on success; non-zero with a diagnostic on failure.

**Errors**
- Compile failure → non-zero exit, source tree left in a loadable state (this is the property WS-B
  establishes; today a mid-compile failure leaves ~130 modules absent).
- Schema parity mismatch between `src/types/index.ts` and `types/index.js` → non-zero exit.

**Invariants** — the load-bearing ones for this bundle:
- **I1** — at every instant during and after `install.sh`, every compiled `.js` in the **source** tree
  that exists at `HEAD` is present and loadable. Currently violated for the duration of the recompile.
- **I2** — `install.sh` leaves the source tree byte-identical to `HEAD` for tracked files. `git status`
  clean before implies clean after.
- **I3** — `--prefix <dir>` confines all *destination* writes to `<dir>`. It does not, and after this
  bundle still will not, confine the *build*; the build is simply no longer destructive.
- **I4** — at every instant during and after `install.sh`, the deploy tree either fails the parity
  probe or is loadable. It is never both parity-passing and unloadable. Currently violated in the
  window between the rsync and the symlink recreation.

## Test Expectations

| Criterion | Test file | Description | Assertion |
|:---|:---|:---|:---|
| AC-A1/A2 | `extension/tests/integration/.serial-tests.json` + `.reasons.json` | Manifest entry and its reason | Both contain `tests/integration/install-excludes-working-dir-state.test.js` |
| AC-A3 | `extension/tests/serial-tests-reasons-coverage.test.js` (existing) | 1:1 manifest↔reasons invariant | Passes unmodified |
| AC-A4/A5 | none — tier run | Parallel sub-tier alone at c=4 | 0 `ERR_MODULE_NOT_FOUND`, 0 `MODULE_NOT_FOUND`, only `INV-CODEX-RECOVERY-ADVANCED` fails |
| AC-B1 | `install.sh` | rm-loop deleted, `.tsbuildinfo` removal kept | `install.sh` contains no `rm -f "$jsfile"`; retains `rm -f "$SCRIPT_DIR/extension/.tsbuildinfo"` |
| AC-B2 | new, `extension/tests/integration/install-stale-cache-rebuild.test.js` | Stale compiled artifact + stale `.tsbuildinfo`, then `install.sh --prefix <tmp>` | Compiled JS matches current source; **fails if `.tsbuildinfo` removal is also dropped** |
| AC-B3 | new, `extension/tests/integration/install-source-tree-stays-loadable.test.js` | Poll `extension/types/index.js` on a tight interval while `install.sh --prefix <tmp>` runs | File never observed missing (invariant I1). **Must fail against `45cda0bd`** |
| AC-B4 | `extension/tests/integration/install-stale-cache-rebuild.test.js` | Clean and stale starting states | Exit 0; deploy-tree compiled JS byte-identical to source |
| AC-B5 | `extension/tests/integration/install-source-tree-stays-loadable.test.js` | `git status --porcelain` before/after | Identical output (invariant I2) |
| AC-C1 | `install.sh` | Interrupt-safe ordering or staging | Stated in the ticket with a reason for the choice |
| AC-C2 | new, `extension/tests/integration/install-parity-requires-node-modules.test.js` | Deploy tree with `node_modules` symlinks removed | Parity probe does **not** pass (invariant I4) |
| AC-C3/C4 | `extension/CLAUDE.md` | `PICKLE_INSTALL_ROOT` row corrected | `grep -rn 'PICKLE_INSTALL_ROOT' extension/CLAUDE.md CLAUDE.md README.md` yields no claim that the env var overrides the `install.sh` prefix |

Note on AC-B3: a test that passes against the pre-fix `install.sh` is not testing the bug. The ticket
must demonstrate it red on `45cda0bd` before it counts as satisfied.

## Simplification Review

---

## WS-A — Serialize the install test that recompiles the repo (P0)

`install-excludes-working-dir-state.test.js` must run in the serial sub-tier, like every other test
that invokes `install.sh`.

`extension/tests/serial-tests-reasons-coverage.test.js` enforces a 1:1 correspondence between
`.serial-tests.json` entries and `.serial-tests.reasons.json` keys, so both files change together.

### Acceptance criteria

- **AC-A1** — `extension/tests/integration/.serial-tests.json` `entries` contains
  `tests/integration/install-excludes-working-dir-state.test.js`.
- **AC-A2** — `extension/tests/integration/.serial-tests.reasons.json` `reasons` has a key for that
  exact path, whose value names `install.sh`'s repo-wide recompile as the reason.
- **AC-A3** — `node --test tests/serial-tests-reasons-coverage.test.js` passes (1:1 invariant holds).
- **AC-A4** — the integration **parallel** sub-tier, run alone at `--test-concurrency=4`, reports
  **zero** occurrences of `ERR_MODULE_NOT_FOUND` and **zero** of `MODULE_NOT_FOUND`. Command:
  `node bin/test-runner.js --tier integration --manifest tests/integration/.serial-tests.json --manifest-mode exclude --test-concurrency=4`
- **AC-A5** — that same run's only remaining failure is `INV-CODEX-RECOVERY-ADVANCED`. Any other
  failure is in scope for diagnosis, not for suppression.

---

## WS-B — Delete the redundant force-clean loop (P1, pure subtraction)

The `rm -f "$jsfile"` loop deletes only `.js` files that **have** a corresponding `.ts` source. It
therefore removes no orphaned `.js` — a `.js` whose `.ts` was deleted is not matched by the `find` that
drives the loop, so it survives. The loop's only remaining effect is to force a full recompile.

`rm -f "$SCRIPT_DIR/extension/.tsbuildinfo"` on the next line already forces a full recompile. The loop
is redundant with the line immediately following it, and it is the sole cause of the destructive
window: `tsc` overwrites its outputs in place, so without the loop no compiled module is ever absent
for a measurable interval.

The stated purpose (`R-ITS-1: prevents stale-tsc-cache drift`) is satisfied by the `.tsbuildinfo`
removal alone.

### Acceptance criteria

- **AC-B1** — the `while IFS= read -r tsfile; do … done < <(find …)` loop at `install.sh:345-350` is
  deleted. `rm -f "$SCRIPT_DIR/extension/.tsbuildinfo"` is retained.
- **AC-B2** — a test asserts the stale-cache property the loop existed for: with a deliberately stale
  compiled artifact and a stale `.tsbuildinfo` in place, `install.sh --prefix <tmp>` produces compiled
  JS matching current source. This must fail if `.tsbuildinfo` removal is also dropped.
- **AC-B3** — a test asserts the absence property directly: while `install.sh --prefix <tmp>` runs, a
  concurrent poll of `extension/types/index.js` never observes the file missing. This is the test that
  would have caught the bug, so it must fail against `install.sh` as of `45cda0bd`.
- **AC-B4** — `bash install.sh --prefix <tmp> --no-confirm` exits 0 and the deployed tree's compiled JS
  is byte-identical to the source tree's, on both a clean and a stale starting state.
- **AC-B5** — `git status` is clean after `install.sh` runs, i.e. the install does not modify tracked
  compiled JS relative to `HEAD`.

### Deliberately NOT in scope

Removing any existing entry from `.serial-tests.json`. The five other install tests are serialized for
overlapping reasons — `install.sh` also runs `npm install` in `extension/` (`install.sh:342`) and
writes a `tsc` symlink into the repo-root `node_modules/.bin` (`install.sh:565`), both shared mutable
state. WS-B removes one hazard, not all of them; de-serializing anything requires separately proving
the others are gone.

---

## WS-C — Deploy atomicity and one false doc claim (P2)

**C1 — non-atomic deploy.** `install.sh` rsyncs with `--delete --delete-excluded` (which removes
`node_modules` from the destination) and only afterwards recreates the runtime-dep symlinks
(`install.sh:462-472`). An interrupt between the two leaves a deploy tree that looks installed but
cannot load, and the MD5 parity probe passes over the empty `node_modules`.

**C2 — false documentation.** `extension/CLAUDE.md` documents `PICKLE_INSTALL_ROOT` as a
"Deploy-prefix override for `install.sh`". `install.sh:33` is
`PICKLE_INSTALL_ROOT="${PREFIX:-$HOME/.claude/pickle-rick}"` — an unconditional assignment that
discards any inherited value. Only `--prefix` sandboxes `install.sh`. The variable is real for the
runtime hook path, which is what the row should say. This has cost real debugging time: a run believed
to be sandboxed deployed to `$HOME` and exited 0, leaving the live tree with an empty `node_modules`.

### Acceptance criteria

- **AC-C1** — the symlink recreation happens such that no interrupt point leaves a deploy tree that is
  both parity-passing and unloadable. Staging-then-rename, or ordering the symlink creation before the
  parity probe, both satisfy this; the ticket picks one and states why.
- **AC-C2** — a test asserts that a deploy tree missing its `node_modules` symlinks does **not** pass
  the parity probe.
- **AC-C3** — the `extension/CLAUDE.md` `PICKLE_INSTALL_ROOT` row states that `install.sh` honours
  `--prefix` only, and that the environment variable governs the runtime hook path. No claim that the
  env var overrides the `install.sh` prefix survives in any doc.
- **AC-C4** — `grep -rn 'PICKLE_INSTALL_ROOT' extension/CLAUDE.md CLAUDE.md README.md` shows no
  surviving statement contradicting `install.sh:33`.

---

## Simplification Review

### WS-A

1. **Necessary?** Adds two JSON entries. No code, no flag, no state field. Necessary only until WS-B
   lands; it is the cheap unblock that makes the tier measurable today.
2. **Reuse instead of add?** Reuses the existing `.serial-tests.json` mechanism exactly as the five
   sibling install tests already do. No parallel mechanism introduced.
3. **Guards existing brittle complexity?** No. It corrects an omission in an existing manifest — the
   test was added without the manifest entry its five siblings all carry.
4. **Subtract?** No subtraction available. WS-A is a one-line-per-file correction; the subtraction
   lives in WS-B.

### WS-B

1. **Necessary?** Adds nothing. Pure removal of six lines.
2. **Reuse instead of add?** Not applicable — the reuse *is* the point: `.tsbuildinfo` removal, already
   present on the following line, does the whole job.
3. **Guards existing brittle complexity?** It **removes** the brittle thing rather than guarding it.
   The tempting wrong fix here is to add a lockfile or a mutex around `install.sh` so concurrent tests
   serialize themselves — that would be new machinery wrapped around a redundant loop. Delete the loop
   instead.
4. **Subtract?** Six lines of `install.sh`, and with them an entire class of cross-test contamination.
   Note what is *not* claimed: the serial manifest does not shrink, because other shared-state hazards
   in `install.sh` remain (see WS-B "Deliberately NOT in scope").

### WS-C

1. **Necessary?** C1 changes ordering or introduces a staging step — that is the one genuine addition
   in this bundle, and it is small. C2 adds nothing; it deletes a false sentence.
2. **Reuse instead of add?** C1 should prefer reordering the existing steps over introducing a staging
   directory. A staging dir is only justified if reordering cannot close the window; the ticket must
   say which and why.
3. **Guards existing brittle complexity?** No. C1 closes a real interrupt window; C2 removes
   documentation that actively misleads.
4. **Subtract?** C2 subtracts a false claim that has already cost debugging time. C1's subtraction is a
   failure mode, not a line count.

---

## Verification ticket

A final ticket must **run the claim**, not merely assert the diff:

1. Run the integration parallel sub-tier alone at `--test-concurrency=4`. Record tests / pass / fail
   from its own `ℹ` summary lines, plus the count of `ERR_MODULE_NOT_FOUND` and `MODULE_NOT_FOUND`.
2. Run the integration serial sub-tier alone at `--test-concurrency=1`. Record the same.
3. Report both sub-tiers separately. `npm run test:integration` chains parallel `&&` serial, so a red
   parallel half means the serial half never runs — do not use the chained script for this evidence.
4. Name the three audit preflights explicitly (`audit-test-tiers.sh`, `audit-test-isolation.sh`,
   `audit-subprocess-heavy-tests.sh`); npm binds `pre` hooks to literal script names and there is no
   `pretest:integration:parallel`.
5. Record the box's `uptime` and `tmutil status` alongside the numbers. A tier result without its load
   context is not evidence.

Baseline to beat, measured on `45cda0bd`: parallel 341 tests / 87 fail (86 collateral, 1 real);
serial 591/591 pass.
