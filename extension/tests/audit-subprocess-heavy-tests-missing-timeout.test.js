// @tier: fast
// R-TFP-C2 extension: missing-timeout predicate over the whole child_process
// family (exec/execSync/execFile/execFileSync/spawn/spawnSync/fork), scanned
// via `--scan-root`. The fixture lives under `fs.mkdtemp` — NEVER under
// `extension/tests/` — so this test cannot itself trip AC-4 (the baseline is
// keyed to the committed `extension/tests` corpus and would never grandfather
// a tmp-dir path anyway).
//
// Fixture source is assembled from split tokens (`FN + '('`) rather than a
// literal `execFileSync(`/`spawnSync(` substring so THIS file — which lives
// in the real extension/tests/ corpus — never itself reads as a missing-
// timeout candidate to the very audit it is testing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/audit-subprocess-heavy-tests.sh');

function tmpScanRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'missing-timeout-scan-root-'));
}

function runAudit(scanRoot) {
  return spawnSync('bash', [SCRIPT, '--scan-root', scanRoot], {
    encoding: 'utf-8',
    timeout: 15000,
  });
}

function fixtureSource(fn, callArgs, withTimeout) {
  const opts = withTimeout
    ? "{ cwd, encoding: 'utf-8', timeout: 15000 }"
    : "{ cwd, encoding: 'utf-8' }";
  return [
    '// @tier: fast',
    `import { ${fn} } from 'node:child_process';`,
    'export function run(cwd) {',
    `  return ${fn}(${callArgs}, ${opts});`,
    '}',
    '',
  ].join('\n');
}

