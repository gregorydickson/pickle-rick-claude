// @tier: fast
/**
 * R-PIAP-A4 — Completion validation honors tier lifecycle.
 *
 * The worker-completion validator (mux-runner.ts:checkPartialLifecycleExit) and
 * its pure helper (artifact-validation.ts:requiredTierArtifactPrefixes) must
 * derive required artifacts from TIER_LIFECYCLE[tier] (R-PIAP-A1), not a
 * hardcoded list. A trivial ticket (implement + code_review only) must validate
 * as complete and NOT be flagged; a medium ticket missing conformance must still
 * fail (no regression to the full-tier path).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { requiredTierArtifactPrefixes } = await import('../services/artifact-validation.js');
const { checkPartialLifecycleExit } = await import('../bin/mux-runner.js');

function makeSession() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-piap-a4-'));
  const sessionDir = path.join(tmp, 'session');
  mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      active: true,
      schema_version: 3,
      working_dir: tmp,
      step: 'implement',
      iteration: 0,
      max_iterations: 10,
      worker_timeout_seconds: 600,
      start_time_epoch: Math.floor(Date.now() / 1000),
      original_prompt: 'piap-a4 test',
      session_dir: sessionDir,
      tmux_mode: false,
      backend: 'claude',
      activity: [],
    }),
  );
  return { tmp, sessionDir, statePath };
}

function makeTicket(sessionDir, ticketId, tier) {
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(
    path.join(ticketDir, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\ntitle: "t"\nstatus: "In Progress"\ncomplexity_tier: ${tier}\n---\n# body\n`,
  );
  return ticketDir;
}

function partialExitEvents(statePath) {
  const state = JSON.parse(readFileSync(statePath, 'utf-8'));
  return (Array.isArray(state.activity) ? state.activity : []).filter(
    (e) => e.event === 'worker_partial_lifecycle_exit',
  );
}

test('requiredTierArtifactPrefixes derives prefixes from TIER_LIFECYCLE per tier', () => {
  assert.deepStrictEqual(requiredTierArtifactPrefixes('trivial'), ['code_review']);
  assert.deepStrictEqual(requiredTierArtifactPrefixes('small'), ['plan', 'code_review']);
  assert.deepStrictEqual(requiredTierArtifactPrefixes('medium'), [
    'research',
    'research_review',
    'plan',
    'plan_review',
    'conformance',
    'code_review',
  ]);
  assert.deepStrictEqual(requiredTierArtifactPrefixes('large'), requiredTierArtifactPrefixes('medium'));
});

test('AC-PIAP-A4-1: trivial ticket with implement + code_review validates complete (no event, not reverted to Failed)', () => {
  const { tmp, sessionDir, statePath } = makeSession();
  try {
    const ticketId = 'aaaatriv';
    const ticketDir = makeTicket(sessionDir, ticketId, 'trivial');
    // Trivial lifecycle = [implement, code_review]; implement is a diff, code_review is the only gated artifact.
    writeFileSync(path.join(ticketDir, 'code_review_2026-05-29.md'), 'PASS');
    writeFileSync(path.join(ticketDir, 'worker_session_12345.log'), 'work');

    checkPartialLifecycleExit(sessionDir, statePath, ticketId);

    assert.equal(
      partialExitEvents(statePath).length,
      0,
      'trivial ticket with code_review must NOT be flagged for missing research/plan',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('no-regression: medium ticket missing conformance_*.md still fails validation', () => {
  const { tmp, sessionDir, statePath } = makeSession();
  try {
    const ticketId = 'bbbbmed1';
    const ticketDir = makeTicket(sessionDir, ticketId, 'medium');
    writeFileSync(path.join(ticketDir, 'research_2026-05-29.md'), 'research');
    writeFileSync(path.join(ticketDir, 'research_review.md'), 'APPROVED');
    writeFileSync(path.join(ticketDir, 'plan_2026-05-29.md'), 'plan');
    writeFileSync(path.join(ticketDir, 'plan_review.md'), 'APPROVED');
    writeFileSync(path.join(ticketDir, 'code_review_2026-05-29.md'), 'PASS');
    // conformance_*.md deliberately MISSING.
    // 90574654: nonzero log without the terminal promise token keeps this exit in
    // the log_truncated sub-class → legacy worker_partial_lifecycle_exit event
    // (absent/0-byte logs now emit worker_silent_death instead).
    writeFileSync(path.join(ticketDir, 'worker_session_4242.log'), 'truncated worker output\n');

    checkPartialLifecycleExit(sessionDir, statePath, ticketId);

    const events = partialExitEvents(statePath);
    assert.equal(events.length, 1, 'medium ticket missing conformance must be flagged');
    assert.ok(
      events[0].gate_payload.artifacts_missing.includes('conformance'),
      `expected conformance in artifacts_missing, got ${JSON.stringify(events[0].gate_payload.artifacts_missing)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
