// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildAcCoverageScorecard, extractKeywordAnchors } from '../services/citadel/ac-coverage-scorecard.js';

function writeFile(repoRoot, filePath, content) {
  const fullPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function changedFile(filePath, kind) {
  return {
    path: filePath,
    status: 'M',
    kind,
    changedLines: [],
    blame: [],
  };
}

function diffSummary(repoRoot, changedFiles) {
  return {
    range: 'main..HEAD',
    base: 'main',
    head: 'HEAD',
    repoRoot,
    changedFiles,
    claudeFiles: [],
  };
}

describe('buildAcCoverageScorecard', () => {
  test('matches implementation by keyword-anchor symbol and test by symbol reference', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-scorecard-'));
    try {
      writeFile(
        repoRoot,
        'src/comparison-retry.ts',
        [
          'export function buildComparisonRetryGuard() {',
          '  return true;',
          '}',
          '',
        ].join('\n'),
      );
      writeFile(
        repoRoot,
        'tests/comparison-retry.test.ts',
        [
          'import { buildComparisonRetryGuard } from "../src/comparison-retry";',
          '',
          'test("comparison retry guard", () => {',
          '  assert.equal(buildComparisonRetryGuard(), true);',
          '});',
          '',
        ].join('\n'),
      );

      const result = buildAcCoverageScorecard(
        [
          {
            id: 'AC-FF-01',
            line: 7,
            text: '- **AC-FF-01**: Comparison retry validates failed child extraction.',
          },
        ],
        diffSummary(repoRoot, [
          changedFile('src/comparison-retry.ts', 'production'),
          changedFile('tests/comparison-retry.test.ts', 'test'),
        ]),
      );

      assert.equal(result.summary.total, 1);
      assert.equal(result.summary.implemented, 1);
      assert.equal(result.summary.tested, 1);
      assert.deepEqual(result.findings, []);
      assert.equal(result.rows[0].implementationEvidence[0].match, 'comparison');
      assert.equal(result.rows[0].implementationEvidence[0].symbol, 'buildComparisonRetryGuard');
      assert.equal(result.rows[0].testEvidence[0].matchType, 'symbol');
      assert.match(result.markdownTable, /\| AC-FF-01 \| ✓ \| ✓ \| src\/comparison-retry\.ts:1 \+ tests\/comparison-retry\.test\.ts:1 \|/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('matches direct AC IDs and emits High finding when changed test evidence is missing', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-scorecard-'));
    try {
      writeFile(
        repoRoot,
        'src/audit-phase.ts',
        [
          '// AC-CIT-04: phase integration validates scorecard behavior',
          'export function runCitadelPhase() {',
          '  return "ok";',
          '}',
          '',
        ].join('\n'),
      );

      const result = buildAcCoverageScorecard(
        [
          {
            id: 'AC-CIT-04',
            line: 11,
            text: '- **AC-CIT-04**: pipeline phase integration validates scorecard behavior.',
          },
        ],
        diffSummary(repoRoot, [changedFile('src/audit-phase.ts', 'production')]),
      );

      assert.equal(result.rows[0].implemented, true);
      assert.equal(result.rows[0].tested, false);
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].severity, 'High');
      assert.equal(result.findings[0].acId, 'AC-CIT-04');
      assert.match(result.markdownTable, /\(no test found\)/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('emits Critical finding and no-enforcement table evidence when implementation is absent', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-scorecard-'));
    try {
      writeFile(repoRoot, 'tests/orphan.test.ts', 'test("unrelated", () => {});\n');

      const result = buildAcCoverageScorecard(
        [
          {
            id: 'AC-FF-05',
            line: 19,
            text: '- **AC-FF-05**: destructive role drift is rejected.',
          },
        ],
        diffSummary(repoRoot, [changedFile('tests/orphan.test.ts', 'test')]),
      );

      assert.equal(result.summary.missingImplementation, 1);
      assert.equal(result.summary.missingTests, 0);
      assert.equal(result.rows[0].implemented, false);
      assert.equal(result.rows[0].tested, false);
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].severity, 'Critical');
      assert.match(result.markdownTable, /\| AC-FF-05 \| ✗ \| ✗ \| \(no enforcement found\) \|/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('uses optional LLM entity mappings when keyword anchors miss implementation symbols', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-scorecard-'));
    try {
      writeFile(
        repoRoot,
        'src/routes.ts',
        [
          'export function enforceLoa618RetryChildExtraction() {',
          '  return true;',
          '}',
          '',
        ].join('\n'),
      );
      writeFile(
        repoRoot,
        'tests/routes.test.ts',
        [
          'import { enforceLoa618RetryChildExtraction } from "../src/routes";',
          '',
          'test("regression keeps LOA-618 route locked", () => {',
          '  assert.equal(enforceLoa618RetryChildExtraction(), true);',
          '});',
          '',
        ].join('\n'),
      );

      const acceptanceCriteria = [
        {
          id: 'AC-CIT-99',
          line: 21,
          text: '- **AC-CIT-99**: Coverage captures the semantic regression.',
        },
      ];
      const diff = diffSummary(repoRoot, [
        changedFile('src/routes.ts', 'production'),
        changedFile('tests/routes.test.ts', 'test'),
      ]);

      const keywordOnly = buildAcCoverageScorecard(acceptanceCriteria, diff);
      assert.equal(keywordOnly.rows[0].implemented, false);
      assert.equal(keywordOnly.findings[0].severity, 'Critical');

      const assisted = buildAcCoverageScorecard(acceptanceCriteria, diff, {
        llmEntityMappings: [
          {
            acId: 'AC-CIT-99',
            expectedSymbols: ['enforceLoa618RetryChildExtraction'],
          },
        ],
      });

      assert.equal(assisted.rows[0].implemented, true);
      assert.equal(assisted.rows[0].tested, true);
      assert.deepEqual(assisted.findings, []);
      assert.equal(assisted.rows[0].implementationEvidence[0].matchType, 'llm_entity');
      assert.equal(assisted.rows[0].implementationEvidence[0].match, 'enforceLoa618RetryChildExtraction');
      assert.equal(assisted.rows[0].testEvidence[0].matchType, 'symbol');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // AP-EXT-ITER286-01: reproduces the live shape from session 2026-09-16-383e1249, where AC-T2's
  // entire test axis rested on the letter `a`. `SYMBOL_PATTERN` keys on the English words
  // `type`/`class`/`const`, and `diff-walker` classifies markdown `production`, so PROSE yields a
  // declaration that does not exist; that token is then the identity for `line.includes(symbol)`
  // against every changed test file. The evidence itself must survive — only the identity goes.
  test('AP-EXT-ITER286-01: a prose-derived one-character symbol cannot carry the test axis', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-scorecard-'));
    try {
      writeFile(
        repoRoot,
        'docs/design-notes.md',
        ['# Notes', '', 'AC-XY-7 is about the type a reader must hold while it stays bounded.', ''].join('\n'),
      );
      // No AC id, no implementation symbol, none of the AC's keyword anchors — the ONLY thing
      // this line shares with the criterion is the letter `a`, inside `serial`.
      writeFile(repoRoot, 'tests/.serial-tests.json', ['{', '  "_comment": "serial sub-tier"', '}', ''].join('\n'));

      const result = buildAcCoverageScorecard(
        [{ id: 'AC-XY-7', line: 3, text: '- **AC-XY-7**: the type a reader must hold while it stays bounded.' }],
        diffSummary(repoRoot, [
          changedFile('docs/design-notes.md', 'production'),
          changedFile('tests/.serial-tests.json', 'test'),
        ]),
        { repoRoot },
      );

      const row = result.rows[0];
      assert.equal(row.implemented, true, 'the id match itself is untouched — only the symbol is dropped');
      assert.equal(row.implementationEvidence[0].matchType, 'ac_id');
      assert.equal(row.implementationEvidence[0].symbol, undefined, 'prose `type a` is not a declared symbol');
      assert.deepEqual(row.implementationSymbols, [], 'no identity is minted from prose');
      assert.equal(row.tested, false, 'the letter `a` matching `serial` is not test evidence');
      assert.deepEqual(row.testEvidence, []);
      assert.deepEqual(
        result.findings.map((finding) => finding.id),
        ['citadel-ac-coverage-AC-XY-7-test'],
        'the missing test axis is reported, not silently certified',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // AP-EXT-ITER286-01 over-trigger control: the floor is exactly 4 characters, so a real
  // four-character symbol (`head` and `line` both occur in the live corpus) must still mint an
  // identity and still carry the symbol axis.
  test('AP-EXT-ITER286-01 control: a four-character declared symbol still carries the test axis', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ac-scorecard-'));
    try {
      writeFile(repoRoot, 'src/head.ts', ['export const head = (rows) => rows[0];', ''].join('\n'));
      writeFile(
        repoRoot,
        'tests/head.test.ts',
        ['test("first row", () => {', '  assert.equal(head([1]), 1);', '});', ''].join('\n'),
      );

      const result = buildAcCoverageScorecard(
        [{ id: 'AC-XY-8', line: 4, text: '- **AC-XY-8**: the head helper returns the leading row.' }],
        diffSummary(repoRoot, [changedFile('src/head.ts', 'production'), changedFile('tests/head.test.ts', 'test')]),
        { repoRoot },
      );

      const row = result.rows[0];
      assert.deepEqual(row.implementationSymbols, ['head']);
      assert.equal(row.tested, true);
      assert.equal(row.testEvidence[0].matchType, 'symbol');
      assert.deepEqual(result.findings, []);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('extractKeywordAnchors', () => {
  test('drops IDs and filler words while preserving useful anchors', () => {
    assert.deepEqual(extractKeywordAnchors('AC-FF-01: Comparison retry validates failed child extraction tests'), [
      'child',
      'comparison',
      'extraction',
      'failed',
      'retry',
      'validates',
    ]);
  });
});
