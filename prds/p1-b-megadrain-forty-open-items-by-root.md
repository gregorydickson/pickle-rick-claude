# B-MEGADRAIN — the whole open backlog, composed BY ROOT

**Priority:** P1 (reliability)
**Type:** bundle (bug + hardening) — operator-directed 2026-08-28: *"we need to batch these in large
batches"* / *"in the past we have done very large prds with dozens of tickets."*
**Branch:** `release/v2.1-beta`
**build_mode:** unattended, uniformly. (Corrected 2026-09-05: the "R-PSRB self-modifying-recovery"
carve-out is DELETED — source and the deployed runtime are isolated, so no root is specially exposed.)

## Why one bundle and not five

Measured phase economics (`pipeline-runner.log` timestamps, 9 sessions): **PICKLE is linear at
22–25 min/ticket; ANATOMY-PARK + SZECHUAN are a near-fixed ~300-minute toll** reviewing the accumulated
diff by SUBSYSTEM. Draining ~33 tickets as five bundles pays that toll five times (~37h). One bundle
pays it once (~18h).

**There is no ticket-count ceiling.** The 6–7 cap in `MASTER_PLAN.md` was RETRACTED 2026-08-26: it was
founded on `B-CGSHIP`'s log line `hit iteration cap`, and session state showed `max_iterations: 500`,
`iteration: 6`, mux-runner **exit code 0**. Nothing capped anything — the line was the
`null`-`priorExitReason`-renders-as-a-specific-cause bug. The one mechanism that genuinely stranded work
in a large bundle (mux-runner exiting 0 with a ticket `In Progress`) shipped as **AC-D2′** in beta.20
(`06c9e64b`, *"render absent exit_reason honestly, park not exit on refused finalize"*).

**The real risk predictor is ITERATION COUNT, not roster size.** Watch `iteration`, not the roster.

## ♻️ RECOMPOSED 2026-09-05 — READ THIS BEFORE SCOPING ANY ROOT

This PRD was authored 2026-08-28. **Four releases have shipped since (beta.22 → beta.25) plus
B-ARGMAX and B-FRESHWIN**, so a meaningful fraction of the roster below is already closed. Launching it
as written would spend worker lifecycles rebuilding shipped work.

**STRUCK — closed since authoring; do NOT create tickets for these.** Verified FIXED by the 2026-08-31
sweep: `R-ISSC`, `R-SJLAGMT`, `R-GBANNER`, `R-NOPOSTTIER`, `R-GENVL`, `R-WGTORPH`, `R-ORCG`, `R-MPVU`,
`R-BCFR`, the 2026-08-07 crash-floor P2. Closed since that sweep: `R-JUNS` and `R-FBTN` (2026-09-01),
the `R-RNTA` mechanism (2026-09-01, and its distribution channel proven in the field 2026-09-04 —
beta.25 shipped `assets=1` over a red gate), `B-LOGEV` and the `B-ONEABORT` residual (2026-09-05,
B-FRESHWIN tickets `9ef9ea19` / `0d579ec5`). `B-OFFREPO` is **partially** shipped — `AC-OFFREPO-1/-2a/
-2c/-2d` are live across 8 files, but the `<workingDir>/extension` keying still stands at 8+ sites in
`mux-runner.ts`; scope its FIVE cited sites individually or not at all.

**ADDED — filed after this PRD was written, same `microverse-runner.ts` surface, so they ride this
review for free:**
- **[[B-JUDGETO]]** (`prds/p1-b-judgeto-the-szechuan-judge-exceeds-its-own-raised-ceiling.md`) — the
  szechuan judge times out at 600s, the ceiling `R-SJWT` raised to 600 in June to stop it timing out.
  Do NOT raise it again; measure whether `R-SJWT-1`'s `allowed_paths` scoping still holds.
- **[[R-JPCM]]** — the judge PROMPT demands a bare number, the judge PARSER demands JSON, so the
  violation ledger is always empty. Same file, and the two defects are adjacent: the judge cannot
  finish measuring, and when it does the contracts disagree.

**MANDATORY per-root discipline — the roster above is a CANDIDATE list, not a verified one.** An
automated pass over the plan's status cells was attempted and was **not reliable** (it classified six
sweep-verified-fixed rows as live, because those rows carry descriptive prose about their original
open state). So every ticket's research phase MUST re-run the mechanism check — grep HEAD and the
deployed tree for the MECHANISM, never the `R-` code — before writing any fix.

