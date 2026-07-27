// @tier: integration
//
// B-GITATTR WS-1 (AC-GA-1, AC-GA-2, AC-GA-4, AC-GA-5): proves the materialized
// prepare-commit-msg hook stamps `Pickle-Ticket: <id>` from `PICKLE_TICKET_ID`,
// idempotently, and that pointing `core.hooksPath` at the managed dir via an
// ephemeral GIT_CONFIG_* env override never mutates the target repo's own
// git config. Drives real `git commit` against real temp repos — see
// tests/integration/start-commit-pinned-sha.test.js for the established
// tmpRoot/initGitRepo/execFileSync pattern this file follows.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { materializeTrailerHooks } from '../../services/git-trailer-hooks.js';

// Hang guard, not a perf assertion (extension/CLAUDE.md serial-manifest hygiene) — this
// file is already serialized via tests/integration/.serial-tests.json.
const GIT_TIMEOUT_MS = 15_000;

function git(args, dir, env) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    env: env ?? process.env,
  });
}

// Every tmpRoot is registered and reclaimed, per the ticket's isolation expectation ("each test's
// temp repo created AND removed"). Registration happens HERE rather than at the call sites because
// the managed-hooks callers do `path.join(tmpRoot(...), 'hooks')` and discard the parent path — the
// only place that still holds it is this function.
const TMP_ROOTS = new Set();

function tmpRoot(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  TMP_ROOTS.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TMP_ROOTS) fs.rmSync(dir, { recursive: true, force: true });
  TMP_ROOTS.clear();
});

function initGitRepo(dir) {
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.local'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  git(['add', '-A'], dir);
  git(['commit', '--no-gpg-sign', '-q', '-m', 'baseline'], dir);
}

function hooksPathEnv(managedDir, extra) {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: managedDir,
    ...extra,
  };
}

function trailerValue(dir) {
  return git(
    ['log', '-1', "--format=%(trailers:key=Pickle-Ticket,valueonly)"],
    dir,
  ).trim();
}

test('gitattr trailer producer', async (t) => {
  await t.test('commit with PICKLE_TICKET_ID set yields exactly one Pickle-Ticket trailer', () => {
    const repoRoot = tmpRoot('gitattr-trailer-');
    const managedDir = path.join(tmpRoot('gitattr-managed-'), 'hooks');
    initGitRepo(repoRoot);

    const materialized = materializeTrailerHooks({ repoRoot, managedDir });
    assert.equal(materialized.ok, true);

    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    const env = hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'a3c75c96' });
    git(['commit', '--no-gpg-sign', '-q', '-m', 'audit: [HIGH] cross-ref — no hash'], repoRoot, env);

    assert.equal(trailerValue(repoRoot), 'a3c75c96');
  });

  await t.test('a message already carrying the trailer stays at trailer count 1', () => {
    const repoRoot = tmpRoot('gitattr-trailer-idem-');
    const managedDir = path.join(tmpRoot('gitattr-managed-idem-'), 'hooks');
    initGitRepo(repoRoot);

    const materialized = materializeTrailerHooks({ repoRoot, managedDir });
    assert.equal(materialized.ok, true);

    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    const env = hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'b1d2e3f4' });
    git(
      ['commit', '--no-gpg-sign', '-q', '-m', 'fix: pre-stamped\n\nPickle-Ticket: b1d2e3f4'],
      repoRoot,
      env,
    );

    const body = git(['log', '-1', '--format=%B'], repoRoot);
    const occurrences = (body.match(/^Pickle-Ticket:/gm) ?? []).length;
    assert.equal(occurrences, 1);
    assert.equal(trailerValue(repoRoot), 'b1d2e3f4');
  });

  await t.test('no PICKLE_TICKET_ID leaves the message byte-identical and trailer-less', () => {
    const repoRoot = tmpRoot('gitattr-trailer-noenv-');
    const managedDir = path.join(tmpRoot('gitattr-managed-noenv-'), 'hooks');
    initGitRepo(repoRoot);

    const materialized = materializeTrailerHooks({ repoRoot, managedDir });
    assert.equal(materialized.ok, true);

    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    const env = hooksPathEnv(managedDir);
    delete env.PICKLE_TICKET_ID;
    const subject = 'chore: no ticket env set';
    git(['commit', '--no-gpg-sign', '-q', '-m', subject], repoRoot, env);

    const body = git(['log', '-1', '--format=%B'], repoRoot).replace(/\n+$/, '');
    assert.equal(body, subject);
    assert.equal(trailerValue(repoRoot), '');
  });

  await t.test('the target repo itself is never mutated (core.hooksPath stays absent)', () => {
    const repoRoot = tmpRoot('gitattr-trailer-unmutated-');
    const managedDir = path.join(tmpRoot('gitattr-managed-unmutated-'), 'hooks');
    initGitRepo(repoRoot);

    const materialized = materializeTrailerHooks({ repoRoot, managedDir });
    assert.equal(materialized.ok, true);

    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    const env = hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'c5d6e7f8' });
    git(['commit', '--no-gpg-sign', '-q', '-m', 'chore: check repo untouched'], repoRoot, env);

    assert.throws(() => {
      git(['config', '--local', '--get', 'core.hooksPath'], repoRoot);
    });
  });
});

