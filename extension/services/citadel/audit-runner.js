import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { isRecord } from '../../lib/is-record.js';
import { withLock } from '../state-manager.js';
import { auditAcShape } from './ac-shape-audit.js';
import { auditSiblingAuthPreconditions } from './sibling-auth-audit.js';
import { auditFrontendPropDrift } from './frontend-prop-drift-audit.js';
import { walkDiff } from './diff-walker.js';
import { auditRuleSetInvariants } from './rule-set-invariant-audit.js';
import { auditDiffHygiene } from './diff-hygiene.js';
import { reconcileDivergences } from './divergence-reconciliation.js';
import { Reporter } from './reporter.js';
import { parseWithComposes } from './prd-parser.js';
import { detectProjectShapes } from './project-shape.js';
import { buildAcCoverageScorecard } from './ac-coverage-scorecard.js';
import { detectAllowlistDeadEntries } from './allowlist-dead-entry-detector.js';
import { auditStateTransitions } from './state-transition-audit.js';
import { auditTrapDoorCoverage } from './trap-door-coverage-audit.js';
import { checkEndpointContractConformance } from './endpoint-contract-conformance.js';
import { auditSchemaRegistryDrift } from './schema-registry-drift-audit.js';
import { auditTestAuthenticity } from './test-authenticity-audit.js';
import { auditStaleReferences } from './stale-reference-audit.js';
import { auditCrossfileBehaviorDrift } from './crossfile-behavior-drift-audit.js';
import { auditBannedConstructs } from './banned-constructs-audit.js';
import { auditBannedCasts } from './banned-casts-audit.js';
import { auditPatternConformance } from './pattern-conformance-audit.js';
import { runSkepticLens } from './skeptic-lens.js';
import { readRecoverableJsonObject } from '../recoverable-json.js';
export async function runCitadelAudit(options) {
    const report = buildCitadelAuditReport(options);
    if (!options.sessionDir && !options.reportPath)
        return report;
    const reportPath = options.reportPath ?? path.join(options.sessionDir ?? '', 'citadel_report.json');
    const lockKey = `citadel:${path.resolve(options.sessionDir ?? path.dirname(reportPath))}`;
    await withLock(lockKey, {}, async () => {
        mkdirSync(path.dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, `${stableJson(report)}\n`, 'utf-8');
    });
    if (options.sessionDir) {
        writeSkepticSink(options.sessionDir, options.diffRange, path.resolve(options.repoRoot ?? process.cwd()));
    }
    return report;
}
// Report-only skeptic lens sink: walks the diff, runs the lens, and writes a
// non-ingested skeptic_findings.json next to the citadel report. Failures are
// swallowed by design so they never surface to the pipeline.
function writeSkepticSink(outDir, diffRange, repoRoot) {
    try {
        const diff = walkDiff(diffRange, { repoRoot });
        const skepticReport = runSkepticLens(diff.changedFiles, repoRoot);
        writeFileSync(path.join(outDir, 'skeptic_findings.json'), `${JSON.stringify(skepticReport, null, 2)}\n`, 'utf-8');
    }
    catch {
        // report-only: failures never surface to the pipeline
    }
}
const NO_PRD_SKIPPED = {
    findings: [],
    skipped: 'no_prd',
    reason: 'no PRD path provided for standalone run',
};
export function buildCitadelAuditReport(options) {
    const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
    const resolvedPrdPath = options.prdPath !== undefined
        ? path.resolve(repoRoot, options.prdPath)
        : undefined;
    const sections = runCitadelAnalyzers(options, repoRoot, resolvedPrdPath);
    const decisionRequired = [
        ...sections.ac_shape.decisionsRequired,
        ...sections.divergence_reconciliation.decisionsRequired,
    ];
    const reporter = new Reporter();
    return reporter.build({
        prdPath: resolvedPrdPath ?? '',
        diffRange: options.diffRange,
        header: buildCitadelReportHeader(options.sessionDir),
        sections,
        findings: collectSectionFindings(sections),
        decisions: decisionRequired,
        strict: options.strict,
    });
}
// Findings follow section order (uniqueFindings renames duplicate ids first-wins).
// Cross-phase findings arrive already attributed, so they are carried verbatim.
function collectSectionFindings(sections) {
    return uniqueFindings(Object.entries(sections).flatMap(([key, section]) => {
        const sectionFindings = section.findings;
        return key === 'cross_phase'
            ? sectionFindings
            : sectionFindings.map((finding) => withFindingSource(finding, key));
    }));
}
// Section keys are spread in order: collectSectionFindings follows section order.
function runCitadelAnalyzers(options, repoRoot, resolvedPrdPath) {
    const inputs = loadAnalyzerInputs(options, repoRoot, resolvedPrdPath);
    return {
        ...runScopeAnalyzers(inputs),
        ...runCrossPhaseAnalyzers(inputs),
        ...runPrdContractAnalyzers(inputs),
        ...runDiffPatternAnalyzers(inputs.diff),
    };
}
function loadAnalyzerInputs(options, repoRoot, resolvedPrdPath) {
    const prd = readPrdInputs(resolvedPrdPath, repoRoot);
    const diff = walkDiff(options.diffRange, { repoRoot });
    const projectShapes = detectProjectShapes(repoRoot);
    return { options, repoRoot, resolvedPrdPath, ...prd, diff, projectShapes };
}
function emptyParsedPrd() {
    return {
        decisions: [],
        acceptanceCriteria: [],
        endpoints: [],
        allowlistEntries: [],
        statusCodeRows: [],
        transitionAuditRows: [],
        composedRcodes: new Map(),
    };
}
/**
 * AP-EXT-ITER287-01: read the PRD and resolve its `composes:` graph, DEGRADING instead of
 * throwing. `loadAnalyzerInputs` runs outside every `safeRunAnalyzer` wrapper, and nothing
 * between here and `pipeline-runner.ts` catches — not `buildCitadelAuditReport`, not
 * `executeCitadelPhase`, not `runPhaseIteration`, not `runPipelinePhaseLoop` — so a throw here
 * reached the CLI's fatal handler, stamped `exit_reason: 'fatal'` and exited 1 with
 * anatomy-park and szechuan-sauce never run. That is the one disposition the PRIME DIRECTIVE
 * forbids a measurement to take: a gate MAY refuse a local action, it MAY NEVER break the
 * phase loop.
 *
 * ticket 98dc9bed F3.1 removed an earlier swallow here for a real reason — masking a malformed
 * compose graph audits the wrong PRD scope silently. That reason is preserved, not reverted:
 * the failure is REPORTED (`citadel-prd-parse`, the same `analyzer_threw` shape every wrapped
 * analyzer emits) rather than swallowed. Honesty is a reporting property; halting is a
 * disposition. This changes only the second one.
 *
 * MEASURED 2026-09-18 over this repo's own `prds/` tree: 35 of 466 PRDs make `parseWithComposes`
 * throw, and one of them — `prds/p2-bug-fix-bundle-b-rlh-review-loop-honesty.md` — is the bundle
 * `prds/MASTER_PLAN.md` names as the next launch. 8 of the 16 recorded sessions hand citadel a
 * repo PRD directly, so the path is the operator's normal one.
 *
 * `prdMarkdown` keeps whatever was read before the failure: a `ComposesError` leaves the root
 * PRD's own text perfectly usable, and `auditRuleSetInvariants` consumes it.
 */
