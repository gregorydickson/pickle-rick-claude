#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { collectTickets, statusSymbol, formatTime, getWidth, getHeight, Style, sleep, MatrixStyle, matrixSeparator, latestIterationLog, safeErrorMessage, restartDeadWatcherPanes, inferMonitorMode, getExtensionRoot, validateSessionDirOrSkip } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { logActivity } from '../services/activity-logger.js';
import { readMicroverseState, readRecoverableJsonObject } from '../services/microverse-state.js';
import { readCircuitBreakerState } from '../services/circuit-breaker.js';
const sm = new StateManager();
export const MONITOR_STDERR_LOG_NAME = 'monitor-stderr.log';
export const MONITOR_STDERR_CAP_BYTES = 64 * 1024;
const MONITOR_STDERR_HEADER_PREFIX = '[monitor-stderr]';
/**
 * Watchdog timeout for stdout writes. When `process.stdout.write()` reports
 * backpressure (returns `false`) and the kernel buffer never drains within
 * this window, the monitor exits with a clear stderr message rather than
 * blocking forever in a synchronous write. Without this guard a wedged
 * tmux pane (scrollback frozen, pipe buffer full) prevents Node from
 * servicing SIGINT, so `Ctrl-C` cannot kill the monitor.
 *
 * AC-SSV-07: 2000ms is long enough to ride out routine pane redraws on
 * busy machines but short enough that a wedged pane is detected before
 * the user reaches for `kill -9`.
 *
 * R-MWR-rename: this is the STDOUT-write-backpressure watchdog. It is a
 * DIFFERENT concept from `RESPAWN_WATCHDOG_INTERVAL_MS` (the dead-pane
 * respawn interval used by `startRespawnWatchdog`). Naming convention
 * established for R-MWR Section E to avoid R7 symbol collision: every
 * dead-pane respawn symbol uses the `RESPAWN_WATCHDOG_*` prefix; every
 * stdout-wedge symbol keeps the existing `MONITOR_STDOUT_WATCHDOG_*`
 * prefix. The two scopes never share state.
 */
export const MONITOR_STDOUT_WATCHDOG_MS = 2000;
/**
 * Interval (ms) at which the monitor pane re-runs `restartDeadWatcherPanes`
 * to revive dashboard/log/morty/raw watcher panes that died mid-iteration.
 *
 * R-MWR-1: continuous watchdog. Without it, watcher panes that crash
 * after `ensureMonitorWindow` returns "exists" stay dead until the next
 * mux-runner phase boundary — operators see frozen panes for the rest of
 * the pipeline.
 *
 * R-MWR-rename: deliberately distinct from `MONITOR_STDOUT_WATCHDOG_MS`
 * (which guards a synchronous stdout write inside this very monitor).
 * The RESPAWN_ prefix marks "dead-pane respawn" scope; do NOT share the
 * symbol with stdout-watchdog code paths.
 */
export const RESPAWN_WATCHDOG_INTERVAL_MS = 30_000;
/**
 * Write `chunk` to `sink`, returning a promise that resolves once the
 * write has flushed (or the kernel has reported drain when backpressure
 * was applied). Rejects with a backpressure error if neither the
 * write callback nor a `drain` event arrives within `watchdogMs`.
 *
 * AC-SSV-07: synchronous `process.stdout.write` blocks indefinitely
 * when the underlying pipe buffer is full and the consumer (the tmux
 * pane) is wedged. `setTimeout` cannot fire while Node is parked in a
 * blocking syscall, so we drive the write through the async callback
 * path and arm the timer alongside it. If the timer wins, we surface
 * the wedge instead of joining it.
 */
export function writeWithWatchdog(sink, chunk, watchdogMs = MONITOR_STDOUT_WATCHDOG_MS) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (err)
                reject(err);
            else
                resolve();
        };
        // Stays REF'D for the duration of the in-flight write: `finish()`
        // above already clears this timer on every settle path (write
        // callback success/error, drain, or the watchdog itself), so a
        // healthy write releases the handle within microseconds. Ref'd is
        // what lets AC-SSV-07 hold — a wedged sink's watchdog must fire and
        // reject rather than let the event loop resolve out from under a
        // still-pending write.
        const timer = setTimeout(() => {
            finish(new Error(`monitor stdout watchdog: no drain within ${watchdogMs}ms (pane wedged?)`));
        }, watchdogMs);
        let okSync;
        try {
            // The write callback fires once data has been flushed (or errored).
            // It alone is enough to resolve us in the healthy path; the drain
            // listener is a belt-and-braces fallback for sinks that signal
            // completion only via 'drain'.
            okSync = sink.write(chunk, (err) => {
                if (err)
                    finish(err);
                else
                    finish();
            });
        }
        catch (err) {
            finish(err instanceof Error ? err : new Error(String(err)));
            return;
        }
        if (!okSync) {
            // Kernel buffer is full — wait for drain or the watchdog.
            sink.once('drain', () => finish());
            sink.once('error', (err) => {
                finish(err instanceof Error ? err : new Error(String(err)));
            });
        }
    });
}
/**
 * Render the `Elapsed` field value. When `maxTimeMin > 0` and the
 * elapsed wall clock has already overrun the budget, append a bold-red
 * ` EXCEEDED` suffix so operators notice that the run is past its
 * configured time-box.
 *
 * AC-LPB-06: large-pipeline budgets that were undersized at launch
 * still keep running, but the monitor must visibly flag that the
 * configured ceiling has been crossed instead of silently rendering
 * `1000m / 720m` as if it were normal.
 *
 * Exported for unit testing.
 */
