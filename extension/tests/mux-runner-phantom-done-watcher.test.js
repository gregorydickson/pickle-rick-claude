// @tier: fast
/**
 * R-ICP-5 / AC-ICP-04 — phantom-Done watcher detects mid-iteration Todo→Done
 * flips and reverts when no completion_commit field is present. Tests the
 * exported inspectPhantomDoneTicketFile function which is the watcher's
 * per-event predicate.
 *
 * AC-ICP-04-3 — phantom_done_detected event registered with required payload
 * fields including completion_commit_present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '..', 'src', 'types', 'activity-events.schema.json');
const VALID_EVENTS_TS = path.resolve(__dirname, '..', 'src', 'types', 'index.ts');
const VALID_EVENTS_JS = path.resolve(__dirname, '..', 'types', 'index.js');

test('AC-ICP-04-3: phantom_done_detected registered in VALID_ACTIVITY_EVENTS (TS source)', () => {
  const content = fs.readFileSync(VALID_EVENTS_TS, 'utf-8');
  assert.ok(/phantom_done_detected/.test(content), 'TS source must register phantom_done_detected');
});

test('AC-ICP-04-3: phantom_done_detected registered in VALID_ACTIVITY_EVENTS (JS deploy)', () => {
  const content = fs.readFileSync(VALID_EVENTS_JS, 'utf-8');
  assert.ok(/phantom_done_detected/.test(content), 'JS deploy must mirror the registration');
});

test('AC-ICP-04-3: schema defines phantom_done_detected with required completion_commit_present', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  const def = schema.definitions.phantom_done_detected;
  assert.ok(def, 'schema definition missing');
  assert.equal(def.type, 'object');
  assert.ok(def.required.includes('event'), 'required must include event');
  assert.ok(def.required.includes('ts'), 'required must include ts (timestamp)');
  assert.ok(def.required.includes('ticket'), 'required must include ticket');
  assert.ok(
    def.required.includes('completion_commit_present'),
    'AC-ICP-04-3 requires completion_commit_present in payload',
  );
  assert.equal(def.properties.completion_commit_present.type, 'boolean');
  assert.equal(def.properties.event.const, 'phantom_done_detected');
});

test('AC-ICP-04-3: payload count covers ≥3 registration sites (lint per AC)', () => {
  const ts = fs.readFileSync(VALID_EVENTS_TS, 'utf-8');
  const js = fs.readFileSync(VALID_EVENTS_JS, 'utf-8');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const tsCount = (ts.match(/phantom_done_detected/g) || []).length;
  const jsCount = (js.match(/phantom_done_detected/g) || []).length;
  const schemaCount = (schema.match(/phantom_done_detected/g) || []).length;
  const total = tsCount + jsCount + schemaCount;
  assert.ok(total >= 3, `expected ≥3 references across the 3 files, got ${total}`);
});

const { inspectPhantomDoneTicketFile, correctPhantomDoneTickets } = await import('../bin/mux-runner.js');

function makeTicketFile(dir, ticketId, frontmatter) {
  const file = path.join(dir, `rick_ticket_${ticketId}.md`);
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(file, `---\n${fm}\n---\n\n# Body\n`);
  return file;
}

test('AC-ICP-04: status: Done WITH reachable completion_commit field → has_completion_commit (no revert)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'phantom-watcher-test-'));
  try {
    // B-1SEAM WS-1: the watcher git-probes the stamped sha through the ONE
    // predicate (bare field presence no longer keeps) — stamp a REAL sha.
    execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'work.txt'), 'work\n');
    execFileSync('git', ['add', '-A'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'work', '--no-gpg-sign'], { cwd: tmp, stdio: 'ignore' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
    const ticketDir = path.join(tmp, 'session', 'eeff0011');
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketFile = makeTicketFile(ticketDir, 'eeff0011', {
      id: 'eeff0011',
      status: 'Done',
      completion_commit: sha,
    });
    const result = inspectPhantomDoneTicketFile(
      ticketFile,
      path.join(tmp, 'session'),
      tmp,
      'In Progress',
    );
    assert.equal(
      result.reason,
      'has_completion_commit',
      `expected has_completion_commit, got ${result.reason}`,
    );
    assert.equal(result.changed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-ICP-04: status: Todo → not_done (watcher silent)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'phantom-watcher-test-'));
  try {
    const ticketDir = path.join(tmp, 'session', '11223344');
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketFile = makeTicketFile(ticketDir, '11223344', {
      id: '11223344',
      status: 'Todo',
    });
    const result = inspectPhantomDoneTicketFile(
      ticketFile,
      path.join(tmp, 'session'),
      tmp,
      'Todo',
    );
    assert.equal(result.reason, 'not_done', `expected not_done, got ${result.reason}`);
    assert.equal(result.changed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-ICP-04: missing id frontmatter → missing_id (defensive)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'phantom-watcher-test-'));
  try {
    const ticketDir = path.join(tmp, 'session', '99887766');
    fs.mkdirSync(ticketDir, { recursive: true });
    // status: Done but NO id field — exercises the missing_id branch which returns
    // before the git lookup that needs a real repo.
    const ticketFile = path.join(ticketDir, 'rick_ticket_99887766.md');
    fs.writeFileSync(ticketFile, '---\nstatus: Done\n---\n');
    const result = inspectPhantomDoneTicketFile(
      ticketFile,
      path.join(tmp, 'session'),
      tmp,
      'In Progress',
    );
    // Either missing_id (no id field) or unparseable (git failed) is acceptable —
    // both prove the watcher refuses to bless a Done flip without evidence.
    assert.ok(
      result.reason === 'missing_id' || result.reason === 'unparseable',
      `expected missing_id or unparseable, got ${result.reason}`,
    );
    assert.equal(result.changed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * AP-EXT-ITER330-01 — an unmeasured keep must SAY it was unmeasured.
 *
 * `gateForPhantomDoneRevert` answers `keep` for two causes: evidence it resolved, and
 * (AP-EXT-ITER327-01/-02, -328-01) an absence no repo on the dir ladder could measure.
 * `applyInspectPhantomDoneDecision` returns the SAME `has_completion_commit` reason for
 * both, and `handlePhantomDoneTicketEvent` drops every `changed: false` result — so the
 * `fs.watch` path kept Done tickets over a dead ladder in total silence while its
 * batch-loop sibling logged it. The decision is correct either way; only the CLAIM was.
 *
 * The rejection arm is fixtured with its own live over-trigger control, because a warn
 * emitted on EVERY keep passes the defect case just as well and disarms the signal.
 */

