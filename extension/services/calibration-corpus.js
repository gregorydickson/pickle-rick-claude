import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateCourseCorrectionProposal } from '../bin/correct-course.js';
import { extractAcceptanceCriteria, isMachineCheckable } from '../bin/check-readiness.js';
import { readRecoverableJsonObject } from './recoverable-json.js';
export const CALIBRATION_SUITES = ['readiness', 'correct-course'];
export const CALIBRATION_SCHEMA_VERSION = 1;
export const DEFAULT_CALIBRATION_DRIFT_THRESHOLD_PCT = 5;
const RECALIBRATION_TRIGGERS = {
    readiness: [
        'extension/src/bin/check-readiness.ts heuristic or fixture changes',
        'ticket acceptance-criteria machinability rules change',
    ],
    'correct-course': [
        'extension/src/bin/correct-course.ts proposal validator changes',
        'course-correction proposal contract section changes',
    ],
};
export function calibrationBaselinePath(extensionRoot, suite) {
    return path.join(extensionRoot, 'tests', 'calibration', suite, 'baseline.json');
}
export function loadCalibrationThresholdPct(extensionRoot) {
    const raw = readRecoverableJsonObject(path.join(extensionRoot, '..', 'pickle_settings.json'));
    const hardening = readRecord(raw?.bmad_hardening);
    const calibration = readRecord(hardening?.calibration);
    const threshold = calibration?.drift_threshold_pct;
    return typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0
        ? threshold
        : DEFAULT_CALIBRATION_DRIFT_THRESHOLD_PCT;
}
export function buildCalibrationBaseline(suite, options) {
    assertKnownSuite(suite);
    const fixtureResults = evaluateSuite(suite, options.extensionRoot);
    return {
        schema_version: CALIBRATION_SCHEMA_VERSION,
        suite,
        generated_at: (options.now ?? new Date()).toISOString(),
        generator: {
            command: `npm run calibrate:${suite}`,
            source: 'extension/src/services/calibration-corpus.ts',
        },
        recalibration_triggers: RECALIBRATION_TRIGGERS[suite],
        threshold_pct: loadCalibrationThresholdPct(options.extensionRoot),
        metrics: aggregateMetrics(fixtureResults),
        fixture_results: fixtureResults,
    };
}
export function writeCalibrationBaseline(extensionRoot, suite, now = new Date()) {
    const baseline = buildCalibrationBaseline(suite, { extensionRoot, now });
    const baselinePath = calibrationBaselinePath(extensionRoot, suite);
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    return baseline;
}
export function checkCalibrationDrift(extensionRoot, suite) {
    assertKnownSuite(suite);
    const baselinePath = calibrationBaselinePath(extensionRoot, suite);
    const current = buildCalibrationBaseline(suite, { extensionRoot });
    const baseline = readBaselineFile(baselinePath);
    const thresholdPct = loadCalibrationThresholdPct(extensionRoot);
    const entries = compareMetrics(baseline.metrics, current.metrics);
    const maxDriftPct = entries.reduce((max, entry) => Math.max(max, entry.drift_pct), 0);
    return {
        suite,
        baselinePath,
        thresholdPct,
        maxDriftPct,
        passed: maxDriftPct <= thresholdPct,
        entries,
        current,
        baseline,
    };
}
export function assertKnownSuite(value) {
    if (!CALIBRATION_SUITES.includes(value)) {
        throw new Error(`Unknown calibration suite ${JSON.stringify(value)}. Expected one of: ${CALIBRATION_SUITES.join(', ')}`);
    }
}
function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function readBaselineFile(baselinePath) {
    const parsed = readRecoverableJsonObject(baselinePath);
    if (!parsed)
        throw new Error(`Missing or invalid calibration baseline: ${baselinePath}`);
    const baseline = parsed;
    if (baseline.schema_version !== CALIBRATION_SCHEMA_VERSION) {
        throw new Error(`Unsupported calibration baseline schema at ${baselinePath}`);
    }
    if (!baseline.suite || !CALIBRATION_SUITES.includes(baseline.suite)) {
        throw new Error(`Invalid calibration suite in ${baselinePath}`);
    }
    if (!readRecord(baseline.metrics)) {
        throw new Error(`Missing calibration metrics in ${baselinePath}`);
    }
    return baseline;
}
function compareMetrics(baseline, current) {
    const keys = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
    return keys.map((metric) => {
        const baselineValue = baseline[metric];
        const currentValue = current[metric];
        const validBaseline = typeof baselineValue === 'number' && Number.isFinite(baselineValue) ? baselineValue : 0;
        const validCurrent = typeof currentValue === 'number' && Number.isFinite(currentValue) ? currentValue : 0;
        const denominator = Math.max(1, Math.abs(validBaseline));
        return {
            metric,
            baseline: validBaseline,
            current: validCurrent,
            drift_pct: roundPct(Math.abs(validCurrent - validBaseline) / denominator * 100),
        };
    });
}
function aggregateMetrics(results) {
    const totals = {
        fixture_count: results.length,
    };
    for (const result of results) {
        for (const [key, value] of Object.entries(result.metrics)) {
            totals[key] = roundMetric((totals[key] ?? 0) + value);
        }
    }
    return totals;
}
function evaluateSuite(suite, extensionRoot) {
    if (suite === 'readiness')
        return evaluateReadinessFixtures();
    return evaluateCorrectCourseFixtures(extensionRoot);
}
function evaluateReadinessFixtures() {
    const fixtures = [
        {
            name: 'machine-checkable-ac',
            markdown: [
                '## Acceptance Criteria',
                '- [ ] Command exits 0 exactly and writes `readiness_2026-04-30.md`.',
                '- [ ] JSON field `status` equals `pass`.',
            ].join('\n'),
        },
        {
            name: 'prose-only-ac',
            markdown: [
                '## Acceptance Criteria',
                '- [ ] The workflow should feel intuitive.',
                '- [ ] The report must be clear.',
            ].join('\n'),
        },
        {
            name: 'mixed-ac',
            markdown: [
                '## Acceptance Criteria',
                '- [ ] `node --test tests/check-readiness.test.js` exits 0.',
                '- [ ] The output should be robust.',
                '- [ ] Table contains exactly 3 rows.',
            ].join('\n'),
        },
    ];
    return fixtures.map((fixture) => {
        const criteria = extractAcceptanceCriteria(fixture.markdown);
        const machineCheckable = criteria.filter(isMachineCheckable).length;
        return {
            name: fixture.name,
            metrics: {
                criteria_total: criteria.length,
                machine_checkable: machineCheckable,
                non_machine_checkable: criteria.length - machineCheckable,
            },
        };
    });
}
function evaluateCorrectCourseFixtures(extensionRoot) {
    const sessionRoot = path.join(extensionRoot, 'tests', '__fixtures__', 'calibration', 'correct-course-session');
    const validProposal = [
        '## Discovery Summary',
        'The ticket tree needs a redirect because scope changed.',
        '',
        '## Impact Map',
        '- kept ticket: `abc123`',
        '- modified ticket: `def456`',
        '',
        '## Artifact Diffs',
        '- No artifact diffs.',
        '',
        '## Restart Point',
        'Continue at ticket `abc123`.',
    ].join('\n');
    const invalidProposal = [
        '## Discovery Summary',
        '',
        '',
        '## Impact Map',
        '',
        '',
        '## Restart Point',
        'null because no restart point is needed.',
    ].join('\n');
    const fixtures = [
        { name: 'valid-ticket-references', proposal: validProposal, discovery: 'scope changed', expectedPassed: true },
        { name: 'missing-impact-map-references', proposal: invalidProposal, discovery: 'scope changed', expectedPassed: false },
    ];
    return fixtures.map((fixture) => {
        const result = validateCourseCorrectionProposal({
            sessionRoot,
            proposalContent: fixture.proposal,
            discoveryStatement: fixture.discovery,
        });
        return {
            name: fixture.name,
            metrics: {
                passed: result.passed ? 1 : 0,
                expected_match: result.passed === fixture.expectedPassed ? 1 : 0,
                referenced_ticket_ids: result.referencedTicketIds.length,
                failures: result.failures.length,
            },
        };
    });
}
function roundPct(value) {
    return Math.round(value * 100) / 100;
}
function roundMetric(value) {
    return Math.round(value * 1_000_000) / 1_000_000;
}
