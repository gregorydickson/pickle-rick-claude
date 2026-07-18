// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures', 'symbol-audit', 'b-nonstop.md');

const { evaluateSymbolAudit } = await import('../bin/spawn-refinement-team.js');

function makeTmpDir(prefix = 'pickle-symbol-audit-false-positives-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('AC-SAFP-1/AC-SAFP-5: B-NONSTOP fixture yields ok===true with 0 findings', () => {
  const prdContent = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const report = evaluateSymbolAudit(prdContent, REPO_ROOT, { tickets: [] }, FIXTURE_PATH);

  assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
  assert.equal(report.findings.length, 0, JSON.stringify(report.findings, null, 2));
});

test('AC-SAFP-2: a HEAD-declared symbol cited near a trigger word is not reported (anatomy_non_convergent)', () => {
  const prdContent = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const report = evaluateSymbolAudit(prdContent, REPO_ROOT, { tickets: [] }, FIXTURE_PATH);

  assert.ok(
    !report.activityEvents.some((ref) => ref.symbol === 'anatomy_non_convergent' && ref.status === 'phantom'),
    JSON.stringify(report.activityEvents, null, 2)
  );
  assert.ok(
    !report.findings.some((finding) => finding.symbol === 'anatomy_non_convergent'),
    JSON.stringify(report.findings, null, 2)
  );
});

test('AC-SAFP-3: a function name cited near a trigger word is not reported (finalizePhaseSuccess) — exit_code category is gone', () => {
  const prdContent = [
    '# Test PRD',
    '',
    '- The phase report ignores the exit code for non-pickle phases. `finalizePhaseSuccess`',
    '  does forward `exitCode` to `maybeStampPhaseGraduation`, but that gate opens only for pickle.',
    'Exit codes: `finalizePhaseSuccess`, `maybeStampPhaseGraduation`.',
    '',
  ].join('\n');
  const report = evaluateSymbolAudit(prdContent, REPO_ROOT, { tickets: [] });

  assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
  assert.equal(report.findings.length, 0, JSON.stringify(report.findings, null, 2));
  assert.ok(
    !report.findings.some((finding) => finding.category === 'exit_code'),
    'exit_code category must no longer exist on any finding'
  );
});

test('AC-SAFP-6: a genuinely invented symbol in claim shape IS still reported, even with no src/ or extension/src/ in the working dir', () => {
  const noSrcWorkingDir = makeTmpDir();
  try {
    assert.ok(!fs.existsSync(path.join(noSrcWorkingDir, 'src')));
    assert.ok(!fs.existsSync(path.join(noSrcWorkingDir, 'extension', 'src')));

    const invented = 'totally_made_up_event_xyz';
    const prdContent = [
      '# Test PRD',
      '',
      '## Activity Events',
      '',
      `The worker must emit the activity event \`${invented}\` when the run completes.`,
      '',
    ].join('\n');
    const report = evaluateSymbolAudit(prdContent, noSrcWorkingDir, { tickets: [] });

    assert.equal(report.ok, false, JSON.stringify(report.findings, null, 2));
    assert.ok(
      report.findings.some((finding) => finding.category === 'activity_event' && finding.symbol === invented),
      JSON.stringify(report.findings, null, 2)
    );
  } finally {
    fs.rmSync(noSrcWorkingDir, { recursive: true, force: true });
  }
});
