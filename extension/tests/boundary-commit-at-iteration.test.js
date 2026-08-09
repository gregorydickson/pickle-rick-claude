// @tier: integration
// B-DURA T10 (AC-DURA-1/2/8) — commitGatePassingDeliverableAtBoundary commits the
// ticket's gate-passing work at the NORMAL iteration boundary (or attributes an
// existing untagged commit, or honest-fails) before context is cleared. The
// idempotent no-op is keyed on HEAD movement, NOT tree dirtiness, so untracked
// research_*.md/plan_*.md artifacts must not defeat the no-op. Emits exactly one
// boundary_commit_resolved event recording the branch taken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commitGatePassingDeliverableAtBoundary } from '../bin/mux-runner.js';
import { readFrontmatterField } from '../services/pickle-utils.js';
import { commitWorkerFixture } from './__helpers__/worker-commit-fixture.js';

function makeTmp(prefix = 'dura-t10-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension', 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
}

function head(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, status, order = 1, extraFm = []) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = ['---', `id: "${ticketId}"`, `status: "${status}"`, `order: ${order}`, ...extraFm, '---', '# Body'].join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), fm);
}

function readActivity(statePath) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return Array.isArray(s.activity) ? s.activity : [];
}

const passGate = () => ({ ok: true, failures: [], timed_out: false, timeout_ms: 0 });

function baseInput(sessionDir, workingDir, ticketId, preIterSha, runGate) {
  return {
    sessionDir,
    statePath: path.join(sessionDir, 'state.json'),
    workingDir,
    ticketId,
    extensionRoot: path.join(workingDir, 'extension'),
    flags: null,
    preIterSha,
    log: () => {},
    runGate,
  };
}

const cleanup = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

const T = 'aaaa1111';

test('AC-DURA-1 commit branch: worker committed nothing, gate-green dirty tree → runner authors a commit, HEAD moves, outcome=committed', () => {
  const workingDir = makeTmp('dura-t10-commit-');
  initGitRepo(workingDir);
  const sessionDir = path.join(workingDir, 'sessiondata');
  try {
    writeTicket(sessionDir, T, 'In Progress', 1);
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'baseline ticket', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ schema_version: 5, activity: [] }));

    const preIterSha = head(workingDir);
    // Worker left gate-green dirty source work but committed nothing.
    fs.writeFileSync(path.join(workingDir, 'extension', 'deliverable.txt'), 'shipped work\n');

    const result = commitGatePassingDeliverableAtBoundary(baseInput(sessionDir, workingDir, T, preIterSha, passGate));

    assert.equal(result.outcome, 'committed', `expected committed, got ${result.outcome}/${result.reason}`);
    const postIterSha = head(workingDir);
    assert.notEqual(postIterSha, preIterSha, 'runner must author a commit (HEAD moves off preIterSha)');
    const committed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: workingDir, encoding: 'utf8' });
    assert.match(committed, /deliverable\.txt/, "commit must contain the ticket's declared file diff");

    const events = readActivity(statePath).filter(e => e.event === 'boundary_commit_resolved');
    assert.equal(events.length, 1, 'exactly one boundary_commit_resolved event');
    assert.equal(events[0].gate_payload.outcome, 'committed');
    assert.equal(events[0].gate_payload.pre_iter_sha, preIterSha);
    assert.equal(events[0].gate_payload.post_iter_sha, postIterSha);
  } finally {
    cleanup(workingDir);
  }
});

test('AC-DURA-8 attribute branch: worker committed untagged (HEAD moved), clean tree → completion_commit back-filled, no second commit, outcome=attributed', () => {
  const workingDir = makeTmp('dura-t10-attr-');
  initGitRepo(workingDir);
  const sessionDir = path.join(workingDir, 'sessiondata');
  try {
    writeTicket(sessionDir, T, 'In Progress', 1);
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'baseline ticket', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ schema_version: 5, activity: [] }));

    const preIterSha = head(workingDir);
    // Worker committed work itself but did NOT stamp completion_commit and the
    // subject lacks a (hash) tag — a4e48c26 deleted subject-line inference, so the
    // commit carries a git trailer that names the ticket (the shape production emits) for the
    // attribution scan to find.
    fs.writeFileSync(path.join(workingDir, 'extension', 'worker-output.txt'), 'worker shipped\n');
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    commitWorkerFixture({ cwd: workingDir, ticketId: T, message: `feat: implement ${T}` });
    const committedSha = head(workingDir);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: workingDir, encoding: 'utf8' }).trim(), '', 'precondition: clean tree');

    const result = commitGatePassingDeliverableAtBoundary(baseInput(sessionDir, workingDir, T, preIterSha, passGate));

    assert.equal(result.outcome, 'attributed', `expected attributed, got ${result.outcome}/${result.reason}`);
    // No second commit — HEAD unchanged from the worker's own commit.
    assert.equal(head(workingDir), committedSha, 'attribute branch must NOT author a second commit');
    // completion_commit back-filled into the ticket frontmatter.
    const raw = fs.readFileSync(path.join(sessionDir, T, `rick_ticket_${T}.md`), 'utf8');
    const cc = (readFrontmatterField(raw, 'completion_commit') ?? '').replace(/^['"]+|['"]+$/g, '');
    assert.ok(cc.length >= 7 && committedSha.startsWith(cc), `completion_commit must be back-filled to the worker commit (got ${cc})`);

    const events = readActivity(statePath).filter(e => e.event === 'boundary_commit_resolved');
    assert.equal(events.length, 1, 'exactly one boundary_commit_resolved event');
    assert.equal(events[0].gate_payload.outcome, 'attributed');
  } finally {
    cleanup(workingDir);
  }
});

