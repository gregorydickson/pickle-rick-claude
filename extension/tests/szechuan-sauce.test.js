// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
    createMicroverseState,
    writeMicroverseState,
    readMicroverseState,
    isConverged,
} from '../services/microverse-state.js';

// ---------------------------------------------------------------------------
// Szechuan Sauce command prompt validation
// ---------------------------------------------------------------------------

const COMMAND_PATH = path.resolve(import.meta.dirname, '../../.claude/commands/szechuan-sauce.md');

function readCommand() {
    return fs.readFileSync(COMMAND_PATH, 'utf-8');
}

test('szechuan-sauce.md exists and is readable', () => {
    assert.ok(fs.existsSync(COMMAND_PATH), `missing: ${COMMAND_PATH}`);
    const content = readCommand();
    assert.ok(content.length > 100, 'command file appears empty');
});

test('szechuan-sauce.md has no --interactive flag references', () => {
    const content = readCommand();
    assert.ok(!content.includes('--interactive'), 'interactive mode should be removed');
    assert.ok(!content.includes('INTERACTIVE'), 'INTERACTIVE variable should be removed');
});

test('szechuan-sauce.md has Setup and Worker modes', () => {
    const content = readCommand();
    assert.ok(content.includes('## SETUP MODE'), 'missing Setup Mode section');
    assert.ok(content.includes('## WORKER MODE'), 'missing Worker Mode section');
});

test('szechuan-sauce.md Worker Mode references microverse protocol', () => {
    const content = readCommand();
    // Worker mode should delegate to the shared microverse worker protocol
    assert.ok(
        content.includes('Microverse Worker protocol') || content.includes('microverse.md'),
        'Worker Mode should reference the shared microverse protocol'
    );
});

test('szechuan-sauce.md Worker Mode defines szechuan-specific overrides', () => {
    const content = readCommand();
    assert.ok(content.includes('szechuan-sauce-principles.md'), 'should reference principles file');
    assert.ok(content.includes('szechuan-sauce:'), 'should define commit message format');
});

test('szechuan-sauce.md defines diff-hygiene gate output contract', () => {
    const content = readCommand();
    assert.ok(content.includes('### Override 4: Diff Hygiene'), 'missing diff hygiene override');
    assert.ok(content.includes('ROOT_MARKDOWN_ALLOWLIST'), 'should reference shared markdown allowlist');
    assert.ok(content.includes('ENV_FILE_ALLOWLIST'), 'should reference env allowlist');
    assert.ok(content.includes('LARGE_FILE_BYTES'), 'should reference large-file threshold');
    assert.ok(content.includes("category: 'hygiene'"), 'hygiene findings must be category-tagged');
    assert.ok(content.includes('root `notes.md` produces a P1 finding'), 'notes.md P1 contract must be explicit');
});

test('szechuan-sauce.md defines trap-door-as-test enforcement contract', () => {
    const content = readCommand();
    assert.ok(content.includes('### Override 5: Trap-Door-as-Test Enforcement'), 'missing trap-door enforcement override');
    assert.ok(content.includes("git diff -- CLAUDE.md '**/CLAUDE.md'"), 'should read CLAUDE.md bullets from git diff');
    assert.ok(content.includes('pattern_shape') && content.includes('PATTERN_SHAPE'), 'should require pattern shape metadata');
    assert.ok(content.includes('negative spec test'), 'should require negative spec coverage');
    assert.ok(content.includes('trap door documented but not enforced'), 'should define exact P0 finding message');
    assert.ok(content.includes("category: 'trap-door-enforcement'"), 'should tag trap-door findings');
    assert.ok(content.includes('claude_md_file') && content.includes('bullet_text'), 'should expose dedupe fields');
    assert.ok(content.includes('(claude_md_file, bullet_text)'), 'should document Citadel T6 dedupe tuple');
});

