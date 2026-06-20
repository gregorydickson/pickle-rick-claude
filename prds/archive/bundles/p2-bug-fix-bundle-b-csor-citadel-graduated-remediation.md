---
title: "B-CSOR — Citadel graduated finding-handling: deterministic remediation of the mechanical sub-Critical subset"
priority: P2
finding: 118
status: open
schema_neutral: true
source_design_note: prds/archive/design-notes/DESIGN-NOTE-2026-06-16-citadel-surface-only-no-remediation.md
---

# B-CSOR — Citadel graduated finding-handling tier (mechanical sub-Critical remediation)

## 0. TL;DR for the reader who just cleared context

Citadel is the pipeline's post-implementation conformance audit (phase 2/4). It is **surface-only** — it writes `citadel_report.json` and must NEVER mutate source (`.claude/commands/citadel.md:25`). That contract is correct and stays.

The pipeline-runner ALREADY has a citadel detect→remediate loop (R-HRP-1, `executeCitadelPhase` at `pipeline-runner.ts:2252`). It is NOT surface-only at the pipeline layer — it converts findings to a `GateResult` and feeds the **existing** `spawn-gate-remediator` (the same mechanical fixer `finalize-gate` uses). **The design note's premise ("nothing remediates citadel findings") is partially stale.**

The REAL gap is a **severity threshold**: `remediationSeverityThreshold(strict)` (`pipeline-runner.ts:2142`) returns `Critical` in the default non-strict mode and `High` in strict mode. Every finding the remediator is fed must be `>= threshold`. So **Medium/Low findings — including the deterministically-fixable `banned-construct:brace-free-if` (severity `Medium`, `banned-constructs-audit.ts:124`) — are filtered out at `pipeline-runner.ts:2286` and never reach the remediator.** They fall through citadel → anatomy-park → szechuan untouched (szechuan targets coding-*principles*, not lint/banned-construct rules), relying on a human.

A SECOND, independent gap: even if a Medium banned-construct finding DID reach the gate-remediator, the remediator's hand-fix scope (`morty-gate-remediator.md:46-71`) is FOUR classes only — regex char-class, async-generator await, type-assertion removal, spec-mock alignment — plus prettier/eslint autofix. A CLAUDE.md brace-free-`if` is none of those and is not eslint-autofixable by the project's default config, so the remediator would **abort** on it today.

So B-CSOR is two coupled fixes: (1) lower the remediation floor for a curated **mechanical subset** of finding sections so they reach the remediator; (2) teach the gate-remediator a new bounded hand-fix class for the deterministic CLAUDE.md banned constructs. Everything else stays advisory (sub-threshold non-mechanical) or halting (Critical).

---

## 1. Problem (code-grounded)

### 1.1 The surface-only contract (correct, unchanged)

`.claude/commands/citadel.md:25`: *"The command surfaces findings only; it does not auto-edit source files."* Citadel the analyzer must never write source. This is a safety boundary and B-CSOR does NOT touch it. Citadel produces a read-only `citadel_report.json`; a SEPARATE actor (the gate-remediator) mutates source, keyed off that read-only report.

### 1.2 The actual remediation gate (the real gap)

`executeCitadelPhase` (`extension/src/bin/pipeline-runner.ts:2252-2298`) runs a bounded detect→remediate loop:

```
2272  const threshold = remediationSeverityThreshold(runtime.config.citadel_strict);
...
2278    const result = await citadelRemediationDeps.runCitadelAudit({...});
2286    remediable = result.findings.filter(f => findingMeetsThreshold(f, threshold));
2287    log(`citadel: cycle ... wrote ... ${result.findings.length} finding(s), ${remediable.length} remediable (>= ${threshold})`);
2288    if (remediable.length === 0) { ... return { exitCode: 0 }; }   // "no remediable findings — phase complete"
2292    await remediateCitadelFindings(runtime, remediable, remediatorTimeoutMs, cycle);
```

