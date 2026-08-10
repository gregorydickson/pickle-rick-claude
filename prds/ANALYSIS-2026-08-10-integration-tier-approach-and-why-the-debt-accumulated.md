# Integration-tier approach — assessment and why 21 failures accumulated unseen

**Date:** 2026-08-10
**Branch:** `release/v2.1-beta`
**Measured at:** `f1e1ce1b` (baseline) → post-B-RATRAIL HEAD
**Companion:** `BUG-REPORT-2026-08-09-runner-authored-commits-carry-no-pickle-ticket-trailer.md`

This is the assessment half of the B-RATRAIL work: not *which* tests failed, but why the tier could
rot for weeks without anyone seeing it, and what the cheapest honest fix is. Every number below was
measured in this session, not recalled.

---

## 1. What the tier actually is

| Tier (`// @tier:` tag) | Files |
|---|---|
| `fast` | 637 |
| `integration` | 172 |
| `expensive` | 7 |

`npm run test:integration` = `test:integration:parallel && test:integration:serial`.

- parallel: 590 tests, `-c 8`, **~56 s**
- serial: 589 tests, `-c 1` (manifest-selected), **~25-31 min**

**85** test files shell out to `install.sh` or a long audit script. **43** read `src/` as *text* and
assert on its contents.

---

## 2. Five structural reasons the debt accumulated

### 2.1 The composite command hides half the tier behind `&&`

A red parallel half short-circuits, so the serial half **never executes**. The serial tier had never
been measured before this session. It had 589 tests and 5 real failures, invisible.

**Any "integration is red, N failures" figure taken from the composite is a parallel-only count.**

### 2.2 No phase runs the tier — but the mechanism to run it already exists

This is a **correction** to the claim carried in `extension/CLAUDE.md`-adjacent notes and in this
bundle's own PRD, which said flatly that no phase runs the integration tier.

It does exist. `spawn-morty.ts:1666` runs `test:integration` inside the worker gate — but only when
`resolveWorkerGateTier` returns `'full'`:

```
worker_gate_tier: 'narrow' | 'fast' | 'full'    // spawn-morty.ts:1276-1293
compiled default: 'fast'                         // deployed value: 'fast'
```

At `'fast'` the gate runs `test:fast` and stops. So the accurate statement is: **the capability is
shipped and switched off**, not absent. That matters — it changes the fix from "build a phase" to
"decide where to spend 32 minutes", which is a much smaller question.

### 2.3 Flipping `worker_gate_tier: 'full'` is a trap, not a fix

The per-gate-phase cap is:

```
DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS = 600_000   // 10 min — pickle-utils.ts:165
```

The serial half alone takes **25-31 min**. So `'full'` as shipped would `__timeout__` every worker
gate — the `gate cap < suite runtime` class, where a too-small hang-guard converts a healthy suite into
a uniformly failing one. Flipping the flag without raising `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` makes
things strictly worse than leaving it off: instead of no signal you get a false red on every ticket.

And raising the cap puts a ~32-minute gate on **every worker turn**, which no bundle can afford.

**Conclusion: the per-worker axis is the wrong axis.** The tier is a bundle-level instrument.

### 2.4 The split-tier invocation silently drops all three audits

npm binds a `pre` hook to a **literal** script name. `package.json` defines `pretest:fast` and
`pretest:integration` — there is **no** `pretest:integration:parallel` and **no**
`pretest:integration:serial`.

So the split invocation this repo (correctly) recommends for *visibility* runs with **zero** audit
preflight: `audit-test-tiers.sh`, `audit-test-isolation.sh`, `audit-subprocess-heavy-tests.sh` all
skipped. Splitting was right for visibility and silently wrong for coverage, and nobody separated the
two properties.

### 2.5 Hang-guard caps have drifted below the work they guard

Measured this session: `audit-test-isolation.sh` took **116 s** under load against a **60 000 ms** cap
in `audit-test-isolation.test.js:97`. Under load 16-21, nine serial tests died at their caps:

```
 60003ms  audit-test-isolation                  (cap 60000)
169092ms  install-script-prefix.prefix-writes-files
170593ms  install-script-prefix.sentinel-staged
157738ms  install-script-prefix.getExtensionRoot-accepts-sentinel
121014ms  install-script-prefix.settings-untouched   → "expected exit 0, got null"
120015ms  install-chmod-coverage                     → "install.sh failed (exit null)"
211942ms  install-typescript-package                 → "install.sh failed (exit null)"
480424ms  codegraph per-mode deploy                  → "first install.sh failed (exit null)"
```

