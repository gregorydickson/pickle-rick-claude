# B-MEASURED — four places the instrument knew more than its output could say

**Every root below was re-grepped at HEAD `cbce36cd` immediately before this PRD was written.** Line
numbers and counts are from that measurement, not from the issues that reported them — two of the
issues were partly wrong, and both corrections are recorded here rather than discovered mid-build.

| root | issue | mechanism at HEAD | surface |
|---|---|---|---|
| **R1** a measured baseline of `0` is indistinguishable from "never measured" | #45 | `baseline_score !== 0` (`microverse-runner.ts:4463`) | `bin/microverse-runner.ts`, `types/index.ts` |
| **R2** a correct judge measurement is destroyed at the parse boundary | #45 | `judgeAttemptFromOutput` (`microverse-runner.ts:2999`), 4 identical retries | `bin/microverse-runner.ts` |
| **R3** the remediation threshold excludes the class that dominates citadel's output | #42 | `strict ? 'High' : 'Critical'` (`pipeline-runner.ts:3060`) vs `severity: 'High'` (`ac-coverage-scorecard.ts:303`) | `bin/pipeline-runner.ts`, `services/citadel/` |
| **R4** nothing Pickle Rick authors says which build authored it | #44 | no version accessor exists in `src/`; 0 of the last 200 commits carry one | `bin/mux-runner.ts`, `bin/microverse-runner.ts`, `services/git-trailer-hooks.ts` |

**The thesis is one sentence:** at four separate decision points this codebase's own instruments
discard information they demonstrably hold. That is clause 6 of the complexity rule — *what did this
code know that its output cannot express?* — and it is why these four ride one bundle rather than four.

**Composition rationale:** R1, R2 and R4 all edit `bin/microverse-runner.ts`; R4 and R3 add
`bin/mux-runner.ts` and `bin/pipeline-runner.ts`. The `bin/` subsystem dominates all four, so the
ANATOMY-PARK + SZECHUAN toll is paid **once**. Per the sizing clause there is no ticket-count ceiling;
refinement should decompose these four roots into as many atomic tickets as the surfaces warrant.

**All commands run from `extension/` unless stated.**

---

## 🚧 ROOT R1 — an in-band sentinel collapses "unmeasured" into "measured zero"

The score parser is careful. `extractScore` returns `number | null` and `judgeAttemptFromOutput`
treats `null` as absent, so *no score* and *a score of zero* are correctly distinguished **at the
producer**. One layer down the distinction is thrown away:

```
types/index.ts:1877        baseline_score: number;          // non-optional, initialised 0
microverse-runner.ts:4463  const hasBaseline = state.baseline_score !== 0;
microverse-runner.ts:4464  const newStatus = (hasHistory || hasBaseline) ? 'iterating' : 'gap_analysis';
```

`resetStoppedMicroverseState` is live at `microverse-runner.ts:6574`, on the resume path.

**Why it bites hardest when the tool is working.** The live `key_metric` is *"Number of coding
principle violations (lower is better)"*. `0` is not an edge case for that metric — **it is the
converged state szechuan exists to reach.** A subsystem driven genuinely clean and then resumed has
its real baseline read as absent and restarts at `gap_analysis` from scratch.

**Fix by SUBTRACTION, not by a companion flag.** Do **not** add `baseline_measured: boolean` beside
the number — that adds a state and a second thing to keep in sync, the exact enumerated-set shape that
schedules the next bypass. Make the type carry what the producer already knows (`number | null`, or
absent) so `hasBaseline` becomes a null check and **tsc kills the class at every read site**.

**Honest scope:** R1 did NOT cause the 2026-09-20 phase-4 degradation. There `baseline_score` was
genuinely unmeasured and `0` was the truthful reading. It is in scope because it rots silently and
indefinitely and no iteration surfaces it.

### Interface Contracts — R1

**Inputs**: `MicroverseState` as persisted in `<session>/microverse.json`.
**Outputs**: `resetStoppedMicroverseState` mutates `state.status` to `'iterating' | 'gap_analysis'`.
**Type change (the fix)**: `MicroverseState.baseline_score` becomes `number | null` (or optional), so
`null`/absent is the ONLY encoding of "never measured" and `0` is an ordinary measured value.
**Invariant**: for all `s`, `hasBaseline(s) === (s.baseline_score !== null && s.baseline_score !== undefined)`
— never a comparison against a member of the value domain.
**Errors**: none added; an unreadable `microverse.json` keeps its existing recovery path.

