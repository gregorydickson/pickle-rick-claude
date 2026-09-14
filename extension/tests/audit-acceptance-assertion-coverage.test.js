// @tier: fast
// AC-O2: audit-acceptance-assertion-coverage.sh runs against temp-dir ticket corpora, never the real git index.
// The floor is READ from the committed JSON; each arm moves ONE count relative to the at-floor control.
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

function runAudit(tickets) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-coverage-')));
  try {
    tickets.forEach((content, i) => {
      const dir = path.join(root, `t${i}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, `rick_ticket_${String(i).padStart(8, '0')}.md`), content);
    });
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

test('precondition: the recorded floor admits a below and an above arm', () => {
  assert.ok(FLOOR.numerator >= 1 && FLOOR.numerator < FLOOR.denominator, JSON.stringify(FLOOR));
});

test('control: a corpus measuring exactly the recorded floor passes and prints the figure', () => {
  const result = runAudit(corpus(FLOOR.numerator, FLOOR.denominator));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`measured ${FLOOR.numerator}/${FLOOR.denominator} guarded`));
});

test('below floor: one fewer guarded ticket fails', () => {
  const result = runAudit(corpus(FLOOR.numerator - 1, FLOOR.denominator));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /below floor/);
});

test('above floor: one more guarded ticket fails and names the floor to write', () => {
  const result = runAudit(corpus(FLOOR.numerator + 1, FLOOR.denominator));
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`raise the floor: .*write numerator ${FLOOR.numerator + 1}, denominator ${FLOOR.denominator}\\b`));
});

test('O2-3: tickets with no section or an empty section are excluded from the denominator', () => {
  const result = runAudit([...corpus(FLOOR.numerator, FLOOR.denominator), NO_SECTION, EMPTY_SECTION]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${FLOOR.denominator + 2} tickets scanned, measured ${FLOOR.numerator}/${FLOOR.denominator} guarded`));
});

test('nothing measured is not clean: an empty corpus fails with a named reason', () => {
  const result = runAudit([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nothing measured is not clean/);
  assert.equal(result.stdout, '');
});

test('nothing measured is not clean: a corpus with no sections fails', () => {
  const result = runAudit([NO_SECTION, EMPTY_SECTION]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nothing measured is not clean/);
});

test('O2-5 mutation: stripping the backticks from a guarded ticket reds the at-floor corpus', () => {
  const tickets = corpus(FLOOR.numerator, FLOOR.denominator);
  tickets[0] = tickets[0].replaceAll('`', '');
  const result = runAudit(tickets);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /below floor/);
});