**When a premise turns out to be stale, declare `zero_diff_intent: already-satisfied` in frontmatter UP
FRONT** and close the ticket on evidence. This is the measured-good pattern: B-DRAIN13 closed two of
its thirteen that way, each with a full lifecycle and machine-checkable ACs, and composing
one-ticket-per-PRD would have spent two worker lifecycles discovering nothing. A stale row closed
cheaply is a success, not a failure.

---

## 🚨 ROOT A — MEASUREMENT DESTROYS ITS OWN EVIDENCE (this codebase's dominant defect class)

Every item here is a gate or audit that **reports a verdict it did not measure**. Order this root FIRST:
until the fast tier is green on Node 22, every other root's CI verdict is unreadable.

**⚠ A1 MUST BE `order: 1`.** It is the live AC-R8 blocker, the fix is ~5 lines, and until it lands this
bundle's own AC-M10 baseline is RED on Node 22 — so every later ticket's gate would be measured against
a broken tier. Refinement must not reorder it.

**⚠ MEASURE THE FAST TIER ON NODE 22, not only Node 24.** Standing precondition corrected 2026-08-28:
pinning Node 24 locally is what let A1 through a "green" gate. Same tree, same commit —
Node 24: `8598 pass / fail 0`. Node 22: `fail 5, cancelled 5`. Node 24 HIDES this class. The prior claim
that "the Node 22 line cancels ~38 fast-tier tests" is **false at this HEAD**: the only Node-22 failures
are A1's own 6.

**A1 — `describe.each` shim cancels its own subtests. BUNDLE-CAUSED, blocks AC-R8, and is live NOW.**
`aa4f847f` (anatomy-park, in beta.21) added 6 tests to `ensure-monitor-window.test.js` via a local shim
that groups with `test()` instead of `describe()`:
```js
test(format(name, ...values), () => fn(...values));   // inner test() calls become subtests
```
The inner `test()` calls become subtests of a **synchronous parent that returns before they settle**.
Measured on Node 22.23.2: `fail 5, cancelled 5`, `failureType: 'cancelledByParent'`,
`error: 'test did not finish before its parent and was cancelled'` — byte-identical to the beta.21 CI
failure (`FAIL_BUDGET_EXCEEDED failures=3 budget=2 runs_completed=3`, same 6 names in all 3 runs).
Node 24 drains both subtests and reads green, which is why the local gate shipped it.

**It is a CLASS, not an instance.** Six shims exist; **2 group with `test()`, 4 with `describe()`**:

| file | groups with | status |
|---|---|---|
| `tests/ensure-monitor-window.test.js` | `test()` | **FAILING** (5 fail / 5 cancelled on Node 22) |
| `tests/monitor-mode-resilience.test.js` | `test()` | **LATENT** — passes only because each block holds ONE test |
| `tests/send-to-morty-no-premature-promise.test.js` | `describe()` | correct |
| `tests/gitattr-inference-deleted.test.js` | `describe()` | correct |
| `tests/integration/mega-bundle-rollup.test.js` | `describe()` | correct |
| `tests/integration/worker-timeout-tier-budget.test.js` | `describe()` | correct |

Fix by SUBTRACTION: **one shared shim** (the 4 correct ones are the oracle), not two patches. Adding a
second `test()` to any `monitor-mode-resilience` block is the next silent cancellation.
Full Node-22 fast tier at HEAD: **8604 tests, 8588 pass, fail 5, cancelled 5** — these 6 are the ONLY
failures. Nothing else on that tier is red.

**A2 — `check-flake-budget` throws away the child's output on the ONE path that needed it (R-FBTN-2).**
`src/bin/check-flake-budget.ts:278`: when `isBudgetableTestFailure()` is false it throws with only
`summarizeHarnessFailure()`'s **first non-empty line**, while the budgetable path writes full
stdout/stderr to `logPath` first. **R-FBTN already shipped** (`495d5e50`) and fixed the budgetable half;
this is its surviving sibling — the enumerated-set shape one branch over. Cost, measured: a 187-byte
gate log naming `▶ AC-6: Operator/terminal surface guard`, a suite that passes 16/16 — the reporter names
whichever file printed FIRST (`ac6-…` sorts first), so it accuses an innocent test by construction.
Fix subtractively: write the log BEFORE classifying the failure; one seam, not two.

**A3 — `rg` is not provisioned, the audit check silently no-ops, and the audit reports OK.**
beta.21 CI log: `scripts/audit-trap-door-enforcement.sh: line 576: rg: command not found`, and the audit
still exits 0 / prints `OK`. This is B-CIGREEN's ROOT A **still live** — the bundle did not fix it. Either
provision `rg` in both workflows or make the check use a provisioned tool; either way an unrunnable check
must FAIL, not pass (reuse the `isUnrunnableCheckResult` fail-closed discipline from R-SZGB-D).

