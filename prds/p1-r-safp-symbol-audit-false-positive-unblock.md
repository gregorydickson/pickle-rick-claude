---
title: "R-SAFP — the refinement symbol audit hard-fails legitimate PRDs (subtract the co-occurrence categories) [REFINED]"
priority: P1
finding: R-SAFP
status: ready
type: bug-fix-bundle
schema_neutral: false
target_version: v2.1.0
branch: release/v2.1-beta
source_assessment: "Filed 2026-07-16; re-proven 2026-07-18 when it hard-blocked B-NONSTOP. Refined by the 3x3 analyst team (session 2026-07-18-c06fd902), which RETRACTED a three-analyst consensus — see §0.1."
---

# R-SAFP — unblock refinement: the audit cannot tell a citation from a claim *(refined)*

> **⚠ AUTHORING NOTE (deliberate, not evasion).** This file describes the checker that scans it, so it
> avoids co-locating the checker's trigger words with backticked identifiers on one line. No claim is
> softened; only line layout changed. Rewording PRDs to appease this gate is otherwise FORBIDDEN — this
> file is the one sanctioned exception, and it exists to delete the reason for it. **See R13 (§6): this
> accommodation must NOT be ratified into the test suite as a passing fixture.**

## 0. Thesis
The audit hard-fails refinement (0 tickets) on **correct** PRDs because two categories treat
**line-proximity as a membership claim**. There is no bypass — the enforcement's exit runs before the
only gate honoring a skip flag. Result: a catch-22 blocking every PRD touching the run-disposition surface.

### 0.1 ⚠ THREE-ANALYST RETRACTION — the prescription in the pre-refinement draft was WRONG
All three analysts (and the draft) claimed the warnings array is frozen at `buildRefinementManifest`
(`:2370`) and that the fix must thread a new parameter through it. **Refuted by an in-repo precedent
~9 lines below the cited seam:** the over-collapse guard at `:2379` already does
`manifest.ticket_quality_warnings = [...(manifest.ticket_quality_warnings ?? []), overCollapseWarning]`
— i.e. a post-build in-place mutation on the returned object — and `writeManifestAtomic` runs at `:2398`.
**No circular dependency exists. No parameter threading. No second warnings array. No double write.**
⇒ WS-3 is a statement move plus an append, not a `main()` restructure.

**Second retraction:** `runSymbolAuditEnforcement` (`:2123-2133`) **does not terminate the process** — it
returns a status code. The single termination is at the callsite `:2401`. Two analysts tiered WS-3 up on
that false premise. **Name `:2401` as the deletion target** so no worker hunts for an exit that isn't there.

## 1. Evidence — the enum-membership category has never worked
| PRD | findings | verified real | reproducible from git today? |
|---|---|---|---|
| R-MWMO d2 (2026-07-16) | 7 | **0** | ❌ **NO — see below** |
| B-NONSTOP (2026-07-18) | 4 | **0** | ✅ yes (committed, re-runs to 4) |
| **lifetime** | **11** | **0** | |

**⚠ HONESTY CORRECTION (executed 2026-07-18, supersedes both the draft AND the refinement's R13
recommendation):** the 2026-07-16 evidence is **not reproducible from git at all.** Every revision of
that PRD — `e7ac8929`, `c2e7846e`, `dcd32b59`, `885a75fb`, `83c26353`, `3f363e5d` — now returns **0
findings / ok=true** under the current checker. The risk analyst proposed pinning `885a75fb^` as "the
revision that actually produced 7 findings"; **it does not** (0 findings, executed). So the historical 7
rest on the contemporaneous bug report, not on a re-runnable artifact, and **no revision of that file may
be used as a fixture in either direction.** This resolves R13 more cleanly than the proposed remedy: by
pinning nothing from that file, the suite cannot ratify the appeasement.

Today's four, each provably wrong (reasons listed away from trigger words so this table survives its own scan):

| # | reported symbol | what it actually is |
|---|---|---|
| 1 | `anatomy_non_convergent` | a **real union member** at `extension/src/types/index.ts:1284` — validated against the wrong set |
| 2 | `finalizePhaseSuccess` | a **function**, declared at HEAD |
| 3 | `maybeStampPhaseGraduation` | a **function**, declared at HEAD |
| 4 | the bare parameter identifier on the reporting function's signature | a **parameter name** — the trigger pattern matches that identifier itself |

**🆕 Defect 3 — the scanner does not skip fenced blocks and harvests JSON field names as claimed
symbols.** Pasting the checker's own machine output as evidence made it report `category`, `symbol` and
`reason` — its own report-format field names — as phantoms. Executed count on a fenced block: 6+4+1
findings across three categories. **The checker cannot read its own output without failing itself.**
Compounding: `renderSymbolAuditMarkdown` (`:2100-2105`) writes each finding as a line carrying the word
category **and** a backticked symbol, so any future PRD citing `symbol_audit.md` as evidence re-enters
the trap through a second door.

