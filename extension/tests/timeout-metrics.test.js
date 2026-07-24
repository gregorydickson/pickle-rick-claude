// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_SRC = path.resolve(__dirname, '../src/bin/mux-runner.ts');
const MUX_BIN = path.resolve(__dirname, '../bin/mux-runner.js');

const { buildTmuxNotification } = await import(MUX_BIN);

test('union-has-timeout_repeat: source contains timeout_repeat in exitReason union', () => {
  const src = fs.readFileSync(MUX_SRC, 'utf-8');
  assert.ok(src.includes("'timeout_repeat'"), "exitReason union missing 'timeout_repeat'");
});

test('is-failed-exit: buildTmuxNotification classifies timeout_repeat as failure', () => {
  const result = buildTmuxNotification('timeout_repeat', 'implement', 3, 600);
  assert.equal(result.title, '🥒 Pickle Run Failed');
});

test('metrics-classification: timeout_repeat session not counted as success', () => {
  const result = buildTmuxNotification('timeout_repeat', 'implement', 3, 600);
  assert.notEqual(result.title, '🥒 Pickle Run Complete');
});

test('all-sites: every failure-bucket exitReason === site handles timeout_repeat', () => {
  const src = fs.readFileSync(MUX_SRC, 'utf-8');
  const lines = src.split('\n');
  const unhandled = [];
  lines.forEach((line, i) => {
    if (!line.includes('exitReason ===')) return;
    // exitReason === 'success' at :1228 is a subtitle fallthrough — not a failure-bucket site
    if (line.includes("exitReason === 'success'") && !line.includes('||')) return;
    // R-ICP-1: 'iteration_cap_exhausted' is an exit-code mapping (→ 3), not a failure-bucket
    // notification site — it gets the standard failed-exit notification via isFailedExit.
    if (line.includes("exitReason === 'iteration_cap_exhausted'")) return;
    // B-GTRUTH WS-A2: 'done_without_commit_evidence' is the SECOND member of that same
    // exit-code mapping (→ 3, the PhaseIncomplete route) — likewise not a failure-bucket
    // notification site. Its notification comes from deriveCompletionVerdict, which reads
    // isFailureExit; the union-wide panel/notification parity loop in
    // mux-runner-done-without-commit-evidence-exit.test.js is what covers it.
    if (line.includes("exitReason === 'done_without_commit_evidence'")) return;
    if (!line.includes("'timeout_repeat'")) {
      unhandled.push({ line: i + 1, content: line.trim() });
    }
  });
  assert.deepEqual(unhandled, [], `Unhandled exitReason === sites:\n${JSON.stringify(unhandled, null, 2)}`);
});

test('remediation-code: source emits structured stderr with remediation_code=RAISE_TIMEOUT', () => {
  const src = fs.readFileSync(MUX_SRC, 'utf-8');
  assert.ok(src.includes("'remediation_code'") || src.includes('"remediation_code"') || src.includes('remediation_code:'),
    'source must reference remediation_code key in halt stderr payload');
  assert.ok(src.includes("'RAISE_TIMEOUT'") || src.includes('"RAISE_TIMEOUT"'),
    "source must include literal 'RAISE_TIMEOUT' for operator remediation");
});

test('remediation-code: exit_reason payload marker present', () => {
  const src = fs.readFileSync(MUX_SRC, 'utf-8');
  assert.ok(src.includes("exit_reason:") || src.includes("'exit_reason'") || src.includes('"exit_reason"'),
    'halt stderr JSON must include exit_reason field');
});