**A4 — R-GBANNER** — the between/cross-ticket gate parser reports an npm lifecycle banner
(`> pkg@ver pretest:fast`, EMPTY `file`) as a failing TEST NAME, and the cross-ticket variant attributes
it to an already-green ticket. Two independent sessions. Fix: empty `file` + `^> \S+@\S+ \S+$` ⇒ attribute
to the SCRIPT, never seed a cross-ticket attribution.

**A5 — R-SJLAGMT** — `sjlag-state-heartbeat.test.js:60` compares float `mtimeMs`; same-millisecond stat
pairs lose ordering (`before=…970.9998 after=…970.999`). Use `{bigint:true}` `mtimeNs`. Do NOT relax to
`>` or delete — the heartbeat is real.

**A6 — R-NOPOSTTIER (P1)** — no phase measures the tier AFTER the bundle's final commit, so a run can
pass every per-ticket gate and hand back a red tree. Report-only per the no-stop rule: withhold the
success verdict, never block the epic.

**A7 — R-GENVL** — the gate inherits the manager env and `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` is read at
TEST time; 7 of 8 measured failures were pure contamination. Reuse the existing gate-env scrub seam
(`scrubGateEnv`/`PICKLE_GATE_SCRUBBED_ENV_KEYS` already exist — extend, do not add a second scrubber).

**A8 — R-ISSC / R-APGG** — `test:integration` short-circuits so the serial half is never measured when
parallel fails; the release gate must measure both halves independently.

## 🔁 ROOT B — MACHINERY PERSISTS A CONCLUSION AND NEVER RE-MEASURES IT

Four instances found in a single day, one shape: a durable artifact records a conclusion about the world
and nothing re-checks whether it still holds.

**B1 — `pipeline-cancel` is never cleared at startup. VERIFIED IN SOURCE, and it cost two phases.**
`bin/pipeline-runner.ts`: written on signal at `:3710` (`installShutdownHandlers`), unlinked ONLY at
`:4541` inside `finalizePhaseSuccess`. `main()` computes it at `:5324` and installs handlers at `:5325`
**without ever clearing a pre-existing marker**, while `cancelledOutcome` (`:5162`) cancels on its mere
existence. Measured: a fresh pipeline-runner inherited a 3-hour-old SIGTERM marker and stopped after
citadel — anatomy-park and szechuan never ran. Fix: a fresh run cannot be cancelled by a prior run's
signal; clear at startup.

**B2 — `handleRateLimit` waits on an IN-MEMORY deadline and never re-probes the API.**
`waitEnd = Date.now() + actualWaitMs`, polling only `state.active`. Deleting `rate_limit_wait.json` does
nothing — it is a STATUS artifact, not the control. Measured: over-waited 360 min on a limit that
cleared in ~45.

**B3 — `rate_limit_wait.json` re-arms itself on resume from the stale persisted `resets_at`**, and
mux-runner AC-A5 reads its PRESENCE to classify a spawn failure as rate-limited — so a stale file
misclassifies an unrelated failure. Source seams: `bin/mux-runner.ts:8229`, `:8490`, `:8494`, and the
presence-predicates at `:4684` / `:4769`.

**B4 — `pickle_incomplete.json` is never cleared when a later pickle phase completes the remaining
tickets.** Log-noise only — the runner DOES override it with real ticket evidence. Lowest priority in
this root; included because it is the same shape, not because it bites.

## 🐙 ROOT H — THE OPEN GITHUB ISSUES (#6 – #10, filed 2026-09-03; none were in the plan until 2026-09-05)

Six of the seven open GitHub issues were **referenced nowhere** in `MASTER_PLAN.md` or this PRD. They
are operator-filed, they postdate this bundle's authoring, and two are confirmed live by field evidence
from the 2026-09-04/05 runs. Read each issue for its full diagnosis; the notes below are the
independent confirmation, not a substitute.

**#6 — `microverse` auto-commit hardcodes "worker timed out" on a branch that only tests for a dirty
tree. CONFIRMED at `microverse-runner.ts:4657`:**

```
ctx.log('No commits but dirty tree detected — auto-committing worker changes');
execFileSync('git', ['commit','-m',`microverse: auto-commit (worker timed out before committing)`], …)
```

The guard is `owned.length === 0` plus a dirty tree. **Nothing in it observes a timeout.** The commit
message asserts a cause the branch never measured — the `failed`-vs-`empty` collapse, written into git
history where it is read back as fact. Field evidence: `b4404985` (B-ARGMAX) and `099554aa`
(B-FRESHWIN), both of which were reported up the chain as "a worker timed out" **because the message
said so**. Fix: name the condition the branch actually tests, or measure the cause before claiming it.

