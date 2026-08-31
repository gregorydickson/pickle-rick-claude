# B-CIGREEN2 — close AC-R8, build a faithful CI repro, and kill the leak producers

**Priority:** P1 (reliability)
**Type:** bundle (bug) — fix-forward from v2.1.0-beta.22, whose CI failed on 2 named tests.
**Branch:** `release/v2.1-beta`
**build_mode:** unattended.

## What beta.22 proved, and what it did not

**[[B-MEGADRAIN]] shipped as v2.1.0-beta.22** — 30/30 tickets, 97 commits, szechuan converged in 3
iterations, full local gate green including the Node-22 fast tier (8903/8909, fail 0, cancelled 0).
**CI failed anyway. AC-R8 is now unmet for 16 consecutive releases (beta.7 → beta.22).**

**Two of that bundle's fixes are working IN PRODUCTION and must not be re-derived:**

| fix | evidence from the beta.22 CI run |
|---|---|
| **R-RNTA** (release reorder) | the Release workflow now has TWO jobs; `gate` failed and **`release` SUCCEEDED** — the tarball built and attached independently of the gate, exactly as designed |
| **A2** (flake-budget evidence) | CI printed named failing tests, per-run attribution and a `REPEATED ACROSS RUNS` block instead of beta.21's 187-byte stub. Diagnosis took one log read. **This bundle exists in diagnosable form because of it.** |

The entire remaining distance to AC-R8 is **two named tests**, both deterministic (3/3 runs).

## 🚨 ROOT A — the two CI failures

### A1 — `simulateBinaryAbsent` deletes system directories on Linux. ROOT CAUSE PROVEN.

`tests/audit-trap-door-enforcement-fixture.test.js:17` removes the **entire directory** containing the
target binary, looping up to 10 times:

```js
const binDir = path.dirname(which.stdout.trim());
const next = currentPath.split(path.delimiter).filter(p => p !== binDir).join(path.delimiter);
```

- **macOS:** `rg` lives alone in `/opt/homebrew/bin`. Removing it costs nothing. Test passes.
- **Linux (CI):** `rg` is in `/usr/bin`, and `/bin` is a **symlink to it**, so the loop strips BOTH.

Measured in a `node:22` container, verbatim:

```
iter 1: removed /usr/bin  -> PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/bin
iter 2: removed /bin      -> PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin
--- final state under filtered PATH ---
env: 'bash': No such file or directory
```

**The audit never executes.** The test asserts fail-closed behavior and instead measures a PATH with no
shell — it fails for a reason unrelated to its subject. A3's *product* fix (fail closed on an unrunnable
tool) and its *provisioning* fix (install ripgrep in both workflows) are BOTH correct and landed; only
the simulation is wrong.

**Fix by SUBTRACTION of the dangerous operation:** make the binary unresolvable without deleting
anything — prepend a temp directory containing a `rg` stub that exits non-zero (or an empty dir plus a
`PATH` that shadows it), so every other tool keeps resolving. Never remove a system directory from PATH.
`simulateBinaryAbsent` is shared with `install-bun-probe.test.js`'s `simulateBunAbsent` shape — fix the
shared idiom once; `bun` is homebrew-only today, which is exactly why this stayed hidden.

**AC-A1:** the test passes on Linux AND macOS, and a mutation that makes the audit report OK while `rg`
is unresolvable FAILS the test on both. Prove the Linux half in a container, not by reasoning.

### A2 — `computeOneHop: basic one-hop` fails on CI. NOT REPRODUCED. Repro comes FIRST.

Deterministic on CI (3/3 runs), but:
- passes standalone on macOS/Node 22,
- passes standalone in a `node:22` + ripgrep container,
- **did not fail** in a full-tier container run.

**Leading hypothesis, UNCONFIRMED:** A3 installed ripgrep on the runners, flipping `findImporters`
(`services/scope-resolver.ts:838`) off its `grep` fallback and onto the `rg` path for the first time.
`_runRgImportWalk` returns `null` only when rg fails/missing; a successful rg returns an authoritative
list. rg honors `.gitignore` and skips hidden files; `grep -rl` does not. Under 8-way concurrency the
5s `FIND_IMPORTERS_TIMEOUT_MS` (lowered 30s→5s by R-SRGT-2) is another candidate.

