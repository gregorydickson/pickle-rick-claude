// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    statusSymbol,
    parseTicketFrontmatter,
    getTicketStatus,
    MissingTicketError,
    collectTickets,
    wrapText,
    formatTime,
    buildHandoffSummary,
    withRetryLock,
    resolveSessionPath,
    pruneOldSessions,
    extractFrontmatter,
    getMicroverseSettings,
    getExtensionRoot,
    resolveJudgeBackend,
    _resetExtensionDirFallbackForTests,
    getDataRoot,
    markTicketDone,
    markTicketSkipped,
    safeErrorMessage,
    pruneOrphanedMapEntries,
    clearTicketCacheFields,
    restartDeadWatcherPanes,
    runCmd,
} from '../services/pickle-utils.js';
import { LockError } from '../types/index.js';

// --- safeErrorMessage ---

test('safeErrorMessage: returns message from Error instance', () => {
    assert.equal(safeErrorMessage(new Error('boom')), 'boom');
});

test('safeErrorMessage: coerces number to string', () => {
    assert.equal(safeErrorMessage(42), '42');
});

test('safeErrorMessage: coerces null to string', () => {
    assert.equal(safeErrorMessage(null), 'null');
});

test('safeErrorMessage: coerces undefined to string', () => {
    assert.equal(safeErrorMessage(undefined), 'undefined');
});

// --- getExtensionRoot ---

