// @tier: fast
// AC-D4 completion-authority single-source-of-truth invariant.
//
// Complements the AC-D3 shell spine (extension/scripts/audit-design-ground-truth.sh).
// The shell spine owns the `evaluateEpicCompletion({` call-floor; this node test owns
// the broader `evaluateEpicCompletion(` form PLUS the terminal-status producer allowlist,
// so a new out-of-band Done/Skipped seam goes RED here.
//
// Three of the four sub-tests are pure source-grep; the fourth is a fail-injection that
// proves the scanner returns RED on a synthetic out-of-band producer written to a temp tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markTicketFailed } from '../services/git-utils.js';
import { reportSkippedFailedTickets } from '../bin/pipeline-runner.js';
import { persistWorkerOutcomeStatus } from '../bin/spawn-morty.js';
import { failureReasonFromWorkerLog, RATE_LIMITED_FAILURE_REASON } from '../bin/mux-runner.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const srcRoot = path.join(repoRoot, 'extension', 'src');
const muxRunnerPath = path.join(srcRoot, 'bin', 'mux-runner.ts');
const claudeMdPath = path.join(repoRoot, 'extension', 'CLAUDE.md');

// The four files allowed to originate a terminal Done/Skipped write.
const ALLOWLIST = new Set([
  path.join('bin', 'mux-runner.ts'), // canonical authority + its gated Done-flip paths
  path.join('bin', 'setup.ts'), // documented exception: resume-reattach best-effort
  path.join('bin', 'spawn-morty.ts'), // documented exception: worker-side outcome persistence
  path.join('services', 'pickle-utils.ts'), // defines markTicketDone / markTicketSkipped
]);

/** Recursively collect every non-`.d.ts` `.ts` file under `dir`. */
function walkTs(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkTs(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      result.push(full);
    }
  }
  return result;
}

/**
 * A terminal-status frontmatter write: an object-literal `status:` key immediately
 * assigned a `'Done'` / `'Skipped'` string literal. This is the form that
 * `updateTicketFrontmatter({ status: 'Done', ... })` (the lower-level rewriter at
 * setup.ts:1225 / spawn-morty.ts:1563) and any raw `status: 'Done'` object write take.
 *
 * Tuned to AVOID false positives on the green tree:
 *  - requires the `status:` COLON form, so `status === 'Done'` equality checks (triple-equals,
 *    no colon) are NOT matched;
 *  - matches only `'Done'`/`'Skipped'`, so `status: 'Failed'` / `status: 'Todo'` writes
 *    (the Failed/Todo paths at mux-runner.ts / pickle-recover.ts / salvage-ticket.ts) are spared;
 *  - applied only to NON-COMMENT lines (see filter below), so documented mentions don't trip it;
 *  - on the current green tree the ONLY src/ lines that match are the two allowlisted
 *    Done-writers (setup.ts, spawn-morty.ts), so it adds NO new producer file.
 *
 * WHY THIS PREDICATE EXISTS (the AC-D4 crux): without it a NEW out-of-band seam that flips
 * Done via `updateTicketFrontmatter({ status: 'Done' })` in a brand-new file — bypassing the
 * markTicket* primitives entirely — would ESCAPE the invariant. That false-negative would defeat
 * the ticket's durability claim. The markTicket* check alone is necessary but not sufficient.
 */
