# B-REFUSAL — one persona sentence makes Opus 5.5 refuse every refinement analyst

**Autonomy root, PRIME DIRECTIVE.** On `claude-opus-5-5` (the current default model) every refinement
analyst spawn ends `stop_reason: "refusal"` with `Details: [reasoning_extraction]` on its FIRST request
(0 tool calls). Refinement produces no tickets, so `/pickle-refine-prd`, `/portal-gun` and every
`/pickle-pipeline --refine` run go to zero. B-REFMODEL (#46) added a `--model` escape route, and its
PRD concluded "the trigger is the model, not the content". **That conclusion was wrong.** The control
PRD failed identically because the trigger is in the STATIC analyst persona, which every PRD shares.

## Mechanism — measured 2026-09-23 at HEAD `ac1c8258`, `claude -p --model claude-opus-5-5`

Bisection over the generated analyst prompts, printing only `stop_reason`:

| input | result |
|---|---|
| PRD text alone | `end_turn` |
| analyst template, PRD removed | `refusal` |
| template section 1 alone (25 lines) | `refusal`; sections 2–4 pass |
| section 1 with its line 3 removed | `end_turn` |
| line 3 alone | `refusal` |
| full prompts, all 3 roles, unmodified | **3/3 `refusal`** |
| full prompts, all 3 roles, line 3 removed | **9/9 `end_turn`** (3 roles × 3 runs) |

Line 3 of section 1 is the third line of `ANALYST_PERSONA` in
`extension/src/bin/spawn-refinement-team.ts` (`:771`): the `CRITICAL RULE` sentence that asks for a
text explanation ahead of each tool call. Its sub-phrases pass alone; the classifier fires on the
sentence as a whole. It is the ONLY occurrence in the tree (source + compiled mirror + deployed copy).

## Fix — subtraction

**Delete that sentence from `ANALYST_PERSONA`.** Do not reword it. The mechanism is semantic, so a
paraphrase of the same demand is an untested guess that may refuse again. Nothing reads the narration:
the analysts' output contract is the analysis file, and the watcher pane renders tool calls on its
own. Leave the other two persona lines as they are; both were measured passing.

Do NOT add a phrase blocklist, a refusal classifier or a retry. The next refusal would come from wording
nobody has enumerated (see root `CLAUDE.md` → ENUMERATED SET), and `--model` already covers the
unenumerated case.

## Files

- `extension/src/bin/spawn-refinement-team.ts`: delete the one sentence
- `extension/tests/spawn-refinement-team.test.js`: add one regression case (in an EXISTING file)

## Acceptance criteria

Each predicate was run at HEAD `ac1c8258` and must NOT pass before the fix.

1. `grep -cF 'MUST output a text explanation' extension/src/bin/spawn-refinement-team.ts` → `0`
   (measured at HEAD: `1`).
2. `extension/tests/spawn-refinement-team.test.js` gains a case asserting that `buildWorkerPrompt(...)`
   output for each of the three roles does NOT contain `MUST output a text explanation`. Falsifying
   control: restore the sentence and the case must red. It pins the real prompt, not a fixture.
3. `cd extension && ./node_modules/.bin/tsc --noEmit && npx eslint src/ --max-warnings=0` exits 0, and
   `node --test tests/spawn-refinement-team.test.js` passes.

**Post-deploy verification (babysitter, NOT a worker step; workers cannot deploy).** After
`install.sh`, generate the three analyst prompts from the DEPLOYED `spawn-refinement-team.js` and run
each on `claude-opus-5-5`: all must return `end_turn`. Before the fix they return `refusal`.

## Out of scope

Rewording other prompt surfaces pre-emptively. None has been measured refusing. File one only on an
observed refusal.
