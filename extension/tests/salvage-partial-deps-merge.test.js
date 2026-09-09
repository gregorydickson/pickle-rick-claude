// @tier: fast
//
// AP-EXT-ITER10-01 regression: `salvageTicket` MUST merge partial dep injection
// over its defaults, never replace them.
//
// `pickle-recover --reset-ticket` steers salvage into its archive-then-Todo
// branch by injecting ONLY `reconcile` + `gate`. Under the old replacement
// semantics every other dep was `undefined`, so the very first statement in the
// try block (`deps.ffReattach(input)`) threw, the best-effort catch swallowed it,
// and the transition returned `{disposition:'error'}` while archiving nothing
// and resetting nothing — yet `runRecover` still logged "Recovery transition
// complete" and exited 0. The sanctioned operator recovery surface reported
// success while orphaning the ticket and stranding its diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { salvageTicket } from '../lib/salvage-ticket.js';

/** The exact injection shape `pickle-recover.ts:resetTicketViaSalvage` uses. */
function resetTicketInjection(recorder) {
    return {
        reconcile: () => {
            recorder.push('reconcile');
            return {
                headSha: 'abc1234',
                dirty: true,
                dirtyPaths: ['extension/src/foo.ts'],
                ticketStatuses: { t1: 'In Progress' },
                tickets: [{ id: 't1', status: 'In Progress' }],
            };
        },
        gate: () => 'failing',
    };
}

test('AP-EXT-ITER10-01: a 2-key partial injection still reaches archive + resetTodo', () => {
    const recorder = [];
    // Supply the two deps pickle-recover injects, plus recording stand-ins for the
    // two the merge must fill in from defaults. If merging regressed to replacement,
    // ffReattach is undefined and this throws into the catch before either fires.
    const outcome = salvageTicket(
        { sessionDir: '/s', workingDir: '/w', ticketId: 't1', log: () => {} },
        {
            ...resetTicketInjection(recorder),
            archive: () => { recorder.push('archive'); return { patchPath: '/tmp/p.patch', files: [], filesTruncated: false }; },
            resetTodo: () => { recorder.push('reset-todo'); },
        },
    );

    assert.equal(outcome.disposition, 'archived-todo', 'reset-ticket reaches the archive+Todo branch');
    assert.notEqual(outcome.disposition, 'error', 'partial deps must not throw into the best-effort catch');
    assert.ok(recorder.includes('archive'), 'the dirty diff was archived');
    assert.ok(recorder.includes('reset-todo'), 'the ticket was reset to Todo');
    // INVARIANT: archive strictly BEFORE reset — never reset over unarchived work.
    assert.ok(recorder.indexOf('archive') < recorder.indexOf('reset-todo'), 'archive precedes reset');
});

test('AP-EXT-ITER10-01: unsupplied deps resolve to real defaults, never undefined', () => {
    // The narrowest proof of merge-not-replace. Inject ONLY the two deps
    // pickle-recover injects and nothing else, so every remaining dep must come
    // from `defaultDeps`. Against fake paths the REAL `resetTodo` default throws
    // (no such session dir), so the disposition is legitimately 'error' here —
    // what matters is WHICH error. Under the old replacement semantics the very
    // first statement blew up with "deps.ffReattach is not a function" before any
    // real work was attempted; that specific failure must never come back.
    const outcome = salvageTicket(
        { sessionDir: '/s', workingDir: '/w', ticketId: 't1', log: () => {} },
        resetTicketInjection([]),
    );

    assert.doesNotMatch(
        String(outcome.reason ?? ''),
        /is not a function/,
        'no dep resolved to undefined — defaults were merged, not replaced',
    );
    assert.doesNotMatch(String(outcome.reason ?? ''), /ffReattach/, 'ffReattach specifically was merged in');
});

test('AP-EXT-ITER10-01: an explicitly-undefined dep cannot re-open the hole', () => {
    const recorder = [];
    const outcome = salvageTicket(
        { sessionDir: '/s', workingDir: '/w', ticketId: 't1', log: () => {} },
        {
            ...resetTicketInjection(recorder),
            // A caller spreading an optional field can produce an explicit undefined.
            // Naive object-spread merging would let this clobber the default back to
            // undefined and reproduce the original TypeError.
            ffReattach: undefined,
            archive: () => { recorder.push('archive'); return null; },
            resetTodo: () => { recorder.push('reset-todo'); },
        },
    );

    assert.notEqual(outcome.disposition, 'error', 'undefined-valued keys are dropped, not merged');
    assert.ok(recorder.includes('reset-todo'), 'reset still ran');
});