### Test Expectations — R1

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| measured `0` resumes as measured | `tests/microverse.test.js` | stopped state, `baseline_score: 0`, empty history | `status === 'iterating'` after reset |
| never-measured still restarts (control) | `tests/microverse.test.js` | stopped state, baseline absent/null, empty history | `status === 'gap_analysis'` after reset |
| a real zero parses as a measurement | `tests/microverse-helpers.test.js` | `judgeAttemptFromOutput('score: 0')` | `metric.score === 0`, not a `failed` attempt |
| absent stays absent | `tests/microverse-helpers.test.js` | `judgeAttemptFromOutput('no numerals here')` | `metric === null` |

### Acceptance criteria — R1

- `grep -c 'baseline_score !== 0' src/bin/microverse-runner.ts` returns `0`
- `grep -cE 'baseline_score(\?)?: number \| null|baseline_score\?: number' src/types/index.ts` returns a value `>= 1`
- `./node_modules/.bin/tsc --noEmit` exits `0`
- `node -e "const m=require('./bin/microverse-runner.js'); const a=m.judgeAttemptFromOutput('score: 0'); process.exit(a.metric && a.metric.score===0 ? 0:1)"` exits `0`
- `node -e "const m=require('./bin/microverse-runner.js'); const a=m.judgeAttemptFromOutput('no numerals here'); process.exit(a.metric===null?0:1)"` exits `0`
- a resume test asserts a genuinely-measured `0` baseline resumes at `iterating`, and its negative control — never measured — still resumes at `gap_analysis`

**Mutation verification (binding):** restore `!== 0` and observe the measured-zero test RED with the
never-measured control GREEN; then force `hasBaseline` true unconditionally and observe the
never-measured control RED. An under-trigger control alone passes a treat-everything-as-measured bug.

---

## 🚧 ROOT R2 — the judge did the work and the parser threw it away

Phase 4/4 of session `2026-09-19-4dbaed57` ran 37m 56s, produced **1 iteration**, and exited
`metric_unmeasurable_unrecoverable` after **4 attempts**. The judge neither crashed nor timed out — it
answered correctly, in prose:

```
raw_output_truncated_512="Based on my review of the codebase, I have examined the key source files
under .../extension/src/. I found one confirmed DRY violation with confidence >= 80: argv
flag-parsing logic duplicated across 8 bi..."
```

`extractScore` found no numeral, `judgeAttemptFromOutput` (`:2999`) classified the attempt `failed`,
and **four identical retries re-asked the same unconstrained question and got four prose answers.**
A whole phase of a 2165-minute run was lost to an output-shape mismatch.

**The loop behaved correctly and this is NOT a halt bug** — `finalize-gate` ran, the phase was marked
degraded, `Pipeline finished: 3/4 phases`. Output-with-flags, exactly as B-NOSTOP-GATES requires. The
defect is that nothing constrains the judge's output shape, and that a retry which re-asks an
unconstrained question is a green light wired to nothing.

**Direction:** constrain the contract at the ask (a required output form the parser can read), rather
than adding a fifth retry or a prose-scraping fallback. A fallback that mines a number out of prose
re-introduces the ambiguity this bundle is removing.

### Interface Contracts — R2

**Inputs**: judge stdout, arbitrary text.
**Outputs**: `JudgeMeasurementAttempt` — either `{ metric: { raw, score } }` or
`{ metric: null, failureKind: 'failed', message, raw_output_truncated_512 }`.
**Contract added (the fix)**: the judge INVOCATION declares a required output shape the parser reads;
refinement names the anchor it adds. `extractScore` keeps returning `number | null` — the parser must
NOT gain a prose-mining fallback, which would re-introduce the ambiguity this bundle removes.
**Invariant**: a retry changes the ASK, never merely repeats it.
**Errors**: exhausted attempts still yield `metric_unmeasurable_unrecoverable`; the phase still degrades
rather than halting (B-NOSTOP-GATES).

