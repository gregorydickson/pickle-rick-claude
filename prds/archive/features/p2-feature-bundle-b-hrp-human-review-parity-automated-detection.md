---
title: P2 — B-HRP: Citadel fix-forward — replace the halt-gate with a remediation feed, and catch the errors leaking out of pipelines
status: draft
filed: 2026-06-04
revised: 2026-06-04
priority: P2
type: feature-bundle
code: B-HRP
composes:
  - "R-HRP-1 (citadel stops halting → feeds spawn-gate-remediator)"
  - "R-HRP-2 (CitadelFinding[] → GateFailure[] adapter)"
  - "R-HRP-3 (consolidated leak-detection analyzers, advisory-by-architecture)"
  - "R-HRP-4 (unwrapped-analyzer fail-open guards)"
  - "C-HRP-CLOSER"
supersedes_design: "Earlier B-HRP draft added 15 scattered detectors WITH halt authority + a Medium-clamp / warn-block / B-HRP-PROMOTE safety apparatus to keep them from wedging pipelines. This revision deletes that apparatus: once citadel cannot halt, none of it is needed. Net complexity goes DOWN."
---

# B-HRP — Citadel fix-forward

## The problem this bundle actually solves

Two things, and the second is the point:

1. **Errors leak out of pipelines.** A retrospective of 20 merged product-repo PRs surfaced 18 recurring defect clusters (140 findings) that only human review caught: schema/registry drift, auth/feature-flag/throttle parity, tests that assert an inline copy instead of the shipped module, banned constructs (nested ternaries, brace-free `if`) and unsafe casts (`(err as Error).message`, `as any`) that are *codified in CLAUDE.md but enforced nowhere*, PII in committed fixtures, stale doc/comment references.

2. **The pipeline is getting brittle, and the review layer is a cause, not a cure.** Today the autonomous pipeline is `pickle → citadel → anatomy-park → szechuan-sauce`. **Citadel is the only phase that halts** (it returns a non-zero exit on `Critical`, or `High` under `--strict`, and `shouldHaltAfterPhase` honors it — `pipeline-runner.ts` ~1855). It halts *directly in front of two phases (anatomy-park, szechuan-sauce) that are already detect-fix-converge loops and continue-on-failure* (R-PHC-6). So citadel detects a problem and **stops for an operator**, when the very next phases exist to fix problems autonomously. Worse, the historical response to each leaked defect has been to add a static trap-door pin — the `extension/CLAUDE.md` trap-door list is now hundreds of entries. **detect→halt→pin is a complexity ratchet; detect→fix→converge is self-correcting.**

The earlier draft of this bundle made #2 worse: it added 15 new detectors, each with halt authority, each needing a Medium-severity clamp + warn/block flags + a deferred-promotion follow-up to *stop them wedging the pipeline*. That scaffolding existed only because the detectors could halt. **Remove the halt and the scaffolding evaporates.**

## The change: citadel detects, the existing remediator fixes, the pipeline never stops

```
BEFORE:  pickle → [citadel: HALT on Critical/High] → anatomy-park → szechuan-sauce
                         ↑ operator must intervene

AFTER:   pickle → citadel(detect, write findings, NEVER halt)
                    → remediate(spawn-gate-remediator fixes the findings, bounded loop)
                    → anatomy-park → szechuan-sauce
                         ↑ fully fix-forward, zero operator stops
```

**No new fixer is built.** `spawn-gate-remediator.ts` already takes a `GateResult { status, failures: GateFailure[] }`, prompts a worker to "fix ONLY the listed failures, do not change behavior," and is already bounded + wired into `finalize-gate` (`remediator_timeout_s: 600`, `*_max_remediation_cycles`). Citadel findings just need a `CitadelFinding[] → GateFailure[]` adapter and a call into that remediator. The leak-detection analyzers then feed the **same** path — one place, no scattered gates.

### Why this is safe AND simpler