// --- Self-reference under a NESTED spawn (ticket 8f7e1cf2, P0) ---
//
// A spawn nested inside one that already carries the WS-1 env fragment inherits it, and
// `git config --get core.hooksPath` HONORS `GIT_CONFIG_*` from the environment. So the second
// materialization resolves the "pre-existing" hooks dir to the MANAGED dir itself and rewrites
// every hook to `exec <itself>` — an infinite exec loop that hangs the commit forever. That is
// the ordinary manager -> spawn-morty path (same sessionDir, hence same managedDir), not an
// exotic one.

/** Re-materialize the way a nested spawn does: our own fragment already in the ambient env. */
function materializeNested(repoRoot, managedDir) {
  const saved = {
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
  };
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
  process.env.GIT_CONFIG_VALUE_0 = managedDir;
  try {
    return materializeTrailerHooks({ repoRoot, managedDir });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function selfExecingHooks(managedDir) {
  return fs
    .readdirSync(managedDir)
    .filter((name) =>
      fs.readFileSync(path.join(managedDir, name), 'utf-8').includes(`exec '${managedDir}/${name}'`),
    );
}

test('gitattr trailer producer — nested spawn self-reference', async (t) => {
  await t.test('a nested materialization never rewrites a hook into exec-itself', () => {
    const repoRoot = tmpRoot('gitattr-nested-');
    const managedDir = path.join(tmpRoot('gitattr-nested-managed-'), 'hooks');
    initGitRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });

    assert.equal(materializeTrailerHooks({ repoRoot, managedDir }).ok, true);
    const pass1 = fs.readFileSync(path.join(managedDir, 'prepare-commit-msg'), 'utf-8');

    assert.equal(materializeNested(repoRoot, managedDir).ok, true);

    assert.deepEqual(selfExecingHooks(managedDir), []);
    // Pass 2 is a no-op on content: the same repo yields the same hooks.
    assert.equal(fs.readFileSync(path.join(managedDir, 'prepare-commit-msg'), 'utf-8'), pass1);
  });

  await t.test('a nested materialization still forwards the repo\'s real hook', () => {
    const repoRoot = tmpRoot('gitattr-nested-fwd-');
    const managedDir = path.join(tmpRoot('gitattr-nested-fwd-managed-'), 'hooks');
    initGitRepo(repoRoot);
    const realHook = path.join(repoRoot, '.git/hooks/pre-commit');
    fs.writeFileSync(realHook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    assert.equal(materializeTrailerHooks({ repoRoot, managedDir }).ok, true);
    assert.equal(materializeNested(repoRoot, managedDir).ok, true);

    // Discarding the self-match must fall THROUGH to .git/hooks, not bail out — otherwise a
    // nested spawn silently loses the repo's own hooks along with the self-exec loop.
    const stub = fs.readFileSync(path.join(managedDir, 'pre-commit'), 'utf-8');
    assert.equal(stub.includes(`exec '${realHook}'`), true);
  });

  await t.test('a commit after a nested materialization terminates and still stamps', () => {
    const repoRoot = tmpRoot('gitattr-nested-commit-');
    const managedDir = path.join(tmpRoot('gitattr-nested-commit-managed-'), 'hooks');
    initGitRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });

    assert.equal(materializeTrailerHooks({ repoRoot, managedDir }).ok, true);
    assert.equal(materializeNested(repoRoot, managedDir).ok, true);

    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    // The outcome-level assertion: the pre-fix body hangs here until GIT_TIMEOUT_MS kills it.
    git(
      ['commit', '--no-gpg-sign', '-q', '-m', 'fix: nested spawn'],
      repoRoot,
      hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'nested01' }),
    );

    assert.equal(trailerValue(repoRoot), 'nested01');
  });

  await t.test('git *.sample hooks are not forwarded', () => {
    const repoRoot = tmpRoot('gitattr-samples-');
    const managedDir = path.join(tmpRoot('gitattr-samples-managed-'), 'hooks');
    initGitRepo(repoRoot);

    assert.equal(materializeTrailerHooks({ repoRoot, managedDir }).ok, true);

    assert.deepEqual(fs.readdirSync(managedDir).filter((n) => n.endsWith('.sample')), []);
  });
});

