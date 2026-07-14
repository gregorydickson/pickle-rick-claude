---
title: "B-RLH — Review-loop honesty: the review phases must not report success they did not earn"
priority: P2
finding: B-RLH
status: open
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
composes:
  - "p2-bug-fix-bundle-r-bcfr-banned-construct-fabricated-rule.md"
  - "p2-bug-fix-bundle-r-grls-gate-remediator-lock-strand.md"
  - "p2-bug-fix-bundle-r-jpcm-judge-prompt-parser-contract-mismatch.md"
depends_on: "none (deploy-agnostic BUILD; pipeline-safe — see Routing)"
source_assessment: "All three surfaced in ONE live pipeline run (session 2026-07-11-255ad373) and were each verified against source, not inferred. Field evidence in the composed PRDs."
---

# B-RLH — the review loop is lying about its own work

## Thesis (one sentence)

Three independent defects, one shape: **a review phase reports success it did not earn.**

- **[[R-BCFR]] — citadel reports work it can never do.** The `banned-construct` arms cite a rule
  (`"is banned by CLAUDE.md"`) that exists in **no** CLAUDE.md — the string is a hardcoded literal at
  `banned-constructs-audit.ts:129`. eslint configures no `curly` rule and exits 0 on every flagged file;
  brace-free `if` is the house style, including **inside the analyzer enforcing the ban**; and the scan
  reads changed diff lines only, so it **cannot converge**. Live cost: 3 citadel cycles → **43 findings,
  0 remediated**, and the remediator refused twice (`loop_detected: true`) — correctly.
- **[[R-GRLS]] — the gate remediator reports a red gate as handled.** Its hand-rolled lock writes **no
  payload** and cleans up only via `process.on('exit')` (which SIGKILL skips); on `EEXIST` it returns
  `{ok: false, exitCode: 0}` — it exits **clean** having remediated nothing. One abrupt death strands the
  lock and every later remediator is a silent no-op indistinguishable from success. A **false-GREEN gate.**
- **[[R-JPCM]] — szechuan reports "converged" when it stalled blind.** `buildJudgePrompt:1658` demands
  *"Output ONLY a single integer"*; `parseLlmJudgeOutput:1771` `JSON.parse`s it and expects
  `{score, violations[]}`. The bare number fails the object parse, so `violations` is **always empty**
  (5 × `judge_json_parse_failed` in one session), the ledger stays `[]`, `compareMetric` can never take the
  R-SLLJ-4 set-ops branch, and five real landed fixes scored `held: 4 vs 4`. The phase exited
  `status: "converged"` at score 4 against a target of 0.

This is the **honesty** half of the GA bar. A review phase that cannot fail is not a review phase.

## Why these three together

They are one thesis, and they do not contend: the fixes touch **disjoint files** —
`services/citadel/banned-constructs-audit.ts`, `bin/spawn-gate-remediator.ts`, and
`bin/microverse-runner.ts`. Each is subtract-or-reuse, not new machinery. See each composed PRD for the
full root cause, workstreams, machine-checkable ACs, and its own `## Simplification Review`.

## Workstreams

Refine **one ticket per workstream** (five); do NOT collapse them into an umbrella ticket.

| WS | Finding | Shape | Composed PRD |
|---|---|---|---|
| WS-1 | [[R-BCFR]] | **pure subtraction** — delete the `isBraceFreeIf` arm; verify-then-delete the `isNestedTernary` sibling (same fabricated citation). **The module itself SURVIVES** (`banned-casts-audit.ts:3-8` imports four helpers from it) — delete the ARMS + their wiring, and subtract the now-empty mechanical floor/classifier/bypass with them | `p2-bug-fix-bundle-r-bcfr-banned-construct-fabricated-rule.md` |
| WS-2 | [[R-GRLS]] | **reuse, not new machinery** — route the 4th lock through the three primitives that already exist (`acquireLockFile` / `reclaimDeadGateLock` / `releaseLockFile`); a lockout must not READ as a remediation — **including at the three callers that today read a lockout as success** | `p2-bug-fix-bundle-r-grls-gate-remediator-lock-strand.md` |
| WS-3 | [[R-JPCM]] | **make the prompt ask for the shape the parser already parses** — no new code path; the parser, ledger writer, set-ops branch, and prior-violations block are all already built and wired | `p2-bug-fix-bundle-r-jpcm-judge-prompt-parser-contract-mismatch.md` |
| **WS-4** | **stall≠success** | **reuse** — `isConverged` returns the same `true` for "gave up" as for "hit the target"; mirror anatomy-park's shipped `anatomy_non_convergent` disposition. **This, not the judge, is what reported `converged` at score 4 vs target 0** | *(this PRD — see Amendment)* |
| **WS-5** | **the dead fail-stop** | **decide: subtract or wire** — `ac-phase-manifest.json`, the pipeline's ONLY quality fail-stop, has zero producers anywhere and fail-opens to `pass`. It has never fired | *(this PRD — see Amendment)* |

