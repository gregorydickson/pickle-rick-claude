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
source_assessment: "Every coverage number was measured against HEAD on 2026-07-14 and re-verified the same day by a 3-agent adversarial pass (citation verification / full prompt-surface inventory / mechanism review); every NEW citation that pass produced was then re-greped by hand before landing here. Given the finding this PRD is about, NO claim is asserted without the command that produced it. Known probe limitation stated inline in the coverage map."
---

# B-FOMC — the review loop lies because the review loop was never told not to

## Thesis (one sentence)

The fable infusion reached **every surface that does the work** and skipped **every surface that checks the
work** — and every honesty defect currently open lives in a skipped surface.

## ⚠ Refinement Corrections (3 cycles × 3 analysts; every claim below re-greped BY HAND, 2026-07-14)

*(refined: refinement cycles 1–3 + operator hand-verification. The analysts are the un-infused surface this bundle
fixes, so nothing they asserted was adopted on trust. Two of three analysts fabricated the central number — see C-1.)*

**C-1 — THE FALSIFIER IS STRUCTURALLY BLIND, and this supersedes the entire WS-4 debate.**
R-RAFC's actual fabrication was: *"two trap-door INVARIANTs **policed by the release gate**
(`audit-trap-door-enforcement.sh`)."* **The cited paths are REAL.** The lie is in the *claim about what the mechanism
does*. `checkAnalystOutputPaths` verifies only **path existence** — so it **passed** that citation, and WS-4's
`file:line` + line-count widening would **also pass it** (the file exists; the line is in range). **The checker caught
0 of R-RAFC's 2 fabrications not because it is miscalibrated, but because it checks the wrong thing.** Consequences:
- **Warning count can NEVER measure fabrication.** Strike it as a success metric (AC-FOMC-10, re-specified below).
- **WS-4 is hygiene, not detection.** Its honest job is to stop lying *at* us (a 98% false-positive rate), not to
  catch fabricators. It **stays ADVISORY**. It cannot reduce fabrication and must claim no such thing.
