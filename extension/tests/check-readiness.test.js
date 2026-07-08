// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');
const DEAD_TMP_PID = 99_999_999;

function tmpDir(prefix = 'pickle-readiness-p0-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function markTmpNewer(filePath) {
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(filePath, future, future);
}

function writeTicket(sessionDir, id, options = {}) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, `rick_ticket_${id}.md`);
    const acIds = options.acIds ? `[${options.acIds.join(', ')}]` : '[]';
    const deps = options.dependencies ? `dependencies: [${options.dependencies.join(', ')}]\n` : '';
    const workingDir = options.workingDir ? `working_dir: ${options.workingDir}\n` : '';
    fs.writeFileSync(ticketPath, [
        '---',
        `id: ${id}`,
        `key: ${options.key ?? id}`,
        `ac_ids: ${acIds}`,
        workingDir.trimEnd(),
        deps.trimEnd(),
        '---',
        '',
        '# Ticket',
        '',
        '## Acceptance Criteria',
        `- [ ] ${options.ac ?? 'Command exits 0 exactly.'}`,
        '',
        options.extra ?? '',
    ].filter((line) => line !== '').join('\n'));
    return ticketPath;
}

function writeManifest(sessionDir, body) {
    const manifestPath = path.join(sessionDir, 'decomposition_manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(body, null, 2));
    return manifestPath;
}

function makeState(sessionDir, overrides = {}) {
    return {
        active: false,
        working_dir: process.cwd(),
        step: 'research',
        iteration: 1,
        max_iterations: 10,
        max_time_minutes: 30,
        worker_timeout_seconds: 60,
        start_time_epoch: Date.now(),
        completion_promise: null,
        original_prompt: 'readiness fixture',
        current_ticket: null,
        history: [],
        started_at: new Date().toISOString(),
        session_dir: sessionDir,
        schema_version: 3,
        readiness: { cycle_history: [] },
        ...overrides,
    };
}

function runReadiness(sessionDir, repoRoot = process.cwd()) {
    return spawnSync(process.execPath, [
        BIN,
        '--session-dir', sessionDir,
        '--repo-root', repoRoot,
    ], {
        encoding: 'utf-8',
        timeout: 60000,
    });
}

function runReadinessHistory(sessionDir) {
    return spawnSync(process.execPath, [
        BIN,
        '--session-dir', sessionDir,
        '--history',
    ], {
        encoding: 'utf-8',
        timeout: 60000,
    });
}

function runFixture(callback) {
    const sessionDir = tmpDir();
    try {
        callback(sessionDir);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

test('check-readiness: PRD requirement without ticket mapping fails independently', () => runFixture((sessionDir) => {
    writeTicket(sessionDir, 'map001', { acIds: ['REQ-2'] });
    writeManifest(sessionDir, {
        requirements: ['REQ-1'],
        tickets: [{ id: 'map001', key: 'MAP-1', ac_ids: ['REQ-2'] }],
    });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 2);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'fail');
    assert.ok(out.findings.some((finding) => finding.kind === 'prd_map' && finding.detail === 'REQ-1'));
}));

test('check-readiness: prose-only verify_pre acceptance criterion fails independently', () => runFixture((sessionDir) => {
    writeTicket(sessionDir, 'ac0001', { ac: 'verify_pre: The workflow should feel intuitive.' });
    writeManifest(sessionDir, { tickets: [{ id: 'ac0001', key: 'AC-1' }] });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 2);
    const out = JSON.parse(result.stdout);
    assert.ok(out.findings.some((finding) => finding.kind === 'machinability'));
}));

test('check-readiness: acceptance criteria default to verify_post and skip readiness machinability', () => runFixture((sessionDir) => {
    writeTicket(sessionDir, 'acpost', { ac: 'The workflow should feel intuitive.' });
    writeManifest(sessionDir, { tickets: [{ id: 'acpost', key: 'AC-POST' }] });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    assert.deepEqual(out.findings, []);
}));

