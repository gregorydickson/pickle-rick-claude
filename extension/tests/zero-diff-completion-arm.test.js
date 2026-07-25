// @tier: fast
//
// B-GTRUTH WS-A1 — the zero-diff completion arm.
//
// Before this bundle, `CompletionDecision`'s success arm carried a non-nullable
// `sha: string`, so a ticket that CORRECTLY produced no diff (verification work, an
// audit, a requirement already satisfied by shipped code) was structurally
// unrepresentable as complete. The only ways out were both forgeries: fabricate a
// sentinel SHA, or manufacture an empty marker commit. The oracle is widened
// instead.
//
// Red-first: every accept case below fails on pre-fix source with a TypeScript-level
// impossibility (no arm returns ok without a sha) and, at runtime, with
// `ok === false`.
//
// The negative cases are the load-bearing half. A declaration is an ASSERTION, and
// this arm only honors it when the assertion is corroborated: the intent is one of
// the three recognized values, the tier's lifecycle artifacts are on disk, and (on a
// Done-flip) the worker gate is GREEN. Drop any one condition and the arm becomes
// "any ticket may declare itself done", which is the failure this bundle removes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateCompletionEvidence,
  gateForPhantomDoneRevert,
} from '../services/ticket-completion-evidence.js';

const TICKET_ID = 'zd111111';

/** The medium-tier lifecycle artifact set (TIER_LIFECYCLE-derived). */
const MEDIUM_TIER_ARTIFACTS = [
  'research_2026-07-24.md',
  'research_review.md',
  'plan_2026-07-24.md',
  'plan_review.md',
  'conformance_2026-07-24.md',
  'code_review_2026-07-24.md',
];

function mkTmp(prefix = 'pickle-zd-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

/**
 * Writes a ticket that produced NO commit: frontmatter declares an intent + tier,
 * and the artifacts listed in `artifacts` exist in the ticket dir.
 */
function writeZeroDiffTicket(sessionDir, {
  intent = 'verification',
  tier = 'medium',
  artifacts = MEDIUM_TIER_ARTIFACTS,
  extraFrontmatter = '',
} = {}) {
  const ticketDir = path.join(sessionDir, TICKET_ID);
  fs.mkdirSync(ticketDir, { recursive: true });
  const intentLine = intent === null ? '' : `zero_diff_intent: ${intent}\n`;
  const tierLine = tier === null ? '' : `complexity_tier: ${tier}\n`;
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${TICKET_ID}.md`),
    `---\nid: ${TICKET_ID}\ntitle: zero-diff fixture\nstatus: In Progress\norder: 1\n`
      + `${tierLine}${intentLine}${extraFrontmatter}---\n\n# Fixture\n`,
  );
  for (const name of artifacts) {
    fs.writeFileSync(path.join(ticketDir, name), 'artifact\n');
  }
  return ticketDir;
}

function ctxFor(sessionDir, workingDir, decision, overrides = {}) {
  return {
    sessionDir,
    ticketId: TICKET_ID,
    workingDir,
    startCommit: null,
    pinnedSha: null,
    decision,
    rereadBackoffMs: 0,
    workerGateVerdict: () => ({ verdict: 'green', computedVia: 'fixture' }),
    zeroDiffIntent: () => {
      const raw = fs.readFileSync(
        path.join(sessionDir, TICKET_ID, `rick_ticket_${TICKET_ID}.md`), 'utf8',
      );
      const m = /^zero_diff_intent:\s*(.+)$/m.exec(raw);
      return m ? m[1].trim() : null;
    },
    ...overrides,
  };
}

