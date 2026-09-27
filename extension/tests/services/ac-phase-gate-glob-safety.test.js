// @tier: fast
// R-VSGE-3 — Regression coverage for glob-safe AC command execution and
// containsUnquotedGlobHazard predicate introduced by R-VSGE-1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAcPhaseGate, AC_PHASE_MANIFEST } from '../../services/ac-phase-gate.js';
import { containsUnquotedGlobHazard } from '../../services/verify-command-safety.js';

function withTempSession(fn) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-gate-glob-'));
  try {
    return fn(sessionDir);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

function writeManifest(sessionDir, criteria) {
  fs.writeFileSync(
    path.join(sessionDir, AC_PHASE_MANIFEST),
    JSON.stringify({ acceptance_criteria: criteria }),
  );
}

test('AC-gate glob safety: string criterion with unmatched glob exits per assertion not shell', () => {
  withTempSession((sessionDir) => {
    // Command contains $() and a glob that matches no files. With set -f, the
    // subshell does not expand the glob — echo outputs the literal pattern,
    // test -n on a non-empty string exits 0, and the criterion passes.
    writeManifest(sessionDir, [
      {
        id: 'test-glob-safety',
        evaluation_phase: 'bundle-end',
        command: 'test -n "$(echo extension/src/*.nonexistent-glob)"',
        expected_exit_code: 0,
      },
    ]);

    const result = runAcPhaseGate({
      sessionDir,
      evaluationPhase: 'bundle-end',
      cwd: sessionDir,
    });

    assert.equal(result.status, 'pass', `expected pass but got failures: ${JSON.stringify(result.failures)}`);
    const failure = (result.failures ?? []).find((f) => f.id === 'test-glob-safety');
    assert.equal(failure, undefined, `unexpected failure: ${JSON.stringify(failure)}`);
  });
});

// AP-TSVC-ITER1-02: the unmatched-glob case above cannot discriminate — POSIX sh
// leaves an unmatched glob literal WITH OR WITHOUT set -f. Only a glob that WOULD
// match a file in the cwd observes whether expansion was suppressed.
test('AC-gate glob safety: a glob matching a cwd file stays literal (set -f is live)', () => {
  withTempSession((sessionDir) => {
    fs.writeFileSync(path.join(sessionDir, 'probe.glob-probe'), '');
    writeManifest(sessionDir, [
      {
        id: 'test-glob-literal',
        evaluation_phase: 'bundle-end',
        command: 'test "$(echo *.glob-probe)" = "*.glob-probe"',
        expected_exit_code: 0,
      },
    ]);

    const result = runAcPhaseGate({ sessionDir, evaluationPhase: 'bundle-end', cwd: sessionDir });

    assert.equal(result.status, 'pass', `glob expanded against cwd: ${JSON.stringify(result.failures)}`);
  });
});

test('containsUnquotedGlobHazard: unquoted * is flagged', () => {
  assert.equal(containsUnquotedGlobHazard('cat extension/src/*.ts'), true);
});

test('containsUnquotedGlobHazard: single-quoted * is not flagged', () => {
  assert.equal(containsUnquotedGlobHazard("cat 'extension/src/*.ts'"), false);
});

test('containsUnquotedGlobHazard: command with no glob is not flagged', () => {
  assert.equal(containsUnquotedGlobHazard('grep -n foo file.ts'), false);
});
