// @tier: fast
// R-WDTF-TO WS-2: `setup --resume`'s orphan-reattach guard must not auto-promote a ticket to
// terminal Done on a RECOMPUTED worker-gate verdict (`resolveWorkerGateVerdict`'s
// `computed_via === 'between_ticket_gate'` — eslint+tsc only, test:fast excluded per R-WGFR).
// Only a persisted real-gate verdict (`computed_via === 'worker_gate'`) may authorize the flip.
// Mirrors the fixture shape of the sibling resume-reattach tests in setup.test.js — duplicated
// here because node:test files are isolated and these helpers are not exported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../bin/setup.js');

function isSessionMapCollision(message) {
    return /session-map collision blocked/.test(message || '');
}

function sleepSync(ms) {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
}

function withTmuxDefault(args) {
    const hasMode = args.some(a => a === '--tmux' || a === '--paused' || a === '--resume');
    return hasMode ? args : ['--tmux', ...args];
}

function execSetup(args, extraEnv) {
    const env = { ...process.env, FORCE_COLOR: '0', ...extraEnv };
    for (const key of Object.keys(env)) {
        if (env[key] === undefined) delete env[key];
    }

    const deadline = Date.now() + 30_000;
    for (;;) {
        try {
            return execFileSync(process.execPath, [SETUP, ...withTmuxDefault(args)], {
                encoding: 'utf-8',
                env,
            });
        } catch (err) {
            const stderr = err && typeof err.stderr === 'string' ? err.stderr : '';
            if (isSessionMapCollision(stderr) && Date.now() < deadline) {
                sleepSync(100);
                continue;
            }
            throw err;
        }
    }
}

function runSetupWithEnv(args, extraEnv) {
    return execSetup(args, extraEnv);
}

function initOrphanRepo(prefix) {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'orphan@example.com');
    git('config', 'user.name', 'Orphan Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    return { repo, git, base: git('rev-parse', 'HEAD') };
}

function seedResumableSession(dataRoot, repo, ticketId, completionCommit, extraFrontmatter = '') {
    const sessionPath = runSetupWithEnv(
        ['--tmux', '--task', 'resume reattach recomputed verdict'],
        { PICKLE_DATA_ROOT: dataRoot },
    ).match(/SESSION_ROOT=(.+)/)?.[1]?.trim();
    assert.ok(sessionPath, 'expected SESSION_ROOT from initial setup');

    const statePath = path.join(sessionPath, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.working_dir = repo; // pin every reattach git probe to the throwaway repo
    state.current_ticket = ticketId;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const ticketDir = path.join(sessionPath, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
        path.join(ticketDir, `rick_ticket_${ticketId}.md`),
        `---\nid: ${ticketId}\nstatus: Failed\ncomplexity_tier: small\norder: 1\ncompletion_commit: ${completionCommit}\n${extraFrontmatter}---\n# ${ticketId}\n`,
    );
    return { sessionPath, ticketDir };
}

function readTicketFrontmatter(ticketDir, ticketId) {
    return fs.readFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), 'utf-8');
}

function readTicketStatus(ticketDir, ticketId) {
    const body = readTicketFrontmatter(ticketDir, ticketId);
    // The frontmatter writer quotes the value it writes (`status: "Done"`) while the seed
    // fixture writes it bare. Unquote, or a `notEqual(status, 'Done')` assertion below can
    // never fail and the regression test greens over the very bug it exists to catch.
    return body.match(/^status:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '');
}

function readTicketCompletionCommit(ticketDir, ticketId) {
    const body = readTicketFrontmatter(ticketDir, ticketId);
    return body.match(/^completion_commit:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '');
}

