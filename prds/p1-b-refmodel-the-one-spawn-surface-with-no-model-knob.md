# B-REFMODEL — refinement is the only spawn surface with no model selection

**Autonomy root (#46).** On 2026-09-21 the default model refused every refinement worker with
`API Error: Opus 5 (1M context)'s safeguards flagged this message … Details: [reasoning_extraction]`.
**9 of 9 worker spawns across 3 runs**, all three roles each time, deterministic. A control run against
a previously-successful PRD (`p2-b-gatered-two-real-reds-not-stale-pins.md`) failed identically, so the
trigger is the model, not the content.

The upstream error's own remediation advice is *"change your model"*. **There was no way to do that.**
Every sibling spawn surface has a model knob; refinement alone has none, so a model-level refusal took
the **entire dogfood path** to zero instead of degrading to a slower model. The PRIME DIRECTIVE is
explicit that a halted pipeline takes reliability AND quality to zero — this is that, sourced from an
external dependency the runtime cannot route around.

**This is a small bundle and that is deliberate.** The backlog is at **zero open bugs**; #43 and #5 are
operator-deferred. Padding this to hit the sizing guidance with invented roots would be worse than
paying the review toll on one real autonomy defect. Do not manufacture roots.

## Census — measured at HEAD `39b09276`, not inferred

| spawn caller | model references | model surface? |
|---|---:|---|
| `src/bin/spawn-morty.ts` | 40 | ✅ `resolveWorkerModelFromTierAndPersona`, `resolvePhasePersonaModel`, `AgentModel` |
| `src/bin/microverse-runner.ts` | 20 | ✅ `judgeModel` threaded end-to-end, `DEFAULT_JUDGE_MODEL` fallback |
| `src/bin/mux-runner.ts` | 11 | ✅ |
| **`src/bin/spawn-refinement-team.ts`** | **0** | ❌ **none** |
| `src/bin/pipeline-runner.ts` | 0 | ❌ (delegates; phases resolve their own) |

`grep -cE "'--model'|--model|ANTHROPIC_MODEL|PICKLE_.*MODEL" src/bin/spawn-refinement-team.ts` → **0**.
A bare `grep -c "model"` on that file returns **3** — all prose (`:28`, `:216`, `:815`), zero code.
Stated here because the distinction is what separates a real criterion from a fake-green one.
`grep -cE 'opts\.model' src/services/backend-spawn.ts` → **10**.

## ⛔ WIDEN THE EXISTING CONVENTION — do not invent a parallel one

The operator convention already ships. `pickle_settings.json` carries a `microverse` block:

```json
"microverse": {
  "judge_backend": "claude",
  "judge_backend_fallback": "codex",
  "judge_model_claude": "claude-sonnet-4-6",
  "judge_model_codex": "gpt-5.4"
}
```

resolved by `getMicroverseSettings` in `src/services/pickle-utils.ts` against
`DEFAULT_MICROVERSE_SETTINGS` (`:25-31`), with the per-field shape
`typeof v === 'string' && v.trim() ? v : DEFAULT` (`:72-84`). Its consumer is
`loadMicroverseSettingsBag`/`getMicroverseSettings` at `microverse-runner.ts:3233`/`:3264`.

**Follow that shape exactly**: a sibling settings block resolved by a sibling function in the same
module, same per-field fallback idiom, same compiled defaults. Per the gate-leg discipline the repo
applies to its own instruments, **a widened pattern is a collapse; a new parallel mechanism is an
addition.** Do not add an env-var channel as the primary surface — `ANTHROPIC_MODEL` worked as an
undocumented emergency workaround on 2026-09-21 and is exactly the unsanctioned channel this root
exists to replace.

## Non-goals, stated so they cannot drift in

- **Do NOT pin refinement to a non-default model by default.** The default must remain whatever the
  session already uses; absent configuration, behaviour is byte-identical to today. This root adds a
  *routing option*, not a policy.
- **Do NOT change the backend pinning.** `/pickle-pipeline` Step 0c pins refinement to the claude
  backend because refinement is planning, not implementation. That is correct and stays. The defect is
  that "pinned backend" was silently also "pinned model" — only the model half moves.
- **Do NOT add a retry-on-refusal loop.** Retrying an identical refused ask is the defect B-MEASURED's
  R2 just fixed one subsystem over; do not re-introduce it here.
- **Do NOT touch `backend-spawn.ts`'s `opts.model`.** It already works; this root feeds it.

## Interface Contracts

**Inputs**: the parsed `pickle_settings.json` object, plus any CLI override on
`spawn-refinement-team`.
**Outputs**: a resolved model string (or `undefined`) reaching `backend-spawn`'s existing `opts.model`
for **every** analyst role spawn.
**Resolution order**: explicit CLI flag → settings block → compiled default → `undefined` (meaning
"inherit the session default", today's behaviour).
**Invariants**: with no configuration present, the resolved value is `undefined` and the spawn argv is
**byte-identical to today's**. All three roles resolve the same model in one cycle.
**Errors**: a malformed/empty/non-string setting falls back to the compiled default exactly as
`getMicroverseSettings` does — never throws, never partially applies.
**Unchanged**: the claude backend pin; `opts.model`'s own contract; every existing settings key.

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| settings arm resolves | `extension/tests/settings-loader.test.js` | a settings object carrying the new block | the configured model is returned |
| malformed falls back | `extension/tests/settings-loader.test.js` | empty string / non-string / absent block | the compiled default, no throw |
| reaches every role | `extension/tests/refinement-manifest-atomic.test.js` | spawn all three analyst roles | each spawn receives the resolved model |
| absent config is a NO-OP (CONTROL) | `extension/tests/refinement-manifest-atomic.test.js` | no setting, no flag | argv is byte-identical to today; **no** `--model` appears |
| CLI beats settings | `extension/tests/refinement-manifest-atomic.test.js` | flag and setting both present, differing | the flag wins |

## Acceptance Criteria

- `grep -c 'refine_model' extension/src/bin/spawn-refinement-team.ts` returns a value `>= 1`
  — **measured `0` at HEAD**, so this criterion can only pass after the fix. Do NOT weaken it to a bare
  `grep -c "model"`: that already returns **3** at HEAD (two prose comments and a telemetry-table row at
  `:28`, `:216`, `:815`) and would pass before any code changed. That is the same fake-green shape
  refinement caught in B-MEASURED's R2 — an AC is a measurement instrument and inherits every defect
  class this repo files against instruments.
- `grep -c 'judge_model_claude' extension/src/services/pickle-utils.ts` returns `4` (the precedent is widened, not replaced — **measured 4 at HEAD**, not assumed; adding a sibling key leaves this count untouched)
- `cd extension && ./node_modules/.bin/tsc --noEmit` exits `0`
- `cd extension && npx eslint src/ --max-warnings=0` exits `0`
- `cd extension && node --test tests/settings-loader.test.js` exits `0`
- `cd extension && node --test tests/refinement-manifest-atomic.test.js` exits `0`
- a test asserts the resolved model reaches the analyst spawn for **all three** roles
- a negative control asserts that with no configuration the spawn argv gains **no** `--model` — today's behaviour preserved exactly
- root `CLAUDE.md` documents the knob in its settings table

## Mutation Verification (BINDING, both directions)

1. Drop the threading (resolve the value, never pass it) → the reaches-every-role test RED, the
   absent-config CONTROL GREEN.
2. Force a model pin unconditionally, ignoring absent configuration → the absent-config CONTROL RED.

An under-trigger control alone passes a pin-everything bug, which would silently change the model for
every existing user — the worst possible outcome for a routing option.

## FALSIFY — take these before building

- `grep -c 'refine_model' extension/src/bin/spawn-refinement-team.ts` returns non-zero → a surface already
  landed; close as already-satisfied. (Use this predicate, not a bare `model` grep, which reads **3** at
  HEAD from prose alone.)
- `grep -c 'judge_model_claude' pickle_settings.json` returns `0` → the convention this root widens does
  not exist and the naming must be re-derived from whatever replaced it.
- `grep -n 'getMicroverseSettings' extension/src/services/pickle-utils.ts` returns nothing → the
  precedent resolver moved; re-locate it before copying its shape.
- A fresh refinement on the default model succeeds → the 2026-09-21 safeguard was transient. **The
  missing-surface half still stands**: the defect is the absence of a route, not the refusal itself.
