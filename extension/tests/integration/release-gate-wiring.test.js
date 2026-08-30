// @tier: expensive
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');
const CLAUDE_PATH = path.join(REPO_ROOT, 'CLAUDE.md');
const RELEASE_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

const GATE = [
  'npx tsc --noEmit',
  'npx eslint src/ --max-warnings=-1',
  'npx tsc',
  'bash scripts/audit-test-tiers.sh',
  'bash scripts/audit-test-isolation.sh',
  'bash scripts/audit-subprocess-heavy-tests.sh',
  'bash scripts/audit-fix-commits.sh',
  'bash scripts/audit-bundle-thesis.sh',
  'bash scripts/audit-quarantine.sh',
  'bash scripts/audit-trap-door-enforcement.sh',
  'bash scripts/audit-guarded-reset.sh',
  'bash scripts/audit-un-terminalize-single-path.sh',
  'bash scripts/audit-did-we-count.sh',
  'npm run test:fast:budget',
  'npm run test:integration',
  'npm run test:contract',
  'RUN_EXPENSIVE_TESTS=1 npm run test:expensive',
].join(' && ');

const FULL_CMD = `cd extension && npm ci && ${GATE}`;

function extractClaudeGate(text) {
  const line = text.split(/\r?\n/).find(l => l.startsWith('cd extension &&'));
  assert.ok(line, 'CLAUDE.md: no line starting with "cd extension &&" in Build & Test section');
  return line;
}

function extractWorkflowRun(text) {
  const line = text.split(/\r?\n/).find(l => /^\s*run:\s*cd extension &&/.test(l));
  assert.ok(line, 'workflow: no "run: cd extension &&" line found');
  return line.replace(/^\s*run:\s*/, '');
}

test('gate command parity across CLAUDE.md, release.yml, and ci.yml', () => {
  const claudeGate = extractClaudeGate(readFileSync(CLAUDE_PATH, 'utf8'));
  const releaseRun = extractWorkflowRun(readFileSync(RELEASE_WORKFLOW, 'utf8'));
  const ciRun = extractWorkflowRun(readFileSync(CI_WORKFLOW, 'utf8'));

  assert.equal(claudeGate, FULL_CMD, 'CLAUDE.md Build&Test gate does not match canonical');
  assert.equal(releaseRun, FULL_CMD, 'release.yml gate does not match canonical');
  assert.equal(ciRun, FULL_CMD, 'ci.yml gate does not match canonical');
});

test('check-wired.sh exits 0', () => {
  const result = spawnSync('bash', ['scripts/check-wired.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `check-wired.sh failed:\n${result.stderr}`);
});

// B-V2RG: the former "full gate exits 0 against HEAD" test re-executed the ENTIRE
// gate (npm ci + fast + integration + expensive) as a nested subprocess. That test:
//   - only ever proved the happy path (exit 0 on a green tree) — already proven by
//     the outer CI/release run, which executes this exact command;
//   - duplicated ~25-30min of work and could NEVER finish under the test-runner's
//     30-min --test-timeout (DEFAULT_TEST_RUNNER_TIMEOUT_MS) — it was cancelled
//     every run, deterministically red-gating the release;
//   - never tested failure PROPAGATION — the actually-dangerous mode (a gate that
//     silently green-lights broken code).
// Replaced with a static guarantee that the documented gate propagates failure (a
// single &&-chain, no failure-swallowing constructs). Parity (above) proves the
// command is byte-identical across CLAUDE.md/ci.yml/release.yml; check-wired proves
// the canonical encoding is intact; the outer CI/release run proves it passes green.
test('gate command propagates failure (pure && chain, no failure-swallowing constructs)', () => {
  assert.ok(!/;/.test(FULL_CMD),
    'gate must not use ; sequencing — a failed step would not stop the chain');
  assert.ok(!/\|\|/.test(FULL_CMD),
    'gate must not use || — it would mask a failed step');
  assert.ok(!/\|\s*tee\b/.test(FULL_CMD),
    'gate must not pipe to tee — it would mask the failing step exit code');
  const steps = FULL_CMD.split('&&').map((s) => s.trim()).filter(Boolean);
  assert.ok(steps.length >= 15,
    `gate should be a multi-step && chain (got ${steps.length} steps)`);
  for (const required of [
    'npx tsc --noEmit',
    'npm run test:integration',
    'RUN_EXPENSIVE_TESTS=1 npm run test:expensive',
  ]) {
    assert.ok(FULL_CMD.includes(required), `gate must include "${required}" so failure propagation covers it`);
  }
});