- `remediationSeverityThreshold(strict)` (`:2142`) → `strict ? 'High' : 'Critical'`. Default pipeline runs are **non-strict** → threshold `Critical`.
- `findingMeetsThreshold` (`:2326`) uses `SEVERITY_RANK` (`Critical:0, High:1, Medium:2, Low:3`) with `<=`. So at threshold `Critical`, only `Critical` findings pass; at `High`, `Critical`+`High` pass. **`Medium` and `Low` are NEVER remediated** in either mode.
- The log line in the design note — `0 remediable (>= Critical)` then `no remediable findings — phase complete` — is exactly `:2287`/`:2289` firing with all 5 findings at `Medium`/`Low`.
- `remediateCitadelFindings` (`:2187`) writes a `GateResult` via `citadelFindingsToGateResult` (`citadel-findings-to-gate-result.ts:8`) and invokes `spawnGateRemediatorMain` → spawns a `morty-gate-remediator` worker. So the plumbing to remediate citadel findings already exists and is exercised for Critical.

### 1.3 The gate-remediator's scope is too narrow for the mechanical subset

`morty-gate-remediator.md` (the agent at `.claude/agents/morty-gate-remediator.md`) hand-fixes ONLY four classes (`:46-71`): (a) regex char-class `\xNN`→`\uNNNN`, (b) async-generator require-await, (c) `no-unnecessary-type-assertion` removal, (d) spec-file type-only mock alignment. Plus prettier/eslint `--fix` (`:21-30`). A CLAUDE.md-banned brace-free `if` is **outside all four** → the remediator's Abort Trigger fires (`:84` "A fix outside classes (a)-(d) is required"). So even lowering the floor alone wouldn't fix the brace-free-`if`; the remediator needs a new bounded class.

### 1.4 Net effect (the gap to close)

A finding that is BOTH (i) below the remediation threshold AND (ii) trivially/deterministically fixable falls through every phase. The canonical example from the LOA-1156 run: `banned-construct:brace-free-if` at `optimized-schema-integrity.spec.ts:45`, severity `Medium`. A one-token mechanical wrap-in-braces fix that no phase applies.

### 1.5 Inverse-symmetry note (scoped OUT of this PRD's implementation)

`#115 R-RGO RC-3` was the readiness gate's *over-aggressive* end: one finding = hard halt, no graduated tier (now shipped). Citadel is the *under-aggressive* end: no action below Critical. A unified "graduated finding-handling tier" abstraction shared by both is attractive but is explicitly a **future** consideration (Approach B below); this PRD recommends the citadel-only fix.

---

## 2. Design analysis (enumerated approaches)

### Approach A (RECOMMENDED) — Mechanical-subset floor lowering + a bounded new remediator hand-fix class

**What changes:**
1. Introduce a `MECHANICAL_FINDING_SECTIONS` allowlist + a `isMechanicalCitadelFinding(finding)` predicate (new module, e.g. `extension/src/services/citadel/mechanical-finding-classifier.ts`). It classifies a finding as mechanical iff its `id`/section + shape are deterministically fixable (see §3 for the exact set). Initially: `banned-constructs` brace-free-`if` only (the proven-deterministic case), gated to be extensible.
2. In `executeCitadelPhase`, after the existing `remediable = findings.filter(meetsThreshold)`, ALSO compute `mechanical = findings.filter(isMechanicalCitadelFinding)` and remediate the **union** (`remediable ∪ mechanical`), deduped. Critical/High behavior is unchanged; the only new findings reaching the remediator are mechanical sub-threshold ones.
3. Add a new bounded hand-fix class **(e) CLAUDE.md banned-construct wrap** to `morty-gate-remediator.md` and a matching brief-prep affordance, restricted to `banned-construct:brace-free-if` (wrap the statement in `{ }`) and `banned-construct:nested-ternary` (extract — DEFER this one; it is not purely mechanical, see §3). The remediator stays forbidden from semantic refactors; the wrap is a pure syntactic transform on the single cited line.
4. Gate the whole mechanical path behind the unified skip flag and a kill-switch; emit a recurrence-budget activity event.

**Blast radius:** `pipeline-runner.ts` (`executeCitadelPhase` + one new helper), one new classifier module, `morty-gate-remediator.md` (+ its compiled brief-prep section in `spawn-gate-remediator.ts` if the trap-door section is templated). No State schema change (the mechanical set is computed from the read-only report; no new persisted field). `schema_neutral: true`.

