# BUG-2026-08-22 (P1) — stop the tmpdir/process leak at its producers

*(refined: requirements / codebase / risk-scope analysts, 3 cycles, session `2026-08-22-a1e33756`)*

## Status

Open. Branch `release/v2.1-beta`, HEAD `55114d94`. Producer half of R-ORCG (D4 + D5). The reaper half is
fixed (`04df0897`) and verified; it is OUT of scope and AC-6 only pins it.

## Root cause — WS-A verified, WS-B REATTRIBUTED

### WS-A — the worker prompt has no backgrounding directive (VERIFIED, unchanged)

All three analysts independently re-ran the asymmetry and confirmed it exactly:

| file | `R-MWBG` | `run_in_background` | `background` |
|---|---:|---:|---:|
| `extension/templates/_pickle-manager-prompt.md` (directive at `:155`) | 1 | 1 | 1 |
| `.claude/commands/send-to-morty.md` | **0** | **0** | **0** |

Failure signature: worker exits `exit:0`, zero artifacts, clean tree, one `npm run test:fast` stranded
at `PPID 1`. Ticket `9b3c4549` burned five consecutive spawns this way.

**⚠️ The fix is INERT without deployment** *(refined: codebase)*. `spawn-morty.ts:1091` reads the worker
prompt from `path.join(os.homedir(), '.claude', 'commands', …)` — **not the repo**. Editing
`.claude/commands/send-to-morty.md` changes nothing at runtime until `install.sh` rsyncs it. The
authored PRD never stated this.

### WS-B — `pickle-judge-*` is PRODUCTION code, not a fixture (REATTRIBUTED)

**The authored PRD's central WS-B premise was false**, and all three analysts caught it in cycle 1.
`extension/src/services/judge-spawn-env.ts:68` calls
`fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-judge-'))` unconditionally inside `buildJudgeEnv`, to
give a nested `claude` judge its own `XDG_RUNTIME_DIR`. It is consumed from `src/bin/microverse-runner.ts`
(five spawn sites) and there is **no cleanup anywhere in `src/`**. So the 12,768 dirs leak from
**production microverse runs**, not tests.