// --- Idempotence across the `--trailer` FLAG, not just an in-message trailer (R-GTDT) ---
//
// The AC-GA-2 case above pre-stamps the trailer inside `-m`, so the hook sees it and no-ops. That
// shape cannot catch the one observed live: commit `271587ae` in session 2026-07-26-013335ff landed
// TWO Pickle-Ticket trailers because the worker used `git commit --trailer` while PICKLE_TICKET_ID
// was also set. Git applies `--trailer` via interpret-trailers AFTER prepare-commit-msg runs, so the
// hook's `^Pickle-Ticket:` guard would inspect a message not yet containing the flag's value and
// append a second one. AC-GA-1 says exactly one trailer; only this ordering exercises that.
//
// The two values are deliberately DIFFERENT, reproducing 271587ae's exact signature
// (`a026c5cc` + `ticket-model-recovered-off`). Same-value inputs cannot fail this: git's default
// `trailer.ifExists = addIfDifferentNeighbor` silently swallows an identical adjacent trailer, so a
// same-value case stays green even with the idempotence guard deleted — it proves nothing.
test('gitattr trailer producer — a --trailer flag and a DIFFERENT PICKLE_TICKET_ID stamp only once', () => {
  const repoRoot = tmpRoot('gitattr-flag-idem-');
  const managedDir = path.join(tmpRoot('gitattr-flag-idem-managed-'), 'hooks');
  initGitRepo(repoRoot);

  assert.equal(materializeTrailerHooks({ repoRoot, managedDir }).ok, true);

  fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
  git(['add', '-A'], repoRoot);
  git(
    ['commit', '--no-gpg-sign', '-q', '-m', 'fix: worker used the flag', '--trailer', 'Pickle-Ticket: a026c5cc'],
    repoRoot,
    hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'ticket-model-recovered-off' }),
  );

  const body = git(['log', '-1', '--format=%B'], repoRoot);
  const occurrences = (body.match(/^Pickle-Ticket:/gm) ?? []).length;
  assert.equal(
    occurrences,
    1,
    `exactly one Pickle-Ticket trailer must survive — live commit 271587ae carried two, the second ` +
    `a non-ticket string. Found ${occurrences}:\n${body}`,
  );
  assert.equal(
    trailerValue(repoRoot),
    'a026c5cc',
    'the message\'s own trailer wins; the hook must no-op rather than overwrite or duplicate',
  );
});

// --- Pre-existing trailers survive the stamp (ticket b34ec6d7 Finding 1, CRITICAL) ---

