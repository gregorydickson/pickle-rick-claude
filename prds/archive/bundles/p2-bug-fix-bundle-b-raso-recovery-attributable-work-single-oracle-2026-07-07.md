---
title: "B-RASO — recovery attributable-work single oracle (refined)"
r_code: B-RASO
priority: P2
kind: bug-fix-bundle
build_protocol: R-PSRB-HAND-BUILD
source: RECOVERY-SPRAWL-COLLAPSE-ANALYSIS-2026-07-07.md
composes: []
---

# B-RASO — Recovery Attributable-Work Single Oracle *(refined 2026-07-07)*

## Problem (verified against HEAD `46a75e4c`)

Two independent detectors answer *"is there salvageable work for this ticket?"* at **divergent
SHA-verification strictness** — the B-1SEAM completion-oracle collapse one level down.

| Detector | Callsite | Frontmatter-SHA arm | Strictness |
|---|---|---|---|
| `detectSilentDeathAttributableWork` | `mux-runner.ts:8090` → `hasFrontmatterCompletionSha:8040` | `completion_commit` / `completion_commit_inferred` | **regex format only** — never `git cat-file`-verified |
| `detectFailedFlipEvidence` | `mux-runner.ts:8326` → `hasVerifiedFrontmatterCompletionSha:8264` | same fields | regex **AND** `git cat-file -t <sha> === 'commit'` |

### The latent false-hold bug
`applySilentDeathRecoveryPolicy` (`mux-runner.ts:8119`) treats any detector hit as `action:'hold'`
— **NO respawn, no cap drawdown, ticket status untouched**. Because the silent-death SHA arm is
format-only, a worker that silent-died after stamping a **garbage / unreachable** `completion_commit`
(the R-AICF class) makes silent-death HOLD — suppressing the respawn that would recover the ticket —
while the Failed-flip path over the *same* stamp correctly **rejects** it. The ticket stalls: never
respawned, never Done, never Failed.

### What must NOT change (earned divergence)
The `detectFailedFlipEvidence` `signal_committed` arm (`resolveInterruptionIsSignal` +
`hasPresentCompletionCommitField:8298`) is **deliberately present-field-not-git-verified** (B-RRH C3:
a SIGTERM teardown can move HEAD out from under a real commit). The defect is ONLY the
SHA-verification-strictness divergence, not the signal arm. The silent-death backstop arms
(`hasScopedIterationWindowCommit:8052`, `hasFreshLifecycleArtifacts:8066`) stay.

## ⚠ Build protocol — R-PSRB HAND-BUILD (attended pipeline soak)

Both consumers sit on the silent-death / Failed-flip → respawn-suppression boundary — the deployed
runtime applies this exact logic to the worker building the fix. Operator decision (2026-07-07): run
**attended** through `/pickle-pipeline` as a soak rep, hand-finishing if the false-hold fires mid-build.

**Detection signal for the hand-finish fallback:** a build ticket sitting `In Progress` with a
format-valid `completion_commit` whose SHA fails `git cat-file` in the session `working_dir`, and
`recovery_attempts` not advancing across N ticks.

## WS-1 (P2, correctness) — collapse both detectors onto one verified-SHA oracle

Introduce ONE **unexported** helper both detectors consume for the frontmatter-SHA arm:

```
resolveAttributableFrontmatterSha(sessionDir, ticketId, workingDir): string | null
```

- Body = the `hasVerifiedFrontmatterCompletionSha:8264` body returning the SHA string (not `true`):
  read the ticket file, iterate BOTH `completion_commit` and `completion_commit_inferred` **with
  `continue` semantics** (a bad first field does NOT suppress a good second field), apply R-CCQF
  normalization (`.trim().replace(/^['"]+|['"]+$/g, '')`), shape-check `/^[0-9a-f]{7,40}$/i`, then
  verify `silentDeathGit(['cat-file','-t',value], workingDir) === 'commit'`. Return the first verified
  SHA, else `null`. Keep **unexported** and `string | null` (neither consumer reads a wrapper — dodges
  the `bin/CLAUDE.md` Module Export Catalog coupling).
- **Delete** `hasFrontmatterCompletionSha` (silent-death); reroute `detectSilentDeathAttributableWork:8093`
  through the helper (still returns the literal `'completion_commit'` on non-null).
- **Delete** `hasVerifiedFrontmatterCompletionSha` (Failed-flip); reroute `hasTicketScopedCommitEvidence:8277`
  through the same helper. Other Failed-flip arms (window-scope, `signal_committed`) unchanged.

