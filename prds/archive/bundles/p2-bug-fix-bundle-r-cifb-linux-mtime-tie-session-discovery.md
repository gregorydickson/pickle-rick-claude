---
title: "R-CIFB — Linux mtime-tie session-discovery + tmp-promotion non-determinism (remaining ~13 CI-only failures)"
finding: 115
priority: P2
status: open
schema_neutral: true
created: 2026-06-16
source_prd: "prds/archive/bundles/p2-bug-fix-bundle-r-cifb-c8-fast-tier-load-flake.md"
source_incident: "CI chronically RED; structural causes already SHIPPED — this PRD is ONLY the Linux-specific mtime-tie tail"
verification_loop: ".github/workflows/rcifb-debug.yml (workflow_dispatch, per-file Linux/node24 diagnosis)"
---

# R-CIFB — Linux mtime-tie session-discovery + tmp-promotion non-determinism

## Problem

The chronic CI red on `main` was multi-cause. Four structural causes are **already SHIPPED**
(deployed-extension dependency via `EXTENSION_DIR=github.workspace`; hermetic-env strip of
`EXTENSION_DIR`/`PICKLE_DATA_ROOT`/`PICKLE_DATA_DIR`; CI node 22→24; `fetch-depth:0`;
`addToJar` getDataRoot-redirect). Those took CI from ~84 failures to ~25 and are **out of scope**
here (see `prds/archive/bundles/p2-bug-fix-bundle-r-cifb-c8-fast-tier-load-flake.md`).

This PRD covers **only the remaining ~13 Linux-specific failures**. They pass on macOS
(node24 AND node25, even under CI-sim `EXTENSION_DIR=$repo TZ=UTC node --test` at c=8) and fail
**only on the CI ubuntu/node24 runner**. They are NOT node-version-specific and NOT
concurrency-specific — they are an **operating-system filesystem-semantics** class.

**CI-green is hygiene, NOT a release gate.** All prior betas shipped on the authoritative LOCAL
gate. This PRD closes the hygiene gap; it does not change any release-gating policy.

### Root cause — mtime-resolution ties (NOT pid detection)

The `rcifb-debug.yml` Linux env probe **disproved the pid hypothesis**:
`process.kill(99999999, 0)` throws `ESRCH` on Linux exactly as on macOS, so
`isProcessAlive` (`extension/src/services/state-manager.ts:190`) correctly returns `false` for a
dead pid on both platforms. The real defect is **recency decisions that rely on filesystem mtime
ordering** — reliable on macOS (fine-grained, slow sequential writes get DISTINCT `mtimeMs`) but
**tied on Linux** (coarse/fast writes to two files in the same loop get the SAME `mtimeMs`). When
mtimes tie, the tie-break is wrong.

There are two sites with the same class of defect:

**Site A — session ranking (`extension/src/services/pickle-utils.ts`):**
- `readSessionLookupState` (`:1619`) reads only `active`, `working_dir`, `started_at`,
  `state_mtime_ms` from the session `state.json`. **It does NOT read `pid`.**
- `getSessionRecencyMs` (`:1637`) returns `started_at` (ms) when present, else falls back to
  `state_mtime_ms`.
- `preferNewerSession` (`:1648`): when `candidate.recencyMs === best.recencyMs`, the tie-break is
  `candidate.sessionPath.localeCompare(best.sessionPath) > 0` — i.e. the **lexicographically
  greater path wins**.
- `selectScannedSessionPath` (`:1659`) collects EVERY `state.active === true` session as an
  `activeMatch` candidate. **It never checks pid liveness** — a dead-pid `active:true` session is
  treated as a full candidate.

**Worked example — `get-session.test.js:320` "getSessionPath: mapped dead-pid active session does
not outrank a live same-cwd session":** the test writes
`stale-session/state.json` = `{ active:true, pid:99999999, working_dir, session_dir:staleSessionDir }`
and `live-session/state.json` = `{ active:true, working_dir, session_dir:liveSessionDir }` (no pid),
then asserts `getSessionPath(cwd) === liveSessionDir`.
- On macOS the two writes get DISTINCT `mtimeMs`; whichever is intended-live wins by recency.
- On Linux both writes TIE on `mtimeMs` (neither has `started_at`, so `getSessionRecencyMs`
  falls to `state_mtime_ms`, which is equal). `preferNewerSession` then breaks the tie by
  `localeCompare`, and `"stale-session" > "live-session"` lexicographically → the **dead-pid stale
  session wins**. Deterministically wrong on Linux.

