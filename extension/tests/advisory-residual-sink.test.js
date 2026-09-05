// @tier: fast
/**
 * WS-C: the advisory worker-gate residual (`gate_skipped`, `worker_gate_not_run` /
 * `worker_gate_target_repo_red`) must land in the jsonl sink `/pickle-metrics`
 * actually reads (`getDataRoot()/activity/*.jsonl`), not in `state.json.activity`
 * — a sink `scanSkipFlagEvents` never scans.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { emitWorkerGateNotRunResidual } from '../bin/mux-runner.js';
import {
  scanSkipFlagEvents,
  scanRefusedRecoveredCounts,
  buildSkipFlagBudgetReport,
  scanSessionFiles,
  scanGitRepos,
  SKIP_FLAG_BUDGETS,
} from '../services/metrics-utils.js';
import { findResiduals } from './__helpers__/activity-sink.js';

function tmpDataRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-advisory-residual-'));
}

test('emitWorkerGateNotRunResidual writes to activity/*.jsonl, not state.json.activity', () => {
  const dataRoot = tmpDataRoot();
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-advisory-session-'));
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }));

    emitWorkerGateNotRunResidual(statePath, 'ticket-abc123', {
      computedVia: 'guardCompletionCommitBeforeDone',
      site: 'guardCompletionCommitBeforeDone',
      verdict: 'not_run',
      reason: 'worker_gate_not_run',
    });

    const residuals = findResiduals({ dataRoot, ticketId: 'ticket-abc123', reason: 'worker_gate_not_run' });
    assert.equal(residuals.length, 1, 'expected exactly one gate_skipped event for ticket-abc123 in the jsonl sink');
    assert.equal(residuals[0].source, 'worker_gate', 'the owning gate is named by the TOP-LEVEL source');
    assert.equal(residuals[0].gate_payload.computed_via, 'guardCompletionCommitBeforeDone');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.deepEqual(state.activity, [], 'state.json.activity must NOT receive the residual');
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
  }
});

function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The sink move (40e07bde) put the residual in the file `/pickle-metrics` reads, but the
 * event still named its gate in `gate_payload.source`. `extractSkipFlagUse` reads the
 * TOP-LEVEL `source` and DEFAULTS an absent one to `'pickle'`, so every use was re-filed
 * under a source that does not own the gate — measured live at 334 uses keyed
 * `pickle::worker_gate_not_run`. Asserting the emitted object alone cannot see that: only
 * running it through the real scanner can. The `pickle` arm is the negative control and is
 * what goes RED against the pre-fix producer.
 */
test('the skip-flag scanner credits worker_gate, never pickle, for the advisory residual', () => {
  const dataRoot = tmpDataRoot();
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-advisory-session-')), 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }));

    emitWorkerGateNotRunResidual(statePath, 'ticket-abc123', {
      computedVia: 'not_applicable',
      site: 'guardCompletionCommitBeforeDone',
      verdict: 'not_run',
      reason: 'worker_gate_not_run',
    });
    emitWorkerGateNotRunResidual(statePath, 'ticket-def456', {
      computedVia: 'target_repo_gate',
      site: 'tryResumeOrphanReattach',
      verdict: 'red',
      reason: 'worker_gate_target_repo_red',
    });

    const day = todayKey();
    const uses = scanSkipFlagEvents(path.join(dataRoot, 'activity'), day, day);
    assert.equal(uses.length, 2, 'the scanner sees both residuals');
    assert.deepEqual(
      [...new Set(uses.map((u) => u.source))],
      ['worker_gate'],
      'every use is credited to the gate that owns it',
    );
    assert.equal(
      uses.filter((u) => u.source === 'pickle').length,
      0,
      'no residual may be re-filed under the pickle source (the extractSkipFlagUse default)',
    );

    const report = buildSkipFlagBudgetReport(uses, SKIP_FLAG_BUDGETS, day, day);
    for (const reason of ['worker_gate_not_run', 'worker_gate_target_repo_red']) {
      const entry = report.entries.find((e) => e.source === 'worker_gate' && e.reason === reason);
      assert.ok(entry, `budget report includes the worker_gate::${reason} entry`);
      assert.equal(entry.uses, 1);
    }
    assert.equal(
      report.entries.some((e) => e.source === 'pickle'),
      false,
      'the pickle source owns no row built from a worker-gate residual',
    );
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
  }
});

