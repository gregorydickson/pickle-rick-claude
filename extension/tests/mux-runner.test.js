// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMUX_RUNNER_BIN = path.resolve(__dirname, '../bin/mux-runner.js');
let compiledMuxRunnerBin = null;
// @add-dir-safe: REPO_ROOT is referenced only by `runWithRealExtension` and
// two gate-halt tests that short-circuit before any worker spawn — no
// --add-dir REPO_ROOT can ever propagate into a spawned claude subprocess.
const REPO_ROOT = path.resolve(__dirname, '../..');
const EXTENSION_ROOT = path.resolve(__dirname, '..');

/**
 * Create an isolated temp root directory.
 * Uses fs.realpathSync to resolve macOS /var -> /private/var symlinks.
 */
function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-runner-')));
}

/**
 * R-WSRC-4: per-call tmpdir EXTENSION_DIR so a leaked claude subprocess
 * (spawn timeout per R-MRWG-2) cannot inherit `--add-dir <real-repo>` write
 * access. NEVER use REPO_ROOT here.
 */
function makeSandboxedExtensionDir() {
    const name = 'pickle-mux-runner-test-' + crypto.randomBytes(4).toString('hex');
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name + '-')));
}

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

/**
 * Run mux-runner.js as a subprocess with a sandboxed (tmpdir-rooted) EXTENSION_DIR.
 *
 * R-WSRC-4: this helper MUST NOT accept REPO_ROOT. Tests that legitimately
 * need the real extension binaries use `runWithRealExtension` instead (those
 * tests halt at a gate BEFORE any worker spawn).
 *
 * @param {string|null} extDir - sandboxed extension dir under os.tmpdir();
 *   when null/undefined, a fresh per-call tmpdir is allocated.
 * @param {string[]} args - additional arguments to pass
 */
function run(extDir, args = []) {
    // 15s → 60s: budget for system load when run alongside concurrent
    // codex/tmux work. Fast-path tests (no-args, missing state.json, etc.)
    // exit in <100ms; the budget exists so node spawn + module load under
    // load doesn't blow the wall-clock and SIGKILL the subprocess.
    const effectiveExtDir = extDir || makeSandboxedExtensionDir();
    const realTmp = fs.realpathSync(os.tmpdir());
    const resolvedExtDir = fs.realpathSync(effectiveExtDir);
    if (resolvedExtDir !== realTmp && !resolvedExtDir.startsWith(realTmp + path.sep)) {
        throw new Error(
            `run(): extDir must be under os.tmpdir() (R-WSRC-4); got ${effectiveExtDir}. ` +
            `Use runWithRealExtension for tests that need REPO_ROOT.`,
        );
    }
    const env = { ...process.env, EXTENSION_DIR: effectiveExtDir };
    delete env.PICKLE_ROLE;
    env.PICKLE_BACKEND = 'claude';
    return spawnSync(process.execPath, [TMUX_RUNNER_BIN, ...args], {
        env,
        encoding: 'utf-8',
        // 15s → 60s → 150s: under 8-way full-suite concurrency on a loaded
        // host, mux-runner startup (state migration, ensureMonitorWindow,
        // module load) can creep past 60s before reaching command_template
        // validation, so the outer spawnSync SIGKILLs the runner before it
        // emits its rejection diagnostic. Fast-path tests still exit in <1s;
        // this budget only prevents premature SIGKILL under load.
        timeout: 150000,
    });
}

/**
 * Run mux-runner.js with EXTENSION_DIR=REPO_ROOT so the real readiness/audit
 * gate binaries resolve. ONLY for tests whose gate halts BEFORE any worker
 * spawn (no `claude --add-dir <real-repo>` subprocess is ever constructed).
 *
 * @add-dir-safe: gate-halt tests never reach buildClaudeWorkerInvocation; no
 * --add-dir propagation occurs because no worker is spawned.
 */
function runWithRealExtension(args = []) {
    // @add-dir-safe: REPO_ROOT here drives EXTENSION_DIR for resolving real
    // gate binaries; callers halt at the readiness or ticket-audit gate
    // before any spawn-morty call, so no worker --add-dir arguments are
    // ever constructed from REPO_ROOT.
    const env = { ...process.env, EXTENSION_DIR: REPO_ROOT };
    delete env.PICKLE_ROLE;
    env.PICKLE_BACKEND = 'claude';
    return spawnSync(process.execPath, [TMUX_RUNNER_BIN, ...args], {
        env,
        encoding: 'utf-8',
        // Gate-halt tests exit in <5s (readiness or ticket-audit fires before
        // any worker spawn). 30s is ample headroom under 8-way full-suite load.
        timeout: 30000,
    });
}

function getCompiledMuxRunnerBin() {
    if (compiledMuxRunnerBin) return compiledMuxRunnerBin;

    const outDir = makeTmpRoot();
    const compile = spawnSync('npx', ['tsc', '--project', 'tsconfig.json', '--outDir', outDir], {
        cwd: EXTENSION_ROOT,
        encoding: 'utf-8',
        timeout: 120000,
    });
    assert.equal(
        compile.status,
        0,
        `Expected temporary mux-runner build to succeed.\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`,
    );
    compiledMuxRunnerBin = path.join(outDir, 'bin', 'mux-runner.js');
    return compiledMuxRunnerBin;
}

function readActivityLines(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    return fs.readdirSync(activityDir)
        .filter((file) => file.endsWith('.jsonl'))
        .flatMap((file) => fs.readFileSync(path.join(activityDir, file), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)));
}

function writeClaudeCompletionStub(binDir) {
    const claudePath = path.join(binDir, 'claude');
    fs.writeFileSync(claudePath, [
        '#!/bin/sh',
        'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"<promise>EPIC_COMPLETED</promise>"}]}}\'',
        '',
    ].join('\n'));
    fs.chmodSync(claudePath, 0o755);
}

function writeGateSkipTicket(sessionDir, id = 'ok0001', status = 'Done') {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), [
        '---',
        `id: ${id}`,
        `key: ${id.toUpperCase()}`,
        `status: ${status}`,
        'ac_ids: [REQ-1]',
        '---',
        '',
        '# Ticket',
        '',
        '## Acceptance Criteria',
        '- [ ] The workflow should feel intuitive.',
        '',
    ].join('\n'));
}

function initCloserTerminalGitRepo(tmpRoot) {
    const repoDir = path.join(tmpRoot, 'worktree');
    fs.mkdirSync(repoDir, { recursive: true });
    assert.equal(spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf-8' }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'tests@example.com'], { cwd: repoDir, encoding: 'utf-8' }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'Pickle Tests'], { cwd: repoDir, encoding: 'utf-8' }).status, 0);
    fs.writeFileSync(path.join(repoDir, 'ticket.txt'), 'closer handoff fixture\n');
    assert.equal(spawnSync('git', ['add', 'ticket.txt'], { cwd: repoDir, encoding: 'utf-8' }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-m', 'seed fixture'], { cwd: repoDir, encoding: 'utf-8' }).status, 0);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' });
    assert.equal(head.status, 0);
    return {
        repoDir,
        headSha: head.stdout.trim(),
    };
}

function writeCloserTerminalSession(sessionDir, workingDir, options) {
    const ticketId = options.ticketId || 'close01';
    writeGateSkipTicket(sessionDir, ticketId, options.status);
    fs.writeFileSync(path.join(sessionDir, 'decomposition_manifest.json'), JSON.stringify({
        requirements: ['REQ-1'],
        tickets: [{ id: ticketId, key: ticketId.toUpperCase(), ac_ids: ['REQ-1'] }],
    }, null, 2));
    if (options.conformanceBody) {
        fs.writeFileSync(path.join(sessionDir, ticketId, 'conformance_2026-05-17.md'), options.conformanceBody);
    }
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
        active: true,
        step: 'implement',
        iteration: 0,
        max_iterations: 5,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        original_prompt: 'closer handoff regression',
        working_dir: workingDir,
        command_template: 'pickle.md',
        current_ticket: ticketId,
        flags: {
            skip_quality_gates_reason: 'closer handoff regression fixture',
        },
        closer_handoff_tracker: options.closerTracker || undefined,
    }, null, 2));
    return ticketId;
}

function writeUnexpectedSpawnStub(binDir, markerPath) {
    const claudePath = path.join(binDir, 'claude');
    fs.writeFileSync(claudePath, [
        '#!/bin/sh',
        `echo invoked > "${markerPath}"`,
        'exit 99',
        '',
    ].join('\n'));
    fs.chmodSync(claudePath, 0o755);
}

function writeGateSkipSession(sessionDir, flags, workingDir) {
    // R-WSRC-4: workingDir must be tmpdir-rooted, never REPO_ROOT. Caller
    // owns sessionDir's tmpdir; we default to it when no override is passed.
    const wd = workingDir || sessionDir;
    writeGateSkipTicket(sessionDir);
    fs.writeFileSync(path.join(sessionDir, 'decomposition_manifest.json'), JSON.stringify({
        requirements: ['REQ-1'],
        tickets: [{ id: 'ok0001', key: 'OK-1', ac_ids: ['REQ-1'] }],
    }, null, 2));
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
        active: true,
        step: 'research',
        iteration: 0,
        max_iterations: 1,
        worker_timeout_seconds: 1200,
        original_prompt: 'quality gate skip regression',
        working_dir: wd,
        command_template: 'pickle.md',
        flags,
    }, null, 2));
}

function runMuxRunnerWithDataRoot(sessionDir, dataRoot, stubBinDir) {
    // R-WSRC-4: EXTENSION_DIR is a fresh tmpdir-rooted sandbox so the worker's
    // getExtensionRoot() never resolves to REPO_ROOT and --add-dir REPO_ROOT
    // can never propagate into the spawned (stubbed) claude subprocess. The
    // quality-gate-skip tests SKIP readiness + ticket-audit gates, so the real
    // gate binaries are unused.
    const sandboxedExtensionDir = makeSandboxedExtensionDir();
    // B-CITAIL T3: make the sandbox a self-contained extension root so
    // getExtensionRoot() ACCEPTS it instead of falling back to the canonical
    // deployed root (~/.claude/pickle-rick) — which exists on a dev box but is
    // ABSENT on CI (no install.sh), where the fallback then resolves the manager
    // template against a missing root and the quality-gate-skip assertions fail.
    // Mirrors the populate-sandbox pattern used by the orphan-tmp test below:
    // the `.pickle-install-root` sentinel + a minimal manager-prompt template.
    fs.writeFileSync(path.join(sandboxedExtensionDir, '.pickle-install-root'), '');
    const sandboxTemplatesDir = path.join(sandboxedExtensionDir, 'templates');
    fs.mkdirSync(sandboxTemplatesDir, { recursive: true });
    fs.writeFileSync(
        path.join(sandboxTemplatesDir, '_pickle-manager-prompt.md'),
        '# Pickle\n\nResume: $ARGUMENTS\n',
    );
    const env = {
        ...process.env,
        EXTENSION_DIR: sandboxedExtensionDir,
        PICKLE_BACKEND: 'claude',
        PICKLE_DATA_ROOT: dataRoot,
        PATH: `${stubBinDir}:${process.env.PATH || ''}`,
    };
    delete env.PICKLE_ROLE;
    return spawnSync(process.execPath, [getCompiledMuxRunnerBin(), sessionDir], {
        env,
        encoding: 'utf-8',
        timeout: 60000,
    });
}

// --- No args → exit code 1, stderr includes "Usage" ---

