// @tier: fast
/**
 * R-WSE-4 / AC-WSE-04 — `.claude/commands/send-to-morty.md` MUST contain a reminder
 * against premature `<promise>I AM DONE</promise>` emission. R-PIAP-A2 replaced the
 * hard "ALL six lifecycle phases" mandate with "all phases in the tier's lifecycle set"
 * so the guard is now tier-parameterized.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

describe.each ??= function each(rows) {
  return function runEach(_title, suite) {
    for (const row of rows) {
      describe(String(row), () => suite(row));
    }
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEND_TO_MORTY = path.resolve(__dirname, '..', '..', '.claude', 'commands', 'send-to-morty.md');
const DEPLOYED_SEND_TO_MORTY = path.join(os.homedir(), '.claude', 'commands', 'send-to-morty.md');

test('AC-WSE-04: send-to-morty.md contains the tier-parameterized premature-promise reminder', () => {
  const content = fs.readFileSync(SEND_TO_MORTY, 'utf-8');
  const matches = content.match(/all phases in the tier's lifecycle set/g) || [];
  assert.ok(
    matches.length >= 1,
    `expected ≥1 occurrence of "all phases in the tier's lifecycle set", got ${matches.length}`,
  );
});

test('AC-WSE-04: reminder ties tier-lifecycle phrase to <promise>I AM DONE</promise> guard', () => {
  const content = fs.readFileSync(SEND_TO_MORTY, 'utf-8');
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

// '&' is a single character that can appear incidentally anywhere in the
// template (HTML entities, prose "&", unrelated shell examples), so a bare
// content.includes('&') can never fail — it would pass even if the directive
// stopped naming trailing '&' as forbidden. Every other form is a multi-char
// token unlikely to appear incidentally, so a substring match stays precise.
const FORM_ASSERTIONS = {
  '&': (content) =>
    /no trailing `&`/.test(content),
};

describe.each(BACKGROUNDING_FORMS)(
  'R-MWBG: send-to-morty.md forbids backgrounding form %s for the worker\'s own long commands',
  (form) => {
    test(`names "${form}" as forbidden`, () => {
      const content = fs.readFileSync(SEND_TO_MORTY, 'utf-8');
      const matches = FORM_ASSERTIONS[form] ? FORM_ASSERTIONS[form](content) : content.includes(form);
      assert.ok(
        matches,
        `expected send-to-morty.md to name "${form}" as a forbidden backgrounding form`,
      );
    });
  },
);

test('R-MWBG: send-to-morty.md requires FOREGROUND execution with an explicit large timeout', () => {
  const content = fs.readFileSync(SEND_TO_MORTY, 'utf-8');
  assert.ok(/FOREGROUND/.test(content), 'expected send-to-morty.md to require FOREGROUND execution');
  assert.ok(
    /explicit large `?timeout`?/i.test(content),
    'expected send-to-morty.md to require an explicit large timeout instead of backgrounding',
  );
});

test('R-MWBG: send-to-morty.md deployed copy matches the repo copy', () => {
  assert.ok(fs.existsSync(DEPLOYED_SEND_TO_MORTY), `expected deployed copy to exist at ${DEPLOYED_SEND_TO_MORTY}`);
  const repoContent = fs.readFileSync(SEND_TO_MORTY, 'utf-8');
  const deployedContent = fs.readFileSync(DEPLOYED_SEND_TO_MORTY, 'utf-8');
  assert.equal(deployedContent, repoContent, 'deployed ~/.claude/commands/send-to-morty.md must match the repo copy');
});
