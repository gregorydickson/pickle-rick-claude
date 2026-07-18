// @tier: fast
// F5 / R-APV-1 / B-FOMC WS-4: spawn-refinement-team must wire
// checkAnalystOutputPaths into manifest build so unverified backticked
// citations surface as ticket_quality_warnings BEFORE the readiness gate
// halts the pipeline. The checker is ADVISORY ONLY — it blocks nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    checkAnalystOutputPaths,
    scanAnalystOutputsForUnverifiedPaths,
    UNATTRIBUTED_TICKET_ID,
    __resetGitLsFilesSuffixCacheForTests,
    countContentLines,
    findStaleAnchorWarnings,
} from '../bin/spawn-refinement-team.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function tmpDir(prefix = 'pickle-apv-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'real-file.ts'), '// real\n');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

test('scanAnalystOutputsForUnverifiedPaths: emits path_not_found for a phantom backticked path', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const refinementDir = tmpDir('pickle-apv-refine-');
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        // Analyst output cites a path that does NOT exist at HEAD and is NOT annotated.
        fs.writeFileSync(
            path.join(refinementDir, 'analysis_codebase.md'),
            '# Analysis\n\nCitation: `extension/services/phantom.ts` — does not exist anywhere.\n'
        );
        const warnings = scanAnalystOutputsForUnverifiedPaths(refinementDir, workingDir);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].defect_class, 'path_not_found');
        assert.match(warnings[0].evidence, /analyst=codebase/);
        assert.match(warnings[0].evidence, /extension\/services\/phantom\.ts/);
        assert.equal(warnings[0].source, 'analyst');
        assert.equal(warnings[0].file_line, 'analysis_codebase.md');
        assert.equal(warnings[0].analyst, 'codebase');
        // No analysis_codebase_c<N>.md archive exists in this fixture, so this is cycle 1.
        assert.equal(warnings[0].cycle, 1);
        assert.equal(warnings[0].ticket_id, UNATTRIBUTED_TICKET_ID);
    } finally {
        fs.rmSync(refinementDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

test('scanAnalystOutputsForUnverifiedPaths: ignores non-canonical (per-cycle) files for citation scanning, but reads them for cycle attribution', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const refinementDir = tmpDir('pickle-apv-refine-');
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        // Per-cycle file should NOT be scanned for citations (synthesis uses canonical only).
        fs.writeFileSync(
            path.join(refinementDir, 'analysis_codebase_c1.md'),
            '# Analysis cycle 1\n\nCitation: `extension/services/phantom-c1.ts`\n'
        );
        const warnings = scanAnalystOutputsForUnverifiedPaths(refinementDir, workingDir);
        assert.equal(warnings.length, 0);
    } finally {
        fs.rmSync(refinementDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

test('scanAnalystOutputsForUnverifiedPaths: emits path_not_found when citing a real-but-untracked path', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const refinementDir = tmpDir('pickle-apv-refine-');
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        // Create the file but don't track it via git — suffix resolution finds nothing.
        fs.writeFileSync(path.join(workingDir, 'untracked.ts'), '// new\n');
        fs.writeFileSync(
            path.join(refinementDir, 'analysis_codebase.md'),
            '# Analysis\n\nCitation: `extension/services/untracked.ts`\n'
        );
        const warnings = scanAnalystOutputsForUnverifiedPaths(refinementDir, workingDir);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].defect_class, 'path_not_found');
        assert.match(warnings[0].evidence, /extension\/services\/untracked\.ts/);
    } finally {
        fs.rmSync(refinementDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

test('scanAnalystOutputsForUnverifiedPaths: derives cycle from the highest analysis_<role>_c<N>.md archive', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const refinementDir = tmpDir('pickle-apv-refine-');
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        const content = '# Analysis\n\nCitation: `extension/services/phantom.ts`\n';
        fs.writeFileSync(path.join(refinementDir, 'analysis_codebase_c1.md'), content);
        fs.writeFileSync(path.join(refinementDir, 'analysis_codebase_c2.md'), content);
        fs.writeFileSync(path.join(refinementDir, 'analysis_codebase_c3.md'), content);
        fs.writeFileSync(path.join(refinementDir, 'analysis_codebase.md'), content);
        const warnings = scanAnalystOutputsForUnverifiedPaths(refinementDir, workingDir);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].cycle, 3);
    } finally {
        fs.rmSync(refinementDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

// --- AC-FOMC-8a: extension-gated token matching -----------------------------

test('AC-FOMC-8a: a token without a file extension is not a citation at all', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        const content = 'See `R-JPCM/WS-2`, `B-RLH/WS-1..5`, and `MICROVERSE_FATAL/FAILURE_REASONS`.\n';
        const warnings = checkAnalystOutputPaths(content, workingDir);
        assert.equal(warnings.length, 0);
    } finally {
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

// --- AC-FOMC-8b: suffix-based resolution, repo-agnostic ---------------------

test('AC-FOMC-8b: suffix resolution finds a bare basename or a partial relative path with no hardcoded prefix', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        spawnSync('git', ['init', '-q'], { cwd: workingDir });
        spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workingDir });
        spawnSync('git', ['config', 'user.name', 'Test'], { cwd: workingDir });
        fs.mkdirSync(path.join(workingDir, 'extension', 'tests'), { recursive: true });
        fs.mkdirSync(path.join(workingDir, 'extension', 'src', 'types'), { recursive: true });
        fs.writeFileSync(path.join(workingDir, 'extension', 'tests', 'microverse.test.js'), '// test\n');
        fs.writeFileSync(path.join(workingDir, 'extension', 'src', 'types', 'index.ts'), '// types\n');
        spawnSync('git', ['add', '.'], { cwd: workingDir });
        spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: workingDir });

        const content = 'Cited: `tests/microverse.test.js` and `types/index.ts`.\n';
        const warnings = checkAnalystOutputPaths(content, workingDir);
        assert.equal(warnings.length, 0);
    } finally {
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

test('AC-FOMC-8b (invariant guard): resolution logic carries no hardcoded extension/ or extension/src/ prefix', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'bin', 'spawn-refinement-team.ts'), 'utf-8');
    assert.doesNotMatch(source, /ls-files.*'extension\/|'extension\/' \+/);
});