/**
 * AP-EXT-ITER10-01 — the scanner must READ the sink it is pointed at.
 *
 * The sink-move tests above prove the residual LANDS in `activity/*.jsonl`. They
 * cannot see the other half: until this fix, every activity-dir scanner in
 * `metrics-utils.ts` skipped any file over a 10 MB cap and `continue`d WITHOUT a
 * diagnostic, so a landed residual past that offset was counted as zero and the
 * emitted report was indistinguishable from a complete measurement. Measured on a
 * live host at the time of the fix: 6 of 8 activity files were over the cap (up to
 * 207 MB), the dashboard tallied 486 of 15,441 real uses, and it published
 * `over_budget: false` for `citadel-mechanical::skip_quality_gates` (121 uses
 * against a budget of 3) — the verdict inverted, not merely under-counted.
 *
 * Both cases below place their events PAST the old cap, so they go RED against a
 * scanner that reads only the first 10 MB. The window-exclusion assertion is the
 * anti-vacuity control: it fails if the fix were "count everything unconditionally".
 */

const OVERSIZED_CHUNK_BYTES = 1024 * 1024; // must mirror ACTIVITY_READ_CHUNK_BYTES
const OLD_SIZE_CAP_BYTES = 10 * 1024 * 1024;
const STRADDLE_EMOJI = '\u{1F600}'; // 4 UTF-8 bytes

/**
 * Write one `<day>.jsonl` larger than the retired 10 MB cap.
 *
 * Layout is deliberate, not incidental:
 *  - a `gate_skipped` whose 4-byte emoji STRADDLES the first read-chunk boundary,
 *    so a reader that decodes each chunk independently corrupts its `reason`;
 *  - ASCII filler out past 10 MB;
 *  - the payload events, all beyond the old cap.
 */
function writeOversizedActivityDay(activityDir, day, { inWindowTs, outOfWindowTs }) {
  fs.mkdirSync(activityDir, { recursive: true });
  const filePath = path.join(activityDir, `${day}.jsonl`);
  const fd = fs.openSync(filePath, 'w');
  let written = 0;
  const put = (s) => { written += fs.writeSync(fd, s); };

  const fillerFor = (n) => {
    const line = `{"event":"ap_iter10_noise","ts":"${inWindowTs}","i":${String(n).padStart(6, '0')},"pad":"`;
    const close = '"}\n';
    const pad = 1024 - Buffer.byteLength(line, 'utf8') - Buffer.byteLength(close, 'utf8');
    return `${line}${'y'.repeat(pad)}${close}`; // exactly 1024 bytes
  };

  const straddleHead =
    `{"event":"gate_skipped","source":"ap_iter10","gate_payload":{"reason":"straddle-`;
  const preambleLines = Math.floor(
    (OVERSIZED_CHUNK_BYTES - 2 - Buffer.byteLength(straddleHead, 'utf8')) / 1024,
  );
  for (let i = 0; i < preambleLines; i += 1) put(fillerFor(i));
  const innerPad = OVERSIZED_CHUNK_BYTES - 2 - written - Buffer.byteLength(straddleHead, 'utf8');
  assert.ok(innerPad >= 0, 'straddle arithmetic must not underflow');
  put(`${straddleHead}${'x'.repeat(innerPad)}`);
  assert.equal(written, OVERSIZED_CHUNK_BYTES - 2, 'emoji must begin 2 bytes before the chunk boundary');
  put(`${STRADDLE_EMOJI}"},"ts":"${inWindowTs}"}\n`);

  for (let i = preambleLines; written <= OLD_SIZE_CAP_BYTES + 4096; i += 1) put(fillerFor(i));
  assert.ok(written > OLD_SIZE_CAP_BYTES, 'filler must carry the file past the retired cap');
  const pastCapOffset = written;

  for (let i = 0; i < 7; i += 1) {
    put(`{"event":"gate_skipped","source":"ap_iter10","gate_payload":{"reason":"past_cap"},"ts":"${inWindowTs}"}\n`);
  }
  for (let i = 0; i < 3; i += 1) {
    put(`{"event":"completion_finalize_refused","ts":"${inWindowTs}"}\n`);
  }
  put(`{"event":"gate_skipped","source":"ap_iter10","gate_payload":{"reason":"out_of_window"},"ts":"${outOfWindowTs}"}\n`);

  fs.closeSync(fd);
  return { filePath, totalBytes: written, pastCapOffset };
}