test('szechuan-sauce.md Setup Mode steps are sequentially numbered', () => {
    const content = readCommand();
    // Extract setup section
    const setupStart = content.indexOf('## SETUP MODE');
    const workerStart = content.indexOf('## WORKER MODE');
    const setup = content.slice(setupStart, workerStart);
    // Steps should be numbered 1 through N without gaps
    const stepNumbers = [...setup.matchAll(/### Step (\d+)/g)].map(m => Number(m[1]));
    assert.ok(stepNumbers.length >= 5, `expected at least 5 steps, found ${stepNumbers.length}`);
    for (let i = 0; i < stepNumbers.length; i++) {
        assert.equal(stepNumbers[i], i + 1, `step ${i + 1} should be numbered ${i + 1}, got ${stepNumbers[i]}`);
    }
});

test('szechuan-sauce.md has no step numbering overlap between modes', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    const workerSection = content.slice(workerStart);
    // Worker mode should use Override numbering, not Step numbering that could clash
    const workerSteps = [...workerSection.matchAll(/### Step (\d+)/g)];
    assert.equal(workerSteps.length, 0, 'Worker Mode should not use "Step N" numbering (uses Override numbering instead)');
});

// ---------------------------------------------------------------------------
// Principles file validation
// ---------------------------------------------------------------------------

const PRINCIPLES_PATH = path.resolve(import.meta.dirname, '../szechuan-sauce-principles.md');

test('szechuan-sauce-principles.md exists', () => {
    assert.ok(fs.existsSync(PRINCIPLES_PATH), `missing: ${PRINCIPLES_PATH}`);
});

test('principles file has priority matrix', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('## Priority Matrix'), 'missing Priority Matrix section');
    assert.ok(content.includes('P0'), 'missing P0 priority');
    assert.ok(content.includes('P4'), 'missing P4 priority');
});

test('principles file has diagnostic guide', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('## Quick Diagnostic Guide'), 'missing Quick Diagnostic Guide');
});

// ---------------------------------------------------------------------------
// init-microverse: gap_analysis_path populated
// ---------------------------------------------------------------------------

