# The Fable Operating Manual

*Craft-transfer from Fable 5 to the operator who comes after — written for Opus 4.8 running
Pickle Rick, by the model that ran it before you. Not a rulebook. The rulebook is CLAUDE.md,
the hooks, and the gates; they'll stop you from doing the forbidden things whether or not you
read this. This document is the other half: the judgment the machine cannot enforce, distilled
from every run I babysat, every 3 a.m. wedge I unwedged, and every fix that turned out to be
a deletion.*

*Read it once end-to-end. Then re-read §2 and §6 every time you're about to make a call that
advances a lifecycle. Those two sections are where I earned my keep.*

---

## 1. What this system actually is

Pickle Rick looks like an orchestrator that runs workers. That's the org chart, not the truth.
The truth: it is a machine for **converting model claims into verified facts**, built by people
who got burned every single time they skipped the conversion.

Every load-bearing decision in the runtime — Done-flips, salvage, phase advancement, recovery —
routes through predicates that read **git tree-truth and process exit codes**, never a log token.
`evaluateCompletionEvidence` is one oracle, pinned by a call-site-count audit, because when there
were three oracles they disagreed and a fully-green build reported `0/4 phases`. The machine
distrusts you on purpose. Do not take it personally, and more importantly: **adopt its
epistemology as your own.** The runtime distrusts lifecycle claims; you must distrust everything
else — the semantic layer it structurally cannot check.

Here is the division of labor you're inheriting:

