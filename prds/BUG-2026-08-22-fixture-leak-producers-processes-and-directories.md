# BUG-2026-08-22 (P1) — stop the fixture leak at its two producers: backgrounded worker tests, and tmpdirs that are never removed

## Status

Open. Branch `release/v2.1-beta`, HEAD `e40df9e8`. This is the **producer half of R-ORCG**
(`p2-orphan-reaper-coverage-gaps-test-fixture-leak.md`, D4 + D5). The consumer half — the reaper — was
fixed by `04df0897` and verified twice on naturally-occurring orphans; it is OUT of scope here.

## What happens

Two independent producers leak, at two layers, from the same fixture surface.

### WS-A — workers background their own tier runs (D4, leaked PROCESSES)

A worker that launches a long test run with `run_in_background` ends its turn saying it will wait for
a notification. **It never gets one.** The backgrounded child is killed at the turn boundary, so the
worker exits `exit:0` with **zero artifacts and a clean tree**, its gate reds, and one
`npm run test:fast` is left orphaned at `PPID 1`. One orphan per failed spawn.

Measured: ticket `9b3c4549` burned **five consecutive worker spawns** this way before an explicit
foreground directive unblocked it in a single spawn.

The asymmetry is verifiable today:

| file | `R-MWBG` | `run_in_background` | `background` |
|---|---:|---:|---:|
| `extension/templates/_pickle-manager-prompt.md` | 1 | 1 | 1 |
| `.claude/commands/send-to-morty.md` | **0** | **0** | **0** |

`R-MWBG` constrains the manager's use of `spawn-morty.js`. Nothing constrains the **worker's own** test
invocations — which are precisely the commands long enough to tempt backgrounding.

### WS-B — fixtures create tmpdirs and never remove them (D5, leaked DIRECTORIES)

`TMPDIR` census 2026-08-22 before cleanup: **57,896 entries / 1355 MB**, of which **17,825 were
`pickle-*`**. **15,067 were modified within the previous 24 hours** — one pipeline run's output —
and **zero were older than 7 days**, so this is per-run production, not sediment.

| prefix | count |
|---|---:|
| `pickle-judge-*` | **12,768** |
| `pickle-crsr-seed-*` | 975 |
| `pickle-ws3a-*` | 900 |
| `pickle-bsi-*` | 450 |
| `pickle-ccem-*` | 420 |
| long tail | ~2,300 |

`pickle-judge-*` is **72%** of the population; nothing else is within an order of magnitude. It traces
to `extension/src/services/judge-spawn-env.ts` and `extension/tests/judge-spawn-env.test.js`.

Each directory is ~4 KB / 3 files, which is why this went unnoticed: **the disk cost is trivial and
the inode cost is not.** `TMPDIR` is Spotlight-indexed in real time (a probe file is indexed within
2 s; `mdutil -s /` reports indexing enabled), so ~18k directories is tens of thousands of files
indexed as they appear. This is a measured contributor to an observed load-average-34.75 window and to
the ledger's recorded *"`StateManager.read` costs ~6s per call on a busy developer `TMPDIR` vs ~0ms on
a private one."*

## What is ALREADY excluded — do not re-litigate

- **NOT the reaper's matching rules.** `04df0897` fixed the tmpdir symlink blindness
  (`path.resolve(os.tmpdir())` is a LEXICAL compare; macOS argv carries the `/private/var` realpath).
  Verified twice: `scanned=1 reaped=1` where it previously read `scanned=0` against six live orphans.
- **NOT a deploy gap.** Source and deploy root are content-identical (`diff -rq` reports 0 differing
  files in both `extension/bin` and `extension/services`).
- **NOT the environment.** Node 24.19.0 + pnpm 11.22.0 + ripgrep + tmux are installed and the three
  tiers measure `fail 1 / 1 / 0` with `cancelled 0` at `8a8c29eb`, both remaining failures already
  filed and both non-code-defects.

## Root cause — WS-A asserted, WS-B open

**WS-A is established**: the directive exists for the manager path and does not exist for the worker
path (table above), and the observed failure signature matches exactly — `exit:0`, zero artifacts,
clean tree, one `PPID 1` npm child per spawn.

**WS-B's mechanism is NOT asserted.** The counts are measured; *why* `judge` fixtures skip cleanup is
left to the research phase. Do not assume it is a missing `afterEach` — establish it. One lead offered
without conclusion: the leak is per-run and uniform across prefixes, which is more consistent with a
shared helper that `mkdtemp`s without a paired removal than with 12,768 individually forgotten
teardowns.

## Interface Contracts

**Worker prompt (`.claude/commands/send-to-morty.md`)**
- **Inputs**: the worker's own long-running commands (test tiers, gates, builds).
- **Invariant**: no `run_in_background`, `&`, `nohup`, `setsid`, or `disown` for any command whose
  output the worker needs. Every such command runs in the FOREGROUND with an explicit large timeout.
- **Errors**: a cut turn must leave attributable evidence, not silence.

**Fixture tmpdir helper (site to be identified in research)**
- **Inputs**: a prefix and an optional lifetime.
- **Outputs**: a directory removed on normal exit AND on abnormal termination.
- **Invariant**: a full `test:fast` run leaves **zero net new** `pickle-*` entries in `TMPDIR`.

## Verification Strategy

**Measurement preconditions, not gates** (PRIME DIRECTIVE): run under
`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` (v24.19.0 + pnpm 11.22.0) on a censused idle box —
record the load average AND the top CPU consumers **by name**, since a pickle-process census reads
clean during a macOS daemon storm. If the box cannot meet these conditions, record the reason, flag a
residual, and proceed. No measurement verdict halts the run.