test('AP-EXT-ITER10-01: a full deps object is unaffected by the merge', () => {
    // Guard the merge against changing behavior for the existing full-object
    // callers (mux-runner bounded-escape / exit path, and the matrix tests).
    const recorder = [];
    const outcome = salvageTicket(
        { sessionDir: '/s', workingDir: '/w', ticketId: 't1', log: () => {} },
        {
            reconcile: () => ({
                headSha: 'abc1234',
                dirty: true,
                dirtyPaths: ['x.ts'],
                ticketStatuses: { t1: 'In Progress' },
                tickets: [{ id: 't1', status: 'In Progress' }],
            }),
            gate: () => 'passing',
            commitScoped: () => { recorder.push('commit-scoped'); return { committed: true, sha: 'deadbee' }; },
            archive: () => { recorder.push('archive'); return null; },
            resetTodo: () => { recorder.push('reset-todo'); },
            ffReattach: () => ({ recovered: false }),
            backfillDone: () => ({ done: false }),
        },
    );

    assert.equal(outcome.disposition, 'committed-done', 'gate-passing path is unchanged');
    assert.equal(outcome.sha, 'deadbee');
    assert.ok(!recorder.includes('archive'), 'gate-passing never archives');
    assert.ok(!recorder.includes('reset-todo'), 'gate-passing never resets');
});

// AP-EXT-ITER10-01 anchor executability (anatomy-park iter 9).
//
// The catalog anchor read "no `as SalvageDeps` in `src/`". A bare
// `grep -rn "as SalvageDeps" src/` returns 1 — and the hit is the
// `pickle-recover.ts` COMMENT naming the retired cast. The prohibition's own
// prose defeats its grep, so the un-filtered form reports a phantom violation
// over intact code (same shape as R-CNAR-2, anatomy-park iter 8).
//
// The comment is worth keeping: it is why nobody re-adds the cast. So the
// anchor must be comment-stripped, and this test runs the corrected form.
test('AP-EXT-ITER10-01: no `as SalvageDeps` cast on any non-comment line in src/', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const srcRoot = path.resolve(import.meta.dirname, '../src');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (p.endsWith('.ts') ? [p] : []);
  });

  const codeHits = [];
  const commentHits = [];
  for (const file of walk(srcRoot)) {
    fs.readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
      if (!line.includes('as SalvageDeps')) return;
      (/^\s*(\/\/|\*|\/\*)/.test(line) ? commentHits : codeHits).push(`${file}:${i + 1}`);
    });
  }

  assert.deepEqual(codeHits, [], `partial deps laundered into SalvageDeps at: ${codeHits.join(', ')}`);
  // Pin the reason the anchor needs stripping at all: a bare grep is NOT zero.
  assert.ok(
    commentHits.length > 0,
    'the retired-cast comment is gone — simplify the catalog anchor back to a bare grep',
  );
});

// AP-EXT-ITER38-04 — `--reset-ticket` performs the transition it names.
//
// `resetTicketViaSalvage` injected `reconcile` and `gate` whose bodies were VERBATIM
// copies of salvageTicket's own defaults, so the injection steered nothing:
// `--reset-ticket` and `--salvage` were byte-identical across every (status × tree)
// shape, and salvageTicket's three refusals — clean tree, terminal status, gate verdict
// — each dropped the command out at `no-op` while it still exited 0 reporting a
// completed transition. A `recovery_exhausted` session most often leaves exactly those
// shapes behind: a clean tree (the recovery ladder already archived), or a ticket the
// bounded escape forced Skipped.
//
// These cases drive the REAL salvageTicket through the REAL runRecover over a REAL git
// repo, because the shipped coverage test injects a fake `salvage` and so asserts a
// disposition table over a stub — it stayed green through the whole defect.
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { runRecover } from '../bin/pickle-recover.js';
import { collectTickets, getTicketStatus } from '../services/pickle-utils.js';
import { updateTicketFrontmatter } from '../services/git-utils.js';

const RESET_TICKET_ID = 't1';

function gitIn(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        timeout: 20000,
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_NAME: 'Anatomy Park',
            GIT_AUTHOR_EMAIL: 'anatomy@example.invalid',
            GIT_COMMITTER_NAME: 'Anatomy Park',
            GIT_COMMITTER_EMAIL: 'anatomy@example.invalid',
        },
    });
}

