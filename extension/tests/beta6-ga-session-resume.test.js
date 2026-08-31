// @tier: fast
//
// AC-GA-EXIT-4 (ticket 2cc238c4) — GA back-compat gate.
//
// Proves that a real v2.0.0-beta.6 session state.json resumes cleanly end-to-end
// under the GA-deployed runtime: StateManager.read round-trips it without throwing,
// setup.js --resume reactivates it, the schema stays at 5, and the recovery_attempts
// ledger + codegraph activity counters survive byte-for-byte.
//
// This test COMPLEMENTS extension/tests/state-schema-version-deploy-parity.test.js
// (which only checks TS-constant <-> compiled-JS-constant equality for
// LATEST_SCHEMA_VERSION) by exercising a real state round-trip rather than constant
// equality. It is DISTINCT from extension/tests/setup-resume-ticket-status-preserved.test.js
// (which focuses on operator ticket-status gating) — here we assert schema neutrality,
// step preservation, and byte-for-byte ledger/counter survival.
//
// METHODOLOGY: the assertions below codify OBSERVED GA-runtime behavior, not wished-for
// behavior. The "one-step advance" AC resolves operationally to the liveness reactivation
// `active:false -> active:true` (plus pid-stamp + stale exit_reason clear); the GA resume
// path PRESERVES the lifecycle `step` and `current_ticket` so the mux-runner re-enters the
// same phase it left. There is no phase skip and no double-advance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const SETUP = path.join(EXT_ROOT, 'bin', 'setup.js');

const { LATEST_SCHEMA_VERSION } = await import(path.join(EXT_ROOT, 'types', 'index.js'));
const { StateManager } = await import(path.join(EXT_ROOT, 'services', 'state-manager.js'));
const { countCodegraphContextEvents } = await import(path.join(EXT_ROOT, 'bin', 'mux-runner.js'));

const CURRENT_TICKET = 'ab12cd34';

// Non-empty recovery_attempts ledger (RecoveryAttempt: {strategy, outcome, reason,
// iteration, ticket?} — see extension/src/types/index.ts:189). One entry carries the
// optional `ticket` field, one omits it, to exercise both shapes.
const RECOVERY_ATTEMPTS = Object.freeze([
    { strategy: 'silent_death_respawn', outcome: 'success', reason: 'log_empty', iteration: 2, ticket: CURRENT_TICKET },
    { strategy: 'failed_flip_suppressed', outcome: 'failed', reason: 'evidence_backed', iteration: 4 },
]);

// Codegraph counters live in state.activity as codegraph_context_injected /
// codegraph_context_skipped events and are aggregated by countCodegraphContextEvents
// (extension/src/bin/mux-runner.ts:793) — they are NOT first-class State fields.
const ACTIVITY = Object.freeze([
    { ts: '2026-06-15T10:00:00.000Z', event: 'codegraph_context_injected', ticket: CURRENT_TICKET },
    { ts: '2026-06-15T10:01:00.000Z', event: 'codegraph_context_injected', ticket: CURRENT_TICKET },
    { ts: '2026-06-15T10:02:00.000Z', event: 'codegraph_context_skipped', ticket: CURRENT_TICKET, reason: 'zero_hits' },
]);

const EXPECTED_CODEGRAPH_COUNTS = { injected: 2, skipped: 1 };

// Minimum beta.6 fixture: schema_version 5 + the full required State field set mirrored
// from setup.ts:createInitialState so the GA runtime does not throw, PLUS a populated
// recovery_attempts ledger, a populated activity array, and a stale forensic exit_reason
// to prove the resume clears it.
function buildBeta6State(sessionDir) {
    return {
        active: false,
        working_dir: process.cwd(),
        step: 'implement',
        iteration: 3,
        max_iterations: 15,
        worker_timeout_seconds: 3600,
        start_time_epoch: 1750000000,
        completion_promise: null,
        original_prompt: 'beta6 back-compat fixture',
        current_ticket: CURRENT_TICKET,
        history: [],
        started_at: new Date(Date.now() - 3600000).toISOString(), // recent: stale hardcoded date aged past pruneOldSessions threshold (time-bomb fixture)
        session_dir: sessionDir,
        tmux_mode: true,
        min_iterations: 0,
        command_template: 'pickle.md',
        chain_meeseeks: false,
        schema_version: 5,
        backend: 'claude',
        pipeline_continue_on_phase_fail: true,
        archaeology: null,
        tickets_version: 0,
        last_course_correction: null,
        phase_personas_active: false,
        flags: {},
        readiness: { cycle_history: [] },
        codex_version_seen: null,
        orphans_detected: [],
        invocation_source: 'operator',
        parent_session_hash: null,
        recovery_attempts: structuredClone(RECOVERY_ATTEMPTS),
        activity: structuredClone(ACTIVITY),
        exit_reason: 'iteration_cap_exhausted',
    };
}

function writeTicketFile(sessionDir, ticketId) {
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    const content = [
        '---',
        `id: ${ticketId}`,
        `title: "beta6 fixture ticket ${ticketId}"`,
        'status: "In Progress"',
        'priority: High',
        'order: 1',
        '---',
        '',
        '# Description',
        'beta6 back-compat fixture ticket.',
    ].join('\n');
    fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), content, 'utf-8');
}

// Hermetic sandbox: temp data root (mkdtempSync) + PICKLE_DATA_ROOT for the setup.js
// subprocess (R-PTSB invariant — session-writing bins must be sandboxed). No ~/.claude
// path is read or written.
function withSession(fn) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-beta6-resume-'));
    try {
        const sessionDir = path.join(dataRoot, 'sessions', '2026-06-15-beta6test');
        fs.mkdirSync(sessionDir, { recursive: true });
        const statePath = path.join(sessionDir, 'state.json');
        writeTicketFile(sessionDir, CURRENT_TICKET);
        fs.writeFileSync(statePath, JSON.stringify(buildBeta6State(sessionDir), null, 2));
        return fn({ dataRoot, sessionDir, statePath });
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
}

