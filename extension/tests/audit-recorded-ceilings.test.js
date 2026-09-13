// @tier: fast
// B-RATCHET R1-6: audit-recorded-ceilings.sh runs against temp-dir fixtures, never the real source.
// Each arm mutates ONE thing relative to the exact-record control, so its verdict is attributable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const EXTENSION_ROOT = path.resolve(import.meta.dirname, '..');
const AUDIT_SCRIPT = path.join(EXTENSION_ROOT, 'scripts', 'audit-recorded-ceilings.sh');

// Measured by the audit itself on SAMPLE_BODY: 6 code lines (blank + comment lines skipped), complexity 4.
const MEASURED_LINES = 6;
const MEASURED_COMPLEXITY = 4;

function sampleFunction(directive, extraLines = 0) {
  const growth = Array.from({ length: extraLines }, (_, i) => `  const pad${i} = a;\n`).join('');
  return `${directive}
export function sample(a: number, b: number): number {
  // a comment line is not a code line

${growth}  if (a > b) {
    return a;
  }
  return a && b ? b : 0;
}
`;
}

function marker(lines, complexity) {
  const figures = [
    lines === undefined ? null : `measured ${lines} code lines against a ceiling of 120`,
    complexity === undefined ? null : `complexity ${complexity} against a ceiling of 15`,
  ].filter(Boolean).join(', and ');
  return `// eslint-disable-next-line max-lines-per-function, complexity -- HT-1 reviewed: ${figures}.`;
}

function runAudit(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-ceilings-')));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, 'src', name), content);
    const result = spawnSync('bash', [AUDIT_SCRIPT], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, RECORDED_CEILINGS_ROOT_OVERRIDE: root },
    });
    assert.equal(result.error, undefined, `audit did not run: ${result.error}`);
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('control: a record equal to the measurement passes', () => {
  const result = runAudit({ 'sample.ts': sampleFunction(marker(MEASURED_LINES, MEASURED_COMPLEXITY)) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 carve-outs checked/);
});

test('R1-3: a record above the measurement fails and names the number to write', () => {
  const result = runAudit({ 'sample.ts': sampleFunction(marker(MEASURED_LINES + 5, MEASURED_COMPLEXITY)) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`R1-3 src/sample\\.ts:1 sample max-lines-per-function: .*lower the record to ${MEASURED_LINES}\\b`));
  assert.doesNotMatch(result.stderr, /complexity:/);
});

test('R1-1: source grown past its record fails', () => {
  const result = runAudit({ 'sample.ts': sampleFunction(marker(MEASURED_LINES, MEASURED_COMPLEXITY), 3) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`R1-1 src/sample\\.ts:1 sample max-lines-per-function: measured ${MEASURED_LINES + 3} exceeds recorded ${MEASURED_LINES}`));
});

test('R1-2: deleting one figure from a two-rule marker fails', () => {
  const result = runAudit({ 'sample.ts': sampleFunction(marker(MEASURED_LINES, undefined)) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /R1-2 src\/sample\.ts:1 sample complexity: expected exactly one recorded figure, found 0/);
});

test('R1-2: a marker that says measured but carries no figure at all fails', () => {
  const directive = '// eslint-disable-next-line complexity -- HT-1 reviewed: measured against a ceiling.';
  const result = runAudit({ 'sample.ts': sampleFunction(directive) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /R1-2 src\/sample\.ts:1 sample complexity: expected exactly one recorded figure, found 0/);
});

test('R1-4: figure-less scoped disables are ignored and pass', () => {
  const result = runAudit({
    'reviewed.ts': sampleFunction('// eslint-disable-next-line complexity -- HT-1 reviewed: branches mirror the schema.'),
    'scoped.ts': `// eslint-disable-next-line pickle/no-sync-in-async -- startup read\nexport const x = 1;\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 carve-outs checked, 2 figure-less directives ignored/);
});

test('a scan that reaches no .ts file fails rather than reading clean', () => {
  const result = runAudit({});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no \.ts files under/);
});
