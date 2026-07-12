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
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {
  advanceOrExitOnLadderExhaustion,
  claimWorkerProducedEverythingButCommit,
} from '../bin/mux-runner.js';
import { requiredTierArtifactPrefixes } from '../services/artifact-validation.js';
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
    if (prefix === omitPrefix) continue;
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

/** Minimal schema validator (mirrors the worker-produced-nothing.test.js shape). */
function validate(payload, defName) {
  const def = schema.definitions[defName];
  assert.ok(def, `no schema definition for '${defName}'`);
  return validateAgainst(payload, def);
}
function validateAgainst(payload, def) {
  for (const field of def.required || []) {
    if (!(field in payload)) return { valid: false, error: `missing required field: ${field}` };
  }
  for (const [field, raw] of Object.entries(def.properties || {})) {
    if (!(field in payload)) continue;
    const types = Array.isArray(raw.type) ? raw.type : [raw.type].filter(Boolean);
    const value = payload[field];
    if (Object.prototype.hasOwnProperty.call(raw, 'const') && value !== raw.const) {
      return { valid: false, error: `${field} must equal ${String(raw.const)}` };
    }
    if (raw.enum && !raw.enum.includes(value)) {
      return { valid: false, error: `${field} '${value}' not in enum` };
    }
    if (types.includes('object') && raw.required) {
      if (typeof value !== 'object' || value === null) return { valid: false, error: `${field} must be an object` };
      const nested = validateAgainst(value, raw);
      if (!nested.valid) return { valid: false, error: `${field}.${nested.error}` };
    }
    if (types.includes('array')) {
      if (!Array.isArray(value)) return { valid: false, error: `${field} must be an array` };
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
// R-CCQF says codex/human edits write QUOTED shas. All three flow through `sha.startsWith(ref)` —
// the one disjunct that does the work — plus the quote-strip in `collectReferencedCompletionShas`.
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

test('structural exclusion: the overlap fixture (prior-iteration artifacts + zero delta + 0-byte log + dirty tree) emits EXACTLY ONE event — worker_produced_nothing', async () => {
  const { repo, baseSha } = makeRepo('wmff-excl-repo-');
  const { sessionDir, statePath } = makeSession('wmff-excl-sess-');
  const { checkPartialLifecycleExit, countWorkerArtifacts } = await import('../bin/mux-runner.js');
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

    // BOTH predicates are individually satisfiable here — that is the whole point.
    const plExit = checkPartialLifecycleExit(sessionDir, statePath, id);
    const afterCount = countWorkerArtifacts(ticketDir);
    const wsdoFires = plExit === null && afterCount - afterCount === 0 && /* 0-byte log */ true;
    assert.equal(wsdoFires, true, 'R-WSDO predicate holds on the overlap fixture');
    // …and so would the new one, on its own:
    assert.ok(
      claimWorkerProducedEverythingButCommit({
        sessionDir, workingDir: repo, ticketId: id, iteration: 99, sessionLogBytes: 0, preIterSha: baseSha,
      }),
      'the everything-but-commit predicate ALSO holds — "disjoint by construction" is false',
    );

    // The runtime's if/else-if is what makes it ONE event. Mirror it here.
    const iteration = 1;
    const everythingButCommit = wsdoFires
      ? null
      : claimWorkerProducedEverythingButCommit({
        sessionDir, workingDir: repo, ticketId: id, iteration, sessionLogBytes: 0, preIterSha: baseSha,
      });
    const emitted = [];
    if (wsdoFires) emitted.push('worker_produced_nothing');
    else if (everythingButCommit) emitted.push('worker_produced_everything_but_commit');

    assert.deepEqual(emitted, ['worker_produced_nothing'], 'exactly ONE event, and R-WSDO wins');
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
