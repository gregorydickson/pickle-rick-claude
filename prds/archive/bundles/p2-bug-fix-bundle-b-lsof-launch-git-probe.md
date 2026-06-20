---
title: "B-LSOF — Launch-time concurrent-git-access probe"
status: Draft
priority: P3
type: bug-bundle
code: B-LSOF
composes:
  - "#37e R-PIWG-5"
backend_constraint: any
schema_neutral: true
---

# B-LSOF — Launch-time concurrent-git-access probe

## Trigger

Master Plan Finding **#37e R-PIWG-5** (drain row 10): the git-isolation residual deferred
from the R-RHGS bundle (`prds/archive/bundles/resume-heal-and-git-safety-bundle-2026-05-14.md:172` — "R-PIWG-5
(concurrent-access probe via `lsof` at session launch) — defer").

R-PIWG-1..4/6 shipped the durable git-safety slices:
- **R-PIWG-1** HEAD pin at bootstrap + per-iteration re-check (`setup.ts` captures
  `pinned_branch`/`pinned_sha`; `mux-runner.ts:checkHeadPinMismatch` re-checks).
- **R-PIWG-2** worker-prompt destructive-git hardening.
- **R-PIWG-4** stale `.git/index.lock` cleanup at CANCEL time (`cancel.ts:cleanupStaleIndexLock`).
- **R-PIWG-6** schema-conformant activity events for the above.

R-PIWG-5 is the one remaining slice: a **proactive launch-time probe**. Today nothing warns
the operator at pipeline launch that ANOTHER live process is already touching this repo's git.
This is the concrete launch-probe companion to the watch-only **#25 R-CSI** (concurrent
claude-session destructive-command interference — DATA-LOSS class). R-CSI's full forensics are
external-event-gated and OUT OF SCOPE here; B-LSOF ships only the advisory launch probe.

## Root cause

A reusable concurrent-access probe pattern ALREADY exists, but only for CANCEL-time lock-holder
detection and only as module-private helpers:

- `extension/src/bin/cancel.ts:106-141` `probeLockHolder(lockPath)` — runs `lsof -t <lockPath>`
  (5s timeout) → PID list; falls back to `pgrep -f 'git -C <repo>'` (5s timeout); returns a
  synthetic `{ pid: -1, command: 'probe-unavailable' }` when neither tool answers confidently.
- `extension/src/bin/cancel.ts:143-150` `lookupCommandForPid(pid)` — `ps -p <pid> -o comm=`
  (5s timeout) → command name.
- Both are consumed ONLY by `cancel.ts:cleanupStaleIndexLock` (`cancel.ts:25-90`), exported as
  `cleanupStaleIndexLock`. `probeLockHolder` / `lookupCommandForPid` are NOT exported.

There is **no launch-time concurrent-git-access probe** anywhere:
- `grep -rn "probeConcurrentGitAccess\|concurrent_git\|concurrent-git" extension/src/` → zero hits.
- `setup.ts` session bootstrap (`createInitialState`, `setup.ts:1031-1089`) captures the HEAD pin
  (`setup.ts:1082-1086`) but never probes for a competing process.
- `mux-runner.ts` startup-validation has no such probe (only `head_mismatch_detected` and
  `SCHEMA_MISMATCH` concurrency handling, `mux-runner.ts:3738`, `:4257`).

The probe logic is the load-bearing reusable slice; the residual is (a) extracting it into a
shared, exported helper and (b) wiring an ADVISORY launch-time call into the bootstrap path.

## In scope

1. A shared, exported `probeConcurrentGitAccess(repoRoot)` helper that detects whether another
   live process is concurrently accessing `repoRoot`'s git, reusing the `lsof` → `pgrep` → `ps`
   pattern currently private to `cancel.ts`. Each subprocess MUST carry a finite timeout
   (subprocess-hang trap-door convention — `cancel.ts` already uses `timeout: 5_000`).
2. An ADVISORY launch-time call wired into `setup.ts` new-session bootstrap that, on a positive
   detection, emits a WARN to stderr + a `concurrent_git_access_detected` activity event. It MUST
   NOT block, throw, or alter the launch exit code (never a hard launch block).
3. A new schema-conformant `concurrent_git_access_detected` activity event (definition + `oneOf`
   `$ref` + `VALID_ACTIVITY_EVENTS` + compiled mirror + refinement prompt catalog row).