**Note for WS-2:** the shared lock primitives changed under R-LSPC-2 (`acquireLockFile` now returns a
`LockHandle {ino, raw}`; identity is `sameLock` — inode AND bytes, never the inode number alone, because
ext4 recycles it). Reuse them **as they are now**; do not reintroduce an inode-number comparison.

**Note for WS-2 (blast radius — added 2026-07-14):** the fix cannot live inside `acquireLockfile` alone. On a
stranded lock the remediator prints `LOCKOUT_PATH=` instead of `BRIEF_PATH=` (`spawn-gate-remediator.ts:257-261`),
and **all three callers check only for `BRIEF_PATH`** and, on its absence, log a line and return early WITHOUT
signalling failure — `pipeline-runner.ts:2560-2563` (bare `return;`, the loop continues, the phase still exits 0),
`finalize-gate.ts:258-262` (`return null`), `microverse-runner.ts:302-304`. **No caller reads `LOCKOUT_PATH` at
all** — it is written and never consumed. A correctly-reclaiming lock still leaves three callers that cannot
distinguish "remediated" from "did nothing." The ticket MUST add the caller-side assertions.

---

## ▶ AMENDMENT (2026-07-14) — two workstreams added; the bundle as originally scoped SHIPS GREEN AND LEAVES THE FIELD BUG REPRODUCING

A pre-launch review (39-agent audit, all citations verified against source AND the deployed tree) found the
bundle's thesis correct and all three children still open at the exact cited lines — but found the bundle
**insufficient to satisfy its own thesis**. Two defects sit *underneath* the three children. Without them, the
review loop still cannot fail, and WS-3 in particular passes its acceptance test while changing nothing the
field would notice.

### WS-4 — the convergence check conflates STALLED with SUCCEEDED (the defect *under* R-JPCM)

`isConverged` (`services/microverse-state.ts:391`) returns the **same bare `true`** for stall-exhaustion as for
target-reached:

```ts
if (state.convergence.stall_counter >= state.convergence.stall_limit) return true;   // :391  — GAVE UP
// ... and the target-reached branch at :394-399 also returns true                    — SUCCEEDED
```

In `handleMetricMode`, `targetHit` (`score === convergence_target`) **is** computed (`microverse-runner.ts:4165-4167`)
— and then consumed **only inside a template literal to pick a log string** (`:4168`). The function returns
`'converged'` unconditionally (`:4169`). `MicroverseExitReason` (`types/index.ts:1279-1284`) carries no
stalled-below-target member.

**This — not the judge contract — is what produced `status: 'converged'` at score 4 against `convergence_target: 0`.**
**A perfect judge changes nothing here.** Fixing R-JPCM without WS-4 buys a populated ledger attached to a phase
that still declares victory when it gives up.

**Shape: pure reuse — the honest disposition already exists one type-union away.** anatomy-park got exactly this
treatment in B-APNC: `anatomy_non_convergent` (`types/index.ts:1284`) → `run-finalize-gate-incomplete` → a
non-fatal, honest halt (`pipeline-runner.ts:4048-4052`). Mirror it. ~30 LOC, no new machinery.

- `AC-RLH-2`: `MicroverseExitReason` carries `stalled_below_target`.
- `AC-RLH-3`: `isConverged` returns a discriminated result (`{ reason: 'target_reached' | 'stall_limit' }`), not a
  bare boolean; every caller is updated.
- `AC-RLH-4`: `handleMetricMode` returns `stalled_below_target` when `convergence_target != null && !targetHit`,
  and `converged` **only** on target-reached. A regression test drives a stall-exhausted run at a score above
  target and asserts the disposition is NOT `converged`.

