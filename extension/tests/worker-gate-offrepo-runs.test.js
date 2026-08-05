// @tier: fast
//
// B-OFFREPO ticket 20 (0454370b) — the worker gate must actually RUN off-repo.
//
// Ticket 10 made the off-repo exit stop CLAIMING a pass. It still issued no
// command, so on every repo without an `extension/` tree — i.e. every repo that
// is not pickle-rick, i.e. the entire autonomy use case — the gate performed no
// lint, no typecheck and no tests. These specs pin that it now executes the
// TARGET's own toolchain and derives its verdict from the real result.
//
// Every fixture is a temp dir with NO `extension/` directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runWorkerGate } from '../bin/spawn-morty.js';
import { isAdvisoryWorkerGateVerdict } from '../bin/mux-runner.js';

const TMP_ROOTS = [];

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offrepo-gate-'));
  TMP_ROOTS.push(dir);
  return fs.realpathSync(dir);
}

process.on('exit', () => {
  for (const dir of TMP_ROOTS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function writeState(root) {
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: 5,
    working_dir: root,
    session_dir: root,
    active: true,
    activity: [],
  }));
  return statePath;
}

function writeTicket(root, ticketId) {
  const dir = path.join(root, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\nstatus: In Progress\n---\n# t\n`,
  );
}