export function renderElapsedField(elapsedSec, maxTimeMin) {
    const safeElapsed = Math.max(0, Math.floor(elapsedSec));
    const base = formatTime(safeElapsed);
    if (!(maxTimeMin > 0)) {
        return `${MX.GREEN}elapsed: ${base}${MX.R}`;
    }
    const withCeiling = `elapsed: ${base} / ${maxTimeMin}m`;
    const exceeded = safeElapsed / 60 > maxTimeMin;
    if (!exceeded)
        return `${MX.GREEN}${withCeiling}${MX.R}`;
    return `${MX.GREEN}${withCeiling}${MX.R} ${MX.ERR}EXCEEDED${MX.R}`;
}
/**
 * Extracts a short readable summary from a stream-json log line.
 * Returns the original line (sans ANSI) if it's not valid JSON.
 */
function summarizeAssistantMessage(parsed) {
    const msg = parsed.message;
    if (!msg || !Array.isArray(msg.content))
        return '';
    const parts = [];
    for (const block of msg.content) {
        if (typeof block !== 'object' || block === null)
            continue;
        const b = block;
        if (b.type === 'text' && typeof b.text === 'string') {
            const first = b.text.split('\n')[0].trim();
            if (first)
                parts.push(first);
        }
        else if (b.type === 'tool_use' && typeof b.name === 'string') {
            parts.push(`🔧 ${b.name}`);
        }
    }
    return parts.join(' | ') || '';
}
function summarizeResultMessage(parsed) {
    const isError = typeof parsed.subtype === 'string' && parsed.subtype.startsWith('error');
    return isError ? `❌ ${parsed.subtype}` : '✅ success';
}
function summarizeSystemMessage(parsed) {
    if (parsed.subtype !== 'init')
        return '';
    return `🚀 init (${typeof parsed.model === 'string' ? parsed.model : 'unknown'})`;
}
export function summarizeLine(raw) {
    const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (!clean)
        return '';
    let parsed;
    try {
        parsed = JSON.parse(clean);
    }
    catch {
        return clean;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return clean;
    const type = parsed.type;
    if (type === 'assistant')
        return summarizeAssistantMessage(parsed);
    if (type === 'result')
        return summarizeResultMessage(parsed);
    if (type === 'system')
        return summarizeSystemMessage(parsed);
    return '';
}
const MX = MatrixStyle;
const VALID_MODES = ['pickle', 'microverse', 'idle', 'council', 'refinement', 'szechuan-sauce', 'anatomy-park'];
function normalizeStderrChunk(chunk) {
    return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
}
export function buildMonitorStderrHeader(sessionDir, pid = process.pid, ts = new Date().toISOString()) {
    return `${MONITOR_STDERR_HEADER_PREFIX} session=${path.basename(sessionDir)} pid=${pid} ts=${ts}\n`;
}
export function appendMonitorStderrLog(opts) {
    const logFn = opts.logFn ?? logActivity;
    const capBytes = opts.capBytes ?? MONITOR_STDERR_CAP_BYTES;
    const pid = opts.pid ?? process.pid;
    const ts = opts.ts ?? new Date().toISOString();
    const logPath = path.join(opts.sessionDir, MONITOR_STDERR_LOG_NAME);
    const payload = normalizeStderrChunk(opts.chunk);
    const header = opts.firstWriteForProcess === false ? Buffer.alloc(0) : Buffer.from(buildMonitorStderrHeader(opts.sessionDir, pid, ts), 'utf8');
    const appended = header.length > 0 ? Buffer.concat([header, payload]) : payload;
    // Append unconditionally, then trim from the front only when the file has
    // grown past the cap. The common path is a single append + stat; the whole
    // file is re-read solely on the (rare) rotation path. The previous
    // implementation read the entire log on every write and double-wrote on
    // rotation (append followed by an overwrite that partially undid it).
    fs.appendFileSync(logPath, appended);
    let onDiskSize = appended.length;
    try {
        onDiskSize = fs.statSync(logPath).size;
    }
    catch { /* keep the append length as a best-effort estimate */ }
    let bytesDropped = 0;
    if (onDiskSize > capBytes) {
        bytesDropped = onDiskSize - capBytes;
        let current = appended;
        try {
            current = fs.readFileSync(logPath);
        }
        catch { /* fall back to the just-appended buffer */ }
        fs.writeFileSync(logPath, current.subarray(bytesDropped));
        logFn({
            event: 'monitor_stderr_rotated',
            source: 'pickle',
            session: path.basename(opts.sessionDir),
            pid,
            bytes_dropped: bytesDropped,
            cap: capBytes,
        });
    }
    return { bytesWritten: appended.length, bytesDropped, rotated: bytesDropped > 0 };
}
export function createMonitorStderrCapture(opts) {
    const stderr = opts.stderr ?? process.stderr;
    const logFn = opts.logFn ?? logActivity;
    const originalWrite = stderr.write.bind(stderr);
    let wroteHeader = false;
    const write = (chunk, encoding, cb) => {
        let captureErr = null;
        try {
            appendMonitorStderrLog({
                sessionDir: opts.sessionDir,
                chunk,
                logFn,
                capBytes: opts.capBytes,
                firstWriteForProcess: !wroteHeader,
            });
            wroteHeader = true;
        }
        catch (err) {
            captureErr = err instanceof Error ? err : new Error(String(err));
        }
        if (typeof encoding === 'function') {
            cb = encoding;
            encoding = undefined;
        }
        const ok = originalWrite(chunk, encoding, cb);
        if (captureErr) {
            originalWrite(`[monitor-stderr] capture failure: ${captureErr.message}\n`);
        }
        return ok;
    };
    return {
        write,
        getHasWrittenHeader: () => wroteHeader,
    };
}
/**
 * R-MDS-3: Map a lifecycle step to the MonitorMode that should display it.
 * Returns null for unrecognised steps — callers should preserve the current mode.
 */
export function inferModeFromStep(step) {
    if (step === 'research' || step === 'plan' || step === 'implement' ||
        step === 'verify' || step === 'review' || step === 'simplify') {
        return 'pickle';
    }
    if (step === 'anatomy-park' || step === 'szechuan-sauce') {
        return 'microverse';
    }
    if (step === 'completed' || step == null) {
        return 'idle';
    }
    return null;
}
/**
 * R-MDS-3: Re-read state.step and return the new mode if it differs from
 * currentMode, logging a monitor_mode_swapped event on the transition.
 * Returns currentMode unchanged on identical mode or unreadable state.
 */
export function checkAndSwapMode(sessionDir, currentMode, logFn = logActivity) {
    const statePath = path.join(sessionDir, 'state.json');
    let step;
    try {
        const st = sm.read(statePath);
        step = st.step;
    }
    catch {
        return currentMode;
    }
    const inferred = inferModeFromStep(step);
    if (inferred === null || inferred === currentMode)
        return currentMode;
    logFn({ event: 'monitor_mode_swapped', source: 'pickle', mode: inferred });
    return inferred;
}
/** Unicode sparkline from a sequence of numbers. */
export function sparkline(values) {
    if (values.length === 0)
        return '';
    const blocks = '▁▂▃▄▅▆▇█';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    return values
        .map(v => blocks[Math.min(blocks.length - 1, Math.round(((v - min) / range) * (blocks.length - 1)))])
        .join('');
}
const MV_WIDTH = 80;
function mvTruncate(s) {
    const bare = s.replace(/\x1b\[[0-9;]*[mJH]/g, '');
    if (bare.length <= MV_WIDTH)
        return s;
    return s.slice(0, s.length - (bare.length - MV_WIDTH + 1)) + '…';
}
/**
 * Truncate `s` to at most `limit` characters, appending '…' when cut.
 * `reserve` characters are dropped before the ellipsis (default 1) so the
 * result — ellipsis included — stays within `limit`. Plain-length counterpart
 * to the ANSI-aware {@link mvTruncate}; use this for raw content truncated
 * before being wrapped in color codes.
 */
function truncate(s, limit, reserve = 1) {
    return s.length > limit ? s.slice(0, limit - reserve) + '…' : s;
}
/**
 * Key spellings of a `findings_history` entry's pass verdict — the same table
 * `microverse-runner.ts:isCleanPassEntry` reads as `CLEAN_PASS_VERDICT_KEYS`. Kept local per the
 * Rule of Three (two readers is not yet an abstraction), but it must stay a SUPERSET-compatible
 * copy: widening that table without widening this one only costs the pane a label, never a wrong
 * one, because an unmatched entry falls to the pane's unknown token.
 */
const MV_PASS_VERDICT_KEYS = ['verdict', 'result'];
/**
 * AP-EXT-ITER11-01: the pane's label for ONE `findings_history` entry.
 *
 * The producer is the anatomy-park worker PROMPT (`anatomy-park.md` Override 5), which mandates
 * only "append current findings summary" and fixes no entry schema. The pre-fix `String(entry)`
 * therefore rendered `[object Object]` on 127/127 live entries across 12/12 host artifacts —
 * every shipped entry is an OBJECT, while the only fixture exercising this column fed an array of
 * STRINGS no producer has ever written, which is why the coercion shipped green.
 *
 * A string entry is its own label. An object entry is labelled by its pass verdict. Anything else
 * reads '--', the token this pane already uses for a field it cannot read — never a coerced
 * string, because a label the reader cannot act on is noise that looks like a value.
 */
function mvLastAction(entry) {
    if (typeof entry === 'string')
        return entry;
    if (!entry || typeof entry !== 'object')
        return '--';
    const record = entry;
    const verdict = MV_PASS_VERDICT_KEYS
        .map((key) => record[key])
        .find((value) => typeof value === 'string' && value.trim().length > 0);
    return verdict?.trim() ?? '--';
}
function mvSubsystemLine(name, clean, target, findingsMap) {
    const findings = Array.isArray(findingsMap[name]) ? findingsMap[name] : [];
    const rawLast = findings.length > 0 ? mvLastAction(findings[findings.length - 1]) : '--';
    const lastAction = truncate(rawLast, 20);
    return mvTruncate(`  ${MX.GREEN}${name}${MX.R} ${MX.DIM}${clean}/${target}${MX.R} ${lastAction}`);
}
function mvSubsystems(sessionDir) {
    const out = [`${matrixSeparator(MV_WIDTH)}\n`, `${MX.BRIGHT}Subsystems:${MX.R}\n`];
    let ap = null;
    try {
        ap = readRecoverableJsonObject(path.join(sessionDir, 'anatomy-park.json'));
    }
    catch { /* missing */ }
    const subs = Array.isArray(ap?.subsystems) ? ap.subsystems : [];
    const cleanMap = (typeof ap?.consecutive_clean === 'object' && ap.consecutive_clean != null)
        ? ap.consecutive_clean : {};
    const target = typeof ap?.stall_limit === 'number' ? String(ap.stall_limit) : '--';
    const findingsMap = (typeof ap?.findings_history === 'object' && ap.findings_history != null)
        ? ap.findings_history : {};
    if (subs.length === 0)
        return [...out, `  ${MX.DIM}--${MX.R}\n`];
    for (let i = 0; i < Math.min(5, subs.length); i++) {
        const name = subs[i];
        const clean = cleanMap[name] != null ? String(cleanMap[name]) : '--';
        out.push(`${mvSubsystemLine(name, clean, target, findingsMap)}\n`);
    }
    return out;
}
function mvStall(conv) {
    const sep = `${matrixSeparator(MV_WIDTH)}\n`;
    if (conv == null || conv.stall_counter == null || conv.stall_limit == null) {
        return `${sep}  ${MX.BRIGHT}Stall:${MX.R} ${MX.DIM}--/--${MX.R}\n`;
    }
    const stallColor = conv.stall_limit > 0 && conv.stall_counter / conv.stall_limit >= 0.66 ? MX.ERR : MX.GREEN;
    return `${sep}  ${MX.BRIGHT}Stall:${MX.R} ${stallColor}${conv.stall_counter}/${conv.stall_limit}${MX.R}\n`;
}
function mvTrend(conv) {
    const sep = `${matrixSeparator(MV_WIDTH)}\n`;
    const hist = Array.isArray(conv?.history) ? conv.history : [];
    const last10 = hist.slice(-10);
    if (last10.length === 0)
        return `${sep}  ${MX.BRIGHT}Metric Trend:${MX.R} ${MX.DIM}--${MX.R}\n`;
    const scores = last10.map(h => h.score);
    const spark = sparkline(scores);
    const minVal = Math.min(...scores);
    const maxVal = Math.max(...scores);
    return `${sep}${mvTruncate(`  ${MX.BRIGHT}Metric Trend:${MX.R} ${MX.DIM}${minVal}${MX.R} ${MX.GREEN}${spark}${MX.R} ${MX.DIM}${maxVal}${MX.R}`)}\n`;
}
/**
 * R-MDS-4: Render the full microverse dashboard with 4 sections.
 * Width ≤ 80 cols, height ≤ 14 lines. Missing fields render '--'.
 */
export function renderMicroverseDashboard(state, microverseJson) {
    const out = ['\x1b[2J\x1b[H', `${MX.BRIGHT}◤ MICROVERSE MONITOR ◢${MX.R}\n`];
    out.push(...mvSubsystems(state.session_dir || ''));
    const iter = state.iteration ?? '--';
    const cap = state.max_iterations ?? '--';
    const fh = Array.isArray(microverseJson?.failure_history)
        ? microverseJson.failure_history : [];
    const last5 = fh.slice(-5).map(f => f.failure_class || '--').join(', ') || '--';
    out.push(`${matrixSeparator(MV_WIDTH)}\n`);
    out.push(`${mvTruncate(`  ${MX.BRIGHT}Convergence:${MX.R} iter ${iter}/${cap} | last 5: ${last5}`)}\n`);
    out.push(mvStall(microverseJson?.convergence));
    out.push(mvTrend(microverseJson?.convergence));
    return out.join('');
}
/** Render a compact microverse convergence trend section. */
export function renderMicroverseTrend(mv, width) {
    const out = [];
    const sep = matrixSeparator(width);
    const history = mv.convergence?.history ?? [];
    const direction = mv.key_metric.direction ?? 'higher';
    const targetLabel = mv.convergence_target != null ? String(mv.convergence_target) : '—';
    out.push(`\n${sep}\n${MX.BRIGHT}Metric Trend${MX.R} ${MX.DIM}(${direction} is better, target: ${targetLabel})${MX.R}\n`);
    if (history.length === 0) {
        out.push(`  ${MX.DIM}No measurements yet${MX.R}\n`);
        return out;
    }
    // Sparkline of all scores (accepted + reverted)
    const scores = history.map(h => h.score);
    const spark = sparkline(scores);
    const latest = scores[scores.length - 1];
    const latestAction = history[history.length - 1].action;
    const latestColor = latestAction === 'accept' ? MX.GREEN : MX.ERR;
    out.push(`  ${MX.DIM}Score:${MX.R} ${latestColor}${latest}${MX.R}  ${MX.GREEN}${spark}${MX.R}\n`);
    // Compact history: last 8 entries as "iter:score(action)"
    const tail = history.slice(-8);
    const entries = tail.map(h => {
        const sym = h.action === 'accept' ? '✓' : '✗';
        const c = h.action === 'accept' ? MX.GREEN : MX.ERR;
        return `${c}${h.iteration}:${h.score}${sym}${MX.R}`;
    });
    out.push(`  ${entries.join(` ${MX.DIM}→${MX.R} `)}\n`);
    // Stall counter
    const { stall_counter, stall_limit } = mv.convergence;
    if (stall_counter > 0) {
        const stallColor = stall_counter >= stall_limit - 1 ? MX.ERR : MX.WARN;
        out.push(`  ${stallColor}Stall: ${stall_counter}/${stall_limit}${MX.R}\n`);
    }
    // Status badge
    if (mv.status === 'converged') {
        out.push(`  ${MX.BRIGHT}${MX.GREEN}◆ CONVERGED${MX.R}\n`);
    }
    else if (mv.status === 'stopped') {
        out.push(`  ${MX.WARN}◇ STOPPED${mv.exit_reason ? ` (${mv.exit_reason})` : ''}${MX.R}\n`);
    }
    return out;
}
/**
 * Format the `Current` header field as `<id>: <title>` when a matching ticket
 * exists, truncated to pane width. Falls back to bare id or "none".
 */
export function formatCurrentField(currentTicketId, tickets, width) {
    if (!currentTicketId)
        return `${MX.DIM}none${MX.R}`;
    const match = tickets.find((t) => t.id === currentTicketId);
    const title = match?.title?.trim();
    const raw = title ? `${currentTicketId}: ${title}` : String(currentTicketId);
    // Reserve ~16 cols for the "  Current: " label + padding
    const maxLen = Math.max(8, width - 16);
    const display = truncate(raw, maxLen);
    return `${MX.BRIGHT}${display}${MX.R}`;
}
function colorTicketStatus(ticket) {
    const status = (ticket.status || '').toLowerCase();
    const sym = statusSymbol(ticket.status);
    if (status === 'done')
        return `${MX.GREEN}${sym}${MX.R}`;
    if (status === 'in progress')
        return `${MX.WARN}${sym}${MX.R}`;
    return `${MX.DIM}${sym}${MX.R}`;
}
function renderTicketLine(ticket, currentTicketId) {
    const isCurrent = ticket.id === currentTicketId;
    const prefix = isCurrent ? `${MX.BRIGHT}▸${MX.R}` : ' ';
    const titleStr = isCurrent
        ? `${MX.BRIGHT}${ticket.title || ''}${MX.R}`
        : `${MX.GREEN}${ticket.title || ''}${MX.R}`;
    return `${prefix} ${colorTicketStatus(ticket)} ${MX.DIM}${ticket.id}:${MX.R} ${titleStr}\n`;
}
function findTicketWindowAnchor(tickets, currentTicketId) {
    const currentIdx = currentTicketId
        ? tickets.findIndex((t) => t.id === currentTicketId)
        : -1;
    if (currentIdx >= 0)
        return currentIdx;
    let lastDone = -1;
    for (let i = 0; i < tickets.length; i++) {
        if ((tickets[i].status || '').toLowerCase() === 'done')
            lastDone = i;
    }
    return lastDone >= 0 ? lastDone : 0;
}
/**
 * Build the ticket list section as an array of pre-formatted lines (each
 * ending in `\n`). When `tickets.length` fits within `budget`, renders the
 * full list. Otherwise, windows the slice around the current (or last-done)
 * ticket, keeping the current ticket visible with a trailing buffer of
 * upcoming tickets, and emits `... N more above/below ...` indicators.
 *
 * Exported for unit testing. `budget` is the max number of ticket body lines
 * available (including any indicator lines). Caller accounts for the
 * "Tickets:" section header separately.
 */
export function buildTicketLines(tickets, currentTicketId, budget) {
    if (tickets.length === 0)
        return [];
    const renderOne = (ticket) => {
        return renderTicketLine(ticket, currentTicketId);
    };
    if (budget <= 0 || tickets.length <= budget) {
        return tickets.map(renderOne);
    }
    const anchorIdx = findTicketWindowAnchor(tickets, currentTicketId);
    // Reserve up to 2 lines for the above/below indicators.
    const bodyBudget = Math.max(1, budget - 2);
    const trailingBuffer = 3;
    let end = Math.min(tickets.length, anchorIdx + trailingBuffer + 1);
    let start = Math.max(0, end - bodyBudget);
    if (anchorIdx < start || anchorIdx >= end) {
        start = Math.max(0, anchorIdx - Math.floor(bodyBudget / 2));
        end = Math.min(tickets.length, start + bodyBudget);
    }
    if (end === tickets.length) {
        start = Math.max(0, tickets.length - bodyBudget);
    }
    if (start === 0) {
        end = Math.min(tickets.length, bodyBudget);
    }
    const out = [];
    if (start > 0) {
        out.push(`  ${MX.DIM}... ${start} more above ...${MX.R}\n`);
    }
    for (let i = start; i < end; i++) {
        out.push(renderOne(tickets[i]));
    }
    if (end < tickets.length) {
        out.push(`  ${MX.DIM}... ${tickets.length - end} more below ...${MX.R}\n`);
    }
    return out;
}
function readTailUtf8(filePath, maxBytes) {
    const { size } = fs.statSync(filePath);
    const readStart = Math.max(0, size - maxBytes);
    if (readStart === 0)
        return fs.readFileSync(filePath, 'utf-8');
    const buf = Buffer.allocUnsafe(size - readStart);
    const fd = fs.openSync(filePath, 'r');
    try {
        fs.readSync(fd, buf, 0, buf.length, readStart);
    }
    finally {
        fs.closeSync(fd);
    }
    const raw = buf.toString('utf-8');
    const firstNewline = raw.indexOf('\n');
    return firstNewline !== -1 ? raw.slice(firstNewline + 1) : raw;
}
export function readPipelineLifecycle(sessionDir) {
    const pipelinePath = path.join(sessionDir, 'pipeline.json');
    if (!fs.existsSync(pipelinePath))
        return 'none';
    const statusPath = path.join(sessionDir, 'pipeline-status.json');
    try {
        const raw = readRecoverableJsonObject(statusPath);
        if (raw && (raw.status === 'running' ||
            raw.status === 'completed' ||
            raw.status === 'failed' ||
            raw.status === 'cancelled')) {
            return raw.status;
        }
    }
    catch {
        // Fall back to the runner log for older sessions without pipeline-status.json.
    }
    const runnerLogPath = path.join(sessionDir, 'pipeline-runner.log');
    try {
        const tail = readTailUtf8(runnerLogPath, 8192);
        if (tail.includes('Pipeline finished:'))
            return 'completed';
        if (tail.includes('shutting down pipeline'))
            return 'cancelled';
        if (tail.includes('pipeline-runner started'))
            return 'running';
    }
    catch {
        // No runner log yet — treat as in-progress until proven terminal.
    }
    return 'unknown';
}
export function shouldMonitorExit(sessionDir, active) {
    if (active)
        return false;
    const lifecycle = readPipelineLifecycle(sessionDir);
    if (lifecycle === 'none')
        return true;
    return lifecycle === 'completed' || lifecycle === 'failed' || lifecycle === 'cancelled';
}
function countRows(segments) {
    let n = 0;
    for (const s of segments) {
        for (let i = 0; i < s.length; i++)
            if (s.charCodeAt(i) === 10)
                n++;
    }
    return n;
}
async function pathExists(p) {
    try {
        await fs.promises.access(p);
        return true;
    }
    catch {
        return false;
    }
}
function appendCircuitField(fields, sessionDir) {
    try {
        const cb = readCircuitBreakerState(sessionDir);
        if (!cb)
            throw new Error('circuit breaker state unavailable');
        if (cb.state === 'CLOSED') {
            fields.push(['Circuit', `${MX.GREEN}CLOSED${MX.R}`]);
        }
        else if (cb.state === 'HALF_OPEN') {
            fields.push(['Circuit', `${MX.WARN}HALF_OPEN (${cb.reason || ''})${MX.R}`]);
        }
        else if (cb.state === 'OPEN') {
            fields.push(['Circuit', `${MX.ERR}OPEN (${cb.reason || ''})${MX.R}`]);
        }
    }
    catch {
        // circuit_breaker.json missing or corrupt — skip field
    }
}
function appendRateLimitField(fields, sessionDir, nowMs) {
    try {
        const waitPath = path.join(sessionDir, 'rate_limit_wait.json');
        const waitData = readRecoverableJsonObject(waitPath);
        if (!waitData || waitData.waiting !== true || !waitData.wait_until)
            return;
        const remainMs = new Date(String(waitData.wait_until)).getTime() - nowMs;
        const typeLabel = waitData.rate_limit_type ? ` [${String(waitData.rate_limit_type)}]` : '';
        const sourceLabel = waitData.wait_source === 'api' ? ' (API reset)' : '';
        if (remainMs > 0) {
            const remainSec = Math.ceil(remainMs / 1000);
            fields.push(['Rate Limit', `${MX.WARN}⏳ Rate limited${typeLabel}${sourceLabel} (${formatTime(remainSec)} remaining)${MX.R}`]);
        }
        else {
            fields.push(['Rate Limit', `${MX.WARN}⏳ Rate limit wait ending...${MX.R}`]);
        }
    }
    catch { /* no wait state */ }
}
function buildHeaderFields(state, tickets, width, sessionDir, nowMs) {
    const startEpoch = Number(state.start_time_epoch) || 0;
    const elapsed = startEpoch > 0 ? Math.max(0, Math.floor(nowMs / 1000) - startEpoch) : 0;
    const maxIter = Number(state.max_iterations) || 0;
    const maxTime = Number(state.max_time_minutes) || 0;
    const iterStr = maxIter > 0 ? `${state.iteration} / ${state.max_iterations}` : `${state.iteration}`;
    const workDir = state.working_dir || '';
    const project = workDir ? path.basename(workDir) : 'unknown';
    const task = state.original_prompt || '';
    const taskDisplay = truncate(task, width - 20, 3) || 'none';
    const fields = [
        ['Project', `${MX.BRIGHT}${project}${MX.R}`],
        ['Task', `${MX.GREEN}${taskDisplay}${MX.R}`],
        ['Phase', `${MX.CYAN}${state.step || 'unknown'}${MX.R}`],
        ['Iteration', `${MX.GREEN}${iterStr}${MX.R}`],
        ['Elapsed', renderElapsedField(elapsed, maxTime)],
        ['Current', formatCurrentField(state.current_ticket, tickets, width)],
        ['Active', state.active === true ? `${MX.BRIGHT}▣ ONLINE${MX.R}` : `${MX.ERR}▢ OFFLINE${MX.R}`],
    ];
    appendCircuitField(fields, sessionDir);
    appendRateLimitField(fields, sessionDir, nowMs);
    return fields;
}
function buildRecentOutput(sessionDir, width, sep) {
    const recentOut = [];
    try {
        const logPath = latestIterationLog(sessionDir);
        if (!logPath)
            return recentOut;
        const TAIL_BYTES = 65536;
        const tail = readTailUtf8(logPath, TAIL_BYTES);
        const summaryLines = tail
            .split('\n')
            .filter((l) => l.trim())
            .slice(-10)
            .map(summarizeLine)
            .filter((l) => l.length > 0)
            .slice(-5);
        if (summaryLines.length === 0)
            return recentOut;
        recentOut.push(`\n${sep}\n${MX.DIM}Recent output:${MX.R}\n`);
        for (const logLine of summaryLines) {
            const truncated = truncate(logLine, width - 2, 3);
            recentOut.push(`${MX.GREEN}  ${truncated}${MX.R}\n`);
        }
    }
    catch {
        /* ignore */
    }
    return recentOut;
}
function buildPickleOutput(state, sessionDir, width) {
    const sep = matrixSeparator(width);
    const tickets = collectTickets(sessionDir);
    const nowMs = Date.now();
    const fields = buildHeaderFields(state, tickets, width, sessionDir, nowMs);
    const keyWidth = Math.max(...fields.map(([k]) => k.length)) + 1;
    const out = ['\x1b[2J\x1b[H'];
    out.push(`\n${MX.BRIGHT}◤ PICKLE RICK — LIVE MONITOR ◢${MX.R}\n`);
    out.push(`${sep}\n`);
    for (const [k, v] of fields) {
        out.push(`  ${MX.DIM}${k + ':'}${' '.repeat(keyWidth - k.length)}${MX.R} ${v}\n`);
    }
    try {
        const mv = readMicroverseState(sessionDir);
        if (mv?.convergence?.history) {
            out.push(...renderMicroverseTrend(mv, width));
        }
    }
    catch {
        // No microverse session — skip
    }
    const recentOut = buildRecentOutput(sessionDir, width, sep);
    const footer = `\n${MX.DIM}Refreshing every 2s  •  Ctrl+C to detach${MX.R}\n`;
    if (tickets.length > 0) {
        const ticketHeader = `\n${sep}\n${MX.BRIGHT}Tickets:${MX.R}\n`;
        const headerRows = countRows(out);
        const recentRows = countRows(recentOut);
        const footerRows = countRows([footer]);
        const ticketHeaderRows = 3;
        const height = getHeight();
        const budget = Math.max(1, height - headerRows - recentRows - footerRows - ticketHeaderRows - 1);
        const ticketLines = buildTicketLines(tickets, state.current_ticket, budget);
        if (ticketLines.length > 0) {
            out.push(ticketHeader);
            out.push(...ticketLines);
        }
    }
    out.push(...recentOut);
    out.push(footer);
    return out;
}
export function renderDashboard(state, mode, sessionDir, width) {
    if (mode === 'idle') {
        return ['\x1b[2J\x1b[H', `${MX.BRIGHT}Pipeline complete${MX.R}\n`];
    }
    if (mode === 'microverse' || mode === 'anatomy-park' || mode === 'szechuan-sauce') {
        const mvPath = path.join(sessionDir, 'microverse.json');
        if (!fs.existsSync(mvPath)) {
            return ['\x1b[2J\x1b[H', `${MX.BRIGHT}◤ MICROVERSE MONITOR ◢${MX.R}\n`, `  ${MX.DIM}microverse: initializing…${MX.R}\n`];
        }
        const mv = readRecoverableJsonObject(mvPath);
        return [renderMicroverseDashboard(state, mv)];
    }
    return buildPickleOutput(state, sessionDir, width);
}
/**
 * R-MWCL-2: TypeError from renderDashboard indicates a transient mode-field mismatch
 * (e.g. pickle mode rendering against a szechuan-sauce session whose pickle-specific
 * fields haven't landed yet). Recoverable — return false and let the !active retry
 * path call checkAndSwapMode. Non-TypeErrors are genuine I/O or corrupt-state faults
 * and must propagate to main() so process.exit(2) fires loudly.
 */
export function isModeMatchError(err) {
    return err instanceof TypeError;
}
export async function render(sessionDir, mode, sink = process.stdout, _renderDashboardFn) {
    // If the session directory itself is gone, signal exit (not just "waiting")
    if (!(await pathExists(sessionDir)))
        return false;
    const statePath = path.join(sessionDir, 'state.json');
    let state;
    try {
        state = sm.read(statePath);
    }
    catch {
        await writeWithWatchdog(sink, `\x1b[2J\x1b[H${MX.DIM}Awaiting signal...${MX.R}\n`);
        return true;
    }
    const width = getWidth();
    const renderFn = _renderDashboardFn ?? renderDashboard;
    let segments;
    try {
        segments = renderFn(state, mode, sessionDir, width);
    }
    catch (err) {
        if (isModeMatchError(err)) {
            process.stderr.write(`[render-mode-mismatch] ${err instanceof Error ? err.message : String(err)}\n`);
            return false;
        }
        throw err;
    }
    await writeWithWatchdog(sink, segments.join(''));
    return state.active === true;
}
/**
 * R-MWR-2: env kill-switch. When `PICKLE_MONITOR_WATCHDOG === 'off'` the
 * dead-pane respawn watchdog is fully disabled — no setInterval is
 * armed, no tmux probes fire, no log lines are emitted. Operators flip
 * this when they need to debug a frozen pane manually without the
 * watchdog reviving it underfoot.
 *
 * Returns `true` when the watchdog is disabled.
 */
export function isRespawnWatchdogDisabled(env = process.env) {
    return env.PICKLE_MONITOR_WATCHDOG === 'off';
}
/**
 * R-MWR-1: register a continuous watchdog inside the monitor pane that
 * re-runs `restartDeadWatcherPanes` every {@link RESPAWN_WATCHDOG_INTERVAL_MS}.
 *
 * `ensureMonitorWindow` already calls `restartDeadWatcherPanes` once at
 * window-creation / re-attach time, but if a watcher pane dies AFTER that
 * call (e.g., a `log-watcher` worker crashed mid-iteration), the dead
 * pane stays dead until the next mux-runner phase boundary calls
 * `ensureMonitorWindow` again. This watchdog plugs that gap with a 30s
 * heartbeat from inside the live monitor process.
 *
 * The interval is `unref()`'d so it never holds the process open past
 * the natural exit conditions (SIGINT or `state.active` flip). Errors
 * inside the callback are swallowed so a transient `tmux` failure does
 * not crash the dashboard.
 *
 * Returns the timer handle for tests / explicit shutdown; the
 * production `main()` discards it.
 */
export function startRespawnWatchdog(opts) {
    // R-MWR-2: env kill-switch. Bail before scheduling so disabling the
    // watchdog truly disables it — no timer, no logs, no tmux calls.
    if (isRespawnWatchdogDisabled(opts.env ?? process.env))
        return null;
    // R-MMRT-2: defense in depth — validate sessionDir before arming the interval.
    if (!validateSessionDirOrSkip(opts.sessionDir, 'startRespawnWatchdog')) {
        process.stderr.write(`${JSON.stringify({ event: 'monitor_respawn_session_dir_invalid', caller: 'startRespawnWatchdog' })}\n`);
        return null;
    }
    const intervalMs = opts.intervalMs ?? RESPAWN_WATCHDOG_INTERVAL_MS;
    const log = opts.logger || (() => { });
    // R-MWCL-5: one-shot flag so the first tick logs errors to stderr in
    // addition to the logger; subsequent interval ticks use logger only.
    let isFirstTick = true;
    const tick = () => {
        try {
            const extensionRoot = opts.extensionRoot ?? getExtensionRoot();
            const mode = inferMonitorMode(opts.sessionDir);
            // R-MWR-3: tag respawn decisions as `monitor-watchdog:` so they
            // can be distinguished in mux-runner.log from boundary-driven
            // restartDeadWatcherPanes calls (AC-MWR-05).
            restartDeadWatcherPanes(opts.sessionDir, extensionRoot, mode, opts.spawnSyncFn ?? spawnSync, 'monitor-watchdog');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`monitor-watchdog tick error: ${msg}`);
            if (isFirstTick) {
                process.stderr.write(`[respawn-watchdog] first-tick error: ${msg}\n`);
            }
        }
        finally {
            isFirstTick = false;
        }
    };
    const _setInterval = opts.setIntervalFn ?? setInterval;
    const handle = _setInterval(tick, intervalMs);
    if (typeof handle.unref === 'function') {
        handle.unref();
    }
    // R-MWCL-5: write startup marker before the first tick so the log line
    // precedes any setInterval-scheduled tick in mux-runner.log.
    const startupTs = new Date().toISOString();
    try {
        fs.appendFileSync(path.join(opts.sessionDir, 'mux-runner.log'), `${startupTs} monitor-watchdog startup: first tick at ${startupTs}\n`);
    }
    catch { /* best-effort */ }
    // R-MWCL-5: fire once synchronously so collapsed panes recover
    // immediately instead of waiting a full watchdog interval.
    tick();
    return handle;
}
function parseMonitorArgs(args) {
    let mode = 'pickle';
    let sessionDir;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--mode') {
            const val = args[i + 1];
            if (!val || val.startsWith('--') || !VALID_MODES.includes(val)) {
                console.error(`monitor: unknown mode '${val ?? ''}' — must be one of: ${VALID_MODES.join(' | ')}`);
                process.exit(64);
            }
            mode = val;
            i++;
        }
        else if (!args[i].startsWith('--')) {
            sessionDir = args[i];
        }
    }
    return { sessionDir, mode };
}
/**
 * AC-SSV-07: never block on stdout in the signal handler. If the pane is wedged a
 * synchronous write would prevent the exit. Try the detach banner asynchronously, but
 * exit unconditionally either way so Ctrl-C always wins.
 */
