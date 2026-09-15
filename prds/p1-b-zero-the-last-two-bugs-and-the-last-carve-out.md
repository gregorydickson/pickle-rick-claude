# B-ZERO — the last two bugs, and the last carve-out

**Three roots, measured at HEAD `bf031258`.** Q1 and Q2 are the only open bugs in the tracker. Q3 takes
the ratchet to its terminus: the single remaining carve-out in the tree is deleted rather than lowered.

After this the tracker is enhancements only, and no function in `src/` sits above an enforced ceiling.

**Order: Q1, Q2, Q3.** Q1 and Q2 are defects; Q3 is debt with an armed ratchet.

---

## 🚦 ROOT Q1 — a PRD named at launch is never recorded, and nothing preflights it (GitHub #27)

A run completed **all six tickets**, work committed and tree clean, then stopped at 1 of 4:

```
[06:03:56] citadel: missing state.prd_path — failing phase
[06:04:02] Pipeline finished: 1/4 phases, 254m 40s
```

The halt is CORRECT — a missing PRD is a genuine misconfiguration and the crash floor is the right
disposition. `pipeline_continue_on_phase_fail: true` does not and must not override it.

**A self-heal exists and is not broken.** `healPipelineRequiredFields` (`pipeline-runner.ts:3053`)
adopts a PRD when it can find one. Its resolver is the narrow part:

```ts
function resolveSessionPrdPath(sessionDir: string): string | undefined {
  for (const name of ['prd_refined.md', 'prd.md']) { ... }   // session dir ONLY
}
```

The failed session contained neither file, because its task named a PRD **in the repo**
(`prds/p1-….md`). Successful sessions record exactly that repo path in `prd_path` — so the field is
populated emergently, when the manager happens to also draft a session PRD, and not otherwise.

**Census of the last eight runs, all launched identically:** 1 missing, 7 set. The one-in-eight rate is
the rate at which the manager happens to draft a session PRD.

### AC-Q1 (machine-checkable)
- Q1-1: a PRD referenced by the launch task is recorded in `prd_path` **by construction** at launch, not
  emergently downstream.
- Q1-2: a launch whose phase list contains `citadel` with no resolvable PRD **fails before spawning the
  first worker**, naming what to supply. A run that cannot finish must not start.
- Q1-3 (over-trigger control): a launch with no `citadel` phase, or with a resolvable PRD, starts exactly
  as it does today. The preflight must not become a blanket gate.
- Q1-4: the existing self-heal is UNCHANGED in kind and still adopts a session-local PRD. This root adds
  a source; it does not replace one.
- Q1-5 (mutation): remove the launch-time recording; Q1-2 goes RED and Q1-3 stays GREEN.

---

## 🎲 ROOT Q2 — a tier reporting `fail 0` is not a regression (GitHub #28)

`post_final_tier_degraded:red` has withheld two runs' success verdicts. **Neither red reproduces.**

Occurrence 2 (`2026-09-14-ae80e917`), with the diagnostic tail that shipped in beta.27:

```
dimensions:  ["script failure: test:fast:parallel"]
diagnostics: "... ℹ fail 0 / ℹ skipped 3 / ℹ todo 1 / ℹ duration_ms 254138"
```

**The tier exited non-zero while reporting `fail 0`.** Re-measured minutes later on an idle box, the
same tier ran five times: `flake-budget OK failures=0 runs_completed=5 tests=9952`.

Occurrence 1 (`2026-09-12-a4d141e1`) was the same shape on the serial half and also did not reproduce
(403 tests, 401 pass, 0 fail, exit 0 standalone).

**The classifier already has the right state and does not reach it.** `mux-runner.ts:1099`:

```ts
if (gate.ok) return finalize(gate.measured ? 'green' : 'inconclusive', []);
```

`inconclusive` is reachable only on the `gate.ok` path. A non-ok gate goes straight to `red`, even when
it reports zero failures — which is an unmeasured outcome, not a measured regression.

### AC-Q2 (machine-checkable)
- Q2-1: a non-zero tier exit reporting **zero test failures** classifies `inconclusive`, not `red`.
- Q2-2 (negative control, load-bearing): a non-zero exit **with** reported test failures still
  classifies `red`. Only the zero-failure case moves.
- Q2-3: `inconclusive` still WITHHOLDS the success verdict and still records the diagnostic tail. This
  root is about naming the cause honestly, not about greening a degraded run.
- Q2-4: both recorded sessions above replay to `inconclusive` under the fix and to `red` before it.
- Q2-5 (mutation): restore the unconditional red; Q2-1 goes RED and Q2-2 stays GREEN.

**Non-goal:** do NOT attempt to eliminate the contention itself. Whether the post-final measurement
should run against a quiescent tree is a separate question and is NOT scoped here — this root stops
calling an unmeasured outcome a regression.

---

## 🏁 ROOT Q3 — delete the last carve-out

`runMuxRunnerMain` is **224 code lines, complexity 42** against ceilings of 120 and 15. It is the ONLY
carve-out in the tree still carrying figures, and `eslint src/` reports no other function over either
ceiling.

Four bundles have taken it 1690 → 892 → 449 → 224 lines and 366 → 173 → 84 → 42 complexity. This is the
last step: reach the enforced ceilings and **delete the disable entirely** rather than lowering it again.

### AC-Q3 (machine-checkable)
- Q3-1: `runMuxRunnerMain` measures **≤120 code lines and complexity ≤15** — the enforced ceilings.
- Q3-2: its `eslint-disable` is **DELETED**, not lowered. `eslint src/` passes with no directive on it.
- Q3-3: `audit-recorded-ceilings.sh` reports **zero** carve-outs carrying figures, and still passes.
- Q3-4 (behaviour): STRUCTURAL ONLY. No exit reason, disposition, activity event, ordering or state
  write may differ. Full fast and integration tiers pass unchanged.
- Q3-5: every extracted helper is itself under 120/15 and carries NO disable.
- Q3-6 (mutation): a behavioural mutation inside any extracted helper must red an existing suite. If an
  extraction is covered by nothing, SAY SO in the ticket rather than claiming it is safe.

**If ≤120/≤15 proves unreachable without changing behaviour, STOP and say so in the ticket with the
measured floor.** Lowering the recorded figures and keeping the carve-out is an acceptable outcome; a
behavioural change to hit a number is not.

---

## 🛡 PRIME DIRECTIVE compliance

Q1 adds a preflight that refuses a LAUNCH, never a running phase loop, and Q1-3 keeps it narrow. Q2
makes a verdict MORE honest while explicitly preserving the withhold (Q2-3). Q3 is the brittleness
clause reaching its terminus.

Q2 is the purest subtraction here: it removes a false attribution without removing the caution.

## Non-goals

- Do NOT let Q1's preflight fire on launches without `citadel` or with a resolvable PRD.
- Do NOT replace the existing self-heal (Q1-4).
- Do NOT green a degraded run in Q2; `inconclusive` still withholds.
- Do NOT address post-final contention itself; out of scope by design.
- Do NOT change behaviour to reach Q3's numbers. Stop and report the floor instead.