test('init-microverse sets gap_analysis_path when run via CLI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-szechuan-init-'));
    try {
        const initScript = path.resolve(import.meta.dirname, '../bin/init-microverse.js');
        const targetPath = '/tmp/fake-target';
        execSync(
            `node ${initScript} ${dir} ${targetPath} --stall-limit 3 --convergence-target 0`,
            { stdio: 'pipe' }
        );
        const state = readMicroverseState(dir);
        assert.ok(state, 'microverse.json should exist');
        assert.equal(state.gap_analysis_path, path.join(dir, 'gap_analysis.md'),
            'gap_analysis_path should be set to session_dir/gap_analysis.md');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('init-microverse sets convergence_target when provided', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-szechuan-conv-'));
    try {
        const initScript = path.resolve(import.meta.dirname, '../bin/init-microverse.js');
        execSync(
            `node ${initScript} ${dir} /tmp/target --convergence-target 0`,
            { stdio: 'pipe' }
        );
        const state = readMicroverseState(dir);
        assert.ok(state, 'microverse.json should exist');
        assert.equal(state.convergence_target, 0, 'convergence_target should be 0');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('init-microverse uses LLM type and lower direction by default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-szechuan-metric-'));
    try {
        const initScript = path.resolve(import.meta.dirname, '../bin/init-microverse.js');
        execSync(
            `node ${initScript} ${dir} /tmp/target`,
            { stdio: 'pipe' }
        );
        const state = readMicroverseState(dir);
        assert.ok(state, 'microverse.json should exist');
        assert.equal(state.key_metric.type, 'llm', 'default metric type should be llm');
        assert.equal(state.key_metric.direction, 'lower', 'default direction should be lower');
        assert.equal(state.key_metric.judge_model, undefined, 'default metric must let backend choose its judge model');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// init-microverse: judge_context_path
// ---------------------------------------------------------------------------

test('init-microverse sets judge_context_path when --judge-context provided', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-szechuan-judge-'));
    try {
        const initScript = path.resolve(import.meta.dirname, '../bin/init-microverse.js');
        execSync(
            `node ${initScript} ${dir} /tmp/target --judge-context /tmp/principles.md`,
            { stdio: 'pipe' }
        );
        const state = readMicroverseState(dir);
        assert.ok(state, 'microverse.json should exist');
        assert.equal(state.judge_context_path, '/tmp/principles.md',
            'judge_context_path should match --judge-context value');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('init-microverse omits judge_context_path when --judge-context not provided', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-szechuan-nojudge-'));
    try {
        const initScript = path.resolve(import.meta.dirname, '../bin/init-microverse.js');
        execSync(
            `node ${initScript} ${dir} /tmp/target`,
            { stdio: 'pipe' }
        );
        const state = readMicroverseState(dir);
        assert.ok(state, 'microverse.json should exist');
        assert.equal(state.judge_context_path, undefined,
            'judge_context_path should not be set when flag is absent');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// szechuan-sauce.md: workers must not call update-state.js (runner owns state)
// ---------------------------------------------------------------------------

// The needle this guard used to carry — the bare phrase `update-state.js iteration`
// — never existed in the artifact. The block 4b7abab1 removed spelled it
// `update-state.js" iteration` (a closing quote before the space), so reinstating
// that block verbatim left the guard GREEN. A negative anchor is a claim about a
// SPELLING; pin the shape instead. A doc INSTRUCTION to run something is written as
// CODE (a fence or an inline span); prose that merely NAMES the script — this rule's
// own prohibition — puts the bare name in a span with no argument after it. So the
// invariant needs no vocabulary list: no code region in the worker section may spell
// update-state.js with an argument.
function codeRegions(markdown) {
    const regions = [];
    const fenced = /```[^\n]*\n([\s\S]*?)```/g;
    let rest = '';
    let last = 0;
    for (let m = fenced.exec(markdown); m; m = fenced.exec(markdown)) {
        regions.push(m[1]);
        rest += markdown.slice(last, m.index);
        last = m.index + m[0].length;
    }
    rest += markdown.slice(last);
    for (const m of rest.matchAll(/`([^`\n]+)`/g)) regions.push(m[1]);
    return regions;
}

test('szechuan-sauce.md Worker Mode does not instruct workers to call update-state.js', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    assert.notEqual(workerStart, -1,
        'the "## WORKER MODE" anchor moved — slice(-1) would reduce this guard to one character');
    const regions = codeRegions(content.slice(workerStart));
    const invocations = regions.filter((r) => /update-state\.js["'`]?\s+\S/.test(r));
    assert.deepEqual(invocations, [],
        'Worker should not call update-state.js — runner manages state');
});

// ---------------------------------------------------------------------------
// isConverged: convergence_target == 0 triggers exit
// ---------------------------------------------------------------------------

test('isConverged returns true when last accepted score equals convergence_target 0', () => {
    const state = createMicroverseState({ prdPath: '/tmp/target', metric: {
        description: 'violations',
        validation: 'count',
        type: 'llm',
        timeout_seconds: 60,
        tolerance: 0,
        direction: 'lower',
    }, stallLimit: 5, convergenceTarget: 0 });
    state.baseline_score = 10;
    state.convergence.history = [
        { iteration: 1, metric_value: '0', score: 0, action: 'accept', description: 'fixed all', pre_iteration_sha: 'abc', timestamp: new Date().toISOString() },
    ];
    assert.equal(isConverged(state), 'target', 'should converge when score equals convergence_target');
});

test('isConverged returns false when last accepted score does not equal convergence_target', () => {
    const state = createMicroverseState({ prdPath: '/tmp/target', metric: {
        description: 'violations',
        validation: 'count',
        type: 'llm',
        timeout_seconds: 60,
        tolerance: 0,
        direction: 'lower',
    }, stallLimit: 5, convergenceTarget: 0 });
    state.baseline_score = 10;
    state.convergence.history = [
        { iteration: 1, metric_value: '3', score: 3, action: 'accept', description: 'some fixes', pre_iteration_sha: 'abc', timestamp: new Date().toISOString() },
    ];
    assert.equal(isConverged(state), null, 'should not converge when score > convergence_target');
});

// ---------------------------------------------------------------------------
// isConverged: direction-aware convergence_target (not just strict equality)
// ---------------------------------------------------------------------------

test('isConverged returns true when score overshoots convergence_target (lower direction)', () => {
    // If target is 0 and score is -1 (overshot), should still converge
    const state = createMicroverseState({ prdPath: '/tmp/target', metric: {
        description: 'violations',
        validation: 'count',
        type: 'llm',
        timeout_seconds: 60,
        tolerance: 0,
        direction: 'lower',
    }, stallLimit: 5, convergenceTarget: 0 });
    state.baseline_score = 10;
    state.convergence.history = [
        { iteration: 1, metric_value: '-1', score: -1, action: 'accept', description: 'overshot', pre_iteration_sha: 'abc', timestamp: new Date().toISOString() },
    ];
    assert.equal(isConverged(state), 'target', 'should converge when score undershoots target in lower direction');
});

test('isConverged returns true when score overshoots convergence_target (higher direction)', () => {
    const state = createMicroverseState({ prdPath: '/tmp/target', metric: {
        description: 'coverage',
        validation: 'test coverage',
        type: 'command',
        timeout_seconds: 60,
        tolerance: 0,
        direction: 'higher',
    }, stallLimit: 5, convergenceTarget: 90 });
    state.baseline_score = 50;
    state.convergence.history = [
        { iteration: 1, metric_value: '95', score: 95, action: 'accept', description: 'exceeded target', pre_iteration_sha: 'abc', timestamp: new Date().toISOString() },
    ];
    assert.equal(isConverged(state), 'target', 'should converge when score exceeds target in higher direction');
});

test('isConverged returns false when score has not reached target (higher direction)', () => {
    const state = createMicroverseState({ prdPath: '/tmp/target', metric: {
        description: 'coverage',
        validation: 'test coverage',
        type: 'command',
        timeout_seconds: 60,
        tolerance: 0,
        direction: 'higher',
    }, stallLimit: 5, convergenceTarget: 90 });
    state.baseline_score = 50;
    state.convergence.history = [
        { iteration: 1, metric_value: '70', score: 70, action: 'accept', description: 'partial', pre_iteration_sha: 'abc', timestamp: new Date().toISOString() },
    ];
    assert.equal(isConverged(state), null, 'should not converge when score < target in higher direction');
});

// ---------------------------------------------------------------------------
// Financial domain principles file
// ---------------------------------------------------------------------------

const FINANCIAL_PRINCIPLES_PATH = path.resolve(import.meta.dirname, '../szechuan-sauce-financial-principles.md');

test('szechuan-sauce-financial-principles.md exists', () => {
    assert.ok(fs.existsSync(FINANCIAL_PRINCIPLES_PATH), `missing: ${FINANCIAL_PRINCIPLES_PATH}`);
});

test('financial principles file has priority matrix', () => {
    const content = fs.readFileSync(FINANCIAL_PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('## Priority Matrix'), 'missing Priority Matrix section');
    assert.ok(content.includes('P0'), 'missing P0 priority');
});

test('financial principles file has diagnostic guide', () => {
    const content = fs.readFileSync(FINANCIAL_PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('## Quick Diagnostic Guide'), 'missing Quick Diagnostic Guide');
});

// ---------------------------------------------------------------------------
// UI domain principles file (AC-PIAP-B3-1)
// ---------------------------------------------------------------------------

const UI_PRINCIPLES_PATH = path.resolve(import.meta.dirname, '../szechuan-sauce-ui-principles.md');

test('szechuan-sauce-ui-principles.md exists', () => {
    assert.ok(fs.existsSync(UI_PRINCIPLES_PATH), `missing: ${UI_PRINCIPLES_PATH}`);
});

test('ui principles file has priority matrix', () => {
    const content = fs.readFileSync(UI_PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('## Priority Matrix'), 'missing Priority Matrix section');
    assert.ok(content.includes('P0'), 'missing P0 priority');
});

test('ui principles file has diagnostic guide', () => {
    const content = fs.readFileSync(UI_PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('## Quick Diagnostic Guide'), 'missing Quick Diagnostic Guide');
});

test('ui principles file codifies four core principles', () => {
    const content = fs.readFileSync(UI_PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('Author Intent'), 'missing Author Intent principle');
    assert.ok(
        content.includes('Magic-Number') || content.includes('magic-number'),
        'missing Magic-Number Spacing principle',
    );
    assert.ok(content.includes('Component Uniqueness'), 'missing Component Uniqueness principle');
    assert.ok(
        content.includes('Markup Structure') || content.includes('markup'),
        'missing Markup Structure principle',
    );
});

test('ui principles file has False Positives section', () => {
    const content = fs.readFileSync(UI_PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('False Positives'), 'missing False Positives section');
});

test('szechuan-sauce.md has --design-safe flag in argument parsing', () => {
    const content = readCommand();
    assert.ok(content.includes('--design-safe'), 'missing --design-safe flag');
    assert.ok(content.includes('DESIGN_SAFE'), 'missing DESIGN_SAFE variable');
});

test('szechuan-sauce.md Step 8 includes ui-principles when DESIGN_SAFE is set', () => {
    const content = readCommand();
    const setupStart = content.indexOf('## SETUP MODE');
    const workerStart = content.indexOf('## WORKER MODE');
    const setup = content.slice(setupStart, workerStart);
    assert.ok(setup.includes('szechuan-sauce-ui-principles.md'), 'Step 8 should reference ui-principles');
    assert.ok(setup.includes('DESIGN_SAFE'), 'Step 8 should reference DESIGN_SAFE');
});

test('szechuan-sauce.md Worker Override 1 handles design_safe microverse field', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    const workerSection = content.slice(workerStart);
    assert.ok(workerSection.includes('design_safe'), 'Worker Override 1 should check microverse.json design_safe field');
    assert.ok(workerSection.includes('szechuan-sauce-ui-principles.md'), 'Worker Override 1 should reference ui-principles file');
});

// ---------------------------------------------------------------------------
// --focus flag validation
// ---------------------------------------------------------------------------

test('szechuan-sauce.md has --focus flag in argument parsing', () => {
    const content = readCommand();
    assert.ok(content.includes('--focus'), 'missing --focus flag');
    assert.ok(content.includes('FOCUS'), 'missing FOCUS variable');
});

test('szechuan-sauce.md --focus injects Focus Directive into judge context', () => {
    const content = readCommand();
    assert.ok(content.includes('## Focus Directive'), 'missing Focus Directive section in judge context assembly');
});

test('szechuan-sauce.md --focus elevates matching violations by one priority level', () => {
    const content = readCommand();
    assert.ok(content.includes('elevated by one priority level'), 'missing priority elevation rule for focus');
});

test('szechuan-sauce.md Worker Mode Override 1 handles focus directive', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    const workerSection = content.slice(workerStart);
    assert.ok(workerSection.includes('Focus Directive'), 'Worker Override 1 should reference Focus Directive');
});

// ---------------------------------------------------------------------------
// Dependency Health and Test Quality principles (ported from meeseeks)
// ---------------------------------------------------------------------------

test('principles file has Dependency Health section', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('### Dependency Health'), 'missing Dependency Health principle');
    assert.ok(content.includes('CVE'), 'Dependency Health should mention CVEs');
    assert.ok(content.includes('phantom'), 'Dependency Health should mention phantom deps');
    assert.ok(content.includes('lockfile'), 'Dependency Health should mention lockfile integrity');
});

