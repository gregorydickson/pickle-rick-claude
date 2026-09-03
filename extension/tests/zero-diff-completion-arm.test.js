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

import ts from 'typescript';

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

/**
 * The file's code with every comment blanked out — by the LANGUAGE's parser, and
 * without moving a single character. A comment's bytes become spaces (newlines
 * kept), so an index taken from this text addresses the same byte in the file
 * and a `file:line` report stays true.
 *
 * This replaces three hand-rolled `replace(...)` strippers that shared one
 * regex pair and were blind in BOTH directions, each measured live against this
 * file's own pins. A `//` inside a string erased the rest of that line: a
 * planted `zero_diff_intent` producer behind `const u = 'https://example.com';`
 * read 22/22 GREEN where the bare producer read 21/22 RED. A comment OPENER
 * inside a string, template or regex literal opened a comment that ran to the
 * next closer — 1,133 code lines across 23 `src/` files, 743 of them in
 * services/dot-builder.ts, whose line 90 hid the same producer at 22/22 GREEN.
 * Both holes also hid a git-subprocess call from the no-git-write pin below.
 *
 * A comment is trivia, so keeping exactly the token spans and blanking
 * everything else needs no enumeration of the lexical contexts a comment marker
 * can hide inside. JSDoc is the one comment the parser hands back as a node
 * rather than as trivia, so it is skipped explicitly.
 *
 * NOTE: a fourth parser-based reader under tests/ (see
 * tests/fixture-lifetime-and-registry.test.js, tests/tsc-gate.test.js,
 * tests/worker-gate-offrepo-runs.test.js). Those return concatenated token text;
 * this one must preserve positions, so it is not the same function. A shared
 * test helper is still the right home — see AP-EXT-ITER174-01.
 */
function codeMask(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const isJsDoc = (node) => node.kind >= ts.SyntaxKind.FirstJSDocNode
    && node.kind <= ts.SyntaxKind.LastJSDocNode;
  // Indexed by UTF-16 code UNIT, which is what `getStart`/`getEnd` count. `Array.from`
  // walks code POINTS, so one astral character (20 src files carry them) would shorten
  // this array and silently shift every span after it.
  const out = new Array(source.length);
  for (let i = 0; i < source.length; i += 1) out[i] = source[i] === '\n' ? '\n' : ' ';

  const keep = (node) => {
    if (isJsDoc(node)) return;
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      for (let i = node.getStart(sourceFile); i < node.getEnd(); i += 1) out[i] = source[i];
      return;
    }
    children.forEach(keep);
  };
  keep(sourceFile);

  return out.join('');
}

