---
title: "R-JPCM — the judge PROMPT demands a bare number; the judge PARSER demands JSON. The violation ledger is therefore always empty and the entire R-SLLJ false-stall fix is unreachable"
priority: P2
finding: R-JPCM
status: "open — filed 2026-07-13 from a live false-stall (session 2026-07-11-255ad373, szechuan-sauce phase)"
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
depends_on: "none (deploy-agnostic BUILD; pipeline-safe — see Routing)"
source_assessment: "Field-surfaced: szechuan stalled flat at score 4 for 5 consecutive iterations while landing 5 real fixes, then self-reported 'converged' against a target of 0. Root cause traced to source and confirmed by 5 judge_json_parse_failed emissions in the session."
---

# P2 Bug-Fix Bundle — R-JPCM: the judge's two contracts disagree, and the ledger dies in the gap

## Context — a live false-stall

`/pickle-pipeline` session `2026-07-11-255ad373`, szechuan-sauce phase, 2026-07-12/13:

| Iteration | Score | Classification | Work landed that iteration |
|---|---|---|---|
| baseline | 5 | — | — |
| 2 | 4 | improved | `1cc46bb0` tar listings materialized so `pipefail` cannot mask a link-scan hit |
| 3 | 4 | **held** | `981a16b2` verify a lock's inode before vacating its path |
| 4 | 4 | **held** | `9f19370b` gate the third ambient-`#S` consumer |
| 5 | 4 | **held** | `ce79c1bf` match the SQL clobber RHS against constants |
| 6 | 4 | **held** | `72280dac` drive the real breadcrumb emitter so a double-fire can redden its spec |
| 7 | 4 | **held** | `b5db1afc` derive the demanded-AC set from the PRD (Single Source of Truth) |

`stall_counter` hit `stall_limit` (5) and the phase exited **`status: "converged"`** with `score: 4` against
`convergence_target: 0`. `failure_history` carries three `no_progress` entries. `violation_ledger` is `[]`.

Five real, reviewed fixes landed. The judge scored the tree identically every single time. **The workers were
working; the metric was blind.**

## Root cause — the prompt and the parser want different things

Two contracts, written against each other, verified 2026-07-13:

1. **The PROMPT demands a bare number.** `buildJudgePrompt` (`microverse-runner.ts:1656-1661`):
   ```
   'Score the current state against the goal.',
   'Output ONLY a single integer or decimal number on the LAST line.',
   'Do NOT use fractions like "7/10". Do NOT add units or explanations after the number.',
   ```

2. **The PARSER demands structured JSON.** `parseLlmJudgeOutput` (`:1771`) runs `JSON.parse(rawOutput)` and expects an
   **object** carrying `score` **and** a `violations` array. Judge prose ending in a bare number is not parseable as a
   JSON object, so it lands in the `catch` → `emptyJudgeResult('malformed')` → `violations: []`.

3. **The score survives; the violations do not.** `extractScore` (`:1735`) tries `JSON.parse` first and then falls back
   to line-oriented scanning (`:1744-1752`) — which is why `score: 4` was captured correctly every iteration and
   nothing looked broken. The failure is silent by construction: **the number works, the payload is dropped.**

4. **Smoking gun.** The session emitted **5 × `judge_json_parse_failed`** (`emitJudgeParseFailure`, `:1756`) — one per
   measurement. It goes to **stderr only**; the comment at `:1769` says activity-event registration is still
   "pending R-SLLJ-6 (ticket 96402c0a)". So the one signal that the ledger is dead is invisible to `/pickle-status`,
   to metrics, and to the operator.

### The blast radius: R-SLLJ is dead code in practice

The empty `violations` array propagates through the whole anti-false-stall orbit:

- `updateViolationLedger(state, judgeResult, ctx.iteration)` (`:3423`) **is** wired — but it is handed an empty array.
  Per the `microverse-state.ts` invariant, a full judge result **replaces** the ledger, so the ledger is rebuilt from
  empty and stays `[]` forever.
