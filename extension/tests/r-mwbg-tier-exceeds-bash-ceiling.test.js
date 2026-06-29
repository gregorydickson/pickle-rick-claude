// @tier: fast
//
// R-MWBG runtime half: the detached-routing gate must fire for a ticket whose
// EXPLICIT frontmatter tier exceeds the 600s Bash ceiling (medium/large) and must
// NOT fire for the prd/no-ticket phase or a default-tier ticket. This is the exact
// distinction the FIRST attempt got wrong (reverted at the beta.30 closer): a
// budget predicate keyed on state.current_ticket_tier fired during the prd phase
// AND for every default-tier ticket because sessionRunnerBudget stamps the `medium`
// fallback there, dragging them through the detached path that bypasses runIteration
// invariants. tierExceedsBashCeiling reads the EXPLICIT field, so both yield false.
// Throwaway temp fixtures only — never the live orchestration state.json.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function setupSession() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r-mwbg-tier-'));
}

// Writes a ticket file; omit `complexity_tier` to model a DEFAULT-tier ticket.
function writeTicket(sessionDir, id, frontmatter) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), `---\n${lines}\n---\n# ${id}\n`);
}

test('R-MWBG: tierExceedsBashCeiling fires for explicit medium/large, never for prd/default', async () => {
  const { tierExceedsBashCeiling, BASH_TOOL_CEILING_SECONDS } = await import('../bin/mux-runner.js');
  assert.equal(BASH_TOOL_CEILING_SECONDS, 600, 'ceiling constant pinned');

  const sessionDir = setupSession();
  // state=null: prove the gate decides from the ticket frontmatter alone, never the
  // polluting state.current_ticket_* fallback that broke the first attempt.
  const state = null;
  try {
    writeTicket(sessionDir, 'mlarge00', { id: 'mlarge00', status: 'Todo', complexity_tier: 'large' });
    writeTicket(sessionDir, 'mmedium0', { id: 'mmedium0', status: 'Todo', complexity_tier: 'medium' });
    writeTicket(sessionDir, 'msmall00', { id: 'msmall00', status: 'Todo', complexity_tier: 'small' });
    writeTicket(sessionDir, 'mtrivial', { id: 'mtrivial', status: 'Todo', complexity_tier: 'trivial' });
    // DEFAULT-tier ticket — no complexity_tier field at all (the revert root cause).
    writeTicket(sessionDir, 'mdefault', { id: 'mdefault', status: 'Todo' });
    // Garbage tier value — must reject, not normalize to medium.
    writeTicket(sessionDir, 'mjunk000', { id: 'mjunk000', status: 'Todo', complexity_tier: 'enormous' });

    // Over the ceiling → detached.
    assert.equal(tierExceedsBashCeiling(state, sessionDir, 'mlarge00'), true, 'explicit large → detached');
    assert.equal(tierExceedsBashCeiling(state, sessionDir, 'mmedium0'), true, 'explicit medium → detached (the fix)');

    // At/under the ceiling → in-process.
    assert.equal(tierExceedsBashCeiling(state, sessionDir, 'msmall00'), false, 'explicit small (600s) → in-process');
    assert.equal(tierExceedsBashCeiling(state, sessionDir, 'mtrivial'), false, 'explicit trivial → in-process');

    // The revert root cause: default-tier + prd phase + junk must NOT route detached.
    assert.equal(tierExceedsBashCeiling(state, sessionDir, 'mdefault'), false, 'default-tier (no field) → in-process (revert root cause)');
    assert.equal(tierExceedsBashCeiling(state, sessionDir, null), false, 'prd/no-ticket phase → in-process (revert root cause)');
    assert.equal(tierExceedsBashCeiling(state, sessionDir, 'mjunk000'), false, 'invalid tier → rejected, not normalized to medium');

    // Fail-open on a missing ticket file.
    assert.equal(tierExceedsBashCeiling(state, sessionDir, 'nonexist'), false, 'missing ticket file → fail-open false');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