/**
 * Puts a `git` on PATH that dies unspoken (SIGKILL, no exit status) whenever any argv
 * element equals `matchArg`, and execs the real git otherwise. That is the distinction
 * this case turns on: an unrunnable git is not a git that answered "no".
 */
function withGitUnableToSpeak(matchArg, fn) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8', timeout: 30_000 }).trim();
  const shimDir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'phantom-watcher-shim-'));
  const shim = path.join(shimDir, 'git');
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    'for a in "$@"; do',
    `  if [ "$a" = ${JSON.stringify(matchArg)} ]; then kill -9 $$; fi`,
    'done',
    `exec ${JSON.stringify(realGit)} "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(shim, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${savedPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
}

/** A one-commit repo plus a Done ticket, returning the sha so a stamp can be REAL. */
function makeDoneTicketFixture(ticketId, frontmatterFor) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'phantom-watcher-test-'));
  execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore', timeout: 30_000 });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp, timeout: 30_000 });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmp, timeout: 30_000 });
  fs.writeFileSync(path.join(tmp, 'work.txt'), 'work\n');
  execFileSync('git', ['add', '-A'], { cwd: tmp, stdio: 'ignore', timeout: 30_000 });
  execFileSync('git', ['commit', '-q', '-m', 'work', '--no-gpg-sign'], { cwd: tmp, stdio: 'ignore', timeout: 30_000 });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8', timeout: 30_000 }).trim();
  const sessionDir = path.join(tmp, 'session');
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const ticketFile = makeTicketFile(ticketDir, ticketId, frontmatterFor(sha));
  return { tmp, sessionDir, ticketFile, sha };
}

/** Runs the inspect with `process.stderr.write` captured, returning result + stderr. */
function inspectCapturingStderr(ticketFile, sessionDir, workingDir, priorStatus) {
  const captured = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : String(chunk));
    return realWrite(chunk, ...rest);
  };
  try {
    const result = inspectPhantomDoneTicketFile(ticketFile, sessionDir, workingDir, priorStatus);
    return { result, stderr: captured.join('') };
  } finally {
    process.stderr.write = realWrite;
  }
}

// Quote-stripped, matching `restorablePriorStatus`: the revert writer emits the
// restored value quoted, the seed path does not, and the status is the same either way.
const statusOf = (ticketFile) =>
  /^status:\s*(.+)$/m.exec(fs.readFileSync(ticketFile, 'utf8'))[1].replace(/["']/g, '').trim();

test('AP-EXT-ITER330-01: a keep the dir ladder never measured reports itself UNMEASURED', () => {
  const fx = makeDoneTicketFixture('a1b2c330', (sha) => ({
    id: 'a1b2c330',
    status: 'Done',
    completion_commit: sha,
  }));
  try {
    // `cat-file` is the sha probe every accept arm resolves on. Killed unspoken, the
    // ladder exhausts having measured NOTHING — the R-DSAN keep.
    const { result, stderr } = withGitUnableToSpeak('cat-file', () =>
      inspectCapturingStderr(fx.ticketFile, fx.sessionDir, fx.tmp, 'In Progress'));
    assert.equal(result.changed, false, 'an unmeasured absence must never revert (R-DSAN)');
    assert.equal(statusOf(fx.ticketFile), 'Done', 'the Done status must survive on disk');
    assert.match(
      stderr,
      /evidence UNMEASURED \(no repo on the dir ladder answered\)/,
      'the unmeasured keep must say so — a silent keep is indistinguishable from resolved evidence',
    );
    assert.match(stderr, /R-DSAN/, 'the claim must name the rule it is keeping under');
    assert.match(stderr, /a1b2c330/, 'the claim must name the ticket it kept');
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER330-01: a keep backed by a RESOLVED sha emits no unmeasured claim', () => {
  // The load-bearing half: a warn on every keep would pass the case above while
  // destroying the signal it exists to carry.
  const fx = makeDoneTicketFixture('c3d4e330', (sha) => ({
    id: 'c3d4e330',
    status: 'Done',
    completion_commit: sha,
  }));
  try {
    const { result, stderr } = inspectCapturingStderr(fx.ticketFile, fx.sessionDir, fx.tmp, 'In Progress');
    assert.equal(result.reason, 'has_completion_commit', 'a resolved stamp still keeps');
    assert.equal(statusOf(fx.ticketFile), 'Done');
    assert.doesNotMatch(
      stderr,
      /evidence UNMEASURED/,
      'a MEASURED keep must not borrow the unmeasured claim',
    );
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER330-01: a MEASURED absence still reverts, and claims nothing', () => {
  // Non-vacuity control on the same fixture shape: git is healthy and answers, so the
  // absence is a finding and the revert must still happen.
  const fx = makeDoneTicketFixture('e5f6a330', () => ({ id: 'e5f6a330', status: 'Done' }));
  try {
    const { result, stderr } = inspectCapturingStderr(fx.ticketFile, fx.sessionDir, fx.tmp, 'In Progress');
    assert.equal(result.reason, 'reverted', 'a measured absence is a finding and must revert');
    assert.equal(result.changed, true);
    assert.equal(statusOf(fx.ticketFile), 'In Progress', 'the prior status must be restored');
    assert.doesNotMatch(stderr, /evidence UNMEASURED/, 'a revert is never an unmeasured keep');
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

/**
 * AP-EXT-ITER330-02 — a keep must not claim evidence whose absence is its own premise.
 *
 * REPLAY of AP-EXT-ITER330-01 on the ZERO-DIFF axis. `gateForPhantomDoneRevert` maps a
 * zero-diff accept to `kind: 'committed'` with NO `sha` (a declared zero-diff ticket has
 * no commit by construction), and `logPhantomDoneKept` derived its claim from
 * `kind === 'committed'` — so the batch loop reported `valid completion_commit evidence`
 * over a ticket that provably carried no `completion_commit` at all. The DECISION was
 * always right (keep); only the claim was wrong, exactly as in -330-01.
 *
 * The fix carries `via` across the `RevertDecision` boundary rather than widening
 * `EvidenceKind`, which -330-01's own guard reads as a two-state
 * measured/unmeasured discriminator.
 *
 * Driven end to end through the real `correctPhantomDoneTickets`, because the claim IS
 * the defect and the reporter is what emits it. The stamped-sha case is the load-bearing
 * over-trigger control: a fix that simply renamed the claim for every keep passes the
 * pin below just as well and destroys the distinction it exists to carry.
 */

/** The `trivial` tier's whole lifecycle set is `code_review` — the corroboration the arm requires. */
function writeTrivialTierArtifact(ticketFile) {
  fs.writeFileSync(path.join(path.dirname(ticketFile), 'code_review_2026-09-20.md'), 'reviewed\n');
}

/** Runs the batch loop with its `log` captured and activity writes pinned off the real tree. */
function correctCapturingLog(sessionDir, workingDir) {
  const lines = [];
  const previousDataRoot = process.env.PICKLE_DATA_ROOT;
  const dataRoot = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'phantom-watcher-data-'));
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    const corrected = correctPhantomDoneTickets({
      sessionDir,
      workingDir,
      startCommit: null,
      iteration: 1,
      log: (msg) => lines.push(msg),
    });
    return { corrected, log: lines.join('\n') };
  } finally {
    if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER330-02: a zero-diff keep names its declared basis and claims no completion_commit', () => {
  const fx = makeDoneTicketFixture('zd580001', () => ({
    id: 'zd580001',
    title: 'zero-diff fixture',
    status: 'Done',
    order: 1,
    complexity_tier: 'trivial',
    zero_diff_intent: 'already-satisfied',
  }));
  try {
    writeTrivialTierArtifact(fx.ticketFile);
    // Fixture precondition: the claim assertion below is only meaningful while the
    // ticket really has no stamp. A fixture that grew one would pass vacuously.
    assert.doesNotMatch(
      fs.readFileSync(fx.ticketFile, 'utf8'),
      /completion_commit/,
      'precondition: a zero-diff ticket carries no completion_commit by construction',
    );

    const { corrected, log } = correctCapturingLog(fx.sessionDir, fx.tmp);

    assert.equal(corrected, 0, 'a corroborated zero-diff Done must be KEPT, not reverted');
    assert.equal(statusOf(fx.ticketFile), 'Done', 'the Done status must survive on disk');
    assert.doesNotMatch(
      log,
      /completion_commit/,
      'the keep must not claim evidence the ticket provably does not have',
    );
    assert.match(log, /zero-diff/, 'the keep must name the basis it actually rests on');
    assert.match(log, /zd580001/, 'the claim must name the ticket it kept');
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER330-02: a keep backed by a RESOLVED sha still claims completion_commit evidence', () => {
  // The load-bearing half: renaming the claim for EVERY keep would satisfy the pin
  // above while erasing the distinction between a commit and a declaration.
  const fx = makeDoneTicketFixture('zd580002', (sha) => ({
    id: 'zd580002',
    title: 'stamped fixture',
    status: 'Done',
    order: 1,
    completion_commit: sha,
  }));
  try {
    const { corrected, log } = correctCapturingLog(fx.sessionDir, fx.tmp);

    assert.equal(corrected, 0, 'a resolved stamp still keeps');
    assert.equal(statusOf(fx.ticketFile), 'Done');
    assert.match(
      log,
      /valid completion_commit evidence/,
      'a commit-backed keep must keep saying so — that is the claim the zero-diff arm must not borrow',
    );
    assert.doesNotMatch(log, /zero-diff/, 'a commit-backed keep has no zero-diff basis to name');
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER330-02: a declaration WITHOUT its tier artifacts still reverts', () => {
  // Non-vacuity control: the keep above comes from the CORROBORATED declaration, not
  // from an inert loop. Drop the one artifact the tier requires and the revert returns.
  const fx = makeDoneTicketFixture('zd580003', () => ({
    id: 'zd580003',
    title: 'uncorroborated fixture',
    status: 'Done',
    order: 1,
    complexity_tier: 'trivial',
    zero_diff_intent: 'already-satisfied',
  }));
  try {
    const { corrected, log } = correctCapturingLog(fx.sessionDir, fx.tmp);

    assert.equal(corrected, 1, 'an uncorroborated declaration is not evidence — it must revert');
    assert.equal(statusOf(fx.ticketFile), 'Todo', 'the revert must land on disk');
    assert.doesNotMatch(log, /zero-diff/, 'a revert has no keep to claim anything about');
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});
