// @tier: fast
//
// WS-WMFF-2 (ticket 9da93c73):
//   AC-WMFF-2A — the ladder-exhaustion Failed-flip now archives a dirty tree first,
//                matching its two sibling flip sites.
//   AC-WMFF-2B — `worker_produced_everything_but_commit` breadcrumb: a structural
//                `else if` BELOW the R-WSDO `worker_produced_nothing` branch.
//   AC-WMFF-2C — payload/registration conformance (schema-validated here; the
//                union + oneOf $ref pins live in activity-event-payload.test.js).
//
// The breadcrumb predicate is exercised through the EXPORTED
// `claimWorkerProducedEverythingButCommit` over real on-disk git + session fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {
  advanceOrExitOnLadderExhaustion,
  checkPartialLifecycleExit,
  claimWorkerProducedEverythingButCommit,
  commitAndContinueDoneFlip,
  countWorkerArtifacts,
  executeConvergedPlanAdapter,
  emitWorkerProductionBreadcrumb,
} from '../bin/mux-runner.js';
import { requiredTierArtifactPrefixes } from '../services/artifact-validation.js';
import { resetToSha } from '../services/git-utils.js';
import { getTicketStatus } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../src/types/activity-events.schema.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const SRC_MUX = path.resolve(__dirname, '../src/bin/mux-runner.ts');

// ─────────────────────────── fixture helpers ───────────────────────────

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', timeout: 15_000 }).trim();
}

/** A real git repo with one baseline commit. Returns { repo, baseSha }. */
function makeRepo(prefix) {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'wmff@test.local']);
  git(repo, ['config', 'user.name', 'WMFF Test']);
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'base']);
  return { repo, baseSha: git(repo, ['rev-parse', 'HEAD']) };
}

function makeSession(prefix) {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ active: true, schema_version: 5, session_dir: sessionDir, activity: [] }));
  return { sessionDir, statePath };
}

/**
 * A ticket dir with frontmatter + every gated artifact its tier requires (unless
 * `omitPrefix` names one to leave out) + a session log.
 */
function makeTicket(sessionDir, ticketId, { tier = 'large', status = 'Failed', omitPrefix = null, extraFiles = {}, frontmatter = {} } = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });
  const extraFm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}\n`).join('');
  writeFileSync(
    path.join(ticketDir, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\nstatus: ${status}\ncomplexity_tier: ${tier}\norder: 1\n${extraFm}---\n# ${ticketId}\n`,
  );
  for (const prefix of requiredTierArtifactPrefixes(tier)) {
    if (prefix === omitPrefix) {
      continue;
    }
    // research_review / plan_review are bare `<prefix>.md`; the rest take a `_<date>` suffix.
    const name = prefix.endsWith('_review') ? `${prefix}.md` : `${prefix}_2026-07-11.md`;
    writeFileSync(path.join(ticketDir, name), `${prefix} body\n`);
  }
  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(path.join(ticketDir, name), content);
  }
  return ticketDir;
}

function readActivity(statePath, event) {
  const s = JSON.parse(readFileSync(statePath, 'utf8'));
  return (s.activity || []).filter((e) => e.event === event);
}

/** Every activity event the runtime actually wrote, in order. A double-fire shows up here. */
function readAllActivity(statePath) {
  const s = JSON.parse(readFileSync(statePath, 'utf8'));
  return s.activity || [];
}

/** Minimal schema validator (mirrors the worker-produced-nothing.test.js shape). */
function validate(payload, defName) {
  const def = schema.definitions[defName];
  assert.ok(def, `no schema definition for '${defName}'`);
  return validateAgainst(payload, def);
}
function validateAgainst(payload, def) {
  for (const field of def.required || []) {
    if (!(field in payload)) {
      return { valid: false, error: `missing required field: ${field}` };
    }
  }
  for (const [field, raw] of Object.entries(def.properties || {})) {
    if (!(field in payload)) {
      continue;
    }
    const types = Array.isArray(raw.type) ? raw.type : [raw.type].filter(Boolean);
    const value = payload[field];
    if (Object.prototype.hasOwnProperty.call(raw, 'const') && value !== raw.const) {
      return { valid: false, error: `${field} must equal ${String(raw.const)}` };
    }
    if (raw.enum && !raw.enum.includes(value)) {
      return { valid: false, error: `${field} '${value}' not in enum` };
    }
    if (types.includes('object') && raw.required) {
      if (typeof value !== 'object' || value === null) {
        return { valid: false, error: `${field} must be an object` };
      }
      const nested = validateAgainst(value, raw);
      if (!nested.valid) {
        return { valid: false, error: `${field}.${nested.error}` };
      }
    }
    if (types.includes('array')) {
      if (!Array.isArray(value)) {
        return { valid: false, error: `${field} must be an array` };
      }
      if (typeof raw.maxItems === 'number' && value.length > raw.maxItems) {
        return { valid: false, error: `${field} exceeds maxItems ${raw.maxItems}` };
      }
    }
    if (types.includes('boolean') && typeof value !== 'boolean') {
      return { valid: false, error: `${field} must be a boolean` };
    }
    if (types.includes('integer') && value !== null && !Number.isInteger(value)) {
      return { valid: false, error: `${field} must be an integer` };
    }
    if (types.includes('string') && value !== null && typeof value !== 'string') {
      return { valid: false, error: `${field} must be a string` };
    }
  }
  return { valid: true };
}

// ═══════════════ AC-WMFF-2A — archive on the ladder-exhaustion flip ═══════════════

