// @tier: fast
//
// AC-V3 pins for the INVARIANT symbol-liveness arm of
// scripts/audit-trap-door-enforcement.sh.
//
// These tests drive the SCRIPT against fixture catalogs. They never assert on the
// script's source text: a test that greps source reddens on rename while proving
// nothing about behaviour.
//
// SELF-REFERENCE HAZARD (the reason every fixture name is concatenated at runtime):
// the arm's corpus is a word set over every tracked non-.md file, and this test file
// is one of them. A dead identifier written here as a LITERAL would enter the corpus,
// resolve as live, and silently defuse the very test asserting it is dead. Splitting
// each name across a `+` keeps the joined token out of every tracked file, and
// `premise: fixture names resolve nowhere in the tree` below fails loudly if that
// ever stops being true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');

// Never written as a joined literal anywhere. See the self-reference note above.
const RENAMED_AWAY = 'zzInvariantLiveness' + 'RenamedAwayFixture';
const DELETED_BY_REFACTOR = 'zzInvariantLiveness' + 'PassThroughFixture';
const FALSE_AT_BIRTH = 'zzInvariantLiveness' + 'NeverExistedFixture';

const FIXTURE_NAMES = [RENAMED_AWAY, DELETED_BY_REFACTOR, FALSE_AT_BIRTH];

// Appends one catalog entry to a copy of the real extension/CLAUDE.md and runs the
// audit against it. The copy keeps every sibling arm satisfied, so a non-zero status
// is attributable to the appended entry alone. REPO_ROOT is derived from the script's
// own location, so resolution still runs against the real tree while the catalog under
// test lives in a tmpdir.
function runAuditWithEntry(entry) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-invariant-liveness-'));

  try {
    const fixturePath = path.join(tmpDir, 'CLAUDE.md');
    const source = fs.readFileSync(path.join(EXTENSION_ROOT, 'CLAUDE.md'), 'utf8');
    fs.writeFileSync(fixturePath, `${source}\n${entry}\n`);

    return spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CLAUDE_PATH_OVERRIDE: fixturePath },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function assertNamesDeadSymbol(result, name) {
  assert.notEqual(result.status, 0, `audit should fail for ${name}; stderr: ${result.stderr}`);
  assert.match(result.stderr, /^INVARIANT: .*absent from the tree/m, result.stderr);
  assert.match(result.stderr, new RegExp(`absent from the tree: ${name}$`, 'm'), result.stderr);
}

// Shape of ea40a7e2 (AP-EXT-ITER46-01): a rename deleted the symbol, the guard stayed
// intact, and the anchor kept naming the old identifier.
test('INVARIANT naming a renamed-away symbol fails the audit', () => {
  const result = runAuditWithEntry(
    '- `src/bin/mux-runner.ts` (R-FIXTURE-RENAMED) — ' +
      `INVARIANT: the relaunch path calls \`${RENAMED_AWAY}\` before spawning. BREAKS: nothing.`
  );

  assertNamesDeadSymbol(result, RENAMED_AWAY);
});

// Shape of c0b6c2e5 (AP-EXT-ITER56-02): a refactor deleted the symbol as a pure
// pass-through. The name sits deep inside a parenthetical mid-clause rather than as the
// first token, which pins that the arm is position-independent — no position rule
// catches all three historical shapes.
test('INVARIANT naming a symbol deleted by refactor fails the audit', () => {
  const result = runAuditWithEntry(
    '- `src/services/state-manager.ts` (R-FIXTURE-PASSTHROUGH) — ' +
      'INVARIANT: the writer stamps its own timestamp before persisting ' +
      `(the wrapper \`${DELETED_BY_REFACTOR}\` forwards to it unchanged), so the ` +
      'ordering holds. BREAKS: nothing.'
  );

  assertNamesDeadSymbol(result, DELETED_BY_REFACTOR);
});

// Shape of 15866fa6 (AP-EXT-ITER8-01): FALSE AT BIRTH — the anchor named a symbol that
// never existed in ANY commit. This is the important case: it must be caught from the
// tree at HEAD alone, so this test performs no history lookup whatsoever.
test('INVARIANT naming a symbol that never existed fails the audit', () => {
  const result = runAuditWithEntry(
    '- `src/hooks/dispatch.ts` (R-FIXTURE-NEVER-EXISTED) — ' +
      `INVARIANT: the hook consults \`${FALSE_AT_BIRTH}\` before deciding. BREAKS: nothing.`
  );

  assertNamesDeadSymbol(result, FALSE_AT_BIRTH);
});

// BREAKS describes historical breakage and legitimately names dead symbols. Sweeping it
// would red correct entries, so it is out of scope by design.
test('BREAKS naming a dead symbol does not fail the audit', () => {
  const result = runAuditWithEntry(
    '- `src/bin/setup.ts` (R-FIXTURE-BREAKS-CONTROL) — ' +
      'INVARIANT: setup resolves catalogs through `discoverCatalogs`. ' +
      `BREAKS: the removed \`${RENAMED_AWAY}\` shim used to bypass it.`
  );

  assert.equal(result.status, 0, `BREAKS is out of scope; stderr: ${result.stderr}`);
});

// A live symbol passes, and a backticked span that is not a bare identifier (here a file
// path) is not treated as a symbol claim. The non-identifier span must be COUNTED in the
// success line rather than silently dropped.
test('INVARIANT naming a live symbol with a backticked path does not fail the audit', () => {
  const result = runAuditWithEntry(
    '- `src/bin/setup.ts` (R-FIXTURE-LIVE-CONTROL) — ' +
      'INVARIANT: `discoverCatalogs` enumerates every catalog under ' +
      '`extension/src/*/CLAUDE.md`. BREAKS: nothing.'
  );

  assert.equal(result.status, 0, `live symbol should pass; stderr: ${result.stderr}`);
  assert.match(result.stdout, /non-identifier span\(s\) not checked/, result.stdout);
});

// Guards the premise the three failing tests depend on. If a future edit ever writes one
// of these names as a joined literal into a tracked non-.md file, it enters the corpus,
// resolves as live, and the tests above would pass vacuously. This fails first instead.
test('premise: fixture names resolve nowhere in the tree', () => {
  for (const name of FIXTURE_NAMES) {
    const result = spawnSync('git', ['grep', '-l', '-w', name, '--', ':!*.md'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 64 * 1024 * 1024,
    });

    assert.equal(
      result.stdout.trim(),
      '',
      `${name} must not appear as a literal in any tracked non-.md file, ` +
        'or it enters the corpus and defuses its own test'
    );
  }
});