**#9 — command-argument substitution rewrites `$1` inside emitted `launch.sh` templates. CONFIRMED by
three live launches.** `~/.claude/commands/pickle-pipeline.md:237` on disk is correct
(`SESSION_ROOT="$1"`), but the RENDERED skill prompt carried `SESSION_ROOT="--refine"` — the invocation
argument substituted into the template's positional. A launcher that takes it verbatim writes every
artifact under a session root named after a flag. Caught and hand-corrected at each of the three
pipeline launches this session; five phase launchers share the shape.

**#7 — szechuan stalls structurally: the worker never works the ledger the metric scores.** Adjacent to
ROOT C0's judge work and to `R-JPCM`; szechuan degraded on **both** completed bundles this session, so
compose these three together rather than separately.

**#8 — anatomy-park declares convergence on an iteration that produced no INV-NO-SELF-DISOWN evidence.**
Anatomy-park reported `completed successfully` on both bundles this session; if the convergence verdict
can be reached without the evidence that backs it, those verdicts are unproven rather than wrong.

**#10 — `refinement_manifest.tickets` silently omits every requirement whose AC family carried no shape
smell — dropped 2 of 9 with `all_success: true`.** A success verdict over an incomplete enumeration.

**NOT in this bundle: #5** (adopt Genesis's persistent-knowledge model) is an *enhancement*, and dispatch
order is bugs before feature epics. It stays queued.

---

## ✂️ ROOT 0 — COLLAPSE THE VERDICT LAYER (operator-set 2026-09-05; ORDER FIRST; subsumes much of A/C/C0)

**Operator: *"all those reasons and classifiers are cruft. fix it."*** This is a SUBTRACTION root and it
is the thesis of the bundle. Every other root here fixes an INSTANCE of a verdict asserted over
something unmeasured; this one removes the structure that keeps generating them.

**Measured 2026-09-05 — do not re-derive:**

| | |
|---|---|
| phase workers (`spawn-morty` + `backend-spawn`) | **5,238 lines** |
| verdict/orchestration (`mux` + `pipeline` + `microverse` runners) | **26,327 lines — 5×** |
| distinct `classify*` / `is*Exit` predicates in `src/` | **52** |
| overlapping state sets | `MICROVERSE_EXIT_REASONS` **18**, `MICROVERSE_FAILURE_REASONS` **5**, `MICROVERSE_FATAL_REASONS` **1**, `MUX_ITERATION_REASONS` **5** |
| boolean halt/failure predicates, ~50 refs | `isHaltExit`, `isFailedExit`, `isFailureExit`, `isMicroverseFailureExit`, `isFatalPhaseFailure`, `isIncompleteExit`, `shouldHaltAfterPhase` |

**Output for comparison (commits since 2026-07-01, total 1,593):** pickle **786**, anatomy-park **423**,
szechuan **139**, microverse rescue 28, **citadel 9**. The work layer earns its keep. Across six recorded
runs there were **ZERO build failures** — every shortfall came from the verdict layer.

**The whole loop is: iterate on issues until they reach zero.** A phase outcome has three shapes —
**made progress · did not · could not measure** — plus the crash floor (state unreadable/unwritable).
Seven booleans and four overlapping sets exist mostly to answer *"should we stop?"*, which the PRIME
DIRECTIVE already answers: **no**.

### Acceptance criteria (machine-checkable)

- **AC-0a** ONE disposition vocabulary for phase and iteration outcomes. Every surviving predicate is a
  DERIVATION of it, not an independent list. State the before/after count of predicates and sets.
- **AC-0b** **Behaviour parity, exhaustively proven.** Build the full `(exit_reason × phase) → action`
  table from the SHIPPED code, then from the collapsed code, and diff them. Every difference is either
  absent or named as an intentional defect fix with its evidence. This is the AC that stops a
  "simplification" from silently changing halt behaviour.
- **AC-0c** **No new abort condition.** `MICROVERSE_FATAL_REASONS` stays at ONE member
  (`session_state_corrupted`). The crash floor does not grow. Mutation-verify: adding a member reddens.
- **AC-0d** Net LOC across the three runners goes **DOWN**, stated as a number. Growth anywhere is
  repaid in-bundle.
- **AC-0e** Citadel: it produced **9 commits in two months** while emitting 111/115/25 advisory findings
  per run that close `cycles: 0, findings_remaining: 67`. `readCitadelReport` has 4 readers — trace them
  and state whether any finding becomes a fix. If none does, the phase emits a number nobody acts on:
  either wire it to remediation or delete it. Do not leave it emitting an unread verdict.
