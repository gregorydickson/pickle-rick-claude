// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnGateRemediatorMain } from '../../bin/spawn-gate-remediator.js';

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sgr-test-')));
}

function makeGateResult(overrides = {}) {
  return {
    status: 'red',
    failures: [
      { check: 'lint', file: 'src/foo.ts', line: 10, ruleOrCode: 'no-control-regex', message: 'use \\u form', severity: 'error', occurrence_index: 0 },
    ],
    baseline_used: false,
    allowed_paths_used: false,
    elapsed_ms: 500,
    total_raw_failure_count: 1,
    new_failures_vs_baseline: 1,
    ...overrides,
  };
}

function readLatestStateActivityEvent(sessionRoot, eventName) {
  const statePath = path.join(sessionRoot, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const activity = Array.isArray(state.activity) ? state.activity : [];
  return [...activity].reverse().find((entry) => entry?.event === eventName) ?? null;
}

describe('spawn-gate-remediator', () => {
  // ---------------------------------------------------------------------------
  // no-subprocess: child_process is never imported in the bin
  // ---------------------------------------------------------------------------

  test('bin module does not import child_process', async () => {
    const binSrc = fs.readFileSync(
      new URL('../../bin/spawn-gate-remediator.js', import.meta.url).pathname,
      'utf-8'
    );
    assert.ok(
      !binSrc.includes('child_process'),
      'child_process must never be imported in spawn-gate-remediator'
    );
  });

  // ---------------------------------------------------------------------------
  // Missing required flags
  // ---------------------------------------------------------------------------

  test('missing --gate-result → exit 1', async () => {
    const lines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--session-root', '/tmp/sr', '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      stderr: (m) => lines.push(m),
      stdout: () => {},
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('Missing required flags')));
  });

  test('missing --session-root → exit 1', async () => {
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', '/tmp/gr.json', '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      stderr: () => {},
      stdout: () => {},
    });
    assert.equal(code, 1);
  });

  test('missing --reason → exit 1', async () => {
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', '/tmp/gr.json', '--session-root', '/tmp/sr'],
      isoOverride: '2026-01-01T00-00-00Z',
      stderr: () => {},
      stdout: () => {},
    });
    assert.equal(code, 1);
  });

  test('invalid --reason → exit 1', async () => {
    const lines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', '/tmp/gr.json', '--session-root', '/tmp/sr', '--reason', 'bad-value'],
      isoOverride: '2026-01-01T00-00-00Z',
      stderr: (m) => lines.push(m),
      stdout: () => {},
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('strict|per-iteration')));
  });

  // ---------------------------------------------------------------------------
  // Invalid gate-result JSON
  // ---------------------------------------------------------------------------

  test('invalid JSON in gate-result → exit 1', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, 'not-json', 'utf-8');

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });

    const lines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stderr: (m) => lines.push(m),
      stdout: () => {},
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('Failed to read')));
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('gate-result missing required fields → exit 1', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify({ status: 'red' }), 'utf-8');

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });

    const lines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stderr: (m) => lines.push(m),
      stdout: () => {},
    });
    assert.equal(code, 1);
    assert.ok(lines.some(l => l.includes('not a valid GateResult')));
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('gate-result with malformed failure entries → exit 1, no brief', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    // failures[] present but each entry is missing required GateFailure fields
    fs.writeFileSync(
      grPath,
      JSON.stringify({ status: 'red', failures: [{ check: 'lint' }], elapsed_ms: 0 }),
      'utf-8'
    );

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });

    const errLines = [];
    const outLines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stderr: (m) => errLines.push(m),
      stdout: (m) => outLines.push(m),
    });

    assert.equal(code, 1, 'malformed failure entry must reject at validator');
    assert.ok(errLines.some(l => l.includes('not a valid GateResult')), 'stderr must explain rejection');
    assert.ok(!outLines.some(l => l.startsWith('BRIEF_PATH=')), 'no BRIEF_PATH must be emitted');

    const gateDir = path.join(sessionRoot, 'gate');
    if (fs.existsSync(gateDir)) {
      const briefs = fs.readdirSync(gateDir).filter(f => /^remediation_.*_brief\.md$/.test(f));
      assert.equal(briefs.length, 0, 'no brief file must be written when validator rejects');
    }

    fs.rmSync(tmpDir, { recursive: true });
  });

  test('gate-result reader promotes newer dead tmp snapshot before brief generation', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    const tmpPath = `${grPath}.tmp.99999999`;
    fs.writeFileSync(grPath, '{', 'utf-8');
    fs.writeFileSync(tmpPath, JSON.stringify(makeGateResult()), 'utf-8');
    const baseTime = new Date('2026-01-01T00:00:00Z');
    const tmpTime = new Date('2026-01-01T00:00:10Z');
    fs.utimesSync(grPath, baseTime, baseTime);
    fs.utimesSync(tmpPath, tmpTime, tmpTime);

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });

    const stdoutLines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stdout: (m) => stdoutLines.push(m),
      stderr: () => {},
    });

    assert.equal(code, 0);
    assert.ok(stdoutLines.some(l => l.startsWith('BRIEF_PATH=')), 'brief path must be emitted after tmp promotion');
    assert.equal(JSON.parse(fs.readFileSync(grPath, 'utf-8')).status, 'red');
    assert.equal(fs.existsSync(tmpPath), false, 'promoted tmp must be renamed over base gate result');

    fs.rmSync(tmpDir, { recursive: true });
  });

  test('gate-result with invalid status enum → exit 1', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(
      grPath,
      JSON.stringify({ status: 'maybe', failures: [], elapsed_ms: 0 }),
      'utf-8'
    );

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });

    const errLines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: '2026-01-01T00-00-00Z',
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stderr: (m) => errLines.push(m),
      stdout: () => {},
    });

    assert.equal(code, 1, 'invalid status enum must reject');
    assert.ok(errLines.some(l => l.includes('not a valid GateResult')), 'stderr must explain rejection');
    fs.rmSync(tmpDir, { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Successful brief write
  // ---------------------------------------------------------------------------

  test('brief written to expected path + BRIEF_PATH echoed', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult()), 'utf-8');

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });

    const iso = '2026-04-27T13-42-01Z';
    const stdoutLines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: iso,
      extensionClaudeMdContent: '## Trap Doors\nFake trap door content.',
      stdout: (m) => stdoutLines.push(m),
      stderr: () => {},
    });

    assert.equal(code, 0);

    const expectedPath = path.join(sessionRoot, 'gate', `remediation_${iso}_brief.md`);
    assert.ok(stdoutLines.some(l => l === `BRIEF_PATH=${expectedPath}`), `Expected BRIEF_PATH line, got: ${JSON.stringify(stdoutLines)}`);
    assert.ok(fs.existsSync(expectedPath), 'Brief file must exist');

    fs.rmSync(tmpDir, { recursive: true });
  });

  test('worker_spawn_backend_resolved telemetry uses schema-valid source values on default backend inheritance', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult()), 'utf-8');

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, 'state.json'), JSON.stringify({ activity: [] }), 'utf-8');

    const originalBackend = process.env.PICKLE_BACKEND;
    delete process.env.PICKLE_BACKEND;
    try {
      const code = await spawnGateRemediatorMain({
        argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
        isoOverride: '2026-04-27T13-50-00Z',
        extensionClaudeMdContent: '## Trap Doors\nNone.',
        stdout: () => {},
        stderr: () => {},
      });

      assert.equal(code, 0);
      const event = readLatestStateActivityEvent(sessionRoot, 'worker_spawn_backend_resolved');
      assert.ok(event, 'expected worker_spawn_backend_resolved activity event');
      assert.equal(event.backend, 'claude');
      assert.equal(event.source, 'default');
      assert.equal(Number.isInteger(event.pid), true);
    } finally {
      if (originalBackend === undefined) delete process.env.PICKLE_BACKEND;
      else process.env.PICKLE_BACKEND = originalBackend;
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Brief content — all 4 sections present
  // ---------------------------------------------------------------------------

  test('brief contains all 4 required sections', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult()), 'utf-8');

    const sessionRoot = path.join(tmpDir, 'session');
    const failingFile = path.join(tmpDir, 'src', 'foo.ts');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(failingFile, 'const x = /[\\x01-\\x1F]/;', 'utf-8');

    // Gate result references the actual file
    const gateResult = makeGateResult({ failures: [
      { check: 'lint', file: failingFile, line: 1, ruleOrCode: 'no-control-regex', message: 'use \\u form', severity: 'error', occurrence_index: 0 },
    ]});
    fs.writeFileSync(grPath, JSON.stringify(gateResult), 'utf-8');

    const iso = '2026-04-27T13-42-01Z';
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'per-iteration'],
      isoOverride: iso,
      extensionClaudeMdContent: '## Trap Doors\nFake trap door content.',
      stdout: () => {},
      stderr: () => {},
    });

    assert.equal(code, 0);

    const briefPath = path.join(sessionRoot, 'gate', `remediation_${iso}_brief.md`);
    const content = fs.readFileSync(briefPath, 'utf-8');
    const lines = content.split('\n');

    assert.ok(content.includes('## Section 1: Gate Failures'), 'Section 1 missing');
    assert.ok(content.includes('## Section 2: Failing File Contents'), 'Section 2 missing');
    assert.ok(content.includes('## Section 3: Relevant CLAUDE.md Trap Doors'), 'Section 3 missing');
    assert.ok(content.includes('## Section 4: Hard Rule and Abort Grammar'), 'Section 4 missing');

    const failureHeaderIndex = lines.indexOf('| Check | File | Line | Rule/Code | Severity | Message |');
    assert.ok(failureHeaderIndex >= 0, 'Failure table header missing');
    assert.equal(
      lines[failureHeaderIndex + 2],
      `| lint | ${failingFile} | 1 | no-control-regex | error | use \\u form |`,
      'Failure table row must preserve the exact GateFailure fields'
    );

    const fileSectionIndex = lines.indexOf(`### \`${failingFile}\``);
    assert.ok(fileSectionIndex >= 0, 'Failing file heading missing');

    // Section 3: trap doors
    assert.ok(content.includes('Fake trap door content'), 'Trap door content missing');

    // Section 4: hard rule
    assert.ok(content.includes('Fix ONLY the failures'), 'Hard rule missing');
    assert.ok(content.includes('Abort Grammar'), 'Abort grammar missing');

    // Section 4: hand-fix class (e) brace-free-if wrap (B-CSOR T30)
    assert.ok(content.includes('five failure classes'), 'brief must say five failure classes');
    assert.ok(content.includes('(e)'), 'brief must carry hand-fix class (e)');
    assert.ok(content.includes('banned-construct:brace-free-if'), 'class (e) must restrict to brace-free-if id');
    assert.ok(content.includes('(a)-(e)'), 'abort grammar must reference classes (a)-(e)');

    fs.rmSync(tmpDir, { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Determinism — same input produces same brief path (iso fixed)
  // ---------------------------------------------------------------------------

  test('brief is deterministic given same iso override', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult()), 'utf-8');

    const sessionRoot1 = path.join(tmpDir, 'session1');
    const sessionRoot2 = path.join(tmpDir, 'session2');
    const iso = '2026-04-27T00-00-00Z';

    for (const sr of [sessionRoot1, sessionRoot2]) {
      fs.mkdirSync(sr, { recursive: true });
      await spawnGateRemediatorMain({
        argv: ['--gate-result', grPath, '--session-root', sr, '--reason', 'strict'],
        isoOverride: iso,
        extensionClaudeMdContent: '## Trap Doors\nSame.',
        stdout: () => {},
        stderr: () => {},
      });
    }

    const brief1 = fs.readFileSync(path.join(sessionRoot1, 'gate', `remediation_${iso}_brief.md`), 'utf-8');
    const brief2 = fs.readFileSync(path.join(sessionRoot2, 'gate', `remediation_${iso}_brief.md`), 'utf-8');
    // Contents differ only by session root path — strip it and compare structure
    assert.equal(brief1.replace(sessionRoot1, 'SESSION').replace(grPath, 'GRPATH'),
      brief2.replace(sessionRoot2, 'SESSION').replace(grPath, 'GRPATH'));

    fs.rmSync(tmpDir, { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Lockfile cleanup after success
  // ---------------------------------------------------------------------------

  test('lockfile is released after successful run', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult()), 'utf-8');
    const sessionRoot = path.join(tmpDir, 'session');
    const iso = '2026-04-27T00-00-00Z';

    await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: iso,
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stdout: () => {},
      stderr: () => {},
    });

    const lockfilePath = path.join(sessionRoot, 'gate', 'remediator.lockfile');
    assert.ok(!fs.existsSync(lockfilePath), 'Lockfile must be released after run');

    fs.rmSync(tmpDir, { recursive: true });
  });
  // ---------------------------------------------------------------------------
  // #51 — Section 3 is drawn from the TARGET repo (session working_dir), never pickle-rick's own
  // ---------------------------------------------------------------------------

  const ISO_51 = '2026-09-26T00-00-00Z';

  /** A target repo at `<tmp>/target` + a session whose state.json names it; no extensionClaudeMdContent seam. */
  function makeTargetBrief(files, failureFiles, { writeState = true } = {}) {
    const tmpDir = makeTmpDir();
    const target = path.join(tmpDir, 'target');
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
      fs.writeFileSync(path.join(target, rel), body, 'utf-8');
    }
    fs.mkdirSync(target, { recursive: true });
    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionRoot, { recursive: true });
    if (writeState) fs.writeFileSync(path.join(sessionRoot, 'state.json'), JSON.stringify({ working_dir: target }), 'utf-8');
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult({
      failures: failureFiles.map((f, i) => ({ check: 'lint', file: f, line: 1, ruleOrCode: 'r', message: 'm', severity: 'error', occurrence_index: i })),
    })), 'utf-8');
    return { tmpDir, target, sessionRoot, grPath };
  }

  async function runBrief({ sessionRoot, grPath }) {
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: ISO_51,
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(code, 0);
    const brief = fs.readFileSync(path.join(sessionRoot, 'gate', `remediation_${ISO_51}_brief.md`), 'utf-8');
    const start = brief.indexOf('## Section 3');
    const end = brief.indexOf('## Section 4');
    return { brief, section3: brief.slice(start, end) };
  }

  test('AC-51a: a field repo brief carries the target CLAUDE.md and none of pickle-rick', async () => {
    const t = makeTargetBrief(
      { 'CLAUDE.md': '# Field rules\nFIELDMARK trap door\n', 'src/mod/CLAUDE.md': 'NEARMARK nested rule\n', 'src/mod/a.ts': 'x' },
      [path.join('src', 'mod', 'a.ts')],
    );
    const { brief, section3 } = await runBrief(t);
    assert.equal(brief.split('FIELDMARK').length - 1, 1, 'root CLAUDE.md content present once');
    assert.ok(section3.includes('NEARMARK'), 'nested CLAUDE.md content present');
    assert.ok(section3.indexOf('NEARMARK') < section3.indexOf('FIELDMARK'), 'nearest CLAUDE.md first');
    assert.equal(brief.split('R-WSRC').length - 1, 0, 'no pickle-rick trap-door content');
    fs.rmSync(t.tmpDir, { recursive: true });
  });

  test('AC-51a: a directory failing row still reads that directory CLAUDE.md, each file once', async () => {
    const t = makeTargetBrief(
      { 'CLAUDE.md': 'ROOTMARK\n', 'pkg/CLAUDE.md': 'PKGMARK\n' },
      [path.join('pkg'), path.join('pkg')],
    );
    const { section3 } = await runBrief(t);
    assert.equal(section3.split('PKGMARK').length - 1, 1);
    assert.equal(section3.split('ROOTMARK').length - 1, 1);
    fs.rmSync(t.tmpDir, { recursive: true });
  });

  test('AC-51b: no CLAUDE.md in the target → absence sentence, 0 pickle-rick bytes', async () => {
    const t = makeTargetBrief({ 'src/a.ts': 'x' }, [path.join('src', 'a.ts')]);
    const { brief, section3 } = await runBrief(t);
    assert.ok(section3.includes('No CLAUDE.md in target'), section3);
    assert.equal(brief.split('R-WSRC').length - 1, 0);
    fs.rmSync(t.tmpDir, { recursive: true });
  });

  test('AC-51b: unreadable session state.json → absence sentence, 0 pickle-rick bytes', async () => {
    const t = makeTargetBrief({ 'CLAUDE.md': 'ROOTMARK\n' }, ['src/a.ts'], { writeState: false });
    const { brief, section3 } = await runBrief(t);
    assert.ok(section3.includes('No CLAUDE.md in target'), section3);
    assert.ok(!brief.includes('ROOTMARK'));
    assert.equal(brief.split('R-WSRC').length - 1, 0);
    fs.rmSync(t.tmpDir, { recursive: true });
  });

  test('AC-51c: three oversized nested CLAUDE.md files are listed by path and Section 3 stays under the cap', async () => {
    const big = 'BIGBODY '.repeat(7_500); // 60 KB
    const t = makeTargetBrief(
      { 'CLAUDE.md': big, 'a/CLAUDE.md': big, 'a/b/CLAUDE.md': big, 'a/b/f.ts': 'x' },
      [path.join('a', 'b', 'f.ts')],
    );
    const { section3 } = await runBrief(t);
    assert.ok(!section3.includes('BIGBODY'), 'oversized bodies not inlined');
    for (const rel of ['CLAUDE.md', path.join('a', 'CLAUDE.md'), path.join('a', 'b', 'CLAUDE.md')]) {
      assert.ok(section3.includes(path.join(t.target, rel)), `path line for ${rel}`);
    }
    assert.ok(section3.length <= 3 * 50_000, `Section 3 is ${section3.length} chars`);
    fs.rmSync(t.tmpDir, { recursive: true });
  });

  test('AC-51c: files that fit one at a time but not in total: inlined until the 3x cap, then path lines', async () => {
    const mid = (tag) => `${tag} ` + 'x'.repeat(40_000);
    const t = makeTargetBrief(
      { 'CLAUDE.md': mid('ROOTTAG'), 'a/CLAUDE.md': mid('ATAG'), 'a/b/CLAUDE.md': mid('BTAG'), 'a/b/c/CLAUDE.md': mid('CTAG'), 'a/b/c/f.ts': 'x' },
      [path.join('a', 'b', 'c', 'f.ts')],
    );
    const { section3 } = await runBrief(t);
    assert.ok(section3.includes('CTAG') && section3.includes('BTAG') && section3.includes('ATAG'), 'nearest three inlined');
    assert.ok(!section3.includes('ROOTTAG'), 'fourth file over the cap is not inlined');
    assert.ok(section3.includes(path.join(t.target, 'CLAUDE.md')), 'fourth file is listed by path');
    assert.ok(section3.length <= 3 * 50_000 + 2_000);
    fs.rmSync(t.tmpDir, { recursive: true });
  });

  test('AC-51d: a pickle-rick-shaped target yields its own root and extension/ files via the walk', async () => {
    const t = makeTargetBrief(
      { 'CLAUDE.md': 'x'.repeat(60_000), 'extension/CLAUDE.md': 'y'.repeat(60_000), 'extension/src/bin/CLAUDE.md': 'SUBBIN\n', 'extension/src/bin/a.ts': 'x' },
      [path.join('extension', 'src', 'bin', 'a.ts')],
    );
    const { section3 } = await runBrief(t);
    assert.ok(section3.includes(path.join(t.target, 'CLAUDE.md')), 'root referenced');
    assert.ok(section3.includes(path.join(t.target, 'extension', 'CLAUDE.md')), 'extension/ referenced');
    assert.ok(section3.includes('SUBBIN'));
    assert.ok(section3.length <= 3 * 50_000);
    fs.rmSync(t.tmpDir, { recursive: true });
  });
});
