// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveScope } from '../../services/scope-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '../..');
const SETUP_BIN = path.join(EXTENSION_ROOT, 'bin', 'setup.js');
const REFINEMENT_BIN = path.join(EXTENSION_ROOT, 'bin', 'spawn-refinement-team.js');
const READINESS_BIN = path.join(EXTENSION_ROOT, 'bin', 'check-readiness.js');
const AUDIT_BIN = path.join(EXTENSION_ROOT, 'bin', 'audit-ticket-bundle.js');
const FIXTURE_DIR = path.join(EXTENSION_ROOT, 'tests', 'fixtures', 'gate-ergonomics-keystone');

const TICKETS = [
  {
    id: 'aa11bb22',
    title: 'Wire alpha gate fixture',
    source_ac_ids: ['AC-KE-ALPHA-01'],
    acceptance_test: 'node --eval "process.exit(0)"',
    files: [
      '- `extension/pickle_settings.json`',
      '- `extension/src/services/keystone-alpha.ts` (forward-created)',
    ],
  },
  {
    id: 'cc33dd44',
    title: 'Wire beta gate fixture',
    source_ac_ids: ['AC-KE-BETA-01'],
    acceptance_test: 'node --eval "process.exit(0)"',
    files: [
      '- `extension/src/services/keystone-beta.ts`',
      '- `extension/src/services/keystone-gamma.ts` (created by ticket ee55ff66)',
    ],
  },
  {
    id: 'ee55ff66',
    title: 'Wire gamma gate fixture',
    source_ac_ids: ['AC-KE-GAMMA-01'],
    acceptance_test: 'node --eval "process.exit(0)"',
    files: [
      '- `extension/src/services/keystone-gamma.ts`',
    ],
  },
];

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Pickle Test',
      GIT_AUTHOR_EMAIL: 'pickle@example.test',
      GIT_COMMITTER_NAME: 'Pickle Test',
      GIT_COMMITTER_EMAIL: 'pickle@example.test',
    },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return (result.stdout || '').trim();
}

function copyDir(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDir(srcPath, destPath);
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
  }
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

function createTrackedFixtureRepo(commitCount = 110) {
  const root = tmpDir('gate-keystone-fixture-');
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');

  fs.mkdirSync(seed, { recursive: true });
  git(['init', '-q', '--bare', '--initial-branch=main', origin], root);
  git(['init', '-q', '-b', 'main'], seed);
  git(['config', 'commit.gpgsign', 'false'], seed);
  copyDir(FIXTURE_DIR, seed);
  writeFile(seed, 'extension/package.json', JSON.stringify({ name: 'fixture-extension', version: '1.74.0' }, null, 2) + '\n');
  writeFile(seed, 'extension/pickle_settings.json', JSON.stringify({ mode: 'fixture' }, null, 2) + '\n');
  // beta.33 deleted the forward-ref annotation grammar (R-RTRC/R-FRA), so readiness no longer
  // suppresses a `(forward-created)` path — it must actually exist in the tracked tree to verify.
  // keystone-alpha is declared `(forward-created)` in the fixture PRD; create it so the clean-bundle
  // ergonomics assertion holds under the post-beta.33 behavior.
  writeFile(seed, 'extension/src/services/keystone-alpha.ts', 'export const keystoneAlpha = true;\n');
  writeFile(seed, 'extension/src/services/keystone-beta.ts', 'export const keystoneBeta = true;\n');
  writeFile(seed, 'extension/src/services/keystone-gamma.ts', 'export const keystoneGamma = true;\n');
  git(['add', '.'], seed);
  git(['commit', '-qm', 'fixture seed'], seed);
  git(['remote', 'add', 'origin', origin], seed);
  git(['push', '-qu', 'origin', 'main'], seed);

  git(['clone', '-q', origin, clone], root);
  git(['config', 'commit.gpgsign', 'false'], clone);
  git(['checkout', '-qb', 'feature'], clone);
  for (let i = 0; i < commitCount; i += 1) {
    fs.writeFileSync(path.join(clone, `feature-${i}.txt`), `feature ${i}\n`);
    git(['add', '.'], clone);
    git(['commit', '-qm', `feature ${i}`], clone);
  }
  git(['push', '-qu', 'origin', 'feature'], clone);
  git(['branch', '-D', 'main'], clone);
  return { root, clone };
}