function withCleanExtensionEnv(fn) {
    const saved = process.env.EXTENSION_DIR;
    const savedDataRoot = process.env.PICKLE_DATA_ROOT;
    const savedNodeEnv = process.env.NODE_ENV;
    const savedAllow = process.env.EXTENSION_DIR_TEST;
    try {
        delete process.env.EXTENSION_DIR;
        delete process.env.PICKLE_DATA_ROOT;
        delete process.env.NODE_ENV;
        delete process.env.EXTENSION_DIR_TEST;
        _resetExtensionDirFallbackForTests();
        fn();
    } finally {
        if (saved === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = saved;
        if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = savedDataRoot;
        if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedNodeEnv;
        if (savedAllow === undefined) delete process.env.EXTENSION_DIR_TEST;
        else process.env.EXTENSION_DIR_TEST = savedAllow;
        _resetExtensionDirFallbackForTests();
    }
}

function makeExtensionRootWithSentinel() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ext-root-')));
    fs.mkdirSync(path.join(root, 'extension', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');
    return root;
}

function readActivityEvents(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    return fs.readdirSync(activityDir)
        .filter(file => file.endsWith('.jsonl'))
        .flatMap(file => fs.readFileSync(path.join(activityDir, file), 'utf-8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => JSON.parse(line)));
}

test('getExtensionRoot: uses EXTENSION_DIR only when log-watcher sentinel exists', () => {
    withCleanExtensionEnv(() => {
        const extRoot = makeExtensionRootWithSentinel();
        try {
            process.env.EXTENSION_DIR = extRoot;
            assert.equal(getExtensionRoot(), extRoot);
        } finally {
            fs.rmSync(extRoot, { recursive: true, force: true });
        }
    });
});

test('getExtensionRoot: invalid EXTENSION_DIR falls back and logs once', () => {
    withCleanExtensionEnv(() => {
        const extRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-invalid-ext-')));
        const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-fallback-data-')));
        const stderr = [];
        const savedWrite = process.stderr.write;
        process.env.EXTENSION_DIR = extRoot;
        process.env.PICKLE_DATA_ROOT = dataRoot;
        process.stderr.write = (chunk) => {
            stderr.push(String(chunk));
            return true;
        };
        try {
            const fallback = path.join(os.homedir(), '.claude/pickle-rick');
            assert.equal(getExtensionRoot(), fallback);
            assert.equal(getExtensionRoot(), fallback);

            const warnings = stderr.filter(line => line.includes('EXTENSION_DIR fallback'));
            assert.equal(warnings.length, 1);
            assert.match(warnings[0], /missing sentinel/);

            const events = readActivityEvents(dataRoot).filter(event => event.event === 'extension_dir_fallback');
            assert.equal(events.length, 1);
            assert.equal(events[0].requested_path, extRoot);
            assert.equal(events[0].fallback_path, fallback);
            assert.match(events[0].reason, /missing sentinel/);
        } finally {
            process.stderr.write = savedWrite;
            fs.rmSync(extRoot, { recursive: true, force: true });
            fs.rmSync(dataRoot, { recursive: true, force: true });
        }
    });
});

test('getExtensionRoot: explicit test override can use temp root without sentinel', () => {
    withCleanExtensionEnv(() => {
        const extRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-ext-')));
        try {
            process.env.EXTENSION_DIR = extRoot;
            process.env.NODE_ENV = 'test';
            process.env.EXTENSION_DIR_TEST = '1';
            assert.equal(getExtensionRoot(), extRoot);
        } finally {
            fs.rmSync(extRoot, { recursive: true, force: true });
        }
    });
});

test('getExtensionRoot: defaults to ~/.claude/pickle-rick', () => {
    const saved = process.env.EXTENSION_DIR;
    try {
        delete process.env.EXTENSION_DIR;
        assert.equal(getExtensionRoot(), path.join(os.homedir(), '.claude/pickle-rick'));
    } finally {
        if (saved !== undefined) process.env.EXTENSION_DIR = saved;
    }
});

// --- getDataRoot ---

function withCleanDataEnv(fn) {
    const savedRoot = process.env.PICKLE_DATA_ROOT;
    const savedData = process.env.PICKLE_DATA_DIR;
    const savedExt = process.env.EXTENSION_DIR;
    try {
        delete process.env.PICKLE_DATA_ROOT;
        delete process.env.PICKLE_DATA_DIR;
        delete process.env.EXTENSION_DIR;
        fn();
    } finally {
        if (savedRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = savedRoot;
        if (savedData === undefined) delete process.env.PICKLE_DATA_DIR;
        else process.env.PICKLE_DATA_DIR = savedData;
        if (savedExt === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = savedExt;
    }
}

test('getDataRoot: PICKLE_DATA_ROOT is the canonical override', () => {
    withCleanDataEnv(() => {
        process.env.PICKLE_DATA_ROOT = '/canonical/data-root';
        process.env.PICKLE_DATA_DIR = '/legacy/data-dir';
        process.env.EXTENSION_DIR = '/some/extension';
        assert.equal(getDataRoot(), '/canonical/data-root');
    });
});

test('getDataRoot: PICKLE_DATA_DIR overrides everything', () => {
    withCleanDataEnv(() => {
        process.env.PICKLE_DATA_DIR = '/explicit/data';
        process.env.EXTENSION_DIR = '/some/extension';
        assert.equal(getDataRoot(), '/explicit/data');
    });
});

test('getDataRoot: EXTENSION_DIR=tmpdir is honored for test isolation', () => {
    withCleanDataEnv(() => {
        process.env.EXTENSION_DIR = '/tmp/pickle-test-isolated';
        assert.equal(getDataRoot(), '/tmp/pickle-test-isolated');
    });
});

test('getDataRoot: EXTENSION_DIR=canonical install path is IGNORED (production)', () => {
    // REGRESSION: dispatch.ts injects EXTENSION_DIR=~/.claude/pickle-rick into every
    // hook subprocess. Before the fix, getDataRoot returned that install path,
    // so hooks read sessions from the install dir instead of ~/.local/share/pickle-rick.
    withCleanDataEnv(() => {
        process.env.EXTENSION_DIR = path.join(os.homedir(), '.claude/pickle-rick');
        assert.equal(getDataRoot(), path.join(os.homedir(), '.local/share/pickle-rick'));
    });
});

test('getDataRoot: defaults to ~/.local/share/pickle-rick when nothing set', () => {
    withCleanDataEnv(() => {
        assert.equal(getDataRoot(), path.join(os.homedir(), '.local/share/pickle-rick'));
    });
});

test('pipeline-runner: spawn targets are under extension/bin/, never directly under extensionRoot/bin/', () => {
    // Regression guard for the /pickle-pipeline MODULE_NOT_FOUND crash: the runner
    // must build node-spawn paths as `extensionRoot/extension/bin/<script>` to match
    // the install layout (install.sh:61 rsyncs src into $EXTENSION_ROOT/extension/).
    const pipelineJsPath = path.join(import.meta.dirname, '..', 'bin', 'pipeline-runner.js');
    const src = fs.readFileSync(pipelineJsPath, 'utf-8');
    const stale = src.match(/path\.join\(\s*extensionRoot\s*,\s*['"]bin['"]/g);
    assert.equal(stale, null,
        `pipeline-runner.js has ${stale?.length} callsite(s) joining extensionRoot with 'bin' directly — must go through 'extension/bin/'`);
});

test('restartDeadWatcherPanes: healthy 2x2 layout is a no-op', () => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-utils-watchers-')));
    // Session dir carries the hash the fake tmux session name advertises below —
    // restartDeadWatcherPanes refuses any tmux session whose hash is not ours.
    const sessionDir = path.join(tmpRoot, 'healthy');
    const extRoot = path.join(tmpRoot, 'ext');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ active: true, command_template: null }));
    fs.writeFileSync(path.join(extRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');

    const spawnCalls = [];
    const spawnSyncFn = (command, args = []) => {
        spawnCalls.push({ command, args: [...args] });
        if (command !== 'tmux') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '#S') {
            return { status: 0, stdout: 'pickle-utils-healthy\n', stderr: '' };
        }
        if (args[0] === 'display-message' && args[1] === '-p' && args[2] === '-t') {
            return { status: 0, stdout: 'node\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    };

    try {
        restartDeadWatcherPanes(sessionDir, extRoot, 'pickle', spawnSyncFn);
        const tmuxCommands = spawnCalls
            .filter(call => call.command === 'tmux')
            .map(call => call.args[0]);
        assert.equal(tmuxCommands.filter(command => command === 'send-keys').length, 0);
        assert.equal(tmuxCommands.filter(command => command === 'split-window').length, 0);
        assert.equal(tmuxCommands.filter(command => command === 'display-message').length, 5);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- extractFrontmatter ---

test('extractFrontmatter: extracts valid frontmatter', () => {
    const content = '---\nid: abc\nstatus: Todo\n---\n# Body';
    const result = extractFrontmatter(content);
    assert.ok(result);
    assert.equal(result.body, 'id: abc\nstatus: Todo');
    assert.equal(result.start, 0);
    assert.equal(content.slice(0, result.end), '---\nid: abc\nstatus: Todo\n---\n');
});

test('extractFrontmatter: returns null when no opening delimiter', () => {
    assert.equal(extractFrontmatter('# No frontmatter'), null);
});

test('extractFrontmatter: returns null when no closing delimiter', () => {
    assert.equal(extractFrontmatter('---\nid: abc\nstatus: Todo'), null);
});

test('extractFrontmatter: handles empty body with blank line', () => {
    const content = '---\n\n---\n# Body';
    const result = extractFrontmatter(content);
    assert.ok(result);
    assert.equal(result.body, '');
});

test('extractFrontmatter: no body (---\\n---) returns null — requires newline separator', () => {
    assert.equal(extractFrontmatter('---\n---\n# Body'), null);
});

test('extractFrontmatter: does not backtrack on large content missing closing ---', () => {
    // This would hang with the old regex on sufficiently large input
    const bigContent = '---\n' + 'x\n'.repeat(100000);
    const start = Date.now();
    const result = extractFrontmatter(bigContent);
    const elapsed = Date.now() - start;
    assert.equal(result, null);
    assert.ok(elapsed < 100, `extractFrontmatter took ${elapsed}ms — should be < 100ms`);
});

test('extractFrontmatter: handles Windows \\r\\n line endings', () => {
    const content = '---\r\nid: abc\r\nstatus: Todo\r\n---\r\n# Body';
    const result = extractFrontmatter(content);
    assert.ok(result);
    assert.ok(result.body.includes('id: abc'));
    assert.ok(result.body.includes('status: Todo'));
});

test('extractFrontmatter: \\r\\n returns null when no closing delimiter', () => {
    assert.equal(extractFrontmatter('---\r\nid: abc\r\nstatus: Todo'), null);
});

// --- statusSymbol ---

test('statusSymbol: lowercase done', () => assert.equal(statusSymbol('done'), '[x]'));
test('statusSymbol: title-case Done', () => assert.equal(statusSymbol('Done'), '[x]'));
test('statusSymbol: uppercase DONE', () => assert.equal(statusSymbol('DONE'), '[x]'));
test('statusSymbol: quoted "Done"', () => assert.equal(statusSymbol('"Done"'), '[x]'));
test("statusSymbol: single-quoted 'Done'", () => assert.equal(statusSymbol("'Done'"), '[x]'));
test('statusSymbol: in progress lowercase', () => assert.equal(statusSymbol('in progress'), '[~]'));
test('statusSymbol: In Progress title-case', () => assert.equal(statusSymbol('In Progress'), '[~]'));
test('statusSymbol: quoted "In Progress"', () => assert.equal(statusSymbol('"In Progress"'), '[~]'));
test('statusSymbol: Skipped → [!]', () => assert.equal(statusSymbol('Skipped'), '[!]'));
test('statusSymbol: skipped lowercase → [!]', () => assert.equal(statusSymbol('skipped'), '[!]'));
test('statusSymbol: quoted "Skipped" → [!]', () => assert.equal(statusSymbol('"Skipped"'), '[!]'));
test('statusSymbol: Todo → [ ]', () => assert.equal(statusSymbol('Todo'), '[ ]'));
test('statusSymbol: Backlog → [ ]', () => assert.equal(statusSymbol('Backlog'), '[ ]'));
test('statusSymbol: empty string → [ ]', () => assert.equal(statusSymbol(''), '[ ]'));
test('statusSymbol: null → [ ]', () => assert.equal(statusSymbol(null), '[ ]'));
test('statusSymbol: undefined → [ ]', () => assert.equal(statusSymbol(undefined), '[ ]'));

// --- formatTime ---

test('formatTime: 0s', () => assert.equal(formatTime(0), '0m 0s'));
test('formatTime: 30s', () => assert.equal(formatTime(30), '0m 30s'));
test('formatTime: 60s → 1m', () => assert.equal(formatTime(60), '1m 0s'));
test('formatTime: 90s', () => assert.equal(formatTime(90), '1m 30s'));
test('formatTime: 3600s → 60m', () => assert.equal(formatTime(3600), '60m 0s'));
test('formatTime: 3661s', () => assert.equal(formatTime(3661), '61m 1s'));

// --- wrapText ---

test('wrapText: short text needs no wrapping', () => {
    assert.deepEqual(wrapText('hello world', 20), ['hello world']);
});

test('wrapText: wraps at word boundary', () => {
    const lines = wrapText('hello world foo bar baz', 10);
    assert.ok(lines.every(l => l.length <= 10), `line too long: ${JSON.stringify(lines)}`);
    assert.ok(lines.length > 1);
    assert.equal(lines.join(' '), 'hello world foo bar baz');
});

test('wrapText: empty string returns [""]', () => {
    assert.deepEqual(wrapText('', 10), ['']);
});

test('wrapText: zero width returns text unchanged', () => {
    assert.deepEqual(wrapText('hello', 0), ['hello']);
});

test('wrapText: single word longer than width gets split', () => {
    const lines = wrapText('abcdefghijklmnop', 5);
    assert.ok(lines.every(l => l.length <= 5), `line too long: ${JSON.stringify(lines)}`);
    assert.equal(lines.join(''), 'abcdefghijklmnop');
});

// --- wrapText: Infinity, NaN, negative width edge cases (pass 9) ---

test('wrapText: Infinity width returns text unchanged', () => {
    assert.deepEqual(wrapText('hello world', Infinity), ['hello world']);
});

test('wrapText: NaN width returns text unchanged', () => {
    assert.deepEqual(wrapText('hello world', NaN), ['hello world']);
});

test('wrapText: negative width returns text unchanged', () => {
    assert.deepEqual(wrapText('hello world', -5), ['hello world']);
});

// --- parseTicketFrontmatter ---

function withTempFile(content, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const file = path.join(dir, 'rick_ticket_test.md');
    fs.writeFileSync(file, content);
    try {
        fn(file);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
}

test('parseTicketFrontmatter: parses valid frontmatter', () => {
    withTempFile(`---\nid: abc123\ntitle: Test Ticket\nstatus: Todo\norder: 10\n---\n# Body\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.id, 'abc123');
        assert.equal(result.title, 'Test Ticket');
        assert.equal(result.status, 'Todo');
        assert.equal(result.order, 10);
    });
});

test('parseTicketFrontmatter: strips quotes from status', () => {
    withTempFile(`---\nid: x\ntitle: T\nstatus: "Done"\norder: 1\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.status, 'Done');
    });
});

test('parseTicketFrontmatter: strips single quotes from title', () => {
    withTempFile(`---\nid: x\ntitle: 'My Ticket'\nstatus: Todo\norder: 1\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.title, 'My Ticket');
    });
});

test('parseTicketFrontmatter: missing frontmatter returns null', () => {
    withTempFile(`# No frontmatter\n\nJust content.`, (file) => {
        assert.equal(parseTicketFrontmatter(file), null);
    });
});

test('parseTicketFrontmatter: non-existent file returns null', () => {
    assert.equal(parseTicketFrontmatter('/tmp/nonexistent_pickle_test_xyz.md'), null);
});

function withTempSessionTicket(id, status, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-session-'));
    const ticketDir = path.join(dir, id);
    fs.mkdirSync(ticketDir);
    const file = path.join(ticketDir, `rick_ticket_${id}.md`);
    fs.writeFileSync(file, `---\nid: ${id}\ntitle: T\nstatus: ${status}\norder: 1\n---\n`);
    try {
        fn(dir, file);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
}

// --- getTicketStatus ---

test('getTicketStatus: reads each status type from ticket frontmatter', () => {
    for (const status of ['Todo', 'In Progress', 'Done', 'Skipped']) {
        withTempSessionTicket(`ticket-${status.toLowerCase().replace(/\s+/g, '-')}`, status, (dir) => {
            assert.equal(getTicketStatus(dir, `ticket-${status.toLowerCase().replace(/\s+/g, '-')}`), status);
        });
    }
});

test('getTicketStatus: strips quoted status via frontmatter parser', () => {
    withTempSessionTicket('quoted', '"Done"', (dir) => {
        assert.equal(getTicketStatus(dir, 'quoted'), 'Done');
    });
});

test('getTicketStatus: rereads frontmatter on each access', () => {
    withTempSessionTicket('reread', 'Todo', (dir, file) => {
        assert.equal(getTicketStatus(dir, 'reread'), 'Todo');
        fs.writeFileSync(file, `---\nid: reread\ntitle: T\nstatus: Done\norder: 1\n---\n`);
        assert.equal(getTicketStatus(dir, 'reread'), 'Done');
    });
});

test('getTicketStatus: missing ticket throws MissingTicketError', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-session-'));
    try {
        assert.throws(
            () => getTicketStatus(dir, 'missing'),
            (err) => err instanceof MissingTicketError && err.ticketId === 'missing'
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('parseTicketFrontmatter: missing order defaults to 0', () => {
    withTempFile(`---\nid: x\ntitle: T\nstatus: Todo\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.order, 0);
    });
});

test('parseTicketFrontmatter: non-numeric order defaults to 0 (NaN guard)', () => {
    withTempFile(`---\nid: x\ntitle: T\nstatus: Todo\norder: abc\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.order, 0);
        assert.strictEqual(typeof result.order, 'number');
    });
});

// --- parseTicketFrontmatter: type field ---

test('parseTicketFrontmatter: extracts type field when present', () => {
    withTempFile(`---\nid: r1a2b3c4\ntitle: "Review: correctness"\nstatus: Todo\norder: 35\ntype: review\n---\n# Review\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.type, 'review');
    });
});

test('parseTicketFrontmatter: type is null when absent (backward compat)', () => {
    withTempFile(`---\nid: abc123\ntitle: Test Ticket\nstatus: Todo\norder: 10\n---\n# Body\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.type, null);
    });
});

// --- parseTicketFrontmatter: working_dir field ---

test('parseTicketFrontmatter: extracts working_dir when present', () => {
    withTempFile(`---\nid: wd1\ntitle: Add API\nstatus: Todo\norder: 10\nworking_dir: subdir/\n---\n# Body\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.working_dir, 'subdir/');
    });
});

test('parseTicketFrontmatter: working_dir is null when absent (backward compat)', () => {
    withTempFile(`---\nid: abc123\ntitle: Test Ticket\nstatus: Todo\norder: 10\n---\n# Body\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.working_dir, null);
    });
});

// --- collectTickets ---

test('collectTickets: review tickets sorted by order alongside impl tickets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        // impl ticket at order 10
        const sub1 = path.join(dir, 'impl1');
        fs.mkdirSync(sub1);
        fs.writeFileSync(path.join(sub1, 'rick_ticket_impl1.md'),
            '---\nid: impl1\ntitle: Implement foo\nstatus: Done\norder: 10\n---\n');
        // review ticket at order 15
        const sub2 = path.join(dir, 'rev1');
        fs.mkdirSync(sub2);
        fs.writeFileSync(path.join(sub2, 'rick_ticket_rev1.md'),
            '---\nid: rev1\ntitle: "Review: impl1"\nstatus: Todo\norder: 15\ntype: review\n---\n');
        // impl ticket at order 20
        const sub3 = path.join(dir, 'impl2');
        fs.mkdirSync(sub3);
        fs.writeFileSync(path.join(sub3, 'rick_ticket_impl2.md'),
            '---\nid: impl2\ntitle: Implement bar\nstatus: Todo\norder: 20\n---\n');

        const tickets = collectTickets(dir);
        assert.equal(tickets.length, 3);
        assert.equal(tickets[0].id, 'impl1');
        assert.equal(tickets[1].id, 'rev1');
        assert.equal(tickets[1].type, 'review');
        assert.equal(tickets[2].id, 'impl2');
        assert.equal(tickets[2].type, null);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('collectTickets: returns tickets sorted by order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        for (const [id, order, status] of [['aaa', 20, 'Todo'], ['bbb', 10, 'Done']]) {
            const sub = path.join(dir, id);
            fs.mkdirSync(sub);
            fs.writeFileSync(path.join(sub, `rick_ticket_${id}.md`),
                `---\nid: ${id}\ntitle: Ticket ${id}\nstatus: ${status}\norder: ${order}\n---\n`);
        }
        const tickets = collectTickets(dir);
        assert.equal(tickets.length, 2);
        assert.equal(tickets[0].id, 'bbb');  // order 10 comes first
        assert.equal(tickets[1].id, 'aaa');  // order 20 comes second
        // AC-SSV-05: backward-compatible — no depends_on means topo sort
        // degenerates to pure-order sort, and depends_on defaults to [].
        assert.deepEqual(tickets[0].depends_on, []);
        assert.deepEqual(tickets[1].depends_on, []);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('collectTickets: ignores non-ticket files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'abc');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'research_2025-01-01.md'), '# Research');
        fs.writeFileSync(path.join(sub, 'plan_2025-01-01.md'), '# Plan');
        const tickets = collectTickets(dir);
        assert.equal(tickets.length, 0);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('collectTickets: empty directory returns []', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        assert.deepEqual(collectTickets(dir), []);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('collectTickets: non-existent directory returns []', () => {
    assert.deepEqual(collectTickets('/tmp/nonexistent_pickle_dir_xyz'), []);
});

// --- buildHandoffSummary: Number() coercion (deep review pass 8) ---

test('buildHandoffSummary: undefined iteration and string max_iterations are coerced', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        // Create a minimal state.json so collectTickets can run
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const summary = buildHandoffSummary(
            { iteration: undefined, max_iterations: "5", step: 'implement' },
            dir
        );
        // With Number() coercion: undefined → 0, "5" → 5, so output is "0 of 5"
        assert.match(summary, /Iteration: 0 of 5/,
            'undefined iteration should coerce to 0, string max_iterations to 5');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('buildHandoffSummary: zero max_iterations shows just iteration number', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const summary = buildHandoffSummary(
            { iteration: "3", max_iterations: 0, step: 'prd' },
            dir
        );
        // max_iterations=0 means unlimited, so no "of N" suffix
        assert.match(summary, /Iteration: 3\n/,
            'zero max_iterations should show just the iteration number');
        assert.ok(!summary.includes('of 0'),
            'should not show "of 0" for unlimited iterations');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- buildHandoffSummary: new session vs resume detection ---

test('buildHandoffSummary: iteration 1 with no history shows NEW SESSION', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const summary = buildHandoffSummary(
            { iteration: 0, max_iterations: 50, step: 'prd', history: [] },
            dir,
            1
        );
        assert.match(summary, /THIS IS A NEW SESSION/,
            'first iteration with empty history should indicate new session');
        assert.ok(!summary.includes('Resume from current phase'),
            'should not say "Resume" on a new session');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('buildHandoffSummary: iteration 2 shows resume message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const summary = buildHandoffSummary(
            { iteration: 1, max_iterations: 50, step: 'implement', history: [{ step: 'prd' }] },
            dir,
            2
        );
        assert.match(summary, /Resume from current phase/,
            'later iterations should say resume');
        assert.ok(!summary.includes('NEW SESSION'),
            'should not say NEW SESSION on resume');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('buildHandoffSummary: iteration 1 with existing history shows resume', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const summary = buildHandoffSummary(
            { iteration: 3, max_iterations: 50, step: 'implement', history: [{ step: 'prd' }] },
            dir,
            1
        );
        assert.match(summary, /Resume from current phase/,
            'iteration 1 with non-zero state.iteration should still say resume');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('buildHandoffSummary: no iterationNum defaults to new-session detection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const summary = buildHandoffSummary(
            { iteration: 0, max_iterations: 50, step: 'prd', history: [] },
            dir
        );
        assert.match(summary, /THIS IS A NEW SESSION/,
            'undefined iterationNum with iteration=0 and empty history should be new session');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- buildHandoffSummary: [REVIEW] tag for review tickets ---

test('buildHandoffSummary: shows [REVIEW] tag for review tickets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        // Create an impl ticket and a review ticket
        const implDir = path.join(dir, 'impl1');
        fs.mkdirSync(implDir);
        fs.writeFileSync(path.join(implDir, 'rick_ticket_impl1.md'),
            '---\nid: impl1\ntitle: Implement foo\nstatus: Done\norder: 10\n---\n');
        const revDir = path.join(dir, 'rev1');
        fs.mkdirSync(revDir);
        fs.writeFileSync(path.join(revDir, 'rick_ticket_rev1.md'),
            '---\nid: rev1\ntitle: "Review: impl1"\nstatus: Todo\norder: 15\ntype: review\n---\n');

        const summary = buildHandoffSummary({ step: 'research', iteration: 1 }, dir);
        assert.match(summary, /rev1:.*\[REVIEW\]/, 'review ticket should show [REVIEW] tag');
        assert.ok(!summary.includes('impl1') || !summary.match(/impl1:.*\[REVIEW\]/),
            'implementation ticket should NOT show [REVIEW] tag');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- buildHandoffSummary: working_dir per-ticket display ---

test('buildHandoffSummary: shows directory context when working_dir differs from session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const ticketDir = path.join(dir, 'wd1');
        fs.mkdirSync(ticketDir);
        fs.writeFileSync(path.join(ticketDir, 'rick_ticket_wd1.md'),
            '---\nid: wd1\ntitle: Add API endpoint\nstatus: Todo\norder: 10\nworking_dir: api/\n---\n');

        const summary = buildHandoffSummary({ step: 'implement', iteration: 1, working_dir: '/project' }, dir);
        assert.match(summary, /wd1: Add API endpoint \(api\/\)/, 'should show (api/) after title');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('buildHandoffSummary: omits parenthetical when working_dir is null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const ticketDir = path.join(dir, 'nowd');
        fs.mkdirSync(ticketDir);
        fs.writeFileSync(path.join(ticketDir, 'rick_ticket_nowd.md'),
            '---\nid: nowd\ntitle: Fix the thing\nstatus: Todo\norder: 10\n---\n');

        const summary = buildHandoffSummary({ step: 'implement', iteration: 1 }, dir);
        assert.ok(!summary.match(/Fix the thing\s*\(/), 'should NOT have parenthetical after title');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('buildHandoffSummary: omits parenthetical when working_dir matches session root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const ticketDir = path.join(dir, 'same');
        fs.mkdirSync(ticketDir);
        fs.writeFileSync(path.join(ticketDir, 'rick_ticket_same.md'),
            '---\nid: same\ntitle: Same dir task\nstatus: Todo\norder: 10\nworking_dir: /project\n---\n');

        const summary = buildHandoffSummary({ step: 'implement', iteration: 1, working_dir: '/project' }, dir);
        assert.ok(!summary.match(/Same dir task\s*\(/), 'should NOT show parenthetical when working_dir matches session');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- pruneOldSessions ---

test('pruneOldSessions: does nothing when sessionsRoot does not exist', () => {
    assert.doesNotThrow(() => pruneOldSessions('/tmp/nonexistent_sessions_root_xyz'));
});

test('pruneOldSessions: removes old inactive session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-'));
    try {
        const sessionDir = path.join(root, 'old-session');
        fs.mkdirSync(sessionDir);
        const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ active: false, started_at: oldDate }));
        pruneOldSessions(root, 7);
        assert.equal(fs.existsSync(sessionDir), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('pruneOldSessions: keeps recent inactive session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-'));
    try {
        const sessionDir = path.join(root, 'recent-session');
        fs.mkdirSync(sessionDir);
        const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ active: false, started_at: recentDate }));
        pruneOldSessions(root, 7);
        assert.equal(fs.existsSync(sessionDir), true);
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

test('pruneOldSessions: never removes active session regardless of age', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-'));
    try {
        const sessionDir = path.join(root, 'active-session');
        fs.mkdirSync(sessionDir);
        const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ active: true, started_at: oldDate }));
        pruneOldSessions(root, 7);
        assert.equal(fs.existsSync(sessionDir), true);
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

test('pruneOldSessions: skips entries without state.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-'));
    try {
        const orphanDir = path.join(root, 'orphan-no-state');
        fs.mkdirSync(orphanDir);
        pruneOldSessions(root, 7);
        assert.equal(fs.existsSync(orphanDir), true); // untouched
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// NaN from corrupt started_at — falls back to mtime (deep review pass 5)
// ---------------------------------------------------------------------------

test('pruneOldSessions: corrupt started_at falls back to mtime for age check', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-'));
    try {
        const sessionDir = path.join(root, 'corrupt-date-session');
        fs.mkdirSync(sessionDir);
        // Write state with corrupt started_at — Date("not-a-date") produces NaN
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: false, started_at: 'not-a-date' })
        );
        // Set mtime to 10 days ago so the session is old enough to prune
        const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        fs.utimesSync(sessionDir, oldTime, oldTime);

        pruneOldSessions(root, 7);
        assert.equal(
            fs.existsSync(sessionDir),
            false,
            'Should prune session with corrupt started_at using mtime fallback'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('pruneOldSessions: corrupt started_at but recent mtime is kept', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-'));
    try {
        const sessionDir = path.join(root, 'corrupt-recent-session');
        fs.mkdirSync(sessionDir);
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: false, started_at: 'not-a-date' })
        );
        // mtime is recent (default, just created) → should NOT be pruned

        pruneOldSessions(root, 7);
        assert.equal(
            fs.existsSync(sessionDir),
            true,
            'Should keep session with corrupt started_at but recent mtime'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// --- markTicketDone ---

test('markTicketDone: updates unquoted Todo to Done', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'abc123');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'rick_ticket_abc123.md'),
            '---\nid: abc123\ntitle: Test\nstatus: Todo\norder: 10\n---\nBody');
        const result = markTicketDone(dir, 'abc123');
        assert.equal(result, true);
        const content = fs.readFileSync(path.join(sub, 'rick_ticket_abc123.md'), 'utf-8');
        assert.ok(content.includes('status: "Done"'), `Expected status: "Done", got: ${content}`);
        assert.ok(content.includes('Body'), 'Body should be preserved');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketDone: updates quoted "In Progress" to Done', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'def456');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'rick_ticket_def456.md'),
            '---\nid: def456\ntitle: Test\nstatus: "In Progress"\norder: 10\n---\n');
        const result = markTicketDone(dir, 'def456');
        assert.equal(result, true);
        const content = fs.readFileSync(path.join(sub, 'rick_ticket_def456.md'), 'utf-8');
        assert.ok(content.includes('status: "Done"'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketDone: no-op when already Done', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'ghi789');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'rick_ticket_ghi789.md'),
            '---\nid: ghi789\ntitle: Test\nstatus: "Done"\norder: 10\n---\n');
        const result = markTicketDone(dir, 'ghi789');
        assert.equal(result, false, 'Should return false when already Done');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketDone: returns false for nonexistent ticket dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        assert.equal(markTicketDone(dir, 'nonexistent'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketDone: returns false when no rick_ticket_ file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'jkl012');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'research_notes.md'), '# Notes');
        assert.equal(markTicketDone(dir, 'jkl012'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketDone: inserts completed_at timestamp', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'ts1');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'rick_ticket_ts1.md'),
            '---\nid: ts1\ntitle: Test\nstatus: Todo\norder: 10\n---\nBody');
        const result = markTicketDone(dir, 'ts1');
        assert.equal(result, true);
        const content = fs.readFileSync(path.join(sub, 'rick_ticket_ts1.md'), 'utf-8');
        assert.ok(content.includes('status: "Done"'));
        assert.match(content, /completed_at: "\d{4}-\d{2}-\d{2}T/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketDone: replaces existing completed_at timestamp instead of duplicating it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'ts2');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'rick_ticket_ts2.md'),
            '---\nid: ts2\ntitle: Test\nstatus: Todo\norder: 10\ncompleted_at: "2026-03-01T00:00:00.000Z"\n---\nBody');
        const result = markTicketDone(dir, 'ts2');
        assert.equal(result, true);
        const content = fs.readFileSync(path.join(sub, 'rick_ticket_ts2.md'), 'utf-8');
        assert.equal((content.match(/^completed_at:/gm) || []).length, 1);
        assert.doesNotMatch(content, /completed_at: "2026-03-01T00:00:00.000Z"/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- markTicketSkipped ---

test('markTicketSkipped: updates Todo to Skipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'skip1');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'rick_ticket_skip1.md'),
            '---\nid: skip1\ntitle: Test\nstatus: Todo\norder: 10\n---\nBody');
        const result = markTicketSkipped(dir, 'skip1');
        assert.equal(result, true);
        const content = fs.readFileSync(path.join(sub, 'rick_ticket_skip1.md'), 'utf-8');
        assert.ok(content.includes('status: "Skipped"'), `Expected status: "Skipped", got: ${content}`);
        assert.ok(content.includes('Body'), 'Body should be preserved');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketSkipped: inserts skipped_at timestamp', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'skip2');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'rick_ticket_skip2.md'),
            '---\nid: skip2\ntitle: Test\nstatus: "In Progress"\norder: 10\n---\n');
        const result = markTicketSkipped(dir, 'skip2');
        assert.equal(result, true);
        const content = fs.readFileSync(path.join(sub, 'rick_ticket_skip2.md'), 'utf-8');
        assert.ok(content.includes('status: "Skipped"'));
        assert.match(content, /skipped_at: "\d{4}-\d{2}-\d{2}T/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketSkipped: replaces existing skipped_at timestamp instead of duplicating it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'skip4');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'rick_ticket_skip4.md'),
            '---\nid: skip4\ntitle: Test\nstatus: Todo\norder: 10\nskipped_at: "2026-03-01T00:00:00.000Z"\n---\n');
        const result = markTicketSkipped(dir, 'skip4');
        assert.equal(result, true);
        const content = fs.readFileSync(path.join(sub, 'rick_ticket_skip4.md'), 'utf-8');
        assert.equal((content.match(/^skipped_at:/gm) || []).length, 1);
        assert.doesNotMatch(content, /skipped_at: "2026-03-01T00:00:00.000Z"/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketSkipped: no-op when already Skipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        const sub = path.join(dir, 'skip3');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'rick_ticket_skip3.md'),
            '---\nid: skip3\ntitle: Test\nstatus: "Skipped"\norder: 10\n---\n');
        const result = markTicketSkipped(dir, 'skip3');
        assert.equal(result, false, 'Should return false when already Skipped');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('markTicketSkipped: returns false for nonexistent ticket dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        assert.equal(markTicketSkipped(dir, 'nonexistent'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- parseTicketFrontmatter: timestamps ---

test('parseTicketFrontmatter: reads completed_at and skipped_at when present', () => {
    withTempFile(`---\nid: x\ntitle: T\nstatus: Done\norder: 1\ncompleted_at: "2026-03-09T12:00:00.000Z"\nskipped_at: "2026-03-08T10:00:00.000Z"\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.completed_at, '2026-03-09T12:00:00.000Z');
        assert.equal(result.skipped_at, '2026-03-08T10:00:00.000Z');
    });
});

test('parseTicketFrontmatter: completed_at and skipped_at null when absent', () => {
    withTempFile(`---\nid: x\ntitle: T\nstatus: Todo\norder: 1\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.completed_at, null);
        assert.equal(result.skipped_at, null);
    });
});

// --- buildHandoffSummary: Skipped ticket note ---

test('buildHandoffSummary: shows "(no verified completion — re-attempt)" for Skipped tickets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const ticketDir = path.join(dir, 'skip1');
        fs.mkdirSync(ticketDir);
        fs.writeFileSync(path.join(ticketDir, 'rick_ticket_skip1.md'),
            '---\nid: skip1\ntitle: Skipped task\nstatus: "Skipped"\norder: 10\n---\n');

        const summary = buildHandoffSummary({ step: 'implement', iteration: 1 }, dir);
        assert.match(summary, /no verified completion — re-attempt/,
            'Skipped ticket should show re-attempt note');
        assert.match(summary, /\[!\] skip1/,
            'Skipped ticket should show [!] symbol');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('buildHandoffSummary: does not show re-attempt note for Done or Todo tickets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const doneDir = path.join(dir, 'done1');
        fs.mkdirSync(doneDir);
        fs.writeFileSync(path.join(doneDir, 'rick_ticket_done1.md'),
            '---\nid: done1\ntitle: Done task\nstatus: "Done"\norder: 10\n---\n');
        const todoDir = path.join(dir, 'todo1');
        fs.mkdirSync(todoDir);
        fs.writeFileSync(path.join(todoDir, 'rick_ticket_todo1.md'),
            '---\nid: todo1\ntitle: Todo task\nstatus: Todo\norder: 20\n---\n');

        const summary = buildHandoffSummary({ step: 'implement', iteration: 1 }, dir);
        assert.ok(!summary.includes('no verified completion'),
            'Done and Todo tickets should NOT show re-attempt note');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- buildHandoffSummary: multi-repo warning ---

test('buildHandoffSummary: includes MULTI-REPO warning when tickets span 2+ working_dirs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const t1 = path.join(dir, 'api1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'rick_ticket_api1.md'),
            '---\nid: api1\ntitle: API task\nstatus: Todo\norder: 10\nworking_dir: api/\n---\n');
        const t2 = path.join(dir, 'web1');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'rick_ticket_web1.md'),
            '---\nid: web1\ntitle: Web task\nstatus: Todo\norder: 20\nworking_dir: web/\n---\n');

        const summary = buildHandoffSummary({ step: 'implement', iteration: 1 }, dir);
        assert.match(summary, /MULTI-REPO/, 'should contain MULTI-REPO warning');
        assert.match(summary, /api\//, 'should mention api/');
        assert.match(summary, /web\//, 'should mention web/');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('buildHandoffSummary: omits MULTI-REPO warning for single working_dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const t1 = path.join(dir, 'a1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'rick_ticket_a1.md'),
            '---\nid: a1\ntitle: Task A\nstatus: Todo\norder: 10\nworking_dir: api/\n---\n');
        const t2 = path.join(dir, 'a2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'rick_ticket_a2.md'),
            '---\nid: a2\ntitle: Task B\nstatus: Todo\norder: 20\nworking_dir: api/\n---\n');

        const summary = buildHandoffSummary({ step: 'implement', iteration: 1 }, dir);
        assert.ok(!summary.includes('MULTI-REPO'), 'should NOT contain MULTI-REPO warning');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- withRetryLock ---

test('withRetryLock: executes fn and returns result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retrylock-'));
    try {
        const lockPath = path.join(dir, 'test.lock');
        const result = withRetryLock(lockPath, () => 99);
        assert.equal(result, 99);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('withRetryLock: lock file cleaned up after fn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retrylock-'));
    try {
        const lockPath = path.join(dir, 'test.lock');
        withRetryLock(lockPath, () => {});
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('withRetryLock: lock file cleaned up when fn throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retrylock-'));
    try {
        const lockPath = path.join(dir, 'test.lock');
        assert.throws(() => withRetryLock(lockPath, () => { throw new Error('kaboom'); }), /kaboom/);
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('withRetryLock: writes PID into lock file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retrylock-'));
    try {
        const lockPath = path.join(dir, 'test.lock');
        let pidInLock;
        withRetryLock(lockPath, () => {
            // The lock carries a nonce header line ahead of the caller's payload (R-LSPC-2:
            // the bytes are the identity, since an inode number can be recycled). The pid is
            // the payload — the last line.
            const raw = fs.readFileSync(lockPath, 'utf-8');
            pidInLock = raw.slice(raw.indexOf('\n') + 1).trim();
        });
        assert.equal(pidInLock, String(process.pid));
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('withRetryLock: throws LockError after maxRetries exhausted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retrylock-'));
    try {
        const lockPath = path.join(dir, 'stuck.lock');
        // Holder must be a LIVE pid: a fresh mtime alone no longer protects a lock, since a
        // provably-dead holder is stolen on sight. This process is the one pid we know is alive.
        const fd = fs.openSync(lockPath, 'w');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);

        let threw = false;
        try {
            // maxRetries=2, baseLockDelayMs=1 — fast failure for test
            withRetryLock(lockPath, () => {}, { maxRetries: 2, baseLockDelayMs: 1, lockJitter: false });
        } catch (e) {
            threw = true;
            assert.ok(e instanceof LockError, `Expected LockError, got ${e?.constructor?.name}`);
            assert.match(e.message, /after 2 retries/);
        }
        assert.ok(threw, 'Should have thrown LockError');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('withRetryLock: retries and steals lock that becomes stale during backoff sleep', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retrylock-'));
    try {
        const lockPath = path.join(dir, 'becomes-stale.lock');
        // Place a fresh lock (mtime = now)
        fs.writeFileSync(lockPath, '0');

        // staleLockTimeoutMs=50ms, baseLockDelayMs=60ms, lockJitter=false
        // First attempt: lock fresh → EEXIST, sleep 60ms (2^0 * 60)
        // Second attempt: lock is now ~60ms old > 50ms → stolen → success
        const result = withRetryLock(lockPath, () => 'retried-ok', {
            maxRetries: 3,
            baseLockDelayMs: 60,
            lockJitter: false,
            staleLockTimeoutMs: 50,
        });
        assert.equal(result, 'retried-ok');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('withRetryLock: steals stale lock (age > staleLockTimeoutMs) and succeeds', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retrylock-'));
    try {
        const lockPath = path.join(dir, 'stale.lock');
        // LIVE holder + mtime 35s in the past: the liveness path cannot fire, so a steal here
        // proves the mtime branch still works on its own.
        fs.writeFileSync(lockPath, String(process.pid));
        const staleTime = new Date(Date.now() - 35_000);
        fs.utimesSync(lockPath, staleTime, staleTime);

        const result = withRetryLock(lockPath, () => 'stolen', { staleLockTimeoutMs: 30_000 });
        assert.equal(result, 'stolen');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('withRetryLock: does NOT steal fresh lock (age < staleLockTimeoutMs)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retrylock-'));
    try {
        const lockPath = path.join(dir, 'fresh.lock');        // Lock mtime = now (fresh)
        fs.writeFileSync(lockPath, String(process.pid));      // ...held by a LIVE pid

        let threw = false;
        try {
            withRetryLock(lockPath, () => {}, {
                maxRetries: 1,
                baseLockDelayMs: 1,
                lockJitter: false,
                staleLockTimeoutMs: 30_000,
            });
        } catch (e) {
            threw = true;
            assert.ok(e instanceof LockError);
        }
        assert.ok(threw, 'Fresh lock should not be stolen — LockError expected');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- withRetryLock: dead-holder steal (abrupt-death strand) ---
//
// A holder killed by SIGKILL/OOM/crash leaves its lock behind with a FRESH mtime. Pre-fix the pid
// in the lock file was never read back, so the only recovery was the staleLockTimeoutMs window —
// which the retry budget (~26.3s over 10 attempts) expires before, so a contender took a LockError
// after 26.5s and setup.ts registered no session (fails open at :1765). StateManager's lock has
// always done the dead-pid steal (state-manager.ts:861); this is the same check on the other lock.

/** A pid that cannot be alive: probed with kill(pid, 0) until ESRCH. */
function findDeadPid() {
    for (let pid = 60000; pid < 65000; pid++) {
        try {
            process.kill(pid, 0);
        } catch (e) {
            if (e.code === 'ESRCH') return pid;
        }
    }
    throw new Error('no dead pid available on this host');
}

test('withRetryLock: steals a FRESH lock whose holder pid is provably dead', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retrylock-'));
    try {
        const lockPath = path.join(dir, 'current_sessions.json.lock');
        fs.writeFileSync(lockPath, String(findDeadPid()));   // fresh mtime, dead holder

        // maxRetries:0 — the steal must happen on the FIRST pass or there is no retry to save it.
        const result = withRetryLock(lockPath, () => 'acquired', { maxRetries: 0 });
        assert.equal(result, 'acquired');
        assert.equal(fs.existsSync(lockPath), false, 'lock released after fn');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('withRetryLock: dead-holder steal does not burn the retry budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retrylock-'));
    try {
        const lockPath = path.join(dir, 'current_sessions.json.lock');
        fs.writeFileSync(lockPath, String(findDeadPid()));

        // Default opts: pre-fix this threw LockError after ~26.5s of backoff sleeps.
        const start = Date.now();
        const result = withRetryLock(lockPath, () => 'acquired');
        const elapsed = Date.now() - start;

        assert.equal(result, 'acquired');
        assert.ok(elapsed < 2000, `expected immediate steal, took ${elapsed}ms`);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('withRetryLock: does NOT steal a fresh lock with an empty payload (holder died mid-write)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retrylock-'));
    try {
        // tryRunWithExclusiveLock creates the file, THEN writes the pid. A contender reading in
        // that window sees ''. An unaccountable holder must defer to the mtime window, never be
        // treated as dead — otherwise we steal from a live holder mid-acquisition.
        const lockPath = path.join(dir, 'empty.lock');
        fs.writeFileSync(lockPath, '');

        assert.throws(
            () => withRetryLock(lockPath, () => {}, { maxRetries: 1, baseLockDelayMs: 1, lockJitter: false }),
            LockError,
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- resolveSessionPath ---

test('resolveSessionPath: returns string entry unchanged (legacy format)', () => {
    assert.equal(resolveSessionPath('/some/session/path'), '/some/session/path');
});

test('resolveSessionPath: extracts sessionPath from SessionMapEntry object', () => {
    assert.equal(
        resolveSessionPath({ sessionPath: '/session/dir', pid: 12345 }),
        '/session/dir'
    );
});

test('resolveSessionPath: returns empty string for undefined entry', () => {
    assert.equal(resolveSessionPath(undefined), '');
});

test('resolveSessionPath: returns empty string for null entry', () => {
    assert.equal(resolveSessionPath(null), '');
});

test('resolveSessionPath: returns empty string for object missing sessionPath', () => {
    assert.equal(resolveSessionPath({ pid: 9999 }), '');
});

test('resolveSessionPath: returns empty string for empty string', () => {
    assert.equal(resolveSessionPath(''), '');
});

// --- Session map entry PID ---

test('session map entry: setup writes SessionMapEntry with PID', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-sessions-map-'));
    try {
        const mapPath = path.join(dir, 'current_sessions.json');
        const lockPath = mapPath + '.lock';
        const sessionPath = path.join(dir, 'session-abc');
        const cwd = '/fake/working/dir';

        // Simulate what setup.ts:updateSessionMap writes
        withRetryLock(lockPath, () => {
            const entry = { sessionPath, pid: process.pid };
            fs.writeFileSync(mapPath, JSON.stringify({ [cwd]: entry }, null, 2));
        });

        const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
        const entry = map[cwd];
        assert.equal(typeof entry, 'object', 'Entry should be an object');
        assert.equal(entry.sessionPath, sessionPath);
        assert.equal(entry.pid, process.pid);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('session map entry: resolveSessionPath handles both old and new format in same map', () => {
    const legacyEntry = '/legacy/session/path';
    const newEntry = { sessionPath: '/new/session/path', pid: 42 };

    assert.equal(resolveSessionPath(legacyEntry), '/legacy/session/path');
    assert.equal(resolveSessionPath(newEntry), '/new/session/path');
});

// --- parseTicketFrontmatter: complexity_tier ---

test('parseTicketFrontmatter: parses valid complexity_tier', () => {
    withTempFile(`---\nid: x\ntitle: T\nstatus: Todo\norder: 1\ncomplexity_tier: small\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.complexity_tier, 'small');
    });
});

test('parseTicketFrontmatter: invalid complexity_tier defaults to medium', () => {
    withTempFile(`---\nid: x\ntitle: T\nstatus: Todo\norder: 1\ncomplexity_tier: huge\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.complexity_tier, 'medium');
    });
});

test('parseTicketFrontmatter: missing complexity_tier defaults to medium', () => {
    withTempFile(`---\nid: x\ntitle: T\nstatus: Todo\norder: 1\n---\n`, (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.complexity_tier, 'medium');
    });
});

test('parseTicketFrontmatter: all 4 valid complexity_tier values accepted', () => {
    for (const tier of ['trivial', 'small', 'medium', 'large']) {
        withTempFile(`---\nid: x\ntitle: T\nstatus: Todo\norder: 1\ncomplexity_tier: ${tier}\n---\n`, (file) => {
            const result = parseTicketFrontmatter(file);
            assert.equal(result.complexity_tier, tier, `tier '${tier}' should be accepted`);
        });
    }
});

// --- buildHandoffSummary: complexity_tier display ---

test('buildHandoffSummary: shows tier tag for non-medium tiers, omits for medium', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        const t1 = path.join(dir, 'triv1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'rick_ticket_triv1.md'),
            '---\nid: triv1\ntitle: Trivial task\nstatus: Todo\norder: 10\ncomplexity_tier: trivial\n---\n');
        const t2 = path.join(dir, 'sm1');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'rick_ticket_sm1.md'),
            '---\nid: sm1\ntitle: Small task\nstatus: Todo\norder: 20\ncomplexity_tier: small\n---\n');
        const t3 = path.join(dir, 'med1');
        fs.mkdirSync(t3);
        fs.writeFileSync(path.join(t3, 'rick_ticket_med1.md'),
            '---\nid: med1\ntitle: Medium task\nstatus: Todo\norder: 30\ncomplexity_tier: medium\n---\n');
        const t4 = path.join(dir, 'lg1');
        fs.mkdirSync(t4);
        fs.writeFileSync(path.join(t4, 'rick_ticket_lg1.md'),
            '---\nid: lg1\ntitle: Large task\nstatus: Todo\norder: 40\ncomplexity_tier: large\n---\n');

        const summary = buildHandoffSummary({ step: 'implement', iteration: 1 }, dir);
        assert.match(summary, /\[trivial\]/, 'trivial tier should show tag');
        assert.match(summary, /\[small\]/, 'small tier should show tag');
        assert.ok(!summary.includes('[medium]'), 'medium tier should NOT show tag');
        assert.match(summary, /\[large\]/, 'large tier should show tag');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- R-SHB-6: pruneOrphanedMapEntries ---

test('R-SHB-6 pruneOrphanedMapEntries: removes entries whose session_dir is missing', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-prune-'));
    try {
        const sessionsDir = path.join(dataRoot, 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        const liveSession = path.join(sessionsDir, 'live-1234');
        fs.mkdirSync(liveSession, { recursive: true });
        fs.writeFileSync(path.join(liveSession, 'state.json'), JSON.stringify({ active: true }));

        const map = {
            '/cwd/live': { sessionPath: liveSession, pid: 999 },
            '/cwd/dead-dir': { sessionPath: path.join(sessionsDir, 'never-existed'), pid: 1000 },
            '/cwd/legacy-string': path.join(sessionsDir, 'also-missing'),
        };
        const mapPath = path.join(dataRoot, 'current_sessions.json');
        fs.writeFileSync(mapPath, JSON.stringify(map));

        const result = pruneOrphanedMapEntries(dataRoot);

        assert.equal(result.pruned, 2);
        assert.equal(result.total, 3);

        const written = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
        assert.deepEqual(Object.keys(written), ['/cwd/live']);
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('R-SHB-6 pruneOrphanedMapEntries: idempotent on clean map', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-prune-clean-'));
    try {
        const sessionsDir = path.join(dataRoot, 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        const liveSession = path.join(sessionsDir, 'live-1');
        fs.mkdirSync(liveSession, { recursive: true });
        fs.writeFileSync(path.join(liveSession, 'state.json'), '{}');
        fs.writeFileSync(
            path.join(dataRoot, 'current_sessions.json'),
            JSON.stringify({ '/cwd': { sessionPath: liveSession, pid: 1 } }),
        );

        const first = pruneOrphanedMapEntries(dataRoot);
        const second = pruneOrphanedMapEntries(dataRoot);

        assert.equal(first.pruned, 0);
        assert.equal(first.total, 1);
        assert.equal(second.pruned, 0);
        assert.equal(second.total, 1);
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('R-SHB-6 pruneOrphanedMapEntries: missing map file is a no-op', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-prune-empty-'));
    try {
        const result = pruneOrphanedMapEntries(dataRoot);

        assert.equal(result.pruned, 0);
        assert.equal(result.total, 0);
        assert.equal(fs.existsSync(path.join(dataRoot, 'current_sessions.json')), false);
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('R-SHB-6 pruneOrphanedMapEntries: removes entries whose state.json is missing even if dir exists', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-prune-no-state-'));
    try {
        const sessionsDir = path.join(dataRoot, 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        const dirNoState = path.join(sessionsDir, 'orphan-dir');
        fs.mkdirSync(dirNoState, { recursive: true });
        // dir exists but no state.json inside

        fs.writeFileSync(
            path.join(dataRoot, 'current_sessions.json'),
            JSON.stringify({ '/cwd': { sessionPath: dirNoState, pid: 1 } }),
        );

        const result = pruneOrphanedMapEntries(dataRoot);

        assert.equal(result.pruned, 1);
        const map = JSON.parse(fs.readFileSync(path.join(dataRoot, 'current_sessions.json'), 'utf-8'));
        assert.deepEqual(map, {});
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

// --- R-CNAR-8 helper unit test (parametrized via describe.each pattern) ---

test('clearTicketCacheFields: clears all 5 fields when populated', () => {
    const state = {
        current_ticket: null,
        current_ticket_tier: 'small',
        current_ticket_budget: 10,
        current_ticket_max_iterations: 10,
        current_ticket_worker_timeout_seconds: 600,
        current_ticket_budget_start_iteration: 0,
    };
    const cleared = clearTicketCacheFields(state);
    assert.equal(cleared, 5);
    assert.equal(state.current_ticket_tier, undefined);
    assert.equal(state.current_ticket_budget, undefined);
    assert.equal(state.current_ticket_max_iterations, undefined);
    assert.equal(state.current_ticket_worker_timeout_seconds, undefined);
    assert.equal(state.current_ticket_budget_start_iteration, undefined);
});

test('clearTicketCacheFields: idempotent on already-clean state', () => {
    const state = { current_ticket: null };
    assert.equal(clearTicketCacheFields(state), 0);
    assert.equal(clearTicketCacheFields(state), 0);
});

// --- R-SJET-4-PRE: new microverse helper functions ---

test('resolveJudgeBackend: default (no settings, no state) -> claude', () => {
    const result = resolveJudgeBackend({});
    assert.equal(result, 'claude');
});

test('resolveJudgeBackend: state.flags.judge_backend_override = codex -> codex', () => {
    const result = resolveJudgeBackend({ flags: { judge_backend_override: 'codex' } });
    assert.equal(result, 'codex');
});

test('resolveJudgeBackend: judge backend auto -> claude at attempt 0 with no prior failure', () => {
    const settings = {
        microverse: {
            judge_backend: 'auto',
        },
    };
    const result = resolveJudgeBackend({}, settings, 0);
    assert.equal(result, 'claude');
});

test('resolveJudgeBackend: auto + state.judge_backend_resolved -> codex', () => {
    const settings = { microverse: { judge_backend: 'auto' } };
    const state = { flags: {}, judge_backend_resolved: 'codex' };
    const result = resolveJudgeBackend(state, settings, 2);
    assert.equal(result, 'codex');
});

test('getMicroverseSettings: defaults apply when settings missing', () => {
    const result = getMicroverseSettings(null);
    assert.equal(result.judge_backend, 'claude');
    assert.equal(result.judge_backend_fallback, 'codex');
    assert.equal(result.judge_model_claude, 'claude-sonnet-4-6');
    assert.equal(result.judge_model_codex, 'gpt-5.4');
});

// --- AP-EXT-ITER8-01: runCmd output is complete or an error, never truncated ---
//
// Asserts the ROUND TRIP (byte count of what the child actually wrote), never
// "did it throw" or "is it non-empty": before the fix, `check: false` returned a
// 1,114,112-byte prefix of a 2 MB write with no signal at all, so any liveness
// or parseability oracle greens over the bug it is meant to catch.

const BIG_OUTPUT_BYTES = 3 * 1024 * 1024;
const emitBytes = (n) => `process.stdout.write("x".repeat(${n}))`;

test('AP-EXT-ITER8-01: runCmd argv-form returns a >1MB payload byte-complete (check: false)', () => {
    const out = runCmd([process.execPath, '-e', emitBytes(BIG_OUTPUT_BYTES)], { check: false });
    assert.equal(out.length, BIG_OUTPUT_BYTES);
});

test('AP-EXT-ITER8-01: runCmd argv-form returns a >1MB payload byte-complete (check: true)', () => {
    const out = runCmd([process.execPath, '-e', emitBytes(BIG_OUTPUT_BYTES)], { check: true });
    assert.equal(out.length, BIG_OUTPUT_BYTES);
});

test('AP-EXT-ITER8-01: runCmd shell-form returns a >1MB payload byte-complete', () => {
    const out = runCmd(`${process.execPath} -e '${emitBytes(BIG_OUTPUT_BYTES)}'`, { check: false });
    assert.equal(out.length, BIG_OUTPUT_BYTES);
});

test('AP-EXT-ITER8-01: past the ceiling runCmd THROWS rather than returning a prefix — check: false too', () => {
    // 65 MB clears RUN_CMD_MAX_BUFFER (64 MB). `check: false` is the load-bearing
    // half: those callers degrade to '' on a FAILED command, and pre-fix they
    // silently accepted a truncated payload from a command that SUCCEEDED.
    const over = 65 * 1024 * 1024;
    for (const check of [false, true]) {
        assert.throws(
            () => runCmd([process.execPath, '-e', emitBytes(over)], { check }),
            /exceeded .* bytes and was truncated/,
            `check: ${check} must not return a truncated prefix`,
        );
    }
});

test('AP-EXT-ITER8-01: a stderr-less spawn failure names its cause instead of throwing a bare "Error: "', () => {
    assert.throws(
        () => runCmd(['definitely-not-a-real-binary-ap-ext-iter8'], { check: true }),
        (err) => /Command failed:/.test(err.message) && !/\nError: $/.test(err.message),
    );
});
