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
import { isUnevaluableScopeStatus } from '../bin/check-scope-diff.js';
import { UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r-ssoc-audit-')));
}

function writeScopeJson(sessionDir, allowedPaths) {
  fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({ allowed_paths: allowedPaths }));
}

function writeRawScopeJson(sessionDir, body) {
  fs.writeFileSync(path.join(sessionDir, 'scope.json'), body);
}

// Drive auditPostIterationScope with injected committed files + captured events.
// committedFiles === null simulates "no scope.json written" callers; otherwise the
// fake git-diff returns the given file list for the preIterSha..postIterSha range.
function runAudit({ allowedPaths, committedFiles, currentSubsystem, writeScope = true, preSha = 'a'.repeat(40), postSha = 'b'.repeat(40), spawnResult, spawnOptsSink, rawScope }) {
  const tmp = makeTmp();
  const captured = [];
  const logLines = [];
  const origSpawn = _deps.spawnSync;
  const origLog = _deps.logActivity;
  try {
    if (rawScope !== undefined) writeRawScopeJson(tmp, rawScope);
    else if (writeScope) writeScopeJson(tmp, allowedPaths);
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

test('AP-EXT-ITER38-03: a maxBuffer-exceeded enumeration that still EXITS 0 is reported unknown', () => {
  // The OTHER `maxBuffer` shape, and the one a status-only guard cannot see. When the
  // child exits before Node's kill lands, `spawnSync` returns `status: 0`, `signal:
  // null` and `error.code === 'ENOBUFS'` — measured on node v24.19.0, 25/25 runs, with
  // `git diff --name-only -z` against this repo. The visible head of the read is in
  // scope and the omitted tail is not, so pre-fix this parsed as a COMPLETE, CLEAN
  // enumeration: no event, no log, and the R-SSOC fence silently disarmed over an
  // off-scope commit it never saw.
  const enobufs = Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
  const events = runAudit({
    allowedPaths: ['packages/api/src/bank-statement'],
    currentSubsystem: 'packages',
    spawnResult: {
      status: 0,
      signal: null,
      stdout: 'packages/api/src/bank-statement/parser.ts\0',
      error: enobufs,
    },
  });
  assert.equal(events.length, 0, 'a ceiling-exceeded read is not a verdict in either direction');
  assert.equal(
    events.logLines.filter((l) => l.includes('NOT evaluated')).length,
    1,
    'an ENOBUFS read that exited 0 must surface as an un-evaluated fence, not a clean one',
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

// ---------------------------------------------------------------------------
// AP-EXT-ITER41-01: the sibling status AP-EXT-ITER38-03 left behind. `checkScopeDiff`
// has TWO cannot-render-a-verdict statuses and the CLI exits 2 on both, sharing one
// disposition ("exiting 0 on either would report a fence that never ran as a fence
// that passed"). This audit handled only `enumeration_failed`, so `malformed_scope`
// fell through the `!== 'outside_scope'` return: a scope.json that parses as an
// object but carries no string `allowed_paths` array disarmed the ONE scope check a
// codex worker cannot bypass, with the byte-identical observable to a clean pass.
// Drive the REAL audit through the REAL checkScopeDiff (no injected status) over a
// garbage fence and an off-scope commit.
// ---------------------------------------------------------------------------

const MALFORMED_FENCES = [
  ['allowed_paths missing entirely', JSON.stringify({ version: 1, mode: 'diff' })],
  ['allowed_paths a bare string', JSON.stringify({ allowed_paths: 'packages/api' })],
  ['allowed_paths an array of non-strings', JSON.stringify({ allowed_paths: [1, 2] })],
];

for (const [label, body] of MALFORMED_FENCES) {
  test(`AP-EXT-ITER41-01: a malformed fence (${label}) is reported unknown, not silently clean`, () => {
    const events = runAudit({
      rawScope: body,
      committedFiles: ['totally/outside/scope.ts'],
      currentSubsystem: 'extension',
    });
    assert.equal(events.length, 0, 'an unreadable fence cannot produce a drift verdict either way');
    const notEvaluated = events.logLines.filter((l) => l.includes('[R-SSOC]') && l.includes('NOT evaluated'));
    assert.equal(notEvaluated.length, 1, 'a garbage fence must be logged, not swallowed');
    assert.ok(
      /UNKNOWN, not absent/.test(notEvaluated[0]),
      `log must distinguish unknown from clean, got: ${notEvaluated[0]}`,
    );
    assert.ok(
      notEvaluated[0].includes('malformed_scope'),
      `log must name WHY the fence was unreadable, got: ${notEvaluated[0]}`,
    );
  });
}

test('AP-EXT-ITER41-01: a well-formed fence over an in-scope commit still logs nothing (no over-trigger)', () => {
  const events = runAudit({
    allowedPaths: ['packages/api/src/bank-statement'],
    committedFiles: ['packages/api/src/bank-statement/parser.ts'],
    currentSubsystem: 'extension',
  });
  assert.equal(events.length, 0, 'in-scope commit → no drift event');
  assert.equal(
    events.logLines.filter((l) => l.includes('NOT evaluated')).length,
    0,
    'a readable fence rendering a real verdict is NOT an unevaluable one',
  );
});

test('AP-EXT-ITER41-01: both unevaluable statuses share ONE disposition at the predicate', () => {
  assert.equal(isUnevaluableScopeStatus('malformed_scope'), true);
  assert.equal(isUnevaluableScopeStatus('enumeration_failed'), true);
  // `no_scope` is a genuine answer ("this session has no fence"), not an unreadable
  // one — folding it in would silence every legitimately unscoped anatomy run.
  for (const status of ['ok', 'outside_scope', 'no_scope']) {
    assert.equal(isUnevaluableScopeStatus(status), false, `${status} renders a verdict`);
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER68-01: the producers AP-EXT-ITER41-01 could not reach. That fix routed
// `malformed_scope` to the loud "UNKNOWN, not absent" log, but `resolveScopeAuditInputs`
// still pre-gated on `readRecoverableJsonObject(scope.json) === null` — a BOOLEAN stand-in
// for the classifier. `readRecoverableJsonObject` returns null for an absent file AND for
// a present file that is not a JSON object, so every non-object fence returned there and
// never reached `checkScopeDiff`. Note the MALFORMED_FENCES table above: all three members
// parse as objects. That is the whole enumerated-set failure — the table could only hold
// the shapes the pre-gate let through, so the pre-gate looked covered.
//
// Measured against the shipped `bin/microverse-runner.js` before the fix: a truncated
// fence plus an off-scope commit produced zero events and zero log lines — byte-identical
// to the absent-fence no-op below, on the one scope check a codex worker cannot bypass.
// The pre-gate is now deleted outright (not widened): `checkScopeDiff:resolveAllowedPaths`
// already owns the three-way answer and, since AP-EXT-ITER40-01, already crosses the
// tmp-rename window itself — so the promotion AP-EXT-ITER8-02 put here is redundant, which
// `microverse-convergence.test.js`'s tmp-only cases pin end-to-end.
// ---------------------------------------------------------------------------

const NON_OBJECT_FENCES = [
  ['truncated mid-write', '{'],
  ['empty file', ''],
  ['top-level array', JSON.stringify(['packages/api'])],
  ['top-level string', JSON.stringify('packages/api')],
  ['literal null', 'null'],
];

for (const [label, body] of NON_OBJECT_FENCES) {
  test(`AP-EXT-ITER68-01: a non-object fence (${label}) is reported unknown, not silently clean`, () => {
    const events = runAudit({
      rawScope: body,
      committedFiles: ['totally/outside/scope.ts'],
      currentSubsystem: 'extension',
    });
    assert.equal(events.length, 0, 'an unreadable fence cannot produce a drift verdict either way');
    const notEvaluated = events.logLines.filter((l) => l.includes('[R-SSOC]') && l.includes('NOT evaluated'));
    assert.equal(notEvaluated.length, 1, 'a present-but-unreadable fence must be logged, not swallowed');
    assert.ok(
      /UNKNOWN, not absent/.test(notEvaluated[0]),
      `log must distinguish unknown from clean, got: ${notEvaluated[0]}`,
    );
    assert.ok(
      notEvaluated[0].includes('malformed_scope'),
      `log must name WHY the fence was unreadable, got: ${notEvaluated[0]}`,
    );
  });
}

// PLACEMENT pin, not a presence pin. Deleting the pre-gate is only correct because
// `checkScopeDiff` answers `no_scope` for a genuinely absent fence; if the distinction
// were drawn anywhere coarser, every unscoped anatomy/microverse run would log this line
// once per committing iteration. The sibling above is green either way without this.
test('AP-EXT-ITER68-01: an ABSENT fence stays fully silent — no NOT-evaluated line', () => {
  const events = runAudit({
    allowedPaths: [],
    committedFiles: ['anything/at/all.ts'],
    writeScope: false,
  });
  assert.equal(events.length, 0, 'no scope.json → no drift event');
  assert.deepEqual(
    events.logLines.filter((l) => l.includes('[R-SSOC]')),
    [],
    'an unscoped session is a genuine answer, not an unreadable fence — it must log nothing',
  );
});