test('idempotent no-op keyed on HEAD movement: HEAD already moved + untracked research_*.md leaves tree dirty → no additional commit', () => {
  const workingDir = makeTmp('dura-t10-noop-');
  initGitRepo(workingDir);
  const sessionDir = path.join(workingDir, 'sessiondata');
  try {
    // Ticket already explicitly tagged with completion_commit pointing at a real commit.
    writeTicket(sessionDir, T, 'In Progress', 1);
    fs.writeFileSync(path.join(workingDir, 'extension', 'already-done.txt'), 'done\n');
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', `feat: ${T}`, '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
    const tagged = head(workingDir);
    // Stamp completion_commit so it reads explicit.
    const tfPath = path.join(sessionDir, T, `rick_ticket_${T}.md`);
    writeTicket(sessionDir, T, 'In Progress', 1, [`completion_commit: "${tagged}"`]);
    void tfPath;
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'stamp completion_commit', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ schema_version: 5, activity: [] }));

    const preIterSha = tagged; // HEAD has moved past preIterSha (the stamp commit).
    const headBefore = head(workingDir);
    assert.notEqual(headBefore, preIterSha, 'precondition: HEAD already moved off preIterSha');
    // Untracked lifecycle artifact leaves the tree dirty — must NOT defeat the no-op.
    fs.writeFileSync(path.join(sessionDir, T, 'research_x.md'), 'notes\n');

    const result = commitGatePassingDeliverableAtBoundary(baseInput(sessionDir, workingDir, T, preIterSha, passGate));

    assert.equal(result.outcome, 'attributed', `HEAD-moved no-op should attribute, got ${result.outcome}`);
    assert.equal(head(workingDir), headBefore, 'no-op must NOT author an additional commit despite the dirty untracked artifact');
  } finally {
    cleanup(workingDir);
  }
});

test('AC-DURA-2 allowlist staging: dirty tree includes a foreign sibling-session path → staged ⊆ allowlist, foreign routed to salvage ref', () => {
  const workingDir = makeTmp('dura-t10-allow-');
  initGitRepo(workingDir);
  const sessionDir = path.join(workingDir, 'sessiondata');
  const session = path.basename(sessionDir);
  const ref = `refs/pickle/salvage/${session}`;
  try {
    writeTicket(sessionDir, T, 'In Progress', 1);
    const sibling = 'cccc3333';
    writeTicket(sessionDir, sibling, 'In Progress', 2);
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'baseline tickets', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ schema_version: 5, activity: [] }));

    const preIterSha = head(workingDir);
    // Owned deliverable for T.
    fs.writeFileSync(path.join(workingDir, 'extension', 'owned.txt'), 'owned work\n');
    // Foreign work under the sibling ticket's session dir.
    fs.writeFileSync(path.join(sessionDir, sibling, 'plan_sib.md'), 'sibling work\n');

    const result = commitGatePassingDeliverableAtBoundary(baseInput(sessionDir, workingDir, T, preIterSha, passGate));

    assert.equal(result.outcome, 'committed', `expected committed, got ${result.outcome}/${result.reason}`);
    const committed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: workingDir, encoding: 'utf8' });
    assert.match(committed, /owned\.txt/, "commit must contain T's owned work");
    assert.doesNotMatch(committed, /plan_sib\.md/, "commit must NOT contain the sibling's foreign work (staged ⊆ allowlist/ownership)");
    // Foreign work recoverable at the salvage ref.
    const refDiff = execFileSync('git', ['show', '--name-only', '--pretty=format:', ref], { cwd: workingDir, encoding: 'utf8' });
    assert.match(refDiff, /plan_sib\.md/, 'foreign work must be routed to the salvage ref');
  } finally {
    cleanup(workingDir);
  }
});

test('honest-failure: HEAD static + clean tree → no commit, outcome=honest_failure', () => {
  const workingDir = makeTmp('dura-t10-honest-');
  initGitRepo(workingDir);
  // sessionDir OUTSIDE the working repo (production session-data root), so writing
  // state.json/tickets does not dirty the working tree under test.
  const sessionDir = makeTmp('dura-t10-honest-sess-');
  try {
    writeTicket(sessionDir, T, 'In Progress', 1);
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ schema_version: 5, activity: [] }));
    const preIterSha = head(workingDir);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: workingDir, encoding: 'utf8' }).trim(), '', 'precondition: clean working tree');

    const result = commitGatePassingDeliverableAtBoundary(baseInput(sessionDir, workingDir, T, preIterSha, passGate));

    assert.equal(result.outcome, 'honest_failure', `expected honest_failure, got ${result.outcome}`);
    assert.equal(head(workingDir), preIterSha, 'honest-failure must not move HEAD');
    const events = readActivity(statePath).filter(e => e.event === 'boundary_commit_resolved');
    assert.equal(events.length, 1, 'exactly one boundary_commit_resolved event');
    assert.equal(events[0].gate_payload.outcome, 'honest_failure');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});