### Test Expectations — R2

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| prose alone yields no metric | `tests/microverse-helpers.test.js` | the real 2026-09-20 prose answer as input | `metric === null`; parser does not guess |
| well-formed numeric answer parses | `tests/microverse-helpers.test.js` | a conforming judge answer | `metric.score` is the expected number |
| the ask carries a shape constraint | `tests/microverse-helpers.test.js` | build the judge invocation | the output-shape anchor is present in the prompt |

### Acceptance criteria — R2

- `node -e "const m=require('./bin/microverse-runner.js'); const a=m.judgeAttemptFromOutput('I found one confirmed DRY violation with confidence >= 80'); process.exit(a.metric===null?0:1)"` exits `0` (prose alone still yields no metric — the parser must not start guessing)
- the judge invocation carries an explicit output-shape instruction: `grep -c . <the new contract anchor>` returns a value `>= 1` (refinement must name the anchor it adds)
- a retry test asserts that retries are not four identical unconstrained asks
- `./node_modules/.bin/tsc --noEmit` exits `0`

**Mutation verification (binding):** remove the output-shape constraint and observe the contract test
RED; then feed a well-formed numeric answer and observe it GREEN, so the test cannot pass by rejecting
everything.

---

## 🚧 ROOT R3 — the dominant finding class sits one notch above the default threshold

**#42's premise was corrected before this PRD; both corrections are recorded on the issue.**

**What #42 got wrong:** it proposes building an iterate-until-resolved loop. **That loop exists** —
`citadel_max_remediation_cycles` defaults to **3** (`finalize-gate.ts:34`), `pipeline-runner.ts:3045`
reads it, and `logCitadelFindingsUnremediated` emits `citadel_findings_unremediated` with `cycles` and
`findings_remaining` on exhaustion. That is #42's own `cycles: 3` table row.

**The measured cause:**

```
pipeline-runner.ts:3060   return strict ? 'High' : 'Critical';
pipeline-runner.ts:269    citadel_strict = raw.citadel_strict === true || raw.strict === true
ac-coverage-scorecard.ts:291   '...-implementation'   severity: 'Critical'
ac-coverage-scorecard.ts:303   '...-test'             severity: 'High'
```

Absent config ⇒ `citadel_strict` is **false** ⇒ threshold is **`Critical`**, and `pickle_settings.json`
carries no `citadel` key at all. The class #42 correctly identifies as worth acting on —
`citadel-ac-coverage-<AC>-test`, *"production evidence but no changed test evidence"* — is emitted at
**`High`**. It is excluded by exactly one severity notch, on every run.

That explains #42's table precisely: `cycles: 3` is the Criticals hitting the cap; every `cycles: 0`
row is High-or-below never reaching the loop at all.

**Direction — subtraction.** Collapse or flip the strict/non-strict severity distinction rather than
adding a mechanism beside a cap that already exists. Whether the cap of `3` is also too low is a
**separate, separately-measurable** question: do not bundle a cap change in without its own evidence.

**This root adds NO new gate leg,** so the four gate-leg questions are not triggered. If refinement
finds itself proposing one, it must answer all four in the ticket first.

### Interface Contracts — R3

**Inputs**: `CitadelFinding[]` with `severity: CitadelSeverity`, plus resolved config.
**Outputs**: the subset admitted to the remediation loop.
**Invariant (the fix)**: a finding of severity `High` is admitted under DEFAULT config. The
strict/non-strict severity distinction is collapsed or its default flipped — not guarded by a new case.
**Explicitly OUT of contract**: `citadel_max_remediation_cycles` keeps its current default of `3`.
Changing the cap is a separate, separately-evidenced question and must not ride this root.
**Errors**: none added; cap exhaustion keeps emitting `citadel_findings_unremediated` and the pipeline
continues.

### Test Expectations — R3

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| `High` admitted under default config | `tests/pipeline-runner.test.js` | a `citadel-ac-coverage-<AC>-test` finding, non-strict | the finding reaches the remediator |
| below-threshold still excluded (control) | `tests/pipeline-runner.test.js` | a finding below the new threshold | not admitted — the change is not a blanket admit |
| cap unchanged | `tests/pipeline-runner.test.js` | resolved settings | `citadel_max_remediation_cycles === 3` |

