// @tier: fast
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
// f2b426dc^ -- the commit immediately before c27b2673 widened hasTestCase() to accept the repo's
// 'ANCHOR: description' test-naming convention (see ticket 2203fe28).
const PRE_WIDENING_SHA = '071c9e60e8c676f5f5613d8074ba7580beeb15f4';

async function importAnalyzer() {
  const { runT6TrapDoorCoverage, ENFORCE_REF_RE, auditTrapDoorCoverage } = await import(
    '../../services/citadel/trap-door-coverage-audit.js'
  );
  return { runT6TrapDoorCoverage, ENFORCE_REF_RE, auditTrapDoorCoverage };
}

function mkFixture(projectRoot, opts = {}) {
  const extDir = path.join(projectRoot, 'extension');
  const testsDir = path.join(extDir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });

  const claudeMdPath = path.join(extDir, 'CLAUDE.md');
  const content = opts.claudeMdContent ?? '## Trap Doors\n\n' + (opts.enforceLines ?? '') + '\n';
  fs.writeFileSync(claudeMdPath, content, 'utf-8');

  for (const [rel, body] of Object.entries(opts.testFiles ?? {})) {
    const full = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }

  return { extDir, testsDir, claudeMdPath };
}

describe('runT6TrapDoorCoverage', () => {
  let tmpRoot;
  before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdca-')); });
  after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  test('orphan_enforce: ENFORCE points to missing file → HIGH finding', async () => {
    const projectRoot = path.join(tmpRoot, 'orphan-enforce');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/nonexistent.test.js\n',
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 1);
    assert.match(high[0].id, /orphan-enforce/);
    assert.match(high[0].message, /nonexistent\.test\.js/);
  });

  test('orphan_test_case: file exists but anchor missing → HIGH finding', async () => {
    const projectRoot = path.join(tmpRoot, 'orphan-test-case');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/real.test.js#missing-anchor\n',
      testFiles: {
        'extension/tests/real.test.js': "test('other-test', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 1);
    assert.match(high[0].id, /orphan-test-case/);
    assert.match(high[0].message, /missing-anchor/);
  });

  test('orphan_test_file: test file has no inbound ENFORCE ref → MEDIUM finding', async () => {
    const projectRoot = path.join(tmpRoot, 'orphan-test-file');
    mkFixture(projectRoot, {
      enforceLines: '',
      testFiles: {
        'extension/tests/unreferenced.test.js': "test('x', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const medium = result.findings.filter((f) => f.severity === 'Medium');
    const orphan = medium.find((f) => f.id.includes('unreferenced.test.js'));
    assert.ok(orphan, 'expected orphan-test-file finding for unreferenced.test.js');
    assert.match(orphan.id, /orphan-test-file/);
  });

  test('bare-path legacy: no #anchor → exactly 1 LOW finding per CLAUDE.md', async () => {
    const projectRoot = path.join(tmpRoot, 'bare-path');
    mkFixture(projectRoot, {
      enforceLines: [
        '- ENFORCE: extension/tests/a.test.js',
        '- ENFORCE: extension/tests/b.test.js',
        '- ENFORCE: extension/tests/c.test.js#anchor-exists',
      ].join('\n') + '\n',
      testFiles: {
        'extension/tests/a.test.js': "test('a', () => {});\n",
        'extension/tests/b.test.js': "test('b', () => {});\n",
        'extension/tests/c.test.js': "test('anchor-exists', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const low = result.findings.filter((f) => f.severity === 'Low');
    assert.equal(low.length, 1, 'exactly one LOW finding per CLAUDE.md');
    assert.match(low[0].id, /trap-door-bare-path/);
  });

  test('anchored ref with matching test case → no HIGH finding', async () => {
    const projectRoot = path.join(tmpRoot, 'anchor-found');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/suite.test.js#my-invariant\n',
      testFiles: {
        'extension/tests/suite.test.js': "test('my-invariant', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 0, 'no HIGH findings when anchor exists');
  });

  test('AP-EXT-C27B2673-01: anchor satisfied by repo convention "ANCHOR: description" title', async () => {
    const projectRoot = path.join(tmpRoot, 'convention-title');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/conv.test.js#AP-RMS-9\n',
      testFiles: {
        'extension/tests/conv.test.js':
          "test('AP-RMS-9: EVERY synchronous subprocess spawn carries a finite timeout', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 0, 'convention-titled test must satisfy the anchor');
  });

  test('AP-EXT-C27B2673-02: exact-title anchor (no description) still satisfies', async () => {
    const projectRoot = path.join(tmpRoot, 'exact-title');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/exact.test.js#AP-RMS-9\n',
      testFiles: {
        'extension/tests/exact.test.js': "test('AP-RMS-9', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 0, 'exact-title anchor must still satisfy');
  });

  test('AP-EXT-C27B2673-03: prefix safety — short anchor does not match a longer sharing-prefix title', async () => {
    const projectRoot = path.join(tmpRoot, 'prefix-short-anchor');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/prefix1.test.js#4-01\n',
      testFiles: {
        'extension/tests/prefix1.test.js': "test('4-011: unrelated longer id', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 1, 'anchor 4-01 must NOT match a title starting with 4-011');
    assert.match(high[0].id, /orphan-test-case/);
  });

  test('AP-EXT-C27B2673-04: prefix safety — longer anchor does not match a shorter sharing-prefix title', async () => {
    const projectRoot = path.join(tmpRoot, 'prefix-long-anchor');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/prefix2.test.js#4-011\n',
      testFiles: {
        'extension/tests/prefix2.test.js': "test('4-01: unrelated shorter id', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 1, 'anchor 4-011 must NOT match a title starting with 4-01');
    assert.match(high[0].id, /orphan-test-case/);
  });

  test('AP-EXT-C27B2673-05: generic-anchor control — a short generic anchor does not match broadly', async () => {
    const projectRoot = path.join(tmpRoot, 'generic-anchor');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/generic.test.js#X\n',
      testFiles: {
        'extension/tests/generic.test.js': [
          "test('Xavier config loads', () => {});",
          "test('XML parsing works', () => {});",
          "test('Xylophone sounds', () => {});",
          '',
        ].join('\n'),
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(
      high.length,
      1,
      'generic anchor X must not be satisfied by titles that merely start with the letter X',
    );
    assert.match(high[0].id, /orphan-test-case/);
  });

  // A literal-title-PREFIX matcher could resolve only a title's first word, so catalogs "fixed" its
  // orphan findings by degrading precise whole-title slugs to `#a` / `#install`, which resolve many
  // tests — a deleted guard then reads green. Citadel must resolve the precise slug, and must refuse
  // it once the named test is gone even while its first-word siblings remain.
  test('AP-EXT-ITER267-01: a whole-title slug anchor resolves in citadel exactly as in the shell audit', async () => {
    const anchor = 'a-microverse-phase-with-no-usable-exit-reason-continues-the-second-fail-open-arm';
    const named = "test('a microverse phase with no usable exit_reason continues — the second fail-open arm', () => {});\n";
    const siblings = "test('a failed AC gate continues the phase loop', () => {});\ntest('a passing AC gate is inert', () => {});\n";
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const orphansFor = (name, body) => {
      const projectRoot = path.join(tmpRoot, name);
      mkFixture(projectRoot, {
        enforceLines: `- ENFORCE: extension/tests/slug.test.js#${anchor}\n`,
        testFiles: { 'extension/tests/slug.test.js': body },
      });
      return runT6TrapDoorCoverage({ projectRoot }).findings.filter((f) => f.id.startsWith('orphan-test-case:'));
    };
    assert.deepEqual(orphansFor('slug-present', named + siblings), [], 'the whole-title slug must resolve its test');
    assert.equal(orphansFor('slug-deleted', siblings).length, 1, 'deleting the named test must report the anchor');
  });

  test('mixed bare and anchored refs in one CLAUDE.md → exactly 1 LOW warning', async () => {
    const projectRoot = path.join(tmpRoot, 'mixed-refs');
    mkFixture(projectRoot, {
      enforceLines: [
        '- ENFORCE: extension/tests/bare1.test.js',
        '- ENFORCE: extension/tests/anchored.test.js#anchor-name',
        '- ENFORCE: extension/tests/bare2.test.js',
      ].join('\n') + '\n',
      testFiles: {
        'extension/tests/bare1.test.js': "test('x', () => {});\n",
        'extension/tests/anchored.test.js': "test('anchor-name', () => {});\n",
        'extension/tests/bare2.test.js': "test('y', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const low = result.findings.filter((f) => f.severity === 'Low');
    assert.equal(low.length, 1, 'one LOW warning per CLAUDE.md regardless of bare-path ref count');
  });

  test('subsystem CLAUDE bare ENFORCE refs resolve to extension/tests and do not emit false orphan findings', async () => {
    const projectRoot = path.join(tmpRoot, 'subsystem-bare-ref');
    mkFixture(projectRoot, {
      testFiles: {
        'extension/tests/backend-spawn.test.js': "test('cli-override', () => {});\n",
      },
    });
    const subsystemClaudePath = path.join(projectRoot, 'extension', 'src', 'services', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(subsystemClaudePath), { recursive: true });
    fs.writeFileSync(
      subsystemClaudePath,
      [
        '## Trap Doors',
        '',
        '- `backend-spawn.ts` — INVARIANT: cli override wins. BREAKS: stale backend. ENFORCE: `backend-spawn.test.js#cli-override`.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const highIds = result.findings.filter((f) => f.severity === 'High').map((f) => f.id);
    const mediumIds = result.findings.filter((f) => f.severity === 'Medium').map((f) => f.id);
    assert.deepEqual(highIds, []);
    assert.deepEqual(mediumIds, []);
  });

  // Ticket 9748856d (AC-V3): audit-trap-door-enforcement.sh scans the WHOLE catalog file for
  // ENFORCE: lines with no section restriction, and trap-door bullets in this repo routinely land
  // after an intervening heading (e.g. `## Module Export Catalog`), not just inside `## Trap
  // Doors`. Citadel must scan the same corpus the shell audit does, so a ref outside the Trap
  // Doors heading is audited exactly like one inside it — never silently dropped.
  test('ENFORCE refs outside the ## Trap Doors heading are still audited (matches the shell contract)', async () => {
    const projectRoot = path.join(tmpRoot, 'outside-section');
    const claudeMd = [
      '## Trap Doors',
      '',
      '## Other Section',
      '',
      '- ENFORCE: extension/tests/outside-missing.test.js',
      '',
    ].join('\n');
    mkFixture(projectRoot, { claudeMdContent: claudeMd });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 1, 'a ref outside the Trap Doors heading must still produce orphan-enforce');
    assert.match(high[0].id, /orphan-enforce/);
    assert.match(high[0].message, /outside-missing\.test\.js/);
  });

  // AC-V3-2 / AC-V3-3 (ticket 9748856d): reproduces the ticket's own probe shape -- a subsystem
  // CLAUDE.md whose ENFORCE bullet sits AFTER an intervening heading, exactly as extension/CLAUDE.md
  // and extension/src/services/CLAUDE.md are shaped in production (## Trap Doors, then
  // ## Module Export Catalog / ## Build & Test, then MORE trap-door bullets). Never the rejected
  // synthetic-throwaway-root shape named in the ticket as inadmissible.
  describe('AC-V3-2/AC-V3-3: absent anchor after an intervening heading, plus a clean-tree control', () => {
    function subsystemFixture(root, { withAbsentAnchor }) {
      const testsDir = path.join(root, 'extension', 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(
        path.join(testsDir, 'stop-hook.test.js'),
        "test('an unrelated real test case', () => {});\n",
        'utf-8',
      );

      const subsystemDir = path.join(root, 'extension', 'src', 'services');
      fs.mkdirSync(subsystemDir, { recursive: true });
      const probeLine = withAbsentAnchor
        ? '- `pickle-utils.ts` (PROBE) — INVARIANT: probe. BREAKS: probe. ' +
          'ENFORCE: tests/stop-hook.test.js#zzz-nonexistent-anchor-probe. PATTERN_SHAPE: probe.'
        : '';
      fs.writeFileSync(
        path.join(subsystemDir, 'CLAUDE.md'),
        [
          '## Trap Doors',
          '',
          '- `pickle-utils.ts` — INVARIANT: real. BREAKS: real. ' +
            'ENFORCE: tests/stop-hook.test.js#an-unrelated-real-test-case.',
          '',
          '## Module Export Catalog',
          '',
          '- `pickle-utils.ts` -> `something`',
          '',
          probeLine,
          '',
        ].join('\n'),
        'utf-8',
      );
    }

    test('AC-V3-2: one absent anchor injected after an intervening heading is reported (>= 1 anchor finding)', async () => {
      const projectRoot = path.join(tmpRoot, 'ac-v3-2-injected');
      subsystemFixture(projectRoot, { withAbsentAnchor: true });
      const { runT6TrapDoorCoverage } = await importAnalyzer();
      const result = runT6TrapDoorCoverage({ projectRoot });
      const anchorFindings = result.findings.filter((f) => f.id.startsWith('orphan-test-case:'));
      assert.ok(
        anchorFindings.length >= 1,
        `expected >= 1 orphan-test-case finding for the injected probe; got ${anchorFindings.length}`,
      );
      assert.ok(
        anchorFindings.some((f) => f.message.includes('zzz-nonexistent-anchor-probe')),
        'expected the injected anchor to be named in a finding',
      );
    });

    test('AC-V3-3: the same tree with the probe removed (clean) reports zero anchor findings', async () => {
      const projectRoot = path.join(tmpRoot, 'ac-v3-3-clean');
      subsystemFixture(projectRoot, { withAbsentAnchor: false });
      const { runT6TrapDoorCoverage } = await importAnalyzer();
      const result = runT6TrapDoorCoverage({ projectRoot });
      const anchorFindings = result.findings.filter(
        (f) => f.id.startsWith('orphan-test-case:') || f.id.startsWith('orphan-enforce:'),
      );
      assert.deepEqual(anchorFindings, [], 'a clean tree must report zero anchor findings');
    });

    // Completes AC-V3-2's "shell non-zero AND citadel >= 1" pairing. audit-trap-door-enforcement.sh
    // supports CLAUDE_PATH_OVERRIDE precisely so a probe catalog can be exercised without touching
    // the live tree; the referenced test file resolves against the REAL extensionRoot (unaffected
    // by the override), so no synthetic test file is needed either -- this is the ticket's own
    // probe, run for real, end to end.
    test('AC-V3-2 shell side: the shell audit exits non-zero over the same injected absent anchor', () => {
      const tmpCatalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdca-shell-probe-'));
      const catalogPath = path.join(tmpCatalogDir, 'CLAUDE.md');
      try {
        fs.writeFileSync(
          catalogPath,
          [
            '## Trap Doors',
            '',
            '- `pickle-utils.ts` (PROBE) — INVARIANT: probe. BREAKS: probe. ' +
              'ENFORCE: tests/stop-hook.test.js#zzz-nonexistent-anchor-probe. PATTERN_SHAPE: probe.',
            '',
          ].join('\n'),
          'utf-8',
        );
        const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
          cwd: path.join(REPO_ROOT, 'extension'),
          encoding: 'utf-8',
          timeout: 60_000,
          env: { ...process.env, CLAUDE_PATH_OVERRIDE: catalogPath },
        });
        assert.notEqual(result.status, 0, 'shell audit must exit non-zero over the injected absent anchor');
        assert.match(result.stderr, /zzz-nonexistent-anchor-probe/);
      } finally {
        fs.rmSync(tmpCatalogDir, { recursive: true, force: true });
      }
    });
  });

  // WIRE (ticket 5987c2f8): the citadel detector (9748856d, matcher fixed by c27b2673/2203fe28)
  // and the shell audit run over the SAME probe catalog content in the SAME two tests, so a
  // future divergence between the two instruments shows up as one test failing rather than as
  // two suites that merely happen to agree today.
  describe('WIRE: citadel and the shell audit agree on the SAME probe catalog', () => {
    const PROBE_ANCHOR = 'zzz-nonexistent-anchor-probe-5987c2f8';

    function probeCatalogBody() {
      const probeLine = `- \`pickle-utils.ts\` (PROBE) — INVARIANT: probe. BREAKS: probe. ENFORCE: tests/stop-hook.test.js#${PROBE_ANCHOR}. PATTERN_SHAPE: probe.`;
      return ['## Trap Doors', '', probeLine, ''].join('\n');
    }

    function runShellAuditOverCatalog(catalogPath) {
      return spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
        cwd: path.join(REPO_ROOT, 'extension'),
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, CLAUDE_PATH_OVERRIDE: catalogPath },
      });
    }

    // Citadel resolves ENFORCE refs against `projectRoot`, so it needs its own copy of the
    // real anchor-bearing file the shell resolves against the real extensionRoot -- the SAME
    // (file, anchor) pair judged through two different roots, not two different probes.
    async function runCitadelOverCatalog(catalogBody) {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdca-agreement-'));
      try {
        const extDir = path.join(projectRoot, 'extension');
        fs.mkdirSync(path.join(extDir, 'tests'), { recursive: true });
        fs.copyFileSync(
          path.join(REPO_ROOT, 'extension', 'tests', 'stop-hook.test.js'),
          path.join(extDir, 'tests', 'stop-hook.test.js'),
        );
        fs.writeFileSync(path.join(extDir, 'CLAUDE.md'), catalogBody, 'utf-8');
        const { runT6TrapDoorCoverage } = await importAnalyzer();
        return runT6TrapDoorCoverage({ projectRoot });
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    }

    test('an injected absent anchor is reported by BOTH detectors', async () => {
      const tmpCatalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdca-agreement-catalog-'));
      try {
        const catalogBody = probeCatalogBody();
        const catalogPath = path.join(tmpCatalogDir, 'CLAUDE.md');
        fs.writeFileSync(catalogPath, catalogBody, 'utf-8');

        const shell = runShellAuditOverCatalog(catalogPath);
        assert.notEqual(shell.status, 0, 'shell audit must exit non-zero over the injected absent anchor');
        assert.match(shell.stderr, new RegExp(PROBE_ANCHOR));

        const citadel = await runCitadelOverCatalog(catalogBody);
        const anchorFindings = citadel.findings.filter((f) => f.id.startsWith('orphan-test-case:'));
        assert.ok(
          anchorFindings.length >= 1,
          `citadel must also report the injected absent anchor; got ${anchorFindings.length} orphan-test-case findings`,
        );
        assert.ok(
          anchorFindings.some((f) => f.message.includes(PROBE_ANCHOR)),
          'the injected anchor must be named in a citadel finding',
        );
      } finally {
        fs.rmSync(tmpCatalogDir, { recursive: true, force: true });
      }
    });

    // A clean tree can only be judged over the REAL catalog: CLAUDE_PATH_OVERRIDE fully
    // replaces the primary catalog for the shell audit's own cross-reference checks (e.g. named
    // trap-door entries it expects to find), so a minimal probe-only catalog reads as "clean"
    // for the ENFORCE-ref check and simultaneously "broken" for unrelated checks the override
    // strips out. Mirrors the existing real-corpus checks
    // ('runT6TrapDoorCoverage — integration: real extension/CLAUDE.md' + 'the shell audit still
    // exits 0 over the same tree') but asserts BOTH in one place.
    test('the real, unmodified extension/CLAUDE.md is reported clean by BOTH detectors', async () => {
      const shell = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
        cwd: path.join(REPO_ROOT, 'extension'),
        encoding: 'utf-8',
        timeout: 60_000,
      });
      assert.equal(
        shell.status,
        0,
        `shell audit must exit 0 over the real, unmodified tree; stderr:\n${shell.stderr}`,
      );

      const { runT6TrapDoorCoverage } = await importAnalyzer();
      const citadel = runT6TrapDoorCoverage({ projectRoot: REPO_ROOT });
      const anchorFindings = citadel.findings.filter(
        (f) => f.severity === 'High' && f.file === 'extension/CLAUDE.md',
      );
      assert.deepEqual(
        anchorFindings,
        [],
        `citadel must also report zero HIGH findings from extension/CLAUDE.md; got:\n${anchorFindings.map((f) => `  ${f.id}: ${f.message}`).join('\n')}`,
      );
    });
  });

  test('diff-scoped audit only emits orphan-test-file for changed tests but still honors unchanged ENFORCE refs', async () => {
    const projectRoot = path.join(tmpRoot, 'diff-scoped-orphans');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/referenced.test.js#kept-anchor\n',
      testFiles: {
        'extension/tests/referenced.test.js': "test('kept-anchor', () => {});\n",
        'extension/tests/unreferenced-changed.test.js': "test('changed', () => {});\n",
        'extension/tests/unreferenced-unchanged.test.js': "test('unchanged', () => {});\n",
      },
    });
    const { auditTrapDoorCoverage } = await importAnalyzer();
    const result = auditTrapDoorCoverage({
      range: 'base..head',
      base: 'base',
      head: 'head',
      repoRoot: projectRoot,
      claudeFiles: [],
      changedFiles: [
        {
          path: 'extension/tests/referenced.test.js',
          status: 'M',
          kind: 'test',
          changedLines: [],
          blame: [],
        },
        {
          path: 'extension/tests/unreferenced-changed.test.js',
          status: 'A',
          kind: 'test',
          changedLines: [],
          blame: [],
        },
      ],
    });

    const orphanIds = result.findings
      .filter((f) => f.id.startsWith('orphan-test-file:'))
      .map((f) => f.id)
      .sort();
    assert.deepEqual(orphanIds, [
      'orphan-test-file:extension/tests/unreferenced-changed.test.js',
    ]);
  });

  test('diff-scoped audit still emits orphan-test-case when a changed test breaks an unchanged ENFORCE anchor', async () => {
    const projectRoot = path.join(tmpRoot, 'diff-scoped-anchor-break');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/referenced.test.js#kept-anchor\n',
      testFiles: {
        'extension/tests/referenced.test.js': "test('different-anchor', () => {});\n",
      },
    });
    const { auditTrapDoorCoverage } = await importAnalyzer();
    const result = auditTrapDoorCoverage({
      range: 'base..head',
      base: 'base',
      head: 'head',
      repoRoot: projectRoot,
      claudeFiles: [],
      changedFiles: [
        {
          path: 'extension/tests/referenced.test.js',
          status: 'M',
          kind: 'test',
          changedLines: [],
          blame: [],
        },
      ],
    });

    const highIds = result.findings
      .filter((f) => f.severity === 'High')
      .map((f) => f.id);
    assert.deepEqual(highIds, [
      'orphan-test-case:extension/tests/referenced.test.js#kept-anchor',
    ]);
  });

  test('subsystem CLAUDE.md absence handled gracefully (no throw)', async () => {
    const projectRoot = path.join(tmpRoot, 'no-subsystem');
    mkFixture(projectRoot, { enforceLines: '' });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    assert.doesNotThrow(() => runT6TrapDoorCoverage({ projectRoot }));
  });

  test('ENFORCE_REF_RE exported and matches comma-separated refs', async () => {
    const { ENFORCE_REF_RE } = await importAnalyzer();
    const line = 'ENFORCE: extension/tests/foo.test.js, extension/tests/bar.test.js.';
    const matches = [...line.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))];
    assert.equal(matches.length, 1);
    const captured = matches[0][1];
    assert.match(captured, /foo\.test\.js/);
    assert.match(captured, /bar\.test\.js/);
  });

  test('ENFORCE_REF_RE matches backtick-wrapped paths', async () => {
    const { ENFORCE_REF_RE } = await importAnalyzer();
    const line = 'ENFORCE: `extension/tests/baz.test.js`';
    const matches = [...line.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))];
    assert.equal(matches.length, 1);
    assert.match(matches[0][1], /baz\.test\.js/);
  });

  test('ENFORCE_REF_RE matches .sh scripts', async () => {
    const { ENFORCE_REF_RE } = await importAnalyzer();
    const line = 'ENFORCE: extension/scripts/audit-check.sh';
    const matches = [...line.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))];
    assert.equal(matches.length, 1);
    assert.match(matches[0][1], /audit-check\.sh/);
  });
});

describe('runT6TrapDoorCoverage — integration: real extension/CLAUDE.md', () => {
  // The acceptance criterion checks extension/CLAUDE.md specifically.
  // Subsystem CLAUDE.md files (extension/src/**/CLAUDE.md) may have pre-existing orphan refs
  // that are filed as separate tickets (NOT in scope per ticket 7a276c38).
  test('0 high-severity findings from extension/CLAUDE.md against HEAD', async () => {
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot: REPO_ROOT });
    const high = result.findings.filter(
      (f) => f.severity === 'High' && f.file === 'extension/CLAUDE.md',
    );
    assert.deepStrictEqual(
      high,
      [],
      `Expected 0 HIGH findings from extension/CLAUDE.md; got:\n${high.map((f) => `  ${f.id}: ${f.message}`).join('\n')}`,
    );
  });
});