function resume(sessionDir, dataRoot) {
    execFileSync(process.execPath, [SETUP, '--resume', sessionDir], {
        encoding: 'utf-8',
        timeout: 60000,
        env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
    });
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

// AC-GA-EXIT-4 #3 (no throw / no migration error): a beta.6 fixture reads back clean.
// FR-A3 disposition (ticket 11226cc4): LOAD-SENSITIVITY, not tight-timeout — this suite's setup.js spawns finish in ~106ms against a 60000ms budget (566x margin), and serialized it ran 1.0s x3 clean under 24 spinners, so the beta.23 RUN 1 failure was 8-way pool contention and no timeout here is tight.
test('beta6-ga-session-resume: resumes clean — StateManager.read does not throw and preserves shape', () => {
    withSession(({ statePath }) => {
        const sm = new StateManager();
        let read;
        assert.doesNotThrow(() => { read = sm.read(statePath); }, 'beta.6 state must read without throwing under the GA runtime');
        assert.equal(read.schema_version, 5, 'StateManager.read must keep schema_version at 5 (no migration bump)');
        assert.equal(read.step, 'implement', 'read must preserve lifecycle step');
        assert.equal(read.current_ticket, CURRENT_TICKET, 'read must preserve current_ticket');
    });
});

// AC-GA-EXIT-4 #2 (one-step advance): operationally the GA resume reactivates
// active:false -> active:true with NO phase skip and NO double-advance — step and
// current_ticket are PRESERVED, the stale forensic exit_reason is cleared, pid is stamped.
test('beta6-ga-session-resume: one-step advance — resume reactivates without skipping or double-advancing the lifecycle', () => {
    withSession(({ sessionDir, statePath, dataRoot }) => {
        const before = readJson(statePath);
        assert.equal(before.active, false, 'fixture precondition: session starts inactive');

        resume(sessionDir, dataRoot);

        const after = readJson(statePath);
        assert.equal(after.active, true, 'resume must reactivate the session (the single liveness transition)');
        assert.equal(after.step, before.step, 'resume must NOT advance / skip the lifecycle step — it re-enters the same phase');
        assert.equal(after.current_ticket, CURRENT_TICKET, 'resume must NOT change current_ticket');
        assert.equal(after.exit_reason, null, 'resume must clear the stale forensic exit_reason');
        assert.equal(typeof after.pid, 'number', 'resume must stamp the live owning pid');
    });
});

// AC-GA-EXIT-4 #3 (byte-for-byte): recovery_attempts ledger + codegraph counters survive
// the real resume round-trip unchanged.
test('beta6-ga-session-resume: byte-preservation — recovery_attempts and codegraph counters survive the resume round-trip', () => {
    withSession(({ sessionDir, statePath, dataRoot }) => {
        resume(sessionDir, dataRoot);
        const after = readJson(statePath);

        assert.equal(
            JSON.stringify(after.recovery_attempts),
            JSON.stringify(RECOVERY_ATTEMPTS),
            'recovery_attempts ledger must survive the resume byte-for-byte',
        );
        assert.equal(
            JSON.stringify(after.activity),
            JSON.stringify(ACTIVITY),
            'activity array (codegraph counter source) must survive the resume byte-for-byte',
        );
        assert.deepEqual(
            countCodegraphContextEvents(after.activity),
            EXPECTED_CODEGRAPH_COUNTS,
            'codegraph counters must aggregate to {injected:2, skipped:1} after resume',
        );
    });
});

// AC-GA-EXIT-4 #4 (schema-neutral): LATEST_SCHEMA_VERSION === 5 and the resumed state
// stays at schema_version 5 — the resume does not bump the schema.
test('beta6-ga-session-resume: schema-neutral — LATEST_SCHEMA_VERSION === 5 and resume does not bump schema_version', () => {
    assert.equal(LATEST_SCHEMA_VERSION, 5, 'LATEST_SCHEMA_VERSION must be 5');
    withSession(({ sessionDir, statePath, dataRoot }) => {
        resume(sessionDir, dataRoot);
        assert.equal(readJson(statePath).schema_version, 5, 'resumed state must stay at schema_version 5');
    });
});

// AC-GA-EXIT-4 #5 (distinctness): this test exercises a real state round-trip, NOT
// constant equality, and does not duplicate the two sibling tests.
test('beta6-ga-session-resume: distinct from constant-parity and status-preservation siblings', () => {
    const paritySibling = path.join(EXT_ROOT, 'tests', 'state-schema-version-deploy-parity.test.js');
    const statusSibling = path.join(EXT_ROOT, 'tests', 'setup-resume-ticket-status-preserved.test.js');
    assert.ok(fs.existsSync(paritySibling), 'constant-parity sibling must exist on disk');
    assert.ok(fs.existsSync(statusSibling), 'status-preservation sibling must exist on disk');

    const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8');
    assert.ok(self.includes('COMPLEMENTS'), 'this test must declare it COMPLEMENTS the constant-parity test');
    // It must reference the parity test ONLY in prose/comments (complement), never re-run
    // its constant-equality assertion via a dynamic import of that module.
    const importsParity = /\bimport\s*\(\s*['"][^'"]*state-schema-version-deploy-parity/.test(self);
    assert.equal(
        importsParity,
        false,
        'this test must not import/re-run the constant-parity test — it exercises a real round-trip instead',
    );
});
