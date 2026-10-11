# B-CI-HERMETIC-HOME — two fast-tier suites read the operator's deployed send-to-morty.md

**Status:** queued 2026-10-11 · **Scope base:** `d3decf60` · **Gate legs:** 22 → 22 (no new leg)

## Problem (measured at HEAD `d3decf60`)

CI has been red on every push since `1aa65d0c` (B-FIELD-88 + B-FIELD-95 ship). The `test` job fails
`test:fast:budget` with `EXCEEDED failures=3 budget=2`: the same 6 tests fail in every run, in two files.

`buildWorkerPrompt` (`extension/src/bin/spawn-morty.ts:1168`) reads the worker template from
`path.join(os.homedir(), '.claude', 'commands', 'send-to-morty.md')` and falls back to a short inline
prompt when it is absent. The fallback has no `{{TIER_RESUME_TABLE}}` / `{{TIER_LIFECYCLE_SECTIONS}}`
placeholders, so no `### N. Implement` section and no `| N (Implement) |` resume row render.

These suites call `buildWorkerPrompt` with the REAL `HOME`:

- `extension/tests/spawn-morty-tier-phases.test.js` — the four `rerunPrompt(...)` tests in the
  "Lifecycle re-run of committed work" block (lines ~226–257).
- `extension/tests/pipeline-runner-units.test.js` — the two `lifecycle chain, serial|wave` tests in
  `describe('runPickleWaves via main()')` (lines ~383–413); their spawn runner builds the prompt.

On the operator's box `~/.claude/commands/send-to-morty.md` exists (install.sh deploys it), so they pass;
on a clean CI runner it does not, so they fail. Reproduced locally:

```
cd extension && H=$(mktemp -d) && HOME=$H node --test --test-concurrency=1 \
  tests/spawn-morty-tier-phases.test.js tests/pipeline-runner-units.test.js   # 6 fail, exit 1
node --test --test-concurrency=1 tests/spawn-morty-tier-phases.test.js tests/pipeline-runner-units.test.js  # 45 pass
```

It is a hermeticity defect with a second, worse face: on the operator box these tests measure the
**deployed** template, not the source one, so a source edit to `.claude/commands/send-to-morty.md` is
verified against a stale copy until `install.sh` runs (fake-green), and the suites also read
`~/.claude/**` from a test.

The shipped runtime is unaffected: every install path deploys `send-to-morty.md`.

## Fix

Reuse the existing hermetic-HOME pattern (`extension/tests/spawn-morty.test.js:2222`): each affected
test runs with `process.env.HOME` pointed at a temp dir whose `.claude/commands/send-to-morty.md` is a
copy of the **source** `.claude/commands/send-to-morty.md` (resolved from the test file, as
`tests/send-to-morty-resume.test.js:11` does), restored in `finally`. No production code changes.

## Tickets

### T1 — spawn-morty-tier-phases: hermetic HOME seeded from the source template
- **Files to modify/create**: `extension/tests/spawn-morty-tier-phases.test.js`
- `rerunPrompt` (or a file-level `before`/`after`) sets `HOME` to a temp dir holding a copy of the
  repo's `.claude/commands/send-to-morty.md`, and restores/removes it afterwards.
- AC1: `cd extension && H=$(mktemp -d) && HOME=$H node --test --test-concurrency=1 tests/spawn-morty-tier-phases.test.js` exits 0 (exits 1 at HEAD: 4 fail).
- AC2: the same file passes under the real HOME too (`node --test --test-concurrency=1 tests/spawn-morty-tier-phases.test.js` exits 0).
- AC3 (falsifying control, recorded in the ticket's conformance artifact, not committed): temporarily
  remove the `{{TIER_LIFECYCLE_SECTIONS}}` placeholder from the temp-HOME copy → the "renders no
  Implement or Code Review section" / "Plan Review still renders" assertions red.

### T2 — pipeline-runner-units: hermetic HOME for the lifecycle chain tests
- **Files to modify/create**: `extension/tests/pipeline-runner-units.test.js`
- Same seeding for the two `lifecycle chain` tests (or the enclosing `describe`). Any spawned child
  inherits the env; every subprocess the change adds gets `timeout: 30_000`.
- AC1: `cd extension && H=$(mktemp -d) && HOME=$H node --test --test-concurrency=1 tests/pipeline-runner-units.test.js` exits 0 (exits 1 at HEAD: 2 fail).
- AC2: the same file passes under the real HOME.

Both tickets: `complexity_tier: small`; tests-only.

## Premises

| Claim | Tag | Evidence |
|---|---|---|
| CI red since `1aa65d0c`, same 6 tests | verified | `gh run list --workflow CI`; failed-log names at `29ea26c6` |
| Cause is the absent `~/.claude/commands/send-to-morty.md` | verified | empty-HOME repro fails the same 6; real HOME passes 45/45 |
| Shipped runtime unaffected | verified | `install.sh` deploys `.claude/commands/*.md`; deploy diff 0 |

## Open Decisions

| decision | options | default | owner | status |
|---|---|---|---|---|
| none | — | — | — | — |

## Simplification Review

1. **Necessary?** Adds no production code, guard, flag or gate leg; only test setup in two files.
2. **Reuse?** Reuses the hermetic-HOME pattern of `spawn-morty.test.js:2222` and the source-template path of `send-to-morty-resume.test.js:11`.
3. **Guards brittle complexity?** No — it removes the tests' dependency on deployed state (a hidden input).
4. **New check?** None. Would the next iteration have caught it? CI already did, on every push; the
   miss was operational (CI status not read before the release decision), recorded in MASTER_PLAN,
   not a new leg. Gate legs 22 → 22.