function readPrdInputs(resolvedPrdPath, repoRoot) {
    if (resolvedPrdPath === undefined) {
        return { prdMarkdown: '', parsedPrd: emptyParsedPrd(), prdUnresolved: null };
    }
    let prdMarkdown = '';
    try {
        prdMarkdown = readFileSync(resolvedPrdPath, 'utf-8');
        return { prdMarkdown, parsedPrd: parseWithComposes(resolvedPrdPath, { repoRoot }), prdUnresolved: null };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { prdMarkdown, parsedPrd: emptyParsedPrd(), prdUnresolved: message };
    }
}
const EMPTY_AC_SHAPE = {
    decisionsRequired: [],
    findings: [],
    summary: { decisionsRequired: 0, highFindings: 0 },
};
/**
 * AP-EXT-ITER287-01: the degrade breadcrumb for a PRD that did not resolve, in
 * `safeRunAnalyzer`'s OWN `AnalyzerErrorResult` shape — "this analyzer could not run" already
 * has exactly one spelling in this report and this is that spelling, not a second one. It rides
 * `ac_coverage` because that is the section whose population (`parsedPrd.acceptanceCriteria`)
 * the failed parse emptied: the row that would otherwise read as "no AC findings" is the row
 * that says why it is empty.
 */
function prdUnresolvedResult(prdUnresolved) {
    return {
        skipped: false,
        findings: [{
                id: 'citadel-prd-parse',
                severity: 'Low',
                analyzer_threw: true,
                message: 'PRD could not be read or its composes: graph could not be resolved; every PRD-derived '
                    + `section ran against an EMPTY PRD this run: ${prdUnresolved}`,
            }],
    };
}
function runScopeAnalyzers(inputs) {
    const { options, repoRoot, resolvedPrdPath, prdMarkdown, prdUnresolved, diff, projectShapes } = inputs;
    const siblingAuth = auditSiblingAuthPreconditions(diff, { projectShapes });
    const frontendPropDrift = safeRunAnalyzer('citadel-frontend-prop-drift', () => auditFrontendPropDrift(diff), { analyzerCompatibility: ['react-frontend'], projectShapes });
    // AP-EXT-ITER287-01: `auditAcShape` is the SECOND unguarded read of the same PRD, so it runs
    // only on the condition that first read succeeded on — one predicate governs both. Measured
    // cost of not running it on a ComposesError (where the root PRD is readable but its graph is
    // not): zero — `ac_shape` emitted 0 findings across all 16 recorded sessions.
    const acShape = resolvedPrdPath !== undefined && prdUnresolved === null
        ? auditAcShape({ prdPath: resolvedPrdPath, sessionDir: options.sessionDir })
        : EMPTY_AC_SHAPE;
    const ruleSetInvariants = resolvedPrdPath
        ? auditRuleSetInvariants(diff, { repoRoot, prdMarkdown })
        : NO_PRD_SKIPPED;
    return {
        sibling_auth_preconditions: siblingAuth,
        frontend_prop_drift: frontendPropDrift,
        ac_shape: acShape,
        rule_set_invariants: ruleSetInvariants,
    };
}
function runCrossPhaseAnalyzers({ options, diff }) {
    const crossPhase = readCrossPhaseFindings(options.sessionDir);
    const crossPhaseReport = {
        findings: crossPhase.findings,
        summary: crossPhase.summary,
    };
    return {
        diff_hygiene: auditDiffHygiene(diff, { szechuanFindings: crossPhase.szechuan_findings }),
        divergence_reconciliation: reconcileDivergences(diff),
        cross_phase: crossPhaseReport,
    };
}
function runPrdContractAnalyzers({ repoRoot, resolvedPrdPath, parsedPrd, prdUnresolved, diff, projectShapes }) {
    const acCoverage = resolvedPrdPath === undefined
        ? NO_PRD_SKIPPED
        : prdUnresolved !== null
            ? prdUnresolvedResult(prdUnresolved)
            : safeRunAnalyzer('citadel-ac-coverage', () => buildAcCoverageScorecard(parsedPrd.acceptanceCriteria, diff, { repoRoot }));
    const allowlistDead = safeRunAnalyzer('citadel-allowlist-dead', () => detectAllowlistDeadEntries(diff, { repoRoot }));
    const stateTransitions = resolvedPrdPath
        ? safeRunAnalyzer('citadel-state-transitions', () => auditStateTransitions(parsedPrd.transitionAuditRows, diff, { repoRoot }))
        : NO_PRD_SKIPPED;
    const trapDoorCoverage = safeRunAnalyzer('citadel-trap-door', () => auditTrapDoorCoverage(diff));
    const endpointContractConformance = resolvedPrdPath
        ? safeRunAnalyzer('citadel-endpoint-contract', () => checkEndpointContractConformance(parsedPrd.endpoints, parsedPrd.statusCodeRows, { repoRoot }), { analyzerCompatibility: ['nestjs-api'], projectShapes })
        : NO_PRD_SKIPPED;
    return {
        ac_coverage: acCoverage,
        allowlist_dead: allowlistDead,
        state_transitions: stateTransitions,
        trap_door_coverage: trapDoorCoverage,
        endpoint_contract_conformance: endpointContractConformance,
    };
}
function runDiffPatternAnalyzers(diff) {
    return {
        schema_registry_drift: safeRunAnalyzer('citadel-schema-registry-drift', () => auditSchemaRegistryDrift(diff)),
        test_authenticity: safeRunAnalyzer('citadel-test-authenticity', () => auditTestAuthenticity(diff)),
        stale_reference: safeRunAnalyzer('citadel-stale-reference', () => auditStaleReferences(diff)),
        crossfile_behavior_drift: safeRunAnalyzer('citadel-crossfile-behavior-drift', () => auditCrossfileBehaviorDrift(diff)),
        banned_constructs: safeRunAnalyzer('citadel-banned-constructs', () => auditBannedConstructs(diff)),
        banned_casts: safeRunAnalyzer('citadel-banned-casts', () => auditBannedCasts(diff)),
        pattern_conformance: safeRunAnalyzer('citadel-pattern-conformance', () => auditPatternConformance(diff)),
    };
}
export async function runCitadelStandalone(target, outputDir) {
    const repoRoot = path.resolve(target.workingDir);
    const reportDir = outputDir !== undefined ? path.resolve(outputDir) : repoRoot;
    const reportPath = path.join(reportDir, 'citadel_report.json');
    const result = buildCitadelAuditReport({ diffRange: target.diffRange, repoRoot, reportPath });
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${stableJson(result)}\n`, 'utf-8');
    writeSkepticSink(reportDir, target.diffRange, repoRoot);
    return result;
}
function stableJson(value) {
    return JSON.stringify(value, null, 2);
}
export function buildCitadelReportHeader(sessionDir) {
    const fallback = {
        pickle_phase_failed: false,
        pickle_exit_code: null,
    };
    if (!sessionDir)
        return fallback;
    const statePath = path.join(sessionDir, 'state.json');
    let parsed;
    try {
        parsed = readRecoverableJsonObject(statePath);
    }
    catch {
        return fallback;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.activity))
        return fallback;
    const pickleFailures = parsed.activity.filter((entry) => (isRecord(entry)
        && entry.event === 'recoverable_phase_failure'
        && entry.phase === 'pickle'
        && typeof entry.exit_code === 'number'
        && entry.exit_code !== 0));
    if (pickleFailures.length === 0)
        return fallback;
    const lastFailure = pickleFailures[pickleFailures.length - 1];
    return {
        pickle_phase_failed: true,
        pickle_exit_code: lastFailure.exit_code,
    };
}
function readCrossPhaseFindings(sessionDir) {
    const anatomyArtifact = readPhaseFindings(sessionDir, 'anatomy-park', 'anatomy-park.json');
    const anatomyFindings = anatomyArtifact.findings;
    const szechuanFindings = readPhaseFindings(sessionDir, 'szechuan-sauce', 'szechuan-sauce.json');
    const merged = dedupeCrossPhaseFindings([
        ...anatomyFindings,
        ...szechuanFindings.findings,
    ]);
    const findings = anatomyArtifact.missing
        ? [missingAnatomyParkFinding(), ...merged.findings]
        : merged.findings;
    return {
        findings,
        summary: {
            anatomy_park: anatomyFindings.length,
            szechuan_sauce: szechuanFindings.findings.length,
            duplicate_ids_deduped: merged.duplicates,
            duplicate_ids_renamed: 0,
            anatomy_park_missing: anatomyArtifact.missing,
        },
        szechuan_findings: szechuanFindings.findings,
    };
}
function readPhaseFindings(sessionDir, source, sourceFile) {
    if (!sessionDir)
        return { findings: [], missing: sourceFile === 'anatomy-park.json' };
    const artifactPath = path.join(sessionDir, sourceFile);
    let parsed;
    try {
        parsed = readRecoverableJsonObject(artifactPath);
    }
    catch {
        return { findings: [], missing: false };
    }
    if (!parsed) {
        return { findings: [], missing: sourceFile === 'anatomy-park.json' && !existsSync(artifactPath) };
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.findings))
        return { findings: [], missing: false };
    const findings = parsed.findings.flatMap((finding) => {
        if (!isRecord(finding) || typeof finding.id !== 'string' || !isSeverity(finding.severity))
            return [];
        return [{
                ...finding,
                id: finding.id,
                original_id: finding.id,
                severity: finding.severity,
                source,
                source_file: sourceFile,
            }];
    });
    return { findings, missing: false };
}
function missingAnatomyParkFinding() {
    return {
        id: 'anatomy-park:missing',
        original_id: 'anatomy-park:missing',
        severity: 'Low',
        source: 'anatomy-park',
        source_file: 'anatomy-park.json',
        message: 'anatomy-park.json is absent; skipping Citadel pattern-replay safety-net input.',
    };
}
function dedupeCrossPhaseFindings(findings) {
    const seen = new Set();
    const deduped = [];
    let duplicates = 0;
    for (const finding of findings) {
        if (seen.has(finding.original_id)) {
            duplicates += 1;
            continue;
        }
        seen.add(finding.original_id);
        deduped.push(finding);
    }
    return { findings: deduped, duplicates };
}
function uniqueFindings(findings) {
    const seen = new Set();
    return findings.map((finding) => {
        const id = uniqueFindingId(finding, seen);
        seen.add(id);
        return id === finding.id ? finding : { ...finding, id };
    });
}
function uniqueFindingId(finding, seen) {
    if (!seen.has(finding.id))
        return finding.id;
    const source = typeof finding.source === 'string'
        ? finding.source
        : typeof finding.source_section === 'string'
            ? finding.source_section
            : 'citadel';
    const base = `${source}:${finding.id}`;
    if (!seen.has(base))
        return base;
    let suffix = 2;
    while (seen.has(`${base}:${suffix}`))
        suffix += 1;
    return `${base}:${suffix}`;
}
function withFindingSource(finding, sourceSection) {
    return {
        ...finding,
        severity: isSeverity(finding.severity) ? finding.severity : 'Medium',
        source_section: sourceSection,
    };
}
function isSeverity(value) {
    return value === 'Critical' || value === 'High' || value === 'Medium' || value === 'Low';
}
let _analyzerOverridesForTests = null;
export function __setAnalyzerOverridesForTests(overrides) {
    _analyzerOverridesForTests = overrides;
}
function safeRunAnalyzer(id, run, shapeOpts) {
    if (shapeOpts?.analyzerCompatibility != null && shapeOpts.projectShapes) {
        const compatible = shapeOpts.analyzerCompatibility.some((s) => shapeOpts.projectShapes.includes(s));
        if (!compatible) {
            const required = shapeOpts.analyzerCompatibility.join(', ');
            const detected = shapeOpts.projectShapes.join(', ');
            return {
                findings: [],
                skipped: 'project_shape_mismatch',
                reason: `analyzer requires [${required}]; detected project shapes: [${detected}]`,
            };
        }
    }
    const override = _analyzerOverridesForTests?.get(id);
    const fn = override ?? run;
    try {
        return fn();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { findings: [{ id, severity: 'Low', analyzer_threw: true, message }], skipped: false };
    }
}
