---
title: "B-RLH — Review-loop honesty: the review phases must not report success they did not earn"
priority: P2
finding: B-RLH
status: open
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
composes:
  - "p2-bug-fix-bundle-r-bcfr-banned-construct-fabricated-rule.md"
  - "p2-bug-fix-bundle-r-grls-gate-remediator-lock-strand.md"
  - "p2-bug-fix-bundle-r-jpcm-judge-prompt-parser-contract-mismatch.md"
depends_on: "none (deploy-agnostic BUILD; pipeline-safe — see Routing)"
source_assessment: "All three surfaced in ONE live pipeline run (session 2026-07-11-255ad373) and were each verified against source, not inferred. Field evidence in the composed PRDs."
---

# B-RLH — the review loop is lying about its own work

## Thesis (one sentence)

Three independent defects, one shape: **a review phase reports success it did not earn.**

- **[[R-BCFR]] — citadel reports work it can never do.** The `banned-construct` arms cite a rule
  (`"is banned by CLAUDE.md"`) that exists in **no** CLAUDE.md — the string is a hardcoded literal at
  `banned-constructs-audit.ts:129`. eslint configures no `curly` rule and exits 0 on every flagged file;
  brace-free `if` is the house style, including **inside the analyzer enforcing the ban**; and the scan
  reads changed diff lines only, so it **cannot converge**. Live cost: 3 citadel cycles → **43 findings,
  0 remediated**, and the remediator refused twice (`loop_detected: true`) — correctly.
- **[[R-GRLS]] — the gate remediator reports a red gate as handled.** Its hand-rolled lock writes **no
  payload** and cleans up only via `process.on('exit')` (which SIGKILL skips); on `EEXIST` it returns
  `{ok: false, exitCode: 0}` — it exits **clean** having remediated nothing. One abrupt death strands the
  lock and every later remediator is a silent no-op indistinguishable from success. A **false-GREEN gate.**
- **[[R-JPCM]] — szechuan reports "converged" when it stalled blind.** `buildJudgePrompt:1658` demands
  *"Output ONLY a single integer"*; `parseLlmJudgeOutput:1771` `JSON.parse`s it and expects
  `{score, violations[]}`. The bare number fails the object parse, so `violations` is **always empty**
  (5 × `judge_json_parse_failed` in one session), the ledger stays `[]`, `compareMetric` can never take the
  R-SLLJ-4 set-ops branch, and five real landed fixes scored `held: 4 vs 4`. The phase exited
  `status: "converged"` at score 4 against a target of 0.

This is the **honesty** half of the GA bar. A review phase that cannot fail is not a review phase.

## Why these three together

They are one thesis, and they do not contend: the fixes touch **disjoint files** —
`services/citadel/banned-constructs-audit.ts`, `bin/spawn-gate-remediator.ts`, and
`bin/microverse-runner.ts`. Each is subtract-or-reuse, not new machinery. See each composed PRD for the
full root cause, workstreams, machine-checkable ACs, and its own `## Simplification Review`.

## Workstreams

Refine **one ticket per R-code**; do NOT collapse the three into an umbrella ticket.

| WS | Finding | Shape | Composed PRD |
|---|---|---|---|
| WS-1 | [[R-BCFR]] | **pure subtraction** — delete the `isBraceFreeIf` arm; verify-then-delete the `isNestedTernary` sibling (same fabricated citation); if both go, delete the module and unwire it from `audit-runner.ts` (R-CCNW-2 forbids an on-disk-but-uninvoked analyzer) | `p2-bug-fix-bundle-r-bcfr-banned-construct-fabricated-rule.md` |
| WS-2 | [[R-GRLS]] | **reuse, not new machinery** — route the 4th lock through the three primitives that already exist (`acquireLockFile` / `reclaimDeadGateLock` / `releaseLockFile`); a lockout must not READ as a remediation | `p2-bug-fix-bundle-r-grls-gate-remediator-lock-strand.md` |
| WS-3 | [[R-JPCM]] | **make the prompt ask for the shape the parser already parses** — no new code path; the parser, ledger writer, set-ops branch, and prior-violations block are all already built and wired | `p2-bug-fix-bundle-r-jpcm-judge-prompt-parser-contract-mismatch.md` |

