// @tier: fast
// AC-O2 / P1 (GitHub #26): audit-acceptance-assertion-coverage.sh measures three named corpora —
// override (deterministic, exact-pair floor), the auto-discovered session corpus (ratio lower-bound floor),
// and the git-index fallback (deterministic, exact-pair floor, used only when no sessions exist).
// The floors are READ from the committed JSON; each arm moves ONE count relative to an at-floor control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const EXTENSION_ROOT = path.resolve(import.meta.dirname, '..');
const AUDIT_SCRIPT = path.join(EXTENSION_ROOT, 'scripts', 'audit-acceptance-assertion-coverage.sh');
const FLOOR = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, 'scripts', 'acceptance-assertion-coverage-floor.json'), 'utf8'));

const GUARDED = '# Ticket\n\n## Acceptance Criteria\n- [ ] `true` exits 0\n';
const UNGUARDED = '# Ticket\n\n### Acceptance criteria\n- [ ] the change behaves as described\n';
const NO_SECTION = '# Ticket\n\n## Description\n- `true` exits 0 but this is not a criteria section\n';
const EMPTY_SECTION = '# Ticket\n\n## Acceptance Criteria\n\n## Notes\n- `true` exits 0\n';

/** A corpus of `total` sectioned tickets, `guarded` of them carrying an executable assertion. */
function corpus(guarded, total) {
  return Array.from({ length: total }, (_, i) => (i < guarded ? GUARDED : UNGUARDED));
}

function writeTickets(root, tickets) {
  tickets.forEach((content, i) => {
    const dir = path.join(root, `t${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rick_ticket_${String(i).padStart(8, '0')}.md`), content);
  });
}

/** Drives the override corpus path (deterministic, exact-pair git_index floor). */
function runAudit(tickets) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-coverage-')));
  try {
    writeTickets(root, tickets);
    const result = spawnSync('bash', [AUDIT_SCRIPT], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, ACCEPTANCE_COVERAGE_ROOT_OVERRIDE: root },
    });
    assert.equal(result.error, undefined, `audit did not run: ${result.error}`);
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Env for the auto-discovery path: PICKLE_DATA_ROOT points getDataRoot() at `dataRoot`,
 * ACCEPTANCE_COVERAGE_ROOT_OVERRIDE is absent (not merely empty) so precedence falls through to session
 * discovery.
 */
function autoDiscoverEnv(dataRoot) {
  const env = { ...process.env, PICKLE_DATA_ROOT: dataRoot };
  delete env.ACCEPTANCE_COVERAGE_ROOT_OVERRIDE;
  delete env.PICKLE_DATA_DIR;
  delete env.EXTENSION_DIR;
  return env;
}

/** Drives the auto-discovery path. `tickets === null` builds no sessions dir at all (git-index fallback case). */
function runAuditAutoDiscover(tickets) {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-coverage-dataroot-')));
  try {
    if (tickets !== null) {
      writeTickets(path.join(dataRoot, 'sessions', 'sess1'), tickets);
    }
    const result = spawnSync('bash', [AUDIT_SCRIPT], { encoding: 'utf8', timeout: 60000, env: autoDiscoverEnv(dataRoot) });
    assert.equal(result.error, undefined, `audit did not run: ${result.error}`);
    return result;
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

test('precondition: the recorded git_index floor admits a below and an above arm', () => {
  const gi = FLOOR.git_index;
  assert.ok(gi.numerator >= 1 && gi.numerator < gi.denominator, JSON.stringify(gi));
});

test('precondition: the recorded session_min_ratio floor admits a below arm', () => {
  const sr = FLOOR.session_min_ratio;
  assert.ok(sr.numerator >= 1 && sr.numerator < sr.denominator, JSON.stringify(sr));
});

test('control: a corpus measuring exactly the recorded git_index floor passes and prints the figure', () => {
  const gi = FLOOR.git_index;
  const result = runAudit(corpus(gi.numerator, gi.denominator));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`measured ${gi.numerator}/${gi.denominator} guarded`));
  assert.match(result.stdout, /override corpus at/);
});

test('below floor: one fewer guarded ticket fails', () => {
  const gi = FLOOR.git_index;
  const result = runAudit(corpus(gi.numerator - 1, gi.denominator));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /below floor/);
});

test('above floor: one more guarded ticket fails and names the floor to write', () => {
  const gi = FLOOR.git_index;
  const result = runAudit(corpus(gi.numerator + 1, gi.denominator));
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`raise the floor: .*write numerator ${gi.numerator + 1}, denominator ${gi.denominator}\\b`));
});

