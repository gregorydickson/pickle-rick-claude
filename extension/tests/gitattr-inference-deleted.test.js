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

/**
 * Every trap-door catalog: the extension root's own, plus one per subsystem under `src/`.
 *
 * Enumerated from `src/`'s immediate children rather than by walking the whole extension tree —
 * a full walk descends into `coverage/`, `bin/`, `services/` and friends and cost ~9.7s here,
 * which is a starvation risk in the `@tier: fast` tier for no added reach.
 */
function listCatalogs() {
  const out = [];
  const rootDoc = path.join(REPO_ROOT, 'CLAUDE.md');
  if (fs.existsSync(rootDoc)) out.push(rootDoc);
  for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const doc = path.join(SRC, entry.name, 'CLAUDE.md');
    if (fs.existsSync(doc)) out.push(doc);
  }
  return out;
}

// The case above covers ONE catalog, but DELETED_SYMBOLS spans two home files: the evidence module
// (`src/services/`) and `extensionGreenGate`'s home `src/bin/mux-runner.ts`, whose anchors live in
// `src/bin/CLAUDE.md` — which that case never reads. This widens the reach to every catalog
// (including src/services/CLAUDE.md, so the two overlap rather than partition).
//
// Scoped to the `ENFORCE:` / `PATTERN_SHAPE:` SEGMENTS, which is AC-GA-8c's own wording and is
// load-bearing rather than stylistic: `extension/CLAUDE.md` legitimately NAMES `extractRCodeTokens`
// in reconciled INVARIANT prose ("...are deleted by B-GITATTR WS-3"). That is the correct reconciled
// form — a check that reddened on it would pressure a future worker into deleting the very sentence
// that records the deletion.
//
// Segment, not line: a trap-door entry is ONE long bullet carrying INVARIANT/BREAKS/ENFORCE/
// PATTERN_SHAPE all on the same line, so line-level filtering cannot tell the anchor from the prose
// beside it (measured — the entry above is a single line).
const SEGMENT_MARKERS = /\b(?:INVARIANT|BREAKS|ENFORCE|PATTERN_SHAPE|Race-Class|OPEN GAP):/g;

/** The `ENFORCE:` / `PATTERN_SHAPE:` segments of `text`, each truncated at the next segment marker. */
function anchorSegments(text) {
  const out = [];
  const bounds = [...text.matchAll(SEGMENT_MARKERS)];
  for (let i = 0; i < bounds.length; i++) {
    const marker = bounds[i][0];
    if (marker !== 'ENFORCE:' && marker !== 'PATTERN_SHAPE:') continue;
    const start = bounds[i].index + marker.length;
    const end = i + 1 < bounds.length ? bounds[i + 1].index : text.length;
    out.push(text.slice(start, end));
  }
  return out;
}

test('anchor reconciliation: no ENFORCE/PATTERN_SHAPE anchor in ANY catalog names a deleted symbol', () => {
  const catalogs = listCatalogs();
  assert.ok(
    catalogs.length >= 2,
    `expected several CLAUDE.md catalogs under ${REPO_ROOT}, found ${catalogs.length} — if the walk ` +
    'silently found nothing, every assertion below would pass vacuously',
  );

  let segmentsScanned = 0;
  for (const abs of catalogs) {
    const rel = path.relative(REPO_ROOT, abs);
    const segments = anchorSegments(fs.readFileSync(abs, 'utf8'));
    segmentsScanned += segments.length;

    for (const { symbol } of DELETED_SYMBOLS) {
      const offender = segments.find((seg) => seg.includes(symbol));
      assert.equal(
        offender,
        undefined,
        `${rel} carries an ENFORCE/PATTERN_SHAPE anchor naming deleted symbol "${symbol}" — a ` +
        'dangling anchor points at code that no longer exists, which audit-trap-door-enforcement.sh ' +
        `and citadel's trap-door analyzer both read as a finding. Offending segment:\n${offender}`,
      );
    }
  }

  // Same reason as the catalog-count guard: if the segment parser drifts and matches nothing, the
  // loop above becomes a no-op that reports success.
  assert.ok(
    segmentsScanned > 0,
    'the ENFORCE/PATTERN_SHAPE segment parser matched nothing across every catalog — it has drifted',
  );
});
