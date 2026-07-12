// @tier: fast
// Tests for the probeConcurrentGitAccess helper (AC-PIWG-5.1.b, .c, .d).
// It is now the only lock-holder probe: the destructive twin in cancel.ts was deleted
// because no probe can license removing a lock git owns. This one stays advisory —
// it may inform an operator, never authorize an unlink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeConcurrentGitAccess } from '../services/git-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GIT_UTILS_SRC = path.resolve(__dirname, '../src/services/git-utils.ts');

// ---------------------------------------------------------------------------
// AC-PIWG-5.1.b — source inspection: no spawnSync/execFileSync without timeout
// inside the probeConcurrentGitAccess function body
// ---------------------------------------------------------------------------

test('probeConcurrentGitAccess: every spawnSync/execFileSync call in function body has timeout option', () => {
    const source = fs.readFileSync(GIT_UTILS_SRC, 'utf8');

    // Extract everything from the function declaration to its closing brace.
    // The function is the last export in the file, so we match from declaration
    // to the end of file and then find the matching closing brace.
    const declStart = source.indexOf('export function probeConcurrentGitAccess(');
    assert.ok(declStart !== -1, 'probeConcurrentGitAccess must exist in git-utils.ts');

    // Find the opening brace of the function body
    const braceStart = source.indexOf('{', declStart);
    assert.ok(braceStart !== -1, 'function must have an opening brace');

    // Walk forward to find the matching closing brace (depth tracking)
    let depth = 1;
    let i = braceStart + 1;
    while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
    }
    const bodyText = source.slice(braceStart + 1, i - 1);

    // Find every spawnSync( or execFileSync( call in the body and assert each
    // one is followed (within the same argument object) by a timeout: option.
    const spawnRe = /spawnSync\s*\(|execFileSync\s*\(/g;
    let m;
    while ((m = spawnRe.exec(bodyText)) !== null) {
        // Get a generous slice after the call start to check for timeout:
        const slice = bodyText.slice(m.index, m.index + 300);
        assert.ok(
            /\btimeout\s*:/.test(slice),
            `spawnSync/execFileSync call at offset ${m.index} inside probeConcurrentGitAccess is missing a timeout: option. Slice: ${slice}`,
        );
    }
});

// ---------------------------------------------------------------------------
// Helpers: create a fake binary dir with configurable exit code and stdout
// ---------------------------------------------------------------------------

function makeFakeBinDir(prefix) {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `probe-test-${prefix}-`)));
}