// --- AC-FOMC-8c: file:line parsing + line_out_of_range -----------------------

test('AC-FOMC-8c: a file:line citation past the file end-of-line count is line_out_of_range', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        fs.mkdirSync(path.join(workingDir, 'extension', 'src', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(workingDir, 'extension', 'src', 'bin', 'microverse-runner.ts'), 'line1\nline2\nline3\n');
        spawnSync('git', ['add', '.'], { cwd: workingDir });
        spawnSync('git', ['commit', '-q', '-m', 'add file'], { cwd: workingDir });

        const content = 'Cited: `microverse-runner.ts:99999`.\n';
        const warnings = checkAnalystOutputPaths(content, workingDir);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].defect_class, 'line_out_of_range');
        assert.equal(warnings[0].line, 99999);
    } finally {
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

test('AC-FOMC-8c: a file:line citation within range produces no warning', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        fs.mkdirSync(path.join(workingDir, 'extension', 'src', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(workingDir, 'extension', 'src', 'bin', 'microverse-runner.ts'), 'line1\nline2\nline3\n');
        spawnSync('git', ['add', '.'], { cwd: workingDir });
        spawnSync('git', ['commit', '-q', '-m', 'add file'], { cwd: workingDir });

        const content = 'Cited: `microverse-runner.ts:2`.\n';
        const warnings = checkAnalystOutputPaths(content, workingDir);
        assert.equal(warnings.length, 0);
    } finally {
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

// --- AC-FOMC-8d: ambiguous suffix match --------------------------------------

test('AC-FOMC-8d: >1 tracked suffix match emits ambiguous_citation, never a silent first-pick', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        spawnSync('git', ['init', '-q'], { cwd: workingDir });
        spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workingDir });
        spawnSync('git', ['config', 'user.name', 'Test'], { cwd: workingDir });
        fs.mkdirSync(path.join(workingDir, 'a'), { recursive: true });
        fs.mkdirSync(path.join(workingDir, 'b'), { recursive: true });
        fs.writeFileSync(path.join(workingDir, 'a', 'activity-events.schema.json'), '{}');
        fs.writeFileSync(path.join(workingDir, 'b', 'activity-events.schema.json'), '{}');
        spawnSync('git', ['add', '.'], { cwd: workingDir });
        spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: workingDir });

        const content = 'Cited: `activity-events.schema.json`.\n';
        const warnings = checkAnalystOutputPaths(content, workingDir);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].defect_class, 'ambiguous_citation');
        assert.equal(warnings[0].path, 'activity-events.schema.json');
    } finally {
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

// --- AC-FOMC-9: defect_class split, analyst/cycle fields, ticket_id sentinel -
// ticket_id carries UNATTRIBUTED_TICKET_ID, not '': these warnings have no
// owning ticket, but refinement-manifest.schema.json requires ticket_id with
// minLength: 1, so '' would fail ajv over the whole manifest.

test('AC-FOMC-9: not_tracked_forward_created is distinguished from a bare path_not_found fabrication', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        const content =
            'Fabrication: `does-not-exist.ts` is cited as if real.\n' +
            'Proposal: **Rename the surviving helper module to `citadel/changed-source-helpers.ts`**.\n';
        const warnings = checkAnalystOutputPaths(content, workingDir);
        assert.equal(warnings.length, 2);
        const byPath = Object.fromEntries(warnings.map((w) => [w.path, w.defect_class]));
        assert.equal(byPath['does-not-exist.ts'], 'path_not_found');
        assert.equal(byPath['citadel/changed-source-helpers.ts'], 'not_tracked_forward_created');
    } finally {
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

test('AC-FOMC-9: scanAnalystOutputsForUnverifiedPaths surfaces analyst + cycle as dedicated fields, ticket_id is the unattributed sentinel', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const refinementDir = tmpDir('pickle-apv-refine-');
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        fs.writeFileSync(
            path.join(refinementDir, 'analysis_requirements.md'),
            '# Analysis\n\nCitation: `phantom-req.ts`\n'
        );
        const warnings = scanAnalystOutputsForUnverifiedPaths(refinementDir, workingDir);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].analyst, 'requirements');
        assert.equal(typeof warnings[0].cycle, 'number');
        assert.equal(warnings[0].ticket_id, UNATTRIBUTED_TICKET_ID);
        assert.ok(['path_not_found', 'line_out_of_range', 'not_tracked_forward_created', 'ambiguous_citation']
            .includes(warnings[0].defect_class));
    } finally {
        fs.rmSync(refinementDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

// --- AC-FOMC-14: memoized + timeout-bounded git ls-files ---------------------

test('AC-FOMC-14: repeating the same token spawns git ls-files exactly once', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const workingDir = tmpDir('pickle-apv-work-');
    const shimDir = tmpDir('pickle-apv-shim-');
    const counterFile = path.join(shimDir, 'count.txt');
    try {
        initGitRepo(workingDir);
        const realGit = spawnSync('which', ['git'], { encoding: 'utf-8' }).stdout.trim();
        fs.writeFileSync(
            path.join(shimDir, 'git'),
            `#!/bin/sh\nprintf 'x' >> "${counterFile}"\nexec "${realGit}" "$@"\n`
        );
        fs.chmodSync(path.join(shimDir, 'git'), 0o755);

        const content = 'Cited 6 times: `same-token.ts` `same-token.ts` `same-token.ts` `same-token.ts` `same-token.ts` `same-token.ts`\n';
        const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}` };
        const script =
            `const { checkAnalystOutputPaths } = require(${JSON.stringify(path.resolve(__dirname, '..', 'bin', 'spawn-refinement-team.js'))});\n` +
            `checkAnalystOutputPaths(${JSON.stringify(content)}, ${JSON.stringify(workingDir)});\n`;
        const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf-8' });
        assert.equal(result.status, 0, result.stderr);
        const spawnCount = fs.existsSync(counterFile) ? fs.readFileSync(counterFile, 'utf-8').length : 0;
        assert.equal(spawnCount, 1);
    } finally {
        fs.rmSync(workingDir, { recursive: true, force: true });
        fs.rmSync(shimDir, { recursive: true, force: true });
    }
});

// --- AP-RMS-9: uniform subprocess-timeout pin --------------------------------
//
// bin/CLAUDE.md contract #3: every subprocess spawn passes a finite `timeout`.
// This replaces the two hand-enumerated per-callsite assertions (git ls-files,
// runReadinessGate). Enumerating call sites by hand is exactly why the third
// one — `readHeadFile`'s `git show HEAD:<path>`, on the main refinement path,
// once per PRD citation — shipped unbounded: no assertion named it, so nothing
// went red. A per-callsite pin can only defend the callsites someone
// remembered. This scans them all, so a NEW spawn is red by default.
//
// `spawn()` (the analyst worker) is exempt by construction: it is async, takes
// no `timeout` option, and is bounded by an explicit SIGTERM/SIGKILL
// escalation plus a hangGuard. The exemption is asserted, not assumed.
const SYNC_SPAWN_RE = /\b(execFileSync|execSync|spawnSync)\s*\(/g;

function readRefinementSource() {
    return fs.readFileSync(path.resolve(__dirname, '..', 'src', 'bin', 'spawn-refinement-team.ts'), 'utf-8');
}

// Slice from a call's opening paren to its balanced close, so the options
// object is inside the window regardless of how the call is formatted.
function callExpressionAt(source, openParenIndex) {
    let depth = 0;
    for (let i = openParenIndex; i < source.length; i += 1) {
        if (source[i] === '(') depth += 1;
        else if (source[i] === ')') {
            depth -= 1;
            if (depth === 0) return source.slice(openParenIndex, i + 1);
        }
    }
    return source.slice(openParenIndex);
}

function syncSpawnCallSites(source) {
    const sites = [];
    SYNC_SPAWN_RE.lastIndex = 0;
    let match;
    while ((match = SYNC_SPAWN_RE.exec(source)) !== null) {
        const openParen = source.indexOf('(', match.index);
        sites.push({
            fn: match[1],
            line: source.slice(0, match.index).split('\n').length,
            text: callExpressionAt(source, openParen),
        });
    }
    return sites;
}

test('AP-RMS-9: EVERY synchronous subprocess spawn carries a finite timeout', () => {
    const source = readRefinementSource();
    const sites = syncSpawnCallSites(source);
    assert.ok(sites.length >= 3, `expected the known sync spawn sites, found ${sites.length}`);
    const unbounded = sites
        .filter((s) => !/\btimeout:\s*[A-Za-z0-9_]/.test(s.text))
        .map((s) => `${s.fn} at spawn-refinement-team.ts:${s.line}`);
    assert.deepEqual(unbounded, [], `unbounded subprocess spawn(s): ${unbounded.join(', ')}`);
});

test('AP-RMS-9: the async analyst spawn is bounded by explicit kill escalation', () => {
    const source = readRefinementSource();
    // Not a `timeout:` option — prove the escalation that stands in for one.
    assert.match(source, /\.kill\('SIGTERM'\)/, 'expected a SIGTERM escalation for the async worker spawn');
    assert.match(source, /\.kill\('SIGKILL'\)/, 'expected a SIGKILL escalation for the async worker spawn');
});

// --- Regression corpus: replay the preserved 44-warning baseline ------------
//
// Fixture files are byte-identical copies of the canonical (cycle-3) analyst
// outputs from the preserved baseline session
// ~/.local/share/pickle-rick/sessions/2026-07-14-ef12a95a/refinement_round1/,
// whose refinement_manifest.round1.json recorded exactly 44
// analyst_path_not_verified warnings against the OLD root-anchored,
// slash-mandatory, no-extension-gate checker. workingDir is this repo itself
// (the same repo the baseline was measured against).
//
// The repaired checker also now resolves ~3x more citations than before (the
// 81% of bare-basename/file:line citations the old regex never even matched),
// so this is NOT a 44-vs-0 comparison — it is a real reduction plus new,
// previously-invisible coverage. Measured 2026-07-14: 28 total warnings (down
// from 44), none carrying the old generic 'analyst_path_not_verified' class.
test('regression corpus: the preserved 44-warning baseline collapses well below its original count, each survivor with a specific defect_class', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const refinementDir = path.join(__dirname, 'fixtures', 'b-fomc-baseline-corpus');
    const warnings = scanAnalystOutputsForUnverifiedPaths(refinementDir, REPO_ROOT);

    // Generous upper bound over the measured 28 — guards against a future
    // regression that reintroduces the old checker's blindness/over-warning,
    // without pinning to a brittle exact count as the repo's own file layout
    // (CLAUDE.md count, package.json count, ...) naturally drifts over time.
    assert.ok(
        warnings.length <= 40,
        `expected the baseline to collapse well below 44 warnings, got ${warnings.length}`
    );
    assert.ok(warnings.length < 44, 'expected a real reduction from the original 44-warning baseline');

    const validClasses = new Set(['path_not_found', 'line_out_of_range', 'not_tracked_forward_created', 'ambiguous_citation']);
    for (const w of warnings) {
        assert.ok(validClasses.has(w.defect_class), `unexpected defect_class: ${w.defect_class}`);
        assert.notEqual(w.defect_class, 'analyst_path_not_verified');
        assert.ok(typeof w.analyst === 'string' && w.analyst.length > 0);
        assert.ok(typeof w.cycle === 'number');
        assert.equal(w.ticket_id, UNATTRIBUTED_TICKET_ID);
    }

    // The originally-misresolved (root-anchoring false positives) baseline
    // paths must now resolve cleanly via suffix matching — this is the core
    // claim of AC-FOMC-8b, hand-verified 2026-07-14.
    const flaggedPaths = new Set(warnings.map((w) => w.evidence));
    for (const shouldResolve of [
        'tests/microverse.test.js',
        'types/index.ts',
        'bin/spawn-gate-remediator.ts',
        'services/citadel/mechanical-finding-classifier.ts',
    ]) {
        for (const evidence of flaggedPaths) {
            assert.ok(
                !evidence.includes(`path=${shouldResolve}`),
                `${shouldResolve} should resolve cleanly via suffix match, but was flagged: ${evidence}`
            );
        }
    }

    // The proposal-to-rename citation must classify as a forward-created
    // proposal, not a bare fabrication (this is the R-RAFC distinction the
    // whole bundle exists to make).
    const forwardCreated = warnings.filter((w) => w.defect_class === 'not_tracked_forward_created');
    assert.ok(
        forwardCreated.some((w) => w.evidence.includes('changed-source-helpers.ts')),
        'expected citadel/changed-source-helpers.ts (or its bare form) to classify as not_tracked_forward_created'
    );
});

// --- AP-RMS-3: ticket_id sentinel vs refinement-manifest.schema.json --------
// Every writer into `manifest.ticket_quality_warnings` must emit a ticket_id
// the schema accepts (required, minLength: 1). Two writers emitted `''`.
// ajv validates the manifest as ONE document, so a single '' entry fails the
// whole manifest, not just the offending warning.

const SCHEMA_PATH = path.resolve(__dirname, '../src/types/refinement-manifest.schema.json');
const REFINE_SRC_PATH = path.resolve(__dirname, '../src/bin/spawn-refinement-team.ts');

/** Item-level constraints read from the REAL schema, not a local restatement. */
function warningItemSchema() {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
    return schema.properties.ticket_quality_warnings.items;
}

function schemaFailuresFor(entry, items) {
    const failures = [];
    for (const key of items.required) {
        const spec = items.properties[key];
        const value = entry[key];
        if (typeof value !== 'string') {
            failures.push(`${key}: expected string, got ${typeof value}`);
            continue;
        }
        if (typeof spec.minLength === 'number' && value.length < spec.minLength) {
            failures.push(`${key}: length ${value.length} < minLength ${spec.minLength}`);
        }
    }
    return failures;
}

test('AP-RMS-3: the schema still requires a non-empty ticket_id (guards the assertions below)', () => {
    const items = warningItemSchema();
    assert.ok(items.required.includes('ticket_id'), 'ticket_id must stay required');
    assert.equal(items.properties.ticket_id.minLength, 1, 'ticket_id must keep minLength: 1');
});

test('AP-RMS-3: analyst-path warnings carry a schema-valid ticket_id', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const refinementDir = tmpDir('pickle-apv-refine-');
    // Non-repo working dir: `git ls-files` fails, so the cited path resolves to
    // zero tracked matches and the scanner emits a path_not_found warning.
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        fs.writeFileSync(
            path.join(refinementDir, 'analysis_architect.md'),
            'The fix belongs in `src/does/not/exist.ts`.\n'
        );

        const warnings = scanAnalystOutputsForUnverifiedPaths(refinementDir, workingDir);
        assert.ok(warnings.length > 0, 'fixture must actually produce a warning');

        const items = warningItemSchema();
        for (const warning of warnings) {
            const failures = schemaFailuresFor(warning, items);
            assert.deepEqual(
                failures,
                [],
                `warning violates refinement-manifest.schema.json: ${JSON.stringify(warning)} -> ${failures.join('; ')}`
            );
        }
    } finally {
        fs.rmSync(refinementDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

test('AP-RMS-3: no writer emits the empty-string ticket_id', () => {
    const src = fs.readFileSync(REFINE_SRC_PATH, 'utf-8');
    assert.ok(
        !/ticket_id:\s*''/.test(src),
        "ticket_id: '' is schema-invalid (minLength: 1) — use UNATTRIBUTED_TICKET_ID"
    );
});

test('AP-RMS-3: the sentinel itself satisfies the schema', () => {
    const items = warningItemSchema();
    const failures = schemaFailuresFor(
        { ticket_id: UNATTRIBUTED_TICKET_ID, defect_class: 'probe', evidence: 'probe' },
        items
    );
    assert.deepEqual(failures, [], 'UNATTRIBUTED_TICKET_ID must be a valid ticket_id');
});

// --- AP-RMS-6: RefinementManifest root keys vs refinement-manifest.schema.json
// The schema sets additionalProperties:false at the manifest root, so any key
// present on the TS interface but absent from schema.properties fails ajv over
// the WHOLE manifest. Two keys already drifted (AP-RMS-1 discovery,
// AP-RMS-7 replay); the schema fix is fenced out of the active scope, so they
// are PINNED here. This assertion is an equality, not a subset check: a third
// undeclared key breaks the build instead of silently joining the backlog.

/** Root keys the TS interface declares but the schema does not — known-open, fenced. */
const KNOWN_UNDECLARED_MANIFEST_KEYS = ['decomposition_quality_flags', 'prd_advisory_shape_concerns'];

/**
 * Property names off a real interface in the TS source. ONE extractor for every
 * schema-drift pin: a per-pin copy would let the character class drift again
 * (the AP-RMS-6 red-check caught a `[a-z_]+` blind to digits/camelCase).
 */
function interfaceKeys(interfaceName) {
    const src = fs.readFileSync(REFINE_SRC_PATH, 'utf-8');
    const start = src.indexOf(`export interface ${interfaceName}`);
    assert.notEqual(start, -1, `${interfaceName} interface must exist in spawn-refinement-team.ts`);
    const body = src.slice(start, src.indexOf('\n}', start));
    return [...body.matchAll(/^ {2}([A-Za-z0-9_]+)\??:/gm)].map((m) => m[1]);
}

/** Keys the interface declares that the strict schema object does not. */
function undeclaredKeys(interfaceName, schemaObject) {
    const declared = Object.keys(schemaObject.properties);
    return interfaceKeys(interfaceName).filter((k) => !declared.includes(k));
}

test('AP-RMS-6: the manifest root still forbids additional properties (guards the assertion below)', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
    assert.equal(schema.additionalProperties, false, 'manifest root must keep additionalProperties: false');
});

test('AP-RMS-6: no NEW manifest root key drifts from the schema', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
    const undeclared = undeclaredKeys('RefinementManifest', schema);

    assert.deepEqual(
        undeclared.slice().sort(),
        KNOWN_UNDECLARED_MANIFEST_KEYS.slice().sort(),
        'RefinementManifest gained or lost an undeclared root key. A NEW key must be added to ' +
            'refinement-manifest.schema.json properties (additionalProperties:false fails the whole ' +
            'manifest otherwise). A key that disappeared here was fixed — drop it from ' +
            'KNOWN_UNDECLARED_MANIFEST_KEYS.'
    );
});

test('AP-RMS-6: every pinned key is genuinely written by buildRefinementManifest', () => {
    // Guards the pin itself: if a key is stale (no longer emitted), the pin
    // must shrink rather than mask a real schema gap forever.
    const src = fs.readFileSync(REFINE_SRC_PATH, 'utf-8');
    for (const key of KNOWN_UNDECLARED_MANIFEST_KEYS) {
        assert.ok(
            new RegExp(`\\b${key}\\b`).test(src),
            `${key} is pinned as known-undeclared but no longer appears in spawn-refinement-team.ts`
        );
    }
});

// --- AP-RMS-8: warning-ITEM keys vs refinement-manifest.schema.json ----------
// AP-RMS-6 pinned the manifest ROOT. `ticket_quality_warnings.items` is the
// second strict object in the same schema and carries the same two-key drift
// (AP-RMS-2), but nothing pinned it: `schemaFailuresFor` above iterates
// `items.required`, so it is structurally blind to EXTRA properties. Without
// this equality a third item key joins the fenced backlog as silently as
// `decomposition_quality_flags` did.

/** Item keys the TS interface declares but the schema does not — known-open, fenced. */
const KNOWN_UNDECLARED_WARNING_ITEM_KEYS = ['analyst', 'cycle'];

test('AP-RMS-8: the warning item still forbids additional properties (guards the assertion below)', () => {
    assert.equal(
        warningItemSchema().additionalProperties,
        false,
        'ticket_quality_warnings.items must keep additionalProperties: false'
    );
});

test('AP-RMS-8: no NEW warning-item key drifts from the schema', () => {
    const undeclared = undeclaredKeys('TicketQualityWarning', warningItemSchema());

    assert.deepEqual(
        undeclared.slice().sort(),
        KNOWN_UNDECLARED_WARNING_ITEM_KEYS.slice().sort(),
        'TicketQualityWarning gained or lost an undeclared key. A NEW key must be added to ' +
            'refinement-manifest.schema.json ticket_quality_warnings.items.properties ' +
            '(additionalProperties:false fails the whole manifest otherwise). A key that ' +
            'disappeared here was fixed — drop it from KNOWN_UNDECLARED_WARNING_ITEM_KEYS.'
    );
});

test('AP-RMS-8: a really-emitted warning carries exactly the pinned undeclared keys', () => {
    // Guards the pin against staleness at the OUTCOME, not the source text: a
    // pinned key that no writer emits any more must shrink the pin, and a
    // writer that starts emitting a third key must fail here.
    __resetGitLsFilesSuffixCacheForTests();
    const refinementDir = tmpDir('pickle-apv-item-refine-');
    const workingDir = tmpDir('pickle-apv-item-work-');
    try {
        fs.writeFileSync(
            path.join(refinementDir, 'analysis_architect.md'),
            'The fix belongs in `src/does/not/exist.ts`.\n'
        );

        const warnings = scanAnalystOutputsForUnverifiedPaths(refinementDir, workingDir);
        assert.ok(warnings.length > 0, 'fixture must actually produce a warning');

        const declared = Object.keys(warningItemSchema().properties);
        for (const warning of warnings) {
            assert.deepEqual(
                Object.keys(warning).filter((k) => !declared.includes(k)).sort(),
                KNOWN_UNDECLARED_WARNING_ITEM_KEYS.slice().sort(),
                `emitted warning's undeclared keys drifted from the pin: ${JSON.stringify(warning)}`
            );
        }
    } finally {
        fs.rmSync(refinementDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

// --- AP-RMS-10: one line-count oracle, off-by-one closed ---------------------
// A POSIX file ends in a newline, so `split(/\r?\n/).length` counts a phantom
// trailing empty element. Both staleness checks hand-rolled that expression, so
// a citation exactly ONE line past EOF read as in-range at BOTH sites and the
// reported count was inflated by one. Collapsed into `countContentLines`.

test('AP-RMS-10: the line-count oracle is exact across newline shapes', () => {
    assert.equal(countContentLines(''), 0, 'empty file has no lines');
    assert.equal(countContentLines('line1\nline2\nline3\n'), 3, 'trailing newline must not inflate');
    assert.equal(countContentLines('line1\nline2\nline3'), 3, 'no trailing newline');
    assert.equal(countContentLines('a\r\nb\r\n'), 2, 'CRLF trailing must not inflate');
    assert.equal(countContentLines('a\r\nb'), 2, 'CRLF no trailing');
    assert.equal(countContentLines('\n'), 1, 'a single blank line is one line');
    assert.equal(countContentLines('only\n'), 1, 'single-line file');
    // the phantom-element shape must not come back
    assert.notEqual(countContentLines('line1\nline2\nline3\n'), 'line1\nline2\nline3\n'.split(/\r?\n/).length);
});

test('AP-RMS-10: analyst path (checkAnalystOutputPaths) flags a citation exactly one line past EOF', () => {
    __resetGitLsFilesSuffixCacheForTests();
    const workingDir = tmpDir('pickle-apv-work-');
    try {
        initGitRepo(workingDir);
        fs.mkdirSync(path.join(workingDir, 'extension', 'src', 'bin'), { recursive: true });
        // a normal 3-line POSIX file
        fs.writeFileSync(path.join(workingDir, 'extension', 'src', 'bin', 'microverse-runner.ts'), 'line1\nline2\nline3\n');
        spawnSync('git', ['add', '.'], { cwd: workingDir });
        spawnSync('git', ['commit', '-q', '-m', 'add file'], { cwd: workingDir });

        // line 4 does not exist — pre-fix this slipped through (4 > 4 === false)
        const boundary = checkAnalystOutputPaths('Cited: `microverse-runner.ts:4`.\n', workingDir);
        assert.equal(boundary.length, 1, 'one-past-EOF must be line_out_of_range');
        assert.equal(boundary[0].defect_class, 'line_out_of_range');
        assert.equal(boundary[0].line, 4);

        // the last REAL line must still be accepted — guards against over-correction
        const lastReal = checkAnalystOutputPaths('Cited: `microverse-runner.ts:3`.\n', workingDir);
        assert.equal(lastReal.length, 0, 'the final real line is in range');
    } finally {
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

test('AP-RMS-10: anchor path (findStaleAnchorWarnings) flags one-past-EOF and reports the TRUE count', () => {
    const workingDir = tmpDir('pickle-apv-anchor-');
    try {
        initGitRepo(workingDir);
        fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(workingDir, 'src', 'short.ts'), 'line1\nline2\nline3\n');
        spawnSync('git', ['add', '.'], { cwd: workingDir });
        spawnSync('git', ['commit', '-q', '-m', 'add file'], { cwd: workingDir });

        const boundary = findStaleAnchorWarnings('See `src/short.ts:4` here.\n', workingDir);
        assert.equal(boundary.length, 1, 'one-past-EOF must be line-out-of-range at the anchor site too');
        assert.equal(boundary[0].reason, 'line-out-of-range');
        // the operator-facing detail must cite 3, not the inflated 4
        assert.match(boundary[0].detail, /HEAD line count 3\b/);

        const lastReal = findStaleAnchorWarnings('See `src/short.ts:3` here.\n', workingDir);
        assert.equal(lastReal.length, 0, 'the final real line is in range');
    } finally {
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

test('AP-RMS-10: neither staleness site hand-rolls its own line count', () => {
    const src = fs.readFileSync(
        path.join(REPO_ROOT, 'extension', 'src', 'bin', 'spawn-refinement-team.ts'),
        'utf-8',
    );
    // the phantom-element expression must exist nowhere outside the one oracle
    const handRolled = src.match(/(?:headContent|fileContent|content)\s*===\s*''\s*\?\s*0\s*:[^\n]*split\(\/\\r\?\\n\/\)\.length/g) ?? [];
    assert.equal(handRolled.length, 0, `line-count logic re-forked: ${JSON.stringify(handRolled)}`);
    // both consumers route through the oracle
    const oracleUses = src.match(/countContentLines\(/g) ?? [];
    assert.ok(oracleUses.length >= 3, `expected 1 definition + 2 call sites, saw ${oracleUses.length}`);
});
