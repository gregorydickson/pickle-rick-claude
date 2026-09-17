#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Style, sleep, drainLog, MatrixStyle, matrixSeparator, safeErrorMessage, detectLogTruncation } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
const ARTIFACT_IGNORE = new Set(['state.json']);
const ARTIFACT_RECENCY_MS = 30000;
const sm = new StateManager();
/**
 * Classifies an artifact filename into a progress category.
 */
export function classifyArtifact(fileName) {
    if (fileName.startsWith('research_') || fileName.startsWith('analysis_'))
        return '📖 Researching...';
    if (fileName.startsWith('plan_'))
        return '📐 Planning...';
    return '🔨 Implementing...';
}
function lstatOrNull(filePath) {
    try {
        return fs.lstatSync(filePath);
    }
    catch {
        return null;
    }
}
function readdirOrEmpty(dirPath) {
    try {
        return fs.readdirSync(dirPath);
    }
    catch {
        return [];
    }
}
/** Ticket directories directly under the session dir; unreadable entries are skipped. */
function listTicketDirs(sessionDir) {
    return readdirOrEmpty(sessionDir)
        .map((ticketId) => ({ ticketId, dirPath: path.join(sessionDir, ticketId) }))
        .filter(({ dirPath }) => lstatOrNull(dirPath)?.isDirectory() === true);
}
/**
 * Scans ticket directories for recently created files (within 30s)
 * that aren't state.json or log files. Used as a fallback when
 * no worker logs exist (inline-processed tickets).
 */
export function discoverArtifacts(sessionDir, seenArtifacts) {
    const now = Date.now();
    const results = [];
    for (const { ticketId, dirPath } of listTicketDirs(sessionDir)) {
        for (const file of readdirOrEmpty(dirPath)) {
            if (ARTIFACT_IGNORE.has(file) || file.endsWith('.log'))
                continue;
            const filePath = path.join(dirPath, file);
            if (seenArtifacts.has(filePath))
                continue;
            const fileStat = lstatOrNull(filePath);
            if (!fileStat?.isFile() || now - fileStat.mtimeMs > ARTIFACT_RECENCY_MS)
                continue;
            seenArtifacts.add(filePath);
            results.push({ ticketId, filePath, fileName: file });
        }
    }
    return results;
}
function discoverWorkerLogs(sessionDir) {
    const entries = [];
    for (const { ticketId, dirPath } of listTicketDirs(sessionDir)) {
        for (const file of readdirOrEmpty(dirPath)) {
            if (!file.startsWith('worker_session_') || !file.endsWith('.log'))
                continue;
            const logPath = path.join(dirPath, file);
            const logStat = lstatOrNull(logPath);
            if (!logStat?.isFile())
                continue;
            entries.push({ ticketId, logPath, mtimeMs: logStat.mtimeMs });
        }
    }
    return entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.logPath.localeCompare(b.logPath));
}
/**
 * R-MWR-4 + R-MWR-6: shared truncation handler. Resets the watcher's
 * file offset on shrinkage and emits exactly one dim `(reconnecting...)`
 * line per disconnect. Extracted to keep `main()` cyclomatic complexity
 * within the project lint cap.
 */
