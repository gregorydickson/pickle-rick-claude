# B-ONEABORT — the four termination sites this bundle does not fix

The parent PRD's original framing claimed "two channels." Refinement found **five** sites in
`extension/src/bin/pipeline-runner.ts` that can terminate a microverse phase. Tickets `1a2e4f92`
(collapse the classifier abort to the crash floor) and `9e6608a8` (name the reason at every
`logPhaseHaltReason` termination site) fixed **one** of the five: the classifier
(`classifyMicroverseHaltDecision`) and its unattributed-abort fallback. The other **four** are named
here, out of scope, on the record — undercounting is the defect this bundle was authored from, and
silence about the remainder would repeat it.

Line numbers below cite both the PRD's original research-seed number and the current line at HEAD —
the file has grown since refinement (tickets 10/20/30 landed code above these sites), so the two
numbers differ; both are recorded rather than silently updating one and losing the paper trail.

## Site 1 — HEAD-mismatch abort
- Seed: `:4025` — Current: `extension/src/bin/pipeline-runner.ts:4050`
  (`if (exitCode !== 0 && emitHeadMismatchStderr(runtime.statePath)) { ... return 'abort'; }`)
- Fires **above** the phase-type/classifier gate inside `logPhaseHaltReason`, so it is reachable for
  every phase regardless of `MICROVERSE_EXIT_REASONS` membership.
- **Why out of scope**: this bundle's acceptance criteria (`AC-OA-1`, `AC-OA-2`) are scoped to the
  classifier and the unattributed-abort message, not to an externally-modified working tree.
  `working_tree_modified_externally` is a distinct hazard class — the working tree changed under the
  pipeline's feet, which is not a microverse-measurement outcome at all.

## Site 2 — Red finalize gate (both destinations)
- Seed: `:4092` / `:4127` — Current: `extension/src/bin/pipeline-runner.ts:4161`
  (`runJudgeTimeoutFinalizeGate`, gate `exitCode !== 0` → `{action:'break'}`) and `:4198`
  (`runAllBackendsExhaustedFinalizeGate`, same).
- Already pinned by `extension/tests/oneabort-termination-invariant.test.js`: "a failing gate still
  breaks and touches no counter".
- **Why out of scope**: a genuinely RED finalize gate is a real quality failure, not a
  classification bug. Papering over it would invert this bundle's thesis — the pipeline is supposed
  to stop on an actual failing gate; the defect this bundle fixes is stopping on a
  *successfully-classified, non-fatal* microverse exit reason.

## Site 3 — AC-phase gate
- Seed: `:4303` — Current: `extension/src/bin/pipeline-runner.ts:4336`
  (`log(\`Phase ${rawPhase} AC gate failed — stopping pipeline\`); return { action: 'break' };`
  inside `runPhaseIteration`).
- **Verified zero test coverage repo-wide**: `grep -rl "AC gate failed" extension/tests/` returns no
  matches. Currently fail-open in practice only because no in-repo code path writes
  `ac-phase-manifest.json` — `runAcPhaseGate` short-circuits to `pass` on a missing manifest.
- **Why out of scope**: this is a different defect shape than the two this bundle fixes (a reachable
  classifier defaulting to abort, and a reachable-but-unattributed halt message). This site is
  untested *and* currently unreachable-in-practice; fixing it would require first building the
  missing test fixture and the manifest-writer, which is new scope this ticket's "Files to
  modify/create" list does not cover.
- **Follow-up finding**: this site should get dedicated test coverage in a future ticket before
  anything starts writing `ac-phase-manifest.json` in production — today's fail-open behavior is an
  accident of no writer existing, not a verified-safe default.

## Site 4 — Cancel marker
- Seed: `:4436` — Current: `extension/src/bin/pipeline-runner.ts:4458` and `:4467`
  (`if (fs.existsSync(cancelMarker)) { log('Pipeline cancelled (cancel marker found) — stopping');
  return { action: 'break' }; }` inside `finalizePhaseSuccess`).
- **Why out of scope**: `CLAUDE.md`'s crash-floor list explicitly names "operator cancel" as a
  sanctioned halt reason. This site IS the operator-cancel implementation — breaking the pipeline
  here is the correct, intended behavior, not a defect.

## Inherited, not fixed
- Integration-tier red inherited from R-GADEL / B-GITATTR, bisected to `a7d6d9ec` — not this
  bundle's regression. See `## NOT in Scope` in the parent ticket.
