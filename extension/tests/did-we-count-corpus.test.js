// @tier: fast
// Ticket 984a768c: well-formedness assertions over the honest 18-sha did-we-count corpus.
// Ticket 60f75491 (AC-2'): firing positive-control assertions for 2c857117 — see below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CORPUS, DETECTABLE_CEILING } from '../services/did-we-count-corpus.js';
import {
  replayCorpus,
  buildAstCheckRegistry,
  extractEnclosingFunctionSnippet,
  ruleFiresOnSnippet,
  resolveReplayRepoRoot,
} from '../bin/did-we-count-replay.js';

const VALID_BUCKETS = new Set(['detectable', 'semantic', 'out-of-reach']);
const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CORPUS has exactly 18 entries', () => {
  assert.equal(CORPUS.length, 18);
});

test('every entry has a valid bucket literal', () => {
  for (const entry of CORPUS) {
    assert.ok(VALID_BUCKETS.has(entry.bucket), `${entry.sha} has invalid bucket ${entry.bucket}`);
  }
});

test('every entry has a non-empty reason', () => {
  for (const entry of CORPUS) {
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.trim().length > 0, `${entry.sha} has an empty reason`);
  }
});

test('no sha appears twice', () => {
  const shas = CORPUS.map((entry) => entry.sha);
  assert.equal(new Set(shas).size, shas.length);
});

test('detectable count matches DETECTABLE_CEILING', () => {
  const detectable = CORPUS.filter((entry) => entry.bucket === 'detectable');
  assert.equal(detectable.length, DETECTABLE_CEILING);
});

test('2c857117 is present as a positive control, not an exemption', () => {
  const entry = CORPUS.find((e) => e.sha === '2c857117');
  assert.ok(entry, '2c857117 must be present in CORPUS');
  assert.equal(entry.bucket, 'out-of-reach');
  assert.equal(entry.positive_control, true);
  assert.equal(entry.expect_fire_on_parent, true);
  assert.equal(entry.expect_fire_on_fix, true);
});

// AC-2' (ticket 60f75491): a positive control is only real if something actually probes it.
// The metadata test above asserts the CORPUS entry's shape but never reads the source files it
// describes. These two tests probe both documented arms of the 2c857117 defect directly and
// assert the check FIRES (the pattern is found) — a firing positive control is the CORRECT,
// passing outcome, because the defect is genuinely still live at HEAD. If either arm is ever
// actually fixed, the corresponding assertion below MUST fail loudly so a human re-dispositions
// the did-we-count-corpus.ts entry — it must never silently pass over a genuine fix.

test("2c857117 positive control FIRES: pickle-utils.ts process-identity arm is live at HEAD", () => {
  const filePath = path.join(EXTENSION_ROOT, 'src', 'services', 'pickle-utils.ts');
  const source = fs.readFileSync(filePath, 'utf8');
  assert.ok(
    source.includes('const oldPid = s.monitor_pid;'),
    'src/services/pickle-utils.ts no longer contains "const oldPid = s.monitor_pid;". ' +
      'If this arm of the 2c857117 process-identity defect was genuinely fixed, re-dispose the ' +
      'did-we-count-corpus.ts entry for 2c857117 — do not flip expect_fire_on_fix to false ' +
      'without also verifying the mux-runner.ts arm below.',
  );
});

test("2c857117 positive control FIRES: mux-runner.ts process-identity arm is live at HEAD", () => {
  const filePath = path.join(EXTENSION_ROOT, 'src', 'bin', 'mux-runner.ts');
  const source = fs.readFileSync(filePath, 'utf8');
  assert.ok(
    source.includes("suspects.set(pidFromFile, 'from-pidfile');"),
    'src/bin/mux-runner.ts no longer contains "suspects.set(pidFromFile, \'from-pidfile\');". ' +
      'If this arm of the 2c857117 process-identity defect was genuinely fixed, re-dispose the ' +
      'did-we-count-corpus.ts entry for 2c857117 — do not flip expect_fire_on_fix to false ' +
      'without also verifying the pickle-utils.ts arm above.',
  );
});