function writeClaudeShim(binDir) {
  const shimPath = path.join(binDir, 'claude');
  const serializedTickets = JSON.stringify(JSON.stringify(TICKETS));
  fs.writeFileSync(shimPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const path = require('path');",
    "const promptIndex = process.argv.indexOf('-p');",
    "const prompt = promptIndex === -1 ? '' : (process.argv[promptIndex + 1] || '');",
    "const outputMatch = /Write ALL findings to this file: (.+)/.exec(prompt);",
    'if (!outputMatch) {',
    "  process.stderr.write('missing output path');",
    '  process.exit(1);',
    '}',
    'const outputPath = outputMatch[1];',
    `const tickets = JSON.parse(${serializedTickets});`,
    "const payload = outputPath.includes('analysis_requirements.md')",
    '  ? { ac_shape_smells: [], tickets }',
    '  : { ac_shape_smells: [], tickets: [] };',
    'fs.mkdirSync(path.dirname(outputPath), { recursive: true });',
    "fs.writeFileSync(outputPath, ['## ac_shape_smells', '', '```json', JSON.stringify(payload, null, 2), '```', ''].join('\\n'));",
    "process.stdout.write('<promise>I AM DONE</promise>\\n');",
    'process.exit(0);',
    '',
  ].join('\n'));
  fs.chmodSync(shimPath, 0o755);
}

function parseSessionRoot(output) {
  const match = output.match(/SESSION_ROOT=(.+)/);
  assert.ok(match, `SESSION_ROOT not found in output:\n${output}`);
  return match[1].trim();
}

function runSetupPaused(workingDir, dataRoot) {
  return execFileSync(process.execPath, [SETUP_BIN, '--paused', '--task', 'gate ergonomics keystone'], {
    cwd: workingDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      PICKLE_DATA_ROOT: dataRoot,
    },
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function readState(sessionDir) {
  return readJson(path.join(sessionDir, 'state.json'));
}

function writeTicketFile(sessionDir, template, extra = {}) {
  const ticket = { ...template, ...extra };
  const ticketDir = path.join(sessionDir, ticket.id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticket.id}.md`), [
    '---',
    `id: ${ticket.id}`,
    `title: ${ticket.title}`,
    'status: Todo',
    `key: ${ticket.id.toUpperCase()}`,
    `ac_ids: [${ticket.source_ac_ids.join(', ')}]`,
    ...(ticket.source_prd ? [`source_prd: ${ticket.source_prd}`] : []),
    ...(ticket.source_section ? [`source_section: ${ticket.source_section}`] : []),
    '---',
    '',
    '# Ticket',
    '',
    '## Files to modify/create',
    ...template.files,
    '',
    '## Acceptance Criteria',
    `- [ ] \`${template.acceptance_test}\``,
    '',
    '## Conformance Check',
    '- [ ] none',
    '',
    '<!-- audit: 7-class checked 2026-05-14 -->',
    '',
  ].join('\n'));
}

function seedSessionTickets(sessionDir) {
  for (const template of TICKETS) {
    writeTicketFile(sessionDir, template);
  }
}

function materializeTickets(sessionDir, manifest) {
  for (const ticket of manifest.tickets) {
    const template = TICKETS.find((entry) => entry.id === ticket.id);
    assert.ok(template, `missing template for ${ticket.id}`);
    writeTicketFile(sessionDir, template, {
      source_prd: ticket.source_prd,
      source_section: ticket.source_section,
    });
  }
}