test('principles file has Test Quality section', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('### Test Quality'), 'missing Test Quality principle');
    assert.ok(content.includes('Tautological'), 'Test Quality should mention tautological assertions');
    assert.ok(content.includes('flaky') || content.includes('Flaky'), 'Test Quality should mention flaky tests');
    assert.ok(content.includes('boundary') || content.includes('Boundary'), 'Test Quality should mention boundary conditions');
});

// ---------------------------------------------------------------------------
// Migration Hygiene dimension
// ---------------------------------------------------------------------------

test('principles file has Migration Hygiene section', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('### Migration Hygiene'), 'missing Migration Hygiene principle');
});

test('principles file Migration Hygiene defines four checks', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('CHECK Constraint Drift'), 'missing CHECK Constraint Drift check');
    assert.ok(content.includes('Redundant Constraint Churn'), 'missing Redundant Constraint Churn check');
    assert.ok(content.includes('Idempotency') && content.includes('IF NOT EXISTS'), 'missing Idempotency check');
    assert.ok(content.includes('Schema Drift'), 'missing Schema Drift check');
});

test('principles file Migration Hygiene is conditional on Drizzle journal', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    assert.ok(content.includes('_journal.json'), 'should reference Drizzle migration journal');
    assert.ok(content.includes('Conditional'), 'should be marked as conditional');
});