// Ticket 7b4f5d60 (d7c017ff's 4 landed rules, wired into the replay): the honest partition
// after wiring. Exactly the 7 detectable shas the 4 rules actually cover replay `pass`; the
// other 2 detectable shas (process-identity membership/identity defects no landed rule
// reaches) stay `no-check-yet`, and NO semantic or out-of-reach sha is ever given a check —
// widening either would be the "stretch a matcher" move this ticket is forbidden from making.
test('replay wiring: exactly the 7 rule-covered detectable shas pass, everything else stays no-check-yet', () => {
  const results = replayCorpus(CORPUS, buildAstCheckRegistry());
  const bySha = new Map(results.map((r) => [r.sha, r]));

  const expectedPass = new Set(['7e06e8b2', 'e2804228', 'd24cec5e', 'c7c85ef3', '0cf3b8e3', 'ff8d4739', '41b9b255']);

  for (const sha of expectedPass) {
    assert.equal(bySha.get(sha)?.status, 'pass', `${sha} must replay as pass (fires on parent, not on fix)`);
  }
  for (const entry of CORPUS) {
    if (expectedPass.has(entry.sha)) continue;
    assert.equal(
      bySha.get(entry.sha)?.status,
      'no-check-yet',
      `${entry.sha} (${entry.bucket}) must never replay as pass or fail without a real registered check`,
    );
  }

  const passCount = results.filter((r) => r.status === 'pass').length;
  const failCount = results.filter((r) => r.status === 'fail').length;
  assert.equal(passCount, 7, 'exactly 7 of 18 shas are replayed today — never stretch this number');
  assert.equal(failCount, 0);
});

// ===========================================================================
// AP-EXT-ITER61-01 regression: the replay harness must never report an UNMEASURED
// rule as "did not fire". `Linter.verify()` answers a parse failure with a single
// `fatal` message carrying `ruleId: null`, which a bare
// `.some(m => m.ruleId === ruleId)` reads as `false` — and because every AST check
// expects `expect_fire_on_fix: false`, that silent `false` satisfies the fix-side
// arm of the oracle having linted nothing. This is the did-we-count defect class
// inside the did-we-count harness itself.
//
// The flow traced end to end below is the real one:
//   historical file content
//     -> extractEnclosingFunctionSnippet()   (can emit an unparseable snippet:
//        a ts.isMethodDeclaration hit is returned bare, and `foo() { ... }` is
//        not a standalone statement)
//     -> ruleFiresOnSnippet()                (must refuse to answer, not say false)
// ===========================================================================

// `audit-subprocess-heavy-tests-missing-timeout.mjs` scans this file's SOURCE TEXT
// for `spawnSync(`, so spelling the call inline inside these fixture strings would
// register four phantom un-baselined callsites. The snippets below are lint fixture
// INPUT, never executed here — building the callee from this constant keeps the
// linted snippet byte-identical while leaving the audit nothing to match.
const CAPTURE = 'spawnSync';

test('AP-EXT-ITER61-01: extractEnclosingFunctionSnippet emits an unparseable snippet for a class method', () => {
  const source = [
    'class Runner {',
    '  runIt(args) {',
    `    return ${CAPTURE}('git', args, { encoding: 'utf-8' });`,
    '  }',
    '}',
  ].join('\n');

  const snippet = extractEnclosingFunctionSnippet(source, "spawnSync('git', args");

  assert.equal(
    snippet.startsWith('runIt(args)'),
    true,
    'a method declaration is returned bare — the arrow/function-expression wrap does not cover it',
  );
  assert.equal(
    snippet.includes('class '),
    false,
    'the bare method body is NOT wrapped in a class, which is what makes it unparseable as a module',
  );
});

test('AP-EXT-ITER61-01: ruleFiresOnSnippet throws on an unparseable snippet instead of answering false', () => {
  const source = [
    'class Runner {',
    '  runIt(args) {',
    `    return ${CAPTURE}('git', args, { encoding: 'utf-8' });`,
    '  }',
    '}',
  ].join('\n');

  const unparseable = extractEnclosingFunctionSnippet(source, "spawnSync('git', args");

  assert.throws(
    () => ruleFiresOnSnippet('pickle/require-max-buffer-on-capture', unparseable),
    (err) => {
      assert.match(err.message, /did not parse/);
      assert.match(err.message, /never measured/);
      return true;
    },
    'an unparsed snippet must surface as a thrown cannot-measure, never as a quiet "did not fire" that ' +
      'vacuously satisfies expect_fire_on_fix: false',
  );
});

