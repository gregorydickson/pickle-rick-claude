// @tier: fast
// R-NOPOSTTIER ticket 34930a4e: the b88a6603 regression oracle.
//
// Session 2026-08-15-b88a6603's actual shape: 8/8 tickets Done, the bundle's LAST commit landed
// and reddened the tree, and EPIC_COMPLETED / exit_reason: completed fired 9.5 minutes later with
// no measurement in between. Every prior ticket in this chain (00e44626, 4dd2d658, fa3d0f5a,
// 9aa67006) pins its OWN seam in isolation. None of them drives the real completion-synthesis
// function (`applyAllTicketsDoneCompletion`, mux-runner.ts) and the real finalize honesty gate
// (`finalizePhaseSuccess`, pipeline-runner.ts) back to back against the SAME state.json, which is
// the only way a future refactor that satisfies every unit-level pin individually could still
// reintroduce the original defect end to end.
//
// Two defects, independently reintroducible, both must go red here:
//   1. remove the post-final measurement call from `applyAllTicketsDoneCompletion` -> caught by
//      the FRESH VERDICT assertion (verdict.ts would never be written, so it can't clear the
//      final-commit timestamp)
//   2. remove `withholdForDegradedPostFinalVerdict` from `finalizePhaseSuccess` -> caught by the
//      SUCCESS-WITHHELD assertion (`counters.nonConvergent` would stay 0)
//
// Parser independence: `runTestFast` is injected directly as a `BetweenTicketGateResult` (no raw
// npm output is ever parsed), and `failures: []` is used so nothing here can depend on
// `parseBetweenTicketFastGateFailures` (R-GBANNER, out of scope). The disposition marker's
// attribution comes from `verdict.state` ("red"), never a dimension name — see
// `pipeline-finalize-honesty.test.js`'s "AC-2 parser independence" test, whose pattern this
// mirrors for the same reason.

process.env.PICKLE_TEST_MODE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { applyAllTicketsDoneCompletion } from '../bin/mux-runner.js';
import { POST_FINAL_DEGRADED_MARKER, finalizePhaseSuccess } from '../bin/pipeline-runner.js';

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const git = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15000 }).trim();

/** A real git repo with a real final commit — this IS the "final commit reddens the tree". */
function makeWorkingRepo() {
  const repo = tmpDir('b88a6603-repo-');
  fs.mkdirSync(path.join(repo, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'extension', 'marker.txt'), 'final commit of the bundle\n');
  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'final commit of the bundle']);
  return repo;
}

const finalCommitTsMs = (repo) => Number(git(repo, ['log', '-1', '--format=%ct'])) * 1000;
const readState = (statePath) => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const readStatus = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));

function makeSession(sessionDir, workingDir) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: 3,
    active: true,
    step: 'implement',
    iteration: 1,
    max_iterations: 15,
    worker_timeout_seconds: 3600,
    start_time_epoch: Math.floor(Date.now() / 1000),
    max_time_minutes: 0,
    current_ticket: null,
    working_dir: workingDir,
    backend: 'claude',
    completion_promise: null,
    history: [],
  }, null, 2));
  return statePath;
}