function frontmatterField(root, ticketId, field) {
  const raw = fs.readFileSync(path.join(root, ticketId, `rick_ticket_${ticketId}.md`), 'utf8');
  const match = raw.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

/**
 * A target repo: `package.json` + `package-lock.json` (so `detectProjectType`
 * resolves `npm`) and NO `extension/` dir. Scripts are real node commands, so the
 * gate's execution is observable through the side effects they leave on disk.
 */
function makeNpmFixture({ typecheckExit = 0, lintExit = 0, testExit = 0, scripts = null } = {}) {
  const root = makeTmp();
  const ticketId = 'bbb22222';
  const probe = (name, exitCode) =>
    `node -e "require('fs').writeFileSync('${name}.ran','1');process.exit(${exitCode})"`;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'target-repo',
    version: '1.0.0',
    scripts: scripts ?? {
      typecheck: probe('typecheck', typecheckExit),
      lint: probe('lint', lintExit),
      test: probe('test', testExit),
    },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  writeTicket(root, ticketId);
  return { root, ticketId, statePath: writeState(root) };
}

function gateArgs({ root, ticketId, statePath }) {
  return { workingDir: root, ticketId, statePath, preWorkerHead: null };
}

const ranProbe = (root, name) => fs.existsSync(path.join(root, `${name}.ran`));

// ---------------------------------------------------------------------------
// AC-OFFREPO-2a — the gate EXECUTES the target's own toolchain.
// ---------------------------------------------------------------------------

test('off-repo: a resolvable npm project has its OWN lint/typecheck/test executed', async () => {
  const fixture = makeNpmFixture();
  const result = await runWorkerGate([], gateArgs(fixture));

  // The load-bearing assertion: real commands ran in the TARGET repo. Before this
  // ticket every one of these was false — the gate returned without spawning
  // anything at all.
  assert.equal(ranProbe(fixture.root, 'typecheck'), true, 'target typecheck must execute');
  assert.equal(ranProbe(fixture.root, 'lint'), true, 'target lint must execute');
  assert.equal(ranProbe(fixture.root, 'test'), true, 'target test must execute');

  assert.equal(
    frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_verdict'),
    'green',
    'a verdict derived from a genuinely passing target toolchain is green',
  );
  assert.equal(frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_tests_verdict'), 'green');
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// AC-OFFREPO-2b — unresolvable project => not_run, NEVER green.
// ---------------------------------------------------------------------------

test('off-repo: a repo with no manifest yields not_run, never green', async () => {
  const root = makeTmp();
  const ticketId = 'ccc33333';
  writeTicket(root, ticketId);
  const statePath = writeState(root);

  const result = await runWorkerGate([], gateArgs({ root, ticketId, statePath }));

  const verdict = frontmatterField(root, ticketId, 'worker_gate_verdict');
  assert.equal(verdict, 'not_run');
  assert.notEqual(verdict, 'green', 'nothing was checked, so nothing may be reported as passing');
  assert.equal(frontmatterField(root, ticketId, 'worker_gate_tests_verdict'), 'not_run');
  // Not a halt: an unrunnable gate must never block the local action.
  assert.equal(result.ok, true);
});

test('off-repo: a project type with no command-map entry (bun) is not_run, not green and not a crash', async () => {
  const root = makeTmp();
  const ticketId = 'ddd44444';
  // `detectProjectType` resolves `bun`, but `gate-commands.json` carries no bun
  // entry. Adding one would be the per-stack adapter matrix the repo-agnostic
  // invariant forbids; the honest answer is that this gate cannot run here.
  fs.writeFileSync(path.join(root, 'bun.lockb'), '');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'bun-repo' }));
  writeTicket(root, ticketId);
  const statePath = writeState(root);

  const result = await runWorkerGate([], gateArgs({ root, ticketId, statePath }));

  assert.equal(frontmatterField(root, ticketId, 'worker_gate_verdict'), 'not_run');
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// AC-OFFREPO-2c — a failing target suite FLAGS and CONTINUES; it does not halt.
// ---------------------------------------------------------------------------

test('off-repo: a failing target suite is recorded red but does NOT halt the pipeline', async () => {
  const fixture = makeNpmFixture({ testExit: 1 });
  const result = await runWorkerGate([], gateArgs(fixture));

  assert.equal(ranProbe(fixture.root, 'test'), true, 'the failing suite must actually have run');
  assert.equal(
    frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_verdict'),
    'red',
    'the verdict is honest: the target suite genuinely failed',
  );
  assert.equal(frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_tests_verdict'), 'red');

  // The whole point of AC-5. `ok:false` would trip the gate-fail tree reset and
  // flip the ticket Failed on a target repo whose suite may well have been red
  // before this worker touched it — a gate STOPPING the system.
  assert.equal(result.ok, true, 'a red target suite must not block the local action');
  assert.equal(result.failedFlipSuppressed, false);
  assert.equal(result.gatePhase, 'test:fast', 'the failing phase is flagged, not swallowed');
});

test('off-repo: a missing script is not_run, not a failure', async () => {
  // "Missing script" is an absent capability, not a code defect — the gate's own
  // `isUnrunnableCheckResult` classifier reaches that verdict from the command's
  // ACTUAL result. (Whether the command was safe to spawn AT ALL is a different
  // question, asked before this one — see the unsafe-test-script spec below.)
  const fixture = makeNpmFixture({
    scripts: { typecheck: `node -e "require('fs').writeFileSync('typecheck.ran','1')"` },
  });
  const result = await runWorkerGate([], gateArgs(fixture));

  assert.equal(ranProbe(fixture.root, 'typecheck'), true);
  assert.equal(
    frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_verdict'),
    'green',
    'one dimension genuinely ran and passed; the absent ones are exempt, not red',
  );
  assert.equal(
    frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_tests_verdict'),
    'not_run',
    'an absent test script never reports as verified',
  );
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER14-01 — an unsafe target test script is never SPAWNED.
//
// The off-repo gate resolves the target's `test` command from the same
// `data/gate-commands.json` the convergence gate uses, and the convergence gate
// refuses to spawn an e2e/playwright/hardhat leaf. Running it here would launch
// browsers / chain nodes / real services once per ticket on an arbitrary repo —
// and no exit-code classifier can un-launch them.
// ---------------------------------------------------------------------------

test('off-repo: an unsafe (smoke/e2e-class) target test script is NOT spawned — not_run, never launched', async () => {
  const fixture = makeNpmFixture({
    scripts: {
      typecheck: `node -e "require('fs').writeFileSync('typecheck.ran','1')"`,
      // Spawnable and would succeed — the ONLY thing stopping it is the safety
      // classifier. A non-existent binary (`playwright`) would prove nothing here:
      // it reads not_run via ENOENT whether or not the guard exists.
      test: 'node ./run-smoke.js',
    },
  });
  fs.writeFileSync(
    path.join(fixture.root, 'run-smoke.js'),
    `require('fs').writeFileSync('test.ran','1');\n`,
  );

  const result = await runWorkerGate([], gateArgs(fixture));

  assert.equal(ranProbe(fixture.root, 'typecheck'), true, 'the safe dimensions still execute');
  assert.equal(
    ranProbe(fixture.root, 'test'), false,
    'the unsafe test script must never have been spawned — this file exists only if it ran',
  );
  assert.equal(
    frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_tests_verdict'),
    'not_run',
    'a script we declined to spawn is not_run — never green, never red',
  );
  assert.equal(
    frontmatterField(fixture.root, fixture.ticketId, 'worker_gate_verdict'),
    'green',
    'typecheck genuinely ran and passed; the declined dimension is exempt, not a failure',
  );
  assert.equal(result.ok, true, 'declining to spawn must not block the local action');
});

test('off-repo: the spawn decision uses the convergence gate ONE classifier, not a second copy', () => {
  const spawnMorty = fs.readFileSync(new URL('../src/bin/spawn-morty.ts', import.meta.url), 'utf8');

  assert.match(
    spawnMorty,
    /classifyTestScriptSafety\(project\.projectType, project\.dir\)/,
    'the off-repo test dimension must ask the shared classifier before spawning',
  );
  // A local unsafe-pattern list here is the divergence this fix removes: the two
  // gates would then answer the same question about the same script differently.
  assert.equal(
    /playwright|cypress|hardhat/.test(spawnMorty.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    false,
    'no second unsafe-test-script pattern may be declared on the gate path',
  );
});

// ---------------------------------------------------------------------------
// AC-OFFREPO-2c — the Done-flip policy split. This is what keeps an honest red
// from fail-closing the guard and halting the pipeline.
// ---------------------------------------------------------------------------

test('isAdvisoryWorkerGateVerdict: a TARGET-repo red is advisory, pickle-rick red stays fail-closed', () => {
  const offRepo = makeTmp();                                   // no extension/
  const selfRepo = makeTmp();
  fs.mkdirSync(path.join(selfRepo, 'extension'));              // pickle-rick shape

  assert.equal(
    isAdvisoryWorkerGateVerdict('red', offRepo), true,
    'a red authored by a target repo flags and continues',
  );
  assert.equal(
    isAdvisoryWorkerGateVerdict('red', selfRepo), false,
    'pickle-rick own red MUST stay fail-closed — this is the R-CWGE protection',
  );

  // not_run stays advisory everywhere (ticket 10's contract).
  assert.equal(isAdvisoryWorkerGateVerdict('not_run', offRepo), true);
  assert.equal(isAdvisoryWorkerGateVerdict('not_run', selfRepo), true);

  // `absent` is "the gate never reported" — fail-closed everywhere, off-repo included.
  assert.equal(
    isAdvisoryWorkerGateVerdict('absent', offRepo), false,
    'absent is not the same fact as a gate that ran and failed',
  );
  assert.equal(isAdvisoryWorkerGateVerdict('green', offRepo), false);
});

// ---------------------------------------------------------------------------
// AC-OFFREPO-2 / repo-agnostic invariant — no new package-manager matrix.
// ---------------------------------------------------------------------------

test('no per-stack adapter matrix: the gate path declares no package-manager name list', () => {
  const sources = [
    fs.readFileSync(new URL('../src/bin/spawn-morty.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/bin/mux-runner.ts', import.meta.url), 'utf8'),
  ].join('\n');

  // A literal array/set enumerating package managers is the adapter matrix this
  // invariant forbids: `detectProjectType`'s return type and the shared
  // `gate-commands.json` map are the only sanctioned enumerations.
  const managerListLiteral = /\[\s*(['"])(?:pnpm|npm|yarn|bun|cargo|go)\1\s*,\s*(['"])(?:pnpm|npm|yarn|bun|cargo|go)\2/;
  assert.equal(
    managerListLiteral.test(sources), false,
    'no literal package-manager list may be introduced on the gate path',
  );

  // The command map must be READ from the shared data file, not re-declared here.
  assert.match(
    sources,
    /gate-commands\.json/,
    'the gate must consume the existing shared command map',
  );
});
