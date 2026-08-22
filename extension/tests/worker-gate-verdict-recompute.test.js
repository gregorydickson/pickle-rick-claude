// @tier: fast
// B-CWGE (R-CWGE/R-DOTR) + R-WGFR: the ABSENT worker-gate verdict recompute MUST enforce
// the DETERMINISTIC eslint + tsc dimensions. A codex / detached / salvaged worker that never
// persisted `worker_gate_verdict` reaches this path; a lint-RED or tsc-RED tree (stale
// compiled JS hides the tsc-RED entirely) must recompute 'red' so the Done-flip guard cannot
// ship Done-over-red on the lint/tsc dimensions (the 2026-06-27 codex soak class).
//
// R-WGFR (SUBTRACTION): the `test:fast` dimension is DROPPED — eslint/tsc are deterministic;
// only `test:fast` flakes (a single c=8 timeout-flake false-red the recompute and killed a
// GREEN bundle FATAL). The recompute takes NO test seam: eslint+tsc green => green, no spawn.
// These tests inject a fake check runner so no real eslint/tsc spawns are needed.
//
// R-PTSB: importing the session-writing mux-runner bin requires a sandboxed data root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PICKLE_DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwge-recompute-')));

const { recomputeAbsentWorkerGateVerdict } = await import('../bin/mux-runner.js');

// runCheck(bin, args, dir) -> boolean; args[0] is 'eslint' then 'tsc'.
function fakeCheck({ eslint = true, tsc = true } = {}) {
  const calls = [];
  const fn = (_bin, args) => {
    const tool = args[0];
    calls.push(tool);
    if (tool === 'eslint') return eslint;
    if (tool === 'tsc') return tsc;
    throw new Error(`unexpected check tool: ${tool}`);
  };
  fn.calls = calls;
  return fn;
}

test('R-WGFR recompute: eslint+tsc green => green with NO test invocation', () => {
  const check = fakeCheck({ eslint: true, tsc: true });
  // Only two args: the recompute has no runTests seam to inject.
  const verdict = recomputeAbsentWorkerGateVerdict('/ext', check);
  assert.equal(verdict, 'green');
  assert.deepEqual(check.calls, ['eslint', 'tsc'], 'eslint then tsc both ran; nothing else');
  // Arity proof: the third (test) parameter is gone — the signature is (dir, runCheck).
  assert.equal(
    recomputeAbsentWorkerGateVerdict.length,
    1,
    'only extensionDir is required (runCheck defaulted); no runTests param',
  );
});

test('R-CWGE recompute: lint-RED tree => red (eslint short-circuits tsc)', () => {
  const check = fakeCheck({ eslint: false });
  const verdict = recomputeAbsentWorkerGateVerdict('/ext', check);
  assert.equal(verdict, 'red', 'eslint failure must recompute red');
  assert.deepEqual(check.calls, ['eslint'], 'eslint short-circuits before tsc');
});

test('R-CWGE recompute: tsc-RED tree => red (tsc ran after eslint passed)', () => {
  const check = fakeCheck({ eslint: true, tsc: false });
  const verdict = recomputeAbsentWorkerGateVerdict('/ext', check);
  assert.equal(verdict, 'red', 'tsc failure must recompute red');
  assert.deepEqual(check.calls, ['eslint', 'tsc'], 'tsc ran after eslint passed');
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER43-01: a gate that produced NO exit code did not measure RED.
//
// The three cases above inject `runCheck`, so `defaultRecomputeCheck` — the real
// spawn wrapper — was never exercised. `spawnSync` does NOT throw for ENOENT /
// ETIMEDOUT / ENOBUFS / signal-kill; it returns `{status: null, error}`, which
// `r.status === 0` reads as a measured RED. `resolveWorkerGateVerdict` then
// PERSISTS that red into the ticket frontmatter, so every later read short-circuits
// on it (`computedVia: 'worker_gate'` — a gate authored it) and the Done-flip is
// refused forever over green work.
//
// Assert the ON-DISK STAMP alongside the verdict: `absent` and `red` are both
// fail-closed in-session, so a verdict-only oracle understates the bug — the
// durable frontmatter write is what makes it unrecoverable.
// ---------------------------------------------------------------------------

const { resolveWorkerGateVerdict } = await import('../bin/mux-runner.js');

const TICKET_FRONTMATTER = (id) =>
  `---\nid: "${id}"\nstatus: "In Progress"\ncomplexity_tier: "medium"\n---\n\nbody\n`;

/**
 * A workingDir whose `extension` entry EXISTS (so `resolveWorkerGateVerdict`
 * reaches the recompute rather than the off-repo `not_run` early return) but is a
 * FILE, so the sync spawn fails on `cwd` before exec with no exit code. Offline,
 * deterministic, and the same `status === null` shape as npx-missing / timeout /
 * ENOBUFS.
 */
function makeUnrunnableGateFixture(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cwge-${label}-`)));
  const sessionDir = path.join(root, 'session');
  const ticketId = 'ab12cd34';
  fs.mkdirSync(path.join(sessionDir, ticketId), { recursive: true });
  const ticketPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
  fs.writeFileSync(ticketPath, TICKET_FRONTMATTER(ticketId));
  const workingDir = path.join(root, 'repo');
  fs.mkdirSync(workingDir, { recursive: true });
  fs.writeFileSync(path.join(workingDir, 'extension'), 'not a directory');
  return { root, sessionDir, ticketId, ticketPath, workingDir };
}

test('AP-EXT-ITER43-01: a gate that cannot run reads absent/unavailable, never a measured red', () => {
  const fx = makeUnrunnableGateFixture('unrunnable');
  try {
    const resolved = resolveWorkerGateVerdict(fx.sessionDir, fx.ticketId, fx.workingDir);
    assert.notEqual(
      resolved.verdict,
      'red',
      'a spawn that produced no exit code measured nothing; it must not author a red',
    );
    assert.equal(resolved.verdict, 'absent', 'an errored gate is absent (AC-CWGE-6 fail-closed)');
    assert.equal(
      resolved.computedVia,
      'unavailable',
      'computedVia must not claim a gate authored this verdict (B-OFFREPO authorship rule)',
    );
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER43-01: an unrunnable gate writes NO worker_gate_verdict stamp', () => {
  const fx = makeUnrunnableGateFixture('nostamp');
  try {
    resolveWorkerGateVerdict(fx.sessionDir, fx.ticketId, fx.workingDir);
    const raw = fs.readFileSync(fx.ticketPath, 'utf8');
    assert.ok(
      !/^worker_gate_verdict:/m.test(raw),
      'persisting a red the toolchain never measured makes the refusal sticky forever',
    );
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER43-01: the failure stays transient — a later runnable gate still resolves', () => {
  const fx = makeUnrunnableGateFixture('transient');
  try {
    resolveWorkerGateVerdict(fx.sessionDir, fx.ticketId, fx.workingDir);
    // No stamp was written, so the field is still `absent` and the recompute is
    // re-attempted rather than short-circuiting on a poisoned frontmatter value.
    const second = resolveWorkerGateVerdict(fx.sessionDir, fx.ticketId, fx.workingDir);
    assert.notEqual(
      second.computedVia,
      'worker_gate',
      'a persisted stamp would make the second read claim a real gate authored it',
    );
    assert.equal(second.verdict, 'absent');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER43-01 control: a real non-zero exit is still a measured red', () => {
  // The distinction must not over-trigger — an exit code of 1 is a genuine
  // measurement and must keep authoring (and persisting) a red.
  const check = fakeCheck({ eslint: false });
  assert.equal(recomputeAbsentWorkerGateVerdict('/ext', check), 'red');
});
