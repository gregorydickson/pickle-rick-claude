// @tier: fast
/**
 * R-RHFP (Finding #64) — check-readiness false-positive surface.
 * Two fixes verified here:
 *  (a) PATH_RE no longer drops the leading `.` of a dotfile path, so
 *      `.github/workflows/x.yml` is not mis-extracted as `github/workflows/x.yml`.
 *  (b) `*(refined: ...)*` correction notes are stripped before reference
 *      extraction, so deliberately-stale OLD paths quoted inside them are
 *      not flagged as unresolved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractContractReferences } from '../bin/check-readiness.js';

const RHFP_BIN = path.resolve(import.meta.dirname, '../bin/check-readiness.js');

test('R-RHFP (a): dotfile path keeps its leading dot', () => {
  const refs = extractContractReferences('CI is configured in .github/workflows/stability-gate.yml today');
  assert.ok(
    refs.includes('.github/workflows/stability-gate.yml'),
    `dotfile path must be extracted intact; got ${JSON.stringify(refs)}`,
  );
  assert.ok(
    !refs.includes('github/workflows/stability-gate.yml'),
    'the dot-stripped variant must NOT appear (that was the phantom finding)',
  );
});

test('R-RHFP (a): a normal non-dotfile path is still extracted', () => {
  const refs = extractContractReferences('edit extension/src/bin/mux-runner.ts for this');
  assert.ok(refs.includes('extension/src/bin/mux-runner.ts'));
});

test('R-RHFP (b): paths quoted inside a *(refined: ...)* note are not extracted', () => {
  const content = [
    'Implement the fix in `extension/src/bin/setup.ts`.',
    '*(refined: the original PRD cited `extension/src/old/stale-path.ts` — wrong, use the setup path)*',
  ].join('\n');
  const refs = extractContractReferences(content);
  assert.ok(refs.includes('extension/src/bin/setup.ts'), 'the real path must still be extracted');
  assert.ok(
    !refs.includes('extension/src/old/stale-path.ts'),
    `the stale path inside the correction note must be skipped; got ${JSON.stringify(refs)}`,
  );
});

test('R-RHFP (b): symbols quoted inside a *(refined: ...)* note are not extracted', () => {
  const content = 'Call `realHelper()`. *(refined: dropped the old `staleHelper()` call)*';
  const refs = extractContractReferences(content);
  assert.ok(refs.includes('realHelper()'));
  assert.ok(!refs.includes('staleHelper()'), `stale symbol in correction note must be skipped; got ${JSON.stringify(refs)}`);
});

/**
 * R-CCR-13: inline code-snippet suppression (AC-CCR-13-1, AC-CCR-13-2, AC-CCR-13-3)
 */
test('R-CCR-13 (AC-CCR-13-1): test-runner and workflow-input dotted tokens are not extracted', () => {
  const content = [
    'Use `t.skip()` to skip a test.',
    'Enable fake timers with `t.mock.timers.enable()`.',
    'The run count is available as `inputs.run_count`.',
  ].join('\n');
  const refs = extractContractReferences(content);
  assert.ok(
    !refs.includes('t.skip()'),
    `t.skip() must be suppressed (inline snippet); got ${JSON.stringify(refs)}`,
  );
  assert.ok(
    !refs.some((r) => r.startsWith('t.')),
    `no t.* ref must appear; got ${JSON.stringify(refs)}`,
  );
  assert.ok(
    !refs.some((r) => r.startsWith('inputs.')),
    `no inputs.* ref must appear; got ${JSON.stringify(refs)}`,
  );
});

test('R-CCR-13 (AC-CCR-13-2): genuine unresolved dotted symbol is still extracted', () => {
  // MyService is not a known snippet head, so this ref must pass through extraction
  // and appear in the returned set (the caller can then check resolution).
  const refs = extractContractReferences('Call `MyService.doWork` to process the job.');
  assert.ok(
    refs.includes('MyService.doWork'),
    `genuine in-repo dotted symbol must still be extracted; got ${JSON.stringify(refs)}`,
  );
});

// R-CCR-9: PATH_RE lookbehind (?<![\w./@-]) blocks @-scoped refs; ./ is in [\w.-] so ./-prefixed paths ARE extracted.
test('R-CCR-9 extractContractReferences: @-scoped package path is excluded from extraction', () => {
  const refs = extractContractReferences(
    'See `@scope/pkg/helper.ts` for the interface, also check `extension/src/bin/foo.ts`.',
  );
  assert.ok(
    !refs.some((r) => r.includes('@scope') || r === 'pkg/helper.ts'),
    `@-scoped package path must be excluded from extraction; got ${JSON.stringify(refs)}`,
  );
  assert.ok(
    refs.includes('extension/src/bin/foo.ts'),
    `plain in-repo path must still be extracted; got ${JSON.stringify(refs)}`,
  );
});

test('R-CCR-9 extractContractReferences: ./-prefixed relative path is included in extraction', () => {
  const refs = extractContractReferences('Edit `./src/helper.ts` to add the new function.');
  assert.ok(
    refs.includes('./src/helper.ts'),
    `./-prefixed path must be extracted as a contract ref; got ${JSON.stringify(refs)}`,
  );
});

/**
 * R-CCR-12 (AC-CCR-12-1): the intentional `@`-scoped-path exclusion must be
 * documented by a source comment immediately above `const PATH_RE =`. The
 * behavioral test above proves the regex EXCLUDES @-scoped refs; this pins the
 * comment that tells a future maintainer the exclusion is deliberate, so a
 * refactor cannot silently strip the rationale and leave the lookbehind
 * looking like a bug.
 */
