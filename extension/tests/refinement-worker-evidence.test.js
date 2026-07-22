// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateAnalystSuccess } from '../bin/spawn-refinement-team.js';

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