4. Regression test(s) + a trap-door pin.

## Not in scope

- The full **#25 R-CSI** concurrent-session destructive-command forensics (external-event-gated;
  watch-only). B-LSOF ships ONLY the launch probe, not incident analysis or remediation.
- **R-PIWG-3** worktree isolation (rejected for pickle runs per
  `p2-bug-fix-bundle-2026-05-15-operational-trifecta-plus-rsu.md:93`).
- Any hard launch block, abort, or non-zero exit on detection — strictly advisory.
- `--resume` and `--paused` prep sessions: the probe is for fresh-launch bootstrap only (a resume
  re-enters an existing session; a paused prep session is not a build loop). Probe MUST short-circuit
  for these.
- Schema-version bump: this bundle is **schema-neutral** (additive activity event only, no state
  schema change).

## Tickets

### Ticket 1 — R-PIWG-5.1: extract shared `probeConcurrentGitAccess(repoRoot)` helper

**Files to modify:**
- `extension/src/services/git-utils.ts` — add and export `probeConcurrentGitAccess`.
- `extension/src/bin/cancel.ts` — refactor `cleanupStaleIndexLock` to reuse the shared probe
  primitive where it currently uses module-private `probeLockHolder`/`lookupCommandForPid`
  (no behavior change at CANCEL time).

**Files to create:**
- `extension/tests/probe-concurrent-git-access.test.js` (forward-created)

Extract the `lsof -t` → `pgrep -f 'git -C <repo>'` → `ps -p <pid> -o comm=` probe pattern from
`cancel.ts:106-150` into a shared exported helper:

```
export interface ConcurrentGitHolder { pid: number; command: string; }
export function probeConcurrentGitAccess(repoRoot: string): ConcurrentGitHolder | null;
```

Returns the first detected live holder of `repoRoot`'s git (`{ pid, command }`), or `null` when
no holder is confidently detected OR when the probe tools are unavailable (advisory probe fails
OPEN — absence of a confident positive is treated as "no holder", unlike the conservative
fail-CLOSED stance `cleanupStaleIndexLock` takes for the destructive unlink path).

**Acceptance criteria (machine-checkable):**

- **AC-PIWG-5.1.a** — `grep -c "export function probeConcurrentGitAccess" extension/src/services/git-utils.ts`
  returns `1`.
- **AC-PIWG-5.1.b** — Every `spawnSync`/`execFileSync` call inside `probeConcurrentGitAccess` passes
  a finite positive `timeout`. Test asserts: the helper source between its declaration and closing
  brace contains no `spawnSync(`/`execFileSync(` call lacking a `timeout:` option (mirrors the
  `cancel.ts` `timeout: 5_000` convention).
- **AC-PIWG-5.1.c** — Given a faked `lsof` that prints a PID for the repo, `probeConcurrentGitAccess(repoRoot)`
  returns a non-null `{ pid, command }`; given a faked `lsof` that exits 1 (unheld) with `pgrep`
  also unheld, it returns `null`.
- **AC-PIWG-5.1.d** — When BOTH `lsof` and `pgrep` are unavailable/error (neither answers confidently),
  `probeConcurrentGitAccess` returns `null` (advisory fail-open) — distinct from `cleanupStaleIndexLock`'s
  conservative refusal. Test asserts the two divergent stances explicitly.
- **AC-PIWG-5.1.e** — `cancel.ts` CANCEL-time stale-lock behavior is unchanged: existing
  `extension/tests/cancel.test.js` passes (the `stale_index_lock_cleaned` /
  `stale_index_lock_held_by_live_process` paths still fire as before).
- **AC-PIWG-5.1.f** — `npx tsc --noEmit` and `npx eslint src/ --max-warnings=-1` are clean.

**complexity_tier: medium**

### Ticket 2 — R-PIWG-5.2: wire ADVISORY launch-time probe + emit event

**Files to modify:**
- `extension/src/bin/setup.ts` — call `probeConcurrentGitAccess` (from
  `extension/src/services/git-utils.ts`, created by ticket 1) at new-session bootstrap, near the
  HEAD-pin capture in `createInitialState` (`setup.ts:1082-1086`) / `createSession`
  (`setup.ts:1091-1131`); on a positive detection emit a WARN to stderr + a
  `concurrent_git_access_detected` activity event.