test('AP-EXT-ITER61-01: a parseable snippet still reports both arms of the rule honestly', () => {
  const firing = [
    'function runIt() {',
    `  return ${CAPTURE}('git', ['ls-files'], { encoding: 'utf-8' });`,
    '}',
  ].join('\n');
  const fixed = [
    'function runIt() {',
    `  return ${CAPTURE}('git', ['ls-files'], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });`,
    '}',
  ].join('\n');

  assert.equal(
    ruleFiresOnSnippet('pickle/require-max-buffer-on-capture', firing),
    true,
    'the defective shape must still fire — the throw must not have swallowed the firing path',
  );
  assert.equal(
    ruleFiresOnSnippet('pickle/require-max-buffer-on-capture', fixed),
    false,
    'the fixed shape must still report a genuine, measured false',
  );
});


// ===========================================================================
// AP-EXT-ITER57-01: audit-did-we-count.sh must count COMPARISONS MADE, not
// files opened. The script had no behavioural test at all — only its
// registration in the gate string was pinned (release-gate-parity,
// release-gate-wiring) — so an oracle reporting green having compared nothing
// was invisible to the release gate. All three RED arms below were measured
// exit 0 on the pre-fix script; the aggregate files-scanned guard could not
// tell "check reached nothing" from "check found no drift".
// ===========================================================================

const DID_WE_COUNT_SCRIPT = path.join(EXTENSION_ROOT, 'scripts', 'audit-did-we-count.sh');
// Well clear of the audit-subprocess-heavy-tests FAIL (<=5000ms) and WARN
// (<=15000ms) bands: a ceiling on a millisecond-scale script, not a wait.
const DID_WE_COUNT_TIMEOUT_MS = 30000;
const DID_WE_COUNT_ENGINE_NODE = '22.x';

function pinnedWorkflow(version) {
  return `name: ci\njobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '${version}'\n`;
}

// Real drift shape: the pin moves to node-version-file, so the regex matches nothing.
const UNPINNED_WORKFLOW =
  'name: ci\njobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n';

/**
 * Build a throwaway repo root and run the shipped script against it via
 * DID_WE_COUNT_REPO_ROOT_OVERRIDE. `workflow` null omits ci.yml entirely;
 * `catalog` false omits the CLAUDE.md that check 2 counts. `extraWorkflows`
 * (name -> content) adds SIBLING workflow files — the multi-file shape is the
 * only one that can express AP-EXT-ITER79-TD1, where a healthy sibling's pins
 * carry the aggregate over an uncounted workflow.
 */