### Acceptance criteria — R3

- `grep -c "strict ? 'High' : 'Critical'" src/bin/pipeline-runner.ts` returns `0`
- a test asserts a `High` ac-coverage finding is admitted to remediation under default (non-strict) config
- a negative control asserts a below-threshold severity is still excluded, so the change is not a blanket admit
- `./node_modules/.bin/tsc --noEmit` exits `0`
- `npx eslint src/ --max-warnings=0` exits `0`

**Mutation verification (binding), and #42's own recorded constraint applies in full:** any test
written to close an AC-coverage finding must be mutation-verified — break the subject, observe red,
restore, observe green — or this enhancement manufactures fake-green at loop speed.

---

## 🚧 ROOT R4 — nothing Pickle Rick authors says which build authored it

Over the last 200 commits: `Pickle-Ticket:` **73**, `Claude-Session:` **30**, any Pickle Rick version
**0**. There is no runtime version accessor anywhere in `src/`
(`grep -rn 'readPackageVersion\|getPickleVersion\|PICKLE_VERSION\|extensionVersion' src` → 0 matches).

Source and the deployed runtime are ISOLATED by design, and that isolation is load-bearing for
reliability. Its cost is that a commit's content cannot say which build produced it — measured on
2026-09-20, the deployed tree was two days and 58 source commits behind while authoring commits. When
a defect escapes, that question currently has no answer in the history.

Three producers write commits; only two stamp anything:

1. `stampPickleTicketTrailer` — `mux-runner.ts:6785`, the runner's in-process stamp, call sites `:6887`, `:8093`
2. `materializeTrailerHooks` — `services/git-trailer-hooks.ts:210`, writes the `prepare-commit-msg` hook
3. `microverse-runner.ts:4491` and `:5584` — raw `execFileSync('git', ['commit', '-m', …])`, **no trailer at all**

### ⛔ Binding design constraint — do NOT add call sites to `mux-runner.ts`

`src/bin/CLAUDE.md` carries the **B-RATRAIL** invariant whose PATTERN_SHAPE is a count:
`grep -c "stampPickleTicketTrailer(" src/bin/mux-runner.ts` == **3** — the definition plus exactly two
call sites. **Verified `3` at HEAD `cbce36cd`.** A third call site reds that anchor, so the version
stamp belongs **inside** the existing body.

The same entry requires the write go through the PARSED trailer view (`git interpret-trailers`,
`--if-exists addIfDifferentNeighbor`) — never a raw `%B` grep or a bare `\n`-append, because a doubled
or valueless trailer makes `scanGitLogByTrailer` read the commit as **unattributed**, which is worse
than no stamp. It also records an OPEN RESIDUAL at `spawn-morty.ts` (`buildTrailerAmendedMessage` has
no blank-id guard, held unreachable because the CLI rejects a blank `--ticket-id` at
`spawn-morty.ts:411`): **do not "fix" it here** — it would be dead code guarding an unreachable input.

**Resolve the version from the DEPLOYED runtime** — the build actually executing — not from the source
tree under edit, and degrade to a typed unknown rather than throwing or guessing.

### Interface Contracts — R4

**Inputs**: `stampPickleTicketTrailer(workingDir: string, message: string, ticketId: string)`, unchanged
signature — the B-RATRAIL anchor pins its call-site count at exactly two.
**Outputs**: the same message, now carrying BOTH `Pickle-Ticket: <id>` and `Pickle-Rick: <version>` as
PARSED trailers (`git interpret-trailers`, `--if-exists addIfDifferentNeighbor`).
**New accessor**: resolves the DEPLOYED runtime's version, returning a typed unknown on failure — never
throwing, never guessing, never silently substituting the source tree's version.
**Invariants**: idempotent (re-stamping yields exactly one `Pickle-Rick:` line); a blank/whitespace
`ticketId` returns the message UNCHANGED; a trailer is never emitted valueless or doubled, because
`scanGitLogByTrailer` reads a doubled value as unattributed.
**Errors**: an unresolvable version degrades to the typed unknown; it must not abort the commit.