**Every one is `exit null` — killed, not failed.** Zero are behavioral assertion mismatches. That is
the signature of contention against a hang-guard, not of a defect. It is also unfalsifiable evidence:
a killed test is *unmeasured*, not passing and not failing.

Per the serial-manifest hygiene principle in `extension/CLAUDE.md`, a subprocess timeout is a
hang-guard, not a perf assertion — so the remedy is raising caps or reducing contention, **never**
shrinking the work to fit.

---

## 3. What made the 21 failures *stay* invisible once introduced

Of the 21 measured at `f1e1ce1b`, **13 were tests pinning a contract or commit shape that a deliberate
change had superseded** — and every one of those changes shipped with a green `test:fast`:

| Class | N | Superseded by |
|---|---|---|
| fixture models a subject-only commit | 6 | `a4e48c26` deleted message inference |
| judge-reason disposition | 3 | B-ONEABORT classifier |
| judge-prompt prose | 2 | R-JPCM object contract |
| brittle source-text anchor | 2 | b1089e97 rename; AP-EXT-ITER6-01 comment growth |

Only **6** were a live production defect (the missing trailer), and **1** remains undiagnosed.

So the dominant failure mode is not "code broke" — it is **contract changes landing without their
tests being reconciled**, in a tier no gate reads.

### 3.1 The brittle-anchor sub-class is worth naming

43 test files read `src/` as text. Two of them broke on refactors that changed no behavior:

- a grep for `emitCgSessionSummary`, a symbol with **no definition anywhere in `src/`**
- a fixed **2000-character** slice from a function whose leading comment block grew past it

A source-text assertion is only sound when anchored to (a) a symbol the compiler also sees, and
(b) a syntactic extent — never a byte offset. Both failures were pure test rot with zero defect
behind them, and both cost triage time that looked like debugging.

---

## 4. Recommendations, subtractive first

### R1 — Can we reach a 5-minute per-worker integration run?

**Plausibly yes, and R0 is what makes the question worth asking at all.** Arithmetic from measured
parts, not aspiration:

| Component | Today | After R0 |
|---|---|---|
| `test:integration:parallel` (`-c 8`) | 56 s | 56 s (already fine) |
| 13 install-invoking serial tests | ~150-1190 s each | ~10-20 s each → **~3-4 min total** |
| remaining ~576 serial tests (`-c 1`) | remainder of the ~31 min wall | unchanged |
| **integration total** | **~31 min** | **~5-10 min** |

So R0 alone plausibly lands the whole tier in the 5-10 minute band. That is the difference between an
instrument you can run per bundle and one you can consider running per worker.

**But per-worker still is not the right first move, for a reason independent of runtime.** The gate
that would run it already exists — `worker_gate_tier: 'full'` (`spawn-morty.ts:1666`,
`resolveWorkerGateTier:1276`) — and its per-phase cap is
`DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS = 600_000` (10 min, `pickle-utils.ts:165`). A 5-10 minute tier
against a 10-minute cap leaves almost no headroom on a loaded box, and this session showed exactly what
happens then: nine tests died `exit null` under load 16-21 and read as failures when they were merely
unmeasured. Sizing a gate to *just* fit is how you manufacture flake.

**Recommended sequence, cheapest-first:**

1. **R0** — the rsync excludes. One line, ~20-40× on `install.sh`, no data touched. Do this first and
   re-measure the tier; every number below depends on it.
2. **Then re-measure**, at rest, both sub-tiers separately. If the tier lands under ~6 min, the
   per-worker option becomes real — but raise the per-phase cap to ≥3× the measured tier time before
   flipping `worker_gate_tier`, or you re-create the `exit null` class on every ticket.
3. **Meanwhile, run it once per bundle at the closer, advisory** (R1b below). That is affordable
   *today*, before any of the above, and it is what would have caught all 21 of these failures at
   introduction.
4. **R0b** — stop the stray-root writer and make pruning follow the live root, so the pile cannot
   regrow and silently undo R0.

**On the fixture-sharing idea I floated earlier: R0 makes it unnecessary.** Building the deployed tree
once and sharing it across install tests would be a real design change with real risk — install tests
exist precisely to verify that a *fresh* install produces a correct tree, and sharing one artifact
weakens exactly the property they assert. At ~10 s per install there is nothing left to amortise. Drop
the idea; the cost was never the install, it was the 601 MB.

### R1b — Run the integration tier once per bundle, at the closer, advisory (P1)

Not per worker (§2.3 — cap math forbids it), not as a new phase (no new machinery needed). Once at the
bundle boundary, where 32 minutes is affordable and the diff to attribute is the whole bundle.

