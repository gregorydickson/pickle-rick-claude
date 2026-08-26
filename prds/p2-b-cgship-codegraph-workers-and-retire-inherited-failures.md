> **✅ SHIPPED 2026-08-25 as v2.1.0-beta.17 — CLOSED (7 of 8 ACs; AC-B4 operator-deferred).**
> Pipeline ran 4/4 phases in 672m32s, 30 commits, session `2026-08-25-c8595785`.
>
> **AC-B5 SATISFIED — the inherited-failure carve-out is RETIRED, measured.** For the first time the
> release gate is green with **zero waived failures**: fast 8109 `fail 0`, integration parallel 662 +
> serial 623 `fail 0`, expensive 22 `fail 0`, deploy-lifecycle soak measured 1803s `pass 1 skipped 0`.
>
> **Retiring the carve-out RESTORED A GATE THAT HAD SILENTLY STOPPED WORKING.** `test:fast:budget` now
> reads `OK failures=0 runs_completed=5 runs_requested=5`, against beta.16's `FAIL_BUDGET_EXCEEDED
> failures=3 runs_completed=3` — it could not finish its own five-run plan because the inherited bun
> probe failed deterministically every run. A flake budget cannot detect flakiness while a
> 100%-reproducible failure sits on the tree.
>
> **AC-1 verified END TO END on a real deploy**, not only in tests: the installer logged
> `MANAGED_KEYS forced codegraph.expose_mcp_to_workers: false -> true` and the deployed settings now
> read `true`. The FEAT's whole premise was that a source-only flip stays inert; that is now closed.
>
> **AC-B4 (macOS notification delivery) was NOT built** — pickle hit its iteration cap with 1/8 tickets
> pending and the runtime correctly reported the phase incomplete and advanced rather than halting.
> Operator ruled it deferred, not high priority. It is a known accepted gap, not a silent drop.
>
> **Phase profile, reported rather than smoothed:** pickle incomplete (7/8), citadel exhausted its
> 3-cycle remediation cap with 2 findings open, anatomy-park **CONVERGED**, szechuan
> `stalled_below_target`.

# B-CGSHIP — turn on codegraph for workers, and retire the inherited-failure carve-out that would hide it

**Priority:** P2 (capability) + P1/P2/P3 fixes riding the same surface
**Type:** bundle (feature + fixes) — first bundle composed under the 2026-08-24 BUNDLE SIZING directive
**Branch:** `release/v2.1-beta`
**build_mode:** unattended. A running pipeline executes DEPLOYED JS; the source diff lands only at deploy time.
**Composes:** `FEAT-2026-08-16-expose-codegraph-mcp-to-workers.md`,
`BUG-2026-08-21-bun-probe-path-filter-misses-homebrew.md`,
`BUG-2026-08-21-extension-wiring-asserts-a-deleted-path.md`,
`BUG-2026-08-22-fixture-leak-producers-processes-and-directories.md`,
`BUG-2026-08-23-mac-notifications-never-arrive.md`

## Why these five travel together

Composed by **shared surface**, per the BUNDLE SIZING rules — not by priority tier. Four of the five
touch the installer or the worker-spawn path that the codegraph flip already edits, so they ride the
same ~300-minute ANATOMY-PARK + SZECHUAN review for free.

| item | surface | rides on |
|---|---|---|
| codegraph MCP exposure (FEAT) | installer MANAGED_KEYS, `services/backend-spawn.ts`, `bin/spawn-morty.ts` | — (the feature) |
| bun-probe PATH filter | installer | same file as MANAGED_KEYS edit |
| extension-wiring deleted path | installer + `tests/integration/` deploy smoke | same file |
| fixture-leak producers | `services/judge-spawn-env.ts` + installer | same subsystem |
| mac notifications | `services/pickle-utils.ts` | `extension` subsystem, operator-sequenced after codegraph |

## 🎯 The load-bearing reason: the FEATURE CANNOT VERIFY ITSELF TODAY

`FEAT-2026-08-16` **AC-7** requires `npm run test:fast` to report **`fail 0` AND `cancelled 0`**.

**`fail 0` is unsatisfiable on the darwin host right now.** `install-bun-probe.test.js` fails
deterministically (re-verified 2026-08-24: `fail 1`, leaf `bun probe emits banner when bun is absent`)
because bun IS installed at `/opt/homebrew/bin` and the probe's substring PATH filter cannot see it.

So shipping the feature alone forces one of two bad outcomes: waive AC-7 (the feature ships unverified),
or satisfy it against a standing exception (the feature ships fake-green). **Fixing the bun probe in the
same bundle is what makes the feature's own acceptance criterion achievable.** That is a hard
dependency, not an efficiency argument.

## The inherited-failure carve-out is a permanent fake-green surface

Every release currently ships under *"2 inherited failures, ignore them."* That is a standing permission
to read red as green, renewed each release, which no gate can distinguish from a real regression —
`post_final_tier_degraded:red` already cannot discriminate inherited-red from bundle-red on this host.

Both re-verified failing 2026-08-24:

| failure | suite | measured |
|---|---|---|
| `install-bun-probe` (P3) | `extension/tests/install-bun-probe.test.js` | `fail 1` |
| `extension-wiring` deploy smoke (P2) | `extension/tests/integration/extension-wiring.test.js` | `fail 1` — missing deployed path `~/.claude/agents/morty-gate-remediator.md` |

**Retiring both makes the next gate read unambiguous: any failure is real.**

## ⚠️ Corrections to the composed PRDs — apply these, do NOT inherit them verbatim

1. **`FEAT` AC-7 test-count floor is STALE.** It says *"must not shrink below 7720"*, measured at
   `770dfe8a`. The tier is at **7984 pass** as of 2026-08-24. Re-floor to the count measured at this
   bundle's own baseline, read from the runner's summary block.
2. **`FEAT` AC-7's `fail 0` is only satisfiable IF the bun-probe ticket lands first.** Order the tickets
   so the probe fix precedes the AC-7 verification, or AC-7 measures a tree it cannot pass.
3. **`FEAT` says "Measured at `770dfe8a` (fast tier green: fail 0)".** That baseline claim does not
   reproduce on this host and must not be reused as evidence.
4. **The installer MANAGED_KEYS comment says "These 3 keys" but FOUR are forced** (`worker_test_gate_timeout_ms`,
   `codegraph.enabled`, `codegraph.index_at_setup`, `auto_update_enabled`). Doc drift on the exact block
   this bundle edits — fix while there.
5. **`extension-wiring.test.js` lives in `tests/integration/`, NOT `tests/`.** A run against the wrong
   path exits 1 with a 48-byte `Could not find` log, which reads as a failure and is not one.

## Live evidence captured at composition time (2026-08-24)

- `codegraph.expose_mcp_to_workers` is **`false`** in BOTH source and deployed `pickle_settings.json`.
- The tmpdir leak is **live**: **1090** `pickle-*` directories in `TMPDIR` at composition time.
- `displayMacNotification` exists (`services/pickle-utils.ts:2877`) and shells out via
  `spawnSyncFn('osascript', ...)` at `:2896` — the mechanism the notification PRD names is present, so
  that PRD's premise holds.

## ✅ BOTH MANDATORY PRE-LAUNCH CHECKS PASSED — measured 2026-08-25 at HEAD `0641a311`

**(a) STALE PREMISE: PASSED.** Every composed mechanism verified live in BOTH source and deployed:

| mechanism | measured |
|---|---|
| `codegraph.expose_mcp_to_workers` | **`false`** in source AND deployed `pickle_settings.json` |
| `buildWorkerMcpConfig` | present: 3 refs in `src/services/backend-spawn.ts`, 2 in deployed `services/backend-spawn.js` |
| the inert-flip mechanism | `expose_mcp_to_workers` appears **0 times** in the installer — not in MANAGED_KEYS, so a source-only flip stays inert |
| `displayMacNotification` | present in `src/services/pickle-utils.ts` |
| tmpdir leak | **1130** `pickle-*` dirs in TMPDIR (was 1090 on 2026-08-24 — still growing) |
| `install-bun-probe` | `fail 1` in the v2.1.0-beta.16 release gate, leaf `bun probe emits banner when bun is absent` |
| `extension-wiring` deploy smoke | `fail 1` in the same gate, leaf `deploy smoke: gate bins and data exist after install` |

**(b) GREEN TREE: PASSED, baseline recorded.** From the beta.16 release gate, interpreter pinned to
node 24.19.0:

| tier | tests | pass | fail | cancelled |
|---|---|---|---|---|
| fast | 8032 | 8025 | **1** (inherited P3) | 0 |
| integration parallel | 662 | 661 | **1** (inherited P2) | 0 |
| integration serial | 615 | 615 | 0 | 0 |
| expensive parallel | 14 | 13 | 0 | 0 |
| deploy-lifecycle soak | 1 | 1 | 0 | 0 (measured 1803s) |

**Exactly two failures, both inherited, both matched BY LEAF NAME.** Any OTHER failure during this
bundle is caused by this bundle.

### ⚠️ New evidence strengthening AC-B5: the carve-out now poisons a SECOND gate

`npm run test:fast:budget` returned **`FAIL_BUDGET_EXCEEDED failures=3 budget=2`** — not from flakiness
but because the inherited bun probe fails **deterministically**: three runs, byte-identical
`8032/8025/fail 1`, same named leaf, zero variance. A flake budget cannot render a verdict while a
100%-reproducible inherited failure sits on the tree. So the standing exemption is not merely a place
where a regression could hide — it has **disarmed the flake-detection gate outright**.

### Reporting note carried from beta.16

Two fake-greens were caught in the babysitter's own gate read, both of which would have shipped a false
verdict: the chained `test:integration` short-circuits, so a parallel red leaves the **615 serial tests
unmeasured**; and `test:expensive:serial` returns `rc=0 fail 0` in 18 seconds when the deploy-lifecycle
soak **skips itself** (it refuses to mutate `$HOME`). Run the integration halves separately, and run the
soak with `PICKLE_INSTALL_ROOT` set to a non-`$HOME` path.

## Acceptance criteria

Lift AC-1 … AC-8 from `FEAT-2026-08-16` **as corrected above**, plus:

- **AC-B1** `install-bun-probe.test.js` passes on a host where bun IS installed at `/opt/homebrew/bin`.
  The fix resolves the binary rather than substring-matching PATH. Pin with a test that fails on the
  substring approach.
- **AC-B2** The `extension-wiring` deploy smoke passes after a deploy. Whatever path the assertion names
  must either be deployed by the installer or be dropped from the assertion — a test that the installer
  guarantees to break is not a test.
- **AC-B3** The tmpdir/process leak producers are fixed; a full fast tier adds no net `pickle-*` TMPDIR
  directories beyond a stated bound. Reuse the 3-cycle refinement already in the composed PRD; the reaper
  half (`04df0897`) is OUT of scope and pinned only.
- **AC-B4** A macOS notification is actually delivered, evidenced by something other than the absence of
  an error. `spawnSyncFn` returning without throwing is NOT evidence of delivery.
- **AC-B5 — the carve-out is retired.** After this bundle, the release gate has **zero** standing
  inherited-failure exceptions. Any fast/integration failure is attributable.
- **AC-B6 (report-only, non-gating)** No new `exit_reason`, no new abort condition, no new halt path
  (PRIME DIRECTIVE). Degradation stays loud-and-continue.

## Sizing

**7 tickets** (feature decomposes to ~3; four fix tickets). Within the proven envelope — both recorded
8-ticket bundles converged. Watch `iteration`, not roster size: the 8-ticket run that needed a resume hit
**12 iterations**.

## Non-goals

- Rewriting `buildWorkerMcpConfig` — the plumbing is built and verified; this is a flip plus verification.
- The reaper half of R-ORCG (already fixed).
- `BUG-2026-08-10-install-sh-destroys-its-own-source-tree` — also installer-surfaced, but large
  (33 references) and destructive. Do NOT fold it into a bundle carrying a feature; queue it separately.

## Simplification Review

1. **Necessary?** Four of five are defects; the fifth is a flag flip whose plumbing already exists.
2. **Reuse?** Yes — MANAGED_KEYS force already exists for three sibling keys; the feature copies that
   pattern rather than inventing one.
3. **Guards brittle complexity?** It REMOVES a standing gate exception rather than adding a guard.
4. **Subtracts?** Two permanent inherited failures, one silent-degradation path, and 1090 leaked dirs.