So the defect is two-fold and BOTH must be fixed: (1) `selectScannedSessionPath` does not demote a
dead-pid active session, and (2) the recency tie-break is mtime-fragile and falls back to a
lexical comparison that has nothing to do with true recency.

**Site B — `.tmp`-vs-base snapshot promotion (the orphan-tmp cluster):**
`readRecoverableJsonObject` (`extension/src/services/recoverable-json.ts`) and the parallel
`StateManager` recovery path (`state-manager.ts` `isStateSnapshotNewer` `:524`,
`recoverOrphanTmpFiles` `:926`/`:1001`) pick the winning `.tmp.<pid>` snapshot by `mtimeMs`:
- `recoverable-json.ts:91` (`parseDeadTmp`): a tmp is discarded when `mtimeMs <= baseMtimeMs`,
  and `:123` keeps the tmp with the strictly-greatest `mtimeMs`.
- `state-manager.ts:524` (`isStateSnapshotNewer`): when both snapshots have equal (or absent)
  `iteration`, the decision is `candidateMtimeMs > currentMtimeMs`.
On Linux a `.tmp.<pid>` interrupted-write snapshot written immediately after the base file can
**tie** the base's `mtimeMs`, so `mtimeMs <= baseMtimeMs` discards the valid recovery candidate (or
`>` fails to promote it). This is the same mtime-tie class one level down. The affected tests are
the orphan-tmp cluster: `status.test.js` (showStatus), `mux-runner.test.js`
(recovered-inactive-orphan-tmp), `check-readiness.test.js` (dead-writer-tmp),
`verify-recapture-fired.test.js` (orphan-tmp).

**Site C — separate (re-confirm, do NOT assume mtime-tie):** `services/convergence-gate-workspaces.test.js`
`runGate` ×3 runs REAL `npm`/`tsc` against fixture packages and asserts `result.status === 'green'`
(`:101`); on Linux it returns red. And the 5s-timeout output-match tests —
`bin/test-runner-tier-discovery.test.js:257` "runner times out wedged child" asserts child stdout
matches `/cancelled 1|tests 1/i` (`:291`), plus a `mux-runner` quality-gate-skip test. These are a
different class (fixture-command behavior / output-timing) and must be diagnosed independently via
`rcifb-debug.yml`.

---

## Tickets / fix areas

### WS-A — session-ranking dead-pid demotion + deterministic recency (`pickle-utils.ts`)

Two coupled defects in `selectScannedSessionPath` / `preferNewerSession` / `getSessionRecencyMs` /
`readSessionLookupState`.

**Import decision for `isProcessAlive` — IMPORT, do not inline.**
`isProcessAlive` is already `export`ed from `state-manager.ts:190`. A circular import edge
**already exists**: `state-manager.ts:27` imports `{ writeStateFile, safeErrorMessage, getDataRoot,
formatLocalDateKey }` from `./pickle-utils.js`, and `pickle-utils.ts:7` imports `{ StateManager }`
from `./state-manager.js`. Adding `isProcessAlive` to the existing
`pickle-utils → state-manager` import rides that already-present edge — it does NOT introduce a new
cycle. `isProcessAlive` is a pure leaf function (no module-load-time side effects, no `pickle-utils`
references), so ESM's lazy binding resolves it safely even within the existing cycle. Inlining a
private copy is REJECTED: it duplicates the dead-pid-detection contract that `state-manager.ts`,
`config-protection.ts`, and `resolve-state.ts` all depend on, and the `state.json` field-invariant
trap doors (`pickle-utils.ts (lookup recovery)`, `(mapped-session evidence)`) already assert
"session lookup reads use `StateManager.read()` so dead-pid active sessions demote" — a private
inline pid check would silently diverge from the shared definition.

- **AC-A1 (read pid):** `readSessionLookupState` (`pickle-utils.ts:1619`) MUST additionally read
  and return `pid` from the recovered session state (typed `pid?: unknown`, coerced to a finite
  integer downstream). Existing fields (`active`, `working_dir`, `started_at`, `state_mtime_ms`)
  unchanged. Machine-check: `readSessionLookupState` return object contains a `pid` key.
- **AC-A2 (demote dead-pid active):** in `selectScannedSessionPath` (`:1659`), a session with
  `state.active === true` AND a finite-integer `pid` AND `!isProcessAlive(pid)` MUST NOT be ranked
  as an `activeMatch`; it is demoted to the `inactiveMatch` lane (eligible only when
  `!requireActive`) — i.e. it never outranks a live or no-pid active session regardless of mtime.
  An `active:true` session with NO pid (or a non-finite pid) stays a live candidate (no pid =
  cannot prove dead). Machine-check: with the `get-session.test.js:320` fixture,
  `getSessionPath(cwd) === liveSessionDir` on BOTH macOS and Linux.
