// @tier: integration
// Characterization test for Path 5: runMuxRunnerMain-direct-guard-calls
// Three direct guardCompletionCommitBeforeDone callsites at mux-runner.js:
//   5a: 4694 — worker-self-attested Done at ticket boundary
//   5b: 5083 — false EPIC_COMPLETED, recover_advance branch
//   5c: 5159 — genuine EPIC_COMPLETED, final ticket Done stamp
//
// All three callsites share the same guard function signature and observable
// return shape: {ok: true, sha: <sha>} when explicit completion_commit present.
// This test characterizes that shared observable behaviour.
//
// Decision-matrix: path_id 5 — assert what the code DOES today.
// R-AFCC-DEEP-3C: guard now calls hasCompletionCommit which runs git cat-file -e.
// Tests use a real git repo so the explicit SHA is verifiable → source:explicit-reachable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  guardCompletionCommitBeforeDone,
  clearStaleDoneWithoutCommitEvidence,
} from '../../../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'decision-matrix.json'), 'utf8'));
const ENTRY = MATRIX.paths.find(p => p.path_id === 5);

function makeTmp(prefix = 'char-path5-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, frontmatter) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    lines.push(`${k}: "${v}"`);
  }
  lines.push('order: 1', '---', '# Body');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
  return path.join(ticketDir, `rick_ticket_${ticketId}.md`);
}

// Shared guard args builder — uses a real git workingDir
function makeGuardArgs(sessionDir, gitDir, ticketId) {
  return {
    sessionDir,
    ticketId,
    workingDir: gitDir, // real git repo containing the commit
    rereadBackoffMs: 0,
  };
}

// ---
// Path 5a: guard-worker-self-attested
// Callsite: mux-runner.js:4694
// Trigger: previousTicket status already 'done' after iteration.
// Observable: guard validates explicit-reachable sha, returns {ok:true, sha}.
// ---
test('path-5a guard-worker-self-attested: explicit completion_commit → {ok:true}', () => {
  const root = makeTmp();
  try {
    const realSha = initGitRepo(root);
    const prevFm = ENTRY.callsites.find(c => c.callsite_id === '5a')
      .fixture.session_dir_skeleton[`aabbccdd/rick_ticket_aabbccdd.md`].frontmatter;
    writeTicket(root, 'aabbccdd', {
      id: 'aabbccdd',
      status: prevFm.status,
      completion_commit: realSha, // use real reachable SHA (R-AFCC-DEEP-3C)
      title: prevFm.title,
    });

    const result = guardCompletionCommitBeforeDone(makeGuardArgs(root, root, 'aabbccdd'));

    // Characterize: explicit-reachable SHA in frontmatter → guard ok, sha returned
    assert.equal(result.ok, true, `5a expected ok=true, got ${result.ok}`);
    assert.equal(result.sha, realSha, `5a expected sha=${realSha}, got '${result.sha}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---
// Path 5b: guard-false-epic-recover-advance
// Callsite: mux-runner.js:5083
// Trigger: false EPIC_COMPLETED, current_ticket In Progress but has explicit sha.
// Observable: guard validates explicit-reachable sha, returns {ok:true}.
// ---
test('path-5b guard-false-epic-recover-advance: In-Progress ticket with explicit completion_commit → {ok:true}', () => {
  const root = makeTmp();
  try {
    const realSha = initGitRepo(root);
    const cs5b = ENTRY.callsites.find(c => c.callsite_id === '5b');
    const fm = cs5b.fixture.session_dir_skeleton['aabbccdd/rick_ticket_aabbccdd.md'].frontmatter;
    writeTicket(root, 'aabbccdd', {
      id: 'aabbccdd',
      status: fm.status,
      completion_commit: realSha, // use real reachable SHA (R-AFCC-DEEP-3C)
      title: fm.title,
    });

    const result = guardCompletionCommitBeforeDone(makeGuardArgs(root, root, 'aabbccdd'));

    // Characterize: explicit-reachable SHA → guard ok regardless of status field
    assert.equal(result.ok, true, `5b expected ok=true, got ${result.ok}`);
    assert.equal(result.sha, realSha, `5b expected sha=${realSha}, got '${result.sha}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---
// Path 5c: guard-genuine-epic-final-ticket
// Callsite: mux-runner.js:5159
// Trigger: genuine EPIC_COMPLETED, final ticket needs Done stamp.
// Observable: same as 5b — explicit-reachable sha passes guard.
// ---
test('path-5c guard-genuine-epic-final-ticket: final ticket with explicit completion_commit → {ok:true}', () => {
  const root = makeTmp();
  try {
    const realSha = initGitRepo(root);
    const cs5c = ENTRY.callsites.find(c => c.callsite_id === '5c');
    const fm = cs5c.fixture.session_dir_skeleton['aabbccdd/rick_ticket_aabbccdd.md'].frontmatter;
    writeTicket(root, 'aabbccdd', {
      id: 'aabbccdd',
      status: fm.status,
      completion_commit: realSha, // use real reachable SHA (R-AFCC-DEEP-3C)
      title: fm.title,
    });

    const result = guardCompletionCommitBeforeDone(makeGuardArgs(root, root, 'aabbccdd'));

    assert.equal(result.ok, true, `5c expected ok=true, got ${result.ok}`);
    assert.equal(result.sha, realSha, `5c expected sha=${realSha}, got '${result.sha}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---
// Guard refuses absent evidence
// ---
test('path-5 guard: absent completion_commit → {ok:false} (guard blocks Done flip)', () => {
  const root = makeTmp();
  try {
    writeTicket(root, 'aabbccdd', {
      id: 'aabbccdd',
      status: 'In Progress',
      title: 'Test ticket',
    });

    const result = guardCompletionCommitBeforeDone(makeGuardArgs(root, 'aabbccdd'));

    assert.equal(result.ok, false, `expected ok=false for absent completion_commit, got ${result.ok}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---
// clearStaleDoneWithoutCommitEvidence: state has matching exit_reason → clears it
// ---
test('path-5 clearStaleDoneWithoutCommitEvidence: clears done_without_commit_evidence', () => {
  const root = makeTmp();
  try {
    const statePath = path.join(root, 'state.json');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ exit_reason: 'done_without_commit_evidence' }, null, 2));

    clearStaleDoneWithoutCommitEvidence(statePath);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(!state.exit_reason || state.exit_reason === null,
      `expected exit_reason cleared, got '${state.exit_reason}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('path-5: decision-matrix evidence_source matches explicit for all three callsites', () => {
  for (const cs of ENTRY.callsites) {
    assert.equal(cs.evidence_source, 'explicit',
      `expected evidence_source=explicit for callsite ${cs.callsite_id}, got '${cs.evidence_source}'`);
  }
});
