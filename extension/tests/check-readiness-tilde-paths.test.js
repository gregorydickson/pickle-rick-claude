// @tier: fast
// R-RTPS-1/R-RTPS-2: regression test for tilde-prefix runtime deploy path skip.
//
// extractContractReferences MUST skip backticked tokens beginning with `~/`,
// `$HOME/`, or `${HOME}/` before PATH_RE or symbol-shape extraction runs.
// These are runtime deploy paths (verified by install.sh parity check) with no
// source-tree counterpart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { extractContractReferences } from '../bin/check-readiness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '../..');

function tmpDir(prefix = 'pickle-rtps-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, body) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, `rick_ticket_${id}.md`);
    fs.writeFileSync(ticketPath, body);
    return ticketPath;
}

function runReadiness(sessionDir, { repoRoot = REPO_ROOT } = {}) {
    return spawnSync(process.execPath, [
        BIN,
        '--session-dir', sessionDir,
        '--repo-root', repoRoot,
        '--contract-only',
    ], { encoding: 'utf-8', timeout: 15000 });
}

// (a) ~/... path in backticks produces no finding
test('R-RTPS-1 (a): extractContractReferences does not include ~/... paths', () => {
    const content = [
        '## Files',
        '',
        'The monitor lives at `~/.claude/pickle-rick/extension/bin/monitor.js` at runtime.',
        '',
        '## Acceptance Criteria',
        '',
        '- [ ] `node --test tests/foo.test.js` exits 0.',
    ].join('\n');
    const refs = extractContractReferences(content);
    const tildeRefs = refs.filter(r => r.startsWith('~/'));
    assert.deepEqual(tildeRefs, [], `expected no ~/... refs, got ${JSON.stringify(refs)}`);
});

// (b) $HOME/... path in backticks produces no finding
test('R-RTPS-1 (b): extractContractReferences does not include $HOME/... paths', () => {
    const content = '`$HOME/.claude/pickle-rick/extension/bin/monitor.js` is deployed at runtime.';
    const refs = extractContractReferences(content);
    const homeRefs = refs.filter(r => r.startsWith('$HOME/'));
    assert.deepEqual(homeRefs, [], `expected no $HOME/... refs, got ${JSON.stringify(refs)}`);
});

// (c) ${HOME}/... path in backticks produces no finding
test('R-RTPS-1 (c): extractContractReferences does not include ${HOME}/... paths', () => {
    const content = '`${HOME}/.claude/pickle-rick/extension/bin/monitor.js` is the runtime path.';
    const refs = extractContractReferences(content);
    const braceRefs = refs.filter(r => r.startsWith('${HOME}/'));
    assert.deepEqual(braceRefs, [], `expected no \${HOME}/... refs, got ${JSON.stringify(refs)}`);
});

// (d) repo-relative path still resolves (exit 0) — uses REPO_ROOT so git ls-files can find the file
test('R-RTPS-1 (d): repo-relative extension/src/bin/check-readiness.ts resolves clean', () => {
    const sessionDir = tmpDir();
    try {
        writeTicket(sessionDir, 'rtps1d01', [
            '---',
            'id: rtps1d01',
            'key: RTPS1-D',
            'ac_ids: []',
            '---',
            '',
            '# Repo-relative path test',
            '',
            '## Files to modify',
            '',
            '- `extension/src/bin/check-readiness.ts`',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] `node --test extension/tests/check-readiness-tilde-paths.test.js` exits 0.',
            '',
        ].join('\n'));
        // Use the true repo root so git ls-files can resolve extension/src/bin/check-readiness.ts
        const result = runReadiness(sessionDir, { repoRoot: REPO_ROOT });
        assert.equal(result.status, 0, `expected exit 0; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        const pathFindings = out.findings.filter(f => f.kind === 'file_path');
        assert.equal(pathFindings.length, 0, `unexpected file_path findings: ${JSON.stringify(pathFindings)}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// (e) Mixed content: tilde path + unresolved repo-relative → only unresolved repo path produces finding
test('R-RTPS-1 (e): mixed content produces findings only for unresolved repo-relative paths', () => {
    const sessionDir = tmpDir();
    try {
        writeTicket(sessionDir, 'rtps1e01', [
            '---',
            'id: rtps1e01',
            'key: RTPS1-E',
            'ac_ids: []',
            '---',
            '',
            '# Mixed tilde + repo-relative paths',
            '',
            '## Files to modify',
            '',
            '- `~/.claude/pickle-rick/extension/bin/monitor.js` — runtime deploy path (not in repo)',
            '- `extension/src/bin/check-readiness-nonexistent-file-xyz.ts` — unresolved repo path',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] `node --test extension/tests/foo.test.js` exits 0.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir);
        // Should fail because the nonexistent repo-relative path is unresolved
        assert.equal(result.status, 2, `expected exit 2; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        // No file_path finding for the tilde path
        const tildeFindings = out.findings.filter(f =>
            f.kind === 'file_path' && f.detail && f.detail.startsWith('~')
        );
        assert.equal(tildeFindings.length, 0, `unexpected tilde file_path findings: ${JSON.stringify(tildeFindings)}`);
        // The unresolved repo path should produce a finding
        const repoFindings = out.findings.filter(f =>
            f.kind === 'file_path' && f.detail && f.detail.includes('check-readiness-nonexistent-file-xyz')
        );
        assert.ok(repoFindings.length > 0, `expected file_path finding for unresolved repo path; findings=${JSON.stringify(out.findings)}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});
