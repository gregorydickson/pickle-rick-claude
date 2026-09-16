// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');

const TEST_FILES = [
  'check-update.test.js',
  'verify-recapture-fired.test.js',
  'integration/readiness-bundle-prd.test.js',
  'integration/rate-limit-recovery.test.js',
  'phase-artifact-lifecycle.test.js',
  'update-state.test.js',
  'status.test.js',
  'tool-error-retry.test.js',
  'failure-classification.test.js',
  'ticket-tier.test.js',
  'task-notes-truncation.test.js',
  'microverse.test.js',
  'szechuan-sauce.test.js',
  'feature-flag-baseline.test.js',
  'hermes-spawn.test.js',
  'hermes-lifecycle.test.js',
  'hermes-metrics.test.js',
  'hermes-smoke.test.js',
  'spawn-morty.test.js',
  'jar-codex.test.js',
  'monitor.test.js',
  'log-watcher.test.js',
  'raw-morty.test.js',
  'mux-runner.test.js',
  'spawn-refinement-team.test.js',
  'integration/mega-bundle-rollup.test.js',
  'integration/mega-bundle-e2e.test.js',
  'release-gate.test.js',
];

const AC_TEST_COVERAGE = [
  ['AC-MEGA-A', ['integration/mega-bundle-rollup.test.js', 'integration/mega-bundle-e2e.test.js', 'check-update.test.js', 'verify-recapture-fired.test.js', 'integration/readiness-bundle-prd.test.js', 'integration/rate-limit-recovery.test.js']],
  ['AC-MEGA-B', ['integration/mega-bundle-rollup.test.js', 'integration/mega-bundle-e2e.test.js', 'phase-artifact-lifecycle.test.js', 'update-state.test.js', 'status.test.js']],
  ['AC-MEGA-C', ['integration/mega-bundle-rollup.test.js', 'integration/mega-bundle-e2e.test.js', 'tool-error-retry.test.js', 'failure-classification.test.js']],
  ['AC-MEGA-D', ['integration/mega-bundle-rollup.test.js', 'integration/mega-bundle-e2e.test.js', 'ticket-tier.test.js', 'task-notes-truncation.test.js', 'microverse.test.js', 'szechuan-sauce.test.js', 'feature-flag-baseline.test.js']],
  ['AC-MEGA-E', ['integration/mega-bundle-rollup.test.js', 'integration/mega-bundle-e2e.test.js', 'hermes-spawn.test.js', 'hermes-lifecycle.test.js', 'hermes-metrics.test.js', 'hermes-smoke.test.js', 'spawn-morty.test.js']],
  ['AC-MEGA-F', ['integration/mega-bundle-rollup.test.js', 'integration/mega-bundle-e2e.test.js', 'mux-runner.test.js', 'microverse.test.js']],
  ['AC-MEGA-INTEGRATE', ['integration/mega-bundle-e2e.test.js']],
  ['AC-MEGA-CLOSER', ['release-gate.test.js', 'integration/mega-bundle-e2e.test.js']],
];

const BACKEND_VERSION_INCLUDE_RE = /\b(?:assert\.ok|assert)\([^;\n]*\.includes\((['"`])(?:Backend(?:: [^'"`]+)?|codex|claude|hermes|openrouter\/[^'"`]+|claude-[^'"`]+|anthropic\/[^'"`]+|v?\d+\.\d+\.\d+)\1\)/;

const SKIP_ONLY_RE = /\.(skip|only)\(/;
const SANCTIONED_RE = /\/\/ SKIP:/;

function discoverDefaultTestFiles() {
  return ['fast', 'integration'].flatMap((tier) => {
    const result = spawnSync(process.execPath, ['bin/test-runner.js', '--tier', tier, '--dry-run'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').filter(Boolean);
  });
}

test('no unsanctioned .skip/.only in TEST_FILES', () => {
  const violations = [];
  for (const filename of TEST_FILES) {
    const filePath = path.join(__dirname, filename);
    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (SKIP_ONLY_RE.test(line) && !SANCTIONED_RE.test(line)) {
        violations.push(`${filename}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(violations, [], `Unsanctioned .skip/.only found:\n${violations.join('\n')}`);
});

test('mega-bundle ACs map to registered tests', () => {
  const registered = new Set(TEST_FILES);
  const failures = [];
  for (const [criterion, files] of AC_TEST_COVERAGE) {
    if (!files.length) {
      failures.push(`${criterion}: no mapped tests`);
    }
    for (const filename of files) {
      if (!registered.has(filename)) {
        failures.push(`${criterion}: ${filename} is not in TEST_FILES`);
      }
      try {
        readFileSync(path.join(__dirname, filename), 'utf8');
      } catch (error) {
        failures.push(`${criterion}: ${filename} missing (${error.code})`);
      }
    }
  }
  assert.deepEqual(failures, [], `AC coverage gaps:\n${failures.join('\n')}`);
});

test('backend/version identity assertions do not use broad .includes()', () => {
  const violations = [];
  for (const filename of TEST_FILES) {
    const filePath = path.join(__dirname, filename);
    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (BACKEND_VERSION_INCLUDE_RE.test(line)) {
        violations.push(`${filename}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(violations, [], `Weak backend/version assertions found:\n${violations.join('\n')}`);
});

// B-JUDGESCOPE AC-V-2: the three microverse corpora this bundle replays are vendored under
// tests/fixtures/microverse-corpora/ (see tests/helpers/microverse-corpora.js) precisely because
// ~/.local/share/pickle-rick/sessions/ is subject to pruneOldSessions and cannot be relied on to
// still hold a given session by the time this suite runs. A CODE line (not a comment, not fixture
// data) reading that live root has a deletion date.
//
// Scoped to the files this bundle actually controls, not a repo-wide grep: a blunt substring scan
// over all of extension/tests/ also matches benign pre-existing prose comments and fabricated
// example paths (e.g. '/home/user/.local/share/pickle-rick/sessions/...' test fixtures) in files
// unrelated to this bundle and out of its scope fence — none of which perform an actual read.
const REPLAY_FILES_UNDER_TEST = ['helpers/microverse-corpora.js', 'microverse-helpers.test.js'];
const LIVE_SESSIONS_ROOT_RE = /local\/share\/pickle-rick\/sessions/;

test('microverse corpora loader and its tests do not read the live sessions root (B-JUDGESCOPE AC-V-2)', () => {
  const violations = [];
  for (const relFile of REPLAY_FILES_UNDER_TEST) {
    const filePath = path.join(__dirname, relFile);
    const codeLines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    for (const line of codeLines) {
      if (LIVE_SESSIONS_ROOT_RE.test(line)) {
        violations.push(`${relFile}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(violations, [], `Live-session-root reads found:\n${violations.join('\n')}`);
});

test('each TEST_FILES file is wired into default test tiers', () => {
  const failures = [];
  const defaultTierFiles = new Set(discoverDefaultTestFiles());
  for (const filename of TEST_FILES) {
    const filePath = path.join(__dirname, filename);
    try {
      readFileSync(filePath, 'utf8');
    } catch (error) {
      failures.push(`${filename}: missing (${error.code})`);
      continue;
    }
    if (!filename.endsWith('.test.js')) {
      failures.push(`${filename}: not a node test file`);
    }
    if (!defaultTierFiles.has(`tests/${filename}`)) {
      failures.push(`${filename}: absent from default package test tiers`);
    }
  }
  assert.deepEqual(failures, [], `Unwired TEST_FILES entries:\n${failures.join('\n')}`);
});