### WS-1 Acceptance Criteria (machine-checkable)
- **AC-1**: `grep -c "hasFrontmatterCompletionSha\|hasVerifiedFrontmatterCompletionSha" extension/src/bin/mux-runner.ts == 0` (both dead helpers removed) AND exactly ONE `silentDeathGit(['cat-file','-t',...])`-backed frontmatter-SHA helper exists.
- **AC-1c**: `resolveAttributableFrontmatterSha` is unexported, returns `string | null`, iterates BOTH fields returning the first `cat-file`-verified commit (bad first field + good second field STILL resolves — `continue` semantics).
- **AC-1d**: the helper retains R-CCQF normalization — a **quoted full SHA** and an **unquoted short SHA** verify identically.
- **AC-2**: Reconcile `silent-death-recovery.test.js:191` **in place** — its non-repo tmp `working_dir` with format-valid-but-unresolvable `completion_commit: abc1234def`, no window commit, aged artifacts → `detectSilentDeathAttributableWork` returns `null` (was `'completion_commit'`); `git cat-file` in a non-repo cwd fails, then `archive()` **fails open** (non-repo, not `ArchiveAbortError`), so `applySilentDeathRecoveryPolicy` returns `action:'respawn'`, `attempt===1`, `cap===1`, `recovery_attempts.length===1` (was `0`), `recovery_attempts[0].strategy===SILENT_DEATH_RESPAWN_STRATEGY`, `recovery_attempts[0].outcome==='success'`. **Do NOT introduce a real dirty git repo fixture** — a dirty tree throws `ArchiveAbortError` → `hold(archive_failed)` and the respawn assertion fails for an unrelated reason. Fixture MUST be a non-repo dir or a clean repo. The sibling graceful-exit test (`:170`) stays green.
- **AC-2b** (SHA-arm survival — falsifier for the workingDir-resolution risk): a **git-resolvable** `completion_commit`, no window commit (`preIterSha` unset/HEAD-equal), aged artifacts → `detectSilentDeathAttributableWork` STILL returns `'completion_commit'` and the policy holds (`recovery_attempts.length===0`). Proves the SHA arm survives as a sole evidence carrier when git resolves.
- **AC-3** (SHA-**arm** parity, NOT full-detector): the SAME unresolvable SHA yields `null` from the frontmatter-SHA arm of BOTH `detectSilentDeathAttributableWork` and `detectFailedFlipEvidence`. Parity is scoped to the SHA arm only — `detectFailedFlipEvidence`'s `signal_committed` present-field arm legitimately still diverges.
- **AC-4**: a git-resolvable `completion_commit` still holds (silent-death) / suppresses (Failed-flip) exactly as before — no behavior change on the genuine-work path.
- **AC-5**: the `signal_committed` Failed-flip arm still fires for a signal teardown over a present-but-HEAD-moved completion field (existing `evaluateFailedFlipSuppression` tests stay green).
- **AC-6**: the collapse is pinned by a new `extension/tests/one-attributable-sha-oracle.test.js` (in the `one-readevidence-oracle.test.js` family) asserting AC-1's grep-to-zero + single-verified-helper invariant. **Choose the active-gate arm**: ALSO add a bespoke node block to `scripts/audit-trap-door-enforcement.sh` keyed on a new `extension/CLAUDE.md` trap-door entry (marker e.g. `B-RASO single verified-SHA oracle`) verifying its four labels present+populated. (The audit has NO generic PATTERN_SHAPE grepper — a CLAUDE.md entry alone is un-audited.) Co-scope `scripts/audit-trap-door-enforcement.sh` in the allowlist for this arm.
- **AC-9** (git-timeout symmetry, doc + covered by AC-2b): post-collapse both detectors route the same helper, so a transient `git cat-file` timeout on a genuine resolvable SHA returns `null` on both paths. Documented as intended symmetric behavior with a known edge (see `## Risks`); the fresh-artifacts arm (`sessionDir`-based) is the independent backstop.

### WS-1 allowlist (co-scope the compiled mirror — silent deadlock otherwise)
`extension/src/bin/mux-runner.ts`, `extension/bin/mux-runner.js` (tsc mirror), `extension/CLAUDE.md`
(AC-6 trap door), `extension/tests/silent-death-recovery.test.js` (`:191` reconcile), new
`extension/tests/one-attributable-sha-oracle.test.js`, `extension/scripts/audit-trap-door-enforcement.sh`
(AC-6 active-gate arm).

## WS-2 (P3, DEFER by default — doc-only) — dead `salvageCleanTree` back-fill branch (B-CSHYG-a)

Verify-first came back **DEFER**. Evidence (re-confirmed first-hand by all three analysts at HEAD):
- Three production `salvageTicket(` callers — `routeExitPathSalvage` (`mux-runner.ts:5405`),
  `executeBoundedEscape` (`mux-runner.ts:6076`), `pickle-recover.ts:88` — wire **NO** `backfillDone`
  and pass null/absent `completionCommitSha`.
