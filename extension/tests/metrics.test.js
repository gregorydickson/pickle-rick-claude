// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    parseSessionLine,
    scanSessionFiles,
    parseGitLogOutput,
    scanGitRepos,
    shortenSlug,
    formatNumber,
    buildReport,
} from '../services/metrics-utils.js';
import { formatLocalDateKey } from '../services/pickle-utils.js';
import { parseMetricsArgs } from '../bin/metrics.js';

const CLI_PATH = path.join(import.meta.dirname, '..', 'bin', 'metrics.js');

function runMetricsCli(args, env = {}) {
    // Every CLI run gets its own empty data root. Without one, main() scans the
    // HOST's activity log (GBs of JSONL) and writes the host's metrics cache:
    // measured 22s standalone vs ~0s isolated, and 22-45s in the parallel fast
    // tier, where the verdict then depended on other tests' I/O load. The
    // timeout is a hang guard, not a budget. A caller-supplied
    // PICKLE_DATA_ROOT still wins.
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-cli-data-'));
    try {
        return spawnSync(process.execPath, [CLI_PATH, ...args], {
            encoding: 'utf-8',
            timeout: 45000,
            env: { ...process.env, PICKLE_DATA_ROOT: dataRoot, ...env },
        });
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
}

function makeTempProjectsDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-'));
    const cacheFile = path.join(root, 'metrics-cache.json');
    return { root, cacheFile };
}

function toLocalDateStr(date) {
    return formatLocalDateKey(date);
}

function withBrokenCanadianDateLocale(fn) {
    const original = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleDateString = function (locale, ...args) {
        if (locale === 'en-CA') {
            return '04/27/2026';
        }
        return original.call(this, locale, ...args);
    };
    try {
        fn();
    } finally {
        Date.prototype.toLocaleDateString = original;
    }
}

function git(env, cwd, args) {
    const result = spawnSync('git', args, {
        cwd,
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        timeout: 15000,
    });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function makeIsoAtNoon(date) {
    return new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        12, 0, 0, 0,
    ).toISOString();
}

function writeSessionLine(dir, slug, jsonlFilename, line) {
    const slugDir = path.join(dir, slug);
    fs.mkdirSync(slugDir, { recursive: true });
    fs.appendFileSync(path.join(slugDir, jsonlFilename), JSON.stringify(line) + '\n');
}

function makeAssistantLine(timestamp, input, output, cacheRead = 0, cacheCreate = 0, backend = undefined) {
    const line = {
        type: 'assistant',
        timestamp,
        message: {
            usage: {
                input_tokens: input,
                output_tokens: output,
                cache_read_input_tokens: cacheRead,
                cache_creation_input_tokens: cacheCreate,
            },
        },
    };
    if (backend !== undefined) line.backend = backend;
    return line;
}

// ---------------------------------------------------------------------------
// parseSessionLine
// ---------------------------------------------------------------------------

test('parseSessionLine: valid assistant line', () => {
    const line = JSON.stringify(makeAssistantLine('2026-02-28T10:00:00Z', 100, 200, 50, 25));
    const result = parseSessionLine(line);
    assert.ok(result);
    assert.equal(result.timestamp, '2026-02-28T10:00:00Z');
    assert.equal(result.usage.input, 100);
    assert.equal(result.usage.output, 200);
    assert.equal(result.usage.cache_read, 50);
    assert.equal(result.usage.cache_create, 25);
});

test('parseSessionLine: non-assistant type returns null', () => {
    const line = JSON.stringify({ type: 'human', timestamp: '2026-02-28T10:00:00Z', message: { usage: { input_tokens: 10, output_tokens: 20 } } });
    assert.equal(parseSessionLine(line), null);
});

test('parseSessionLine: corrupt JSON returns null', () => {
    assert.equal(parseSessionLine('NOT VALID JSON {{{'), null);
});

test('parseSessionLine: missing usage returns null', () => {
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-02-28T10:00:00Z', message: {} });
    assert.equal(parseSessionLine(line), null);
});

test('parseSessionLine: missing timestamp returns null', () => {
    const line = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 20 } } });
    assert.equal(parseSessionLine(line), null);
});

test('parseSessionLine: numeric timestamp returns null', () => {
    const line = JSON.stringify({ type: 'assistant', timestamp: 12345, message: { usage: { input_tokens: 10, output_tokens: 20 } } });
    assert.equal(parseSessionLine(line), null);
});

test('parseSessionLine: invalid timestamp returns null', () => {
    const line = JSON.stringify(makeAssistantLine('not-a-date', 10, 20));
    assert.equal(parseSessionLine(line), null);
});

// ---------------------------------------------------------------------------
// formatNumber
// ---------------------------------------------------------------------------

test('formatNumber: 0 returns "0"', () => {
    assert.equal(formatNumber(0), '0');
});

test('formatNumber: 999 returns "999"', () => {
    assert.equal(formatNumber(999), '999');
});

test('formatNumber: 1000 returns "1.0K"', () => {
    assert.equal(formatNumber(1000), '1.0K');
});