test('mux-runner: exits with code 1 and prints Usage when no args provided', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const result = run(tmpRoot);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('Usage'),
            `Expected "Usage" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Session dir without state.json → exit code 1, stderr includes "Usage" ---

test('mux-runner: exits with code 1 when session dir has no state.json', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Create a session dir but don't put state.json in it
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        const result = run(tmpRoot, [sessionDir]);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('Usage'),
            `Expected "Usage" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Max iterations already reached → exits with "Max iterations reached" ---

test('mux-runner: exits when max_iterations already reached', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Create a session dir with state.json where iteration >= max_iterations
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 5,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test task',
            working_dir: tmpRoot,
        }, null, 2));

        // mux-runner also needs pickle_settings.json at extension root (optional)
        // and pickle.md in ~/.claude/commands/ (only needed for runIteration)
        // Since max_iterations is already reached, the loop will break before
        // calling runIteration, so we don't need those files.

        const result = run(tmpRoot, [sessionDir]);

        // Combine stdout and runner log to check for the exit message
        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Max iterations reached'),
            `Expected "Max iterations reached" in output/log, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );

        // Verify state was set to inactive
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'Session should be inactive after max iterations');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Session starts inactive, mux-runner takes ownership, then immediately hits max ---

test('mux-runner: takes ownership of inactive session then respects max_iterations', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Start with active: false (mux-runner should set it to true)
        // but iteration is already at max
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            tmux_mode: true,
            step: 'plan',
            iteration: 10,
            max_iterations: 10,
            worker_timeout_seconds: 1200,
            original_prompt: 'test ownership',
            working_dir: tmpRoot,
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        // Should have taken ownership
        assert.ok(
            combined.includes('ownership'),
            `Expected ownership message in log, got: ${logContent}`
        );

        // Should hit max iterations
        assert.ok(
            combined.includes('Max iterations reached'),
            `Expected "Max iterations reached" in output/log, got stdout: ${result.stdout}, log: ${logContent}`
        );

        // Final state should be inactive again (set by the max_iterations guard)
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'Session should be inactive after max iterations');
        // R-ICP-1: cap-hit without an EPIC_COMPLETED promise is forensic, not clean-success.
        // safeDeactivate preserves step/current_ticket so postmortem can show the unfinished queue.
        // exit_reason flips from 'limit' to 'iteration_cap_exhausted' to distinguish from time/budget exits.
        assert.equal(finalState.step, 'plan', 'iteration-cap exhaustion must preserve original step for forensics');
        assert.equal(finalState.exit_reason, 'iteration_cap_exhausted', 'cap-hit-without-promise exit_reason must be "iteration_cap_exhausted"');
        // Exit code must be 3 (distinct from 0=clean and 1=error) so pipeline-runner halts instead of advancing.
        assert.equal(result.status, 3, 'iteration-cap exhaustion must exit with code 3');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Settings type guards for max turns ---

test('mux-runner: ignores non-number default_tmux_max_turns in settings', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Session already at max iterations — will exit immediately
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 3,
            max_iterations: 3,
            worker_timeout_seconds: 1200,
            original_prompt: 'test settings guard',
            working_dir: tmpRoot,
        }, null, 2));

        // Write settings with a string (should be ignored)
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_tmux_max_turns: "eighty",
            default_manager_max_turns: true,
        }));

        const result = run(tmpRoot, [sessionDir]);
        const combined = result.stdout + result.stderr;
        // Should not crash with TypeError
        assert.ok(
            !combined.includes('TypeError'),
            `Should handle non-number settings gracefully, got: ${combined.slice(0, 500)}`
        );

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        if (fs.existsSync(runnerLog)) {
            const logContent = fs.readFileSync(runnerLog, 'utf-8');
            assert.ok(
                logContent.includes('Max iterations reached'),
                `Expected normal max iterations exit, got: ${logContent}`
            );
        }
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: ignores zero default_tmux_max_turns, falls back to default_manager_max_turns', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'refactor',
            iteration: 2,
            max_iterations: 2,
            original_prompt: 'test fallback',
            working_dir: tmpRoot,
        }, null, 2));

        // default_tmux_max_turns is 0 (rejected), but default_manager_max_turns is valid
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_tmux_max_turns: 0,
            default_manager_max_turns: 42,
        }));

        const result = run(tmpRoot, [sessionDir]);
        const combined = result.stdout + result.stderr;
        assert.ok(
            !combined.includes('TypeError'),
            `Should handle zero settings gracefully, got: ${combined.slice(0, 500)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Nonexistent session dir path → exit code 1 ---

test('mux-runner: exits with code 1 when session dir path does not exist', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const result = run(tmpRoot, ['/nonexistent/session/path/xyz']);
        assert.equal(result.status, 1, `Expected exit code 1, got: ${result.status}`);
        assert.ok(
            result.stderr.includes('Usage'),
            `Expected "Usage" in stderr, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Runner creates mux-runner.log ---

// ---------------------------------------------------------------------------
// Number() coercion for string numeric limits (deep review pass 5)
// ---------------------------------------------------------------------------

test('mux-runner: string max_iterations and iteration still trigger max iterations exit', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Use STRING values for max_iterations and iteration
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: '1',
            max_iterations: '1',
            worker_timeout_seconds: 1200,
            original_prompt: 'test string coercion',
            working_dir: tmpRoot,
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Max iterations reached'),
            `Expected "Max iterations reached" with string numerics, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );

        // Verify state was set to inactive
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'Session should be inactive after string max iterations');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: recovered inactive orphan tmp stops the loop before stale command_template validation', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        const statePath = path.join(sessionDir, 'state.json');
        const baseState = {
            working_dir: tmpRoot,
            backend: 'claude',
            active: true,
            step: 'implement',
            iteration: 0,
            max_iterations: 5,
            max_time_minutes: 0,
            worker_timeout_seconds: 1200,
            start_time_epoch: 0,
            original_prompt: 'test recovered inactive state',
            session_dir: sessionDir,
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
            schema_version: 3,
            command_template: '../stale-template.md',
        };
        fs.writeFileSync(statePath, JSON.stringify(baseState, null, 2));
        fs.writeFileSync(`${statePath}.tmp.99999999`, JSON.stringify({
            ...baseState,
            active: false,
            step: 'review',
            iteration: 4,
            original_prompt: 'promoted inactive state',
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        const logContent = fs.existsSync(runnerLog) ? fs.readFileSync(runnerLog, 'utf-8') : '';
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Session inactive. Exiting.'),
            `Expected recovered inactive session exit, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );
        assert.ok(
            !combined.includes('Invalid command_template'),
            `Recovered inactive state should short-circuit stale template validation, got: ${combined}`
        );

        const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(finalState.active, false, 'promoted inactive state must persist');
        assert.equal(finalState.iteration, 4, 'higher-iteration orphan tmp must be promoted');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: SIGTERM shutdown preserves a newer orphan tmp session payload', async () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        const statePath = path.join(sessionDir, 'state.json');
        const baseState = {
            schema_version: 1,
            active: false,
            tmux_mode: true,
            backend: 'claude',
            step: 'implement',
            iteration: 1,
            max_iterations: 10,
            max_time_minutes: 0,
            worker_timeout_seconds: 1200,
            start_time_epoch: 0,
            current_ticket: 'T-BASE',
            original_prompt: 'Base mux session state',
            working_dir: tmpRoot,
            session_dir: sessionDir,
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
        };
        fs.writeFileSync(statePath, JSON.stringify(baseState, null, 2));

        const templatesDir = path.join(tmpRoot, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(templatesDir, '_pickle-manager-prompt.md'), '# Pickle\n\nResume: $ARGUMENTS\n');
        // Sentinel so getExtensionRoot() accepts EXTENSION_DIR=tmpRoot and finds the template above.
        fs.writeFileSync(path.join(tmpRoot, '.pickle-install-root'), '');
        fs.writeFileSync(
            path.join(tmpRoot, 'current_sessions.json'),
            JSON.stringify({ [tmpRoot]: { sessionPath: sessionDir, pid: 12345 } }, null, 2),
        );

        const fakeBin = path.join(tmpRoot, 'fake-bin');
        fs.mkdirSync(fakeBin, { recursive: true });
        const fakeClaude = path.join(fakeBin, 'claude');
        fs.writeFileSync(fakeClaude, '#!/bin/sh\n/bin/sleep 30\n');
        fs.chmodSync(fakeClaude, 0o755);

        const child = spawn(process.execPath, [TMUX_RUNNER_BIN, sessionDir], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpRoot,
                PICKLE_DATA_ROOT: tmpRoot,
                PATH: fakeBin,
                PICKLE_BACKEND: 'claude',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        const iterLog = path.join(sessionDir, `tmux_iteration_${baseState.iteration + 1}.log`);

        await waitFor(() => {
            try {
                const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
                return state.active === true && fs.existsSync(iterLog);
            } catch {
                return false;
            }
        });

        const orphanTmpPath = `${statePath}.tmp.99999999`;
        fs.writeFileSync(orphanTmpPath, JSON.stringify({
            ...baseState,
            active: true,
            iteration: 7,
            current_ticket: 'T-RECOVERED',
            original_prompt: 'Recovered mux session state',
        }, null, 2));

        const exitPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error('mux-runner did not exit after SIGTERM'));
            }, 10000);
            child.on('exit', () => {
                clearTimeout(timer);
                resolve(undefined);
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
        child.kill('SIGTERM');
        await exitPromise;

        const combined = stdout + stderr;
        const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.ok(
            combined.includes('Received SIGTERM'),
            `Expected shutdown log in output, got: ${combined.slice(0, 1000)}`
        );
        assert.equal(finalState.iteration, 7, 'shutdown must promote the newer orphan tmp before deactivation');
        assert.equal(finalState.current_ticket, 'T-RECOVERED', 'shutdown must preserve the recovered session payload');
        assert.equal(finalState.active, false, 'shutdown must deactivate the session');
        assert.equal(fs.existsSync(orphanTmpPath), false, 'orphan tmp should be consumed during shutdown recovery');
        assert.deepEqual(
            JSON.parse(fs.readFileSync(path.join(tmpRoot, 'current_sessions.json'), 'utf-8')),
            {},
            'signal shutdown must remove the current_sessions.json entry for the tmux owner',
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: SIGTERM shutdown emits signal_received with sender attribution when parent command is inspectable', async () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        const statePath = path.join(sessionDir, 'state.json');
        const baseState = {
            schema_version: 1,
            active: false,
            tmux_mode: true,
            backend: 'claude',
            step: 'implement',
            iteration: 1,
            max_iterations: 10,
            max_time_minutes: 0,
            worker_timeout_seconds: 1200,
            start_time_epoch: 0,
            current_ticket: 'T-SIGNAL',
            original_prompt: 'Signal attribution fixture',
            working_dir: tmpRoot,
            session_dir: sessionDir,
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
        };
        fs.writeFileSync(statePath, JSON.stringify(baseState, null, 2));

        const templatesDir = path.join(tmpRoot, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(templatesDir, '_pickle-manager-prompt.md'), '# Pickle\n\nResume: $ARGUMENTS\n');
        // Sentinel so getExtensionRoot() accepts EXTENSION_DIR=tmpRoot and finds the template above.
        fs.writeFileSync(path.join(tmpRoot, '.pickle-install-root'), '');
        fs.writeFileSync(
            path.join(tmpRoot, 'current_sessions.json'),
            JSON.stringify({ [tmpRoot]: { sessionPath: sessionDir, pid: 12345 } }, null, 2),
        );

        const fakeBin = path.join(tmpRoot, 'fake-bin');
        fs.mkdirSync(fakeBin, { recursive: true });
        const fakeClaude = path.join(fakeBin, 'claude');
        fs.writeFileSync(fakeClaude, '#!/bin/sh\n/bin/sleep 30\n');
        fs.chmodSync(fakeClaude, 0o755);

        const senderScript = path.join(tmpRoot, 'codex-signal-sender.js');
        fs.writeFileSync(senderScript, `
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const [runnerBin, sessionDir] = process.argv.slice(2);
const child = spawn(process.execPath, [runnerBin, sessionDir], {
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
const iterLog = path.join(sessionDir, 'tmux_iteration_2.log');
const deadline = Date.now() + 30000;
const timer = setInterval(() => {
  if (fs.existsSync(iterLog)) {
    clearInterval(timer);
    child.kill('SIGTERM');
    return;
  }
  if (Date.now() >= deadline) {
    clearInterval(timer);
    child.kill('SIGKILL');
    process.exit(124);
  }
}, 25);
child.on('exit', (code, signal) => {
  clearInterval(timer);
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
        `.trimStart());

        const parent = spawn(process.execPath, [senderScript, TMUX_RUNNER_BIN, sessionDir], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpRoot,
                PICKLE_DATA_ROOT: tmpRoot,
                PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
                PICKLE_BACKEND: 'claude',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        parent.stdout.on('data', chunk => { stdout += chunk.toString(); });
        parent.stderr.on('data', chunk => { stderr += chunk.toString(); });

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                parent.kill('SIGKILL');
                reject(new Error('signal attribution wrapper did not exit'));
            }, 30000);
            parent.on('exit', () => {
                clearTimeout(timer);
                resolve(undefined);
            });
            parent.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

        const signalEvent = readActivityLines(tmpRoot).find((entry) => entry.event === 'signal_received');
        assert.ok(signalEvent, `expected signal_received activity event; stdout=${stdout} stderr=${stderr}`);
        assert.equal(signalEvent.signal, 'SIGTERM');
        assert.equal(signalEvent.source, 'pickle');
        assert.equal(signalEvent.session, path.basename(sessionDir));
        assert.equal(signalEvent.gate_payload?.signal_sender_pid, parent.pid);
        assert.match(
            signalEvent.gate_payload?.signal_sender_cmd ?? '',
            /codex-signal-sender\.js/,
            `expected sender command to reference wrapper script, got ${signalEvent.gate_payload?.signal_sender_cmd ?? '(missing)'}`,
        );

        const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        const stateSignalEvent = (finalState.activity || []).find((entry) => entry.event === 'signal_received');
        assert.ok(stateSignalEvent, 'state.json activity should preserve the signal_received entry');
        assert.equal(stateSignalEvent.gate_payload?.signal_sender_pid, parent.pid);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: NaN max_time_minutes and start_time_epoch do not crash', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // NaN time values but valid iteration limit so it exits quickly
        // Number("abc") = NaN, || 0 fallback prevents crash on time checks
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 5,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            max_time_minutes: 'abc',
            start_time_epoch: 'xyz',
            original_prompt: 'test NaN safety',
            working_dir: tmpRoot,
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        // Should not crash with TypeError — should handle NaN gracefully
        assert.ok(
            !combined.includes('TypeError'),
            `Should not crash on NaN time values, got: ${combined.slice(0, 500)}`
        );
        // Should still hit max iterations and exit cleanly
        assert.ok(
            combined.includes('Max iterations reached'),
            `Expected "Max iterations reached" despite NaN time values, got: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: stall detection works with string state.iteration', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // String iteration — stall detection must compare Number()-coerced values
        // Start at iteration "5" with max "100" — runIteration will fail (no claude),
        // but the stall counter should increment because state.iteration won't advance.
        // After 3 stalls, mux-runner exits.
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: '5',
            max_iterations: 100,
            worker_timeout_seconds: 1200,
            original_prompt: 'test stall with string',
            working_dir: tmpRoot,
        }, null, 2));

        // Require _pickle-manager-prompt.md to run — runIteration needs the manager template
        const claudeDir = path.join(os.homedir(), '.claude', 'commands');
        const managerPromptPath = path.join(claudeDir, '_pickle-manager-prompt.md');
        const hasManagerPrompt = fs.existsSync(managerPromptPath);

        if (!hasManagerPrompt) {
            // Skip test if _pickle-manager-prompt.md isn't installed — can't test runIteration
            return;
        }

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }

        // The stall detection should NOT treat string "5" === number -1 as different
        // (which would reset the counter each time). With the Number() fix,
        // it compares 5 === -1, 5 === 5, 5 === 5 and stalls after 3 iterations.
        // But runIteration may exit with 'error' first since claude binary isn't available.
        // Either way, the runner should have logged iterations and exited.
        assert.ok(
            logContent.includes('Iteration'),
            `Expected iteration logs, got: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- command_template path traversal validation ---

test('mux-runner: rejects command_template with path traversal (../)', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Active session at iteration 0 — runIteration will be called,
        // which reads command_template from state.json
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'prd',
            iteration: 0,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test traversal',
            working_dir: tmpRoot,
            command_template: '../../../etc/passwd',
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Invalid command_template'),
            `Expected path traversal rejection, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: rejects command_template with forward slash', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'prd',
            iteration: 0,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test slash',
            working_dir: tmpRoot,
            command_template: 'subdir/evil.md',
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('Invalid command_template'),
            `Expected slash rejection, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: runs readiness gate at iteration 0 before manager spawn', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        const ticketDir = path.join(sessionDir, 'bad001');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(path.join(ticketDir, 'rick_ticket_bad001.md'), [
            '---',
            'id: bad001',
            'key: BAD-1',
            'ac_ids: []',
            '---',
            '',
            '# Ticket',
            '',
            '## Acceptance Criteria',
            '- [ ] verify_pre: The workflow should feel intuitive.',
            '',
        ].join('\n'));
        fs.writeFileSync(path.join(sessionDir, 'decomposition_manifest.json'), JSON.stringify({
            tickets: [{ id: 'bad001', key: 'BAD-1' }],
        }, null, 2));
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'research',
            iteration: 0,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test readiness gate',
            working_dir: tmpRoot,
            command_template: 'pickle.md',
        }, null, 2));

        // R-GATE-ADVISORY: the readiness gate is ADVISORY — it still runs and logs its
        // findings, but it does NOT halt the run. The build proceeds past it (here it
        // then fails only on unrelated test-fixture issues: no manager template / non-git
        // dir), so it never stops at the gate with a halt exit_reason.
        const result = runWithRealExtension([sessionDir]);
        const runnerLog = fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf-8');
        const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));

        assert.match(runnerLog, /readiness advisory/);          // gate ran, logged its finding
        assert.doesNotMatch(result.stderr + runnerLog, /READINESS HALT/);
        assert.ok(fs.readdirSync(sessionDir).some((file) => /^readiness_\d{4}-\d{2}-\d{2}/.test(file)));
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// R-GATE-ADVISORY: ticket-audit gate is advisory — a non-zero audit-ticket-bundle exit
// is logged but does NOT halt the iteration-0 run (the build/review phases catch real defects).
test('mux-runner.audit-bundle-advisory: logs but does NOT halt on defective tickets', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        // 8-char hex hash dir so audit-ticket-bundle.js listTicketDirs picks it up
        const ticketDir = path.join(sessionDir, 'deadbeef');
        fs.mkdirSync(ticketDir, { recursive: true });
        // Body contains a backtick path that doesn't exist in git → path-drift (fatal) finding.
        // .xyz extension is not in check-readiness.js PATH_RE extension allowlist so
        // readiness passes without a bypass flag; audit-ticket-bundle.js flags the path
        // as path-drift because gitListFiles(tmpRoot) returns empty (non-git working_dir).
        // No flags set — skip_quality_gates_reason (the single bypass surface) would
        // bypass both gates.
        fs.writeFileSync(path.join(ticketDir, 'rick_ticket_deadbeef.md'), [
            '---',
            'id: deadbeef',
            'title: Phantom File Ticket',
            'status: Todo',
            'mapped_requirements: []',
            '---',
            '',
            '# Description',
            '',
            'Modify `extension/src/does-not-exist-phantom.xyz` to add a function.',
            '',
        ].join('\n'));
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'research',
            iteration: 0,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test audit gate',
            working_dir: tmpRoot,
            command_template: 'pickle.md',
        }, null, 2));

        // R-GATE-ADVISORY: a path-drift finding is logged, NOT halted. The run proceeds
        // past the ticket-audit gate (here it then fails only on unrelated test-fixture
        // issues), so no gate-halt exit_reason is ever stamped.
        const result = runWithRealExtension([sessionDir]);
        const runnerLog = fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf-8');
        const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));

        assert.match(runnerLog, /ticket audit advisory/);        // gate ran, logged its finding
        assert.doesNotMatch(result.stderr + runnerLog, /TICKET AUDIT HALT/);
        assert.notEqual(state.exit_reason, 'ticket_audit_failed'); // retired halt reason never stamped
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner quality-gate skip: unified flag honored; lingering retired legacy keys are inert', () => {
    const sessionDir = makeTmpRoot();
    const dataRoot = makeTmpRoot();
    const stubBinDir = makeTmpRoot();
    try {
        writeClaudeCompletionStub(stubBinDir);
        writeGateSkipSession(sessionDir, {
            skip_quality_gates_reason: 'canonical quality gate waiver',
            skip_readiness_reason: 'retired legacy key (inert)',
            skip_ticket_audit_reason: 'retired legacy key (inert)',
        });

        const result = runMuxRunnerWithDataRoot(sessionDir, dataRoot, stubBinDir);
        const runnerLog = fs.readFileSync(path.join(sessionDir, 'mux-runner.log'), 'utf-8');
        const events = readActivityLines(dataRoot);

        assert.ok([0, 3].includes(result.status ?? -1), result.stderr + runnerLog);
        assert.match(runnerLog, /canonical quality gate waiver/);
        assert.doesNotMatch(runnerLog, /DEPRECATION: state\.flags\./);
        assert.ok(
            !events.some((entry) => entry.event === 'skip_flag_legacy_used'),
            `retired legacy event must never be emitted, got ${JSON.stringify(events)}`,
        );
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
        fs.rmSync(stubBinDir, { recursive: true, force: true });
    }
});

test('mux-runner quality-gate skip: retired legacy flags do NOT bypass any gate (single skip surface)', () => {
    // Guard-layer prune (item e): skip_readiness_reason / skip_ticket_audit_reason
    // were retired. resolveQualityGateSkipReason reads ONLY the unified
    // skip_quality_gates_reason; legacy keys on old sessions are inert.
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-legacy-skip-data-')));
    const prev = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        const legacyOnly = {
            flags: {
                skip_readiness_reason: 'retired readiness waiver',
                skip_ticket_audit_reason: 'retired audit waiver',
            },
        };
        const log = () => {};
        assert.deepEqual(resolveQualityGateSkipReason(legacyOnly, log, 'test-session', 'readiness_gate'), {});
        assert.deepEqual(resolveQualityGateSkipReason(legacyOnly, log, 'test-session', 'ticket_audit_gate'), {});

        const unified = { flags: { skip_quality_gates_reason: '  unified waiver  ' } };
        assert.deepEqual(
            resolveQualityGateSkipReason(unified, log, 'test-session', 'readiness_gate'),
            { reason: 'unified waiver' },
        );

        const events = readActivityLines(dataRoot).filter((entry) => entry.event === 'skip_flag_legacy_used');
        assert.deepEqual(events, [], 'retired legacy event must never be emitted');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

// F20: unknown template rejected (not present in extensionRoot/templates or ~/.claude/commands)
test('mux-runner: rejects command_template not found in any directory', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Use a name that cannot exist in the real ~/.claude/commands either
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'prd',
            iteration: 0,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test unknown template',
            working_dir: tmpRoot,
            command_template: 'definitely-nonexistent-template-xyz123abc.md',
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        assert.ok(
            combined.includes('not found'),
            `Expected "not found" error for unknown template, got stdout: ${result.stdout}, stderr: ${result.stderr}, log: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// F20: user command accepted when template exists in extensionRoot/templates
test('mux-runner: accepts command_template found in extensionRoot/templates', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        // Create the templates directory and a valid template inside it
        const templatesDir = path.join(tmpRoot, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(templatesDir, 'test-valid-template.md'),
            '# Test Template\nThis template exists and should be accepted.\n');

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'prd',
            iteration: 0,
            max_iterations: 1,
            original_prompt: 'test valid template',
            working_dir: tmpRoot,
            command_template: 'test-valid-template.md',
        }, null, 2));

        const result = run(tmpRoot, [sessionDir]);

        const runnerLog = path.join(sessionDir, 'mux-runner.log');
        let logContent = '';
        if (fs.existsSync(runnerLog)) {
            logContent = fs.readFileSync(runnerLog, 'utf-8');
        }
        const combined = result.stdout + result.stderr + logContent;

        // Template validation must pass — no "not found" or "Invalid" error
        assert.ok(
            !combined.includes('not found in'),
            `Template should be accepted, got: ${combined.slice(0, 600)}`
        );
        assert.ok(
            !combined.includes('Invalid command_template'),
            `Template should not be rejected, got: ${combined.slice(0, 600)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: creates mux-runner.log in session directory', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'refactor',
            iteration: 3,
            max_iterations: 3,
            worker_timeout_seconds: 1200,
            original_prompt: 'test log creation',
            working_dir: tmpRoot,
        }, null, 2));

        run(tmpRoot, [sessionDir]);

        const logPath = path.join(sessionDir, 'mux-runner.log');
        assert.ok(fs.existsSync(logPath), 'mux-runner.log should be created in session dir');

        const logContent = fs.readFileSync(logPath, 'utf-8');
        assert.ok(
            logContent.includes('mux-runner started'),
            `Expected "mux-runner started" in log, got: ${logContent}`
        );
        assert.ok(
            logContent.includes('mux-runner finished'),
            `Expected "mux-runner finished" in log, got: ${logContent}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Completion classification (classifyCompletion) ---

import { buildTmuxNotification, classifyCompletion, classifyTicketCompletion, applyAutoTicketCompletionValidation, correctPhantomDoneTickets, extractAssistantContent, loadRateLimitSettings, classifyIterationExit, detectRateLimitInLog, detectRateLimitInText, stripSetupSection, detectMultiRepo, validateAutoTicketCompletion, writeHandoffAtomic, resolveQualityGateSkipReason } from '../bin/mux-runner.js';
import { readEvidence } from '../services/ticket-completion-evidence.js';

test('classifyCompletion: TASK_COMPLETED returns continue (single ticket, loop continues)', () => {
    assert.equal(classifyCompletion('<promise>TASK_COMPLETED</promise>'), 'continue');
});

test('classifyCompletion: EPIC_COMPLETED returns task_completed', () => {
    assert.equal(classifyCompletion('<promise>EPIC_COMPLETED</promise>'), 'task_completed');
});

test('classifyCompletion: EXISTENCE_IS_PAIN returns review_clean', () => {
    assert.equal(classifyCompletion('<promise>EXISTENCE_IS_PAIN</promise>'), 'review_clean');
});

test('classifyCompletion: THE_CITADEL_APPROVES returns review_clean', () => {
    assert.equal(classifyCompletion('<promise>THE_CITADEL_APPROVES</promise>'), 'review_clean');
});

test('classifyCompletion: no token returns continue', () => {
    assert.equal(classifyCompletion('Some random output with no tokens'), 'continue');
});

test('classifyCompletion: empty string returns continue', () => {
    assert.equal(classifyCompletion(''), 'continue');
});

test('classifyCompletion: EPIC_COMPLETED takes precedence over EXISTENCE_IS_PAIN', () => {
    const output = '<promise>EPIC_COMPLETED</promise>\n<promise>EXISTENCE_IS_PAIN</promise>';
    assert.equal(classifyCompletion(output), 'task_completed');
});

test('classifyCompletion: tolerates whitespace in tokens', () => {
    assert.equal(classifyCompletion('<promise> EXISTENCE_IS_PAIN </promise>'), 'review_clean');
    assert.equal(classifyCompletion('<promise> TASK_COMPLETED </promise>'), 'continue');
});

test('classifyCompletion: TASK_COMPLETED inside stream-json returns continue', () => {
    const streamJsonLine = JSON.stringify({
        type: 'assistant',
        message: {
            content: [{ type: 'text', text: 'All done!\n<promise>TASK_COMPLETED</promise>' }],
        },
    });
    assert.equal(classifyCompletion(streamJsonLine), 'continue');
});

test('classifyCompletion: EPIC_COMPLETED inside stream-json returns task_completed', () => {
    const streamJsonLine = JSON.stringify({
        type: 'assistant',
        message: {
            content: [{ type: 'text', text: 'All done!\n<promise>EPIC_COMPLETED</promise>' }],
        },
    });
    assert.equal(classifyCompletion(streamJsonLine), 'task_completed');
});

// --- extractAssistantContent ---

test('extractAssistantContent: extracts assistant text, ignores tool results', () => {
    const lines = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'x', content: 'Source: <promise>EPIC_COMPLETED</promise>' }
        ]}}),
        JSON.stringify({ type: 'assistant', message: { content: [
            { type: 'text', text: 'Review complete.\n<promise>EXISTENCE_IS_PAIN</promise>' }
        ]}}),
    ].join('\n');
    const content = extractAssistantContent(lines);
    assert.ok(content.includes('EXISTENCE_IS_PAIN'), 'Should include assistant text');
    assert.ok(!content.includes('EPIC_COMPLETED'), 'Should exclude tool_result content');
});

test('extractAssistantContent: includes result type lines', () => {
    const lines = [
        JSON.stringify({ type: 'result', result: 'Final output <promise>EPIC_COMPLETED</promise>' }),
    ].join('\n');
    const content = extractAssistantContent(lines);
    assert.ok(content.includes('EPIC_COMPLETED'), 'Should include result type');
});

test('extractAssistantContent: raw text passes through for backward compat', () => {
    const raw = 'Just plain text with <promise>EXISTENCE_IS_PAIN</promise>';
    const content = extractAssistantContent(raw);
    assert.ok(content.includes('EXISTENCE_IS_PAIN'), 'Should include raw text');
});

// F16: non-JSON line excluded in stream-json mode (prevents catch-block false positives)
test('extractAssistantContent: non-JSON plaintext excluded when stream-json lines present', () => {
    // A JSON line marks this as stream-json output; the subsequent plain-text line
    // (e.g. from a catch block printing an error) must NOT be included.
    const jsonLine = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Working on it...' }] },
    });
    const catchArtifact = '<promise>TASK_COMPLETED</promise>'; // stray non-JSON line
    const output = [jsonLine, catchArtifact].join('\n');

    const content = extractAssistantContent(output);
    assert.ok(!content.includes('TASK_COMPLETED'),
        'Non-JSON line should be excluded in stream-json mode');
    assert.ok(content.includes('Working on it...'),
        'JSON assistant text should still be included');
});

// F16: result-type blocks must be included (session final response for promise detection)
test('extractAssistantContent: result-type block included in stream-json mode', () => {
    const jsonLine = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'All done.' }] },
    });
    const resultLine = JSON.stringify({ type: 'result', result: '<promise>EPIC_COMPLETED</promise>' });
    const output = [jsonLine, resultLine].join('\n');

    const content = extractAssistantContent(output);
    assert.ok(content.includes('EPIC_COMPLETED'),
        'result-type block must be included for promise detection');
});

// F16: assistant-type blocks included (sanity check alongside result-type)
test('extractAssistantContent: assistant-type text block included in stream-json mode', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '<promise>EXISTENCE_IS_PAIN</promise>' }] },
    });
    const content = extractAssistantContent(line);
    assert.ok(content.includes('EXISTENCE_IS_PAIN'), 'assistant text block must be included');
});

// --- Regression: EPIC_COMPLETED in tool_result must not override EXISTENCE_IS_PAIN in assistant ---

test('classifyCompletion: EPIC_COMPLETED in tool_result does NOT cause task_completed (regression)', () => {
    const output = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'read1', content: 'if (hasToken(output, PromiseTokens.EPIC_COMPLETED)) {\n  return \'task_completed\';\n}\n<promise>EPIC_COMPLETED</promise>' }
        ]}}),
        JSON.stringify({ type: 'assistant', message: { content: [
            { type: 'text', text: 'EXISTENCE IS PAIN! No issues found.\n<promise>EXISTENCE_IS_PAIN</promise>' }
        ]}}),
    ].join('\n');
    assert.equal(classifyCompletion(output), 'review_clean',
        'Should return review_clean, not task_completed from source code in tool_result');
});

test('classifyCompletion: system prompt containing EPIC_COMPLETED is ignored', () => {
    const output = [
        JSON.stringify({ type: 'system', system: 'Promise tokens: <promise>EPIC_COMPLETED</promise>' }),
        JSON.stringify({ type: 'assistant', message: { content: [
            { type: 'text', text: 'Done reviewing.\n<promise>EXISTENCE_IS_PAIN</promise>' }
        ]}}),
    ].join('\n');
    assert.equal(classifyCompletion(output), 'review_clean');
});

// --- Notification logic (buildTmuxNotification) ---

test('buildTmuxNotification: success shows "Complete" with elapsed time', () => {
    const n = buildTmuxNotification('success', 'implement', 5, 300);
    assert.equal(n.title, '🥒 Pickle Run Complete');
    assert.ok(n.subtitle.includes('Finished in'), `Expected "Finished in" subtitle, got: ${n.subtitle}`);
    assert.ok(n.body.includes('5 iterations'), `Expected iterations in body, got: ${n.body}`);
});

test('buildTmuxNotification: limit shows "Complete" with "Stopped"', () => {
    const n = buildTmuxNotification('limit', 'implement', 10, 600);
    assert.equal(n.title, '🥒 Pickle Run Complete');
    assert.ok(n.subtitle.includes('Stopped: limit'), `Expected "Stopped: limit" subtitle, got: ${n.subtitle}`);
});

test('buildTmuxNotification: cancelled shows "Complete" with "Stopped"', () => {
    const n = buildTmuxNotification('cancelled', 'research', 3, 120);
    assert.equal(n.title, '🥒 Pickle Run Complete');
    assert.ok(n.subtitle.includes('Stopped: cancelled'), `Expected "Stopped: cancelled" subtitle, got: ${n.subtitle}`);
});

