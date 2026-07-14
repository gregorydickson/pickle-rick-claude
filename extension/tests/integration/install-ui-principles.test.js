// @tier: integration
// AC-PIAP-B3-1: szechuan-sauce-ui-principles.md is installed by install.sh.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

let tmpHome = '';

after(() => {
    if (tmpHome) {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

test('install-ui-principles: szechuan-sauce-ui-principles.md lands under PICKLE_INSTALL_ROOT (AC-PIAP-B3-1)', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ui-principles-'));
    const prefix = path.join(tmpHome, '.claude', 'pickle-rick');

    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), '{}');

    const install = spawnSync('bash', [INSTALL_SH, '--prefix', prefix, '--no-confirm'], {
        encoding: 'utf8',
        timeout: 120_000,
        env: {
            ...process.env,
            HOME: tmpHome,
            PICKLE_INSTALL_ROOT: prefix,
            PICKLE_DATA_ROOT: path.join(tmpHome, '.local', 'share', 'pickle-rick'),
        },
    });

    assert.equal(install.status, 0, `install.sh failed (exit ${install.status}):\n${install.stderr}`);

    const deployedPrinciples = path.join(prefix, 'szechuan-sauce-ui-principles.md');
    assert.ok(
        fs.existsSync(deployedPrinciples),
        `szechuan-sauce-ui-principles.md not found at ${deployedPrinciples} after install.sh`,
    );

    const content = fs.readFileSync(deployedPrinciples, 'utf-8');
    assert.ok(content.includes('Author Intent'), 'deployed ui-principles should contain Author Intent principle');
    assert.ok(content.includes('False Positives'), 'deployed ui-principles should contain False Positives section');

    // Existence is not enough: the rubric deploys via a plain `cp` with no compiled mirror
    // (install.sh:517-518), so nothing else pins deployed bytes to source bytes. Assert content
    // parity directly so a stale/hand-edited deployed copy fails loud instead of merely existing.
    const sourcePrinciples = path.join(REPO_ROOT, 'extension', 'szechuan-sauce-ui-principles.md');
    const sourceContent = fs.readFileSync(sourcePrinciples, 'utf-8');
    assert.equal(content, sourceContent, 'deployed szechuan-sauce-ui-principles.md must be byte-identical to the repo source');
});