test('formatNumber: 1234567 returns "1.2M"', () => {
    assert.equal(formatNumber(1234567), '1.2M');
});

test('formatNumber: 1234567890 returns "1.2B"', () => {
    assert.equal(formatNumber(1234567890), '1.2B');
});

test('formatNumber: NaN returns "0"', () => {
    assert.equal(formatNumber(NaN), '0');
});

test('formatNumber: Infinity returns "0"', () => {
    assert.equal(formatNumber(Infinity), '0');
});

test('formatNumber: negative number', () => {
    assert.equal(formatNumber(-1500), '-1.5K');
});

// ---------------------------------------------------------------------------
// shortenSlug
// ---------------------------------------------------------------------------

test('shortenSlug: strips user prefix', () => {
    const username = os.userInfo().username;
    const slug = `-Users-${username}-myproject`;
    assert.equal(shortenSlug(slug), 'myproject');
});

test('shortenSlug: replaces loanlight- prefix', () => {
    const username = os.userInfo().username;
    const slug = `-Users-${username}-loanlight-api`;
    assert.equal(shortenSlug(slug), 'l/api');
});

test('shortenSlug: passthrough for unmatched slug', () => {
    assert.equal(shortenSlug('other-project'), 'other-project');
});

test('shortenSlug: handles loanlight- without user prefix', () => {
    assert.equal(shortenSlug('loanlight-shared'), 'l/shared');
});

// ---------------------------------------------------------------------------
// parseGitLogOutput
// ---------------------------------------------------------------------------

test('parseGitLogOutput: normal two-commit output', () => {
    const output = [
        '2026-02-28T10:00:00-06:00',
        ' 3 files changed, 50 insertions(+), 10 deletions(-)',
        '2026-02-28T09:00:00-06:00',
        ' 1 file changed, 5 insertions(+)',
    ].join('\n');
    const result = parseGitLogOutput(output);
    assert.equal(result.size, 1);
    const entry = result.get('2026-02-28');
    assert.ok(entry);
    assert.equal(entry.commits, 2);
    assert.equal(entry.added, 55);
    assert.equal(entry.removed, 10);
});

test('parseGitLogOutput: merge commit with no stat line', () => {
    const output = [
        '2026-02-27T14:00:00-06:00',
        '',
        '2026-02-27T12:00:00-06:00',
        ' 2 files changed, 20 insertions(+), 5 deletions(-)',
    ].join('\n');
    const result = parseGitLogOutput(output);
    const entry = result.get('2026-02-27');
    assert.ok(entry);
    assert.equal(entry.commits, 2);
    assert.equal(entry.added, 20);
    assert.equal(entry.removed, 5);
});

test('parseGitLogOutput: empty output', () => {
    const result = parseGitLogOutput('');
    assert.equal(result.size, 0);
});

test('parseGitLogOutput: multi-day output', () => {
    const output = [
        '2026-02-28T10:00:00-06:00',
        ' 1 file changed, 10 insertions(+)',
        '2026-02-27T10:00:00-06:00',
        ' 1 file changed, 20 insertions(+), 3 deletions(-)',
    ].join('\n');
    const result = parseGitLogOutput(output);
    assert.equal(result.size, 2);
    assert.equal(result.get('2026-02-28').added, 10);
    assert.equal(result.get('2026-02-27').added, 20);
    assert.equal(result.get('2026-02-27').removed, 3);
});

test('parseGitLogOutput: deletions only', () => {
    const output = [
        '2026-02-28T10:00:00-06:00',
        ' 2 files changed, 8 deletions(-)',
    ].join('\n');
    const result = parseGitLogOutput(output);
    const entry = result.get('2026-02-28');
    assert.ok(entry);
    assert.equal(entry.added, 0);
    assert.equal(entry.removed, 8);
});

// ---------------------------------------------------------------------------
// scanSessionFiles
// ---------------------------------------------------------------------------

