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

// Regression pin for F1 (0618cccd): the mechanism claim "the installer never prunes removed files"
// is false — install.sh:379 runs `rsync -a --delete --delete-excluded`. This test demonstrates that
// end to end against a sandboxed --prefix (never the real ~/.claude). --delete-excluded means an
// EXCLUDED path (node_modules, src, tests, .pickle-rick, .codegraph — see install.sh:379-386) is
// itself wiped from the deployed tree on every deploy, not preserved — those are build/cache
// artifacts the deploy deliberately resets, so they are NOT the AC-F1-3 negative control. The real
// "leave alone" boundary is the rsync invocation's own SOURCE/DEST argument pair
// ("$SCRIPT_DIR/extension/" "$EXTENSION_ROOT/extension/", install.sh:386): anything outside
// $EXTENSION_ROOT/extension/ is structurally outside rsync's reach. pickle_settings.json
// (install.sh:505-510, jq-merged at $EXTENSION_ROOT/pickle_settings.json, one level above
// extension/) is exactly such an operator-owned file, so a custom key an operator added there is
// the negative control. If a future edit drops --delete from the install.sh:379 rsync invocation,
// the orphan-pruned assertion below goes RED (AC-F1-4).
test('install-tmux-runner-symlink-not-copy: a next deploy prunes a deployed-only orphan, but never an operator-owned file outside the rsync scope (AC-F1-1/AC-F1-3/AC-F1-4)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-prunecheck-'));
    const prefix = path.join(home, '.claude', 'pickle-rick');

    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');

    const env = {
        ...process.env,
        HOME: home,
        PICKLE_INSTALL_ROOT: prefix,
        PICKLE_DATA_ROOT: path.join(home, '.local', 'share', 'pickle-rick'),
    };

    try {
        const first = spawnSync('bash', [INSTALL_SH, '--prefix', prefix, '--no-confirm'], {
            encoding: 'utf8',
            timeout: 120_000,
            env,
        });
        assert.equal(first.status, 0, `first install.sh failed (exit ${first.status}):\n${first.stderr}`);

        const deployedBin = path.join(prefix, 'extension', 'bin');
        const muxRunnerPath = path.join(deployedBin, 'mux-runner.js');
        assert.ok(fs.existsSync(muxRunnerPath), `expected ${muxRunnerPath} to exist after first deploy`);

        // AC-F1-1 probe: a file with no source counterpart, INSIDE the rsync-managed extension/ tree.
        const orphanPath = path.join(deployedBin, '__ac_f1_orphan_probe.js');
        fs.writeFileSync(orphanPath, '// orphan probe — must be pruned by the next deploy\n');
        assert.ok(fs.existsSync(orphanPath), 'orphan probe must exist before the second deploy');

        // AC-F1-3 negative control: an operator-owned custom key in pickle_settings.json, which
        // lives at $EXTENSION_ROOT/pickle_settings.json — one level above extension/ and therefore
        // structurally outside the rsync SOURCE/DEST pair (install.sh:386) that AC-F1-1 exercises.
        const deployedSettingsPath = path.join(prefix, 'pickle_settings.json');
        assert.ok(fs.existsSync(deployedSettingsPath), `expected ${deployedSettingsPath} to exist after first deploy`);
        const settingsBefore = JSON.parse(fs.readFileSync(deployedSettingsPath, 'utf8'));
        settingsBefore.__ac_f1_operator_marker = 'keep-me';
        fs.writeFileSync(deployedSettingsPath, JSON.stringify(settingsBefore, null, 2));

        const second = spawnSync('bash', [INSTALL_SH, '--prefix', prefix, '--no-confirm'], {
            encoding: 'utf8',
            timeout: 120_000,
            env,
        });
        assert.equal(second.status, 0, `second install.sh failed (exit ${second.status}):\n${second.stderr}`);

        assert.ok(
            !fs.existsSync(orphanPath),
            `expected ${orphanPath} to be pruned by the second deploy's rsync --delete`,
        );

        const settingsAfter = JSON.parse(fs.readFileSync(deployedSettingsPath, 'utf8'));
        assert.equal(
            settingsAfter.__ac_f1_operator_marker,
            'keep-me',
            'operator-owned pickle_settings.json custom key must survive the second deploy — it lives outside the rsync extension/ scope',
        );

        assert.ok(fs.existsSync(muxRunnerPath), `expected ${muxRunnerPath} to exist after second deploy`);
        const tmuxRunnerPath = path.join(deployedBin, 'tmux-runner.js');
        assert.ok(
            fs.lstatSync(tmuxRunnerPath).isSymbolicLink(),
            `expected ${tmuxRunnerPath} to remain a symlink after second deploy`,
        );
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