- `extension/src/types/index.ts` — add `concurrent_git_access_detected` to `VALID_ACTIVITY_EVENTS`.
- `extension/src/types/activity-events.schema.json` — add the `concurrent_git_access_detected`
  definition AND its top-level `oneOf` `$ref` (R-PDD-oneOf invariant).
- `extension/src/bin/spawn-refinement-team.ts` — add a `concurrent_git_access_detected` row to
  `ACTIVITY_EVENT_SCHEMA_SECTION` (the analyst prompt catalog, beside the existing
  `head_mismatch_detected` / `stale_index_lock_*` rows at `:274-276`).
- `extension/types/index.js` — compiled mirror of the `VALID_ACTIVITY_EVENTS` addition (produced by
  `npx tsc`, must match source).

**Files to create:**
- `extension/tests/concurrent-git-access-probe-launch.test.js` (forward-created)
- `extension/tests/concurrent-git-access-detected-schema-conformance.test.js` (forward-created)

The event shape (modeled on `stale_index_lock_held_by_live_process`,
`activity-events.schema.json:1022-1041`):

```
event: 'concurrent_git_access_detected'
required: ['event', 'ts', 'session', 'gate_payload']
gate_payload.required: ['repo_root', 'holder_pid', 'holder_command']
```

The probe MUST short-circuit (no probe, no event) for `--resume` and `--paused` prep sessions —
only a fresh `createSession` bootstrap probes.

**Acceptance criteria (machine-checkable):**

- **AC-PIWG-5.2.a** — `grep -c "probeConcurrentGitAccess" extension/src/bin/setup.ts` returns `>= 1`,
  invoked only on the fresh-bootstrap (non-resume, non-paused) path.
- **AC-PIWG-5.2.b** — When the probe returns a holder, `setup.ts` writes a stderr line matching
  `/\[pickle\] WARNING: .*concurrent/i` AND emits a `concurrent_git_access_detected` activity event
  whose `gate_payload` carries `repo_root`, `holder_pid`, `holder_command`. Test asserts both.
- **AC-PIWG-5.2.c** — The launch path is NON-BLOCKING: a positive detection does NOT throw and does
  NOT change the setup exit code (session is still created, `state.json` still written). Test
  asserts setup completes successfully (exit 0 / session dir created) with a holder present.
- **AC-PIWG-5.2.d** — `concurrent_git_access_detected` is present in `VALID_ACTIVITY_EVENTS`
  (`extension/src/types/index.ts`) AND in the compiled mirror (`extension/types/index.js`).
- **AC-PIWG-5.2.e** — The R-PDD-oneOf invariant holds: the schema oneOf-membership grep
  (`node -e "const s=require('./extension/src/types/activity-events.schema.json'); const refs=new Set(s.oneOf.map(o=>o.$ref.replace('#/definitions/','')));  const SHARED=new Set(['backendEnum','backendResolutionSourceEnum','workerBackendResolutionSourceEnum']); for (const k of Object.keys(s.definitions)) if (!SHARED.has(k) && !refs.has(k)) console.log(k);"`)
  emits zero lines, AND a per-event conformance test validates a sample emission against the schema.
- **AC-PIWG-5.2.f** — The probe short-circuits for resume/paused: a `--resume` or `--paused` setup
  run emits NO `concurrent_git_access_detected` event even when a holder would be present. Test asserts.
- **AC-PIWG-5.2.g** — `spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION` contains a
  `concurrent_git_access_detected` row listing its schema-required `gate_payload` keys
  (`repo_root`, `holder_pid`, `holder_command`).
- **AC-PIWG-5.2.h** — `npx tsc --noEmit`, `npx eslint src/ --max-warnings=-1`, and
  `npm run test:fast` are clean.

**complexity_tier: medium**

### Ticket 3 — R-PIWG-5.TD: trap-door pin

**Files to modify:**
- `extension/src/services/git-utils.ts` — ensure the helper carries a grep-able trap-door anchor
  comment.