test('scanSessionFiles: scans JSONL and returns correct map', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        writeSessionLine(root, 'my-project', 'session.jsonl',
            makeAssistantLine('2026-02-28T10:00:00Z', 100, 200, 50, 25));
        writeSessionLine(root, 'my-project', 'session.jsonl',
            makeAssistantLine('2026-02-28T11:00:00Z', 150, 300, 60, 30));

        const result = scanSessionFiles(root, '2026-02-28', '2026-02-28', cacheFile);
        assert.equal(result.size, 1);
        assert.ok(result.has('my-project'));
        const dateMap = result.get('my-project');
        assert.ok(dateMap.has('2026-02-28'));
        const tokens = dateMap.get('2026-02-28');
        assert.equal(tokens.turns, 2);
        assert.equal(tokens.input, 250);
        assert.equal(tokens.output, 500);
        assert.equal(tokens.cache_read, 110);
        assert.equal(tokens.cache_create, 55);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: keeps YYYY-MM-DD buckets even when locale formatting falls back', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        writeSessionLine(
            root,
            'my-project',
            'session.jsonl',
            makeAssistantLine(new Date(2026, 1, 28, 12, 0, 0, 0).toISOString(), 100, 200)
        );

        let result;
        withBrokenCanadianDateLocale(() => {
            result = scanSessionFiles(root, '2026-02-28', '2026-02-28', cacheFile);
        });

        assert.equal(result.size, 1);
        const dateMap = result.get('my-project');
        assert.ok(dateMap);
        assert.ok(dateMap.has('2026-02-28'));
        assert.equal(dateMap.get('2026-02-28').turns, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: cache hit returns same data', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        writeSessionLine(root, 'cached-proj', 'sess.jsonl',
            makeAssistantLine('2026-02-28T10:00:00Z', 100, 200));

        const result1 = scanSessionFiles(root, '2026-02-28', '2026-02-28', cacheFile);
        assert.ok(fs.existsSync(cacheFile), 'cache file should be created');

        const result2 = scanSessionFiles(root, '2026-02-28', '2026-02-28', cacheFile);
        const t1 = result1.get('cached-proj').get('2026-02-28');
        const t2 = result2.get('cached-proj').get('2026-02-28');
        assert.equal(t1.turns, t2.turns);
        assert.equal(t1.input, t2.input);
        assert.equal(t1.output, t2.output);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: promotes newer dead-writer cache tmp before cache hit', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        const timestamp = '2026-02-28T10:00:00Z';
        writeSessionLine(root, 'tmp-cache-proj', 'sess.jsonl', makeAssistantLine(timestamp, 100, 200));

        const sessionFile = path.join(root, 'tmp-cache-proj', 'sess.jsonl');
        const stat = fs.statSync(sessionFile);
        const currentTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
        const staleDate = '2026-02-28';
        const tmpPath = `${cacheFile}.tmp.99999999`;

        fs.writeFileSync(cacheFile, JSON.stringify({
            version: 2,
            time_zone: currentTimeZone,
            files: {
                [sessionFile]: {
                    mtime: stat.mtimeMs,
                    size: stat.size,
                    data: {
                        [staleDate]: {
                            turns: 9,
                            input: 999,
                            output: 999,
                            cache_read: 0,
                            cache_create: 0,
                        },
                    },
                },
            },
        }));
        fs.writeFileSync(tmpPath, JSON.stringify({
            version: 2,
            time_zone: currentTimeZone,
            files: {
                [sessionFile]: {
                    mtime: stat.mtimeMs,
                    size: stat.size,
                    data: {
                        [staleDate]: {
                            turns: 1,
                            input: 100,
                            output: 200,
                            cache_read: 0,
                            cache_create: 0,
                        },
                    },
                },
            },
        }));
        const future = new Date(Date.now() + 1000);
        fs.utimesSync(tmpPath, future, future);

        const result = scanSessionFiles(root, staleDate, staleDate, cacheFile);
        const tokens = result.get('tmp-cache-proj').get(staleDate);
        assert.equal(tokens.turns, 1);
        assert.equal(tokens.input, 100);
        assert.equal(tokens.output, 200);
        assert.equal(fs.existsSync(tmpPath), false, 'dead cache tmp should be consumed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: timezone-mismatched cache is rebuilt from source JSONL', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        const timestamp = '2026-02-28T12:00:00Z';
        writeSessionLine(root, 'tz-proj', 'sess.jsonl', makeAssistantLine(timestamp, 100, 200));

        const sessionFile = path.join(root, 'tz-proj', 'sess.jsonl');
        const stat = fs.statSync(sessionFile);
        const actualDate = toLocalDateStr(new Date(timestamp));
        const staleDate = actualDate === '2026-02-28' ? '2026-02-27' : '2026-02-28';
        const currentTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';

        fs.writeFileSync(cacheFile, JSON.stringify({
            version: 2,
            time_zone: '__stale_timezone__',
            files: {
                [sessionFile]: {
                    mtime: stat.mtimeMs,
                    size: stat.size,
                    data: {
                        [staleDate]: {
                            turns: 9,
                            input: 999,
                            output: 999,
                            cache_read: 0,
                            cache_create: 0,
                        },
                    },
                },
            },
        }));

        const result = scanSessionFiles(root, actualDate, actualDate, cacheFile);
        const dateMap = result.get('tz-proj');
        assert.ok(dateMap);
        assert.ok(dateMap.has(actualDate));
        assert.ok(!dateMap.has(staleDate));
        const tokens = dateMap.get(actualDate);
        assert.equal(tokens.turns, 1);
        assert.equal(tokens.input, 100);
        assert.equal(tokens.output, 200);

        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        assert.equal(cache.time_zone, currentTimeZone);
        assert.equal(cache.files[sessionFile].data[actualDate].input, 100);
        assert.ok(!(staleDate in cache.files[sessionFile].data));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: invalid transcript timestamps do not pollute cache buckets', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        writeSessionLine(root, 'bad-ts-proj', 'sess.jsonl', makeAssistantLine('not-a-date', 100, 200));

        const result = scanSessionFiles(root, '2026-02-28', '2026-02-28', cacheFile);
        assert.equal(result.size, 0, 'invalid timestamp line should not produce report rows');

        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        const sessionFile = path.join(root, 'bad-ts-proj', 'sess.jsonl');
        assert.deepEqual(cache.files[sessionFile].data, {}, 'invalid timestamp line should not create NaN date buckets');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: date range filtering', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        writeSessionLine(root, 'proj', 'sess.jsonl',
            makeAssistantLine('2026-02-25T10:00:00Z', 100, 200));
        writeSessionLine(root, 'proj', 'sess.jsonl',
            makeAssistantLine('2026-02-28T10:00:00Z', 150, 300));

        const result = scanSessionFiles(root, '2026-02-27', '2026-02-28', cacheFile);
        const dateMap = result.get('proj');
        assert.ok(dateMap);
        assert.ok(dateMap.has('2026-02-28'));
        assert.ok(!dateMap.has('2026-02-25'), 'Should exclude dates before since');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: skips files over 50MB', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        const slugDir = path.join(root, 'big-project');
        fs.mkdirSync(slugDir, { recursive: true });
        const bigFile = path.join(slugDir, 'session.jsonl');
        const fd = fs.openSync(bigFile, 'w');
        const line = JSON.stringify(makeAssistantLine('2026-02-28T10:00:00Z', 100, 200)) + '\n';
        const chunk = line.repeat(1000);
        for (let i = 0; i < Math.ceil((51 * 1024 * 1024) / chunk.length); i++) {
            fs.writeSync(fd, chunk);
        }
        fs.closeSync(fd);

        const result = scanSessionFiles(root, '2026-02-28', '2026-02-28', cacheFile);
        assert.ok(!result.has('big-project'), 'Should skip files > 50MB');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanSessionFiles: filters out -private-var- slugs', () => {
    const { root, cacheFile } = makeTempProjectsDir();
    try {
        writeSessionLine(root, '-private-var-folders-abc', 'sess.jsonl',
            makeAssistantLine('2026-02-28T10:00:00Z', 100, 200));
        writeSessionLine(root, 'real-project', 'sess.jsonl',
            makeAssistantLine('2026-02-28T10:00:00Z', 100, 200));

        const result = scanSessionFiles(root, '2026-02-28', '2026-02-28', cacheFile);
        assert.ok(!result.has('-private-var-folders-abc'), 'Should filter temp-dir slugs');
        assert.ok(result.has('real-project'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('metrics.hermes-bucket: mixed backend session reports separate backend totals and Hermes column', () => {
    const { root, cacheFile: _ } = makeTempProjectsDir();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-data-root-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-repos-'));
    try {
        const today = formatLocalDateKey(new Date());
        writeSessionLine(root, 'mixed-backend-project', 'session.jsonl',
            makeAssistantLine(`${today}T10:00:00Z`, 100, 200, 0, 0, 'claude'));
        writeSessionLine(root, 'mixed-backend-project', 'session.jsonl',
            makeAssistantLine(`${today}T11:00:00Z`, 50, 800, 0, 0, 'hermes'));
        writeSessionLine(root, 'mixed-backend-project', 'session.jsonl',
            makeAssistantLine(`${today}T12:00:00Z`, 25, 300, 0, 0, 'codex'));

        const jsonResult = runMetricsCli(['--days', '0', '--json'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
            PICKLE_DATA_ROOT: dataRoot,
        });
        assert.equal(jsonResult.status, 0, `stderr: ${jsonResult.stderr}`);
        const report = JSON.parse(jsonResult.stdout);
        assert.equal(report.totals.output, 1300);
        assert.equal(report.tokens_per_backend.claude.output, 200);
        assert.equal(report.tokens_per_backend.codex.output, 300);
        assert.equal(report.tokens_per_backend.hermes.output, 800);

        const tableResult = runMetricsCli(['--days', '0'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
            PICKLE_DATA_ROOT: dataRoot,
        });
        assert.equal(tableResult.status, 0, `stderr: ${tableResult.stderr}`);
        assert.match(tableResult.stdout, /Hermes/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('metrics.backend-columns: newer backends (gemini) are never silently dropped from the per-backend breakdown', () => {
    const { root } = makeTempProjectsDir();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-data-root-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-repos-'));
    try {
        const today = formatLocalDateKey(new Date());
        // A claude turn plus a gemini turn — gemini is in BACKENDS but had no column before HS-13.
        writeSessionLine(root, 'multi-backend-project', 'session.jsonl',
            makeAssistantLine(`${today}T10:00:00Z`, 100, 200, 0, 0, 'claude'));
        writeSessionLine(root, 'multi-backend-project', 'session.jsonl',
            makeAssistantLine(`${today}T11:00:00Z`, 50, 700, 0, 0, 'gemini'));

        const jsonResult = runMetricsCli(['--days', '0', '--json'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
            PICKLE_DATA_ROOT: dataRoot,
        });
        assert.equal(jsonResult.status, 0, `stderr: ${jsonResult.stderr}`);
        const report = JSON.parse(jsonResult.stdout);
        assert.equal(report.totals.output, 900);
        assert.equal(report.tokens_per_backend.gemini.output, 700);

        const tableResult = runMetricsCli(['--days', '0'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
            PICKLE_DATA_ROOT: dataRoot,
        });
        assert.equal(tableResult.status, 0, `stderr: ${tableResult.stderr}`);
        // The gemini output must surface as its own column, not vanish into the total.
        assert.match(tableResult.stdout, /Gemini/);
        assert.match(tableResult.stdout, /Claude/);

        const weeklyResult = runMetricsCli(['--days', '0', '--weekly'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
            PICKLE_DATA_ROOT: dataRoot,
        });
        assert.equal(weeklyResult.status, 0, `stderr: ${weeklyResult.stderr}`);
        assert.match(weeklyResult.stdout, /Gemini/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('metrics.backend-columns: a backend with zero output in the window gets no column', () => {
    const { root } = makeTempProjectsDir();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-data-root-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-repos-'));
    try {
        const today = formatLocalDateKey(new Date());
        writeSessionLine(root, 'claude-only-project', 'session.jsonl',
            makeAssistantLine(`${today}T10:00:00Z`, 100, 200, 0, 0, 'claude'));

        const tableResult = runMetricsCli(['--days', '0'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
            PICKLE_DATA_ROOT: dataRoot,
        });
        assert.equal(tableResult.status, 0, `stderr: ${tableResult.stderr}`);
        assert.match(tableResult.stdout, /Claude/);
        // No gemini activity → no Gemini column (keeps the table readable).
        assert.doesNotMatch(tableResult.stdout, /Gemini/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('scanSessionFiles: nonexistent directory returns empty map', () => {
    const result = scanSessionFiles('/nonexistent/path', '2026-02-28', '2026-02-28', '/tmp/no-cache.json');
    assert.equal(result.size, 0);
});

test('scanGitRepos: filters out commits dated after the report until day', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-git-root-'));
    const repoDir = path.join(repoRoot, 'future-dated-repo');
    fs.mkdirSync(repoDir, { recursive: true });

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayStr = toLocalDateStr(today);
    const yesterdayStr = toLocalDateStr(yesterday);
    const tomorrowStr = toLocalDateStr(tomorrow);

    try {
        git({}, repoDir, ['init']);
        git({}, repoDir, ['config', 'user.name', 'Metrics Test']);
        git({}, repoDir, ['config', 'user.email', 'metrics@example.com']);

        fs.writeFileSync(path.join(repoDir, 'report.txt'), 'today\n');
        git(
            {
                GIT_AUTHOR_DATE: makeIsoAtNoon(today),
                GIT_COMMITTER_DATE: makeIsoAtNoon(today),
            },
            repoDir,
            ['add', 'report.txt'],
        );
        git(
            {
                GIT_AUTHOR_DATE: makeIsoAtNoon(today),
                GIT_COMMITTER_DATE: makeIsoAtNoon(today),
            },
            repoDir,
            ['commit', '-m', 'today commit'],
        );

        fs.writeFileSync(path.join(repoDir, 'report.txt'), 'tomorrow\n');
        git(
            {
                GIT_AUTHOR_DATE: makeIsoAtNoon(tomorrow),
                GIT_COMMITTER_DATE: makeIsoAtNoon(tomorrow),
            },
            repoDir,
            ['add', 'report.txt'],
        );
        git(
            {
                GIT_AUTHOR_DATE: makeIsoAtNoon(tomorrow),
                GIT_COMMITTER_DATE: makeIsoAtNoon(tomorrow),
            },
            repoDir,
            ['commit', '-m', 'future commit'],
        );

        const loc = scanGitRepos(repoRoot, yesterdayStr, todayStr);
        const repoStats = loc.get(repoDir.replace(/[\\/]/g, '-'));
        assert.ok(repoStats, 'expected repo stats for in-range commit');
        assert.ok(repoStats.has(todayStr), 'today commit should be included');
        assert.ok(!repoStats.has(tomorrowStr), 'future-dated commit must be excluded');
        assert.equal(repoStats.get(todayStr).commits, 1);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

test('buildReport: daily grouping with token and LOC data', () => {
    const tokens = new Map([
        ['proj-a', new Map([
            ['2026-02-27', { turns: 5, input: 1000, output: 2000, cache_read: 100, cache_create: 50 }],
            ['2026-02-28', { turns: 3, input: 500, output: 1000, cache_read: 50, cache_create: 25 }],
        ])],
    ]);
    const loc = new Map([
        ['proj-a', new Map([
            ['2026-02-28', { commits: 2, added: 100, removed: 20 }],
        ])],
    ]);

    const report = buildReport(tokens, loc, '2026-02-27', '2026-02-28', 'daily');
    assert.equal(report.since, '2026-02-27');
    assert.equal(report.until, '2026-02-28');
    assert.equal(report.grouping, 'daily');
    assert.equal(report.rows.length, 2);
    assert.equal(report.rows[0].date, '2026-02-27');
    assert.equal(report.rows[1].date, '2026-02-28');
    assert.equal(report.totals.turns, 8);
    assert.equal(report.totals.input, 1500);
    assert.equal(report.totals.output, 3000);
    assert.equal(report.totals.commits, 2);
    assert.equal(report.totals.added, 100);
    assert.equal(report.totals.removed, 20);
});

test('buildReport: weekly grouping value preserved', () => {
    const tokens = new Map();
    const loc = new Map();
    const report = buildReport(tokens, loc, '2026-02-01', '2026-02-28', 'weekly');
    assert.equal(report.grouping, 'weekly');
});

test('buildReport: empty maps produce empty report', () => {
    const tokens = new Map();
    const loc = new Map();
    const report = buildReport(tokens, loc, '2026-02-28', '2026-02-28', 'daily');
    assert.equal(report.rows.length, 0);
    assert.equal(report.projects.length, 0);
    assert.equal(report.totals.turns, 0);
    assert.equal(report.totals.commits, 0);
});

test('buildReport: LOC merges into matching project by exact project slug', () => {
    const tokens = new Map([
        ['-Users-greg-loanlight-api', new Map([
            ['2026-02-28', { turns: 1, input: 10, output: 20, cache_read: 0, cache_create: 0 }],
        ])],
    ]);
    const loc = new Map([
        ['-Users-greg-loanlight-api', new Map([
            ['2026-02-28', { commits: 1, added: 50, removed: 10 }],
        ])],
    ]);

    const report = buildReport(tokens, loc, '2026-02-28', '2026-02-28', 'daily');
    const proj = report.projects.find(p => p.slug === '-Users-greg-loanlight-api');
    assert.ok(proj);
    assert.equal(proj.totals.commits, 1);
    assert.equal(proj.totals.added, 50);
    assert.equal(proj.totals.removed, 10);
});

test('buildReport: LOC stays separate when only a fuzzy basename would have matched', () => {
    const tokens = new Map([
        ['-Users-greg-loanlight-api', new Map([
            ['2026-02-28', { turns: 1, input: 10, output: 20, cache_read: 0, cache_create: 0 }],
        ])],
    ]);
    const loc = new Map([
        ['api', new Map([
            ['2026-02-28', { commits: 1, added: 50, removed: 10 }],
        ])],
    ]);

    const report = buildReport(tokens, loc, '2026-02-28', '2026-02-28', 'daily');
    const tokenProject = report.projects.find(p => p.slug === '-Users-greg-loanlight-api');
    const locOnlyProject = report.projects.find(p => p.slug === 'api');
    assert.ok(tokenProject);
    assert.equal(tokenProject.totals.commits, 0, 'fuzzy basename matches must not steal LOC into another slug');
    assert.ok(locOnlyProject);
    assert.equal(locOnlyProject.totals.commits, 1);
    assert.equal(locOnlyProject.totals.added, 50);
    assert.equal(locOnlyProject.totals.removed, 10);
});

// ---------------------------------------------------------------------------
// CLI Integration Tests
// ---------------------------------------------------------------------------

test('CLI: default invocation with mock data', () => {
    const { root, cacheFile: _ } = makeTempProjectsDir();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-repos-'));
    try {
        const today = formatLocalDateKey(new Date());
        writeSessionLine(root, 'test-project', 'session.jsonl',
            makeAssistantLine(`${today}T10:00:00Z`, 100, 200));

        const result = runMetricsCli([], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('CLI: --json outputs valid MetricsReport shape', () => {
    const { root, cacheFile: _ } = makeTempProjectsDir();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-repos-'));
    try {
        const today = formatLocalDateKey(new Date());
        writeSessionLine(root, 'json-project', 'session.jsonl',
            makeAssistantLine(`${today}T10:00:00Z`, 500, 1000, 50, 25));

        const result = runMetricsCli(['--json'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.ok(report.since);
        assert.ok(report.until);
        assert.ok(report.grouping);
        assert.ok(Array.isArray(report.rows));
        assert.ok(Array.isArray(report.projects));
        assert.ok(typeof report.totals === 'object');
        assert.ok(typeof report.totals.turns === 'number');
        assert.ok(typeof report.totals.input === 'number');
        assert.ok(typeof report.totals.output === 'number');
        assert.ok(typeof report.totals.commits === 'number');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('CLI: --json with no data still returns empty MetricsReport JSON', () => {
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-empty-projects-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-empty-repos-'));
    try {
        const result = runMetricsCli(['--json'], {
            CLAUDE_PROJECTS_DIR: projectsRoot,
            METRICS_REPO_ROOT: repoRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.equal(report.grouping, 'daily');
        assert.deepStrictEqual(report.rows, []);
        assert.deepStrictEqual(report.projects, []);
        assert.equal(report.totals.turns, 0);
        assert.equal(report.totals.commits, 0);
    } finally {
        fs.rmSync(projectsRoot, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('CLI: --since future date exits with error', () => {
    const result = runMetricsCli(['--since', '2099-01-01']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /future/);
});

test('CLI: --since impossible calendar date exits with error', () => {
    const result = runMetricsCli(['--since', '2026-02-30']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid date/);
});

test('CLI: unknown flag exits with error', () => {
    const result = runMetricsCli(['--verbose']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown flag/);
});

test('CLI: --days 0 returns today only', () => {
    const { root, cacheFile: _ } = makeTempProjectsDir();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-repos-'));
    try {
        const today = formatLocalDateKey(new Date());
        writeSessionLine(root, 'today-proj', 'session.jsonl',
            makeAssistantLine(`${today}T08:00:00Z`, 100, 200));

        const result = runMetricsCli(['--days', '0', '--json'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.equal(report.until, today, 'Report end date should reflect the last included day');
        for (const row of report.rows) {
            assert.equal(row.date, today, 'All rows should be today');
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('CLI: future-dated git commits do not leak past report.until', () => {
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-empty-projects-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-cli-git-root-'));
    const repoDir = path.join(repoRoot, 'future-dated-repo');
    fs.mkdirSync(repoDir, { recursive: true });

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayStr = toLocalDateStr(today);
    const yesterdayStr = toLocalDateStr(yesterday);
    const tomorrowStr = toLocalDateStr(tomorrow);

    try {
        git({}, repoDir, ['init']);
        git({}, repoDir, ['config', 'user.name', 'Metrics Test']);
        git({}, repoDir, ['config', 'user.email', 'metrics@example.com']);

        fs.writeFileSync(path.join(repoDir, 'report.txt'), 'today\n');
        git(
            {
                GIT_AUTHOR_DATE: makeIsoAtNoon(today),
                GIT_COMMITTER_DATE: makeIsoAtNoon(today),
            },
            repoDir,
            ['add', 'report.txt'],
        );
        git(
            {
                GIT_AUTHOR_DATE: makeIsoAtNoon(today),
                GIT_COMMITTER_DATE: makeIsoAtNoon(today),
            },
            repoDir,
            ['commit', '-m', 'today commit'],
        );

        fs.writeFileSync(path.join(repoDir, 'report.txt'), 'tomorrow\n');
        git(
            {
                GIT_AUTHOR_DATE: makeIsoAtNoon(tomorrow),
                GIT_COMMITTER_DATE: makeIsoAtNoon(tomorrow),
            },
            repoDir,
            ['add', 'report.txt'],
        );
        git(
            {
                GIT_AUTHOR_DATE: makeIsoAtNoon(tomorrow),
                GIT_COMMITTER_DATE: makeIsoAtNoon(tomorrow),
            },
            repoDir,
            ['commit', '-m', 'future commit'],
        );

        const result = runMetricsCli(['--since', yesterdayStr, '--json'], {
            CLAUDE_PROJECTS_DIR: projectsRoot,
            METRICS_REPO_ROOT: repoRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.equal(report.until, todayStr, 'report end date should stay on the requested local day');
        assert.ok(report.rows.every((row) => row.date !== tomorrowStr), 'future rows must be excluded');
        assert.equal(report.totals.commits, 1, 'future-dated commits must not count toward totals');
    } finally {
        fs.rmSync(projectsRoot, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('CLI: nested git repos contribute LOC to the matching nested project slug', () => {
    const { root, cacheFile: _ } = makeTempProjectsDir();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-nested-root-'));
    const repoDir = path.join(repoRoot, 'group', 'nested-repo');
    fs.mkdirSync(repoDir, { recursive: true });

    try {
        const today = formatLocalDateKey(new Date());
        const nestedSlug = repoDir.replace(/[\\/]/g, '-');
        writeSessionLine(root, nestedSlug, 'session.jsonl',
            makeAssistantLine(`${today}T10:00:00Z`, 100, 200));

        git({}, repoDir, ['init']);
        git({}, repoDir, ['config', 'user.name', 'Metrics Test']);
        git({}, repoDir, ['config', 'user.email', 'metrics@example.com']);

        fs.writeFileSync(path.join(repoDir, 'report.txt'), 'nested repo\n');
        git({}, repoDir, ['add', 'report.txt']);
        git(
            {
                GIT_AUTHOR_DATE: `${today}T12:00:00Z`,
                GIT_COMMITTER_DATE: `${today}T12:00:00Z`,
            },
            repoDir,
            ['commit', '-m', 'nested commit'],
        );

        const result = runMetricsCli(['--days', '0', '--json'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);

        const report = JSON.parse(result.stdout);
        const project = report.projects.find((entry) => entry.slug === nestedSlug);
        assert.ok(project, 'expected nested project slug in metrics report');
        assert.equal(project.totals.turns, 1);
        assert.equal(project.totals.commits, 1, 'nested repo commit should merge into the matching project');
        assert.equal(project.totals.added, 1);
        assert.equal(project.totals.removed, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('CLI: git worktrees contribute LOC to the matching worktree project slug', () => {
    const { root, cacheFile: _ } = makeTempProjectsDir();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-worktree-root-'));
    const baseRepoDir = path.join(repoRoot, 'base-repo');
    const worktreeDir = path.join(repoRoot, 'feature-worktree');
    fs.mkdirSync(baseRepoDir, { recursive: true });

    try {
        const today = formatLocalDateKey(new Date());
        const worktreeSlug = worktreeDir.replace(/[\\/]/g, '-');
        writeSessionLine(root, worktreeSlug, 'session.jsonl',
            makeAssistantLine(`${today}T10:00:00Z`, 100, 200));

        git({}, baseRepoDir, ['init']);
        git({}, baseRepoDir, ['config', 'user.name', 'Metrics Test']);
        git({}, baseRepoDir, ['config', 'user.email', 'metrics@example.com']);

        fs.writeFileSync(path.join(baseRepoDir, 'report.txt'), 'base repo\n');
        git({}, baseRepoDir, ['add', 'report.txt']);
        git(
            {
                GIT_AUTHOR_DATE: `${today}T09:00:00Z`,
                GIT_COMMITTER_DATE: `${today}T09:00:00Z`,
            },
            baseRepoDir,
            ['commit', '-m', 'base commit'],
        );
        git({}, baseRepoDir, ['branch', 'feature']);
        git({}, baseRepoDir, ['worktree', 'add', worktreeDir, 'feature']);

        fs.appendFileSync(path.join(worktreeDir, 'report.txt'), 'worktree line\n');
        git({}, worktreeDir, ['add', 'report.txt']);
        git(
            {
                GIT_AUTHOR_DATE: `${today}T12:00:00Z`,
                GIT_COMMITTER_DATE: `${today}T12:00:00Z`,
            },
            worktreeDir,
            ['commit', '-m', 'worktree commit'],
        );

        const result = runMetricsCli(['--days', '0', '--json'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);

        const report = JSON.parse(result.stdout);
        const project = report.projects.find((entry) => entry.slug === worktreeSlug);
        assert.ok(project, 'expected worktree project slug in metrics report');
        assert.equal(project.totals.turns, 1);
        assert.equal(project.totals.commits, 1, 'worktree commit should merge into the matching project');
        assert.equal(project.totals.added, 1);
        assert.equal(project.totals.removed, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// parseMetricsArgs
// ---------------------------------------------------------------------------

test('parseMetricsArgs: no flags defaults to 7 days', () => {
    const result = parseMetricsArgs([]);
    assert.equal(result.days, 7);
    assert.equal(result.since, null);
    assert.equal(result.weekly, false);
    assert.equal(result.json, false);
});

test('parseMetricsArgs: --days 14', () => {
    const result = parseMetricsArgs(['--days', '14']);
    assert.equal(result.days, 14);
});

test('parseMetricsArgs: --days 0', () => {
    const result = parseMetricsArgs(['--days', '0']);
    assert.equal(result.days, 0);
});

test('parseMetricsArgs: --weekly alone defaults to 28 days', () => {
    const result = parseMetricsArgs(['--weekly']);
    assert.equal(result.days, 28);
    assert.equal(result.weekly, true);
});

test('parseMetricsArgs: --weekly --days 14 uses explicit days', () => {
    const result = parseMetricsArgs(['--weekly', '--days', '14']);
    assert.equal(result.days, 14);
    assert.equal(result.weekly, true);
});

test('parseMetricsArgs: --json flag', () => {
    const result = parseMetricsArgs(['--json']);
    assert.equal(result.json, true);
    assert.equal(result.days, 7);
});

test('parseMetricsArgs: --since sets date', () => {
    const result = parseMetricsArgs(['--since', '2026-02-01']);
    assert.equal(result.since, '2026-02-01');
    assert.equal(result.days, 7);
});

test('parseMetricsArgs: combined --json --weekly --days 7', () => {
    const result = parseMetricsArgs(['--json', '--weekly', '--days', '7']);
    assert.equal(result.json, true);
    assert.equal(result.weekly, true);
    assert.equal(result.days, 7);
});

// ---------------------------------------------------------------------------
// parseGitLogOutput: Invalid Date handling
// ---------------------------------------------------------------------------

test('parseGitLogOutput: invalid ISO date is skipped', () => {
    const output = [
        '9999-99-99T00:00:00Z',
        ' 1 file changed, 10 insertions(+)',
        '2026-02-28T10:00:00-06:00',
        ' 1 file changed, 5 insertions(+)',
    ].join('\n');
    const result = parseGitLogOutput(output);
    assert.equal(result.size, 1);
    assert.ok(result.has('2026-02-28'));
    assert.equal(result.get('2026-02-28').added, 5);
});

// ---------------------------------------------------------------------------
// CLI: --weekly integration
// ---------------------------------------------------------------------------

test('CLI: --weekly --json returns weekly grouping', () => {
    const { root, cacheFile: _ } = makeTempProjectsDir();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-metrics-repos-'));
    try {
        const today = formatLocalDateKey(new Date());
        writeSessionLine(root, 'weekly-proj', 'session.jsonl',
            makeAssistantLine(`${today}T10:00:00Z`, 100, 200));

        const result = runMetricsCli(['--weekly', '--json'], {
            CLAUDE_PROJECTS_DIR: root,
            METRICS_REPO_ROOT: repoRoot,
        });
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.equal(report.grouping, 'weekly');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