- **AC-0f** Each removed predicate/set member is mutation-verified: deleting it must redden a real test,
  or it was already dead and its removal is recorded as such with the probe.

**Non-goals.** Do NOT preserve a predicate because a test names it — move the test to the collapsed
seam. Do NOT add a compatibility shim that keeps both vocabularies alive; two vocabularies is the defect.

**Subsumption.** ROOT A (measurement destroys its own evidence) and ROOT C (two termination channels)
are instances of this; scope them AFTER ROOT 0 lands and close as `zero_diff_intent: already-satisfied`
whichever the collapse already fixed.

---

## 🚨 ROOT C0 — `manager_handoff_pending` HALTS THE PIPELINE ON AN INFORMATIVE NOTE (GitHub #11, operator-filed 2026-09-05)

**Order this FIRST. It is the highest-severity item in this bundle and it endangers this bundle's own
run.** A four-phase `/pickle-pipeline` stopped at **0 of 4 phases** because the last ticket's
conformance artifact contained a `## Manager Handoff` section that was purely informative — a worker
CORRECTING a stale note and reporting a 9/9 PASS. Re-attaching cleared `exit_reason` and ran straight
through to citadel with no operator action. The halt cost three phases and a human round-trip.

**Mechanism.** `evaluateCloserTerminalState` (`mux-runner.ts:5998`) exits `manager_handoff_pending`
when a Done ticket's conformance has a handoff section. **The gate tests whether the worker WROTE
something, not whether an operator MUST ACT before work can continue** — orthogonal properties. Thorough
workers write substantive handoffs routinely, so *the better the worker, the likelier the pipeline
stalls*: a quality signal wired to a halt, which the PRIME DIRECTIVE forbids outright.

`hasSubstantiveManagerHandoff` (`:5949`) compensates with a **two-arm denylist of boilerplate
phrasings** — the enumerated-set shape root `CLAUDE.md` names as "a liability with a maintenance
schedule". It has already grown once (the `none`/`n\a` arm was added for an earlier false-positive
class), and its own comment concedes the premise: *"Workers write the `## Manager Handoff` header
unconditionally."* If the header is unconditional, its PRESENCE carries no information at all.

**MEASURED 2026-09-05 by replaying the SHIPPED predicate over the live artifact corpus** (41
conformance artifacts across 6 sessions) — do not re-derive:

| | count |
|---|---|
| artifacts scanned | 41 |
| carry a `## Manager Handoff` header | **26 (63%)** |
| **`hasSubstantiveManagerHandoff` returns true → would halt** | **10 (38% of those; 24% of ALL tickets)** |

Ten halting tickets span **five different sessions**, including **three in the B-CIGREEN run that was
executing while this was written** (`12fc3483`, `ad66feb5`, `c75ba623`). That run did not halt only
because the ticket evaluated at the closer boundary happened not to be one of them. **This is a coin
flip on every bundle, and a bigger roster is a bigger target.**

**CONSUMER CENSUS 2026-09-05 — the predicate has exactly TWO production readers, and one of them is a
proxy standing in front of a real oracle.** Everything else is test mass.

| consumer | line | what it does |
|---|---|---|
| the halt | `mux-runner.ts:6152` | `status === 'done' && hasManagerHandoff` → `exit`, `manager_handoff_pending`. **Terminal by design** — `:12969` records it as "operator-gated and never recovered by the ladder", and `isHaltExit` (`:5347`) includes it. |
| phantom-Done guard | `mux-runner.ts:2121` | inside `correctPhantomDoneTickets`: `if (conformance.hasManagerHandoff) continue;` — protects a Done ticket from being reverted to Todo |

Defending those two call sites: **11 unit cases** pinning the denylist arms in `mux-runner.test.js`,
plus source-text pins in `tests/integration/closer-handoff-terminal.test.js` that assert the FUNCTION
NAME exists in the source, plus a reconcile-parity test. Deleting the predicate reddens all of them, so
the tests must move with the behaviour rather than be worked around.

**The `:2121` reader is the interesting one: it short-circuits ONE LINE BEFORE the real evidence
oracle.** `batchLoopPhantomDoneKind` runs immediately after and returns `explicit-reachable` /
`inferred` / `absent` from actual commit evidence. So the handoff text is being used as a *proxy for
having evidence*, in front of a check that measures evidence directly. Determine by measurement whether
that `continue` changes any outcome the oracle would not already reach; if it does not, it deletes too
and the predicate loses its second consumer.