test('gitattr trailer producer — stamping does not orphan a pre-existing trailer', () => {
  const repoRoot = tmpRoot('gitattr-coexist-');
  const managedDir = path.join(tmpRoot('gitattr-coexist-managed-'), 'hooks');
  initGitRepo(repoRoot);

  assert.equal(materializeTrailerHooks({ repoRoot, managedDir }).ok, true);

  // git parses trailers out of the LAST paragraph only. A `printf '\nPickle-Ticket: …'`
  // append opens a NEW paragraph, demoting this Co-Authored-By to body prose — it stays
  // present in %B, so only %(trailers:…) can see the damage. Asserting on %B here would
  // false-PASS against the very bug this pins.
  fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
  git(['add', '-A'], repoRoot);
  git(
    [
      'commit', '--no-gpg-sign', '-q',
      '-m', 'feat: work that already credits a co-author\n\nCo-Authored-By: Someone <someone@example.com>',
    ],
    repoRoot,
    hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'b34ec6d7' }),
  );

  const coAuthor = git(
    ['log', '-1', '--format=%(trailers:key=Co-Authored-By,valueonly)'],
    repoRoot,
  ).trim();

  assert.equal(coAuthor, 'Someone <someone@example.com>', 'the pre-existing trailer must still parse');
  assert.equal(trailerValue(repoRoot), 'b34ec6d7', 'and ours must parse alongside it');
});

// --- unset / empty / whitespace all no-op identically (ticket b34ec6d7 Finding 2, HIGH) ---

test('gitattr trailer producer — a whitespace-only ticket id no-ops like unset and empty', () => {
  const subject = 'chore: blank-ish ticket env';

  // `[ -z "$PICKLE_TICKET_ID" ]` is FALSE for "   ", so the whitespace case used to stamp a
  // valueless `Pickle-Ticket:` line. %(trailers:…) reports '' for that line just as it does
  // for a clean no-op, so it cannot tell the two apart — assert on %B, which can.
  for (const [label, id] of [['unset', undefined], ['empty', ''], ['whitespace', '   '], ['tab/newline', '\t\n ']]) {
    const repoRoot = tmpRoot('gitattr-blank-');
    const managedDir = path.join(tmpRoot('gitattr-blank-managed-'), 'hooks');
    initGitRepo(repoRoot);

    assert.equal(materializeTrailerHooks({ repoRoot, managedDir }).ok, true);

    fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
    git(['add', '-A'], repoRoot);
    const env = hooksPathEnv(managedDir);
    if (id === undefined) delete env.PICKLE_TICKET_ID;
    else env.PICKLE_TICKET_ID = id;
    git(['commit', '--no-gpg-sign', '-q', '-m', subject], repoRoot, env);

    const body = git(['log', '-1', '--format=%B'], repoRoot).replace(/\n+$/, '');
    assert.equal(body, subject, `${label}: the message must be byte-identical`);
    assert.equal(trailerValue(repoRoot), '', `${label}: no trailer value`);
  }
});

// --- Shell-injection guard (ticket 8f7e1cf2 Test Expectations) ---

test('gitattr trailer producer — a ticket id cannot break out of the hook script', () => {
  const repoRoot = tmpRoot('gitattr-inject-');
  const managedDir = path.join(tmpRoot('gitattr-inject-managed-'), 'hooks');
  const marker = path.join(tmpRoot('gitattr-inject-marker-'), `pwned-${process.pid}`);
  initGitRepo(repoRoot);

  assert.equal(materializeTrailerHooks({ repoRoot, managedDir }).ok, true);

  // The id never reaches the script as source: it travels by env and is consumed as a
  // single argv token (`git interpret-trailers --trailer "Pickle-Ticket: $PICKLE_TICKET_ID"`,
  // or `printf '%s'` on the fallback arm). Either way a payload that would break out of an
  // interpolated form stays inert.
  const hostileId = `abc'; touch ${marker}; #`;
  fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
  git(['add', '-A'], repoRoot);
  git(
    ['commit', '--no-gpg-sign', '-q', '-m', 'chore: hostile ticket id'],
    repoRoot,
    hooksPathEnv(managedDir, { PICKLE_TICKET_ID: hostileId }),
  );

  assert.equal(fs.existsSync(marker), false, 'injected command must not execute');
  assert.equal(trailerValue(repoRoot), hostileId, 'the id must land literally');
});