// --- ticket 2203fe28: prove the c27b2673 widening repaired the matcher rather than disabling it.
//
// Everything below is re-derived from the live tree and from git history at test-run time -- no
// stored fixture. The OLD (pre-widening) hasTestCase() no longer exists in source, so its body is
// extracted from the compiled mirror at the commit immediately before the fix landed, via git show,
// and evaluated as real code -- never hand-duplicated, which would risk silently drifting from what
// the fix commit actually changed.

function walkForClaudeMdFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkForClaudeMdFiles(full));
    else if (entry.name === 'CLAUDE.md') results.push(full);
  }
  return results;
}

// Mirrors collectClaudeMdFiles() in trap-door-coverage-audit.ts: extension/CLAUDE.md plus every
// extension/src/**/CLAUDE.md -- the same corpus runT6TrapDoorCoverage walks in production.
function collectClaudeMdFilesForTest(repoRoot) {
  const files = [];
  const primary = path.join(repoRoot, 'extension', 'CLAUDE.md');
  if (fs.existsSync(primary)) files.push(primary);
  const srcDir = path.join(repoRoot, 'extension', 'src');
  if (fs.existsSync(srcDir)) files.push(...walkForClaudeMdFiles(srcDir));
  return files;
}

function normalizeRelativePathForTest(filePath) {
  return filePath.split(path.sep).join('/');
}