function runDidWeCount({ workflow, catalog = true, extraWorkflows = {}, subdir = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'did-we-count-'));
  const subdirPath = subdir ? path.join(root, subdir.name) : null;
  try {
    fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'extension', 'package.json'),
      JSON.stringify({ engines: { node: DID_WE_COUNT_ENGINE_NODE } }, null, 2),
    );
    if (workflow !== null) {
      fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), workflow);
    }
    for (const [name, content] of Object.entries(extraWorkflows)) {
      fs.writeFileSync(path.join(root, '.github', 'workflows', name), content);
    }
    if (catalog) {
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# fixture catalog\n');
    }
    if (subdir) {
      fs.mkdirSync(subdirPath, { recursive: true });
      fs.writeFileSync(path.join(subdirPath, 'CLAUDE.md'), subdir.content);
      fs.chmodSync(subdirPath, subdir.mode);
    }
    return spawnSync('bash', [DID_WE_COUNT_SCRIPT], {
      encoding: 'utf8',
      timeout: DID_WE_COUNT_TIMEOUT_MS,
      env: { ...process.env, DID_WE_COUNT_REPO_ROOT_OVERRIDE: root },
    });
  } finally {
    // rm cannot descend a mode-000 directory either; restore before cleanup.
    if (subdirPath) fs.chmodSync(subdirPath, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// AP-EXT-ITER226-01. The per-DIRECTORY arm of the rule the two arms above enforce per
// comparison and per file. `findClaudeMdFiles` swallowed the readdir error for a directory it
// could not enter, so every catalog beneath it went uncompared while `claudeMdFiles.length` —
// the honesty counter `requireCounted` reads — stayed satisfied by the readable siblings. The
// counter counts what the walk FOUND, and nothing invalidated it. That is AP-EXT-ITER79-TD1's
// shape one check over: a healthy sibling carrying the aggregate past an uncounted unit.
//
// MEASURED on the pre-fix script: the RED arm below exited 0 printing "no drift found" over an
// EMPTY catalog — the 2c857117 shape check 2 exists to catch — buried one mode-000 directory deep.
const DARK_DIR_MODE = 0o000;

// chmod is advisory to uid 0, so under a root-owned container this row would measure the
// readable case twice and pass vacuously. Ask the filesystem whether the mode took, and report
// an honest skip rather than scoring the silence as agreement.
function darkDirTakes(t) {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'did-we-count-probe-'));
  try {
    fs.chmodSync(probe, DARK_DIR_MODE);
    try {
      fs.readdirSync(probe);
    } catch {
      return true;
    }
    t.skip(`mode 000 is advisory to this uid (${process.getuid?.()}); the dark-subtree arm cannot be measured here`);
    return false;
  } finally {
    fs.chmodSync(probe, 0o755);
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER226-01: a subtree the walk cannot enter is not a clean tree', (t) => {
  if (!darkDirTakes(t)) return;

  const res = runDidWeCount({
    workflow: pinnedWorkflow(DID_WE_COUNT_ENGINE_NODE),
    subdir: { name: 'dark', content: '   \n\n', mode: DARK_DIR_MODE },
  });

  assert.equal(res.status, 1, `an unreadable subtree must not report clean; stdout: ${res.stdout}`);
  assert.match(res.stderr, /dark: unreadable directory — any CLAUDE\.md beneath it was never compared/);
  assert.doesNotMatch(res.stdout, /no drift found/);
  // The aggregate arm cannot be what fired: the root catalog was compared.
  assert.doesNotMatch(res.stderr, /check 2 \(CLAUDE\.md catalog reachability\): zero comparisons made/);
  // Nor could the empty-catalog arm — the walk never reached it. Darkness IS the verdict.
  assert.doesNotMatch(res.stderr, /2c857117 defect shape/);
});

test('AP-EXT-ITER226-01 control: the same buried catalog, readable, is caught on its own merits', () => {
  // Disjoint on the directory MODE alone — same tree, same contents, same workflow. A gate
  // rejecting on anything but "could not enter this directory" reds this row too.
  const res = runDidWeCount({
    workflow: pinnedWorkflow(DID_WE_COUNT_ENGINE_NODE),
    subdir: { name: 'dark', content: '   \n\n', mode: 0o755 },
  });

  assert.equal(res.status, 1, `a reachable empty catalog must still fail; stdout: ${res.stdout}`);
  assert.match(res.stderr, /dark\/CLAUDE\.md: empty catalog file/);
  assert.doesNotMatch(res.stderr, /unreadable directory/);
});

test('AP-EXT-ITER226-01 non-vacuity: a healthy nested catalog still passes', () => {
  // The walk must descend and the new report must not degrade into "any subdirectory reds".
  const res = runDidWeCount({
    workflow: pinnedWorkflow(DID_WE_COUNT_ENGINE_NODE),
    subdir: { name: 'nested', content: '# nested catalog\n', mode: 0o755 },
  });

  assert.equal(res.status, 0, `a readable non-empty nested catalog must pass; stderr: ${res.stderr}`);
  assert.match(res.stdout, /2 CLAUDE\.md catalog\(s\) compared/);
});

test('AP-EXT-ITER57-01 control: a matching pin passes and the summary reports pins COMPARED', () => {
  const res = runDidWeCount({ workflow: pinnedWorkflow(DID_WE_COUNT_ENGINE_NODE) });
  assert.equal(res.status, 0, `expected pass; stderr: ${res.stderr}`);
  assert.match(
    res.stdout,
    /1 node-version pin\(s\) across 1 workflow file\(s\)/,
    'the summary must report comparisons made, not merely files opened',
  );
});

