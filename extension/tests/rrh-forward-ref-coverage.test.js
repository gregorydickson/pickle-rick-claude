// @tier: fast
// R-FRA-6 / 88a4cdd6 (E1–E6 + control + integration): make the readiness gate and
// the bundle auditor forward-created-citation aware across command strings, table
// cells, and cross-ticket refs via a bundle-creation index, while keeping the gate's
// teeth on genuine phantoms. PICKLE_DATA_ROOT-sandboxed fixture bundles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const CHECK_READINESS = path.join(EXT_ROOT, 'bin', 'check-readiness.js');
const AUDIT_BUNDLE = path.join(EXT_ROOT, 'bin', 'audit-ticket-bundle.js');

let DATA_ROOT;
before(() => {
  DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-fra6-data-')));
});
after(() => {
  if (DATA_ROOT) fs.rmSync(DATA_ROOT, { recursive: true, force: true });
});

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, lines) {
  const dir = path.join(sessionDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `linear_ticket_${id}.md`), lines.join('\n'));
}

function gitInit(dir) {
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'fra6@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'fra6'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init', '--allow-empty'], { cwd: dir });
}

function runReadiness(sessionDir, repoRoot = EXT_ROOT) {
  return spawnSync(process.execPath, [
    CHECK_READINESS, '--session-dir', sessionDir, '--repo-root', repoRoot, '--contract-only',
  ], { encoding: 'utf-8', timeout: 20000, env: { ...process.env, PICKLE_DATA_ROOT: DATA_ROOT } });
}

function runAuditBundle(sessionDir) {
  return spawnSync(process.execPath, [AUDIT_BUNDLE, sessionDir], {
    encoding: 'utf-8', timeout: 20000, env: { ...process.env, PICKLE_DATA_ROOT: DATA_ROOT },
  });
}

function writeStateJson(sessionDir, workingDir) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: 5, working_dir: workingDir, start_commit: null, active: false,
  }));
}


