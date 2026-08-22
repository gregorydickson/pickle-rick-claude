// @tier: fast
// R-SSOC (#129): runner-side post-iteration scope audit. After a worker
// iteration commits, microverse-runner must diff the iteration's committed files
// against scope.json:allowed_paths and emit `worker_edit_outside_scope`
// INDEPENDENTLY of whether the worker ran the prompt-level check-scope-diff
// preflight. The codex worker bypasses that prompt instruction, so the
// prompt-only preflight produced zero events while 7 off-scope commits landed
// silently (session 2026-06-19-2b1e2707). This audit reuses checkScopeDiff
// (incl. the #128 CLAUDE.md carve-out) and is observability-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditPostIterationScope, _deps } from '../bin/microverse-runner.js';
import { UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r-ssoc-audit-')));
}

function writeScopeJson(sessionDir, allowedPaths) {
  fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({ allowed_paths: allowedPaths }));
}

// Drive auditPostIterationScope with injected committed files + captured events.
// committedFiles === null simulates "no scope.json written" callers; otherwise the
// fake git-diff returns the given file list for the preIterSha..postIterSha range.
function runAudit({ allowedPaths, committedFiles, currentSubsystem, writeScope = true, preSha = 'a'.repeat(40), postSha = 'b'.repeat(40), spawnResult, spawnOptsSink }) {
  const tmp = makeTmp();
  const captured = [];
  const logLines = [];
  const origSpawn = _deps.spawnSync;
  const origLog = _deps.logActivity;
  try {
    if (writeScope) writeScopeJson(tmp, allowedPaths);
    _deps.spawnSync = (bin, args, opts) => {
      assert.equal(bin, 'git');
      assert.ok(args.includes('--name-only'), 'audit must run git diff --name-only');
      if (spawnOptsSink) spawnOptsSink.push(opts);
      if (spawnResult) return spawnResult;
      return { status: 0, stdout: (committedFiles ?? []).map((f) => f + '\0').join('') };
    };
    _deps.logActivity = (ev) => { captured.push(ev); };
    const ctx = {
      sessionDir: tmp,
      workingDir: tmp,
      preIterSha: preSha,
      postIterSha: postSha,
      log: (msg) => { logLines.push(msg); },
    };
    const state = currentSubsystem ? { current_subsystem: currentSubsystem } : {};
    auditPostIterationScope(ctx, state);
    const events = captured.filter((e) => e.event === 'worker_edit_outside_scope');
    events.logLines = logLines;
    return events;
  } finally {
    _deps.spawnSync = origSpawn;
    _deps.logActivity = origLog;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('R-SSOC: a committed file OUTSIDE allowed_paths emits worker_edit_outside_scope with the schema quartet', () => {
  const events = runAudit({
    allowedPaths: ['packages/api/src/bank-statement'],
    committedFiles: ['src/lib/appraisal-pipeline/xml/parser.ts'],
    currentSubsystem: 'packages',
  });
  assert.equal(events.length, 1, 'exactly one drift event');
  const ev = events[0];
  assert.equal(ev.source, 'pickle');
  assert.equal(ev.ticket_id, 'packages', 'current_subsystem rides into ticket_id');
  assert.ok(ev.gate_payload, 'gate_payload present');
  assert.ok(typeof ev.gate_payload.scope_json_path === 'string' && ev.gate_payload.scope_json_path.endsWith('scope.json'));
  assert.deepEqual(ev.gate_payload.staged_paths_outside_scope, ['src/lib/appraisal-pipeline/xml/parser.ts']);
  assert.equal(ev.gate_payload.head_ref, 'b'.repeat(40));
  assert.equal(typeof ev.gate_payload.suggested_remediation, 'string');
  assert.ok(ev.gate_payload.suggested_remediation.length > 0);
});

test('R-SSOC: a committed file INSIDE allowed_paths emits nothing', () => {
  const events = runAudit({
    allowedPaths: ['packages/api/src/bank-statement'],
    committedFiles: ['packages/api/src/bank-statement/parser.ts'],
    currentSubsystem: 'packages',
  });
  assert.equal(events.length, 0, 'in-scope commit must not emit drift');
});

test('R-SSOC: a committed subsystem CLAUDE.md is exempt (the #128 carve-out flows through checkScopeDiff)', () => {
  const events = runAudit({
    allowedPaths: ['packages/api/src/bank-statement'],
    committedFiles: ['packages/api/src/los/CLAUDE.md'],
    currentSubsystem: 'packages',
  });
  assert.equal(events.length, 0, 'trap-door catalog CLAUDE.md must not be flagged as drift');
});

test('R-SSOC: an out-of-scope .ts staged alongside an exempt CLAUDE.md is still flagged', () => {
  const events = runAudit({
    allowedPaths: ['packages/api/src/bank-statement'],
    committedFiles: ['packages/api/src/los/CLAUDE.md', 'packages/api/src/los/authentication.service.ts'],
    currentSubsystem: 'packages',
  });
  assert.equal(events.length, 1, 'the source file still trips the fence');
  assert.deepEqual(events[0].gate_payload.staged_paths_outside_scope, ['packages/api/src/los/authentication.service.ts']);
});

test('R-SSOC: absent scope.json is a no-op (anatomy/unscoped runs)', () => {
  const events = runAudit({
    allowedPaths: [],
    committedFiles: ['anything/at/all.ts'],
    writeScope: false,
  });
  assert.equal(events.length, 0, 'no scope.json → no audit');
});

test('R-SSOC: an iteration with no new commits (preIterSha === postIterSha) is a no-op', () => {
  const sha = 'c'.repeat(40);
  const events = runAudit({
    allowedPaths: ['packages/api/src/bank-statement'],
    committedFiles: ['src/off/scope.ts'],
    preSha: sha,
    postSha: sha,
  });
  assert.equal(events.length, 0, 'identical pre/post HEAD → nothing committed → no audit');
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER38-03: the OPEN GAP left by AP-EXT-ITER38-01 (which landed the same
// distinction in `check-scope-diff.ts:getStagedPaths`). `listCommittedFilesInRange`
// collapsed "git could not enumerate" into `[]`, which `resolveScopeAuditInputs`
// reads as "this iteration committed nothing" and returns null on — so the ONE
// scope check a codex worker cannot bypass silently no-ops, reporting the same
// nothing as a genuinely in-scope iteration. Drive the REAL audit through a
// failing / truncated git and assert the two observable differences: no fabricated
// clean verdict, and a log line saying drift is UNKNOWN rather than absent.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER38-03: a git enumeration that FAILED is reported unknown, not silently clean', () => {
  const events = runAudit({
    allowedPaths: ['packages/api/src/bank-statement'],
    currentSubsystem: 'packages',
    // git exits non-zero (bad range, repo gone): status 128, no stdout.
    spawnResult: { status: 128, stdout: '', stderr: 'fatal: bad revision' },
  });
  assert.equal(events.length, 0, 'a failed enumeration cannot produce a drift verdict either way');
  const notEvaluated = events.logLines.filter((l) => l.includes('[R-SSOC]') && l.includes('NOT evaluated'));
  assert.equal(notEvaluated.length, 1, 'the un-evaluated fence must be logged, not swallowed');
  assert.ok(
    /UNKNOWN, not absent/.test(notEvaluated[0]),
    `log must distinguish unknown from clean, got: ${notEvaluated[0]}`,
  );
});

test('AP-EXT-ITER38-03: a maxBuffer-truncated enumeration (status null + SIGTERM) is reported unknown', () => {
  // Node SIGTERMs the child past maxBuffer and hands back `status: null` with a
  // truncated first chunk. The pre-fix `(status ?? 1) !== 0 -> []` guard turned
  // that into "nothing committed"; it must now be "could not enumerate".
  const events = runAudit({
    allowedPaths: ['packages/api/src/bank-statement'],
    currentSubsystem: 'packages',
    spawnResult: { status: null, signal: 'SIGTERM', stdout: 'src/off/scope.ts\0', error: new Error('ENOBUFS') },
  });
  assert.equal(events.length, 0, 'a truncated read is not a verdict');
  assert.equal(
    events.logLines.filter((l) => l.includes('NOT evaluated')).length,
    1,
    'truncation must surface as an un-evaluated fence',
  );
});

test('AP-EXT-ITER38-03: the enumeration declares the ONE unbounded-read ceiling', () => {
  const opts = [];
  runAudit({
    allowedPaths: ['packages/api/src/bank-statement'],
    committedFiles: ['packages/api/src/bank-statement/parser.ts'],
    currentSubsystem: 'packages',
    spawnOptsSink: opts,
  });
  assert.equal(opts.length, 1, 'the audit runs exactly one git enumeration');
  assert.equal(
    opts[0].maxBuffer,
    UNBOUNDED_READ_MAX_BUFFER,
    'inheriting Node\'s 1 MB default silently truncates a large iteration diff',
  );
});

test('AP-EXT-ITER38-03: a COMPLETED-but-empty enumeration is still a plain no-op', () => {
  // The distinction must not over-trigger: `status: 0` with no paths is a real
  // "nothing was committed" answer and must stay silent on BOTH surfaces.
  const events = runAudit({
    allowedPaths: ['packages/api/src/bank-statement'],
    currentSubsystem: 'packages',
    spawnResult: { status: 0, stdout: '' },
  });
  assert.equal(events.length, 0, 'no commits → no drift event');
  assert.equal(
    events.logLines.filter((l) => l.includes('NOT evaluated')).length,
    0,
    'a completed empty enumeration is NOT an enumeration failure',
  );
});
