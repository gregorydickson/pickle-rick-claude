// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import eslintConfig from '../eslint.config.js';
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
// M4 (GitHub #22): the judge is told the ENFORCED function-size ceiling
// ---------------------------------------------------------------------------
// The ceiling is read from eslint.config.js, never hand-copied, and the replay measures the real
// functions with eslint's own rule under noInlineConfig, so a scoped disable cannot hide one.

const EXTENSION_ROOT = path.resolve(import.meta.dirname, '..');
const SIZE_RULE = 'max-lines-per-function';
const STALE_SIZE_LIMIT_RE = /function.{0,20}(>|limit|hard limit).{0,5}50|50-line function/i;
const M4_LEDGER_FUNCTIONS = {
    'src/bin/mux-runner.ts': ['runMuxRunnerMain', 'checkPartialLifecycleExit', 'reapOrphanedManagersAtIterationStart', 'bootstrapSessionResources'],
    'src/services/citadel/audit-runner.ts': ['buildCitadelAuditReport'],
};

/** The unscoped base options plus each per-file override, as eslint.config.js enforces them. */
function enforcedSizeCeilings() {
    const entries = eslintConfig.filter((entry) => entry.rules?.[SIZE_RULE]);
    const base = entries.find((entry) => !entry.files);
    assert.ok(base, `eslint.config.js has no unscoped ${SIZE_RULE} entry`);
    const overrides = entries.filter((entry) => entry.files)
        .map((entry) => ({ files: entry.files, max: entry.rules[SIZE_RULE][1].max }));
    return { options: base.rules[SIZE_RULE][1], overrides };
}

/** Ledger functions the size rule reports under `options`; throws if a file fails to parse or a function is gone. */
function oversizedLedgerFunctions(options) {
    const reported = [];
    for (const [file, names] of Object.entries(M4_LEDGER_FUNCTIONS)) {
        const source = fs.readFileSync(path.join(EXTENSION_ROOT, file), 'utf-8');
        const messages = new Linter({ configType: 'flat', cwd: EXTENSION_ROOT }).verify(source, [{
            files: ['**/*.ts'],
            languageOptions: { parser: tseslint.parser },
            linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
            rules: { [SIZE_RULE]: ['error', options] },
        }], file);
        const fatal = messages.find((m) => m.fatal);
        if (fatal) throw new Error(`${file} did not parse, so it was not measured: ${fatal.message}`);
        for (const name of names) {
            assert.match(source, new RegExp(`function ${name}\\b`), `${name} is no longer in ${file}; the replay would pass vacuously`);
            if (messages.some((m) => m.ruleId === SIZE_RULE && m.message.includes(`'${name}'`))) reported.push(name);
        }
    }
    return reported.sort();
}

let enforcedReplay;
const replayUnderEnforcedRule = () => (enforcedReplay ??= oversizedLedgerFunctions(enforcedSizeCeilings().options));

test('M4-1: the principles file states the enforced code-line ceiling and every per-file exception', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    const { options, overrides } = enforcedSizeCeilings();
    assert.ok(options.skipBlankLines && options.skipComments, 'eslint no longer counts code lines only; revisit the prompt text');
    assert.ok(content.includes(`${options.max} code lines`), `principles must state the enforced ${options.max} code-line ceiling`);
    assert.ok(content.includes('skipComments'), 'principles must say comment lines do not count');
    assert.ok(overrides.length > 0, 'expected per-file max-lines-per-function overrides in eslint.config.js');
    for (const { files, max } of overrides) {
        assert.ok(content.includes(String(max)), `principles must name the ${max}-line exception`);
        for (const file of files) assert.ok(content.includes(file), `principles must name the exception file ${file}`);
    }
});

test('M4-4: no judge prompt, principles file or root CLAUDE.md states a 50-line function limit', () => {
    const commandsDir = path.resolve(EXTENSION_ROOT, '../.claude/commands');
    const prompts = [
        ...fs.readdirSync(EXTENSION_ROOT).filter((f) => /^szechuan-sauce.*principles\.md$/.test(f)).map((f) => path.join(EXTENSION_ROOT, f)),
        ...fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md')).map((f) => path.join(commandsDir, f)),
        path.resolve(EXTENSION_ROOT, '../CLAUDE.md'),
    ];
    assert.ok(prompts.length > 3, 'prompt corpus unexpectedly small; the scan would pass vacuously');
    const hits = prompts.flatMap((file) => fs.readFileSync(file, 'utf-8').split('\n')
        .map((line, i) => (STALE_SIZE_LIMIT_RE.test(line) ? `${path.basename(file)}:${i + 1}: ${line.trim()}` : null))
        .filter(Boolean));
    assert.deepEqual(hits, [], 'a prompt still states a function-size limit other than the enforced ceiling');
});

test('M4-3 (negative control): runMuxRunnerMain is still over the enforced ceiling', () => {
    assert.ok(replayUnderEnforcedRule().includes('runMuxRunnerMain'), 'tightening the count must not silence the real finding');
});