- **AC-A3 (deterministic recency tie-break):** `preferNewerSession` MUST NOT resolve a recency tie
  by `sessionPath.localeCompare` (lexical order is unrelated to true recency). Replace the tie-break
  so that when `candidate.recencyMs === best.recencyMs` the decision reflects real write-order, not
  path spelling. Chosen approach (see "Deterministic tie-break" below): **prefer the candidate whose
  state carries a parseable `started_at` over one that has none** (a stamped start time is stronger
  recency evidence than a coarse `mtimeMs`); when both or neither have `started_at` and `recencyMs`
  still ties, **keep the incumbent `best`** (stable, first-seen-wins on `sessionPaths` iteration
  order) rather than flipping on lexical comparison. The dead-pid demotion (AC-A2) is what makes
  the `get-session` case correct; the tie-break change removes the *fragility* so the result no
  longer depends on path spelling. Machine-check: a unit test with two same-cwd active no-pid
  sessions written with EQUAL `state_mtime_ms` and no `started_at` returns a STABLE winner
  independent of which lexical name is greater (assert the result does not flip when the two
  session-dir basenames are swapped).
- **AC-A4 (no regression on covering tests):** `get-session.test.js`, `cancel.test.js`,
  `status.test.js`, `retry-ticket.test.js`, `worker-setup.test.js`, `resolve-state.test.js`,
  `state-manager.test.js`, `crash-recovery.test.js`, `state-field-invariants.test.js` all stay
  green on the macOS local gate. Machine-check: each file exits 0 under
  `EXTENSION_DIR=$repo TZ=UTC node --test tests/<file>.test.js`.

### WS-B — orphan-tmp promotion robust to equal mtimes (`recoverable-json.ts` + `state-manager.ts`)

Make the base-vs-tmp recency decision deterministic when `mtimeMs` ties on Linux. The rule a
fixer MUST implement: **a valid `.tmp.<pid>` recovery candidate (parseable JSON object, dead or
non-live writer pid, required state fields present) wins over the base file when its `mtimeMs` is
`>=` the base mtime (ties go to the tmp), NOT strictly `>`.** Rationale: a `.tmp.<pid>` snapshot is
only ever written AFTER its base — it is the in-progress newer write — so on an equal-mtime tie the
tmp is the more-recent intent. The existing `shouldSkipLiveTmp` guard (live-writer protection) and
the `iteration`-first comparison in `isStateSnapshotNewer` are PRESERVED; only the mtime tie-break
flips from `>` to `>=`.