### Test Expectations — R4

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| version trailer present | `tests/runner-authored-trailer.test.js` | stamp a message | `/^Pickle-Rick: \d+\.\d+\.\d+$/m` matches |
| ticket trailer survives | `tests/runner-authored-trailer.test.js` | stamp a message | `/^Pickle-Ticket: t1$/m` matches |
| idempotent | `tests/runner-authored-trailer.test.js` | stamp an already-stamped message | exactly one `Pickle-Rick:` line |
| blank id is a no-op | `tests/runner-authored-trailer.test.js` | stamp with `'   '` | message returned unchanged |
| parsed-view visible | `tests/runner-authored-trailer.test.js` | pipe through `interpret-trailers --parse` | `Pickle-Rick:` appears in the parsed view |
| microverse commits stamp | `tests/microverse.test.js` | the two auto-commit paths | each message carries the version trailer |

### Acceptance criteria — R4

- `grep -c "stampPickleTicketTrailer(" src/bin/mux-runner.ts` returns `3` (B-RATRAIL anchor unbroken)
- `node -e "const m=require('./bin/mux-runner.js'); const o=m.stampPickleTicketTrailer(process.cwd(),'subject','t1'); process.exit(/^Pickle-Rick: \d+\.\d+\.\d+$/m.test(o)?0:1)"` exits `0`
- `node -e "const m=require('./bin/mux-runner.js'); const o=m.stampPickleTicketTrailer(process.cwd(),'subject','t1'); process.exit(/^Pickle-Ticket: t1$/m.test(o)?0:1)"` exits `0`
- `node -e "const m=require('./bin/mux-runner.js'); const a=m.stampPickleTicketTrailer(process.cwd(),'s','t1'); const b=m.stampPickleTicketTrailer(process.cwd(),a,'t1'); process.exit((b.match(/^Pickle-Rick:/gm)||[]).length===1?0:1)"` exits `0` (idempotent)
- `node -e "const m=require('./bin/mux-runner.js'); const o=m.stampPickleTicketTrailer(process.cwd(),'s','   '); process.exit(o==='s'?0:1)"` exits `0` (blank-ticket no-op preserved)
- `grep -c "\['commit', '-m'" src/bin/microverse-runner.ts` returns `0` (both raw commits now stamp)
- `./node_modules/.bin/tsc --noEmit` exits `0`
- `npx eslint src/ --max-warnings=0` exits `0`

**Mutation verification (binding), both directions:** delete the version stamp and observe exactly the
version pins RED with the `Pickle-Ticket` pins GREEN; then force the stamp to emit unconditionally,
ignoring the blank-id guard, and observe exactly the no-op pin RED.

---

## Bundle-wide constraints

- **Author every acceptance criterion in executable form** (`` `cmd` exits N `` / `` `cmd` returns N ``).
  The coverage ratchet `audit-acceptance-assertion-coverage.sh` is a ratio lower-bound that never
  refuses growth — it refuses exactly one thing, the ratio falling. B-INVENTED dragged it 24/73 → 25/82
  and reddened the gate on nine tickets carrying one executable assertion between them.
- **Every pin gets an over-trigger control.** Under-trigger alone passes a do-anything bug; this
  session has already caught two unfalsifiable controls in hand-written criteria.
- **No new gate legs** are contemplated by any root. Proposing one requires answering the four
  gate-leg questions in the ticket first.
- **Prefer subtraction.** R1 and R3 are both explicitly framed as removing a distinction rather than
  guarding it.

## FALSIFY — take these observations before building

- `grep -n 'baseline_score !== 0' src/bin/microverse-runner.ts` returns nothing → R1 already fixed.
- `grep -rn 'resetStoppedMicroverseState' src` shows no call site → R1 is unreachable; close it.
- `grep -n "strict ? 'High' : 'Critical'" src/bin/pipeline-runner.ts` returns nothing → R3's mechanism moved.
- `grep -n "severity: 'High'" src/services/citadel/ac-coverage-scorecard.ts` returns nothing → R3's one-notch claim is wrong.
- `git log -200 --format='%B' | grep -ciE 'pickle.?rick.*[0-9]+\.[0-9]+\.[0-9]+'` returns non-zero → R4 already satisfied.
- `grep -c "stampPickleTicketTrailer(" src/bin/mux-runner.ts` does not return `3` → R4's binding constraint must be re-derived before designing.
