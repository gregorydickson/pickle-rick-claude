# BUG — install.sh destroys the source tree it builds from (REFINED)

**Status:** ready to decompose
**Branch:** `release/v2.1-beta`
**Launch commit:** `7987e121` (PRD baseline `45cda0bd` for red-proofs)
**Build mode:** unattended
**Scope:** `paths:install.sh,extension/tests/**,CLAUDE.md`

*(refined: requirements / codebase / risk-scope analysts, 3 cycles, 2026-08-10 — `REFINE_EXIT=0`)*

---

## Problem

`install.sh:345-350` deletes every compiled `.js` under `extension/` that has a `.ts` twin, then
`:353` recompiles — always in `$SCRIPT_DIR/extension`, the real repository, regardless of `--prefix`.
`--prefix` sandboxes the rsync *destination*, never the *build*. For the 10-30 s of that recompile
**156** modules (`git ls-files`-verified count; the original PRD said "roughly 130") are absent.

`tests/integration/install-excludes-working-dir-state.test.js` runs `install.sh` and is missing from
`.serial-tests.json`, unlike its five sibling install tests. Measured on `45cda0bd` at effective
`--test-concurrency=4`: parallel sub-tier 341 tests, 87 fail — **86 collateral**
(`ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`), **1 real** (`INV-CODEX-RECOVERY-ADVANCED`). Serial
sub-tier on the same box: **591/591**. Concurrency, not load.

---

## Bundle-wide preconditions (P0 — apply to EVERY test this bundle adds that invokes `install.sh`)

Three independent ways a test harness can forge this bundle's central evidence. All three must be
closed **before any other assertion**, or a broken harness satisfies "must fail against `45cda0bd`"
for the wrong reason.

- **AC-P0 — git mode.** Assert observed stderr contains `[install.sh] Mode: git` (emitted
  `install.sh:336`). `install.sh:331-335` selects `tarball` when `$SCRIPT_DIR/.git` is absent, and
  `:339` puts the ENTIRE compile block — `npm install`, the force-clean loop, `.tsbuildinfo` removal,
  `npx tsc`, the schemaVersion check — inside `if [ "$INSTALL_MODE" = "git" ]`. A harness that
  `rsync --exclude .git` / `git archive` / `tar`s the tree exercises nothing and "fails" for free.
  Note `-e` not `-d`: a plain `cp -r` keeps `.git` and stays in git mode; a `git worktree` also gets
  git mode by design.

- **AC-P1 — sandboxed data root.** Every invocation sets `PICKLE_DATA_ROOT=<tmp>`.
  `install.sh:293-302` REFUSES to run while an active session is in flight, and `find_active_session`
  (`:173-176`) scans the real sessions root. **During this bundle's own build a session is active by
  construction**, so without this every install-invoking test exits non-zero before reaching the
  compile block — indistinguishable from "the fix is broken", and it forges the red-proof.
  Precedent: `install-excludes-working-dir-state.test.js:84`, `install-script-real.test.js:35`.
  Use `PICKLE_DATA_ROOT`, **not** `--override-active` — sandbox the guard, don't suppress it.

- **AC-P2 — sandboxed telemetry.** Every invocation sets `EXTENSION_DIR=<prefix>` in the child env.
  `install.sh` contains **zero** `export` statements, so `PICKLE_INSTALL_ROOT` (`:33`) is shell-local
  and the child inherits nothing; the deployed `log-activity.js` resolves via `getExtensionRoot()` →
  `CANONICAL_EXTENSION_ROOT = ~/.claude/pickle-rick` (`pickle-utils.ts:226,329-334`). Without this the
  new tests append to the operator's real activity stream — reintroducing this bundle's own
  contamination class. Precedent: `install-script-prefix.test.js:98,111`.

- **AC-P3 — every invocation passes `--prefix <tmp> --no-confirm`.**

### Red-proof procedure (P0 — applies to AC-B3 and AC-C3)

**No `git checkout`, `git stash`, or `git restore` anywhere in this bundle.** Extract read-only.

