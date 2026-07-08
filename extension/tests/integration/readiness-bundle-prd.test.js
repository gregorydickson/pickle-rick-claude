// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const BIN = path.resolve(__dirname, '../../bin/check-readiness.js');
const BUNDLE_PRD = path.join(REPO_ROOT, 'prds/archive/bundles/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md');
const CHECKED_AT = '2026-05-02T00:00:00.000Z';

function tmpDir(prefix = 'pickle-readiness-bundle-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function bundleAcIds() {
  const content = fs.readFileSync(BUNDLE_PRD, 'utf-8');
  return [...new Set([...content.matchAll(/\bAC-DR-[A-Za-z0-9-]+\b/g)].map((match) => match[0]))].sort();
}

function writeTicket(sessionDir, acId) {
  const id = acId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), [
    '---',
    `id: ${id}`,
    `key: ${acId}`,
    '---',
    '',
    '# Ticket',
    '',
    '## Acceptance Criteria',
    `- [ ] ${acId} passes after implementation.`,
  ].join('\n'));
  return { id, key: acId, requirements: [acId] };
}

test('check-readiness: current bundle PRD clears readiness without skip-readiness and writes AC-DR-06 artifact', () => {
  const sessionDir = tmpDir();
  try {
    const acIds = bundleAcIds();
    assert.ok(acIds.includes('AC-DR-06'), 'fixture bundle must define AC-DR-06');
    const tickets = acIds.map((acId) => writeTicket(sessionDir, acId));
    fs.writeFileSync(path.join(sessionDir, 'decomposition_manifest.json'), JSON.stringify({
      prd_path: BUNDLE_PRD,
      requirements: acIds,
      tickets,
    }, null, 2));

    const readinessArgs = [
      BIN,
      '--session-dir', sessionDir,
      '--repo-root', REPO_ROOT,
    ];
    const result = spawnSync(process.execPath, readinessArgs, {
      encoding: 'utf-8',
      timeout: 10000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(readinessArgs.join(' '), /--skip-readiness/);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    assert.deepEqual(out.findings, []);

    const artifactDir = path.join(REPO_ROOT, 'bundle');
    fs.mkdirSync(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, 'ac-dr-06.json');
    fs.writeFileSync(artifactPath, JSON.stringify({
      ac_id: 'AC-DR-06',
      pass: true,
      checked_at: CHECKED_AT,
      checker: 'tests/integration/readiness-bundle-prd.test.js',
      checker_version: 'local',
      evidence: {
        bundle_prd: 'prds/archive/bundles/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md',
        ticket_count: tickets.length,
        skip_readiness: false,
      },
      failure_reason: null,
      remediation_hint: null,
    }, null, 2));
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
