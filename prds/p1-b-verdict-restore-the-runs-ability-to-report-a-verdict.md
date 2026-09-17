# B-VERDICT — restore the run's ability to report a verdict

**Fixes and enhancements together, as the operator asked.** Three fixes that stop completed runs from
reporting success, and two enhancements that were waiting on them.

**The measured problem this bundle exists for:** the last three runs each completed **4/4 phases with
every ticket Done**, and **two of the three lost their success verdict** to a judge that answered in
prose. A phase that cannot report its metric cannot converge, so the loss is the whole phase's
contribution, not just a verdict line.

| root | kind | source |
|---|---|---|
| **V1** the output contract is not the last thing the judge reads | fix | #39 |
| **V2** the evidence field is untyped and embedded in a string | fix | PR #38 (external) + our shipped form |
| **V3** citadel and the shell audit disagree on an absent anchor | fix | #37 — **gates V5** |
| **V4** why is acceptance-criteria the largest external finding category | enhancement | B-LENS L4 |
| **V5** route citadel findings into the fixing loop | enhancement | B-LENS L7 — **gated on V3** |

---

## 🚧 ROOT V1 — the judge answers the last thing it reads (#39)

`buildJudgePrompt` assembles, in order: scoring reference and scope → `Previous iterations:` → **the
output contract** (*"Output a SINGLE JSON object and NOTHING else — no prose, no markdown fences, no
trailing commentary"* + `JUDGE_OUTPUT_JSON_SCHEMA`) → `## Prior violations (DO NOT re-report unless still
present)` → `FOM_HONEST_REPORTING_RULES`, a **prose** block → return.

**The JSON-only instruction is followed by two further sections, the last of which models prose.** The
observed failure:

```
The prior violation [b3968b47] is **resolved**: `walkComposeChain` now takes 3 parameters…
```

It uses the `[id]` notation from the prior-violations section, discusses *resolution* — which that
section's "DO NOT re-report unless still present" invites — and is markdown prose. **Four attempts in a
row.**

The ordering is deliberate: the contract says *"relative to the prior-violations list **below**."* The
defect is that **nothing re-asserts the contract after it.**

### AC-V1
- **AC-V1-1 (executable, FALSE at HEAD):** the assembled prompt ENDS with the output contract —
  `buildJudgePrompt({...}).trimEnd().endsWith(<contract marker>)` returns **true**. It returns **false**
  today.
- **AC-V1-2:** the ledger's `[id]` references still resolve — if the contract moves below the ledger, its
  wording *"the prior-violations list below"* must stop saying "below". **A reorder that leaves a stale
  directional word is half a fix.**
- **AC-V1-3 (do NOT loosen the parser):** `extractScore` is unchanged. Scraping a number out of narrative
  would re-create the collapse #35 just removed — a judge that did not answer would start producing a
  score anyway. `git diff` shows no edit to `extractScore`.
- **AC-V1-4 (replay):** rebuild the prompt with the exact ledger from session `2026-09-17-5f3aa6b4` and
  assert the contract is last. That session is the one that failed.
- **AC-V1-5 (mutation):** restore the original order ⇒ AC-V1-1 reds.

---

## 🚧 ROOT V2 — the evidence field is untyped and lives inside a message string (PR #38)

**An external contributor (PR #38, `sabahmax-dev`) identified a real weakness in our own fix and it is
worth taking, with corrections.**

Our shipped form embeds the evidence in prose:
```ts
message: `judge output did not contain a numeric score (raw_output_truncated_512=${JSON.stringify(...)})`
```
A consumer must parse it back out of a sentence. **Their form is the better shape** — a structured field.

**But their version as submitted does not work**, and the reasons are the interesting part:
- `JudgeMeasurementAttempt` is `{ metric, failureKind?, message?, typedFailure? }`. **The field is not in
  the type.**
- Their `const failure = {...}; return failure;` defeats TypeScript's excess-property check, which only
  applies to object literals returned directly. **It compiles silently and the type system cannot see the
  field.**
- **Nothing reads it.** As submitted it is a write-only channel — the same shape as a metric nobody
  consumes.

### AC-V2
- **AC-V2-1:** the truncated output is a **typed field** on `JudgeMeasurementAttempt`, not an
  excess property smuggled past the compiler.
- **AC-V2-2 (it must have a reader):** a consumer reads the field and surfaces it. **A field with no
  reader is not an improvement over the string — it is a regression with better manners.**
- **AC-V2-3:** the evidence still reaches a human. Whatever the message does or does not carry, the
  truncated output must remain visible in the run artifacts, as it is today.
- **AC-V2-4 (executable):** `grep -c 'raw_output_truncated_512' extension/src/bin/microverse-runner.ts`
  returns **≥ 2** — the write and at least one read.
- **AC-V2-5:** reuse the existing 512-char convention; do not introduce a second truncation length.
- **AC-V2-6 (attribution):** credit PR #38 in the commit message. The contributor found a real defect in
  our fix.

---

## 🚧 ROOT V3 — citadel and the shell audit disagree on an absent anchor (#37). **Gates V5.**

`6cf7c9da` unified `hasTestCase` with `audit-trap-door-enforcement.sh`'s `anchorMatchCount`, stating *"one
definition of the contract, not two."* Measured after that:

- Inject `- ENFORCE: tests/stop-hook.test.js#zzz-nonexistent-anchor-probe` into a live `CLAUDE.md`
- `bash scripts/audit-trap-door-enforcement.sh` → **exit 1**, names `zzz`
- `runT6TrapDoorCoverage({projectRoot})` → **0 anchor findings**, total unchanged at 566

