// @tier: fast
/**
 * audit-ticket-bundle-hallucinated-premise-suffix.test.js
 *
 * AC-R-RESH-1: hallucinated-premise check uses suffix-symmetric git ls-files
 * match (R-RTRC-4 parity with checkPathDrift).
 *
 *   HP-SUFFIX-01 — ## Problem cites `src/lib/salvage-ticket.ts` (real at
 *                  extension/src/lib/salvage-ticket.ts via suffix match)
 *                  → no hallucinated-premise finding
 *   HP-SUFFIX-02 — ## Problem cites fabricated path → hallucinated-premise fatal
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(__dirname, '..', 'bin', 'audit-ticket-bundle.js');
const SCRIPT_DIR = path.resolve(__dirname, '..', 'bin');

// The actual project root — git ls-files will be run here.
// extension/src/lib/salvage-ticket.ts is tracked at HEAD.
const PROJECT_DIR = path.resolve(__dirname, '..', '..');

const { auditSession } = await import(BUNDLE);

function makeSessionDir(problemText) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-hp-suffix-'));
  const ticketId = 'aabbccdd';
  const ticketSubdir = path.join(tmpDir, ticketId);
  fs.mkdirSync(ticketSubdir, { recursive: true });

  const ticketContent = [
    '---',
    `id: ${ticketId}`,
    'title: "Suffix match test"',
    'status: "Todo"',
    'priority: High',
    'order: 1',
    'complexity_tier: small',
    `working_dir: ${PROJECT_DIR}`,
    'created: 2026-06-18',
    'updated: 2026-06-18',
    '---',
    '# Description',
    '## Problem',
    problemText,
    '## Solution',
    'Fix it.',
  ].join('\n');

  fs.writeFileSync(path.join(ticketSubdir, `rick_ticket_${ticketId}.md`), ticketContent, 'utf-8');

  // Minimal state.json so loadSessionState resolves working_dir to the project.
  fs.writeFileSync(
    path.join(tmpDir, 'state.json'),
    JSON.stringify({ working_dir: PROJECT_DIR }),
    'utf-8',
  );

  return tmpDir;
}

test('HP-SUFFIX-01: Problem cites extension-relative path via suffix match — no hallucinated-premise', () => {
  // git tracks extension/src/lib/salvage-ticket.ts
  // ticket cites src/lib/salvage-ticket.ts (no extension/ prefix)
  // suffix regex (?:^|/)src/lib/salvage-ticket\.ts$ MUST match
  const tmpDir = makeSessionDir('The `src/lib/salvage-ticket.ts:555-561` function has a bug.');
  try {
    const result = auditSession(tmpDir, SCRIPT_DIR);
    const hallucinatedFindings = result.findings.filter((f) => f.defect_class === 'hallucinated-premise');
    assert.deepStrictEqual(
      hallucinatedFindings,
      [],
      `Expected no hallucinated-premise for real extension-relative path, got: ${JSON.stringify(hallucinatedFindings)}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HP-SUFFIX-02: Problem cites genuinely fabricated path — hallucinated-premise fatal emitted', () => {
  // No file like totally/fake/zzz-nonexistent-path-xyz.ts exists in git.
  const tmpDir = makeSessionDir('The `totally/fake/zzz-nonexistent-path-xyz.ts` function has a bug.');
  try {
    const result = auditSession(tmpDir, SCRIPT_DIR);
    const hallucinatedFindings = result.findings.filter((f) => f.defect_class === 'hallucinated-premise');
    assert.equal(
      hallucinatedFindings.length,
      1,
      `Expected 1 hallucinated-premise for fake path, got: ${JSON.stringify(hallucinatedFindings)}`,
    );
    assert.ok(
      hallucinatedFindings[0].evidence.includes('totally/fake/zzz-nonexistent-path-xyz.ts'),
      `Expected evidence to cite the fake path, got: ${hallucinatedFindings[0].evidence}`,
    );
    assert.equal(hallucinatedFindings[0].severity, 'fatal');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HP-SUFFIX-03: suffix is anchored to the full cited path, not bare basename — still fatal', () => {
  // basename `salvage-ticket.ts` IS tracked (at extension/src/lib/salvage-ticket.ts), but the
  // 2-segment suffix `nonexistent-dir/salvage-ticket.ts` is NOT. The anchored regex
  // (?:^|/)nonexistent-dir/salvage-ticket\.ts$ must NOT match — proving the resolver keys on the
  // full multi-segment ref, not a loose basename match (which would false-suppress this finding).
  const tmpDir = makeSessionDir('The `nonexistent-dir/salvage-ticket.ts` function has a bug.');
  try {
    const result = auditSession(tmpDir, SCRIPT_DIR);
    const hallucinatedFindings = result.findings.filter((f) => f.defect_class === 'hallucinated-premise');
    assert.equal(
      hallucinatedFindings.length,
      1,
      `Expected 1 hallucinated-premise for a non-anchored multi-segment path, got: ${JSON.stringify(hallucinatedFindings)}`,
    );
    assert.ok(
      hallucinatedFindings[0].evidence.includes('nonexistent-dir/salvage-ticket.ts'),
      `Expected evidence to cite the non-anchored path, got: ${hallucinatedFindings[0].evidence}`,
    );
    assert.equal(hallucinatedFindings[0].severity, 'fatal');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
