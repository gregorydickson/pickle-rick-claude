# F4/F5 Disposition — B-OFFREPO ticket 30 (AC-OFFREPO-3a)

Two sites the PRD's site table names as "honest in shape but undecided in consequence" —
neither routed through ticket 20's off-repo worker-gate resolver, both documented here as a
**deliberate disposition, with reason**.

## F4 — `runBetweenTicketFastGate` (`extension/src/bin/mux-runner.ts:670`)

Verified current signature at HEAD:

```ts
export function runBetweenTicketFastGate(input: RunBetweenTicketFastGateInput): BetweenTicketGateResult | null {
  const extensionDir = path.join(input.workingDir, 'extension');
  if (!fs.existsSync(extensionDir)) return null;
  ...
```

**Disposition: deliberate, not routed.**

This function and `runBetweenTicketFastTests` (`mux-runner.ts:632-666`) that it delegates to
always target `path.join(workingDir, 'extension')` — i.e. they run **pickle-rick's own**
`npm run test:fast`, scoped to pickle-rick's own subdirectory, as a between-ticket sanity check
for **self-build** bundles (pickle-rick modifying itself). This is a different gate from the one
ticket 20 (`0454370b`) fixed — the per-ticket WORKER gate now runs the **target repo's own**
lint/typecheck/test via `detectProjectType` (`spawn-morty.ts:runOffRepoWorkerGate`). Routing F4
through that resolver would mean re-arming a self-build safety net with an unrelated target
repo's test suite: not a like-for-like substitution, and a change to a Done-adjacent recovery
path this ticket's fence deliberately does not include (`mux-runner.ts` is in-fence for
disposition citations only — this ticket's "NOT in Scope" excludes rewriting the convergence
gate's own convergence logic, and F4/F5's self-build safety-net role is the same category of
logic, just living in `mux-runner.ts` instead of `convergence-gate.ts`).

Both call sites (`mux-runner.ts:7591`, `mux-runner.ts:10803`) already wrap the call in
`try { ... } catch { log(...) }` and never branch on the return value (including the existing
`null`) — off-repo, this between-ticket gate is a documented no-op today, not a regression this
ticket introduces or leaves newly undecided.

## F5 — `commitGatePassingDeliverableOnExitPath` (`extension/src/bin/mux-runner.ts:5387`)

The ticket's site table cites `mux-runner.ts:5238` for this site. Verified at HEAD, the guard
now lives at `mux-runner.ts:5387` (line numbers shifted after ticket 20, `88d8576b`/`d894b082`/
`bd5dc6b8`/`a24c3499`, added code earlier in the file). Both citations are recorded here so the
ticket's own AC-verify grep (`mux-runner.ts:5238`) and the current, correct location are both on
the record:

```ts
export function commitGatePassingDeliverableOnExitPath(
  input: CommitGatePassingDeliverableInput,
): CommitGatePassingDeliverableResult {
  ...
  const extensionDir = path.join(workingDir, 'extension');
  if (!fs.existsSync(extensionDir)) return { committed: false, reason: 'no-extension-dir' };
  ...
```

**Disposition: deliberate, not routed.**

This is the R-MWIS-3/R-WCUC "armed gate" (`mux-runner.ts:5280-5293`): on worker-exit / idle-stall
self-recovery, it commits an otherwise-stranded gate-passing deliverable, using
`runBetweenTicketFastTests` (pickle-rick's own `extension/` suite — the same self-build-only
mechanism as F4) as the arming signal before committing. Same reasoning as F4 applies: this is not
the worker gate ticket 20 fixed, and re-arming it with the target repo's own test suite would be a
substantive behavior change to a commit path adjacent to the Done-flip policy sites this session's
history repeatedly flags as high-risk to touch outside a ticket scoped specifically for them.

Unlike F4, this refusal was never silent — `CommitGatePassingDeliverableReason` is a typed,
ten-member union (`mux-runner.ts:5307-5316`) and `'no-extension-dir'` is one of its members,
returned to the caller. The ticket's own framing ("an honest refusal that strands work") already
concedes this much. Off-repo, there is no self-build safety net to arm, so refusing to commit is
the conservative default until a target-repo-scoped disposition is designed under a ticket whose
fence explicitly covers this Done/commit-adjacent path.

## Conditional AC — vacuously satisfied

Ticket 30's AC states: "If either F4 or F5 is routed rather than documented, its new behaviour is
pinned by a test." Neither F4 nor F5 is routed — both are documented, with reasoning, above. No
new test is required to pin behavior that was not changed.
