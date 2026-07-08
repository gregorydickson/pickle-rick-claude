// @tier: integration
// SERIAL: spawns the real bin/setup.js as a subprocess; listed in
// tests/integration/.serial-tests.json so it never runs in the parallel pass
// concurrently with a sibling test that transiently rewrites the compiled tree
// (the MODULE_NOT_FOUND-on-setup.js contamination class).
//
// R-PNTR-4 (AC-PNTR-04): the bare /pickle in-session build loop and the in-session
// /pickle --teams path are removed; /pickle-tmux --teams launches Teams Mode under
// tmux. This test verifies the LAUNCH WIRING (live nested-Agent execution is not
// unit-testable): tmux_mode + teams_mode are set jointly, a 3-ticket fixture session
// is created inactive (mux-runner owns activation), bare non-tmux invocations are
// rejected with migration hints, and the manager-lifecycle template that the tmux
// pane runs carries Teams Mode + the morty-phase-* subagents.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../../bin/setup.js');
const MANAGER_TEMPLATE = path.resolve(__dirname, '../../templates/_pickle-manager-prompt.md');

const sandboxDirs = [];
after(() => {
    for (const dir of sandboxDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

function makeSandboxDataRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pntr-teams-tmux-'));
    sandboxDirs.push(dir);
    return dir;
}

function sleepSync(ms) {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
}

// setup.js keys its session-map by process.cwd(); concurrent setup-family tests can
// transiently claim the same cwd. Retry on the collision-block error, bounded.
function runSetupOk(args) {
    const dataRoot = makeSandboxDataRoot();
    const deadline = Date.now() + 30_000;
    for (;;) {
        try {
            const output = execFileSync(process.execPath, [SETUP, ...args], {
                encoding: 'utf-8',
                env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
            });
            const match = output.match(/SESSION_ROOT=(.+)/);
            if (!match) throw new Error(`SESSION_ROOT not found in output:\n${output}`);
            return match[1].trim();
        } catch (err) {
            const stderr = err && typeof err.stderr === 'string' ? err.stderr : '';
            if (/session-map collision blocked/.test(stderr) && Date.now() < deadline) {
                sleepSync(100);
                continue;
            }
            throw err;
        }
    }
}

function runSetupExpectFail(args) {
    const dataRoot = makeSandboxDataRoot();
    const result = spawnSync(process.execPath, [SETUP, ...args], {
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// A 3-ticket fixture: scaffold three ticket dirs under the created session so the
// launch represents a real multi-ticket Teams epic.
function scaffoldThreeTickets(sessionRoot) {
    const ids = ['t1aaaaaa', 't2bbbbbb', 't3cccccc'];
    ids.forEach((id, i) => {
        const dir = path.join(sessionRoot, id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, `rick_ticket_${id}.md`),
            `---\nid: ${id}\ntitle: "Teams fixture ticket ${i + 1}"\nstatus: Todo\norder: ${(i + 1) * 10}\n---\n# Fixture ${i + 1}\n`,
        );
    });
    return ids;
}

test('AC-PNTR-04: /pickle-tmux --teams sets tmux_mode + teams_mode jointly on a 3-ticket session', () => {
    const sessionRoot = runSetupOk(['--tmux', '--teams', '--max-parallel', '5', '--task', 'teams epic: 3 tickets']);
    const ids = scaffoldThreeTickets(sessionRoot);
    const state = JSON.parse(fs.readFileSync(path.join(sessionRoot, 'state.json'), 'utf-8'));

    assert.equal(state.tmux_mode, true, 'tmux_mode must be true (runs under tmux)');
    assert.equal(state.teams_mode, true, 'teams_mode must be true (Teams Mode enabled)');
    assert.equal(state.max_parallel, 5, 'max_parallel persisted');
    assert.equal(state.active, false, 'tmux sessions start inactive — mux-runner takes ownership');

    for (const id of ids) {
        assert.ok(
            fs.existsSync(path.join(sessionRoot, id, `rick_ticket_${id}.md`)),
            `3-ticket fixture present: ${id}`,
        );
    }
});

test('AC-PNTR-04: bare /pickle --teams (no --tmux) is rejected — no in-session Teams path remains', () => {
    const r = runSetupExpectFail(['--teams', '--task', 'in-session teams attempt']);
    assert.notEqual(r.code, 0, 'bare --teams must exit non-zero');
    assert.match(r.stderr, /pickle-tmux --teams/, 'migration hint must point to /pickle-tmux --teams');
});

test('AC-PNTR-04: bare /pickle (non-tmux build loop) is rejected with a tmux migration hint', () => {
    const r = runSetupExpectFail(['--task', 'in-session build loop attempt']);
    assert.notEqual(r.code, 0, 'bare non-tmux build session must exit non-zero');
    assert.match(r.stderr, /pickle-tmux/, 'migration hint must point to /pickle-tmux');
});

test('AC-PNTR-04: the tmux manager template carries Teams Mode + all morty-phase-* subagents', () => {
    const template = fs.readFileSync(MANAGER_TEMPLATE, 'utf-8');
    assert.match(template, /Teams Mode/, 'manager template must contain the Teams Mode block');
    for (const sub of [
        'morty-phase-researcher',
        'morty-phase-planner',
        'morty-phase-implementer',
        'morty-phase-verifier',
        'morty-phase-reviewer',
        'morty-phase-simplifier',
    ]) {
        assert.ok(template.includes(sub), `manager template references ${sub}`);
    }
});