**Fix shape (subtraction, not another denylist arm).** No arm can classify this case and none should —
the text genuinely IS a manager note; it simply is not a BLOCKING one. Distinguish the two properties
instead of guessing between them: either a worker declares blocking-ness explicitly, or the disposition
becomes park-and-flag per [[B-NOSTOP-GATES]] — record the residual, continue to citadel, never break
the phase loop. Adding a third regex arm is the prohibited fix.

**⚠ EXPOSURE — and it is NOT special to this root.** The halt lives in the DEPLOYED runtime, and a
worker editing `mux-runner.ts` in source cannot change the runtime executing it. So this gate can stop
**any** bundle at its closer seam, including one fixing something unrelated — the ~24% figure above is a
property of the deployed build, not of this bundle's subject matter. There is no self-modifying category
and no reason to split, reorder or re-posture on account of it.

**The recovery is measured and cheap.** GitHub #11: re-attaching `launch.sh` against the same
`SESSION_ROOT` cleared `exit_reason`, marked pickle complete and entered citadel — `completed_phases`
0 → 1, no operator judgement required. Treat a `manager_handoff_pending` stop as a known false positive
and re-launch. Once C0 ships and is DEPLOYED, the exposure is gone for every future run.

---

## ⛔ ROOT C — TWO TERMINATION CHANNELS, ONE SUBTRACTION (halt → park)

**C1 — B-ONEABORT residual — ❌ CLOSED BY MEASUREMENT 2026-08-28. DO NOT DISPATCH A TICKET.**
The pre-launch stale-premise check killed this one. At HEAD `0a5d4146` **and** in the deployed mirror:
```
export const MICROVERSE_FATAL_REASONS = [ 'session_state_corrupted' ];   // exactly ONE
```
The residual the handoff described (`judge_cli_missing` + `baseline_unmeasurable_unrecoverable` still
fatal, "3 → 1") is **stale**. Both reasons survive only in `MICROVERSE_FAILURE_REASONS`
(`types/index.ts:1467`), which drives `isMicroverseFailureExit` — a REPORTING classification that
withholds the success verdict. That is precisely what [[B-NOSTOP-GATES]] mandates: *honesty is a
REPORTING property, halting is a DISPOSITION, and they are not the same wire.* Keeping them there is
correct, not a residual. **B-ONEABORT's target of exactly one abort condition is MET.**
*Method note: this is the third time in this file's history that a ticket was nearly built on a premise
the code had already satisfied. Grep HEAD and the deployed tree before writing the ticket, not after.*

**C2 — R-JUNS** — an unparseable judge answer is treated as "unrecoverable" and aborts the pipeline. A
parse failure is a measurement failure.
**C3** — a deployed crash-floor halt verdict is discarded at the phase boundary; the amnesiac breaker
zeroes its own bound ($13.21 burned).
**C4 — R-MVPARK** — microverse rate-limit park has no cumulative ceiling; route through the EXISTING
`state.rate_limit_park` accumulator (`microverse-runner.ts`), do not grow a second ledger.
**C5 — R-EROS** — an In-Progress ticket is reported "all-Failed" and stamped `recovery_exhausted`.

## 🧟 ROOT D — PROCESS LIFECYCLE: ORPHANS, WEDGES, AND THE LINUX-ONLY SUBPROCESS REDS

