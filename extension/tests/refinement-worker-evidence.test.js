// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateAnalystSuccess, spawnAnalystProcess, terminateWorkerProcess } from '../bin/spawn-refinement-team.js';

function mkTmp(prefix = 'refinement-worker-evidence-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('evaluateAnalystSuccess: fresh artifact + no token => success true', () => {
    const dir = mkTmp();
    const outputFile = path.join(dir, 'analysis_researcher.md');
    const startTime = Date.now();
    fs.writeFileSync(outputFile, '# analysis\nno promise token here\n');

    const success = evaluateAnalystSuccess({ workerTimedOut: false, outputFile, startTime });

    assert.equal(success, true);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('evaluateAnalystSuccess: wrote nothing but STALE prior-cycle artifact present => success false', () => {
    const dir = mkTmp();
    const outputFile = path.join(dir, 'analysis_researcher.md');
    // Simulate a cycle-1 artifact that survived (archiveCycleResults copies, never unlinks
    // the canonical analysis_<role>.md), while the current cycle's worker died writing nothing.
    fs.writeFileSync(outputFile, '# stale analysis from a prior cycle\n');
    const staleTime = Date.now() - 10_000;
    fs.utimesSync(outputFile, staleTime / 1000, staleTime / 1000);
    const startTime = Date.now();

    const success = evaluateAnalystSuccess({ workerTimedOut: false, outputFile, startTime });

    assert.equal(success, false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('evaluateAnalystSuccess: no artifact at all => success false', () => {
    const dir = mkTmp();
    const outputFile = path.join(dir, 'analysis_researcher.md');
    const startTime = Date.now();

    const success = evaluateAnalystSuccess({ workerTimedOut: false, outputFile, startTime });

    assert.equal(success, false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('evaluateAnalystSuccess: timed out => success false, regardless of a fresh artifact', () => {
    const dir = mkTmp();
    const outputFile = path.join(dir, 'analysis_researcher.md');
    const startTime = Date.now();
    fs.writeFileSync(outputFile, '# fresh but the worker still timed out\n');

    const success = evaluateAnalystSuccess({ workerTimedOut: true, outputFile, startTime });

    assert.equal(success, false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('evaluateAnalystSuccess: all three analysts token-less with fresh artifacts => the :1305 cycle loop does NOT break early', () => {
    const dir = mkTmp();
    const startTime = Date.now();
    const roles = ['researcher', 'architect', 'skeptic'];
    const results = roles.map((roleId) => {
        const outputFile = path.join(dir, `analysis_${roleId}.md`);
        fs.writeFileSync(outputFile, `# ${roleId} analysis\nno promise token\n`);
        const success = evaluateAnalystSuccess({ workerTimedOut: false, outputFile, startTime });
        return { roleId, success, logPath: path.join(dir, `worker_${roleId}_c1.log`), cycle: 1, exitCode: 0 };
    });

    // Literal expression from orchestrateCycles' cycle loop (spawn-refinement-team.ts:1305).
    const wouldBreak = results.every((r) => !r.success);

    assert.equal(wouldBreak, false);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER43-01: a timed-out analyst must leave no surviving tree, and its
// 'close' must fire. Pre-fix (`spawn` without `detached`, bare `proc.kill`) the
// signal reached the `claude` CLI alone; its own tool subprocesses survived
// holding the inherited stdout/stderr write ends, so 'close' never fired and the
// still-ref'd pipe handles kept spawn-refinement-team.js alive forever — it is
// invoked from /pickle-refine-prd and /portal-gun with no outer timeout.
// Mutation-verified RED: drop `detached` from spawnAnalystProcess, or revert
// terminateWorkerProcess to `proc.kill(signal)`, and both tests hang to timeout
// rather than failing an assertion.
// ---------------------------------------------------------------------------

function waitFor(predicate, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            let done = false;
            try {
                done = predicate();
            } catch (err) {
                reject(err);
                return;
            }
            if (done) resolve();
            else if (Date.now() > deadline) reject(new Error('waitFor timed out'));
            else setTimeout(tick, 25);
        };
        tick();
    });
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

test("AP-EXT-ITER43-01: terminating a timed-out analyst fires 'close' even though it forked", async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX process groups only');
    const dir = mkTmp('refinement-worker-reap-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    // Stand-in for the real analyst: the `claude` CLI forks tool subprocesses that
    // outlive a signal aimed at the CLI itself. `exec` on the last child so the
    // shell is not an extra layer the bare-kill path would have reaped by accident.
    const readyFile = path.join(dir, 'grandchild.pid');
    const proc = spawnAnalystProcess(
        '/bin/sh',
        ['-c', `sh -c 'echo $$ > "${readyFile}"; exec sleep 45' & exec sleep 40`],
        { cwd: dir, env: process.env },
    );
    // spawnWorker pipes both streams; the ref'd read handles are what hang the process.
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});

    let closed = false;
    proc.on('close', () => { closed = true; });

    // Signal only AFTER the fork has provably happened. Terminating before the shell
    // forks leaves nothing holding the pipes, and the assertion greens on a race
    // rather than on the group kill.
    await waitFor(() => fs.existsSync(readyFile) && fs.readFileSync(readyFile, 'utf8').trim() !== '');

    // The escalation spawnWorker's timeout handler runs, via the one terminator.
    terminateWorkerProcess(proc, 'SIGTERM');
    terminateWorkerProcess(proc, 'SIGKILL');

    await waitFor(() => closed);
    assert.equal(closed, true, "'close' must fire once the whole analyst group is reaped");
});

test('AP-EXT-ITER43-01: terminating a timed-out analyst reaps the forked grandchild too', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX process groups only');
    const dir = mkTmp('refinement-worker-reap-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const pidFile = path.join(dir, 'grandchild.pid');
    const proc = spawnAnalystProcess(
        '/bin/sh',
        ['-c', `sh -c 'echo $$ > "${pidFile}"; exec sleep 45' & exec sleep 40`],
        { cwd: dir, env: process.env },
    );
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});

    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'grandchild pid captured');
    assert.equal(pidAlive(grandchildPid), true, 'grandchild is alive before termination');

    terminateWorkerProcess(proc, 'SIGKILL');

    await waitFor(() => !pidAlive(grandchildPid));
    assert.equal(pidAlive(grandchildPid), false, 'a bare child-only kill leaks the analyst tree');
});
