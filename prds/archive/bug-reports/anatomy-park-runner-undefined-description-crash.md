# Anatomy-Park Runner — `Cannot read properties of undefined (reading 'description')` FATAL

**Status**: Draft (P1) — halts pipeline before szechuan-sauce; reproduces on a separate code path from the gate-baseline-missing P1 (`anatomy-park-gate-baseline-missing.md`)

**Severity**: P1 — every `/pickle-pipeline` run that reaches anatomy-park is at risk; szechuan-sauce never gets a turn.

## Symptom

```
[2026-05-01T20:50:57.183Z] Iteration 2 — worker convergence: not yet
[FATAL] Cannot read properties of undefined (reading 'description')
[2026-05-01T20:50:58.209Z] Phase anatomy-park exited with code 1
[2026-05-01T20:50:58.210Z] Phase anatomy-park failed (exit 1) — stopping pipeline
```

Exit code 1 from `microverse-runner.ts` (anatomy-park is dispatched via microverse-runner with `command_template: anatomy-park.md`). The FATAL is emitted by the global error catcher at `pipeline-runner.ts:1560` which received the crash via the per-phase child-process exit reporting.

## Reproduction (concrete, observed once)

- Repo: `loanlight-api` @ branch `feat/dscr-agent-v1`
- Invocation: `/pickle-pipeline prd.md --backend codex` (the DSCR Agent v1 hardening PRD, 11 atomic tickets, see `loanlight-api/prd.md` at the time of the run; PR #1229)
- Pipeline session: `2026-05-01-a78affa6` (preserved at `~/.local/share/pickle-rick/sessions/2026-05-01-a78affa6/`)
- Pickle phase: ✓ shipped 11 commits in 102m (codex backend)
- Citadel: ✓ wrote `citadel_report.json` with 1 LOW finding (`anatomy-park:missing` — anatomy-park hadn't run yet)
- Anatomy-park: discovered 1 subsystem (`packages`), iter 1 fixed 1 HIGH (DSCR lease-date-prefill TZ bug, commit `5af9a661`), iter 2 was clean (`pass_counts.packages=2`, `consecutive_clean.packages=1`), iter 3 crashed inside microverse-runner before reaching the next subsystem rotation or convergence checkpoint.
- `anatomy-park.json` at crash time:
  ```json
  {
    "subsystems": ["packages"],
    "current_index": 0,
    "pass_counts": {"packages": 2},
    "consecutive_clean": {"packages": 1},
    "stall_counts": {"packages": 0},
    "stall_limit": 3,
    "converged": false,
    "reason": "packages clean pass 1/2; continuing rotation"
  }
  ```
  Note `consecutive_clean=1` — convergence requires ≥2 clean passes per the protocol — so iter 3 was launched correctly; the crash occurred inside the iteration before convergence could be re-evaluated.

## Distinguishing from the gate-baseline P1

`prds/archive/bug-reports/anatomy-park-gate-baseline-missing.md` (queue slot #1) covers a different failure: anatomy-park exits at iter 2 because `gate/` directory is missing on disk despite the gap-analysis log claiming baseline-initialized. That bug has a deterministic ~1-second strict-mode-fallback exit signature.

This bug is different:
- Crash happens at iter **3** (this case), not iter 2.
- Stack includes the literal string `Cannot read properties of undefined (reading 'description')` — gate-baseline bug does not.
- `gate/` directory **exists** and is populated on this session (`ls gate/` shows files).
- The 1 HIGH finding from iter 1 was successfully fixed and committed (`5af9a661`) — gate-baseline failures don't get that far.

So this is a NEW P1 alongside the gate-baseline one, not a duplicate.

## Suspected sites in `microverse-runner.ts`

`grep -n "\.description" extension/src/bin/microverse-runner.ts`:

| Line | Expression | Crash if … |
|---|---|---|
| `902` | ``parts.push(`- Iteration ${entry.iteration}: score=${entry.score} action=${entry.action} — ${entry.description}`)`` | `entry` is undefined (template-literal interpolation of `undefined.description`) |
| `1063` | ``${mvState.key_metric.description}`` | `mvState.key_metric` is undefined — **likely root cause**, anatomy-park does not have a `key_metric` (that's a microverse-only concept) |
| `1084` | ``score=${entry.score} action=${entry.action} — ${entry.description}`` | same as 902 |
| `1188` | ``${mvState.key_metric.description}`` | same as 1063 |
| `1202` | `history.map(h => \`| ${h.iteration} | ${h.score} | ${h.action} | ${h.description} |\`)` | `h` undefined would error on `iteration`, not `description` — unlikely site |
| `1523` | `entry.description` | `entry` undefined |

Templating into a **`undefined`** value yields the literal string `"undefined"`, NOT a TypeError. Therefore the crash is on `undefined.description` — accessing `.description` on an undefined object. The high-probability site is `mvState.key_metric.description` at line `1063` or `1188`. Anatomy-park sessions don't populate `key_metric`, so when one of these branches runs in anatomy-park mode, the access throws.

The "Iteration 2 — worker convergence: not yet" message comes from `microverse-runner.ts:640`, immediately followed by `runPerIterationGateHook(...)` (line `646`). The gate hook or downstream code paths are the likely caller of the failing `.description` reference.

## Proposed work

### AC-APRC-01 — Reproduce in isolation
- Spawn microverse-runner with `command_template = anatomy-park.md` and a manifest containing `key_metric: undefined` (or simply absent).
- Drive it through one iteration that ends with `worker convergence: not yet`.
- Assert: process exits 1 with the FATAL message.
- Without the fix: passes (reproducer confirmed). With the fix: assertion inverted to assert clean exit / next-iteration spawn.

### AC-APRC-02 — Guard `mvState.key_metric` access
- Branch the runner so `key_metric.*` accesses are conditional on `command_template`. In anatomy-park mode, do not consume microverse-specific fields. Lift the field accesses into a helper that returns a default string (`"(no key metric)"`) when `key_metric` is absent.
- File: `extension/src/bin/microverse-runner.ts` lines `1063`, `1188`, plus any nearby parts of the prompt-building helper (audit the function those lines live in).

### AC-APRC-03 — Defensive guards on iteration history accesses
- Lines `902`, `1084`, `1523`: filter `history` to drop `undefined`/`null` entries before iterating, OR add a `.filter(Boolean)` upstream where `history` is read from disk in `readRecoverableJsonObject(...)` (consistent with how `1202` already iterates with `.map`).
- This is defense-in-depth; the primary fix is AC-APRC-02.

### AC-APRC-04 — Add anatomy-park integration test
- New file: `extension/tests/integration/anatomy-park-microverse-runner-no-key-metric.test.js`.
- Spin up a session with anatomy-park manifest, stub microverse-runner to one iteration, assert no `Cannot read properties` error reaches the parent pipeline-runner. Lock the regression.

### AC-APRC-05 — Trap-door entry in `extension/CLAUDE.md`
- Pattern shape: `mvState\.key_metric\.\w+|entry\.description` accessed without an upstream existence check in `microverse-runner.ts`.
- Guard: parametrized lint or jest fixture ensuring all such accesses go through a helper that handles the absent-`key_metric` (anatomy-park) case.

### AC-APRC-06 — Pipeline resumability after anatomy-park crash
- Today an anatomy-park exit-1 halts the entire pipeline; szechuan-sauce never runs. Even after AC-APRC-02 ships, the pipeline-runner should be resilient: if `command_template === anatomy-park.md` and the runner crashes with a known error class (TypeError on `.description`), surface a structured `phase_skipped_with_warning` rather than `phase_failed`, allowing szechuan-sauce to proceed against the post-pickle HEAD.
- Decision-required for the team: do we want anatomy-park failures to halt the pipeline, or to degrade gracefully so szechuan-sauce still runs? The ergonomics argue for graceful degradation; the correctness argument is that a missed HIGH finding without anatomy-park converging is a real risk.
- Recommend: graceful degrade with an explicit `pipeline.json.fail_fast: true` flag for users who want strict mode.

## Estimated scope

~150–250 LOC across `microverse-runner.ts` (guard + helper extraction), one integration test, one trap-door catalog entry, one MASTER_PLAN row update. Roughly 5 atomic tickets (T0–T4 above plus the optional T5 graceful-degrade).

## Cross-references

- Sibling P1: `prds/archive/bug-reports/anatomy-park-gate-baseline-missing.md` (different failure mode, same blast radius).
- Tracking session evidence: `~/.local/share/pickle-rick/sessions/2026-05-01-a78affa6/`.
- The DSCR Agent v1 hardening that triggered this: PR https://github.com/loanlight-engineering/loanlight-api/pull/1229 (merged-status pending; pickle phase shipped fine, this bug only blocked anatomy-park + szechuan).

## Session Notes

- Pipeline ran 111m wall (102m pickle + 1.3s citadel + 9m anatomy-park-until-crash + 0s szechuan-never-ran).
- Worktree clean at branch HEAD `5af9a661` after the run.
- Stop hook spam after the crash: orphaned ghost session `2026-05-01-9cebfe74` had `active: true, pid: none` — cleared manually. Live `2026-05-01-bfa25a4b` mux-runner (PID 82009, working in `pickle-rick-claude` repo on the gate-baseline PRD) was unrelated and left running.
