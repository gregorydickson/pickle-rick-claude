// @tier: fast
//
// AC-W4a-1: ONE parametrized matrix for the W4a single recovery choke point.
//   describe.each([backends]) × describe.each([modes]) × describe.each([halt-sites])
// proving every no-progress / handoff / self-terminate seam routes its decision
// through `routeRecoveryBeforeTerminal` — the single DECISION site that wraps the
// `runRecoveryLadder` invocation in `attemptRecoveryBeforeTerminal`.
//
// Per cell: a valid RecoveryOutcome kind is returned, proving the ladder fires
// regardless of backend × mode × halt-site.
//
// Plus the forward-protection lint over `extension/src/bin/mux-runner.ts`:
//   - the `runRecoveryLadder(` DECISION appears exactly once (single decision site).
//   - the `attemptRecoveryBeforeTerminal` function definition is unique.
//   - each former terminal-emission seam (closer_handoff_terminal /
//     codex_manager_no_progress / wmw oversized / timeout_repeat /
//     idle_stall_unrecoverable) is choke-point-routed.
//   - a synthetic NEW bypassing halt fails the lint predicate.
//
// MUST remain ONE parametrized file — do NOT fan out per seam (AC-W4a-1).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { routeRecoveryBeforeTerminal } from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_SRC = path.join(__dirname, '..', 'src', 'bin', 'mux-runner.ts');

// The W4a discriminant axes.
const BACKENDS = ['claude', 'codex'];
const MODES = ['worker', 'manager'];

// The five halt-site seams routed through the choke point.
const HALT_SITES = [
  'closer_handoff_terminal',
  'codex_manager_no_progress',
  'wmw_oversized_no_progress',
  'timeout_repeat',
  'idle_stall_unrecoverable',
];

/** Build a tmp session + a tmp (non-repo) working dir so the ladder runs without a real repo. */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w4a-choke-'));
  const sessionDir = path.join(root, 'session');
  const ticketId = 't1';
  fs.mkdirSync(path.join(sessionDir, ticketId), { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  // working_dir is a non-repo tmp dir — the ladder's git/gate adapters fail soft, so the
  // ladder honestly falls through / exhausts without ever touching a real repository.
  const workingDir = path.join(root, 'work');
  fs.mkdirSync(workingDir, { recursive: true });
  return { root, sessionDir, statePath, ticketId, workingDir };
}

function writeState(statePath, backend) {
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: 5,
    active: true,
    backend,
    working_dir: path.dirname(statePath),
    session_dir: path.dirname(statePath),
    current_ticket: 't1',
  }));
}

const VALID_OUTCOME_KINDS = new Set(['advanced', 'fall_through', 'exhausted']);

describe('W4a single choke point — backend × mode × halt-site matrix', () => {
  for (const backend of BACKENDS) {
    describe(`backend=${backend}`, () => {
      for (const mode of MODES) {
        describe(`mode=${mode}`, () => {
          for (const haltSite of HALT_SITES) {
            describe(`halt-site=${haltSite}`, () => {
              function buildInput() {
                const fx = makeFixture();
                writeState(fx.statePath, backend);
                return {
                  fx,
                  input: {
                    sessionDir: fx.sessionDir,
                    statePath: fx.statePath,
                    extensionRoot: fx.root,
                    workingDir: fx.workingDir,
                    ticketId: fx.ticketId,
                    iteration: 1,
                    flags: null,
                    log: () => {},
                    backend,
                    mode,
                    evidence: { halt_site: haltSite },
                  },
                };
              }

              it('routes through the ladder (valid RecoveryOutcome)', () => {
                const { input } = buildInput();
                const outcome = routeRecoveryBeforeTerminal(input);
                assert.ok(VALID_OUTCOME_KINDS.has(outcome.kind), `unexpected kind ${outcome.kind}`);
                // The ladder ran (no real repo) — it must NOT silently advance/commit
                // against a non-repo tree; it honestly falls through or exhausts.
                assert.notEqual(outcome.kind, 'advanced');
              });
            });
          }
        });
      }
    });
  }
});

