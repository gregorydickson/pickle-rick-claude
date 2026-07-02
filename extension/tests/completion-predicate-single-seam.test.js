// @tier: fast
// B-1SEAM WS-1 completion-predicate single-seam call-site-count audit.
//
// Pins the collapse of the divergent completion-decision policy shapes onto the
// ONE predicate `evaluateCompletionEvidence` in ticket-completion-evidence.ts.
// Shape copied from completion-authority-single-source.test.js (AC-D4); the
// B-1SEAM grep block in scripts/audit-trap-door-enforcement.sh mirrors these pins.
//
// Five pins:
//   1. `readEvidence(<arg>)` callsites OUTSIDE ticket-completion-evidence.ts == 0
//      — every decision site routes through the predicate (or its adapters).
//      The guard's refusal reason string mentions the zero-arg prose form
//      `readEvidence().kind` — prose, not a callsite — deliberately spared.
//   2. `evaluateCompletionEvidence(` callsites: exactly MUX_PREDICATE_CALLSITES
//      in mux-runner.ts (enumerated below) + exactly 1 in
//      auto-fill-completion-commit.ts. A new consumer is a deliberate pin bump.
//   3. importer files of ticket-completion-evidence == exactly
//      {mux-runner.ts, auto-fill-completion-commit.ts} (R-AFCC-CALLER-ENUMERATION).
//   4. defaultDoneGuard body contains `evaluateCompletionEvidence(` and does NOT
//      contain a bare `.length > 0` field-presence accept (the live
//      accept-here-revert-there split, session 2026-07-01-9e922602).
//   5. guardCompletionCommitBeforeDone body contains `evaluateCompletionEvidence(`
//      — the predicate lives UNDER the guard, not beside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const srcRoot = path.join(repoRoot, 'extension', 'src');
const muxRunnerPath = path.join(srcRoot, 'bin', 'mux-runner.ts');
const autoFillPath = path.join(srcRoot, 'bin', 'auto-fill-completion-commit.ts');

const ORACLE_BASENAME = 'ticket-completion-evidence.ts';

// Pin-2 enumerated mux-runner.ts consumers (all built via buildCompletionCtx):
//   1. collectTwinEvidence            — R-PDUP twin attribution ('attribution')
//   2. validateAutoTicketCompletion   — manager-drift validation ('attribution')
//   3. isTicketOracleCommitted        — salvage/no-progress probe ('attribution')
//   4. guardCompletionCommitBeforeDone — the Done-flip gate ('done-flip')
//   5. attributeBoundaryHeadMoved     — boundary attribution ('attribution')
//   6. defaultDoneGuard               — charge-loop keep-decision ('phantom-watch')
const MUX_PREDICATE_CALLSITES = 6;

// A readEvidence CALLSITE passes an argument: `readEvidence({`, `readEvidence(ctx)`.
// The zero-arg prose form `readEvidence().kind` (guard refusal reason string) is
// NOT a callsite — `[^)\s]` after the paren excludes it. `\s*` spans newlines on
// joined text, so a line-wrapped callsite cannot dodge the pin.
const READ_EVIDENCE_CALLSITE_RE = /\breadEvidence\(\s*[^)\s]/;

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

