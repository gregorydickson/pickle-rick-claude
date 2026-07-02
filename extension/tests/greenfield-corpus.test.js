// @tier: fast
// W1e: standing greenfield-corpus CI. Proves the W1a–W1d gate loosenings stay HONEST.
//
//   POSITIVE corpus (historically-blocking, now-ready — must PASS, zero skip-flags):
//     (a) loa727-ac-shape    — AC-shape cross-field parametrized recognition (refiner gate)
//     (c) forced-budget      — R-RHFP wall-budget `performance` finding is non-blocking
//     (d) deep-path          — R-RTRC-4 bare-basename suffix-match (readiness, fresh repo)
//
//   PAIRED-NEGATIVE corpus (N=3, genuinely-unready — must still FAIL):
//     (N1) negative-contract-drift — unresolved un-annotated symbol still fails readiness
//     (N2) negative-ac-shape       — unparametrized 3-target enumeration still violates
//     (N3) negative-path-drift     — un-annotated nonexistent path still fatal (ticket-audit)
//
// A new false-positive regression in a loosened gate makes a POSITIVE fixture fail;
// a new no-op regression (a gate that lost its teeth) makes a NEGATIVE fixture pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const READINESS_BIN = path.resolve(__dirname, '../bin/check-readiness.js');
const AUDIT_BIN = path.resolve(__dirname, '../bin/audit-ticket-bundle.js');
const CORPUS = path.join(__dirname, 'fixtures', 'greenfield-corpus');

const { evaluateAcShapeEnforcement } = await import('../bin/spawn-refinement-team.js');

// The unified flag is the only live skip surface; the two retired legacy keys stay
// in this list so positive fixtures prove they never reappear.
const SKIP_FLAG_KEYS = ['skip_quality_gates_reason', 'skip_readiness_reason', 'skip_ticket_audit_reason'];

function tmpDir(prefix = 'pickle-greenfield-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function readFixtureManifest(relDir) {
  return JSON.parse(fs.readFileSync(path.join(CORPUS, relDir, 'manifest.json'), 'utf-8'));
}

// Writes a session state.json with NO skip flags. Callers prove the zero-skip-flag
// invariant by re-reading the on-disk bytes via assertNoSkipFlags.
function writeSessionState(sessionDir, workingDir) {
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({ working_dir: workingDir, schema_version: 5, active: false }),
  );
}

function assertNoSkipFlags(sessionDir) {
  const raw = fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8');
  const state = JSON.parse(raw);
  for (const key of SKIP_FLAG_KEYS) {
    assert.ok(!(key in state), `positive fixture state.json must not carry ${key}`);
    assert.ok(!(state.flags && key in state.flags), `positive fixture state.flags must not carry ${key}`);
  }
}

function copyFixtureTicket(sessionDir, relDir, ticketId) {
  const dest = path.join(sessionDir, ticketId);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(
    path.join(CORPUS, relDir, ticketId, `linear_ticket_${ticketId}.md`),
    path.join(dest, `linear_ticket_${ticketId}.md`),
  );
}

function writeTicket(sessionDir, id, lines) {
  const dir = path.join(sessionDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `linear_ticket_${id}.md`), lines.join('\n'));
}

function initGitRepo(root) {
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'corpus@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'corpus'], { cwd: root });
}

function commitAll(root) {
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
}

function runReadiness(sessionDir, repoRoot, extraArgs = [], dataRoot) {
  return spawnSync(process.execPath, [
    READINESS_BIN,
    '--session-dir', sessionDir,
    '--repo-root', repoRoot,
    '--contract-only',
    ...extraArgs,
  ], { encoding: 'utf-8', timeout: 60000, env: { ...process.env, PICKLE_DATA_ROOT: dataRoot } });
}

function runAuditBundle(sessionDir) {
  return spawnSync(process.execPath, [AUDIT_BIN, sessionDir], { encoding: 'utf-8', timeout: 60000 });
}

// ── POSITIVE (a) — LOA-727 AC-shape false-reject ────────────────────────────
test('POSITIVE (a): LOA-727 parametrized ticket passes the AC-shape gate with zero violations', () => {
  const manifest = readFixtureManifest('loa727-ac-shape');
  // No skip-flag involved: the gate is a pure function over the manifest shape.
  assert.deepEqual(
    evaluateAcShapeEnforcement(manifest), [],
    'cross-field parametrized recognition must yield no violation',
  );
});