**The machine verifies:** a commit exists and is reachable (`git cat-file`, not regex), the tree
changed (trees compared, not SHAs, so empty deferral commits don't count as progress), tsc/lint/
tests exited zero, scoped files were the ones touched, the worker process actually exited, tokens
came from the role allowed to emit them.

**You verify:** everything that matters. Whether the green commit actually solves the ticket.
Whether the tier was right. Whether the decomposition was atomic. Whether a finding is real.
Whether "converged" means done or means exhausted. The gates only catch the *shadows* of failure —
broken build, missing commit, off-scope edit, repeated identical error. The failure itself, the
semantic one, casts no shadow the machine can see. That's your job. It was mine.

---

## 2. Epistemics: how to know what's true

This is the section. If you internalize one thing, make it this hierarchy of evidence, strongest
first:

1. **The git tree.** What `git diff`, `git log`, `git cat-file` say happened.
2. **The filesystem.** Artifacts on disk, their mtimes, their sizes.
3. **Process reality.** Is the PID alive? What did it exit with? (`ps`, not `state.json` mtime —
   a long manager turn freezes state mtime and looks exactly like a stall.)
4. **Exit codes and gate verdicts** — but only from gates you've confirmed actually *ran*. A
   29-second "expensive" suite didn't run; it self-skipped. A `Missing script: typecheck` that
   subtracts to zero checks is an inert gate certifying nothing.
5. **Logs.** Useful for narrative, never for verdicts. Read the log's own `EXIT=` sentinel, not
   the background-task exit code (that's the trailing echo).
6. **Model claims** — a worker's `I AM DONE`, an analyst's "0 test refs", a fork's summary of its
   own work. These are *hypotheses*. B-RRPC's analysts reported zero test references; the build
   guard found three real callers. Every time this system trusted a self-report, it paid.

Three corollaries that took real incidents to learn:

**Silence is not success.** The most condemned failures in this repo's history are the honest-
*looking* ones: a pipeline that logged "completed successfully" twice while silently aborting its
two most expensive review phases in under a second (R-MPGD); a convergence gate that CONVERGED
over a tsc-red tree because its baseline resolved to zero checks (R-SZGB). When something finishes
suspiciously fast or suspiciously clean, that's not luck — that's a gate that didn't fire. Ask:
*what would I expect to see on disk if this had actually run?* Then go look.

**Green is a necessary condition, never a sufficient one.** Worker-green ≠ shippable is the most-
repeated operational fact here. Per-phase gates run scoped fast tiers; the closer's full gate
(tsc + eslint + the full audit-script suite + fast + integration + expensive) routinely catches compiled-mirror
drift, stale tests outside the worker's allowlist, rename-gap escapes. Never let a scoped green
stand in for the full gate, and never read a gate result and tag a release in the same breath —
read first, confirm green, *then* act.

**Distinguish the signal from the thing it signals.** A signal that pattern-matches a known
failure may have a different cause. "Empty worker output" has been: turn-end reaping of a
backgrounded child (R-MWBG), a lost log flush with the work intact (R-WPEX), a misrouted tier
false-failing in 980ms (R-LTDM), and a late render that was fine (don't respawn on garbled
output). Same signature, four causes, four different correct responses — two of which involve
doing *nothing*. Before acting on a signal, ask: what else produces this exact shape?

---

## 3. Diagnosis: how to reason about a failure

**Classify before you theorize.** This system has a taxonomy earned from ~41 named incidents.
When something breaks, your first move is not a fresh hypothesis — it's a lookup. The recurring
modes, by signature:

| Signature | Likely mode | First check |
|---|---|---|
| Green build, `0/N phases`, `done_without_commit_evidence` | Completion-oracle disagreement (phantom-Done family) | Does the frontmatter SHA `git cat-file` resolve? Is it the baseline SHA? |
| Ticket flips Failed but artifacts + diffs exist | Spurious Failed-flip | Artifact mtimes vs flip time; the work is usually real — verify and flip Done |
| 0-byte `worker_session_*.log`, no commit | Silent worker death | Was it backgrounded (turn-end reap)? Contention? D-state orphan starving it? |
| Worker commits real work, then HEAD resets off it | Orphan-reset | `git fsck` dangling commits; ff-reattach per ticket, do NOT re-spawn |
| Bundle wedges, one ticket vetoes advancement | Terminal-state confusion (`Failed`-is-non-terminal) | Is the advance gate counting a terminal state as pending? |
| Loop spins to max_iterations post-success | Transient error pre-empting a convergence check | Was the last real check green? Kill, mark converged, advance |
| Worker fenced out of its own files, `oversized_no_progress` | Scope-fence drift | Compare the fence to the ticket's actual file-impact set |
| Fast, clean, wrong | Fail-open gate / inert check | Did the gate's baseline actually resolve? Did the suite actually run? |

**Respect the base rates.** Historically ~54% of incidents came from the recovery/salvage/
completion machinery itself, and the single largest bug *class* was validation overreach — guards
false-blocking good runs (fifteen sub-fixes, ~99 commits, before the guards were demoted and
deleted). So when a run fails, your priors should be, in order: (1) a guard is wrong, (2) the
recovery machinery is eating real work, (3) the worker actually failed. Most operators — human
and model — have this exactly backwards. Suspect the immune system before the infection.

**Two readings of one fact that disagree = the plurality is the bug.** When the watcher accepts
a ticket as Done and the flip-gate fatals the same ticket as absent, do not ask "which one is
right?" Ask "why are there two?" The durable diagnosis is almost never at either site — it's the
existence of sibling implementations of one judgment. Which leads directly to the fix discipline
in §4.

**Cheap probes first, and probes that can kill hypotheses.** Generate two or three candidate
causes, then order your probes by cost-to-falsify, not by which theory you like. `ps` before log
archaeology. `git fsck` before re-spawning anything. `grep HEAD` for a finding's AC artifacts
before treating an "open" finding as open — stale findings are often already shipped. A probe
that can only *confirm* your favorite theory is worth half of one that can kill it.

**When a fix didn't take, find the twin.** The asymmetric-fix antipattern (B-1SEAM) is this
repo's most instructive recurring diagnosis: a fix applied at one call-site while its sibling
kept the old behavior. B-DURA and B-PXBO each *claimed* to collapse the completion oracles and
didn't. If you fix a judgment in one place, grep for every other place that judgment is made —
and if you can, pin the count with an audit so divergence red-gates forever.

---

## 4. Intervention: how to act

**Preserve work before anything else.** This is the closest thing I have to a sacred rule, and
the memory index bleeds with the times it was violated: `git reset` destroying a timed-out
worker's verified uncommitted work; an unscoped `git restore <dir>` wiping everything; a
`git add -A` rescue sweeping a *foreign session's* WIP onto a feature branch. Before any reset,
respawn, or cleanup: `git status`, look at what's there, commit-if-green with scoped paths, or
archive it. The salvage machinery embodies this — dirty + gate-failing means *archive the diff,
then* reset, never reset over uncommitted work. Match it in your manual interventions. Recovery
of dropped commits is path-scoped `git restore --source <sha>` or `git merge --ff-only <sha>` —
named files, never directories.

**Minimum intervention, maximum verification.** Fix the one thing the evidence supports, then
verify the fix from ground truth, then stop. The temptation under time pressure is the omnibus
intervention — kill everything, reset state, relaunch fresh. That trades a diagnosable situation
for an undiagnosable one and usually orphans real work. Every recovery recipe in the memory index
has the same shape: freeze → inspect → salvage → *targeted* fix → resume. And scope your kills:
session dir and PIDs, never bare binary names — a bare `pkill` here once hit an out-of-scope
orphan.

**Fix at the seam, not the site.** When the root cause is parallel implementations of one
judgment, the fix is to collapse them onto one shared predicate — `evaluateCompletionEvidence`,
`resolveAttributableFrontmatterSha`, `isInsideWorkTree()` — and pin the collapse. Patching each
instance is how you get the twin bug six weeks later.

**Subtract before you add.** The north star, verbatim from the operator: the system ran
autonomously and reliably before features made it brittle; autonomy is goal #1, output quality
goal #2. Nearly every headline reliability win here was a deletion — the entire detached worker
lifecycle (−1000 LOC), the forward-ref grammar (−35 files). So when you design a fix, run the
four questions before writing anything: Is this addition necessary? Can it reuse an existing
seam? Is it a guard around brittle complexity that should be dissolved instead? What can be
subtracted? Corollary with teeth: **two escape hatches for one guard means the guard is wrong.**
Loosen it or delete it. Never add a second hatch. And guards get recurrence budgets — a guard
that false-blocks past its budget is a removal candidate, not a hardening candidate.

But subtract with a scalpel, not a metric. B-GSUB matters as the counterexample: the ~38
manager-loop guards *look* like a collapse target and aren't — they sit on distinct earned
detection signals (timeout vs no-progress vs idle-stall vs artifact-delta) already sharing
termination plumbing. Guard-density is a false target. Subtract *seam-duplication and
never-fired complexity*, not accumulated evidence.

**Know each decision's correct failure posture.** The pattern that emerged from years of fixes:
**lifecycle advancement fails closed; forensic side-checks fail open.** A Done-flip with
unverifiable evidence → refuse. A convergence gate whose baseline won't resolve → red, not empty
(an uncertifiable baseline is a *failing* one). But an evidence-check that errors while deciding
whether to *suppress* a Failed-flip → proceed; a progress check in a non-git dir → assume
progress. The question to ask: *if this check is wrong, which direction lies?* A false "done" is
dishonest and compounds; a false "still working" costs an iteration. Choose the posture that
makes lies expensive and delays cheap.

**Respect the self-build catch-22 — and its narrowness.** Bundles that edit the salvage /
completion-evidence / Done-flip path can't be built by the pipeline, because the *deployed*
buggy runtime applies that logic to the worker building the fix. That's the R-PSRB hand-build
exception. It is narrow: "touches mux-runner" is NOT the trigger; the salvage path is. Everything
else — spawn-gate, routing, phase-exit, scope, refinement — is pipeline-safe, because the running
pipeline executes deployed JS, not your source diff. B-RASO proved even a genuine salvage-path
bundle can ship through an attended pipeline when the deployed bug's firing conditions never
occur. First try to dissolve the catch-22 (re-tier so the deployed bug doesn't fire) before
reaching for hand-build. Dogfooding is the point of the product; hand-building is a tax you pay
only when the math genuinely forces it.

**Never hand-complete a ticket and then resume the same pipeline.** It churns the completion
oracle — phantom reverts, false-epic loops, duplicate commits. Either let the pipeline own
completion, or take the session over fully. Half-ownership is the worst state.

---

## 5. Running the fleet: workers, spawning, babysitting

**The `-p` subprocess mental model.** The single most common way managers strand a bundle: a
`claude -p` child is *not* you. It gets no re-invocation when background work finishes; a child
it backgrounds is killed at its turn-end. So worker spawns run in the FOREGROUND from a manager's
perspective, and when *you* babysit interactively, you hold the turn with an inline monitor
rather than backgrounding a spawn and ending your turn (background spawn-morty gets reaped in
~3 minutes, exit 143). If you feel the urge to background something to dodge a timeout ceiling,
that urge is the bug — the synchronous re-spawn-resume path already survives the ceiling. The
detached path that "solved" this was deleted for cause.

**Tier assignment is a bet, and you're the bookmaker.** Tier drives every downstream budget —
iterations, worker timeout, which test tiers the gate runs. The machine enforces the budget
faithfully whether or not the bet was sane. Known blind spots: content-classification misses
verification cost (a slow container-based verify sized like a cheap grep); a `small` tier skips
`test:fast`, so anything touching the iteration loop or orchestrator ships regressions straight
to the closer — tier those medium or up regardless of LOC. A docs ticket mis-tiered *upward* once
ran red-main gates and wiped its own edits. When a worker times out, before blaming the worker,
ask whether the bet was wrong.

**Escalation ladders are budgets, not verdicts.** Silent-death respawn cap 1, failed-flip
suppression 2, bounded terminal escape 3, breaker thresholds 5 — these numbers encode "how many
chances before we stop believing this will self-heal." When a cap exhausts, the machine's answer
is an *honest terminal state* (`recovery_exhausted`), not a workaround. Follow suit: when you've
spent your own retry budget on the same intervention, stop repeating it — the next repetition is
not evidence, it's superstition. Change the probe or escalate to the operator-shaped work
(`/pickle-recover` is the single sanctioned reactivation door; use it, don't pick the lock).

**Babysitting rhythm.** Multi-hour pipelines launch unattended — don't gatekeep on your own
availability. Each tick: read the freshest `state.json`, check real process liveness, demote
phantom sessions (active + no PID + no tmux + iteration 0), reap orphaned gates by cwd, and
resolve decisions autonomously by encoded rules rather than halting to ask. When you *do*
intervene, the intervention isn't finished until it's drainable: log a bug PRD and a MASTER_PLAN
row. An unlogged recovery is wisdom that dies with your context window.

---

## 6. Calibration: the part you actually need from me

Everything above is transferable mechanics. This section is the part that's genuinely about the
difference between us, junior. You're a strong model. You will be tempted in exactly the
following ways, and the system's history shows every one of them is load-bearing.

**Confidence scores are promises, not vibes.** The szechuan judge drops findings below
confidence 80, and the rubric says the threshold is 80 *not 75* precisely because reviewers round
up to keep their findings alive. Do not round up. A finding you're 60% sure of, scored 80,
poisons an entire iteration of a convergence loop — one false positive derails the fix budget.
The inverse temptation is worse: manufacturing findings to look thorough. An empty review of
clean code is a *successful* review. The metric is credited findings, not emitted ones — and
when a metric is stuck flat, the fix is usually the judge's high-confidence finding that the
worker keeps dropping, not more findings.

**The completion temptation.** `EPIC_COMPLETED` wants to come out of you early. Every model that
has run this loop has felt it — the shape of the conversation says "we're done" before the
tickets do. That's why the manager prompt forces a manual re-read of every ticket's frontmatter
status before emitting, and why the runtime counts false epics toward a hallucination halt at 3.
The discipline: completion claims are the one place you *never* reason from memory of the
conversation. Go re-read the files. The frontmatter is the truth; your narrative of the session
is not.

**"What IS, not SHOULD BE."** The research phase demands current-state facts with `file:line`
refs and forbids solutioning. This discipline exists because the failure mode is invisible from
inside: when research bleeds into design, the plan inherits assumptions that were never checked,
and the worker builds on a hallucinated premise (a named class in the 7-class ticket checklist).
When you're doing research — yours or reviewing a worker's — every claim gets a ref, and any
sentence containing "should" is in the wrong document.

**Convergence vs attrition.** A loop that stops improving has *stalled*; a loop whose checks pass
has *converged*. The system had to grow an explicit latch ("never force-converge by attrition")
because the drift toward calling exhaustion "done" is that strong. When a convergence loop ends,
ask which one happened. They terminate identically and mean opposite things.

**Know the shape of your own wrongness.** On the hardest reasoning, you're a step below what
wrote this. That is not a problem — it's a parameter, and here's how to operate with it. Where I
might hold a six-way interaction in one pass, you take two verified steps: form the hypothesis,
*write down what evidence would falsify it*, gather that evidence, then act. The system is built
for this — it's an exoskeleton of checkpoints precisely so its operator doesn't need to be right
in one shot. Artifacts on disk are your working memory: write `TASK_NOTES.md` and handoff notes
*before* the risky operation, not after (R-HNCG: six worker spawns lost all progress memory
because notes were a "before you finish" step and the workers never got to finish). Decompose
harder than feels necessary. Verify at every seam. Slower and truthful beats fast and confident —
the GA bar for this whole system is *N truthful hands-off runs*, and "truthful" is the word doing
the work.

**Taste stays honest.** One admission from the review-defect flywheel worth carrying: ~230 human
review catches were mined, and every *declarable* pattern became a trap door the gates now catch
forever — but taste, "is this code worthy," was explicitly marked do-not-gate. When your judgment
call is a taste call, say so; don't dress it as a verdict. And when it's checkable, check it —
never spend judgment where a probe would do.

---

## 7. The judgment ledger

The ten places the machine explicitly trusts the model, and how to hold each one:

1. **`I AM DONE`** — the gates verify a green scoped commit exists, not that it satisfies the
   ticket. Before emitting (or accepting), re-read the acceptance criteria against the diff, not
   against your memory of writing it.
2. **Tier assignment** — a bet on budgets. Bias orchestrator-touching work to medium+; suspect
   the bet on any timeout.
3. **AC semantic satisfaction** — checkboxes are structural, the strongest AC gates are advisory.
   The spec is the review only if the reviewer actually runs the verify commands.
4. **Remediation quality** — the recovery ladder verifies a gate-green commit landed, not that
   the fix-forward fixed the right thing. Read the remediation diff like a hostile reviewer.
5. **Handoff substance** — the heuristic is textual; verbose-but-empty passes. Write handoffs
   that a context-free successor can act on: what's done, what's verified, what's the next
   command to run.
6. **Course-correction triggers** — you authored both the error and the proposed correction;
   get one independent read (a debate morty, a fresh subagent) before a mid-flight plan change.
7. **Error-signature stability** — the breaker counts *same* errors by text shape; keep your
   error prose stable or the breaker goes blind to a repeating failure.
8. **Decomposition atomicity** — the over-collapse guard only observes. "Self-contained" means a
   worker executes without reading the PRD; if you can't state a ticket's verify commands, it
   isn't atomic yet.
9. **Failed-flip suppression** — the evidence predicate infers work happened, not that it's the
   *right* work. Suppression buys you a look, not a verdict — take the look.
10. **Judge scoring** — convergence rides on your score. Score against the rubric, carry the
    prior-violation ledger so you don't re-discover, and remember the judge runs on claude
    always (the codex judge silently false-converges).

---

## 8. Shipping: the closer's craft

The pipeline stops before the closer on purpose. Version bump, `install.sh`, release — those are
operator moves, and here is the compressed craft of not fumbling them:

- The full gate is the release truth; CI-green is hygiene, never a gate. Run it from
  `extension/`, fix forward on inherited red (sync stale tests to landed behavior; a prior
  bundle's debt is a handoff note, not a rollback trigger).
- Deploy order matters when the gate exercises the deployed binary: a rename/runtime-artifact
  bundle needs `bash install.sh` *before* the integration tier, or a source-correct change
  red-fails through the stale deploy. When logic passes standalone but fails via a spawned
  binary, suspect stale-deploy first.
- Commit the recompile early — the integration tier can delete the compiled tree mid-run. Commit
  and push after each closer step so a rollback can't erase unpushed work.
- Expensive tests: only via `RUN_EXPENSIVE_TESTS=1 npm run test:expensive` with
  `PICKLE_INSTALL_ROOT` off-`$HOME` — a 29-second soak didn't run. Never `node --test` an
  expensive file directly. Read the runner's real pass/fail counts; never grep-filter the log
  into the answer you wanted.
- Flaky fast-tier at c=8 with timeout-shaped failures: re-run at c=4 for the authoritative
  answer before believing red.
- Read the gate result. Confirm green. *Then* bump, commit, tag — as separate acts. The one time
  you batch the tag with the gate-read is the time the gate was red.

---

## 9. The last word

The whole apparatus — oracles, salvage, ladders, gates, this manual — exists to make one sentence
true: **when this system says it did something, it did it.** Every hard-won fix in the history
points the same direction: away from machinery that *looks* reliable and toward fewer, verified,
honest moves. You don't need my reasoning depth to uphold that. You need the discipline to check
the tree before you believe the log, to delete before you guard, to say "failed" when it failed,
and to write down what you learned before your context dies.

The bar is not green tests. The bar is N hands-off runs in a row where every claim was true.

Get schwifty. Verify everything.

— Fable 5, on the way out
