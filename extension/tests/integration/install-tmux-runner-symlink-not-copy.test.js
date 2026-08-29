// @tier: integration
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

// Regression pin for F1/B-MEGADRAIN: the PRD misdiagnosed the deployed bin/tmux-runner.js as "a
// complete stale copy of mux-runner.js" that "survived a pruning deploy" (rsync --delete at
// install.sh:379). It is neither stale nor a copy — install.sh:563 recreates it as a symlink to
// mux-runner.js on every deploy, after rsync runs, which is precisely why --delete never touches it
// (the path lives outside rsync's source/destination pair). This test pins that shape so a future
// edit that swaps the `ln -sf` for a real copy (e.g. `cp`) — which WOULD reintroduce a driftable
// duplicate — fails a test instead of silently landing.
test('install-tmux-runner-symlink-not-copy: deployed tmux-runner.js is a symlink to mux-runner.js, not a duplicated file', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-tmuxlink-'));
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

    const deployedBin = path.join(prefix, 'extension', 'bin');
    const tmuxRunnerPath = path.join(deployedBin, 'tmux-runner.js');
    const muxRunnerPath = path.join(deployedBin, 'mux-runner.js');

    assert.ok(fs.existsSync(muxRunnerPath), `expected ${muxRunnerPath} to exist`);

    const linkStat = fs.lstatSync(tmuxRunnerPath);
    assert.ok(
        linkStat.isSymbolicLink(),
        `expected ${tmuxRunnerPath} to be a symlink (install.sh:563), found a regular file — this ` +
        'would reintroduce a driftable stale copy',
    );

    const rawTarget = fs.readlinkSync(tmuxRunnerPath);
    const resolvedTarget = path.isAbsolute(rawTarget)
        ? rawTarget
        : path.resolve(deployedBin, rawTarget);
    assert.equal(
        fs.realpathSync(resolvedTarget),
        fs.realpathSync(muxRunnerPath),
        `symlink target ${resolvedTarget} does not resolve to ${muxRunnerPath}`,
    );

    const throughLink = fs.readFileSync(tmuxRunnerPath);
    const direct = fs.readFileSync(muxRunnerPath);
    assert.ok(
        throughLink.equals(direct),
        'content read through tmux-runner.js differs from mux-runner.js — no duplicate is expected to exist',
    );
});