test('principles file Migration Hygiene scores as HIGH or MEDIUM only', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    const hygieneStart = content.indexOf('### Migration Hygiene');
    const hygieneEnd = content.indexOf('###', hygieneStart + 1);
    const section = content.slice(hygieneStart, hygieneEnd > -1 ? hygieneEnd : undefined);
    assert.ok(section.includes('HIGH'), 'should have HIGH severity findings');
    assert.ok(section.includes('MEDIUM'), 'should have MEDIUM severity findings');
    // Should not introduce LOW or OPTIONAL for this dimension
    assert.ok(!section.includes('(LOW)'), 'should not have LOW severity');
});

test('principles file Migration Hygiene does not duplicate CI lint checks', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    const hygieneStart = content.indexOf('### Migration Hygiene');
    const hygieneEnd = content.indexOf('###', hygieneStart + 1);
    const section = content.slice(hygieneStart, hygieneEnd > -1 ? hygieneEnd : undefined);
    assert.ok(section.includes('validate-migrations.ts'), 'should reference CI lint script exclusion');
});

test('szechuan-sauce.md Worker Mode has Migration Hygiene override', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    const workerSection = content.slice(workerStart);
    assert.ok(workerSection.includes('Migration Hygiene'), 'Worker Mode should have Migration Hygiene override');
    assert.ok(workerSection.includes('_journal.json'), 'should check for Drizzle journal');
});

