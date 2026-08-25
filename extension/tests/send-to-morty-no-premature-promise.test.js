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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe.each ??= function each(rows) {
  return function runEach(_title, suite) {
    for (const row of rows) {
      describe(String(row), () => suite(row));
    }
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

test('R-MWBG: send-to-morty.md deployed copy matches the repo copy', (t) => {
  // CI checks out the repo but never runs `bash install.sh`, so no deploy root
  // exists at ~/.claude/commands/ there — this assertion is structurally
  // unsatisfiable in CI (belongs with extension-wiring deploy-smoke instead).
  // Explicit named skip, not a vacuous `continue`: the assertion below still
  // runs — and can still fail — on any host where the deploy root IS present
  // (see the negative-proof test immediately below).
  if (!fs.existsSync(DEPLOYED_SEND_TO_MORTY)) {
    t.skip(`deploy root absent: ${DEPLOYED_SEND_TO_MORTY} (no ~/.claude/commands/ — expected in CI)`);
    return;
  }
  const repoContent = fs.readFileSync(SEND_TO_MORTY, 'utf-8');
  const deployedContent = fs.readFileSync(DEPLOYED_SEND_TO_MORTY, 'utf-8');
  assert.equal(deployedContent, repoContent, 'deployed ~/.claude/commands/send-to-morty.md must match the repo copy');
});

test('R-MWBG negative proof: a present-but-mutated deployed copy still fails the assertion', () => {
  // Proves the skip above is not a disguised vacuous pass: point HOME at a
  // fixture with a deliberately mutated deployed copy and confirm the
  // assertion test — run as a real child process, so os.homedir() re-resolves
  // against the fixture HOME — fails rather than silently skipping again.
  const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rmwbg-'));
  try {
    const commandsDir = path.join(fixtureHome, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    const repoContent = fs.readFileSync(SEND_TO_MORTY, 'utf-8');
    fs.writeFileSync(path.join(commandsDir, 'send-to-morty.md'), `${repoContent}\nMUTATED BY NEGATIVE PROOF FIXTURE\n`);

    const result = spawnSync(
      process.execPath,
      // Scope to the single deploy-parity test by name: this file's OWN
      // negative-proof test also spawns a child, so running the whole file
      // here would recurse (and eventually time out) instead of proving
      // anything.
      ['--test', '--test-name-pattern=R-MWBG: send-to-morty\\.md deployed copy matches the repo copy', __filename],
      {
        encoding: 'utf-8',
        // NODE_TEST_CONTEXT is set by the OUTER `node --test` harness running
        // this very file; inheriting it makes the child believe it's a
        // harness-managed subtest (IPC reporting, always-0 exit) instead of a
        // standalone run, which is what makes this negative proof meaningful.
        env: { ...process.env, HOME: fixtureHome, NODE_TEST_CONTEXT: undefined },
        timeout: 60_000,
      },
    );

    assert.notEqual(result.signal, 'SIGTERM', 'child test run timed out (60s) instead of completing');
    assert.notEqual(result.status, 0, 'expected the child test run to FAIL against a mutated deployed copy under fixture HOME');
    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.match(
      combined,
      /deployed ~\/\.claude\/commands\/send-to-morty\.md must match the repo copy/,
      'expected the deploy-parity assertion failure message in the child run output',
    );
  } finally {
    fs.rmSync(fixtureHome, { recursive: true, force: true });
  }
});