Consequences the authored PRD got wrong: AC-3 named a test file that cannot fix production code; the
"Fixture tmpdir helper" Interface Contract describes something that does not exist; the UNATTENDED
posture rested on "WS-B edits test fixtures"; and the offered lead ("a shared helper that `mkdtemp`s
without a paired removal") is **refuted by measurement** — 1,476 independent `mkdtemp` sites across
`tests/`, each named prefix confined to a single file. **There is no shared fixture seam.**

A real one-seam fix exists at a layer the authored PRD never examined: `src/bin/test-runner.ts:325`,
whose `spawnSync(process.execPath, nodeArgs, { stdio, timeout })` passes **no `env`**.

## 🚨 The authored leak budget was VACUOUS — it could score green without fixing anything

*(refined: risk-scope, reproduced by requirements)* Three independent ways the authored AC-4 passes
while the leak continues:

- **Relocation scores as a fix.** `TMPDIR=$PRIV node --test tests/judge-spawn-env.test.js` creates **6**
  `pickle-judge-*` inside `$PRIV` while the operator's `TMPDIR` census reads **0**.
- **The `^pickle-` filter misses two thirds.** A partial fast-tier run left **699** entries, only
  **236 (33%)** matching `^pickle-`; the rest are our own `cp-git`, `cp-state`, `cxhang-test`,
  `w4a-choke`, `flake-budget-logs` fixtures.
- **`isNestedClaude()` (`judge-spawn-env.ts:32`) reads ambient env**, so an unnested shell measures 0
  before AND after regardless of whether anything changed.

Assertion hygiene: `grep -c` exits 1 on zero matches, so a `set -e` / `&&` chain silently measures
nothing.

## Acceptance criteria

- **AC-1 (universal, not enumerated)** *(refined: AC-shape smell, all 3 analysts)* — **For every**
  backgrounding form, `.claude/commands/send-to-morty.md` names it as forbidden for the worker's own
  long-running commands and requires FOREGROUND execution with an explicit large timeout. Pinned by one
  parametrized test using `describe.each(['run_in_background', '&', 'nohup', 'setsid', 'disown'])`.
  Reuse the exact shape `R-MWBG` uses at `_pickle-manager-prompt.md:155`; do not invent a second
  convention. **AC-1b:** the directive is DEPLOYED — `diff -q .claude/commands/send-to-morty.md
  ~/.claude/commands/send-to-morty.md` reports identical, since `spawn-morty.ts:1091` reads the home
  copy. `README.md` updated per the Documentation Rule.
- **AC-2** A worker whose long command is cut leaves an attributable line in `worker_session_*.log`;
  repeated `exit:0` + `validation: failed` + clean tree is diagnosable in one read.
- **AC-3** `judge-spawn-env.ts:68`'s `XDG_RUNTIME_DIR` directory is removed on normal AND abnormal exit
  of the judge spawn. **This is production code in `src/`, not a test fixture.**
- **AC-3a** *(refined: requirements P0 #2 — NOT a zero-risk subtraction)* `microverse-runner.ts:2593`
  (`Object.keys(buildJudgeEnv('claude', isNested))`) MUST create no directory **and MUST NOT change
  `pre_spawn_env_key_names`** (`:2657`). The env is discarded; the key list is the shipped observable
  proving the R-SJET-3 `DANGEROUS_PREFIXES` strip happened. Measured baseline: nested = **41 keys**
  including `XDG_RUNTIME_DIR`; unnested = **44** including `PICKLE_BACKEND`, `PICKLE_ROLE`,
  `PICKLE_REFINEMENT_LOCK`, `CLAUDECODE`. Passing `isNested=false` or skipping the call makes the
  telemetry report the outer session's contamination markers as present in the judge env — the exact
  condition R-SJET-3 detects — while the tmpdir count goes green. The existing ENFORCE assertion
  (`tests/bin/microverse-judge-probe.test.js:295`) is only `assert.ok(Array.isArray(...))` and cannot
  catch this; strengthen it to assert contents. **Co-scope** `src/bin/CLAUDE.md` (the `:48` INVARIANT +
  PATTERN_SHAPE) and that test file, or the scope fence blocks the trap-door update.
- **AC-4 (the oracle, rewritten to close four free variables)** The leak budget counts directories
  **created**, not **visible**, and counts **all** of them. Procedure: `PRIV=$(mktemp -d)`; run
  `TMPDIR="$PRIV" CLAUDECODE=1 npm run test:fast`; count **every** entry created in `$PRIV` — not a
  `^pickle-` subset. **Net new MUST be exactly 0.** One threshold only; the authored "zero net new" and
  "within a small documented bound" phrasings are deleted. **Non-halting**: report the delta and flag a
  residual. If any precondition fails, record **`unmeasured`** — never `0`.
- **AC-5 (universal, not enumerated)** *(refined: AC-shape smell)* A per-run disposable `TMPDIR` root is
  established at `src/bin/test-runner.ts:325`, so that **for every** prefix — the four named, the ~2,300
  unenumerated tail, and the non-`pickle-` families — net new **created** entries is zero. Three binding
  constraints:
  **(a)** the root's basename **MUST** begin with `pickle-`. `resolveTmpPrefixFixturePath`
  (`orphan-reaper.ts:254`) admits an orphan only when its first segment beneath `os.tmpdir()` starts
  with a `TEST_OWNED_TMP_PREFIXES` entry (`:244`); a `tmp.XXXXXX` root makes every fixture orphan
  unmatchable and **silently reverts `04df0897`**.
  **(b)** the redirect **MUST** be scoped to the `spawnSync` child, **not** exported at npm-script
  level — the `posttest` reaper is a separate process whose `os.tmpdir()` must stay ORIGINAL, or its
  first segment becomes `cp-git-…` and the matcher goes blind.
  **(c)** the root is removed on exit. (`resolveUnderTmpRoot` (`:198`) is a pure prefix compare with no
  `existsSync`, so removal does not blind argv matching.)
- **AC-6** A unit test pins the reaper's realpath handling (argv in `/private/var/...` form matches) so
  `04df0897` cannot regress.
- **AC-7** No new `exit_reason`, no new abort condition, no new halt path (PRIME DIRECTIVE).
- **AC-8 (report-only, non-gating)** Tiers do not regress: `cancelled 0`, no new failures beyond the two
  filed known ones (`install-bun-probe`, `extension-wiring` deploy smoke).

## Verification Strategy

Measurement preconditions, not gates. Node 24 + pnpm on PATH; censused idle box recording load average
**and top CPU consumers by name**. Failure to meet preconditions → record the reason, flag a residual,
proceed. No measurement verdict halts the run.

```bash
# AC-4 primary oracle — private root, ALL entries, created-not-visible
PRIV=$(mktemp -d)
TMPDIR="$PRIV" CLAUDECODE=1 npm run test:fast
find "$PRIV" -maxdepth 1 -mindepth 1 | wc -l      # MUST be 0

# AC-1b deployment check (the fix is inert until this passes)
diff -q .claude/commands/send-to-morty.md ~/.claude/commands/send-to-morty.md

# The reaper will NOT reap what this run just created: bin/reap-orphans.js:20 calls
# reap({ sessionsRoot }) with no minAgeSeconds, inheriting DEFAULT_MIN_AGE_SECONDS = 600
# (orphan-reaper.ts:47), enforced for EVERY kind including tmp_fixture (:475, :575).
node bin/reap-orphans.js    # expect scanned=N reaped=0 for fresh orphans — this is CORRECT.
# `reaped=0` is meaningful ONLY alongside `scanned=N>0`. A zero-SCAN sweep means the matcher never
# fired — the 04df0897 regression signature, not cleanliness. Never read reaped=0 in the same session
# as evidence the leak is fixed (silence is not success).

npm run test:integration:parallel && npm run test:integration:serial
npx tsc --noEmit && npx eslint src/ --max-warnings=-1
```

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-1 | `tests/send-to-morty-*.test.js` | `describe.each` over the five backgrounding forms | each form named forbidden in the worker template |
| AC-1b | same | deployed copy matches repo copy | `diff` identical |
| AC-2 | new | cut long command leaves attributable log line | log names the cause, not silence |
| AC-3 | `tests/judge-spawn-env.test.js` | judge `XDG_RUNTIME_DIR` removed on normal + abnormal exit | zero dirs survive |
| AC-3a | `tests/bin/microverse-judge-probe.test.js` | `pre_spawn_env_key_names` unchanged | nested 41 incl `XDG_RUNTIME_DIR`; unnested 44 incl the 4 markers — assert CONTENTS, not `Array.isArray` |
| AC-4 | new | leak budget under a private root | every created entry counted; delta exactly 0 or `unmeasured` |
| AC-5 | `tests/bin/test-runner-*.test.js` | per-run root basename starts with `pickle-`, child-scoped, removed | all three constraints asserted |
| AC-6 | `tests/orphan-reaper-*.test.js` | realpath argv matches | `/private/var/...` form matched |

## Non-goals

- The reaper's matching rules (fixed; AC-6 only pins them).
- Spotlight configuration — operator UI action. Tested and rejected code-side:
  `.metadata_never_index` (ineffective), `/private/tmp` and `/private/var/tmp` (both indexed),
  `mdutil -i off` (volume-scoped).
- Lowering `--test-concurrency`.
- Backfilling historical `TMPDIR` contents (already cleaned: 17,921 entries / 331 MB).

## Execution posture

**UNATTENDED, with a corrected premise.** The authored PRD justified this with "WS-B edits test
fixtures", which is false — WS-B edits **production** `src/` code. It remains UNATTENDED for a different
and valid reason: neither workstream touches the salvage / completion-evidence / Done-flip path, and the
deployed runtime is content-identical to source.

## Simplification Review

1. **Necessary?** WS-A adds prompt text only. WS-B is a removal of a leak plus one `env` argument at an
   existing `spawnSync` — not new machinery.
2. **Reuse?** WS-A reuses the `R-MWBG` shape verbatim. WS-B reuses the existing `spawnSync` at
   `test-runner.ts:325` rather than touching 1,476 `mkdtemp` sites. AC-5(a) reuses
   `TEST_OWNED_TMP_PREFIXES` so the reaper keeps matching.
3. **Guards brittle complexity?** No. The reaper is correct; this stops feeding it. Do NOT add reaper
   special-cases for these prefixes — that guards a leak instead of closing it.
4. **Subtracts?** ~15k directories per run and one orphan per failed spawn. **Bonus win:** the 463
   non-`pickle-` fixture dirs match no `TEST_OWNED_TMP_PREFIXES` entry today, so their orphans are
   unreapable right now; nesting them under a `pickle-`-prefixed root makes them reapable for the first
   time.

## Implementation Task Breakdown

| Order | ID | Title | Tier | Entry | Exit |
|---|---|---|---|---|---|
| 10 | `470170dd` | Forbid backgrounding in the worker prompt + deploy it | medium | clean tree | directive pinned by `describe.each`, deployed copy identical |
| 20 | `b1bb51ca` | Remove judge `XDG_RUNTIME_DIR` without mutating R-SJET-3 telemetry | medium | `470170dd` | no `pickle-judge-*` survives; key-name contents asserted |
| 30 | `ac1a2c2d` | Disposable `pickle-` TMPDIR root + non-vacuous leak budget | medium | `470170dd`,`b1bb51ca` | `find $PRIV` = 0 after `test:fast` |
| 40 | `b2252ef3` | Pin reaper realpath + record evidence | small | prior 3 | realpath test green, evidence doc committed |
| 50-80 | `8c89594e` `c06f960d` `b382cbcb` `4801536f` | 4 hardening passes | medium | all prior | zero P0-P1 in MODIFIED_FILES |

**Wiring ticket SKIPPED** — the 7d gate fires at ≤2 implementation tickets only when scope is a single
module; here the four tickets share one seam set and the hardening passes cover integration. Recorded
explicitly rather than silently omitted.

**AC-shape smells resolved:** AC-1 and AC-5 were flagged by all three analysts as enumerations with a
repeated predicate. Both are now universally quantified — AC-1 pinned by `describe.each` over the five
backgrounding forms, AC-5 stated as "for every prefix … zero net new created entries" with the seam as
the single mechanism. No per-target ticket fan-out, so no `// JUSTIFICATION:` blocks are required.
