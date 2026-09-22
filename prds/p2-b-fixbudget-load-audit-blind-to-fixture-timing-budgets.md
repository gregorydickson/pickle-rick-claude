# B-FIXBUDGET — the load-sensitivity audit cannot see a timing budget declared in a fixture

**Root (#47, operator-filed 2026-09-22).** `npm run test:fast:parallel` went red twice on `main`: 2 of
9,969 tests in `extension/tests/worker-gate-offrepo-runs.test.js`, both `gatePhase === 'tsc'` where the
spec expects `test:fast`. Alone the file is 29/29 green. The specs are right; they run in the 8-way
parallel half, where a 250ms budget measures machine load instead of liveness.

**Why they run parallel:** `tests/.serial-tests.json`'s `_comment` says its floor is DERIVED from
`scripts/audit-subprocess-heavy-tests.sh` and must not be hand-curated. That audit decides
load-sensitivity by reading a literal `timeout: N` out of a spawn block
(`scripts/audit-subprocess-heavy-tests.sh:207-208`). These specs declare their budget by WRITING A
SETTINGS FILE — `{ worker_test_gate_timeout_ms: 250 }` into the fixture's `pickle_settings.json`
(`tests/worker-gate-offrepo-runs.test.js:264`, `:284`). The audit cannot see it, so it never derives
them into the serial floor. The blind spot is silent and permanent: every future fixture-budget test
inherits it.

## Census — measured at HEAD `13e1018a`, not inferred

| probe | result |
|---|---|
| `grep -c 'worker-gate-offrepo' extension/tests/.serial-tests.json` | **0** |
| `bash scripts/audit-subprocess-heavy-tests.sh` (from `extension/`) | exit **0** |
| audit over a `--scan-root` holding ONE `@tier: fast` file that writes `{ worker_test_gate_timeout_ms: 250 }` | exit **0**, `OK` — **blind** |
| test files writing a numeric `*_timeout_ms` literal | **17** (14 `@tier: fast`) |
| …of those, value ≤ `SUBPROCESS_HEAVY_WARN_MS` (15000) and in neither manifest | **12** |
| …of those 12, with ≥1 direct spawn matched by the audit's own `spawnRe` | **1** (`install-script.test.js`); `worker-gate-offrepo-runs.test.js` has **0** — its subprocess is spawned inside the imported `runWorkerGate` |
| wall-clock of the 12 run serially (`--test-concurrency=1`) | **23s**, 295 tests, 0 fail · the target file alone: **7s** |
| release gate `test_fast_budget` leg on `b017f393` (fast tier ×5) | **green** — the red is load-dependent, not deterministic |

The 12, with their minimum fixture value: `codegraph-settings` 0 · `codegraph-index-cost` 5 ·
`codegraph-service` 10 · `mux-runner-between-ticket-gate` 50 · `worker-gate-offrepo-runs` 250 ·
`codegraph-degradation` 1500 · `install-script` 3300 · `status` 3456 ·
`codegraph-context-events-schema-conformance` 5000 · `codegraph-context-section` 5000 ·
`codegraph-staleness` 5000 · `settings-loader` 12345.

## ⛔ Two directions, both measured — the default is (b)

**(a) One `_evidence` entry.** Add `tests/worker-gate-offrepo-runs.test.js` to `tests/.serial-tests.json`
with an `_evidence` note, exactly as `tests/spawn-morty-worker-gate.test.js` is already recorded
("NOT statically derivable" — its budget travels through the SAME `worker_test_gate_timeout_ms`
channel). One file, zero audit change. **Rejected as the default:** it adds a member to a
hand-maintained set, and the next fixture-budget test is invisible in exactly the same way. Root
CLAUDE.md clause 1: *adding the 8th member schedules the 9th bypass.*

**(b) Widen the audit's existing classifier — DEFAULT.** A second evidence source in the SAME scan:
a `*_timeout_ms` key assigned a numeric literal anywhere in the file counts as a timing budget, fed into
the SAME band comparison the `timeout:` literal already uses. No list of keys: the `_timeout_ms` suffix is
this repo's settings convention (`worker_test_gate_timeout_ms`, `index_timeout_ms`, `sync_timeout_ms`,
`query_timeout_ms`). **Measured cost: it admits all 12 files above, not 2.** Several have no timing
assumption at all (clamp/resolver tests). Serializing them costs **~16s** of serial wall-clock per
fast-tier run — and over-serializing is the gentler failure direction (a slower tier, never a flaky red).
**Narrowing by "file also spawns" was measured and FAILS:** it keeps `install-script` and drops the
target file (0 direct spawns). Do not reintroduce that narrowing.

This is a widened predicate inside an existing gate leg, not a new leg — the release gate's leg count
does not change.

### Where it lands

```
scripts/audit-subprocess-heavy-tests.sh:197-231   the per-file spawn scan (node heredoc)
  :207  const timeoutMatch = block.match(/\btimeout\s*:\s*([0-9][0-9_]*)\b/);
  :208  if (!timeoutMatch) continue;
  :233  load-sensitive verdict collected for --emit-fast-manifest
  :266  AC-A1a — a fast-tier load-sensitive file missing from tests/.serial-tests.json FAILS
```

The widened source must feed the WARN/AC-A1a band only. **It must not reach the FAIL arm**, which keeps
its `bash`/`sh` program narrowing deliberately (`:63-69` explain why widening it would red the gate).

### Regeneration is part of the fix, not a follow-up

Widening the classifier makes AC-A1a FAIL for all 12 newly-derived files (measured: none is in either manifest) until the manifest carries
them. The same ticket MUST run `bash scripts/audit-subprocess-heavy-tests.sh --emit-fast-manifest`
(writes the UNION — never drops an entry) and commit the regenerated `tests/.serial-tests.json`.
Splitting that into a later ticket leaves a red audit between them.