test('AP-EXT-ITER57-01 control: a drifted pin still fails loud (the audit is not neutered)', () => {
  const res = runDidWeCount({ workflow: pinnedWorkflow('20.x') });
  assert.equal(res.status, 1, 'a pin disagreeing with engines.node must fail');
  assert.match(res.stderr, /node-version '20\.x' does not match engines\.node '22\.x'/);
});

test('AP-EXT-ITER57-01 arm A: workflows carrying ZERO node-version pins fail closed', () => {
  const res = runDidWeCount({ workflow: UNPINNED_WORKFLOW });
  assert.equal(res.status, 1, `check 1 compared zero pins and must not report clean; stdout: ${res.stdout}`);
  assert.match(res.stderr, /check 1 \(workflow node-version parity\): zero comparisons made/);
});

test('AP-EXT-ITER57-01 arm B: a workflows dir with ZERO .yml files fails closed', () => {
  // The dir exists (readdirSync does not throw) but yields no workflow file.
  // Pre-fix, check 2's healthy CLAUDE.md count carried the aggregate over zero.
  const res = runDidWeCount({ workflow: null });
  assert.equal(res.status, 1, `check 1 reached no workflow file and must not report clean; stdout: ${res.stdout}`);
  assert.match(res.stderr, /check 1 \(workflow node-version parity\): zero comparisons made/);
});

// AP-EXT-ITER79-TD1: `pinsCompared` is accumulated across the workflow loop, so
// arm A above only fires when EVERY workflow is unpinned. Measured on the
// pre-fix script: two pinned workflows plus one setup-node step carrying no
// `node-version:` exited 0 while the summary printed "2 pin(s) across 3 workflow
// file(s)" — the ff2846d1 "three workflows, only two caught" shape, reported
// clean. Check 1's unit is the setup-node STEP, asserted per file.

const NODELESS_WORKFLOW = 'name: docs\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n';

const TWO_STEP_ONE_PIN_WORKFLOW =
  'name: ci\njobs:\n  a:\n    steps:\n' +
  "      - uses: actions/setup-node@v4\n        with:\n          node-version: '22.x'\n" +
  '      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n';

test('AP-EXT-ITER79-TD1: an unpinned workflow beside pinned siblings fails closed and is NAMED', () => {
  const res = runDidWeCount({
    workflow: pinnedWorkflow(DID_WE_COUNT_ENGINE_NODE),
    extraWorkflows: {
      'release.yml': pinnedWorkflow(DID_WE_COUNT_ENGINE_NODE),
      'stability-gate.yml': UNPINNED_WORKFLOW,
    },
  });
  assert.equal(
    res.status,
    1,
    `a setup-node step comparing zero pins must fail even when siblings are pinned; stdout: ${res.stdout}`,
  );
  assert.match(
    res.stderr,
    /stability-gate\.yml: 1 actions\/setup-node step\(s\) but 0 node-version pin\(s\)/,
    'the failure must name the uncounted workflow — an aggregate count cannot',
  );
  // The aggregate arm cannot be what fired: the pinned siblings made comparisons.
  assert.doesNotMatch(res.stderr, /check 1 \(workflow node-version parity\): zero comparisons made/);
});

test('AP-EXT-ITER79-TD1: the unit is the setup-node STEP, not the file', () => {
  const res = runDidWeCount({ workflow: TWO_STEP_ONE_PIN_WORKFLOW });
  assert.equal(res.status, 1, `a second unpinned setup-node step must fail; stdout: ${res.stdout}`);
  assert.match(res.stderr, /ci\.yml: 2 actions\/setup-node step\(s\) but 1 node-version pin\(s\)/);
});

test('AP-EXT-ITER79-TD1 non-vacuity: a workflow that never selects Node is NOT required to pin', () => {
  // Keyed on setup-node so the guard cannot degrade into "every .yml must pin",
  // which would red a legitimate node-free workflow and make the audit a brake.
  const res = runDidWeCount({
    workflow: pinnedWorkflow(DID_WE_COUNT_ENGINE_NODE),
    extraWorkflows: { 'docs.yml': NODELESS_WORKFLOW },
  });
  assert.equal(res.status, 0, `a workflow with no setup-node step must not fail; stderr: ${res.stderr}`);
  assert.match(res.stdout, /1 node-version pin\(s\) across 2 workflow file\(s\)/);
});

