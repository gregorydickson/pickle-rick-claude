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

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r-ssoc-audit-')));
}

function writeScopeJson(sessionDir, allowedPaths) {
  fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({ allowed_paths: allowedPaths }));
}

// Drive auditPostIterationScope with injected committed files + captured events.
// committedFiles === null simulates "no scope.json written" callers; otherwise the
// fake git-diff returns the given file list for the preIterSha..postIterSha range.
function runAudit({ allowedPaths, committedFiles, currentSubsystem, writeScope = true, preSha = 'a'.repeat(40), postSha = 'b'.repeat(40) }) {
  const tmp = makeTmp();
  const captured = [];
  const origSpawn = _deps.spawnSync;
  const origLog = _deps.logActivity;
  try {
    if (writeScope) writeScopeJson(tmp, allowedPaths);
    _deps.spawnSync = (bin, args) => {
      assert.equal(bin, 'git');
      assert.ok(args.includes('--name-only'), 'audit must run git diff --name-only');
      return { status: 0, stdout: (committedFiles ?? []).map((f) => f + '\0').join('') };
    };
    _deps.logActivity = (ev) => { captured.push(ev); };
    const ctx = {
      sessionDir: tmp,
      workingDir: tmp,
      preIterSha: preSha,
      postIterSha: postSha,
      log: () => {},
    };
    const state = currentSubsystem ? { current_subsystem: currentSubsystem } : {};
    auditPostIterationScope(ctx, state);
    return captured.filter((e) => e.event === 'worker_edit_outside_scope');
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