test('R-CCR-12 (AC-CCR-12-1): PATH_RE carries a comment marking @-scoped paths as a deliberate exclusion', () => {
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/bin/check-readiness.ts'),
    'utf-8',
  );
  const lines = src.split('\n');
  const declIdx = lines.findIndex((l) => l.includes('const PATH_RE ='));
  assert.notEqual(declIdx, -1, 'const PATH_RE = must exist in check-readiness.ts');

  // Walk upward to collect the contiguous block of // comment lines directly
  // above the declaration — the AC requires the comment to sit "near PATH_RE",
  // so an unrelated comment elsewhere in the file cannot satisfy it.
  const commentLines = [];
  for (let i = declIdx - 1; i >= 0 && lines[i].trim().startsWith('//'); i -= 1) {
    commentLines.unshift(lines[i]);
  }
  assert.notEqual(
    commentLines.length, 0,
    'AC-CCR-12-1: PATH_RE must be immediately preceded by an explanatory // comment block',
  );
  const block = commentLines.join('\n');

  assert.match(
    block,
    /@`?-scoped/,
    'AC-CCR-12-1: the comment block must name `@`-scoped paths literally',
  );
  assert.match(
    block,
    /deliberately|intentional/i,
    'AC-CCR-12-1: the comment must state the exclusion is deliberate, not an oversight',
  );
  assert.match(
    block,
    /exclude/i,
    'AC-CCR-12-1: the comment must state @-scoped paths are excluded',
  );
  assert.match(
    block,
    /not in-repo/i,
    'AC-CCR-12-1: the comment must explain @-scoped paths are not in-repo refs',
  );
});

/**
 * R-RHFP (Finding #64 BUG #3) — telemetry-event name literals introduced by a
 * ticket (`appraisal.reducto.split_source_mix`) are NOT in-repo symbol
 * contracts; they must not be extracted as contract references.
 */
test('R-RHFP (BUG #3): a 3+ segment all-lowercase event literal is not extracted', () => {
  const content = [
    'The processor emits a new `appraisal.reducto.split_source_mix` event.',
    'It also emits `appraisal.reducto.subschema_cancel_failed` on failure.',
  ].join('\n');
  const refs = extractContractReferences(content);
  assert.ok(
    !refs.includes('appraisal.reducto.split_source_mix'),
    `event-name literal must be skipped; got ${JSON.stringify(refs)}`,
  );
  assert.ok(
    !refs.includes('appraisal.reducto.subschema_cancel_failed'),
    `event-name literal must be skipped; got ${JSON.stringify(refs)}`,
  );
});

test('R-RHFP (BUG #3): a PascalCase Type.member contract is still extracted', () => {
  // The event-literal filter must not over-reach: a genuine `Type.member`
  // symbol contract keeps a leading uppercase segment and must pass through.
  const refs = extractContractReferences('Call `JobGetResponse.result` on the SDK type.');
  assert.ok(
    refs.includes('JobGetResponse.result'),
    `PascalCase symbol contract must still be extracted; got ${JSON.stringify(refs)}`,
  );
});

test('R-RHFP (BUG #3): a 2-segment lowercase ref is still extracted (filter requires 3+)', () => {
  const refs = extractContractReferences('Invoke `job.cancel` to abort.');
  assert.ok(
    refs.includes('job.cancel'),
    `2-segment ref must still pass extraction; got ${JSON.stringify(refs)}`,
  );
});

/**
 * R-RHFP (Finding #64 BUG #1) — `kind:'performance'` findings (contract
 * resolution wall budget exceeded) are advisory: surfaced in the JSON output
 * but excluded from the blocking set, so the gate does not fail just because
 * the checker ran out of time on a large/slow target repo.
 */
test('R-RHFP (BUG #1): a performance wall-budget finding does not fail the gate', () => {
  const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rhfp-')));
  try {
    const ticketDir = path.join(sessionDir, 'wb0001');
    fs.mkdirSync(ticketDir, { recursive: true });
    // Every contract ref is a real exported symbol of check-readiness.ts, so
    // none can ever produce a blocking `contract` finding. With --max-wall-ms 1
    // the shared resolver budget is exhausted after the first ref or two, so
    // the remaining refs emit `kind:'performance'` instead — the only findings.
    const symbols = [
      'extractContractReferences()', 'extractAcceptanceCriteria()', 'isMachineCheckable()',
      'parseArgs()', 'runHistory()', 'findReadinessFindings()', 'loadReadinessAllowlist()',
      'runReadiness()', 'resolveSymbolRef()',
      'gitTrackedFiles()', 'createResolverCache()',
    ];
    fs.writeFileSync(path.join(ticketDir, 'rick_ticket_wb0001.md'), [
      '---', 'id: wb0001', 'key: WB-1', 'ac_ids: []', '---', '',
      '# Ticket', '', '## Acceptance Criteria', '- [ ] `node --test` passes.', '',
      '## Interface Contracts', '',
      ...symbols.map((sym) => `- \`${sym}\` must exist.`), '',
    ].join('\n'));
    fs.writeFileSync(
      path.join(sessionDir, 'decomposition_manifest.json'),
      JSON.stringify({ tickets: [{ id: 'wb0001', key: 'WB-1' }] }, null, 2),
    );

    const result = spawnSync(process.execPath, [
      RHFP_BIN,
      '--session-dir', sessionDir,
      '--repo-root', process.cwd(),
      '--max-wall-ms', '1',
    ], { encoding: 'utf-8', timeout: 60000 });

    assert.equal(result.status, 0, `gate must pass on a perf-only finding; stderr: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    assert.ok(
      out.findings.some((finding) => finding.kind === 'performance'),
      `the performance finding must still be surfaced; got ${JSON.stringify(out.findings)}`,
    );
    assert.ok(
      !out.findings.some((finding) => finding.kind !== 'performance'),
      `no blocking finding expected; got ${JSON.stringify(out.findings)}`,
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
