// @tier: fast
//
// AP-EXT-ITER300-01 -- the provisioning half of the widened ENFORCE census in
// scripts/audit-trap-door-enforcement.sh.
//
// Two catalog entries named an audit SCRIPT as their enforcement and nothing in the tree
// ran it: `audit-readiness-allowlist.sh` (extension/CLAUDE.md calls it "enforced at CI
// time"; it is the SOLE enforcer of the allowlist `source:` schema, and its companion test
// check-readiness-forward-ref-fixture.test.js says nothing about that schema) and
// `audit-ac-command-glob-safety.sh`. Both were unwired from their birth commits to this
// one, because the ENFORCE census admitted `tests/**.test.js` refs ONLY and could not see
// a script-shaped claim at all.
//
// This file is the caller the claims asserted, so each arm is paired: an ACCEPT over the
// real tree proves the audit passes at HEAD, and a REJECT over a fixture proves it can
// still fail. An audit that only ever passes is indistinguishable from one wired to
// nothing -- which is the defect this file exists to close, not to reproduce.
//
// The REJECT arms copy the shipped script into a fixture root rather than plumbing an
// override into it. Both scripts resolve their subject from `${BASH_SOURCE[0]}`, so a copy
// under `<fixture>/scripts/` reads `<fixture>/` as its extension root by construction --
// the real bytes, a fixture subject, and no second source file touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(EXTENSION_ROOT, 'scripts');

function runScript(relScript, args = [], cwd = EXTENSION_ROOT) {
  return spawnSync('bash', [relScript, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

/** Copies one shipped script into a throwaway extension root and returns both paths. */
function fixtureRootWithScript(scriptName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-claimed-audit-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const copied = path.join(root, 'scripts', scriptName);
  fs.copyFileSync(path.join(SCRIPTS, scriptName), copied);
  return { root, copied };
}

test('AP-EXT-ITER300-01 readiness-allowlist ACCEPT: the audit exits 0 over the tracked allowlist', () => {
  const result = runScript('scripts/audit-readiness-allowlist.sh');
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /entries verified/, `stdout: ${result.stdout}`);
});

test('AP-EXT-ITER300-01 readiness-allowlist REJECT: an entry with no source justification exits 1', () => {
  const { root, copied } = fixtureRootWithScript('audit-readiness-allowlist.sh');

  try {
    // Entry 0 is well-formed so the run cannot fail for a reason other than entry 1.
    fs.writeFileSync(
      path.join(root, '.readiness-allowlist.json'),
      JSON.stringify([
        { ref: 'Promise.all', kind: 'symbol', source: 'ECMAScript stdlib.' },
        { ref: 'Unjustified.ref', kind: 'symbol' },
      ])
    );

    const result = runScript(copied, [], root);
    assert.equal(result.status, 1, `stdout: ${result.stdout} stderr: ${result.stderr}`);
    assert.match(result.stderr, /missing or empty 'source' field/, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /Unjustified\.ref/, `stderr: ${result.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER300-01 glob-safety ACCEPT: the audit exits 0 over the tracked AC gate', () => {
  const result = runScript('scripts/audit-ac-command-glob-safety.sh');
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /shell: true check passed/, `stdout: ${result.stdout}`);
});

test('AP-EXT-ITER300-01 glob-safety REJECT: a reintroduced shell: true on the criterion path exits 1', () => {
  const { root, copied } = fixtureRootWithScript('audit-ac-command-glob-safety.sh');

  try {
    const gateDir = path.join(root, 'src', 'services');
    fs.mkdirSync(gateDir, { recursive: true });
    fs.writeFileSync(
      path.join(gateDir, 'ac-phase-gate.ts'),
      'const criterionOptions = { cwd: repoRoot, shell: true };\n'
    );

    const result = runScript(copied, [], root);
    assert.equal(result.status, 1, `stdout: ${result.stdout} stderr: ${result.stderr}`);
    assert.match(result.stderr, /shell: true detected/, `stderr: ${result.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER300-01 glob-safety --lint: an unquoted glob in a string command warns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-claimed-audit-lint-'));

  try {
    const manifest = path.join(dir, 'manifest.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        acceptance_criteria: [
          { id: 'AC-SAFE', command: ['node', '--test'] },
          { id: 'AC-HAZARD', command: 'ls extension/tests/*.test.js' },
        ],
      })
    );

    // --lint WARNs by contract (exit 0, stderr) -- the arm pins the warning, not a verdict.
    const result = runScript('scripts/audit-ac-command-glob-safety.sh', ['--lint', manifest]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /AC-HAZARD.*unquoted glob hazard/, `stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /AC-SAFE/, `array-form command must not warn: ${result.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
