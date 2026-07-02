// @tier: fast
//
// AC-W4b-3: bind the recovery ladder's honest terminal EXCLUSIVELY to the EXISTING
// `recovery_exhausted` state, write a `## Recovery Handoff` artifact on exhaustion,
// and resolve the empty roster {all-Done -> completion, all-Failed-no-runnable ->
// recovery_exhausted}.
//
// Covers:
//   1. terminal-literal grep — only `recovery_exhausted` is the honest ladder terminal;
//      the retired legacy `all_tickets_terminal` literal must NOT reappear.
//   2. empty-roster resolution — recovery_exhausted, plus the all-Done -> completion path.
//   3. handoff-artifact write — `writeRecoveryHandoffArtifact` writes `recovery_handoff.md`
//      with a `## Recovery Handoff` header naming the exact `pickle-recover` subcommand.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeRecoveryHandoffArtifact, applyAllTicketsDoneCompletion } from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_SRC = path.join(__dirname, '..', 'src', 'bin', 'mux-runner.ts');
const SRC = fs.readFileSync(MUX_SRC, 'utf-8');

const noop = () => {};

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('AC-W4b-3 terminal-literal grep — only recovery_exhausted is the honest ladder terminal', () => {
  it('the empty-roster all-Failed path terminates into recovery_exhausted', () => {
    // The W4b empty-roster branch records recovery_exhausted.
    const onBranch = SRC.match(/empty roster \(all-Failed, no runnable ticket\)[\s\S]{0,400}?recordExitReason\(statePath, 'recovery_exhausted'\)/);
    assert.ok(onBranch, 'empty-roster all-Failed branch must record recovery_exhausted');
  });

  it('the retired legacy all_tickets_terminal literal does not reappear', () => {
    // The legacy per-seam terminal was deleted in the guard-layer kill-switch prune —
    // no emission site and no ExitReason member.
    assert.ok(!SRC.includes("'all_tickets_terminal'"), 'all_tickets_terminal must not reappear in mux-runner.ts');
  });

  it('no NEW honest-terminal literal sibling is introduced — recovery_exhausted is the single ladder terminal', () => {
    // Every ladder-exhausted seam records recovery_exhausted; none introduces a fresh
    // distinct terminal literal for the exhausted disposition.
    const exhaustedTerminals = SRC.match(/recordExitReason\([^,]+, 'recovery_exhausted'\)/g) || [];
    assert.ok(exhaustedTerminals.length >= 8, `expected the ladder-exhausted seams to all record recovery_exhausted (found ${exhaustedTerminals.length})`);
  });
});

describe('AC-W4b-3 handoff artifact — writeRecoveryHandoffArtifact', () => {
  it('writes recovery_handoff.md with a ## Recovery Handoff header naming pickle-recover', () => {
    const dir = mkTmp('w4b-handoff-');
    try {
      writeRecoveryHandoffArtifact(dir, 'tkt-abc', 'ladder_exhausted', noop);
      const artifact = path.join(dir, 'recovery_handoff.md');
      assert.ok(fs.existsSync(artifact), 'recovery_handoff.md must be written');
      const body = fs.readFileSync(artifact, 'utf-8');
      assert.match(body, /## Recovery Handoff/, 'must carry the ## Recovery Handoff header');
      assert.match(body, /pickle-recover/, 'must name the pickle-recover command');
      assert.match(body, /recovery_exhausted/, 'must reference the recovery_exhausted entry state');
      assert.match(body, /tkt-abc/, 'must include the seam ticket id');
      assert.match(body, /ladder_exhausted/, 'must include the recovery reason');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty/absent ticket still names the re-queue subcommand (empty-roster handoff)', () => {
    const dir = mkTmp('w4b-handoff-empty-');
    try {
      writeRecoveryHandoffArtifact(dir, null, 'empty_roster_all_failed_no_runnable', noop);
      const body = fs.readFileSync(path.join(dir, 'recovery_handoff.md'), 'utf-8');
      assert.match(body, /pickle-recover --resume-from-todo/, 'empty roster names the resume-from-todo path');
      assert.match(body, /empty_roster_all_failed_no_runnable/, 'must carry the empty-roster reason');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is best-effort — a non-existent session dir does not throw', () => {
    assert.doesNotThrow(() =>
      writeRecoveryHandoffArtifact(path.join(os.tmpdir(), 'does-not-exist-w4b', 'nope'), 'x', 'r', noop));
  });
});

describe('AC-W4b-3 empty-roster resolution', () => {
  function writeTicket(sessionDir, id, status) {
    const tdir = path.join(sessionDir, id);
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(
      path.join(tdir, `linear_ticket_${id}.md`),
      `---\nid: ${id}\nstatus: ${status}\n---\n# ${id}\n`,
    );
  }

  it('roster all-Done -> completion (applyAllTicketsDoneCompletion synthesizes EPIC_COMPLETED)', () => {
    const sessionDir = mkTmp('w4b-allDone-');
    try {
      const statePath = path.join(sessionDir, 'state.json');
      fs.writeFileSync(statePath, JSON.stringify({
        active: true, step: 'research', current_ticket: null, working_dir: sessionDir,
        schema_version: 5, activity: [], iteration: 1,
      }));
      writeTicket(sessionDir, 'aaaaaaaa', 'Done');
      writeTicket(sessionDir, 'bbbbbbbb', 'Done');
      const done = applyAllTicketsDoneCompletion(statePath, sessionDir, 1, noop);
      assert.equal(done, true, 'all-Done roster resolves to completion');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(state.exit_reason, 'completed', 'all-Done writes exit_reason completed');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('roster all-Failed (no runnable) does NOT resolve to completion via the all-Done check', () => {
    const sessionDir = mkTmp('w4b-allFailed-');
    try {
      const statePath = path.join(sessionDir, 'state.json');
      fs.writeFileSync(statePath, JSON.stringify({
        active: true, step: 'research', current_ticket: null, working_dir: sessionDir,
        schema_version: 5, activity: [], iteration: 1,
      }));
      writeTicket(sessionDir, 'cccccccc', 'Failed');
      writeTicket(sessionDir, 'dddddddd', 'Failed');
      const done = applyAllTicketsDoneCompletion(statePath, sessionDir, 1, noop);
      assert.equal(done, false, 'all-Failed roster must NOT be treated as all-Done completion — it routes to recovery_exhausted');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