test('szechuan-sauce.md Migration Hygiene override is conditional', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    const workerSection = content.slice(workerStart);
    // Must check for journal existence before applying
    assert.ok(
        workerSection.includes('If none of these paths resolve, skip this override entirely') ||
            workerSection.includes('If it does NOT exist, skip'),
        'Migration Hygiene must be skipped when no Drizzle journal found'
    );
});

test('Override 6 monorepo journal globbing', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    const workerSection = content.slice(workerStart);
    assert.ok(workerSection.includes('db/migrations/meta/_journal.json'), 'missing legacy root journal path');
    assert.ok(
        workerSection.includes('packages/*/db/migrations/meta/_journal.json'),
        'missing packages monorepo journal path'
    );
    assert.ok(
        workerSection.includes('apps/*/db/migrations/meta/_journal.json'),
        'missing apps monorepo journal path'
    );
    assert.ok(
        workerSection.includes('services/*/db/migrations/meta/_journal.json'),
        'missing services monorepo journal path'
    );
    assert.ok(workerSection.includes('iterate each discovered journal'), 'should run checks per discovered journal');
});

test('Override 6 absent journal still skips', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    const workerSection = content.slice(workerStart);
    assert.ok(workerSection.includes('If none of these paths resolve, skip this override entirely'));
});

test('szechuan-sauce.md Migration Hygiene override defines all four checks', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    const workerSection = content.slice(workerStart);
    assert.ok(workerSection.includes('CHECK Constraint Drift'), 'missing CHECK Constraint Drift');
    assert.ok(workerSection.includes('Redundant Constraint Churn'), 'missing Redundant Constraint Churn');
    assert.ok(workerSection.includes('Idempotency'), 'missing Idempotency');
    assert.ok(workerSection.includes('Schema Drift'), 'missing Schema Drift');
});

test('szechuan-sauce.md Migration Hygiene excludes CI lint overlap', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    const workerSection = content.slice(workerStart);
    assert.ok(workerSection.includes('validate-migrations.ts'), 'should reference CI lint exclusion');
});

test('Override 6 Schema Drift uses monorepo sibling schema path', () => {
    const content = readCommand();
    const workerStart = content.indexOf('## WORKER MODE');
    const workerSection = content.slice(workerStart);
    assert.ok(
        workerSection.includes('packages/api/src/database/schema/*.ts'),
        'missing monorepo schema TS example'
    );
    assert.ok(
        workerSection.includes('packages/api/db/migrations/*.sql'),
        'missing monorepo migration SQL example'
    );
    assert.ok(
        workerSection.includes("not root-level `db/schema/*.ts`"),
        'should explicitly reject root-level schema path for the monorepo example'
    );
});