test('audit-subprocess-heavy-tests --scan-root: missing-timeout callsite fails, adding timeout fixes it (AC-5)', () => {
  const dir = tmpScanRoot();
  try {
    const fixturePath = path.join(dir, 'missing-timeout.test.js');
    fs.writeFileSync(fixturePath, fixtureSource('execFileSync', "'git', ['status']", false));

    const before = runAudit(dir);
    assert.equal(
      before.status,
      1,
      `expected exit 1 for missing-timeout callsite; stderr=${before.stderr}`,
    );
    assert.match(before.stderr, /new missing-timeout execFileSync\(\.\.\.\) callsite not in baseline/);

    fs.writeFileSync(fixturePath, fixtureSource('execFileSync', "'git', ['status']", true));

    const after = runAudit(dir);
    assert.equal(
      after.status,
      0,
      `expected exit 0 once timeout is added; stderr=${after.stderr}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit-subprocess-heavy-tests --scan-root: spawnSync without timeout is also caught (child_process family coverage)', () => {
  const dir = tmpScanRoot();
  try {
    const fixturePath = path.join(dir, 'missing-timeout-spawn.test.js');
    fs.writeFileSync(fixturePath, fixtureSource('spawnSync', "'node', ['-v']", false));

    const result = runAudit(dir);
    assert.equal(
      result.status,
      1,
      `expected exit 1 for missing-timeout spawnSync callsite; stderr=${result.stderr}`,
    );
    assert.match(result.stderr, /new missing-timeout spawnSync\(\.\.\.\) callsite not in baseline/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit-subprocess-heavy-tests --scan-root: clean scan root (no candidates) exits 0', () => {
  const dir = tmpScanRoot();
  try {
    fs.writeFileSync(
      path.join(dir, 'clean.test.js'),
      fixtureSource('execFileSync', "'git', ['status']", true),
    );

    const result = runAudit(dir);
    assert.equal(result.status, 0, `expected exit 0 for a clean scan root; stderr=${result.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Receiver qualification. `RegExp.prototype.exec` shares its name with
// `child_process.exec`, so the candidate matcher classifies by receiver. These
// fixtures pin BOTH directions in one test, which is what stops the fix from
// degenerating into a blanket `exec` exclusion that would blind the audit to
// the real un-timed `child_process.exec` class.
//
// The child_process fixture is assembled from split tokens (`EXEC + '('`) so
// THIS file — part of the scanned extension/tests/ corpus — never becomes a
// candidate to its own audit. The regex fixture needs no such care: a regex
// receiver is precisely what must NOT be a candidate, so writing it literally
// pins the behaviour in the real corpus too.
const EXEC = 'exec';

function regexExecFixtureSource() {
  return [
    '// @tier: fast',
    'export function countMatches(text) {',
    '  const re = /a(b)c/g;',
    '  let n = 0;',
    '  while (re.exec(text) !== null) n++;',
    '  const someRegex = /x/g;',
    '  someRegex.exec(text);',
    '  return n;',
    '}',
    '',
  ].join('\n');
}

function childProcessExecFixtureSource() {
  return [
    '// @tier: fast',
    "import * as child_process from 'node:child_process';",
    `import { ${EXEC} } from 'node:child_process';`,
    'export function runQualified(cb) {',
    `  return child_process.${EXEC}('git status', { encoding: 'utf-8' }, cb);`,
    '}',
    'export function runBare(cb) {',
    `  return ${EXEC}('git log -1', { encoding: 'utf-8' }, cb);`,
    '}',
    '',
  ].join('\n');
}

test('audit-subprocess-heavy-tests --scan-root: regex .exec is not a candidate, child_process exec still is', () => {
  const dir = tmpScanRoot();
  try {
    const fixturePath = path.join(dir, 'receiver-qualified.test.js');

    // Direction 1: `re.exec(text)` / `someRegex.exec(text)` spawn nothing.
    fs.writeFileSync(fixturePath, regexExecFixtureSource());
    const regexRun = runAudit(dir);
    assert.equal(
      regexRun.status,
      0,
      `expected exit 0 for regex .exec callsites; stderr=${regexRun.stderr}`,
    );
    assert.doesNotMatch(regexRun.stderr, /missing-timeout exec\(\.\.\.\)/);

    // Direction 2: an un-timed `child_process` exec call and a bare destructured
    // one still fail. (Written without literal call syntax so this comment is not
    // itself scanned as a callsite.)
    fs.writeFileSync(fixturePath, childProcessExecFixtureSource());
    const cpRun = runAudit(dir);
    assert.equal(
      cpRun.status,
      1,
      `expected exit 1 for un-timed child_process exec callsites; stderr=${cpRun.stderr}`,
    );
    assert.match(cpRun.stderr, /new missing-timeout exec\(\.\.\.\) callsite not in baseline/);
    const execFindings = cpRun.stderr
      .split('\n')
      .filter((line) => /missing-timeout exec\(\.\.\.\)/.test(line));
    assert.equal(
      execFindings.length,
      2,
      `expected both the qualified and the bare exec callsite; got ${execFindings.length}: ${cpRun.stderr}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// AP-EXT-ITER42-01. Every case above scans a SYNTHETIC scan-root, so they pin the
// predicate but never its self-application to the committed corpus. That arm only ran
// as `pretest:integration` — so commit 3d414e57 landed two untimed `spawnSync` callsites,
// reddened the pretest, and left the ENTIRE integration tier unrunnable for a full
// iteration while the affected fast-tier suites reported green.
//
// Scan the REAL `extension/tests` corpus against the REAL committed baseline, with the
// same file set and `--base` the shell wrapper computes. Asserting on the scanner alone
// (not `audit-subprocess-heavy-tests.sh`) keeps this case decoupled from the
// heavy-candidate arm, and skips that arm's ~21s per-file node spawns.
test('AP-EXT-ITER42-01: the committed extension/tests corpus has zero un-baselined missing-timeout callsites', () => {
  const extensionRoot = path.resolve(__dirname, '..');
  const testRoot = path.join(extensionRoot, 'tests');
  const scanner = path.resolve(extensionRoot, 'scripts/audit-subprocess-heavy-tests-missing-timeout.mjs');
  const baseline = path.resolve(extensionRoot, 'scripts/subprocess-heavy-missing-timeout-baseline.json');

  // Mirrors the wrapper's `find "$TEST_ROOT" -type f -name '*.test.js' ! -path "$TEST_ROOT/fixtures/*"`.
  const files = fs
    .readdirSync(testRoot, { recursive: true })
    .map((entry) => String(entry).split(path.sep).join('/'))
    .filter((rel) => rel.endsWith('.test.js') && !rel.startsWith('fixtures/'))
    .sort()
    .map((rel) => path.join(testRoot, rel));

  assert.ok(files.length > 0, 'fixture guard: the real test corpus must be non-empty');

  const run = spawnSync(
    process.execPath,
    [scanner, '--baseline', baseline, '--base', extensionRoot, ...files],
    { encoding: 'utf-8', timeout: 60000 },
  );

  assert.equal(
    run.status,
    0,
    `new missing-timeout callsite(s) in the committed corpus — add an explicit \`timeout:\` (a hang-guard, >=30s) at the callsite, or baseline it only if the unbounded spawn is intentional:\n${run.stdout}`,
  );
  assert.equal(run.stdout.trim(), '', `expected no findings, got:\n${run.stdout}`);
});

// AP-EXT-ITER92-01. The scanner reads RAW file text — it strips no comments — so a `//`
// documentation line that spells a call shape is a candidate exactly like real code, and
// (being un-baselined) it blanks the whole integration tier via `pretest:integration`.
// This is not hypothetical: anatomy-park commit `aa0a8bc8` documented the plan-verify seam
// by naming its consumer call in prose and blacked out the tier for a full iteration, the
// second recurrence of the AP-EXT-ITER42-01 blackout with a different producer.
//
// Pinned in BOTH directions so the rule is "prose must not spell a call shape", not
// "prose is ignored": the paren-bearing form must fail, the reworded form must pass.
// Both fixtures are assembled from split tokens so THIS file never becomes a candidate.
test('AP-EXT-ITER92-01: a child_process call shape in COMMENT PROSE is a candidate; rewording clears it', () => {
  const dir = tmpScanRoot();
  const scanner = path.resolve(__dirname, '../scripts/audit-subprocess-heavy-tests-missing-timeout.mjs');
  const FN = 'spawnSync';
  const scan = (file) =>
    spawnSync(process.execPath, [scanner, '--base', dir, file], {
      encoding: 'utf-8',
      timeout: 30000,
    });

  try {
    const fixturePath = path.join(dir, 'comment-prose.test.js');
    const body = ['export function run() {', '  return 1;', '}', ''];

    // Prose that spells the call shape, parenthesis and all.
    fs.writeFileSync(
      fixturePath,
      ['// @tier: fast', `// the sole consumer is ${FN}` + '(phase.verify, { shell: true })', ...body].join('\n'),
    );
    const flagged = scan(fixturePath);
    assert.equal(
      flagged.status,
      1,
      `a call shape in comment prose must read as a candidate; stdout=${flagged.stdout}`,
    );
    assert.match(
      flagged.stdout,
      new RegExp(`\\t${FN}\\t`),
      `the finding must name the function from the prose; got:\n${flagged.stdout}`,
    );

    // Same sentence, same meaning, no call shape — the documented remedy.
    fs.writeFileSync(
      fixturePath,
      ['// @tier: fast', `// the sole consumer is the one \`shell: true\` ${FN} in \`src/\``, ...body].join('\n'),
    );
    const cleared = scan(fixturePath);
    assert.equal(
      cleared.status,
      0,
      `rewording away the parenthesis must clear the candidate; stdout=${cleared.stdout}`,
    );
    assert.equal(cleared.stdout.trim(), '', `expected no findings, got:\n${cleared.stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// AP-EXT-ITER21-01. The scanner is a TEXTUAL predicate: it accepts any argument list
// containing `timeout:` and proves nothing about whether that option actually bounds the
// child. The callsite this case was written for is `detached: true` + `.unref()` — the one
// shape where the guard is plausibly inert, because the parent has deliberately stopped
// letting the child hold the event loop open. If `timeout:` were decorative there, every
// remediation the audit demands on a detached callsite would be a token that satisfies the
// grep and leaks the process anyway, and the audit would be greening over its own premise.
//
// Pinned in BOTH directions against the real node runtime, so the property is "the option
// bounds a detached unref'd child", not "the option is spelled": the guarded arm's child
// must be dead once its parent returns, the unguarded control's child must survive it.
// Both call shapes are assembled from split tokens and written to a tmp script, so THIS
// file never itself reads as a candidate to the audit it is testing.
test('AP-EXT-ITER21-01: `timeout:` really bounds a detached unref\'d child, it is not a token that only satisfies the grep', async () => {
  const dir = tmpScanRoot();
  const FN = 'spawn';
  const pidIsAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  // `opts` is the only difference between the two arms.
  const scriptSource = (opts) => [
    "import { " + FN + " } from 'node:child_process';",
    'const child = ' + FN + "('sleep', ['30'], " + opts + ');',
    'child.unref();',
    'process.stdout.write(String(child.pid));',
  ].join('\n');

  const runArm = (opts) => {
    const scriptPath = path.join(dir, `arm-${opts.includes('timeout') ? 'guarded' : 'control'}.mjs`);
    fs.writeFileSync(scriptPath, scriptSource(opts));
    // The guarded arm's own timer keeps its parent alive until the deadline fires, so
    // spawnSync returning IS the "past the deadline" observation — no sleep needed here.
    const run = spawnSync(process.execPath, [scriptPath], { encoding: 'utf-8', timeout: 30000 });
    assert.equal(run.status, 0, `arm exited non-zero: ${run.stderr}`);
    const pid = Number(run.stdout.trim());
    assert.ok(Number.isInteger(pid) && pid > 0, `arm must report a real pid, got ${run.stdout}`);
    return pid;
  };

  // Control FIRST: it establishes that `sleep 30` genuinely outlives an unref'd parent,
  // so the guarded arm's dead child cannot be explained by the child dying on its own.
  const controlPid = runArm("{ detached: true, stdio: 'ignore' }");
  try {
    assert.ok(
      pidIsAlive(controlPid),
      'without `timeout:` a detached unref\'d child survives its parent — if this fails the guarded assertion below proves nothing',
    );
  } finally {
    try { process.kill(controlPid, 'SIGKILL'); } catch { /* already gone */ }
  }

  const guardedPid = runArm("{ detached: true, stdio: 'ignore', timeout: 800 }");
  try {
    assert.equal(
      pidIsAlive(guardedPid),
      false,
      '`timeout:` did NOT bound a detached unref\'d child — the audit\'s prescribed remediation is decorative on exactly the shape it was applied to',
    );
  } finally {
    try { process.kill(guardedPid, 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
