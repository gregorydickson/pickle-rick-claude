/**
 * Ticket 984a768c (AC-1'): the honest 18-sha partition backing the "did we count it" prevention
 * bundle. The authored AC-1 assumed every corpus sha was reachable by an ESLint/AST rule;
 * refinement measured otherwise (`prd_refined.md` §1) and declared AC-1-as-authored
 * unsatisfiable. This module is the committed, machine-readable record of that measurement —
 * landed as data BEFORE any detection rule is written, so a later ticket has no incentive to
 * stretch a matcher until it "hits 18/18".
 *
 * DETECTABLE_CEILING is stated here, not derived, because the ceiling is the thing this file
 * exists to fix: 9 of 18 shas are reachable by an AST rule over `extension/src/**\/*.ts`. The
 * other 9 split into `semantic` (file-reachable, but the defect is a meaning question no AST
 * rule can decide — 5, including `4b0a4a70`, vacuous for both proposed rules) and `out-of-reach`
 * (touches zero `extension/src/**\/*.ts` — 4, including `2c857117`, encoded as a positive
 * control because both its defect arms are LIVE at HEAD, not exempted).
 */
/** Realistic ceiling per `prd_refined.md` §1 — do not stretch a matcher to inflate this. */
export const DETECTABLE_CEILING = 9;
export const CORPUS = [
    // detectable (9) — reachable by an AST rule over extension/src/**/*.ts, fires on parent only.
    {
        sha: '697fd734',
        bucket: 'detectable',
        host: 'process-identity',
        expect_fire_on_parent: true,
        expect_fire_on_fix: false,
        reason: 'process-identity defect with an AST-shape signature; not the vacuous-rule case (4b0a4a70) or the positive control (2c857117).',
    },
    {
        sha: '39c5b33e',
        bucket: 'detectable',
        host: 'process-identity',
        expect_fire_on_parent: true,
        expect_fire_on_fix: false,
        reason: 'process-identity defect with an AST-shape signature; not the vacuous-rule case (4b0a4a70) or the positive control (2c857117).',
    },
    {
        sha: 'ff8d4739',
        bucket: 'detectable',
        host: 'process-identity',
        expect_fire_on_parent: true,
        expect_fire_on_fix: false,
        reason: 'process-identity defect with an AST-shape signature; not the vacuous-rule case (4b0a4a70) or the positive control (2c857117).',
    },
    {
        sha: '41b9b255',
        bucket: 'detectable',
        host: 'process-identity',
        expect_fire_on_parent: true,
        expect_fire_on_fix: false,
        reason: 'process-identity defect with an AST-shape signature; not the vacuous-rule case (4b0a4a70) or the positive control (2c857117).',
    },
    {
        sha: '7e06e8b2',
        bucket: 'detectable',
        host: 'capture-enumeration',
        expect_fire_on_parent: true,
        expect_fire_on_fix: false,
        reason: 'capture-enumeration defect with an AST-shape signature reachable over extension/src/**/*.ts.',
    },
    {
        sha: 'e2804228',
        bucket: 'detectable',
        host: 'capture-enumeration',
        expect_fire_on_parent: true,
        expect_fire_on_fix: false,
        reason: 'capture-enumeration defect with an AST-shape signature reachable over extension/src/**/*.ts.',
    },
    {
        sha: 'd24cec5e',
        bucket: 'detectable',
        host: 'capture-enumeration',
        expect_fire_on_parent: true,
        expect_fire_on_fix: false,
        reason: 'capture-enumeration defect with an AST-shape signature reachable over extension/src/**/*.ts.',
    },
    {
        sha: 'c7c85ef3',
        bucket: 'detectable',
        host: 'capture-enumeration',
        expect_fire_on_parent: true,
        expect_fire_on_fix: false,
        reason: 'capture-enumeration defect with an AST-shape signature reachable over extension/src/**/*.ts.',
    },
    {
        sha: '0cf3b8e3',
        bucket: 'detectable',
        host: 'verification-machinery',
        expect_fire_on_parent: true,
        expect_fire_on_fix: false,
        reason: 'verification-machinery defect with an AST-shape signature; the one member of this host not excluded (ab8fe436/9e89e360/ff2846d1 are out-of-reach).',
    },
    // semantic (5) — file-reachable, but the defect is a meaning question, not a shape question.
    {
        sha: '4b0a4a70',
        bucket: 'semantic',
        host: 'process-identity',
        expect_fire_on_parent: false,
        expect_fire_on_fix: false,
        reason: 'vacuous for both proposed rules: parent commit has zero `detached` occurrences and already carries `maxBuffer: 10 * 1024 * 1024`; the defect ("is this subprocess call a subtree ROOT?") is a process-semantics question, not an AST shape.',
    },
    {
        sha: '853012c1',
        bucket: 'semantic',
        host: 'lexical-matcher',
        expect_fire_on_parent: false,
        expect_fire_on_fix: false,
        reason: 'lexical-matcher defect: file-reachable but the correctness question is about matcher SEMANTICS (what the pattern means), not the AST shape of the call site.',
    },
    {
        sha: 'dd146e61',
        bucket: 'semantic',
        host: 'lexical-matcher',
        expect_fire_on_parent: false,
        expect_fire_on_fix: false,
        reason: 'lexical-matcher defect: file-reachable but the correctness question is about matcher SEMANTICS (what the pattern means), not the AST shape of the call site.',
    },
    {
        sha: 'da392255',
        bucket: 'semantic',
        host: 'lexical-matcher',
        expect_fire_on_parent: false,
        expect_fire_on_fix: false,
        reason: 'lexical-matcher defect: file-reachable but the correctness question is about matcher SEMANTICS (what the pattern means), not the AST shape of the call site.',
    },
    {
        sha: 'ea84879e',
        bucket: 'semantic',
        host: 'lexical-matcher',
        expect_fire_on_parent: false,
        expect_fire_on_fix: false,
        reason: 'lexical-matcher defect: file-reachable but the correctness question is about matcher SEMANTICS (what the pattern means), not the AST shape of the call site.',
    },
    // out-of-reach (4) — touches zero extension/src/**/*.ts; no ESLint/AST rule can reach it.
    {
        sha: '2c857117',
        bucket: 'out-of-reach',
        host: 'process-identity',
        expect_fire_on_parent: true,
        expect_fire_on_fix: true,
        positive_control: true,
        reason: "positive control, not an exemption: the sha's own commit diff touches zero extension/src/**/*.ts files (so a diff-based replay cannot reach it), but both documented defect arms (pickle-utils.ts:2750, mux-runner.ts:626) are LIVE at HEAD — the labeled \"fix\" never resolved the code-level defect, so both fire-on-parent and fire-on-fix are true.",
    },
    {
        sha: 'ab8fe436',
        bucket: 'out-of-reach',
        host: 'verification-machinery',
        expect_fire_on_parent: false,
        expect_fire_on_fix: false,
        reason: "commit diff touches zero extension/src/**/*.ts files; no ESLint/AST rule over that glob can ever reach this sha.",
    },
    {
        sha: '9e89e360',
        bucket: 'out-of-reach',
        host: 'verification-machinery',
        expect_fire_on_parent: false,
        expect_fire_on_fix: false,
        reason: "commit diff touches zero extension/src/**/*.ts files; no ESLint/AST rule over that glob can ever reach this sha.",
    },
    {
        sha: 'ff2846d1',
        bucket: 'out-of-reach',
        host: 'verification-machinery',
        expect_fire_on_parent: false,
        expect_fire_on_fix: false,
        reason: "commit diff touches zero extension/src/**/*.ts files; no ESLint/AST rule over that glob can ever reach this sha.",
    },
];