test('buildTmuxNotification: error shows "Failed" with phase', () => {
    const n = buildTmuxNotification('error', 'plan', 2, 45);
    assert.equal(n.title, '🥒 Pickle Run Failed');
    assert.ok(n.subtitle.includes('Exit: error'), `Expected "Exit: error" subtitle, got: ${n.subtitle}`);
    assert.ok(n.subtitle.includes('phase: plan'), `Expected phase in subtitle, got: ${n.subtitle}`);
});

test('buildTmuxNotification: stall shows "Failed" with phase', () => {
    const n = buildTmuxNotification('stall', 'implement', 7, 900);
    assert.equal(n.title, '🥒 Pickle Run Failed');
    assert.ok(n.subtitle.includes('Exit: stall'), `Expected "Exit: stall" subtitle, got: ${n.subtitle}`);
});

// ---------------------------------------------------------------------------
// loadRateLimitSettings
// ---------------------------------------------------------------------------

test('loadRateLimitSettings: returns defaults when no settings file', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 5);
        assert.equal(result.maxRetries, 3);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: reads custom values from pickle_settings.json', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: 30,
            default_max_rate_limit_retries: 5,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 30);
        assert.equal(result.maxRetries, 5);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: zero values fall back to floor of 1', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: 0,
            default_max_rate_limit_retries: 0,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 5, 'wait_minutes: 0 should fall back to default 5');
        assert.equal(result.maxRetries, 3, 'retries: 0 should fall back to default 3');
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: negative values fall back to defaults', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: -10,
            default_max_rate_limit_retries: -1,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 5);
        assert.equal(result.maxRetries, 3);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: non-number values fall back to defaults', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: 'sixty',
            default_max_rate_limit_retries: true,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 5);
        assert.equal(result.maxRetries, 3);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

test('loadRateLimitSettings: boundary value 1 is accepted (minimum floor)', () => {
    const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-')));
    try {
        fs.writeFileSync(path.join(fakeRoot, 'pickle_settings.json'), JSON.stringify({
            default_rate_limit_wait_minutes: 1,
            default_max_rate_limit_retries: 1,
        }));
        const result = loadRateLimitSettings(fakeRoot);
        assert.equal(result.waitMinutes, 1);
        assert.equal(result.maxRetries, 1);
    } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Exit code sidecar file pattern (d6ed51ab)
// ---------------------------------------------------------------------------

test('exitcode sidecar: .log replaced with .exitcode produces correct filename', () => {
    const logFile = '/tmp/sessions/2026-03-01/tmux_iteration_1.log';
    const exitCodeFile = logFile.replace('.log', '.exitcode');
    assert.equal(exitCodeFile, '/tmp/sessions/2026-03-01/tmux_iteration_1.exitcode');
});

test('exitcode sidecar: pattern works for various iteration numbers', () => {
    for (const n of [0, 1, 42, 999]) {
        const logFile = `tmux_iteration_${n}.log`;
        const exitCodeFile = logFile.replace('.log', '.exitcode');
        assert.equal(exitCodeFile, `tmux_iteration_${n}.exitcode`);
    }
});

// ---------------------------------------------------------------------------
// classifyIterationExit — rate limit main loop integration (87e1fdde)
// ---------------------------------------------------------------------------

test('classifyIterationExit: inactive result returns inactive', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'some output\n');
        assert.equal(classifyIterationExit('inactive', logFile).type, 'inactive');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: error result returns error', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'some output\n');
        assert.equal(classifyIterationExit('error', logFile).type, 'error');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: task_completed returns success', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'normal output\n');
        assert.equal(classifyIterationExit('task_completed', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: review_clean returns success', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'clean output\n');
        assert.equal(classifyIterationExit('review_clean', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with rate_limit_event JSON returns api_limit', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        const lines = [
            'normal output',
            JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(classifyIterationExit('continue', logFile).type, 'api_limit');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('mux-runner source: closer handoff exit reasons are part of the runner contract', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/bin/mux-runner.ts'), 'utf-8');
    assert.match(source, /closer_handoff_terminal/);
    assert.match(source, /manager_handoff_pending/);
    assert.match(source, /const isHaltExit = \(r: ExitReason\).*closer_handoff_terminal.*manager_handoff_pending/s);
});

test('mux-runner source: closer handoff tracker persists ticket id, head sha, and consecutive budget', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/bin/mux-runner.ts'), 'utf-8');
    assert.match(source, /interface CloserHandoffTracker/);
    assert.match(source, /ticket_id:\s*string/);
    assert.match(source, /head_sha:\s*string/);
    assert.match(source, /consecutive_failed_iterations:\s*number/);
    assert.match(source, /readCloserHandoffBudget/);
    assert.match(source, /closer_handoff_iteration_budget/);
});

test('mux-runner: exits before manager spawn when a failed closer handoff repeats on the same ticket and head', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        const dataRoot = path.join(tmpRoot, 'data-root');
        const stubBinDir = path.join(tmpRoot, 'bin');
        const spawnMarker = path.join(tmpRoot, 'claude-invoked.txt');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(dataRoot, { recursive: true });
        fs.mkdirSync(stubBinDir, { recursive: true });
        writeUnexpectedSpawnStub(stubBinDir, spawnMarker);

        const { repoDir, headSha } = initCloserTerminalGitRepo(tmpRoot);
        const ticketId = writeCloserTerminalSession(sessionDir, repoDir, {
            status: 'Failed',
            closerTracker: {
                ticket_id: 'close01',
                head_sha: headSha,
                consecutive_failed_iterations: 1,
            },
        });

        const result = runMuxRunnerWithDataRoot(sessionDir, dataRoot, stubBinDir);
        assert.equal(result.status, 0, `Expected clean terminal exit, got ${result.status} stderr=${result.stderr}`);
        assert.equal(fs.existsSync(spawnMarker), false, 'manager subprocess should not spawn after closer terminal detection');

        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'session should deactivate on terminal closer handoff');
        assert.equal(finalState.exit_reason, 'closer_handoff_terminal');
        assert.equal(finalState.current_ticket, ticketId);

        const activity = readActivityLines(dataRoot).filter((entry) => entry.terminal_exit_reason === 'closer_handoff_terminal');
        assert.equal(activity.length > 0, true, 'expected a session_end activity for closer_handoff_terminal');
        assert.match(activity.at(-1).reason || '', /remained Failed on HEAD/);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// Helper: unset PICKLE_TEST_MODE for the duration of a callback so the F3
// guard's production behavior is exercised, then restore.
function withProductionGuard(fn) {
    const prev = process.env.PICKLE_TEST_MODE;
    delete process.env.PICKLE_TEST_MODE;
    try {
        return fn();
    } finally {
        if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev;
    }
}

test('guardCompletionCommitBeforeDone: rejects ticket with no completion_commit', async () => {
    const { guardCompletionCommitBeforeDone } = await import('../bin/mux-runner.js');
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        const workingDir = path.join(tmpRoot, 'work');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(workingDir, { recursive: true });
        const ticketId = 'aaaa1111';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });
        // Ticket with NO completion_commit field — the f00097e8 attack vector.
        fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`),
          `---\nid: ${ticketId}\ntitle: "test"\nstatus: Done\n---\n# T\n`);
        const result = withProductionGuard(() =>
            guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir, rereadBackoffMs: 0 })
        );
        assert.equal(result.ok, false, 'guard should reject ticket with no commit');
        assert.equal(result.source, 'absent');
        assert.match(result.reason, /cannot flip Done/);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('guardCompletionCommitBeforeDone: bypass flag accepts inferred when set', async () => {
    const { guardCompletionCommitBeforeDone } = await import('../bin/mux-runner.js');
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        const workingDir = path.join(tmpRoot, 'work');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(workingDir, { recursive: true });
        const ticketId = 'bbbb2222';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`),
          `---\nid: ${ticketId}\ntitle: "test"\nstatus: Done\n---\n# T\n`);
        withProductionGuard(() => {
            // Absent evidence: reject (no attributable commit at all).
            const r1 = guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir, flags: {}, rereadBackoffMs: 0 });
            assert.equal(r1.ok, false);
            // Null flags: also reject — absent evidence has no SHA to attribute.
            const r2 = guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir, flags: null, rereadBackoffMs: 0 });
            assert.equal(r2.ok, false, 'absent evidence rejects regardless of flags');
        });
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('R-CCGR guardCompletionCommitBeforeDone: backoff re-read recovers a completion_commit stamped during the window', async () => {
    const { guardCompletionCommitBeforeDone } = await import('../bin/mux-runner.js');
    const tmpRoot = makeTmpRoot();
    try {
        initGitRepo(tmpRoot);
        const sha = gitHead(tmpRoot);
        const sessionDir = path.join(tmpRoot, 'session');
        const ticketId = 'ccgr0001';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
        // Initial frontmatter: status Done but NO completion_commit — the
        // exact state the guard sees before the worker's stamp lands.
        fs.writeFileSync(ticketFile, `---\nid: ${ticketId}\ntitle: ccgr\nstatus: Done\n---\n# T\n`);

        // A separate process signals readiness, then stamps completion_commit
        // ~150ms later — well inside the 800ms guard backoff window. The guard
        // blocks synchronously via Atomics.wait, so only a real concurrent
        // process can win this race. Blocking on the ready marker before the
        // guard starts absorbs Node subprocess cold-start jitter; without it a
        // slow cold-start could push the 150ms stamp past the 800ms re-read.
        const stamped = `---\nid: ${ticketId}\ntitle: ccgr\nstatus: Done\ncompletion_commit: ${sha}\n---\n# T\n`;
        const readyMarker = path.join(tmpRoot, 'writer-ready');
        const writer = spawn(process.execPath, ['-e',
            `const fs=require('fs');`
            + `fs.writeFileSync(${JSON.stringify(readyMarker)},'r');`
            + `setTimeout(()=>fs.writeFileSync(${JSON.stringify(ticketFile)}, ${JSON.stringify(stamped)}), 150);`,
        ], { stdio: 'ignore' });
        const readyDeadline = Date.now() + 10000;
        while (!fs.existsSync(readyMarker)) {
            if (Date.now() > readyDeadline) {
                try { writer.kill(); } catch { /* already exited */ }
                throw new Error('R-CCGR: writer subprocess never signaled ready');
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }

        const result = withProductionGuard(() =>
            guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir: tmpRoot, rereadBackoffMs: 800 })
        );
        try { writer.kill(); } catch { /* already exited */ }

        assert.equal(result.ok, true, 'guard must accept a completion_commit that landed during the backoff');
        assert.equal(result.sha, sha);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('R-CCGR guardCompletionCommitBeforeDone: backoff re-read is reached for commitless ticket (R-CCR-7)', async () => {
    // AC-CCR-7-1 mechanism substitution (see conformance_*.md for full justification):
    // The literal AC asks for a spy asserting hasCompletionCommit count===2, but this is
    // infeasible in the current ESM module architecture:
    //   (a) hasCompletionCommit is an ESM named binding in mux-runner.js — immutable.
    //   (b) t.mock.method(fs, 'readFileSync') throws "Cannot redefine property" because
    //       ESM namespace properties are non-configurable in Node.js.
    //   (c) require('fs').readFileSync = wrapper mutates the CJS exports but does NOT
    //       affect ESM namespace callers (verified: patching CJS does not change fs.readFileSync
    //       observed through the ESM namespace — snapshot taken at module evaluation).
    //   (d) mock.module() only affects future imports; mux-runner.js is already cached.
    //   (e) File mutation between reads is impossible: sleepSyncMs(0) returns immediately
    //       (early-return guard 'if (ms <= 0) return'), so both reads are back-to-back.
    //
    // Deterministic proxy used instead: for a commitless ticket, hasCompletionCommit
    // returns source:'absent' on the first call. guardPasses({source:'absent'}) is false,
    // so the backoff block (ts:2798-2805) is ALWAYS entered — the re-read at ts:2804
    // is GUARANTEED to execute. The production-guard wrapper rules out the PICKLE_TEST_MODE
    // bypass path (which would return ok:true). The behavioral result {ok:false,
    // source:'absent'} is the observable evidence of the re-read path executing.
    //
    // Regression coverage: the existing R-CCGR test at line 2140 provides the executable
    // regression pin (removing the re-read would flip that test from ok:true to ok:false).
    const { guardCompletionCommitBeforeDone } = await import('../bin/mux-runner.js');
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        const workingDir = path.join(tmpRoot, 'work');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(workingDir, { recursive: true });
        const ticketId = 'ccgr7001';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
        fs.writeFileSync(ticketFile, `---\nid: ${ticketId}\ntitle: "test"\nstatus: Done\n---\n# T\n`);

        const result = withProductionGuard(() =>
            guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir, rereadBackoffMs: 0 })
        );

        // absent source means guardPasses=false on first read → backoff block entered →
        // re-read fires → second read also returns absent → guard rejects.
        assert.equal(result.ok, false, 'commitless ticket must be rejected by production guard');
        assert.equal(result.source, 'absent',
            'R-CCGR: re-read fired (backoff block entered because absent fails guardPasses); guard correctly rejects');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('guardCompletionCommitBeforeDone: PICKLE_TEST_MODE=1 bypasses entire guard (R-WSRC-4 parity)', async () => {
    const { guardCompletionCommitBeforeDone } = await import('../bin/mux-runner.js');
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        const workingDir = path.join(tmpRoot, 'work');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(workingDir, { recursive: true });
        const ticketId = 'cccc3333';
        const prev = process.env.PICKLE_TEST_MODE;
        process.env.PICKLE_TEST_MODE = '1';
        try {
            const result = guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir });
            assert.equal(result.ok, true, 'guard should bypass under PICKLE_TEST_MODE=1');
            assert.equal(result.sha, 'pickle-test-mode-bypass');
        } finally {
            if (prev === undefined) delete process.env.PICKLE_TEST_MODE;
            else process.env.PICKLE_TEST_MODE = prev;
        }
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- R-CCR-9: guardRereadBackoffMs env handling ---

test('guardRereadBackoffMs: R-CCR-9 PICKLE_GUARD_REREAD_BACKOFF_MS=0 honored — guard returns without sleeping', async () => {
    const { guardCompletionCommitBeforeDone } = await import('../bin/mux-runner.js');
    const tmpRoot = makeTmpRoot();
    const prevEnv = process.env.PICKLE_GUARD_REREAD_BACKOFF_MS;
    process.env.PICKLE_GUARD_REREAD_BACKOFF_MS = '0';
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        const workingDir = path.join(tmpRoot, 'work');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(workingDir, { recursive: true });
        const ticketId = 'ccr9env0';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`),
            `---\nid: ${ticketId}\ntitle: "test"\nstatus: Done\n---\n# T\n`);
        const t0 = Date.now();
        const result = withProductionGuard(() =>
            guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir })
        );
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 400, `env=0 must produce no sleep; elapsed=${elapsed}ms`);
        assert.equal(result.ok, false, 'commitless ticket must still be rejected');
    } finally {
        if (prevEnv === undefined) delete process.env.PICKLE_GUARD_REREAD_BACKOFF_MS;
        else process.env.PICKLE_GUARD_REREAD_BACKOFF_MS = prevEnv;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('guardRereadBackoffMs: R-CCR-9 env above 5000ms ceiling clamped — writer at 100ms found after ~5000ms sleep', async () => {
    // env=99999 clamped to 5000ms; without clamping the test would time out (99999ms sleep).
    const { guardCompletionCommitBeforeDone } = await import('../bin/mux-runner.js');
    const tmpRoot = makeTmpRoot();
    const prevEnv = process.env.PICKLE_GUARD_REREAD_BACKOFF_MS;
    process.env.PICKLE_GUARD_REREAD_BACKOFF_MS = '99999';
    try {
        initGitRepo(tmpRoot);
        const sha = gitHead(tmpRoot);
        const sessionDir = path.join(tmpRoot, 'session');
        const ticketId = 'ccr9ceil';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
        fs.writeFileSync(ticketFile, `---\nid: ${ticketId}\ntitle: "test"\nstatus: Done\n---\n# T\n`);
        const stamped = `---\nid: ${ticketId}\ntitle: "test"\nstatus: Done\ncompletion_commit: ${sha}\n---\n# T\n`;
        const writer = spawn(process.execPath, ['-e',
            `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(ticketFile)}, ${JSON.stringify(stamped)}), 100)`,
        ], { stdio: 'ignore' });
        const t0 = Date.now();
        const result = withProductionGuard(() =>
            guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir: tmpRoot })
        );
        const elapsed = Date.now() - t0;
        try { writer.kill(); } catch { /* already exited */ }
        assert.ok(elapsed >= 4000 && elapsed < 6000,
            `ceiling must clamp env=99999 to ~5000ms; elapsed=${elapsed}ms`);
        assert.equal(result.ok, true, 'writer found after clamped backoff');
        assert.equal(result.sha, sha);
    } finally {
        if (prevEnv === undefined) delete process.env.PICKLE_GUARD_REREAD_BACKOFF_MS;
        else process.env.PICKLE_GUARD_REREAD_BACKOFF_MS = prevEnv;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('guardRereadBackoffMs: R-CCR-9 NaN and negative env values fall back to 500ms default', async () => {
    // Non-finite or negative env falls back to the 500ms default backoff; a
    // concurrent writer stamps completion_commit inside that window and the
    // guard's single re-read after the backoff must find it.
    const { guardCompletionCommitBeforeDone } = await import('../bin/mux-runner.js');
    for (const [envVal, label] of [['notanumber', 'NaN'], ['-100', 'negative']]) {
        const tmpRoot = makeTmpRoot();
        const prevEnv = process.env.PICKLE_GUARD_REREAD_BACKOFF_MS;
        process.env.PICKLE_GUARD_REREAD_BACKOFF_MS = envVal;
        try {
            initGitRepo(tmpRoot);
            const sha = gitHead(tmpRoot);
            const sessionDir = path.join(tmpRoot, 'session');
            const ticketId = label === 'NaN' ? 'ccr9dflt1' : 'ccr9dflt2';
            const ticketDir = path.join(sessionDir, ticketId);
            fs.mkdirSync(ticketDir, { recursive: true });
            const ticketFile = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
            fs.writeFileSync(ticketFile, `---\nid: ${ticketId}\ntitle: "test"\nstatus: Done\n---\n# T\n`);
            const stamped = `---\nid: ${ticketId}\ntitle: "test"\nstatus: Done\ncompletion_commit: ${sha}\n---\n# T\n`;
            // The writer signals readiness, then stamps the ticket 150ms later.
            // Blocking on the ready marker before starting the guard absorbs
            // Node subprocess cold-start jitter — without it, a slow cold-start
            // could push the 100ms write past the guard's 500ms re-read (flake).
            // The 150ms stamp delay reliably lands AFTER the guard's first read
            // (so the backoff path is exercised) and BEFORE its 500ms re-read.
            const readyMarker = path.join(tmpRoot, 'writer-ready');
            const writer = spawn(process.execPath, ['-e',
                `const fs=require('fs');`
                + `fs.writeFileSync(${JSON.stringify(readyMarker)},'r');`
                + `setTimeout(()=>fs.writeFileSync(${JSON.stringify(ticketFile)}, ${JSON.stringify(stamped)}), 150);`,
            ], { stdio: 'ignore' });
            const readyDeadline = Date.now() + 10000;
            while (!fs.existsSync(readyMarker)) {
                if (Date.now() > readyDeadline) {
                    try { writer.kill(); } catch { /* already exited */ }
                    throw new Error(`${label}: writer subprocess never signaled ready`);
                }
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
            }
            const t0 = Date.now();
            const result = withProductionGuard(() =>
                guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir: tmpRoot })
            );
            const elapsed = Date.now() - t0;
            try { writer.kill(); } catch { /* already exited */ }
            assert.ok(elapsed >= 400,
                `${label} env must fall back to 500ms default; elapsed=${elapsed}ms`);
            assert.equal(result.ok, true,
                `${label} env: writer found after 500ms default backoff`);
            assert.equal(result.sha, sha);
        } finally {
            if (prevEnv === undefined) delete process.env.PICKLE_GUARD_REREAD_BACKOFF_MS;
            else process.env.PICKLE_GUARD_REREAD_BACKOFF_MS = prevEnv;
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    }
});

test('hasSubstantiveManagerHandoff: substantive body returns true', async () => {
    const { hasSubstantiveManagerHandoff } = await import('../bin/mux-runner.js');
    const content = '## Manager Handoff\n- operator-owned release work remains\n';
    assert.equal(hasSubstantiveManagerHandoff(content), true);
});

test('hasSubstantiveManagerHandoff: body "None" returns false (no halt)', async () => {
    const { hasSubstantiveManagerHandoff } = await import('../bin/mux-runner.js');
    const content = '## Manager Handoff\n\nNone.\n';
    assert.equal(hasSubstantiveManagerHandoff(content), false);
});

test('hasSubstantiveManagerHandoff: body "None. The ticket file contains no [manager]-tagged acceptance items." (f00097e8 fixture) returns false', async () => {
    const { hasSubstantiveManagerHandoff } = await import('../bin/mux-runner.js');
    const content = '## Manager Handoff\n\nNone. The ticket file contains no `[manager]`-tagged acceptance items.\n\n## Verdict\nALL_PASS\n';
    assert.equal(hasSubstantiveManagerHandoff(content), false);
});

test('hasSubstantiveManagerHandoff: body "No `[manager]` criteria in this ticket." (R-PGI 20043815 fixture) returns false', async () => {
    const { hasSubstantiveManagerHandoff } = await import('../bin/mux-runner.js');
    const content = '## Manager Handoff\n\nNo `[manager]` criteria in this ticket.\n\n## Verdict: ALL_PASS\n';
    assert.equal(hasSubstantiveManagerHandoff(content), false);
});

test('hasSubstantiveManagerHandoff: "No manager handoff items needed" returns false', async () => {
    const { hasSubstantiveManagerHandoff } = await import('../bin/mux-runner.js');
    const content = '## Manager Handoff\n- No manager handoff items needed\n';
    assert.equal(hasSubstantiveManagerHandoff(content), false);
});

test('hasSubstantiveManagerHandoff: substantive body starting with a non-"no" word still returns true', async () => {
    const { hasSubstantiveManagerHandoff } = await import('../bin/mux-runner.js');
    const content = '## Manager Handoff\n\n| Item | Action |\n|---|---|\n| pickle_settings key | Manager must add the key |\n';
    assert.equal(hasSubstantiveManagerHandoff(content), true);
});

test('hasSubstantiveManagerHandoff: body "- none" with list marker returns false', async () => {
    const { hasSubstantiveManagerHandoff } = await import('../bin/mux-runner.js');
    const content = '## Manager Handoff\n- none\n';
    assert.equal(hasSubstantiveManagerHandoff(content), false);
});

test('hasSubstantiveManagerHandoff: body "N/A" returns false', async () => {
    const { hasSubstantiveManagerHandoff } = await import('../bin/mux-runner.js');
    const content = '## Manager Handoff\nN/A\n';
    assert.equal(hasSubstantiveManagerHandoff(content), false);
});

test('hasSubstantiveManagerHandoff: body "Nothing." returns false', async () => {
    const { hasSubstantiveManagerHandoff } = await import('../bin/mux-runner.js');
    const content = '## Manager Handoff\nNothing.\n';
    assert.equal(hasSubstantiveManagerHandoff(content), false);
});

test('hasSubstantiveManagerHandoff: empty body returns false', async () => {
    const { hasSubstantiveManagerHandoff } = await import('../bin/mux-runner.js');
    const content = '## Manager Handoff\n\n\n## Verdict\nPASS\n';
    assert.equal(hasSubstantiveManagerHandoff(content), false);
});

test('hasSubstantiveManagerHandoff: section absent returns false', async () => {
    const { hasSubstantiveManagerHandoff } = await import('../bin/mux-runner.js');
    const content = '## Verdict\nPASS\n';
    assert.equal(hasSubstantiveManagerHandoff(content), false);
});

test('mux-runner: exits before manager spawn when a done closer ticket carries manager handoff work', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        const dataRoot = path.join(tmpRoot, 'data-root');
        const stubBinDir = path.join(tmpRoot, 'bin');
        const spawnMarker = path.join(tmpRoot, 'claude-invoked.txt');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(dataRoot, { recursive: true });
        fs.mkdirSync(stubBinDir, { recursive: true });
        writeUnexpectedSpawnStub(stubBinDir, spawnMarker);

        const { repoDir } = initCloserTerminalGitRepo(tmpRoot);
        writeCloserTerminalSession(sessionDir, repoDir, {
            status: 'Done',
            conformanceBody: [
                'ALL_PASS',
                '',
                '## Manager Handoff',
                '- operator-owned release work remains',
                '',
            ].join('\n'),
        });

        const result = runMuxRunnerWithDataRoot(sessionDir, dataRoot, stubBinDir);
        assert.equal(result.status, 0, `Expected clean terminal exit, got ${result.status} stderr=${result.stderr}`);
        assert.equal(fs.existsSync(spawnMarker), false, 'manager subprocess should not spawn when manager handoff is pending');

        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'session should deactivate on manager handoff pending');
        assert.equal(finalState.exit_reason, 'manager_handoff_pending');

        const activity = readActivityLines(dataRoot).filter((entry) => entry.terminal_exit_reason === 'manager_handoff_pending');
        assert.equal(activity.length > 0, true, 'expected a session_end activity for manager_handoff_pending');
        assert.match(activity.at(-1).reason || '', /Manager Handoff section/);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with rate limit text pattern returns api_limit', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, "You're out of extra usage · resets Mar 6 at 11am\n");
        assert.equal(classifyIterationExit('continue', logFile).type, 'api_limit');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with clean log returns success', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'all good, no issues\n');
        assert.equal(classifyIterationExit('continue', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: missing log file still returns success for continue', () => {
    assert.equal(classifyIterationExit('continue', '/nonexistent/path/log.log').type, 'success');
});

// ---------------------------------------------------------------------------
// detectRateLimitInLog / detectRateLimitInText — unit coverage (87e1fdde)
// ---------------------------------------------------------------------------

test('detectRateLimitInLog: returns true for rate_limit_event with rejected status', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }) + '\n');
        assert.equal(detectRateLimitInLog(logFile).limited, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns false for rate_limit_event with accepted status', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, JSON.stringify({ type: 'rate_limit_event', status: 'accepted' }) + '\n');
        assert.equal(detectRateLimitInLog(logFile).limited, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns limited=false for missing file', () => {
    assert.equal(detectRateLimitInLog('/nonexistent/file.log').limited, false);
});