- `compareMetric` (`:3446`) needs **both** current and previous ledgers populated to take the **R-SLLJ-4 set-ops
  branch** (resolved / new / remaining). With empty ledgers it falls through to bare numeric comparison — which is
  precisely how five resolved violations register as `held: 4 vs 4`.
- `buildJudgePrompt`'s own **`## Prior violations (DO NOT re-report unless still present)`** section (`:1664-1674`) is
  gated on `safeViolations.length > 0`. It never fires, so the judge re-discovers the same issues every pass — the
  exact re-discovery R-SLLJ-1 exists to prevent.
- `JudgeResult.shape` is a 4-way discriminator (`'full' | 'legacy' | 'malformed' | 'partial'`). Under the current
  prompt, **`'full'` is unreachable**.

R-SLLJ-1/3/4 were built to kill this false-stall class. They are all present, all wired, and all inert — because the
prompt never produces the input they need. We did not regress the fix; **we have never once run it.**

## WS-1 — make the prompt ask for the shape the parser already parses (SHIP)

### Changes

- `microverse-runner.ts:1656-1661`: replace the bare-number output contract with the structured object
  `parseLlmJudgeOutput` already accepts — `{ "score": <number>, "violations": [ { id?, severity, description }, … ] }`
  — stating that `score` MUST equal `violations.length` for count-type metrics, and that the object must be the entire
  output.
- Keep `extractScore`'s legacy line-oriented fallback (`:1744-1752`) **untouched**. It already tries `JSON.parse` first
  and reads `.score` (`:1737-1740`), so a JSON object satisfies **both** readers. The fallback stays as the safety net
  for a judge that ignores the format — which is exactly what a fallback is for.
- Do **not** add a new parser, a new event, or a second judge path. The parser, the ledger writer, the set-ops branch,
  and the prior-violations prompt section all already exist and are already wired.

### Acceptance criteria (machine-checkable)

- `AC-JPCM-1`: `buildJudgePrompt` output contains no instruction to emit "ONLY a single integer"; it specifies a JSON
  object with `score` and `violations`.
- `AC-JPCM-2`: given a judge response that is a well-formed `{score, violations:[…]}` object, `parseLlmJudgeOutput`
  returns `shape: 'full'` with `violations.length === score` (the `'full'` shape becomes reachable — assert it).
- `AC-JPCM-3`: after one iteration with a non-empty judge result, `microverse.json:violation_ledger` is **non-empty**.
- `AC-JPCM-4`: **the regression that reproduces this bug** — a two-iteration fixture where the judge reports 4
  violations, then reports the same count but with **one violation resolved and one new**, classifies via the
  **set-ops** branch (`resolved`/`new`/`remaining` populated), NOT as `held`. Pre-fix this test must fail.
- `AC-JPCM-5`: a bare-number judge response still yields a correct `score` via the `extractScore` fallback (no
  regression for a non-compliant judge).
- `AC-JPCM-6`: full release gate green from `extension/`.

### Simplification Review (subtract-before-add) — WS-1

1. **Is the addition necessary at all?** It adds **no code path**. It edits prompt text so that an existing,
   already-wired, currently-unreachable code path starts receiving its input. Arguably the highest-leverage
   character-count in the repo.
2. **Can it REUSE instead of ADD?** This *is* the reuse. `parseLlmJudgeOutput`, `updateViolationLedger`,
   `compareMetric`'s set-ops branch, and the prior-violations prompt block are all already built and wired. The
   alternative — teaching `compareMetric` to infer progress some other way — would be a second mechanism beside a
   working one. Rejected.
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** No new guard. If anything it
   *retires* a latent one: the `'legacy'`/`'malformed'` shapes stop being the steady state and go back to being the
   exception they were designed as.