/** Drop comment lines so documented mentions can't trip (or hide) a pin. */
function nonCommentText(content) {
  return content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

/**
 * Slice a top-level function from `signature` to its column-0 closing brace.
 * Brace-matching is defeated by `{}` in parameter type literals (the guard's
 * `args: {...}`), so the `\n}\n` terminator — standard formatting for every
 * top-level function in mux-runner.ts — is the robust cut. The bare `\n}`
 * form is NOT enough: a multi-line params type closes with a column-0 `})`,
 * which would truncate the slice at the signature.
 */
function extractTopLevelFunction(content, signature) {
  const start = content.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found in mux-runner.ts`);
  const end = content.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `no column-0 closing brace after ${signature}`);
  return content.slice(start, end + 3);
}

const muxRunnerContent = fs.readFileSync(muxRunnerPath, 'utf8');
const autoFillContent = fs.readFileSync(autoFillPath, 'utf8');

test('PIN 1: zero readEvidence(<arg>) callsites outside ticket-completion-evidence.ts', () => {
  const violations = [];
  for (const filePath of walkTs(srcRoot)) {
    if (path.basename(filePath) === ORACLE_BASENAME) continue;
    const body = nonCommentText(fs.readFileSync(filePath, 'utf8'));
    if (READ_EVIDENCE_CALLSITE_RE.test(body)) {
      violations.push(path.relative(srcRoot, filePath));
    }
  }
  assert.deepEqual(
    violations,
    [],
    'readEvidence( callsite(s) outside the oracle — a decision site bypassed ' +
      `evaluateCompletionEvidence (B-1SEAM single-seam regression): ${violations.join(', ')}`,
  );
});

test('PIN 2: evaluateCompletionEvidence( callsite counts are exact (mux-runner + auto-fill)', () => {
  const muxCount = (nonCommentText(muxRunnerContent).match(/evaluateCompletionEvidence\(/g) || []).length;
  const autoFillCount = (nonCommentText(autoFillContent).match(/evaluateCompletionEvidence\(/g) || []).length;

  assert.equal(
    muxCount,
    MUX_PREDICATE_CALLSITES,
    `evaluateCompletionEvidence( callsites in mux-runner.ts = ${muxCount}, expected exactly ` +
      `${MUX_PREDICATE_CALLSITES}. A dropped site is a policy-shape re-split; a new site is a ` +
      'deliberate pin bump (update the enumeration comment too).',
  );
  assert.equal(
    autoFillCount,
    1,
    `evaluateCompletionEvidence( callsites in auto-fill-completion-commit.ts = ${autoFillCount}, ` +
      'expected exactly 1 (the R-AFCC-DEEP-4A evidence read routed through the predicate).',
  );
});

test('PIN 3: ticket-completion-evidence importer files are exactly {mux-runner.ts, auto-fill-completion-commit.ts}', () => {
  const importers = walkTs(srcRoot)
    .filter((f) => path.basename(f) !== ORACLE_BASENAME)
    .filter((f) => fs.readFileSync(f, 'utf8').includes('ticket-completion-evidence'))
    .map((f) => path.basename(f))
    .sort();
  assert.deepEqual(
    importers,
    ['auto-fill-completion-commit.ts', 'mux-runner.ts'],
    'ticket-completion-evidence importer set drifted from the R-AFCC-CALLER-ENUMERATION pin — ' +
      'a new caller requires a deliberate pin update here AND in audit-trap-door-enforcement.sh.',
  );
});

test('PIN 4: defaultDoneGuard routes through the predicate with no bare field-presence accept', () => {
  const body = extractTopLevelFunction(muxRunnerContent, 'function defaultDoneGuard(');
  assert.ok(
    body.includes('evaluateCompletionEvidence('),
    'defaultDoneGuard no longer calls evaluateCompletionEvidence — the charge-loop keep-decision ' +
      'diverged from the watcher (accept-here-revert-there split).',
  );
  assert.ok(
    !/\.length\s*>\s*0/.test(body),
    'defaultDoneGuard contains a bare `.length > 0` field-presence accept — the pre-B-1SEAM shape ' +
      'that accepted a hallucinated completion_commit stamp without a git probe.',
  );
});

test('PIN 5: guardCompletionCommitBeforeDone body routes through the predicate', () => {
  const body = extractTopLevelFunction(muxRunnerContent, 'export function guardCompletionCommitBeforeDone(');
  assert.ok(
    body.includes('evaluateCompletionEvidence('),
    'guardCompletionCommitBeforeDone no longer calls evaluateCompletionEvidence — the predicate ' +
      'must live UNDER the guard (B-1SEAM WS-1), not as a re-inlined per-site ladder.',
  );
});

test('FAIL-INJECTION: the readEvidence callsite regex catches real calls and spares the prose form', () => {
  assert.ok(READ_EVIDENCE_CALLSITE_RE.test('const e = readEvidence({ sessionDir, ticketId });'));
  assert.ok(READ_EVIDENCE_CALLSITE_RE.test('const e = readEvidence(ctx);'));
  assert.ok(READ_EVIDENCE_CALLSITE_RE.test('readEvidence(\n  probe,\n)'), 'line-wrapped callsite must match');
  assert.ok(
    !READ_EVIDENCE_CALLSITE_RE.test("reason: `... readEvidence().kind === 'absent' (expected 'committed') ...`"),
    'zero-arg prose mention in the guard refusal string must NOT count as a callsite',
  );
});
