// @tier: fast
/**
 * R-WSE-4 / AC-WSE-04 — `.claude/commands/send-to-morty.md` MUST contain a reminder
 * against premature `<promise>I AM DONE</promise>` emission. R-PIAP-A2 replaced the
 * hard "ALL six lifecycle phases" mandate with "all phases in the tier's lifecycle set"
 * so the guard is now tier-parameterized.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeEach } from './helpers/describe-each.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SEND_TO_MORTY = path.resolve(__dirname, '..', '..', '.claude', 'commands', 'send-to-morty.md');
const content = fs.readFileSync(SEND_TO_MORTY, 'utf-8');

test('AC-WSE-04: send-to-morty.md contains the tier-parameterized premature-promise reminder', () => {
  const matches = content.match(/all phases in the tier's lifecycle set/g) || [];
  assert.ok(
    matches.length >= 1,
    `expected ≥1 occurrence of "all phases in the tier's lifecycle set", got ${matches.length}`,
  );
});

test('AC-WSE-04: reminder ties tier-lifecycle phrase to <promise>I AM DONE</promise> guard', () => {
  const reminderRe = /Do NOT emit[^.]{0,300}I AM DONE[^.]{0,300}tier's lifecycle set/s;
  assert.ok(
    reminderRe.test(content),
    'reminder must connect "Do NOT emit ... I AM DONE" with "tier\'s lifecycle set"',
  );
});

/**
 * R-MWBG (worker command discipline) — the worker's OWN long-running commands
 * (test tiers, gates, builds) must never be backgrounded, reusing the exact
 * discipline shape `extension/templates/_pickle-manager-prompt.md:155` already
 * applies to the manager's `spawn-morty.js` invocation.
 */
const BACKGROUNDING_FORMS = ['run_in_background', '&', 'nohup', 'setsid', 'disown'];

describeEach(BACKGROUNDING_FORMS)(
  'R-MWBG: send-to-morty.md forbids backgrounding form %s for the worker\'s own long commands',
  (form) => {
    test(`names "${form}" as forbidden`, () => {
      // '&' is a single character that can appear incidentally anywhere in the
      // template (HTML entities, prose "&", unrelated shell examples), so a bare
      // content.includes('&') can never fail — it would pass even if the directive
      // stopped naming trailing '&' as forbidden. Every other form is a multi-char
      // token unlikely to appear incidentally, so a substring match stays precise.
      const matches = form === '&' ? /no trailing `&`/.test(content) : content.includes(form);
      assert.ok(
        matches,
        `expected send-to-morty.md to name "${form}" as a forbidden backgrounding form`,
      );
    });
  },
);

test('R-MWBG: send-to-morty.md requires FOREGROUND execution with an explicit large timeout', () => {
  assert.ok(/FOREGROUND/.test(content), 'expected send-to-morty.md to require FOREGROUND execution');
  assert.ok(
    /explicit large `?timeout`?/i.test(content),
    'expected send-to-morty.md to require an explicit large timeout instead of backgrounding',
  );
});

/**
 * AC-2 (R-MWBG-LONGCMD) — a worker whose long command is cut must leave an
 * attributable line in `worker_session_*.log`, so the repeated
 * `exit:0` + `validation: failed` + clean-tree signature is diagnosable in ONE
 * read instead of being inferred from an empty diff.
 *
 * spawn-morty pipes the worker's own stdout into
 * `worker_session_<pid>.log` (`src/bin/spawn-morty.ts` — `sessionLogPath` at
 * :436, `fs.createWriteStream` at :3628), so a directive telling the worker to
 * echo a marker is what puts the line in that file.
 */
test('AC-2: send-to-morty.md names the R-MWBG-LONGCMD marker', () => {
  assert.ok(
    content.includes('R-MWBG-LONGCMD'),
    'expected send-to-morty.md to name the R-MWBG-LONGCMD attributable marker',
  );
});

test('AC-2: the marker is emitted BEFORE the long command, so a cut leaves start-without-done', () => {
  // The start/done asymmetry IS the diagnostic: a `done` marker alone would be
  // emitted only on the paths that already completed, which are exactly the
  // ones that never needed diagnosing. Assert both halves are specified.
  assert.ok(
    /R-MWBG-LONGCMD start:/.test(content),
    'expected a "R-MWBG-LONGCMD start:" marker emitted before the command runs',
  );
  assert.ok(
    /R-MWBG-LONGCMD done:/.test(content),
    'expected a "R-MWBG-LONGCMD done:" marker emitted after the command returns',
  );
  const startIdx = content.indexOf('R-MWBG-LONGCMD start:');
  const doneIdx = content.indexOf('R-MWBG-LONGCMD done:');
  assert.ok(
    startIdx < doneIdx,
    'the start marker must be documented before the done marker (a cut leaves start with no done)',
  );
});

test('AC-2: the directive ties the marker to worker_session logs and the stall signature', () => {
  assert.ok(
    /worker_session/.test(content),
    'expected the directive to name worker_session_<pid>.log as where the markers land',
  );
  assert.ok(
    /exit:0/.test(content) && /validation: failed/.test(content),
    'expected the directive to name the exit:0 + validation: failed signature it makes diagnosable',
  );
});