function withResumeFixture(prefix, fn) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-data-`));
    const { repo, git, base } = initOrphanRepo(`${prefix}-repo-`);
    try {
        fn({ dataRoot, repo, git, base });
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
    }
}

// A fake `node_modules/.bin/<bin>` executable makes `npx <bin>` resolve locally with no
// network call and no real toolchain — `recomputeAbsentWorkerGateVerdict`'s eslint+tsc spawns
// then exit 0 deterministically, driving `resolveWorkerGateVerdict` into the RECOMPUTED
// (`computed_via: 'between_ticket_gate'`) green path without a real lint/tsc install.
function seedFakePassingRecomputeToolchain(repo) {
    const binDir = path.join(repo, 'extension', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const bin of ['eslint', 'tsc']) {
        const binPath = path.join(binDir, bin);
        fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n');
        fs.chmodSync(binPath, 0o755);
    }
}

test('setup --resume (AC-WDTFTO-2-1): a RECOMPUTED green worker-gate verdict must NOT flip the ticket Done', () => {
    withResumeFixture('pickle-resume-recomputed', ({ dataRoot, repo, git }) => {
        const ticketId = 'aa55recm';

        // extension/ exists (so resolveWorkerGateVerdict does not take the no-extension-dir
        // N/A shortcut) and its fake eslint/tsc both pass, driving the RECOMPUTE path green.
        // Committed (not left untracked) so the working tree stays clean across the reset +
        // ff-reattach below — an untracked fixture file would dirty the tree and make
        // detectAndRecoverHeadRegression hold instead of reattaching, unrelated to this guard.
        seedFakePassingRecomputeToolchain(repo);
        git('add', '-A');
        git('commit', '-q', '-m', 'toolchain');
        const toolchainBase = git('rev-parse', 'HEAD');

        fs.writeFileSync(path.join(repo, 'b.txt'), 'work only eslint+tsc ever recomputed over\n');
        git('add', '-A');
        git('commit', '-q', '-m', 'worker commit');
        const orphan = git('rev-parse', 'HEAD');
        git('reset', '--hard', '-q', toolchainBase); // strand the worker's commit off HEAD

        // No persisted worker_gate_verdict field — readWorkerGateVerdict returns 'absent',
        // forcing resolveWorkerGateVerdict to recompute via recomputeAbsentWorkerGateVerdict.
        const { sessionPath, ticketDir } = seedResumableSession(dataRoot, repo, ticketId, orphan);

        runSetupWithEnv(['--resume', sessionPath], {
            PICKLE_DATA_ROOT: dataRoot,
            PICKLE_ORPHAN_REAP: 'off',
        });

        assert.equal(
            git('rev-parse', 'HEAD'),
            orphan,
            'ff-reattach commit preservation is unconditional — the orphaned commit must still land on HEAD',
        );
        assert.equal(
            readTicketCompletionCommit(ticketDir, ticketId),
            orphan,
            'completion_commit must remain stamped even though the Done flip was refused',
        );
        assert.notEqual(
            readTicketStatus(ticketDir, ticketId),
            'Done',
            'a RECOMPUTED verdict (eslint+tsc only, test:fast excluded per R-WGFR) is not proof the tier\'s ' +
                'full worker gate ran, so it must not authorize a terminal Done flip that bypasses every later gate',
        );
    });
});

test('setup --resume (AC-WDTFTO-2-2): a PERSISTED real-gate green worker-gate verdict still flips Done', () => {
    withResumeFixture('pickle-resume-persisted', ({ dataRoot, repo, git, base }) => {
        const ticketId = 'aa66pers';
        fs.writeFileSync(path.join(repo, 'b.txt'), 'work the real worker gate actually passed\n');
        git('add', '-A');
        git('commit', '-q', '-m', 'worker commit');
        const orphan = git('rev-parse', 'HEAD');
        git('reset', '--hard', '-q', base); // strand the worker's commit off HEAD

        // A persisted worker_gate_verdict field is exactly the mechanism spawn-morty's
        // persistWorkerGateVerdict uses after a real full-tier gate run — readWorkerGateVerdict
        // returns it directly (computed_via: 'worker_gate'), so no recompute ever fires.
        const { sessionPath, ticketDir } = seedResumableSession(
            dataRoot, repo, ticketId, orphan, 'worker_gate_verdict: green\n',
        );

        runSetupWithEnv(['--resume', sessionPath], {
            PICKLE_DATA_ROOT: dataRoot,
            PICKLE_ORPHAN_REAP: 'off',
        });

        assert.equal(git('rev-parse', 'HEAD'), orphan, 'the real orphaned commit must still be ff-reattached');
        assert.equal(
            readTicketStatus(ticketDir, ticketId),
            'Done',
            'a persisted real-gate green verdict is unaffected by the recompute guard and must still flip Done',
        );
    });
});
