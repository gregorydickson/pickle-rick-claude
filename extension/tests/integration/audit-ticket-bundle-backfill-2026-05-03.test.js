// @tier: integration
/**
 * AC-TAQ-FIXTURE-01 — per-class fixture corpus exists under
 *   extension/tests/fixtures/audit-ticket-bundle/class-{1..7}/
 * AC-TAQ-06 — backfill audit on session 2026-05-03-7d9ee8cc produces ≥12 findings.
 * AC-TAQ-BACKFILL-01 — every documented per-ticket class mapping fires the right
 *   defect_class tag.
 *
 * Section H test contract proving Sections A+B+C close the documented gap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');
const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixtures', 'audit-ticket-bundle');
const BACKFILL_FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixtures', 'baseline-2026-05-03-7d9ee8cc');
const AUDIT_BIN = path.resolve(__dirname, '..', '..', 'bin', 'audit-ticket-bundle.js');
const START_COMMIT = 'ee2ae138a6cc3edc4fbcd9b420f53cb9f5947bb6';

function createBackfillSession() {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'pickle-audit-backfill-'));

  for (const entry of readdirSync(BACKFILL_FIXTURE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcTicketDir = path.join(BACKFILL_FIXTURE_ROOT, entry.name);
    const destTicketDir = path.join(sessionDir, entry.name);
    mkdirSync(destTicketDir, { recursive: true });
    for (const file of readdirSync(srcTicketDir)) {
      copyFileSync(path.join(srcTicketDir, file), path.join(destTicketDir, file));
    }
  }

  writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      working_dir: REPO_ROOT,
      start_commit: START_COMMIT,
    }),
  );

  return sessionDir;
}

test('AC-TAQ-FIXTURE-01: class-1..7 fixture directories each contain exactly one ticket', () => {
  const classes = readdirSync(FIXTURE_ROOT).filter((d) => d.startsWith('class-'));
  assert.equal(classes.length, 7, `expected 7 class dirs, got ${classes.length}: ${classes.join(',')}`);

  for (const klass of classes) {
    const ticketFiles = readdirSync(path.join(FIXTURE_ROOT, klass)).filter((f) =>
      /^rick_ticket_[a-f0-9]{8}\.md$/.test(f),
    );
    assert.equal(
      ticketFiles.length,
      1,
      `${klass} must contain exactly one synthetic rick_ticket_<hash>.md, got ${ticketFiles.length}`,
    );
  }
});

test('AC-TAQ-FIXTURE-01: each class fixture has the audit comment and a deliberate violation hint in the body', () => {
  const classes = readdirSync(FIXTURE_ROOT).filter((d) => d.startsWith('class-'));
  for (const klass of classes) {
    const dir = path.join(FIXTURE_ROOT, klass);
    const ticketFile = readdirSync(dir).find((f) => f.startsWith('rick_ticket_'));
    const content = readFileSync(path.join(dir, ticketFile), 'utf-8');
    assert.ok(
      /<!-- audit: 7-class checked \d{4}-\d{2}-\d{2} -->/.test(content),
      `${klass}/${ticketFile} missing audit comment`,
    );
    assert.ok(content.includes('## Problem to solve'), `${klass}/${ticketFile} missing Problem section`);
  }
});

const BACKFILL_SKIP = process.env.PICKLE_SKIP_BACKFILL_AUDIT === '1';

test('AC-TAQ-06: backfill audit on 2026-05-03-7d9ee8cc produces ≥12 findings', { skip: BACKFILL_SKIP }, () => {
  const backfillSession = createBackfillSession();
  try {
    const result = spawnSync(process.execPath, [AUDIT_BIN, backfillSession], {
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      cwd: EXTENSION_ROOT,
    });
    const manifestPath = path.join(backfillSession, 'audit-ticket-bundle.json');
    assert.ok(existsSync(manifestPath), 'audit-ticket-bundle manifest must be written');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    assert.ok(Array.isArray(manifest.findings), 'manifest must have findings array');
    assert.ok(
      manifest.findings.length >= 12,
      `expected ≥12 findings on 2026-05-03-7d9ee8cc, got ${manifest.findings.length}`,
    );
    // Non-zero exit on defective bundle is the contract from AC-TAQ-02.
    assert.notEqual(result.status, 0, 'audit must exit non-zero when findings exist');
  } finally {
    rmSync(backfillSession, { recursive: true, force: true });
  }
});

test('AC-TAQ-BACKFILL-01: every documented ticket-class mapping fires its expected class tag', { skip: BACKFILL_SKIP }, () => {
  const backfillSession = createBackfillSession();
  try {
    const result = spawnSync(process.execPath, [AUDIT_BIN, backfillSession], {
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      cwd: EXTENSION_ROOT,
    });
    const manifestPath = path.join(backfillSession, 'audit-ticket-bundle.json');
    assert.notEqual(result.status, 2, `audit failed operationally:\n${result.stderr}`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    // Index findings by ticket_id → set of defect_class tags.
    const byTicket = new Map();
    for (const f of manifest.findings) {
      const id = f.ticket_id;
      if (!id) continue;
      let s = byTicket.get(id);
      if (!s) { s = new Set(); byTicket.set(id, s); }
      s.add(f.defect_class);
    }

    const expectedByTicket = new Map([
      ['aa001122', ['path-drift', 'hallucinated-premise']],
      ['bb112233', ['self-reference', 'missing-deps']],
      ['ee334455', ['path-drift', 'cross-doc-naming', 'hallucinated-premise']],
      ['dd334455', ['path-drift', 'wrong-HEAD-assumptions', 'cross-doc-naming-drift', 'hallucinated-premise']],
    ]);

    const missingTickets = [...expectedByTicket.keys()].filter((id) => !byTicket.has(id));
    assert.deepStrictEqual(
      missingTickets,
      [],
      `every baseline defective ticket must produce findings; missing: ${missingTickets.join(',')}`,
    );

    for (const [ticketId, expectedClasses] of expectedByTicket) {
      const classes = byTicket.get(ticketId) ?? new Set();
      for (const defectClass of expectedClasses) {
        assert.ok(
          classes.has(defectClass),
          `ticket ${ticketId} must emit defect_class ${defectClass}; got ${[...classes].join(', ')}`,
        );
      }
    }
  } finally {
    rmSync(backfillSession, { recursive: true, force: true });
  }
});