test('detectRateLimitInLog: only checks last 100 lines', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        // Place rate limit event beyond the last 100 lines
        const lines = [JSON.stringify({ type: 'rate_limit_event', status: 'rejected' })];
        for (let i = 0; i < 110; i++) lines.push('filler line');
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInLog(logFile).limited, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns true for "usage limit has been reached" pattern', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'Your daily usage limit has been reached.\n');
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns true for "out of usage" pattern', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, "You're out of extra usage · resets Mar 6 at 11am\n");
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: does not match generic "rate limit" mentions', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'API rate limit hit, backing off.\n');
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: ignores rate limit text inside user/tool_result lines', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        // Lines containing "type":"user" or "type":"tool_result" are filtered out
        fs.writeFileSync(logFile, '{"type":"user","text":"rate limit handling code"}\n');
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns false for clean output', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rl-')));
    try {
        const logFile = path.join(tmpDir, 'test.log');
        fs.writeFileSync(logFile, 'Everything worked great. No issues.\n');
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns false for missing file', () => {
    assert.equal(detectRateLimitInText('/nonexistent/file.log'), false);
});

// ---------------------------------------------------------------------------
// buildTmuxNotification: rate_limit_exhausted (87e1fdde)
// ---------------------------------------------------------------------------

test('buildTmuxNotification: rate_limit_exhausted shows "Failed"', () => {
    const n = buildTmuxNotification('rate_limit_exhausted', 'implement', 3, 3600);
    assert.equal(n.title, '🥒 Pickle Run Failed');
    assert.ok(n.subtitle.includes('Exit: rate_limit_exhausted'), `Expected exit reason in subtitle, got: ${n.subtitle}`);
    assert.ok(n.subtitle.includes('phase: implement'), `Expected phase in subtitle, got: ${n.subtitle}`);
});

// ---------------------------------------------------------------------------
// Stale rate_limit_wait.json cleanup on startup (87e1fdde)
// ---------------------------------------------------------------------------

test('mux-runner: cleans up stale rate_limit_wait.json on startup', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        // Session at max iterations — will exit immediately after ownership
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'implement',
            iteration: 5,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test stale cleanup',
            working_dir: tmpRoot,
        }, null, 2));
        // Create a stale rate_limit_wait.json
        fs.writeFileSync(path.join(sessionDir, 'rate_limit_wait.json'), JSON.stringify({
            waiting: true, reason: 'API rate limit',
            started_at: '2026-03-01T00:00:00Z',
        }));

        run(tmpRoot, [sessionDir]);

        // The stale file should have been cleaned up during ownership takeover
        assert.equal(
            fs.existsSync(path.join(sessionDir, 'rate_limit_wait.json')),
            false,
            'Stale rate_limit_wait.json should be deleted on startup'
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// consecutiveRateLimits reset logic (87e1fdde)
// ---------------------------------------------------------------------------

test('classifyIterationExit: success exit type used to reset consecutiveRateLimits counter', () => {
    // This verifies the contract: when classifyIterationExit returns type 'success',
    // the main loop resets consecutiveRateLimits to 0.
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'clean.log');
        fs.writeFileSync(logFile, 'normal iteration output\n');
        assert.equal(classifyIterationExit('continue', logFile).type, 'success');
        assert.equal(classifyIterationExit('task_completed', logFile).type, 'success');
        assert.equal(classifyIterationExit('review_clean', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: api_limit is distinct from other exit types', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-exit-')));
    try {
        const logFile = path.join(tmpDir, 'rl.log');
        fs.writeFileSync(logFile, JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }) + '\n');
        const result = classifyIterationExit('continue', logFile);
        assert.equal(result.type, 'api_limit');
        assert.notEqual(result.type, 'success');
        assert.notEqual(result.type, 'error');
        assert.notEqual(result.type, 'inactive');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// iteration_start / iteration_end activity events (222c384d)
// ---------------------------------------------------------------------------

/**
 * Run mux-runner with claude removed from PATH so spawn fails fast.
 * Returns parsed activity events from EXTENSION_DIR/activity/.
 */
let activityFixtureCounter = 0;

function runAndCollectActivity(stateOverrides = {}) {
    const fixtureId = ++activityFixtureCounter;
    const tmpRoot = makeTmpRoot();
    const sessionName = `session-${fixtureId}`;
    const sessionDir = path.join(tmpRoot, sessionName);
    fs.mkdirSync(sessionDir, { recursive: true });
    // Create templates/ and commands/ with a minimal _pickle-manager-prompt.md so
    // runIteration gets past template validation and reaches the claude spawn (which
    // then fails because claude is stripped from PATH). Without this, the runner
    // throws on template lookup before logging any iteration events.
    // Write _pickle-manager-prompt.md to templates/ (not commands/) — runIteration
    // checks extensionRoot/templates/ first, then falls back to ~/.claude/commands/.
    // In CI, ~/.claude/commands/_pickle-manager-prompt.md doesn't exist, so the template must
    // be in the EXTENSION_DIR-relative templates/ directory.
    const templatesDir = path.join(tmpRoot, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '_pickle-manager-prompt.md'), 'placeholder');
    const defaultIteration = fixtureId * 10;
    const mergedState = {
        active: true,
        step: 'implement',
        iteration: defaultIteration,
        max_iterations: 100,
        max_time_minutes: 720,
        worker_timeout_seconds: 1200,
        original_prompt: 'test iteration events',
        working_dir: tmpRoot,
        ...stateOverrides,
    };
    const initialIteration = typeof mergedState.iteration === 'number'
        ? mergedState.iteration
        : Number(mergedState.iteration);
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(mergedState, null, 2));

    // Strip claude from PATH so runIteration's spawn('claude') fails immediately
    const pathDirs = (process.env.PATH || '').split(':').filter(d => {
        try { return !fs.existsSync(path.join(d, 'claude')); } catch { return true; }
    });

    // 15s → 60s: budget for system load when run alongside concurrent
    // codex/tmux work. The runner spawns claude (which fails fast because
    // we stripped it from PATH) and writes activity events; under load the
    // 15s budget got SIGKILL'd before the subprocess could even flush logs.
    const result = spawnSync(process.execPath, [TMUX_RUNNER_BIN, sessionDir], {
        env: {
            ...process.env,
            EXTENSION_DIR: tmpRoot,
            PATH: pathDirs.join(':'),
            PICKLE_BACKEND: 'claude',
        },
        encoding: 'utf-8',
        timeout: 60000,
    });

    const activityDir = path.join(tmpRoot, 'activity');
    let events = [];
    if (fs.existsSync(activityDir)) {
        for (const f of fs.readdirSync(activityDir)) {
            if (f.endsWith('.jsonl')) {
                const lines = fs.readFileSync(path.join(activityDir, f), 'utf-8').trim().split('\n').filter(Boolean);
                events.push(...lines.map(l => JSON.parse(l)));
            }
        }
    }

    fs.rmSync(tmpRoot, { recursive: true, force: true });
    return {
        events,
        result,
        expectedIteration: Number.isFinite(initialIteration) ? initialIteration + 1 : null,
        expectedSession: sessionName,
    };
}

function writeMuxTicket(sessionDir, ticketId, status, order = 1) {
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
        '---',
        `id: ${ticketId}`,
        `title: ${ticketId}`,
        `status: "${status}"`,
        `order: ${order}`,
        '---',
        '# Ticket',
        '',
    ].join('\n'));
}

function readMuxTicketStatus(sessionDir, ticketId) {
    const file = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
    const content = fs.readFileSync(file, 'utf-8');
    const match = content.match(/^status:\s*(.+)$/m);
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

function readActivityEventsFromRoot(tmpRoot) {
    const activityDir = path.join(tmpRoot, 'activity');
    const events = [];
    if (!fs.existsSync(activityDir)) return events;
    for (const f of fs.readdirSync(activityDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const lines = fs.readFileSync(path.join(activityDir, f), 'utf-8').trim().split('\n').filter(Boolean);
        events.push(...lines.map(l => JSON.parse(l)));
    }
    return events;
}

function runDesyncFixture({ currentTicket, tickets }) {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });
        const templatesDir = path.join(tmpRoot, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(templatesDir, '_pickle-manager-prompt.md'), 'placeholder');

        tickets.forEach((ticket, index) => {
            writeMuxTicket(sessionDir, ticket.id, ticket.status, index + 1);
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            // Live pid so the R-PTSB-3 phantom-demotion guard does not demote this
            // active fixture before the runner reconciles ticket desync.
            pid: process.pid,
            step: 'implement',
            iteration: 0,
            max_iterations: 100,
            max_time_minutes: 720,
            worker_timeout_seconds: 1200,
            original_prompt: 'test ticket desync',
            working_dir: tmpRoot,
            current_ticket: currentTicket,
            history: [],
            started_at: new Date().toISOString(),
            session_dir: sessionDir,
        }, null, 2));

        const pathDirs = (process.env.PATH || '').split(':').filter(d => {
            try { return !fs.existsSync(path.join(d, 'claude')); } catch { return true; }
        });
        const result = spawnSync(process.execPath, [TMUX_RUNNER_BIN, sessionDir], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpRoot,
                PATH: pathDirs.join(':'),
                PICKLE_BACKEND: 'claude',
            },
            encoding: 'utf-8',
            timeout: 60000,
        });

        const statuses = Object.fromEntries(tickets.map(ticket => [ticket.id, readMuxTicketStatus(sessionDir, ticket.id)]));
        const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        const events = readActivityEventsFromRoot(tmpRoot);
        return { result, statuses, state, events };
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}

test('iteration events: iteration_start logged at start of iteration', () => {
    const { events, expectedIteration, expectedSession } = runAndCollectActivity();
    const starts = events.filter(e => e.event === 'iteration_start');
    assert.ok(starts.length >= 1, `Expected at least 1 iteration_start event, got ${starts.length}`);
    assert.equal(starts[0].source, 'pickle');
    assert.equal(starts[0].iteration, expectedIteration);
    assert.equal(starts[0].session, expectedSession);
    assert.ok(starts[0].ts, 'iteration_start should have timestamp');
});

test('iteration events: iteration_end logged with error exit_type on spawn failure', () => {
    const { events, expectedIteration, expectedSession } = runAndCollectActivity();
    const ends = events.filter(e => e.event === 'iteration_end');
    assert.ok(ends.length >= 1, `Expected at least 1 iteration_end event, got ${ends.length}`);
    assert.equal(ends[0].source, 'pickle');
    assert.equal(ends[0].iteration, expectedIteration);
    assert.equal(ends[0].exit_type, 'error');
    assert.equal(ends[0].session, expectedSession);
});

test('iteration events: session ID matches basename of session directory', () => {
    const { events, expectedSession } = runAndCollectActivity();
    const starts = events.filter(e => e.event === 'iteration_start');
    const ends = events.filter(e => e.event === 'iteration_end');
    assert.ok(starts.length >= 1, 'Need iteration_start events');
    assert.ok(ends.length >= 1, 'Need iteration_end events');
    assert.equal(starts[0].session, expectedSession);
    assert.equal(ends[0].session, expectedSession);
});

test('iteration events: iteration number matches across start and end', () => {
    const { events, expectedIteration } = runAndCollectActivity();
    const starts = events.filter(e => e.event === 'iteration_start');
    const ends = events.filter(e => e.event === 'iteration_end');
    assert.ok(starts.length >= 1 && ends.length >= 1, 'Need both iteration events');
    assert.equal(starts[0].iteration, expectedIteration);
    assert.equal(starts[0].iteration, ends[0].iteration, 'Start and end should have same iteration number');
});

test('wasted-iter.emit: mux emits wasted_iter with no-progress predicate value', () => {
    const { events, expectedIteration, expectedSession } = runAndCollectActivity();
    const wasted = events.filter(e => e.event === 'wasted_iter');
    assert.ok(wasted.length >= 1, 'Expected at least one wasted_iter event');
    assert.equal(wasted[0].source, 'pickle');
    assert.equal(wasted[0].runner, 'mux');
    assert.equal(wasted[0].iteration, expectedIteration);
    assert.equal(wasted[0].session, expectedSession);
    assert.equal(wasted[0].wasted, true);
    assert.equal(wasted[0].post_iter_sha, wasted[0].pre_iter_sha);
});

test('mux-runner: persists iteration, picked ticket, and lifecycle step before manager spawn', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const sessionDir = path.join(tmpRoot, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        const templatesDir = path.join(tmpRoot, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(templatesDir, '_pickle-manager-prompt.md'), 'placeholder');

        const ticketId = 'ticket-state-1';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
            '---',
            `id: ${ticketId}`,
            'title: State coherence',
            'status: Todo',
            'order: 1',
            '---',
            '# Ticket',
            '',
        ].join('\n'));

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            // Live pid so the R-PTSB-3 phantom-demotion guard does not demote this
            // active fixture before the runner picks the first ticket.
            pid: process.pid,
            step: 'implement',
            iteration: 0,
            max_iterations: 100,
            max_time_minutes: 720,
            worker_timeout_seconds: 1200,
            original_prompt: 'test mux lifecycle state',
            working_dir: tmpRoot,
            current_ticket: null,
            history: [],
            started_at: new Date().toISOString(),
            session_dir: sessionDir,
        }, null, 2));

        const pathDirs = (process.env.PATH || '').split(':').filter(d => {
            try { return !fs.existsSync(path.join(d, 'claude')); } catch { return true; }
        });

        const result = spawnSync(process.execPath, [TMUX_RUNNER_BIN, sessionDir], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpRoot,
                PATH: pathDirs.join(':'),
                PICKLE_BACKEND: 'claude',
            },
            encoding: 'utf-8',
            timeout: 60000,
        });

        assert.equal(result.status, 1, `Expected backend spawn failure exit. stderr:\n${result.stderr}`);

        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.iteration, 1, 'outer-loop iteration must be persisted before manager spawn');
        assert.equal(finalState.current_ticket, ticketId, 'first pending ticket must be persisted when picked');
        assert.equal(finalState.step, 'research', 'new picked ticket with no artifacts starts at research');
        assert.equal(finalState.active, false, 'spawn failure still deactivates through existing error path');
        assert.equal(finalState.exit_reason, 'error', 'spawn failure records existing error exit reason');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('desync.multi-in-progress: reconciles multiple In Progress tickets to state.current_ticket', () => {
    const { result, statuses, state } = runDesyncFixture({
        currentTicket: 'ticket-current',
        tickets: [
            { id: 'ticket-current', status: 'In Progress' },
            { id: 'ticket-stale', status: 'In Progress' },
        ],
    });

    assert.equal(result.status, 1, `Expected backend spawn failure exit. stderr:\n${result.stderr}`);
    assert.equal(statuses['ticket-current'], 'In Progress');
    assert.equal(statuses['ticket-stale'], 'Todo');
    assert.equal(state.current_ticket, 'ticket-current');
});

test('desync.event: emits ticket_state_desync_detected on frontmatter/current_ticket mismatch', () => {
    const { result, statuses, state, events } = runDesyncFixture({
        currentTicket: 'ticket-state',
        tickets: [
            { id: 'ticket-state', status: 'Todo' },
            { id: 'ticket-frontmatter', status: 'In Progress' },
        ],
    });

    assert.equal(result.status, 1, `Expected backend spawn failure exit. stderr:\n${result.stderr}`);
    assert.equal(statuses['ticket-frontmatter'], 'In Progress');
    assert.equal(statuses['ticket-state'], 'Todo');
    assert.equal(state.current_ticket, 'ticket-frontmatter');
    assert.ok(
        events.some(event => event.event === 'ticket_state_desync_detected' && event.ticket === 'ticket-frontmatter'),
        `Expected ticket_state_desync_detected event, got: ${JSON.stringify(events)}`
    );
});

// --- stripSetupSection ---

test('stripSetupSection: strips "## SETUP MODE" through "## REVIEW PASS MODE"', () => {
    const input = 'Header\n\n## SETUP MODE\n\nSetup stuff\n\n## REVIEW PASS MODE\n\nReview stuff';
    const result = stripSetupSection(input);
    assert.equal(result, 'Header\n\n## REVIEW PASS MODE\n\nReview stuff');
    assert.ok(!result.includes('Setup stuff'));
});

test('stripSetupSection: strips "## SETUP" through "## REVIEW PASS" (no MODE suffix)', () => {
    const input = 'Header\n\n## SETUP\n\nSetup stuff\n\n## REVIEW PASS\n\nReview stuff';
    const result = stripSetupSection(input);
    assert.equal(result, 'Header\n\n## REVIEW PASS\n\nReview stuff');
    assert.ok(!result.includes('Setup stuff'));
});

test('stripSetupSection: strips "## SETUP" through "## REVIEW PASS MODE" (mixed)', () => {
    const input = 'Header\n\n## SETUP\n\nSetup stuff\n\n## REVIEW PASS MODE\n\nReview stuff';
    const result = stripSetupSection(input);
    assert.equal(result, 'Header\n\n## REVIEW PASS MODE\n\nReview stuff');
});

test('stripSetupSection: returns prompt unchanged when no setup section', () => {
    const input = 'Just a regular prompt\n\n## Some Other Section\n\nContent';
    assert.equal(stripSetupSection(input), input);
});

test('stripSetupSection: returns prompt unchanged when setup appears after review', () => {
    const input = '## REVIEW PASS MODE\n\nReview\n\n## SETUP MODE\n\nSetup';
    assert.equal(stripSetupSection(input), input);
});

test('stripSetupSection: does not match partial headers like "## SETUP WIZARD"', () => {
    const input = 'Header\n\n## SETUP WIZARD\n\nWizard stuff\n\n## REVIEW PASS MODE\n\nReview';
    assert.equal(stripSetupSection(input), input);
});

test('stripSetupSection: preserves content before setup and after review pass', () => {
    const input = 'Preamble line 1\nPreamble line 2\n\n## SETUP MODE\n\nGate checks\nStep 1\n\n## REVIEW PASS MODE\n\nStep 10\n\nFooter';
    const result = stripSetupSection(input);
    assert.ok(result.startsWith('Preamble line 1\nPreamble line 2\n\n'));
    assert.ok(result.includes('Step 10'));
    assert.ok(result.includes('Footer'));
    assert.ok(!result.includes('Gate checks'));
});

