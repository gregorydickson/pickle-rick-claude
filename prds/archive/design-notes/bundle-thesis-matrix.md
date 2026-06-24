# Bundle Thesis Traceability Matrix

This matrix operationalizes the reliability bundle thesis: each Section A-D bug must have a retroactive Section E artifact that would have caught the bug class before release. Canary paths are concrete requirements from the bundle PRD; the audit intentionally fails while those later canary implementation tickets remain pending.

Bug | Failure-mode classification | Section E artifact (R-RTC-N) | Canary test path | Bug-repro assertion | other-rationale | annotation
---|---|---|---|---|---|---
| A | missing-e2e | R-RTC-3 | extension/tests/integration/deploy-lifecycle-soak.test.js | After install, deployed package.json version must remain equal to source version across the soak window while deployed runtime files continue matching source. | n/a | n/a |
| B | missing-e2e | R-RTC-4 | extension/tests/integration/pipeline-empty-queue-e2e.test.js | A synthetic all-Done ticket queue must end the pickle phase cleanly, stamp completed state, and advance the pipeline beyond phase 1. | n/a | n/a |
| C | coverage-gap | R-RTC-5 | extension/tests/stop-hook-state-matrix.test.js | The stop-hook state matrix must include stale active pid-null paused orphans and assert they do not block future stop-hook exits. | n/a | n/a |
| D | mock-drift | R-RTC-7, R-RTC-8 | extension/tests/contract/cli-contract.test.js | CLI contract tests and coverage instrumentation must expose drift between mocks and real command surfaces before council-publish and scope-resolver class flakes can ship. | n/a | parametrized; covers gh AND codex AND claude in one file (per ticket 01c13ccf) rather than three separate files |
