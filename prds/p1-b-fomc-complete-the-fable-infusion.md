---
title: "B-FOMC — Complete the fable infusion: it reached every surface that BUILDS and skipped every surface that JUDGES"
priority: P1
finding: B-FOMC
status: open
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
supersedes_scope_of:
  - "BUG-REPORT-2026-07-14-refinement-analysts-fabricate-citations-fom-infusion-gap.md (R-RAFC — folded in as WS-2)"
blocks:
  - "p2-bug-fix-bundle-b-rlh-review-loop-honesty.md (B-RLH treats three symptoms of this)"
source_assessment: "Every coverage number below was measured against HEAD on 2026-07-14 and is reproducible by the commands quoted inline. Given the finding this PRD is about, NO claim here is asserted without the command that produced it."
---

# B-FOMC — the review loop lies because the review loop was never told not to

## Thesis (one sentence)

The fable infusion reached **every surface that does the work** and skipped **every surface that checks the
work** — and every honesty defect currently open lives in a skipped surface.

## The coverage map (measured, not asserted)

Probe used throughout (`FOM` = the infusion's own vocabulary):

```
grep -ciE 'ground.?truth|evidence hierarch|silence is not success|tree.?truth|checkpoint as you work|verify before' <file>
```

**The four runtime prompt-builders in `extension/src/bin/`:**

| Prompt-builder | The worker it prompts | Role | FOM hits |
|---|---|---|---|
| `spawn-morty.ts` | Morty implementer | **BUILDS** | **3 ✅** |
| `spawn-refinement-team.ts` | the 3 analysts | **JUDGES** the PRD | **0 ❌** |
| `spawn-gate-remediator.ts` | the gate remediator | **JUDGES** the gate | **0 ❌** |
| `microverse-runner.ts` (`buildJudgePrompt`, `:1613`) | the LLM judge | **JUDGES** code quality | **0 ❌** |

**Everything else:**

| Surface | Coverage |
|---|---|
| `extension/templates/_pickle-manager-prompt.md` (the manager — DRIVES) | ✅ |
| `.claude/commands/*.md` | **8 / 33** (`anatomy-park`, `pickle-dot-patterns`, `pickle-microverse`, `pickle-pipeline`, `pickle-standup`, `plumbus`, `send-to-morty`, `szechuan-sauce`) |
| `.claude/agents/*.md` | **2 / 18** (`morty-implementer`, `morty-phase-verifier`) |
| `persona.md` | **0** — and it is the source of `~/.claude/CLAUDE.md`, in context on **every turn of every session in every repo** |

Note the tell: **`szechuan-sauce.md` and `pickle-microverse.md` ARE infused** — the human-facing command prose
got the treatment — **while `microverse-runner.ts`, which generates the actual judge prompt those commands
spawn, did not.** The infusion stopped at the surfaces a human reads.

## Why this is P1 and not prompt hygiene

Line up the coverage map against the open honesty defects:

| Finding | Defect | Lives in | Infused? |
|---|---|---|---|
| [[R-JPCM]] | the judge reports `converged` at score 4 against a target of 0 | `microverse-runner.ts` | **❌** |
| [[R-GRLS]] | the remediator exits clean having remediated nothing (false-GREEN gate) | `spawn-gate-remediator.ts` | **❌** |
| [[R-RAFC]] | the analysts fabricate `file:line` citations; nothing verifies them | `spawn-refinement-team.ts` | **❌** |
| [[R-BCFR]] | citadel cites a rule that exists in no CLAUDE.md | citadel analyzer *(code, not prompt — see Risks)* | n/a |

**Three of the four open honesty defects live in the three un-infused judging prompts.** The infused surfaces
(implementer, manager) have produced none.

**⚠ What this does NOT prove (stated plainly, because this PRD is about not overclaiming).** These defects are
**older than the infusion** (2026-07-10/11), so the infusion did not *cause* them, and "un-infused prompt →
fabricates" is **not** established causally. What IS established is that the infusion's coverage map and the
honesty-defect map are **exact complements**. That makes completing the infusion a credible **systemic**
countermeasure rather than four separate patches — and it makes [[B-RLH]] look like three symptoms of one
disease. It is a strong hypothesis, and the soak (WS-5) is how we find out. **Do not let a ticket restate this
correlation as causation.**

## Root cause: the infusion is hand-mirrored prose with no source, no markers, and no test

There is no way to know which surfaces carry the infusion — not for us, and not for a test. Coverage is untracked,
so a **missing** surface is invisible. That is why `spawn-refinement-team.ts` was skipped and nobody noticed.

**The manual predicted this in its own field notes** (`docs/FABLE_OPERATING_MANUAL.md`, Addendum):

> **"Mirrored prose drifts like mirrored code.** The infusion hand-mirrored instructions into sibling prompts
> (worker/reviewer twins, Legacy/Teams manager arms) and drifted *within one session* — the GIT_BOUNDARY copies
> had already diverged before we ever looked. **A mirrored instruction family needs a pin test or a single
> source; 'I'll keep them in sync' is the asymmetric-fix antipattern in slow motion."**

It diagnosed itself and shipped anyway.

## The mechanism already exists and is proven IN THIS REPO — reuse it, do not invent one

`GIT_BOUNDARY_RULES` is the same problem, already solved
(`extension/tests/skill-prompt-shape/git-boundary-prompts.test.js`):

```js
const COMMAND_FILES = [
  '.claude/commands/pickle-tmux.md',
  '.claude/commands/anatomy-park.md',
  'extension/templates/_pickle-manager-prompt.md',   // ← added 2026-07-10 "after the copies were found
  '.claude/commands/death-crystal.md',               //   silently drifting"
];
const BOUNDARY_BLOCK_START = '<!-- BEGIN GIT_BOUNDARY_RULES -->';
```

A delimited block + an **enumerated file list** + a shape test that fails when a listed file lacks the block.
**The enumeration IS the coverage ledger** — a surface cannot be silently skipped, because the test names it.
~30 lines per family. **This is the piece the FOM infusion never had, and it is the entire fix.**

**This is [[R-FOMH]] leg (e), which has sat unbuilt because it was filed as needing an "operator decision."**
It is not a decision. GIT_BOUNDARY already made it. Filing it as a decision is what kept it unbuilt while the
prose rotted.

## ⛔ Hard constraint: deployed prompts must be SELF-CONTAINED

From the same addendum — the infusion's own first failure:

> "My first injections cited '(FOM §N)' — an acronym that greps to nothing, in files read by workers whose cwd is
> the **target** repo and whose runtime **never deploys `docs/`**."

`docs/FABLE_OPERATING_MANUAL.md` is **physically unreachable** from a worker running in loanlight-api. The prose
must live **in the prompt**. **No `(see FOM §N)` citations, no "read the manual" pointers.** Provenance lives in
git blame.

## Workstreams

| WS | What | Shape |
|---|---|---|
| **WS-1** | The **shape test + delimited blocks** — the enforcement mechanism. Reuse GIT_BOUNDARY's pattern verbatim. | reuse |
| **WS-2** | Infuse the **three judging prompt-builders** (folds in [[R-RAFC]]) | reuse (prose from a shipped surface) |
| **WS-3** | Infuse **`persona.md`** — O(1) cost, 100% reach, lands in **every target repo** | reuse |
| **WS-4** | Widen the **existing** analyst-output checker from *path-exists* to *line-exists* + **attribute** warnings | reuse |
| **WS-5** | **Soak**: does an infused judging surface actually stop lying? (the falsifier) | measurement |

### WS-1 — the enforcement mechanism (build this FIRST; everything else is inert without it)

Define the blocks **by concern**, not by file. Start with the ones the open defects demand — resist inventing a
taxonomy:

- `FOM_EVIDENCE_RULES` — *verify a citation before you assert it; a claimed grep result must be a grep you
  actually ran; an unverified mechanism is a hypothesis — label it as one.*
- `FOM_HONEST_REPORTING_RULES` — *silence is not success; a fast clean pass is a gate that did not fire; never
  report an outcome you did not observe.*

Delimit each with `<!-- BEGIN FOM_EVIDENCE_RULES -->` / `<!-- END FOM_EVIDENCE_RULES -->` (markdown surfaces) or
the equivalent comment sentinels in the `.ts` template literals.

- `AC-FOMC-1`: `extension/tests/skill-prompt-shape/fom-infusion-prompts.test.js` exists, enumerates every surface
  in the infusion family, and **FAILS when an enumerated surface lacks its block** (assert the failure — a shape
  test that cannot fail is this bundle's own thesis, self-inflicted).
- `AC-FOMC-2`: the block content is **byte-identical** across every surface carrying it (the drift assertion —
  this is the half GIT_BOUNDARY earned the hard way).
- `AC-FOMC-3`: **zero** `(FOM §N)`-style unresolvable citations in any deployed prompt:
  `! grep -rE 'FOM §|see the operating manual|FABLE_OPERATING_MANUAL' .claude/ extension/src/bin/ persona.md`
  (a worker in a target repo cannot resolve any of them).

### WS-2 — infuse the three judging prompt-builders (folds in R-RAFC)

`spawn-refinement-team.ts`, `spawn-gate-remediator.ts`, `microverse-runner.ts:buildJudgePrompt`.

**R-RAFC's specific fix belongs here.** `spawn-refinement-team.ts:569` currently instructs:

> "Use **file:line references for every codebase claim**."

It **mandates citation precision and never asks anyone to verify one.** Widen it to *"file:line references **you
have verified**; mark anything unverified as a hypothesis."*

- `AC-FOMC-4`: all three files carry `FOM_EVIDENCE_RULES` and are enumerated in WS-1's test.
- `AC-FOMC-5`: `spawn-refinement-team.ts`'s citation mandate requires verification.
- `AC-FOMC-6`: `buildJudgePrompt` carries `FOM_HONEST_REPORTING_RULES`. **Coordinate with [[R-JPCM]]** — that
  finding also edits this prompt's output contract. Land B-FOMC first; R-JPCM rebases onto the infused block.

### WS-3 — persona.md

The single highest-leverage insertion in the codebase: it is the source of `~/.claude/CLAUDE.md`
(`install.sh:516`), in context on **every turn of every session in every repo — including target repos.** It
carries **zero** FOM content today. 3–5 lines.

- `AC-FOMC-7`: `persona.md` carries the evidence + honest-reporting blocks and is enumerated in WS-1's test.
- **Do NOT hand-edit `~/.claude/CLAUDE.md`** — edit `persona.md`, run `bash install.sh`
  ([[feedback_persona_source_of_truth]]).
- ⚠ **Watch the token budget.** [[project_beta33_gate_overreach_subtraction_shipped]]'s lesson: a CLAUDE.md
  token-optimize broke `release-gate-parity` + `codegraph-docs-optin-parity` because those files carry
  **test-pinned literal phrases**. Adding to `persona.md` is the safe direction, but re-run those two tests.

### WS-4 — make the EXISTING checker earn its keep (do not build a new one)

`checkAnalystOutputPaths` → `analyst_path_not_verified` (`spawn-refinement-team.ts:2142-2149`) already parses
analyst output for citations. Today it checks only that a cited **path exists** — never that the cited **line**
says what is claimed, that a claimed **grep result** is real, or that a claimed **relationship** exists. **All
three R-RAFC fabrications cite real files and sail straight through it.** It fired **44 warnings** on the
2026-07-14 run, wrote them with `ticket_id: ""` (**unattributed**), and blocked nothing.

- `AC-FOMC-8`: a `file:line` citation is checked for **line existence**, not just file existence.
- `AC-FOMC-9`: each warning is **attributed** to the emitting analyst + cycle (today: `ticket_id: ""`).
- **Stays ADVISORY.** Per W5b, do **not** build a fabrication gate. The cross-cycle catch already works — both
  R-RAFC fabrications were caught by a later cycle. Make the signal legible and let the next cycle use it.

### WS-5 — the soak (the falsifier; this is what makes the thesis honest)

The correlation above is a hypothesis. Test it.

- `AC-FOMC-10`: re-run the B-RLH refinement on the **infused** analyst team and compare fabrication counts
  against the recorded 2026-07-14 baseline (2 fabricated mechanisms, 44 unattributed path warnings; artifacts
  preserved at `~/.local/share/pickle-rick/sessions/2026-07-14-ef12a95a/refinement_round1/`). **A null result is
  a real result and must be recorded** — if infusion changes nothing, the disease is elsewhere and B-RLH's
  three symptom-fixes are the right level after all.

## Simplification Review (subtract-before-add)

1. **Is the addition necessary at all?** WS-1 adds one shape test (~30 lines) — the smallest possible enforcement
   and the *only* new machinery in the bundle. WS-2/WS-3 add **prose to existing prompts**, copied from a shipped
   surface. WS-4 adds **nothing** — it widens a check that already runs. WS-5 is measurement.
2. **Can it REUSE instead of ADD?** That is the entire bundle. The enforcement pattern is GIT_BOUNDARY's,
   verbatim. The prose is `spawn-morty.ts`'s, verbatim (that is what makes AC-FOMC-2's byte-identity assertion
   both possible and meaningful). The checker is the one already wired.
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** No new guards. WS-4
   explicitly **refuses** to add a fabrication gate — the honest fix is to *tell the analysts to verify*, not to
   police them after the fact. Adding a gate around an un-instructed worker is the guard-on-a-guard smell.
4. **What can this issue SUBTRACT?** The hand-mirroring discipline itself — after WS-1 the family has a single
   canonical block and a test that enumerates its members, so "I'll keep them in sync" stops being a maintenance
   obligation. Also closes [[R-FOMH]] leg (e) and retires its false framing as an operator decision.

## Risks

- **Prompt bloat degrades the worker.** Adding prose to every judging prompt costs context. Mitigate: two blocks,
  not a taxonomy; keep each ≤ 5 lines; `persona.md` is where the O(1) leverage is, so put the weight there and
  keep the per-prompt blocks thin.
- **R-BCFR is NOT a prompt defect.** citadel's fabricated `"is banned by CLAUDE.md"` is a **hardcoded string
  literal in code** (`banned-constructs-audit.ts:129`), not an LLM hallucination. It has the same *shape* but a
  different cause, and infusion cannot fix it — it stays in [[B-RLH]] WS-1. **Do not let the thesis's elegance
  swallow a defect it cannot actually fix.**
- **The correlation may be spurious.** See the ⚠ above. WS-5 exists to find out, and a null result must ship as a
  null result.
- **A shape test that cannot fail.** The single funniest way to get this wrong. AC-FOMC-1 requires proving the
  test RED against a surface with the block removed.

## Rollback

No runtime behaviour changes — this bundle edits prompts and adds one test. Rollback is `git revert` per
workstream. **No kill-switch is warranted**: an infused prompt cannot wedge a run, and a shape test failing is a
build-time signal, not a runtime halt. (If WS-4's widened checker ever false-positives, it is **advisory** — it
cannot block anything by construction.)

## Routing

**Pipeline-safe (NOT [[R-PSRB]]).** Nothing here touches the salvage / completion-evidence / Done-flip path. The
build worker executes the **deployed** runtime, not this source diff.

⚠ **One self-reference to hold in mind:** this bundle is refined by the very analysts it is fixing. Their
un-infused prompts govern the refinement that decomposes it. That is not a blocker (the deployed runtime is not
the source diff), but the decomposition **must be citation-checked by hand** before launch — treat every
`file:line` in the resulting tickets as unverified until greped. **That is the discipline this bundle exists to
make automatic.**
