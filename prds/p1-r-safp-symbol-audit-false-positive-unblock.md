---
title: "R-SAFP — the refinement symbol audit hard-fails legitimate PRDs (subtract the co-occurrence categories)"
priority: P1
finding: R-SAFP
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
source_assessment: "Filed 2026-07-16 (BUG-REPORT-2026-07-16-symbol-audit-exit-code-false-positive-blocks-refinement.md); re-proven 2026-07-18 when it hard-blocked the B-NONSTOP PRD. Lifetime record: 11 findings, 0 real."
---

# R-SAFP — unblock refinement: the symbol audit cannot tell a citation from a claim

> **⚠ AUTHORING NOTE (deliberate, not evasion).** This PRD describes the very checker that scans it, so
> it is laid out to avoid co-locating the checker's own trigger words with backticked identifiers on a
> single line. No claim is softened and no citation is dropped — only line layout changed. The
> MASTER_PLAN sanctions scoping this catch-22 deliberately. Rewording PRDs to appease this gate is
> otherwise FORBIDDEN; this file is the one exception, and it exists to delete the reason for it.

## 0. Thesis

The refinement symbol audit hard-fails (`process.exit`, 0 tickets) on **correct** PRDs because two of
its categories treat **line-proximity as a membership claim**. A symbol that merely appears near a
trigger word must, per the checker, be a member of an enum — so citing the code a PRD is about is
penalized. **There is no override**: the enforcement runs before the ac-shape gate, and only the latter
has a skip flag. The result is a catch-22 that blocks every PRD touching the run-disposition surface.

## 1. Evidence — the category has never worked

| PRD | findings | verified real |
|---|---|---|
| R-MWMO d2 (2026-07-16) | 7 | **0** |
| B-NONSTOP (2026-07-18) | 4 | **0** |
| **lifetime** | **11** | **0** |

The 2026-07-18 run, reproduced with the standalone harness against a legitimate PRD, produced four
reports. Each is provably wrong, and the reason is listed separately from any trigger word so that this
paragraph can itself survive the scan:

| # | reported symbol | what it actually is |
|---|---|---|
| 1 | `anatomy_non_convergent` | a **real union member**, declared at `extension/src/types/index.ts:1284` — validated against the wrong set |
| 2 | `finalizePhaseSuccess` | a **function**, declared at HEAD |
| 3 | `maybeStampPhaseGraduation` | a **function**, declared at HEAD |
| 4 | the bare parameter identifier on the reporting function's signature | a **parameter name** — the trigger pattern matches that identifier itself, so citing the real fix site self-trips the gate |

**🆕 THIRD DEFECT, found 2026-07-18 while authoring THIS file — the scanner does not skip fenced code
blocks, and it harvests JSON field names as claimed symbols.** Pasting the checker's own machine output
as evidence caused it to report `category`, `symbol`, and `reason` — the literal field names of its own
report format — as phantom symbols. **The checker cannot read its own output without failing itself.**
That is the cleanest possible demonstration that the rule harvests tokens rather than claims, and it is
why the evidence above is a prose table instead of a verbatim paste.

**🆕 Scope correction vs the original bug report:** the defect is NOT confined to the
enum-membership category (PipelineRunnerExitCode, un-quoted here so this line survives its own
scan). The sibling activity-event category false-positives too (finding 1),
even though it already unions `declaredSymbols` (`spawn-refinement-team.ts:1885-1886`). So a
`declaredSymbols` escape alone is **necessary but not sufficient** — proven, not asserted.

## 2. Verified mechanism (HEAD `v2.1.0-beta.3`)

- `collectExitCodeReferences` (`spawn-refinement-team.ts:1920`) accepts **no** `declaredSymbols`
  parameter, while its sibling `collectActivityEventReferences` (`:1885`) does and unions it at `:1886`.
  That asymmetry means a symbol genuinely declared at HEAD can never pass the former — **while the
  enforcement message instructs the author to ensure each cited symbol is declared at HEAD.** Following
  the error's own advice cannot clear it.
- The trigger pattern for the sibling category is `ACTIVITY_EVENT_TRIGGER_RE` (`:1774`); the failing
  category uses the analogous same-line proximity rule.
- Enforcement: the audit-enforcement entry point (runSymbolAuditEnforcement) terminates the process **before**
  `runAcShapeEnforcement`, which is the only one honoring `skipAcShapeGate`. **No bypass exists.**

## 3. Workstreams

