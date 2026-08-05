// @tier: fast
// B-OFFREPO (AC-OFFREPO-1 / AC-OFFREPO-1b) — a gate that DID NOT RUN must not report a pass.
//
// Four sites used to return a pass-shaped value for work they never did. The worst
// asserted AUTHORSHIP: `resolveWorkerGateVerdict` returned `{verdict:'green',
// computedVia:'worker_gate'}` for a target repo with no `extension/` tree — naming a
// gate as the author of a verdict no gate produced. The fear behind it was sound (a
// blanket fail-close WOULD refuse every Done flip on a non-pickle-rick target); the
// conclusion was not. A gate that cannot run reports `not_run`, and the permissive
// policy is applied where it belongs: at the Done-flip guard, not smuggled in as a
// fake measurement.
//
// SITES below is the universal quantifier from the ticket's site table. Each row owns a
// probe that drives its site through a real seam and reports the disposition it settled
// on plus the disposition a REAL PASS would have produced. Adding a row without landing
// the behaviour reddens the suite: the probe either throws or returns the pass shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offrepo-data-')));
process.env.PICKLE_DATA_ROOT = DATA_ROOT;

const { runWorkerGate } = await import('../bin/spawn-morty.js');
const {
  resolveWorkerGateVerdict,
  guardCompletionCommitBeforeDone,
  attemptRecoveryBeforeTerminal,
  WORKER_GATE_NOT_RUN_REASON,
} = await import('../bin/mux-runner.js');

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offrepo-')));
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function initRepo(dir) {
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
}

function commitFile(dir, name, body, msg) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', msg, '--no-gpg-sign']);
  return git(dir, ['rev-parse', 'HEAD']);
}

function writeState(sessionDir, extra = {}) {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: 5,
    activity: [],
    ...extra,
  }, null, 2));
  return path.join(sessionDir, 'state.json');
}

function writeTicket(sessionDir, ticketId, fields = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = ['---', `id: ${ticketId}`, 'title: off-repo gate fixture', 'status: "In Progress"', 'order: 1'];
  for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${value}`);
  lines.push('---', '# Ticket');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
  return ticketDir;
}

function readFrontmatterField(sessionDir, ticketId, field) {
  const raw = fs.readFileSync(path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`), 'utf8');
  const match = raw.match(new RegExp(`^${field}:\\s*"?([^"\\s]+)"?\\s*$`, 'm'));
  return match ? match[1] : null;
}