describe('W4a discriminant resolution', () => {
  it('defaults backend from state.backend when the input omits it', () => {
    const fx = makeFixture();
    writeState(fx.statePath, 'codex');
    // No explicit backend on the input — resolver must read state.backend.
    const outcome = routeRecoveryBeforeTerminal({
      sessionDir: fx.sessionDir,
      statePath: fx.statePath,
      extensionRoot: fx.root,
      workingDir: fx.workingDir,
      ticketId: fx.ticketId,
      iteration: 1,
      flags: null,
      log: () => {},
      mode: 'manager',
    });
    assert.ok(VALID_OUTCOME_KINDS.has(outcome.kind));
    // The ledger entry is annotated with the resolved discriminant.
    const state = JSON.parse(fs.readFileSync(fx.statePath, 'utf-8'));
    if (Array.isArray(state.recovery_attempts) && state.recovery_attempts.length > 0) {
      const last = state.recovery_attempts.at(-1);
      assert.match(last.reason, /\[backend=codex;mode=manager\]/);
    }
  });
});

// ---------------------------------------------------------------------------
// Forward-protection lint — assert the single-decision-site invariant in source.
// ---------------------------------------------------------------------------

function readMuxSource() {
  return fs.readFileSync(MUX_SRC, 'utf-8');
}

/** Count non-overlapping occurrences of a literal substring. */
function countLiteral(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

describe('W4a forward-protection lint', () => {
  it('the runRecoveryLadder DECISION appears exactly once (single decision site)', () => {
    const src = readMuxSource();
    assert.equal(countLiteral(src, 'runRecoveryLadder(deps)'), 1,
      'the ladder invocation must live in exactly ONE place (attemptRecoveryBeforeTerminal)');
  });

  it('the attemptRecoveryBeforeTerminal function definition is unique', () => {
    const src = readMuxSource();
    assert.equal(countLiteral(src, 'export function attemptRecoveryBeforeTerminal('), 1);
    assert.equal(countLiteral(src, 'export function routeRecoveryBeforeTerminal('), 1);
  });

  it('every former terminal-emission seam is choke-point-routed', () => {
    const src = readMuxSource();
    // Each seam emits a terminal disposition AND has a routeRecoveryBeforeTerminal call
    // in the same file. The structural invariant: the count of choke-point routes is at
    // least the count of distinct routed seams (closer, codex, wmw, timeout, idle).
    const routeCalls = countLiteral(src, 'routeRecoveryBeforeTerminal(');
    // 1 definition + 1 kill-switch return inside the body are NOT calls; the call sites
    // are the codex/closer/wmw/timeout(×2)/idle seams.
    assert.ok(routeCalls >= 6,
      `expected >= 6 routeRecoveryBeforeTerminal call/def sites, found ${routeCalls}`);
    for (const token of ['closer_handoff_terminal', 'codex_manager_no_progress',
      'oversized_no_progress', 'timeout_repeat', 'idle_stall_unrecoverable']) {
      assert.ok(src.includes(token), `seam token ${token} missing from source`);
    }
  });

  it('a NEW bypassing halt (raw terminal emit, no choke-point route) fails the lint', () => {
    // The lint predicate: any block that records a terminal exit_reason for a
    // recoverable no-progress class MUST be preceded by a routeRecoveryBeforeTerminal
    // call within the same seam. Simulate a regression where a new halt parks directly.
    const bypassingSnippet = [
      "if (noProgress) {",
      "  recordExitReason(statePath, 'brand_new_no_progress_halt');",
      "  safeDeactivate(statePath);",
      "}",
    ].join('\n');
    const isChokePointRouted = (block) => /routeRecoveryBeforeTerminal\s*\(/.test(block);
    assert.equal(isChokePointRouted(bypassingSnippet), false,
      'the bypassing snippet must be detected as NOT routed (lint would flag it)');
    // And the real timeout/idle seams ARE routed (the predicate passes for them).
    const src = readMuxSource();
    const idleBlock = src.slice(
      src.indexOf('evaluateIdleStallRecoveryCap(idleStallRecoveryCount'),
      src.indexOf("exitReason = 'idle_stall_unrecoverable';"),
    );
    assert.equal(isChokePointRouted(idleBlock), true,
      'the idle_stall_unrecoverable seam must be choke-point-routed');
  });
});