**D1 — R-ORCG (supersedes R-WGTORPH's scope).** The orphan reaper's own test suite is the box's biggest
orphan producer and the shipped reaper cannot match most of what it produces. Operator census: 42 procs,
all `ppid 1`, ~1.7 GB. Two proven sub-defects: teardown lives in a per-test `finally` (unreachable on
timeout/OOM/cancel) and the fixture installs a no-op SIGTERM handler so it survives by design; and
`resolveTmpPrefixFixturePath` (`services/orphan-reaper.ts:148-162`) matches only an argv token resolving
under `os.tmpdir()` whose first segment starts `pickle-`, so a bare
`node <repo>/extension/tests/fixtures/sigterm-ignoring-sleeper.js` matches **zero** classes
(`grep -rc cxhang extension/src/` = 0).
**Census caveat, binding:** the population is currently **0** (hand-SIGKILLed). An empty census is NOT
evidence of a fix. Any AC must be demonstrated against a REAL re-accumulated population, never planted
fixtures — the R-WGTORPH fix passed precisely because its test planted the one class it could match.
Escalate to SIGKILL and VERIFY by pid; a SIGTERM that returns success changes nothing (measured).

**D2 — B-CIINT: the Linux-only serial-tier reds.** 7 fail / 3 cancelled on Linux, **633/633 green on
macOS/Node 24** (re-measured this session). Six are subprocess-lifecycle (kill/timeout/orphan) and one
is a path-containment pair. **CORRECTED 2026-08-30 (ticket `c1d1eeb3`): the constraint carried forward from
the B-CIGREEN PRD — "`docker` has no VM, so there is no local Linux repro" — is false as stated.**
Docker runs here (server 29.0.1) and `extension/scripts/ci-repro.sh` reproduces CI's Linux
environment with a measured **provisioning-noise baseline of 0** at `fe7860bb` (1-3 genuine failures
of 8902 tests across three runs, against 130 for the naive container shape). **What survives the correction is the rule, unchanged: a
ticket may not close on "passes locally" — it closes on a mechanically-checkable property, a green CI
run, or a `ci-repro.sh` run naming the sha it tested, and must say which.**

**D3 — R-TIERWEDGE** — a plain `npm run test:fast` can wedge at ZERO CPU: log frozen 8+ min, runner and
children with unchanged CPU time across samples, no summary emitted. Cannot fake a green (no summary) but
never returns. **Operational rule to encode: any wait on a tier run needs a STALL detector (no log growth
for N minutes), not a timeout.**
**D4 — R-GRLS** — fd cleanup only via `process.on('exit')`, which SIGKILL never runs.
**D5 — R-DSPW** — manager re-spawns a worker whose worker is still alive; the `rtk` filter empties
`ps|grep` so a live worker reads as dead. Fix subtractively: remove the heuristic that declared it dead.
**D6** — TMPDIR fixture-directory leak (~15k `pickle-*` dirs/run; TMPDIR is Spotlight-indexed).

## 🔄 ROOT E — RESTORED TO THIS BUNDLE (2026-09-05; its exclusion rested on a category that does not exist)

**`R-ORSR-2` and `R-ACNP` are back IN.** They were removed 2026-08-28 on the reasoning that they edit
the salvage / completion-evidence / Done-flip path, which made them "R-PSRB" and therefore
attended-only, conflicting with this bundle's unattended `build_mode`.

**That rationale is void.** Source and the deployed runtime are isolated — a worker editing those files
cannot change the runtime executing it — so editing the salvage path confers no special exposure and
there is no attended-only class to conflict with. The exclusion removed real work for no measured
reason.

`B-LOGEV`, the third member, is separately **CLOSED** — shipped 2026-09-05 in B-FRESHWIN (ticket
`9ef9ea19`, commit `b8e4753e`). Do not scope it.

Both restored members carry the same verify-first burden as every other root: re-run the mechanism
check against HEAD before writing a fix, and declare `zero_diff_intent: already-satisfied` if the
premise has gone stale.

**Split to `prds/p1-b-evidence-completion-evidence-and-done-flip-attended.md` ([[B-EVIDENCE]]), to be
launched attended as its own bundle.** 3 of 30 tickets — the phase economics barely move, and the
constraint is honored rather than hoped past.

## 📦 ROOT F — DEPLOY, INSTALL, AND PATH RESOLUTION

**F1 — the installer never prunes removed files.** Measured this session:
`~/.claude/pickle-rick/extension/bin/tmux-runner.js` is a **complete stale copy of mux-runner.js**
(identical line numbers at `:6795`, `:9438`, `:10376`). Inert — nothing invokes it — but a stale runtime
twin is a live misdirection hazard for anyone grepping the deployed tree. Verify deploys BY CONTENT.
**F2 — R-MPVU** — the manager prompt ships `${EXTENSION_ROOT}` unbound (8 literal occurrences delivered;
`grep EXTENSION_ROOT mux-runner.ts` = 0 hits). Blocks `--backend codex` entirely; claude infers and
proceeds. The fix is written and unwired: `getExtensionRoot()` (`services/pickle-utils.ts:301`).
**Build on claude — this bundle cannot build itself on codex.**
**F3 — R-RNTA** — release workflow reorder (build+attach the tarball independent of the gate).

## 🧩 ROOT G — SINGLETONS

**G1 — B-OFFREPO (P1)** the worker quality gate does not exist on any repo that is not pickle-rick.
**G2 — R-JPCM** the judge prompt demands a bare number, the parser demands JSON — ONE contract, not a
second parser. Also correct the stale `extension/CLAUDE.md` trap door that misroutes triage to a
dead-code hypothesis.
**G3 — `writeWithWatchdog: rejects with backpressure error when sink never drains`** flaked 1-in-5 this
session (200 ms). Same sole-settle-path timer family as B-DRAIN13 ROOT 1, which already fixed this exact
function once. Re-measure before assuming a second defect.
**G4 — R-BCFR** delete the `isBraceFreeIf` arm; verify-then-delete the `isNever` arm.
**G5 — R-HNCG / R-TCVC** unscoped bug reports — reground or close.

## Held back DELIBERATELY

`BUG-2026-08-10-install-sh-destroys-its-own-source-tree` — installer-surfaced but large (33 references)
and **destructive**. It does not belong in a bundle carrying 30 other tickets. Its own bundle.

## 🛡 PRIME DIRECTIVE COMPLIANCE — stated explicitly because this bundle is large

- **No new halt path.** ROOT C removes two abort conditions; ROOT B removes four persisted-conclusion
  states. ROOT A's fail-closed changes (A3) refuse a LOCAL verdict — an unrunnable check may not read as
  a pass — and never break the phase loop.
- **Subtraction is the preferred fix.** A1 collapses 6 shims to 1. A2 collapses 2 reporting paths to 1.
  B1 removes a state distinction. D5 removes a heuristic rather than guarding it.
- **Enumerated sets are the target, not the tool.** A1, A2 and D1 are all "the list was one member short."
  Prefer the formulation that needs no list.

## Acceptance criteria

- **AC-M1** Node-22 fast tier is `fail 0, cancelled 0`. Measure with Node 22 explicitly —
  **Node 24 hides this class** (proven: same tree, 8598 pass / 0 fail on 24, 5 fail / 5 cancelled on 22).
- **AC-M2** One shared `describe.each` shim; both defective files use it; a mutation adding a second
  `test()` to a `monitor-mode-resilience` each-block is demonstrated GREEN (the latent arm is closed, not
  just the failing one).
- **AC-M3** A non-budgetable flake-budget child failure writes the child's FULL stdout/stderr to a log
  path named in the error. Mutation-verify: the message must not be able to name a passing test.
- **AC-M4** An unrunnable audit check (missing `rg` or any absent tool) FAILS; it may not print OK.
- **AC-M5** A fresh `pipeline-runner` with a stale `pipeline-cancel` present runs all phases.
- **AC-M6** The rate-limit wait re-probes the API; `rate_limit_wait.json` presence alone cannot classify
  a spawn failure.
- **AC-M7 — WITHDRAWN, already satisfied at launch.** `MICROVERSE_FATAL_REASONS` is already exactly
  `['session_state_corrupted']` at HEAD and deployed (see ROOT C / C1). Retained as a REGRESSION pin
  only: no ticket in this bundle may add a member to it.
- **AC-M8** D1 is demonstrated against a RE-ACCUMULATED real orphan population, not planted fixtures.
- **AC-M9** Every D2 ticket states in its closing artifact WHICH it closed on: a mechanically-checkable
  property, or a green CI run. "Passes locally" is not a close.
- **AC-M10 (report-only, non-gating)** Tiers do not regress. Baseline recorded at launch:
  fast **8604/8598 pass, fail 0, cancelled 0** (Node 24) and **fail 5, cancelled 5** (Node 22, = A1);
  integration parallel **662/662**, serial **633/633**; expensive **8/8** serial + 13/14 parallel
  (1 benign empty-catalog skip), soak genuinely 1803673 ms.
  **There are NO inherited failures — beta.17 retired both — so ANY new failure is attributable to this
  bundle.**
- **AC-M11** A green release-workflow run on the resulting tag (**AC-R8**, unmet for 15 consecutive
  releases, beta.7→beta.21). This is the bundle's headline and the only close that counts for ROOT A/D2.

## Non-goals

- **Do NOT move CI off Node 22.** Node 24 HIDES the unsettled-promise/cancelled-subtest class rather than
  fixing it — proven twice by controlled experiment, and again by A1 this session. Bumping would be
  fake-green by definition.
- **Do NOT raise the iteration cap.** 500 global with no per-ticket budget never bound anything.
- Do NOT blanket-`ref` every timer; a heartbeat holding the loop open forever is a NEW hang.
- Do NOT rewrite published tags. beta.16/.17 pointing at `origin/main` stays an operator residual.

## Simplification Review

1. **Necessary?** ~43 open items; ROOT A's first ticket is what currently blocks the release workflow.
2. **Reuse?** A7 extends `scrubGateEnv`; A3 reuses R-SZGB-D's `isUnrunnableCheckResult` fail-closed
   discipline; C4 reuses `state.rate_limit_park`; F2's `getExtensionRoot()` is already written.
3. **Guards brittle complexity?** No — it removes the distinctions the guards compensated for.
4. **Subtracts?** 6 shims → 1, 2 reporting paths → 1, 3 abort reasons → 1, 4 persisted-conclusion
   states → 0, ~30 PRD rows closed.
