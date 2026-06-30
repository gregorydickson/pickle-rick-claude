// @tier: fast
/**
 * W1c (AC-W1c-1) — resolver_indeterminate: a checker that can't finish is not a defect.
 *
 * When the readiness contract/symbol resolver exhausts its wall budget, the gate MUST:
 *   - emit a NAMED `resolver_indeterminate` (warn) activity event with
 *     gate_payload {wall_ms, budget_ms, phase}, and
 *   - exit 0 (the over-budget `kind:'performance'` finding is advisory, excluded from
 *     blockingFindings) — never a halting `wall_budget_exceeded` finding.
 * A within-budget run with only resolvable refs emits a normal pass verdict and NO event.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';

const READINESS_BIN = path.resolve(import.meta.dirname, '../bin/check-readiness.js');

// Every contract ref below is a real exported symbol of check-readiness.ts, so none can
// ever produce a blocking `contract` finding — the only findings come from the wall budget.
const RESOLVABLE_SYMBOLS = [
  'extractContractReferences()', 'extractAcceptanceCriteria()', 'isMachineCheckable()',
  'parseArgs()', 'runHistory()', 'findReadinessFindings()', 'loadReadinessAllowlist()',
  'runReadiness()', 'resolveSymbolRef()',
  'gitTrackedFiles()', 'createResolverCache()',
];

function buildSession(symbols) {
  const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-w1c-')));
  const ticketDir = path.join(sessionDir, 'wb0001');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, 'linear_ticket_wb0001.md'), [
    '---', 'id: wb0001', 'key: WB-1', 'ac_ids: []', '---', '',
    '# Ticket', '', '## Acceptance Criteria', '- [ ] `node --test` passes.', '',
    '## Interface Contracts', '',
    ...symbols.map((sym) => `- \`${sym}\` must exist.`), '',
  ].join('\n'));
  fs.writeFileSync(
    path.join(sessionDir, 'decomposition_manifest.json'),
    JSON.stringify({ tickets: [{ id: 'wb0001', key: 'WB-1' }] }, null, 2),
  );
  return sessionDir;
}

function runReadiness(sessionDir, dataRoot, maxWallMs) {
  return spawnSync(process.execPath, [
    READINESS_BIN,
    '--session-dir', sessionDir,
    '--repo-root', process.cwd(),
    '--contract-only',
    '--max-wall-ms', String(maxWallMs),
  ], { encoding: 'utf-8', timeout: 120000, env: { ...process.env, PICKLE_DATA_ROOT: dataRoot } });
}

function readActivityEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  return fs.readdirSync(activityDir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(activityDir, f), 'utf-8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line)));
}

test('AC-W1c-EVENT: resolver_indeterminate is registered in VALID_ACTIVITY_EVENTS', () => {
  assert.ok(
    VALID_ACTIVITY_EVENTS.includes('resolver_indeterminate'),
    'resolver_indeterminate must be present in VALID_ACTIVITY_EVENTS',
  );
});

test('AC-W1c-1: over-budget resolver emits resolver_indeterminate (warn) and exits 0', () => {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-w1c-data-')));
  const sessionDir = buildSession(RESOLVABLE_SYMBOLS);
  try {
    // --max-wall-ms 1 exhausts the shared resolver budget after the first ref.
    const result = runReadiness(sessionDir, dataRoot, 1);

    assert.equal(result.status, 0, `over-budget run must exit 0; stderr: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass', 'status must be pass (no blocking findings)');

    // The over-budget condition stays advisory: a performance finding is surfaced...
    assert.ok(
      out.findings.some((f) => f.kind === 'performance'),
      `performance finding must be surfaced; got ${JSON.stringify(out.findings)}`,
    );
    // ...and NO blocking / halting finding exists (no `wall_budget_exceeded`-style halt).
    assert.ok(
      !out.findings.some((f) => f.kind !== 'performance'),
      `no blocking finding expected; got ${JSON.stringify(out.findings)}`,
    );

    const events = readActivityEvents(dataRoot);
    const indeterminate = events.filter((e) => e.event === 'resolver_indeterminate');
    assert.equal(indeterminate.length, 1, `exactly one resolver_indeterminate expected; got ${indeterminate.length}`);

    const evt = indeterminate[0];
    assert.ok(typeof evt.ts === 'string' && evt.ts.length > 0, 'event must carry a ts');
    assert.ok(evt.gate_payload, 'event must carry gate_payload');
    assert.equal(typeof evt.gate_payload.wall_ms, 'number');
    assert.equal(evt.gate_payload.budget_ms, 1, 'budget_ms must reflect the --max-wall-ms argument');
    assert.equal(evt.gate_payload.phase, 'contract', 'phase must be contract for --contract-only run');

    // The named event NEVER coexists with a halting wall_budget_exceeded finding.
    assert.ok(
      !out.findings.some((f) => /wall_budget_exceeded/i.test(f.message || '')),
      'no halting wall_budget_exceeded finding may be emitted',
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('AC-W1c-1: within-budget resolvable run emits normal verdict and NO resolver_indeterminate', () => {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-w1c-data-')));
  const sessionDir = buildSession(RESOLVABLE_SYMBOLS);
  try {
    // A generous budget lets every (resolvable) ref resolve — no truncation, no event.
    const result = runReadiness(sessionDir, dataRoot, 120000);

    assert.equal(result.status, 0, `within-budget resolvable run must pass; stderr: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    assert.ok(
      !out.findings.some((f) => f.kind === 'performance'),
      `no performance finding within budget; got ${JSON.stringify(out.findings)}`,
    );

    const events = readActivityEvents(dataRoot);
    assert.ok(
      !events.some((e) => e.event === 'resolver_indeterminate'),
      'within-budget run must NOT emit resolver_indeterminate',
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