/** `status:` is the one frontmatter value that is quoted AND contains a space. */
function readTicketStatus(sessionDir, ticketId) {
  const raw = fs.readFileSync(path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`), 'utf8');
  const match = raw.match(/^status:\s*"?([^"\n]+?)"?\s*$/m);
  return match ? match[1] : null;
}

function readActivity(statePath) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return Array.isArray(state.activity) ? state.activity : [];
}

function notRunResiduals(statePath) {
  return readActivity(statePath).filter(entry =>
    entry.event === 'gate_skipped' && entry.gate_payload?.reason === WORKER_GATE_NOT_RUN_REASON);
}

/** A shim that answers every `npx`/`npm` invocation with the given exit code, instantly. */
function writeShim(binDir, name, exitCode = 0) {
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, name);
  fs.writeFileSync(shimPath, `#!/usr/bin/env node\nprocess.exit(${exitCode});\n`);
  fs.chmodSync(shimPath, 0o755);
}

async function withPathPrefix(prefix, fn) {
  const prev = process.env.PATH;
  process.env.PATH = `${prefix}${path.delimiter}${prev || ''}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = prev;
  }
}

// The guard early-returns ok:true under PICKLE_TEST_MODE=1 — the Done-flip probes MUST
// exercise the real evidence + verdict path, so the var is unset and restored after.
function withoutTestMode(fn) {
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  try { return fn(); } finally { if (prev !== undefined) { process.env.PICKLE_TEST_MODE = prev; } }
}

/** A fixture repo carrying an `extension/` tree the gate considers applicable. */
function initOnRepoFixture(root) {
  initRepo(root);
  fs.mkdirSync(path.join(root, 'extension', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extension', 'bin', 'log-watcher.js'), '');
  fs.mkdirSync(path.join(root, 'extension', 'src', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extension', 'src', 'demo', 'one.ts'), 'export const one = 1;\n');
  return commitFile(root, 'extension/package.json', JSON.stringify({ name: 'fixture', private: true, type: 'module' }), 'base');
}

/**
 * Drive `runWorkerGate` over the on-repo fixture with eslint/tsc/test shims that all
 * pass, so the ONLY thing that varies between rows is whether the tier ran the tests.
 */
async function runOnRepoGate(ticketTier) {
  const root = makeTmp();
  const ticketId = 'bbb22222';
  const preWorkerHead = initOnRepoFixture(root);
  const statePath = writeState(root, { working_dir: root });
  writeTicket(root, ticketId, { complexity_tier: ticketTier });
  const shimDir = path.join(root, 'shim');
  writeShim(shimDir, 'npx');
  writeShim(shimDir, 'npm');
  const result = await withPathPrefix(shimDir, () => runWorkerGate(['extension/src/demo/one.ts'], {
    workingDir: root,
    ticketId,
    statePath,
    preWorkerHead,
    ticketTier,
  }));
  return { root, ticketId, statePath, result, testsVerdict: readFrontmatterField(root, ticketId, 'worker_gate_tests_verdict') };
}

// ---------------------------------------------------------------------------
// AC-1 — the universal quantifier over the site table.
// ---------------------------------------------------------------------------

const SITES = [
  {
    site: 'extension/src/bin/spawn-morty.ts — runWorkerGate off-repo early return',
    symbol: 'runWorkerGate',
    // Off-repo: no `extension/` tree, so no command is ever issued.
    probe: async () => {
      const root = makeTmp();
      const ticketId = 'aaa11111';
      const statePath = writeState(root, { working_dir: root });
      writeTicket(root, ticketId);
      const result = await runWorkerGate([], { workingDir: root, ticketId, statePath, preWorkerHead: null });
      return {
        disposition: readFrontmatterField(root, ticketId, 'worker_gate_verdict'),
        passDisposition: 'green',
        // `ok:true` is retained deliberately: it means "do not block the local
        // action". An `ok:false` here would flip the ticket Failed on every
        // non-pickle-rick repo — a gate STOPPING the pipeline.
        extra: () => {
          assert.equal(result.ok, true, 'an unrunnable gate must not block the local action');
          assert.equal(result.gateNotRun, true, 'the result must carry the did-not-run fact');
          assert.equal(readFrontmatterField(root, ticketId, 'worker_gate_tests_verdict'), 'not_run');
        },
      };
    },
  },
  {
    site: 'extension/src/bin/spawn-morty.ts — runWorkerGateChecks testsOk:true = "not run"',
    symbol: 'runWorkerGateChecks',
    // A `small`-tier ticket deliberately skips the test phases. That skip used to be
    // reported as `testsOk: true` and persisted as `worker_gate_tests_verdict: green`.
    probe: async () => {
      const { root, ticketId, result, testsVerdict } = await runOnRepoGate('small');
      return {
        disposition: testsVerdict,
        passDisposition: 'green',
        extra: () => {
          assert.equal(result.ok, true, 'a skipped test phase must not fail the gate');
          // The lint/tsc verdict is unaffected: those dimensions DID run and passed.
          assert.equal(readFrontmatterField(root, ticketId, 'worker_gate_verdict'), 'green');
        },
      };
    },
  },
  {
    site: 'extension/src/bin/mux-runner.ts — resolveWorkerGateVerdict no-extension arm',
    symbol: 'resolveWorkerGateVerdict',
    probe: async () => {
      const root = makeTmp();
      const ticketId = 'ccc33333';
      writeState(root, { working_dir: root });
      writeTicket(root, ticketId);
      const resolved = resolveWorkerGateVerdict(root, ticketId, root);
      return {
        disposition: `${resolved.verdict}/${resolved.computedVia}`,
        passDisposition: 'green/worker_gate',
        extra: () => {
          // AC-2: no authorship claim. `computedVia` names no gate.
          assert.equal(resolved.computedVia, 'not_applicable');
          assert.equal(resolved.verdict, 'not_run');
        },
      };
    },
  },
  {
    site: 'extension/src/bin/mux-runner.ts — attemptRecoveryBeforeTerminal.runArmedGate',
    symbol: 'attemptRecoveryBeforeTerminal',
    // The armed gate's `ok` authorises rung 1's automatic commit-and-flip-Done — the
    // highest-consequence action in the ladder. Reporting ok:true for a gate that
    // issued no command was a Done flip over zero evidence.
    probe: async () => {
      const root = makeTmp();
      const ticketId = 'ddd44444';
      const sessionDir = path.join(root, 'session');
      initRepo(root);
      commitFile(root, 'work.txt', 'base', 'baseline');
      fs.writeFileSync(path.join(root, 'work.txt'), 'dirty tree — rung 1 is reachable');
      const statePath = writeState(sessionDir, { working_dir: root });
      writeTicket(sessionDir, ticketId);
      const outcome = attemptRecoveryBeforeTerminal({
        sessionDir,
        statePath,
        // No remediator binary under this root, so rung 2 fails fast instead of
        // spawning a real gate remediator.
        extensionRoot: path.join(root, 'absent-extension-root'),
        workingDir: root,
        ticketId,
        iteration: 1,
        flags: null,
        log: () => {},
      });
      // The disposition that matters is whether the armed gate AUTHORISED rung 1,
      // not the ladder's final kind: with the gate reporting a pass, the commit is
      // attempted and merely fails for an unrelated reason, so the ladder still
      // ends `exhausted`. The ledger is what separates the two — a gate that
      // reports a pass leaves a `commit-and-continue` attempt behind ("armed gate
      // passed but commit was blocked"); a gate that reports not-run leaves none,
      // because rung 1 was never entered.
      const ladder = JSON.parse(fs.readFileSync(statePath, 'utf8')).recovery_attempts ?? [];
      const authorisedRungOne = ladder.some(a => a.strategy === 'commit-and-continue');
      return {
        disposition: authorisedRungOne ? 'armed-gate-authorised-commit-and-flip-done' : 'armed-gate-declined',
        passDisposition: 'armed-gate-authorised-commit-and-flip-done',
        extra: () => {
          assert.equal(notRunResiduals(statePath).length, 1, 'the unrun armed gate records a residual');
          assert.notEqual(outcome.kind, 'advanced', 'an unrun gate must not advance the ladder');
          assert.equal(
            readTicketStatus(sessionDir, ticketId),
            'In Progress',
            'an unrun armed gate must not auto-flip the ticket Done',
          );
        },
      };
    },
  },
];

for (const row of SITES) {
  test(`AC-1 site: ${row.site} — an unrunnable gate is distinguishable from a real pass`, async () => {
    const outcome = await row.probe();
    assert.notEqual(
      outcome.disposition,
      outcome.passDisposition,
      `${row.symbol} reported the pass disposition for work it did not do`,
    );
    assert.ok(outcome.disposition, `${row.symbol} produced no disposition at all`);
    outcome.extra();
  });
}

// The distinguishability above is only meaningful if the pass disposition is one this
// seam actually produces. This pins the comparator: the SAME fixture, with a tier that
// genuinely runs the tests, reports `green`.
test('AC-1 comparator: a tier whose tests genuinely run reports green, not not_run', async () => {
  const { result, testsVerdict } = await runOnRepoGate('medium');
  assert.equal(result.ok, true);
  assert.equal(testsVerdict, 'green', 'a test phase that ran and passed is still recorded green');
});

// ---------------------------------------------------------------------------
// AC-2 — no authorship claim on a gate that did not execute.
// ---------------------------------------------------------------------------

test('AC-2: resolveWorkerGateVerdict never returns green/worker_gate when the gate did not execute', () => {
  const root = makeTmp();
  const ticketId = 'eee55555';
  writeState(root, { working_dir: root });
  writeTicket(root, ticketId);
  const resolved = resolveWorkerGateVerdict(root, ticketId, root);
  assert.notEqual(resolved.verdict, 'green');
  assert.notEqual(resolved.computedVia, 'worker_gate');
});

// ---------------------------------------------------------------------------
// AC-3 — not_run does NOT refuse the Done flip, and leaves a residual.
// ---------------------------------------------------------------------------

test('AC-3: a not_run verdict flips Done and emits a residual naming the ticket and reason', () => {
  withoutTestMode(() => {
    const root = makeTmp();
    const ticketId = 'fff66666';
    const sessionDir = path.join(root, 'session');
    initRepo(root);
    const baseline = commitFile(root, 'init.txt', 'init', 'baseline');
    const real = commitFile(root, 'work.txt', 'real work', 'feat: real ticket work');
    const statePath = writeState(sessionDir, { start_commit: baseline, pinned_sha: null });
    writeTicket(sessionDir, ticketId, { completion_commit: real });

    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir: root, rereadBackoffMs: 0 });

    // Directive 2: a gate may block a LOCAL action, never stop the pipeline. `not_run`
    // routes through the gate-exempt evaluation instead of the fail-closed `absent`.
    assert.equal(guard.ok, true, 'a not_run verdict must not refuse the Done flip');
    assert.equal(guard.sha, real, 'the committed sha is still attributed');

    const residuals = notRunResiduals(statePath);
    assert.equal(residuals.length, 1, 'exactly one residual records the unverified state');
    assert.equal(residuals[0].ticket_id, ticketId, 'the residual names the ticket');
    assert.equal(residuals[0].gate_payload.verdict, 'not_run');
    assert.equal(residuals[0].gate_payload.site, 'guardCompletionCommitBeforeDone');
  });
});

// ---------------------------------------------------------------------------
// AC-4 — the persistence round-trip is explicit: not_run is PRESERVED.
// ---------------------------------------------------------------------------

test('AC-4: a persisted not_run round-trips as not_run, never coerced to absent', () => {
  const root = makeTmp();
  const ticketId = 'ggg77777';
  writeState(root, { working_dir: root });
  // An `extension/` tree exists, so a coercion to `absent` would be OBSERVABLE: the
  // resolver would recompute and report `between_ticket_gate` instead of reading back
  // the value that was written.
  fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
  writeTicket(root, ticketId, { worker_gate_verdict: 'not_run' });

  const resolved = resolveWorkerGateVerdict(root, ticketId, root);
  assert.equal(resolved.verdict, 'not_run', 'the persisted literal is preserved');
  assert.notEqual(resolved.verdict, 'absent', 'not_run must not be erased into the fail-closed value');
  assert.equal(readFrontmatterField(root, ticketId, 'worker_gate_verdict'), 'not_run', 'the field is left intact');
  // AC-2 applies on the READ-BACK path too. The persisted-verdict arm hardcoded
  // `computedVia: 'worker_gate'`, so a round-tripped not_run claimed a gate authored it —
  // the same authorship claim the no-extension arm was fixed to stop making.
  assert.equal(resolved.computedVia, 'not_applicable', 'a round-tripped not_run names no gate');
  assert.notEqual(resolved.computedVia, 'worker_gate', 'no gate authored a verdict no gate produced');
});

test('round-trip: a persisted green is STILL attributed to the worker gate', () => {
  const root = makeTmp();
  const ticketId = 'ggg77778';
  writeState(root, { working_dir: root });
  fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
  writeTicket(root, ticketId, { worker_gate_verdict: 'green' });

  // The not_run carve-out above must not widen into the green/red arm: those verdicts
  // WERE authored by a real gate run, and `bin/setup.ts` distinguishes a persisted
  // verdict from a recomputed one by exactly this field.
  const resolved = resolveWorkerGateVerdict(root, ticketId, root);
  assert.equal(resolved.verdict, 'green');
  assert.equal(resolved.computedVia, 'worker_gate', 'a real gate run still owns its verdict');
});

// ---------------------------------------------------------------------------
// Regression guards — the pre-existing dispositions are untouched.
// ---------------------------------------------------------------------------

test('regression: an explicit red verdict is still fail-CLOSED', () => {
  withoutTestMode(() => {
    const root = makeTmp();
    const ticketId = 'hhh88888';
    const sessionDir = path.join(root, 'session');
    initRepo(root);
    const baseline = commitFile(root, 'init.txt', 'init', 'baseline');
    const real = commitFile(root, 'work.txt', 'real work', 'feat: real ticket work');
    writeState(sessionDir, { start_commit: baseline, pinned_sha: null });
    writeTicket(sessionDir, ticketId, { completion_commit: real, worker_gate_verdict: 'red' });

    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, false, 'a recorded red verdict must NOT flip Done (R-CWGE fail-closed)');
  });
});

test('regression: an absent verdict on a repo WITH extension/ still recomputes', async () => {
  const root = makeTmp();
  const ticketId = 'iii99999';
  writeState(root, { working_dir: root });
  fs.mkdirSync(path.join(root, 'extension', 'src'), { recursive: true });
  writeTicket(root, ticketId);
  const shimDir = path.join(root, 'shim');
  writeShim(shimDir, 'npx');

  const resolved = await withPathPrefix(shimDir, () => resolveWorkerGateVerdict(root, ticketId, root));
  assert.equal(resolved.computedVia, 'between_ticket_gate', 'the recompute arm still owns an absent verdict');
  assert.equal(resolved.verdict, 'green');
  assert.notEqual(resolved.verdict, 'not_run', 'not_run must not swallow the recompute arm');
});