// --- AP-EXT-ITER2-01: the idempotence guard must read the CONSUMER's oracle ---

// The guard used to be a whole-file `grep '^Pickle-Ticket:'`. git parses trailers out of the
// LAST paragraph ONLY, so a `Pickle-Ticket:` line earlier in the body satisfied the grep, the
// hook skipped, and `%(trailers:key=Pickle-Ticket)` — the exact reader `scanGitLogByTrailer`
// uses — then reported NOTHING. Attribution silently lost with the id sitting in plain sight
// in %B; since WS-3 deleted message inference, the trailer scan is the ONLY git-log arm, so
// readEvidence returns `absent` and the Done-flip guard refuses `done_without_commit_evidence`.
// Live shape: 271587ae on release/v2.1-beta.
//
// Asserting on %B cannot catch this — the pre-fix body ALSO contains `Pickle-Ticket: <id>`.
// Only the git-parsed trailer view distinguishes them, which is the whole point.
test('gitattr trailer producer — a mid-body Pickle-Ticket line does not suppress the real trailer', () => {
  const repoRoot = tmpRoot('gitattr-midbody-');
  const managedDir = path.join(tmpRoot('gitattr-midbody-managed-'), 'hooks');
  initGitRepo(repoRoot);

  assert.equal(materializeTrailerHooks({ repoRoot, managedDir }).ok, true);

  // The ticket id appears in a NON-last paragraph, followed by a real trailer block — the
  // shape a worker produces when it narrates the ticket id in its own commit body.
  const message = [
    'fix: something the worker narrated',
    '',
    'Pickle-Ticket: a026c5cc',
    '',
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
  git(['add', '-A'], repoRoot);
  git(
    ['commit', '--no-gpg-sign', '-q', '-m', message],
    repoRoot,
    hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'a026c5cc' }),
  );

  assert.equal(
    trailerValue(repoRoot),
    'a026c5cc',
    'the consumer oracle must see the ticket id, not an empty trailer set',
  );

  // Still exactly one — the fix must not trade a missed stamp for a double stamp.
  const parsed = git(['log', '-1', '--format=%(trailers:key=Pickle-Ticket,valueonly)'], repoRoot)
    .split('\n')
    .filter((line) => line.trim().length > 0);
  assert.equal(parsed.length, 1, 'exactly one parsed Pickle-Ticket trailer');

  // The pre-existing trailer must survive: interpret-trailers appends into the same block
  // rather than opening a new paragraph that would demote it to body prose.
  assert.equal(
    git(['log', '-1', '--format=%(trailers:key=Co-Authored-By,valueonly)'], repoRoot).trim(),
    'Claude <noreply@anthropic.com>',
  );
});

// The guard must still fire when the trailer is genuinely in the parsed block — otherwise the
// fix above would just be a double-stamp machine.
test('gitattr trailer producer — a real trailer in the parsed block still no-ops', () => {
  const repoRoot = tmpRoot('gitattr-parsed-idem-');
  const managedDir = path.join(tmpRoot('gitattr-parsed-idem-managed-'), 'hooks');
  initGitRepo(repoRoot);

  assert.equal(materializeTrailerHooks({ repoRoot, managedDir }).ok, true);

  const message = [
    'fix: worker stamped its own trailer',
    '',
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    'Pickle-Ticket: a026c5cc',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(repoRoot, 'two.txt'), 'two');
  git(['add', '-A'], repoRoot);
  git(
    ['commit', '--no-gpg-sign', '-q', '-m', message],
    repoRoot,
    hooksPathEnv(managedDir, { PICKLE_TICKET_ID: 'a026c5cc' }),
  );

  const parsed = git(['log', '-1', '--format=%(trailers:key=Pickle-Ticket,valueonly)'], repoRoot)
    .split('\n')
    .filter((line) => line.trim().length > 0);
  assert.deepEqual(parsed, ['a026c5cc'], 'exactly one trailer, not two');
});