function makeTicket(sessionDir, id) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${id}.md`),
    ['---', `id: "${id}"`, `title: "Ticket ${id}"`, 'status: "Done"', 'order: 1', '---', '', '# Body'].join('\n'),
  );
  return ticketDir;
}

/** Runtime shape `finalizePhaseSuccess` expects — mirrors `pipeline-finalize-honesty.test.js`. */
function makeRuntime(sessionDir, statePath) {
  return {
    sessionDir,
    statePath,
    config: { phases: [{}, {}, {}, {}] },
    workingDir: '/tmp',
    log: () => {},
  };
}

test('b88a6603 shape: 8/8 Done, final commit reddens, run completes without reporting success', () => {
  const sessionDir = tmpDir('b88a6603-session-');
  const repo = makeWorkingRepo();
  try {
    const statePath = makeSession(sessionDir, repo);
    const ticketIds = ['aaa11111', 'bbb22222'];
    for (const id of ticketIds) makeTicket(sessionDir, id);

    const gateLogs = [];
    // Injected directly as a structured BetweenTicketGateResult — no npm output is ever
    // parsed, so R-GBANNER cannot affect this oracle either way.
    const redRunner = () => ({ ok: false, failures: [], timed_out: false, timeout_ms: 1_800_000 });

    // Step 1: drive the REAL completion-synthesis seam (the fixture: all tickets Done + a
    // real reddening final commit + an injected red gate).
    const fired = applyAllTicketsDoneCompletion(
      statePath, sessionDir, 1, (m) => gateLogs.push(m), repo, { runTestFast: redRunner },
    );
    assert.equal(fired, true, 'the all-Done bundle must still synthesize its completion promise');

    const stateAfterSynthesis = readState(statePath);

    // Defect 1 guard: a FRESH verdict must exist, post-dating the final commit. If the
    // post-final measurement call is ever removed from applyAllTicketsDoneCompletion, this
    // field goes back to being entirely absent (not merely degraded) and this assertion fails.
    assert.ok(stateAfterSynthesis.post_final_verdict, 'a post_final_verdict must be recorded');
    assert.equal(stateAfterSynthesis.post_final_verdict.state, 'red');
    assert.equal(stateAfterSynthesis.post_final_verdict.degraded, true);
    assert.ok(
      stateAfterSynthesis.last_between_ticket_gate.ts >= finalCommitTsMs(repo),
      'the verdict must post-date the final commit, not predate it',
    );

    // Disposition intact: measuring is not acting. exit_reason and ticket status are untouched
    // by the measurement step itself.
    assert.equal(stateAfterSynthesis.exit_reason, 'completed');
    assert.equal(stateAfterSynthesis.step, 'completed');
    for (const id of ticketIds) {
      const body = fs.readFileSync(path.join(sessionDir, id, `rick_ticket_${id}.md`), 'utf8');
      assert.match(body, /status: "Done"/, `ticket ${id} must not be demoted by the measurement`);
    }

    // Step 2: drive the REAL finalize honesty gate against the SAME state.json the
    // synthesis step just wrote. This is the seam that must withhold success.
    const runtime = makeRuntime(sessionDir, statePath);
    const finalizeLogs = [];
    runtime.log = (m) => finalizeLogs.push(m);
    const counters = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };

    const outcome = finalizePhaseSuccess(runtime, counters, path.join(sessionDir, 'pipeline-cancel'), 'pickle', 0, runtime.log);

    // The run COMPLETES — it is never halted or broken. Output-with-flags, not no-output.
    assert.equal(outcome.action, 'continue', 'a degraded post-final verdict must never break the phase loop');
    assert.equal(counters.completed, 1, 'the phase still executed to completion');

    // Defect 2 guard: success must be withheld. If withholdForDegradedPostFinalVerdict is
    // ever removed from finalizePhaseSuccess, nonConvergent stays 0 and this fails.
    assert.equal(counters.nonConvergent, 1, 'a red post-final verdict must withhold the success verdict');

    // Attribution is the marker + verdict STATE only — never a specific dimension/failure
    // name (parser-independent per R-GBANNER; the injected gate's `failures: []` proves it).
    const disposition = counters.phaseDispositions.pickle;
    assert.ok(disposition.startsWith(`${POST_FINAL_DEGRADED_MARKER}:`), 'the degraded marker must be present');
    const attribution = disposition.slice(`${POST_FINAL_DEGRADED_MARKER}:`.length);
    assert.ok(attribution.length > 0, 'the marker must carry a non-empty attribution (the verdict state)');
    assert.equal(attribution, 'red');

    assert.equal(readStatus(sessionDir).phase_dispositions.pickle, disposition);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