- `extension/src/bin/CLAUDE.md` (or `extension/src/services/CLAUDE.md` if the helper's home dictates)
  — add the trap-door entry.

Add a trap-door entry to the appropriate subsystem `CLAUDE.md` pinning the advisory contract.

**Acceptance criteria (machine-checkable):**

- **AC-PIWG-5.TD.a** — A trap-door block referencing `probeConcurrentGitAccess` exists in a
  subsystem `CLAUDE.md` with the labeled INVARIANT / BREAKS / ENFORCE / PATTERN_SHAPE quartet; the
  INVARIANT states the probe is ADVISORY (warn + event, never a hard launch block) and that every
  probe subprocess carries a finite timeout.
- **AC-PIWG-5.TD.b** — `bash scripts/audit-trap-door-enforcement.sh` passes (the new entry's
  PATTERN_SHAPE anchor resolves in source).
- **AC-PIWG-5.TD.c** — `bash scripts/audit-subsystem-claude-md.sh` passes (no dirty-report churn).

**complexity_tier: small**

## [manager] Closer — R-PIWG-5.CLOSE: full gate, release, MASTER_PLAN repoint

Manager-owned. Runs AFTER tickets 1-3 land.

1. **Full gate** from `extension/`:
   `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`.
   Test failures block the release — no exceptions. READ the gate result and confirm green BEFORE
   any bump/commit/tag.
2. **Version bump** `extension/package.json` 1.89.6 → **1.89.7** (PATCH: additive advisory probe +
   one new activity event; no breaking schema/CLI/hook change). Commit `chore: bump version to 1.89.7`.
3. **Clean tree** — `git status` must be clean and compiled JS must match TS source (parity gate)
   before tagging. All uncommitted changes committed first.
4. **Deploy** — `bash install.sh` (parity gate must pass).
5. **Push + release** — `git push` then `gh release create v1.89.7`.
6. **MASTER_PLAN repoint** — close **#37e R-PIWG-5**: strike drain row 10 (`B-LSOF` SHIPPED v1.89.7),
   move Open Finding #37e to the closed-detail archive convention, update the Status line "Next:"
   pointer to the following drain row (R-PSAI, row 11).

**Acceptance criteria (machine-checkable):**

- **AC-PIWG-5.CLOSE.a** — `extension/package.json` version === `1.89.7`; a `v1.89.7` git tag exists.
- **AC-PIWG-5.CLOSE.b** — `git status --porcelain` is empty at tag time; the 5-file install.sh parity
  check passes (compiled mirrors match source).
- **AC-PIWG-5.CLOSE.c** — `prds/MASTER_PLAN.md` no longer lists `B-LSOF` as an open drain row and
  `#37e R-PIWG-5` is marked closed/SHIPPED v1.89.7.

**complexity_tier: medium**

## Risks

- **R1 — advisory false positives.** `pgrep -f 'git -C <repo>'` can match the pipeline's own future
  git invocations or unrelated `git` processes. Mitigation: the probe is advisory only (warn +
  event, never blocks); a noisy warning is tolerable, a false launch block is not. The `lsof`
  primary path is more precise; `pgrep` is the fallback.
- **R2 — probe-tool absence.** macOS has `lsof`/`pgrep`/`ps`; minimal Linux CI images may not.
  Mitigation: the launch probe fails OPEN (returns `null`, no event) when tools are unavailable —
  the opposite of `cleanupStaleIndexLock`'s fail-CLOSED stance, because a missing probe must never
  manufacture a phantom holder at launch. AC-PIWG-5.1.d pins this divergence.
- **R3 — refactor regression at CANCEL time.** Reusing the extracted helper inside
  `cleanupStaleIndexLock` must preserve its conservative fail-closed behavior. Mitigation:
  AC-PIWG-5.1.d + AC-PIWG-5.1.e keep the two stances explicit and re-run `cancel.test.js`. If the
  fail-open/fail-closed split makes a shared single-return-shape awkward, ticket 1 may keep
  `cleanupStaleIndexLock` on its existing private `probeLockHolder` and have the new helper be a
  thin sibling that shares only the spawn primitives — the AC bar is "shared spawn pattern + new
  exported launch probe", not "single function for both stances".

## Forward-reference hygiene

All paths that do not exist at HEAD are annotated:
- `extension/tests/probe-concurrent-git-access.test.js` (forward-created)
- `extension/tests/concurrent-git-access-probe-launch.test.js` (forward-created)
- `extension/tests/concurrent-git-access-detected-schema-conformance.test.js` (forward-created)
- `extension/src/services/git-utils.ts` `probeConcurrentGitAccess` is created by ticket 1; ticket 2
  cites it as `(created by ticket 1)` in prose above.