**🔑 The ill-posedness in one sentence (the warrant for subtraction, not rewrite):**
`declaredActivityEventSymbols` (`:1807-1816`) harvests — from trigger-word lines, with the same regex and
the same `/^[a-z][a-z0-9_]*$/` shape filter — exactly the tokens that `collectActivityEventReferences`
(`:1888-1894`) reports as phantom. The checker runs it on **composed** PRDs (`:1846`) to build its pass-set
and pointedly never runs it on the file under audit. ⇒ *A token is "declared" if it appears this way in
another PRD and "phantom" if it appears this way in this one.*

## 2. Verified mechanism (HEAD `f33c4952`)
```
buildRefinementManifest(:2370) → over-collapse guard MUTATES ticket_quality_warnings (:2379)
  → writeManifestAtomic(:2398) → writeSymbolAudit(:2399) → runSymbolAuditEnforcement(:2400)
  → if (status !== 0) terminate (:2401)   ← the ONLY termination; delete THIS line
  → runAcShapeEnforcement(:2402, owns skipAcShapeGate) → AC-phase(:2412) → readiness(:2414)
```
- `collectExitCodeReferences` (`:1920`) accepts **no** `declaredSymbols`; its sibling (`:1885`) does and
  unions it at `:1886`. A symbol declared at HEAD can never pass the former — **while the error message
  instructs the author to ensure each cited symbol is declared at HEAD.**
- `TicketQualityWarning` (`:294-304`) = `{ticket_id, defect_class, evidence, source?, file_line?}`,
  schema `additionalProperties: false`, `required: [ticket_id, defect_class, evidence]`,
  `ticket_id.minLength: 1`. **No runtime validator exists in `src/`** — it is a test-asserted contract.

## 3. Workstreams — WS-1 and WS-2 are JOINTLY REQUIRED (R14)
Today's 4 findings split **3 enum-membership / 1 activity-event**. WS-1 alone reaches 1; WS-2 alone
reaches 3; **only both reach 0.** ⇒ **The bundle MUST NOT be declared done on WS-1 alone**, and the
decomposition must not queue them as independently shippable.

### WS-1 — Subtract the enum-membership category (small)
Remove it. Rationale: §1's 11-findings/0-real record. Per R-CCNW-2 a gate that has never once been right
is deleted or wired — pick one. **Do not** replace it with a stricter variant of the same proximity rule.

### WS-2 — Make the activity-event category claim-shaped, not proximity-shaped (small)
Restrict to a real claim shape, or union the declared union members so a HEAD-declared symbol passes.
**REUSE `declaredActivityEventSymbols` (`:1807`)** — the checker already owns it (§1). ⚠ **Do NOT adopt
`hasSourceHit`/`sourceRoots` (R7):** `sourceRoots` falls back to `[workingDir]` when neither `src/` nor
`extension/src/` exists, so on a target repo laid out as `lib/`/`app/`/`pkg/` the scan swallows the PRD
directory and **an invented symbol grounds itself from the PRD that invented it** — a repo-agnosticism
violation invisible from this repo.

### WS-3 — Fail open; never terminate refinement on a heuristic (small)
Evaluate the audit **before** `writeManifestAtomic` (`:2398`), append findings in place exactly as the
over-collapse precedent does at `:2379`, emit the stderr line, and **delete `:2401`**. Per §0.1 this is a
statement move + append — not a control-flow restructure.
- **Warning shape (schema-fixed):** entries MUST be `{ticket_id, defect_class, evidence}`. The
  `{category, symbol, source_line, reason}` shape every analyst proposed is **unwritable**
  (`additionalProperties: false`). Fold category/symbol/line into `evidence`, matching the precedent's
  `evidence: "composed_sources=… tickets=…"` style.
- **`ticket_id` decision (required, `minLength: 1`; findings are PRD-scoped):** use the sentinel
  **`ticket_id: '<prd>'`**. Do NOT copy the precedent's `ticket_id: ''` — that violates the schema it is
  declared against (invisible only because no runtime validator exists). This is why the frontmatter is
  **`schema_neutral: false`**.
- **⚠ REGISTRATION CO-LOCATION:** if WS-3 emits an activity event, its name MUST be enrolled in
  `VALID_ACTIVITY_EVENTS` (`types/index.ts:586`) or `assertValidActivityEvent` (`state-manager.ts:1574`)
  throws. **The WS-3 ticket allowlist MUST include `extension/src/types/index.ts`** or the scope fence
  blocks the registration edit and the ticket deadlocks at zero commits. *(Noted irony: the audit's own
  advisory event must be enrolled in the same union whose citation started this bug.)*

### WS-4 — Fence-aware line scanning (small) — IN SCOPE per Defect 3
`lineRefs` (`:1780`) is a bare `content.split(/\r?\n/)` with **zero fence state** and is the shared entry
point for **all four collectors**. One fence-aware change removes the whole class. Chosen in-scope over
"advisory noise is tolerable" because R11 leaves us unable to assume downstream tolerance.