const TERMINAL_STATUS_WRITE_RE = /\bstatus:\s*['"](?:Done|Skipped)['"]/;

/**
 * Reusable scanner: returns the src-relative paths of files under `scanRoot` that contain a
 * terminal-status producer on a NON-COMMENT line but are NOT in the allowlist. A producer is
 * EITHER a `markTicketDone(` / `markTicketSkipped(` primitive call OR a terminal-status
 * frontmatter write (`status: 'Done'` / `status: 'Skipped'` — see TERMINAL_STATUS_WRITE_RE).
 *
 * The comment-line filter is REQUIRED: pipeline-runner.ts mentions `markTicketDone` in a
 * JSDoc comment and MUST NOT trip the invariant. A real out-of-band seam adds the call/write on a
 * non-comment line — exactly what this catches.
 */
function findOutOfBandProducers(scanRoot) {
  const violations = [];
  for (const filePath of walkTs(scanRoot)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const isProducer = content.split('\n').some((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
      if (trimmed.includes('markTicketDone(') || trimmed.includes('markTicketSkipped(')) return true;
      return TERMINAL_STATUS_WRITE_RE.test(trimmed);
    });
    if (!isProducer) continue;
    const relPath = path.relative(scanRoot, filePath);
    if (!ALLOWLIST.has(relPath)) {
      violations.push(relPath);
    }
  }
  return violations;
}

// Call-floors. Live counts (grep -c) at authoring time: evaluateEpicCompletion( = 3,
// guardCompletionCommitBeforeDone( = 7, applyAllTicketsDoneCompletion( = 2. Floors set
// conservatively below actual so refactors that preserve the authority stay green.
const EVAL_EPIC_FLOOR = 2;
const GUARD_DONE_FLOOR = 5;
const APPLY_ALL_DONE_FLOOR = 1;

const muxRunnerContent = fs.readFileSync(muxRunnerPath, 'utf8');
const claudeMdContent = fs.readFileSync(claudeMdPath, 'utf8');

test('CHECK A: no extension/src/ file outside the 4-file allowlist contains a terminal-status producer', () => {
  const violations = findOutOfBandProducers(srcRoot);
  assert.equal(
    violations.length,
    0,
    'Out-of-band terminal-status producer(s) detected outside the canonical allowlist ' +
      '(bin/mux-runner.ts, bin/setup.ts, bin/spawn-morty.ts, services/pickle-utils.ts):\n' +
      violations.map((v) => `  ${v}`).join('\n'),
  );
});

test('CHECK B: canonical completion-authority functions meet minimum call-site floors in mux-runner.ts', () => {
  const evalCount = (muxRunnerContent.match(/evaluateEpicCompletion\(/g) || []).length;
  const guardCount = (muxRunnerContent.match(/guardCompletionCommitBeforeDone\(/g) || []).length;
  const applyCount = (muxRunnerContent.match(/applyAllTicketsDoneCompletion\(/g) || []).length;

  assert.ok(
    evalCount >= EVAL_EPIC_FLOOR,
    `evaluateEpicCompletion( count ${evalCount} < floor ${EVAL_EPIC_FLOOR} — a completion ` +
      'decision stopped routing through the canonical evaluateEpicCompletion authority.',
  );
  assert.ok(
    guardCount >= GUARD_DONE_FLOOR,
    `guardCompletionCommitBeforeDone( count ${guardCount} < floor ${GUARD_DONE_FLOOR} — a ` +
      'Done-flip stopped passing through the canonical guardCompletionCommitBeforeDone gate.',
  );
  assert.ok(
    applyCount >= APPLY_ALL_DONE_FLOOR,
    `applyAllTicketsDoneCompletion( count ${applyCount} < floor ${APPLY_ALL_DONE_FLOOR} — the ` +
      'all-tickets-done short-circuit stopped routing through the canonical authority.',
  );
});

test('CHECK C: extension/CLAUDE.md names all three canonical completion-authority functions and the invariant token', () => {
  assert.ok(
    claudeMdContent.includes('evaluateEpicCompletion'),
    'extension/CLAUDE.md missing evaluateEpicCompletion — AC-D4 trap-door entry not present',
  );
  assert.ok(
    claudeMdContent.includes('applyAllTicketsDoneCompletion'),
    'extension/CLAUDE.md missing applyAllTicketsDoneCompletion — AC-D4 trap-door entry not present',
  );
  assert.ok(
    claudeMdContent.includes('guardCompletionCommitBeforeDone'),
    'extension/CLAUDE.md missing guardCompletionCommitBeforeDone — AC-D4 trap-door entry not present',
  );
  assert.ok(
    claudeMdContent.includes('completion-authority') || claudeMdContent.includes('single-source'),
    'extension/CLAUDE.md missing the completion-authority/single-source invariant row',
  );
});

test('FAIL-INJECTION: findOutOfBandProducers flags a real out-of-band producer and spares an allowlisted one', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-d4-inject-'));
  try {
    // Out-of-band seam: a NEW file with a real (non-comment) markTicketDone call.
    const fakeBinDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBinDir, 'evil-seam.ts'),
      'markTicketDone(sessionDir, ticketId);\n',
      'utf8',
    );

    // Allowlisted producer written at an allowlisted relative path must NOT be flagged.
    const fakeServicesDir = path.join(tmpRoot, 'services');
    fs.mkdirSync(fakeServicesDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeServicesDir, 'pickle-utils.ts'),
      'export function markTicketDone() {}\n',
      'utf8',
    );

    const violations = findOutOfBandProducers(tmpRoot);

    assert.ok(
      violations.includes(path.join('bin', 'evil-seam.ts')),
      `fail-injection: evil-seam.ts was NOT flagged as out-of-band (violations: ${JSON.stringify(violations)})`,
    );
    assert.ok(
      !violations.includes(path.join('services', 'pickle-utils.ts')),
      'fail-injection: allowlisted pickle-utils.ts was incorrectly flagged as a violation',
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('FAIL-INJECTION (updateTicketFrontmatter-Done escape): a new seam flipping Done WITHOUT markTicket* is still caught', () => {
  // The crux of AC-D4: research found setup.ts:1225 and spawn-morty.ts:1563 flip Done via
  // `updateTicketFrontmatter({ status: 'Done' })` — NOT the markTicket* primitives. A new
  // out-of-band file using that same form (or a raw `status: 'Done'` object write) would escape
  // a markTicket*-only scanner. This proves the terminal-status frontmatter predicate closes it,
  // while the Failed/Todo writers and `status ===` equality checks stay spared.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-d4-fm-inject-'));
  try {
    const fakeBinDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });

    // (1) Out-of-band Done flip via updateTicketFrontmatter — the escape this predicate closes.
    fs.writeFileSync(
      path.join(fakeBinDir, 'frontmatter-done-seam.ts'),
      "export function flip(p: string) {\n" +
        "  updateTicketFrontmatter(p, sessionDir, { status: 'Done', completion_commit: sha });\n" +
        "}\n",
      'utf8',
    );

    // (2) Out-of-band raw Skipped object-literal write — the other terminal-status form.
    fs.writeFileSync(
      path.join(fakeBinDir, 'raw-skipped-seam.ts'),
      "const frontmatter = { status: 'Skipped' };\n",
      'utf8',
    );

    // Decoys that MUST NOT be flagged (false-positive guards on the green-tree shapes):
    fs.writeFileSync(
      path.join(fakeBinDir, 'failed-decoy.ts'),
      "updateTicketFrontmatter(p, sessionDir, { status: 'Failed', completion_commit: null });\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeBinDir, 'todo-decoy.ts'),
      "updateTicketFrontmatter(p, sessionDir, { status: 'Todo', completion_commit: null });\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeBinDir, 'equality-decoy.ts'),
      "if (t.status === 'Done' || t.status === 'Skipped') { return true; }\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeBinDir, 'comment-decoy.ts'),
      "// updateTicketFrontmatter(p, { status: 'Done' }) — only documented in a comment\n",
      'utf8',
    );

    const violations = findOutOfBandProducers(tmpRoot);

    // Escapes are caught:
    assert.ok(
      violations.includes(path.join('bin', 'frontmatter-done-seam.ts')),
      `updateTicketFrontmatter-Done seam was NOT flagged — the AC-D4 escape is open ` +
        `(violations: ${JSON.stringify(violations)})`,
    );
    assert.ok(
      violations.includes(path.join('bin', 'raw-skipped-seam.ts')),
      `raw status:'Skipped' object-literal write was NOT flagged (violations: ${JSON.stringify(violations)})`,
    );

    // Decoys are spared (no false positives):
    for (const decoy of ['failed-decoy.ts', 'todo-decoy.ts', 'equality-decoy.ts', 'comment-decoy.ts']) {
      assert.ok(
        !violations.includes(path.join('bin', decoy)),
        `false positive: ${decoy} was incorrectly flagged as a terminal-status producer`,
      );
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// A Failed status is written only together with its reason. `markTicketFailed` (git-utils.ts) is
// the ONE writer: status, `failed_reason`, the evidence log and the completion-commit rule land in
// a single frontmatter write. Any other `status: 'Failed'` / `updateTicketStatus(..'Failed'..)`
// write in src/ is a Failed ticket that can reach the report with no reason.
// ---------------------------------------------------------------------------------------------

const FAILED_WRITE_RE = /\bstatus:\s*['"]Failed['"]|\bupdateTicketStatus\([^)]*['"]Failed['"]/;
const FAILED_WRITER_FILE = path.join('services', 'git-utils.ts');
const FAILED_WRITER_DEF = 'export function markTicketFailed(';

/** [start, end) character span of the brace-matched body opened after `needle`, or null. */
function bracedSpan(text, needle) {
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const open = text.indexOf('{', text.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && (depth -= 1) === 0) return [open, i + 1];
  }
  return null;
}

/** Non-comment lines of `content` with their character offsets. */
function codeLines(content) {
  const out = [];
  let offset = 0;
  for (const [index, line] of content.split('\n').entries()) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('//') && !trimmed.startsWith('*')) out.push({ line, offset, lineNo: index + 1 });
    offset += line.length + 1;
  }
  return out;
}

/** `file:line` of every bare Failed write under `scanRoot` — anything outside the markTicketFailed body. */
function findBareFailedWrites(scanRoot) {
  const violations = [];
  for (const filePath of walkTs(scanRoot)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relPath = path.relative(scanRoot, filePath);
    const allowed = relPath === FAILED_WRITER_FILE ? bracedSpan(content, FAILED_WRITER_DEF) : null;
    for (const { line, offset, lineNo } of codeLines(content)) {
      if (!FAILED_WRITE_RE.test(line)) continue;
      if (allowed && offset >= allowed[0] && offset < allowed[1]) continue;
      violations.push(`${relPath}:${lineNo}`);
    }
  }
  return violations;
}

/** Every `markTicketFailed(` call site in src/ (outside its definition) with its argument text. */
function findFailedWriterCalls(scanRoot) {
  const calls = [];
  for (const filePath of walkTs(scanRoot)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const relPath = path.relative(scanRoot, filePath);
    for (const { line, offset, lineNo } of codeLines(content)) {
      const col = line.indexOf('markTicketFailed(');
      if (col < 0 || line.includes(FAILED_WRITER_DEF)) continue;
      const argStart = offset + col + 'markTicketFailed('.length;
      let depth = 1;
      let i = argStart;
      for (; i < content.length && depth > 0; i += 1) {
        if (content[i] === '(') depth += 1;
        else if (content[i] === ')') depth -= 1;
      }
      calls.push({ site: `${relPath}:${lineNo}`, args: content.slice(argStart, i - 1) });
    }
  }
  return calls;
}

function writeTicket(sessionDir, id, frontmatter) {
  fs.mkdirSync(path.join(sessionDir, id), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, id, `rick_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: "t"\n${frontmatter}\norder: 1\nupdated: "2026-01-01"\n---\n# T\n`,
  );
}

function readTicket(sessionDir, id) {
  return fs.readFileSync(path.join(sessionDir, id, `rick_ticket_${id}.md`), 'utf8');
}

function reportLine(sessionDir) {
  const logs = [];
  reportSkippedFailedTickets({ sessionDir, log: (m) => logs.push(m) });
  assert.equal(logs.length, 1);
  return logs[0];
}

function withSession(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-reason-'));
  try { return fn(path.join(root, 'session'), root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('CHECK D: no extension/src/ file writes a Failed status outside markTicketFailed', () => {
  const violations = findBareFailedWrites(srcRoot);
  assert.deepEqual(violations, [], `bare Failed write(s) — route them through markTicketFailed:\n  ${violations.join('\n  ')}`);
});

test('FAIL-INJECTION (bare Failed write): a Failed write outside markTicketFailed is flagged; the writer itself is spared', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-write-inject-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'services'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'bin', 'frontmatter-seam.ts'),
      "updateTicketFrontmatter(id, dir, { status: 'Failed', completion_commit: null });\n");
    fs.writeFileSync(path.join(tmpRoot, 'bin', 'status-seam.ts'), "updateTicketStatus(id, 'Failed', dir);\n");
    fs.writeFileSync(path.join(tmpRoot, 'bin', 'decoys.ts'),
      "// updateTicketFrontmatter(id, dir, { status: 'Failed' })\nif (t.status === 'Failed') { skip(); }\n");
    fs.writeFileSync(path.join(tmpRoot, 'services', 'git-utils.ts'),
      "export function markTicketFailed(a: string) {\n  updateTicketFrontmatter(a, b, { status: 'Failed' });\n}\n" +
      "export function other() {\n  updateTicketFrontmatter(a, b, { status: 'Failed' });\n}\n");

    const violations = findBareFailedWrites(tmpRoot);
    assert.deepEqual(violations.sort(), [
      path.join('bin', 'frontmatter-seam.ts') + ':1',
      path.join('bin', 'status-seam.ts') + ':1',
      path.join('services', 'git-utils.ts') + ':5',
    ].sort());
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describeFailedWriters();

function describeFailedWriters() {
  const calls = findFailedWriterCalls(srcRoot);
  test('every Failed writer is derived from src/ (the census is not empty)', () => {
    // Floor, not an exact count: six writers exist today; the census exists so a seventh is checked too.
    assert.ok(calls.length >= 6, `expected >= 6 markTicketFailed call sites, found ${calls.map((c) => c.site).join(', ')}`);
  });
  for (const { site, args } of calls) {
    test(`Failed writer ${site} passes a reason that the report prints`, () => {
      assert.match(args, /\breason:/, `${site} calls markTicketFailed without a reason`);
      const literal = /\breason:\s*['"]([^'"]*)['"]/.exec(args)?.[1] ?? 'derived_reason';
      withSession((sessionDir) => {
        writeTicket(sessionDir, 'aaaa1111', 'status: "In Progress"');
        markTicketFailed('aaaa1111', sessionDir, { reason: literal, evidenceLog: '/tmp/w.log' });
        assert.match(reportLine(sessionDir), new RegExp(`aaaa1111 Failed \\(${literal}\\)`));
      });
    });
  }
}

test('markTicketFailed: an empty reason still leaves a non-empty failed_reason, and the evidence log is recorded', () => {
  withSession((sessionDir) => {
    writeTicket(sessionDir, 'aaaa1111', 'status: "In Progress"');
    markTicketFailed('aaaa1111', sessionDir, { reason: '  ', evidenceLog: '/tmp/worker_session_1.log' });
    const raw = readTicket(sessionDir, 'aaaa1111');
    assert.match(raw, /^status: "Failed"$/m);
    assert.match(raw, /^failed_evidence_log: "\/tmp\/worker_session_1\.log"$/m);
    assert.match(reportLine(sessionDir), /aaaa1111 Failed \(unspecified\)/);
  });
});

test('markTicketFailed: completion-commit rule — null clears the inferred sha, a passed sha is kept, absent is untouched', () => {
  withSession((sessionDir) => {
    writeTicket(sessionDir, 'aaaa1111', 'status: "In Progress"\ncompletion_commit: "abc1234"\ncompletion_commit_inferred: "abc1234"');
    writeTicket(sessionDir, 'bbbb2222', 'status: "In Progress"');
    writeTicket(sessionDir, 'cccc3333', 'status: "In Progress"\ncompletion_commit: "def5678"\nfailed_evidence_log: "/old.log"');
    markTicketFailed('aaaa1111', sessionDir, { reason: 'r', completionCommit: null });
    markTicketFailed('bbbb2222', sessionDir, { reason: 'r', completionCommit: 'fedcba9' });
    markTicketFailed('cccc3333', sessionDir, { reason: 'r' });
    assert.doesNotMatch(readTicket(sessionDir, 'aaaa1111'), /completion_commit/);
    assert.match(readTicket(sessionDir, 'bbbb2222'), /^completion_commit: "fedcba9"$/m);
    const untouched = readTicket(sessionDir, 'cccc3333');
    assert.match(untouched, /^completion_commit: "def5678"$/m);
    assert.doesNotMatch(untouched, /failed_evidence_log/, 'a stale evidence log is cleared with the new reason');
  });
});

test('persistWorkerOutcomeStatus: a failed worker turn records its cause and the worker log', () => {
  withSession((sessionDir) => {
    writeTicket(sessionDir, 'aaaa1111', 'status: "In Progress"');
    writeTicket(sessionDir, 'bbbb2222', 'status: "In Progress"');
    const base = { sessionRoot: sessionDir, sessionWorkingDir: sessionDir, isSuccess: false, flipSuppressed: false, completionCommitSha: null };
    persistWorkerOutcomeStatus({ ...base, ticketId: 'aaaa1111', failedReason: 'worker_gate_red', evidenceLog: '/tmp/w.log' });
    persistWorkerOutcomeStatus({ ...base, ticketId: 'bbbb2222' });
    const line = reportLine(sessionDir);
    assert.match(line, /aaaa1111 Failed \(worker_gate_red\)/);
    assert.match(line, /bbbb2222 Failed \(worker_outcome_failed\)/);
    assert.match(readTicket(sessionDir, 'aaaa1111'), /^failed_evidence_log: "\/tmp\/w\.log"$/m);
  });
});

test('failureReasonFromWorkerLog: a rate/usage-limited worker log overrides the cause with the environmental class', () => {
  withSession((sessionDir, root) => {
    const limited = path.join(root, 'limited.log');
    const clean = path.join(root, 'clean.log');
    fs.writeFileSync(limited, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }) + '\n');
    fs.writeFileSync(clean, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }) + '\n');
    assert.equal(failureReasonFromWorkerLog('worker_hang', limited), RATE_LIMITED_FAILURE_REASON);
    assert.equal(failureReasonFromWorkerLog('worker_hang', clean), 'worker_hang');
    assert.equal(failureReasonFromWorkerLog('worker_hang', undefined), 'worker_hang');
    assert.equal(failureReasonFromWorkerLog('worker_hang', path.join(root, 'missing.log')), 'worker_hang');
    void sessionDir;
  });
});

test('an operator-Skipped ticket prints its skipped_reason', () => {
  withSession((sessionDir) => {
    writeTicket(sessionDir, 'aaaa1111', 'status: "Skipped"\nskipped_reason: "operator parked it"');
    assert.match(reportLine(sessionDir), /aaaa1111 Skipped \(operator parked it\)/);
  });
});
