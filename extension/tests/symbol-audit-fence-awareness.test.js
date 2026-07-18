// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
