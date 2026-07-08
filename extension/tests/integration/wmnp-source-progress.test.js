// @tier: integration
//
// AC-R-WMNP-1: the per-spawn no-progress signal must count working-tree SOURCE
// deltas (git status/diff signature change vs the prior spawn), OR'd with the
// existing artifact-count signal. A worker that lands real source work each spawn
// but writes zero new lifecycle artifacts MUST NOT accrue zero_progress_count and
// MUST NOT be auto-skipped. The inverse (no source change + no artifact change)
// MUST still accrue zero-progress and fire at K. Throwaway temp fixtures only —
// never the live orchestration state.json.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function makeV5RawState(dir) {
  return {
    active: true,
    working_dir: dir,
    step: 'implement',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 0,
    worker_timeout_seconds: 3600,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'AC-R-WMNP-1 source-progress test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    schema_version: 5,
    worker_artifact_progress: {},
    activity: [],
  };
}

function setupSession(prefix) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(makeV5RawState(sessionDir), null, 2));
  return { sessionDir, statePath };
}

function readProgress(statePath, ticketId) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return s.worker_artifact_progress?.[ticketId] ?? null;
}

function countEmissions(statePath) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return (s.activity ?? []).filter((e) => e.event === 'worker_artifact_progress_zero');
}

// A scripted worker that produces a NEW source signature on every spawn (it landed
// real working-tree work each time) while writing ZERO new artifact files.
function makeChangingSig() {
  let n = 0;
  return () => `source-state-${n++}`;
}

test('AC-R-WMNP-1: changing source signature each spawn never accrues zero-progress (no auto-skip)', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('wmnp-source-progress-');
  const ticketId = 'src01';
  const changingSig = makeChangingSig();
  try {
    // 5 consecutive spawns: zero artifact growth (beforeCount = afterCount = 0)
    // but the source signature changes every spawn. K=3 / skip-K=5 must never trip.
    let r;
    for (let i = 0; i < 5; i++) {
      r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, {
        k: 3,
        workingDir: sessionDir,
        sourceSignatureFn: changingSig,
      });
    }
    // Spawn 1 establishes the baseline (no prior signature → counts as one
    // zero-progress); every subsequent spawn changes the signature → resets to 0.
    assert.equal(r.zeroProgressCount, 0, 'ongoing source work keeps zero_progress_count at 0');
    assert.equal(countEmissions(statePath).length, 0, 'no worker_artifact_progress_zero emission while source advances');
    const persisted = readProgress(statePath, ticketId);
    assert.equal(persisted.spawn_count, 5, 'all 5 spawns counted');
    assert.equal(persisted.last_source_signature, 'source-state-4', 'freshest signature persisted');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-R-WMNP-1 inverse: identical source signature + no artifacts accrues zero-progress and fires at K', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('wmnp-stuck-');
  const ticketId = 'stuck01';
  try {
    // M2: spawn 1 SEEDS the baseline signature (no prior to compare against) and
    // is NOT scored zero-progress; the frozen tree only accrues zero-progress from
    // spawn 2 onward. With K=3 the threshold therefore fires on the 4th spawn
    // (1 seed + 3 frozen). This is the intended M2 trade-off — a first spawn that
    // establishes a signature must not be punished as no-progress.
    let r;
    for (let i = 0; i < 4; i++) {
      r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, {
        k: 3,
        workingDir: sessionDir,
        sourceSignatureFn: () => 'frozen-tree', // never changes → genuinely stuck
      });
    }
    assert.equal(r.zeroProgressCount, 3, 'frozen source + no artifacts accrues zero-progress after the seed spawn');
    assert.ok(r.fired, 'fires at exactly K=3 (on the 4th spawn: 1 seed + 3 frozen)');
    assert.equal(countEmissions(statePath).length, 1, 'exactly one emission at the threshold');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-R-WMNP-1: null signature (git unavailable) falls back to artifact-count signal, never a false reset', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('wmnp-nullsig-');
  const ticketId = 'nullsig01';
  try {
    let r;
    for (let i = 0; i < 3; i++) {
      r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, {
        k: 3,
        workingDir: sessionDir,
        sourceSignatureFn: () => null, // probe failed every spawn
      });
    }
    // With no usable signature, behavior must match the legacy artifact-only path:
    // zero artifact growth accrues zero-progress and still fires at K.
    assert.equal(r.zeroProgressCount, 3, 'null signature does not mask a genuinely stuck worker');
    assert.ok(r.fired, 'still fires at K under null-signature fallback');
    const persisted = readProgress(statePath, ticketId);
    // M3: a first-spawn git failure persists an explicit `null` sentinel (not
    // `undefined`) so a later successful probe is detected as gap-recovery.
    assert.equal(persisted.last_source_signature, null, 'explicit null sentinel persisted when every probe returned null');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-R-WMNP-1: computeSourceTreeSignature detects a real working-tree delta', async () => {
  const { computeSourceTreeSignature } = await import('../../bin/mux-runner.js');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wmnp-realgit-'));
  // PICKLE_DATA_ROOT sandbox: this test only spawns `git` in the throwaway repo,
  // but keep any session writes off the live data dir for isolation hygiene.
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = repo;
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', timeout: 10_000 });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');

    const sigClean = computeSourceTreeSignature(repo);
    assert.equal(typeof sigClean, 'string', 'returns a string signature for a real repo');

    // Land new source work — an untracked file the status probe must observe.
    fs.writeFileSync(path.join(repo, 'analyzer.ts'), 'export const x = 1;\n');
    const sigAfterNew = computeSourceTreeSignature(repo);
    assert.notEqual(sigAfterNew, sigClean, 'new source file changes the signature');

    // Grow a tracked file — the numstat probe must observe the churn.
    fs.appendFileSync(path.join(repo, 'seed.txt'), 'more\n');
    const sigAfterGrow = computeSourceTreeSignature(repo);
    assert.notEqual(sigAfterGrow, sigAfterNew, 'growing a tracked file changes the signature');

    assert.equal(computeSourceTreeSignature(path.join(repo, 'nope')), null, 'non-repo dir → null (artifact-count fallback)');
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// M2: a worker that lands ONLY source work (no artifacts) on spawn 1 must seed the
// baseline (NOT be scored zero-progress), and a forward source change on spawn 2
// must be detected as progress. The pre-fix `prev.last_source_signature !== undefined`
// guard counted spawn 1 as zero-progress because no prior signature existed.
test('M2: spawn-1 source-only change seeds baseline (zpc 0), spawn-2 forward change = progress', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('wmnp-m2-firstspawn-');
  const ticketId = 'm2t01';
  let sig = 'sig-spawn-1';
  const sigFn = () => sig;
  try {
    // Spawn 1: source-only change, no artifacts. First capture seeds the baseline.
    let r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, {
      k: 3, workingDir: sessionDir, sourceSignatureFn: sigFn,
    });
    assert.equal(r.zeroProgressCount, 0, 'spawn-1 source-only change is NOT scored zero-progress (M2)');
    // Spawn 2: the source signature advances → forward progress detected.
    sig = 'sig-spawn-2';
    r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, {
      k: 3, workingDir: sessionDir, sourceSignatureFn: sigFn,
    });
    assert.equal(r.zeroProgressCount, 0, 'spawn-2 forward source change detected as progress');
    assert.equal(countEmissions(statePath).length, 0, 'no zero-progress emission across two productive spawns');
    assert.equal(readProgress(statePath, ticketId).last_source_signature, 'sig-spawn-2', 'freshest signature persisted');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// M3: spawn 1 has git unavailable (signature null) → an explicit null sentinel is
