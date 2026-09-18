# B-INVENTED — instruments that report a state they never measured

**Bundle thesis:** each root is one shape — *a decision point emits a status its own inputs cannot
support.* The microverse judge scores function size against a ceiling nobody gave it; `recordStall`
writes a constant cause for three different stalls and `deriveStallCause` faithfully reports the
fabrication; `install.sh` reports a decline to deploy as a successful deploy. Root `CLAUDE.md` clause 6:
the defect is in the INSTRUMENT, not the logic.

**This PRD was refined against a 3-role × 3-cycle analyst pass and two of its four original roots were
cut or rescoped by measurement.** Recorded here because the cuts are the substance:

- **The original I1 was an ADDITION.** It routed a worker to build a new reader of `eslint.config.js`
  inside `buildJudgePrompt`. That derivation **already exists twice** — `enforcedSizeCeilings()`
  (`tests/szechuan-sauce.test.js:206`) and the `audit-recorded-ceilings.sh` gate leg. A third reader is
  precisely the divergence clauses 1–2 forbid. The real gap is narrower and is a **wiring** gap.
- **The original I4 (#29) was already satisfied** and is closed. `driveMuxRunnerMain`
  (`src/bin/mux-runner.ts:16431`) is exported and drives the real loop;
  `tests/mux-runner-main-loop-behaviour.test.js:145` calls it. My grep matched the loop's name, not the
  wrapper's, and a symbol-liveness grep is not a capability measurement.

| root | kind | source | surface | verification host |
|---|---|---|---|---|
| **I1** the microverse judge never receives the enforced ceiling | fix (wiring) | #32 Cause A | `src/bin/microverse-runner.ts` | `tests/szechuan-sauce.test.js` |
| **I2** one stall cause is written as a constant for three stalls | fix | #32 Cause B | `src/services/microverse-state.ts` | `tests/microverse-disposition-map.test.js` |
| **I3** `install.sh` exits 0 on a refusal to deploy | fix | #40 | `install.sh` | `tests/install-script-real.test.js` |

**All commands run from `extension/`.** Repo-wide legs apply to every root:
`./node_modules/.bin/tsc --noEmit` · `./node_modules/.bin/tsc` · `./node_modules/.bin/eslint src/ --max-warnings=0`.

---

## 🚧 ROOT I1 — the enforced ceiling reaches one judge and not the other (#32 Cause A)

Session `2026-09-12-a4d141e1` scored `6` against `baseline_score: 2` and reverted. The judge's six
violations cite **"the 50-line hard limit"** four times. **This repo has no 50-line limit** — the
enforced ceiling is `max-lines-per-function` in `extension/eslint.config.js`, 120 code lines. Strip the
4 of 6 flagged functions under 120 and the score is **2**, equal to baseline, so `compareMetric` returns
`held` and the revert never happens. **The judge's measurements were accurate; only the threshold was
invented.**

**The derivation already exists and is already gated — do NOT build another.**
- `enforcedSizeCeilings()` (`tests/szechuan-sauce.test.js:206`) imports `eslint.config.js` directly and
  returns `{ options, overrides }`, asserting the base entry exists rather than defaulting.
- M4-1 (`:239`) asserts `szechuan-sauce-principles.md` states the ceiling **derived from the config**,
  and loops every per-file override asserting both number and filename appear.
- M4-4 (`:253`) scans `STALE_SIZE_LIMIT_RE` (`:199`) across every principles asset, every
  `.claude/commands/*.md` and root `CLAUDE.md`, with a vacuity guard.
- `scripts/audit-recorded-ceilings.sh` reads rule options from the project config and **fails when they
  are absent rather than defaulting**.

**The residual gap is wiring.** `grep -n "principles" src/bin/microverse-runner.ts` returns **nothing**.
`buildJudgePrompt` (`:2062`) assembles `parts: string[]` and never loads the asset carrying the derived
ceiling. The consumer that does is `pipeline-runner.ts:2699`
(`buildSzechuanJudgeContext(sessionDir, principlesPath, ...)`). **The szechuan judge gets the ceiling;
the microverse judge does not.** The asset ships in the deployed runtime.

**M4-4's corpus scans assets and command files — it does not scan the assembled prompt string.** That is
why a green M4-4 coexists with a judge inventing a limit.

### Interface Contracts — I1
- **Input:** the existing maintained asset (`szechuan-sauce-principles.md`) reached the way
  `pipeline-runner.ts:2699` already reaches it. **No new read of `eslint.config.js`.**
- **Output:** the assembled microverse judge prompt, carrying the ceiling the asset states.
- **Errors:** a missing asset degrades to "no ceiling stated" — it must not throw into the judge path
  and must not substitute a default.
- **Invariant:** the ceiling in the prompt is the one the linter enforces, or no ceiling is stated.
  There is no third case, and no number is written into the prompt builder.

### AC-I1
- [ ] **AC-I1-1 (executable, FALSE at HEAD):** the assembled microverse judge prompt carries the
  enforced function-size ceiling, sourced from the existing asset rather than a literal or a new config
  read — Verify: `node bin/test-runner.js tests/szechuan-sauce.test.js --test-concurrency=1` — Type: test
- [ ] **AC-I1-2 (subtraction proof, REQUIRED):** `grep -c "eslint.config" src/bin/microverse-runner.ts`
  returns 0 — the fix adds no third reader of the config — Verify:
  `grep -c "eslint.config" src/bin/microverse-runner.ts` returns 0 — Type: lint
- [ ] **AC-I1-3 (over-trigger control, REQUIRED):** M4-4's `STALE_SIZE_LIMIT_RE` corpus is extended to
  include the **assembled prompt string**, and the extension is shown to fire — inject a "50-line hard
  limit" string into the prompt and show the suite reds, then remove it and show it greens — Verify:
  `node bin/test-runner.js tests/szechuan-sauce.test.js --test-concurrency=1` — Type: test
- [ ] **AC-I1-4:** a missing asset yields a prompt stating no ceiling, not a fabricated one — Verify:
  `node bin/test-runner.js tests/szechuan-sauce.test.js --test-concurrency=1` — Type: test
- [ ] Typecheck, build and lint pass — Verify: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc && ./node_modules/.bin/eslint src/ --max-warnings=0` — Type: typecheck

### Test Expectations — I1
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-I1-1 | `tests/szechuan-sauce.test.js` | assembled microverse prompt | contains the ceiling the asset states |
| AC-I1-2 | `tests/szechuan-sauce.test.js` | no new config reader | `microverse-runner.ts` never imports `eslint.config.js` |
| AC-I1-3 | `tests/szechuan-sauce.test.js` | M4-4 corpus widened to the prompt | an injected "50-line hard limit" reds the suite |

---

## 🚧 ROOT I2 — a constant written where a measurement was in hand (#32 Cause B)

Session `2026-09-15-c5a7eb48`: `stall_counter` **5/5**, `convergence.history` **empty**.
`recordIteration` (`src/services/microverse-state.ts:378`) appends history and increments together, so a
full counter with empty history means every increment came from `recordStall` (`:410`).

**The precise defect, and it is a collapse rather than an addition.** `recordIteration` writes
`last_stall_signal: classification` (`:400`) — a **variable**. `recordStall` writes
`last_stall_signal: 'no-commit'` (`:417`) — a **constant**. The field can already carry a cause; only
this writer refuses to. And the caller already computed one: `microverse-runner.ts:5421` calls
`classifyStall(...)` with a `noCommitClass` (`:1815`) and **discards it before persistence**. The
information loss is at the *write*, with the value in scope — the same shape as #33 and #35.

**The population is THREE causes, not two** (the original PRD said two; measured at the callsites):

| callsite | context | cause |
|---|---|---|
| `microverse-runner.ts:892` | `gateMode === 'strict'`, after `iteration_regressions++`, emits `strict_mode_red` | a strict-mode red |
| `microverse-runner.ts:4668` | `recordMetricMeasurementFailure` — *"Metric measurement failed twice"* | metric unmeasurable |
| `microverse-runner.ts:5421` | *"No commits made — stall (no rollback)"* | no commits |

**The read side must move with the write side.** `deriveStallCause` (`:553`) returns
`signal ?? (history.length === 0 ? 'no-commit' : 'unknown')` and its docblock claims the cause is
*"derived from ONE field … set live by `recordIteration`/`recordStall` on every call"* — but since
`recordStall` hardcodes `'no-commit'`, it **can never report `metric-unmeasurable`: no producer can
write it.** The fabricated cause is persisted as `stall_disposition` (`types/index.ts:1887`) and stamped
at `microverse-runner.ts:5321`, so it is durable, not transient. Widening the producer without the
consumer ships a writer that can express three causes into a reader that still collapses them.

**NOT in scope:** why the worker produced no commits in iterations of 61s/33s/31s/28s. That is a
worker-productivity question. This root only makes the stall path able to say which branch it took.

### Interface Contracts — I2
- **Input:** `recordStall(state, cause)` where `cause` is a typed union over the **three** measured
  callsites, not a free string. At HEAD the signature is `recordStall(state: MicroverseSessionState)`
  with no cause parameter at all.
- **Output:** persisted state whose `last_stall_signal` reflects the callsite that fired, and a
  `deriveStallCause` that reports it.
- **Errors:** an unrecognised cause is a compile-time type error, never a runtime default.
- **Invariant:** `stall_counter` arithmetic is unchanged and the limit fires at the same iteration.
  This is a widening of what is *recorded*, not a change to what *happens*.

### AC-I2
- [ ] **AC-I2-1 (executable, FALSE at HEAD):** the three stall callsites are distinguishable **from
  persisted state alone**, with no log parsing — Verify:
  `node bin/test-runner.js tests/microverse-disposition-map.test.js --test-concurrency=1` — Type: test
- [ ] **AC-I2-2 (read-side half, REQUIRED):** `deriveStallCause` reports `metric-unmeasurable` for a
  state written by the `:4668` callsite. At HEAD this is **unreachable** — assert it is reachable
  after the fix — Verify:
  `node bin/test-runner.js tests/microverse-disposition-map.test.js --test-concurrency=1` — Type: test
- [ ] **AC-I2-3 (over-trigger control, REQUIRED):** stall arithmetic is unchanged — a run that stalls N
  times reaches the limit at the same iteration as before — Verify:
  `node bin/test-runner.js tests/microverse-convergence.test.js --test-concurrency=1` — Type: test
- [ ] **AC-I2-4:** state written **after** `last_stall_signal` existed but **before** the new cause
  members still loads and derives without guessing. *(Do NOT re-point this at pre-field legacy state —
  that case is already pinned at `tests/microverse-disposition-map.test.js:383` and asserting it again
  is vacuous.)* — Verify:
  `node bin/test-runner.js tests/microverse-disposition-map.test.js --test-concurrency=1` — Type: test
- [ ] Typecheck, build and lint pass — Verify: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc && ./node_modules/.bin/eslint src/ --max-warnings=0` — Type: typecheck

### Test Expectations — I2
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-I2-1 | `tests/microverse-disposition-map.test.js` | three stalls, three callsites | three distinct persisted causes |
| AC-I2-2 | `tests/microverse-disposition-map.test.js` | metric-failure stall | `deriveStallCause` reports `metric-unmeasurable` |
| AC-I2-3 | `tests/microverse-convergence.test.js` | N stalls to the limit | limit fires at the same N |

---

## 🚧 ROOT I3 — `install.sh` reports a refusal as success (#40)

Measured with the exit code captured directly:

```
$ bash install.sh --allow-downgrade < /dev/null; echo "EXIT=$?"
Downgrade 2.2.0-beta.1 → 2.1.1 — proceed? [y/N] EXIT=0
$ grep -m1 '"version"' ~/.claude/pickle-rick/extension/package.json
  "version": "2.2.0-beta.1",     # unchanged — nothing was deployed
```

`install.sh:207` does `IFS= read -r answer || true`; EOF leaves `answer` empty, the `[y/N]` default
declines, and `:209` does `exit 0`. **Both sibling refusals in the same chain exit non-zero** — `:225`
exits 1 (source older than deployed), `:200` exits 2 (active session). Only the decline claims success,
so a caller cannot separate *deployed* from *declined to deploy*, and the runtime then executes stale JS
invisibly.

**Prefer the subtraction:** make the three refusals agree in sign rather than adding a fourth state.

**The verification host had to move, and this is the whole reason the row is specified this way.**
`tests/install-script.test.js` is `// @tier: fast` and its downgrade coverage runs a generated fixture
(`buildVersionGuardFixtureScript`, `:96`) that contains **no `handle_allowed_downgrade`, no prompt, no
`exit 0`** — it cannot execute this defect. The suites that spawn the real script,
`tests/install-script-real.test.js` and `tests/install-script-prefix.test.js`, are both
`// @tier: integration`. **Verify against the real-script host.**

**No source-text pin covers the decline's `exit 0`.** The pins at `install-script.test.js:582-635` cover
`--override-active`, `--closer-context`, the active-session REFUSE string, the `DOWNGRADE` audit event,
`deploy-audit.log`, the R-ITS-5-MIN banner and a guard-ordering assertion. So this fix reds no existing
pin; the risk is only that the wrong host cannot observe it.

### Interface Contracts — I3
- **Input:** `install.sh` argv (`--allow-downgrade`, `--no-confirm`, `--prefix`) and stdin — a TTY, a
  pipe, or closed.
- **Output:** exit status, and the deployed tree under the resolved prefix.
- **Errors:** every refusal in this chain exits non-zero; `:200`, `:225` and the decline at `:209` agree
  in sign.
- **Invariant:** **exit 0 from `install.sh` means a deploy happened.** There is no path where it does not.

### AC-I3
- [ ] **AC-I3-1 (executable, FALSE at HEAD):** `install.sh --allow-downgrade` with non-TTY stdin exits
  **non-zero** and deploys nothing — Verify:
  `node bin/test-runner.js tests/install-script-real.test.js --test-concurrency=1` — Type: integration
- [ ] **AC-I3-2 (over-trigger control, REQUIRED):** `--allow-downgrade --no-confirm` still exits 0
  **and** deploys — assert the deployed `package.json` version actually changed, not merely that the
  exit code is 0. A fix that reds the working path is worse than the defect — Verify:
  `node bin/test-runner.js tests/install-script-real.test.js --test-concurrency=1` — Type: integration
- [ ] **AC-I3-3:** an interactive `y` proceeds; an interactive `n` exits non-zero — Verify:
  `node bin/test-runner.js tests/install-script-real.test.js --test-concurrency=1` — Type: integration
- [ ] Typecheck, build and lint pass — Verify: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc && ./node_modules/.bin/eslint src/ --max-warnings=0` — Type: typecheck

**Test against a `--prefix` sandbox, never the real `~/.claude/pickle-rick`.**
`tests/install-script-prefix.test.js` already establishes that pattern — follow it.

### Test Expectations — I3
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-I3-1 | `tests/install-script-real.test.js` | decline via closed stdin | exit non-zero AND prefix version unchanged |
| AC-I3-2 | `tests/install-script-real.test.js` | `--no-confirm` | exit 0 AND prefix version equals source version |
| AC-I3-3 | `tests/install-script-real.test.js` | `n` piped to stdin | exit non-zero |

---

## NOT in Scope
- Why the worker produced no commits in `2026-09-15-c5a7eb48`.
- #5 (architecture enhancement).
- Exporting `runMuxRunnerMain` — #29 is closed as already satisfied by `driveMuxRunnerMain`.
- Any new release-gate leg. Each root widens an existing suite; none earns a new leg under the four
  questions in root `CLAUDE.md`.

## Exit State
Three instruments can each express the state they actually observed, each pinned by a test with an
over-trigger control, and no root added a second reader of anything.

---

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | `ac36d450` | Wire the enforced ceiling into the microverse judge prompt | High | clean tree | prompt carries the ceiling, no new config reader | `src/bin/microverse-runner.ts`, `tests/szechuan-sauce.test.js` |
| 20 | `74e6feef` | Extend the stale-size-limit corpus to the assembled prompt | High | `ac36d450` done | M4-4 scans runtime output, control falsified both ways | `tests/szechuan-sauce.test.js` |
| 30 | `8255fa22` | Carry the measured stall cause through recordStall and deriveStallCause | High | clean tree | three causes written and reportable | `src/services/microverse-state.ts`, `src/bin/microverse-runner.ts`, 2 suites |
| 40 | `6955c947` | Make the declined downgrade in install.sh exit non-zero | High | clean tree | exit 0 means a deploy happened | `install.sh`, `tests/install-script-real.test.js` |
| 50 | `10c37f01` | Wire: verify the three instruments end to end | High | 10-40 done | all four suites green together | all bundle files |
| 60 | `b098d7f2` | Harden: code quality review | High | 50 done | zero P0-P1 | all bundle files |
| 70 | `d44a2d45` | Audit: data flow integrity | High | 60 done | zero CRITICAL+HIGH | all bundle files |
| 80 | `2837d9ba` | Harden: test quality review | High | 70 done | every AC mapped, every control falsified | 4 test files |
| 90 | `74e6fef0` | Audit: cross-reference consistency | High | 80 done | every cited line number verified | doc files |
