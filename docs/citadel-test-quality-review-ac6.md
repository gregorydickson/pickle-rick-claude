# Citadel Review-Efficacy — Test-Quality Review (R-RGED #105, AC-6, ticket 05e86ab7)

Test-quality review of the citadel review-efficacy test suite added/extended by the R-RGED #105 bundle. Baseline: **191/191 `tests/citadel/*.test.js` pass**.

## AC → test mapping (every refined-PRD AC maps to ≥1 test)

| AC | Mechanism | Covering test file(s) |
|----|-----------|----------------------|
| AC-1 | `runCitadelStandalone` + CLI shim | `run-standalone.test.js`, `standalone-integration.test.js`, `citadel-analyzer-wiring.test.js` |
| AC-2 | extended banned-casts / sibling-auth / stale-reference analyzers | `banned-casts-audit.test.js`, `banned-constructs-audit.test.js`, `sibling-auth-audit.test.js` (+ `-throttle-roles`, `-toctou`), `stale-reference-audit.test.js` |
| AC-3 | new `pattern-conformance-audit` (PATTERN_SHAPE + SQL ON CONFLICT) — PATTERN_SHAPE arm later subtracted by R-PCPS; SQL ON CONFLICT retained | `pattern-conformance-audit.test.js` |
| AC-4 | (descoped to target-repo — out of bundle) | n/a |
| AC-5 | M2 report-only skeptic lens → `skeptic_findings.json` sink | `skeptic-lens.test.js` |
| AC-6 | test-quality review (this record) | this document + the suite as a whole |
| AC-7 | flywheel-closes proof (documented PATTERN_SHAPE → caught) — WITHDRAWN by R-PCPS: the flywheel only closed for sentinel-shaped patterns; against the real corpus the arm emitted 41/41 false High findings, so it was subtracted and its test removed. Trap-door enforcement lives in `extension/scripts/audit-trap-door-enforcement.sh`. | ~~`pattern-conformance-flywheel.test.js`~~ (removed) |
| AC-8 | analyzer count rises ≤1, no double-report; LOC flat-or-down | `citadel-analyzer-wiring.test.js`, `severity-enum-guard.test.js` |
| G1/G2 | PR#1707 dirty/clean regression fixtures | `loa907-regression.test.js` (+ `fixtures/loa907-{dirty,clean}.diff`) |

## P0/P1 assertion-gap review

- **Severity-by-substring antipattern: ABSENT.** Grep for `includes('Critical'|'High'|'Medium'|'Low')` over `tests/citadel/*.test.js` returns zero hits; severities are asserted by exact `CitadelSeverity` enum value, enforced going forward by `severity-enum-guard.test.js`.
- **No tautological / unmapped ACs:** every AC above resolves to a concrete detector test, not a self-satisfying assertion.
- **G2 clean fixture exercises every detector:** `fixtures/loa907-clean.diff` (the safe variant) is replayed through `loa907-regression.test.js` and must produce no findings, proving each new/extended detector is silent on clean input (no false positives).

## Conclusion

Zero P0 and zero P1 test-quality gaps. No actionable test changes required — the suite is comprehensive and asserts on exact enum values. AC-6 satisfied by review.