function runRefinement(sessionDir, prdPath, workingDir, fakeBinDir) {
  return spawnSync(process.execPath, [
    REFINEMENT_BIN,
    '--prd', prdPath,
    '--session-dir', sessionDir,
    '--cycles', '1',
    '--max-turns', '1',
    '--timeout', '15',
  ], {
    cwd: workingDir,
    encoding: 'utf-8',
    timeout: 45_000,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
}

function runReadiness(sessionDir, repoRoot) {
  return spawnSync(process.execPath, [
    READINESS_BIN,
    '--session-dir', sessionDir,
    '--repo-root', repoRoot,
    '--manifest', 'refinement_manifest.json',
  ], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 20_000,
  });
}

function runAudit(sessionDir, repoRoot) {
  const manifestPath = path.join(sessionDir, 'audit-ticket-bundle.json');
  const result = spawnSync(process.execPath, [
    AUDIT_BIN,
    sessionDir,
    '--manifest', manifestPath,
  ], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { result, manifestPath };
}

test('gate ergonomics keystone: paused setup, refinement, readiness, audit, and scope stay clean end-to-end', { timeout: 120_000 }, () => {
  const fixture = createTrackedFixtureRepo();
  const dataRoot = tmpDir('gate-keystone-data-');
  const fakeBinDir = tmpDir('gate-keystone-bin-');
  writeClaudeShim(fakeBinDir);

  try {
    const bundlePath = path.join(fixture.clone, 'bundle.md');
    const setupOutput = runSetupPaused(fixture.clone, dataRoot);
    const sessionDir = parseSessionRoot(setupOutput);
    const stateBefore = readState(sessionDir);
    assert.equal(stateBefore.active, false);
    assert.equal(stateBefore.working_dir, fixture.clone);
    assert.equal(stateBefore.flags?.skip_readiness_reason, undefined);
    assert.equal(stateBefore.flags?.skip_ticket_audit_reason, undefined);

    const started = Date.now();
    seedSessionTickets(sessionDir);
    const refinement = runRefinement(sessionDir, bundlePath, fixture.clone, fakeBinDir);
    const refinementElapsed = Date.now() - started;
    assert.equal(refinement.status, 0, refinement.stderr || refinement.stdout);

    const refinementManifestPath = path.join(sessionDir, 'refinement_manifest.json');
    assert.ok(fs.existsSync(refinementManifestPath), 'refinement_manifest.json should exist');
    const refinementManifest = readJson(refinementManifestPath);
    assert.deepEqual(refinementManifest.tickets.map((ticket) => ticket.source_prd), [
      'prds/source-alpha.md',
      'prds/source-beta.md',
      'prds/source-beta.md',
    ]);
    materializeTickets(sessionDir, refinementManifest);
    fs.writeFileSync(path.join(sessionDir, 'decomposition_manifest.json'), JSON.stringify(refinementManifest, null, 2));

    for (const ticket of refinementManifest.tickets) {
      const ticketPath = path.join(sessionDir, ticket.id, `linear_ticket_${ticket.id}.md`);
      const content = fs.readFileSync(ticketPath, 'utf-8');
      assert.match(content, new RegExp(`source_prd: ${ticket.source_prd.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
      assert.doesNotMatch(content, /^\s*source_prd:\s+\//m);
    }

    const readiness = runReadiness(sessionDir, fixture.clone);
    assert.equal(readiness.status, 0, readiness.stderr || readiness.stdout);
    const readinessOut = JSON.parse(readiness.stdout);
    assert.equal(readinessOut.status, 'pass');
    assert.deepEqual(readinessOut.findings, []);

    const scope = resolveScope({
      repoRoot: fixture.clone,
      sessionRoot: sessionDir,
      scopeFlag: 'branch',
    });
    assert.equal(scope.base_ref, 'origin/main');
    assert.ok(scope.allowed_paths.length >= 100, `expected >=100 allowed paths, got ${scope.allowed_paths.length}`);

    const { result: auditResult, manifestPath: auditManifestPath } = runAudit(sessionDir, fixture.clone);
    assert.equal(auditResult.status, 0, auditResult.stderr || auditResult.stdout);
    const auditManifest = readJson(auditManifestPath);
    assert.equal(auditManifest.exit_code, 0);
    assert.ok(
      auditManifest.findings.every((finding) => finding.severity !== 'warning' && finding.severity !== 'fatal'),
      JSON.stringify(auditManifest.findings, null, 2),
    );
    const driftFindings = auditManifest.findings.filter((finding) => finding.defect_class === 'cross-doc-naming-drift');
    assert.ok(driftFindings.length >= 1, `expected at least one drift finding, got ${JSON.stringify(auditManifest.findings)}`);
    assert.ok(driftFindings.every((finding) => finding.severity === 'info'));

    const stateAfter = readState(sessionDir);
    assert.equal(stateAfter.flags?.skip_readiness_reason, undefined);
    assert.equal(stateAfter.flags?.skip_ticket_audit_reason, undefined);

    const totalElapsed = refinementElapsed + readinessOut.elapsed_ms + (auditManifest.elapsed_ms ?? 0);
    assert.ok(totalElapsed < 60_000, `expected combined wall time < 60000ms, got ${totalElapsed}`);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