**This ticket may NOT close on a code change alone.** It closes on a repro that fails before the fix and
passes after, on Linux. If the repro cannot be built, the ticket says so and parks — it does not guess.

**AC-A2:** a repro that reproduces the CI failure is committed and demonstrated RED at the parent commit
and GREEN after the fix. **"Passes locally" is not a close** — that premise is what shipped beta.22 red.

## 🧪 ROOT B — a faithful CI repro harness (this is why A2 is undiagnosed)

**Measured gap, honestly:** a naive `docker run -v $PWD:/w node:22` produced **106 failures against CI's
2**. The noise, by cause:

| count | cause |
|---|---|
| 54 | `Cannot find module '/root/.claude/pickle-rick/extension/bin/init-microverse.js'` — no deployed runtime |
| 27 + 20 | live **API 429/529** — fast-tier tests reaching the real API |
| 14 | `fatal: not a git repository` — bind-mount lacks CI's checkout semantics |

**A repro harness that is 98% noise cannot falsify anything**, and its absence is precisely why
B-CIGREEN and B-MEGADRAIN both carried the premise *"there is no local Linux repro, so a ticket may not
close on passes-locally."* That premise is **half wrong**: Docker IS available and it proved A1 in about
a minute. What is missing is not Docker — it is CI-equivalent provisioning.

**AC-B1:** a committed script (e.g. `extension/scripts/ci-repro.sh`) that runs the fast tier in a
Linux container reproducing the CI job's environment: real git checkout semantics (or
`safe.directory`), `npm ci`, ripgrep, deployed runtime present, and **no network access to the model
API**. Its baseline at a known-green commit must be **fail 0**, not 106. Until that baseline holds, the
harness is not trusted and must not be used to close a ticket.
**AC-B2:** the harness reproduces A2's failure, or reports honestly that it cannot — a negative result
is a valid outcome and must be recorded, not hidden.
**AC-B3 (docs):** correct the "no local Linux repro" claim in `prds/MASTER_PLAN.md` and in the
B-CIGREEN PRD. It is now false as stated and it has been shaping how tickets close.

## 🧟 ROOT C — the fixture-leak PRODUCERS (fresh measurement, D1/D6 residual)

B-MEGADRAIN fixed the reaper's blind spots; **the producers are untouched and still leaking.** Measured
on this box 2026-08-30, and the dominant prefix is NOT the one the earlier PRD named:

| prefix | count | producer |
|---|---|---|
| `cp-git-` | **103,872** | `bootstrapSession()`, `tests/hooks/config-protection-git-boundary.test.js:42` — **174 call sites** |
| `cp-state-` | 34,043 | `tests/config-protection-state-files.test.js:46` sibling |
| everything else ours | ~25,000 | ~951 distinct `mkdtemp` prefixes across the suite |
| **TMPDIR total** | **173,736 entries** | — |

**Cost, measured:** `fseventsd` grew to **1,373 MB RSS / 76% CPU** on an 8 GB machine, driving free
memory to **42 MB** and 5.8 GB of swap. Manual cleanup took TMPDIR to 4,758 and a daemon restart
reclaimed 1.37 GB; free memory went 42 MB → 2,606 MB. **The producers will re-accumulate on the next
heavy run.**

**Root shape:** cleanup lives ONLY in a per-test `finally`, which a timeout, OOM, SIGKILL or pipeline
cancel never runs — and `grep -cE "after\(|afterEach\(|registerFixture" ` on that file returns **0**.
The reaper cannot compensate: `resolveTmpPrefixFixturePath` admits only paths whose first segment starts
`pickle-`, so `cp-git-*` matches zero classes.

**Fix, preferring the formulation that needs no list:** a shared fixture helper that registers every
temp root it creates and removes them in an unconditional `after()` hook, plus a `posttest` sweep keyed
on the **source-derived** prefix set (derivable mechanically: `grep -rhoE "mkdtempSync\(path\.join\((os\.)?tmpdir\(\), '[^']+'"`
yields 951 prefixes today — do NOT hand-maintain that list).

