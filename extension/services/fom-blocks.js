// Single source for the FOM (fable-operating-manual) prompt family (B-FOMC WS-1).
// Each block is epistemics-only, <=5 lines, <=400 bytes — enforced by fom-infusion-prompts.test.js.
// `.ts` builders import these; `.md`/persona surfaces carry the exact string between
// `<!-- BEGIN <NAME> -->` / `<!-- END <NAME> -->` sentinels; `.claude/workflows/*.js` twins carry
// them as a single top-level unindented template literal (see the shape test for the exact contract).
export const FOM_EVIDENCE_RULES = `## Evidence rules
A resolving path is not a verified claim; a missing path may be a proposed file, not a fabrication.
Verify the claim itself, not whether a token resolves.`;
export const FOM_HONEST_REPORTING_RULES = `## Honest reporting
Silence is not success. A fast clean pass may mean the gate never fired, not that it passed.
Never report an outcome you did not observe; verify before declaring a verdict.`;
