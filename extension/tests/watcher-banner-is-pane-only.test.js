// @tier: fast
//
// The `◤ FEED TERMINATED ◢` watcher banner is PANE-ONLY.
//
// It is written exclusively with `process.stdout.write` from the three file-tail
// watchers, and `wrapWithStderrRedirect` captures only each pane's STDERR
// (`2>>monitor-<pane>.log`). Nothing tees pane stdout into a file. A gate that
// greps a log file for this literal therefore can never match — which is what
// `bin/section-c-still-needed.js` did for 13 commits (7 of them anatomy-park
// HIGH fixes hardening the plumbing around a predicate that could not fire)
// before it was deleted as a permanent false-green.
//
// Note the polarity trap: post-R-MWR-6 the banner is RESERVED for the genuine
// `state.active !== true` exit, i.e. it marks NORMAL session end. Making it
// file-visible would not repair such a gate — it would flip it to a permanent
// false-RED on every cleanly-completed session.
//
// These assertions pin the producer contract, so the class cannot be rebuilt.
//
// The class DID get rebuilt once, in the one place these assertions could not
// see: AC-DR-05 (`writeWatcherLivenessArtifact`, pipeline-runner.ts) grepped the
// same two logs from `extension/src/bin/` — outside the repo-`bin/` scan — and
// referred to the banner through a named constant rather than the raw literal,
// so a literal-only scan missed it. Its `pass: matches.length === 0` could never
// be false, and unlike section-c it WAS consumed (EXPECTED_BUNDLE_AC_IDS), so it
// shipped a green "watcher liveness verified" checkmark on every bundle. Deleted;
// the consumer-side scan below now resolves constants and covers both trees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'extension', 'src');
const BANNER = '◤ FEED TERMINATED ◢';

const WATCHERS = ['log-watcher.ts', 'morty-watcher.ts', 'raw-morty.ts'];

/** Lines carrying the raw banner literal, excluding comments. */
function bannerCodeLines(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => text.includes(BANNER))
    .filter(({ text }) => {
      const t = text.trimStart();
      return !t.startsWith('//') && !t.startsWith('*');
    });
}

function tsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('watcher banner is emitted only via process.stdout.write', () => {
  for (const watcher of WATCHERS) {
    const file = path.join(SRC_DIR, 'bin', watcher);
    const emissions = bannerCodeLines(file);
    assert.ok(emissions.length > 0, `${watcher} should still emit the banner`);
    for (const { text, line } of emissions) {
      assert.match(
        text,
        /process\.stdout\.write\(/,
        `${watcher}:${line} emits the banner outside process.stdout.write — a file sink here `
        + 'would resurrect the dead-gate class (see file header)',
      );
    }
  }
});

test('no code path writes the watcher banner into a file', () => {
  const offenders = [];
  for (const file of tsFilesUnder(SRC_DIR)) {
    for (const { text, line } of bannerCodeLines(file)) {
      if (/writeFileSync|appendFileSync|createWriteStream|writeStateFile/.test(text)) {
        offenders.push(`${path.relative(REPO_ROOT, file)}:${line}`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    `banner written to a file at: ${offenders.join(', ')} — any log-grepping gate would then `
    + 'fire on every NORMAL session end (R-MWR-6 reserves the banner for real termination)',
  );
});

test('watcher panes capture stderr only, so pane stdout never reaches a file', () => {
  const utils = fs.readFileSync(path.join(SRC_DIR, 'services', 'pickle-utils.ts'), 'utf8');
  const start = utils.indexOf('function wrapWithStderrRedirect');
  assert.ok(start !== -1, 'wrapWithStderrRedirect must exist — it is the pane output contract');
  const body = utils.slice(start, utils.indexOf('\n}', start));

  assert.match(body, /2>>/, 'wrapWithStderrRedirect must redirect pane stderr to a file');
  for (const stdoutSink of ['&>', '1>', '| tee']) {
    assert.ok(
      !body.includes(stdoutSink),
      `wrapWithStderrRedirect must not capture pane stdout (found "${stdoutSink}") — capturing it `
      + 'would make the banner file-visible and flip AC-DR-05 to a permanent false-RED',
    );
  }
});

test('no tmux pane-to-file tee exists (pipe-pane / capture-pane)', () => {
  const offenders = tsFilesUnder(SRC_DIR).filter((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return text.includes('pipe-pane') || text.includes('capture-pane');
  });
  assert.deepEqual(
    offenders.map((f) => path.relative(REPO_ROOT, f)), [],
    'a pane->file tee would make pane stdout (and the banner) file-visible; see file header',
  );
});

/**
 * Every name the banner is reachable under in `text`: the raw literal, plus any
 * `const NAME = '<banner>'` alias. AC-DR-05 hid behind exactly such an alias.
 */
function bannerAliases(text) {
  const aliases = [BANNER];
  const bind = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*['"`]◤ FEED TERMINATED ◢['"`]/g;
  for (const m of text.matchAll(bind)) aliases.push(m[1]);
  return aliases;
}

function sourceFilesUnder(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesUnder(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

test('no gate tests file content against the watcher banner', () => {
  const files = [
    ...sourceFilesUnder(SRC_DIR, ['.ts']),
    ...sourceFilesUnder(path.join(REPO_ROOT, 'bin'), ['.js', '.sh']),
  ];
  const offenders = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(BANNER)) continue;
    const aliases = bannerAliases(text);

    text.split('\n').forEach((line, i) => {
      const t = line.trimStart();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('#')) return;
      // Flag a line that BOTH names the banner and tests content for it —
      // `readFileSync(log).includes(BANNER)`, `grep -q '<banner>' log`. Emitting the
      // banner (`process.stdout.write(...)`) names it without testing, and stays legal.
      const namesBanner = aliases.some((alias) => line.includes(alias));
      const testsContent = line.includes('.includes(') || /\bgrep\b/.test(line);
      if (namesBanner && testsContent) offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}`);
    });
  }

  assert.deepEqual(
    offenders, [],
    `these lines test file content against the watcher banner: ${offenders.join(', ')} — no log a `
    + 'watcher writes can contain it (pane stdout is never teed), so the check is unfalsifiable. '
    + 'It cannot be repaired by making the banner file-visible either: R-MWR-6 reserves it for '
    + 'NORMAL session end, so a working version would false-RED every clean session. Delete the '
    + 'gate (see AC-DR-05 / section-c-still-needed.js in the file header).',
  );
});