**It must be advisory.** Per the root `CLAUDE.md`, a gate may refuse a local action and record a
residual, but must never break the phase loop: a halted run produces no output, and no output has no
quality. So: measure, stamp a residual, withhold the success verdict, **continue**.

This is the one change that would have caught all 21 failures at introduction.

### R2 — Add `pretest:integration:parallel` and `pretest:integration:serial` (P1, trivial)

Two lines in `package.json`. Restores audit preflight to the split invocation without giving up the
visibility the split exists for. Alternative — naming the three audits explicitly at every call site —
works but must then be remembered forever; the pre-hook cannot be forgotten.

### R0 — SUPERSEDES R3. The install family is slow for one removable reason: rsync walks 601 MB of test detritus (P0, one line)

**Measured 2026-08-10. This is the highest-leverage finding in the document and it makes R3 unnecessary.**

`install.sh` spends effectively all of its wall-clock in ONE rsync:

```
rsync -a --delete --delete-excluded \
  --exclude=node_modules --exclude=src --exclude=tests \
  --exclude=tsconfig.json --exclude=package-lock.json \
  extension/  $EXTENSION_ROOT/extension/
```

That exclude list omits two directories that dominate the tree:

| Path | Size | Paths walked | In git? |
|---|---|---|---|
| `extension/.pickle-rick/sessions/` | **510 MB** | **130,596** | untracked, `.gitignore:32` |
| `extension/.codegraph/` | **91 MB** | 3 | untracked, `.git/info/exclude:19` |
| *actual deployable payload* | **4.9 MB** | ~1,200 | tracked |

**A/B, same machine, data restored afterwards (nothing deleted):**

```
install.sh WITH  the stub pile in the rsync path   329 s   (147-329 s across runs)
install.sh WITHOUT it                             7-11 s
```

**~20-40×.** Component costs for contrast: `npm install` warm **1 s**, `tsc` cold with `.tsbuildinfo`
deleted **9 s**, codegraph deploy **0 s** (git mode symlinks) / 10 s (tarball mode). None of those was
ever the problem.

**Consequence for the tier:** 13 of the 15 tests that make up **89 % of serial test-time** are
`install.sh` invocations. At ~10 s per install instead of ~150 s, every one of them lands far inside
its existing `timeout: 120_000`. **The caps do not need raising — R3 is withdrawn.** A cap that looked
"drifted below its work" was in fact adequate for the work, guarding a step bloated by 601 MB of files
that have no business in a deploy tree.

**Fix:** add `--exclude='.pickle-rick'` and `--exclude='.codegraph'` to that rsync. Both are untracked,
git-ignored, regenerable-or-irrelevant runtime state; neither is deployable payload. This is
subtractive — it deletes nothing and removes work rather than adding a guard. Note the precedent:
AP-EXT-ITER6-01 already established that `.codegraph` is "the runtime's OWN regenerable index … plain
untracked dirt in any freshly-cloned target repo" and made **every staging path** exclude it. The
install rsync is the one seam that never got the same treatment.

### R0 — CONFIRMED END TO END (2026-08-10, post-fix, quiet box)

Measured at HEAD `c1bc530a`, load 4.90, Time Machine stopped, no runners:

```
install.sh --prefix <tmp>          5 s     rc=0        (baseline 147-329 s)   ~30-65x
test:integration:serial            591 tests, 591 pass, 0 fail, SER_EXIT=0
`exit null` occurrences            0                    (baseline 8)
install-script-prefix              17.9 s               (baseline 1,190 s, killed at cap)
deploy tree                        mux-runner.js present; state dirs 0
hang-guard caps raised             ZERO
```

The full chain is proven: 601 MB of detritus in the rsync → ~150-330 s installs → tests killed at
their hang-guards → 8 failures that read as defects but were **unmeasured**. Remove the detritus and
all 8 pass inside their unchanged `timeout: 120_000`. **R3's cap-raise was never needed** and is
correctly withdrawn.

Live-data effect of the two fixes, independently sufficient:

```
in-tree sessions   130,596 -> 443       rsync payload   606 MB -> 5.0 MB
in-tree size        510 MB -> 1.7 MB    rsync elapsed    231 s -> 1 s
```

### ⚠️ Measurement correction — `PICKLE_INSTALL_ROOT` is NOT a deploy prefix

`install.sh:33` unconditionally clobbers the environment variable with the `--prefix` flag:

```bash
PICKLE_INSTALL_ROOT="${PREFIX:-$HOME/.claude/pickle-rick}"
```