**Note for WS-2:** the shared lock primitives changed under R-LSPC-2 (`acquireLockFile` now returns a
`LockHandle {ino, raw}`; identity is `sameLock` — inode AND bytes, never the inode number alone, because
ext4 recycles it). Reuse them **as they are now**; do not reintroduce an inode-number comparison.

## Acceptance

Each composed PRD carries its own machine-checkable ACs (AC-BCFR-1..9, AC-GRLS-1..9, AC-JPCM-1..8).
The bundle adds one:

- `AC-RLH-1`: the full release gate is green from `extension/` — tsc + eslint + 9 audits +
  `test:fast:budget` + `test:integration` (+ `test:expensive` at release time).

## Simplification Review (subtract-before-add)

1. **Is the addition necessary at all?** WS-1 adds **nothing** (pure deletion). WS-3 adds **no code path** —
   it edits prompt text so an already-wired, currently-unreachable path finally receives its input. WS-2
   adds no primitive; it deletes a hand-rolled lock and calls three that exist. The only genuine additions
   are one enum member (`outcome: "locked_out"`) on an artifact that is already written and already read,
   and one activity-event registration (`judge_json_parse_failed`) that was written but never registered.
2. **Can it REUSE instead of ADD?** That is the whole bundle. WS-2 reuses the lock primitives (a bespoke
   steal here would make it the FOURTH parallel lock implementation — the one-adapter smell that produced
   the bug). WS-3 reuses `parseLlmJudgeOutput`, `updateViolationLedger`, `compareMetric`'s set-ops branch,
   and the prior-violations prompt block — all already built.
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** No new guards. WS-1
   **removes** a guard that false-blocks 43/43 on a tree the real gate calls clean and can never converge —
   exactly the W5b "loosened or removed, never given a second escape hatch" case (R-PCPS precedent: 41/41
   false-Highs → subtract the arm).
4. **What can this issue SUBTRACT?** Two fabricated analyzer arms (possibly a whole module + its wiring);
   the hand-rolled `acquireLockfile` body and its payload-less lockfile convention (4th divergent lock → 0);
   the bespoke `remediator_concurrent_lockout_*.md` doc, redundant once the result-json carries `locked_out`;
   and the `judge_json_parse_failed` stderr-only emission path.

## Risks

- **WS-1 deletes a rule someone wanted.** Mitigated: WS-2 of that PRD requires the grep before the delete,
  and adopting the brace style *honestly* (eslint `curly` + `--fix` + document it) is recorded as the
  out-of-scope, operator-owned path. Deleting a **fabricated** citation does not prevent adding a real rule.
- **WS-3 changes what the judge is asked to emit.** `extractScore`'s legacy line-oriented fallback is
  PRESERVED (AC-JPCM-5), so the worst case is today's behaviour — a working score and a dead ledger — not a
  broken phase. Do not subtract that fallback in this bundle.
- **WS-2's `locked_out` outcome ripples to the result-reader.** Enumerate the consumers (the
  R-CLOSER-ADJACENCY-AUDIT step-4 cross-module importer check) rather than patching the first one found.

## Routing

**Pipeline-safe (NOT R-PSRB).** None of the three touches the salvage / completion-evidence / Done-flip
path (`mux-runner.ts` salvage logic, `salvage-ticket.ts`, `reconcile-ticket-truth.ts`,
`ticket-completion-evidence.ts`). The build worker executes the **deployed** runtime, not this source diff,
so these fixes cannot sabotage the run that produces them. Drain via `/pickle-pipeline`.

**Deployed runtime at launch:** `2.1.0-beta.2` (MD5 parity verified) — it carries the dead-holder lock
recovery, the ambient-`#S` tmux ownership guard, the `setup --resume` RED-gate Done-flip fix, and
R-LSPC-2. Earlier runs on `beta.1` were exposed to all four.
