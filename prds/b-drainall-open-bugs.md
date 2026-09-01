# B-DRAINALL — every remaining open bug, composed by surface — PRD

**Branch:** `release/v2.1-beta`  **Build mode:** unattended
**Launch AFTER B-CIGREEN4 completes and its release is green.** Re-run the stale-premise check at
launch: this PRD's premises were measured 2026-09-01 and B-CIGREEN4 is still in flight.

## Scope decision — what is IN, and what is deliberately OUT

This bundle drains the open backlog. Three classes are **excluded on purpose**, and excluding them
is part of the design, not an omission:

| Excluded | Why |
|---|---|
| [[R-ORSR-2]] (recovery flips Done without the impl landing) | Done-flip / completion-evidence = **R-PSRB**. Belongs to `prds/p1-b-evidence-completion-evidence-and-done-flip-attended.md`, which runs **ATTENDED**. A worker building this fix runs under the deployed pre-fix salvage logic. |
| [[R-RWNF]] (dead review-worker path removal) | The row itself says **"attended removal, NOT pipeline"** — woven through `spawn-morty.ts` 8 sites + ~5 tests. |
| `BUG-2026-08-10-...-destroys-its-own-source-tree` | Destructive; its own bundle. It force-cleans 156 compiled modules in the REAL repo. This is the bug that produced the missing-`lib/` deploy drift on 2026-09-01. |

**Already absorbed by B-CIGREEN4 — do NOT duplicate:** [[B-ONEABORT]] residue, [[R-JUNS]],
[[R-JPCM]], [[R-FBTN]], [[R-RNTA]]. If B-CIGREEN4 closed them, these rows are done; verify at launch.

## Measured 2026-09-01 — six of these look ALREADY FIXED

The drain rule is verify-first, and ~40% of rows measured across the last two sweeps proved stale.
Pre-measurement at HEAD `f1eaa022`:

| Row | Signal found at HEAD | Expected disposition |
|---|---|---|
| [[R-ACNP]] | `services/ac-phase-gate.ts` EXISTS; `acceptance_criteria_not_checked` is a live reason (`mux-runner.ts:3529`) | likely **STALE** — the "consumer with no producer" now has a producer |
| `describe.each` AC-shape gate | `spawn-refinement-team.ts:1623-1626` already states `node:test` has no `describe.each` and routes to `tests/helpers/describe-each.js`; B-CIGREEN3 `45556cb1` fixed the advice | likely **STALE** |
| [[R-HNCG]] | `mux-runner.ts:9911-9919` writes `<ticketDir>/handoff_notes.md` **append-only, never truncates** | likely **STALE** (enforcement now exists) |
| [[B-OFFREPO]] | `spawn-morty.ts:53` names **AC-OFFREPO-1** and owns `worker_gate_not_run`; no repo-name gating found | likely **PARTIAL** |
| [[R-FOMH]] (a) | `ui-test-worker.md` is absent from **both** `.claude/commands/` and the deployed `~/.claude/commands/` | **STALE** — the Source-of-Truth violation is gone; the file no longer exists anywhere |
| row 119 / [[B-CIINT]] | MASTER_PLAN says `test:integration:serial` ships 4 inherited failures; local serial run exited **0** on 2026-09-01, and beta.24 CI's ONLY failure was the wedged-child test B-CIGREEN4 just fixed | likely **STALE or down to 0** |

**Every "likely STALE" row is a VERIFY-FIRST ticket.** Close it with a regression pin **plus a
control arm** so the pin cannot pass by never firing — the shape `1b635b4c` used for R-EROS and
`--max-iterations 0`. Do NOT "fix" something already fixed; that is how a bundle burns a ticket.

---

## Surface A — worker/ticket lifecycle economics (`spawn-morty` / `mux-runner`)

### FR-A1 (P3, [[R-TCVC]]) — the tier classifier has no signal for AC VERIFICATION cost
`classifyTicketTier` sizes on `fileCount`/`acCount`/LOC plus a 9-word keyword list. A ticket whose
ACs bundle a slow container-based verify (e.g. `test:migration`, or now `ci-repro.sh`, which builds
a Docker image) is sized identically to one with only cheap greps. Forensic origin: session
`2026-07-04-4f50b896` ticket `43e8f1a9`, 6 zero-progress spawns before salvage.
**Measured 2026-09-01: no verify-cost signal exists in `src/` — treat as OPEN, but re-confirm.**
⛔ Do NOT add a 10th keyword — a hand-maintained word list is the enumerated-set liability. Prefer a
signal derived from the AC text's own commands.
**Files (scope fence):** `extension/src/bin/spawn-refinement-team.ts` + compiled
`extension/bin/spawn-refinement-team.js`, existing classifier tests.
**Oracle available:** `~/.local/share/pickle-rick/sessions/*/*/rick_ticket_*.md` is a live corpus of
100+ real tickets — A/B the shipped classifier against it and prove no invented upward bumps.

### FR-A2 (P3, [[R-HNCG]]) — VERIFY-FIRST: handoff continuity enforcement
Measure whether `mux-runner.ts:9911` append-only `handoff_notes.md` closes the filed defect (a spawn
that runs out of turns mid-verification loses all progress memory). B-CIGREEN3's ticket dirs DID
contain `handoff_notes.md`. If closed, pin it with a control arm. If a gap remains, it is the
FALLBACK path — a spawn that dies before writing notes — not the write itself.
**Files (scope fence):** `extension/src/bin/mux-runner.ts` + compiled `extension/bin/mux-runner.js`,
existing mux-runner tests.