test('AC-WMFF-2A: ladder-exhaustion flip with a dirty tree leaves a pre_reset archive AND flips Failed', () => {
  const { repo } = makeRepo('wmff-2a-repo-');
  const { sessionDir, statePath } = makeSession('wmff-2a-sess-');
  try {
    const stuck = 'aa11stck';
    const runnable = 'aa22todo';
    const ticketDir = makeTicket(sessionDir, stuck, { status: 'In Progress' });
    makeTicket(sessionDir, runnable, { status: 'Todo' });

    // Verified, uncommitted worker output on the floor.
    writeFileSync(path.join(repo, 'README.md'), 'base\nworker edit that must not vanish\n');
    writeFileSync(path.join(repo, 'new-file.ts'), 'export const x = 1;\n');

    const action = advanceOrExitOnLadderExhaustion({
      sessionDir, statePath, workingDir: repo, ticketId: stuck, reason: 'recovery_exhausted: test', log: () => {},
    });

    assert.equal(action, 'advance', 'a runnable Todo remains → advance');
    assert.equal(getTicketStatus(sessionDir, stuck), 'Failed', 'ticket is flipped Failed');

    const patches = readdirSync(ticketDir).filter((f) => /^pre_reset_diff_\d+\.patch$/.test(f));
    assert.equal(patches.length, 1, 'exactly one pre_reset archive was written before the flip');
    const patch = readFileSync(path.join(ticketDir, patches[0]), 'utf8');
    assert.match(patch, /worker edit that must not vanish/, 'archive captures the tracked-file diff');
    assert.match(patch, /new-file\.ts/, 'archive captures the untracked file too');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-WMFF-2A: ladder-exhaustion flip on a CLEAN tree writes no archive (self-no-op) and still flips', () => {
  const { repo } = makeRepo('wmff-2a-clean-repo-');
  const { sessionDir, statePath } = makeSession('wmff-2a-clean-sess-');
  try {
    const only = 'aa33only';
    const ticketDir = makeTicket(sessionDir, only, { status: 'In Progress' });

    const action = advanceOrExitOnLadderExhaustion({
      sessionDir, statePath, workingDir: repo, ticketId: only, reason: 'recovery_exhausted: test', log: () => {},
    });

    assert.equal(action, 'exit', 'no runnable ticket remains → exit');
    assert.equal(getTicketStatus(sessionDir, only), 'Failed');
    assert.equal(
      readdirSync(ticketDir).filter((f) => f.startsWith('pre_reset_diff_')).length,
      0,
      'clean tree → archiveBeforeDestructive self-no-ops',
    );
    assert.equal(readActivity(statePath, 'ticket_ladder_exhausted').length, 1, 'the A0-frozen literal still emits');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// The `bin/CLAUDE.md` AC-WMFF-2A trap door states this ordering as a PATTERN_SHAPE, but
// `audit-trap-door-enforcement.sh` only verifies ENFORCE-reachability — it never checks the
// shape itself. The two behavioural tests above cannot check it either: a Failed-flip does not
// mutate the working tree, so an archive moved AFTER the frontmatter write leaves both of them
// green while the downstream reset destroys the diff unexamined. Only source order can pin it.
test('AC-WMFF-2A: advanceOrExitOnLadderExhaustion archives BEFORE its Failed frontmatter write', () => {
  const src = readFileSync(SRC_MUX, 'utf8');
  const fnAt = src.indexOf('export function advanceOrExitOnLadderExhaustion');
  assert.ok(fnAt > 0, 'the ladder-exhaustion flip site exists');
  const end = src.indexOf('\n}\n', fnAt);
  assert.ok(end > fnAt, 'body is delimited');
  const body = src.slice(fnAt, end);

  const archiveAt = body.indexOf('archiveDirtyTreeBeforeFlip(');
  const flipAt = body.indexOf("status: 'Failed'");
  assert.ok(archiveAt > 0, 'the flip site calls archiveDirtyTreeBeforeFlip');
  assert.ok(flipAt > 0, "the flip site writes status: 'Failed'");
  assert.ok(
    archiveAt < flipAt,
    'the archive MUST precede the Failed flip — the B-DURA T10 boundary committer is terminal-guarded and skips an already-Failed ticket, so an archive that runs after the flip saves nothing',
  );

  // `workingDir` is REQUIRED, not optional. Making it optional both re-opens the gap and lets
  // archiveBeforeDestructive run git in `process.cwd()`. Bound the search to the param block —
  // an unfound delimiter would make `slice(0, -1)` match the whole body and pass for the wrong
  // reason.
  const sigEnd = body.indexOf('}): ');
  assert.ok(sigEnd > 0, 'the input-object signature is delimited');
  const signature = body.slice(0, sigEnd);
  assert.match(signature, /workingDir: string;/, 'workingDir is a required input (never `workingDir?:`)');

  // Trap-door claim 2: every Failed-flip site archives, so the call-site count stays >= 4
  // (the three flip sites + the orphan-reattach pre-ff-only archive).
  const callSites = (src.match(/archiveDirtyTreeBeforeFlip\(/g) ?? []).length;
  assert.ok(
    callSites >= 4,
    `expected >= 4 archiveDirtyTreeBeforeFlip call sites (3 Failed-flip sites + orphan-reattach), got ${callSites}`,
  );
});

// The sibling AC-WMFF-2A case above asserts the patch MENTIONS the work (`assert.match`).
// That oracle cannot separate a recoverable archive from an unrecoverable one: git writes a
// contentless `Binary files a/x and b/x differ` stub that still mentions the path. The archive's
// whole contract is that an operator can get the work BACK, so assert the round trip.
test('AP-EXT-ITER8-01: the pre-reset archive must APPLY — one dirty binary must not take the text down with it', () => {
  const { repo } = makeRepo('wmff-bin-repo-');
  const { sessionDir } = makeSession('wmff-bin-sess-');
  try {
    // Baseline a tracked binary so the worker's edit is a MODIFY, not an add.
    const png = path.join(repo, 'asset.png');
    writeFileSync(png, Buffer.from('89504e470d0a1a0a0001020304', 'hex'));
    git(repo, ['add', 'asset.png']);
    git(repo, ['commit', '-q', '-m', 'add binary asset']);
    const preResetSha = git(repo, ['rev-parse', 'HEAD']);

    // Uncommitted worker output on the floor: a tracked TEXT edit, a tracked BINARY edit,
    // and an untracked BINARY file — all three destroyed by the reset below.
    const text = path.join(repo, 'README.md');
    const blob = path.join(repo, 'fixture.bin');
    writeFileSync(text, 'base\nworker edit that must survive a round trip\n');
    writeFileSync(png, Buffer.from('89504e470d0a1a0aaabbccdd4d5554415445', 'hex'));
    writeFileSync(blob, Buffer.from('00014e45572d42494e415259ff', 'hex'));
    const wantText = readFileSync(text);
    const wantPng = readFileSync(png);
    const wantBlob = readFileSync(blob);

    resetToSha(preResetSha, repo, undefined, {
      cwd: repo, sessionDir, ticketDir: null, reason: 'pre_reset',
    });

    // Precondition — the destructive op really did destroy all three. Without this the
    // recovery assertions below could pass on a tree that was never reset (tautology guard).
    assert.ok(!readFileSync(text).equals(wantText), 'reset reverted the text edit');
    assert.ok(!readFileSync(png).equals(wantPng), 'reset reverted the binary edit');
    assert.equal(existsSync(blob), false, 'clean -fd removed the untracked binary');

    const patches = readdirSync(sessionDir).filter((f) => /^pre_reset_diff_\d+\.patch$/.test(f));
    assert.equal(patches.length, 1, 'exactly one pre_reset archive was written');

    // The contract: the archive IS the recovery artifact, so it must apply. `git apply` is
    // all-or-nothing — a single unappliable binary stub rejects the whole patch, taking the
    // co-archived text work with it.
    git(repo, ['apply', path.join(sessionDir, patches[0])]);

    assert.ok(readFileSync(text).equals(wantText), 'text work recovered byte-identically');
    assert.ok(readFileSync(png).equals(wantPng), 'tracked binary recovered byte-identically');
    assert.ok(readFileSync(blob).equals(wantBlob), 'untracked binary recovered byte-identically');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// The AP-EXT-ITER8-01 case above proves the BINARY class round-trips, and it can only prove
// that class: git base85-encodes what it calls binary, so those sections are pure ASCII and a
// decode cannot hurt them. The gap `--binary` never reached is a file git calls TEXT — no NUL
// in the first 8000 bytes — whose bytes are not valid UTF-8. Git emits those raw, so any decode
// on the archive pipe rewrites them. The mangling lands only in ADDED lines, so context still
// matches and `git apply` exits 0: the archive reports success and hands back different bytes.
test('AP-EXT-ITER25-01: a non-UTF-8 TEXT file survives the archive byte-identically', () => {
  const { repo } = makeRepo('wmff-enc-repo-');
  const { sessionDir } = makeSession('wmff-enc-sess-');
  try {
    // 0xE9 is latin-1 'é' and an invalid UTF-8 lead byte. No NUL anywhere, so git classifies
    // both files as TEXT and diffs them as raw bytes — never as a base85 binary patch.
    const tracked = path.join(repo, 'notes.txt');
    writeFileSync(tracked, Buffer.from('seed\n', 'latin1'));
    git(repo, ['add', 'notes.txt']);
    git(repo, ['commit', '-q', '-m', 'seed latin-1 note']);
    const preResetSha = git(repo, ['rev-parse', 'HEAD']);

    const untracked = path.join(repo, 'new-note.txt');
    writeFileSync(tracked, Buffer.from([...Buffer.from('seed\ncaf'), 0xe9, ...Buffer.from(' edit\n')]));
    writeFileSync(untracked, Buffer.from([...Buffer.from('caf'), 0xe9, ...Buffer.from(' brand new\n')]));
    const wantTracked = readFileSync(tracked);
    const wantUntracked = readFileSync(untracked);

    // Guard the fixture itself: if git ever called these binary the case would pass for the
    // wrong reason (base85 survives a decode), proving nothing about the TEXT path.
    assert.ok(wantTracked.includes(0xe9), 'fixture really holds the invalid UTF-8 byte');
    assert.equal(wantTracked.includes(0x00), false, 'fixture has no NUL — git must call it TEXT');

    resetToSha(preResetSha, repo, undefined, {
      cwd: repo, sessionDir, ticketDir: null, reason: 'pre_reset',
    });

    // Tautology guard — prove the destructive op really destroyed both.
    assert.ok(!readFileSync(tracked).equals(wantTracked), 'reset reverted the tracked edit');
    assert.equal(existsSync(untracked), false, 'clean -fd removed the untracked note');

    const patches = readdirSync(sessionDir).filter((f) => /^pre_reset_diff_\d+\.patch$/.test(f));
    assert.equal(patches.length, 1, 'exactly one pre_reset archive was written');
    git(repo, ['apply', path.join(sessionDir, patches[0])]);

    // Byte equality is the whole oracle. A decoded pipe restores U+FFFD (ef bf bd) where the
    // original held 0xe9, and `git apply` still exits 0 — so an rc check or a /caf/ match
    // would both go green over the corruption.
    assert.ok(
      readFileSync(tracked).equals(wantTracked),
      `tracked non-UTF-8 text recovered byte-identically (got ${readFileSync(tracked).toString('hex')})`,
    );
    assert.ok(
      readFileSync(untracked).equals(wantUntracked),
      `untracked non-UTF-8 text recovered byte-identically (got ${readFileSync(untracked).toString('hex')})`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ═══════════ AC-WMFF-2B — the breadcrumb predicate ═══════════

test('AC-WMFF-2B: complete artifacts + Failed + dirty tree → fires with the full discriminator payload', () => {
  const { repo, baseSha } = makeRepo('wmff-2b-repo-');
  const { sessionDir, statePath } = makeSession('wmff-2b-sess-');
  try {
    const id = 'bb11full';
    makeTicket(sessionDir, id, {
      tier: 'large',
      status: 'Failed',
      frontmatter: { worker_gate_verdict: 'green' },
      extraFiles: { 'worker_session_7777.log': 'x'.repeat(4096) },
    });
    writeFileSync(path.join(repo, 'src.ts'), 'export const y = 2;\n');

    const payload = claimWorkerProducedEverythingButCommit({
      sessionDir, workingDir: repo, ticketId: id, iteration: 3, sessionLogBytes: 4096, preIterSha: baseSha,
    });

    assert.ok(payload, 'predicate fires');
    assert.equal(payload.tier, 'large', 'tier is read from the ticket FRONTMATTER (not state.current_ticket_tier)');
    assert.deepEqual(payload.prefixes_checked, requiredTierArtifactPrefixes('large'));
    assert.equal(payload.session_log_bytes, 4096);
    assert.equal(payload.worker_gate_verdict, 'green');
    assert.deepEqual(payload.dirty_in_scope_paths, ['src.ts']);
    assert.equal(payload.truncated, false);
    assert.equal(payload.total_count, 1);
    assert.equal(payload.window_commit, null, 'HEAD never moved off preIterSha');

    // The emitted event must be schema-conformant, with the producer's explicit ts.
    const event = {
      event: 'worker_produced_everything_but_commit',
      ts: new Date().toISOString(),
      ticket: id,
      gate_payload: payload,
    };
    const res = validate(event, 'worker_produced_everything_but_commit');
    assert.equal(res.valid, true, res.error);
    assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/, 'ts is explicitly stamped (writeActivityEntry does not auto-stamp)');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// A worker that dies at budget death never persisted a gate verdict, so `absent` (the
// `readWorkerGateVerdict` default on a missing frontmatter field) is the shape this event
// carries MOST often in production — and a payload the runtime routinely writes must be
// provably schema-conformant, not merely the happy-path `green` one.
test('AC-WMFF-2B: a ticket with NO worker_gate_verdict field emits "absent" — and THAT payload is schema-conformant', () => {
  const { repo, baseSha } = makeRepo('wmff-2b-absent-repo-');
  const { sessionDir } = makeSession('wmff-2b-absent-sess-');
  try {
    const id = 'bbccabsn';
    // No `worker_gate_verdict` in frontmatter — the budget-death worker never got to persist one.
    makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });
    writeFileSync(path.join(repo, 'src.ts'), 'export const y = 2;\n');

    const payload = claimWorkerProducedEverythingButCommit({
      sessionDir, workingDir: repo, ticketId: id, iteration: 1, sessionLogBytes: 0, preIterSha: baseSha,
    });

    assert.ok(payload, 'the predicate still fires — a missing verdict is not a missing artifact');
    assert.equal(payload.worker_gate_verdict, 'absent', 'a missing frontmatter field reads "absent", never undefined');

    const res = validate(
      { event: 'worker_produced_everything_but_commit', ts: new Date().toISOString(), ticket: id, gate_payload: payload },
      'worker_produced_everything_but_commit',
    );
    assert.equal(res.valid, true, res.error);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-WMFF-2B: clean tree + an UNREFERENCED commit in preIterSha..HEAD → fires with window_commit set', () => {
  const { repo, baseSha } = makeRepo('wmff-2b-win-repo-');
  const { sessionDir, statePath } = makeSession('wmff-2b-win-sess-');
  try {
    const id = 'bb22wind';
    makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });

    // The worker committed, then died before anything claimed the commit.
    writeFileSync(path.join(repo, 'landed.ts'), 'export const z = 3;\n');
    git(repo, ['add', 'landed.ts']);
    git(repo, ['commit', '-q', '-m', 'worker work nobody claimed']);
    const orphan = git(repo, ['rev-parse', 'HEAD']);

    const payload = claimWorkerProducedEverythingButCommit({
      sessionDir, workingDir: repo, ticketId: id, iteration: 1, sessionLogBytes: 0, preIterSha: baseSha,
    });

    assert.ok(payload, 'the window-commit arm fires on a clean tree');
    assert.equal(payload.total_count, 0, 'tree is clean');
    assert.deepEqual(payload.dirty_in_scope_paths, []);
    assert.equal(payload.window_commit, orphan, 'the unclaimed commit is surfaced for recovery');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-WMFF-2B: a REFERENCED commit (some ticket\'s completion_commit) is not "unreferenced" → no fire', () => {
  const { repo, baseSha } = makeRepo('wmff-2b-ref-repo-');
  const { sessionDir } = makeSession('wmff-2b-ref-sess-');
  try {
    writeFileSync(path.join(repo, 'landed.ts'), 'export const z = 3;\n');
    git(repo, ['add', 'landed.ts']);
    git(repo, ['commit', '-q', '-m', 'claimed work']);
    const claimed = git(repo, ['rev-parse', 'HEAD']);

    const id = 'bb33refd';
    makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });
    // A sibling ticket already owns that commit.
    makeTicket(sessionDir, 'bb44sibl', { status: 'Done', frontmatter: { completion_commit: claimed } });

    const payload = claimWorkerProducedEverythingButCommit({
      sessionDir, workingDir: repo, ticketId: id, iteration: 1, sessionLogBytes: 0, preIterSha: baseSha,
    });

    assert.equal(payload, null, 'clean tree + every window commit already claimed → nothing on the floor');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// The full-40-char case above is the ONLY shape the referenced-commit arm had covered, but it is
// the rare one: the worker prompt allows a short sha, auto-promote writes unquoted short shas, and
// R-CCQF says codex/human edits write QUOTED shas. All three must survive the quote-strip in
// `collectReferencedCompletionShas` and then match as a PREFIX of the full window sha.
for (const { label, stamp } of [
  { label: 'abbreviated, unquoted (auto-promote shape)', stamp: (sha) => sha.slice(0, 7) },
  { label: 'abbreviated, quoted (R-CCQF codex/human shape)', stamp: (sha) => `"${sha.slice(0, 7)}"` },
  { label: 'full, quoted (R-CCQF codex/human shape)', stamp: (sha) => `"${sha}"` },
]) {
  test(`AC-WMFF-2B: a REFERENCED commit stamped ${label} is still recognized → no fire`, () => {
    const { repo, baseSha } = makeRepo('wmff-2b-refshape-repo-');
    const { sessionDir } = makeSession('wmff-2b-refshape-sess-');
    try {
      writeFileSync(path.join(repo, 'landed.ts'), 'export const z = 3;\n');
      git(repo, ['add', 'landed.ts']);
      git(repo, ['commit', '-q', '-m', 'claimed work']);
      const claimed = git(repo, ['rev-parse', 'HEAD']);

      const id = 'bb66shap';
      makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });
      // A sibling ticket owns that commit, stamped in this shape.
      makeTicket(sessionDir, 'bb77sibl', { status: 'Done', frontmatter: { completion_commit: stamp(claimed) } });

      const payload = claimWorkerProducedEverythingButCommit({
        sessionDir, workingDir: repo, ticketId: id, iteration: 1, sessionLogBytes: 0, preIterSha: baseSha,
      });

      assert.equal(payload, null, 'the sole window commit is already claimed → nothing on the floor');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
}

// Window LOWER bound. Every other window test commits AFTER `preIterSha`, so all of them pass
// whether the walk starts at `preIterSha` or at the session `start_commit`. These two pin the
// bound: widening the walk to `start_commit..HEAD` — the exact regression the bounded-window rule
// exists to prevent — must turn the suite RED, because a commit from an EARLIER iteration is not
// this iteration's unclaimed work.
test('AC-WMFF-2B: a commit BELOW preIterSha is outside the window → not reported as window_commit', () => {
  const { repo } = makeRepo('wmff-2b-lowbound-repo-');
  const { sessionDir } = makeSession('wmff-2b-lowbound-sess-');
  try {
    const id = 'bbaalowb';
    makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });

    // A prior iteration's commit. Under a `start_commit..HEAD` walk this is unreferenced and
    // would be wrongly surfaced as THIS iteration's unclaimed work.
    writeFileSync(path.join(repo, 'earlier.ts'), 'export const earlier = 1;\n');
    git(repo, ['add', 'earlier.ts']);
    git(repo, ['commit', '-q', '-m', 'a previous iteration already landed this']);

    // mux-runner.ts captures preIterSha = readHeadCommit(workingDir) at the TOP of the iteration.
    const preIterSha = git(repo, ['rev-parse', 'HEAD']);
    // This iteration then commits nothing and leaves a clean tree: preIterSha..HEAD is EMPTY.

    assert.equal(
      claimWorkerProducedEverythingButCommit({
        sessionDir, workingDir: repo, ticketId: id, iteration: 1, sessionLogBytes: 0, preIterSha,
      }),
      null,
      'an empty window over a clean tree means nothing is on the floor — a prior iteration\'s commit is not this one\'s',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// `rev-list` emits newest-first, so a NON-empty window whose newest commit is unclaimed would find
// that commit before ever reaching a below-window one — such a fixture passes even under a widened
// walk, for the wrong reason. To pin the lower bound with a non-empty window, the IN-window commit
// must be claimed: correct code then finds nothing unreferenced and declines, while a
// `start_commit..HEAD` walk falls through to the unclaimed below-window commit and fires.
test('AC-WMFF-2B: a claimed in-window commit does not let the walk fall through to a below-window one', () => {
  const { repo } = makeRepo('wmff-2b-lowbound2-repo-');
  const { sessionDir } = makeSession('wmff-2b-lowbound2-sess-');
  try {
    const id = 'bbbblowc';
    makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });

    // Unclaimed, and BELOW the window — a widened walk would surface this.
    writeFileSync(path.join(repo, 'earlier.ts'), 'export const earlier = 1;\n');
    git(repo, ['add', 'earlier.ts']);
    git(repo, ['commit', '-q', '-m', 'below the window, unclaimed']);
    const below = git(repo, ['rev-parse', 'HEAD']);

    const preIterSha = below;   // the iteration starts here

    // Inside the window, but already claimed by a sibling ticket.
    writeFileSync(path.join(repo, 'inside.ts'), 'export const inside = 2;\n');
    git(repo, ['add', 'inside.ts']);
    git(repo, ['commit', '-q', '-m', 'in-window work, claimed']);
    const inside = git(repo, ['rev-parse', 'HEAD']);
    makeTicket(sessionDir, 'bbccsibl', { status: 'Done', frontmatter: { completion_commit: inside } });

    assert.equal(
      claimWorkerProducedEverythingButCommit({
        sessionDir, workingDir: repo, ticketId: id, iteration: 1, sessionLogBytes: 0, preIterSha,
      }),
      null,
      `the only in-window commit is claimed → nothing on the floor; ${below.slice(0, 8)} is below the window and must not be resurrected`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-WMFF-2B: dirty_in_scope_paths is capped at 20 with truncated + total_count telling the truth', () => {
  const { repo, baseSha } = makeRepo('wmff-2b-cap-repo-');
  const { sessionDir } = makeSession('wmff-2b-cap-sess-');
  try {
    const id = 'bb55capp';
    makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });
    for (let i = 0; i < 25; i += 1) {
      writeFileSync(path.join(repo, `f${String(i).padStart(2, '0')}.ts`), `export const v${i} = ${i};\n`);
    }

    const payload = claimWorkerProducedEverythingButCommit({
      sessionDir, workingDir: repo, ticketId: id, iteration: 1, sessionLogBytes: 0, preIterSha: baseSha,
    });

    assert.ok(payload);
    assert.equal(payload.dirty_in_scope_paths.length, 20, 'FIRST 20 ONLY (20MB-state.json incident precedent)');
    assert.equal(payload.truncated, true);
    assert.equal(payload.total_count, 25, 'the true count survives the cap');
    assert.equal(
      validate({ event: 'worker_produced_everything_but_commit', ts: new Date().toISOString(), ticket: id, gate_payload: payload },
        'worker_produced_everything_but_commit').valid,
      true,
      'a capped payload is schema-conformant (maxItems: 20)',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// The 25-path test above cannot tell `truncated: dirty.length > CAP` apart from a `>=`
// off-by-one — at 25 BOTH report `true`. The boundary is the only place they disagree: at
// EXACTLY 20 a correct `>` reports `truncated: false` while a `>=` regression reports `true`.
// 21 is the first input that must truncate; 19 anchors the under-cap side.
for (const { n, expectedPaths, expectedTruncated } of [
  { n: 19, expectedPaths: 19, expectedTruncated: false },
  { n: 20, expectedPaths: 20, expectedTruncated: false },
  { n: 21, expectedPaths: 20, expectedTruncated: true },
]) {
  test(`AC-WMFF-2B: cap boundary — ${n} dirty paths → ${expectedPaths} reported, truncated=${expectedTruncated}, total_count=${n}`, () => {
    const { repo, baseSha } = makeRepo(`wmff-2b-bound${n}-repo-`);
    const { sessionDir } = makeSession(`wmff-2b-bound${n}-sess-`);
    try {
      const id = `cap${n}bnd`;
      makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });
      for (let i = 0; i < n; i += 1) {
        writeFileSync(path.join(repo, `f${String(i).padStart(2, '0')}.ts`), `export const v${i} = ${i};\n`);
      }

      const payload = claimWorkerProducedEverythingButCommit({
        sessionDir, workingDir: repo, ticketId: id, iteration: 1, sessionLogBytes: 0, preIterSha: baseSha,
      });

      assert.ok(payload, 'a dirty tree fires regardless of how many paths');
      assert.equal(payload.dirty_in_scope_paths.length, expectedPaths, 'reported slice honors the cap');
      assert.equal(payload.truncated, expectedTruncated, `truncated at n=${n} (20 is where > and >= disagree)`);
      assert.equal(payload.total_count, n, 'total_count tells the truth whether capped or not');
      assert.equal(
        validate({ event: 'worker_produced_everything_but_commit', ts: new Date().toISOString(), ticket: id, gate_payload: payload },
          'worker_produced_everything_but_commit').valid,
        true,
        'schema-conformant AT the boundary (maxItems: 20), not merely at 25',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
}

test('AC-WMFF-2B: scope.json filters dirty paths, but the #128 CLAUDE.md carve-out still counts', () => {
  const { repo } = makeRepo('wmff-2b-scope-repo-');
  const { sessionDir } = makeSession('wmff-2b-scope-sess-');
  try {
    const id = 'bb66scop';
    makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });
    writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({ allowed_paths: ['src'] }));

    // Track the in-scope + out-of-scope sources first so `git status --porcelain` lists them
    // individually (an ENTIRELY untracked dir collapses to `src/`, which is in-scope anyway).
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'in-scope.ts'), 'export const a = 0;\n');
    writeFileSync(path.join(repo, 'unrelated.ts'), 'export const b = 0;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'seed sources']);
    const baseSha = git(repo, ['rev-parse', 'HEAD']);

    writeFileSync(path.join(repo, 'src', 'in-scope.ts'), 'export const a = 1;\n');   // in scope
    writeFileSync(path.join(repo, 'unrelated.ts'), 'export const b = 2;\n');         // genuinely out of scope
    writeFileSync(path.join(repo, 'CLAUDE.md'), '# trap-door catalog\n');            // #128 carve-out

    const payload = claimWorkerProducedEverythingButCommit({
      sessionDir, workingDir: repo, ticketId: id, iteration: 1, sessionLogBytes: 0, preIterSha: baseSha,
    });

    assert.ok(payload);
    assert.deepEqual(
      [...payload.dirty_in_scope_paths].sort(),
      ['CLAUDE.md', 'src/in-scope.ts'],
      'checkScopeDiff is REUSED, so the CLAUDE.md trap-door-catalog carve-out flows through',
    );
    assert.ok(!payload.dirty_in_scope_paths.includes('unrelated.ts'), 'genuinely out-of-scope dirt is fenced out');
    assert.equal(payload.total_count, 2, 'total_count counts the IN-SCOPE set, not the raw dirty set');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// The payload's claim is "this work is still on the floor" and `archiveBeforeDestructive` is what
// puts it somewhere recoverable — so the two MUST agree on what "the work" is. The archive drops
// codegraph artifacts (`listWorkingTreeDirtyPaths(cwd, [CODEGRAPH_DIR]).filter(!isCodegraphArtifact)`);
// the breadcrumb must too. Codegraph writes its index INTO the working dir and `.codegraph/` is
// ignored only via the local, unversioned `.git/info/exclude`, so on a fresh clone — and in these
// fixtures — it is plain untracked dirt.
test('AC-WMFF-2B: codegraph runtime artifacts are NOT recoverable work → no fire', () => {
  const { repo, baseSha } = makeRepo('wmff-2b-cg-repo-');
  const { sessionDir } = makeSession('wmff-2b-cg-sess-');
  try {
    const id = 'bb88cgrf';
    makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });

    // The ONLY dirt is the runtime's own codegraph index. The archive would save nothing here.
    mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
    writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), 'binary-ish\n');

    assert.equal(
      claimWorkerProducedEverythingButCommit({
        sessionDir, workingDir: repo, ticketId: id, iteration: 1, sessionLogBytes: 0, preIterSha: baseSha,
      }),
      null,
      'a codegraph-only tree has NO recoverable work — firing here sends the operator after a patch that was never written',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-WMFF-2B: codegraph dirt is excluded from the COUNT, not merely from the capped slice', () => {
  const { repo, baseSha } = makeRepo('wmff-2b-cgmix-repo-');
  const { sessionDir } = makeSession('wmff-2b-cgmix-sess-');
  try {
    const id = 'bb99cgmx';
    makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });

    mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
    writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), 'binary-ish\n');
    writeFileSync(path.join(repo, 'real.ts'), 'export const real = 1;\n');   // genuine worker output

    const payload = claimWorkerProducedEverythingButCommit({
      sessionDir, workingDir: repo, ticketId: id, iteration: 1, sessionLogBytes: 0, preIterSha: baseSha,
    });

    assert.ok(payload, 'real uncommitted work still fires');
    assert.deepEqual(payload.dirty_in_scope_paths, ['real.ts'], 'codegraph paths never reach the payload');
    assert.equal(payload.total_count, 1, 'total_count reports the RECOVERABLE set — the set the archive would save');
    assert.equal(payload.truncated, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-WMFF-2B: idempotent once per (ticket, iteration); a NEW iteration re-arms', () => {
  const { repo, baseSha } = makeRepo('wmff-2b-idem-repo-');
  const { sessionDir } = makeSession('wmff-2b-idem-sess-');
  try {
    const id = 'bb77idem';
    makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });
    writeFileSync(path.join(repo, 'dirty.ts'), 'export const c = 3;\n');
    const args = { sessionDir, workingDir: repo, ticketId: id, sessionLogBytes: 0, preIterSha: baseSha };

    assert.ok(claimWorkerProducedEverythingButCommit({ ...args, iteration: 5 }), 'first claim fires');
    assert.equal(
      claimWorkerProducedEverythingButCommit({ ...args, iteration: 5 }),
      null,
      're-check of the SAME (ticket, iteration) must not re-emit (bounded-terminal-escape revisits included)',
    );
    assert.ok(claimWorkerProducedEverythingButCommit({ ...args, iteration: 6 }), 'a new iteration re-arms');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// The claim key is `${ticketId}:${iteration}`, but the idempotency test above varies ONLY the
// iteration. A regression that keyed the ledger on the iteration alone would pass it — while
// silently suppressing the breadcrumb for every ticket after the first in any given iteration.
// Two DIFFERENT tickets at the SAME iteration is the only input that can see that.
test('AC-WMFF-2B: the claim key is per-(ticket, iteration) — two tickets at the SAME iteration both fire', () => {
  const { repo, baseSha } = makeRepo('wmff-2b-key-repo-');
  const { sessionDir } = makeSession('wmff-2b-key-sess-');
  try {
    const first = 'dd11keya';
    const second = 'dd22keyb';
    makeTicket(sessionDir, first, { tier: 'large', status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });
    makeTicket(sessionDir, second, { tier: 'small', status: 'Failed', extraFiles: { 'worker_session_2.log': '' } });
    writeFileSync(path.join(repo, 'dirty.ts'), 'export const g = 7;\n');

    const args = { sessionDir, workingDir: repo, iteration: 42, sessionLogBytes: 0, preIterSha: baseSha };
    const a = claimWorkerProducedEverythingButCommit({ ...args, ticketId: first });
    const b = claimWorkerProducedEverythingButCommit({ ...args, ticketId: second });

    assert.ok(a, 'the first ticket fires at iteration 42');
    assert.ok(b, 'a DIFFERENT ticket at the SAME iteration ALSO fires — the key is not iteration-only');

    // Each payload describes its OWN ticket (tier read per-ticket from frontmatter), never a
    // shared or cached one.
    assert.equal(a.tier, 'large');
    assert.equal(b.tier, 'small');
    assert.deepEqual(a.prefixes_checked, requiredTierArtifactPrefixes('large'));
    assert.deepEqual(b.prefixes_checked, requiredTierArtifactPrefixes('small'));

    // …and each remains claim-once under its own key.
    assert.equal(claimWorkerProducedEverythingButCommit({ ...args, ticketId: first }), null, 'first ticket already claimed');
    assert.equal(claimWorkerProducedEverythingButCommit({ ...args, ticketId: second }), null, 'second ticket already claimed');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-WMFF-2B: negative cases — non-Failed status, a missing required prefix, and a clean/claimed tree', () => {
  const { repo, baseSha } = makeRepo('wmff-2b-neg-repo-');
  const { sessionDir } = makeSession('wmff-2b-neg-sess-');
  try {
    writeFileSync(path.join(repo, 'dirty.ts'), 'export const d = 4;\n');
    const base = { sessionDir, workingDir: repo, iteration: 1, sessionLogBytes: 0, preIterSha: baseSha };

    // (a) not the worker-flip class — the ticket is not Failed.
    makeTicket(sessionDir, 'bb88inpr', { status: 'In Progress', extraFiles: { 'worker_session_1.log': '' } });
    assert.equal(claimWorkerProducedEverythingButCommit({ ...base, ticketId: 'bb88inpr' }), null, 'In Progress → no fire');

    makeTicket(sessionDir, 'bb99done', { status: 'Done', extraFiles: { 'worker_session_1.log': '' } });
    assert.equal(claimWorkerProducedEverythingButCommit({ ...base, ticketId: 'bb99done' }), null, 'Done → no fire');

    // (b) NOT "everything but commit" — a required artifact prefix is missing.
    makeTicket(sessionDir, 'bbaamiss', { status: 'Failed', omitPrefix: 'code_review', extraFiles: { 'worker_session_1.log': '' } });
    assert.equal(
      claimWorkerProducedEverythingButCommit({ ...base, ticketId: 'bbaamiss' }),
      null,
      'a missing code_review artifact means the worker did NOT produce everything',
    );

    // (c) nothing on the floor — clean tree, no window commit.
    const { repo: cleanRepo, baseSha: cleanBase } = makeRepo('wmff-2b-neg-clean-');
    try {
      makeTicket(sessionDir, 'bbbbclen', { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });
      assert.equal(
        claimWorkerProducedEverythingButCommit({ ...base, workingDir: cleanRepo, preIterSha: cleanBase, ticketId: 'bbbbclen' }),
        null,
        'clean tree + no unreferenced commit → nothing to recover, no breadcrumb',
      );
    } finally {
      rmSync(cleanRepo, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ═══════════ Structural exclusion — R-WSDO wins the overlap ═══════════

test('structural exclusion: the overlap fixture (prior-iteration artifacts + zero delta + 0-byte log + dirty tree) emits EXACTLY ONE event — worker_produced_nothing', () => {
  const { repo, baseSha } = makeRepo('wmff-excl-repo-');
  const { sessionDir, statePath } = makeSession('wmff-excl-sess-');
  try {
    const id = 'cc11over';
    // The exact double-fire fixture the ticket calls out: a RESPAWNED worker that
    // carries a COMPLETE prior-iteration artifact set, produced zero NEW artifacts
    // this iteration, wrote a 0-byte log, and left a dirty tree.
    const ticketDir = makeTicket(sessionDir, id, {
      tier: 'large',
      status: 'Failed',
      extraFiles: { 'worker_session_4242.log': '' },
    });
    writeFileSync(path.join(repo, 'dirty.ts'), 'export const e = 5;\n');

    // R-WSDO's three conjuncts, each MEASURED from real on-disk state and then fed to the
    // runtime emitter. An assertion over a term the fixture hardcodes cannot fail, so it
    // characterizes nothing — these are read back off disk, not asserted into existence.
    const plExit = checkPartialLifecycleExit(sessionDir, statePath, id);
    const beforeCount = countWorkerArtifacts(ticketDir);
    // …the respawned worker's iteration runs HERE and produces nothing new…
    const afterCount = countWorkerArtifacts(ticketDir);
    const logBytes = statSync(path.join(ticketDir, 'worker_session_4242.log')).size;

    assert.equal(plExit, null, 'R-WSDO term 1: a complete prefix set forces plExit === null');
    assert.equal(afterCount - beforeCount, 0, 'R-WSDO term 2: zero NEW artifacts this iteration (measured delta)');
    assert.equal(logBytes, 0, 'R-WSDO term 3: the session log is 0 bytes (read from disk)');

    // BOTH predicates are individually satisfiable on this fixture — that is the whole point,
    // and it is why mutual exclusion has to live in the emitter's control flow. Probe the
    // second one on a throwaway iteration so the claim-once key for iteration 1 stays unburnt.
    assert.ok(
      claimWorkerProducedEverythingButCommit({
        sessionDir, workingDir: repo, ticketId: id, iteration: 99, sessionLogBytes: 0, preIterSha: baseSha,
      }),
      'the everything-but-commit predicate ALSO holds — "disjoint by construction" is false',
    );

    // Drive the REAL emitter — the same function the mux loop calls — and read the events it
    // actually wrote. A test-local re-derivation of the if/else-if would pass against a
    // production double-fire; only state.json can refute one.
    const fired = emitWorkerProductionBreadcrumb({
      sessionDir,
      statePath,
      workingDir: repo,
      ticketId: id,
      iteration: 1,
      partialLifecycleExit: plExit,
      artifactDelta: afterCount - beforeCount,
      preIterSha: baseSha,
    });

    assert.equal(fired, 'worker_produced_nothing', 'R-WSDO wins the overlap');
    assert.deepEqual(
      readAllActivity(statePath).map((e) => e.event),
      ['worker_produced_nothing'],
      'EXACTLY ONE event reached state.json — an eager second arm would leave two',
    );

    // Term 2 is load-bearing, not vacuous: a worker that DID produce a new artifact this
    // iteration moves the delta off zero, so R-WSDO declines and the `else if` arm becomes
    // reachable. A delta term that cannot be pushed off zero is not measuring anything.
    writeFileSync(path.join(ticketDir, 'code_review_2026-07-12.md'), 'produced THIS iteration\n');
    assert.notEqual(
      countWorkerArtifacts(ticketDir) - beforeCount, 0,
      'a new artifact moves the measured delta off zero — term 2 genuinely discriminates',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// The 0-byte/1-byte boundary — the else-if's OTHER arm. R-WSDO requires `log_empty`, so a
// single byte makes it decline and the breadcrumb becomes the event that must fire. That is the
// live incident's own shape: the worker logged real work, then died at budget with the diff
// uncommitted. A fixture set that only ever passes a 0-byte log never reaches this arm.
test('structural exclusion: a 1-BYTE session log flips the else-if — R-WSDO declines, the breadcrumb wins (the incident shape)', () => {
  const { repo, baseSha } = makeRepo('wmff-1byte-repo-');
  const { sessionDir, statePath } = makeSession('wmff-1byte-sess-');
  try {
    const id = 'cc22oneb';
    // Identical to the overlap fixture in EVERY respect but one: the log carries a single byte.
    const ticketDir = makeTicket(sessionDir, id, {
      tier: 'large',
      status: 'Failed',
      extraFiles: { 'worker_session_4242.log': 'x' },
    });
    writeFileSync(path.join(repo, 'dirty.ts'), 'export const e = 5;\n');

    const plExit = checkPartialLifecycleExit(sessionDir, statePath, id);
    const beforeCount = countWorkerArtifacts(ticketDir);
    const afterCount = countWorkerArtifacts(ticketDir);
    const logBytes = statSync(path.join(ticketDir, 'worker_session_4242.log')).size;
    assert.equal(logBytes, 1, 'the ONLY difference from the overlap fixture is this one byte');
    assert.equal(plExit, null, 'the prefix set is still complete, so plExit is still null');
    assert.equal(afterCount - beforeCount, 0, 'the artifact delta is still zero');

    // The emitter reads the log size off disk itself — the one byte is what makes R-WSDO's
    // log_empty term false, so the else-if arm becomes reachable and the breadcrumb wins.
    const fired = emitWorkerProductionBreadcrumb({
      sessionDir,
      statePath,
      workingDir: repo,
      ticketId: id,
      iteration: 1,
      partialLifecycleExit: plExit,
      artifactDelta: afterCount - beforeCount,
      preIterSha: baseSha,
    });

    assert.equal(fired, 'worker_produced_everything_but_commit', 'at 1 byte it is the breadcrumb, not R-WSDO');
    const emitted = readAllActivity(statePath);
    assert.deepEqual(
      emitted.map((e) => e.event),
      ['worker_produced_everything_but_commit'],
      'still EXACTLY ONE event in state.json — but the other arm of the else-if',
    );

    const entry = emitted[0];
    assert.equal(entry.gate_payload.session_log_bytes, 1, 'the non-zero log size round-trips into the payload');
    assert.equal(
      validate(entry, 'worker_produced_everything_but_commit').valid,
      true,
      'the incident-shaped payload the runtime actually wrote is schema-conformant',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('structural exclusion: the runtime region is a real if/else-if with R-WSDO FIRST', () => {
  const src = readFileSync(SRC_MUX, 'utf8');
  const wsdoAt = src.indexOf("event: 'worker_produced_nothing'");
  const ebcAt = src.indexOf("event: 'worker_produced_everything_but_commit'");
  assert.ok(wsdoAt > 0 && ebcAt > 0, 'both emitters exist in mux-runner.ts');
  assert.ok(wsdoAt < ebcAt, 'worker_produced_nothing is emitted FIRST in the source');

  const region = src.slice(wsdoAt, ebcAt);
  assert.match(region, /}\s*else if \(everythingButCommit\)\s*{/, 'the new arm is a structural `else if`, not a sibling `if`');
  // Both emitters stamp ts explicitly — writeActivityEntry does NOT auto-stamp.
  const ebcCall = src.slice(ebcAt, ebcAt + 400);
  assert.match(ebcCall, /ts: new Date\(\)\.toISOString\(\)/, 'the producer stamps ts explicitly');
});

// ═══════════ Observability-only invariant ═══════════

test('observability-only: the emit path performs NO reap/salvage/status/frontmatter write', () => {
  const { repo, baseSha } = makeRepo('wmff-obs-repo-');
  const { sessionDir } = makeSession('wmff-obs-sess-');
  try {
    const id = 'dd11obsv';
    const ticketDir = makeTicket(sessionDir, id, { status: 'Failed', extraFiles: { 'worker_session_1.log': '' } });
    writeFileSync(path.join(repo, 'dirty.ts'), 'export const f = 6;\n');

    const ticketPath = path.join(ticketDir, `rick_ticket_${id}.md`);
    const before = readFileSync(ticketPath, 'utf8');
    const beforeFiles = readdirSync(ticketDir).sort();
    const beforeHead = git(repo, ['rev-parse', 'HEAD']);
    const beforeStatus = git(repo, ['status', '--porcelain']);
    const beforeMtime = statSync(ticketPath).mtimeMs;

    const payload = claimWorkerProducedEverythingButCommit({
      sessionDir, workingDir: repo, ticketId: id, iteration: 1, sessionLogBytes: 0, preIterSha: baseSha,
    });
    assert.ok(payload, 'the predicate fired — so this is the real emit path, not a vacuous pass');

    assert.equal(readFileSync(ticketPath, 'utf8'), before, 'ticket frontmatter is byte-identical (no status/frontmatter write)');
    assert.equal(statSync(ticketPath).mtimeMs, beforeMtime, 'the ticket file was not even rewritten');
    assert.equal(getTicketStatus(sessionDir, id), 'Failed', 'status untouched');
    assert.deepEqual(readdirSync(ticketDir).sort(), beforeFiles, 'no salvage/archive artifact was written');
    assert.equal(git(repo, ['rev-parse', 'HEAD']), beforeHead, 'no commit — HEAD is untouched');
    assert.equal(git(repo, ['status', '--porcelain']), beforeStatus, 'the dirty tree is left exactly as found (no reap)');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('observability-only: claimWorkerProducedEverythingButCommit contains no mutating call', () => {
  const src = readFileSync(SRC_MUX, 'utf8');
  const start = src.indexOf('export function claimWorkerProducedEverythingButCommit');
  assert.ok(start > 0, 'the claim function exists');
  // Body ends at the next top-level `\n}\n` after the signature.
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'body is delimited');
  const body = src.slice(start, end);

  for (const forbidden of [
    'updateTicketFrontmatter',
    'writeTicketStatus',
    'upsertFrontmatterField',
    'markTicketDone',
    'markTicketSkipped',
    'salvageTicket',
    'salvageDirtyTree',
    'archiveBeforeDestructive',
    'archiveDirtyTreeBeforeFlip',
    'writeActivityEntry',
    'sm.update',
    'forceWrite',
    'writeFileSync',
  ]) {
    assert.ok(!body.includes(forbidden), `emit path must not call ${forbidden} — it is observability ONLY`);
  }
});

// ─────────── AP-EXT-ITER6-01: the Done-flip committer stages the OWNED set ───────────
//
// B-PCOMP (#b736337f) built the ownership/salvage guard at the exit-path CALL SITE and
// left `commitAndContinueDoneFlip`'s `stagePaths`-absent default a whole-tree
// `git add -A`. The recovery-ladder rung-1 caller (`attemptRecoveryBeforeTerminal`)
// passes no `stagePaths`, so it swept `.codegraph/` — the runtime's own regenerable
// index, untracked dirt in any target repo — into a commit it then stamps as the
// ticket's `completion_commit`.
//
// Assert the COMMIT CONTENT, never the return value: the guard/Done-flip runs AFTER
// the commit lands, so a return-value pin greens over the pollution.

test('AP-EXT-ITER6-01: a stagePaths-less Done-flip commit excludes .codegraph/ and keeps the worker edit', () => {
  const { repo } = makeRepo('ap-iter6-repo-');
  const { sessionDir, statePath } = makeSession('ap-iter6-session-');
  const ticketId = 'abc12345';
  makeTicket(sessionDir, ticketId, { tier: 'small', status: 'In Progress' });

  // The worker's real deliverable …
  writeFileSync(path.join(repo, 'src.ts'), 'export const x = 1;\n');
  // … alongside the runtime's own codegraph index (untracked; ignored ONLY via the
  // unversioned .git/info/exclude, which a fresh clone / target repo does not carry).
  mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
  writeFileSync(path.join(repo, '.codegraph', 'graph.db'), 'BINARY-INDEX\n');

  const prev = process.env.PICKLE_TEST_MODE;
  process.env.PICKLE_TEST_MODE = '1';
  try {
    commitAndContinueDoneFlip({
      sessionDir, ticketId, workingDir: repo, statePath, flags: {}, log: () => {},
    });
  } finally {
    if (prev === undefined) delete process.env.PICKLE_TEST_MODE; else process.env.PICKLE_TEST_MODE = prev;
  }

  const committed = git(repo, ['show', '--pretty=format:', '--name-only', 'HEAD'])
    .split('\n').map(s => s.trim()).filter(Boolean);

  assert.ok(committed.includes('src.ts'), `the worker deliverable must be committed (got ${JSON.stringify(committed)})`);
  assert.deepEqual(
    committed.filter(p => p === '.codegraph' || p.startsWith('.codegraph/')),
    [],
    `the runtime's own codegraph index must never ride into a ticket completion commit (got ${JSON.stringify(committed)})`,
  );
  // And it is still on the floor, untracked — excluded, not destroyed.
  assert.ok(existsSync(path.join(repo, '.codegraph', 'graph.db')), 'the codegraph index is left in place');

  rmSync(repo, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

test('AP-EXT-ITER6-01: the whole-tree add carries the shared codegraph pathspec excludes', () => {
  const src = readFileSync(SRC_MUX, 'utf8');
  const start = src.indexOf('export function commitAndContinueDoneFlip');
  assert.ok(start > 0, 'the committer exists');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const wholeTreeAdd = body.match(/'add',\s*'-A'[^\]]*/);
  assert.ok(wholeTreeAdd, 'the committer still has its whole-tree add branch');
  assert.match(
    wholeTreeAdd[0],
    /\.\.\.CODEGRAPH_PATHSPEC_EXCLUDES/,
    'the whole-tree add must spread the ONE shared exclusion constant, not a hand-copied pathspec',
  );
});

// AP-EXT-ITER6-01 replay: the sibling whole-tree add — `executeConvergedPlanAdapter`'s
// per-Phase `commitPhase`. Same shape, same target repo, same pollution.
test('AP-EXT-ITER6-01 (replay): execute-converged-plan phase commits exclude .codegraph/', () => {
  const { repo } = makeRepo('ap-iter6r-repo-');
  const { sessionDir, statePath } = makeSession('ap-iter6r-session-');
  const ticketId = 'def67890';
  const ticketDir = makeTicket(sessionDir, ticketId, { tier: 'small', status: 'In Progress' });
  writeFileSync(
    path.join(ticketDir, 'plan_2026-08-07.md'),
    '# plan\n\n## Phase 1 — do the thing\n\n**Verify:** `true`\n',
  );

  writeFileSync(path.join(repo, 'src.ts'), 'export const y = 2;\n');
  mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
  writeFileSync(path.join(repo, '.codegraph', 'graph.db'), 'BINARY-INDEX\n');

  const out = executeConvergedPlanAdapter({
    sessionDir, ticketId, workingDir: repo, statePath, log: () => {},
  });
  assert.equal(out.ok, true, 'the single-phase plan executes and commits');

  const committed = git(repo, ['show', '--pretty=format:', '--name-only', 'HEAD'])
    .split('\n').map(s => s.trim()).filter(Boolean);
  assert.ok(committed.includes('src.ts'), `the phase deliverable must be committed (got ${JSON.stringify(committed)})`);
  assert.deepEqual(
    committed.filter(p => p === '.codegraph' || p.startsWith('.codegraph/')),
    [],
    `the codegraph index must never ride into a converged-plan phase commit (got ${JSON.stringify(committed)})`,
  );

  rmSync(repo, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

// --- AP-EXT-ITER55-02: the plan-phase verify's capture buffer IS the verdict ---------------
//
// `executeConvergedPlanAdapter` runs each approved Phase's `**Verify:**` through a
// capture-mode shell spawn and reads `ok` off `r.status === 0` and NOTHING else. That
// command is arbitrary operator plan text — routinely a whole test suite — so its stdout is
// unbounded. Past Node's 1MB DEFAULT `maxBuffer` the child is SIGTERMed and reported as
// `status === null` / `ENOBUFS`: neither `0` nor `ETIMEDOUT`, so a PASSING phase reads
// not-ok, `executePhaseLoop` stops there, and the R-ORSR-3 partial-failure contract leaves
// phase k's work uncommitted while the rung reports failure over green work.
//
// Assert the RUNG'S DISPOSITION and the landed commit, never the captured text.

/**
 * An emitter that streams `bytes` to stdout and exits on its own.
 *
 * `.mjs` because the tmpdir has no package.json — a `.js` emitter would be parsed as
 * CommonJS and die on the ESM import, reddening this case on a syntax error instead of on
 * buffer size. `writeSync(1, ...)` is BLOCKING and the process ends naturally: stdout is a
 * pipe, so `process.stdout.write(big); process.exit(0)` delivers only 65536 bytes, never
 * overflows the cap, and the case would then pass AGAINST the defect (the AP-EXT-ITER55-01
 * flush trap — that fixture documents the same trap, and both were mutation-verified).
 */
function writeBigVerifyEmitter(dir, bytes) {
  const emitterPath = path.join(dir, 'emit-verify-output.mjs');
  writeFileSync(emitterPath, [
    "import fs from 'node:fs';",
    "const chunk = 'verify: a realistically long passing line from an operator plan phase\\n';",
    "let out = '';",
    `while (out.length < ${bytes}) out += chunk;`,
    'fs.writeSync(1, out);',
    '',
  ].join('\n'));
  return emitterPath;
}

function writeSinglePhasePlan(ticketDir, verifyCommand) {
  writeFileSync(
    path.join(ticketDir, 'plan_2026-08-23.md'),
    `# plan\n\n## Phase 1 — verbose but passing\n\n**Verify:** \`${verifyCommand}\`\n`,
  );
}

test('AP-EXT-ITER55-02: a plan-phase verify streaming past the 1MB default is still OK and commits', () => {
  const { repo, baseSha } = makeRepo('ap-iter55b-repo-');
  const { sessionDir, statePath } = makeSession('ap-iter55b-session-');
  const ticketId = 'c7d8e9fa';
  const ticketDir = makeTicket(sessionDir, ticketId, { tier: 'small', status: 'In Progress' });

  // 1.5MB — over Node's 1MB default, well under the shared 64MB UNBOUNDED_READ_MAX_BUFFER.
  const emitterPath = writeBigVerifyEmitter(sessionDir, 1_500_000);
  writeSinglePhasePlan(ticketDir, `node ${JSON.stringify(emitterPath)}`);
  writeFileSync(path.join(repo, 'src.ts'), 'export const y = 2;\n');

  const out = executeConvergedPlanAdapter({
    sessionDir, ticketId, workingDir: repo, statePath, log: () => {},
  });

  // The whole defect in one pair: a verify that EXITS 0 must be ok, and the phase's work
  // must land. Pre-fix the capture returned status=null/ENOBUFS, `executePhase` returned
  // not-ok, the loop stopped at phase 1, and this commit never happened.
  assert.equal(out.ok, true, 'a verify command that exits 0 must not be read as a failed phase');
  assert.notEqual(git(repo, ['rev-parse', 'HEAD']), baseSha, 'the phase commit must have landed');
  assert.match(git(repo, ['log', '-1', '--format=%s']), /execute-converged-plan phase 1/);

  rmSync(repo, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

test('AP-EXT-ITER55-02 control: a verbose verify that genuinely FAILS is still not-ok and commits nothing', () => {
  const { repo, baseSha } = makeRepo('ap-iter55b-fail-repo-');
  const { sessionDir, statePath } = makeSession('ap-iter55b-fail-session-');
  const ticketId = 'c7d8e9fb';
  const ticketDir = makeTicket(sessionDir, ticketId, { tier: 'small', status: 'In Progress' });

  // Same byte volume, non-zero exit. Without this control the cap could over-trigger — turn
  // a real phase failure green — and nothing would notice.
  const emitterPath = writeBigVerifyEmitter(sessionDir, 1_500_000);
  writeFileSync(emitterPath, `${readFileSync(emitterPath, 'utf-8')}process.exitCode = 1;\n`);
  writeSinglePhasePlan(ticketDir, `node ${JSON.stringify(emitterPath)}`);
  writeFileSync(path.join(repo, 'src.ts'), 'export const y = 3;\n');

  const out = executeConvergedPlanAdapter({
    sessionDir, ticketId, workingDir: repo, statePath, log: () => {},
  });

  assert.equal(out.ok, false, 'a verify command that exits non-zero is a real phase failure');
  assert.equal(git(repo, ['rev-parse', 'HEAD']), baseSha, 'a failed phase commits nothing');

  rmSync(repo, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

// --- AP-EXT-ITER2-01: a multi-phase converged plan is the DOMINANT shape ------------------
//
// `executeCleanTreeReExecution` spawns ONE implement pass against the WHOLE plan, so the
// entire diff is already in the tree when the verify-and-commit loop starts. Phase 1's
// `git add -A` therefore stages everything and phases 2..N have nothing of their own left.
// `git commit` exits 1 on an empty index, which `commitPhase` read as a phase FAILURE:
// `executePhaseLoop` stopped at phase 2, the adapter returned `ok:false`, and the ladder
// escalated to the terminal `recovery_exhausted` — a FAILURE exit that stops auto-resume —
// over work that was fully committed with a clean tree and every verify green.
//
// This is not an edge case: of the 32 real `plan_*.md` artifacts on the operator's box that
// carry `## Phase` blocks, 31 have 2+ phases. Every existing case in this file uses a
// SINGLE-phase plan, which is the one shape the defect cannot reach.
//
// Assert the RUNG'S DISPOSITION plus the landed commit, and pair it with an all-no-op
// control so the empty-index tolerance can never turn "nothing was recovered" green.

function writeMultiPhasePlan(ticketDir) {
  writeFileSync(
    path.join(ticketDir, 'plan_2026-08-26.md'),
    '# plan\n\n## Phase 1 — first\n\n**Verify:** `true`\n\n## Phase 2 — second\n\n**Verify:** `true`\n',
  );
}

test('AP-EXT-ITER2-01: a 2-phase plan whose work all lands in phase 1 is ok, not a failed rung', () => {
  const { repo, baseSha } = makeRepo('ap-iter2-repo-');
  const { sessionDir, statePath } = makeSession('ap-iter2-session-');
  const ticketId = 'a1b2c3d4';
  const ticketDir = makeTicket(sessionDir, ticketId, { tier: 'small', status: 'In Progress' });
  writeMultiPhasePlan(ticketDir);

  // The implement pass already produced the whole plan's diff.
  writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(repo, 'b.ts'), 'export const b = 2;\n');

  const out = executeConvergedPlanAdapter({
    sessionDir, ticketId, workingDir: repo, statePath, log: () => {},
  });

  // Pre-fix this was `false`, and the ladder terminated the run `recovery_exhausted`.
  assert.equal(out.ok, true, 'every phase verified green and the work landed — the rung succeeded');
  assert.notEqual(git(repo, ['rev-parse', 'HEAD']), baseSha, 'the plan work must be committed');
  assert.equal(git(repo, ['status', '--porcelain']), '', 'no plan work may be left uncommitted');

  rmSync(repo, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

test('AP-EXT-ITER2-01 control: an all-no-op run over a clean tree stays not-ok', () => {
  const { repo, baseSha } = makeRepo('ap-iter2-noop-repo-');
  const { sessionDir, statePath } = makeSession('ap-iter2-noop-session-');
  const ticketId = 'a1b2c3d5';
  const ticketDir = makeTicket(sessionDir, ticketId, { tier: 'small', status: 'In Progress' });
  writeMultiPhasePlan(ticketDir);

  // No tree delta at all: both phases stage nothing. Tolerating an empty index must NOT
  // turn "nothing was recovered" into a green rung — the verdict is a LANDED COMMIT.
  const out = executeConvergedPlanAdapter({
    sessionDir, ticketId, workingDir: repo, statePath, log: () => {},
  });

  assert.equal(out.ok, false, 'a rung that commits nothing has recovered nothing');
  assert.equal(git(repo, ['rev-parse', 'HEAD']), baseSha, 'HEAD must not move');

  rmSync(repo, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

test('AP-EXT-ITER2-01: a genuinely failing phase 2 still stops the loop and fails the rung', () => {
  const { repo, baseSha } = makeRepo('ap-iter2-fail-repo-');
  const { sessionDir, statePath } = makeSession('ap-iter2-fail-session-');
  const ticketId = 'a1b2c3d6';
  const ticketDir = makeTicket(sessionDir, ticketId, { tier: 'small', status: 'In Progress' });
  writeFileSync(
    path.join(ticketDir, 'plan_2026-08-26.md'),
    '# plan\n\n## Phase 1 — first\n\n**Verify:** `true`\n\n## Phase 2 — second\n\n**Verify:** `false`\n',
  );
  writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');

  const out = executeConvergedPlanAdapter({
    sessionDir, ticketId, workingDir: repo, statePath, log: () => {},
  });

  assert.equal(out.ok, false, 'a phase whose verify exits non-zero is still a real rung failure');
  assert.notEqual(git(repo, ['rev-parse', 'HEAD']), baseSha, 'phase 1 stays committed (partial-failure contract)');

  rmSync(repo, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});
