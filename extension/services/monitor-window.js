// Tmux monitor/watcher-window concern, extracted from pickle-utils.ts (R5a). pickle-utils.ts re-exports
// every public name here, so existing `../services/pickle-utils.js` imports keep resolving.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './state-manager.js';
import { _killOldMonitorPid, formatLocalDateKey, getDataRoot, getExtensionRoot, resolveExtensionRoot, safeErrorMessage, wrapWithStderrRedirect, } from './pickle-utils.js';
/**
 * Infers monitor mode from state.json's command_template. Defaults to 'pickle'.
 * Glob mapping: pickle*→pickle, council*→council.
 * Exact mapping: anatomy-park.md→anatomy-park, szechuan-sauce.md→szechuan-sauce, refinement.md→refinement.
 * Missing or unrecognized template defaults to 'pickle' and emits a WARN via optional log.
 */
export function inferMonitorMode(sessionDir, log) {
    try {
        const state = new StateManager().read(path.join(sessionDir, 'state.json'));
        const tpl = (state.command_template || '').toLowerCase();
        if (!tpl) {
            log?.('[ensureMonitorWindow] command_template missing; defaulting to pickle');
            return 'pickle';
        }
        if (tpl.startsWith('pickle'))
            return 'pickle';
        if (tpl === 'anatomy-park.md')
            return 'anatomy-park';
        if (tpl === 'szechuan-sauce.md')
            return 'szechuan-sauce';
        if (tpl.startsWith('council'))
            return 'council';
        if (tpl === 'refinement.md')
            return 'refinement';
        log?.(`[ensureMonitorWindow] unrecognized command_template '${state.command_template}'; defaulting to pickle`);
        return 'pickle';
    }
    catch {
        log?.('[ensureMonitorWindow] command_template missing; defaulting to pickle');
        return 'pickle';
    }
}
export function restartDeadWatcherPanes(sessionDir, extensionRoot, mode, spawnSyncFn = spawnSync, 
/**
 * R-MWR-3: log-line prefix for respawn decisions. Defaults to
 * `restartDeadWatcherPanes` for boundary-driven invocations
 * (`ensureMonitorWindow` re-attach). The continuous in-monitor
 * watchdog (`startRespawnWatchdog`) passes `monitor-watchdog` so
 * AC-MWR-05 grep can distinguish the two callers in `mux-runner.log`.
 */
logTag = 'restartDeadWatcherPanes', 
// R-MWCL-3: injectable for testing window-missing escalation.
ensureMonitorWindowFn = ensureMonitorWindow) {
    const callerName = logTag === 'monitor-watchdog' ? 'startRespawnWatchdog' : 'restartDeadWatcherPanes';
    if (!validateSessionDirOrSkip(sessionDir, callerName))
        return;
    if (isSessionInactive(sessionDir))
        return;
    const sessionName = readCurrentTmuxSessionName(spawnSyncFn);
    if (!sessionName) {
        appendWatcherRestartLog(sessionDir, `${logTag} WARN: unable to resolve tmux session name`);
        return;
    }
    if (isForeignTmuxSession(sessionName, sessionDir)) {
        appendWatcherRestartLog(sessionDir, `${logTag} WARN: tmux session '${sessionName}' does not host this session's monitor window — skipping respawn`);
        return;
    }
    for (const watcher of watcherPaneCommands(sessionDir, extensionRoot, mode)) {
        if (processWatcherPane(sessionDir, extensionRoot, mode, sessionName, watcher, spawnSyncFn, logTag, ensureMonitorWindowFn))
            return;
    }
}
function isSessionInactive(sessionDir) {
    try {
        const state = new StateManager().read(path.join(sessionDir, 'state.json'));
        return state.active === false;
    }
    catch {
        return false;
    }
}
/** Trailing `-`-delimited segment: the session hash both names are keyed by. */
function sessionHashOf(name) {
    return name.slice(name.lastIndexOf('-') + 1);
}
/**
 * We may only drive the tmux session that hosts THIS session's monitor window.
 * `#S` answers "which tmux session is this PROCESS in" — the right answer only
 * when the runner was launched inside the session it manages. A runner that
 * inherits `$TMUX` from somewhere else (a test child, an operator's own window)
 * would otherwise send-keys its pane commands, with Enter, into a stranger's
 * live pane.
 *
 * Launchers name the tmux session `<prefix>-<session-hash>` for the session dir
 * they manage, so the two hashes agree exactly when the window is ours. Fail
 * CLOSED: a name we cannot tie to our own session dir is not ours to drive.
 * Deriving ownership from the pair alone — rather than resolving the name
 * against the data root — is what makes this hold for a runner whose data root
 * does not contain the ambient session.
 */