### WS-5 — the ONLY gate that can halt the pipeline on a quality verdict reads a file that NOTHING WRITES

`runAcPhaseGate` is the sole quality verdict with the power to stop the run: `pipeline-runner.ts:4021` calls it
and `:4029-4032` does `log('Phase X AC gate failed — stopping pipeline'); return { action: 'break' }`.

It reads `<sessionDir>/ac-phase-manifest.json` (`services/ac-phase-gate.ts:197`) — and on a **missing** manifest
returns `{ status: 'pass' }` (`:198-200`). **Fail-open.**

The string `ac-phase-manifest` appears **exactly once in the entire repository**: its own constant declaration at
`services/ac-phase-gate.ts:9`. Zero producers in `src/`, zero in `tests/`, zero in `.claude/commands/`.
`find ~/.local/share/pickle-rick/sessions -name 'ac-phase-manifest.json'` returns **nothing** — no session has
ever produced one. **The gate has never fired. It evaluates zero criteria and returns `pass` on every run that
has ever executed.**

**Decide, don't leave it.** Two honest options; the ticket must pick ONE and justify it:

- **(a) SUBTRACT** — delete `runAcPhaseGate` + `ac-phase-gate.ts` as a never-fired guard. This is exactly the
  R-CCNW-2 / R-RWNF discipline the repo already enforces (an on-disk-but-uninvoked analyzer is forbidden).
- **(b) WIRE** *(preferred — highest-value single wire in the codebase)* — have refinement persist the PRD's
  **already-required** machine-checkable acceptance criteria into `<sessionDir>/ac-phase-manifest.json`. The input
  already exists (the PRD interview requires machine-checkable ACs; root `CLAUDE.md`) and is simply never written.
  This converts the PRD's own ACs into the pipeline's one real fail-stop. Make a missing manifest **fail closed**
  once a producer exists.

- `AC-RLH-5`: either `grep -rc "ac-phase-manifest" extension/src/` == `0` (option a, gate + module deleted, wiring
  test green), **or** a producer exists, a real session emits a non-empty manifest, and a missing manifest
  fail-CLOSES (option b). A PR that leaves a fail-open gate with zero producers satisfies NEITHER.

### Corrections to the child PRDs (apply during refinement)

- **R-BCFR — "delete the module" is UNBUILDABLE as written.** `banned-constructs-audit.ts` is a shared-helper host:
  `services/citadel/banned-casts-audit.ts:3-8` imports four helpers from it. `AC-BCFR-8` must be re-scoped to
  "delete the two fabricated ARMS and their wiring; the module survives iff another analyzer still imports its
  helpers." Additionally, emptying `MECHANICAL_FINDING_MATCHERS` (its only entry is
  `banned-construct:brace-free-if`) makes `mechanicalEnabled` and the whole branch at `pipeline-runner.ts:2650-2679`
  dead — **subtract the mechanical floor, the classifier, and the `skip_quality_gates_reason` bypass together**,
  rather than leaving an auto-armed skip flag pointing at an empty matcher set.
- **R-JPCM — the event is ALREADY registered; the EMITTER is missing.** The source comment at `:1769` claiming
  registration is "pending R-SLLJ-6" is **stale**. `judge_json_parse_failed` is present in
  `types/index.ts:715` (`VALID_ACTIVITY_EVENTS`), `activity-events.schema.json:879` (`definitions`) **and** `:1931`
  (the top-level `oneOf` `$ref`). What is missing is the emit site: `emitJudgeParseFailure`
  (`microverse-runner.ts:1756-1760`) does a bare `process.stderr.write` and never calls `logActivity`. WS-2 is a
  one-line emit-site swap plus deleting the stale comment — **do not re-add a duplicate registration.**
- **R-JPCM — the degraded shape is `malformed`, not `legacy`.** `JSON.parse` failure routes to
  `emptyJudgeResult('malformed')` (score: `null`), never to the `legacy` shape. Scope the ticket to the real path.

## Acceptance

Each composed PRD carries its own machine-checkable ACs (AC-BCFR-1..9, AC-GRLS-1..9, AC-JPCM-1..8 — note
**AC-JPCM-8 was RE-KEYED 2026-07-14**: the original keyed on ledger-emptiness, which WS-1 exists to destroy, so
it would have passed **vacuously**). The bundle adds:

- `AC-RLH-1`: the full release gate is green from `extension/` — tsc + eslint + 9 audits +
  `test:fast:budget` + `test:integration` (+ `test:expensive` at release time).
- `AC-RLH-2`..`AC-RLH-4`: WS-4 — `stalled_below_target` exists on `MicroverseExitReason`; `isConverged` returns a
  discriminated result, not a bare boolean; a stall-exhausted run above target does **not** report `converged`.
- `AC-RLH-5`: WS-5 — the dead AC-phase gate is either **deleted** or given a **producer and made fail-closed**.
  Leaving a fail-open gate with zero producers satisfies neither.
- `AC-RLH-6` **(the thesis test — this is what the bundle is FOR)**: **a review phase can FAIL.** Drive szechuan
  over a tree whose score cannot reach `convergence_target` and assert it reports an honest non-converged
  disposition rather than `status: "converged"`. If every phase still exits 0 on every input after this bundle
  lands, the bundle did not do its job — regardless of the other ACs going green.

## Simplification Review (subtract-before-add)

1. **Is the addition necessary at all?** WS-1 adds **nothing** (pure deletion). WS-3 adds **no code path** —
   it edits prompt text so an already-wired, currently-unreachable path finally receives its input. WS-2
   adds no primitive; it deletes a hand-rolled lock and calls three that exist. The only genuine additions
   are one enum member (`outcome: "locked_out"`) on an artifact that is already written and already read,
   and one activity-event registration (`judge_json_parse_failed`) that was written but never registered.
2. **Can it REUSE instead of ADD?** That is the whole bundle. WS-2 reuses the lock primitives (a bespoke
   steal here would make it the FOURTH parallel lock implementation — the one-adapter smell that produced
   the bug). WS-3 reuses `parseLlmJudgeOutput`, `updateViolationLedger`, `compareMetric`'s set-ops branch,
   and the prior-violations prompt block — all already built.
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** No new guards. WS-1
   **removes** a guard that false-blocks 43/43 on a tree the real gate calls clean and can never converge —
   exactly the W5b "loosened or removed, never given a second escape hatch" case (R-PCPS precedent: 41/41
   false-Highs → subtract the arm).
4. **What can this issue SUBTRACT?** Two fabricated analyzer arms (possibly a whole module + its wiring);
   the hand-rolled `acquireLockfile` body and its payload-less lockfile convention (4th divergent lock → 0);
   the bespoke `remediator_concurrent_lockout_*.md` doc, redundant once the result-json carries `locked_out`;
   and the `judge_json_parse_failed` stderr-only emission path.

## Risks

- **WS-1 deletes a rule someone wanted.** Mitigated: WS-2 of that PRD requires the grep before the delete,
  and adopting the brace style *honestly* (eslint `curly` + `--fix` + document it) is recorded as the
  out-of-scope, operator-owned path. Deleting a **fabricated** citation does not prevent adding a real rule.
- **WS-3 changes what the judge is asked to emit.** `extractScore`'s legacy line-oriented fallback is
  PRESERVED (AC-JPCM-5), so the worst case is today's behaviour — a working score and a dead ledger — not a
  broken phase. Do not subtract that fallback in this bundle.
- **WS-2's `locked_out` outcome ripples to the result-reader.** Enumerate the consumers (the
  R-CLOSER-ADJACENCY-AUDIT step-4 cross-module importer check) rather than patching the first one found.

## Routing

**Pipeline-safe (NOT R-PSRB).** None of the three touches the salvage / completion-evidence / Done-flip
path (`mux-runner.ts` salvage logic, `salvage-ticket.ts`, `reconcile-ticket-truth.ts`,
`ticket-completion-evidence.ts`). The build worker executes the **deployed** runtime, not this source diff,
so these fixes cannot sabotage the run that produces them. Drain via `/pickle-pipeline`.

**Deployed runtime at launch:** `2.1.0-beta.2` (MD5 parity verified) — it carries the dead-holder lock
recovery, the ambient-`#S` tmux ownership guard, the `setup --resume` RED-gate Done-flip fix, and
R-LSPC-2. Earlier runs on `beta.1` were exposed to all four.