4. **What can this issue SUBTRACT?** Candidate for subtraction once `'full'` is the norm: the `'legacy'` shape and its
   branch, if nothing else depends on it. **Do not subtract it in this bundle** — it is the fallback that AC-JPCM-5
   pins, and removing a safety net in the same change that starts depending on a new judge behavior is exactly the
   kind of coupled bet that produces the next incident. Revisit after one clean soak.

## WS-2 — a dead ledger must be loud (SHIP)

`judge_json_parse_failed` is a stderr line with a code comment admitting its registration is "pending." That is why
this ran for five iterations, in front of an attentive operator, and looked like honest convergence.

### Changes

- Register `judge_json_parse_failed` as a real activity event at all touchpoints (`VALID_ACTIVITY_EVENTS`, the schema
  `definitions` block **and** the top-level `oneOf` `$ref` — a definition without the `$ref` is inert — plus the
  compiled mirrors). This is the R-SLLJ-6 / ticket `96402c0a` residual, finally paid.
- Surface it: a phase whose judge produced `shape: 'malformed'` on **every** measurement has an unusable ledger, and
  the run should say so rather than reporting `converged`.

### Acceptance criteria (machine-checkable)

- `AC-JPCM-7`: `judge_json_parse_failed` is in `VALID_ACTIVITY_EVENTS` and reachable from the schema's top-level
  `oneOf`; `activity-event-payload.test.js` covers its required fields.
- `AC-JPCM-8`: a szechuan/anatomy phase that exits on the stall limit with a **flat** score and an **empty**
  `violation_ledger` does **not** report `status: "converged"` — it reports a distinct, honest disposition
  (e.g. `stalled_unmeasurable`), because a metric that never moved and a ledger that never populated is not evidence
  of convergence.

### Simplification Review (subtract-before-add) — WS-2

1. **Is the addition necessary at all?** WS-2 adds one event registration (already written, never registered) and one
   honest exit label. Without it, WS-1's fix is unverifiable in the field and the *next* judge-contract drift is
   equally silent.
2. **Can it REUSE instead of ADD?** Yes — it reuses the existing activity-event schema pipeline and the existing exit
   disposition mechanism. No new channel, no new gate.
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** No. It makes an existing signal
   *reach* the operator; `converged`-at-score-4-against-target-0 is a **mislabel**, and the fix is honesty, not a guard.
4. **What can this issue SUBTRACT?** The stderr-only emission path, once the event is registered properly.

## Risks

- **The judge stops complying with the JSON format.** Mitigated by AC-JPCM-5: `extractScore`'s line-oriented fallback
  is preserved, so the worst case is today's behavior — a working score and a dead ledger — not a broken phase.
- **`score` and `violations.length` disagree.** The prompt must make the relationship explicit for count-type metrics;
  the parser should prefer the array length when the two conflict for a count metric (the array is the evidence, the
  integer is a summary). The ticket must decide this explicitly rather than leaving it to chance.
- **This changes what the judge is asked to do, mid-metric.** Baselines measured under the old prompt are not strictly
  comparable to scores under the new one. Not a blocker — baselines are recaptured per phase — but do not read
  cross-run score deltas across the fix boundary.

## Out of scope

- The szechuan **principles** themselves and the scoring rubric. This bundle changes the judge's *output contract*, not
  its *judgment*.
- The R-BCFR / R-GRLS escapes from the same session (filed separately).
- Re-running the stalled szechuan phase. Queued separately as **[[B-APRP]]** alongside the anatomy-park re-pass.

## Routing

**Pipeline-safe (NOT R-PSRB).** Touches `microverse-runner.ts` judge prompt/parse surface plus the activity-event
schema — not the salvage / completion-evidence / Done-flip path (`mux-runner.ts` salvage logic, `salvage-ticket.ts`,
`reconcile-ticket-truth.ts`, `ticket-completion-evidence.ts`). The build worker runs the **deployed** runner, so a
source edit here cannot perturb the run producing it. Drain via `/pickle-pipeline`.
