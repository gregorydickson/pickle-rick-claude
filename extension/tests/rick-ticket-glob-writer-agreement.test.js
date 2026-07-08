// @tier: fast
// Regression guard for ticket 8de77691 (R-LTNC Addendum B).
//
// The manager prompt's Step-0 epic-Done detector globs the internal ticket
// artifact filename ("read every <prefix>*.md frontmatter; if every status is
// Done, emit EPIC_COMPLETED"). If that glob prefix ever drifts from the prefix
// the code writers actually emit, the glob matches the EMPTY SET, "every status
// is Done" is vacuously true, and the manager fires a premature EPIC_COMPLETED
// with zero work done. The content greps in the rename tickets prove the string
// `linear_ticket` is gone; they do NOT prove the renamed glob and the renamed
// writer AGREE. This test pins that agreement so a future half-rename (or a
// revert of either rename ticket) goes RED instead of silently self-completing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(EXT_ROOT, 'templates', '_pickle-manager-prompt.md');
const WRITER = path.join(EXT_ROOT, 'src', 'services', 'transaction-ticket-ops.ts');

const ARTIFACT_PREFIX = 'rick_ticket_';
const LEGACY_PREFIX = 'linear_ticket_';

// Extract the `<word>_ticket_` prefix from a `<prefix>*.md` glob.
function globPrefix(text) {
  const m = text.match(/(\w+_ticket_)\*\.md/);
  return m ? m[1] : null;
}
// Extract the `<word>_ticket_` prefix from a `<prefix>${...}.md` template-literal writer.
function writerPrefix(text) {
  const m = text.match(/(\w+_ticket_)\$\{/);
  return m ? m[1] : null;
}

test('manager-prompt epic-Done + listing globs use the current rick_ticket_ prefix', () => {
  const tpl = readFileSync(TEMPLATE, 'utf8');
  // Both runtime globs (:25 epic-Done detector, :208 child listing) must be present.
  assert.match(tpl, /read every rick_ticket_\*\.md frontmatter/,
    'the Step-0 epic-Done detector must glob rick_ticket_*.md');
  assert.match(tpl, /List `rick_ticket_\*\.md` files/,
    'the child-listing step must glob rick_ticket_*.md');
  // No legacy glob may survive — an empty-set glob is the vacuous-completion bug.
  assert.ok(!tpl.includes(LEGACY_PREFIX),
    `manager prompt must not contain ${LEGACY_PREFIX} (empty-set glob -> premature EPIC_COMPLETED)`);
});

test('code writer emits the same rick_ticket_ prefix the manager globs match', () => {
  const writer = readFileSync(WRITER, 'utf8');
  assert.match(writer, /rick_ticket_\$\{/, 'writer default must emit rick_ticket_<id>.md');
  assert.ok(!writer.includes(LEGACY_PREFIX), `writer must not emit the legacy ${LEGACY_PREFIX} prefix`);
});

test('manager glob prefix and code-writer prefix AGREE (no vacuous-completion drift)', () => {
  const tpl = readFileSync(TEMPLATE, 'utf8');
  const writer = readFileSync(WRITER, 'utf8');
  const gp = globPrefix(tpl);
  const wp = writerPrefix(writer);
  assert.ok(gp, 'could not extract a *_ticket_*.md glob prefix from the manager prompt');
  assert.ok(wp, 'could not extract a *_ticket_${...}.md writer prefix from the source');
  assert.equal(gp, wp,
    `manager glob prefix (${gp}) must equal the code-writer prefix (${wp}); a mismatch makes the ` +
    `epic-Done detector read the empty set and fire a premature EPIC_COMPLETED`);
  assert.equal(gp, ARTIFACT_PREFIX, `expected the agreed prefix to be ${ARTIFACT_PREFIX}`);
});