/** A real repo + session dir holding one ticket at `status`, tree dirty or clean. */
function makeRecoverFixture(status, dirty) {
    const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'pickle-reset-ticket-')));
    const repo = path.join(root, 'repo');
    fsSync.mkdirSync(repo);
    gitIn(repo, ['init', '-q', '-b', 'main']);
    gitIn(repo, ['config', 'user.name', 'Anatomy Park']);
    gitIn(repo, ['config', 'user.email', 'anatomy@example.invalid']);
    fsSync.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['commit', '-q', '-m', 'base']);
    const head = gitIn(repo, ['rev-parse', 'HEAD']).trim();
    if (dirty) fsSync.writeFileSync(path.join(repo, 'a.txt'), 'worker work\n');

    const sessionDir = path.join(root, 'session');
    const ticketDir = path.join(sessionDir, RESET_TICKET_ID);
    fsSync.mkdirSync(ticketDir, { recursive: true });
    fsSync.writeFileSync(
        path.join(ticketDir, `rick_ticket_${RESET_TICKET_ID}.md`),
        ['---', `id: ${RESET_TICKET_ID}`, 'title: reset fixture', `status: ${status}`, 'order: 1', '---', '', '# body', ''].join('\n'),
    );

    const logs = [];
    // Only the state/session/event seams are faked. `salvage` is the REAL primitive, so
    // the injection under test is the one production uses.
    const deps = {
        readState: () => ({
            exit_reason: 'recovery_exhausted',
            working_dir: repo,
            start_commit: head,
            current_ticket: RESET_TICKET_ID,
            active: false,
        }),
        updateState: () => {},
        resolveSessionPath: () => sessionDir,
        collectTickets,
        ticketStatus: getTicketStatus,
        salvage: (input, salvageDeps) => salvageTicket(input, salvageDeps),
        reattach: () => { throw new Error('reset-ticket must not reach the ff-reattach primitive'); },
        setTicketTodo: (id, sd) => updateTicketFrontmatter(id, sd, { status: 'Todo', completion_commit: null }),
        emit: () => {},
        log: (m) => logs.push(m),
    };
    const readStatus = () => (getTicketStatus(sessionDir, RESET_TICKET_ID) ?? '').replace(/["']/g, '').trim();
    const archivedPatches = () => fsSync.readdirSync(ticketDir).filter((f) => f.startsWith('pre_reset_diff_'));
    return { repo, sessionDir, deps, logs, readStatus, archivedPatches };
}

test('AP-EXT-ITER38-04: --reset-ticket re-queues the named ticket on a CLEAN tree', () => {
    const fx = makeRecoverFixture('Failed', false);
    // Precondition: the tree really is clean, so the pre-fix clean-tree refusal applies.
    assert.equal(gitIn(fx.repo, ['status', '--porcelain']).trim(), '', 'fixture tree must be clean');

    const result = runRecover({ subcommand: 'reset-ticket', ticketArg: RESET_TICKET_ID, plan: false }, fx.repo, fx.deps);

    assert.equal(result.code, 0);
    assert.equal(result.transition?.disposition, 'archived-todo', 'the reset branch is reached, not `no-op`');
    assert.equal(fx.readStatus(), 'Todo', 'the ticket the operator named is actually re-queued');
    assert.deepEqual(fx.archivedPatches(), [], 'a clean tree archives nothing — forcing `dirty` widens the RESET, never the archive');
});

test('AP-EXT-ITER38-04: --reset-ticket re-queues a TERMINAL ticket the bounded escape Skipped', () => {
    const fx = makeRecoverFixture('Skipped', false);

    const result = runRecover({ subcommand: 'reset-ticket', ticketArg: RESET_TICKET_ID, plan: false }, fx.repo, fx.deps);

    assert.equal(result.transition?.disposition, 'archived-todo');
    assert.equal(fx.readStatus(), 'Todo', 'an explicit operator override re-queues a Skipped ticket');
});

test('AP-EXT-ITER38-04: --reset-ticket still archives a dirty diff BEFORE resetting', () => {
    const fx = makeRecoverFixture('In Progress', true);

    const result = runRecover({ subcommand: 'reset-ticket', ticketArg: RESET_TICKET_ID, plan: false }, fx.repo, fx.deps);

    assert.equal(result.transition?.disposition, 'archived-todo');
    assert.equal(fx.readStatus(), 'Todo');
    assert.equal(fx.archivedPatches().length, 1, 'the dirty diff is archived, never reset over unarchived work');
});

test('AP-EXT-ITER38-04: --salvage is UNCHANGED — the override belongs to --reset-ticket alone', () => {
    // The teeth of the fix: it must live in `resetTicketViaSalvage`'s injection, never in
    // salvageTicket's own refusals. A fix applied to the primitive would green the three
    // cases above AND change this one, turning every autonomous salvage seam into a
    // forced archive+Todo.
    const fx = makeRecoverFixture('Failed', false);

    const result = runRecover({ subcommand: 'salvage', ticketArg: RESET_TICKET_ID, plan: false }, fx.repo, fx.deps);

    assert.equal(result.transition?.disposition, 'no-op', '--salvage still declines a clean tree');
    assert.equal(fx.readStatus(), 'Failed', '--salvage leaves the ticket alone');
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER42-02 — `--salvage` advertised two dispositions it cannot reach.
//
// `executeTransition`'s salvage arm calls `deps.salvage(input)` with NO second
// argument and a literal `completionCommitSha: null`, so every dep that DECIDES
// a disposition stays at salvage-ticket's inert default: `gate` returns
// 'failing', `commitScoped` returns {committed:false}, `ffReattach` returns
// {recovered:false} and `backfillDone` returns {done:false}. A census of `src/`
// finds no provider for `ffReattach` or `backfillDone` anywhere, and no caller
// passes a non-null `completionCommitSha`. So `committed-done` and
// `ff-reattached` are unreachable from this command — yet the header comment,
// the `--plan` text, the operator command doc and the README all named them as
// outcomes "chosen by the working tree + gate", and the command doc told the
// operator a dirty-but-green tree "wants --salvage". It gets the same
// archive-then-requeue the same doc calls `--reset-ticket`'s last resort.
//
// These cases drive the REAL `runRecover` -> REAL `salvageTicket` over a REAL
// git repo, so they observe the shipped disposition rather than a stub's.
const SALVAGE_MATRIX = [
    { status: 'In Progress', dirty: true },
    { status: 'Failed', dirty: true },
    { status: 'In Progress', dirty: false },
    { status: 'Done', dirty: true },
];

test('AP-EXT-ITER42-02: --salvage never commits — a dirty green tree is archived + re-queued', () => {
    const fx = makeRecoverFixture('In Progress', true);
    const headBefore = gitIn(fx.repo, ['rev-parse', 'HEAD']).trim();

    const result = runRecover({ subcommand: 'salvage', ticketArg: RESET_TICKET_ID, plan: false }, fx.repo, fx.deps);

    assert.equal(result.transition?.disposition, 'archived-todo');
    assert.equal(fx.readStatus(), 'Todo', 'the ticket is re-queued, never flipped Done');
    assert.equal(fx.archivedPatches().length, 1, 'the diff is archived, never committed');
    assert.equal(gitIn(fx.repo, ['rev-parse', 'HEAD']).trim(), headBefore, 'HEAD never moves — commit+Done is unreachable');
});

test('AP-EXT-ITER42-02: the reachable disposition set is a strict subset of the primitive\'s', () => {
    // Corpus control: derive the disposition universe from the shipped primitive
    // instead of restating it, so a disposition added later cannot pass unseen.
    const primitive = fsSync.readFileSync(new URL('../lib/salvage-ticket.js', import.meta.url), 'utf-8');
    const universe = new Set([...primitive.matchAll(/disposition:\s*'([a-z-]+)'/g)].map((m) => m[1]));
    assert.ok(universe.size >= 4, `expected >=4 dispositions in the primitive, saw ${universe.size}`);

    const observed = new Set(SALVAGE_MATRIX.map(({ status, dirty }) => {
        const fx = makeRecoverFixture(status, dirty);
        return runRecover({ subcommand: 'salvage', ticketArg: RESET_TICKET_ID, plan: false }, fx.repo, fx.deps)
            .transition?.disposition;
    }));

    assert.deepEqual([...observed].sort(), ['archived-todo', 'no-op'], '--salvage reaches exactly these two');
    for (const unreachable of ['committed-done', 'ff-reattached']) {
        assert.ok(universe.has(unreachable), `${unreachable} must still exist in the primitive`);
        assert.ok(!observed.has(unreachable), `${unreachable} is unreachable from --salvage`);
    }
});

test('AP-EXT-ITER42-02: the --plan text promises no transition --salvage cannot perform', () => {
    const fx = makeRecoverFixture('In Progress', true);

    const result = runRecover({ subcommand: 'salvage', ticketArg: RESET_TICKET_ID, plan: true }, fx.repo, fx.deps);

    assert.equal(result.transition, null, '--plan performs no transition');
    const plan = fx.logs.join('\n');
    assert.match(plan, /archive/i, 'the plan names the disposition the command actually reaches');
    assert.doesNotMatch(plan, /commit\+Done|ff-reattach/i, 'the plan must not advertise an unreachable disposition');
});