## Simplification Review

1. **Necessary?** It adds one evidence source (a `*_timeout_ms` literal) to an existing per-file scan,
   and regenerates a derived manifest. It adds no gate leg, flag, state field, or halt path.
2. **Reuse instead of add?** It reuses the scan loop, the `SUBPROCESS_HEAVY_WARN_MS` band, the AC-A1a
   check and `--emit-fast-manifest` unchanged. The alternative (a), a hand-maintained `_evidence` entry,
   is the "add a member" shape root CLAUDE.md clause 1 names.
3. **Guarding brittle complexity that should be subtracted?** The brittle part is the audit's premise
   that a timing budget lives only in a spawn `timeout:` literal. The fix removes that premise's
   blindness rather than adding a guard beside it. The 250ms spec budget is correct and stays.
4. **Subtraction?** The distinction "budget in a spawn literal vs budget in a settings fixture"
   collapses to one: a numeric timing budget in the file. **A second subtraction follows:**
   `spawn-morty-worker-gate.test.js` is serial today only through a hand-written `_evidence` note ("NOT
   statically derivable"), but it writes a `*_timeout_ms` literal of 6000 (measured). Under the widened
   source it becomes DERIVED. Its manifest entry stays (the union regeneration keeps it). The ticket
   must re-word its `_evidence` note to say the entry is now derived, and must not delete the entry.

**Green-tree precondition:** the release gate was 22/22 green on `b017f393` (run
`20260922T195321Z-30733`). Every commit since then is docs-only under `prds/`.

## Non-goals

- **Do NOT raise the 250ms in the specs.** It would green these two and leave every future
  fixture-budget test unclassifiable, and it weakens the margin the stall-detector specs measure.
- **Do NOT enumerate settings keys** (`worker_test_gate_timeout_ms`, …). The suffix is the formulation.
- **Do NOT touch the FAIL arm or the `bash`/`sh` narrowing.**
- **Do NOT hand-edit `tests/.serial-tests.json` entries** — regenerate it with `--emit-fast-manifest`.
- **Do NOT remove any existing manifest ENTRY.** Re-wording `spawn-morty-worker-gate.test.js`'s `_evidence` note is in scope (see Simplification Review §4); deleting the entry is not.

## Interface Contracts

**Inputs**: every test file under the audit's scan root (default `extension/tests`, or `--scan-root <dir>`).
**Outputs**: for a `@tier: fast` file whose smallest numeric `*_timeout_ms` literal is
≤ `SUBPROCESS_HEAVY_WARN_MS`, the same load-sensitive verdict a spawn `timeout:` literal in that band
produces today — included in the `--emit-fast-manifest` union and subject to AC-A1a.
**Invariants**: a file with no `*_timeout_ms` literal classifies exactly as today. A `*_timeout_ms` above
the WARN band is not flagged. The FAIL arm's verdicts are unchanged for every file. The audit exits 0
on the committed tree after regeneration.
**Errors**: a non-numeric value (`worker_test_gate_timeout_ms: SOME_CONST`) is not classified — same
rule as a non-numeric spawn timeout (`:71-73`).

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| fixture budget is seen | `extension/tests/audit-subprocess-heavy-tests-missing-timeout.test.js` | `--scan-root` with one `@tier: fast` file writing `{ worker_test_gate_timeout_ms: 250 }`, no manifest entry | audit exits non-zero and names the file |
| above-band is NOT seen (OVER-TRIGGER CONTROL) | same | same file with `300000` | audit exits 0 |
| FAIL arm unchanged | same | the fixture file is reported under the load-sensitive/AC-A1a wording, not the `subprocess-heavy candidate not serialized` FAIL wording | FAIL wording absent |
| regeneration covers the target | n/a — verify command | the committed manifest | contains `tests/worker-gate-offrepo-runs.test.js` |

## Acceptance Criteria

- `grep -c 'worker-gate-offrepo-runs' extension/tests/.serial-tests.json` returns a value `>= 1` — **measured 0 at HEAD**.
- `grep -c '_timeout_ms' extension/scripts/audit-subprocess-heavy-tests.sh` returns a value `>= 1` — **measured 0 at HEAD**.
- `cd extension && bash scripts/audit-subprocess-heavy-tests.sh` exits `0` on the committed tree (measured 0 at HEAD; must STAY 0 after regeneration).
- `cd extension && node --test tests/audit-subprocess-heavy-tests-missing-timeout.test.js tests/audit-subprocess-heavy-tests.test.js` exits `0`.
- a test asserts a fixture-declared 250ms budget is reported (**measured blind at HEAD: exit 0, `OK`**), and an over-trigger control asserts a 300000ms one is not.
- `cd extension && ./node_modules/.bin/tsc --noEmit && npx eslint src/ --max-warnings=0` exits `0`.

## Mutation Verification (BINDING, both directions)

1. Delete the new `*_timeout_ms` evidence source → the fixture-budget test RED, the over-trigger control GREEN.
2. Drop the band comparison (flag every `*_timeout_ms` literal) → the over-trigger control RED.

## FALSIFY — take these before building

- `grep -c 'worker-gate-offrepo' extension/tests/.serial-tests.json` non-zero → already serialized; close as already-satisfied.
- The `--scan-root` probe above exits non-zero at HEAD → the audit already sees fixture budgets; re-derive.
- `sed -n '207,208p' extension/scripts/audit-subprocess-heavy-tests.sh` no longer shows the `timeout:` match → the classifier moved; re-locate before extending.
