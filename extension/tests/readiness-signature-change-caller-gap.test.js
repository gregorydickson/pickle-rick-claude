// @tier: fast
// R-SIGF (LOA-1488): the readiness gate emits an ADVISORY
// `signature_change_caller_gap` finding when a ticket changes an exported/injected
// symbol's ARITY (adds a constructor param) and a positional caller in an
// out-of-scope `*.spec.ts` / factory file would be left stale. The finding is
// ADVISORY — readiness still PASSES (exit 0); it is excluded from the blocking set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');

function tmpDir(prefix = 'pickle-sigf-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, body) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), body);
}

function gitRepoWith(files) {
  const repoRoot = tmpDir('pickle-sigf-repo-');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.email', 'sigf@example.com'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.name', 'sigf'], { cwd: repoRoot });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  spawnSync('git', ['add', '-A'], { cwd: repoRoot });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });
  return repoRoot;
}

function runReadiness(sessionDir, repoRoot) {
  return spawnSync(process.execPath, [
    BIN,
    '--session-dir', sessionDir,
    '--repo-root', repoRoot,
    '--contract-only',
  ], { encoding: 'utf-8', timeout: 15000 });
}

test('R-SIGF: arity change with an out-of-scope positional caller emits the advisory finding AND readiness passes', () => {
  const sessionDir = tmpDir();
  // The out-of-scope spec instantiates the service POSITIONALLY with the old arity.
  // It is NOT in the ticket's declared files, so a fenced worker could not fix it.
  const repoRoot = gitRepoWith({
    'src/widget-service.ts': 'export class WidgetService { constructor(a, b) {} }\n',
    'src/widget-service.spec.ts': "import { WidgetService } from './widget-service';\nconst s = new WidgetService(1, 2);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf1', [
      '---',
      'id: sigf1',
      'key: SIGF-1',
      'ac_ids: []',
      '---',
      '',
      '# Add a 3rd constructor parameter to WidgetService',
      '',
      'This ticket adds a new constructor parameter (an injected dependency) to the',
      '`WidgetService` so it can resolve the clock.',
      '',
      '## Files to modify',
      '',
      '- `src/widget-service.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] `WidgetService` constructor accepts exactly `3` parameters.',
      '',
    ].join('\n'));
    const result = runReadiness(sessionDir, repoRoot);
    assert.equal(result.status, 0, `expected exit 0 (advisory never blocks), got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    const advisory = (out.findings ?? []).filter(
      (f) => f.kind === 'advisory' && /signature|arity/i.test(f.message) && /WidgetService/.test(f.detail),
    );
    assert.equal(advisory.length, 1, `expected one signature_change_caller_gap advisory finding; got ${JSON.stringify(out.findings)}`);
    assert.match(advisory[0].detail, /widget-service\.spec\.ts/, 'finding must name the out-of-scope caller');
    // It must not be a blocking finding.
    const blocking = (out.findings ?? []).filter((f) => f.kind !== 'advisory' && f.kind !== 'performance');
    assert.deepEqual(blocking, [], `no blocking findings expected; got ${JSON.stringify(blocking)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('R-SIGF: in-scope positional caller emits NOTHING (a fenced worker can fix it)', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/gadget-service.ts': 'export class GadgetService { constructor(a, b) {} }\n',
    'src/gadget-service.spec.ts': "import { GadgetService } from './gadget-service';\nconst s = new GadgetService(1, 2);\n",
  });
  try {
    // The spec IS declared in-scope, so no gap — nothing to flag.
    writeTicket(sessionDir, 'sigf2', [
      '---',
      'id: sigf2',
      'key: SIGF-2',
      'ac_ids: []',
      '---',
      '',
      '# Add a new constructor parameter to GadgetService',
      '',
      'Adds a new constructor injection to the `GadgetService`.',
      '',
      '## Files to modify',
      '',
      '- `src/gadget-service.ts`',
      '- `src/gadget-service.spec.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] `GadgetService` constructor accepts exactly `3` parameters.',
      '',
    ].join('\n'));
    const result = runReadiness(sessionDir, repoRoot);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    const advisory = (out.findings ?? []).filter((f) => f.kind === 'advisory' && /signature|arity/i.test(f.message));
    assert.deepEqual(advisory, [], `in-scope caller must emit no advisory; got ${JSON.stringify(advisory)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('R-SIGF: a ticket with no arity change emits nothing', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/sprocket-service.ts': 'export class SprocketService { constructor(a) {} }\n',
    'src/sprocket-service.spec.ts': "import { SprocketService } from './sprocket-service';\nconst s = new SprocketService(1);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf3', [
      '---',
      'id: sigf3',
      'key: SIGF-3',
      'ac_ids: []',
      '---',
      '',
      '# Tweak SprocketService behavior',
      '',
      'This ticket changes a method body; it does not change the constructor signature.',
      '',
      '## Files to modify',
      '',
      '- `src/sprocket-service.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] The service emits exactly `1` event per call.',
      '',
    ].join('\n'));
    const result = runReadiness(sessionDir, repoRoot);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    const advisory = (out.findings ?? []).filter((f) => f.kind === 'advisory' && /signature|arity/i.test(f.message));
    assert.deepEqual(advisory, [], `no arity change → no advisory; got ${JSON.stringify(advisory)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