```bash
# WS-B leak budget — the primary oracle
BEFORE=$(ls -A "$TMPDIR" | grep -c '^pickle-')
node bin/test-runner.js --tier fast --test-concurrency=8
AFTER=$(ls -A "$TMPDIR" | grep -c '^pickle-')
echo "net new pickle-* dirs: $((AFTER-BEFORE))"      # MUST be 0

# NOTE: `ls -d $TMPDIR/pickle-*` silently fails at this entry count and reports 0. Use the grep form.

# WS-A directive presence
grep -c 'run_in_background' .claude/commands/send-to-morty.md   # MUST be >= 1

# regression surface
npm run test:integration:parallel && npm run test:integration:serial
npx tsc --noEmit && npx eslint src/ --max-warnings=-1
node bin/reap-orphans.js                                         # must still reap real orphans
```

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-1 | `tests/send-to-morty-no-premature-promise.test.js` (or a sibling) | worker template forbids backgrounding its own long commands | template text contains the directive, pinned the way `R-MWBG` is pinned for the manager |
| AC-2 | new test | a backgrounded-then-cut run leaves an attributable log line | `worker_session_*.log` names the cause; not silence |
| AC-3 | `tests/judge-spawn-env.test.js` | `pickle-judge-*` fixtures remove their tmpdir | zero net new `pickle-judge-*` after the suite |
| AC-4 | new test | leak budget enforced across the tier | net new `pickle-*` delta ≤ small bound after `test:fast` |
| AC-6 | `tests/orphan-reaper-*.test.js` | realpath handling pinned | argv in `/private/var/...` form matches |

## Acceptance criteria

- **AC-1** `.claude/commands/send-to-morty.md` forbids `run_in_background`, `&`, `nohup`, `setsid` and
  `disown` for the worker's own long-running commands, and requires FOREGROUND execution with an
  explicit large timeout. A test pins the directive's presence. `README.md` updated if the command's
  documented behaviour changes (Documentation Rule).
- **AC-2** A worker whose long command is cut leaves an attributable line in its
  `worker_session_*.log`. Repeated `exit:0` + `validation: failed` + clean tree is diagnosable in one
  read rather than by inference.
- **AC-3** `pickle-judge-*` fixtures remove their tmpdir on normal AND abnormal exit. Measured: zero
  net new `pickle-judge-*` entries after `tests/judge-spawn-env.test.js`. **Fix this first and
  re-measure before touching the tail — it is 72% of the population.**
- **AC-4** A test enforces a leak budget: net new `pickle-*` entries after a `test:fast` run is within
  a small documented bound. Without enforcement the leak returns silently, because its disk cost is too
  small to notice.
- **AC-5** The remaining prefixes (`pickle-crsr-seed`, `pickle-ws3a`, `pickle-bsi`, `pickle-ccem`, and
  the tail) are either fixed by the same shared seam as AC-3 or explicitly recorded as out of scope
  with a count. No silent partial fix.
- **AC-6** A unit test pins the reaper's realpath handling (argv in `/private/var/...` form matches) so
  the `04df0897` fix cannot regress.
- **AC-7** No new `exit_reason`, no new abort condition, no new halt path (PRIME DIRECTIVE).
- **AC-8 (report-only, non-gating)** The three tiers do not regress: `cancelled 0`, and no new failures
  beyond the two already-filed known ones (`install-bun-probe`, `extension-wiring` deploy smoke).

## Non-goals

- **The reaper's matching rules** — fixed and verified (`04df0897`). AC-6 only pins it.
- **The `cxhang-int-*` prefixes** (48 entries) — R-ORCG AC-3's own arm; negligible beside 17,825.
- **Spotlight configuration.** The host-level exclusion is an operator UI action; tested and rejected
  as code-side fixes: `.metadata_never_index` (ineffective — file still indexed 3 s later), relocating
  to `/private/tmp` or `/private/var/tmp` (both indexed), `mdutil -i off` (volume-scoped).
- **Lowering `--test-concurrency`.** It trades wall-clock for load and does not address the leak.
- Backfilling or reaping historical `TMPDIR` contents (already cleaned: 17,921 entries / 331 MB).

## Execution posture

**UNATTENDED.** The deployed runtime is content-identical to source and carries the trailer,
reaper and entry-guard fixes, so the R-PSRB catch-22 does not apply. WS-A edits a prompt template and
WS-B edits test fixtures — neither is on the salvage / completion-evidence / Done-flip path.

## Simplification Review

1. **Is the addition necessary at all?** WS-A adds prompt text only — no runtime code. WS-B should be a
   **removal of a leak**, not an addition: if a shared `mkdtemp` helper exists, the fix is one paired
   cleanup there, not 12,768 teardowns.
2. **Can it REUSE instead of ADD?** WS-A must reuse the exact shape `R-MWBG` already uses for the
   manager prompt — same wording discipline, same pinning test style — not invent a second convention.
   WS-B must find the shared fixture seam before writing per-suite teardowns; a per-suite fix
   multiplied across prefixes is the smell this section exists to catch.
3. **Does it guard EXISTING brittle complexity that should be SUBTRACTED?** No. The reaper is now
   correct; this bundle stops feeding it. Do NOT add reaper special-cases for these prefixes — that
   would be guarding a leak instead of closing it.
4. **What can this SUBTRACT?** ~15k directories per run and one orphaned process per failed spawn. The
   leak budget (AC-4) replaces manual census with an enforced invariant, so the finding does not have
   to be re-discovered by a human noticing the host is slow.
