// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { simulateBinaryAbsent } from './helpers/simulate-binary-absent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');

test('audit-trap-door-enforcement exits 0 at HEAD', () => {
  const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test('audit-trap-door-enforcement fails when R-CNAR-7 PATTERN_SHAPE is blanked in fixture CLAUDE.md', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-trap-door-'));

  try {
    const sourcePath = path.join(EXTENSION_ROOT, 'CLAUDE.md');
    const fixturePath = path.join(tmpDir, 'CLAUDE.md');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const fixture = source.replace(
      /(R-CNAR-1 part 2 cap split\)[\s\S]*?)PATTERN_SHAPE:\s*[\s\S]*?(?=\sBREAKS:)/,
      '$1PATTERN_SHAPE: '
    );

    assert.notEqual(fixture, source, 'fixture must remove the PATTERN_SHAPE clause body');
    fs.writeFileSync(fixturePath, fixture);

    const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PATH_OVERRIDE: fixturePath,
      },
    });

    assert.notEqual(result.status, 0, 'audit should fail when PATTERN_SHAPE is blank');
    assert.match(result.stderr, /PATTERN_SHAPE/, `stderr: ${result.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// AC-M4 / B-CIGREEN ROOT A: an unrunnable check (missing `rg`, or any absent tool)
// must FAIL, never print OK. beta.21 CI proved the opposite — `rg: command not
// found` on stderr, yet the audit exited 0. Simulate the exact CI condition (rg
// absent from PATH, everything else present) and assert the audit now fails
// closed with an explicit unrunnable reason instead of silently no-oping.
test('audit-trap-door-enforcement fails closed when rg is absent from PATH (never reports OK)', () => {
  const filteredPath = simulateBinaryAbsent(process.env.PATH || '', 'rg');

  // Only `rg` may go missing. The predecessor simulation deleted the whole directory that resolved
  // it, which on Linux is /usr/bin (with /bin symlinked to it) — so `bash` itself became
  // unresolvable, the audit was never spawned, and every assertion below graded a failed spawn
  // rather than the audit's verdict. Assert the survivors FIRST so that regression reports
  // "bash no longer resolves" instead of passing the rg precondition for the wrong reason.
  for (const bin of ['bash', 'env', 'git']) {
    const probe = spawnSync('bash', ['-c', `command -v ${bin}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: filteredPath },
      timeout: 30_000,
    });
    assert.equal(
      probe.status,
      0,
      `${bin} must still resolve under the simulated-absent PATH (got exit ${probe.status}); ` +
        'without it the audit never runs and this test measures nothing',
    );
  }

  const which = spawnSync('bash', ['-c', 'command -v rg'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: filteredPath },
    timeout: 30_000,
  });
  assert.notEqual(which.status, 0, 'precondition: rg must be unresolvable under the filtered PATH');

  const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: filteredPath },
    timeout: 60_000,
  });

  assert.notEqual(result.status, 0, `audit must FAIL when rg is unrunnable, got exit ${result.status}; stderr: ${result.stderr}`);
  assert.match(
    result.stderr,
    /tool not installed: rg/,
    `stderr must name the unrunnable reason, got: ${result.stderr}`
  );
  assert.doesNotMatch(
    result.stderr,
    /command not found/,
    `a raw shell "command not found" leak means the check no-oped instead of failing closed: ${result.stderr}`
  );
});

// AP-EXT-ITER152-01: the INVARIANT liveness corpus must exclude the sibling wire's
// anchor-absence allowlist.
//
// That allowlist (trap-door-conformance.test.js) exists to spell out, as bare string
// literals, every anchor token that must NOT exist. The sibling excludes itself from its
// own corpus and calls the exclusion load-bearing; this arm did not, so every token the
// sibling declared deliberately-dead read back as LIVE here — and, generally, allowlisting
// a name over there was the act that blinded this gate to it. Measured before the fix: 8
// anchors in src/services/CLAUDE.md resolved SOLELY off those literals and were counted
// among `verified`.
//
// The dead token is DERIVED at run time, never written here as a bare word. Writing one
// into this file would put it in the corpus and revive it — the exact defect under test,
// re-created by its own regression test.
const ANCHOR_ABSENCE_ENUMERATOR = 'extension/tests/trap-door-' + 'conformance.test.js';

/** A token the enumerator declares absent and that occurs in NO other non-markdown tracked file. */
function findTokenLiveOnlyInEnumerator() {
  const repoRoot = path.resolve(EXTENSION_ROOT, '..');
  const enumeratorText = fs.readFileSync(path.join(repoRoot, ANCHOR_ABSENCE_ENUMERATOR), 'utf8');
  const tokens = [...enumeratorText.matchAll(/'[^'\n]*::([A-Za-z_$][A-Za-z0-9_$]*)'/g)].map((m) => m[1]);

  for (const token of tokens) {
    const hits = spawnSync('git', ['grep', '-l', '-w', '-F', '--', token], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (hits.status !== 0 && hits.status !== 1) continue;
    const files = (hits.stdout || '').split('\n').filter(Boolean).filter((f) => !f.endsWith('.md'));
    if (files.length === 1 && files[0] === ANCHOR_ABSENCE_ENUMERATOR) return token;
  }
  return null;
}

function runAuditOverFixtureCatalog(entryLine) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-trap-door-corpus-'));
  try {
    const fixturePath = path.join(tmpDir, 'CLAUDE.md');
    const emptyCatalogRoot = path.join(tmpDir, 'no-subsystems');
    fs.mkdirSync(emptyCatalogRoot);
    fs.writeFileSync(
      fixturePath,
      fs.readFileSync(path.join(EXTENSION_ROOT, 'CLAUDE.md'), 'utf8') + '\n' + entryLine + '\n'
    );

    return spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        CLAUDE_PATH_OVERRIDE: fixturePath,
        SUBSYSTEM_CATALOG_ROOT_OVERRIDE: emptyCatalogRoot,
      },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER152-01 INVARIANT corpus does not resolve a token that only the anchor-absence allowlist spells out', () => {
  const token = findTokenLiveOnlyInEnumerator();
  assert.ok(
    token,
    'precondition: the enumerator must declare at least one token absent from every other ' +
      'non-markdown tracked file, otherwise this test measures nothing'
  );

  const result = runAuditOverFixtureCatalog('- `x.ts` — INVARIANT: `' + token + '` is the anchor.');

  assert.match(
    result.stderr,
    new RegExp('names a symbol nothing in the tree uses: ' + token),
    'a token spelled ONLY in the sibling allowlist must NOT resolve as live; the corpus is ' +
      `resolving it off that allowlist. stderr: ${result.stderr}`
  );
});

test('AP-EXT-ITER152-01 INVARIANT corpus still resolves a genuinely live symbol (exclusion is not a blanket)', () => {
  // Declared in the audit script itself, a tracked non-markdown file that stays in the corpus.
  const liveToken = 'buildSymbolCorpus';
  const result = runAuditOverFixtureCatalog('- `x.ts` — INVARIANT: `' + liveToken + '` is the anchor.');

  assert.doesNotMatch(
    result.stderr,
    new RegExp('names a symbol (?:absent from the tree|nothing in the tree uses): ' + liveToken),
    `excluding the enumerator must not narrow the corpus for live symbols. stderr: ${result.stderr}`
  );
});

test('AP-EXT-ITER153-01 the INVARIANT corpus reads every tracked non-markdown file', () => {
  const withFix = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });

  const trackedNonMarkdown = spawnSync('bash', ['-c', 'git ls-files -z | tr "\\0" "\\n" | grep -cv "\\.md$"'], {
    cwd: path.resolve(EXTENSION_ROOT, '..'),
    encoding: 'utf8',
    timeout: 30_000,
  });

  const reported = /against \d+ symbols in (\d+) tracked file\(s\)/.exec(withFix.stdout);
  assert.ok(reported, `success line must report the corpus file count; stdout: ${withFix.stdout}`);
  assert.equal(
    Number(reported[1]),
    Number(trackedNonMarkdown.stdout.trim()),
    'the corpus is every tracked non-markdown file: AP-EXT-ITER153-01 replaced the ' +
      'per-file exclusion with a per-OCCURRENCE rule, so the enumerator is READ again ' +
      'while the names it only spells still resolve nothing (pin above)'
  );
});

// AP-EXT-ITER153-01: the per-file exclusion was one hand-written path, and the tree held
// more files that spell a name solely to assert it is GONE — including THIS AUDIT's own
// `prunedExports` list, which resolved both of the pruned exports it names (each declared
// MUST-NOT-EXIST by an extension/CLAUDE.md anchor) off the very arm asserting their
// absence. Both wires were blind: the sibling sweep reads *.sh too. The fix stops naming
// files and asks of each OCCURRENCE whether the file USES the name or only SPELLS it.
//
// Those two names are deliberately NOT written anywhere in this file, not even in this
// comment: a comment is stripped from the USE half of the rule but still counts as a
// SPELLING, so naming them here pushes their file cardinality to 2 and defuses the pin
// below. Measured — the first draft of this comment did exactly that.
//
// Same derivation discipline as the pin above: the dead token is read out of the audit
// script at run time. Writing it here as a literal would make THIS file a second speller,
// push the cardinality to 2 and silently defuse the pin.

/** A name the audit's own `prunedExports` list declares absent, spelled nowhere else. */
function findTokenLiveOnlyInAuditScript() {
  const repoRoot = path.resolve(EXTENSION_ROOT, '..');
  const auditRel = 'extension/scripts/audit-trap-door-' + 'enforcement.sh';
  const text = fs.readFileSync(path.join(repoRoot, auditRel), 'utf8');
  const block = /const prunedExports = \[([\s\S]*?)\]/.exec(text);
  if (!block) return null;
  const tokens = [...block[1].matchAll(/'export function ([A-Za-z_$][A-Za-z0-9_$]*)'/g)].map((m) => m[1]);

  for (const token of tokens) {
    const hits = spawnSync('git', ['grep', '-l', '-w', '-F', '--', token], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (hits.status !== 0 && hits.status !== 1) continue;
    const files = (hits.stdout || '').split('\n').filter(Boolean).filter((f) => !f.endsWith('.md'));
    if (files.length === 1 && files[0] === auditRel) return token;
  }
  return null;
}

test('AP-EXT-ITER153-01 a name only the audit\'s own absence-assertion list spells does not resolve as live', () => {
  const token = findTokenLiveOnlyInAuditScript();
  assert.ok(
    token,
    'precondition: the audit\'s prunedExports must declare at least one name absent from ' +
      'every other non-markdown tracked file, otherwise this test measures nothing'
  );

  const result = runAuditOverFixtureCatalog('- `x.ts` — INVARIANT: `' + token + '` is the anchor.');

  assert.match(
    result.stderr,
    new RegExp('names a symbol nothing in the tree uses: ' + token),
    'the arm is resolving the anchor off its OWN list of names that must not exist. ' +
      `stderr: ${result.stderr}`
  );
});

test('AP-EXT-ITER153-01 a symbol the audit script genuinely declares still resolves as live', () => {
  // Declared, not merely spelled, inside the audit script — the file stays in the corpus
  // and must keep answering for what it USES. This is the direction a blanket per-file
  // exclusion would have broken: measured, `isLivenessChannel`, `codeWords` and
  // `TEST_NAME_RE` are all anchored in extension/CLAUDE.md and resolve nowhere else.
  const liveToken = 'isLivenessChannel';
  const result = runAuditOverFixtureCatalog('- `x.ts` — INVARIANT: `' + liveToken + '` is the anchor.');

  assert.doesNotMatch(
    result.stderr,
    new RegExp('names a symbol (?:absent from the tree|nothing in the tree uses): ' + liveToken),
    `a symbol the corpus USES must stay verified. stderr: ${result.stderr}`
  );
});

test('AP-EXT-ITER153-01 a live string-valued name spelled in several files still resolves as live', () => {
  // The cardinality clause is what keeps the spell/use rule from reddening every
  // activity-event name: those exist ONLY as string literals, so they are spelled and
  // never "used" — but they are spelled by a producer, a consumer and a compiled mirror.
  // Drop the `=== 1` and this anchor goes red, which is the mutation this pin catches.
  const eventName = 'worker_gate_red';
  const result = runAuditOverFixtureCatalog('- `x.ts` — INVARIANT: `' + eventName + '` is the anchor.');

  assert.doesNotMatch(
    result.stderr,
    new RegExp('names a symbol (?:absent from the tree|nothing in the tree uses): ' + eventName),
    'a literal-only name spelled by more than one file is live, not spelled-only. ' +
      `stderr: ${result.stderr}`
  );
});
