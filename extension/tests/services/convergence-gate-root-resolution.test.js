// @tier: fast
//
// R-SZGB-A (WS-1) regression coverage.
//
// When detectProjectType(target) returns null, runGate must attempt a bounded
// depth-1 downward scan for the real project root before declaring "no
// project type." Exactly one unambiguous child candidate resolves; zero or
// 2+ candidates fall through to the existing skip (never guess). A target
// that already carries its own project marker must resolve to itself
// unchanged (no spurious descent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGate } from '../../services/convergence-gate.js';

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePkgJson(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }, null, 2));
}

test('AC-SZGB-01: exactly one child with package.json resolves the gate working dir to that child', async () => {
  const root = mkTmp('szgb-one-child-');
  try {
    const child = path.join(root, 'app');
    writePkgJson(child);
    const baselinePath = path.join(root, 'session', 'gate', 'baseline.json');

    const events = [];
    const origError = console.error;
    const errLines = [];
    console.error = (msg) => errLines.push(msg);
    let result;
    try {
      result = await runGate({
        workingDir: root,
        mode: 'baseline',
        scope: 'full',
        checks: ['typecheck', 'lint', 'tests'],
        baselinePath,
        onEvent: (event, data) => events.push({ event, data }),
      });
    } finally {
      console.error = origError;
    }

    assert.equal(result.status, 'green');
    assert.equal(fs.existsSync(baselinePath), true, 'baseline file MUST exist on disk');

    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.notEqual(baseline.project_type, null, 'project_type must be non-empty (not null) after resolution');
    assert.equal(baseline.project_type, 'npm');
    assert.equal(baseline.working_dir, child, 'baseline working_dir must be the resolved child, not the ambiguous root');

    // No 'no_project_type_detected' skip should fire — resolution succeeded before the skip branch.
    const skipped = events.find(e => e.event === 'gate_skipped' && e.data.reason === 'no_project_type_detected');
    assert.equal(skipped, undefined, 'gate must not skip once resolution finds an unambiguous child');

    // Log line only — no new activity event, per AC-SZGB-04.
    const logLine = errLines.find(l => l.includes('gate: resolved project root'));
    assert.ok(logLine, 'expected the resolution log line on stderr');
    assert.equal(logLine, `gate: resolved project root 1 level(s) below target -> ${child}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-SZGB-02a: zero package children keeps project_type null (skip preserved)', async () => {
  const root = mkTmp('szgb-zero-children-');
  try {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
    const baselinePath = path.join(root, 'session', 'gate', 'baseline.json');

    const result = await runGate({
      workingDir: root,
      mode: 'baseline',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
      baselinePath,
    });

    assert.equal(result.status, 'green');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.equal(baseline.project_type, null);
    assert.equal(baseline.working_dir, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-SZGB-02b: two package children keeps project_type null (ambiguous, no guess)', async () => {
  const root = mkTmp('szgb-two-children-');
  try {
    writePkgJson(path.join(root, 'app-a'));
    writePkgJson(path.join(root, 'app-b'));
    const baselinePath = path.join(root, 'session', 'gate', 'baseline.json');

    const result = await runGate({
      workingDir: root,
      mode: 'baseline',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
      baselinePath,
    });

    assert.equal(result.status, 'green');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.equal(baseline.project_type, null, 'ambiguous monorepo must not guess a child');
    assert.equal(baseline.working_dir, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-SZGB-03: target directory itself carrying package.json resolves to the target unchanged', async () => {
  const root = mkTmp('szgb-self-marker-');
  try {
    writePkgJson(root);
    // A child also carries a package.json — must NOT cause spurious descent
    // since the target itself already resolves via detectProjectType.
    writePkgJson(path.join(root, 'nested'));
    const baselinePath = path.join(root, 'session', 'gate', 'baseline.json');

    const result = await runGate({
      workingDir: root,
      mode: 'baseline',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
      baselinePath,
    });

    assert.equal(result.status, 'green');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.equal(baseline.project_type, 'npm');
    assert.equal(baseline.working_dir, root, 'must resolve to the target itself, not descend into nested/');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