test('M4-2: replaying the five ledger functions under code-line counting yields exactly one violation', () => {
    assert.deepEqual(replayUnderEnforcedRule(), ['runMuxRunnerMain']);
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

// ---------------------------------------------------------------------------
// B-ROUTABLE ROOT R3: preservation replay. Three places this repo is ahead of
// an external bar (szechuan Part I/II, Migration Hygiene's four scored
// checks, anatomy-park's subsystem tracing) must not be silently narrowed by
// later edits to this bundle (R4 adds a sentence, R5 re-tiers three cells
// outside Migration Hygiene). AC-R3-4: if a replay below cannot be made to
// pass, that is a silenced finding to report, not a replay to adjust.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');

// AC-R3-1: this bundle's own start point. Diffing against a fixed historical
// sha (rather than a hand-copied line snapshot) means every later ticket in
// this bundle (R4, R5) is checked against the same baseline cumulatively, per
// AC-R3-1's "across this whole bundle" wording.
const PRESERVATION_BASELINE_SHA = '8e7a10f6809cac51cbf33dda42235652ea03a75c';
const PRINCIPLES_REL_PATH = 'extension/szechuan-sauce-principles.md';
const PART_I_HEADING = '## Part I: Clean Code';
const PART_III_HEADING = '## Part III: Reliability';

/** 1-based [start, end) line range covering Part I + Part II in the given file content. */
function partIAndIILineRange(content) {
    const lines = content.split('\n');
    const startIdx = lines.findIndex((l) => l.startsWith(PART_I_HEADING));
    const endIdx = lines.findIndex((l) => l.startsWith(PART_III_HEADING));
    assert.ok(startIdx >= 0, `${PART_I_HEADING} not found in baseline; the range probe would be vacuous`);
    assert.ok(endIdx > startIdx, `${PART_III_HEADING} not found after Part I; the range probe would be vacuous`);
    return { start: startIdx + 1, end: endIdx + 1 };
}

test('AC-R3-1: Parts I and II of the principles file lose no line since the bundle baseline', () => {
    let baselineContent;
    try {
        baselineContent = execSync(`git show ${PRESERVATION_BASELINE_SHA}:${PRINCIPLES_REL_PATH}`,
            { cwd: REPO_ROOT, encoding: 'utf-8' });
    } catch (err) {
        throw new Error(`baseline ${PRESERVATION_BASELINE_SHA} unreadable for ${PRINCIPLES_REL_PATH}: ${err.message}`);
    }
    const { start, end } = partIAndIILineRange(baselineContent);

    const diff = execSync(`git diff --unified=0 ${PRESERVATION_BASELINE_SHA} -- ${PRINCIPLES_REL_PATH}`,
        { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 });
    if (!diff) return; // nothing has changed since baseline yet

    const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;
    let oldLine = null;
    const removedInScope = [];
    for (const line of diff.split('\n')) {
        const hunkMatch = hunkHeaderRe.exec(line);
        if (hunkMatch) {
            oldLine = parseInt(hunkMatch[1], 10);
            continue;
        }
        if (oldLine === null || line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\')) continue;
        if (line.startsWith('-')) {
            if (oldLine >= start && oldLine < end) removedInScope.push(`line ${oldLine}: ${line.slice(1)}`);
            oldLine += 1;
        } else if (line.startsWith('+')) {
            // additions do not consume an old-file line number
        } else {
            oldLine += 1;
        }
    }
    assert.deepEqual(removedInScope, [],
        `AC-R3-4: Parts I/II lost line(s) since baseline ${PRESERVATION_BASELINE_SHA} — this is a silenced finding, do not adjust the replay:\n${removedInScope.join('\n')}`);
});

// AC-R3-2: Migration Hygiene lives in Part III (out of the Part I/II diff pin
// above) and must keep each of its four checks at its EXACT existing
// severity, not merely "some HIGH and some MEDIUM exist somewhere".
test('AC-R3-2: Migration Hygiene keeps its four scored checks at their existing severities', () => {
    const content = fs.readFileSync(PRINCIPLES_PATH, 'utf-8');
    const hygieneStart = content.indexOf('### Migration Hygiene');
    const hygieneEnd = content.indexOf('###', hygieneStart + 1);
    const section = content.slice(hygieneStart, hygieneEnd > -1 ? hygieneEnd : undefined);
    const checkRe = /\*\*([A-Za-z ]+?)\*\*\s*\((HIGH|MEDIUM|LOW)\)/g;
    const found = {};
    let m;
    while ((m = checkRe.exec(section)) !== null) found[m[1].trim()] = m[2];
    assert.deepEqual(found, {
        'CHECK Constraint Drift': 'HIGH',
        'Redundant Constraint Churn': 'MEDIUM',
        'Idempotency': 'MEDIUM',
        'Schema Drift': 'HIGH',
    }, 'AC-R3-4: a Migration Hygiene check severity drifted from its existing, ahead-of-the-bar tier — this is a silenced finding, do not adjust the replay');
});

// AC-R3-3/AC-R3-4 (szechuan half): runWorkerGate was a 196-line/171-code-line
// god function carrying its own max-lines-per-function eslint-disable before
// szechuan-sauce commit 16a203c5 split it. Replaying the pre-fix blob under
// the CURRENT enforced ceiling (via noInlineConfig, so the historical
// eslint-disable cannot hide it) proves the ceiling still catches this class.
const HISTORICAL_SZECHUAN_FIX_COMMIT = '16a203c5a11e5816d1f881c7002fd0709550b61a';
const HISTORICAL_SZECHUAN_FILE = 'src/bin/spawn-morty.ts';
const HISTORICAL_SZECHUAN_FUNCTION = 'runWorkerGate';

test('AC-R3-3 replay: the historical runWorkerGate god-function (16a203c5) still trips the enforced ceiling', () => {
    const source = execSync(
        `git show ${HISTORICAL_SZECHUAN_FIX_COMMIT}^:extension/${HISTORICAL_SZECHUAN_FILE}`,
        { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 20 }
    );
    assert.match(source, new RegExp(`function ${HISTORICAL_SZECHUAN_FUNCTION}\\b`),
        'the historical function is gone from the git blob; the replay would be vacuous');

    const { options } = enforcedSizeCeilings();
    const messages = new Linter({ configType: 'flat', cwd: EXTENSION_ROOT }).verify(source, [{
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
        rules: { [SIZE_RULE]: ['error', options] },
    }], HISTORICAL_SZECHUAN_FILE);
    const fatal = messages.find((m) => m.fatal);
    if (fatal) throw new Error(`${HISTORICAL_SZECHUAN_FILE}@${HISTORICAL_SZECHUAN_FIX_COMMIT}^ did not parse: ${fatal.message}`);
    const hit = messages.some((m) => m.ruleId === SIZE_RULE && m.message.includes(`'${HISTORICAL_SZECHUAN_FUNCTION}'`));
    assert.ok(hit,
        `AC-R3-4: the enforced ceiling no longer catches the historical ${HISTORICAL_SZECHUAN_FUNCTION} violation (${HISTORICAL_SZECHUAN_FIX_COMMIT}) — this is a silenced finding, do not adjust the replay`);
});

// AC-R3-3/AC-R3-4 (anatomy-park half): before commit 059ee673, config-protection's
// R-WSRC-GR git-verb gate approved `git update-ref`/`git symbolic-ref` HEAD
// mutations — plumbing that reaches the exact ref the porcelain verbs
// (reset/checkout/switch) were already blocked from touching. Confirm the
// CURRENT guard still blocks both, and (negative control) that the pre-fix
// guard genuinely approved them — otherwise this would not be a real replay.
const HISTORICAL_ANATOMY_FIX_COMMIT = '059ee6730d3924a57d515adce5f51dfbd06d2a9b';
const HISTORICAL_ANATOMY_BYPASS_COMMANDS = [
    'git update-ref HEAD HEAD~2',
    'git symbolic-ref HEAD refs/heads/other',
];

test('AC-R3-3 replay: the historical R-WSRC-GR ref-mutation bypass (059ee673) is still blocked', async () => {
    const { detectProhibitedGitVerb } = await import('../hooks/handlers/config-protection.js');
    for (const command of HISTORICAL_ANATOMY_BYPASS_COMMANDS) {
        assert.ok(detectProhibitedGitVerb(command),
            `AC-R3-4: current config-protection no longer blocks "${command}" — this is a silenced finding (${HISTORICAL_ANATOMY_FIX_COMMIT}), do not adjust the replay`);
    }
});

test('AC-R3-3 replay (negative control): the pre-fix guard genuinely approved the historical bypass', async () => {
    const oldSource = execSync(
        `git show ${HISTORICAL_ANATOMY_FIX_COMMIT}^:extension/hooks/handlers/config-protection.js`,
        { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 20 }
    );
    // Written as a real sibling module file (not a data: URL) so the blob's
    // own relative imports (./resolve-state.js etc.) resolve normally.
    const handlersDir = path.dirname(fs.realpathSync(path.resolve(EXTENSION_ROOT, 'hooks/handlers/config-protection.js')));
    const tmpFile = path.join(handlersDir, `__replay_ap_critical_${process.pid}.mjs`);
    fs.writeFileSync(tmpFile, oldSource);
    try {
        const old = await import(pathToFileURL(tmpFile).href);
        for (const command of HISTORICAL_ANATOMY_BYPASS_COMMANDS) {
            assert.equal(old.detectProhibitedGitVerb(command), null,
                `replay setup is wrong: "${command}" was already blocked before ${HISTORICAL_ANATOMY_FIX_COMMIT}, so this is not a real historical violation`);
        }
    } finally {
        fs.rmSync(tmpFile, { force: true });
    }
});