- **AC-B1 (recoverable-json tie-to-tmp):** in `recoverable-json.ts`, the
  `parseDeadTmp` discard predicate `mtimeMs <= baseMtimeMs` (`:91`) MUST be narrowed to
  `mtimeMs < baseMtimeMs` so an equal-mtime valid tmp is NOT discarded; the winner-selection at
  `:123` MUST keep the tmp on `>=` among competing tmps deterministically (document the
  multiple-tmp ordering — newest pid or first-seen — and pin it). Machine-check: a test that writes
  base `state.json` and one `.tmp.<deadpid>` with an IDENTICAL forced `mtimeMs` promotes the tmp
  (`readRecoverableJsonObject` returns the tmp's payload) on both platforms.
- **AC-B2 (state-manager tie-to-candidate):** `isStateSnapshotNewer` (`state-manager.ts:524`) —
  when `iteration` is equal/absent on both sides, the mtime comparison `candidateMtimeMs >
  currentMtimeMs` MUST tie to the candidate (`>=`) consistently with AC-B1, so the orphan-tmp
  recovery in `recoverOrphanTmpFiles` (`:926`/`:1001`) promotes an equal-mtime `.tmp.<pid>`. Keep
  the `iteration`-first precedence intact (a higher-iteration snapshot still wins regardless of
  mtime). Machine-check: `state-manager.test.js` orphan-tmp recovery + a new equal-mtime case
  promote the tmp.
- **AC-B3 (orphan-tmp cluster green on Linux):** `status.test.js` (showStatus),
  `mux-runner.test.js` (recovered-inactive-orphan-tmp), `check-readiness.test.js`
  (dead-writer-tmp), `verify-recapture-fired.test.js` (orphan-tmp) pass when re-dispatched
  individually via `rcifb-debug.yml` on Linux/node24. Machine-check: rcifb-debug per-file run = 0
  fail for each.
- **AC-B4 (no regression):** the `recoverable-json.ts` trap door
  (`unreadable orphan tmp … must never be unlinked`) and `state-manager.ts` orphan-tmp/reset-step
  trap doors stay green on the macOS gate (`get-session.test.js`, `resolve-state.test.js`,
  `state-manager.test.js`, `crash-recovery.test.js`, `verify-recapture-fired.test.js`).

### WS-C — runGate fixtures + 5s-timeout output-match (DIAGNOSE FIRST, then fix-or-serialize)

These are NOT assumed mtime-tie. The fixer MUST first capture the real Linux error block via
`rcifb-debug.yml`, then choose the minimal correct fix.

- **AC-C1 (runGate diagnosis):** re-dispatch `rcifb-debug.yml`, read the clean per-file error for
  `services/convergence-gate-workspaces.test.js`. `runGate` runs real `npm`/`tsc`/`eslint` against
  the fixture packages and asserts `result.status === 'green'` (`:101`). Determine on Linux whether
  the fixture packages need `npm ci` (deps absent), whether `tsc`/`eslint` resolve on the runner
  PATH, or whether the gate genuinely returns red. **Fix the fixture setup or the test** (e.g.
  ensure fixture deps are installed in the workflow, or assert the platform-correct status). Do NOT
  weaken the gate's pass/fail contract. Machine-check: the 3 `runGate` cases pass on Linux via
  rcifb-debug AND on the macOS gate.
- **AC-C2 (5s-timeout output-match):** `bin/test-runner-tier-discovery.test.js:257` asserts child
  stdout matches `/cancelled 1|tests 1/i` (`:291`). Diagnose whether the Linux failure is a real
  output-timing/format difference (fix the assertion to be platform-robust) OR a c=8-contention
  starvation. **If — and only if — rcifb-debug proves it passes individually but fails under c=8
  load**, serialize it per the R-TFP precedent: promote `@tier:fast`→`@tier:integration` + add to
  `extension/tests/integration/.serial-tests.json` with a 1:1 reason in
  `.serial-tests.reasons.json` (sanctioned class, likely `subprocess-timeout-coupling` or
  `load-dependent-timeout`). Same triage for the `mux-runner` quality-gate-skip test. Machine-check:
  the test passes individually on Linux via rcifb-debug; if serialized,
  `serial-tests-reasons-coverage.test.js` + `audit-subprocess-heavy-tests.sh` stay green.

---

## AC verification protocol (MANDATORY — Linux is the oracle)

Every WS-A/B/C fix is **Linux-specific** and MUST be verified on Linux. A passing macOS/node24 run
is **NECESSARY BUT NOT SUFFICIENT** — these failures do not reproduce on macOS at all (not even
under CI-sim at c=8).

1. **Per-change Linux verify:** after each fix, re-dispatch the per-file diagnostic:
   `gh workflow run rcifb-debug.yml` (workflow_dispatch). Download its artifact and confirm the
   previously-failing file now exits 0 in the clean per-file run. Docker Hub pulls hang in the
   babysitter env, so this CI workflow is the only working Linux repro.
2. **macOS gate must also stay green:** every fix MUST keep the full local gate green, especially
   the covering tests enumerated in AC-A4 / AC-B4. Run:
   `EXTENSION_DIR=$repo TZ=UTC node --test tests/<file>.test.js` for each covering file, and the
   standard `cd extension && npm run test:fast:budget && npm run test:integration`.
3. **Final closing gate:** a clean `gh workflow run stability-gate.yml -f run_count=10` (CI-side
   `test:fast:budget` passes 10/10) closes R-CIFB. Then **remove `.github/workflows/rcifb-debug.yml`**
   (it is diagnostic-only, documented "Remove once R-CIFB is closed").

---

## Scope / non-goals

**In scope:** the remaining ~13 Linux-specific failures — WS-A session ranking (get-session
dead-pid + mtime tie), WS-B orphan-tmp promotion (status/mux-runner/check-readiness/verify-recapture
clusters), WS-C runGate ×3 + 5s-timeout output-match (diagnose-then-fix-or-serialize).

**Out of scope:**
- The already-SHIPPED structural fixes (`EXTENSION_DIR=workspace`, hermetic-env strip, CI node
  22→24, `fetch-depth:0`, `addToJar`). Do NOT re-touch them.
- `check-update.test.js` c=8-contention failures — these PASS individually (the c=8 failures are
  contention-dependent, NOT mtime-tie). Lower priority / separate; note as a follow-up, do NOT bundle.
- **Changing CI concurrency or the fail-budget** (`--test-concurrency=8`, `--fail-budget=2` in
  `check-flake-budget` / `test:fast:budget`). W5b subtract-before-add: fix the tests/runtime, do
  NOT weaken the guard. (The `flake-budget` trap door pins these values.)

---

## Trap doors / enforcement

Pin the two deterministic invariants so they cannot regress on Linux. Both ENFORCE entries are new
tests; add them to `extension/CLAUDE.md` `## Trap Doors` and to the relevant subsystem
`extension/src/services/CLAUDE.md`.

- **R-CIFB-A (dead-pid demotion + non-lexical recency in `selectScannedSessionPath`):**
  INVARIANT — `selectScannedSessionPath` MUST demote an `active:true` session whose `pid` is a
  finite integer and `!isProcessAlive(pid)` out of the `activeMatch` lane, and `preferNewerSession`
  MUST NOT break a recency tie by `sessionPath.localeCompare`. `isProcessAlive` is IMPORTED from
  `state-manager.js` (rides the existing pickle-utils→state-manager edge), never re-inlined.
  BREAKS — a dead-pid stale session out-ranks a live/no-pid session on coarse-mtime filesystems
  (Linux), deterministically returning the wrong session. ENFORCE —
  `extension/tests/get-session.test.js` (`mapped dead-pid active session does not outrank a live
  same-cwd session` + a new lexical-swap-stability case). PATTERN_SHAPE — `isProcessAlive(` imported
  in `pickle-utils.ts` and called inside `selectScannedSessionPath`; `localeCompare` ABSENT from
  `preferNewerSession`.
- **R-CIFB-B (equal-mtime tmp-wins promotion):**
  INVARIANT — orphan-`.tmp.<pid>` recovery treats an equal `mtimeMs` as "tmp wins" (`>=`), never
  discarding a valid equal-mtime recovery candidate, in BOTH `recoverable-json.ts` (`parseDeadTmp`)
  and `state-manager.ts` (`isStateSnapshotNewer` mtime tie-break); the `iteration`-first precedence
  and `shouldSkipLiveTmp` live-writer guard are preserved. BREAKS — a `.tmp.<pid>` interrupted-write
  snapshot written same-tick as its base is dropped on Linux, losing recoverable state. ENFORCE —
  `extension/tests/get-session.test.js`, `extension/tests/state-manager.test.js`,
  `extension/tests/verify-recapture-fired.test.js` (each with an equal-forced-mtime promotion case).
  PATTERN_SHAPE — `mtimeMs < baseMtimeMs` (not `<=`) in `parseDeadTmp`; candidate-wins-on-tie in
  `isStateSnapshotNewer`.

---

## Deterministic tie-break — chosen approach

The fix removes mtime-fragility WITHOUT introducing a new persisted field (schema-neutral). Two
parts:

1. **Demote dead-pid active sessions (WS-A AC-A2)** — this is the *correctness* fix for the
   get-session worked example: the dead-pid stale session is no longer an `activeMatch` candidate at
   all, so it cannot win regardless of mtime. This alone makes the canonical failing test pass on
   both platforms.
2. **Replace the lexical tie-break with a recency-meaningful, stable rule (WS-A AC-A3)** —
   `started_at`-present beats `started_at`-absent (a stamped start time is real recency evidence;
   coarse `mtimeMs` is not); a true remaining tie keeps the incumbent `best` (stable
   first-seen-wins on iteration order) instead of flipping on path spelling. For `.tmp` promotion
   (WS-B), equal mtime resolves "tmp wins" because a tmp is by construction the newer interrupted
   write.

This is the minimal, schema-neutral change: no new state field, no `LATEST_SCHEMA_VERSION` bump
(hence `schema_neutral: true`). A monotonic write-counter was considered and rejected as
over-engineering — the dead-pid demotion + `started_at`-preference + stable-incumbent tie-break
fully closes the observed Linux failures without persisting new schema.

## Honest scope note

This is a focused, careful systemic change across two recovery sites (session ranking + tmp
promotion) plus a diagnose-first WS-C, each verified per-change on Linux via `rcifb-debug.yml`. It
is a dedicated-session dev task, NOT babysitter tick-work. CI-green is hygiene; do not let it block
higher-value drain, but when picked up, drive it to a clean 10-run stability-gate close and then
delete the diagnostic workflow.