**They cannot both be right.** My own isolation attempt was inadmissible — a synthetic tree returned
*"Test file has no inbound ENFORCE ref"*, implying the `ENFORCE:` lines were not read at all, so it did
not reproduce the live scanning path. **Do not reuse that probe.**

### AC-V3
- **AC-V3-1:** determine which side is wrong, by reading the scan path — not by adjusting either until
  they agree. **Tuning to agreement is the failure mode this repo files against itself.**
- **AC-V3-2 (executable):** with one absent anchor injected into a live `extension/src/**/CLAUDE.md`,
  BOTH report it: the shell audit exits non-zero AND `runT6TrapDoorCoverage` returns ≥ 1 anchor finding.
- **AC-V3-3 (negative control):** on the clean tree both report zero. A fix that makes citadel report
  absences must not make it report phantoms.
- **AC-V3-4:** if the two are found to be measuring genuinely different populations by design, say so and
  **remove the "SAME rule" comment**, which would then be false. Either the claim or the code is wrong.

---

## 🔬 ROOT V4 — why is acceptance-criteria the largest external finding category? (B-LENS L4)

The review inventory measured *acceptance criteria unmet* at **45 of 342 (13%)**, the largest identifiable
category by 3x. **We already audit this surface** — citadel runs a conformance audit and
`audit-acceptance-assertion-coverage.sh` is a gate leg that is currently green at 22/63.

**So this root is a DIAGNOSIS, not a prompt edit**, and it may cut itself.

### AC-V4
- **AC-V4-1:** sample the 45 and classify each as (a) never checked, (b) checked and passed wrongly, or
  (c) the criterion itself was absent or unfalsifiable. **Only (a) is a coverage gap.**
- **AC-V4-2:** if (c) dominates, the defect is in PRD authoring, not review — **say so and re-scope
  there** rather than widening a review prompt.
- **AC-V4-3 (honesty control):** if the 45 turn out to be domain criteria of another codebase with no
  analogue here, **cut this root and record why.** Transferability is a claim, not a given.
- **AC-V4-4:** no prompt change lands from this root without AC-V4-1's classification first.

---

## 🎯 ROOT V5 — route citadel findings into the fixing loop (B-LENS L7). **BLOCKED on V3.**

*"The loops should fix all issues they find."* Citadel's channel is the largest and is now the most
repaired: **147 anchor findings → 29 → 0**, with `ENFORCE:` clause count held at 444.

### AC-V5
- **AC-V5-1 (the gate):** **do not wire anything until V3 passes.** A channel whose detection floor is
  unknown cannot be routed — that is what AC-L7-1 was written to prevent, and V3 is exactly that
  question reopened.
- **AC-V5-2:** the wire is a ROUTE, not a rewrite. Citadel keeps surfacing as it does; its output becomes
  an input to the existing fix loop. **No new criterion, no per-pass cost** — the review phases stay
  simple because they work by iterating.
- **AC-V5-3 (budget honesty):** report the projected iteration cost before enabling. The loop fixes one
  violation per iteration.
- **AC-V5-4 (negative control):** a run with zero advisory findings behaves exactly as today.
- **AC-V5-5:** **a zero-diff outcome is a SUCCESS here.** If V3 shows the channel is not ready, record
  `zero_diff_intent: blocked-on-V3` and close. Do not wire to hit a ticket count.

---

## 🛡 PRIME DIRECTIVE compliance

- **No halt, no abort, no phase-loop break.** V5 parks if blocked.
- **No new gate leg.** V1 reorders, V2 types an existing field, V3 repairs a detector, V4 is a
  diagnosis, V5 routes.
- **`EXIT_REASONS` gains nothing.**
- **The review phases stay simple** — AC-V5-2 forbids per-pass cost, per the operator constraint.

## Non-goals

- Do NOT loosen `extractScore` (AC-V1-3).
- Do NOT tune citadel or the shell audit until they agree (AC-V3-1).
- Do NOT land a V4 prompt change before its classification (AC-V4-4).
- Do NOT wire V5 before V3 passes (AC-V5-1).
- Do NOT merge PR #38 as-is; adopt its idea correctly (V2).

## Simplification Review

**V1 is a reorder. V2 types a field that already exists as a string. V3 is a divergence to remove.** V4
and V5 may both end zero-diff, and that is a success, not a gap.

**The bundle's risk is V5** — it is the only root that could add cost to a loop whose value comes from
iterating cheaply. AC-V5-1 through AC-V5-5 exist to make stopping the easy outcome.
