# B-CIGREEN4 — the Linux-only divergence class, and the termination channel — PRD

**Branch:** `release/v2.1-beta`  **Build mode:** unattended  **Launch commit:** see `start_commit`

## What beta.24 PROVED, and what it did not

`v2.1.0-beta.24` (`ec691ef7`) CI run `33536065252` is RED, but **not for the reason beta.23 was**.

**The flake class is FIXED — measured on ubuntu-latest, not locally.** beta.24's CI emitted:

```
flake-budget OK failures=0 budget=2 runs_completed=5 runs_requested=5
```

against beta.23's CI (`33401996681`), which ended:

```
RUN 2 FAILED: status=1
RUN 4 FAILED: status=1
REPEATED ACROSS RUNS:
  - AP-EXT-ITER21-01: `timeout:` really bounds a detached unref'd child ...
```

B-CIGREEN3's derived fast-tier serial sub-tier did its job. **Do NOT re-open the flake class.**

**What is still red is ONE test, and it is a platform divergence, not load.**

```
not ok 28 - runner times out wedged child test process instead of hanging indefinitely
  location: extension/tests/bin/test-runner-tier-discovery.test.js:439
  error: The input did not match the regular expression
         /cancelled 1|tests 1|Interrupted while running/i. Input: 'TAP version 13\n'
  duration_ms: 5065
```