test('check-readiness: missing file path fails independently', () => runFixture((sessionDir) => {
    writeTicket(sessionDir, 'path01', { extra: '## Files\n\n- `missing/path-contract.ts`\n' });
    writeManifest(sessionDir, { tickets: [{ id: 'path01', key: 'PATH-1' }] });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 2);
    const out = JSON.parse(result.stdout);
    assert.ok(out.findings.some((finding) => finding.kind === 'file_path' && finding.detail === 'missing/path-contract.ts'));
}));

test('check-readiness: file path resolver accepts paths relative to ticket working_dir', () => runFixture((sessionDir) => {
    const repoRoot = tmpDir('pickle-readiness-repo-');
    try {
        fs.mkdirSync(path.join(repoRoot, 'packages/app/src'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'packages/app/src/path-contract.ts'), 'export const ok = true;\n');
        writeTicket(sessionDir, 'pathwd', {
            workingDir: 'packages/app',
            extra: '## Files\n\n- `src/path-contract.ts`\n',
        });
        writeManifest(sessionDir, { tickets: [{ id: 'pathwd', key: 'PATH-WD' }] });

        const result = runReadiness(sessionDir, repoRoot);
        assert.equal(result.status, 0, result.stderr);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        assert.deepEqual(out.findings, []);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}));

test('check-readiness: file path resolver accepts extension-root fallback paths', () => runFixture((sessionDir) => {
    const repoRoot = tmpDir('pickle-readiness-repo-');
    try {
        fs.mkdirSync(path.join(repoRoot, 'extension/tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'extension/tests/path-contract.test.js'), 'export {};\n');
        writeTicket(sessionDir, 'pathext', { extra: '## Files\n\n- `tests/path-contract.test.js`\n' });
        writeManifest(sessionDir, { tickets: [{ id: 'pathext', key: 'PATH-EXT' }] });

        const result = runReadiness(sessionDir, repoRoot);
        assert.equal(result.status, 0, result.stderr);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        assert.deepEqual(out.findings, []);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}));

test('check-readiness: missing contract fails independently', () => runFixture((sessionDir) => {
    // R-RTRC-3 lifts the tests/ exclusion in resolveSymbolRef, so the contract
    // detail must be a symbol whose every dotted part is absent from any
    // tracked .ts/.tsx/.js/.jsx/.mjs/.cjs file across src/ AND tests/ — including
    // this test source. The previous fixture (`NoSuchReadinessContract.resolve()`)
    // self-resolved once tests/ became a valid resolution scope. Build the
    // missing-symbol via concat so the literal does not appear in this file.
    const head = 'Zyxx' + 'QqUni' + 'cornGlyph' + 'Latched';
    const tail = 'euler' + 'Nautilus' + 'Rune';
    const symbol = `${head}.${tail}()`;
    writeTicket(sessionDir, 'ctr001', { extra: `## Interface Contracts\n\n- \`${symbol}\` must exist.\n` });
    writeManifest(sessionDir, { tickets: [{ id: 'ctr001', key: 'CTR-1' }] });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 2);
    const out = JSON.parse(result.stdout);
    assert.ok(out.findings.some((finding) => finding.kind === 'contract' && finding.detail === symbol));
}));

test('check-readiness: R-RCEX (#65) external SDK symbol resolves against node_modules .d.ts', () => runFixture((sessionDir) => {
    const repoRoot = tmpDir('pickle-readiness-repo-');
    try {
        // A declared dependency whose `.d.ts` surface declares the cited symbol.
        fs.writeFileSync(
            path.join(repoRoot, 'package.json'),
            JSON.stringify({ name: 'rcex-fixture', dependencies: { reductoish: '0.1.0' } }),
        );
        const depDir = path.join(repoRoot, 'node_modules', 'reductoish');
        fs.mkdirSync(depDir, { recursive: true });
        fs.writeFileSync(
            path.join(depDir, 'index.d.ts'),
            'export interface JobGetResponse { result: string; }\n',
        );
        writeTicket(sessionDir, 'rcex01', { extra: '## Interface Contracts\n\n- `JobGetResponse.result` must exist.\n' });
        writeManifest(sessionDir, { tickets: [{ id: 'rcex01', key: 'RCEX-1' }] });

        const result = runReadiness(sessionDir, repoRoot);
        assert.equal(result.status, 0, result.stderr);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        assert.ok(
            !out.findings.some((finding) => finding.kind === 'contract'),
            `external SDK symbol must not produce a contract finding; got ${JSON.stringify(out.findings)}`,
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}));

test('check-readiness: R-RCEX (#65) a symbol absent from every dependency still fails', () => runFixture((sessionDir) => {
    const repoRoot = tmpDir('pickle-readiness-repo-');
    try {
        fs.writeFileSync(
            path.join(repoRoot, 'package.json'),
            JSON.stringify({ name: 'rcex-fixture', dependencies: { reductoish: '0.1.0' } }),
        );
        const depDir = path.join(repoRoot, 'node_modules', 'reductoish');
        fs.mkdirSync(depDir, { recursive: true });
        fs.writeFileSync(path.join(depDir, 'index.d.ts'), 'export interface JobGetResponse { result: string; }\n');
        const symbol = 'Phantom' + 'SdkType' + 'Xyz.' + 'never' + 'DeclaredMember';
        writeTicket(sessionDir, 'rcex02', { extra: `## Interface Contracts\n\n- \`${symbol}\` must exist.\n` });
        writeManifest(sessionDir, { tickets: [{ id: 'rcex02', key: 'RCEX-2' }] });

        const result = runReadiness(sessionDir, repoRoot);
        assert.equal(result.status, 2);
        const out = JSON.parse(result.stdout);
        assert.ok(out.findings.some((finding) => finding.kind === 'contract' && finding.detail === symbol));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}));

test('check-readiness: R-RPRA (#57) an absolute path outside TARGET is not a file_path finding', () => runFixture((sessionDir) => {
    // A ticket whose body cites an absolute session-PRD path outside the repo
    // (the `source_prd` shape that produced 13 false findings pre-R-RHFP). The
    // PATH_RE negative lookbehind `(?<![\w./@-])` now refuses to start a match
    // after a `/`, so an absolute path extracts nothing — no phantom finding,
    // no leading-`/`-stripped variant.
    writeTicket(sessionDir, 'rpra01', {
        extra: 'Source PRD: /Users/dev/.local/share/pickle-rick/sessions/2026-05-19-abc/prd.md (outside target).\n',
    });
    writeManifest(sessionDir, { tickets: [{ id: 'rpra01', key: 'RPRA-1' }] });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    assert.ok(
        !out.findings.some((finding) => finding.kind === 'file_path'),
        `absolute path outside TARGET must not produce a file_path finding; got ${JSON.stringify(out.findings)}`,
    );
}));

test('check-readiness: missing dependency fails independently', () => runFixture((sessionDir) => {
    writeTicket(sessionDir, 'dep001', { dependencies: ['DEP-MISSING'] });
    writeManifest(sessionDir, { tickets: [{ id: 'dep001', key: 'DEP-1' }] });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 2);
    const out = JSON.parse(result.stdout);
    assert.ok(out.findings.some((finding) => finding.kind === 'dependency' && finding.detail === 'DEP-MISSING'));
}));

test('check-readiness: aligned fixture exits 0 with structured JSON stdout', () => runFixture((sessionDir) => {
    writeTicket(sessionDir, 'ok0001', { key: 'OK-1', acIds: ['REQ-1'] });
    writeManifest(sessionDir, {
        requirements: ['REQ-1'],
        tickets: [{ id: 'ok0001', key: 'OK-1', ac_ids: ['REQ-1'] }],
    });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    assert.deepEqual(out.findings, []);
    assert.equal(typeof out.elapsed_ms, 'number');
}));

test('check-readiness: history reads recover dead-writer state tmp snapshots', () => runFixture((sessionDir) => {
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(makeState(sessionDir, {
        iteration: 1,
        readiness: {
            cycle_history: [
                { cycle: 1, status: 'failed', suggested_analyst: 'gaps', user_action: null, timestamp: '2026-04-30T01:00:00.000Z' },
            ],
        },
    }), null, 2));

    const tmpPath = `${statePath}.tmp.99999999`;
    fs.writeFileSync(tmpPath, JSON.stringify(makeState(sessionDir, {
        iteration: 2,
        readiness: {
            cycle_history: [
                { cycle: 1, status: 'failed', suggested_analyst: 'gaps', user_action: null, timestamp: '2026-04-30T01:00:00.000Z' },
                { cycle: 2, status: 'failed', suggested_analyst: 'codebase', user_action: null, timestamp: '2026-04-30T02:00:00.000Z' },
            ],
        },
    }), null, 2));

    const result = runReadinessHistory(sessionDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\| 2 \| failed \| codebase \|/);
    assert.equal(fs.existsSync(tmpPath), false, 'StateManager.read should consume the dead-writer tmp snapshot');
}));

test('check-readiness: failing run preserves cycle history from a tmp-only state snapshot', () => runFixture((sessionDir) => {
    const statePath = path.join(sessionDir, 'state.json');
    const tmpPath = `${statePath}.tmp.${DEAD_TMP_PID}`;
    fs.writeFileSync(tmpPath, JSON.stringify(makeState(sessionDir, {
        iteration: 2,
        readiness: {
            cycle_history: [
                { cycle: 1, status: 'failed', suggested_analyst: 'gaps', user_action: null, timestamp: '2026-04-30T01:00:00.000Z' },
            ],
        },
    }), null, 2));
    markTmpNewer(tmpPath);

    writeTicket(sessionDir, 'map001', { acIds: ['REQ-2'] });
    writeManifest(sessionDir, {
        requirements: ['REQ-1'],
        tickets: [{ id: 'map001', key: 'MAP-1', ac_ids: ['REQ-2'] }],
    });

    const result = runReadiness(sessionDir);
    assert.equal(result.status, 2, result.stderr);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const history = persisted.readiness?.cycle_history ?? [];

    assert.equal(fs.existsSync(tmpPath), false, 'tmp-only state should be promoted before readiness mutates state');
    assert.equal(history.length, 2, `expected prior readiness history to survive tmp-only recovery: ${JSON.stringify(history)}`);
    assert.equal(history[0].cycle, 1);
    assert.equal(history[1].cycle, 2);
    assert.equal(history[1].status, 'failed');
    assert.equal(typeof history[1].suggested_analyst, 'string');
  }));

test('check-readiness: post-correction delta recovers dead-writer snapshot tmp', () => runFixture((sessionDir) => {
    const statePath = path.join(sessionDir, 'state.json');
    const unchanged = writeTicket(sessionDir, 'unchanged', {
        key: 'UNCHANGED-1',
        ac: 'The workflow should feel intuitive.',
    });
    const changed = writeTicket(sessionDir, 'changed', {
        key: 'CHANGED-1',
        ac: 'Command exits 0 exactly.',
    });
    writeManifest(sessionDir, {
        tickets: [
            { id: 'unchanged', key: 'UNCHANGED-1' },
            { id: 'changed', key: 'CHANGED-1' },
        ],
    });

    const hashes = Object.fromEntries([unchanged, changed].map((file) => [
        path.relative(sessionDir, file),
        createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    ]));
    const snapshotPath = path.join(sessionDir, 'readiness_snapshot.json');
    fs.writeFileSync(snapshotPath, '{not valid json');
    const tmpSnapshotPath = `${snapshotPath}.tmp.${DEAD_TMP_PID}`;
    fs.writeFileSync(tmpSnapshotPath, JSON.stringify({ ticketsVersion: 1, hashes }, null, 2));
    markTmpNewer(tmpSnapshotPath);
    fs.writeFileSync(statePath, JSON.stringify(makeState(sessionDir, {
        tickets_version: 2,
        activity: [{ event: 'course_corrected' }],
    }), null, 2));
    fs.writeFileSync(changed, fs.readFileSync(changed, 'utf8').replace('Command exits 0 exactly.', 'verify_pre: The workflow should feel intuitive.'));

    const result = runReadiness(sessionDir);

    assert.equal(result.status, 2, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'fail');
    assert.equal(out.delta, true);
    assert.deepEqual(out.findings.map((finding) => path.basename(path.dirname(finding.ticket))), ['changed']);
    assert.equal(fs.existsSync(tmpSnapshotPath), false, 'dead-writer snapshot tmp should be promoted');
}));