test('AP-EXT-ITER57-01 arm C: check 2 fails closed on zero catalogs even when check 1 is healthy', () => {
  const res = runDidWeCount({ workflow: pinnedWorkflow(DID_WE_COUNT_ENGINE_NODE), catalog: false });
  assert.equal(res.status, 1, `check 2 reached no catalog and must not report clean; stdout: ${res.stdout}`);
  assert.match(res.stderr, /check 2 \(CLAUDE\.md catalog reachability\): zero comparisons made/);
});

test('AP-EXT-ITER57-01: the empty-catalog (2c857117) arm still fires — the guard did not replace it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'did-we-count-empty-'));
  try {
    fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'extension', 'package.json'),
      JSON.stringify({ engines: { node: DID_WE_COUNT_ENGINE_NODE } }, null, 2),
    );
    fs.writeFileSync(
      path.join(root, '.github', 'workflows', 'ci.yml'),
      pinnedWorkflow(DID_WE_COUNT_ENGINE_NODE),
    );
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '   \n\n');
    const res = spawnSync('bash', [DID_WE_COUNT_SCRIPT], {
      encoding: 'utf8',
      timeout: DID_WE_COUNT_TIMEOUT_MS,
      env: { ...process.env, DID_WE_COUNT_REPO_ROOT_OVERRIDE: root },
    });
    assert.equal(res.status, 1, 'an empty catalog must still fail');
    assert.match(res.stderr, /empty catalog file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// AP-EXT-ITER102-01 regression: `resolveReplayRepoRoot` must DECODE its own
// module URL before handing it to git as a `cwd`.
//
// A `file://` URL is percent-encoded by specification, so the prior
// `new URL(import.meta.url).pathname` spelling answered `.../my%20repo/...` for a
// checkout under `.../my repo/...`. That directory does not exist, so
// `execFileSync` threw ENOENT — the fast-tier replay oracle below
// (`buildAstCheckRegistry()`, no argument) went red on a healthy repo, and the
// CLI's `buildRegistryOrEmpty()` swallowed the throw and reported all 18 shas
// `no-check-yet` having measured nothing.
//
// Exercises the real data flow, not the spelling: a REAL git repo under a REAL
// spaced path, a REAL `file://` URL of a module inside it, and the REAL
// `git rev-parse --show-toplevel` call. `pathToFileURL` produces exactly the
// `import.meta.url` Node would hand this module from that checkout.
// ===========================================================================
test('AP-EXT-ITER102-01: resolveReplayRepoRoot decodes a percent-encoded module URL', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-dwc-space-'));
  // The space is the whole point — it is what `.pathname` percent-encodes.
  const repoRoot = path.join(parent, 'my repo');
  try {
    fs.mkdirSync(path.join(repoRoot, 'extension', 'bin'), { recursive: true });
    const init = spawnSync('git', ['init', '-q', repoRoot], {
      encoding: 'utf8',
      timeout: DID_WE_COUNT_TIMEOUT_MS,
    });
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`);

    const moduleUrl = pathToFileURL(
      path.join(repoRoot, 'extension', 'bin', 'did-we-count-replay.js'),
    ).href;
    assert.ok(moduleUrl.includes('%20'), 'fixture must actually produce a percent-encoded URL');

    // git resolves symlinks (/var -> /private/var on macOS), so compare realpaths.
    assert.equal(
      resolveReplayRepoRoot(moduleUrl),
      fs.realpathSync(repoRoot),
      'a checkout under a path containing a space must resolve, not throw ENOENT',
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER102-01: resolveReplayRepoRoot resolves this repo from its own default URL', () => {
  // The no-argument path the fast-tier oracle and the CLI both take.
  assert.equal(resolveReplayRepoRoot(), fs.realpathSync(path.resolve(EXTENSION_ROOT, '..')));
});