- **The only real countermeasure is WS-2 (the prompt) plus cross-cycle catch** — which is what actually caught both
  R-RAFC fabrications, and both of this refinement's. The PRD's original instinct ("that verification burden moves
  into the analyst prompt itself, where it belongs") was right. **Verify the claim, not the token.**

**C-2 — Genuine fabrications in the 44-warning baseline: ZERO. Two of three analysts got this wrong, identically.**
Requirements and Codebase both reported `citadel/changed-source-helpers.ts` as a "TRUE FABRICATION," each citing
`git ls-files | grep changed-source → nothing`. **Hand-verified: it is a PROPOSAL** — *"**Rename** the surviving
helper module **to** `citadel/changed-source-helpers.ts`"* (`refinement_round1/analysis_codebase_c2.md:37`). They ran a
correct command, got a correct result, and asserted a false conclusion **by never reading the sentence around the
token.** That is the precise error this bundle exists to kill, committed by 2 of the 3 analysts auditing it, at a 2-1
majority. **A vote count would have shipped the wrong WS-4.** This anecdote is the single best field evidence for
`FOM_EVIDENCE_RULES` and MUST land in it (see WS-1).

**C-3 — All 44 baseline warnings are false positives, via three mechanisms** (hand-verified): **cwd-prefix mismatch**
(analysts cite relative to `extension/` and `extension/src/`; the checker greps root-anchored), **non-path tokens**
(the regex `spawn-refinement-team.ts:484` matches any backticked `foo/bar`, so `R-JPCM/WS-2` counts as a path), and
**forward-created/proposed paths** (C-2's class — a file the analyst is *proposing to create*).

**C-4 — The dominant citation idiom is a BARE BASENAME, and the shipped regex requires a slash.** Hand-verified over
the preserved baseline: **327** `file:line` citations, **264 (81%) carry no slash**. The naive reading of AC-FOMC-8
(add `:` to the character class) leaves the mandatory `\/` in place and therefore matches **0 of the 264** — WS-4
would ship green and stay blind to four-fifths of citations. **The fix is one subtractive rule, not a prefix ladder**
(see AC-FOMC-8, re-specified).

**C-5 — A NEW REQUIRED SURFACE the PRD never named: `.claude/commands/pickle-refine-prd.md`.** Hand-verified: FOM
probe **0**; appears **0** times in this PRD; it carries Step 6 "Synthesize Refined PRD" (`:150`) and Step 7's `Write`
of `rick_ticket_<hash>.md` (`:210`). `spawn-refinement-team.ts` has **no synthesis prompt** (its `build*` exports are
the 3 analysts, the env, and the manifest — verified). **On the default path, the synthesizer and ticket-writer IS
this command file.** It is the last hop before a ticket exists, and `rick_ticket_<hash>.md` is exactly the artifact
WS-5's primary metric hand-audits — **the falsifier measures the output of a surface no AC covered.** Enumeration
missed it; a 3-agent verification pass missed it; four analyses missed it. **This is the third time this family has
been caught missing a live surface** (`spawn-refinement-team.ts` → the original bug; `refine-analyze.js` → the first
draft; this → now). Enumeration found none of the three. **Ship the discovery sweep (AC-FOMC-1b).**

**C-6 — `refine-analyze.js` is NOT DEPLOYED.** Hand-verified: `grep -c workflows install.sh` → **0**;
`~/.claude/workflows/` **does not exist**. It is still infused (a twin that drifts is the antipattern), but it carries
**zero autonomous reach**, no coverage claim may rest on it, and WS-5 does not measure it. **The PRD required the
undeployed twin and skipped the deployed synthesizer.**

**C-7 — AC-FOMC-11 as written is UNSATISFIABLE.** Hand-verified: `tsc` emits an **import edge**, never an inlined
literal (`extension/services/dot-builder.js:5` imports `DEFAULT_FIX_BACKEND_PROMPT`; the literal appears **0** times
in that file). A builder's compiled mirror can therefore never contain the block *string*. The only way to satisfy the
AC as written is to **inline copies into every builder** — failing AC-FOMC-2(b) and re-shipping the hand-mirroring
antipattern across every judging surface at once. **That is the escape hatch an unattended worker is most likely to
take, and it is the bundle's worst possible failure mode.** Re-specified below.

**C-8 — The claimed reuse donor does not exist.** Hand-verified: `send-to-morty.md:38` — the PRD's named donor — is
*"Checkpoint as you work"*, a **session-checkpointing** section. `FOM_HONEST_REPORTING_RULES` has exactly one real
donor (`.claude/agents/morty-phase-verifier.md:18`, on a **default-OFF** surface). **`FOM_EVIDENCE_RULES` has no donor
anywhere — it is net-new authored prose, injected into every judging surface at once.** The Simplification Review
calls this "reuse." **It is an addition. Declared.**

**C-9 — The live hand-mirrored twin drift is IN THE FILES WS-2 MUST EDIT.** Hand-verified: `AC_SHAPE_PROMPT_SECTION`
(`spawn-refinement-team.ts:109`) is a template literal; its twin `AC_SHAPE_CONTRACT` (`refine-analyze.js:139`) is a
`[...].join()` array. Different carriers, already drifted. The manual's *"mirrored prose drifts like mirrored code"*
is not a prediction — **it is currently reproducing in the worksite.**

**C-10 — The judge silently scores with NO rubric if the deployed file is missing.** Hand-verified:
`pipeline-runner.ts:2142` → `return fs.existsSync(principlesPath) ? principlesPath : undefined;` — no warn, no event,
no throw. **Silence-is-not-success, failing inside the machinery being infused to teach that silence is not success.**
WS-5 must assert the deployed rubric exists before reading any judge result as evidence.

## The coverage map (measured, not asserted)

Probe used throughout (`FOM` = the infusion's own vocabulary):

```
grep -ciE 'ground.?truth|evidence hierarch|silence is not success|tree.?truth|checkpoint as you work|verify before' <file>
```

**⚠ The probe is noisy, and this PRD's first draft was bitten by it.** `spawn-morty.ts` greps 3 — but all
three hits are **code comments** using "ground truth" as an engineering term (`:1739`, `:1809`, `:1904` — git
reconciliation JSDoc), not prompt prose. The implementer's *actual* infusion lives in the prompt file
`spawn-morty.ts` loads: `.claude/commands/send-to-morty.md` (1 hit) + `.claude/agents/morty-implementer.md`
(1 hit). The thesis survives — the BUILDS surface *is* infused — but the grep both over-counts (comment noise)
and misattributes (the infusion lives in the loaded `.md`, not the `.ts`). **This is one more reason WS-1's
enumerated ledger, not this grep, must become the coverage source of truth.**

**The production prompt surfaces, by role** (spawn path = `extension/src/bin/`; workflow path =
`.claude/workflows/`):

| Prompt surface | The LLM it prompts | Role | FOM content |
|---|---|---|---|
| `send-to-morty.md` + `morty-implementer.md` (loaded by `spawn-morty.ts:buildWorkerPrompt`) | Morty implementer | **BUILDS** | **✅ infused** |
| `extension/templates/_pickle-manager-prompt.md` | the manager | **DRIVES** | **✅ infused** |
| `spawn-refinement-team.ts:buildWorkerPrompt` (`:534`; 3 analyst roles, inline) | the 3 analysts | **JUDGES the PRD** | **0 ❌** |
| `.claude/workflows/refine-analyze.js` `analystPrompt` (`:150`) + `synthPrompt` (`:197`) — **the workflow twin of the row above** | the 3 analysts + synthesizer | **JUDGES the PRD** | **0 ❌** |
| `microverse-runner.ts:buildJudgePrompt` (`:1613`) **and** `JUDGE_SYSTEM_PROMPT` (`:1593`) | the LLM judge | **JUDGES code quality** | **0 ❌** |
| `extension/szechuan-sauce-principles.md` (+ `-ui-`, `-financial-`) — the rubric the judge scores against | the LLM judge (context) | **JUDGES code quality** | **0 ❌** |
| `spawn-gate-remediator.ts:buildBriefContent` (`:76`) + its agent mirror `.claude/agents/morty-gate-remediator.md` | the gate remediator | **REMEDIATES the gate** (its clean exit is read as gate-GREEN) | **0 ❌** |
| `.claude/workflows/council-round.js` — `subagentPrompt` (`:224`), `codexSweepPrompt` (`:275`), `synthesisPrompt` (`:307`) | review panel | **JUDGES/REVIEWS** | **0 ❌** |

**Everything else:**

| Surface | Coverage |
|---|---|
| `.claude/commands/*.md` | **8 / 33** (`anatomy-park`, `pickle-dot-patterns`, `pickle-microverse`, `pickle-pipeline`, `pickle-standup`, `plumbus`, `send-to-morty`, `szechuan-sauce`) |
| `.claude/agents/*.md` | **2 / 18** (`morty-implementer`, `morty-phase-verifier`) — but note the `morty-phase-*` agents are **default-OFF** (`PICKLE_PHASE_PERSONAS`), so "2/18" overstates live-path reach; the default teams teammate is `morty-implementer` alone |
| `persona.md` | **0** — reach mechanism corrected in WS-3 (it is NOT what the first draft claimed) |

Note the tell: **`szechuan-sauce.md` and `pickle-microverse.md` ARE infused** — the human-facing command prose
got the treatment — **while `microverse-runner.ts`, which generates the actual judge prompt those commands
spawn, did not** (nor did the rubric files that judge reads). The infusion stopped at the surfaces a human reads.

**Doubly so:** the judge prompt is **firewalled from the persona lever by design** — `JUDGE_SYSTEM_PROMPT`
opens with *"Do NOT adopt any persona from CLAUDE.md or project instructions"* (`microverse-runner.ts:1595`)
and the judge prompt body repeats *"ignore any persona instructions"* (`:1660`). **No amount of `persona.md`
infusion can reach the judge. Its FOM content must live in its own prompt (WS-2), full stop.**

## Why this is P1 and not prompt hygiene

Line up the coverage map against the open honesty defects:

| Finding | Defect | Lives in | Infused? |
|---|---|---|---|
| [[R-JPCM]] | the run reports `converged` at score 4 against a target of 0 | `microverse-runner.ts` | **❌** |
| [[R-GRLS]] | the remediator exits clean having remediated nothing (read as a GREEN gate) | `spawn-gate-remediator.ts` | **❌** |
| [[R-RAFC]] | the analysts fabricate `file:line` citations; nothing verifies them | `spawn-refinement-team.ts` (and its untouched twin `refine-analyze.js`) | **❌** |
| [[R-BCFR]] | citadel cites a rule that exists in no CLAUDE.md | citadel analyzer *(code, not prompt — see Risks)* | n/a |

**Three of the four open honesty defects live in un-infused judging surfaces.** The infused surfaces
(implementer, manager) have produced none.

**⚠ What this does NOT prove (stated plainly, because this PRD is about not overclaiming).** These defects are
**older than the infusion** (2026-07-10/11), so the infusion did not *cause* them, and "un-infused prompt →
fabricates" is **not** established causally. What IS established is that the infusion's coverage map and the
honesty-defect map are **exact complements**. That makes completing the infusion a credible **systemic**
countermeasure rather than four separate patches — and it makes [[B-RLH]] look like three symptoms of one
disease. It is a strong hypothesis, and the soak (WS-5) is how we find out. **Do not let a ticket restate this
correlation as causation.**

**⚠ And two of the three may not even be prompt-addressable.** The judge emits **only a number** — its prompt
mandates *"Output ONLY a single integer or decimal number on the LAST line"* (`microverse-runner.ts:1658`);
the `converged` verdict is a **runner-side** score-vs-`convergence_target` comparison, which is why [[B-RLH]]
WS-4 exists (`isConverged` bare-`true`, a code defect). Likewise R-GRLS's false-GREEN is at least partly
**caller-side** (all three callers read a lockout as success). Infusing these prompts is honest-reporting
hygiene with real value at the margins — but **the behavioral fixes stay in [[B-RLH]] and this PRD claims no
behavioral fix for either.** WS-2's research phase must record, per defect, whether the prompt is causal or
cosmetic (the R-BCFR discipline, extended).

## Root cause: the infusion is hand-mirrored prose with no source, no markers, and no test

There is no way to know which surfaces carry the infusion — not for us, and not for a test. Coverage is untracked,
so a **missing** surface is invisible. That is why `spawn-refinement-team.ts` was skipped and nobody noticed —
and why this PRD's own first draft missed `refine-analyze.js`, **the production workflow twin of the exact
analyst team it fixes**. The antipattern caught the PRD written to kill it.

**The manual predicted this in its own field notes** (`docs/FABLE_OPERATING_MANUAL.md`, Addendum):

> **"Mirrored prose drifts like mirrored code.** The infusion hand-mirrored instructions into sibling prompts
> (worker/reviewer twins, Legacy/Teams manager arms) and drifted *within one session* — the GIT_BOUNDARY copies
> had already diverged before we ever looked. **A mirrored instruction family needs a pin test or a single
> source; 'I'll keep them in sync' is the asymmetric-fix antipattern in slow motion."**

It diagnosed itself and shipped anyway.

## The mechanism: GIT_BOUNDARY's ledger + a single-source constant (both proven IN THIS REPO)

`GIT_BOUNDARY_RULES` solved the *enumeration* half
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

**⚠ But GIT_BOUNDARY does NOT solve the identity half the way the first draft claimed.** Two corrections from
reading its actual contract:

1. It asserts identity of only the **PROHIBITED-verb sub-section** and explicitly allows per-file tails to
   vary (`git-boundary-prompts.test.js:114-138`) — it never asserts whole-block byte-identity.
2. It reads `.md` files with `readFileSync` + `indexOf` — a contract that **cannot port to the `.ts` builders**,
   whose prompts are assembled as `parts.push(...)`/`sections.push(...)` arrays (`microverse-runner.ts:1622+`,
   `spawn-gate-remediator.ts:86+`); a multi-line block is not a contiguous substring in that source, and any
   backtick or `${` in the prose would escape differently in a template literal than in markdown.

**The identity half is solved by the repo's OTHER proven pattern: a single exported constant.**
`DECOMPOSITION_COLOCATION_PROMPT_SECTION` (`spawn-refinement-team.ts:507`, consumed at `:529`) already
single-sources a prompt block exactly this way. So:

- each FOM block is defined **once**, as an exported constant containing **no backticks and no `${`**, in a
  shared module;
- every `.ts` prompt-builder **imports** it (identity is automatic — there is nothing to drift);
- every `.md`/persona surface carries the constant's exact string between HTML-comment sentinels, and the shape
  test asserts the file content matches the constant.

**This is [[R-FOMH]] leg (e), which has sat unbuilt because it was filed as needing an "operator decision."**
It is not a decision. GIT_BOUNDARY + the colocation constant already made it. Filing it as a decision is what
kept it unbuilt while the prose rotted.

## ⛔ Hard constraint: deployed prompts must be SELF-CONTAINED

From the same addendum — the infusion's own first failure:

> "My first injections cited '(FOM §N)' — an acronym that greps to nothing, in files read by workers whose cwd is
> the **target** repo and whose runtime **never deploys `docs/`**."

`docs/FABLE_OPERATING_MANUAL.md` is **physically unreachable** from a worker running in loanlight-api. The prose
must live **in the prompt**. **No `(see FOM §N)` citations, no "read the manual" pointers.** Provenance lives in
git blame.

## Workstreams

| WS | What | Shape *(refined — the original labels understated three of five)* |
|---|---|---|
| **WS-1** | The **shape test + single-source constants + delimited blocks + the discovery sweep** — the enforcement mechanism | reuse (GIT_BOUNDARY ledger + colocation-constant identity) **+ net-new authored prose** (C-8) **+ the discovery sweep** (C-5) |
| **WS-2** | Infuse the **judging surfaces** — both refinement twins, **the default-path synthesizer/ticket-writer (C-5)**, both judge prompts, the rubric files, the remediator brief + agent mirror, the council prompts (folds in [[R-RAFC]]) | **ADDITION, not reuse** — `FOM_EVIDENCE_RULES` has no donor (C-8) |
| **WS-3** | Infuse **`persona.md`** — worker-prompt reach; **option (b) DECIDED** (see WS-3) | reuse |
| **WS-4** | **Instrument hygiene** on the analyst-output checker: subtractive path resolution, extension-required tokens, split `defect_class`, memoize + timeout. **ADVISORY. It does NOT detect fabrication (C-1).** | **instrument repair** — NOT "a small addition (a parsing branch)" |
| **WS-5** | **Soak**: does an infused judging surface actually stop lying? (the falsifier) | measurement — **metric re-specified (C-1)** |

**Mandatory revert order (WS-2/WS-3 import WS-1's constant; reverting WS-1 alone leaves dangling imports and a red
`tsc`): WS-4 → WS-3 → WS-2 → WS-1.**

## Non-Goals (consolidated — these were scattered across six locations and the two that matter most were easiest to miss)

1. **This bundle claims NO behavioral fix for [[R-JPCM]]** (`converged` at score 4). That is a **code** defect
   (`isConverged` bare-`true`) and stays in [[B-RLH]] WS-4.
2. **This bundle claims NO behavioral fix for [[R-GRLS]]** (the false-GREEN remediator). It is at least partly
   **caller-side** and stays in [[B-RLH]].
3. **R-BCFR is not a prompt defect at all** — it is a hardcoded string literal (`banned-constructs-audit.ts:129`).
   Infusion cannot fix it. Stays in [[B-RLH]] WS-1.
4. **WS-4 does not gate, block, or down-weight anything.** It is advisory by construction, and after C-1 it is not
   even a fabrication detector. Do **not** build a fabrication gate (W5b).
5. **Verifying that a cited line SAYS what is claimed is out of scope** — not machine-checkable. That burden lives in
   the analyst prompt (WS-2). This is the whole lesson of C-1.
6. **Do NOT add the shape test to `RELEASE_GATE_COMMAND`** — `release-gate-parity.test.js` pins that string
   byte-for-byte against `ci.yml`+`release.yml`; a 3-file coupled edit for zero gain. `@tier: fast` is enough.

### WS-1 — the enforcement mechanism (build this FIRST; everything else is inert without it)

Define the blocks **by concern**, not by file. Start with the ones the open defects demand — resist inventing a
taxonomy:

- `FOM_EVIDENCE_RULES` — *verify a citation before you assert it; a claimed grep result must be a grep you
  actually ran; an unverified mechanism is a hypothesis — label it as one.*
  **⚠ It MUST cut both ways (C-1, C-2 — this refinement produced BOTH errors):**
  > *A path that resolves is not a verified claim. A path that does NOT resolve is not a fabrication — it may be a
  > file someone is proposing to create. **Verify the claim, not the token.***

  This is not aspirational prose. In the refinement of this very PRD: one analyst confirmed the baseline manifest
  said "44" and asserted the number *meant* fabrication (it meant nothing — all 44 were false positives); two
  analysts ran a correct `git ls-files`, got a correct empty result, and declared a **proposal** to be a
  **fabrication**. Same error, both directions: **treating the citation as the claim.**
- `FOM_HONEST_REPORTING_RULES` — *silence is not success; a fast clean pass is a gate that did not fire; never
  report an outcome you did not observe.* **Sole donor: `.claude/agents/morty-phase-verifier.md:18`** (verified).
  `FOM_EVIDENCE_RULES` has **no donor** — it is net-new prose (C-8).

Each block: one exported constant (no backticks, no `${`) in a shared module; `.ts` builders import it; `.md`
surfaces carry it between `<!-- BEGIN FOM_EVIDENCE_RULES -->` / `<!-- END FOM_EVIDENCE_RULES -->` sentinels.

- `AC-FOMC-1`: `extension/tests/skill-prompt-shape/fom-infusion-prompts.test.js` exists, enumerates every surface
  in the infusion family, and **FAILS when an enumerated surface lacks its block**. The red-proof must be real:
  factor the per-surface assertion into one shared helper and add a case that feeds the helper a real surface's
  content with the block stripped, asserting it **throws via the SAME helper the live assertions use** (a
  test-local re-derivation would be the AC-DR-05 unfalsifiable-green trap door all over again).
- `AC-FOMC-2` (re-specified — whole-block cross-language byte-identity is not achievable and GIT_BOUNDARY never
  claimed it): (a) each block is a single exported constant containing no `` ` `` and no `${` **in the block
  PROSE** (the cited precedent `DECOMPOSITION_COLOCATION_PROMPT_SECTION:507` is itself declared *as* a template
  literal — the rule is about the prose, not the declaration; say so or a worker concludes the precedent violates
  the rule); (b) every enumerated `.ts` builder **imports** the constant — the test greps the import, so a re-typed
  inline copy fails; (c) every enumerated `.md`/persona surface contains the constant's exact string between its
  sentinels; **(d) (the third carrier — C-6/C-9)** the sandboxed `.claude/workflows/*.js` twins can be neither (they
  have zero `import`/`require` and no filesystem access): they carry the block as **one top-level `const` assigned a
  single unindented template literal at column 0**, and the test asserts substring containment. **Forbid the file's
  own `[...].join('\n')` idiom for FOM blocks** — an array of per-line literals is **not a contiguous substring**,
  which is exactly the property that ruled `readFileSync`+`indexOf` out for `parts.push`-assembled `.ts`. (This is
  not hypothetical: `AC_SHAPE_CONTRACT:139` uses the array form today, and has already drifted from its twin — C-9.)
  **(e) A FOM block carries EPISTEMICS ONLY — never output-format, schema, or emission instructions.** A shared
  constant carrying an output contract is un-shareable **by construction**, because the two runtimes have different
  output contracts — and the first "helpful" addition of *"and report your findings as…"* re-forks the twins
  permanently. That is precisely how `AC_SHAPE_PROMPT_SECTION`/`AC_SHAPE_CONTRACT` drifted into contradiction.
- `AC-FOMC-3` (**regression guard — already green at HEAD**, verified 2026-07-14; it pins the door shut, it does
  not fix anything): zero `(FOM §N)`-style unresolvable citations in any deployed prompt:
  `! grep -rE 'FOM §|see the operating manual|FABLE_OPERATING_MANUAL' .claude/ extension/src/bin/ extension/bin/ extension/templates/ persona.md`
  (widened over the first draft to include the compiled mirror and templates).
- `AC-FOMC-1b` (**DISCOVERY, not merely enumeration — the highest-value AC in this bundle; C-5**): the shape test
  **globs the prompt-surface space** — `.claude/agents/*.md`, `.claude/commands/*.md`, `.claude/workflows/*.js`,
  `extension/templates/_*.md`, `persona.md`, and every `extension/src/bin/*.ts` exporting a `*Prompt` symbol or a
  `build*Prompt` function — and **FAILS if any discovered surface appears in neither the FAMILY list nor an
  `EXCLUDED` list**, where each `EXCLUDED` entry is `{path, reason}`. Seed `EXCLUDED` from `## Deferred surfaces`
  (each already carries its reason). **A new prompt surface must be CLASSIFIED, not merely ignored.**
  **Why this is non-negotiable:** this family has been caught missing a live surface **three times** —
  `spawn-refinement-team.ts` (the original bug), `refine-analyze.js` (the first draft), `pickle-refine-prd.md`
  (cycle-2 refinement, *after* a 3-agent verification pass and four analyses). **Enumeration found none of the
  three.** A ledger fails only for a surface it *names*. The sweep is what makes a skipped surface impossible.
- `AC-FOMC-11` (**RE-SPECIFIED — the original is unsatisfiable; C-7**). The original demanded each `.ts` builder's
  compiled mirror carry the block **string**. `tsc` emits an **import edge** and never inlines an imported constant
  (`extension/services/dot-builder.js:5` imports `DEFAULT_FIX_BACKEND_PROMPT`; the literal appears **0** times in
  that file). Satisfying it would require **inlining copies into every builder** — failing AC-FOMC-2(b) and
  re-shipping the hand-mirroring antipattern across every judging surface at once. **That is the escape hatch an
  unattended worker is most likely to take. Do not leave it open.** Replace with:
  - `AC-FOMC-11a` (**import-edge form**): the shape test asserts (a) the **constants module's** compiled mirror
    (`extension/services/fom-blocks.js`) contains each block string verbatim, **and** (b) each enumerated `.ts`
    builder's compiled mirror contains an **import of the block symbol**.
  - `AC-FOMC-11b` (**the real deploy pin — REUSE, do not invent**): add `bin/spawn-refinement-team.js`,
    `bin/microverse-runner.js`, `bin/spawn-gate-remediator.js` to `install.sh`'s `_parity_files` MD5 array
    (`:408-414` — today exactly **5** entries, **none of them judging builders**; verified). This reuses the shipped
    post-rsync parity probe, the only mechanism in the repo that fails on source-green/deploy-stale.
  - `AC-FOMC-11c` (**the rubric has no compiled mirror**): `szechuan-sauce-*-principles.md` deploy by a `cp` loop
    (`install.sh:517-518`). Extend the existing `install-ui-principles.test.js` (`AC-PIAP-B3-1`) from an
    **existence** assertion to a **content** assertion. Do not invent a new check.
- `AC-FOMC-13` (**bound the bloat — the top-listed Risk had no AC; the shape test already opens every file**): each
  FOM constant is **≤ 5 lines and ≤ 400 bytes**. `persona.md` is 85 lines / 4930 bytes (verified) and rides in
  **every** worker spawn. **An unenforced budget in a Risks section is how prompts rot — which is the thesis of this
  very PRD.**
- Keep the test `@tier: fast` (like git-boundary; `// @tier: fast` on **line 1** or `audit-test-tiers.sh` fails the
  release gate). Do **NOT** add it to `RELEASE_GATE_COMMAND` — see Non-Goals #6.

### WS-2 — infuse the judging surfaces (folds in R-RAFC)

The enumerated set (each also lands in WS-1's ledger):

1. `spawn-refinement-team.ts` (the 3 analyst role prompts) **and its production workflow twin
   `.claude/workflows/refine-analyze.js`** (`analystPrompt:150`, `synthPrompt:197`) — infusing one twin and not
   the other would re-ship the exact drift this PRD exists to kill.
2. `microverse-runner.ts` — **both** `buildJudgePrompt` (`:1613`) and `JUDGE_SYSTEM_PROMPT` (`:1593`; the
   persona firewall makes this the judge's only possible carrier).
3. The judge's rubric context: `extension/szechuan-sauce-principles.md`, `-ui-principles.md`,
   `-financial-principles.md`.
4. `spawn-gate-remediator.ts:buildBriefContent` (`:76`) **and its agent mirror
   `.claude/agents/morty-gate-remediator.md`** (another twin pair — both or neither).
5. `.claude/workflows/council-round.js` — `subagentPrompt`, `codexSweepPrompt`, `synthesisPrompt`.
6. **`.claude/commands/pickle-refine-prd.md` — THE DEFAULT PATH'S SYNTHESIZER AND TICKET-WRITER (NEW; C-5).**
   Step 6 "Synthesize Refined PRD" (`:150`); Step 7 "Task Decomposition" (`:168`); the `Write` of
   `rick_ticket_<hash>.md` (`:210`). Probes **0**; appeared **0** times in the first draft.
   `spawn-refinement-team.ts` contains **no synthesis prompt** — on the deployed `.ts` path, the synthesizer **is
   this command file**. **It is the last hop before a ticket exists, and `rick_ticket_<hash>.md` is exactly the
   artifact WS-5's primary metric hand-audits — the falsifier was measuring the output of a surface no AC covered.**
   Carrier: `.md` sentinel (clause c). Note the symmetry: Step 5 of that same file already tells the synthesizer to
   read `refinement_manifest.json` — the file WS-4's warnings land in. **Infusing this surface is what makes WS-4's
   output actionable rather than merely legible.**

**⚠ Reach note (C-6), so no coverage claim rests on a fiction:** `refine-analyze.js` is **not deployed**
(`grep -c workflows install.sh` → 0; `~/.claude/workflows/` does not exist). It is infused **because a twin that
drifts is the antipattern this bundle exists to kill** — not because it has reach. It carries **zero** autonomous
reach, AC-FOMC-4 must not count it as coverage, and WS-5 does not measure it. Likewise the `-ui-` and `-financial-`
rubrics load **only** under `--szechuan-domain`, which no default caller passes — the *same* predicate under which
this PRD defers `send-to-morty-review.md`. Infuse them, but **claim no reach from them.**

**R-RAFC's specific fix belongs here.** `spawn-refinement-team.ts:569` currently instructs:

> "Use **file:line references for every codebase claim**."

It **mandates citation precision and never asks anyone to verify one.** Widen it to *"file:line references **you
have verified**; mark anything unverified as a hypothesis"* — **in both twins** (`refine-analyze.js` carries
its own copy of the analyst role instructions).

- `AC-FOMC-4`: every surface in the list above carries the appropriate block(s) and is enumerated in WS-1's test.
- `AC-FOMC-5`: the citation mandate requires verification in **both** refinement twins.
- `AC-FOMC-6` (softened from the first draft — presence, not behavior): `buildJudgePrompt` and
  `JUDGE_SYSTEM_PROMPT` carry `FOM_HONEST_REPORTING_RULES`. **The behavioral `converged`-at-4 fix is [[B-RLH]]
  WS-4 (`isConverged` bare-`true` — a code defect) and is NOT claimed here.** Coordinate: land B-FOMC first;
  R-JPCM rebases onto the infused block.
- `AC-FOMC-12` (the prds/CLAUDE.md contract-match rule — a mandated reuse must print both contracts): the
  research artifact MUST show GIT_BOUNDARY's contract (readFileSync+indexOf over `.md`) beside the FOM family's
  (mixed `.md` + `parts.push`-assembled `.ts`) and state the delta and its resolution (the single-source
  constant). It must ALSO record, for R-JPCM and R-GRLS, whether the defect is prompt-causal or code-causal
  (see "Why this is P1").

### WS-3 — persona.md (reach mechanism corrected; the first draft was wrong here)

**What the first draft claimed:** persona.md "is the source of `~/.claude/CLAUDE.md` (`install.sh:516`), in
context on every turn of every session in every repo." **What is true (verified 2026-07-14):**

- `install.sh:516` is `cp persona.md "$EXTENSION_ROOT/persona.md"` — it deploys into the **extension root**,
  and it does **NOT** write `~/.claude/CLAUDE.md`. The CLAUDE.md landing is a **manual operator step** install.sh
  merely *prints* (`install.sh:755-762`).
- The deployed `~/.claude/CLAUDE.md` carries a `<!-- BEGIN PICKLE RICK PERSONA (managed by install.sh …) -->`
  marker that **no script maintains** — the marker's own claim is false. (Noted; fixing install.sh is a
  decision point below, not an assumption.)
- persona.md's **real automated reach** is `spawn-morty.ts:readBasePersona` (`:143`) → the Morty **worker**
  prompt (`## Active Persona`). That is a BUILDS surface. **It does not reach the three judging
  prompt-builders** (the analysts use their own inline persona const, `spawn-refinement-team.ts:543`; the judge
  is persona-firewalled; the remediator brief never reads it).

So WS-3 is real but its leverage is **worker-prompt reach + whatever CLAUDE.md the operator has pasted**, not
"O(1), 100% reach, reaches the judge." The judge is reached only by WS-2.

- `AC-FOMC-7`: `persona.md` carries both blocks and is enumerated in WS-1's test.
- `AC-FOMC-7b` — **DECIDED IN THE PRD: option (b). Do not re-litigate this in a worker's research phase.**

  **The decision, and the argument that settles it.** The Codebase analyst argued for option (a) (make `install.sh`
  maintain the `~/.claude/CLAUDE.md` persona block) on the ground that the CLAUDE.md channel is *"the ONLY automated
  mechanism that reaches the ticket-writer"* — because the analysts and the synthesizer are plain `claude -p`
  subprocesses with no persona firewall, so they inherit `~/.claude/CLAUDE.md` through the harness. **That reach
  claim is correct** (and the judge's explicit firewall — *"Do NOT adopt any persona from CLAUDE.md"*,
  `microverse-runner.ts:1595` — is the proof the channel is live: you do not firewall a channel that isn't there).

  **But its premise died with C-5.** The argument rests on *"WS-2 cannot reach the synthesizer — there is no `.ts`
  builder to import a constant into."* **WS-2 item 6 now reaches it directly, via the `.md` sentinel — an
  ENFORCEABLE carrier, pinned by the shape test.** So option (a) buys nothing that WS-2 item 6 does not already buy,
  **enforceably**, and pays for it with the largest blast radius in the repo (a write to the operator's global
  config, outside the repo). Option (a) is **additive machinery to reach a surface we now reach subtractively.**
  Three further nails: a worker **cannot** demonstrate it green (`bash install.sh` is bash-scanner-blocked with **no
  override flag**); `install.sh` today never even mentions `~/.claude/CLAUDE.md` — it only *prints* instructions for
  the **project's** `.claude/CLAUDE.md` (`:758`, `:762`), so option (a) would have to invent which file it maintains
  and ship a third variant; and the un-maintained `<!-- BEGIN PICKLE RICK PERSONA -->` marker is a **doc lie**, which
  is cheaper to fix by **deleting the false claim** than by building machinery to make it true.

  **Therefore:** (b) — downscope to worker-prompt reach + documented manual propagation, and **strike every "100%
  reach" / "O(1)" claim** from the PRD. Additionally, **subtract the lie**: correct the `<!-- BEGIN PICKLE RICK
  PERSONA (managed by install.sh …) -->` marker text so it no longer claims to be script-managed when nothing
  manages it. That is a doc edit, not machinery — and it is the honest version of "make an existing lie true."
- **Do NOT hand-edit `~/.claude/CLAUDE.md`** — edit `persona.md`, run `bash install.sh`
  ([[feedback_persona_source_of_truth]]) — noting per above that today this updates worker-prompt reach only.
- Pin-test note (corrected): the only test that reads the real `persona.md` is
  `persona-step0-creation-heavy-skip.test.js` (four additive contains-checks — appended blocks are safe).
  `release-gate-parity` / `codegraph-docs-optin-parity` pin the repo-root `CLAUDE.md`/`README.md`, **not**
  persona.md; they are unaffected. ⚠ Watch the token budget regardless: persona.md rides in every worker prompt.

#### WS-3 gate corrections (manager, 2026-07-14, ticket `a460cad3`) — both gates were broken

The worker refused to fake either gate and escalated. It was right. Recorded here rather than quietly
re-written, because a silently-relaxed gate is the exact failure this bundle exists to kill.

- **AC-FOMC-7c passed VACUOUSLY — the subtraction has no in-repo target.** The string
  `managed by install.sh` appears **nowhere in `install.sh`**, and nowhere in the repo except this PRD
  *quoting* it (`:413`, `:447`). Nothing in the tree emits the marker — not `install.sh`, not
  `persona.md`. It exists **only** at `~/.claude/CLAUDE.md:1`, which is unversioned, written by no
  script, and which this PRD (`:449`) forbids hand-editing. So `! grep -q 'managed by install.sh'
  install.sh` goes green **by finding a string that was never there** — the bundle's own
  `FOM_HONEST_REPORTING_RULES` verbatim: *a fast clean pass may mean the gate never fired.* The PRD
  ordered a doc edit to a file it put off-limits. **Not claimed green. Demoted to an operator
  residual** (see Drain Queue below).
- **AC-FOMC-7b could NEVER pass as written — the gate matched its own success condition.** Its verify,
  `! grep -rniE '100% reach|O\(1\) reach' persona.md <this-PRD>`, hits exactly two lines, and **neither
  is a live claim**: `:422` is this PRD *quoting the dead claim in order to refute it* ("…not `"O(1),
  100% reach, reaches the judge."` The judge is reached only by WS-2"), and `:669` is the ticket table
  row **stating the acceptance criterion itself** (`no "100% reach" claim survives`). A grep that cannot
  tell **use from mention** fires on its own retraction and on its own AC. Permanently red ⇒ permanently
  ignored, which is worse than no gate. `persona.md` — the only surface where such a claim ships (it
  rides in every worker prompt) — has **zero** matches.
  **Resolution (subtractive, per [[feedback_subtract_flaky_gate_input_not_add_resistance]]):** scope the
  verify to `persona.md`. We did **not** add use/mention resistance to the regex, and we did **not**
  paraphrase the PRD's refutation to dodge a token — contorting the doc to satisfy a broken instrument
  is the dishonesty, not the fix. Read the sentence, not the token
  ([[feedback_analyst_majority_is_not_truth_grep_the_sentence]]).

**Both defects are the same species as C-1** ([[project_b_fomc_checker_structurally_blind_to_fabrication]]):
a checker that cannot detect what it was built to detect. This bundle has now caught it in its own ACs
**twice**. That is the discipline working — on itself.

### WS-4 — make the EXISTING checker earn its keep (a small honest addition, not "nothing")

`checkAnalystOutputPaths` (`spawn-refinement-team.ts:479-500`; emission loop at `:2142-2151`) already parses
analyst output for backticked paths and git-verifies **path existence**. Two hard facts from reading it:

- Its regex (`:484`) has **no `:` in the character class** — a `` `foo/bar.ts:42` `` citation **never matches
  at all**. Line-cited fabrications aren't "passed"; they are *invisible*. AC-FOMC-8 is therefore a new parsing
  branch, not a widening — say so honestly.
- Warnings are **already role-attributed** (`evidence: analyst=<role> path=<p>`, `file_line: analysis_<role>.md`
  — `:2147-2149`), and `ticket_id: ''` is **correct** (they fire pre-decomposition; no ticket exists). The
  first draft's "unattributed" was wrong about the field, right about the legibility: nothing surfaces the
  attribution, and cycle provenance is unrecoverable from the cycle-final `analysis_<role>.md` files the
  scanner reads.

All three R-RAFC fabrications cite real files and were invisible or unremarked to this checker. It emitted
**44 warnings** on the 2026-07-14 baseline run and blocked/down-weighted nothing.

**⚠ READ C-1 FIRST. WS-4 is HYGIENE, not detection.** The checker verifies **path existence**; R-RAFC's fabrications
**cite real files and lie about what those files do**. It therefore caught **0 of 2**, and a `file:line` + line-count
widening still catches **0 of 2** (the file exists; the line is in range). **WS-4 cannot reduce fabrication and must
claim no such thing.** Its honest job is to stop lying at *us* — the instrument is **98% false-positive** today, and
`AC-FOMC-9` as originally written would have promoted that noise into dedicated attribution fields: **a dashboard on
a broken gauge.** Fix the flaky input; do not decorate it ([[feedback_subtract_flaky_gate_input_not_add_resistance]]).

- `AC-FOMC-8` (**RE-SPECIFIED — the original ships green and sees 19% of citations; C-4**): the shipped regex
  (`:484`) **mandates a slash** (`/`` `([a-zA-Z][a-zA-Z0-9/_.-]*\/[a-zA-Z0-9/_.-]+)` ``/`), but **264 of 327 (81%)
  of real citations are bare basenames** (`microverse-runner.ts:1613`). Adding `:` to the character class — the
  obvious reading of the original AC — leaves the `\/` in place and **matches 0 of the 264**. Instead:
  - **(a) A token is a citation only if it carries a FILE EXTENSION**, with or without slashes, optionally suffixed
    `:<line>`. This is **subtractive**: it kills the `not_a_path` class (`R-JPCM/WS-2`, `B-RLH/WS-1..5`,
    `MICROVERSE_FATAL/FAILURE_REASONS`) by *removing* matches, rather than adding a rule to suppress them.
  - **(b) Resolution is SUFFIX-based, not root-anchored, and NOT a prefix ladder:** a citation resolves if **any
    tracked file ends with it** — `git ls-files -- '*<token>'`. **Hand-verified 2026-07-14: this resolves every
    misresolved baseline citation with exactly ONE match each — zero over-match** (`*tests/microverse.test.js` →
    `extension/tests/microverse.test.js`; `*types/index.ts` → `extension/src/types/index.ts`;
    `*bin/spawn-gate-remediator.ts` → `extension/src/bin/spawn-gate-remediator.ts`). It handles bare basenames,
    `extension/`-relative, and `extension/src/`-relative citations **in one rule**, and it **deletes** the
    root-anchoring assumption rather than adding a special case.
    **⛔ Do NOT hardcode an `extension/` (or `extension/src/`) prefix fallback.** `extension/` exists in **exactly one
    repository on earth — this one** — and this checker runs inside the shared refinement runtime that refines
    `octy`, `loanlight-api`, and `attractor`. A prefix ladder is **a per-stack adapter inside the repo-agnostic
    core** — a defect by invariant ([[feedback_pickle_rick_must_be_repo_agnostic_invariant]]), and it would be shipped
    by the bundle whose entire subject is not shipping unverified assumptions. *(One analyst proposed exactly this in
    cycle 2 and retracted it in cycle 3 on precisely this ground. A second analyst then attacked the **withdrawn**
    version and proposed a 4-rung ladder in its place. Take the suffix form.)*
  - **(c)** When `<line>` is present and the file resolves, assert **`<line>` ≤ the file's line count.** (This
    deletes the original's unbound free variable `N` — *"contains ≥ N lines"* never defined `N`.)
  - **(d) Ambiguity is explicit:** if `git ls-files -- '*<token>'` returns >1 match, emit `ambiguous_citation`.
    Measured: of 40 unique cited basenames, exactly **one** (`activity-events.schema.json`, 2 candidates) is
    ambiguous. Do not silently pick the first.
  - **Still explicitly out of scope: verifying the line SAYS what is claimed.** Not machine-checkable. **That is the
    entire defect class (C-1), and its only countermeasure is the analyst prompt (WS-2).**
- `AC-FOMC-9` (**re-specified**): `defect_class` is **split, not bucketed** — `path_not_found` |
  `line_out_of_range` | `not_tracked_forward_created` | `ambiguous_citation`. **One bucket destroys the only
  comparison this bundle has.** `not_tracked_forward_created` is **mandatory, not optional**: it is the C-2 class
  (a file the analyst is *proposing to create*), and **this bundle forward-creates its own `fom-blocks.ts` and
  `fom-infusion-prompts.test.js`** — without the split, the bundle's own new files inflate the very signal it is
  measured by. Attribution surfaces via dedicated `analyst` and `cycle` fields; `cycle` **is** recoverable — the
  per-cycle artifacts are `analysis_<role>_c<N>.md`, in the directory the scanner already reads (the original AC's
  `worker_<role>_c<N>` premise was false — those are worker *logs*). Do **not** overload `ticket_id`; it is
  correctly empty (these fire pre-decomposition).
- `AC-FOMC-14` (**bound the hot path — this is a Worker Forbidden Op TODAY**): the `git ls-files` `spawnSync`
  (`:487-492`) passes **no `timeout`** (verified) — CLAUDE.md's Worker Forbidden Ops table names an un-timeout'd
  `spawnSync` as requiring a declared per-callsite trap door. It fires **44 un-deduped subprocesses for 21 unique
  paths** today (2.1× pure waste), and WS-4 makes every one of 327 citations resolvable. **Memoize per unique token
  and add a `timeout`** (or declare the trap door). Both are strictly subtractive against the current hot path.
  `:361` (`runReadinessGate`) needs the same.
- **Stays ADVISORY.** Per W5b, do **not** build a fabrication gate. The cross-cycle catch already works — both
  R-RAFC fabrications were caught by a later cycle. Make the signal legible and let the next cycle use it.
- Scope note: the workflow twin (`refine-analyze.js`) has no equivalent checker; building one there is NOT in
  scope (it would be new machinery) — the twin gets the prompt-side fix (WS-2) only. Recorded so the asymmetry
  is a decision, not a drift.

### WS-5 — the soak (the falsifier; this is what makes the thesis honest)

The correlation above is a hypothesis. Test it.

- `AC-FOMC-10` (**RE-SPECIFIED — the original's primary metric is structurally blind; C-1**). **Pre-registered
  decision rule, written BEFORE any soak run** (with the instrument moving and n=1 on a stochastic system, every
  outcome otherwise narrates as confirmation):
  - **Primary metric: hand-audited fabrication count over the resulting `rick_ticket_<hash>.md` files.**
    Baseline = **2** (R-RAFC's two fabricated mechanisms). **Success = 0. Null = ≥ baseline. Anything between is
    null.**
  - **⛔ Warning count is DESCRIPTIVE ONLY and is NOT a success metric.** The checker verifies path *existence*;
    both baseline fabrications **cite real files and lie about what they do**, so the checker caught **0 of 2** and
    a repaired checker still catches **0 of 2**. **An infusion that eliminated 100% of fabrication would move the
    warning count by ~0.** Record it; never read it as the result. *(Re-baseline the repaired checker over the
    preserved artifacts anyway — expect it to fall to near zero, which is the honest finding: the instrument never
    measured fabrication.)*
  - **Name the path.** The soak exercises the **`spawn-refinement-team.ts`** spawn path. `refine-analyze.js` is
    **not deployed** and is **not measured** (C-6). **Verify the infusion is live post-`bash install.sh` before
    reading any result** — a null from an un-infused path is a **false null**, and this PRD pre-commits to treating
    nulls as disconfirming. Likewise **assert the deployed rubric exists** before reading any judge result (C-10:
    `pipeline-runner.ts:2142` returns `undefined` silently).
  - **The soak is a THROWAWAY refinement of the preserved B-RLH PRD into a scratch session dir, explicitly
    discarded.** It is **NOT** B-RLH's real decomposition. This PRD `blocks:` B-RLH, so running the soak *as* B-RLH's
    refinement would mean (i) a second sample produces a second, divergent decomposition of B-RLH with no assigned
    tie-breaker, and (ii) a verdict of *"revert the refinement-path edit"* would arrive **after** B-RLH had already
    been decomposed by the reverted prompts. Cost per run: 3 cycles × 3 analysts = **9 spawns**.
  - **n=1 cannot separate infusion effect from LLM variance.** Run it twice, or **record explicitly that the result
    is under-powered and supports no causal claim.**
  - **A null result is a real result and must ship as one** — if infusion changes nothing, the disease is elsewhere
    and B-RLH's three symptom-fixes are the right level after all.
- `AC-FOMC-10b` (**the revert lever the Rollback section wrongly waived**): WS-2 edits `spawn-refinement-team.ts` —
  **the front door of every future PRD refinement in this repo.** "No kill-switch is warranted" is right for the
  judging surfaces and **wrong for the analysts**: if the infused prompt degrades analyst output (over-cautious
  citation, turns burned self-verifying), every future refinement degrades with no lever. **WS-5 is a GATE on
  retaining WS-2's refinement-path edit, with a named revert trigger.**

## Deferred surfaces (enumerated so the skip is a decision, not a drift)

The inventory that produced the coverage map also surfaced these. They are **deliberately NOT in the required
family** — each with the reason on the record:

- `send-to-morty-review.md` — **dead on the autonomous path** ([[R-RWNF]]): selected only by spawn-morty's
  `--review` flag, which no production caller passes. Do not count it as reach; its disposal belongs to R-RWNF.
- `morty-phase-*` agents (reviewer/verifier/simplifier/etc.) — **default-OFF** (`PICKLE_PHASE_PERSONAS`); infuse
  when/if that flag graduates.
- `correct-course.ts` (`:13`), `archaeology.ts` (`:118`), `debate.ts` + `generate-debate-personas.ts` —
  ANALYZE-class, user-invoked, not on the autonomous pipeline hot path.
- `citadel.md` — the *manual* `/citadel` path's judge prose; the autonomous pipeline runs the in-process
  analyzer instead. Opportunistic follow-up.
- `mux-runner.ts` inline handoff nudges (`COMMIT_PENDING_HANDOFF_TEXT:3871`, false-epic `retryBrief:~10983`) —
  DRIVE-class micro-prompts; honesty-adjacent but single-purpose. Enumerate in the ledger as excluded.
- `~/.claude/commands/pickle-portal.md` — deployed-only, **no repo source** (referenced once, from
  `attract.md:78`); and `ui-test-worker.md`, same class — both are [[R-FOMH]] leg (a) source-of-truth
  adoptions, not infusion targets.

## Simplification Review (subtract-before-add)

1. **Is the addition necessary at all?** *(corrected — the original under-declared its own additions in the section
   whose entire purpose is declaring them; C-8)* WS-1 adds one shape test **plus a discovery sweep** (AC-FOMC-1b)
   plus one shared constants module. **WS-2 ships NET-NEW AUTHORED PROSE — it is an ADDITION, not a reuse.**
   `FOM_EVIDENCE_RULES` has **no donor anywhere in the repo** (verified); the PRD's named donor, `send-to-morty.md:38`,
   is a *session-checkpointing* section (*"Checkpoint as you work"*). `FOM_HONEST_REPORTING_RULES` has exactly one
   real donor (`morty-phase-verifier.md:18`) **on a default-OFF surface this PRD defers.** So the honest declaration
   is: **unproven prose, authored once, injected simultaneously into the analysts, the synthesizer, the judge, three
   rubrics, the remediator, and the council.** That is the bundle's real risk profile and it was hidden behind the
   word "reuse." WS-4 is an **instrument repair**, not "one parsing branch." WS-5 is measurement.
2. **Can it REUSE instead of ADD?** Where it genuinely can, it does — and those are named honestly.
   Enforcement = GIT_BOUNDARY's enumeration ledger. Identity = the `DECOMPOSITION_COLOCATION_PROMPT_SECTION`
   single-constant pattern (`spawn-refinement-team.ts:507`). The deploy pin = `install.sh`'s existing `_parity_files`
   MD5 probe (AC-FOMC-11b) — **not a new check.** The rubric deploy assertion = the existing
   `install-ui-principles.test.js` extended from existence to content (AC-FOMC-11c) — **not a new test.** The checker
   is the one already wired. **But the PROSE is not reuse, and this section will not pretend otherwise.**
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** No new guards. WS-4
   explicitly **refuses** to add a fabrication gate — the honest fix is to *tell the analysts to verify*, not to
   police them after the fact. Adding a gate around an un-instructed worker is the guard-on-a-guard smell.
4. **What can this issue SUBTRACT?** The hand-mirroring discipline itself — after WS-1 the family has a single
   canonical constant and a test that enumerates its members, so "I'll keep them in sync" stops being a
   maintenance obligation. Closes [[R-FOMH]] leg (e) and retires its false framing as an operator decision.
   Surfaced-but-out-of-scope subtraction candidates, filed where they belong: the dead `--review` path
   ([[R-RWNF]]) and the orphaned `pickle-portal.md` ([[R-FOMH]] leg a).

## Pre-launch stale-premise check (per prds/CLAUDE.md)

Run before launch, against HEAD **and** the deployed tree `~/.claude/pickle-rick/extension/`:

- `grep -c 'FOM_EVIDENCE_RULES' extension/src/bin/spawn-refinement-team.ts` — a nonzero hit means WS-2 (or part
  of it) already shipped; re-scope before launching.
- `ls extension/tests/skill-prompt-shape/fom-infusion-prompts.test.js` — existence means WS-1 shipped.
- The AC-FOMC-3 grep — **already green at HEAD (2026-07-14)**; it is a regression pin, not a fix, and finding it
  green is expected, not evidence the bundle shipped.
- Recoverability line: N/A — no state field is healed by this bundle.

## Risks

- **Prompt bloat degrades the worker.** Adding prose to every judging prompt costs context. Mitigate: two blocks,
  not a taxonomy; keep each ≤ 5 lines; persona.md rides in every worker prompt, so weight there is paid on
  every spawn — keep all blocks thin.
- **R-BCFR is NOT a prompt defect.** citadel's fabricated `"is banned by CLAUDE.md"` is a **hardcoded string
  literal in code** (`banned-constructs-audit.ts:129`), not an LLM hallucination. It has the same *shape* but a
  different cause, and infusion cannot fix it — it stays in [[B-RLH]] WS-1. **And per "Why this is P1", R-JPCM
  and R-GRLS are at least partly code/caller defects too — their behavioral fixes also stay in B-RLH.** Do not
  let the thesis's elegance swallow defects it cannot actually fix.
- **The correlation may be spurious.** See the ⚠ above. WS-5 exists to find out, and a null result must ship as
  a null result.
- **A shape test that cannot fail.** The single funniest way to get this wrong. AC-FOMC-1 requires proving the
  test RED through the same helper the live assertions use.
- **The probe lies.** The grep that produced the original coverage map counts code comments as infusion
  (`spawn-morty.ts` = 3 comment hits, 0 prompt hits). After WS-1, coverage questions are answered by the
  ledger + shape test, never by that grep.
- **Source-green, deploy-stale.** Workers run `~/.claude/pickle-rick/extension/**/*.js`. AC-FOMC-11 pins the
  compiled mirror; the infusion is live only after `bash install.sh`.

## Rollback

No runtime behaviour changes — this bundle edits prompts, adds one test + one constants module. Rollback is
`git revert` per workstream. **No kill-switch is warranted**: an infused prompt cannot wedge a run, and a shape
test failing is a build-time signal, not a runtime halt. (If WS-4's widened checker ever false-positives, it is
**advisory** — it cannot block anything by construction. If WS-3 takes option (a) — install.sh maintaining the
persona block — that IS an installer behaviour change; keep it a marker-delimited replace so rollback is
deleting the block.)

## Routing

**Pipeline-safe (NOT [[R-PSRB]]).** Nothing here touches the salvage / completion-evidence / Done-flip path. The
build worker executes the **deployed** runtime, not this source diff.

⚠ **One self-reference to hold in mind:** this bundle is refined by the very analysts it is fixing. Their
un-infused prompts govern the refinement that decomposes it. That is not a blocker (the deployed runtime is not
the source diff), but the decomposition **must be citation-checked by hand** before launch — treat every
`file:line` in the resulting tickets as unverified until greped. **That is the discipline this bundle exists to
make automatic.** (This PRD practiced it on itself: a 3-agent verification pass on 2026-07-14 caught the first
draft's own false mechanism claim (`install.sh:516`), an unbuildable AC (cross-language byte-identity), a
probe that counted comments as infusion, and the missing `refine-analyze.js` twin.)

## Implementation Task Breakdown

| Order | ID | Title | Priority | Tier | Entry | Exit | Files |
|---|---|---|---|---|---|---|---|
| 10 | `33681a13` | Build the FOM enforcement mechanism (constants + ledger + discovery sweep) | High | medium | HEAD clean | Registration sites exist; FAMILY empty; red-proof green | `fom-blocks.ts`, `fom-infusion-prompts.test.js`, `install.sh`, `install-ui-principles.test.js` |
| 20 | `c4ee67ff` | Infuse every judging surface + enroll in the ledger (ONE parametrized ticket, 10 surfaces) | High | medium | `33681a13` done | All 10 surfaces carry blocks; zero `pending` in EXCLUDED | the 3 `.ts` builders, 2 `.js` workflows, `pickle-refine-prd.md`, `morty-gate-remediator.md`, 3 rubrics |
| 30 | `a460cad3` | Infuse `persona.md` (option **b**) + subtract the install.sh marker lie | Medium | small | `33681a13` done | persona.md in FAMILY; no "100% reach" claim survives | `persona.md`, `install.sh` |
| 40 | `16e6923f` | Repair the analyst-citation checker (suffix resolution, split `defect_class`, memoize+timeout) | Medium | medium | `c4ee67ff` done | 44 warnings collapse to ~0; still ADVISORY | `spawn-refinement-team.ts`, checker test |
| 50 | `aa67d49a` | **Wire + deploy + prove live** `[manager]` | High | medium | All impl done | Infusion live in `~/.claude/pickle-rick/` | `install.sh` (deploy) |
| 60 | `634ee56f` | **The soak — the falsifier** `[manager]` | High | medium | `aa67d49a` done | `soak_result.md` against a PRE-REGISTERED rule | `soak_result.md` |
| 70 | `1e780803` | Harden: code quality of the infusion diff | High | large | All prior | Zero P0-P1 | MODIFIED_FILES |
| 80 | `a4038d7c` | Audit: data flow (constant → mirror → deploy → prompt → LLM) | High | large | All prior | Zero CRITICAL/HIGH | MODIFIED_FILES |
| 90 | `a83d7ead` | Harden: test quality — **prove the shape test can FAIL** | High | large | All prior | Suite proven RED by hand ×2 | TEST_FILES |
| 100 | `f27e591f` | Audit: cross-reference consistency (docs ↔ prompts ↔ code) | High | medium | All prior | Zero unresolvable citations survive | DOC_FILES |

**Rollback order is the REVERSE of build order: WS-4 → WS-3 → WS-2 → WS-1.**