function withFixture(fn, ticketOpts) {
  const repo = mkTmp('pickle-zd-repo-');
  const sessionDir = mkTmp('pickle-zd-session-');
  try {
    initGitRepo(repo);
    writeZeroDiffTicket(sessionDir, ticketOpts);
    return fn({ repo, sessionDir });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// AC-GTRUTH-A1-1 — the accept
// ---------------------------------------------------------------------------

for (const intent of ['verification', 'audit', 'already-satisfied']) {
  test(`AC-GTRUTH-A1-1: declared zero_diff_intent='${intent}' + artifacts + green gate → ok with NO sha`, () => {
    withFixture(({ repo, sessionDir }) => {
      const decision = evaluateCompletionEvidence(ctxFor(sessionDir, repo, 'done-flip'));

      assert.equal(decision.ok, true,
        `a declared zero-diff ticket must be representable as complete — got ok=${decision.ok}`
        + ` reason=${decision.reason ?? 'n/a'}`);
      assert.equal(decision.sha, undefined,
        'the zero-diff accept must carry NO sha — a value here is a fabricated sentinel (AC-GTRUTH-A1-3)');
      assert.equal(decision.via, 'zero-diff');
      assert.equal(decision.zeroDiffIntent, intent,
        'the accepted intent must be reported back so callers can log WHY there is no commit');
    }, { intent });
  });
}

test('AC-GTRUTH-A1-1: the arm is case/whitespace tolerant on the declared value', () => {
  withFixture(({ repo, sessionDir }) => {
    const decision = evaluateCompletionEvidence(ctxFor(sessionDir, repo, 'done-flip'));
    assert.equal(decision.ok, true);
    assert.equal(decision.zeroDiffIntent, 'audit');
  }, { intent: '  AUDIT  ' });
});

// ---------------------------------------------------------------------------
// AC-GTRUTH-A1-2 — the undeclared refusal (AC-MWMO-D2-8 survives)
// ---------------------------------------------------------------------------

test('AC-GTRUTH-A1-2: NO declaration + no sha still refuses (refuseAbsent)', () => {
  withFixture(({ repo, sessionDir }) => {
    const decision = evaluateCompletionEvidence(ctxFor(sessionDir, repo, 'done-flip'));
    assert.equal(decision.ok, false,
      'an undeclared ticket with no commit must STILL be refused — this is the AC-MWMO-D2-8 '
      + 'guarantee the widening must not erode');
    assert.equal(decision.reason, 'no_evidence');
  }, { intent: null });
});

test('AC-GTRUTH-A1-2: an un-injected zeroDiffIntent resolver refuses (fail-closed)', () => {
  withFixture(({ repo, sessionDir }) => {
    const decision = evaluateCompletionEvidence(
      ctxFor(sessionDir, repo, 'done-flip', { zeroDiffIntent: undefined }),
    );
    assert.equal(decision.ok, false,
      'an absent resolver must read as "no declaration", never as an implicit one — same '
      + 'fail-closed posture as workerGateVerdict');
  });
});

test('AC-GTRUTH-A1-2: a throwing zeroDiffIntent resolver refuses', () => {
  withFixture(({ repo, sessionDir }) => {
    const decision = evaluateCompletionEvidence(
      ctxFor(sessionDir, repo, 'done-flip', {
        zeroDiffIntent: () => { throw new Error('unreadable'); },
      }),
    );
    assert.equal(decision.ok, false);
  });
});

// ---------------------------------------------------------------------------
// The corroboration conditions — each one alone must be able to refuse
// ---------------------------------------------------------------------------

test('an unrecognized zero_diff_intent value refuses (the enum is closed)', () => {
  withFixture(({ repo, sessionDir }) => {
    const decision = evaluateCompletionEvidence(ctxFor(sessionDir, repo, 'done-flip'));
    assert.equal(decision.ok, false,
      'only {verification, audit, already-satisfied} are recognized — an arbitrary string '
      + 'would make the field a free-form self-certification');
  }, { intent: 'because-i-said-so' });
});

test('a MISSING lifecycle artifact refuses — the declaration alone is not evidence', () => {
  withFixture(({ repo, sessionDir }) => {
    const decision = evaluateCompletionEvidence(ctxFor(sessionDir, repo, 'done-flip'));
    assert.equal(decision.ok, false,
      'dropping one required prefix (conformance) must refuse: without the artifact check a '
      + 'worker could declare zero-diff having done nothing at all');
  }, { artifacts: MEDIUM_TIER_ARTIFACTS.filter((f) => !f.startsWith('conformance')) });
});

test('an ABSENT complexity_tier refuses rather than defaulting to a tier', () => {
  withFixture(({ repo, sessionDir }) => {
    const decision = evaluateCompletionEvidence(ctxFor(sessionDir, repo, 'done-flip'));
    assert.equal(decision.ok, false,
      'normalizeTicketComplexityTier would silently default an absent tier to medium; '
      + 'inventing a tier for a ticket that never declared one is the proxy this bundle removes');
  }, { tier: null });
});

test('trivial tier: the required prefix set follows TIER_LIFECYCLE, not a hardcoded list', () => {
  withFixture(({ repo, sessionDir }) => {
    const decision = evaluateCompletionEvidence(ctxFor(sessionDir, repo, 'done-flip'));
    assert.equal(decision.ok, true,
      'a trivial-tier ticket needs only its own lifecycle artifacts (code_review) — holding it '
      + "to medium's 6 prefixes would make the arm unreachable for short tiers");
  }, { tier: 'trivial', artifacts: ['code_review_2026-07-24.md'] });
});

test('AC-GTRUTH-A1-1: a RED worker gate refuses the zero-diff Done-flip (R-CWGE holds)', () => {
  withFixture(({ repo, sessionDir }) => {
    const decision = evaluateCompletionEvidence(ctxFor(sessionDir, repo, 'done-flip', {
      workerGateVerdict: () => ({ verdict: 'red', computedVia: 'fixture' }),
    }));
    assert.equal(decision.ok, false,
      'a zero-diff declaration must not become a bypass around the worker gate');
    assert.equal(decision.reason, 'worker_gate_red');
  });
});

test('AC-GTRUTH-A1-1: an ABSENT/un-injected worker gate refuses the zero-diff Done-flip', () => {
  withFixture(({ repo, sessionDir }) => {
    const decision = evaluateCompletionEvidence(ctxFor(sessionDir, repo, 'done-flip', {
      workerGateVerdict: undefined,
    }));
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'worker_gate_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Decision-kind reach
// ---------------------------------------------------------------------------

test('roster honesty: decision=attribution REFUSES a fully-declared zero-diff ticket', () => {
  withFixture(({ repo, sessionDir }) => {
    const decision = evaluateCompletionEvidence(ctxFor(sessionDir, repo, 'attribution'));
    assert.equal(decision.ok, false,
      'isTicketOracleCommitted (decision=attribution) feeds reportPhaseIncomplete\'s unfinished '
      + 'roster. Admitting a declaration there would let a frontmatter field HIDE a '
      + 'genuinely-unfinished ticket from the operator — relocating the bug instead of removing it. '
      + 'This refusal is also what makes the CompletionAttributionDecision overload sound.');
  });
});

test('the arm is not inert: decision=phantom-watch KEEPS a declared zero-diff Done', () => {
  withFixture(({ repo, sessionDir }) => {
    const kept = gateForPhantomDoneRevert(ctxFor(sessionDir, repo, 'phantom-watch'));
    assert.equal(kept.action, 'keep',
      'a zero-diff Done carries no completion_commit, so a done-flip-ONLY arm would be reverted '
      + 'by the phantom-Done watcher on the next sweep — the feature would flip Done and lose it '
      + 'seconds later. This assertion is the difference between shipping the arm and shipping '
      + 'nothing.');
  });
});

test('phantom-watch keep does NOT extend to an undeclared absent-evidence Done', () => {
  withFixture(({ repo, sessionDir }) => {
    const decided = gateForPhantomDoneRevert(ctxFor(sessionDir, repo, 'phantom-watch'));
    assert.equal(decided.action, 'revert',
      'the phantom-Done watcher must still revert a Done ticket with no evidence and no '
      + 'declaration — otherwise the widening disarms the watcher wholesale');
  }, { intent: null });
});

// ---------------------------------------------------------------------------
// Hard-absent evidence is never laundered by a declaration
// ---------------------------------------------------------------------------

test('R-CXOR-2: a declaration does NOT launder a baseline-sha stamp', () => {
  const repo = mkTmp('pickle-zd-base-repo-');
  const sessionDir = mkTmp('pickle-zd-base-session-');
  try {
    const head = initGitRepo(repo);
    writeZeroDiffTicket(sessionDir, { extraFrontmatter: `completion_commit: ${head}\n` });

    const decision = evaluateCompletionEvidence(
      ctxFor(sessionDir, repo, 'done-flip', { startCommit: head, pinnedSha: head }),
    );

    assert.equal(decision.ok, false,
      'a stamp equal to the session baseline is the codex orphan-reset false-Done signature '
      + '(R-CXOR-2 hard-absent). A zero-diff ticket has no business carrying a stamp at all, so '
      + 'the declaration must not rescue a positively mis-attributed one');
    assert.equal(decision.reason, 'baseline_sha');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-GTRUTH-A1-3 / A1-5 — source-shape invariants
// ---------------------------------------------------------------------------

const ORACLE_TS = path.join(import.meta.dirname, '..', 'src', 'services', 'ticket-completion-evidence.ts');
const MUX_TS = path.join(import.meta.dirname, '..', 'src', 'bin', 'mux-runner.ts');

/**
 * AC-GTRUTH-A1-3 is stated over the BRANCH DIFF, so scanning only the oracle and
 * mux-runner would leave four of this bundle's six modified source files free to carry a
 * fabricated sentinel. This list is that six-file set.
 *
 * It is a hand-maintained FLOOR, not a derivation: deriving it from a live `git diff`
 * would make a fast-tier test depend on branch state and on which baseline it is diffed
 * against. The cost is that a SEVENTH file modified by a future bundle is not covered
 * until someone adds it here — so add it here.
 */
const BRANCH_MODIFIED_SRC = [
  ['services/ticket-completion-evidence.ts', []],
  // The one permitted literal in the whole set: the pre-existing PICKLE_TEST_MODE bypass.
  ['bin/mux-runner.ts', ['pickle-test-mode-bypass']],
  ['bin/pipeline-runner.ts', []],
  ['bin/setup.ts', []],
  ['bin/spawn-morty.ts', []],
  ['services/codegraph-service.ts', []],
];

test("AC-GTRUTH-A1-3: no sentinel sha literal beyond the pre-existing test-mode bypass", () => {
  for (const [relPath, expected] of BRANCH_MODIFIED_SRC) {
    const absPath = path.join(import.meta.dirname, '..', 'src', ...relPath.split('/'));

    // Fail CLOSED: a rename would otherwise silently empty this file's scan, and an
    // assertion over a file that does not exist passes for the worst possible reason.
    assert.ok(fs.existsSync(absPath), `${relPath} must exist — AC-GTRUTH-A1-3's scan cannot `
      + 'cover a file it cannot read, and a missing path here means this list went stale');

    // Both quote styles: single is the house style, but the AC forbids the VALUE, not a
    // particular spelling of it, and a double-quoted sentinel is the same forgery.
    const source = fs.readFileSync(absPath, 'utf8');
    const literals = [...source.matchAll(/sha:\s*(?:'([^']*)'|"([^"]*)")/g)]
      .map((m) => m[1] ?? m[2]);

    assert.deepEqual(
      literals,
      expected,
      `${relPath}: assigning a string literal to \`sha\` is the empty-marker-commit forgery `
      + 'moved into a string — the zero-diff arm exists precisely so no sentinel is needed. '
      + `Expected ${JSON.stringify(expected)}, found ${JSON.stringify(literals)}.`,
    );
  }
});

test('AC-GTRUTH-A1-5: guardCompletionCommitBeforeDone stays policy-free (shape mapping only)', () => {
  const mux = fs.readFileSync(MUX_TS, 'utf8');
  const start = mux.indexOf('export function guardCompletionCommitBeforeDone(');
  assert.ok(start > 0, 'guardCompletionCommitBeforeDone must be present');
  const end = mux.indexOf('\nexport function hasSubstantiveManagerHandoff', start);
  assert.ok(end > start, 'could not delimit the guard body');
  const body = mux.slice(start, end);

  assert.ok(
    !/zero[_-]?[Dd]iff/.test(body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')),
    'the guard must contain NO zero-diff decision logic (comments excluded) — the arm and all '
    + 'three of its conditions belong to evaluateCompletionEvidence. A branch here would re-split '
    + 'the single-seam policy the B-1SEAM trap door protects.',
  );
  assert.match(
    body,
    /sha:\s*decision\.sha\s*\?\?\s*null/,
    'the guard must map a sha-less accept mechanically (`decision.sha ?? null`), not interpret it',
  );
});

test('AC-GTRUTH-A1-4: the zero-diff path performs no git write', () => {
  const oracle = fs.readFileSync(ORACLE_TS, 'utf8');
  const start = oracle.indexOf('function zeroDiffAccept(');
  assert.ok(start > 0, 'zeroDiffAccept must be present');
  const end = oracle.indexOf('\nexport function evaluateCompletionEvidence', start);
  assert.ok(end > start, 'could not delimit zeroDiffAccept');
  // Strip comments first: the prose legitimately discusses commits ("attributably
  // committed", "no business carrying a stamp"), and matching that would make this
  // assertion fire on documentation rather than on code.
  const body = oracle.slice(start, end).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');

  for (const forbidden of ['execFileSync(', 'spawnSync(', 'writeFileSync(', 'persistEvidence(']) {
    assert.ok(
      !body.includes(forbidden),
      `zeroDiffAccept must not call ${forbidden} — no commit may be manufactured and nothing `
      + 'written to represent a zero-diff completion; an empty marker commit is the forgery this '
      + 'arm exists to avoid (AC-GTRUTH-A1-4)',
    );
  }
});