## 4. Acceptance criteria — OUTCOME-based
- **AC-SAFP-1 (headline):** B-NONSTOP's PRD passes the audit (`ok === true`) after the fix. ⚠ **Fixture
  governance (R13, resolved by execution):** B-NONSTOP is the **sole** fixture — commit its current
  (4-finding) revision under `extension/tests/fixtures/symbol-audit/`. **Do NOT pin any revision of the
  R-MWMO d2 PRD in either direction**: none reproduces its historical findings (all return 0 today, §1),
  so a "fails-before" pin is impossible and a "passes-after" pin would ratify an appeased document.
  — Type: test
- **AC-SAFP-2:** a HEAD-declared symbol cited near a trigger word is NOT reported (fixture:
  `anatomy_non_convergent`). — Type: test
- **AC-SAFP-3:** a function name cited near a trigger word is NOT reported (fixture:
  `finalizePhaseSuccess`). — Type: test
- **AC-SAFP-4 (no hard-stop, schema-legal):** with findings present, refinement does **not** terminate at
  0 tickets, and each finding appears in `ticket_quality_warnings` as a schema-legal
  `{ticket_id:'<prd>', defect_class, evidence}` entry validating against
  `refinement-manifest.schema.json`. — Type: test
- **AC-SAFP-5 (regression pin):** post-fix findings on the today-fixture = **0**. ⚠ The fail-before
  direction is **unrecoverable in-tree** (it would require retaining `collectExitCodeReferences`,
  `shouldAuditActivityEventToken` (`:1872`), and `NON_EVENT_ACTIVITY_CONTEXT_RE` (`:1775`) as dead code).
  Capture the pre-fix count out-of-tree against tag `v2.1.0-beta.3`, record it as ticket evidence, and
  assert only the post-fix `0` in CI. **Do not mandate dead code.** — Type: test
- **AC-SAFP-6 (no capability lost, repo-agnostic):** a genuinely invented symbol is still reported —
  executed against a fixture working dir containing **no** `src/` and no `extension/src/`, so the
  `sourceRoots` whole-repo fallback (R7) cannot self-ground it. — Type: test
- **AC-SAFP-7 (fences):** a fenced code block contributes **zero** findings. — Type: test
- **🔴 AC-SAFP-8 (R11 — the unblock is TESTED, not asserted):** after the fix, a refinement run on
  B-NONSTOP **reaches ticket decomposition**. If a downstream gate (`:2402` ac-shape, `:2412` AC-phase,
  `:2414` readiness) blocks it instead, that gate is **named in §7 as a known limitation** and the
  bundle does not claim the unblock. — Type: integration

## 5. Simplification Review
1. **Necessary?** WS-1/WS-3/WS-4 are pure removal or demotion. WS-2 narrows or reuses an existing
   harvester. No new machinery in any workstream.
2. **REUSE not ADD?** Yes — WS-2 reuses `declaredActivityEventSymbols` (`:1807`); WS-3 reuses the
   over-collapse append precedent (`:2379`) and the manifest's existing warning channel; WS-4 changes one
   shared entry point rather than four collectors.
3. **Guards brittle complexity that should be SUBTRACTED?** Yes — a proximity heuristic promoted to a hard
   gate. Remove the false input; do not add resistance around it.
4. **SUBTRACTS:** one whole category (11/11 wrong), one termination path, the fence-blindness class, and
   the catch-22 blocking the run-disposition queue. **NOT built:** a stricter proximity rule; a per-PRD
   allowlist; `hasSourceHit` adoption (R7); any author-facing rewording convention.

## 6. Risks
- **R11 (highest) — "unblocks B-NONSTOP" is a hypothesis about three never-executed gates.** `:2402`
  fires first today, so `:2404`/`:2412`/`:2414` have never been evaluated against a blocked PRD.
  `runReadinessGate` (`:365-384`) spawns `check-readiness.js` and returns its status directly — a
  non-zero verdict terminates exactly as the audit does now. **Mitigation: AC-SAFP-8 makes the unblock a
  tested outcome; §7 must record the observed next gate.**
- **R13 (governance) — do not ratify the appeasement.** Handled in AC-SAFP-1 by pinning the
  pre-rewording revision.
- **R14 — partial ship.** Handled in §3: WS-1 and WS-2 are jointly required.
- **R7 — repo-agnosticism.** Handled in WS-2 (no `hasSourceHit`) and AC-SAFP-6 (no-`src/` fixture).
- **R1 — removing a check could let a fabricated symbol through.** Bounded by AC-SAFP-6; note the honest
  limit: this checker is structurally blind to fabrication anyway (real paths + invented claims), so the
  capability removed is smaller than it appears.

## 7. Observed downstream gate (filled in by AC-SAFP-8 at build time)
> **TO BE RECORDED:** which gate, if any, blocks B-NONSTOP once the audit passes. Do not ship this
> section empty and do not assert the unblock without it.

## 8. Build notes
- **Pipeline-safe** — the refinement spawner is not the salvage/completion-evidence path.
- Tiering: WS-1/WS-2/WS-3/WS-4 all **small** (§0.1 removes the stated reason WS-3 could not be small).
- Green-tree precondition on the launch commit.