// Mirrors resolveEnforceRef() in trap-door-coverage-audit.ts.
function resolveEnforceRefForTest(repoRoot, filePath) {
  const normalized = normalizeRelativePathForTest(filePath);
  const canonicalPath = normalized.startsWith('extension/')
    ? normalized
    : normalized.startsWith('tests/')
      ? `extension/${normalized}`
      : `extension/tests/${normalized}`;
  return { canonicalPath, absPath: path.resolve(repoRoot, canonicalPath) };
}

// Mirrors parseEnforceRefs() in trap-door-coverage-audit.ts.
function parseEnforceRefsForTest(raw) {
  return raw.split(/,\s*/).flatMap((part) => {
    const cleaned = part.trim().replace(/^`|`$/g, '');
    if (!cleaned) return [];
    const hashIdx = cleaned.indexOf('#');
    if (hashIdx === -1) return [];
    return [{ filePath: cleaned.slice(0, hashIdx), anchor: cleaned.slice(hashIdx + 1) }];
  });
}

// Every anchored ENFORCE ref, across the real catalog corpus, whose target file exists on disk --
// the exact population runT6TrapDoorCoverage evaluates for orphan-test-case findings. Ticket
// 9748856d: production scans the WHOLE catalog file (no ## Trap Doors section restriction), so
// this independent re-derivation must scan the same corpus or it silently under-counts against
// production once a catalog carries ENFORCE refs after an intervening heading.
async function enumerateAnchoredEnforceRefs(repoRoot) {
  const { ENFORCE_REF_RE } = await importAnalyzer();

  const pairs = [];
  for (const claudeFile of collectClaudeMdFilesForTest(repoRoot)) {
    const content = fs.readFileSync(claudeFile, 'utf-8');
    for (const match of content.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))) {
      for (const ref of parseEnforceRefsForTest(match[1])) {
        const { canonicalPath, absPath } = resolveEnforceRefForTest(repoRoot, ref.filePath);
        if (!fs.existsSync(absPath)) continue;
        pairs.push({ canonicalPath, absPath, anchor: ref.anchor });
      }
    }
  }

  const seen = new Set();
  return pairs.filter((p) => {
    const key = `${p.canonicalPath}#${p.anchor}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractHasTestCaseSource(jsModuleText) {
  const match = jsModuleText.match(/function hasTestCase\(content, anchor\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('could not extract hasTestCase() from module source');
  return match[0];
}

function buildHasTestCase(fnSource) {
  // eslint-disable-next-line no-new-func -- evaluating real historical/current production source,
  // extracted verbatim by extractHasTestCaseSource(), not a hand-authored regex.
  return new Function('content', 'anchor', `${fnSource}\nreturn hasTestCase(content, anchor);`);
}

function readOldHasTestCase(repoRoot) {
  const oldModuleText = execFileSync(
    'git',
    ['show', `${PRE_WIDENING_SHA}:extension/services/citadel/trap-door-coverage-audit.js`],
    { cwd: repoRoot, encoding: 'utf-8', timeout: 10_000 },
  );
  return buildHasTestCase(extractHasTestCaseSource(oldModuleText));
}

function readCurrentHasTestCase(repoRoot) {
  const currentModuleText = fs.readFileSync(
    path.join(repoRoot, 'extension', 'services', 'citadel', 'trap-door-coverage-audit.js'),
    'utf-8',
  );
  return buildHasTestCase(extractHasTestCaseSource(currentModuleText));
}

// Computed ONCE (module scope) and shared by both describe blocks below, so the process spawns
// `git show` exactly once regardless of how many assertions replay over the result.
let replayCleared;
let replayRemaining;
let replayOldBrokenCount;
let replayPairs;
let replayReadCached;
let replayNewHasTestCase;

const pairKey = (p) => `${p.canonicalPath}#${p.anchor}`;

before(async () => {
  const pairs = await enumerateAnchoredEnforceRefs(REPO_ROOT);
  const oldHasTestCase = readOldHasTestCase(REPO_ROOT);
  const newHasTestCase = readCurrentHasTestCase(REPO_ROOT);

  const fileContentCache = new Map();
  const readCached = (absPath) => {
    if (!fileContentCache.has(absPath)) fileContentCache.set(absPath, fs.readFileSync(absPath, 'utf-8'));
    return fileContentCache.get(absPath);
  };
  replayPairs = pairs;
  replayReadCached = readCached;
  replayNewHasTestCase = newHasTestCase;

  const oldBroken = [];
  const newBroken = [];
  for (const p of pairs) {
    const content = readCached(p.absPath);
    if (!oldHasTestCase(content, p.anchor)) oldBroken.push(p);
    if (!newHasTestCase(content, p.anchor)) newBroken.push(p);
  }

  replayOldBrokenCount = oldBroken.length;
  const newBrokenKeys = new Set(newBroken.map((p) => `${p.canonicalPath}#${p.anchor}`));
  replayCleared = oldBroken.filter((p) => !newBrokenKeys.has(`${p.canonicalPath}#${p.anchor}`));
  replayRemaining = newBroken;
});

describe('runT6TrapDoorCoverage — full corpus replay against the widened anchor matcher (ticket 2203fe28)', () => {
  test('the widened matcher clears the large majority of previously-broken anchors', () => {
    const cleared = replayCleared;
    const remaining = replayRemaining;
    const oldBrokenCount = replayOldBrokenCount;
    // The failure message prints the live counts. Floor is set well below the value measured when
    // the widening landed so ordinary future trap-door additions don't make this flaky; it exists
    // to catch a REGRESSION of the widening (cleared collapsing back toward oldBrokenCount).
    assert.ok(
      cleared.length >= 80,
      `expected the widening to clear at least 80 previously-broken anchors, cleared only ${cleared.length} of ${oldBrokenCount}`,
    );
    assert.ok(
      cleared.length > remaining.length,
      `expected clearing to dominate: cleared=${cleared.length} remaining=${remaining.length}`,
    );
  });

  // Synthetic-fixture negative controls (bundle 481d0e0c, handoff from 7a024cbe). 7a024cbe correctly
  // drained the live CLAUDE.md corpus's genuinely-absent-anchor population to 0 (29 -> 0) -- exactly
  // the population these two controls used to derive "must remain" from, so deriving it from live
  // corpus text is now structurally vacuous, permanently, by design of the very fix these controls
  // exist to guard. Re-homed onto a synthetic CLAUDE.md + test file carrying one anchor whose
  // characters occur nowhere in the file, so the controls stay meaningful regardless of live corpus
  // state while still exercising the real, UNMODIFIED hasTestCase()/runT6TrapDoorCoverage() -- never
  // a re-implementation. Do not derive this from the live corpus again; see 7a024cbe / AC-D-1.
  const SYNTHETIC_ABSENT_ANCHOR = 'SYNTHETIC_ANCHOR_NEVER_PRESENT_IN_FIXTURE_TEXT';
  const SYNTHETIC_TEST_FILE_REL = 'extension/tests/synthetic-fixture-for-trap-door-audit.test.js';
  const SYNTHETIC_TEST_FILE_CONTENT =
    "import { test } from 'node:test';\ntest('an unrelated real test case', () => {});\n";

  test('the widened matcher still reports the genuinely-absent anchors -- it did not disable the check', () => {
    // The synthetic absent anchor catches over-widening (an accept-everything matcher returns true
    // for it). The ceiling catches under-widening (a reverted/weakened matcher would balloon
    // remaining back toward oldBrokenCount, ~145).
    assert.ok(
      !SYNTHETIC_TEST_FILE_CONTENT.includes(SYNTHETIC_ABSENT_ANCHOR),
      'fixture bug: the synthetic anchor must not occur in the synthetic test file\'s text',
    );
    assert.equal(
      replayNewHasTestCase(SYNTHETIC_TEST_FILE_CONTENT, SYNTHETIC_ABSENT_ANCHOR),
      false,
      'the widened matcher must not be vacuous: a known-absent synthetic anchor must still be reported absent',
    );
    const remaining = replayRemaining;
    assert.ok(
      remaining.length < 50,
      `expected remaining genuinely-broken anchors to stay well below the pre-fix scale (~145); got ${remaining.length}`,
    );
  });

  test('the re-derived remaining set matches production\'s own live orphan-test-case findings exactly', async () => {
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot: REPO_ROOT });
    const productionIds = result.findings
      .filter((f) => f.id.startsWith('orphan-test-case:'))
      .map((f) => f.id.replace(/^orphan-test-case:/, ''))
      .sort();
    const derivedIds = replayRemaining.map((p) => `${p.canonicalPath}#${p.anchor}`).sort();
    assert.deepEqual(
      derivedIds,
      productionIds,
      'the independently re-derived "still genuinely broken" set must equal what runT6TrapDoorCoverage actually reports',
    );
  });

  // d5b5add3 (AC-T2-2, second half): "genuinely absent" is defined as an anchor whose characters
  // occur nowhere in its file's text, independent of any matcher. Re-homed onto the same synthetic
  // fixture as the control above (see the bundle 481d0e0c comment there) rather than derived from the
  // live CLAUDE.md corpus, which 7a024cbe correctly drained to 0 members of exactly this population.
  test('AC-T2-2: every anchor absent from its file\'s text is still reported — a matcher clearing any of them reds', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdca-ac-t2-2-'));
    try {
      mkFixture(projectRoot, {
        enforceLines: `- ENFORCE: ${SYNTHETIC_TEST_FILE_REL}#${SYNTHETIC_ABSENT_ANCHOR}\n`,
        testFiles: { [SYNTHETIC_TEST_FILE_REL]: SYNTHETIC_TEST_FILE_CONTENT },
      });
      assert.ok(
        !SYNTHETIC_TEST_FILE_CONTENT.includes(SYNTHETIC_ABSENT_ANCHOR),
        'fixture bug: the synthetic anchor must not occur in the synthetic test file\'s text',
      );

      const { runT6TrapDoorCoverage } = await importAnalyzer();
      const reported = new Set(
        runT6TrapDoorCoverage({ projectRoot }).findings
          .filter((f) => f.id.startsWith('orphan-test-case:'))
          .map((f) => f.id.replace(/^orphan-test-case:/, '')),
      );
      assert.ok(
        reported.has(`${SYNTHETIC_TEST_FILE_REL}#${SYNTHETIC_ABSENT_ANCHOR}`),
        'runT6TrapDoorCoverage did not report the known-absent synthetic anchor',
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('runT6TrapDoorCoverage vs audit-trap-door-enforcement.sh — no silent contradiction (ticket 2203fe28)', () => {
  test('the shell audit still exits 0 over the same tree', () => {
    const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: path.join(REPO_ROOT, 'extension'),
      encoding: 'utf-8',
      timeout: 60_000,
    });
    assert.equal(
      result.status,
      0,
      `audit-trap-door-enforcement.sh must exit 0; got status=${result.status}\nstderr:\n${result.stderr}`,
    );
  });

  test('a citadel/shell divergence, if any, is reported rather than silently reconciled', async () => {
    // Extract the shell script's OWN slug/segment-boundary anchor rule from its live source text
    // -- the same anti-drift idiom used above for the retired hasTestCase() -- rather than
    // hand-duplicating it, so this can never silently diverge from what the shell script runs.
    const shellSource = fs.readFileSync(
      path.join(REPO_ROOT, 'extension', 'scripts', 'audit-trap-door-enforcement.sh'),
      'utf-8',
    );
    const slugifyMatch = shellSource.match(/const slugify = \([^)]*\) => [^;]+;/);
    const testNameReMatch = shellSource.match(/const TEST_NAME_RE = [^;]+;/);
    const matchCountMatch = shellSource.match(/function anchorMatchCount\(fileContent, anchor\) \{[\s\S]*?\n\}/);
    assert.ok(slugifyMatch && testNameReMatch && matchCountMatch, 'could not extract the shell script\'s anchor-resolution rule from its source');

    const shellAnchorResolves = new Function(
      'fileContent',
      'anchor',
      `${slugifyMatch[0]}\n${testNameReMatch[0]}\n${matchCountMatch[0]}\nreturn anchorMatchCount(fileContent, anchor) > 0;`,
    );

    // AP-EXT-ITER267-01: citadel and the shell apply ONE rule, so they must agree in BOTH directions.
    // A citadel-only rejection is not a harmless divergence: it is what pushed catalogs onto first-word
    // anchors that resolve many tests. Over the real corpus alone the shell resolves every pair, so each
    // pair is also probed with its anchor lengthened by one character (a derived non-anchor over the
    // same real content) — otherwise the rejecting direction would never be exercised.
    const probes = replayPairs.flatMap((p) => [p, { ...p, anchor: `${p.anchor}9` }]);
    let shellRejected = 0;
    const contradictions = [];
    for (const p of probes) {
      const content = replayReadCached(p.absPath);
      const shell = shellAnchorResolves(content, p.anchor);
      if (!shell) shellRejected++;
      if (replayNewHasTestCase(content, p.anchor) !== shell) contradictions.push(`${pairKey(p)} shell=${shell}`);
    }
    assert.ok(shellRejected > 0, 'the shell rule rejected no probe — the agreement check would be vacuous');
    assert.deepEqual(
      contradictions,
      [],
      'citadel and the authoritative shell audit disagree on the same anchor over the same content',
    );
  });
});

/**
 * ROOT V5 (ticket 32f7684e): findings routed into the microverse fix loop must name the LINE a
 * fixer edits — `extension/CLAUDE.md` alone is a multi-thousand-line catalog.
 *
 * Every assertion here resolves the reported line back to the fixture's OWN text rather than
 * comparing a hardcoded integer, so a test cannot pass because an off-by-one happens to coincide
 * with a literal someone updated to match.
 */
describe('ENFORCE-ref findings carry an actionable line (ROOT V5, ticket 32f7684e)', () => {
  let tmpRoot;
  before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdca-v5-')); });
  after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  /** Resolve a finding's 1-based `line` back to the catalog text it claims to point at. */
  function lineText(claudeMdPath, line) {
    assert.equal(typeof line, 'number', 'finding must carry a numeric line');
    const lines = fs.readFileSync(claudeMdPath, 'utf-8').split('\n');
    assert.ok(line >= 1 && line <= lines.length, `line ${line} is outside the catalog (${lines.length} lines)`);
    return lines[line - 1];
  }

  test('orphan-enforce points at the catalog line holding the ref', async () => {
    const projectRoot = path.join(tmpRoot, 'orphan-enforce-line');
    const { claudeMdPath } = mkFixture(projectRoot, {
      claudeMdContent: [
        '# Catalog',
        '',
        'Prose that must not be counted as a ref.',
        '',
        '## Trap Doors',
        '',
        '- ENFORCE: extension/tests/absent-one.test.js',
        '',
      ].join('\n'),
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const finding = runT6TrapDoorCoverage({ projectRoot }).findings
      .find((f) => f.id.startsWith('orphan-enforce:'));

    assert.ok(finding, 'expected an orphan-enforce finding');
    assert.match(lineText(claudeMdPath, finding.line), /absent-one\.test\.js/);
  });

  test('trap-door-bare-path points at the catalog line holding the bare ref', async () => {
    const projectRoot = path.join(tmpRoot, 'bare-path-line');
    const { claudeMdPath } = mkFixture(projectRoot, {
      claudeMdContent: [
        '# Catalog',
        '',
        '## Trap Doors',
        '',
        '- ENFORCE: extension/tests/present.test.js',
        '',
      ].join('\n'),
      testFiles: { 'extension/tests/present.test.js': "test('anything', () => {});\n" },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const finding = runT6TrapDoorCoverage({ projectRoot }).findings
      .find((f) => f.id.startsWith('trap-door-bare-path:'));

    assert.ok(finding, 'expected a trap-door-bare-path finding');
    assert.match(lineText(claudeMdPath, finding.line), /ENFORCE:.*present\.test\.js/);
  });

  // The NEGATIVE half. `orphan-test-case`'s `file` is the TEST file, while the ref line is a
  // position in the CLAUDE.md — attaching it would make `file:line` name a location that does not
  // contain the defect. This pins the deliberate omission so a later "helpful" change reds.
  test('orphan-test-case carries NO line — its file is the test file, not the catalog', async () => {
    const projectRoot = path.join(tmpRoot, 'orphan-test-case-noline');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/real.test.js#missing-anchor\n',
      testFiles: { 'extension/tests/real.test.js': "test('other-test', () => {});\n" },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const finding = runT6TrapDoorCoverage({ projectRoot }).findings
      .find((f) => f.id.startsWith('orphan-test-case:'));

    assert.ok(finding, 'expected an orphan-test-case finding');
    assert.equal(finding.file, 'extension/tests/real.test.js');
    assert.equal(finding.line, undefined, 'a catalog line must NOT be attached to a test-file finding');
  });

  // MUTATION KILLER for the running-cursor arithmetic: a cursor that never advances, or one that
  // rescans from 0, gives every ref the first ref's line. Built on `orphan-enforce` deliberately —
  // `trap-door-bare-path` is latched by `barePathWarned` and emitted ONCE per catalog, so a
  // second-ref assertion on it would be unreachable and would pass for the wrong reason.
  test('the SECOND and later refs get their own lines, not the first ref line', async () => {
    const projectRoot = path.join(tmpRoot, 'multi-ref-lines');
    const { claudeMdPath } = mkFixture(projectRoot, {
      claudeMdContent: [
        '# Catalog',
        '',
        '## Trap Doors',
        '',
        '- ENFORCE: extension/tests/absent-alpha.test.js',
        '',
        'Intervening prose, and a blank line above and below.',
        '',
        '- ENFORCE: extension/tests/absent-beta.test.js',
        '',
        '## Another Heading',
        '',
        '- ENFORCE: extension/tests/absent-gamma.test.js',
        '',
      ].join('\n'),
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const findings = runT6TrapDoorCoverage({ projectRoot }).findings
      .filter((f) => f.id.startsWith('orphan-enforce:'));

    assert.equal(findings.length, 3, 'all three absent refs must be reported');

    // Each finding must resolve to the catalog line naming ITS OWN file.
    for (const finding of findings) {
      const name = finding.id.split('/').pop();
      assert.match(lineText(claudeMdPath, finding.line), new RegExp(name.replace(/\./g, '\\.')));
    }

    // And the lines must be distinct and increasing — a frozen cursor collapses them to one value.
    const lines = findings.map((f) => f.line);
    assert.equal(new Set(lines).size, 3, `expected three distinct lines, got ${JSON.stringify(lines)}`);
  });
});