### FR-A3 (P1, [[B-LOGEV]]) — empty worker session logs are not evidence
Measured 2026-09-01: no empty-log guard found in `src/`. 81% of worker session logs measured EMPTY
on session `2026-08-03-2d5b3820`, and the classifier believed them. An empty artifact must be
`unknown`, never `clean`. **Replay the shipped classifier over the live log corpus** rather than
reasoning about it — a verdict that falls back to scanning the whole artifact fails open, and 60/60
real logs previously read "clean".
⛔ An empty log must NOT become a new abort condition. `unknown` parks and flags.
**Files (scope fence):** `extension/src/bin/mux-runner.ts` + compiled `extension/bin/mux-runner.js`,
existing classifier tests.

## Surface B — gate / verdict honesty

### FR-B1 (P1, [[B-OFFREPO]]) — VERIFY-FIRST then finish: the worker gate off-repo
`AC-OFFREPO-1` is present (`spawn-morty.ts:53`, `worker_gate_not_run`). Determine which of the five
filed sites are done and which remain. Report the count as measured, not as filed.
⛔ Never emit `green` from a gate that did not run — `not_run` is the honest value, and the residual
emitter already exists. Do NOT fail-closed on raw red (it deadlocks every ticket on inherited debt).
**Files (scope fence):** `extension/src/bin/spawn-morty.ts` + compiled `extension/bin/spawn-morty.js`,
existing worker-gate tests.

### FR-B2 (P2, [[B-RLH]] residue) — citadel reports findings it can never remediate
B-RLH composed R-BCFR + R-GRLS + R-JPCM. **R-BCFR and R-GRLS were closed by B-CIGREEN3**
(`d8d77e8e`, `66d1fab6`); R-JPCM is in B-CIGREEN4. What remains is the citadel half: ~43 findings
citing a "banned by CLAUDE.md rule" string that is a hardcoded literal no CLAUDE.md carries, eslint
exits 0 on every flagged file, and the changed-lines-only scan can never converge.
**Re-scope this row to the citadel half before working it.** Its two composed halves are gone.
**Files (scope fence):** `extension/src/services/citadel/**` + compiled
`extension/services/citadel/**`, existing citadel tests.

### FR-B3 (P2, row 119 / [[B-CIINT]]) — VERIFY-FIRST: integration-serial inherited failures
MASTER_PLAN claims `test:integration:serial` ships 4 inherited failures. Local serial exited 0 on
2026-09-01. Measure on **Linux via `extension/scripts/ci-repro.sh`**, not macOS — this row's whole
class is platform-divergent, and a macOS pass is not acceptance (B-CIGREEN4 FR-A1 proved that trap).
Update the row to the measured count, whatever it is.
**Files (scope fence):** `prds/MASTER_PLAN.md`; test files only if a real failure survives.

## Surface C — verify-first closures (expect most to be STALE)

### FR-C1 (P2, [[R-ACNP]]) — AC checkbox gate "consumer with no producer"
`services/ac-phase-gate.ts` exists and throws when a manifest lacks `acceptance_criteria`. Close by
measurement with a control arm, or fix the surviving gap.
**Files (scope fence):** `extension/src/services/ac-phase-gate.ts` + compiled
`extension/services/ac-phase-gate.js`, existing ac-phase-gate tests, `prds/MASTER_PLAN.md`.

### FR-C2 (capture-only) — AC-shape gate rejects DERIVED `describe.each`
The refinement template already documents that `node:test` has no `describe.each` and routes to the
repo helper. Confirm the gate accepts the DERIVED form, pin it, close the row.
**Files (scope fence):** `extension/src/bin/spawn-refinement-team.ts` + compiled
`extension/bin/spawn-refinement-team.js`, existing refinement tests, `prds/MASTER_PLAN.md`.

### FR-C3 (P3, [[R-FOMH]]) — retire the row
`ui-test-worker.md` exists in NEITHER the repo nor the deployed tree, so the Source-of-Truth
violation it describes cannot be reproduced. **Retire the row with the measurement recorded.** Do
not adopt a file that no longer exists. Check the remaining R-FOMH residuals separately.
**Files (scope fence):** `prds/MASTER_PLAN.md`.

### FR-C4 (P2, [[B-APRP]]) — re-pass queue from session `2026-07-11-255ad373`
The row queues a re-pass of two phases that did not finish in a JULY session. anatomy-park has since
run to completion many times (B-CIGREEN3 alone: 59 iterations, 20 trap doors). Determine whether the
row still describes anything real, or is superseded. Likely retire.
**Files (scope fence):** `prds/MASTER_PLAN.md`.

---

## Bundle-wide rules

- **PRIME DIRECTIVE:** no new abort condition, in any ticket. A gate may refuse a LOCAL action and
  flag a residual; it may never break the phase loop. Prefer subtraction.
- **No enumerated sets.** If a fix adds a member to a list, ask what formulation needs no list.
  This bundle exists partly because "additive accept" (B-CITAIL) scheduled the beta.24 red.
- **Verify-first rows need a CONTROL ARM.** A pin that passes because it never fires is worse than
  no pin: see "negative pin false at birth".
- Tests go in EXISTING test files — a new test file is a scope violation under `allowed_paths`.
- Tests import COMPILED JS: run `./node_modules/.bin/tsc` before believing a result. `npx tsc`
  exits 0 without typechecking.
- Platform-divergent claims are settled by `extension/scripts/ci-repro.sh`, never by a macOS pass.
- ⛔ NEVER raise the flake budget. ⛔ NEVER move CI off Node 22.

## Definition of done

Every row above is either FIXED with a pin+control, or RETIRED with the measurement that retired it
recorded in `prds/MASTER_PLAN.md`. A row closed with "looks fine" and no measurement is not done.