**AC-C1:** a run killed with SIGKILL mid-suite leaves zero orphaned fixture dirs for the converted
producers. Demonstrate against a REAL re-accumulated population, never planted fixtures.
**AC-C2:** the two dominant producers (`cp-git-`, `cp-state-`) route through the shared helper.
**AC-C3:** TMPDIR entry count after a full fast-tier run returns to its pre-run value ±100.

## ROOT D — remaining operational items (grounded STILL-OPEN at HEAD)

**D1 — R-TIERWEDGE** — a plain `test:fast` can wedge at zero CPU with no summary emitted; it cannot fake
a green but never returns. Encode the operational rule: any wait on a tier run needs a **stall detector**
(no log growth for N minutes), not a timeout.
**D2 — R-DSPW** — manager re-spawns a worker whose worker is still alive; the `rtk` filter empties
`ps|grep` so a live worker reads as dead. Fix subtractively — remove the heuristic that declared it dead.
**D3 — R-GRLS** — fd cleanup only via `process.on('exit')`, which SIGKILL never runs.

## ROOT E — singletons (verify-first; each may be stale)

**E1 — B-OFFREPO (P1)** the worker quality gate does not exist on any repo that is not pickle-rick.
**E2 — R-JPCM** judge prompt demands a bare number, parser demands JSON — ONE contract, not a second
parser. Also correct the stale `extension/CLAUDE.md` trap door that misroutes triage.
**E3 — R-MPVU** manager prompt ships `${EXTENSION_ROOT}` unbound; blocks `--backend codex` entirely.
`getExtensionRoot()` (`services/pickle-utils.ts:301`) is written and unwired. **Build on claude.**
**E4 — R-BCFR** delete the `isBraceFreeIf` arm; verify-then-delete the `isNever` arm.

## 🛡 PRIME DIRECTIVE COMPLIANCE

- **No new halt path.** ROOT A fixes tests and a simulation; ROOT C adds teardown; ROOT D2/D3 remove a
  heuristic and a fd leak. Nothing gains an abort condition.
- **Subtraction:** A1 removes a destructive PATH mutation; C collapses ~951 ad-hoc temp roots onto one
  registered helper; D2 deletes a false-death heuristic.
- **Enumerated sets are the target:** the reaper's `pickle-`-only prefix admission and the hand-listed
  fixture prefixes are both the incomplete-set shape. Derive, do not enumerate.

## Acceptance criteria

- **AC-1** Node-22 fast tier `fail 0, cancelled 0` locally (regression floor: 8903/8909 at beta.22).
- **AC-2** `test:fast:budget` `failures=0, runs 5/5`.
- **AC-3** AC-A1, AC-A2, AC-B1..B3, AC-C1..C3 as stated above.
- **AC-4 (report-only)** Tiers do not regress from the beta.22 baseline: fast 8909 / int-parallel 687 /
  int-serial 661 / contract 99 / expensive 8 serial + 14 parallel, soak ≥1.8e6 ms.
  **No inherited failures exist — ANY failure is attributable to this bundle.**
- **AC-5 — THE HEADLINE: a green release-workflow run on the resulting tag (AC-R8).** Unmet for 16
  consecutive releases. ROOT A is the whole remaining distance; every other root is hygiene riding the
  same review toll.

## Non-goals

- **Do NOT move CI off Node 22.** It hides this class rather than fixing it.
- Do NOT rewrite published tags. beta.16/.17 pointing at `origin/main` stays an operator residual.
- Do NOT weaken the A3 audit fail-closed behavior to make A1 pass — the product fix is correct; the
  simulation is what is broken.

## Simplification Review

1. **Necessary?** A/B block AC-R8; C is a measured 173k-entry, 1.37 GB resource leak.
2. **Reuse?** A1 fixes an idiom shared with `simulateBunAbsent`; C reuses the existing prefix-derivation
   grep; B reuses the existing tier runner inside a container.
3. **Guards brittle complexity?** No — it removes a destructive PATH mutation and a hand-kept prefix list.
4. **Subtracts?** One dangerous simulation, ~951 ad-hoc temp roots, one false-death heuristic, and a
   documentation premise that is actively misleading ticket closure.