- **AC-B3** — the test MUST accept the script under test via `INSTALL_SH_PATH` (default: repo
  `install.sh`). Red-proof: `git show 45cda0bd:install.sh > ./install.pre.sh && chmod +x ./install.pre.sh`.
  The copy MUST live **inside the repository** — `SCRIPT_DIR` derives from the script's own path, so a
  copy under `$TMP` has no `.git` beside it, runs in tarball mode, and proves nothing (AC-P0). Delete
  it in a `finally` so I2 holds; add it to no tracked file.
- **AC-C3** — the test MUST accept its enumeration source via `DOC_SCAN_REF` (default: working tree
  via `git ls-files '*.md'`; when set, `git ls-tree -r --name-only <ref> -- '*.md'` + `git show <ref>:<path>`).
  Red-proof: `DOC_SCAN_REF=7987e121`. A script-path swap cannot red-proof AC-C3.

**A test not observed red against its pre-fix source does not satisfy its AC.**

---

## Interface Contracts

**Inputs** — `--prefix <dir>` (deploy destination; absent → `$HOME/.claude/pickle-rick`),
`--no-confirm`. `PICKLE_INSTALL_ROOT` is **not** an input: `install.sh:33` overwrites it
unconditionally. It governs the deployed runtime's path resolution only.

**Outputs** — deploy tree at the resolved prefix; exit 0 on success, non-zero with a diagnostic
otherwise.

**Errors** — (a) compile failure → non-zero exit, source tree left present (AC-B7); (b) schemaVersion
parity mismatch → non-zero exit.

**Invariants**

- **I1 (scoped)** — at every instant during and after `install.sh`, every compiled `.js` in the
  **source** tree that exists at `HEAD` is **present on disk**. Byte-level emit atomicity is **out of
  scope, recorded as a residual**: the vendored compiler writes via `openSync(path,"w")` + one
  `writeSync` (`extension/node_modules/typescript/lib/typescript.js:8550-8563`) — `O_TRUNC`, no
  temp-then-rename — so each output is briefly zero-length. Today's violation is 10-30 s of
  **absence** across 156 modules; after WS-B it is a per-file sub-millisecond truncation.
- **I2** — `install.sh` leaves tracked compiled JS byte-identical to `HEAD`.
- **I3** — `--prefix` confines destination writes. It does not confine the build; after this bundle
  the build is simply no longer destructive.
- **I4** — *(deferred with WS-C2; see Residuals)*

---

## WS-A — Serialize the install test that recompiles the repo (P0, tier `small`)

**Scope is complete and closed.** Every `tests/**/*.test.js` mentioning `install.sh` was enumerated
and cross-checked against the 62-entry manifest: of 8 unserialized hits, only
`install-excludes-working-dir-state.test.js` actually executes it.
`deploy-lifecycle-soak.test.js` is `// @tier: expensive` (never runs in the integration tier);
`extension-wiring`, `lockdown-end-to-end`, `audit-closer-template-compliance`, `loa-618-replay`,
`pkgjson-fix`, `config-protection-git-boundary` reference it as a path string or prose only.
**Adding further manifest entries is out of scope.**

- **AC-A1** — `.serial-tests.json` `entries` contains
  `tests/integration/install-excludes-working-dir-state.test.js`.
- **AC-A2 (corrected)** — the `.serial-tests.reasons.json` value for that path is the literal
  **`"real-repo-isolation"`**, a class string from the five-member `ALLOWED_CLASSES` enum at
  `serial-tests-reasons-coverage.test.js:45-51`, matching all five sibling install entries. **Prose
  fails AC-A3** — the original PRD's "value names install.sh's repo-wide recompile" made AC-A2 and
  AC-A3 mutually exclusive and WS-A unsatisfiable. Rationale prose belongs in the ticket body.
- **AC-A3** — evidence is the **explicit single-file run**, pasted into the ticket artifact:
  `cd extension && PATH="$PWD/node_modules/.bin:$PATH" node --test tests/serial-tests-reasons-coverage.test.js`.
  A bare `node --test` on one file drops `node_modules/.bin` from `PATH` and fabricates failures. A
  green worker gate is **not** evidence: that oracle is `// @tier: integration`, which no worker phase
  runs, and it sits in the very parallel set this bug destroys.
