// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { runGate } from '../../services/convergence-gate.js';

function makePnpmFixture(dir, testScript) {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'safety-test',
      version: '1.0.0',
      scripts: { test: testScript },
    }, null, 2)
  );
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
}

function makeNpmFixture(dir, scripts) {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'safety-test',
      version: '1.0.0',
      scripts,
    }, null, 2)
  );
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'safety-test', lockfileVersion: 3 }, null, 2));
}

async function withGitFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-safety-'));
  try {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: dir, stdio: 'pipe' });
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Unsafe keyword fixtures — each should be blocked + gate_unsafe_test_command_blocked emitted
const UNSAFE_FIXTURES = [
  { label: 'integration',  script: 'npx integration-runner' },
  { label: 'e2e',          script: 'npx run-e2e' },
  { label: 'golden',       script: 'run-golden-suite' },
  { label: 'smoke',        script: 'smoke-test --all' },
  { label: 'baseline',     script: 'update-baseline --run' },
  { label: 'playwright',   script: 'playwright test' },
  { label: 'cypress',      script: 'cypress run' },
  { label: 'hardhat',      script: 'hardhat test' },
];

for (const { label, script } of UNSAFE_FIXTURES) {
  test(`runGate test-safety: "${label}" script is blocked, status green, event emitted`, async () => {
    await withGitFixture(async dir => {
      makePnpmFixture(dir, script);
      execSync('git add .', { cwd: dir, stdio: 'pipe' });
      execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

      const events = [];
      const result = await runGate({
        workingDir: dir,
        mode: 'strict',
        scope: 'full',
        checks: ['tests'],
        onEvent: (event, data) => events.push({ event, data }),
      });

      assert.equal(result.status, 'green', `Expected green (skipped), got ${result.status}`);
      assert.deepEqual(result.failures, []);
      const blocked = events.find(e => e.event === 'gate_unsafe_test_command_blocked');
      assert.ok(blocked, `Expected gate_unsafe_test_command_blocked event for "${label}" script`);
      assert.equal(blocked.data.script, script);
    });
  });
}

// Safe runner — vitest script should pass through; status green because vitest exits 0 in test env
test('runGate test-safety: recognized runner (vitest) is allowed through safety check', async () => {
  await withGitFixture(async dir => {
    // Use node --test as the actual executable so the gate can invoke it
    makePnpmFixture(dir, 'node --test');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      onEvent: (event, data) => events.push({ event, data }),
      _timeouts: { perCheck: { tests: 10_000 }, total: 30_000 },
    });

    const blocked = events.find(e => e.event === 'gate_unsafe_test_command_blocked');
    assert.ok(!blocked, 'Should NOT emit gate_unsafe_test_command_blocked for recognized runner');
    // status may be green or red depending on whether node --test finds tests — either is fine
    assert.ok(['green', 'red'].includes(result.status), `Unexpected status: ${result.status}`);
    // No event + green is also what a SILENT skip produces; only check_status proves it ran.
    assert.equal(result.check_status?.tests, 'ran', `allowed runner must actually run: ${JSON.stringify(result.check_status)}`);
  });
});

// Missing runner — "echo hi" has no recognized runner → skip green, no block event
test('runGate test-safety: missing recognized runner (echo hi) → skip green, no event', async () => {
  await withGitFixture(async dir => {
    makePnpmFixture(dir, 'echo hi');
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      onEvent: (event, data) => events.push({ event, data }),
    });

    assert.equal(result.status, 'green', `Expected green (skipped), got ${result.status}`);
    assert.deepEqual(result.failures, []);
    const blocked = events.find(e => e.event === 'gate_unsafe_test_command_blocked');
    assert.ok(!blocked, 'Should NOT emit gate_unsafe_test_command_blocked for missing runner');
  });
});

test('runGate test-safety: delegated integration-named scripts that bottom out at node runner are allowed', async () => {
  await withGitFixture(async dir => {
    makeNpmFixture(dir, {
      test: 'npm run test:fast && npm run test:integration',
      'test:fast': 'node --test',
      'test:integration': 'npm run test:integration:serial',
      'test:integration:serial': 'node --test',
    });
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      onEvent: (event, data) => events.push({ event, data }),
      _timeouts: { perCheck: { tests: 10_000 }, total: 30_000 },
    });

    const blocked = events.find(e => e.event === 'gate_unsafe_test_command_blocked');
    assert.ok(!blocked, `delegated safe test chain must not be blocked: ${JSON.stringify(events)}`);
    assert.equal(result.status, 'green');
    assert.equal(result.check_status?.tests, 'ran', `allowed chain must actually run: ${JSON.stringify(result.check_status)}`);
  });
});

test('runGate test-safety: env-prefixed delegated safe leaf is allowed through', async () => {
  await withGitFixture(async dir => {
    makeNpmFixture(dir, {
      test: 'CI=1 npm run test:integration',
      'test:integration': 'node --test',
    });
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      onEvent: (event, data) => events.push({ event, data }),
      _timeouts: { perCheck: { tests: 10_000 }, total: 30_000 },
    });

    const blocked = events.find(e => e.event === 'gate_unsafe_test_command_blocked');
    assert.ok(!blocked, `env-prefixed safe leaf must not be blocked: ${JSON.stringify(events)}`);
    assert.equal(result.status, 'green');
    assert.equal(result.check_status?.tests, 'ran', `allowed chain must actually run: ${JSON.stringify(result.check_status)}`);
  });
});

test('runGate test-safety: delegated unsafe leaf script is blocked', async () => {
  await withGitFixture(async dir => {
    makeNpmFixture(dir, {
      test: 'npm run ci',
      ci: 'npm run browser-suite',
      'browser-suite': 'playwright test',
    });
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      onEvent: (event, data) => events.push({ event, data }),
    });

    assert.equal(result.status, 'green', `Expected green (skipped), got ${result.status}`);
    const blocked = events.find(e => e.event === 'gate_unsafe_test_command_blocked');
    assert.ok(blocked, `delegated unsafe leaf must emit block event, got ${JSON.stringify(events)}`);
    assert.equal(blocked.data.script, 'npm run ci');
    assert.equal(blocked.data.leaf_script, 'playwright test');
  });
});

test('runGate test-safety: env-prefixed delegated unsafe leaf is blocked at the leaf command', async () => {
  await withGitFixture(async dir => {
    makeNpmFixture(dir, {
      test: 'CI=1 npm run test:integration',
      'test:integration': 'playwright test',
    });
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    const events = [];
    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      onEvent: (event, data) => events.push({ event, data }),
    });

    assert.equal(result.status, 'green', `Expected green (skipped), got ${result.status}`);
    const blocked = events.find(e => e.event === 'gate_unsafe_test_command_blocked');
    assert.ok(blocked, `env-prefixed unsafe leaf must emit block event, got ${JSON.stringify(events)}`);
    assert.equal(blocked.data.script, 'CI=1 npm run test:integration');
    assert.equal(blocked.data.leaf_script, 'playwright test');
  });
});