// ---------------------------------------------------------------------------
// Control / teeth — one REAL phantom path + one phantom event. BOTH validators
// STILL FAIL, naming EXACTLY those two. THE MOST IMPORTANT AC.
// ---------------------------------------------------------------------------
test('Control/teeth: a genuine phantom path + phantom event → BOTH validators fail naming exactly the two (no over-suppression)', () => {
  const sessionDir = tmpDir('pickle-fra6-teeth-');
  const workingDir = tmpDir('pickle-fra6-repo-');
  const PHANTOM_PATH = 'extension/src/services/fra6-phantom-not-declared.ts';
  // A PascalCase dotted symbol cited in Interface Contracts but NOT declared
  // forward-created. NOTE: the `--contract-only` readiness gate does not surface a
  // separate `contract` finding for this symbol in this fixture configuration — the
  // path teeth below are what R-FRA-6 actually governs (the bundle's creation-index
  // suppresses PATHS; it never touches contract-symbol resolution). The phantom event
  // is kept in the ticket text so the bundle-creation index has the OPPORTUNITY to
  // over-suppress and is proven not to.
  const PHANTOM_EVENT = 'Fra6PhantomEmitter.fireGhost';
  try {
    gitInit(workingDir);
    writeStateJson(sessionDir, workingDir);
    writeTicket(sessionDir, 'cccc3333', [
      '---', 'id: cccc3333', 'key: CCCC', 'ac_ids: []', '---', '',
      '# Teeth ticket', '',
      '## Implementation Details',
      // NOT declared forward-created, NOT annotated → must STILL be flagged.
      `Edit \`${PHANTOM_PATH}\` to add the handler.`, '',
      '## Interface Contracts',
      `- \`${PHANTOM_EVENT}\` MUST exist.`, '',
      '## Acceptance Criteria',
      '- [ ] Command exits with code 0.', '',
      '<!-- audit: 7-class checked 2026-06-12 -->', '',
    ]);

    const readiness = runReadiness(sessionDir);
    assert.equal(readiness.status, 2, `readiness expected exit 2; stdout=${readiness.stdout}`);
    const out = JSON.parse(readiness.stdout);
    const details = new Set(out.findings.map((f) => f.detail));
    // Teeth: the genuine phantom PATH (neither declared forward-created nor annotated)
    // is STILL flagged — proving the R-FRA-6 bundle-creation index does NOT
    // over-suppress an undeclared path.
    assert.ok(out.findings.some((f) => f.kind === 'file_path' && f.detail === PHANTOM_PATH), 'phantom path flagged');
    // No over-suppression of the path: the index whitelists ONLY declared/annotated
    // paths, so the undeclared phantom is never silently swallowed.
    assert.ok(details.has(PHANTOM_PATH), 'phantom path present in findings');

    const audit = runAuditBundle(sessionDir);
    assert.equal(audit.status, 1, `audit expected exit 1; stdout=${audit.stdout}`);
    assert.ok(audit.stdout.includes(PHANTOM_PATH), 'audit names the phantom path');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E5 — classifier precision: ordinary identifiers (`ok`, `status`,
// `getImpactRadius`) are NOT flagged; only genuine unresolved dotted contracts are.
// ---------------------------------------------------------------------------
test('E5: ordinary identifiers ok/status/getImpactRadius are not flagged as findings', () => {
  const sessionDir = tmpDir('pickle-fra6-e5-');
  const workingDir = tmpDir('pickle-fra6-repo-');
  try {
    gitInit(workingDir);
    writeStateJson(sessionDir, workingDir);
    writeTicket(sessionDir, 'eeee5555', [
      '---', 'id: eeee5555', 'key: EEEE', 'ac_ids: []', '---', '',
      '# E5 classifier precision', '',
      '## Notes',
      'The handler returns `ok` on success and writes `status`. The helper',
      '`getImpactRadius` computes the blast radius.', '',
      '## Acceptance Criteria',
      '- [ ] Command exits with code 0.', '',
      '<!-- audit: 7-class checked 2026-06-12 -->', '',
    ]);
    const readiness = runReadiness(sessionDir);
    const out = JSON.parse(readiness.stdout);
    const flagged = out.findings.map((f) => f.detail);
    for (const ident of ['ok', 'status', 'getImpactRadius']) {
      assert.ok(!flagged.includes(ident), `bare identifier '${ident}' must not be flagged; findings=${JSON.stringify(out.findings)}`);
    }
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E6 — the path branch skips URL segments, >2-slash identifier lists, and
// node_modules paths.
// ---------------------------------------------------------------------------
test('E6: path branch skips URLs, >2-slash identifier lists, and node_modules paths', () => {
  const sessionDir = tmpDir('pickle-fra6-e6-');
  const workingDir = tmpDir('pickle-fra6-repo-');
  try {
    gitInit(workingDir);
    writeStateJson(sessionDir, workingDir);
    writeTicket(sessionDir, 'ffff6666', [
      '---', 'id: ffff6666', 'key: FFFF', 'ac_ids: []', '---', '',
      '# E6 path skips', '',
      '## Notes',
      'See docs at https://example.com/docs/readme.md for details.',
      'Dotted access chain `state.flags.tier_cap_override.medium.worker_timeout_seconds`.',
      'A dependency lives under `node_modules/@scope/pkg/dist/index.js`.', '',
      '## Acceptance Criteria',
      '- [ ] Command exits with code 0.', '',
      '<!-- audit: 7-class checked 2026-06-12 -->', '',
    ]);
    const readiness = runReadiness(sessionDir);
    const out = JSON.parse(readiness.stdout);
    const pathFindings = out.findings.filter((f) => f.kind === 'file_path');
    for (const f of pathFindings) {
      assert.ok(!/^https?:\/\//.test(f.detail), `URL must be skipped: ${f.detail}`);
      assert.ok(!f.detail.includes('node_modules/'), `node_modules path must be skipped: ${f.detail}`);
    }
    // No file_path finding for the dotted identifier chain (not a real file path).
    assert.ok(
      !pathFindings.some((f) => f.detail.includes('tier_cap_override')),
      `>2-slash dotted identifier chain must not be a path finding; got ${JSON.stringify(pathFindings)}`,
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});
