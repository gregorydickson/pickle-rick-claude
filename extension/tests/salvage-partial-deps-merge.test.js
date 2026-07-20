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