function installMonitorSigintHandler() {
    process.on('SIGINT', () => {
        try {
            process.stdout.write(`\x1b[2J\x1b[H${MX.DIM}Monitor detached.${MX.R}\n`, () => {
                process.exit(0);
            });
        }
        catch { /* fall through */ }
        setTimeout(() => process.exit(0), 50).unref();
    });
}
/**
 * AC-SSV-07: render() awaits writeWithWatchdog internally, so a wedged stdout surfaces
 * here as a rejected promise rather than a blocked iteration. We exit with status 2 + a
 * clear stderr message instead of joining the wedge — kill -9 should never be required.
 */
async function renderOrExit(sessionDir, mode) {
    try {
        return await render(sessionDir, mode);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[monitor] ${msg}\n`);
        process.exit(2);
    }
}
/** The terminal banner runs under the same wedge discipline as `renderOrExit`. */
async function announceSessionCompleteOrExit() {
    try {
        await writeWithWatchdog(process.stdout, `\n${MX.BRIGHT}◤ SESSION COMPLETE ◢${MX.R}\n`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[monitor] ${msg}\n`);
        process.exit(2);
    }
}
/**
 * One inactive render is not an exit: the session may be between iterations. Confirm with a
 * second render 3s later and only then ask the session whether it is allowed to end.
 */