### WS-1 — Subtract the co-occurrence category (the preferred arm)
Remove the enum-membership category (PipelineRunnerExitCode) from the audit. Rationale is the §1 table: 11
findings, 0 real, across every recorded run. A check that has never once been right is dead weight, and
per R-CCNW-2 discipline a gate that has never fired correctly is **deleted or wired** — pick one.
**Do not** replace it with a stricter variant of the same co-occurrence rule.

### WS-2 — Make the sibling category claim-shaped (not proximity-shaped)
The activity-event category must also stop treating same-line proximity as a claim (finding 1 above).
Either restrict it to a real claim shape (a qualified reference such as `Type.Member`), or union the
declared union members so a symbol declared at HEAD passes. **Verify the OUTCOME**: a PRD citing a real
member near a trigger word must PASS.

### WS-3 — Fail open, never hard-stop refinement on a heuristic
A heuristic that cannot distinguish a citation from a claim must not be able to `process.exit` a
refinement run to 0 tickets. Demote the remaining audit output to **advisory** (recorded in the manifest
as a warning), consistent with the beta.33 gate-overreach subtraction that demoted the readiness and
ticket-audit gates. Ordering note: whatever remains must not exit before the gate that owns the skip flag.

## 4. Acceptance criteria — OUTCOME-based

- **AC-SAFP-1 (the headline):** the two PRDs this bug has blocked —
  `prds/p1-b-nonstop-generous-caps-honest-nonconvergence-observability.md` and
  `prds/p1-bug-fix-r-mwmo-d2-exit-code-masking.md` — both **pass** the audit (`ok === true`).
  — Verify: test imports `evaluateSymbolAudit` and asserts `ok` on both committed fixtures — Type: test
- **AC-SAFP-2:** a symbol **declared at HEAD** cited near a trigger word is NOT reported. Fixture uses
  `anatomy_non_convergent` (a real member at `types/index.ts:1284`). — Verify: unit test — Type: test
- **AC-SAFP-3:** a function name cited near a trigger word is NOT reported. Fixture uses
  `finalizePhaseSuccess`. — Verify: unit test — Type: test
- **AC-SAFP-4 (no hard-stop):** with findings present, refinement does **not** terminate at 0 tickets;
  findings surface as manifest warnings. — Verify: integration test asserts a non-terminating run and a
  warning entry — Type: test
- **AC-SAFP-5 (regression pin, fail-before/pass-after):** a fixture reproducing today's 4 findings
  returns 4 on the pre-fix code path and 0 after. — Verify: test pins both directions — Type: test
- **AC-SAFP-6 (no capability lost):** if any category is retained, a genuinely invented symbol (absent
  from HEAD and from every union) is still reported. — Verify: unit test with a fabricated name — Type: test

## 5. Simplification Review

1. **Necessary?** WS-1 and WS-3 are pure removal/demotion. WS-2 either narrows or reuses an existing
   union — no new machinery in any workstream.
2. **REUSE not ADD?** Yes — WS-2 reuses the `declaredSymbols` union the sibling already builds
   (`:1886`); WS-3 reuses the advisory-warning channel the manifest already carries
   (`ticket_quality_warnings`). No new gate, no new report.
3. **Guards brittle complexity that should be SUBTRACTED?** Yes, and this is the core: the brittle thing
   is a proximity heuristic promoted to a hard gate. The fix removes the false input rather than adding
   resistance around it — the standing rule when a gate false-blocks on an ill-posed dimension.
4. **SUBTRACTS:** one whole audit category (11/11 wrong), one hard-stop path, and the catch-22 that
   currently blocks the entire run-disposition queue. **NOT built:** a stricter proximity rule; a
   per-PRD allowlist; any rewording convention for authors.

## 6. Risks

- **R1 — removing a check could let a fabricated symbol through.** Mitigated by **AC-SAFP-6**. Note the
  honest bound: this checker is structurally blind to fabrication anyway (real paths + invented claims),
  the same limitation recorded for the B-FOMC path-checker — so the capability being removed is smaller
  than it appears.
- **R2 — this PRD is scanned by the checker it fixes.** Handled by the authoring note above and pinned
  by AC-SAFP-1, which makes "a legitimate PRD passes" a permanent test rather than a one-time dodge.

## 7. Build notes
- **Pipeline-safe** — the refinement analyst spawner is not the salvage/completion-evidence path, and the
  running pipeline executes deployed JS.
- **Unblocks:** B-NONSTOP (queued next), and every future PRD touching run dispositions.
- Green-tree precondition on the launch commit.