**Risk:** LOW. The mechanical set is opt-in-narrow (one finding class at ship). The remediator already has snapshot-and-revert (`morty-gate-remediator.md:32-42`) so a wrap that breaks a previously-green test is auto-reverted. The pipeline still **never halts** in this phase (the loop always returns exit 0; mechanical remediation is best-effort like the Critical path).

**Alignment with surface-only boundary:** PRESERVED. Citadel still only writes the report. The gate-remediator (a distinct worker process) mutates source, keyed off the read-only `citadel_gate_result_*.json` derived from the report. The trap door (§6) pins that citadel analyzers never write source.

### Approach B — Unified "graduated finding-handling tier" abstraction shared by readiness + citadel

**What changes:** Extract a single `classifyFindingDisposition(finding) → 'auto-remediate' | 'advisory' | 'halt'` service consumed by BOTH the readiness gate (#115 R-RGO) and citadel. Citadel maps mechanical→auto-remediate, semantic-sub-Critical→advisory, Critical→halt; readiness reuses the same tiering instead of its current floor.

**Blast radius:** LARGE — touches `check-readiness.ts`, `pipeline-runner.ts`, a new shared service, and the readiness cycle-history. Two gates with different existing contracts (readiness HALTS, citadel CONTINUES) must be reconciled under one abstraction.

**Risk:** MEDIUM-HIGH. Conflates two gates with different halt semantics; a bug in the shared tiering regresses BOTH. Violates W5b subtract-before-add discipline by adding a broad new abstraction before the narrow citadel fix has proven its mechanical set. The one-adapter-rule (`extension/CLAUDE.md` Architectural Vocabulary) says: don't build the shared seam until a SECOND real adapter justifies it. Today there is one proven adapter (citadel). **Premature.**

**Alignment:** Same surface-only preservation as A, but at much higher cost. Recommend deferring to a follow-up only after Approach A's mechanical classifier has run in production and the set is stable.

### Approach C — Status quo + better operator surfacing only

**What changes:** No remediation. Make sub-Critical findings louder: a `citadel_findings_surfaced` summary in `pipeline-status.json` / `/pickle-status`, and a non-zero "advisory count" the operator sees post-run.

**Blast radius:** SMALL (status rendering only). **Risk:** LOW. But it does NOT close the gap — the deterministic brace-free-`if` still requires a human. It is a strictly-weaker complement to A, not a substitute. (Worth shipping the surfacing piece AS PART OF A for the residual advisory findings — see AC-9 — but not on its own.)

### Decision

**Approach A.** It closes the actual gap (deterministic mechanical findings get fixed) at minimal blast radius, reuses the existing R-HRP-1 remediation plumbing rather than building new, honors W5b (narrow add, with subtract-pressure: the mechanical set is the smallest thing that works), and keeps the surface-only boundary intact. Approach C's surfacing is folded in for the residual advisory tail (AC-9). Approach B is documented as a deliberate future option, not this PRD's scope.

---

## 3. Recommendation detail — the mechanical / advisory / halt taxonomy

Severity facts are read from source, not guessed:

| Citadel finding (section : id-shape) | Source severity | Disposition under B-CSOR | Why |
|---|---|---|---|
| `banned-constructs : banned-construct:brace-free-if` | `Medium` (`banned-constructs-audit.ts:124`) | **MECHANICAL — auto-remediate** | Single-line syntactic wrap `if (c) s;` → `if (c) { s; }`. Zero judgment. Cited file:line is exact. |
| `banned-constructs : banned-construct:nested-ternary` | `Medium` (`:113`) | **ADVISORY (DEFER mechanical)** | "Extract into if/else or named vars" is a semantic restructure with >1 valid shape — NOT deterministic. Stays advisory until/unless a canonical-form transform is proven. |
| `trap_door_coverage : orphan-test-file` | `Medium` (`trap-door-coverage-audit.ts:114`) | **ADVISORY** | Adding an inbound `ENFORCE:` ref requires choosing WHICH trap door it guards — a human/semantic decision. Not deterministic. |
| `trap_door_coverage : orphan-enforce` / `orphan-test-case` | `High` (`:82`,`:95`) | **ADVISORY** (already `High`, but non-mechanical) | Already above the strict floor but still not a single-shape fix. |
| anything `Critical` | `Critical` | **HALT path unchanged** | The existing remediation loop feeds Critical to the remediator; phase still returns 0 (never hard-halts) per R-HRP-1. B-CSOR does NOT change Critical handling. |
| eslint/prettier-autofixable (if Citadel ever emits such a `lint`-shaped finding) | varies | **MECHANICAL — auto-remediate** | Already covered by the remediator's `--fix` step; the floor-lowering simply lets them through. |

**Mechanical set at ship = exactly `banned-construct:brace-free-if`.** The classifier module is written to be extended (a `MECHANICAL_FINDING_MATCHERS` array), but only the brace-free-`if` matcher ships, because it is the only finding both proven-deterministic AND outside the remediator's current four classes. `nested-ternary` and `orphan-*` are explicitly advisory.

---

## 4. Acceptance criteria (machine-checkable, numbered)

> Test files are forward-created. CLI/grep invariants run from `extension/`.

**AC-1 — Mechanical classifier exists and is narrow.**
`extension/src/services/citadel/mechanical-finding-classifier.ts` (forward-created) exports `isMechanicalCitadelFinding(finding: CitadelFinding): boolean` and a `MECHANICAL_FINDING_MATCHERS` array. A unit test asserts: `banned-construct:brace-free-if:*` → `true`; `banned-construct:nested-ternary:*`, `orphan-test-file:*`, `orphan-enforce:*`, any `Critical` → `false`.
Verify: `node --test extension/tests/citadel/mechanical-finding-classifier.test.js` (forward-created).

**AC-2 — Sub-threshold mechanical findings reach the remediator.**
In `executeCitadelPhase`, the set fed to `remediateCitadelFindings` is the deduped union of `findings.filter(f => findingMeetsThreshold(f, threshold))` and `findings.filter(isMechanicalCitadelFinding)`. A test injecting a single `Medium` `banned-construct:brace-free-if` finding (non-strict mode) asserts the remediator is invoked with that finding (currently it is NOT).
Verify: `extension/tests/pipeline-runner-citadel-mechanical-remediation.test.js` (forward-created) via the existing `__setCitadelRemediationDepsForTests` injection seam.
Grep invariant: `grep -c "isMechanicalCitadelFinding" extension/src/bin/pipeline-runner.ts` >= 1.

**AC-3 — The remediator only touches the mechanical subset; never edits source citadel.**
`grep -rn "writeFileSync\|fs.writeFile\|Edit(" extension/src/services/citadel/` finds NO source-mutation in any citadel analyzer (citadel stays surface-only). The brace-free-`if` wrap happens only inside the `morty-gate-remediator` worker, keyed off `citadel_gate_result_*.json`.
Verify: `extension/tests/citadel/citadel-never-writes-source.test.js` (forward-created) — asserts no citadel analyzer module imports an Edit/write primitive against repo source. Trap-door enforced (§6).

**AC-4 — Routes through the EXISTING gate-remediator (no new remediation path; no semantic edits).**
The mechanical remediation reuses `remediateCitadelFindings` → `spawnGateRemediatorMain` → `morty-gate-remediator`. No new spawn site is added. The new hand-fix class (e) in `morty-gate-remediator.md` is documented as "wrap the cited line's brace-free `if` statement in `{ }`; abort on any change touching more than the cited line".
Verify: `grep -c "spawnGateRemediatorMain\|spawnRemediator" extension/src/bin/pipeline-runner.ts` is unchanged from baseline (no new remediation entrypoint); `grep -c "brace-free" .claude/agents/morty-gate-remediator.md` >= 1.

**AC-5 — Unified skip flag bypasses the mechanical path.**
A non-empty `state.flags.skip_quality_gates_reason` causes `executeCitadelPhase` to skip mechanical remediation (union collapses to the legacy Critical-only set) AND emit a `gate_skipped` activity event with `source: 'citadel-mechanical'` and the reason. NO new per-gate `skip_*_reason` flag is introduced (W5b / audit-skip-flag-unification.sh stays green).
Verify: `extension/tests/pipeline-runner-citadel-mechanical-skip.test.js` (forward-created); `bash scripts/audit-skip-flag-unification.sh` exits 0.

**AC-6 — Recurrence budget entry exists.**
`SKIP_FLAG_BUDGETS` (`extension/src/services/metrics-utils.ts:97`) gains a `'citadel-mechanical::skip_quality_gates'` key (or the source/reason pair the AC-5 event emits) with a stated budget; `/pickle-metrics` W5c surfaces it when over budget. The budget value is documented in this PRD: **3** (a quality gate, not a kill-switch; tighter than `DEFAULT_SKIP_FLAG_BUDGET=5` because routine mechanical-skip is a smell).
Verify: `grep -c "citadel-mechanical" extension/src/services/metrics-utils.ts` >= 1; `extension/tests/metrics-skip-flag-budget.test.js` covers the new key.

**AC-7 — Idempotence.**
Running `executeCitadelPhase` a second time on a tree where the mechanical finding was already fixed produces zero mechanical findings (the brace-free `if` no longer matches `banned-constructs-audit.ts:isBraceFreeIf`) → no remediator spawn on the second pass. The bounded loop (`cap` cycles) converges and re-detection on a fixed line yields nothing.
Verify: `extension/tests/pipeline-runner-citadel-mechanical-idempotence.test.js` (forward-created) — two-cycle run, second cycle spawns no remediator.

**AC-8 — Pipeline still halts at Critical (regression guard).**
A `Critical` finding still routes to the remediator on the existing path; the phase still returns exit 0 (R-HRP-1: citadel never hard-halts, it remediates-then-continues). B-CSOR changes NOTHING about Critical handling. The existing R-HRP-1 / R-PHC-6 tests remain green.
Verify: existing `extension/tests/pipeline-runner-phase-fail-continue.test.js` + `pipeline-runner.test.js` pass unchanged; a new assertion confirms `Critical` is in BOTH `remediable` and the union (no double-spawn — dedupe AC).

**AC-9 — Residual advisory findings are surfaced (Approach C fold-in).**
Sub-Critical, NON-mechanical findings (e.g. `orphan-test-file`, `nested-ternary`) that the phase does NOT remediate are counted into a `pipeline-status.json` field (e.g. `citadel_advisory_findings: <n>`) and the existing `citadel_findings_unremediated` activity event (`types/index.ts:705`) is emitted with the advisory subset so `/pickle-status` can surface them. No new schema-version bump (additive optional field, like `phase_skips`).
Verify: `extension/tests/pipeline-runner-citadel-advisory-surfacing.test.js` (forward-created).

**AC-10 — Kill-switch.**
`PICKLE_CITADEL_MECHANICAL=off` (or fold into the existing `PICKLE_RECOVERY_CONSOLIDATION=off` family — operator decides, see §8) reverts `executeCitadelPhase` to the legacy Critical-only floor. Documented in the root `CLAUDE.md` Environment Variables table.
Verify: `extension/tests/pipeline-runner-citadel-mechanical-killswitch.test.js` (forward-created).

---

## 5. Scope / non-goals

**In scope:**
- Lowering the citadel remediation floor for a curated mechanical subset (ship: `banned-construct:brace-free-if` only).
- One new bounded hand-fix class in the gate-remediator for the brace-free-`if` wrap.
- Skip-flag bypass, recurrence budget, kill-switch, idempotence, advisory surfacing.

**Explicitly OUT of scope (non-goals):**
- **Changing citadel's surface-only contract.** Citadel analyzers must never write source. (Trap-door enforced.)
- **Semantic auto-fix.** `nested-ternary` extraction, `orphan-test-file` ENFORCE-ref authoring, sibling-route reconciliation, endpoint-contract drift — all stay ADVISORY. The remediator stays forbidden from semantic refactors.
- **The readiness-gate side / unified graduated tier (Approach B).** Noted as a possible future unification once the citadel mechanical set is production-proven; NOT built here. (#115 R-RGO is already shipped on its own terms.)
- **Adding new analyzers or new severities.** B-CSOR consumes the existing finding model unchanged.
- **State schema changes.** `schema_neutral: true` — the mechanical set is derived from the read-only report; the only persisted additions are an optional `pipeline-status.json` advisory count (additive, no version bump) and a `SKIP_FLAG_BUDGETS` map key.

---

## 6. Trap doors / enforcement

**TD-1 (new) — Citadel analyzers never mutate source.**
INVARIANT: no module under `extension/src/services/citadel/` (excluding the new classifier, which is read-only) may import or call a source-write primitive (`fs.writeFileSync`/`fs.promises.writeFile` against a repo path, or an Edit op). The mechanical remediation is performed exclusively by the `morty-gate-remediator` worker, keyed off the read-only `citadel_gate_result_*.json`. BREAKS: any future analyzer that "helpfully" edits source collapses the surface-only safety boundary and makes citadel non-deterministic / non-idempotent. ENFORCE: `extension/tests/citadel/citadel-never-writes-source.test.js` (AC-3). PATTERN_SHAPE: no `writeFileSync`/`writeFile`/Edit against a path derived from `repoRoot`/`changedFiles` in any `services/citadel/*.ts` except report-write helpers under the session dir.

**TD-2 (new) — Mechanical floor is union-not-replace; Critical path untouched.**
INVARIANT: `executeCitadelPhase` feeds `remediable ∪ mechanical` (deduped) to `remediateCitadelFindings`; the severity-threshold `remediable` set is NEVER removed or weakened — the mechanical set is purely ADDITIVE below the threshold. BREAKS: a refactor that replaces (rather than unions) the set could drop Critical findings from remediation, regressing R-HRP-1. ENFORCE: `extension/tests/pipeline-runner-citadel-mechanical-remediation.test.js` (AC-2, AC-8). PATTERN_SHAPE: `findingMeetsThreshold(f, threshold)` filter still present AND a deduped union with `isMechanicalCitadelFinding` before `remediateCitadelFindings`.

**TD-3 (new) — Mechanical set stays narrow.**
INVARIANT: `MECHANICAL_FINDING_MATCHERS` matches ONLY `banned-construct:brace-free-if`; `nested-ternary`, `orphan-test-file`, `orphan-enforce`, `orphan-test-case` and any `Critical` finding MUST classify non-mechanical. BREAKS: widening the matcher to a non-deterministic class lets the remediator attempt a semantic fix it must abort on, burning cycles. ENFORCE: `extension/tests/citadel/mechanical-finding-classifier.test.js` (AC-1).

**TD-4 (skip-flag unification, existing audit) — no new per-gate skip flag.**
The mechanical bypass uses ONLY `state.flags.skip_quality_gates_reason`. ENFORCE: `bash extension/scripts/audit-skip-flag-unification.sh` (AC-5) + W5b recurrence budget (AC-6).

**Audit-script wiring:** add the three new test files to their tier (`@tier: fast` for classifier unit tests; `@tier: integration` for the pipeline-runner remediation/idempotence/killswitch tests, registered via `discoverTierFiles`). Ensure `test-registration-hygiene.test.js` stays green.

---

## 7. Open decisions — RESOLVED (babysitter, 2026-06-16; encoded defaults per `feedback_babysitter_resolve_decisions_autonomously`)

The drain authority adopts the PRD's own recommendations for all four; none blocked launch:

1. **Kill-switch naming (AC-10): RESOLVED → dedicated `PICKLE_CITADEL_MECHANICAL=off`.** Matches the `PICKLE_CODEGRAPH` / `PLUMBUS_GENERATIVE_AUDIT` precedent; cleaner blast-radius than folding into `PICKLE_RECOVERY_CONSOLIDATION`. Document it in the root `CLAUDE.md` Environment Variables table (only the literal lowercase `off` disables).
2. **Recurrence budget value (AC-6): RESOLVED → `3`.** The budget is on the skip-flag use rate, not the finding count, so 3 is ample (skipping mechanical remediation should be rare).
3. **`nested-ternary` mechanical promotion: RESOLVED → DEFERRED (out of scope).** Non-deterministic (>1 valid extraction shape). Stays advisory; a separate PRD would define a canonical form.
4. **Strict-mode interaction: RESOLVED → mechanical findings are added regardless of strict/non-strict.** By design intent: a mechanical Medium finding gets fixed in both modes (the union is purely additive below whatever the threshold is).