test('AC-GTRUTH-A1-5: guardCompletionCommitBeforeDone stays policy-free (shape mapping only)', () => {
  const code = codeMask(fs.readFileSync(MUX_TS, 'utf8'), MUX_TS);
  const start = code.indexOf('export function guardCompletionCommitBeforeDone(');
  assert.ok(start > 0, 'guardCompletionCommitBeforeDone must be present');
  const end = code.indexOf('\nexport function hasSubstantiveManagerHandoff', start);
  assert.ok(end > start, 'could not delimit the guard body');
  const body = code.slice(start, end);

  assert.ok(
    !/zero[_-]?[Dd]iff/.test(body),
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

// ---------------------------------------------------------------------------
// F9 — the arm has no production producer, and that is load-bearing
// ---------------------------------------------------------------------------

/** Every `.ts` under src/, so a producer cannot hide in a file this list forgot. */
function collectSourceTs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceTs(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

test('F9: `zero_diff_intent` is READ-ONLY in production — a producer must bring an authorship constraint', () => {
  const SRC_ROOT = path.join(import.meta.dirname, '..', 'src');
  const sanctionedRead = /readFrontmatterField\([^,]+,\s*'zero_diff_intent'\)/;

  const unsanctioned = [];
  for (const file of collectSourceTs(SRC_ROOT)) {
    const lines = codeMask(fs.readFileSync(file, 'utf8'), file).split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('zero_diff_intent')) return;
      if (sanctionedRead.test(line)) return;
      unsanctioned.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    unsanctioned,
    [],
    'The zero-diff arm accepts a ticket as complete with NO commit. Today nothing in '
    + 'production ever WRITES `zero_diff_intent` — the declaration can only arrive from a '
    + 'human or a refinement-time author, which is what makes the arm safe. Both of its '
    + 'corroborating conditions are worker-producible: a worker writes its own lifecycle '
    + 'artifacts, and a worker runs its own gate. So a producer that lets the WORKER author '
    + 'the declaration closes the loop and a worker can self-authorize a commit-less Done — '
    + 'the exact self-certification this bundle removed from the commit-count proxy.\n\n'
    + 'This test cannot verify an authorship constraint mechanically; it can only notice a '
    + 'producer appearing. If you are adding one deliberately: state who may author the '
    + 'declaration and how that is enforced, add a test for it, then extend the sanctioned '
    + 'set here. Do not simply delete this assertion.\n\n'
    + `Unsanctioned occurrences:\n${unsanctioned.join('\n')}`,
  );
});

test('F9: the sanctioned read is still present — this pin fails closed', () => {
  const mux = fs.readFileSync(MUX_TS, 'utf8');
  assert.match(
    mux,
    /readFrontmatterField\([^,]+,\s*'zero_diff_intent'\)/,
    'the read that feeds the arm must exist. If it is gone the arm is unreachable, and the '
    + 'producer-absence test above would pass vacuously over a feature that no longer exists.',
  );
});

/**
 * The reader itself, pinned. Every row below is one mutation measured by hand
 * against the three pins above on the real tree; writing them down is what keeps
 * the repair proved. Regress `codeMask` in either direction and this reds:
 * under-blanking lets prose answer a pin, over-blanking hides code from it.
 */
test('AP-EXT-ITER176-01: codeMask blanks comments by grammar, and moves nothing', () => {
  const CLOSER = `*${'/'}`;
  const cases = [
    {
      name: 'a `//` inside a string opens no comment',
      source: `const u = 'https://example.com'; const p = { zero_diff_intent: 'reused' };`,
      visible: ['zero_diff_intent', 'https'],
      blanked: [],
    },
    {
      name: 'a comment OPENER inside a string opens no comment',
      source: `const g = ':!dir/**';\nconst p = { zero_diff_intent: 'reused' };\nconst h = 'tail${CLOSER}';`,
      visible: ['zero_diff_intent'],
      blanked: [],
    },
    {
      name: 'a comment OPENER inside a regex literal opens no comment',
      source: `const re = /[\\w./*-]+/;\npersistEvidence(ctx);\nconst h = 'tail${CLOSER}';`,
      visible: ['persistEvidence'],
      blanked: [],
    },
    {
      name: 'an astral character does not shift the spans after it',
      source: `const e = '\u{1F952}'; // prose\nconst p = { zero_diff_intent: 'reused' };\n`,
      visible: ['zero_diff_intent'],
      blanked: ['prose'],
    },
    {
      name: 'a trailing line comment is still blanked',
      source: `const p = 1; // zero_diff_intent is only ever read\n`,
      visible: ['const p = 1;'],
      blanked: ['zero_diff_intent'],
    },
    {
      name: 'a block comment is still blanked',
      source: `/* zero_diff_intent ${CLOSER}\nconst p = 1;\n`,
      visible: ['const p = 1;'],
      blanked: ['zero_diff_intent'],
    },
    {
      name: 'a JSDoc block is still blanked — the parser hands it back as a node',
      source: `/** never persistEvidence( a commit into being ${CLOSER}\nexport function f() { return 1; }\n`,
      visible: ['export function f()'],
      blanked: ['persistEvidence'],
    },
  ];

  for (const { name, source, visible, blanked } of cases) {
    const masked = codeMask(source, 'probe.ts');

    assert.equal(masked.length, source.length,
      `${name}: codeMask must not move a character — every pin above takes an index from `
      + 'this text and addresses the file with it');
    assert.equal(masked.split('\n').length, source.split('\n').length,
      `${name}: line count must survive, or the F9 pin reports the wrong file:line`);

    for (const token of visible) {
      assert.ok(masked.includes(token),
        `${name}: \`${token}\` is CODE and must survive — blanking it makes every pin above `
        + 'pass for the worst possible reason');
    }
    for (const token of blanked) {
      assert.ok(!masked.includes(token),
        `${name}: \`${token}\` is a COMMENT and must be blanked — prose must never answer a pin`);
    }
  }
});

test('AC-GTRUTH-A1-4: the zero-diff path performs no git write', () => {
  // Read the code, not the prose: the surrounding documentation legitimately discusses
  // commits ("attributably committed", "no business carrying a stamp"), and matching that
  // would make this assertion fire on documentation rather than on code.
  const code = codeMask(fs.readFileSync(ORACLE_TS, 'utf8'), ORACLE_TS);
  const start = code.indexOf('function zeroDiffAccept(');
  assert.ok(start > 0, 'zeroDiffAccept must be present');
  const end = code.indexOf('\nexport function evaluateCompletionEvidence', start);
  assert.ok(end > start, 'could not delimit zeroDiffAccept');
  const body = code.slice(start, end);

  for (const forbidden of ['execFileSync(', 'spawnSync(', 'writeFileSync(', 'persistEvidence(']) {
    assert.ok(
      !body.includes(forbidden),
      `zeroDiffAccept must not call ${forbidden} — no commit may be manufactured and nothing `
      + 'written to represent a zero-diff completion; an empty marker commit is the forgery this '
      + 'arm exists to avoid (AC-GTRUTH-A1-4)',
    );
  }
});