function isoAtLocalNoon(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}

test('AP-EXT-ITER10-01: the skip-flag scanner reads a >10 MB activity file in full', () => {
  const dataRoot = tmpDataRoot();
  try {
    const day = todayKey();
    const [y, m, d] = day.split('-').map(Number);
    const outOfWindowDay = new Date(y, m - 1, d - 30, 12, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    const outKey = `${outOfWindowDay.getFullYear()}-${pad(outOfWindowDay.getMonth() + 1)}-${pad(outOfWindowDay.getDate())}`;

    const activityDir = path.join(dataRoot, 'activity');
    const { totalBytes, pastCapOffset } = writeOversizedActivityDay(activityDir, day, {
      inWindowTs: isoAtLocalNoon(day),
      outOfWindowTs: outOfWindowDay.toISOString(),
    });
    assert.ok(totalBytes > OLD_SIZE_CAP_BYTES, 'fixture must exceed the retired 10 MB cap');
    assert.ok(pastCapOffset > OLD_SIZE_CAP_BYTES, 'payload events must sit beyond it');

    const uses = scanSkipFlagEvents(activityDir, day, day);
    const mine = uses.filter((u) => u.source === 'ap_iter10');
    assert.equal(
      mine.filter((u) => u.reason === 'past_cap').length,
      7,
      'every skip-flag use past the 10 MB offset is counted — a file over the cap is streamed, never dropped',
    );
    assert.equal(
      mine.filter((u) => u.reason.startsWith('straddle-')).length,
      1,
      'the use whose reason straddles a read-chunk boundary survives the chunked read',
    );
    assert.ok(
      mine.find((u) => u.reason.startsWith('straddle-')).reason.endsWith(STRADDLE_EMOJI),
      'a multi-byte character split across two read chunks must decode intact, not as a replacement char',
    );
    assert.equal(
      mine.filter((u) => u.reason === 'out_of_window').length,
      0,
      'anti-vacuity: the date window still excludes an out-of-window event past the cap',
    );

    const report = buildSkipFlagBudgetReport(uses, SKIP_FLAG_BUDGETS, day, day);
    const entry = report.entries.find((e) => e.source === 'ap_iter10' && e.reason === 'past_cap');
    assert.ok(entry, 'the budget report carries the past-cap row');
    assert.equal(entry.uses, 7);
    assert.equal(
      entry.over_budget,
      true,
      '7 uses against the default budget of 5 is over budget — the pre-fix scanner saw 0 and published over_budget:false',
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER10-01: the sibling refused-and-recovered scanner reads the same >10 MB file', () => {
  const dataRoot = tmpDataRoot();
  try {
    const day = todayKey();
    const activityDir = path.join(dataRoot, 'activity');
    writeOversizedActivityDay(activityDir, day, {
      inWindowTs: isoAtLocalNoon(day),
      outOfWindowTs: isoAtLocalNoon(day),
    });

    const counts = scanRefusedRecoveredCounts(activityDir, day, day);
    assert.equal(
      counts.completion_finalize_refused,
      3,
      'the refusal counter shares the one streaming walk — it cannot re-fork its own size cap',
    );
    assert.equal(counts.total, 3);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER193-01 — the SESSION-transcript half of the AP-EXT-ITER10-01
// invariant. `aceb54d7` retired the activity-dir size cap and made every
// activity-file drop announce itself; the session-transcript reader
// (`scanSessionFiles` -> `loadSessionFileData`) kept the pre-fix shape the trap
// door's own PATTERN_SHAPE names — "a `.size >` threshold gating a
// `readFileSync` in a jsonl scan loop, skipping silently". Removing that cap
// reds an out-of-scope pin (`tests/metrics.test.js`, "skips files over 50MB"),
// so the DROP is preserved here on purpose and only the SILENCE is fixed: the
// under-count must announce itself.
// ---------------------------------------------------------------------------

const SESSION_FILE_CAP_BYTES = 50 * 1024 * 1024;

function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1]() ?? true : true;
  };
  try {
    return { value: fn(), stderr: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

function makeProjectsDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-session-scan-'));
  return { root, cacheFile: path.join(root, 'metrics-cache.json') };
}

function assistantLine(ts, input, output) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
}

/**
 * A session transcript whose FIRST line is real, countable usage and whose size
 * is then pushed past the cap with a sparse tail (no bytes written, no disk
 * burned). The real first line is load-bearing in BOTH mutation directions: drop
 * the cap and the slug appears in the result, so a fix that stops dropping is
 * caught too.
 */
function writeOversizedSessionFile(root, slug, dayKey) {
  const slugDir = path.join(root, slug);
  fs.mkdirSync(slugDir, { recursive: true });
  const filePath = path.join(slugDir, 'session.jsonl');
  fs.writeFileSync(filePath, `${assistantLine(isoAtLocalNoon(dayKey), 111, 222)}\n`);
  fs.truncateSync(filePath, SESSION_FILE_CAP_BYTES + 1024);
  assert.ok(fs.statSync(filePath).size > SESSION_FILE_CAP_BYTES, 'fixture must exceed the 50 MB cap');
  return filePath;
}

test('AP-EXT-ITER193-01: an oversized session transcript is dropped LOUDLY, never as a silent zero', () => {
  const { root, cacheFile } = makeProjectsDir();
  try {
    const day = todayKey();
    const filePath = writeOversizedSessionFile(root, 'oversized-project', day);

    const { value: result, stderr } = captureStderr(() => scanSessionFiles(root, day, day, cacheFile));

    assert.ok(
      !result.has('oversized-project'),
      'behavior unchanged: the over-cap file is still skipped (tests/metrics.test.js pins this)',
    );
    assert.match(
      stderr,
      /\[metrics\] session scan skipped /,
      'the drop must announce itself — an under-count that says nothing is a false verdict, not a measurement',
    );
    assert.ok(stderr.includes(filePath), 'the diagnostic must name the file that left the totals');
    assert.match(stderr, /exceeds the 52428800-byte cap/, 'the diagnostic must state why the file was dropped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER193-01: anti-vacuity — a countable session transcript is counted and stays silent', () => {
  const { root, cacheFile } = makeProjectsDir();
  try {
    const day = todayKey();
    const slugDir = path.join(root, 'normal-project');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, 'session.jsonl'), `${assistantLine(isoAtLocalNoon(day), 111, 222)}\n`);

    const { value: result, stderr } = captureStderr(() => scanSessionFiles(root, day, day, cacheFile));

    assert.equal(result.get('normal-project').get(day).input, 111, 'the in-window transcript is counted');
    assert.equal(result.get('normal-project').get(day).output, 222);
    assert.equal(stderr, '', 'a file that was read must produce no drop diagnostic');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER200-01 — the DIRECTORY arm of the same invariant.
//
// `aceb54d7` and `7e56db10` each announced the per-FILE drop and each left the
// enumeration one frame up returning silently: `readSessionSlugs`,
// `readSlugJsonlFiles` and `forEachActivityEventInWindow`'s `readdirSync` all
// swallowed the error and reported zero. That is the SAME "an under-count that
// says nothing is a false verdict" defect at strictly larger blast radius — a
// whole corpus rather than one file — and `/pickle-metrics` prints it as
// "No metrics data found", indistinguishable from a quiet day.
//
// The cases below exercise the shipped scanners, not a mirror of their rule.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER200-01: an unreadable projects dir is announced, never a silent zero', () => {
  const { root, cacheFile } = makeProjectsDir();
  try {
    const missing = path.join(root, 'no-such-projects-dir');

    const { value: result, stderr } = captureStderr(() => scanSessionFiles(missing, todayKey(), todayKey(), cacheFile));

    assert.equal(result.size, 0, 'the corpus is genuinely absent from the totals');
    assert.match(stderr, /\[metrics\] session scan skipped /, 'the whole-corpus drop must announce itself');
    assert.ok(stderr.includes(missing), 'the diagnostic must name the directory that left the totals');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER200-01: a project dir that cannot be enumerated is announced', () => {
  const { root, cacheFile } = makeProjectsDir();
  try {
    const day = todayKey();
    // A dangling symlink: `readSessionSlugs` enumerates it as a slug, then the
    // per-slug stat REFUSES. A real EACCES project dir takes the same arm, but a
    // dangling link reproduces it without depending on the runner's uid.
    const brokenSlug = path.join(root, 'unreadable-project');
    fs.symlinkSync(path.join(root, 'target-that-does-not-exist'), brokenSlug);
    // A countable sibling so the scan is not vacuous — the drop must not take it down.
    const goodDir = path.join(root, 'normal-project');
    fs.mkdirSync(goodDir, { recursive: true });
    fs.writeFileSync(path.join(goodDir, 'session.jsonl'), `${assistantLine(isoAtLocalNoon(day), 5, 7)}\n`);

    const { value: result, stderr } = captureStderr(() => scanSessionFiles(root, day, day, cacheFile));

    assert.equal(result.get('normal-project').get(day).input, 5, 'the readable sibling is still counted');
    assert.match(stderr, /\[metrics\] session scan skipped /, 'the per-project drop must announce itself');
    assert.ok(stderr.includes(brokenSlug), 'the diagnostic must name the project dir that left the totals');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER200-01: an unreadable activity dir is announced by the scanner that read it', () => {
  const { root } = makeProjectsDir();
  try {
    const missing = path.join(root, 'no-such-activity-dir');

    const { value: events, stderr } = captureStderr(() => scanSkipFlagEvents(missing, todayKey(), todayKey()));

    assert.equal(events.length, 0, 'no events are invented for an unreadable dir');
    assert.match(stderr, /\[metrics\] skip-flag scan skipped /, 'the activity-half drop must announce itself, and name its scanner');
    assert.ok(stderr.includes(missing), 'the diagnostic must name the directory that left the totals');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER200-01: anti-vacuity — a non-directory entry drops nothing and stays silent', () => {
  const { root, cacheFile } = makeProjectsDir();
  try {
    const day = todayKey();
    // The shape a previous run leaves behind: a stray FILE beside the slug dirs.
    // The filesystem ANSWERED (`!isDirectory()`); no transcript was lost, so a
    // diagnostic here would be noise — and noise is how a real drop gets ignored.
    fs.writeFileSync(path.join(root, 'stray-cache-file.json'), '{}');
    const slugDir = path.join(root, 'normal-project');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, 'session.jsonl'), `${assistantLine(isoAtLocalNoon(day), 111, 222)}\n`);

    const { value: result, stderr } = captureStderr(() => scanSessionFiles(root, day, day, cacheFile));

    assert.equal(result.get('normal-project').get(day).input, 111, 'the transcript beside it is still counted');
    assert.equal(stderr, '', 'an answered non-directory is not a drop and must produce no diagnostic');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER200-02 — the LOC half of the same corpus-enumeration invariant.
//
// `aceb54d7`, `7e56db10` and `bd7b4033` each closed one arm of "a drop is a
// diagnostic, never a silent zero" on the TOKEN half. `discoverGitRepos` is the
// LOC half's enumeration and kept a bare `catch { continue; }`, so a `repoRoot`
// that cannot be read yielded zero repos, zero commits and zero LOC in total
// silence — and `metrics.ts` DEFAULTS `repoRoot` to `~/loanlight`, a path that
// does not exist on most hosts (measured absent on the authoring box), so the
// silent zero is the ORDINARY case rather than an edge one.
//
// It could not take the uniform `announceScanDrop` its three siblings share:
// the same `catch` serves the corpus ROOT and every speculative SUBTREE descent
// below it, and announcing each routine descent refusal is the noise that hides
// a real drop. The split is the fix — the ROOT announces, a DESCENT does not.
//
// The cases below drive the shipped `scanGitRepos`, not a mirror of its rule.
// ---------------------------------------------------------------------------

function gitIn(cwd, args, env = {}) {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 15000,
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function isoAtNoon(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0).toISOString();
}

/** A real single-commit repo dated at local noon TODAY, so the report window contains it. */
function makeCountableRepo(parentDir, name) {
  const repoDir = path.join(parentDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, ['init']);
  gitIn(repoDir, ['config', 'user.name', 'Metrics Test']);
  gitIn(repoDir, ['config', 'user.email', 'metrics@example.com']);
  fs.writeFileSync(path.join(repoDir, 'report.txt'), 'one line\n');
  const stamp = { GIT_AUTHOR_DATE: isoAtNoon(new Date()), GIT_COMMITTER_DATE: isoAtNoon(new Date()) };
  gitIn(repoDir, ['add', 'report.txt'], stamp);
  gitIn(repoDir, ['commit', '-m', 'countable commit'], stamp);
  return repoDir;
}

test('AP-EXT-ITER200-02: an unreadable corpus ROOT is announced, never a silent zero', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-loc-scan-'));
  try {
    // The live shape: `metrics.ts` defaults `repoRoot` to `~/loanlight`, which is
    // absent on most hosts. Every project's commits/added/removed then publish as
    // 0 and the operator reads a real report as a quiet day.
    const missing = path.join(parent, 'no-such-repo-root');

    const { value: loc, stderr } = captureStderr(() => scanGitRepos(missing, todayKey(), todayKey()));

    assert.equal(loc.size, 0, 'the corpus is genuinely absent from the LOC totals');
    assert.match(stderr, /\[metrics\] loc scan skipped /, 'the whole-corpus drop must announce itself');
    assert.ok(stderr.includes(missing), 'the diagnostic must name the root that left the totals');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER200-02: anti-vacuity — a failed speculative DESCENT drops nothing operators can act on and stays silent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-loc-scan-'));
  const blocked = path.join(root, 'unreadable-subtree');
  try {
    // A readable ROOT holding one countable repo plus one subtree the walk cannot
    // descend into. A home-directory walk hits these routinely; announcing each one
    // is the noise that buries the ROOT drop the case above exists to surface.
    const repoDir = makeCountableRepo(root, 'countable-repo');
    fs.mkdirSync(blocked, { recursive: true });
    fs.chmodSync(blocked, 0o000);

    const day = todayKey();
    const { value: loc, stderr } = captureStderr(() => scanGitRepos(root, day, day));

    const stats = loc.get(repoDir.replace(/[\\/]/g, '-'));
    assert.ok(stats, 'the readable sibling repo is still discovered and counted');
    assert.equal(stats.get(day).commits, 1, 'its in-window commit is counted');
    assert.equal(stderr, '', 'a speculative descent refusal is not a corpus drop and must produce no diagnostic');
  } finally {
    fs.chmodSync(blocked, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER200-02: a readable root holding no repos is a measured empty, not a drop', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-loc-scan-'));
  try {
    // The gate against over-triggering: the walk RAN and answered "no repos here".
    // Nothing was dropped, so a diagnostic would misreport a correct measurement.
    fs.mkdirSync(path.join(root, 'just-a-plain-dir'), { recursive: true });

    const { value: loc, stderr } = captureStderr(() => scanGitRepos(root, todayKey(), todayKey()));

    assert.equal(loc.size, 0, 'an empty corpus is an empty result');
    assert.equal(stderr, '', 'a root that WAS enumerated must produce no drop diagnostic');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER200-04 — the LOC half's per-REPO altitude, the fifth recurrence.
//
// `aceb54d7`, `7e56db10`, `bd7b4033` and `099554aa` each closed ONE arm of "a
// drop is a diagnostic, never a silent zero". The four of them cover the token
// half's per-file arm, the token half's directory arm, and the LOC half's
// corpus-ROOT arm. `scanGitRepos` kept TWO arms below all of them — the
// completion guard and the defensive catch — each of which removed a whole
// repo's commits/added/removed from a PUBLISHED total writing nothing at all.
//
// Its own comment asserted the opposite ("at least leaves the absence
// visible"), which is the same shape iteration 2 found in
// `forEachActivityEventInWindow`: a comment stating an invariant is where the
// violation lives, not evidence it holds.
//
// The fix is a COLLAPSE, not a third guard — both arms now exit through the one
// `dropRepo` funnel, mirroring `dropSessionFile` on the session half.
// ---------------------------------------------------------------------------

/**
 * A stale worktree: a `.git` FILE whose `gitdir:` target no longer exists.
 * `discoverGitRepos` accepts it (the walk admits `.git` as a file), and `git log`
 * then exits non-zero without ascending to any parent repo — so the failure is
 * deterministic and does not depend on where the tmpdir lives.
 */
function makeUnreadableRepo(parentDir, name) {
  const repoDir = path.join(parentDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.git'), `gitdir: ${path.join(parentDir, 'deleted-main', '.git', 'worktrees', name)}\n`);
  return repoDir;
}

test('AP-EXT-ITER200-04: a repo whose git log fails is announced, never dropped from the LOC totals in silence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-loc-repo-'));
  try {
    const broken = makeUnreadableRepo(root, 'stale-worktree');

    const day = todayKey();
    const { value: loc, stderr } = captureStderr(() => scanGitRepos(root, day, day));

    assert.equal(loc.size, 0, 'the unreadable repo contributes nothing to the totals');
    assert.match(stderr, /\[metrics\] loc scan skipped /, 'a repo leaving a published total must announce itself');
    assert.ok(stderr.includes(broken), 'the diagnostic must name the repo that left the totals');
    assert.match(stderr, /git log exited /, 'and must name WHICH failure mode dropped it, not just that one did');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER200-04: a readable repo alongside a broken one is still counted, and only the broken one is announced', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-loc-repo-'));
  try {
    // The narrowness control the ROOT case cannot give: the walk continues past a
    // failed repo, so one bad repo must not zero the corpus, and the announcement
    // must be exactly one line — a per-repo funnel that fires per-repo, not per-scan.
    const good = makeCountableRepo(root, 'countable-repo');
    const broken = makeUnreadableRepo(root, 'stale-worktree');

    const day = todayKey();
    const { value: loc, stderr } = captureStderr(() => scanGitRepos(root, day, day));

    const stats = loc.get(good.replace(/[\\/]/g, '-'));
    assert.ok(stats, 'the healthy repo is still discovered and counted');
    assert.equal(stats.get(day).commits, 1, 'its in-window commit survives the sibling failure');
    assert.equal(stderr.trim().split('\n').length, 1, 'exactly one drop is announced');
    assert.ok(stderr.includes(broken), 'and it is the broken repo, not the counted one');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
