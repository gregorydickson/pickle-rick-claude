// @tier: fast
//
// B-GITATTR WS-3: with the Pickle-Ticket git trailer producing and consuming
// attribution (tickets 20-40), the message-inference surface — ref-token scan,
// declared-file-touch attribution, sibling-declared-file enumeration, and the
// extension/-scoped greenGate — is dead weight. This pins the deletion via ONE
// declared DELETED_SYMBOLS set (describe.each), so the list can never drift
// into two hand-maintained copies. Absence is asserted PER HOME FILE, never
// whole-tree — `commitMessage` is a name collision with unrelated locals in
// microverse-runner.ts and bundle-finalize.ts.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe.each ??= function each(rows) {
  return function runEach(_title, suite) {
    for (const row of rows) {
      describe(row.symbol, () => suite(row));
    }
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'src');

const DELETED_SYMBOLS = [
  { symbol: 'scanGitLogByRefToken', homeFile: 'src/services/ticket-completion-evidence.ts' },
  { symbol: 'guardScanHit', homeFile: 'src/services/ticket-completion-evidence.ts' },
  { symbol: 'extractRCodeTokens', homeFile: 'src/services/ticket-completion-evidence.ts' },
  { symbol: 'commitMessage', homeFile: 'src/services/ticket-completion-evidence.ts' },
  { symbol: 'scanGitLogByFileTouch', homeFile: 'src/services/ticket-completion-evidence.ts' },
  { symbol: 'touchesDeclared', homeFile: 'src/services/ticket-completion-evidence.ts' },
  { symbol: 'commitTouchedFiles', homeFile: 'src/services/ticket-completion-evidence.ts' },
  { symbol: 'enumerateSiblingDeclaredFiles', homeFile: 'src/services/ticket-completion-evidence.ts' },
  { symbol: 'extensionGreenGate', homeFile: 'src/bin/mux-runner.ts' },
];

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

/** Recursively lists every `.ts` file under `dir` (relative to REPO_ROOT, POSIX-joined). */
function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out;
}

describe.each(DELETED_SYMBOLS)('DELETED_SYMBOLS member is absent from its home file', ({ symbol, homeFile }) => {
  test(`${symbol} has zero occurrences in ${homeFile}`, () => {
    const src = readRepoFile(homeFile);
    const count = src.split(symbol).length - 1;
    assert.equal(count, 0, `${symbol} must be fully deleted from ${homeFile}, found ${count} occurrence(s)`);
  });
});

test('survival pin: ticket-declared-files.ts exists, exports readDeclaredFiles, and has >=3 external importer files', () => {
  const modulePath = path.join(SRC, 'services', 'ticket-declared-files.ts');
  assert.ok(fs.existsSync(modulePath), 'ticket-declared-files.ts must survive the deletion — it has live non-attribution consumers');

  const moduleSrc = fs.readFileSync(modulePath, 'utf8');
  assert.match(moduleSrc, /export function readDeclaredFiles\b/, 'readDeclaredFiles must remain exported');

  const importRe = /from ['"](?:\.\.\/)*services\/ticket-declared-files\.js['"]/;
  const importers = listTsFiles(SRC).filter((abs) => {
    if (path.resolve(abs) === path.resolve(modulePath)) return false;
    return importRe.test(fs.readFileSync(abs, 'utf8'));
  });
  assert.ok(
    importers.length >= 3,
    `expected >=3 external importers of ticket-declared-files.ts, found ${importers.length}: ${importers.join(', ')}`,
  );
});

test('collision guard: commitMessage is still present in microverse-runner.ts and bundle-finalize.ts (home-file-scoped absence, not whole-tree)', () => {
  const microverse = readRepoFile('src/bin/microverse-runner.ts');
  assert.match(
    microverse,
    /\bcommitMessage\b/,
    'microverse-runner.ts declares its own unrelated `commitMessage` local — a whole-tree absence assertion would wrongly delete it',
  );

  const bundleFinalize = readRepoFile('src/services/bundle-finalize.ts');
  assert.match(
    bundleFinalize,
    /\bcommitMessage\b/,
    'bundle-finalize.ts uses `commitMessage` as a DTO field/parameter name — unrelated to the deleted evidence-module helper',
  );
});

test('anchor reconciliation: no DELETED_SYMBOLS member is named in src/services/CLAUDE.md', () => {
  const doc = readRepoFile('src/services/CLAUDE.md');
  for (const { symbol } of DELETED_SYMBOLS) {
    assert.ok(
      !doc.includes(symbol),
      `src/services/CLAUDE.md still names deleted symbol "${symbol}" — reconcile the dangling trap-door anchor`,
    );
  }
});