- **AC-A4** — parallel sub-tier alone, `ERR_MODULE_NOT_FOUND` count == 0 and `MODULE_NOT_FOUND`
  count == 0, reported for BOTH:
  (a) effective `--test-concurrency=4` (the baseline's configuration), and
  (b) the literal `npm run test:integration:parallel`, which passes **no** `--test-concurrency` and
  therefore runs at `availableParallelism()` — **hotter than the AC measures**, and contention-shaped
  collateral scales with concurrency. A green (a) alone is not evidence the release gate is green.
- **AC-A5 — disposition (binding).** Any remaining failure other than `INV-CODEX-RECOVERY-ADVANCED`
  is **diagnosed and named as a residual** in the ticket artifact. The ticket neither suppresses it
  (fake-green) nor halts (takes reliability and quality to zero). If any such failure exists, the
  verification ticket **withholds its success verdict while completing every step.**

---

## WS-B — Delete the redundant force-clean loop (P1, tier `medium`, pure subtraction)

The `rm -f "$jsfile"` loop deletes only `.js` files that **have** a `.ts` twin, so it removes no
orphans. Its only effect is forcing a full recompile — which `rm -f .tsbuildinfo` on the next line
already does.

**Strengthened by the codebase analyst:** `tsconfig.json` excludes `src/**/*.test.ts`; all 156
non-`.d.ts` `.ts` files under `src/` have a `.js` twin, so deleting the loop strands nothing today.
But the loop's `find` filters only `! -name "*.d.ts"` and does **not** honour that exclusion — a
future `src/foo.test.ts` makes the loop `rm -f extension/foo.js`, a file `tsc` is configured never to
emit. The six lines are **redundant today and destructive the moment a `src/**/*.test.ts` lands.**
State the enumeration command and result in the ticket so a worker does not re-add the loop as a
safety net.

- **AC-B1 — MANDATORY CO-SCOPE.** Delete the loop at `install.sh:345-350`; retain
  `rm -f "$SCRIPT_DIR/extension/.tsbuildinfo"`. **`extension/tests/install-script.test.js` MUST be in
  this ticket's allowlist.** `AC-ITS-01` at `:1420-1455` (`// @tier: fast`) asserts the loop *exists* —
  `src.includes('Force-cleaning compiled JS')` (`:1424`), the `find` regex (`:1433`),
  `/rm -f "\$jsfile"/` (`:1438`), and ordering `forceClean < tsbuildinfoRm < tsc` (`:1452-1454`).
  Omit the file and the per-file fence blocks the required edit → **zero-commit deadlock**. Tier
  `small` would skip `test:fast` and ship Done over a red tier. Rewriting `AC-ITS-01` trips no
  trap-door audit (`audit-trap-door-enforcement.sh` pins only `R-CNAR-7` / `R-PDT-4`).
- **AC-B2** — with a stale compiled artifact AND a stale `.tsbuildinfo`, `install.sh` produces
  compiled JS matching current source. **Must fail if `.tsbuildinfo` removal is also dropped.**
  File: `extension/tests/integration/install-stale-cache-rebuild.test.js`.
- **AC-B3 (load-bearing discriminator)** — while `install.sh` runs, a concurrent poll of
  `extension/types/index.js` at ≤10 ms intervals never observes `fs.existsSync() === false`. The test
  **additionally records** the observed minimum file size and sample count in the ticket artifact **as
  data, with no assertion on either** — a recorded number cannot flake and cannot be fake-green, and it
  evidences the truncation residual. The test asserts a **minimum sample count overlapping the
  subprocess lifetime**, so a run sampling zero times inside the compile window cannot pass vacuously.
  Assertion is **presence-only**; a size assertion goes intermittently red for a cause WS-B cannot fix,
  and a false red on the discriminator is worse than a named residual.
  File: `extension/tests/integration/install-source-tree-stays-loadable.test.js`.
- **AC-B4** — deploy-tree compiled JS byte-identical to source, on clean and stale starting states.
  **Domain must be one of two named sets, do not invent a third:** the probe's 8-file list
  (`install.sh:410-419`) or the 156-file `.js`-with-a-`.ts`-twin set. A whole-tree diff fails for
  unrelated reasons (`--delete-excluded`, the separate `activity-events.schema.json` `cp` at `:400-403`,
  the `mux-runner.js → tmux-runner.js` symlink at `:562`, the deliberate `.tsbuildinfo` removal).
- **AC-B5** — `git status --porcelain` identical before/after, **scoped to `extension/**/*.js`**.
  `install.sh:342` runs `npm install`, which can rewrite tracked `extension/package-lock.json`.
  Unscoped, the likely worker response is a `git restore` — the catalogued work-destroying move.
- **AC-B6 — new-test hygiene, four parts, in the same ticket that creates each file.** For each of
  `install-stale-cache-rebuild.test.js` and `install-source-tree-stays-loadable.test.js`:
  (1) an entry in `.serial-tests.json`; (2) a `.serial-tests.reasons.json` value of
  `"real-repo-isolation"` (enum, not prose); (3) `// @tier: integration` as **line 1** — an entry whose
  file declares another tier is **silently ignored and keeps running at full concurrency**
  (`serial-tests-reasons-coverage.test.js:26-42`), this codebase's named fix-looks-applied-and-is-not
  failure mode; (4) AC-P0..P3 satisfied. Manifest paths are extension-root-relative and **not**
  directory-derived (`tests/install-script-real.test.js` is a `tests/`-resident entry in the
  `tests/integration/` manifest); `bin/test-runner.js:112-114,207-211` matches by exact normalized
  path — **a typo'd entry is silently a no-op with no error.**
- **AC-B7 — failure interface (I1 under failure).** With a deliberate TypeScript error injected into a
  scratch copy of one source file, `install.sh` exits non-zero and every tracked compiled `.js` whose
  `.ts` twin exists under `src/` is still present afterwards. Record the diagnostic verbatim. Today it
  surfaces as `❌ Could not extract schemaVersion from source or compiled types/index. Refusing to
  deploy.` (`:358`) — the check at `:353-360` greps `extension/types/index.js`, which the force-clean
  loop just deleted, so a *compile* failure is reported as a *schema-extraction* failure. **Whether the
  diagnostic is improved is out of scope**; the AC asserts non-zero exit + post-failure presence and
  records the message as evidence. This is the one documented output with zero coverage, on the exact
  failure path this bundle exists to fix.

### Deliberately NOT in scope
De-serializing any existing manifest entry. `install.sh` also runs `npm install` in `extension/`
(`:342`) and writes a `tsc` symlink into repo-root `node_modules/.bin` (`:565`) — both shared mutable
state. WS-B removes one hazard, not all three.

---

## WS-C1 — Symlink recreation before the parity probe (P2, tier `medium`)

`install.sh` rsyncs with `--delete --delete-excluded` (removing `node_modules` from the destination)
and only afterwards recreates the runtime-dep symlinks (`:462-472`), whose own comment says it exists
*because* `--delete-excluded` blew them away. The parity probe (`:405-460`) runs in between and
**executes the deploy tree** (`node "${EXTENSION_ROOT}/extension/bin/log-activity.js"`, `:438,447`),
so it depends on symlinks that do not yet exist.

- **AC-C1** — move the `# --- RUNTIME DEPS ---` block so the order is
  **rsync → RUNTIME DEPS → codegraph dep → parity probe**. Verified legal:
  `install-script.test.js:1329-1330` pins `rsyncIdx < codegraphIdx < jqMergeIdx`. **Do not hoist above
  the rsync.** The ticket states this ordering and why.
- **AC-C1 (co-scope, MANDATORY)** — `extension/tests/install-sh-parity-event-gate-payload.test.js`
  (`// @tier: fast`) pins "exactly 2 `install_sh_parity_check` emission sites" plus both `jq -nc`
  payload constructions by regex. Any reorder touching an emission breaks it. Omitting it from the
  allowlist is a zero-commit fence deadlock; `small` tiering hides the failure.

---

## WS-C3 — Documentation invariant (P2, folded into the WS-C ticket)

Keep this edit **inside the WS-C ticket**: a standalone doc-only ticket reddens doc-coupled tests on
its own, and an upward mis-tier runs red-main gates that can wipe the edit.

- **AC-C3** — **for every** tracked `*.md` file **excluding `prds/**`**, no statement claims that
  `PICKLE_INSTALL_ROOT` overrides the `install.sh` deploy prefix. Enumerated from
  `git ls-files '*.md'` at runtime — not a hardcoded list — so a future doc reintroducing the claim is
  caught without editing the test. **The `prds/**` exclusion is load-bearing: without it the invariant
  fails on the PRD that defines it.** Census at `HEAD`: 26 occurrences across 14 tracked `*.md`; 6
  outside `prds/**`; exactly **one** violates.
  File: `extension/tests/integration/install-root-doc-invariant.test.js`.
  **`describe.each` is `undefined` in `node:test`** — the literal belongs in the ticket manifest's
  `acceptance_test` field (where `spawn-refinement-team.ts:1383,1706-1713` requires it for a single
  parametrized ticket to survive the AC-shape gate) and **must not** appear in the test file.
- The one violating occurrence is `CLAUDE.md:149`. It must state that `install.sh` honours `--prefix`
  only and that the env var governs the deployed runtime's path resolution.
- **Must-not-touch (correct usage):** `README.md:531`,
  `docs/closer-ticket-manager-handoff.md:31`, `docs/FABLE_OPERATING_MANUAL.md:336` (all correctly
  instruct setting the env var off-`$HOME` for the expensive soak) and
  `extension/docs/gitattr-live-run-evidence.md:31,35` (captured terminal output). **A ticket that edits
  these has misread the invariant.**

---

## Verification ticket (tier `medium`)

- **AC-V0** — record `require('node:os').availableParallelism()` and the **effective**
  `--test-concurrency`. `bin/test-runner.js:11-28` clamps a requested value down to the core count and
  never raises it (`R-TCC-1`); the 341/87 baseline was measured at effective c=4 on a 24-core box. A
  run whose effective concurrency is < 4 does **not** satisfy AC-A4/AC-V1 and its numbers are not
  comparable to the baseline.
- **AC-V1** — parallel sub-tier alone at effective c=4: `ERR_MODULE_NOT_FOUND` == 0, `MODULE_NOT_FOUND` == 0.
- **AC-V2** — parallel total fail ≤ 1; any single failure is `INV-CODEX-RECOVERY-ADVANCED`. Anything
  else follows the AC-A5 disposition.
- **AC-V3** — serial sub-tier alone at c=1: 591/591, exit 0.
- **AC-V4 — WS-B discriminator (LOAD-BEARING).** AC-V1 proves **WS-A only**: after WS-A the offending
  test no longer runs in the parallel set, so a green tier is consistent with **WS-B never landing**.
  Report separately: `install-source-tree-stays-loadable.test.js` with
  `INSTALL_SH_PATH=./install.pre.sh` (extracted from `45cda0bd`) → **red**, with the observed absence
  window in ms; and against the fixed `install.sh` → **green**, with the observed minimum file size.
  **A green AC-V1 without both halves of AC-V4 is WS-A masking, not WS-B fixing, and must be reported
  as such.**
- **AC-V5** — both sub-tiers reported separately from their own `ℹ` summary lines, plus `uptime`,
  `tmutil status`, and the core count. A chained `npm run test:integration` does **not** satisfy
  AC-V1–V3 (a red parallel half means the serial half never ran). Name the three audits explicitly —
  npm binds `pre` hooks to literal script names and there is no `pretest:integration:parallel`.

---

## Residuals (recorded, not fixed)

1. **AC-C2 / I4 — parity-probe fail-opens, DEFERRED by operator decision 2026-08-10.** "A deploy tree
   missing its `node_modules` symlinks fails the parity probe" is untestable as worded: the probe is
   inline (`:409-460`) with no standalone entry point; running `install.sh` recreates the symlinks at
   `:462-472` right after it; and `:503-507` already aborts on an unloadable tree, so "non-zero exit"
   cannot distinguish the parity probe from the codegraph self-probe. Three independent fail-opens, all
   re-read at `HEAD`: the mode/skip guard (`:409`), the empty-MD5 condition (`:424` — a missing
   destination yields an empty MD5, which is not a mismatch; the 8-file `_parity_files` list at
   `:410-419` contains no `node_modules` path at all), and `2>/dev/null || true` on both emissions
   (`:438,447`). Needs its own PRD that picks one head.
2. **`tsc` emit truncation window** — per-file sub-millisecond zero-length outputs (`O_TRUNC`, no
   rename). Out of scope; AC-B3 records the observed minimum size as evidence that it is real and
   bounded.
3. **`install.sh:34`** — `EXTENSION_ROOT="${PICKLE_INSTALL_ROOT:-...}"` is a dead `:-` default; `:33`
   guarantees non-empty. Free subtraction if WS-C1 lands in that region. **Do not touch** the
   `${PICKLE_INSTALL_ROOT:-…}` literals at `:39,681,687,702,725` — deliberately-unexpanded hook strings.
4. **AC-C2 safety clause (carried forward to the follow-up PRD)** — deploy `node_modules` entries are
   symlinks into the live repo (`:462-472`). Removal must be by link path only (`fs.rmSync`/`unlink`,
   after asserting `lstatSync(p).isSymbolicLink()`). `cp -rL`, `find -L … -delete`, and `rsync` without
   `--no-links` reach into the real `extension/node_modules/typescript` and wedge every subsequent
   `npx tsc` and every gate.

---

## Simplification Review

**WS-A** — (1) two JSON entries, no code/flag/state. (2) Reuses `.serial-tests.json` exactly as five
siblings do. (3) Corrects an omission, guards nothing. (4) No subtraction; it lives in WS-B.

**WS-B** — (1) adds nothing; removes six lines. (2) The reuse *is* the point: `.tsbuildinfo` removal on
the following line does the whole job. (3) **Removes** the brittle thing rather than guarding it — the
tempting wrong fix is a lockfile or mutex around `install.sh` so concurrent tests self-serialize, i.e.
new machinery wrapped around a redundant loop. (4) Six lines that are redundant today **and destructive
the moment a `src/**/*.test.ts` lands**. Not claimed: the manifest does not shrink; other shared-state
hazards remain.

**WS-C** — (1) C1 reorders existing steps, adding nothing; C3 deletes a false sentence. (2) C1 is a
reorder, not a staging directory — reuse over addition, and the verified legal order is already pinned
by an existing test. (3) Neither guards brittle complexity; C1 closes a real interrupt window, C3
removes actively misleading documentation. (4) C3 subtracts a false claim that has already cost
debugging time — it sent this very PRD to the wrong file for three drafts. **Deferring C2 is itself the
subtraction**: it removes an unbounded three-headed design choice from a worker's plate.

## Implementation Task Breakdown

| Order | Title | Tier | Priority | Files |
|---|---|---|---|---|
| 10 | Serialize `install-excludes-working-dir-state.test.js` | small | High | `.serial-tests.json`, `.serial-tests.reasons.json` |
| 20 | Delete force-clean loop + rewrite `AC-ITS-01` | medium | High | `install.sh`, `extension/tests/install-script.test.js` |
| 30 | `install-source-tree-stays-loadable.test.js` (AC-B3, red-proofed) | medium | High | new test, both manifests |
| 40 | `install-stale-cache-rebuild.test.js` (AC-B2, AC-B4, AC-B5) | medium | High | new test, both manifests |
| 50 | `AC-B7` failure-interface test | medium | Medium | new test, both manifests |
| 60 | Reorder RUNTIME DEPS before parity probe + `CLAUDE.md:149` | medium | Medium | `install.sh`, `CLAUDE.md`, `install-sh-parity-event-gate-payload.test.js` |
| 70 | `install-root-doc-invariant.test.js` (AC-C3, red-proofed) | medium | Medium | new test, both manifests |
| 80 | Verification: AC-V0–V5 incl. WS-B discriminator | medium | High | none (measurement + artifact) |
