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
    const prdMarkdown = resolvedPrdPath ? readFileSync(resolvedPrdPath, 'utf-8') : '';
    // ticket 98dc9bed F3.1: parseWithComposes already handles PRDs without a
    // composes: front-matter block. Swallowing ComposesError here masks malformed
    // compose graphs and audits the wrong PRD scope.
    const parsedPrd = resolvedPrdPath
        ? parseWithComposes(resolvedPrdPath, { repoRoot })
        : { decisions: [], acceptanceCriteria: [], endpoints: [], allowlistEntries: [], statusCodeRows: [], transitionAuditRows: [], composedRcodes: new Map() };
    const diff = walkDiff(options.diffRange, { repoRoot });
    const projectShapes = detectProjectShapes(repoRoot);
    const siblingAuth = auditSiblingAuthPreconditions(diff, { projectShapes });
    const frontendPropDrift = safeRunAnalyzer('citadel-frontend-prop-drift', () => auditFrontendPropDrift(diff), { analyzerCompatibility: ['react-frontend'], projectShapes });
    const acShape = resolvedPrdPath
        ? auditAcShape({ prdPath: resolvedPrdPath, sessionDir: options.sessionDir })
        : { findings: [], decisionsRequired: [], summary: { decisionsRequired: 0, highFindings: 0 } };
    const ruleSetInvariants = resolvedPrdPath
        ? auditRuleSetInvariants(diff, { repoRoot, prdMarkdown })
        : NO_PRD_SKIPPED;
    const crossPhase = readCrossPhaseFindings(options.sessionDir);
    const crossPhaseReport = {
        findings: crossPhase.findings,
        summary: crossPhase.summary,
    };
    const diffHygiene = auditDiffHygiene(diff, { szechuanFindings: crossPhase.szechuan_findings });
    const divergenceReconciliation = reconcileDivergences(diff);
    const acCoverage = resolvedPrdPath
        ? safeRunAnalyzer('citadel-ac-coverage', () => buildAcCoverageScorecard(parsedPrd.acceptanceCriteria, diff, { repoRoot }))
        : NO_PRD_SKIPPED;
    const allowlistDead = safeRunAnalyzer('citadel-allowlist-dead', () => detectAllowlistDeadEntries(diff, { repoRoot }));
    const stateTransitions = resolvedPrdPath
        ? safeRunAnalyzer('citadel-state-transitions', () => auditStateTransitions(parsedPrd.transitionAuditRows, diff, { repoRoot }))
        : NO_PRD_SKIPPED;
    const trapDoorCoverage = safeRunAnalyzer('citadel-trap-door', () => auditTrapDoorCoverage(diff));
    const endpointContractConformance = resolvedPrdPath
        ? safeRunAnalyzer('citadel-endpoint-contract', () => checkEndpointContractConformance(parsedPrd.endpoints, parsedPrd.statusCodeRows, { repoRoot }), { analyzerCompatibility: ['nestjs-api'], projectShapes })
        : NO_PRD_SKIPPED;
    const schemaRegistryDrift = safeRunAnalyzer('citadel-schema-registry-drift', () => auditSchemaRegistryDrift(diff));
    const testAuthenticity = safeRunAnalyzer('citadel-test-authenticity', () => auditTestAuthenticity(diff));
    const staleReference = safeRunAnalyzer('citadel-stale-reference', () => auditStaleReferences(diff));
    const crossfileBehaviorDrift = safeRunAnalyzer('citadel-crossfile-behavior-drift', () => auditCrossfileBehaviorDrift(diff));
    const bannedConstructs = safeRunAnalyzer('citadel-banned-constructs', () => auditBannedConstructs(diff));
    const bannedCasts = safeRunAnalyzer('citadel-banned-casts', () => auditBannedCasts(diff));
    const patternConformance = safeRunAnalyzer('citadel-pattern-conformance', () => auditPatternConformance(diff));
    const decisionRequired = [
        ...acShape.decisionsRequired,
        ...divergenceReconciliation.decisionsRequired,
    ];
    const findings = uniqueFindings([
        ...siblingAuth.findings.map((finding) => withFindingSource(finding, 'sibling_auth_preconditions')),
        ...frontendPropDrift.findings.map((finding) => withFindingSource(finding, 'frontend_prop_drift')),
        ...acShape.findings.map((finding) => withFindingSource(finding, 'ac_shape')),
        ...ruleSetInvariants.findings.map((finding) => withFindingSource(finding, 'rule_set_invariants')),
        ...diffHygiene.findings.map((finding) => withFindingSource(finding, 'diff_hygiene')),
        ...crossPhaseReport.findings,
        ...acCoverage.findings.map((finding) => withFindingSource(finding, 'ac_coverage')),
        ...allowlistDead.findings.map((finding) => withFindingSource(finding, 'allowlist_dead')),
        ...stateTransitions.findings.map((finding) => withFindingSource(finding, 'state_transitions')),
        ...trapDoorCoverage.findings.map((finding) => withFindingSource(finding, 'trap_door_coverage')),
        ...endpointContractConformance.findings.map((finding) => withFindingSource(finding, 'endpoint_contract_conformance')),
        ...schemaRegistryDrift.findings.map((finding) => withFindingSource(finding, 'schema_registry_drift')),
        ...testAuthenticity.findings.map((finding) => withFindingSource(finding, 'test_authenticity')),
        ...staleReference.findings.map((finding) => withFindingSource(finding, 'stale_reference')),
        ...crossfileBehaviorDrift.findings.map((finding) => withFindingSource(finding, 'crossfile_behavior_drift')),
        ...bannedConstructs.findings.map((finding) => withFindingSource(finding, 'banned_constructs')),
        ...bannedCasts.findings.map((finding) => withFindingSource(finding, 'banned_casts')),
        ...patternConformance.findings.map((finding) => withFindingSource(finding, 'pattern_conformance')),
    ]);
    const sections = {
        sibling_auth_preconditions: siblingAuth,
        frontend_prop_drift: frontendPropDrift,
        ac_shape: acShape,
        rule_set_invariants: ruleSetInvariants,
        diff_hygiene: diffHygiene,
        divergence_reconciliation: divergenceReconciliation,
        cross_phase: crossPhaseReport,
        ac_coverage: acCoverage,
        allowlist_dead: allowlistDead,
        state_transitions: stateTransitions,
        trap_door_coverage: trapDoorCoverage,
        endpoint_contract_conformance: endpointContractConformance,
        schema_registry_drift: schemaRegistryDrift,
        test_authenticity: testAuthenticity,
        stale_reference: staleReference,
        crossfile_behavior_drift: crossfileBehaviorDrift,
        banned_constructs: bannedConstructs,
        banned_casts: bannedCasts,
        pattern_conformance: patternConformance,
    };
    const reporter = new Reporter();
    return reporter.build({
        prdPath: resolvedPrdPath ?? '',
        diffRange: options.diffRange,
        header: buildCitadelReportHeader(options.sessionDir),
        sections,
        findings,
        decisions: decisionRequired,
        strict: options.strict,
    });
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