// persisted; spawn 2 has a working git + a real source change → progress MUST be
// detected, not stay invisible behind the pre-fix `!== undefined` guard (which only
// recovered at spawn 3). Folds into the M2 predicate.
test('M3: spawn-1 null sentinel → spawn-2 valid signature change detected as gap-recovery progress', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('wmnp-m3-gaprecovery-');
  const ticketId = 'm3t01';
  try {
    // Spawn 1: git unavailable.
    let r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, {
      k: 3, workingDir: sessionDir, sourceSignatureFn: () => null,
    });
    assert.equal(r.zeroProgressCount, 1, 'spawn-1 with null signature accrues one zero-progress (no usable signal)');
    assert.equal(readProgress(statePath, ticketId).last_source_signature, null, 'explicit null sentinel persisted on spawn-1 git failure');
    // Spawn 2: git is back and reports a real source signature.
    r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, {
      k: 3, workingDir: sessionDir, sourceSignatureFn: () => 'real-sig-after-recovery',
    });
    assert.equal(r.zeroProgressCount, 0, 'spawn-2 valid signature after a null sentinel counts as progress (NOT invisible until spawn 3)');
    assert.equal(readProgress(statePath, ticketId).last_source_signature, 'real-sig-after-recovery', 'recovered signature persisted');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// L1: computeSourceTreeSignature must return null when EITHER git probe fails,
// never a partial half-signature. A non-repo dir makes BOTH probes fail; an
// EISDIR / bogus path makes them exit non-zero. We assert the OR semantics by
// pointing at a path where `git status`/`git diff` cannot both succeed.
test('L1: computeSourceTreeSignature returns null (not a half-signature) when a probe fails', async () => {
  const { computeSourceTreeSignature } = await import('../../bin/mux-runner.js');
  // A path that is not a git repo: both probes exit non-zero → null.
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wmnp-l1-nonrepo-'));
  try {
    assert.equal(computeSourceTreeSignature(nonRepo), null, 'non-repo dir → null (both probes fail under the OR guard)');
    // A path that does not exist at all → git -C fails → null, never a partial string.
    assert.equal(computeSourceTreeSignature(path.join(nonRepo, 'does-not-exist')), null, 'missing dir → null');
  } finally {
    fs.rmSync(nonRepo, { recursive: true, force: true });
  }
});

// M4: a missing/corrupt/unreadable ticket file MUST NOT be silently swallowed.
// isOversizedNoProgressFailed (reached via resolvePreTicket) returns false
// (conservative — selection behavior unchanged) but logs a [warn] to stderr.
test('M4: unreadable/corrupt ticket file → resolvePreTicket keeps the ticket AND logs a warning', async () => {
  const { resolvePreTicket } = await import('../../bin/mux-runner.js');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmnp-m4-corrupt-'));
  const ticketId = 'corruptt01';
  // Make the ticket PATH a directory where the .md file is itself a directory →
  // readFileSync throws EISDIR (an unreadable, non-ENOENT corruption case).
  fs.mkdirSync(path.join(sessionDir, ticketId), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`));
  const writes = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { writes.push(String(chunk)); return origWrite(chunk, ...rest); };
  try {
    // current_ticket is the corrupt ticket: oversized-no-progress check fails to
    // read it → returns false → resolvePreTicket returns the ticket unchanged.
    const resolved = resolvePreTicket(sessionDir, ticketId);
    assert.equal(resolved, ticketId, 'unreadable ticket is NOT treated as a terminal no-progress flip (selection unchanged)');
    const warned = writes.some((w) => w.includes('isOversizedNoProgressFailed') && w.includes('[warn]') && w.includes(ticketId));
    assert.ok(warned, 'a [warn] is logged naming the unreadable ticket (M4 observability)');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