So `PICKLE_INSTALL_ROOT=<tmp> bash install.sh` **silently deploys to `$HOME/.claude/pickle-rick`** —
the operator's real tree — and exits 0. Only `--prefix <dir>` works.

Consequences, recorded because they affected this document's own evidence:

- An earlier `STATE_DIRS=0` assertion in this investigation was **vacuous**: it inspected an empty temp
  dir that nothing had been written to. The re-run with `--prefix` is the real proof and it passes
  (`mux-runner.js` present, 0 state dirs).
- The A/B timings remain valid — same target on both sides, real work both times — but they were
  measured against `$HOME`, not a sandbox.
- This is what corrupted the deployed tree mid-session (empty `node_modules`, `typescript` missing,
  citadel analyzers failing to load): killed installs were hitting the **live** install, not a sandbox.

**Two follow-on defects, neither in B-RSYNCEX's scope:**

1. **`extension/CLAUDE.md` documents `PICKLE_INSTALL_ROOT` as "Deploy-prefix override for `install.sh`
   + deploy-lifecycle soak."** The first half is false — `install.sh` honors only `--prefix`. The env
   var is a *gate* the soak reads to decide whether to run. The integration tests get this right
   (5 uses of `--prefix`); the doc does not. This is exactly the doc-anchor-vs-code drift class the
   ArchUnit spike targets.
2. **`install.sh` is not atomic.** The rsync uses `--delete --delete-excluded` with
   `--exclude='node_modules'`, deleting the deployed `node_modules`, and lines 465-468 recreate the
   runtime symlinks afterwards. An interrupt in that window leaves a tree that *looks* installed (35
   entries) but cannot load a single runtime dep — and the post-rsync MD5 parity probe passes happily
   over an empty `node_modules`, because it only checks 8 compiled files. A plausible cause of
   "mysteriously broken deploy" reports.

### R0b — Why session scaffolds are being written into the source tree at all (P1)

The 130,596 entries under `extension/.pickle-rick/sessions/` are **not session data**. Sampled 3,000:
**every one contains exactly one file, an empty `TASK_NOTES.md` template** — headers, no content, no
`state.json`, no artifacts. 4 KB of block overhead each. They span 2026-04 → 2026-08:

```
2026-04: 1,917   2026-05: 31,552   2026-06: 35,749   2026-07: 46,503   2026-08: 14,875
```

Real session data lives at the XDG root and **is** managed — `~/.local/share/pickle-rick/sessions/`
holds **22** sessions / 90 MB, because `pruneOldSessions(root, maxAgeDays = 7)`
(`pickle-utils.ts:2842`) runs against it.

So there are two defects behind one symptom:

1. Something resolves a data root to `extension/.pickle-rick` instead of `getDataRoot()` and creates a
   session scaffold there. This is the R-PTSB test-isolation class that
   `audit-test-isolation.sh` exists to catch — that audit passes today, so current tests are
   sandboxed and this is largely historical accumulation, but entries dated **today** mean at least
   one live writer remains. Find it.
2. **Pruning is per-root, so a stray root is never pruned.** `pruneOldSessions` protects the canonical
   root only. Any root that isn't the canonical one grows without bound — five months, 130 k entries,
   silently, until it made a deploy step 30× slower.

**Retention view (the data-management question, answered):** the valuable data is already managed at
7 days. The stub pile is not data and its removal loses nothing — but the *right* fix is not a one-off
`rm`: it is (a) stop writing to the stray root, and (b) make pruning follow whatever root is actually
in use rather than a hardcoded one. Otherwise the same pile regrows somewhere else.

### R3 — WITHDRAWN. Raise the install-family caps (superseded by R0)

**Re-measured at rest on a quiet box (load decaying 8.3, zero external contenders). The verdict
splits, and the split is the whole point of insisting on an at-rest measurement:**

- `audit-test-isolation: real tests/ directory exits 0` — **PASSED.** Its earlier `60003ms` death was
  genuinely load-shaped. The 60 s cap is adequate at rest. *No action.* Had this been "fixed" from the
  loaded measurement, a healthy cap would have been raised for no reason.
- The **install/deploy family — 8 failures, 7 of 8 explicitly `exit null` — is REAL, not contention.**

The decisive datum, measured directly:

```
PICKLE_INSTALL_ROOT=/tmp/... bash install.sh   →  exit 0, 147 s
```

Against the shipped caps:

| Test | Cap | `install.sh` needs | Verdict |
|---|---|---|---|
| `install-chmod-coverage` | `timeout: 120_000` | 147 s | **cannot pass** |
| `install-ui-principles` | 120 s (died 120011 ms) | 147 s | **cannot pass** |
| `install-typescript-package` | `timeout: 120_000` | 147 s | **cannot pass** |
| `install-script-prefix.settings-untouched-at-home` | 120 s (died 120040 ms) | 147 s | **cannot pass** |

`install.sh` runs `npm ci` plus a full `tsc`; 147 s is its honest cost, and it exits **0**. Four tests
cap that work at 120 s, so they fail deterministically at rest on this machine — the
`gate cap < suite runtime` class, where a hang-guard drifted under the work it guards and converts a
healthy operation into a uniform red.

**This is pre-existing, not introduced by B-RATRAIL** — `install-script-prefix` was already failing at
the `f1e1ce1b` baseline. It surfaced more broadly only because this was the first time the serial
sub-tier was measured at all (§2.1).

**Fix: raise the caps to fit the work** (≥300 s gives headroom over a 147 s baseline on a slower box).
Per the serial-manifest hygiene principle, a subprocess timeout is a hang-guard, not a perf assertion —
so do **not** shrink `install.sh`, and do **not** quarantine the tests. Its own bundle; it is
independent of everything else here.

### R4 — Ban byte-offset and unresolved-symbol anchors in source-text tests (P2, subtractive)

The invariant, already applied to the two offenders in this bundle: every source-text anchor resolves
in `src/`, and every source read is bounded by a syntactic extent. Both checks are one grep each. This
*removes* a class of test rather than adding a guard.

### R5 — Do NOT flip `worker_gate_tier: 'full'` (explicit non-recommendation)

Recorded so it is not rediscovered as an easy win. As shipped it guarantees a false red on every
ticket (§2.3). It is only viable alongside a cap raise, and the cap raise is unaffordable per-ticket.

---

## 5. What this bundle proved about the approach

Two defects were found **only** by running the pipeline against its own code, neither reachable from
the static analysis that opened this investigation:

1. **`scanGitLogByTrailer` bounded its window on the count axis (`-n 50`) while filtering on the epoch
   axis.** Exact ticket-id equality is not monotone in log order, so the cap can skip the matching
   commit. This repo has logged 143 commits in a day. A second, independent route to
   `done_without_commit_evidence` over shipped work — meaning the trailer fix was necessary and **not
   sufficient**. Fixed at `8242cc3b`.
2. **A citadel finding citing a line that already has braces** (`mux-runner.ts:6130`) — the R-BCFR
   fabricated-rule class, but a fabricated *instance*, which is a one-line disproof.

The measured outcome, both sub-tiers read separately:

**Authoritative gate, at rest, HEAD `f9febbbd`** — `install.sh` first (the tier exercises the deployed
binary), sub-tiers read separately, worker trailer-hook env stripped:

```
INSTALL_EXIT=0   TSC_EXIT=0   LINT_EXIT=0
FAST_EXIT=0      7468 tests, 7465 pass, 0 fail
PAR_EXIT=1        607 tests,  606 pass, 1 fail
SER_EXIT=1        589 tests,  581 pass, 8 fail
```

| | Baseline `f1e1ce1b` | After (at rest) |
|---|---|---|
| fast | 7453 / 0 fail | 7468 / **0 fail** |
| parallel | 590 / **16 fail** | 607 / **1 fail** — `INV-CODEX-RECOVERY-ADVANCED`, deliberately scoped out |
| serial, in-scope | **4 fail** | **0** |
| serial, install/deploy family | 1 | 8 — **pre-existing, cap-below-work (R3)** |

Test counts rose in both tiers (590 → 607, 7453 → 7468): nothing was deleted, skipped, quarantined, or
weakened to reach green.

**Every in-scope failure is resolved.** The two survivors are both out of scope by prior decision: one
undiagnosed codex-recovery test excluded before the bundle was written, and one pre-existing
install-family defect that this work merely made visible.

---

## 6. Open, not closed

- `INV-CODEX-RECOVERY-ADVANCED` — undiagnosed. Its `PICKLE_TEST_MODE` bypass is intact, so the trailer
  gap does not explain it. Deliberately excluded rather than guessed at; the only honest ticket for it
  would be diagnose-only, which decomposition forbids.
- The nine install/deploy kills — need one at-rest measurement (R3).
- Anatomy-park exited `anatomy_non_convergent`. The pipeline parked it and completed 3/4 phases;
  `pipeline-status.json` reads `failed`. That is the correct disposition and the success verdict is
  **withheld**, not assumed.
