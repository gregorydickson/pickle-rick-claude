// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const muxRunnerSource = fs.readFileSync(path.resolve(__dirname, '../../src/bin/mux-runner.ts'), 'utf-8');

test('closer-handoff-terminal source: failed-handoff terminal detection is keyed by ticket id, head sha, and consecutive budget', () => {
  assert.match(muxRunnerSource, /type CloserTerminalDecision/);
  assert.match(muxRunnerSource, /status !== 'failed'/);
  assert.match(muxRunnerSource, /prior\.ticket_id === ticketId && prior\.head_sha === headSha/);
  assert.match(muxRunnerSource, /consecutive_failed_iterations:\s*consecutive/);
  assert.match(muxRunnerSource, /if \(consecutive >= args\.failedBudget\)/);
  assert.match(muxRunnerSource, /reason:\s*'closer_handoff_terminal'/);
});

// TIER-1.2 gh-11: manager_handoff_pending no longer halts. A Done ticket whose
// latest conformance artifact carries a substantive Manager Handoff section is
// parked and flagged (residual logged) — never routed through the exit-action
// arm of CloserTerminalDecision.
test('closer-handoff-terminal source: done-plus-manager-handoff is parked and flagged, never an exit action', () => {
  assert.match(muxRunnerSource, /readLatestTicketConformanceSnapshot/);
  // The Manager Handoff detector was extracted into hasSubstantiveManagerHandoff()
  // — it carries the `^## Manager Handoff` regex and additionally rejects
  // "none"/"n/a"/empty bodies (F2 hardening). The conformance snapshot delegates
  // to it rather than matching an inline regex.
  assert.match(muxRunnerSource, /function hasSubstantiveManagerHandoff\(/);
  assert.match(muxRunnerSource, /\/\^##\\s\+Manager Handoff\\b/);
  assert.match(muxRunnerSource, /hasManagerHandoff:\s*hasSubstantiveManagerHandoff\(content\)/);
  assert.match(muxRunnerSource, /status === 'done' && conformance\.hasManagerHandoff/);
  assert.match(muxRunnerSource, /emitManagerHandoffResidual\(ticketId,\s*conformance\.file\)/);

  // AC-1: the reason must not be reachable as a `CloserTerminalDecision` exit action —
  // it survives only as the residual payload's `reason` value.
  const isHaltExitLine = muxRunnerSource.match(/const isHaltExit = \(r: ExitReason\).*$/m)[0];
  assert.doesNotMatch(isHaltExitLine, /manager_handoff_pending/);
  const closerTerminalDecisionType = muxRunnerSource.match(/type CloserTerminalDecision =[\s\S]*?;/)[0];
  assert.doesNotMatch(closerTerminalDecisionType, /manager_handoff_pending/);
});

test('closer-handoff-terminal source: mux-runner checks closer terminal state at the iteration head and both completion exits', () => {
  // Command-Query Separation: the decision QUERY has exactly one call site and it
  // consumes the `CloserTerminalDecision`. The two completion-path sites used to
  // invoke the same query purely for its park-and-flag side effect and discard the
  // return — while eagerly spending `observeCurrentHead` (two git subprocesses) and
  // `readCloserHandoffBudget` (a settings read) to populate arguments that only the
  // 'failed' arm reads, an arm those sites' own comments state is unreachable there.
  // These two assertions together forbid that shape returning: one call site, and
  // that site binds the result.
  const occurrences = [...muxRunnerSource.matchAll(/evaluateCloserTerminalState\(\{/g)].length;
  assert.equal(occurrences, 1, 'expected the single decision-consuming iteration-head call site');
  assert.match(muxRunnerSource, /const closerDecision = evaluateCloserTerminalState\(\{/);
  // The completion paths reach the residual through the COMMAND instead. Anchored at
  // statement position so neither the definition (`function flag...`) nor the query's
  // own `const status = flag...` binding is counted — only bare side-effect calls.
  const residualCommandCalls =
    [...muxRunnerSource.matchAll(/^[ \t]*flagManagerHandoffResidual\(/gm)].length;
  assert.equal(residualCommandCalls, 2, 'expected both completion paths to park-and-flag via the command');
  assert.match(muxRunnerSource, /function flagManagerHandoffResidual\(/);
  assert.match(muxRunnerSource, /persistCloserHandoffTracker\(statePath,\s*closerDecision\.tracker\)/);
  // TIER-1.2 gh-11: only the main-loop iteration-head site still routes a closer
  // terminal decision to a halt (closer_handoff_terminal survives).
  const exitForCloserTerminalStateOccurrences =
    [...muxRunnerSource.matchAll(/exitForCloserTerminalState\(/g)].length;
  assert.equal(exitForCloserTerminalStateOccurrences, 2, 'expected the definition plus exactly one call site');
  assert.match(muxRunnerSource, /exitReason = exitForCloserTerminalState\(statePath,\s*sessionDir,\s*iteration,\s*closerDecision,\s*log\)/);
});