// ---------------------------------------------------------------------------
// Dry-run format validation
// ---------------------------------------------------------------------------

test('szechuan-sauce.md dry-run section includes priority buckets', () => {
    const content = readCommand();
    assert.ok(content.includes('### P0: Critical'), 'missing P0 bucket in dry-run format');
    assert.ok(content.includes('### P1: High'), 'missing P1 bucket in dry-run format');
    assert.ok(content.includes('### P2: Medium'), 'missing P2 bucket in dry-run format');
    assert.ok(content.includes('### P3: Low'), 'missing P3 bucket in dry-run format');
    assert.ok(content.includes('### P4: Optional'), 'missing P4 bucket in dry-run format');
});

test('szechuan-sauce.md has dry-run mode in Setup', () => {
    const content = readCommand();
    assert.ok(content.includes('--dry-run'), 'missing --dry-run flag');
    assert.ok(content.includes('DRY_RUN'), 'missing DRY_RUN variable');
});

// ---------------------------------------------------------------------------
// init-microverse: --metric-json accepts custom metric
// ---------------------------------------------------------------------------

test('init-microverse accepts --metric-json for custom metrics', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-szechuan-custom-'));
    try {
        const initScript = path.resolve(import.meta.dirname, '../bin/init-microverse.js');
        const customMetric = JSON.stringify({
            description: 'test coverage',
            validation: 'npm test -- --coverage',
            type: 'command',
            timeout_seconds: 120,
            tolerance: 1,
            direction: 'higher',
        });
        execSync(
            `node ${initScript} ${dir} /tmp/target --stall-limit 3 --metric-json '${customMetric}'`,
            { stdio: 'pipe' }
        );
        const state = readMicroverseState(dir);
        assert.ok(state, 'microverse.json should exist');
        assert.equal(state.key_metric.type, 'command', 'should use custom metric type');
        assert.equal(state.key_metric.direction, 'higher', 'should use custom direction');
        assert.equal(state.key_metric.tolerance, 1, 'should use custom tolerance');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER46-01 ENFORCE — the citadel cross-phase reader vs. the shape the
// szechuan PRODUCER writes (replay of AP-EXT-ITER45-01 on the sibling artifact).
//
// `readPhaseFindings` (`src/services/citadel/audit-runner.ts`) harvests a TOP-LEVEL
// `findings` array out of `szechuan-sauce.json`, and `auditDiffHygiene` builds its
// suppression index from the same array. Since 650bd933 the prompt has MANDATED
// content for that file ("MUST include `category: 'hygiene'` in `szechuan-sauce.json`")
// without ever instructing the worker to write it — no producer exists anywhere in the
// repo — so the harvest is structurally zero and, unlike anatomy-park.json, no `missing`
// breadcrumb fires (`missing` is set for anatomy only). Override 8 is the producer half.
//
// The second case is the load-bearing one and it is NOT hand-authored: it derives the
// findings from the shared rule source `auditSzechuanDiffHygiene`, which is what the
// worker is pointed at in Override 4. That canonical shape stamps `severity: 'P0'` —
// which `isSeverity` rejects entry-and-all — so copying it verbatim harvests zero. Only
// the Override 8 severity mapping makes it through the shipped reader.
// ---------------------------------------------------------------------------

test('szechuan-sauce.md defines the citadel findings hand-off contract', () => {
    const content = readCommand();
    assert.ok(
        content.includes('### Override 8: Citadel Findings Hand-off (`szechuan-sauce.json`)'),
        'missing citadel hand-off override — citadel harvests zero szechuan findings without it'
    );
    assert.ok(content.includes('TOP-LEVEL `findings` array'), 'must name the top-level findings array as the harvested key');
    assert.ok(content.includes('Nothing else in the pipeline writes this file'), 'must state that the worker is the only producer');
    assert.ok(
        content.includes('`P0` → `"Critical"`') && content.includes('`P1` →') && content.includes('`P3`/`P4` → `"Low"`'),
        'must define the P-scale to citadel-severity mapping'
    );
    assert.ok(content.includes('dropped ENTRY AND ALL'), 'must warn that an unmapped severity drops the whole record');
    assert.ok(content.includes('Rewrite, do not append'), 'must define the array as an open-violation projection');
});

test('canonical szechuan hygiene findings reach citadel only through the Override 8 severity mapping', async () => {
    const { auditSzechuanDiffHygiene } = await import('../services/citadel/diff-hygiene.js');
    const { runCitadelAudit } = await import('../services/citadel/audit-runner.js');

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'szechuan-crossphase-repo-'));
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'szechuan-crossphase-session-'));
    const git = (args) => execSync(`git ${args}`, { cwd: repoRoot, stdio: 'pipe', timeout: 15000 });
    try {
        fs.writeFileSync(path.join(repoRoot, 'prd.md'), '# PRD\n\n## Acceptance Criteria\n\n**AC-TEST-01**: Stable.\n');
        git('init -q');
        git('config user.email test@example.com');
        git('config user.name "Test User"');
        git('add .');
        git('commit -qm base');
        const base = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8', timeout: 15000 }).trim();
        // `notes.md` is the exact Override 4 example: an orphan root markdown, P1.
        fs.writeFileSync(path.join(repoRoot, 'notes.md'), 'scratch\n');
        git('add .');
        git('commit -qm head');

        const diffRange = `${base}..HEAD`;
        const audit = async () => (await runCitadelAudit({
            prdPath: 'prd.md', diffRange, repoRoot, sessionDir,
        })).sections.cross_phase;

        // The shared rule source the worker is told to mirror — not a fixture.
        const canonical = auditSzechuanDiffHygiene({
            repoRoot,
            changedFiles: [{ path: 'notes.md', status: 'A' }],
        }).findings;
        assert.ok(canonical.length > 0, 'shared rule source should flag the orphan root markdown');
        assert.equal(canonical[0].severity, canonical[0].priority, 'canonical shape stamps the P-scale into severity itself');

        const artifactPath = path.join(sessionDir, 'szechuan-sauce.json');

        // Unmapped: every entry is dropped entry-and-all, and nothing announces it.
        fs.writeFileSync(artifactPath, JSON.stringify({ findings: canonical }, null, 2));
        const unmapped = await audit();
        assert.equal(unmapped.summary.szechuan_sauce, 0, 'P-spelled severities harvest as zero');

        // Mapped per Override 8: same findings, citadel severity spelling.
        const P_TO_CITADEL = { P0: 'Critical', P1: 'High', P2: 'Medium', P3: 'Low', P4: 'Low' };
        const mapped = canonical.map((f) => ({ ...f, severity: P_TO_CITADEL[f.priority] }));
        fs.writeFileSync(artifactPath, JSON.stringify({ findings: mapped }, null, 2));
        const harvested = await audit();
        assert.equal(harvested.summary.szechuan_sauce, mapped.length, 'mapped severities harvest through the shipped reader');
        assert.ok(
            harvested.findings.some((f) => f.source === 'szechuan-sauce' && f.original_id === canonical[0].id),
            'harvested finding keeps its producer id'
        );

        // The same array is the diff-hygiene suppression index: without it citadel
        // re-reports the added file that szechuan already reported.
        fs.rmSync(artifactPath);
        const unsuppressed = await runCitadelAudit({ prdPath: 'prd.md', diffRange, repoRoot, sessionDir });
        assert.equal(unsuppressed.sections.diff_hygiene.summary.suppressed_by_szechuan, 0, 'no artifact means no suppression');
        fs.writeFileSync(artifactPath, JSON.stringify({ findings: mapped }, null, 2));
        const suppressed = await runCitadelAudit({ prdPath: 'prd.md', diffRange, repoRoot, sessionDir });
        assert.ok(
            suppressed.sections.diff_hygiene.summary.suppressed_by_szechuan > 0,
            'the Override 8 artifact must feed the T10.9 dedupe'
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});