function handleTruncation(currentLog, offset, mx) {
    const truncCheck = detectLogTruncation(currentLog, offset, '');
    if (!truncCheck.truncated)
        return offset;
    process.stdout.write(`\n${mx.DIM}(reconnecting...)${mx.R}\n`);
    return truncCheck.offset;
}
async function handleNoWorkerLogs(sessionDir, seenArtifacts, sep, mx, currentTicket) {
    const artifacts = discoverArtifacts(sessionDir, seenArtifacts);
    if (artifacts.length > 0) {
        let ticket = currentTicket;
        for (const art of artifacts) {
            const label = classifyArtifact(art.fileName);
            if (art.ticketId !== ticket) {
                ticket = art.ticketId;
                process.stdout.write(`\n${sep()}\n${mx.BRIGHT}▸ ${art.ticketId}${mx.R}\n${sep()}\n`);
            }
            process.stdout.write(`  ${label} ${mx.DIM}${art.fileName}${mx.R}\n`);
        }
        return { action: 'continue', currentTicket: ticket };
    }
    try {
        const state = sm.read(path.join(sessionDir, 'state.json'));
        if (state.active !== true) {
            process.stdout.write(`\n${sep()}\n${mx.BRIGHT}◤ FEED TERMINATED ◢${mx.R}\n`);
            return { action: 'break', currentTicket };
        }
        if (state.monitor_panes?.[2]?.producer_done === true) {
            process.stdout.write(`\r${mx.DIM}Producer complete${mx.R}\x1b[K`);
        }
        else {
            process.stdout.write(`\r${mx.DIM}Awaiting worker signal...${mx.R}\x1b[K`);
        }
    }
    catch {
        process.stdout.write(`\r${mx.DIM}Awaiting worker signal...${mx.R}\x1b[K`);
    }
    return { action: 'continue', currentTicket };
}
async function main() {
    const sessionDir = process.argv[2];
    // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
    if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
        console.error('Usage: node morty-watcher.js <session-dir>');
        process.exit(1);
    }
    process.on('SIGINT', () => {
        process.stdout.write('\nDetached.\n');
        process.exit(0);
    });
    const MX = MatrixStyle;
    const sep = () => matrixSeparator(Math.min((process.stdout.columns || 60) - 2, 60));
    process.stdout.write(`\n${MX.BRIGHT}◤ WORKER LOGS ◢${MX.R}\n${sep()}\n`);
    let currentLog = null;
    let currentTicket = null;
    let offset = 0;
    const seenArtifacts = new Set();
    while (true) {
        const logs = discoverWorkerLogs(sessionDir);
        if (logs.length === 0) {
            const noLogsResult = await handleNoWorkerLogs(sessionDir, seenArtifacts, sep, MX, currentTicket);
            currentTicket = noLogsResult.currentTicket;
            if (noLogsResult.action === 'break')
                break;
            await sleep(1000);
            continue;
        }
        const latest = logs[logs.length - 1];
        if (latest.logPath !== currentLog) {
            const isNewTicket = latest.ticketId !== currentTicket;
            currentLog = latest.logPath;
            currentTicket = latest.ticketId;
            offset = 0;
            if (isNewTicket) {
                process.stdout.write(`\n${sep()}\n${MX.BRIGHT}▸ ${latest.ticketId}${MX.R}\n${sep()}\n`);
            }
            else {
                const pid = path.basename(latest.logPath, '.log').replace('worker_session_', '');
                process.stdout.write(`\n${sep()}\n${MX.WARN}▸ RETRY (PID ${pid})${MX.R}\n${sep()}\n`);
            }
        }
        // R-MWR-4 + R-MWR-6: detect truncation of currentLog so post-truncate
        // content is consumed instead of skipped by drainLog's size<=offset
        // early-return. A dim `(reconnecting...)` line on EOF/truncation,
        // NEVER the `◤ FEED TERMINATED ◢` banner — that's reserved for the
        // inactive-state liveness branch below.
        offset = handleTruncation(currentLog, offset, MX);
        offset = drainLog(currentLog, offset);
        try {
            const state = sm.read(path.join(sessionDir, 'state.json'));
            if (state.active !== true) {
                await sleep(2000);
                drainLog(currentLog, offset);
                process.stdout.write(`\n${sep()}\n${MX.BRIGHT}◤ FEED TERMINATED ◢${MX.R}\n`);
                break;
            }
        }
        catch {
            /* ignore */
        }
        await sleep(500);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'morty-watcher.js') {
    main().catch((err) => {
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}[morty-watcher] ${msg}${Style.RESET}`);
        process.exit(1);
    });
}