- **It cannot wedge pipelines** because nothing it adds can halt — citadel's halt is *removed*, not clamped. No Medium-severity dance, no `off|warn|block` flags, no `B-HRP-PROMOTE` follow-up. All deleted from the design.
- **Broken code still cannot ship.** Removing citadel's *conformance* halt does NOT remove the test/tsc/lint/convergence gates — the worker gate (R-PTG) and convergence gate still block code that fails tests, types, or lint. Citadel was a *quality/conformance* gate on top of green-ness; green-ness stays enforced. A bad remediation fix fails those gates and is reverted by the same convergence machinery that guards every anatomy/szechuan fix.
- **It catches more** because a detected leak becomes a *fix target in a bounded loop* instead of a `Critical` that halts or a nit dropped below szechuan's confidence cut.
- **Autonomy is the default.** If the remediator cannot fix a finding within its cycle cap, the pipeline **logs it and continues** (surfaced async in `citadel_report.json` + an activity event, optionally a Linear comment) — it never blocks on an operator. The honest tradeoff you chose: an unfixable *conformance* finding ships and is surfaced for later, rather than stopping the line. Correctness/green-ness is still gated.
- **Fewer trap doors.** Self-correcting loops don't need a static pin per error class the way a halt gate does.

## Tickets (machine-checkable ACs)

**R-HRP-1 — Citadel stops halting; findings feed the existing remediator. (keystone)**
- In `pipeline-runner.ts`: the citadel phase MUST NOT return a halting exit code. After `runCitadelAudit` writes `citadel_report.json`, convert its findings to a `GateResult` and invoke `spawnGateRemediatorMain({ gateResult, sessionRoot, reason: 'citadel' })`, bounded by a new `citadel_max_remediation_cycles` finalize-gate setting (default `3`, reuse `remediator_timeout_s`). Remove the citadel branch from the halt path (`shouldHaltAfterPhase` no longer special-cases citadel; the `citadel_strict ? 'High' : 'Critical'` *halt threshold* logic is deleted). `citadel_strict` is retained as a flag but re-documented: it widens which findings are *remediated* (High+), it no longer halts. After remediation, the phase ALWAYS returns success and the pipeline continues to anatomy-park.
- AC: `extension/tests/pipeline-runner.test.js` (new cases) — (a) a citadel run that produces `Critical` findings does NOT halt the pipeline: the phase exit is non-halting and the next phase (anatomy-park) is dispatched; (b) `spawnGateRemediatorMain` is invoked with a `GateResult` whose `failures` correspond to the citadel findings; (c) when the remediator exhausts `citadel_max_remediation_cycles` with findings still open, the pipeline logs a `citadel_findings_unremediated` activity event and STILL continues (no halt, exit reason is not a halt). PATTERN_SHAPE: no `shouldHaltAfterPhase` branch references `'citadel'`; no `citadel_strict ? 'High' : 'Critical'` halt-threshold expression remains.

