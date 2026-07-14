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

| WS | What | Shape |
|---|---|---|
| **WS-1** | The **shape test + single-source constants + delimited blocks** — the enforcement mechanism | reuse (GIT_BOUNDARY ledger + colocation-constant identity) |
| **WS-2** | Infuse the **judging surfaces** — both refinement twins, both judge prompts, the rubric files, the remediator brief + agent mirror, the council prompts (folds in [[R-RAFC]]) | reuse (prose from the shipped `send-to-morty.md` blocks) |
| **WS-3** | Infuse **`persona.md`** — worker-prompt reach (mechanism corrected below) | reuse |
| **WS-4** | Widen the **existing** analyst-output checker to parse `file:line` and check line existence; attribute warnings | small addition (a parsing branch) — honestly declared |
| **WS-5** | **Soak**: does an infused judging surface actually stop lying? (the falsifier) | measurement |

### WS-1 — the enforcement mechanism (build this FIRST; everything else is inert without it)

Define the blocks **by concern**, not by file. Start with the ones the open defects demand — resist inventing a
taxonomy:

- `FOM_EVIDENCE_RULES` — *verify a citation before you assert it; a claimed grep result must be a grep you
  actually ran; an unverified mechanism is a hypothesis — label it as one.*
- `FOM_HONEST_REPORTING_RULES` — *silence is not success; a fast clean pass is a gate that did not fire; never
  report an outcome you did not observe.*

Each block: one exported constant (no backticks, no `${`) in a shared module; `.ts` builders import it; `.md`
surfaces carry it between `<!-- BEGIN FOM_EVIDENCE_RULES -->` / `<!-- END FOM_EVIDENCE_RULES -->` sentinels.

- `AC-FOMC-1`: `extension/tests/skill-prompt-shape/fom-infusion-prompts.test.js` exists, enumerates every surface
  in the infusion family, and **FAILS when an enumerated surface lacks its block**. The red-proof must be real:
  factor the per-surface assertion into one shared helper and add a case that feeds the helper a real surface's
  content with the block stripped, asserting it **throws via the SAME helper the live assertions use** (a
  test-local re-derivation would be the AC-DR-05 unfalsifiable-green trap door all over again).
- `AC-FOMC-2` (re-specified — whole-block cross-language byte-identity is not achievable and GIT_BOUNDARY never
  claimed it): (a) each block is a single exported constant containing no `` ` `` and no `${`; (b) every
  enumerated `.ts` builder **imports** the constant — the test greps the import, so a re-typed inline copy
  fails; (c) every enumerated `.md`/persona surface contains the constant's exact string between its sentinels.
- `AC-FOMC-3` (**regression guard — already green at HEAD**, verified 2026-07-14; it pins the door shut, it does
  not fix anything): zero `(FOM §N)`-style unresolvable citations in any deployed prompt:
  `! grep -rE 'FOM §|see the operating manual|FABLE_OPERATING_MANUAL' .claude/ extension/src/bin/ extension/bin/ extension/templates/ persona.md`
  (widened over the first draft to include the compiled mirror and templates).
- `AC-FOMC-11` (**the deployed tree is what workers actually run**): the shape test also asserts each enumerated
  `.ts` surface's **compiled mirror** (`extension/bin/*.js`) carries the block string — `install.sh`'s MD5
  parity checks cover 5 hot files and **none of the judging builders**, so source-green/deploy-stale is a live
  failure mode. Routing note: the infusion reaches real workers only after `bash install.sh`.
- Keep the test `@tier: fast` (like git-boundary). Do **NOT** add it to `RELEASE_GATE_COMMAND` —
  `release-gate-parity.test.js` pins that string byte-for-byte against `ci.yml`+`release.yml`; a 3-file coupled
  edit for zero gain.

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
- `AC-FOMC-7b` (**research-phase decision gate, MANDATORY — do not let this AC pass by omission**): the research
  artifact states, with the exact `install.sh` line, how `~/.claude/CLAUDE.md`'s persona block gets updated,
  then the ticket does ONE of: (a) make `install.sh` actually maintain the marker-delimited block it already
  claims to manage (declared new machinery, small, makes an existing lie true), or (b) downscope to
  worker-prompt reach + documented manual propagation, striking every "100% reach" claim. Either is
  acceptable; silence is not.
- **Do NOT hand-edit `~/.claude/CLAUDE.md`** — edit `persona.md`, run `bash install.sh`
  ([[feedback_persona_source_of_truth]]) — noting per above that today this updates worker-prompt reach only.
- Pin-test note (corrected): the only test that reads the real `persona.md` is
  `persona-step0-creation-heavy-skip.test.js` (four additive contains-checks — appended blocks are safe).
  `release-gate-parity` / `codegraph-docs-optin-parity` pin the repo-root `CLAUDE.md`/`README.md`, **not**
  persona.md; they are unaffected. ⚠ Watch the token budget regardless: persona.md rides in every worker prompt.

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

- `AC-FOMC-8`: a new `file:line` parsing branch: cited file exists AND contains ≥ N lines. **Explicitly out of
  scope: verifying the line SAYS what is claimed** — not machine-checkable; that verification burden moves into
  the analyst prompt itself (WS-2), where it belongs.
- `AC-FOMC-9` (re-specified): attribution surfaced via dedicated fields (`analyst`, and `cycle` **only if** the
  builder scans the per-cycle `worker_<role>_c<N>` artifacts — otherwise drop the word "cycle" and record why).
  Do **not** overload `ticket_id`; it is correctly empty here.
- **Stays ADVISORY.** Per W5b, do **not** build a fabrication gate. The cross-cycle catch already works — both
  R-RAFC fabrications were caught by a later cycle. Make the signal legible and let the next cycle use it.
- Scope note: the workflow twin (`refine-analyze.js`) has no equivalent checker; building one there is NOT in
  scope (it would be new machinery) — the twin gets the prompt-side fix (WS-2) only. Recorded so the asymmetry
  is a decision, not a drift.

### WS-5 — the soak (the falsifier; this is what makes the thesis honest)

The correlation above is a hypothesis. Test it.

- `AC-FOMC-10`: re-run the B-RLH refinement on the **infused** analyst team and record, against the preserved
  2026-07-14 baseline (`~/.local/share/pickle-rick/sessions/2026-07-14-ef12a95a/refinement_round1/`; round-1
  manifest: **44** `analyst_path_not_verified` warnings, **2** fabricated mechanisms): (a) the widened checker's
  warning count + attributions, and (b) a hand-audited fabrication count over the resulting tickets. **A null
  result is a real result and must be recorded** — if infusion changes nothing, the disease is elsewhere and
  B-RLH's three symptom-fixes are the right level after all.

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

1. **Is the addition necessary at all?** WS-1 adds one shape test (~30 lines) plus one shared constants module —
   the enforcement mechanism and single source; both declared. WS-2/WS-3 add **prose to existing prompts**,
   copied from the shipped `send-to-morty.md` blocks. WS-4 adds **one parsing branch** to an existing checker
   (the first draft's "adds nothing" was false — the current regex cannot even see `file:line`). WS-5 is
   measurement.
2. **Can it REUSE instead of ADD?** That is the entire bundle. Enforcement = GIT_BOUNDARY's enumeration ledger.
   Identity = the `DECOMPOSITION_COLOCATION_PROMPT_SECTION` single-constant pattern
   (`spawn-refinement-team.ts:507`) — both already shipped in this repo. The prose comes from the infused
   BUILDS surfaces. The checker is the one already wired.
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