- `grep -rn backfillDone extension/src/ | grep -v test` → only `salvage-ticket.ts:94` (optional type),
  `:124` (default no-op), `:150/:153` (internal guard). Zero production callers wire it.
- `salvage-ticket.ts:2` declares `backfillDone` a deliberate inert-by-default forward-seam.
- Pinned by `salvage-backfilled-done.test.js` + `integration/pipeline-completion-handsoff-e2e.test.js`
  + the B-PCOMP `#0a1ce691` trap door (`extension/CLAUDE.md`).

### WS-2 Acceptance Criteria
- **AC-7**: the ticket records the `salvageTicket(`-caller grep result (caller files + each wiring `backfillDone`/`completionCommitSha`).
- **AC-8**: WS-2 **defaults to DEFER**. Deletion is rejected as B-GSUB over-subtraction of a pinned forward-seam and requires an explicit operator override enumerating the full blast radius (branch + `backfillDone` dep + orphaned `SalvageTicketInput.completionCommitSha` + `pickle-recover.ts` signature reconcile + BOTH pinning tests + B-PCOMP trap door + any keyed audit block + 2 compiled mirrors) before any `salvage-ticket.ts` source ships. Absent that override, NO `salvage-ticket.ts` source changes ship; the ticket delivers a durable DEFER-evidence doc only.

## Risks

| Risk | Likelihood | Mitigation / disposition |
|---|---|---|
| **workingDir-resolution inversion**: the frontmatter-SHA arm now returns `null` for ANY reason `git cat-file -t` can't resolve in the handed cwd (transient timeout, stale/wrong `state.working_dir`, detached/mid-rebase repo, git env breakage) — inverting a genuine SHA-only hold to respawn. `hasScopedIterationWindowCommit` runs git against the SAME cwd (correlated backstop); only `hasFreshLifecycleArtifacts` (sessionDir-based) is independent. | Low–Med | Intended tradeoff (rejects garbage SHAs); already shipped on the Failed-flip path (`:8270`). AC-2b proves the SHA arm survives when git resolves; fresh-artifacts arm is the independent backstop. |
| **deployment rollout of already-held sessions**: sessions parked in a garbage-SHA false-hold flip to `respawn` (cap drawdown) on their first post-`install.sh` tick. A MINORITY whose one respawn was already drawn earlier then masked by a later false-hold jump straight to `recovery_exhausted` (HALT). | Low | Intended surfacing of a previously-hidden stall. A post-deploy `recovery_exhausted` during the soak is NOT this bundle causing a regression. |
| **scope-fence deadlock (compiled mirror)**: a WS-1 allowlist omitting the tsc-regenerated `bin/mux-runner.js` fences out the mirror → ticket deadlocks with zero commits, silently. | Med | Decomposition-time: allowlist co-scopes every compiled mirror (done above). No runtime mitigation. |

## Simplification Review (subtract-before-add)

**WS-1:** (1) Necessary — adds ONE helper, **deletes TWO**; net −1 function, −1 strictness divergence.
(2) Reuse — the helper is the intersection of the two dead functions using the existing `silentDeathGit`
wrapper + R-CCQF normalizer; no new machinery (B-1SEAM pattern one level down). (3) No new guard — it
removes a divergence. (4) Subtracts — one detector function deleted, one strictness class collapsed;
the trap door is doc-discipline pinning the collapse, not a runtime gate.

**WS-2:** Pure removal if dead, nothing if live (DEFER). No addition either way. Confirmed DEFER —
removing a pinned forward-seam would be B-GSUB over-subtraction.

## Must-survive (do NOT collapse)
`evaluateCompletionEvidence` (B-1SEAM) · `salvageTicket`/`reconcileTicketTruth` · the `signal_committed`
present-field arm (B-RRH C3) · the silent-death scoped-window + fresh-artifacts arms · the
`state.recovery_attempts` ledger + caps · `evaluateFailedFlipSuppression` cap/escalate policy.

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | ac78e4a2 | Collapse silent-death + Failed-flip SHA detectors onto one verified oracle (WS-1) | High | HEAD clean | one verified-SHA helper; both dead helpers gone; `:191` reconciled; new ENFORCE test green | `src/bin/mux-runner.ts`, `bin/mux-runner.js`, `extension/CLAUDE.md`, `tests/silent-death-recovery.test.js`, `tests/one-attributable-sha-oracle.test.js`, `scripts/audit-trap-door-enforcement.sh` |
| 20 | fc4c29c9 | Record WS-2 DEFER evidence for the dead salvageCleanTree back-fill branch (B-CSHYG-a) | Low | WS-1 done | DEFER-evidence doc committed; no `salvage-ticket.ts` change | `prds/BUG-REPORT-2026-07-07-b-cshyg-a-defer-evidence.md` (or session doc) |