The test is `@tier: integration`, was added by `31d47445` (an EARLIER bundle's anatomy-park), and
**passes on macOS** — the full local gate including the Node 22 fast tier was green at `ec691ef7`.
On Linux the killed child flushes only the TAP header; on macOS it flushes a summary line.

## Thesis — one root, two surfaces

**Root:** an oracle asserts on an ENUMERATED SET of output shapes instead of on the observable it
actually cares about. `/cancelled 1|tests 1|Interrupted while running/` is a 3-member list, and
Linux supplies a 4th (header-only). Per the PRIME DIRECTIVE's complexity rule, the fix is NOT a 4th
alternative — it is the formulation that needs no list. The test's own comment states its real
intent: prove the runner **kills the wedged grandchild** rather than hanging. That is two direct
observables — the grandchild pid is dead, and the runner returned inside its bound — neither of
which depends on child stdout text at all.

**Surface A** is that class in the test/CI harness. **Surface B** is the termination channel
(`isMicroverseArmFatal`), which is the same shape one layer up: a fatal-reason list that was
collapsed to ONE member and then re-widened by an `||`.

---

## FR-A1 (P1, CI-RED) — replace the wedged-child output-shape enumeration with the direct observable

`extension/tests/bin/test-runner-tier-discovery.test.js:439` must stop matching child stdout text.
Assert instead: (a) the recorded grandchild pid is NOT alive after the runner returns, and (b) the
runner returned within its bound (the existing 5s-ish window; keep the wall-clock assertion). The
test's own AP-EXT-ITER54-01 comment already names these as the thing being proven.

⛔ Do NOT add `|TAP version 13` or any 4th alternative to the regex — that schedules the 5th bypass.
⛔ Do NOT weaken the test to "runner exited non-zero"; the grandchild-death assertion is the point.

**MANDATORY verification — this ticket is not done on a macOS-only pass.** Reproduce the Linux
failure FIRST with `extension/scripts/ci-repro.sh` (committed `4026af79`, "faithful CI repro harness
with a measured 0-noise baseline"), show it RED against HEAD, then show it GREEN after the fix.
A macOS-green claim is worthless here: macOS was already green at `ec691ef7` while CI was red.

**Files (scope fence):**
- `extension/tests/bin/test-runner-tier-discovery.test.js`
- `extension/src/bin/test-runner.ts` + compiled `extension/bin/test-runner.js` — ONLY if the repro
  proves a real runner defect rather than an oracle defect. Identify in research; default is
  test-only.

## FR-A2 (P1) — sweep for SIBLING output-shape enumerations

FR-A1's shape is never alone (`9452a550`/`e7502abf`/`258e0d05` were three siblings in one phase).
Sweep the test corpus for oracles that regex-alternate over a CHILD PROCESS's stdout/TAP text, and
report each as: real risk / benign. Fix only those that a `ci-repro.sh` run actually reddens.

**Files (scope fence):** `extension/tests/**` (assertions only), `extension/scripts/ci-repro.sh`
(read-only). No `src/` changes.

## FR-A3 (P1) — a green local gate must not be able to hide a Linux-only red

This bundle exists because the documented release gate passed on macOS — including the Node 22 fast
tier — while CI was red. The Node 22 leg covers the RUNTIME axis; nothing covered the OS axis.
Add `ci-repro.sh` to the documented pre-release path in root `CLAUDE.md` (the release-gate section)
and to `prds/CLAUDE.md`'s pre-launch checklist, stating plainly which axis each leg covers.

⛔ DOC + existing-script wiring only. Do NOT add a new abort condition, and do NOT make `ci-repro.sh`
a blocking leg of the automated gate in this ticket (Docker availability is not guaranteed on every
box — an unrunnable check that fails closed reds the whole chain).

**Files (scope fence):** `CLAUDE.md`, `prds/CLAUDE.md`, `extension/tests/release-gate-parity.test.js`
(only if it pins the documented command list).

## FR-B1 (P1, [[B-ONEABORT]] residue) — collapse the `||` in `isMicroverseArmFatal`

Measured 2026-08-31: `MICROVERSE_FATAL_REASONS` (`src/types/index.ts:1451`) has reached its stated
one-member target — `session_state_corrupted`. But `isMicroverseArmFatal`
(`src/bin/pipeline-runner.ts:3161-3165`) ORs that against `isMicroverseFailureExit(reason)`, and
`MICROVERSE_FAILURE_REASONS` (`:1492`) carries five more (`error`, `rate_limit_exhausted`,
`judge_unreachable`, `baseline_unmeasurable_unrecoverable`, `judge_cli_missing`). So the arm has
**6 effective fatal reasons, not 1**. The remaining subtraction is that `||`, not the list it
already collapsed. B-ONEABORT's section counts are STALE — correct them from measurement.

A measurement/quality verdict must park-and-flag, never break the phase loop. Preserve the genuine
floor and the withheld-success wiring (`unsuccessful = pipelineFailed || nonConvergent > 0`).

**Files (scope fence):** `extension/src/bin/pipeline-runner.ts` + compiled `extension/bin/pipeline-runner.js`,
`extension/src/types/index.ts` + compiled `extension/types/index.js`,
`extension/tests/nostop-gates-invariant.test.js`, `prds/MASTER_PLAN.md` (the B-ONEABORT section counts).

## FR-B2 (P1, [[R-JUNS]]) — route an unparseable judge answer to the transient reason that ALREADY EXISTS

Traced live 2026-08-31: `mapJudgeMeasurementFailure` (`src/bin/microverse-runner.ts:3721`) falls
through its `default:` arm to `baseline_unmeasurable_unrecoverable` for any failure it does not
recognise — an unparseable answer included — and that reason is fatal via FR-B1's path. A NON-fatal
`baseline_unmeasurable_transient` already exists and only `exhaustedFailureKind === 'rate_limited'`
reaches it. **Reuse it. No new exit reason, no new machinery.**

Keep a genuinely unrecoverable answer distinguishable from a transient one — the point is that a
parse failure is retryable, not that everything becomes transient.

**Files (scope fence):** `extension/src/bin/microverse-runner.ts` + compiled `extension/bin/microverse-runner.js`,
`extension/tests/microverse-judge-*.test.js` (existing files only).

## FR-C1 / FR-C2 / FR-C3 (VERIFY-FIRST — close by measurement, like B-CIGREEN3's FR-D)

For each: grep HEAD **and** the deployed tree for the MECHANISM (never the R-code). If already
fixed, close it with a regression pin **plus a control arm** so the pin cannot pass by never firing
— exactly the shape `1b635b4c` used to dispose R-EROS and `--max-iterations 0`. If genuinely open,
fix it. Roughly 40% of drain rows measured this way have proven stale; expect some of these to be.

- **FR-C1 — [[R-JPCM]]:** the judge prompt already emits `{"score": <number>, "violations": [...]}`
  at `microverse-runner.ts:1902`. Determine whether the filed defect survives.
- **FR-C2 — [[R-FBTN]]:** on gate failure, surface the failing TEST NAMES rather than a bare status.
  Relates to `collectGateFailures` (`services/convergence-gate.ts`).
- **FR-C3 — [[R-RNTA]]:** the filed fix is a release-workflow reorder (build+attach the tarball).
  Re-read `.github/workflows/release.yml` at HEAD before assuming the order is still wrong.

**Files (scope fence):** per-ticket, identified at research. `prds/MASTER_PLAN.md` for the
disposition rows. Tests go in EXISTING test files — a brand-new test file is a scope violation.

---

## Bundle-wide rules

- **PRIME DIRECTIVE:** no new abort condition, in any ticket. Prefer subtraction. A gate may refuse
  a LOCAL action and flag a residual; it may never break the phase loop.
- **No enumerated sets.** If a fix adds a member to a list, ask what formulation needs no list.
- ⛔ **NEVER raise the flake budget.** It is `budget=2` and beta.24 measured `failures=0`.
- ⛔ **NEVER move CI off Node 22.**
- Tests import COMPILED JS — run `./node_modules/.bin/tsc` before believing a test result.
- `npx tsc` exits 0 without typechecking; use `./node_modules/.bin/tsc`.

## Definition of done

CI green on `ubuntu-latest` for the tagged commit — that, not a local gate, is the AC-R8 verdict.