async function isSessionFinished(sessionDir, mode) {
    await sleep(3000);
    const stillInactive = !(await renderOrExit(sessionDir, mode));
    return stillInactive && shouldMonitorExit(sessionDir, false);
}
async function runMonitorLoop(sessionDir, initialMode) {
    let mode = initialMode;
    while (true) {
        const active = await renderOrExit(sessionDir, mode);
        if (!active && await isSessionFinished(sessionDir, mode)) {
            await announceSessionCompleteOrExit();
            break;
        }
        // R-MDS-3: re-check state.step each tick and hot-swap mode if phase changed.
        mode = checkAndSwapMode(sessionDir, mode);
        await sleep(2000);
    }
}
async function main() {
    const { sessionDir, mode } = parseMonitorArgs(process.argv.slice(2));
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (!sessionDir || !fs.existsSync(sessionDir)) {
        console.error('Usage: node monitor.js <session-dir> [--mode pickle|microverse|idle|council|refinement|szechuan-sauce|anatomy-park]');
        process.exit(1);
    }
    const stderrCapture = createMonitorStderrCapture({ sessionDir });
    process.stderr.write = stderrCapture.write;
    // R-MWCL-4: startup marker for per-pane log (captured via shell 2>> redirect)
    process.stderr.write(`[monitor-0] starting at ${new Date().toISOString()} (pid=${process.pid})\n`);
    // R-MWR-1: arm the dead-pane respawn watchdog before entering the
    // render loop so panes that die mid-iteration get revived without
    // waiting for the next mux-runner phase boundary.
    startRespawnWatchdog({ sessionDir });
    installMonitorSigintHandler();
    await runMonitorLoop(sessionDir, mode);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'monitor.js') {
    main().catch((err) => {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}[monitor] ${msg}${Style.RESET}`);
        process.exit(1);
    });
}