**R-HRP-2 — `CitadelFinding[] → GateFailure[]` adapter.**
- NEW pure function `citadelFindingsToGateResult(findings: CitadelFinding[]): GateResult` (in `services/citadel/` or alongside the remediator) mapping each finding's file/line/severity/description into a `GateFailure`, producing `{ status: findings.length ? 'fail' : 'pass', failures }`. Pure, no I/O.
- AC: `extension/tests/citadel/citadel-findings-to-gate-result.test.js` — asserts a representative `CitadelFinding[]` maps to a well-formed `GateResult` that `isGateResult()` accepts (the remediator's own type guard), and an empty input yields `{ status: 'pass', failures: [] }`.

**R-HRP-3 — Consolidated leak-detection analyzers (advisory by architecture).**
- Add the leak detections as citadel analyzers feeding R-HRP-1's path. Because citadel no longer halts, these need **no** severity clamp and **no** flags — they simply emit findings the remediator fixes. New/extended analyzers, each wired via `safeRunAnalyzer` (new ones) and auto-enforced by `audit-citadel-wiring.js` (R-CCNW-2):
  - `schema-registry-drift-audit.ts` — Drizzle `pgEnum`/CHECK members vs their declared TS-registry mirror.
  - `test-authenticity-audit.ts` — a changed `*.spec` declaring a symbol that matches a sibling export it never imports (inline-copy); vacuous `Object.keys(...).toContain('<TypeName>')`.
  - `stale-reference-audit.ts` — backticked identifiers in changed comments/JSDoc absent from HEAD.
  - extend `sibling-auth-audit.ts` — feature-flag/`@Throttle` parity + destructive-verb weaker-`@Roles`-allowlist (gated `nestjs-api`).
  - extend `diff-hygiene.ts` — `pii-in-fixture` on non-placeholder values of an enumerated PII-key allowlist.
  - **`banned-constructs` + `banned-casts` move here as analyzers, NOT worker-gate scripts** — folding them into the detect→remediate path deletes the separate `audit-banned-*.sh` scripts, their `runWorkerGate` wiring, and the `PICKLE_GATE_*` flags from the earlier draft. Nested ternary / brace-free `if` / `(x as Error).` / `} as any` become findings the remediator rewrites to the CLAUDE.md-prescribed form.
- AC: each analyzer ships `extension/tests/citadel/<name>.test.js` proving it fires on a positive fixture, is silent on a negative fixture, **and emits zero findings on the current pickle-rick-claude tree** (so the bundle's own citadel→remediate pass is a no-op against clean code). `node extension/scripts/audit-citadel-wiring.js` exits 0.

**R-HRP-4 — Fail-open guards for the EXTENDED unwrapped analyzers.**
- `sibling-auth-audit.ts`, `rule-set-invariant-audit.ts`, and `diff-hygiene.ts` run UNWRAPPED by `safeRunAnalyzer` (per `services/CLAUDE.md`): a throw in added code crashes the whole audit (independent of halting). Every new filesystem/parse read in those extensions MUST be individually `try/catch`-guarded (return `[]`/`0`/`''`).
- AC: each extension's test asserts the audit still completes (no throw) when its new read hits an unreadable / TOCTOU-removed / malformed input — mirroring the existing `readManifestText` / `fileSize` trap-door precedent.

**C-HRP-CLOSER (manager-owned).**
- Recompile `.ts`→`.js` parity, `bash install.sh`, full gate (tsc/eslint/all audit scripts/test:fast/test:integration/`RUN_EXPENSIVE_TESTS=1` test:expensive). Because the new citadel analyzers run during the closer's own citadel phase on this very diff and must emit **zero** findings on the clean tree, the bundle self-dogfoods: a broken/false-positive analyzer surfaces as a self-remediation churn or a gate failure before release. Version bump **MINOR** (behavior change to citadel + new analyzers, schema-neutral, no CLI-arg removal). `gh release create`.

## What this bundle DELETES (the simplification, made explicit)

- Citadel's halt path + the `citadel_strict ? 'High' : 'Critical'` halt-threshold logic in `pipeline-runner.ts`.
- The earlier draft's entire safety scaffolding: `Medium`-severity clamp (S1), `PICKLE_GATE_BANNED_*` `off|warn|block` flags (S6), the `B-HRP-PROMOTE` deferred-promotion follow-up, and the per-detector severity-reconciliation rules. None are needed when nothing halts.
- Two standalone `audit-banned-*.sh` worker-gate scripts + their `runWorkerGate` wiring (folded into citadel analyzers).
- The redundant szechuan-Override-8 and anatomy-park prompt additions from the earlier draft — the leak classes are now caught at citadel and fixed by the remediator, so duplicating detection into the LLM-judge prompts is unnecessary.

Net: **−1 halt point, −1 operator-stop class, −2 shell scripts, −1 follow-up bundle, − a whole flag/clamp/promote apparatus**, while catching strictly more (every cluster becomes a fix target). The only genuinely new surfaces are the detection analyzers and one adapter function — and they ride the existing remediation loop.

## Notes

- **Distinct from #95 R-SJWT (shipped v1.98.0).** That scoped the szechuan judge's read surface; this changes citadel's role from gate to detector. Independent.
- **Worker Forbidden Ops respected.** No state/schema/settings writes; remediation runs through the existing `spawn-gate-remediator` worker; `install.sh` only at the closer.
- **Residual risk (honest).** A *conformance* finding the remediator cannot fix within the cap ships and is surfaced async — by design, per the autonomy goal. This does not weaken correctness gates (tests/tsc/lint/convergence still block broken code). If a class of finding proves it must never ship un-fixed (e.g. PII), that single class — not the whole gate — can be given a narrow async escalation (Linear comment / activity alert), still without halting the pipeline. That refinement is out of scope here and would be its own small ticket.
- **Open follow-up the operator flagged:** whether to go further and *dissolve* citadel into anatomy-park entirely (one fewer phase). This bundle does the reform-in-place version (citadel kept, halt removed); the dissolve option remains available later if the remediation-feed proves the analyzers are better hosted inside the anatomy loop.
