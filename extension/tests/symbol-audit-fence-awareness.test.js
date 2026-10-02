// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { evaluateSymbolAudit } = await import('../bin/spawn-refinement-team.js');

const WORKING_DIR = process.cwd();

test('AC-SAFP-7: an invented activity-event symbol cited only inside a fenced block yields zero findings', () => {
  const prdContent = [
    '# Test PRD',
    '',
    '## Activity Events',
    '',
    'Example evidence, not a claim:',
    '',
    '```',
    'The worker must emit the activity event `totally_fenced_phantom_xyz` when the run completes.',
    '```',
    '',
  ].join('\n');
  const report = evaluateSymbolAudit(prdContent, WORKING_DIR, { tickets: [] });

  assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
  assert.equal(report.findings.length, 0, JSON.stringify(report.findings, null, 2));
});

test('AC-SAFP-7 (control): the same invented symbol in unfenced prose IS reported', () => {
  const prdContent = [
    '# Test PRD',
    '',
    '## Activity Events',
    '',
    'The worker must emit the activity event `totally_fenced_phantom_xyz` when the run completes.',
    '',
  ].join('\n');
  const report = evaluateSymbolAudit(prdContent, WORKING_DIR, { tickets: [] });

  assert.equal(report.ok, false, JSON.stringify(report.findings, null, 2));
  assert.ok(
    report.findings.some((finding) => finding.category === 'activity_event' && finding.symbol === 'totally_fenced_phantom_xyz'),
    JSON.stringify(report.findings, null, 2)
  );
});

test('self-ingestion: a verbatim symbol_audit.md-shaped paste inside a fence yields zero findings from the fenced region', () => {
  const prdContent = [
    '# Test PRD',
    '',
    '## Evidence',
    '',
    'Prior run output, pasted verbatim for context:',
    '',
    '```',
    '# Symbol Audit',
    '',
    'Status: FAIL',
    '',
    '## Activity Events',
    '| Symbol | Status | PRD Line | Detail |',
    '|---|---:|---:|---|',
    '| `foo_event` | PHANTOM | 12 | not present in VALID_ACTIVITY_EVENTS |',
    '',
    '## Findings',
    '',
    '- activity_event: `foo_event` at PRD line 12 - not present in VALID_ACTIVITY_EVENTS',
    '',
    '{"category": "activity_event", "symbol": "foo_event", "sourceLine": 12, "reason": "not present in VALID_ACTIVITY_EVENTS"}',
    '```',
    '',
  ].join('\n');
  const report = evaluateSymbolAudit(prdContent, WORKING_DIR, { tickets: [] });

  assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
  assert.equal(report.findings.length, 0, JSON.stringify(report.findings, null, 2));
});

test('no detection regression: an invented helper sentinel in unfenced prose is still reported', () => {
  const prdContent = [
    '# Test PRD',
    '',
    '## Helpers',
    '',
    'This PRD relies on the sentinel helper `totallyInventedHelperSentinelXyz` to gate the retry.',
    '',
  ].join('\n');
  const report = evaluateSymbolAudit(prdContent, WORKING_DIR, { tickets: [] });

  assert.equal(report.ok, false, JSON.stringify(report.findings, null, 2));
  assert.ok(
    report.findings.some((finding) => finding.category === 'helper_sentinel' && finding.symbol === 'totallyInventedHelperSentinelXyz'),
    JSON.stringify(report.findings, null, 2)
  );
});

test('unterminated fence does not throw', () => {
  const prdContent = [
    '# Test PRD',
    '',
    '## Activity Events',
    '',
    '```',
    'The worker must emit the activity event `unterminated_fence_phantom` when the run completes.',
    '',
  ].join('\n');

  assert.doesNotThrow(() => evaluateSymbolAudit(prdContent, WORKING_DIR, { tickets: [] }));
  const report = evaluateSymbolAudit(prdContent, WORKING_DIR, { tickets: [] });
  assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
});

function dependencyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dts-sym-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@fx/types': '1.0.0' } }));
  fs.mkdirSync(path.join(dir, 'node_modules', '@fx', 'types'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', '@fx', 'types', 'index.d.ts'), "export declare const k: 'widget_state';\n");
  return dir;
}

test('T3-F4: a helper symbol declared in a declared dependency .d.ts is valid; an undeclared absent one stays phantom', () => {
  const dir = dependencyFixture();
  try {
    const prd = (sym) => `# PRD\n\nThis relies on the helper \`${sym}\` for state.\n`;
    const hit = evaluateSymbolAudit(prd('widget_state'), dir, { tickets: [] });
    assert.equal(hit.ok, true, JSON.stringify(hit.findings));
    assert.equal(hit.helperSentinels[0].reason, 'declared in an installed dependency');
    const miss = evaluateSymbolAudit(prd('absent_symbol_qq'), dir, { tickets: [] });
    assert.equal(miss.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