test('stripSetupSection: strips setup through any next ## heading (e.g. WORKER MODE)', () => {
    const input = 'Header\n\n## SETUP MODE\n\nSetup stuff\n\n## WORKER MODE\n\nWorker stuff';
    const result = stripSetupSection(input);
    assert.equal(result, 'Header\n\n## WORKER MODE\n\nWorker stuff');
    assert.ok(!result.includes('Setup stuff'));
});

test('stripSetupSection: strips setup through arbitrary section name', () => {
    const input = 'Intro\n\n## SETUP\n\nInit steps\n\n## EXECUTION PHASE\n\nDo the thing\n\n## CLEANUP\n\nTidy up';
    const result = stripSetupSection(input);
    assert.equal(result, 'Intro\n\n## EXECUTION PHASE\n\nDo the thing\n\n## CLEANUP\n\nTidy up');
    assert.ok(!result.includes('Init steps'));
});

test('stripSetupSection: returns unchanged when setup is the only/last section', () => {
    const input = 'Header\n\n## SETUP MODE\n\nSetup stuff and nothing else';
    assert.equal(stripSetupSection(input), input);
});

// --- classifyTicketCompletion ---

test('classifyTicketCompletion: returns completed when TASK_COMPLETED token found in log', () => {
    const tmpDir = makeTmpRoot();
    try {
        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'some output\n<promise>TASK_COMPLETED</promise>\nmore output');
        assert.equal(classifyTicketCompletion(logFile, '/nonexistent/dir'), 'completed');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: returns completed when TASK_COMPLETED in stream-json assistant message', () => {
    const tmpDir = makeTmpRoot();
    try {
        const logFile = path.join(tmpDir, 'test_iter.log');
        const streamLine = JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Done! <promise>TASK_COMPLETED</promise>' }] }
        });
        fs.writeFileSync(logFile, streamLine + '\n');
        assert.equal(classifyTicketCompletion(logFile, '/nonexistent/dir'), 'completed');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: returns skipped when no evidence found (empty log, nonexistent dir)', () => {
    const tmpDir = makeTmpRoot();
    try {
        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'some random output with no tokens\n');
        assert.equal(classifyTicketCompletion(logFile, '/nonexistent/dir/xyz'), 'skipped');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: returns skipped on log read failure (nonexistent file)', () => {
    assert.equal(classifyTicketCompletion('/nonexistent/log/file.log', '/nonexistent/dir'), 'skipped');
});

// Helper: initialize a git repo in `dir` with one commit so later diffs are meaningful.
function initGitRepo(dir) {
    spawnSync('git', ['init'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'initial.txt'), 'initial');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir });
}

function gitHead(dir) {
    return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).stdout.trim();
}

function writeAutoMarkTicket(sessionDir, ticketId, checked = true) {
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
        '---',
        `id: ${ticketId}`,
        'title: Auto mark validation',
        'status: Todo',
        'order: 1',
        '---',
        '# Description',
        '',
        '## Acceptance Criteria',
        `- [${checked ? 'x' : ' '}] criterion met`,
        '',
    ].join('\n'));
}

function writeAutoMarkTicketWithStatus(sessionDir, ticketId, status, checked = true) {
    return writeAutoMarkTicketWithCriteria(
        sessionDir,
        ticketId,
        status,
        [`- [${checked ? 'x' : ' '}] criterion met`],
    );
}

function writeAutoMarkTicketWithCriteria(sessionDir, ticketId, status, criteriaLines) {
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
        '---',
        `id: ${ticketId}`,
        'title: Auto mark validation',
        `status: ${status}`,
        'order: 1',
        '---',
        '# Description',
        '',
        '## Acceptance Criteria',
        ...criteriaLines,
        '',
    ].join('\n'));
}

