// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');

function tmpDir(prefix = 'pickle-readiness-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, acLines, extra = '') {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, `rick_ticket_${id}.md`);
    fs.writeFileSync(ticketPath, [
        '---',
        `id: ${id}`,
        '---',
        '',
        '# Ticket',
        '',
        '## Acceptance Criteria',
        ...acLines.map((line) => `- [ ] ${line}`),
        '',
        extra,
    ].join('\n'));
    return ticketPath;
}

function runReadiness(sessionDir, repoRoot, env = {}) {
    return spawnSync(process.execPath, [
        BIN,
        '--session-dir', sessionDir,
        '--repo-root', repoRoot,
        '--machinability-only',
        '--contract-only',
    ], {
        encoding: 'utf-8',
        env: { ...process.env, ...env },
        timeout: 10000,
    });
}

function runHistory(sessionDir, last) {
    const args = [
        BIN,
        '--session-dir', sessionDir,
        '--history',
    ];
    if (last !== undefined) args.push('--last', String(last));
    return spawnSync(process.execPath, args, {
        encoding: 'utf-8',
        timeout: 10000,
    });
}

function readinessFiles(sessionDir) {
    return fs.readdirSync(sessionDir).filter((file) => /^readiness_/.test(file)).sort();
}

test('check-readiness: prose-only AC exits 2, suggests gaps, writes readiness report', () => {
    const sessionDir = tmpDir();
    try {
        writeTicket(sessionDir, 'aaa111', ['verify_pre: The UI must be intuitive.']);
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            readiness: {
                cycle_history: [],
            },
        }));
        const result = runReadiness(sessionDir, process.cwd());
        assert.equal(result.status, 2);
        const files = readinessFiles(sessionDir);
        assert.equal(files.length, 1);
        const report = fs.readFileSync(path.join(sessionDir, files[0]), 'utf-8');
        assert.match(report, /suggested_analyst: gaps/);
        assert.match(report, /must be intuitive/i);
        const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(state.readiness.cycle_history.length, 1);
        assert.equal(state.readiness.cycle_history[0].cycle, 1);
        assert.equal(state.readiness.cycle_history[0].status, 'failed');
        assert.equal(state.readiness.cycle_history[0].suggested_analyst, 'gaps');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('check-readiness: unresolved contract exits 2 and suggests codebase', () => {
    const sessionDir = tmpDir();
    try {
        // R-RTRC-3: tests/ source files are now in the resolver scope, so this
        // fixture must use a symbol whose dotted parts are absent from every
        // tracked .ts/.js source — including this test file. Build via concat
        // so the literal token never appears in this file's source.
        const head = 'Wraith' + 'Glyphic' + 'Latched' + 'Nexus';
        const tail = 'tessera' + 'Cogweld' + 'Forge';
        const symbol = `${head}.${tail}()`;
        writeTicket(
            sessionDir,
            'bbb222',
            ['Command exits 0 exactly.'],
            `## Interface Contracts\n\n- \`${symbol}\` must exist.\n`
        );
        const result = runReadiness(sessionDir, process.cwd());
        assert.equal(result.status, 2);
        const report = fs.readFileSync(path.join(sessionDir, readinessFiles(sessionDir)[0]), 'utf-8');
        assert.match(report, /suggested_analyst: codebase/);
        assert.ok(report.includes(symbol), `expected report to mention ${symbol}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('check-readiness: fourth failed cycle writes escalation report', () => {
    const sessionDir = tmpDir();
    try {
        writeTicket(sessionDir, 'ccc333', ['verify_pre: The workflow should feel intuitive.']);
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            readiness: {
                cycle_history: [{}, {}, {}],
            },
        }));
        const result = runReadiness(sessionDir, process.cwd());
        assert.equal(result.status, 2);
        assert.ok(readinessFiles(sessionDir).some((file) => file.startsWith('readiness_escalation_')));
        const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(state.readiness.cycle_history.length, 3);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('check-readiness: --history prints readiness cycle table', () => {
    const sessionDir = tmpDir();
    try {
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            readiness: {
                cycle_history: [
                    {
                        cycle: 1,
                        status: 'failed',
                        suggested_analyst: 'gaps',
                        user_action: 'recycled',
                        timestamp: '2026-04-29T12:00:00.000Z',
                    },
                ],
            },
        }));
        const result = runHistory(sessionDir);
        assert.equal(result.status, 0);
        assert.match(result.stdout, /\| Cycle \| Status \| Suggested analyst \| User action \| Timestamp \|/);
        assert.match(result.stdout, /\| 1 \| failed \| gaps \| recycled \| 2026-04-29T12:00:00\.000Z \|/);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('check-readiness: --history --last limits printed rows', () => {
    const sessionDir = tmpDir();
    try {
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            readiness: {
                cycle_history: [
                    { cycle: 1, status: 'failed', suggested_analyst: 'gaps', user_action: null, timestamp: '2026-04-29T12:00:00.000Z' },
                    { cycle: 2, status: 'failed', suggested_analyst: 'codebase', user_action: null, timestamp: '2026-04-29T13:00:00.000Z' },
                ],
            },
        }));
        const result = runHistory(sessionDir, 1);
        assert.equal(result.status, 0);
        assert.doesNotMatch(result.stdout, /\| 1 \| failed \| gaps /);
        assert.match(result.stdout, /\| 2 \| failed \| codebase /);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('check-readiness: post-correction delta checks modified tickets and logs regression event', () => {
    const sessionDir = tmpDir();
    const dataRoot = tmpDir('pickle-readiness-data-');
    try {
        writeTicket(sessionDir, 'ddd444', ['Command exits 0 exactly.']);
        writeTicket(sessionDir, 'eee555', ['Command exits 0 exactly.']);
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            tickets_version: 1,
            activity: [],
        }));
        assert.equal(runReadiness(sessionDir, process.cwd(), { EXTENSION_DIR: dataRoot }).status, 0);

        writeTicket(sessionDir, 'eee555', ['verify_pre: The workflow should be intuitive.']);
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            tickets_version: 2,
            activity: [{ event: 'course_corrected' }],
        }));

        const result = runReadiness(sessionDir, process.cwd(), { EXTENSION_DIR: dataRoot });
        assert.equal(result.status, 2);
        const report = fs.readFileSync(path.join(sessionDir, readinessFiles(sessionDir)[0]), 'utf-8');
        assert.match(report, /eee555/);
        assert.doesNotMatch(report, /ddd444/);

        const activityDir = path.join(dataRoot, 'activity');
        const activity = fs.readdirSync(activityDir)
            .flatMap((file) => fs.readFileSync(path.join(activityDir, file), 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse));
        assert.ok(activity.some((event) => event.event === 'readiness_failed_post_correction'));
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('check-readiness: 25-ticket manifest fixture runs under 10 seconds', () => {
    const sessionDir = tmpDir();
    try {
        for (let i = 0; i < 25; i += 1) {
            writeTicket(sessionDir, `ticket${String(i).padStart(2, '0')}`, ['Command exits 0 exactly.']);
        }
        const start = Date.now();
        const result = runReadiness(sessionDir, process.cwd());
        const elapsedMs = Date.now() - start;
        assert.equal(result.status, 0);
        assert.ok(elapsedMs < 10000, `expected under 10s, got ${elapsedMs}ms`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});