function isForeignTmuxSession(sessionName, sessionDir) {
    return sessionHashOf(sessionName) !== sessionHashOf(path.basename(sessionDir));
}
function readCurrentTmuxSessionName(spawnSyncFn) {
    const result = spawnSyncFn('tmux', ['display-message', '-p', '#S'], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (result.status !== 0)
        return null;
    const sessionName = (result.stdout || '').trim();
    return sessionName || null;
}
function readPaneCurrentCommand(target, spawnSyncFn) {
    const result = spawnSyncFn('tmux', ['display-message', '-p', '-t', target, '#{pane_current_command}'], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (result.status !== 0)
        return null;
    return (result.stdout || '').trim();
}
function withSerializedPath(fn) {
    // R-TSPF-4 trap door: tests serialize PATH shim mutations around this
    // helper. Runtime tmux calls stay synchronous; the helper marks the call
    // sites that must stay on the shared serialized path in test fixtures.
    return fn();
}
// Processes one watcher pane entry in the restartDeadWatcherPanes loop.
// Returns true when the outer function should exit immediately (monitor window gone, escalated).
function processWatcherPane(sessionDir, extensionRoot, mode, sessionName, watcher, spawnSyncFn, logTag, ensureMonitorWindowFn) {
    const target = `${sessionName}:monitor.${watcher.pane}`;
    const currentCommand = readPaneCurrentCommand(target, spawnSyncFn);
    if (currentCommand === null) {
        return handleNullPaneCommand(sessionDir, extensionRoot, mode, sessionName, watcher, spawnSyncFn, logTag, ensureMonitorWindowFn) === 'return';
    }
    if (currentCommand === watcher.process)
        return false;
    appendWatcherRestartLog(sessionDir, `${logTag} WARN: pane ${watcher.pane} command '${currentCommand || '(empty)'}' is not ${watcher.process}`);
    const result = spawnSyncFn('tmux', ['send-keys', '-t', target, watcher.command, 'Enter'], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (result.status === 0) {
        appendWatcherRestartLog(sessionDir, `${logTag}: respawned ${watcher.name} in pane ${watcher.pane}`);
    }
    else {
        const err = (result.stderr || result.stdout || '').toString().trim();
        appendWatcherRestartLog(sessionDir, `${logTag} WARN: failed to respawn ${watcher.name} in pane ${watcher.pane}: ${err || 'non-zero exit'}`);
    }
    return false;
}
// R-MWCL-3: extracted from restartDeadWatcherPanes to reduce complexity.
// Probes the monitor window and either escalates to ensureMonitorWindow (returns 'return')
// or delegates to recreateMissingWatcherPane (returns 'continue').
function handleNullPaneCommand(sessionDir, extensionRoot, mode, sessionName, watcher, spawnSyncFn, logTag, ensureMonitorWindowFn) {
    const listResult = spawnSyncFn('tmux', ['list-panes', '-t', `${sessionName}:monitor`], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (listResult.status !== 0) {
        appendWatcherRestartLog(sessionDir, `${logTag} collapsed-layout-repair: monitor window missing — escalating to ensureMonitorWindow`);
        ensureMonitorWindowFn({ sessionDir, extensionRoot, mode, spawnSyncFn, inTmux: true });
        return 'return';
    }
    recreateMissingWatcherPane(sessionDir, sessionName, watcher, spawnSyncFn, logTag);
    return 'continue';
}
function recreateMissingWatcherPane(sessionDir, sessionName, watcher, spawnSyncFn, logTag) {
    const splitSpec = missingWatcherPaneSplitSpec(sessionName, watcher.pane);
    const split = withSerializedPath(() => spawnSyncFn('tmux', splitSpec.args, {
        encoding: 'utf-8',
        timeout: 5_000,
    }));
    if (split.status !== 0) {
        const err = (split.stderr || split.stdout || '').toString().trim();
        appendWatcherRestartLog(sessionDir, `${logTag} WARN: failed to recreate missing pane ${watcher.pane} via ${splitSpec.target}: ${err || 'non-zero exit'}`);
        return false;
    }
    appendWatcherRestartLog(sessionDir, `${logTag} WARN: pane ${watcher.pane} missing; recreated via ${splitSpec.target} [collapsed-layout-repair]`);
    const send = withSerializedPath(() => spawnSyncFn('tmux', ['send-keys', '-t', `${sessionName}:monitor.${watcher.pane}`, watcher.command, 'Enter'], {
        encoding: 'utf-8',
        timeout: 5_000,
    }));
    if (send.status === 0) {
        appendWatcherRestartLog(sessionDir, `${logTag}: respawned ${watcher.name} in pane ${watcher.pane}`);
        // R-MWCL-3: re-tile after inserting a new pane so the layout lands in a
        // reasonable position rather than inheriting tmux's default stacking.
        withSerializedPath(() => spawnSyncFn('tmux', ['select-layout', '-t', `${sessionName}:monitor`, 'tiled'], {
            encoding: 'utf-8',
            timeout: 5_000,
        }));
        appendWatcherRestartLog(sessionDir, `${logTag} collapsed-layout-repair: select-layout tiled applied to ${sessionName}:monitor`);
        return true;
    }
    const err = (send.stderr || send.stdout || '').toString().trim();
    appendWatcherRestartLog(sessionDir, `${logTag} WARN: failed to respawn ${watcher.name} in recreated pane ${watcher.pane}: ${err || 'non-zero exit'}`);
    return false;
}
function missingWatcherPaneSplitSpec(sessionName, pane) {
    const windowTarget = `${sessionName}:monitor`;
    switch (pane) {
        case 0:
            return {
                target: `${windowTarget}.1`,
                args: ['split-window', '-h', '-b', '-t', `${windowTarget}.1`],
            };
        case 1:
            return {
                target: `${windowTarget}.0`,
                args: ['split-window', '-h', '-t', `${windowTarget}.0`],
            };
        case 2:
            return {
                target: `${windowTarget}.0`,
                args: ['split-window', '-v', '-l', '40%', '-t', `${windowTarget}.0`],
            };
        case 3:
            return {
                target: `${windowTarget}.2`,
                args: ['split-window', '-h', '-t', `${windowTarget}.2`],
            };
    }
}
/**
 * Builds one pane entry from its raw (unwrapped) command. `command` and
 * `process` are derived from the SAME string, so the launcher and the
 * health predicate cannot drift apart — which is exactly what happened while
 * the predicate was a hardcoded `'node'` literal and council's pane 2 ran
 * `tail -F`.
 */
function watcherPane(pane, name, rawCommand, sessionDir) {
    return {
        pane,
        name,
        command: wrapWithStderrRedirect(rawCommand, sessionDir, pane),
        process: path.basename(rawCommand.split(' ')[0]),
    };
}
export function watcherPaneCommands(sessionDir, extensionRoot, mode) {
    const binRoot = path.join(extensionRoot, 'extension', 'bin');
    let paneTwo;
    switch (mode) {
        case 'pickle':
        case 'council':
        case 'refinement':
        case 'szechuan-sauce':
        case 'anatomy-park':
            paneTwo = watcherPaneTwoCommand(sessionDir, binRoot, mode);
            break;
    }
    return [
        watcherPane(0, 'monitor.js', `node ${path.join(binRoot, 'monitor.js')} ${sessionDir}`, sessionDir),
        watcherPane(1, 'log-watcher.js', `node ${path.join(binRoot, 'log-watcher.js')} ${sessionDir}`, sessionDir),
        paneTwo,
        watcherPane(3, 'raw-morty.js', `node ${path.join(binRoot, 'raw-morty.js')} ${sessionDir}`, sessionDir),
    ];
}
function watcherPaneTwoCommand(sessionDir, binRoot, mode) {
    switch (mode) {
        case 'refinement':
            return watcherPane(2, 'refinement-watcher.js', `node ${path.join(binRoot, 'refinement-watcher.js')} ${sessionDir}`, sessionDir);
        case 'council':
            return watcherPane(2, 'mux-runner.log tail', `tail -F ${path.join(sessionDir, 'mux-runner.log')}`, sessionDir);
        case 'pickle':
            return watcherPane(2, 'morty-watcher.js', `node ${path.join(binRoot, 'morty-watcher.js')} ${sessionDir}`, sessionDir);
        case 'szechuan-sauce':
        case 'anatomy-park':
            return watcherPane(2, 'pane-1-2-pointer.js', `node ${path.join(binRoot, 'pane-1-2-pointer.js')} ${sessionDir}`, sessionDir);
    }
}
function appendWatcherRestartLog(sessionDir, line) {
    try {
        fs.appendFileSync(path.join(sessionDir, 'mux-runner.log'), `${new Date().toISOString()} ${line}\n`);
    }
    catch {
        // Best-effort diagnostic logging must not break pane recovery.
    }
}
/** Dedup guard: emit only one activity event per (caller, sessionDir, reason) tuple per process. */
const _sessionDirInvalidEmitted = new Map();
/**
 * Validates sessionDir before tmux-watcher invocation. Returns true when valid; returns false
 * and emits a monitor_respawn_session_dir_invalid activity event (once per tuple) when invalid.
 *
 * Checks (in order): non-empty string → path exists → state.json present → resolved path matches state
 */
export function validateSessionDirOrSkip(sessionDir, caller) {
    let reason = null;
    if (!sessionDir || typeof sessionDir !== 'string') {
        reason = 'empty';
    }
    else if (!fs.existsSync(sessionDir)) {
        reason = 'enoent';
    }
    else if (!fs.existsSync(path.join(sessionDir, 'state.json'))) {
        reason = 'no_state_json';
    }
    else {
        try {
            const sm = new StateManager();
            const state = sm.read(path.join(sessionDir, 'state.json'));
            if (state.session_dir && path.resolve(state.session_dir) !== path.resolve(sessionDir)) {
                reason = 'session_dir_mismatch';
            }
        }
        catch {
            reason = 'session_dir_mismatch';
        }
    }
    if (reason === null)
        return true;
    const dedupeKey = `${caller}:${sessionDir}:${reason}`;
    if (_sessionDirInvalidEmitted.has(dedupeKey))
        return false;
    _sessionDirInvalidEmitted.set(dedupeKey, true);
    appendWatcherRestartLog(sessionDir, `validateSessionDirOrSkip WARN: ${caller} skipped — sessionDir ${reason} (${sessionDir})`);
    try {
        const ts = new Date();
        const activityDir = path.join(getDataRoot(), 'activity');
        fs.mkdirSync(activityDir, { recursive: true });
        const event = {
            ts: ts.toISOString(),
            event: 'monitor_respawn_session_dir_invalid',
            source: 'pickle',
            gate_payload: { caller, sessionDir, reason },
        };
        fs.appendFileSync(path.join(activityDir, `${formatLocalDateKey(ts)}.jsonl`), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
    catch (err) {
        process.stderr.write(`[pickle-rick] Failed to log monitor_respawn_session_dir_invalid: ${safeErrorMessage(err)}\n`);
    }
    return false;
}
/** Test helper: resets the session-dir-invalid dedup map. */
export function _resetSessionDirInvalidEmittedForTests() {
    _sessionDirInvalidEmitted.clear();
}
/**
 * Idempotently creates the 4-pane monitor window in the current tmux session.
 *
 * Called at the start of every long-running pickle tmux runner (mux-runner,
 * pipeline-runner) so agents never have to invoke tmux-monitor.sh explicitly —
 * previously Step 11e of several skill prompts, silently dropped when the
 * agent's context was tight.
 *
 * Never throws. Returns a status so callers can log the outcome:
 *   - `skipped`    → not inside tmux (headless or direct invocation), or the
 *                    ambient tmux session is not the one hosting our monitor
 *                    window (`isForeignTmuxSession`) — we do not kill or create
 *                    windows in a session we do not own
 *   - `exists`     → monitor window already present for this mode, no-op
 *   - `created`    → monitor window spawned
 *   - `recreated`  → stale monitor (different mode) killed and respawned
 *   - `error`      → tmux/bash call failed; check `reason`
 *
 * Mode compatibility: the monitor window's layout is mode-specific
 * (pickle/council/refinement). We persist the mode it was built for
 * via a tmux user-option (`@pickle_monitor_mode`) on the window itself, then
 * on re-entry compare against the mode this invocation wants. Mismatch =>
 * kill + recreate. Silent reuse would leave the wrong layout in place.
 */
export function ensureMonitorWindow(opts) {
    const log = opts.log || (() => { });
    const inTmux = opts.inTmux !== undefined ? opts.inTmux : !!process.env.TMUX;
    if (!inTmux) {
        log('ensureMonitorWindow: not inside tmux, skipping');
        return { status: 'skipped', reason: 'not in tmux' };
    }
    activeMonitorWindowContext = {
        opts,
        log,
        tmuxBin: opts.tmuxBin || 'tmux',
        bashBin: opts.bashBin || 'bash',
        spawnSyncFn: opts.spawnSyncFn || spawnSync,
        mode: opts.mode || inferMonitorMode(opts.sessionDir, log),
    };
    try {
        const sessionName = getSessionName();
        if (!sessionName)
            return activeMonitorWindowContext.outcome || { status: 'error', reason: 'empty session name' };
        if (isForeignTmuxSession(sessionName, opts.sessionDir)) {
            log(`ensureMonitorWindow: tmux session '${sessionName}' does not host this session's monitor window — skipping`);
            return { status: 'skipped', reason: `foreign tmux session: ${sessionName}` };
        }
        const { recreate } = checkAndRecreateWindow(sessionName);
        if (activeMonitorWindowContext.outcome)
            return activeMonitorWindowContext.outcome;
        createMonitorWindow(sessionName);
        if (activeMonitorWindowContext.outcome)
            return activeMonitorWindowContext.outcome;
        if (recreate) {
            log(`ensureMonitorWindow: recreated 4-pane monitor (mode=${activeMonitorWindowContext.mode}) on ${sessionName}`);
            return { status: 'recreated' };
        }
        log(`ensureMonitorWindow: created 4-pane monitor (mode=${activeMonitorWindowContext.mode}) on ${sessionName}`);
        return { status: 'created' };
    }
    finally {
        activeMonitorWindowContext = null;
    }
}
let activeMonitorWindowContext = null;
function currentMonitorWindowContext() {
    if (!activeMonitorWindowContext)
        throw new Error('ensureMonitorWindow context not initialized');
    return activeMonitorWindowContext;
}
function getSessionName() {
    const { log, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
    // Resolve session name via tmux itself — the TMUX env var alone only proves
    // we're inside *some* tmux, not which session owns this pane.
    const displayName = spawnSyncFn(tmuxBin, ['display-message', '-p', '#S'], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (displayName.status !== 0) {
        const err = (displayName.stderr || '').toString().trim();
        log(`ensureMonitorWindow: tmux display-message failed: ${err}`);
        activeMonitorWindowContext.outcome = { status: 'error', reason: `display-message: ${err || 'non-zero exit'}` };
        return null;
    }
    const sessionName = (displayName.stdout || '').trim();
    if (!sessionName) {
        log('ensureMonitorWindow: empty tmux session name');
        activeMonitorWindowContext.outcome = { status: 'error', reason: 'empty session name' };
        return null;
    }
    return sessionName;
}
function checkAndRecreateWindow(sessionName) {
    const { log, mode, opts, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
    const target = `${sessionName}:monitor`;
    // Compatibility guard — a "monitor" window from a previous command (e.g.
    // anatomy-park then council) has the wrong layout. Check the window's
    // `@pickle_monitor_mode` user-option and recreate on mismatch.
    const listWindows = spawnSyncFn(tmuxBin, ['list-windows', '-t', sessionName, '-F', '#W'], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (listWindows.status !== 0)
        return { recreate: false };
    const names = (listWindows.stdout || '').split('\n').map(s => s.trim());
    if (!names.includes('monitor'))
        return { recreate: false };
    const existingMode = readWindowMode(tmuxBin, target, spawnSyncFn);
    if (monitorModesCompatible(existingMode, mode)) {
        log(`ensureMonitorWindow: monitor window already exists on ${sessionName} (mode=${mode})`);
        restartDeadWatcherPanes(opts.sessionDir, resolveMonitorExtensionRoot(opts), mode, spawnSyncFn);
        activeMonitorWindowContext.outcome = { status: 'exists' };
        return { recreate: false };
    }
    log(`ensureMonitorWindow: mode mismatch on ${sessionName} ` +
        `(existing=${existingMode || 'unset'}, want=${mode}) — killing stale window`);
    const kill = spawnSyncFn(tmuxBin, ['kill-window', '-t', target], {
        encoding: 'utf-8',
        timeout: 5_000,
    });
    if (kill.status !== 0) {
        const err = (kill.stderr || '').toString().trim();
        log(`ensureMonitorWindow: kill-window failed: ${err}`);
        activeMonitorWindowContext.outcome = { status: 'error', reason: `kill-window: ${err || 'non-zero exit'}` };
        return { recreate: false };
    }
    return { recreate: true };
}
function createMonitorWindow(sessionName) {
    const { bashBin, log, mode, opts, spawnSyncFn, tmuxBin } = currentMonitorWindowContext();
    const target = `${sessionName}:monitor`;
    const extensionRoot = resolveMonitorExtensionRoot(opts);
    const script = path.join(extensionRoot, 'extension', 'scripts', 'tmux-monitor.sh');
    if (!fs.existsSync(script)) {
        log(`ensureMonitorWindow: tmux-monitor.sh missing at ${script}`);
        activeMonitorWindowContext.outcome = { status: 'error', reason: `script missing: ${script}` };
        return;
    }
    const result = spawnSyncFn(bashBin, [script, sessionName, opts.sessionDir, mode], {
        encoding: 'utf-8',
        timeout: 10_000,
    });
    if (result.status !== 0) {
        const err = (result.stderr || result.stdout || '').toString().trim();
        log(`ensureMonitorWindow: tmux-monitor.sh failed (exit ${result.status}): ${err}`);
        activeMonitorWindowContext.outcome = { status: 'error', reason: `script exit ${result.status}: ${err || 'no stderr'}` };
        return;
    }
    // Stamp the mode on the freshly-created window so the next invocation can
    // detect compatibility. Non-fatal if it fails — we log and move on.
    const setOpt = spawnSyncFn(tmuxBin, ['set-option', '-w', '-t', target, '@pickle_monitor_mode', mode], { encoding: 'utf-8', timeout: 5_000 });
    if (setOpt.status !== 0) {
        const err = (setOpt.stderr || '').toString().trim();
        log(`ensureMonitorWindow: set-option @pickle_monitor_mode failed (non-fatal): ${err}`);
    }
}
function resolveMonitorExtensionRoot(opts) {
    return opts.extensionRoot ? resolveExtensionRoot(opts.extensionRoot) : getExtensionRoot();
}
/** Reads the monitor window's stamped mode via tmux user-option, or null. */
function readWindowMode(tmuxBin, target, spawnSyncFn) {
    const show = spawnSyncFn(tmuxBin, ['show-option', '-w', '-qv', '-t', target, '@pickle_monitor_mode'], { encoding: 'utf-8', timeout: 5_000 });
    if (show.status !== 0)
        return null;
    const val = (show.stdout || '').trim();
    return val || null;
}
/**
 * Returns true iff we can reuse an existing monitor window without recreating.
 * Unset existing mode counts as incompatible — we can't prove the layout matches
 * what this mode needs, so play it safe and rebuild.
 */
export function monitorModesCompatible(existing, want) {
    if (!existing)
        return false;
    switch (want) {
        case 'pickle':
            return existing === 'pickle';
        case 'council':
            return existing === 'council';
        case 'refinement':
            return existing === 'refinement';
        case 'szechuan-sauce':
            return existing === 'szechuan-sauce';
        case 'anatomy-park':
            return existing === 'anatomy-park';
    }
}
function _resolveTmuxSessionName(spawnSyncFn, log, mode) {
    const r = spawnSyncFn('tmux', ['display-message', '-p', '#S'], { encoding: 'utf-8', timeout: 5_000 });
    if (r.status !== 0) {
        log(`monitor: tmux display-message failed for mode ${mode}`);
        return null;
    }
    const name = (r.stdout || '').trim();
    if (!name) {
        log(`monitor: empty tmux session name for mode ${mode}`);
        return null;
    }
    return name;
}
function _tmuxRespawnPane(spawnSyncFn, target, command, log, mode) {
    const r = spawnSyncFn('tmux', ['respawn-pane', '-k', '-t', target, command], { encoding: 'utf-8', timeout: 5_000 });
    if (r.status !== 0) {
        const err = (r.stderr || '').trim() || 'non-zero exit';
        log(`monitor: respawn-pane failed for mode ${mode}: ${err}`);
        return false;
    }
    return true;
}
function _tmuxGetPanePid(spawnSyncFn, target) {
    try {
        const r = spawnSyncFn('tmux', ['display-message', '-p', '-t', target, '#{pane_pid}'], { encoding: 'utf-8', timeout: 5_000 });
        if (r.status === 0) {
            const parsed = parseInt((r.stdout || '').trim(), 10);
            if (!isNaN(parsed) && parsed > 0)
                return parsed;
        }
    }
    catch { /* best-effort */ }
    return null;
}
function _updateMonitorState(smLocal, statePath, newPid, mode) {
    try {
        smLocal.update(statePath, s => {
            const ext = s;
            ext.monitor_pid = newPid;
            ext.monitor_mode = mode;
        });
    }
    catch { /* best-effort */ }
}
/**
 * Respawns the monitor dashboard pane (pane 0) with --mode set to `mode`.
 *
 * Returns 'no-op' when:
 *   - sessionDir is invalid (validateSessionDirOrSkip)
 *   - state.monitor_mode already equals `mode`
 *   - not inside tmux
 *   - the ambient tmux session is not ours (isForeignTmuxSession)
 *   - tmux respawn-pane fails
 * Every no-op above the ownership gate is TOTAL: no pane is respawned and no pid is
 * signalled. Only a run that has proven the tmux target is ours reclaims the old monitor.
 * Returns 'respawned' on success; updates state.monitor_pid and state.monitor_mode.
 * Logs `monitor: respawned for mode <mode>` via opts.log so the line appears in
 * pipeline-runner.log (AC-MDS-01).
 */
export async function respawnMonitorWindowForMode(sessionDir, mode, opts) {
    if (!validateSessionDirOrSkip(sessionDir, 'respawnMonitorWindowForMode'))
        return 'no-op';
    const statePath = path.join(sessionDir, 'state.json');
    const smLocal = new StateManager();
    const log = opts?.log ?? (() => undefined);
    try {
        const s = smLocal.read(statePath);
        if (s.monitor_mode === mode)
            return 'no-op';
    }
    catch { /* tolerate read failure — proceed */ }
    const inTmux = opts?.inTmux !== undefined ? opts.inTmux : !!process.env.TMUX;
    if (!inTmux) {
        log(`monitor: tmux unavailable, skipping respawn for mode ${mode}`);
        return 'no-op';
    }
    const spawnSyncFn = opts?.spawnSyncFn ?? spawnSync;
    const sessionName = _resolveTmuxSessionName(spawnSyncFn, log, mode);
    if (!sessionName)
        return 'no-op';
    // `respawn-pane -k` KILLS the target pane. `validateSessionDirOrSkip` above proves
    // our sessionDir is coherent — it says nothing about whose tmux session `#S` named.
    if (isForeignTmuxSession(sessionName, sessionDir)) {
        log(`monitor: tmux session '${sessionName}' does not host this session's monitor window — skipping respawn for mode ${mode}`);
        return 'no-op';
    }
    // AP-EXT-ITER112-01: reclaiming the old monitor process is the OTHER half of the same
    // destructive act as `respawn-pane -k`, so it lives under the same ownership gate. Above
    // this line the function has decided nothing may be touched; a pid signalled there is
    // signalled by a run that then declines to act.
    await _killOldMonitorPid(smLocal, statePath);
    const extensionRoot = getExtensionRoot();
    const monitorBin = path.join(extensionRoot, 'extension', 'bin', 'monitor.js');
    const target = `${sessionName}:monitor.0`;
    const ok = _tmuxRespawnPane(spawnSyncFn, target, `node ${monitorBin} --mode ${mode} ${sessionDir}`, log, mode);
    if (!ok)
        return 'no-op';
    const newPid = _tmuxGetPanePid(spawnSyncFn, target);
    _updateMonitorState(smLocal, statePath, newPid, mode);
    log(`monitor: respawned for mode ${mode}`);
    return 'respawned';
}