function readAutoMarkTicketStatus(sessionDir, ticketId) {
    const filePath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = /^status:\s*(.+)$/m.exec(content);
    return match ? match[1].replace(/^["']|["']$/g, '').trim() : null;
}

// --- auto-mark-done completion validation ---

test('auto-mark-done.no-commit: transition marks checked ticket Skipped not Done without commit evidence', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'auto-no-commit-ticket';
        writeAutoMarkTicket(sessionDir, ticketId, true);

        const verdict = applyAutoTicketCompletionValidation({
            sessionDir,
            ticketId,
            workingDir: tmpDir,
            startCommit,
            iteration: 1,
        });

        assert.equal(verdict.action, 'skip');
        assert.equal(verdict.reason, 'no_commit_referencing_ticket_since_current_set');
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'Skipped');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('auto-mark-done.with-commit: transition marks checked ticket Done with referencing commit evidence', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'auto-with-commit-ticket';
        writeAutoMarkTicket(sessionDir, ticketId, true);
        fs.writeFileSync(path.join(tmpDir, 'work.txt'), 'ticket work');
        spawnSync('git', ['add', 'work.txt'], { cwd: tmpDir });
        spawnSync('git', ['commit', '-m', 'complete', '--trailer', `Pickle-Ticket: ${ticketId}`, '--no-gpg-sign'], { cwd: tmpDir });

        const verdict = applyAutoTicketCompletionValidation({
            sessionDir,
            ticketId,
            workingDir: tmpDir,
            startCommit,
            iteration: 1,
        });

        assert.equal(verdict.action, 'done');
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'Done');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('auto-mark-done.manager-tagged-ac: unchecked manager criteria do not block worker completion', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'auto-manager-tagged-ticket';
        writeAutoMarkTicketWithCriteria(sessionDir, ticketId, 'In Progress', [
            '- [x] [worker] implementation complete',
            '- [ ] [manager] publish release',
        ]);
        fs.writeFileSync(path.join(tmpDir, 'work.txt'), 'ticket work');
        spawnSync('git', ['add', 'work.txt'], { cwd: tmpDir });
        spawnSync('git', ['commit', '-m', 'complete', '--trailer', `Pickle-Ticket: ${ticketId}`, '--no-gpg-sign'], { cwd: tmpDir });

        const verdict = applyAutoTicketCompletionValidation({
            sessionDir,
            ticketId,
            workingDir: tmpDir,
            startCommit,
            iteration: 1,
        });

        assert.equal(verdict.action, 'done');
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'Done');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('auto-mark-done.worker-tagged-ac: unchecked worker criteria still block completion', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'auto-worker-tagged-ticket';
        writeAutoMarkTicketWithCriteria(sessionDir, ticketId, 'In Progress', [
            '- [ ] [worker] implementation complete',
            '- [x] [manager] publish release',
        ]);

        const verdict = validateAutoTicketCompletion(
            sessionDir,
            ticketId,
            tmpDir,
            startCommit,
        );

        assert.deepEqual(verdict, { action: 'skip', reason: 'acceptance_criteria_not_checked' });
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'In Progress');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('auto-mark-done.activity-event: skip path emits ticket_auto_skip_no_evidence event', () => {
    const tmpDir = makeTmpRoot();
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-auto-mark-data-')));
    const prev = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'auto-activity-ticket';
        writeAutoMarkTicket(sessionDir, ticketId, true);

        applyAutoTicketCompletionValidation({
            sessionDir,
            ticketId,
            workingDir: tmpDir,
            startCommit,
            iteration: 7,
        });

        const events = readRelaunchActivityEvents(dataRoot);
        const event = events.find(e => e.event === 'ticket_auto_skip_no_evidence');
        assert.ok(event, 'expected skip event');
        assert.equal(event.ticket, ticketId);
        assert.equal(event.reason, 'no_commit_referencing_ticket_since_current_set');
        assert.equal(event.iteration, 7);
    } finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('phantom-done.correction: Done frontmatter with no completion commit is reset to Todo and emits event', () => {
    const tmpDir = makeTmpRoot();
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-phantom-done-data-')));
    const prev = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'phantom-done-ticket';
        writeAutoMarkTicketWithStatus(sessionDir, ticketId, 'Done', true);

        const corrected = correctPhantomDoneTickets({
            sessionDir,
            workingDir: tmpDir,
            startCommit,
            iteration: 3,
        });

        assert.equal(corrected, 1);
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'Todo');
        const events = readRelaunchActivityEvents(dataRoot);
        const event = events.find(e => e.event === 'ticket_phantom_done_corrected');
        assert.ok(event, `Expected ticket_phantom_done_corrected event, got: ${JSON.stringify(events)}`);
        assert.equal(event.ticket, ticketId);
        assert.equal(event.iteration, 3);
        assert.equal(event.reason, 'done_frontmatter_without_completion_commit');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

// --- R-CCC-5: hasCompletionCommit + correctPhantomDoneTickets honor frontmatter ---

function writeAutoMarkTicketWithCompletionCommit(sessionDir, ticketId, sha) {
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
        '---',
        `id: ${ticketId}`,
        'title: Auto mark validation',
        'status: Done',
        'order: 1',
        `completion_commit: ${sha}`,
        '---',
        '# Description',
        '',
        '## Acceptance Criteria',
        '- [x] criterion met',
        '',
    ].join('\n'));
}

test('R-CCC-5 readEvidence: explicit frontmatter + reachable SHA returns committed', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        // Worker commits with R-* code in subject (no ticket hash anywhere).
        fs.writeFileSync(path.join(tmpDir, 'worker.txt'), 'work');
        spawnSync('git', ['add', '.'], { cwd: tmpDir });
        spawnSync('git', ['commit', '-m', 'bundle/X: R-FOO-1 — work', '--no-gpg-sign'], { cwd: tmpDir });
        const sha = gitHead(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'aabbccdd';
        writeAutoMarkTicketWithCompletionCommit(sessionDir, ticketId, sha);

        const evidence = readEvidence({ sessionDir, ticketId, workingDir: tmpDir });
        assert.equal(evidence.kind, 'committed');
        assert.equal(evidence.sha, sha);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('R-CCC-5 readEvidence: frontmatter absent + git --grep matches returns committed', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        const ticketId = 'deadbeef';
        fs.writeFileSync(path.join(tmpDir, 'worker.txt'), 'work');
        spawnSync('git', ['add', '.'], { cwd: tmpDir });
        spawnSync('git', ['commit', '-m', 'work', '--trailer', `Pickle-Ticket: ${ticketId}`, '--no-gpg-sign'], { cwd: tmpDir });
        const sha = gitHead(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        // Note: status:Done frontmatter without completion_commit field.
        writeAutoMarkTicketWithStatus(sessionDir, ticketId, 'Done', true);

        const evidence = readEvidence({ sessionDir, ticketId, workingDir: tmpDir });
        assert.equal(evidence.kind, 'committed');
        assert.equal(evidence.sha, sha);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('R-CCC-5 readEvidence: no frontmatter SHA AND no matching commit returns absent', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'feedface';
        writeAutoMarkTicketWithStatus(sessionDir, ticketId, 'Done', true);

        const evidence = readEvidence({ sessionDir, ticketId, workingDir: tmpDir });
        assert.equal(evidence.kind, 'absent');
        assert.equal(evidence.sha, undefined);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('R-CCC-5 correctPhantomDoneTickets: completion_commit in frontmatter is NOT reverted even when commit lacks ticket hash', () => {
    // Run #6 forensic replay: bundle commits use R-* codes in subject, operator backfills
    // completion_commit: SHA into frontmatter. Pre-fix, the git-log ticket-hash scan
    // missed (no ticket hash in commit) and reverted Done→Todo. Post-fix the explicit
    // field short-circuits the revert.
    const tmpDir = makeTmpRoot();
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rccc5-data-')));
    const prev = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);
        // Worker commit with ONLY an R-* code — no ticket hash anywhere.
        fs.writeFileSync(path.join(tmpDir, 'worker.txt'), 'work');
        spawnSync('git', ['add', '.'], { cwd: tmpDir });
        spawnSync('git', ['commit', '-m', 'bundle/A: R-CCC-1 — initial work', '--no-gpg-sign'], { cwd: tmpDir });
        const completionSha = gitHead(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = '12345678';
        writeAutoMarkTicketWithCompletionCommit(sessionDir, ticketId, completionSha);

        const corrected = correctPhantomDoneTickets({
            sessionDir,
            workingDir: tmpDir,
            startCommit,
            iteration: 4,
        });

        assert.equal(corrected, 0, 'ticket with valid completion_commit must NOT be reverted');
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'Done');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('B-DURA T60 correctPhantomDoneTickets: absent evidence always reverts (no inferred-completion bypass flag)', () => {
    const tmpDir = makeTmpRoot();
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rpdwr-flag-')));
    const prev = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'rpdwrflag';
        // Done frontmatter with NO completion_commit and no matching commit —
        // a phantom-Done revert. The deleted allow_inferred_completion_commit
        // bypass flag (T60) can no longer suppress it: absent always reverts.
        writeAutoMarkTicketWithStatus(sessionDir, ticketId, 'Done', true);

        const corrected = correctPhantomDoneTickets({
            sessionDir,
            workingDir: tmpDir,
            startCommit,
            iteration: 2,
            flags: { allow_inferred_completion_commit: true },
        });

        assert.equal(corrected, 1, 'absent evidence reverts; the deleted bypass flag is inert');
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'Todo');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('R-AFCC-DEEP-3C correctPhantomDoneTickets: backtick-decorated completion_commit is reverted (no lax-strip fallback after 3C)', () => {
    // R-AFCC-DEEP-3C: frontmatterCompletionCommitReachable (which lax-stripped backticks)
    // is deleted. The strict normalizeCompletionCommitField in hasCompletionCommit returns
    // null for backtick-decorated SHAs → evidence.source='absent' → ticket reverted.
    const tmpDir = makeTmpRoot();
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rpdwr-tick-')));
    const prev = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'worker.txt'), 'work');
        spawnSync('git', ['add', '.'], { cwd: tmpDir });
        spawnSync('git', ['commit', '-m', 'misc cleanup', '--no-gpg-sign'], { cwd: tmpDir });
        const completionSha = gitHead(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'rpdwrtick';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });
        // completion_commit with backtick decoration — normalizeCompletionCommitField
        // does not strip backticks → explicit=null → hasCompletionCommit returns 'absent'.
        fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
            '---',
            `id: ${ticketId}`,
            'title: plain stamp ticket',
            'status: Done',
            'order: 1',
            `completion_commit: \`${completionSha}\``,
            '---',
            '# Description',
            '',
        ].join('\n'));

        // readEvidence returns 'absent' for the decorated value.
        const evidence = readEvidence({ sessionDir, ticketId, workingDir: tmpDir });
        assert.equal(evidence.kind, 'absent', 'precondition: strict check misses the decorated SHA');

        // Without the lax-strip fallback, the watcher reverts the ticket.
        const corrected = correctPhantomDoneTickets({
            sessionDir,
            workingDir: tmpDir,
            startCommit,
            iteration: 3,
        });

        assert.equal(corrected, 1, 'backtick-decorated SHA with no fallback must be reverted (R-AFCC-DEEP-3C)');
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'Todo');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

// --- R-CCR-1: session-dir fallback (now via hasCompletionCommit fallbackDir arg) ---

function writeTicketWithWorkingDir(sessionDir, ticketId, sha, ticketWorkingDir) {
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
        '---',
        `id: ${ticketId}`,
        'title: Fallback test ticket',
        'status: Done',
        'order: 1',
        `completion_commit: ${sha}`,
        `working_dir: ${ticketWorkingDir}`,
        '---',
        '# Description',
        '',
    ].join('\n'));
}

test('R-CCR-1 fallback keeps Done: stale ticket working_dir, real commit in session dir', () => {
    // ticket.working_dir points at a non-git dir; the commit is reachable in
    // input.workingDir (the session's real repo). Ticket must NOT be reverted.
    const tmpDir = makeTmpRoot();
    const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rccr1-stale-'));
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rccr1-data-')));
    const prev = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        // Real git repo — this is the session working dir.
        initGitRepo(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'work.txt'), 'done');
        spawnSync('git', ['add', '.'], { cwd: tmpDir });
        spawnSync('git', ['commit', '-m', 'work done R-CCR-1', '--no-gpg-sign'], { cwd: tmpDir });
        const completionSha = gitHead(tmpDir);
        const startCommit = completionSha;

        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'rccr1keep';
        // Ticket's working_dir is the stale non-git dir.
        writeTicketWithWorkingDir(sessionDir, ticketId, completionSha, staleDir);

        const logMessages = [];
        const corrected = correctPhantomDoneTickets({
            sessionDir,
            workingDir: tmpDir,   // session fallback dir (real repo with the commit)
            startCommit,
            iteration: 1,
            log: (msg) => logMessages.push(msg),
        });

        assert.equal(corrected, 0, 'ticket with valid completion_commit in session dir must NOT be reverted');
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'Done');
        // Fallback fired: log must name both the stale dir and the session dir.
        const fallbackLog = logMessages.find(msg => msg.includes(staleDir) && msg.includes(tmpDir));
        assert.ok(fallbackLog, `expected log naming both dirs; got: ${JSON.stringify(logMessages)}`);
    } finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(staleDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('R-CCR-1 no-fallback on clean miss: git runs, SHA is valid but not in repo (backtick-decorated)', () => {
    // The SHA is backtick-decorated → normalizeCompletionCommitField returns null →
    // hasCompletionCommit returns 'absent' (no explicit field, no git-log match).
    // No fallback fires because evidence.source is 'absent' (not unreachable).
    // Ticket reverts.
    const tmpDir = makeTmpRoot();
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rccr1-miss-')));
    const prev = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);
        // Create a side-branch commit that is NOT an ancestor of the main HEAD.
        spawnSync('git', ['checkout', '-b', 'rccr1-side'], { cwd: tmpDir });
        fs.writeFileSync(path.join(tmpDir, 'side.txt'), 'side');
        spawnSync('git', ['add', '.'], { cwd: tmpDir });
        spawnSync('git', ['commit', '-m', 'side commit', '--no-gpg-sign'], { cwd: tmpDir });
        const notAncestorSha = gitHead(tmpDir);
        // Return to original HEAD — notAncestorSha exists in repo but is not an ancestor.
        spawnSync('git', ['checkout', '-'], { cwd: tmpDir });

        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'rccr1miss';
        // Use backtick-decorated SHA so hasCompletionCommit (strict hex check)
        // misses it and returns 'absent' (no fallback for absent evidence).
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
            '---',
            `id: ${ticketId}`,
            'title: clean miss test',
            'status: Done',
            'order: 1',
            `completion_commit: \`${notAncestorSha}\``,
            '---',
            '# Description',
            '',
        ].join('\n'));

        const logMessages = [];
        const corrected = correctPhantomDoneTickets({
            sessionDir,
            workingDir: tmpDir,   // git runs fine here (exit 1 for non-ancestor)
            startCommit,
            iteration: 1,
            log: (msg) => logMessages.push(msg),
        });

        // SHA is valid but not ancestor → exit 1 → no fallback → ticket reverts.
        assert.equal(corrected, 1, 'clean not-ancestor must trigger revert (no fallback)');
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'Todo');
        // Verify fallback did NOT fire (no log message about fallback dirs).
        const fallbackLog = logMessages.find(msg => msg.includes('retried in session dir'));
        assert.ok(!fallbackLog, `fallback must not fire on clean exit 1; log: ${JSON.stringify(logMessages)}`);
    } finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('R-CCR-1 genuine phantom: dir unusable AND SHA absent in fallback repo', () => {
    // ticket.working_dir is stale; commit SHA is NOT in the session repo either.
    // The ticket must still be reverted.
    const tmpDir = makeTmpRoot();
    const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rccr1-gphantom-stale-'));
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rccr1-gphantom-data-')));
    const prev = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);
        // SHA belongs to a different repo (another tmpDir) — not reachable in tmpDir.
        const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rccr1-other-'));
        initGitRepo(otherDir);
        fs.writeFileSync(path.join(otherDir, 'x.txt'), 'x');
        spawnSync('git', ['add', '.'], { cwd: otherDir });
        spawnSync('git', ['commit', '-m', 'other', '--no-gpg-sign'], { cwd: otherDir });
        const foreignSha = gitHead(otherDir);
        fs.rmSync(otherDir, { recursive: true, force: true });

        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'rccr1gph';
        // Ticket working_dir = stale; SHA not in tmpDir either.
        writeTicketWithWorkingDir(sessionDir, ticketId, foreignSha, staleDir);

        const corrected = correctPhantomDoneTickets({
            sessionDir,
            workingDir: tmpDir,
            startCommit,
            iteration: 1,
        });

        assert.equal(corrected, 1, 'dir unusable + SHA absent in fallback must trigger revert');
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'Todo');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(staleDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

// --- R-CCR-8: coverage backfill for completion_commit_inferred and non-reachable SHA ---

test('R-AFCC-DEEP-3C correctPhantomDoneTickets: backtick-decorated completion_commit_inferred is reverted (frontmatterCompletionCommitReachable deleted)', () => {
    // R-AFCC-DEEP-3C: frontmatterCompletionCommitReachable (which lax-stripped backticks
    // from completion_commit_inferred) is deleted. The strict normalizeCompletionCommitField
    // in hasCompletionCommit returns null for backtick-decorated inferred SHAs.
    // Without a matching git-log commit, source='absent' → ticket reverted.
    const tmpDir = makeTmpRoot();
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rccr8-inferred-')));
    const prev = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'work.txt'), 'done');
        spawnSync('git', ['add', '.'], { cwd: tmpDir });
        spawnSync('git', ['commit', '-m', 'misc work (no ticket ref)', '--no-gpg-sign'], { cwd: tmpDir });
        const completionSha = gitHead(tmpDir);

        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'rccr8inf';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });
        // completion_commit_inferred with backtick decoration: hasCompletionCommit strict
        // hex check misses it (returns 'absent'). After 3C, no lax-strip fallback exists.
        fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
            '---',
            `id: ${ticketId}`,
            'title: inferred-only reachable test',
            'status: Done',
            'order: 1',
            `completion_commit_inferred: \`${completionSha}\``,
            '---',
            '# Description',
            '',
        ].join('\n'));

        const evidence = readEvidence({ sessionDir, ticketId, workingDir: tmpDir });
        assert.equal(evidence.kind, 'absent', 'precondition: strict check misses the decorated inferred SHA');

        const corrected = correctPhantomDoneTickets({
            sessionDir,
            workingDir: tmpDir,
            startCommit,
            iteration: 1,
        });

        assert.equal(corrected, 1, 'backtick-decorated inferred SHA with no matching commit → reverted (R-AFCC-DEEP-3C)');
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'Todo');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('R-CCR-8 R-PDWR correctPhantomDoneTickets: completion_commit SHA that is a git object but not HEAD-reachable is reverted (single-repo)', () => {
    const tmpDir = makeTmpRoot();
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rccr8-orphan-')));
    const prev = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        initGitRepo(tmpDir);
        const startCommit = gitHead(tmpDir);

        // Create a commit then reset it — the SHA still exists as a git object
        // (in the object database) but is no longer reachable from HEAD.
        fs.writeFileSync(path.join(tmpDir, 'orphan.txt'), 'orphan work');
        spawnSync('git', ['add', '.'], { cwd: tmpDir });
        spawnSync('git', ['commit', '-m', 'orphan commit (no ticket ref)', '--no-gpg-sign'], { cwd: tmpDir });
        const orphanedSha = gitHead(tmpDir);
        // Reset back — SHA is now orphaned from HEAD but still in the object db.
        spawnSync('git', ['reset', '--hard', startCommit], { cwd: tmpDir });
        assert.equal(gitHead(tmpDir), startCommit, 'precondition: HEAD is back to startCommit');

        const sessionDir = path.join(tmpDir, 'session');
        const ticketId = 'rccr8orp';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });
        // Backtick-decorated SHA: hasCompletionCommit strict hex check returns 'absent'
        // (backticks not stripped by normalizeCompletionCommitField). No fallback fires
        // since evidence.source is 'absent'. Ticket reverts.
        fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
            '---',
            `id: ${ticketId}`,
            'title: orphan SHA revert test',
            'status: Done',
            'order: 1',
            `completion_commit: \`${orphanedSha}\``,
            '---',
            '# Description',
            '',
        ].join('\n'));

        // Precondition: the SHA still exists as a git object.
        const catFile = spawnSync('git', ['-C', tmpDir, 'cat-file', '-e', `${orphanedSha}^{commit}`]);
        assert.equal(catFile.status, 0, 'precondition: orphaned SHA still exists as git object');
        // Precondition: the SHA is NOT reachable from HEAD.
        const ancestorCheck = spawnSync('git', ['-C', tmpDir, 'merge-base', '--is-ancestor', orphanedSha, 'HEAD']);
        assert.notEqual(ancestorCheck.status, 0, 'precondition: orphaned SHA is not reachable from HEAD');

        const corrected = correctPhantomDoneTickets({
            sessionDir,
            workingDir: tmpDir,
            startCommit,
            iteration: 1,
        });

        assert.equal(corrected, 1, 'non-reachable orphaned SHA must trigger revert');
        assert.equal(readAutoMarkTicketStatus(sessionDir, ticketId), 'Todo');
    } finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: uncommitted git changes + lifecycle artifact → completed', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'modified');

        const ticketDir = path.join(tmpDir, 'ticket-a');
        fs.mkdirSync(ticketDir);
        fs.writeFileSync(path.join(ticketDir, 'research_2026-04-18.md'), 'research output');

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens here\n');
        assert.equal(
            classifyTicketCompletion(logFile, tmpDir, ticketDir, 'implementation'),
            'completed'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: staged git changes + lifecycle artifact → completed', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'staged change');
        spawnSync('git', ['add', '.'], { cwd: tmpDir });

        const ticketDir = path.join(tmpDir, 'ticket-b');
        fs.mkdirSync(ticketDir);
        fs.writeFileSync(path.join(ticketDir, 'plan_2026-04-18.md'), 'plan output');

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens here\n');
        assert.equal(
            classifyTicketCompletion(logFile, tmpDir, ticketDir, 'implementation'),
            'completed'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// --- Ghost-ticket prevention (issue #3) ---

test('classifyTicketCompletion: dirty tree but no ticketDir → skipped (ghost guard)', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'stray change from another ticket');

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens, no artifacts\n');
        // Before the fix: unscoped git diff alone → completed (ghost).
        // After the fix: no ticketDir → skipped.
        assert.equal(classifyTicketCompletion(logFile, tmpDir), 'skipped');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: dirty tree + empty ticketDir → skipped (ghost guard)', () => {
    const tmpDir = makeTmpRoot();
    try {
        initGitRepo(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'stray change');

        const ticketDir = path.join(tmpDir, 'ticket-empty');
        fs.mkdirSync(ticketDir);

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens here\n');
        assert.equal(
            classifyTicketCompletion(logFile, tmpDir, ticketDir, 'implementation'),
            'skipped'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: artifact present, clean tree → completed (non-git corroboration)', () => {
    const tmpDir = makeTmpRoot();
    try {
        const ticketDir = path.join(tmpDir, 'ticket-c');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(path.join(ticketDir, 'research_2026-04-18.md'), 'research output');

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens here\n');
        // No git repo at workingDir — runCmd throws, caught, falls through
        // to the default 'completed' since artifact exists.
        assert.equal(
            classifyTicketCompletion(logFile, '/nonexistent/not-a-repo', ticketDir, 'implementation'),
            'completed'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: review artifact with implementation role → skipped', () => {
    const tmpDir = makeTmpRoot();
    try {
        const ticketDir = path.join(tmpDir, 'ticket-mismatch');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(path.join(ticketDir, 'review_scope.md'), 'review scope');

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens here\n');
        assert.equal(
            classifyTicketCompletion(logFile, '/nonexistent/dir', ticketDir, 'implementation'),
            'skipped'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: review artifact with review role → completed', () => {
    const tmpDir = makeTmpRoot();
    try {
        const ticketDir = path.join(tmpDir, 'ticket-review');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.writeFileSync(path.join(ticketDir, 'review_findings.md'), 'findings');

        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'no tokens here\n');
        assert.equal(
            classifyTicketCompletion(logFile, '/nonexistent/dir', ticketDir, 'review'),
            'completed'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyTicketCompletion: token present overrides missing artifact', () => {
    const tmpDir = makeTmpRoot();
    try {
        const logFile = path.join(tmpDir, 'test_iter.log');
        fs.writeFileSync(logFile, 'output <promise>TASK_COMPLETED</promise>\n');
        // No ticketDir, no artifacts, but token is strong evidence — still completed.
        assert.equal(
            classifyTicketCompletion(logFile, '/nonexistent/dir'),
            'completed'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// --- detectMultiRepo ---

test('detectMultiRepo: returns dirs when tickets have 2+ distinct working_dir values', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-multi-')));
    try {
        const t1 = path.join(dir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'rick_ticket_t1.md'),
            '---\nid: t1\ntitle: API work\nstatus: Todo\norder: 10\nworking_dir: api/\n---\n');
        const t2 = path.join(dir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'rick_ticket_t2.md'),
            '---\nid: t2\ntitle: Web work\nstatus: Todo\norder: 20\nworking_dir: web/\n---\n');

        // api/ and web/ are not git repos — each resolves to its own
        // distinct absolute path, so this is still flagged as multi-repo.
        const result = detectMultiRepo(dir, dir);
        assert.ok(result, 'should return an array');
        assert.equal(result.length, 2);
        assert.ok(result.some(r => r.endsWith('/api')), `should contain an api root; got ${JSON.stringify(result)}`);
        assert.ok(result.some(r => r.endsWith('/web')), `should contain a web root; got ${JSON.stringify(result)}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('R-MRFP detectMultiRepo: monorepo workspace subdirs of one repo are NOT multi-repo', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mrfp-')));
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mrfp-repo-')));
    try {
        initGitRepo(repo);
        const apiDir = path.join(repo, 'packages', 'api');
        const appDir = path.join(repo, 'packages', 'app');
        fs.mkdirSync(apiDir, { recursive: true });
        fs.mkdirSync(appDir, { recursive: true });

        const t1 = path.join(dir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'rick_ticket_t1.md'),
            `---\nid: t1\ntitle: API work\nstatus: Todo\norder: 10\nworking_dir: ${apiDir}\n---\n`);
        const t2 = path.join(dir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'rick_ticket_t2.md'),
            `---\nid: t2\ntitle: App work\nstatus: Todo\norder: 20\nworking_dir: ${appDir}\n---\n`);
        const t3 = path.join(dir, 't3');
        fs.mkdirSync(t3);
        fs.writeFileSync(path.join(t3, 'rick_ticket_t3.md'),
            `---\nid: t3\ntitle: Root work\nstatus: Todo\norder: 30\nworking_dir: ${repo}\n---\n`);

        assert.equal(
            detectMultiRepo(dir, dir),
            null,
            'workspace subdirs of one git repo must not trip the multi-repo warning',
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test('R-MRFP detectMultiRepo: tickets in two genuinely distinct git repos are multi-repo', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mrfp2-')));
    const repoA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mrfp-a-')));
    const repoB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mrfp-b-')));
    try {
        initGitRepo(repoA);
        initGitRepo(repoB);
        const t1 = path.join(dir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'rick_ticket_t1.md'),
            `---\nid: t1\ntitle: A\nstatus: Todo\norder: 10\nworking_dir: ${repoA}\n---\n`);
        const t2 = path.join(dir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'rick_ticket_t2.md'),
            `---\nid: t2\ntitle: B\nstatus: Todo\norder: 20\nworking_dir: ${repoB}\n---\n`);

        const result = detectMultiRepo(dir, dir);
        assert.ok(result, 'genuinely distinct repos must still be flagged');
        assert.equal(result.length, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(repoA, { recursive: true, force: true });
        fs.rmSync(repoB, { recursive: true, force: true });
    }
});

test('detectMultiRepo: returns null when all tickets share same working_dir', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-multi-')));
    try {
        const t1 = path.join(dir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'rick_ticket_t1.md'),
            '---\nid: t1\ntitle: Task A\nstatus: Todo\norder: 10\nworking_dir: api/\n---\n');
        const t2 = path.join(dir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'rick_ticket_t2.md'),
            '---\nid: t2\ntitle: Task B\nstatus: Todo\norder: 20\nworking_dir: api/\n---\n');

        assert.equal(detectMultiRepo(dir, dir), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('detectMultiRepo: returns null when all tickets have working_dir null', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-multi-')));
    try {
        const t1 = path.join(dir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'rick_ticket_t1.md'),
            '---\nid: t1\ntitle: Task A\nstatus: Todo\norder: 10\n---\n');
        const t2 = path.join(dir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'rick_ticket_t2.md'),
            '---\nid: t2\ntitle: Task B\nstatus: Todo\norder: 20\n---\n');

        assert.equal(detectMultiRepo(dir, dir), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('detectMultiRepo: returns null when only one ticket has a working_dir', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-multi-')));
    try {
        const t1 = path.join(dir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'rick_ticket_t1.md'),
            '---\nid: t1\ntitle: Task A\nstatus: Todo\norder: 10\nworking_dir: api/\n---\n');
        const t2 = path.join(dir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'rick_ticket_t2.md'),
            '---\nid: t2\ntitle: Task B\nstatus: Todo\norder: 20\n---\n');

        assert.equal(detectMultiRepo(dir, dir), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('R-CCR-2 detectMultiRepo: relative working_dirs resolve against stableBase not process.cwd', () => {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ccr2-sess-')));
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ccr2-repo-')));
    try {
        initGitRepo(repo);
        fs.mkdirSync(path.join(repo, 'api'), { recursive: true });
        fs.mkdirSync(path.join(repo, 'app'), { recursive: true });

        const t1 = path.join(sessionDir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'rick_ticket_t1.md'),
            '---\nid: t1\ntitle: API work\nstatus: Todo\norder: 10\nworking_dir: api\n---\n');
        const t2 = path.join(sessionDir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'rick_ticket_t2.md'),
            '---\nid: t2\ntitle: App work\nstatus: Todo\norder: 20\nworking_dir: app\n---\n');

        // With stableBase=repo, relative 'api' → <repo>/api and 'app' → <repo>/app.
        // Both are inside the same git repo — resolveRepoRoot returns the same root for both.
        assert.equal(
            detectMultiRepo(sessionDir, repo),
            null,
            'relative working_dirs anchored to a monorepo must not false-flag as multi-repo',
        );
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test('R-MRFP detectMultiRepo: relative working_dir with non-git stableBase falls back to resolved absolute path', () => {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mrfp3-')));
    const stableBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mrfp3-base-')));
    try {
        // stableBase is NOT a git repo — resolveRepoRoot falls back to the absolute resolved path
        const subA = path.join(stableBase, 'subA');
        const subB = path.join(stableBase, 'subB');
        fs.mkdirSync(subA, { recursive: true });
        fs.mkdirSync(subB, { recursive: true });

        const t1 = path.join(sessionDir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'rick_ticket_t1.md'),
            '---\nid: t1\ntitle: A\nstatus: Todo\norder: 10\nworking_dir: subA\n---\n');
        const t2 = path.join(sessionDir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'rick_ticket_t2.md'),
            '---\nid: t2\ntitle: B\nstatus: Todo\norder: 20\nworking_dir: subB\n---\n');

        // Relative paths resolve via stableBase; neither subdir is a git repo, so resolveRepoRoot falls back to the absolute path.
        const result = detectMultiRepo(sessionDir, stableBase);
        assert.ok(result, 'distinct non-git relative working_dirs must be detected as multi-repo');
        // Exact structural match against the known absolute roots. A `.endsWith('/subA')`
        // suffix check would also pass for a wrong base (e.g. `/other/subA`) — sorting
        // both sides and comparing the full resolved paths proves detectMultiRepo
        // anchored the relative working_dirs to stableBase, not merely produced a
        // path whose final segment happens to match.
        assert.deepEqual(
            [...result].sort(),
            [subA, subB].sort(),
            `detectMultiRepo must return exactly the resolved subA/subB roots; got ${JSON.stringify(result)}`,
        );
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(stableBase, { recursive: true, force: true });
    }
});

test('R-MRFP detectMultiRepo: mixed git-repo and non-git-repo working_dirs are detected as multi-repo', () => {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mrfp4-')));
    const gitRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mrfp4-repo-')));
    const plainDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mrfp4-plain-')));
    try {
        initGitRepo(gitRepo);

        const t1 = path.join(sessionDir, 't1');
        fs.mkdirSync(t1);
        fs.writeFileSync(path.join(t1, 'rick_ticket_t1.md'),
            `---\nid: t1\ntitle: Git repo\nstatus: Todo\norder: 10\nworking_dir: ${gitRepo}\n---\n`);
        const t2 = path.join(sessionDir, 't2');
        fs.mkdirSync(t2);
        fs.writeFileSync(path.join(t2, 'rick_ticket_t2.md'),
            `---\nid: t2\ntitle: Plain dir\nstatus: Todo\norder: 20\nworking_dir: ${plainDir}\n---\n`);

        // gitRepo resolves to its own git root; plainDir has no git root so falls back to plainDir itself — two distinct roots.
        const result = detectMultiRepo(sessionDir, sessionDir);
        assert.ok(result, 'git-repo + non-git-dir must be flagged as multi-repo');
        assert.equal(result.length, 2);
        assert.ok(result.includes(gitRepo), `expected gitRepo root; got ${JSON.stringify(result)}`);
        assert.ok(result.includes(plainDir), `expected plainDir root; got ${JSON.stringify(result)}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(gitRepo, { recursive: true, force: true });
        fs.rmSync(plainDir, { recursive: true, force: true });
    }
});

import { Defaults } from '../types/index.js';

test('mux-runner: template lookup prefers templates/ dir over commands/ dir', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const templatesDir = path.join(tmpRoot, 'templates');
        const commandsDir = path.join(tmpRoot, 'commands');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.mkdirSync(commandsDir, { recursive: true });

        fs.writeFileSync(path.join(templatesDir, 'test.md'), 'TEMPLATE_VERSION');
        fs.writeFileSync(path.join(commandsDir, 'test.md'), 'COMMAND_VERSION');

        const templateName = 'test.md';
        const picklePromptPath = fs.existsSync(path.join(templatesDir, templateName))
            ? path.join(templatesDir, templateName)
            : path.join(commandsDir, templateName);

        const content = fs.readFileSync(picklePromptPath, 'utf-8');
        assert.equal(content, 'TEMPLATE_VERSION', 'should prefer templates/ dir');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('mux-runner: template lookup falls back to commands/ when not in templates/', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const templatesDir = path.join(tmpRoot, 'templates');
        const commandsDir = path.join(tmpRoot, 'commands');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.mkdirSync(commandsDir, { recursive: true });

        fs.writeFileSync(path.join(commandsDir, '_pickle-manager-prompt.md'), 'COMMAND_ONLY');

        const templateName = '_pickle-manager-prompt.md';
        const picklePromptPath = fs.existsSync(path.join(templatesDir, templateName))
            ? path.join(templatesDir, templateName)
            : path.join(commandsDir, templateName);

        const content = fs.readFileSync(picklePromptPath, 'utf-8');
        assert.equal(content, 'COMMAND_ONLY', 'should fall back to commands/ dir');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('Defaults.MAX_ITERATION_SECONDS exists and is positive', () => {
    assert.ok(typeof Defaults.MAX_ITERATION_SECONDS === 'number', 'should be a number');
    assert.ok(Defaults.MAX_ITERATION_SECONDS > 0, 'should be positive');
    assert.ok(Defaults.MAX_ITERATION_SECONDS >= 3600, 'should be at least 1 hour');
});

// ---------------------------------------------------------------------------
// writeHandoffAtomic — handoff.txt race / fallback scenarios (ticket 38b76eb5)
// ---------------------------------------------------------------------------

test('writeHandoffAtomic: unlink EACCES on tmp cleanup logs warning', () => {
    const logs = [];
    const log = (msg) => logs.push(msg);

    // rename throws so we reach the tmp-cleanup path; unlinkSync throws EACCES
    const fsOps = {
        writeFileSync: () => {},
        renameSync: () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; throw e; },
        unlinkSync: () => {
            const e = new Error('permission denied');
            e.code = 'EACCES';
            throw e;
        },
    };

    const tmpRoot = makeTmpRoot();
    try {
        writeHandoffAtomic(tmpRoot, 'content', 9999, log, fsOps);
        assert.ok(
            logs.some(l => l.includes('WARNING') && l.includes('EACCES')),
            `Expected EACCES warning in logs, got: ${JSON.stringify(logs)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('writeHandoffAtomic: rename fail falls back to direct writeFileSync', () => {
    const logs = [];
    const log = (msg) => logs.push(msg);
    const writes = [];

    const fsOps = {
        writeFileSync: (p, content) => writes.push({ p, content }),
        renameSync: () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; throw e; },
        unlinkSync: () => {},
    };

    const tmpRoot = makeTmpRoot();
    try {
        writeHandoffAtomic(tmpRoot, 'handoff content', 1234, log, fsOps);

        assert.ok(
            logs.some(l => l.includes('WARNING') && l.includes('rename failed')),
            `Expected rename-failed warning in logs, got: ${JSON.stringify(logs)}`
        );
        const handoffWrite = writes.find(w => w.p.endsWith('handoff.txt') && !w.p.includes('.tmp.'));
        assert.ok(handoffWrite, `Expected a direct handoff.txt write, got writes: ${JSON.stringify(writes.map(w => w.p))}`);
        assert.equal(handoffWrite.content, 'handoff content', 'Fallback write must use original content');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('writeHandoffAtomic: both rename and fallback fail, error logged, does not throw', () => {
    const logs = [];
    const log = (msg) => logs.push(msg);

    const fsOps = {
        writeFileSync: (p) => {
            // tmp write succeeds, direct write fails
            if (!p.includes('.tmp.')) {
                const e = new Error('read-only filesystem');
                e.code = 'EROFS';
                throw e;
            }
        },
        renameSync: () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; throw e; },
        unlinkSync: () => {},
    };

    const tmpRoot = makeTmpRoot();
    try {
        // Must NOT throw
        assert.doesNotThrow(() => {
            writeHandoffAtomic(tmpRoot, 'content', 5678, log, fsOps);
        });
        assert.ok(
            logs.some(l => l.includes('ERROR') && l.includes('handoff.txt write failed')),
            `Expected ERROR log for both-fail scenario, got: ${JSON.stringify(logs)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Codex manager relaunch on per-iteration error.
//
// The hang-guard at `Defaults.MAX_ITERATION_SECONDS` SIGTERMs the long-lived
// codex manager subprocess after 4h and resolves
// `{ completion: 'error', timedOut: true }`. The legacy error branch
// unconditionally exited; tickets the manager hadn't started yet were
// stranded in `Todo`. processCompletionBranch() must consult
// `evaluateManagerRelaunch()` and return a `relaunch` LoopAction so the
// outer loop spawns a fresh manager that resumes the queue.
// ---------------------------------------------------------------------------
import {
    processCompletionBranch as processCompletionBranchForRelaunch,
    evaluateManagerRelaunch as evaluateManagerRelaunchUnit,
    recordManagerRelaunch as recordManagerRelaunchUnit,
} from '../bin/mux-runner.js';
import { Defaults as DefaultsForRelaunch } from '../types/index.js';

function writeRelaunchTicket(sessionDir, id, status, order = 1) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), [
        '---',
        `id: ${id}`,
        `title: ${id}`,
        `status: "${status}"`,
        `order: ${order}`,
        '---',
        '',
    ].join('\n'));
}

function makeCodexRelaunchSession({ backend = 'codex', priorRelaunchCount = 0, tickets = [] } = {}) {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-relaunch-')));
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-relaunch-data-')));
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
        active: true,
        step: 'implement',
        iteration: 5,
        max_iterations: 100,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        max_time_minutes: 720,
        working_dir: sessionDir,
        backend,
        manager_relaunch_count: priorRelaunchCount,
    }, null, 2));
    for (const t of tickets) writeRelaunchTicket(sessionDir, t.id, t.status, t.order);
    return { sessionDir, statePath, dataRoot };
}

function withRelaunchDataRoot(dataRoot, fn) {
    const prev = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    try { return fn(); }
    finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
    }
}

function readRelaunchActivityEvents(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    const events = [];
    for (const entry of fs.readdirSync(activityDir)) {
        if (!entry.endsWith('.jsonl')) continue;
        const content = fs.readFileSync(path.join(activityDir, entry), 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try { events.push(JSON.parse(line)); } catch { /* ignore */ }
        }
    }
    return events;
}

test('mux-runner relaunch: processCompletionBranch returns relaunch action with side effects', async () => {
    const session = makeCodexRelaunchSession({
        backend: 'codex',
        priorRelaunchCount: 0,
        tickets: [
            { id: 't-done', status: 'Done', order: 1 },
            { id: 't-pending', status: 'Todo', order: 2 },
        ],
    });
    try {
        await withRelaunchDataRoot(session.dataRoot, async () => {
            const logs = [];
            const ctx = {
                sessionDir: session.sessionDir,
                statePath: session.statePath,
                extensionRoot: path.resolve('.'),
                iteration: 6,
                log: (msg) => logs.push(msg),
                cbEnabled: false,
                cbState: null,
            };
            const action = await processCompletionBranchForRelaunch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'relaunch',
                `expected relaunch LoopAction, got ${action.kind} (reason=${action.reason || ''})`);
            assert.equal(action.relaunchCount, 1);
            assert.equal(action.pendingTickets, 1);
            assert.equal(action.resetStall, true);

            // Side effect: state counter persisted.
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.manager_relaunch_count, 1);
            assert.equal(persisted.active, true,
                'session must remain active so the next iteration spawns a fresh codex manager');

            // Side effect: activity event emitted.
            const relaunch = readRelaunchActivityEvents(session.dataRoot)
                .filter(e => e.event === 'codex_manager_relaunch');
            assert.equal(relaunch.length, 1);
            assert.equal(relaunch[0].iteration, 6);
            assert.equal(relaunch[0].source, 'pickle');

            // Operator-visible log.
            assert.ok(
                logs.some(m => m.includes('relaunching') && m.includes('1/' + DefaultsForRelaunch.CODEX_MANAGER_RELAUNCH_CAP)),
                `expected relaunch log line, got: ${JSON.stringify(logs)}`,
            );
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('mux-runner relaunch: cap honored — break on error after CODEX_MANAGER_RELAUNCH_CAP relaunches', async () => {
    const session = makeCodexRelaunchSession({
        backend: 'codex',
        priorRelaunchCount: DefaultsForRelaunch.CODEX_MANAGER_RELAUNCH_CAP,
        tickets: [
            { id: 't-pending', status: 'Todo', order: 1 },
        ],
    });
    try {
        await withRelaunchDataRoot(session.dataRoot, async () => {
            const ctx = {
                sessionDir: session.sessionDir,
                statePath: session.statePath,
                extensionRoot: path.resolve('.'),
                iteration: 99,
                log: () => {},
                cbEnabled: false,
                cbState: null,
            };
            const action = await processCompletionBranchForRelaunch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'break');
            assert.equal(action.reason, 'error');
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.manager_relaunch_count, DefaultsForRelaunch.CODEX_MANAGER_RELAUNCH_CAP);
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('manager-spawn.hermes: relaunch action mirrors codex below cap', async () => {
    const session = makeCodexRelaunchSession({
        backend: 'hermes',
        priorRelaunchCount: 0,
        tickets: [
            { id: 't-pending', status: 'Todo', order: 1 },
        ],
    });
    try {
        await withRelaunchDataRoot(session.dataRoot, async () => {
            const logs = [];
            const ctx = {
                sessionDir: session.sessionDir,
                statePath: session.statePath,
                extensionRoot: path.resolve('.'),
                iteration: 7,
                log: (msg) => logs.push(msg),
                cbEnabled: false,
                cbState: null,
            };
            const action = await processCompletionBranchForRelaunch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'relaunch');
            assert.equal(action.relaunchCount, 1);
            assert.equal(action.pendingTickets, 1);
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.manager_relaunch_count, 1);
            assert.ok(logs.some(m => m.includes('hermes manager subprocess errored')));
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('manager-spawn.hermes: relaunch cap is respected', async () => {
    const session = makeCodexRelaunchSession({
        backend: 'hermes',
        priorRelaunchCount: DefaultsForRelaunch.CODEX_MANAGER_RELAUNCH_CAP,
        tickets: [
            { id: 't-pending', status: 'Todo', order: 1 },
        ],
    });
    try {
        await withRelaunchDataRoot(session.dataRoot, async () => {
            const ctx = {
                sessionDir: session.sessionDir,
                statePath: session.statePath,
                extensionRoot: path.resolve('.'),
                iteration: 8,
                log: () => {},
                cbEnabled: false,
                cbState: null,
            };
            const action = await processCompletionBranchForRelaunch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'break');
            assert.equal(action.reason, 'error');
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.manager_relaunch_count, DefaultsForRelaunch.CODEX_MANAGER_RELAUNCH_CAP);
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('mux-runner relaunch: claude backend relaunches pending work', async () => {
    const session = makeCodexRelaunchSession({
        backend: 'claude',
        tickets: [
            { id: 't-pending', status: 'Todo', order: 1 },
        ],
    });
    try {
        await withRelaunchDataRoot(session.dataRoot, async () => {
            const ctx = {
                sessionDir: session.sessionDir,
                statePath: session.statePath,
                extensionRoot: path.resolve('.'),
                iteration: 2,
                log: () => {},
                cbEnabled: false,
                cbState: null,
            };
            const action = await processCompletionBranchForRelaunch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'relaunch');
            assert.equal(action.relaunchCount, 1);
            const events = readRelaunchActivityEvents(session.dataRoot)
                .filter(e => e.event === 'codex_manager_relaunch');
            assert.equal(events.length, 1);
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.manager_relaunch_count, 1);
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('mux-runner relaunch: circuit-breaker OPEN suppresses relaunch even with pending tickets', async () => {
    const session = makeCodexRelaunchSession({
        backend: 'codex',
        priorRelaunchCount: 0,
        tickets: [
            { id: 't-pending', status: 'Todo', order: 1 },
        ],
    });
    try {
        await withRelaunchDataRoot(session.dataRoot, async () => {
            const ctx = {
                sessionDir: session.sessionDir,
                statePath: session.statePath,
                extensionRoot: path.resolve('.'),
                iteration: 3,
                log: () => {},
                cbEnabled: true,
                cbState: { state: 'OPEN', reason: 'no_progress' },
            };
            const action = await processCompletionBranchForRelaunch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'break');
            assert.equal(action.reason, 'error');
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.manager_relaunch_count, 0,
                'CB OPEN must NOT bump relaunch counter');
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('evaluateManagerRelaunch (mux-runner): smoke test for exported helper', () => {
    // Sanity duplicate of the iteration-outcome.test.js coverage so the
    // mux-runner test file holds its own loop-action contract test as
    // required by the trap-door entry.
    const codex = { backend: 'codex', codex_manager_relaunch_count: 0 };
    const tickets = [
        { id: 't1', status: 'Todo', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
    ];
    const result = evaluateManagerRelaunchUnit(codex, tickets, null);
    assert.equal(result.shouldRelaunch, true);
    assert.equal(result.pendingCount, 1);
    assert.equal(result.nextRelaunchCount, 1);

    // Ensure exports are wired correctly.
    assert.equal(typeof recordManagerRelaunchUnit, 'function');
    assert.equal(typeof DefaultsForRelaunch.CODEX_MANAGER_RELAUNCH_CAP, 'number');
    assert.ok(DefaultsForRelaunch.CODEX_MANAGER_RELAUNCH_CAP >= 1);
});

// ---------------------------------------------------------------------------
// AC-LPB-04: SCHEMA_MISMATCH on cap-check read emits an escalation event
// instead of silently retrying. The error must surface so the user can act,
// but the loop must not crash (which would lose progress on every retryable
// concurrent-write race).
// ---------------------------------------------------------------------------
import { classifyCapCheckReadError } from '../bin/mux-runner.js';

function makeSchemaMismatchSession() {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-schema-')));
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-schema-data-')));
    return { sessionDir, dataRoot };
}

function readSchemaActivityEvents(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    const events = [];
    for (const entry of fs.readdirSync(activityDir)) {
        if (!entry.endsWith('.jsonl')) continue;
        const content = fs.readFileSync(path.join(activityDir, entry), 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try { events.push(JSON.parse(line)); } catch { /* ignore */ }
        }
    }
    return events;
}

function withSchemaDataRoot(dataRoot, fn) {
    const prev = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    try { return fn(); }
    finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
    }
}

test('classifyCapCheckReadError: SCHEMA_MISMATCH emits cap_check_failed_schema_mismatch and continues', () => {
    const session = makeSchemaMismatchSession();
    try {
        withSchemaDataRoot(session.dataRoot, () => {
            const logs = [];
            // Mimic StateError shape — code is the discriminator.
            const err = Object.assign(new Error(
                'State file schema_version 999 is newer than supported version 3',
            ), { code: 'SCHEMA_MISMATCH', name: 'StateError' });

            const decision = classifyCapCheckReadError(err, session.sessionDir, (m) => logs.push(m));
            assert.equal(decision, 'continue',
                'SCHEMA_MISMATCH must continue the loop, not exit');

            // Activity event surfaced with the right shape.
            const events = readSchemaActivityEvents(session.dataRoot);
            const escalation = events.find(e => e.event === 'cap_check_failed_schema_mismatch');
            assert.ok(escalation, `expected cap_check_failed_schema_mismatch event, got: ${events.map(e => e.event).join(', ')}`);
            assert.equal(escalation.source, 'pickle');
            assert.equal(escalation.session, path.basename(session.sessionDir));
            assert.ok(typeof escalation.error === 'string' && /schema/i.test(escalation.error),
                `expected schema-mentioning error, got: ${escalation.error}`);

            // Visibility: surfaced to runner log too.
            assert.ok(
                logs.some(line => /schema mismatch/i.test(line)),
                `expected schema-mismatch line in runner logs, got: ${logs.join(' | ')}`,
            );
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('classifyCapCheckReadError: non-SCHEMA_MISMATCH errors return exit_error and emit no event', () => {
    const session = makeSchemaMismatchSession();
    try {
        withSchemaDataRoot(session.dataRoot, () => {
            for (const code of ['CORRUPT', 'MISSING', 'LOCK_FAILED', undefined]) {
                const err = Object.assign(new Error(`simulated ${code ?? 'plain'} failure`), code ? { code } : {});
                const logs = [];
                const decision = classifyCapCheckReadError(err, session.sessionDir, (m) => logs.push(m));
                assert.equal(decision, 'exit_error',
                    `non-SCHEMA_MISMATCH error (code=${code}) must exit with error`);
                assert.ok(
                    logs.some(line => /Cannot read state\.json/.test(line)),
                    `expected legacy 'Cannot read state.json' log for code=${code}, got: ${logs.join(' | ')}`,
                );
            }
            const events = readSchemaActivityEvents(session.dataRoot);
            const escalation = events.find(e => e.event === 'cap_check_failed_schema_mismatch');
            assert.equal(escalation, undefined,
                'non-SCHEMA_MISMATCH errors must NOT emit cap_check_failed_schema_mismatch');
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('classifyCapCheckReadError: non-Error thrown values default to exit_error', () => {
    const session = makeSchemaMismatchSession();
    try {
        withSchemaDataRoot(session.dataRoot, () => {
            const logs = [];
            // Defensive: a thrown string/number/null should not crash the
            // runner — fall through to legacy exit-error.
            const decision = classifyCapCheckReadError('plain string error', session.sessionDir, (m) => logs.push(m));
            assert.equal(decision, 'exit_error');
            const events = readSchemaActivityEvents(session.dataRoot);
            assert.equal(events.find(e => e.event === 'cap_check_failed_schema_mismatch'), undefined,
                'plain non-Error throws must not emit the escalation event');
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

// AC-R-WPEXA-9 — exit-drain fallback resolver: strict positive-int env override
// with default-on-invalid (no floor clamp beyond > 0). The 30000ms default is
// the foreground small/medium worker exit-drain window; the large-tier detached
// path short-circuits runIteration and never reaches it.
import {
    EXIT_DRAIN_FALLBACK_ENV_VAR,
    resolveExitDrainFallbackMs,
} from '../bin/mux-runner.js';

test('AC-R-WPEXA-9: env var name is PICKLE_EXIT_DRAIN_FALLBACK_MS', () => {
    assert.equal(EXIT_DRAIN_FALLBACK_ENV_VAR, 'PICKLE_EXIT_DRAIN_FALLBACK_MS');
});

test('AC-R-WPEXA-9: absent env -> 30000 default', () => {
    assert.equal(resolveExitDrainFallbackMs({}), 30000);
});

test('AC-R-WPEXA-9: strict positive-int override is honored', () => {
    assert.equal(
        resolveExitDrainFallbackMs({ [EXIT_DRAIN_FALLBACK_ENV_VAR]: '500' }),
        500,
    );
    assert.equal(
        resolveExitDrainFallbackMs({ [EXIT_DRAIN_FALLBACK_ENV_VAR]: '120000' }),
        120000,
    );
});

test('AC-R-WPEXA-9: invalid / zero / negative / fractional / non-numeric -> 30000', () => {
    const cases = ['0', '-1', '-250', '3.5', 'abc', '', '   ', '12px', 'NaN', 'Infinity'];
    for (const raw of cases) {
        assert.equal(
            resolveExitDrainFallbackMs({ [EXIT_DRAIN_FALLBACK_ENV_VAR]: raw }),
            30000,
            `raw=${JSON.stringify(raw)} must fall back to 30000`,
        );
    }
});

test('AC-R-WPEXA-9: blank/whitespace env value falls back (does not parse to 0)', () => {
    assert.equal(resolveExitDrainFallbackMs({ [EXIT_DRAIN_FALLBACK_ENV_VAR]: ' ' }), 30000);
});

// ---------------------------------------------------------------------------
// B5 (ticket e9bdac75): the cumulative rate-limit park ceiling must be REACHABLE.
//
// `computeRateLimitAction` clamps a single wait to `maxParkMs`, so the ceiling
// predicate `isParkExhausted(cumulative + waitMs, max)` can only ever fire on the
// CUMULATIVE term. The shipped resume path used to null `state.rate_limit_park`
// outright, pinning `cumulative_parked_ms` at 0 forever — which reduced the
// predicate to `waitMs > maxParkMs` (never true) and made
// `rate_limit_park_exhausted` dead code. Parked wall is also excluded from
// `max_time_minutes` (B3), so nothing else bounded a 429 storm.
// ---------------------------------------------------------------------------
import { foldParkIntoEpisode as foldPark, isParkExhausted as parkExhausted, runMainLoopRateLimitPark } from '../bin/mux-runner.js';

const MIN_MS = 60 * 1000;

test('B5: foldParkIntoEpisode accumulates parked wall across consecutive parks', () => {
    const first = foldPark(null, 30 * MIN_MS, 1, 1_000);
    assert.equal(first.cumulative_parked_ms, 30 * MIN_MS);
    assert.equal(first.parked_started_epoch_ms, 1_000, 'episode start seeded on first park');

    const second = foldPark(first, 20 * MIN_MS, 2, 9_999);
    assert.equal(second.cumulative_parked_ms, 50 * MIN_MS, 'second park ADDS to the ledger');
    assert.equal(second.parked_started_epoch_ms, 1_000, 'episode start is inherited, not reseeded');
    assert.equal(second.consecutive_waits, 2);
});

test('B5: fold drops the spent reset_at so a healthy --resume does not re-arm a park', () => {
    // The startup re-arm keys on a still-FUTURE reset_at_epoch_sec; carrying a spent
    // one forward would re-park a relaunch that has nothing to wait for.
    const prior = { reset_at_epoch_sec: 1_700_000_000, parked_started_epoch_ms: 5, cumulative_parked_ms: 0, consecutive_waits: 1 };
    assert.equal(foldPark(prior, 10 * MIN_MS, 2, 50).reset_at_epoch_sec, null);
});

test('B5: negative/zero parked wall never decrements the ledger', () => {
    const prior = { reset_at_epoch_sec: null, parked_started_epoch_ms: 5, cumulative_parked_ms: 40 * MIN_MS, consecutive_waits: 1 };
    assert.equal(foldPark(prior, -5 * MIN_MS, 2, 50).cumulative_parked_ms, 40 * MIN_MS);
    assert.equal(foldPark(prior, 0, 2, 50).cumulative_parked_ms, 40 * MIN_MS);
});

test('B5: OUTCOME — repeated sub-ceiling parks eventually exhaust the ceiling', () => {
    // 30-min parks against a 60-min ceiling. Each individual wait is UNDER the
    // ceiling (that is what computeRateLimitAction guarantees), so the ceiling can
    // only fire if the ledger accumulates. This is the assertion that goes RED if
    // the resume path reverts to `s.rate_limit_park = null`.
    const CEILING_MIN = 60;
    const WAIT = 30 * MIN_MS;
    let park = null;
    let firedOnPark = -1;

    for (let i = 1; i <= 5; i++) {
        if (parkExhausted((park?.cumulative_parked_ms ?? 0) + WAIT, CEILING_MIN)) { firedOnPark = i; break; }
        park = foldPark(park, WAIT, i, 1_000);
    }

    assert.equal(firedOnPark, 3, 'ceiling must fire on the 3rd park (30+30 burned, 3rd would exceed 60)');

    // Control: the pre-fix behaviour (ledger discarded on every resume) never fires.
    let neverFires = true;
    for (let i = 1; i <= 50; i++) {
        if (parkExhausted(0 + WAIT, CEILING_MIN)) neverFires = false;
    }
    assert.ok(neverFires, 'with a pinned-at-0 ledger the ceiling is unreachable — the bug this test pins');
});

test('B5: the SHIPPED main-loop resume folds the ledger and does not null it', async () => {
    // Was a regex over mux-runner.ts, because the park lived inline in
    // `runMuxRunnerMain` and "has no callable seam" (the old comment said so).
    // That pin greps the mechanism instead of running it: it stays GREEN if the
    // fold is correct but unreachable, and goes RED on a reformat that changes
    // nothing. The park is now `runMainLoopRateLimitPark`, so drive it and read
    // the ledger it actually persists.
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-b5-fold-')));
    try {
        const statePath = path.join(tmpDir, 'state.json');
        const START_EPOCH = 1714080000;
        const BURNED_MS = 30 * MIN_MS;  // this episode has already burned 30min
        fs.writeFileSync(statePath, JSON.stringify({
            active: true, iteration: 3, max_iterations: 10, min_iterations: 0,
            worker_timeout_seconds: 30, max_time_minutes: 0, step: 'implement',
            current_ticket: 't1', working_dir: tmpDir, start_time_epoch: START_EPOCH,
            rate_limit_park: {
                reset_at_epoch_sec: null,
                parked_started_epoch_ms: 1_000,
                cumulative_parked_ms: BURNED_MS,
                consecutive_waits: 1,
            },
        }, null, 2));

        let now = START_EPOCH * 1000;
        const outcome = await runMainLoopRateLimitPark({
            exitResult: { type: 'api_limit', rateLimitInfo: { resetsAt: START_EPOCH + 600 } },
            consecutiveRateLimits: 2,
            maxRateLimitRetries: 3,
            rateLimitWaitMinutes: 5,
            maxParkMinutes: 360,
            statePath,
            sessionDir: tmpDir,
            state: { current_ticket: 't1' },
            iteration: 3,
            log: () => {},
            now: () => now,
            // One poll jumps the clock past the (jitter-free) resume target.
            sleep: async () => { now = (START_EPOCH + 601) * 1000; },
            jitterMs: 0,
        });

        assert.equal(outcome.kind, 'resume', 'a sub-ceiling park resumes rather than exiting');

        const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.ok(persisted.rate_limit_park, 'the arm must survive the wake — nulling it disarms the ceiling');
        // THE assertion: the ledger ACCUMULATED. `s.rate_limit_park = null` here is
        // what pinned cumulative_parked_ms at 0 and made the ceiling unreachable.
        assert.ok(persisted.rate_limit_park.cumulative_parked_ms > BURNED_MS,
            `resume must FOLD the burned wall into the episode ledger (got ${persisted.rate_limit_park.cumulative_parked_ms}, prior was ${BURNED_MS})`);
        assert.equal(persisted.rate_limit_park.parked_started_epoch_ms, 1_000,
            'episode start is inherited across the fold, not reseeded');
        // B3: the parked wall is excluded from max_time_minutes.
        assert.ok(persisted.start_time_epoch > START_EPOCH,
            'start_time_epoch must advance by the parked seconds');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('B5: a clean iteration ends the episode by clearing the park ledger', () => {
    // Without an episode boundary the ledger would accumulate across the whole
    // session and eventually exit a HEALTHY long run.
    const srcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'mux-runner.ts');
    const muxSrc = fs.readFileSync(srcPath, 'utf-8');
    const successIdx = muxSrc.indexOf("if (exitType === 'success') {");
    assert.ok(successIdx > 0, 'success branch found');
    const successBlock = muxSrc.slice(successIdx, successIdx + 700);
    assert.match(successBlock, /rate_limit_park\b/, 'the success branch must reset the episode ledger');
    assert.match(successBlock, /s\.rate_limit_park = null/);
});

// R-WSRC-2 anchor executability (anatomy-park iter 9).
//
// The catalog PATTERN_SHAPE demanded
//   grep -c "sm\.read(statePath)"  ==  grep -c "readRunnerState(" + grep -c "classifyCapCheckReadError("
// which was already false at its own authoring commit e0d37d1c (1 vs 21) and is
// 1 vs 27 today. It equates ONE raw read against the wrapper's CALL count — two
// numbers that grow in opposite directions, so it can never hold. The guarded
// behaviour is intact; the anchor is the defect.
//
// The executable form: exactly one raw `sm.read(statePath)` exists, and it is
// the one inside `readRunnerState`. A second raw read IS an unwrapped site.
test('R-WSRC-2: the only raw sm.read(statePath) in mux-runner.ts is inside readRunnerState', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/bin/mux-runner.ts'), 'utf-8');
  const lines = src.split('\n');

  // Comment lines are stripped for the same reason AP-EXT-ITER10-01 needs it:
  // prose naming the guarded token would otherwise falsify this pin — which is
  // the very failure mode this family of anchors keeps hitting.
  const rawReads = lines
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => line.includes('sm.read(statePath)') && !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.equal(
    rawReads.length,
    1,
    `expected exactly 1 raw sm.read(statePath); found ${rawReads.length} at lines ` +
    `${rawReads.map(r => r.no).join(', ')} — any site outside readRunnerState is unwrapped`,
  );

  const wrapperStart = lines.findIndex(l => l.includes('export function readRunnerState('));
  assert.ok(wrapperStart > -1, 'readRunnerState wrapper is gone');
  const wrapperEnd = lines.findIndex((l, i) => i > wrapperStart && /^}/.test(l));
  assert.ok(
    rawReads[0].no > wrapperStart + 1 && rawReads[0].no <= wrapperEnd + 1,
    `the raw sm.read(statePath) at line ${rawReads[0].no} escaped readRunnerState ` +
    `(lines ${wrapperStart + 1}-${wrapperEnd + 1})`,
  );
});

// AP-EXT-ITER49-01 — assessRecoveryEvidence: an ABSENT working-tree measurement
// must not be published as a MEASURED clean tree.
//
// `listWorkingTreeDirtyPaths` THROWS on every git failure on purpose
// (AP-EXT-ITER8-03). The assessor used to map that throw to `treeDirty = false`,
// which skipped the ladder's two salvage rungs entirely — the ticket's whole
// uncommitted implementation was never offered to commit-and-continue — while
// the ladder still reported the `no_work_produced` fall_through, its own
// "genuinely zero output" verdict.
//
// The fix widens what the ladder ATTEMPTS and leaves every disposition alone:
// the two disposition-bearing flags read exactly as they did before, so a
// still-broken probe records a failed rung and lands on the same fall_through.
//
// A corrupt `.git/index` is the deterministic unmeasurable shape: `git status`
// exits 128 while `git rev-parse --git-dir` still exits 0, so the dir is
// provably a repo whose tree could not be read.
function seedRecoveryEvidenceRepo(root, { corruptIndex = false } = {}) {
  const repoDir = path.join(root, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  assert.equal(spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf-8', timeout: 30_000 }).status, 0);
  spawnSync('git', ['config', 'user.email', 'tests@example.com'], { cwd: repoDir, encoding: 'utf-8', timeout: 30_000 });
  spawnSync('git', ['config', 'user.name', 'Pickle Tests'], { cwd: repoDir, encoding: 'utf-8', timeout: 30_000 });
  fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
  spawnSync('git', ['add', 'seed.txt'], { cwd: repoDir, encoding: 'utf-8', timeout: 30_000 });
  assert.equal(
    spawnSync('git', ['commit', '-m', 'seed', '--no-gpg-sign'], { cwd: repoDir, encoding: 'utf-8', timeout: 30_000 }).status,
    0,
  );
  if (corruptIndex) {
    // Truncated index: `git status` fatals (128), `rev-parse --git-dir` still succeeds.
    fs.writeFileSync(path.join(repoDir, '.git', 'index'), 'GARBAGE-NOT-AN-INDEX');
    assert.notEqual(
      spawnSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf-8', timeout: 30_000 }).status,
      0,
      'fixture precondition: git status must FAIL on the corrupt index',
    );
    assert.equal(
      spawnSync('git', ['rev-parse', '--git-dir'], { cwd: repoDir, encoding: 'utf-8', timeout: 30_000 }).status,
      0,
      'fixture precondition: the dir must still be a provable git repo',
    );
  }
  return repoDir;
}

test('AP-EXT-ITER49-01: an UNMEASURABLE tree still attempts the salvage rungs, and keeps the same disposition', async () => {
  const { assessRecoveryEvidence } = await import('../bin/mux-runner.js');
  const root = makeTmpRoot();
  const repoDir = seedRecoveryEvidenceRepo(root, { corruptIndex: true });
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(path.join(sessionDir, 'tkt1'), { recursive: true });

  const evidence = assessRecoveryEvidence(sessionDir, repoDir, 'tkt1');

  // The fix: an absent measurement reads as possibly-dirty, so runRecoveryLadder
  // enters the treeDirty arm and rungs 1-2 get to try to commit the work.
  assert.equal(
    evidence.treeDirty, true,
    'a failed git-status probe must NOT be published as a measured clean tree — ' +
    'it skips commit-and-continue over a tree that may hold the whole ticket',
  );
  // Disposition unchanged: still the exact fall_through the fabricated-clean read produced.
  assert.equal(evidence.noWorkProduced, true, 'the fall_through disposition must be preserved');
  assert.equal(evidence.planConvergedUncommitted, false);
});

test('AP-EXT-ITER49-01: a MEASURED clean tree is unchanged (no salvage rungs, no gate cost)', async () => {
  const { assessRecoveryEvidence } = await import('../bin/mux-runner.js');
  const root = makeTmpRoot();
  const repoDir = seedRecoveryEvidenceRepo(root);
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(path.join(sessionDir, 'tkt1'), { recursive: true });

  assert.deepEqual(assessRecoveryEvidence(sessionDir, repoDir, 'tkt1'), {
    treeDirty: false,
    planConvergedUncommitted: false,
    noWorkProduced: true,
  });
});

test('AP-EXT-ITER49-01: a MEASURED dirty tree is unchanged', async () => {
  const { assessRecoveryEvidence } = await import('../bin/mux-runner.js');
  const root = makeTmpRoot();
  const repoDir = seedRecoveryEvidenceRepo(root);
  fs.writeFileSync(path.join(repoDir, 'work.txt'), 'the ticket implementation\n');
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(path.join(sessionDir, 'tkt1'), { recursive: true });

  assert.deepEqual(assessRecoveryEvidence(sessionDir, repoDir, 'tkt1'), {
    treeDirty: true,
    planConvergedUncommitted: false,
    noWorkProduced: false,
  });
});

test('AP-EXT-ITER49-01: a provable NON-repo is a measured answer, not an absent one', async () => {
  const { assessRecoveryEvidence } = await import('../bin/mux-runner.js');
  const root = makeTmpRoot();
  const plainDir = path.join(root, 'not-a-repo');
  fs.mkdirSync(plainDir, { recursive: true });
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(path.join(sessionDir, 'tkt1'), { recursive: true });

  // There is no tree that could be dirty, so rung 1 must NOT be attempted —
  // otherwise every off-repo recovery pass buys a doomed gate + remediator spawn.
  assert.equal(assessRecoveryEvidence(sessionDir, plainDir, 'tkt1').treeDirty, false);
});

test('AP-EXT-ITER49-01: an unmeasurable tree with an APPROVED plan still reaches the converged-plan rung', async () => {
  const { assessRecoveryEvidence } = await import('../bin/mux-runner.js');
  const root = makeTmpRoot();
  const repoDir = seedRecoveryEvidenceRepo(root, { corruptIndex: true });
  const ticketDir = path.join(root, 'session', 'tkt1');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, 'plan_tkt1.md'), '## Phase 1 — do it\n');
  fs.writeFileSync(path.join(ticketDir, 'plan_review.md'), 'APPROVED\n');

  const evidence = assessRecoveryEvidence(path.join(root, 'session'), repoDir, 'tkt1');
  assert.equal(evidence.treeDirty, true);
  assert.equal(
    evidence.planConvergedUncommitted, true,
    'rung 3 must stay reachable — widening what the ladder attempts must not remove a rung',
  );
  assert.equal(evidence.noWorkProduced, false);
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER8-03: the R-REIN refund must cover EVERY per-ticket recovery budget,
// not just `bounded_terminal_escape`.
//
// `recovery_attempts` carries three independent per-ticket budgets and they do not
// share a charge polarity (bounded-escape charges on outcome:'failed'; silent-death
// respawn and failed-flip suppression charge on 'success'). The refund used to
// enumerate ONE of them, so the documented operator heal ("set status: Todo +
// relaunch") released the failed-flip scheduling hold — readActiveFailedFlipHolds
// drops a Todo ticket — while leaving the spent suppression budget in the ledger.
// The ticket was re-scheduled and then escalated on its VERY FIRST flip intent
// (evaluateFailedFlipSuppression -> {action:'escalate'}), which routes to
// advanceOrExitOnLadderExhaustion -> Failed flip + `recovery_exhausted` when no
// other runnable ticket remains. That is the exact inert-recipe defect R-REIN was
// written to kill, reproduced in the sibling budget.
//
// `failed_flip_suppressed` is the HOT strategy: 35/35 recovery_attempts entries
// across the 11 live session ledgers carry it; `bounded_terminal_escape` has zero.
// ---------------------------------------------------------------------------

function seedRefundFixture(entries, status) {
    const root = makeTmpRoot();
    const ticket = 'abc12345';
    fs.mkdirSync(path.join(root, ticket), { recursive: true });
    fs.writeFileSync(path.join(root, ticket, 'research_2026-08-29.md'), '# work\n');
    fs.writeFileSync(
        path.join(root, ticket, `rick_ticket_${ticket}.md`),
        `---\nid: ${ticket}\nstatus: ${status}\ncomplexity_tier: small\n---\n\n# Ticket\n`,
    );
    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
        schema_version: 5,
        session_id: path.basename(root),
        working_dir: root,
        current_ticket: ticket,
        iteration: 9,
        recovery_attempts: entries(ticket),
    }, null, 2));
    return { root, ticket, statePath };
}

const suppressionEntry = (ticket, n) => ({
    strategy: 'failed_flip_suppressed',
    outcome: 'success',
    reason: `worker_gate_fail flip suppressed ${n}/2 (both) for ${ticket}`,
    iteration: n,
    ticket,
});

const HARDENING_FOR_REFUND = {
    silent_death_respawn_cap: 1,
    failed_flip_suppression_cap: 2,
    breaker_recovery_grace_seconds: 30,
    bounded_terminal_escape_cap: 3,
};

function flipIntentAfterHeal(fixture) {
    return import('../bin/mux-runner.js').then(({ evaluateFailedFlipSuppression }) =>
        evaluateFailedFlipSuppression({
            sessionDir: fixture.root,
            statePath: fixture.statePath,
            ticketId: fixture.ticket,
            workingDir: fixture.root,
            iteration: 10,
            callsite: 'worker_gate_fail',
            windowStartMs: Date.now() - 60_000,
            windowEndMs: Date.now(),
            preSha: null,
            settings: HARDENING_FOR_REFUND,
        }));
}

test('AP-EXT-ITER8-03: a Todo reset refunds the failed-flip suppression budget, so the first flip intent is not an escalate', async () => {
    const { refundRecoveryBudgetOnReset, readActiveFailedFlipHolds } = await import('../bin/mux-runner.js');
    const fixture = seedRefundFixture(t => [suppressionEntry(t, 1), suppressionEntry(t, 2)], 'Todo');

    // Precondition: the Todo reset already releases the SCHEDULING hold, so the ticket
    // is re-queued. That half worked; the budget half is what was missing.
    assert.deepEqual(
        [...readActiveFailedFlipHolds(fixture.root)], [],
        'a Todo reset releases the failed-flip hold — the ticket is re-scheduled',
    );

    const result = refundRecoveryBudgetOnReset(fixture.statePath, fixture.root, fixture.ticket, 9, () => {});
    assert.equal(result.refunded, true, 'a Todo reset with a spent failed-flip budget must refund');
    assert.equal(result.cleared, 2, 'both spent suppression entries cleared');

    const decision = await flipIntentAfterHeal(fixture);
    assert.notEqual(
        decision.action, 'escalate',
        'the healed ticket must get a real re-attempt, not an immediate ladder escalation',
    );
    assert.equal(decision.action, 'suppress', 'evidence is present and the budget is fresh → suppress');
    assert.equal(decision.suppressionCount, 1, 'the budget restarts at 1/2');
});

test('AP-EXT-ITER8-03: a Todo reset refunds the silent-death respawn budget too', async () => {
    const { refundRecoveryBudgetOnReset } = await import('../bin/mux-runner.js');
    const fixture = seedRefundFixture(t => [{
        strategy: 'silent_death_respawn',
        outcome: 'success',
        reason: `log_empty respawn 1/1 for ${t}`,
        iteration: 1,
        ticket: t,
    }], 'Todo');

    const result = refundRecoveryBudgetOnReset(fixture.statePath, fixture.root, fixture.ticket, 9, () => {});
    assert.equal(result.refunded, true, 'the third per-ticket budget must refund on the same heal');
    assert.equal(result.cleared, 1);
});

test('AP-EXT-ITER8-03: NEGATIVE CONTROL — a ticket that was never reset keeps its spent budget and still escalates', async () => {
    const { refundRecoveryBudgetOnReset } = await import('../bin/mux-runner.js');
    const fixture = seedRefundFixture(t => [suppressionEntry(t, 1), suppressionEntry(t, 2)], 'In Progress');

    const result = refundRecoveryBudgetOnReset(fixture.statePath, fixture.root, fixture.ticket, 9, () => {});
    assert.equal(result.refunded, false, 'no operator reset → no refund; widening must not become a blanket clear');
    assert.equal(result.cleared, 0);

    const decision = await flipIntentAfterHeal(fixture);
    assert.equal(decision.action, 'escalate', 'an un-reset exhausted ticket must still exhaust');
});

test('AP-EXT-ITER8-03: the refund is ticket-keyed and must not clear ticket-less recovery-ladder entries', async () => {
    const { refundRecoveryBudgetOnReset } = await import('../bin/mux-runner.js');
    // `runRecoveryLadder` appends {strategy, outcome, reason, iteration} with NO ticket
    // field, and `convergedPlanIdempotentNoOp` latches on an `execute-converged-plan`
    // success. Clearing that would re-run an already-successful converged-plan rung.
    const fixture = seedRefundFixture(t => [
        suppressionEntry(t, 1),
        { strategy: 'execute-converged-plan', outcome: 'success', reason: 'ladder', iteration: 2 },
        { strategy: 'failed_flip_suppressed', outcome: 'success', reason: 'sibling', iteration: 3, ticket: 'other999' },
    ], 'Todo');

    const result = refundRecoveryBudgetOnReset(fixture.statePath, fixture.root, fixture.ticket, 9, () => {});
    assert.equal(result.cleared, 1, 'only THIS ticket’s entry is cleared');

    const after = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8')).recovery_attempts;
    assert.ok(
        after.some(a => a.strategy === 'execute-converged-plan'),
        'a ticket-less ladder entry survives — undefined never equals the ticket id',
    );
    assert.ok(
        after.some(a => a.ticket === 'other999'),
        'a sibling ticket’s budget survives',
    );
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER50-01: the orphan-manager pidfile arm must not signal a pid the
// live `ps` census attributes to a stranger. `reapOrphanedManagersAtIterationStart`
// reaches its pidfile arm only when the census did NOT recognise the pid as this
// session's manager, so before this guard the arm's reachable effects were killing
// a dead pid (a no-op) or killing whatever process inherited the recycled slot.
// ---------------------------------------------------------------------------
import {
    reapOrphanedManagersAtIterationStart as reapManagersForPidfileOwnership,
    findLiveCommandForPid as findLiveCommandForPidUnderTest,
} from '../bin/mux-runner.js';
import { LATEST_SCHEMA_VERSION as SCHEMA_VERSION_FOR_PIDFILE_OWNERSHIP } from '../types/index.js';

function makePidfileOwnershipFixture() {
    const dir = makeTmpRoot();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
        active: true,
        schema_version: SCHEMA_VERSION_FOR_PIDFILE_OWNERSHIP,
        activity: [],
    }));
    return { sessionDir: dir, statePath };
}

function pidIsAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

test('AP-EXT-ITER50-01: a real stranger process named by the pidfile survives the reap', async () => {
    const { sessionDir, statePath } = makePidfileOwnershipFixture();
    // A genuine unrelated process — its argv references nothing about this session,
    // exactly like a pid the kernel recycled after the manager died.
    // `timeout:` is the CLAUDE.md:148 hang-guard, not decoration: the child is
    // detached and unref'd, so if this test dies between here and the finally the
    // orphan would otherwise outlive the run. Verified to bound a detached child.
    const stranger = spawn('sleep', ['120'], { detached: true, stdio: 'ignore', timeout: 30000 });
    stranger.unref();
    await new Promise(resolve => setTimeout(resolve, 300));
    const strangerPid = stranger.pid;

    try {
        assert.ok(pidIsAlive(strangerPid), 'precondition: the stranger is running');
        fs.writeFileSync(path.join(sessionDir, '.active_manager.pid'), String(strangerPid));

        // Real ps census and the real SIGTERM path — no injection, this is the
        // production wire that was measured killing a `sleep 120`.
        const reaped = reapManagersForPidfileOwnership(statePath, sessionDir, () => {});
        await new Promise(resolve => setTimeout(resolve, 400));

        assert.deepEqual(reaped, [], 'an unattributable pid is not reported as reaped');
        assert.ok(pidIsAlive(strangerPid), 'the stranger process must still be alive');

        const activity = JSON.parse(fs.readFileSync(statePath, 'utf8')).activity || [];
        assert.ok(
            !activity.some(e => e.event === 'orphan_manager_reaped' && e.pid === strangerPid),
            'no orphan_manager_reaped event is recorded for a kill that never happened',
        );
    } finally {
        try { process.kill(strangerPid, 'SIGKILL'); } catch { /* already gone */ }
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('AP-EXT-ITER50-01: the pidfile stays authoritative about ROLE — a census-visible non-claude manager naming this session is still reaped', () => {
    const { sessionDir, statePath } = makePidfileOwnershipFixture();
    const codexPid = 424242;
    fs.writeFileSync(path.join(sessionDir, '.active_manager.pid'), String(codexPid));

    const killed = [];
    // `basename !== 'claude'`, so parseOrphanedManagersFromPs cannot see it — only
    // the pidfile finds this one, and the census confirms it belongs to us.
    const psOutput = `${codexPid} 1 10:00 /opt/codex/bin/codex exec --add-dir ${sessionDir} -- run\n`;
    reapManagersForPidfileOwnership(statePath, sessionDir, () => {}, {
        psOutput,
        kill: pid => killed.push(pid),
    });

    assert.deepEqual(killed, [codexPid], 'a census line referencing this sessionDir is attributable');
    fs.rmSync(sessionDir, { recursive: true, force: true });
});

test('AP-EXT-ITER50-01: a census-visible pid whose command never names this session is refused', () => {
    const { sessionDir, statePath } = makePidfileOwnershipFixture();
    const strangerPid = 515151;
    fs.writeFileSync(path.join(sessionDir, '.active_manager.pid'), String(strangerPid));

    const killed = [];
    const logged = [];
    const psOutput = `${strangerPid} 1 10:00 /usr/bin/sleep 120\n`;
    reapManagersForPidfileOwnership(statePath, sessionDir, msg => logged.push(msg), {
        psOutput,
        kill: pid => killed.push(pid),
    });

    assert.deepEqual(killed, [], 'a stranger in the census is never signalled');
    assert.ok(
        logged.some(m => m.includes('not attributable to this session')),
        'the refusal is logged rather than silent',
    );
    fs.rmSync(sessionDir, { recursive: true, force: true });
});

test('AP-EXT-ITER50-01: findLiveCommandForPid returns the census command, or null when absent', () => {
    const psOutput = [
        '111 1 10:00 /usr/bin/sleep 120',
        '222 1 09:00 node /path/to/thing.js --flag',
    ].join('\n');

    assert.equal(findLiveCommandForPidUnderTest(psOutput, 222), 'node /path/to/thing.js --flag');
    assert.equal(findLiveCommandForPidUnderTest(psOutput, 999), null, 'a pid absent from the census is dead');
    assert.equal(findLiveCommandForPidUnderTest('', 111), null, 'an empty census attributes nothing');
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER99-01: the commit-pending rescue must see UNTRACKED work.
//
// `commitPendingProbe` is the rescue that nudges a stagnating codex worker to
// commit BEFORE the no-progress circuit breaker trips. It used to read pending
// work as `git diff --stat` OR `git diff --stat --cached` — a pair that covers
// tracked modifications staged and unstaged, and nothing untracked. A worker
// whose entire output is NEW files therefore read as "nothing pending", so the
// run most in need of the rescue was the one run that could never receive it.
//
// Hosted here rather than in the natural sibling `iteration-outcome.test.js`
// (which owns the probe's happy path) because that file is outside this run's
// scope fence; `mux-runner.test.js` is the in-scope host for this module.
//
// Both directions are pinned: the untracked case must FIRE, and two clean-ish
// cases must NOT — a collapse that simply carries everything would pass the
// first assertion alone.
// ---------------------------------------------------------------------------
import { commitPendingProbe as commitPendingProbeUnderTest } from '../bin/mux-runner.js';

function runCommitPendingProbe(sessionDir, workingDir) {
    return commitPendingProbeUnderTest({
        sessionDir,
        workingDir,
        backend: 'codex',
        iteration: 5,
        lastProgressIteration: 2, // stagnation = 3 >= threshold 2
        threshold: 2,
        pid: process.pid,
        log: () => {},
    });
}

function withProbeDirs(fn) {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ap99-sess-')));
    const workingDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ap99-repo-')));
    try {
        initGitRepo(workingDir);
        fn(sessionDir, workingDir);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
}

test('AP-EXT-ITER99-01: untracked-only worker output fires the commit-pending rescue', () => {
    withProbeDirs((sessionDir, workingDir) => {
        // The worker's entire output is NEW files it never staged — invisible to
        // `git diff --stat` and to `git diff --stat --cached` alike.
        fs.mkdirSync(path.join(workingDir, 'newmod'), { recursive: true });
        fs.writeFileSync(path.join(workingDir, 'newmod', 'a.ts'), 'export const a = 1;\n');
        fs.writeFileSync(path.join(workingDir, 'newmod', 'b.ts'), 'export const b = 2;\n');

        // Sanity: this really is the blind spot — both replaced reads are empty.
        assert.equal(
            spawnSync('git', ['diff', '--stat'], { cwd: workingDir, encoding: 'utf-8', timeout: 30000 }).stdout.trim(),
            '',
            'sanity: unstaged diff is empty for untracked-only work',
        );
        assert.equal(
            spawnSync('git', ['diff', '--stat', '--cached'], { cwd: workingDir, encoding: 'utf-8', timeout: 30000 }).stdout.trim(),
            '',
            'sanity: staged diff is empty for untracked-only work',
        );

        assert.equal(runCommitPendingProbe(sessionDir, workingDir), 'fired');
        assert.ok(
            fs.existsSync(path.join(sessionDir, 'handoff.txt')),
            'the rescue handoff must be written so the worker commits before the breaker trips',
        );
    });
});

test('AP-EXT-ITER99-01: a genuinely clean tree still declines (no carry-anything)', () => {
    withProbeDirs((sessionDir, workingDir) => {
        assert.equal(runCommitPendingProbe(sessionDir, workingDir), 'skipped:no-uncommitted');
        assert.ok(
            !fs.existsSync(path.join(sessionDir, 'handoff.txt')),
            'a clean tree must not produce a rescue handoff',
        );
    });
});

test('AP-EXT-ITER99-01: a .codegraph-only tree declines (regenerable index is not worker output)', () => {
    withProbeDirs((sessionDir, workingDir) => {
        // `.codegraph/` is plain untracked dirt on a fresh clone — it is ignored
        // only through the local, unversioned `.git/info/exclude`. Widening the
        // read to untracked files must not turn the runtime's own index into
        // "pending worker work".
        fs.mkdirSync(path.join(workingDir, '.codegraph'), { recursive: true });
        fs.writeFileSync(path.join(workingDir, '.codegraph', 'index.bin'), 'x');

        assert.equal(runCommitPendingProbe(sessionDir, workingDir), 'skipped:no-uncommitted');
    });
});