// ── POSITIVE (c) — forced-budget-override wall-budget (indeterminate, not fail) ──
test('POSITIVE (c): forced --max-wall-ms 1 yields an advisory performance finding, status pass', () => {
  const sessionDir = tmpDir();
  const dataRoot = tmpDir('pickle-greenfield-data-');
  try {
    // Every ref is a real exported symbol of check-readiness.ts, so none can produce
    // a blocking `contract` finding. With --max-wall-ms 1 the shared resolver budget is
    // exhausted after the first ref or two and the rest emit kind:'performance' — the
    // only findings. This is the FORCED-BUDGET-OVERRIDE case, NOT a real large repo.
    const symbols = [
      'extractContractReferences()', 'extractAcceptanceCriteria()', 'isMachineCheckable()',
      'parseArgs()', 'runHistory()', 'findReadinessFindings()', 'loadReadinessAllowlist()',
      'runReadiness()',
      'gitTrackedFiles()', 'createResolverCache()', 'resolveSymbolRef()',
    ];
    writeTicket(sessionDir, 'cc000001', [
      '---', 'id: cc000001', 'key: WB-1', 'ac_ids: []', '---', '',
      '# Forced-budget fixture', '', '## Acceptance Criteria', '- [ ] `node --test` passes.', '',
      '## Interface Contracts', '',
      ...symbols.map((sym) => `- \`${sym}\` must exist.`), '',
    ]);
    writeSessionState(sessionDir, REPO_ROOT);

    const result = runReadiness(sessionDir, REPO_ROOT, ['--max-wall-ms', '1'], dataRoot);
    assert.equal(result.status, 0, `gate must pass on a perf-only finding; stderr=${result.stderr}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    assert.ok(
      out.findings.some((f) => f.kind === 'performance'),
      `the performance finding must be surfaced; got ${JSON.stringify(out.findings)}`,
    );
    assert.ok(
      !out.findings.some((f) => f.kind !== 'performance'),
      `no blocking finding expected; got ${JSON.stringify(out.findings)}`,
    );

    assertNoSkipFlags(sessionDir);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ── POSITIVE (d) — deep bare-basename path (R-RTRC-4 suffix-match) ───────────
test('POSITIVE (d): deep bare-basename path resolves via git ls-files suffix-match', () => {
  const sessionDir = tmpDir();
  const repoRoot = tmpDir('pickle-greenfield-repo-');
  const dataRoot = tmpDir('pickle-greenfield-data-');
  try {
    initGitRepo(repoRoot);
    const deepDir = path.join(repoRoot, 'packages', 'core', 'src', 'modules', 'corpus', 'deep');
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(deepDir, 'corpus-nested-deep.ts'), 'export const sigil = true;\n');
    commitAll(repoRoot);

    writeTicket(sessionDir, 'dd000001', [
      '---', 'id: dd000001', 'key: DEEP-1', 'ac_ids: []', '---', '',
      '# Deep path fixture', '', '## Files', '',
      '- `corpus-nested-deep.ts`', '',
      '## Acceptance Criteria', '- [ ] File `corpus-nested-deep.ts` exists at HEAD.', '',
    ]);
    writeSessionState(sessionDir, repoRoot);

    const result = runReadiness(sessionDir, repoRoot, [], dataRoot);
    assert.equal(result.status, 0, `readiness must pass; stderr=${result.stderr}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    assert.equal(
      out.findings.filter((f) => f.kind === 'file_path').length, 0,
      `suffix-match must resolve deep path; got ${JSON.stringify(out.findings)}`,
    );

    assertNoSkipFlags(sessionDir);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ── PAIRED-NEGATIVE (N1) — unresolved, un-annotated contract ref ────────────
test('NEGATIVE (N1): unresolved un-annotated contract ref still fails readiness', () => {
  const sessionDir = tmpDir();
  const repoRoot = tmpDir('pickle-greenfield-emptyrepo-');
  const dataRoot = tmpDir('pickle-greenfield-data-');
  try {
    // Fresh empty repo so the cited symbol genuinely cannot resolve at HEAD.
    initGitRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'placeholder.txt'), 'x\n');
    commitAll(repoRoot);
    copyFixtureTicket(sessionDir, 'negative-contract-drift', 'cccc0002');

    const result = runReadiness(sessionDir, repoRoot, [], dataRoot);
    assert.equal(result.status, 2, `readiness must fail (exit 2); stdout=${result.stdout}; stderr=${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'fail');
    assert.ok(
      out.findings.some((f) => f.kind === 'contract'),
      `a contract finding must be present; got ${JSON.stringify(out.findings)}`,
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ── PAIRED-NEGATIVE (N2) — genuinely-unparametrized AC-shape ────────────────
test('NEGATIVE (N2): unparametrized 3-target enumeration still violates the AC-shape gate', () => {
  const manifest = readFixtureManifest('negative-ac-shape');
  const violations = evaluateAcShapeEnforcement(manifest);
  assert.ok(violations.length > 0, `expected a violation; got ${JSON.stringify(violations)}`);
  assert.equal(violations[0].ac_id, 'NEG-AC-1');
});

// ── PAIRED-NEGATIVE (N3) — real path-drift, un-annotated ────────────────────
test('NEGATIVE (N3): un-annotated nonexistent path still fails ticket-audit (fatal path-drift)', () => {
  const sessionDir = tmpDir();
  try {
    copyFixtureTicket(sessionDir, 'negative-path-drift', 'dddd0003');
    writeSessionState(sessionDir, REPO_ROOT);

    const audit = runAuditBundle(sessionDir);
    assert.equal(audit.status, 1, `ticket-audit must fail (exit 1); stdout=${audit.stdout}; stderr=${audit.stderr}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, 'audit-ticket-bundle.json'), 'utf-8'));
    assert.ok(
      manifest.findings.some((f) => f.defect_class === 'path-drift' && f.severity === 'fatal'),
      `a fatal path-drift finding must be present; got ${JSON.stringify(manifest.findings)}`,
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ── Zero-skip-flag-by-construction invariant on the static positive fixtures ──
test('INVARIANT: static positive fixtures carry no skip-flag in their committed data', () => {
  // The AC-shape manifest is the only static fixture with embedded state-like data;
  // assert no skip-flag token leaked into any committed fixture file.
  const corpusFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else corpusFiles.push(full);
    }
  };
  walk(CORPUS);
  for (const file of corpusFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const key of SKIP_FLAG_KEYS) {
      assert.ok(
        !content.includes(key),
        `committed fixture ${path.relative(CORPUS, file)} must not embed skip-flag ${key}`,
      );
    }
  }
});