function writeFakeBin(dir, name, exitCode, stdout = '') {
    const p = path.join(dir, name);
    // Use a Node.js shim so JSON.stringify stdout is correctly interpreted
    // (e.g. "git\n" produces a real newline rather than a literal backslash-n
    // that shell printf '%s' would emit).
    fs.writeFileSync(p, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.exit(${exitCode});\n`);
    fs.chmodSync(p, 0o755);
}

function withPath(fakeDir, fn) {
    const original = process.env.PATH;
    process.env.PATH = `${fakeDir}${path.delimiter}${original ?? ''}`;
    try {
        return fn();
    } finally {
        process.env.PATH = original;
    }
}

function makeFakeLockDir() {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-lock-')));
    const gitDir = path.join(tmpRoot, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    return { tmpRoot, gitDir };
}

// ---------------------------------------------------------------------------
// AC-PIWG-5.1.c — lsof returns a PID → non-null result
// ---------------------------------------------------------------------------

test('probeConcurrentGitAccess: returns { pid, command } when lsof reports a holder', () => {
    const { tmpRoot } = makeFakeLockDir();
    const fakeDir = makeFakeBinDir('lsof-held');
    try {
        writeFakeBin(fakeDir, 'lsof', 0, '12345\n');
        writeFakeBin(fakeDir, 'ps', 0, 'git\n');
        writeFakeBin(fakeDir, 'pgrep', 1, '');

        const result = withPath(fakeDir, () => probeConcurrentGitAccess(tmpRoot));

        assert.ok(result !== null, 'should return a holder when lsof finds a PID');
        assert.equal(result.pid, 12345, 'pid must match lsof output');
        assert.equal(result.command, 'git', 'command must come from ps lookup');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        fs.rmSync(fakeDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC-PIWG-5.1.c — lsof exits 1 (unheld) AND pgrep exits 1 → null
// ---------------------------------------------------------------------------

test('probeConcurrentGitAccess: returns null when lsof exits 1 (no holder) and pgrep exits 1', () => {
    const { tmpRoot } = makeFakeLockDir();
    const fakeDir = makeFakeBinDir('lsof-unheld');
    try {
        writeFakeBin(fakeDir, 'lsof', 1, '');
        writeFakeBin(fakeDir, 'pgrep', 1, '');
        writeFakeBin(fakeDir, 'ps', 0, 'git\n');

        const result = withPath(fakeDir, () => probeConcurrentGitAccess(tmpRoot));

        assert.equal(result, null, 'should return null when both tools confirm no holder');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        fs.rmSync(fakeDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC-PIWG-5.1.c — lsof exits 0 with empty stdout → null (confirmed no holder)
// ---------------------------------------------------------------------------

test('probeConcurrentGitAccess: returns null when lsof exits 0 with empty stdout', () => {
    const { tmpRoot } = makeFakeLockDir();
    const fakeDir = makeFakeBinDir('lsof-empty');
    try {
        writeFakeBin(fakeDir, 'lsof', 0, '');
        writeFakeBin(fakeDir, 'pgrep', 1, '');
        writeFakeBin(fakeDir, 'ps', 0, '');

        const result = withPath(fakeDir, () => probeConcurrentGitAccess(tmpRoot));

        assert.equal(result, null, 'lsof exit 0 + empty stdout means confirmed no holder');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        fs.rmSync(fakeDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC-PIWG-5.1.c — lsof unavailable, pgrep returns PID → non-null
// ---------------------------------------------------------------------------

test('probeConcurrentGitAccess: falls back to pgrep when lsof is unavailable', () => {
    const { tmpRoot } = makeFakeLockDir();
    const fakeDir = makeFakeBinDir('lsof-unavail');
    try {
        // lsof exits 2 (or any non-0, non-1) to signal "unavailable/error"
        writeFakeBin(fakeDir, 'lsof', 2, '');
        writeFakeBin(fakeDir, 'pgrep', 0, '99999\n');
        writeFakeBin(fakeDir, 'ps', 0, 'node\n');

        const result = withPath(fakeDir, () => probeConcurrentGitAccess(tmpRoot));

        assert.ok(result !== null, 'should fall back to pgrep when lsof unavailable');
        assert.equal(result.pid, 99999);
        assert.equal(result.command, 'node');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        fs.rmSync(fakeDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC-PIWG-5.1.d — both tools unavailable: fail-OPEN.
//
// Safe here precisely because the probe is advisory. It warns and emits an event;
// nothing destructive rides on the answer, so an absent probe tool costs a warning,
// not a deleted lock.
// ---------------------------------------------------------------------------

test('probeConcurrentGitAccess: returns null (fail-OPEN) when both lsof and pgrep are unavailable', () => {
    const { tmpRoot } = makeFakeLockDir();
    const fakeDir = makeFakeBinDir('both-unavail-probe');
    try {
        // Both tools error out (non-0, non-1)
        writeFakeBin(fakeDir, 'lsof', 2, '');
        writeFakeBin(fakeDir, 'pgrep', 2, '');
        writeFakeBin(fakeDir, 'ps', 1, '');

        const result = withPath(fakeDir, () => probeConcurrentGitAccess(tmpRoot));

        assert.equal(result, null,
            'probeConcurrentGitAccess must return null (fail-OPEN) when both tools are unavailable');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        fs.rmSync(fakeDir, { recursive: true, force: true });
    }
});