test('O2-3: tickets with no section or an empty section are excluded from the denominator', () => {
  const gi = FLOOR.git_index;
  const result = runAudit([...corpus(gi.numerator, gi.denominator), NO_SECTION, EMPTY_SECTION]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${gi.denominator + 2} tickets scanned, measured ${gi.numerator}/${gi.denominator} guarded`));
});

test('nothing measured is not clean: an empty corpus fails with a named reason', () => {
  const result = runAudit([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nothing measured is not clean/);
  assert.match(result.stderr, /UNMEASURED/);
  assert.equal(result.stdout, '');
});

test('nothing measured is not clean: a corpus with no sections fails', () => {
  const result = runAudit([NO_SECTION, EMPTY_SECTION]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nothing measured is not clean/);
});

test('O2-5 mutation: stripping the backticks from a guarded ticket reds the at-floor corpus', () => {
  const gi = FLOOR.git_index;
  const tickets = corpus(gi.numerator, gi.denominator);
  tickets[0] = tickets[0].replaceAll('`', '');
  const result = runAudit(tickets);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /below floor/);
});

// AC-P1-1: with a data root containing session tickets, the verdict line names the session corpus and its
// path, and the run exits 0 against the recorded (raise-only, lower-bound) session floor.
test('AC-P1-1: an auto-discovered session corpus at or above the floor names the session corpus and passes', () => {
  const sr = FLOOR.session_min_ratio;
  const result = runAuditAutoDiscover(corpus(sr.numerator, sr.denominator));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /session corpus at .*sessions/);
  assert.match(result.stdout, new RegExp(`measured ${sr.numerator}/${sr.denominator} guarded`));
});

// AC-P1-2: with no sessions under the data root, the output NAMES the git-index fallback and why — every
// fallback path prints the notice, independent of what the git-index scan itself then measures.
test('AC-P1-2: no sessions under the data root falls back to the git index and names why', () => {
  const result = runAuditAutoDiscover(null);
  const combined = result.stdout + result.stderr;
  assert.match(combined, /falling back to git index/);
  assert.match(combined, /no sessions under/);
});

// AC-P1-3 (load-bearing falsifying control): the measured fraction over the auto-discovered session corpus
// tracks the corpus's actual on-disk content — breaking the assertion form in one ticket changes the
// measured numerator.
test('AC-P1-3: breaking the assertion form in a session-corpus ticket changes the measured fraction', () => {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-coverage-dataroot-')));
  try {
    const tickets = corpus(4, 5);
    writeTickets(path.join(dataRoot, 'sessions', 'sess1'), tickets);
    const env = { ...process.env, PICKLE_DATA_ROOT: dataRoot };
    delete env.ACCEPTANCE_COVERAGE_ROOT_OVERRIDE;
    delete env.PICKLE_DATA_DIR;
    delete env.EXTENSION_DIR;

    const before = spawnSync('bash', [AUDIT_SCRIPT], { encoding: 'utf8', timeout: 60000, env });
    assert.match(before.stdout, /measured 4\/5 guarded/, before.stdout + before.stderr);

    const guardedTicketPath = path.join(dataRoot, 'sessions', 'sess1', 't0', 'rick_ticket_00000000.md');
    fs.writeFileSync(guardedTicketPath, tickets[0].replaceAll('`', ''));

    const after = spawnSync('bash', [AUDIT_SCRIPT], { encoding: 'utf8', timeout: 60000, env });
    assert.notEqual(before.stdout, after.stdout);
    assert.match(after.stdout, /measured 3\/5 guarded/, after.stdout + after.stderr);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// AC-P1-4 (over-trigger control): a corpus whose tickets carry zero acceptance sections is reported
// UNMEASURED by name, never as 0% coverage and never as below-floor.
test('AC-P1-4: a session corpus with no acceptance sections is UNMEASURED, not 0% or below-floor', () => {
  const result = runAuditAutoDiscover([NO_SECTION, EMPTY_SECTION]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNMEASURED/);
  assert.doesNotMatch(result.stderr, /below floor/);
  assert.doesNotMatch(result.stderr, /0%/);
});

// AC-P1-5: the recorded session floor is a ratio lower bound — a measured value below it still refuses.
test('AC-P1-5: a session corpus below the recorded ratio floor refuses', () => {
  const sr = FLOOR.session_min_ratio;
  assert.ok(sr.numerator >= 1, 'floor numerator must be >= 1 to construct a below-floor arm');
  const result = runAuditAutoDiscover(corpus(sr.numerator - 1, sr.denominator));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /below floor/);
  assert.match(result.stderr, /session corpus at/);
});

// The session floor is lower-bound-only: measuring ABOVE it must not trigger a forced "raise the floor".
test('session ratio floor: measuring above the recorded ratio still passes (no forced raise)', () => {
  const sr = FLOOR.session_min_ratio;
  const result = runAuditAutoDiscover(corpus(sr.denominator, sr.denominator));
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /raise the floor/);
});
