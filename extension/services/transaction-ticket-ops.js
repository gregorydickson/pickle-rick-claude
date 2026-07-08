import * as fs from 'node:fs';
import * as path from 'node:path';
import { StateManager } from './state-manager.js';
function isWithinRoot(targetPath, rootPath) {
    const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function assertWithinRoot(targetPath, rootPath) {
    if (!isWithinRoot(targetPath, rootPath)) {
        throw new Error(`Path escapes ticket transaction root: ${targetPath}`);
    }
    return targetPath;
}
function resolveTicketDir(sessionDir, ticketId) {
    return path.join(sessionDir, ticketId);
}
function findRickTicketFile(ticketDir) {
    const ticketFile = fs
        .readdirSync(ticketDir)
        .find(file => file.startsWith('rick_ticket_') && file.endsWith('.md'));
    if (!ticketFile)
        throw new Error(`No rick ticket file found in ${ticketDir}`);
    return path.join(ticketDir, ticketFile);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function extractFrontmatter(content) {
    const openLen = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : 0;
    if (openLen === 0)
        return null;
    const closeIdx = content.indexOf('\n---', openLen);
    if (closeIdx === -1)
        return null;
    const rawEnd = closeIdx + 4;
    const end = content[rawEnd] === '\n'
        ? rawEnd + 1
        : content[rawEnd] === '\r' && content[rawEnd + 1] === '\n'
            ? rawEnd + 2
            : rawEnd;
    return { body: content.slice(openLen, closeIdx), start: 0, end };
}
function setFrontmatterField(content, field, value) {
    const fm = extractFrontmatter(content);
    if (!fm)
        return content;
    const existingField = new RegExp(`^${escapeRegExp(field)}:\\s*.*$`, 'm');
    if (existingField.test(fm.body)) {
        return content.replace(existingField, `${field}: "${value}"`);
    }
    const closingNewline = content.lastIndexOf('\n---', fm.end - 1);
    if (closingNewline === -1)
        return content;
    const insertPoint = closingNewline + 1;
    return content.slice(0, insertPoint) + `${field}: "${value}"\n` + content.slice(insertPoint);
}
function statusTimestampField(status) {
    const normalized = String(status).toLowerCase();
    if (normalized === 'done')
        return 'completed_at';
    if (normalized === 'skipped')
        return 'skipped_at';
    return null;
}
function timestamp(ctx) {
    if (ctx?.now instanceof Date)
        return ctx.now.toISOString();
    if (typeof ctx?.now === 'string')
        return ctx.now;
    return new Date().toISOString();
}
function assertStatusWasUpdated(before, after, filePath) {
    if (before === after) {
        throw new Error(`Ticket status could not be updated in ${filePath}`);
    }
}
export function updateTicketStatusInTransaction(ticketId, newStatus, sessionDir, txCtx) {
    const ticketDir = resolveTicketDir(sessionDir, ticketId);
    const filePath = findRickTicketFile(ticketDir);
    const content = fs.readFileSync(filePath, 'utf-8');
    let updated = content.replace(/^(status:\s*).*$/m, `$1"${newStatus}"`);
    assertStatusWasUpdated(content, updated, filePath);
    const timestampField = statusTimestampField(newStatus);
    if (timestampField) {
        updated = setFrontmatterField(updated, timestampField, timestamp(txCtx));
    }
    return { path: filePath, content: updated };
}
function defaultTicketContent(spec) {
    const frontmatter = {
        id: spec.ticketId,
        status: 'Todo',
        ...spec.frontmatter,
    };
    const lines = Object.entries(frontmatter).map(([key, value]) => {
        if (typeof value === 'number' || typeof value === 'boolean')
            return `${key}: ${value}`;
        if (value === null)
            return `${key}: null`;
        return `${key}: "${value}"`;
    });
    return `---\n${lines.join('\n')}\n---\n\n${spec.body ?? ''}`;
}
export function materializeNewTicket(spec) {
    const root = spec.dirPath ?? path.join(spec.sessionDir ?? spec.sessionRoot ?? '', spec.ticketId);
    if (!root || root === spec.ticketId) {
        throw new Error('materializeNewTicket requires dirPath, sessionDir, or sessionRoot');
    }
    const files = spec.files && spec.files.length > 0
        ? spec.files
        : [{
                name: spec.ticketFileName ?? `rick_ticket_${spec.ticketId}.md`,
                content: spec.content ?? defaultTicketContent(spec),
            }];
    return {
        dirPath: root,
        files: files.map(file => ({
            path: assertWithinRoot(file.path ?? path.join(root, file.name ?? `rick_ticket_${spec.ticketId}.md`), root),
            content: file.content,
        })),
    };
}
function resolveLedgerEntries(parsed) {
    if (Array.isArray(parsed))
        return parsed;
    return parsed.entries ?? parsed.actions ?? parsed.steps ?? [];
}
function parseLedgerContent(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return [];
    if (trimmed.startsWith('[') || (trimmed.startsWith('{') && !trimmed.includes('\n'))) {
        return resolveLedgerEntries(JSON.parse(trimmed));
    }
    return trimmed
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line));
}
function parseApplyLedgerContent(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return [];
    const parsed = trimmed.startsWith('[')
        ? JSON.parse(trimmed)
        : trimmed
            .split(/\r?\n/)
            .filter(line => line.trim().length > 0)
            .map(line => JSON.parse(line));
    return parsed.filter(entry => Number.isInteger(entry.step) && typeof entry.path === 'string');
}
function resolveLedgerPath(sessionRoot, entryPath) {
    const targetPath = path.isAbsolute(entryPath) ? entryPath : path.join(sessionRoot, entryPath);
    return assertWithinRoot(targetPath, sessionRoot);
}
function restoreContent(entry) {
    if ('beforeContent' in entry)
        return entry.beforeContent;
    if ('previousContent' in entry)
        return entry.previousContent;
    if ('backupContent' in entry)
        return entry.backupContent;
    return undefined;
}
function removeEmptyParents(startDir, stopDir) {
    let current = startDir;
    while (isWithinRoot(current, stopDir) && path.resolve(current) !== path.resolve(stopDir)) {
        try {
            fs.rmdirSync(current);
        }
        catch {
            return;
        }
        current = path.dirname(current);
    }
}
export function replayReverseLedger(ledgerPath, sessionRoot) {
    const entries = parseLedgerContent(fs.readFileSync(ledgerPath, 'utf-8'));
    const restored = [];
    for (const entry of [...entries].reverse()) {
        const targetPath = resolveLedgerPath(sessionRoot, entry.path);
        const priorContent = restoreContent(entry);
        if (priorContent === undefined || priorContent === null) {
            if (fs.existsSync(targetPath))
                fs.rmSync(targetPath, { force: true, recursive: true });
            removeEmptyParents(path.dirname(targetPath), sessionRoot);
            continue;
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, priorContent);
        restored.push({ path: targetPath, content: priorContent });
    }
    return restored;
}
function timestampForLedger(now) {
    if (now instanceof Date)
        return now.toISOString();
    if (typeof now === 'string')
        return now;
    return new Date().toISOString();
}
function proposalApplyLedgerPath(sessionRoot, proposalPath) {
    const base = path.basename(proposalPath).replace(/\.md$/i, '');
    return path.join(sessionRoot, `${base}_apply.log`);
}
function latestApplyLedgerPath(sessionRoot) {
    const ledgers = fs
        .readdirSync(sessionRoot, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^change_proposal_.*_apply\.log$/.test(entry.name))
        .map(entry => {
        const filePath = path.join(sessionRoot, entry.name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.filePath.localeCompare(a.filePath));
    if (ledgers.length === 0)
        throw new Error(`No course-correction apply ledger found in ${sessionRoot}`);
    return ledgers[0].filePath;
}
function acquireFileLock(lockFile) {
    const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    fs.closeSync(fd);
    return () => {
        try {
            fs.unlinkSync(lockFile);
        }
        catch { /* already released */ }
    };
}
function appendApplyLedger(ledgerPath, entry) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}
function safeErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function collectTicketDirectoryIds(sessionRoot) {
    return fs
        .readdirSync(sessionRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
}
function resolveCurrentTicketBranch(state, killedSet, addedSet) {
    const current = state.current_ticket;
    if (current && killedSet.has(current))
        return 'a';
    if (current && addedSet.has(current))
        return 'c';
    return 'b';
}
function resolveAddedCurrentTicket(state, addedSet) {
    const current = state.current_ticket;
    if (current && addedSet.has(current))
        return current;
    return null;
}
function appendActivity(state, entry) {
    const existing = Array.isArray(state.activity) ? state.activity : [];
    state.activity = [...existing, entry];
}
function applyPlannedWrite(ledgerPath, step, operation, ticketId, file, nowIso) {
    assertWithinRoot(file.path, path.dirname(ledgerPath));
    const existed = fs.existsSync(file.path);
    let beforeContent = null;
    if (existed) {
        try {
            beforeContent = fs.readFileSync(file.path, 'utf-8');
        }
        catch {
            beforeContent = null;
        }
    }
    const action = existed ? 'write' : 'create';
    const ledgerEntry = (status, error) => ({
        step,
        action,
        operation,
        ticket_id: ticketId,
        path: file.path,
        status,
        recovery_class: existed ? 'restore-previous-content' : 'delete-created',
        beforeContent,
        previousContent: beforeContent,
        afterContent: file.content,
        content: file.content,
        ...(error !== undefined ? { error } : {}),
        createdAt: nowIso,
    });
    appendApplyLedger(ledgerPath, ledgerEntry('started'));
    try {
        fs.mkdirSync(path.dirname(file.path), { recursive: true });
        fs.writeFileSync(file.path, file.content, 'utf-8');
    }
    catch (error) {
        appendApplyLedger(ledgerPath, ledgerEntry('failed', safeErrorMessage(error)));
        throw error;
    }
    appendApplyLedger(ledgerPath, ledgerEntry('applied'));
}
function writeHaltFile(sessionRoot, ledgerPath, failedStep, cause, nowIso) {
    const haltPath = path.join(sessionRoot, `HALT_${isoSafeStamp(nowIso)}.md`);
    const content = [
        '# Course Correction Apply Halted',
        '',
        `Failed step: ${failedStep}`,
        `Cause: ${cause}`,
        `Ledger path: ${ledgerPath}`,
        '',
        '## Recovery Options',
        '',
        '1. Run `/pickle-correct-course --recover-from-ledger` to replay-reverse the partial apply.',
        '2. Run `/pickle-correct-course --recover --force` to forward-replay the ledger after fixing a transient cause.',
        '3. Run `/pickle-status --reset-current-ticket` to abandon this correction and force ticket selection.',
        '',
        '## If You Do Nothing',
        '',
        'The runner remains halted at the next iteration boundary until an operator chooses a recovery option.',
        '',
    ].join('\n');
    fs.writeFileSync(haltPath, content, 'utf-8');
    return haltPath;
}
function isoSafeStamp(nowIso) {
    return nowIso.replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}
function appendStateActivity(sessionRoot, stateManager, entry) {
    const statePath = path.join(sessionRoot, 'state.json');
    if (!fs.existsSync(statePath))
        return;
    stateManager.update(statePath, (state) => {
        appendActivity(state, entry);
    });
}
function lastSuccessfulStep(entries) {
    return entries.reduce((max, entry) => entry.status === 'applied' ? Math.max(max, entry.step) : max, 0);
}
function reverseAppliedEntries(entries, sessionRoot, throughStep) {
    const reversedSteps = [];
    for (const entry of entries.filter(item => item.status === 'applied' && item.step <= throughStep).reverse()) {
        const targetPath = resolveLedgerPath(sessionRoot, entry.path);
        const priorContent = restoreContent(entry);
        if (priorContent === undefined || priorContent === null) {
            if (fs.existsSync(targetPath))
                fs.rmSync(targetPath, { force: true, recursive: true });
            removeEmptyParents(path.dirname(targetPath), sessionRoot);
        }
        else {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, priorContent, 'utf-8');
        }
        reversedSteps.push(entry.step);
    }
    return reversedSteps;
}
function selectForwardEntries(entries) {
    const byStep = new Map();
    for (const entry of entries) {
        if (entry.status === 'started' || entry.status === 'applied' || entry.status === 'failed') {
            byStep.set(entry.step, entry);
        }
    }
    return [...byStep.values()].sort((a, b) => a.step - b.step);
}
function forwardReplayEntries(entries, sessionRoot) {
    const replayedSteps = [];
    for (const entry of selectForwardEntries(entries)) {
        const nextContent = entry.afterContent ?? entry.content;
        if (nextContent === undefined) {
            throw new Error(`Ledger step ${entry.step} is missing replay content`);
        }
        const targetPath = resolveLedgerPath(sessionRoot, entry.path);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, nextContent, 'utf-8');
        replayedSteps.push(entry.step);
    }
    return replayedSteps;
}
export function recoverCourseCorrectionFromLedger(input) {
    const sessionRoot = path.resolve(input.sessionRoot);
    const ledgerPath = assertWithinRoot(input.ledgerPath ? path.resolve(input.ledgerPath) : latestApplyLedgerPath(sessionRoot), sessionRoot);
    const nowIso = timestampForLedger(input.now);
    const stateManager = input.stateManager ?? new StateManager();
    const releaseRestructureLock = acquireFileLock(path.join(sessionRoot, 'restructure.lock'));
    try {
        const entries = parseApplyLedgerContent(fs.readFileSync(ledgerPath, 'utf-8'));
        const lastStep = lastSuccessfulStep(entries);
        if (input.mode === 'forward' && !input.force) {
            throw new Error('--recover requires --force for forward ledger replay');
        }
        const recoveredSteps = input.mode === 'reverse'
            ? reverseAppliedEntries(entries, sessionRoot, lastStep)
            : forwardReplayEntries(entries, sessionRoot);
        appendStateActivity(sessionRoot, stateManager, {
            event: 'course_correct_recovered',
            timestamp: nowIso,
            mode: input.mode,
            ledger_path: ledgerPath,
            last_successful_step: lastStep,
            recovered_steps: recoveredSteps,
        });
        return { ledgerPath, mode: input.mode, lastSuccessfulStep: lastStep, recoveredSteps };
    }
    finally {
        releaseRestructureLock();
    }
}
function latestFailedEntry(ledgerPath) {
    if (!fs.existsSync(ledgerPath))
        return undefined;
    const entries = parseApplyLedgerContent(fs.readFileSync(ledgerPath, 'utf-8'));
    return entries.filter(entry => entry.status === 'failed').at(-1);
}
/**
 * R-CNAR-8: single source of truth for the per-ticket cache fields that MUST be
 * cleared atomically whenever a course-correction transition re-points
 * `current_ticket`. Stale values here let the new ticket inherit the killed
 * ticket's tier/budget/max-iter and skew budget calculations. Kept local
 * (mirrors the private helper in state-manager.ts) — importing pickle-utils'
 * canonical `clearTicketCacheFields` here would create a new
 * transaction-ticket-ops → pickle-utils module cycle.
 */
function clearCurrentTicketCache(s) {
    delete s.current_ticket_tier;
    delete s.current_ticket_budget;
    delete s.current_ticket_max_iterations;
    delete s.current_ticket_worker_timeout_seconds;
    delete s.current_ticket_budget_start_iteration;
}
export function applyCourseCorrectionRestructure(input) {
    const sessionRoot = path.resolve(input.sessionRoot);
    const statePath = path.join(sessionRoot, 'state.json');
    const ledgerPath = assertWithinRoot(input.ledgerPath ? path.resolve(input.ledgerPath) : proposalApplyLedgerPath(sessionRoot, input.proposalPath), sessionRoot);
    const nowIso = timestampForLedger(input.now);
    const killedTicketIds = input.killedTicketIds ?? [];
    const addedTickets = input.addedTickets ?? [];
    const killedSet = new Set(killedTicketIds);
    const addedSet = new Set(addedTickets.map(ticket => ticket.ticketId));
    const stateManager = input.stateManager ?? new StateManager();
    let branch = 'b';
    let ticketsVersion = 0;
    let appliedSteps = 0;
    const releaseRestructureLock = acquireFileLock(path.join(sessionRoot, 'restructure.lock'));
    try {
        stateManager.transaction([statePath], ([state]) => {
            const beforeTickets = collectTicketDirectoryIds(sessionRoot);
            branch = resolveCurrentTicketBranch(state, killedSet, addedSet);
            for (const ticketId of killedTicketIds) {
                appliedSteps += 1;
                const planned = updateTicketStatusInTransaction(ticketId, 'Killed', sessionRoot, { now: nowIso });
                applyPlannedWrite(ledgerPath, appliedSteps, 'kill_ticket', ticketId, planned, nowIso);
            }
            for (const ticket of addedTickets) {
                const plan = materializeNewTicket({ ...ticket, sessionRoot });
                for (const file of plan.files) {
                    appliedSteps += 1;
                    applyPlannedWrite(ledgerPath, appliedSteps, 'add_ticket', ticket.ticketId, file, nowIso);
                }
            }
            if (branch === 'a') {
                state.current_ticket = input.restartTicketId ?? null;
                // R-CNAR-8: course-correct current_ticket transition MUST clear cache
                // fields. Pre-fix, the new ticket inherited tier/budget/max-iter from
                // the killed ticket and skewed budget calculations.
                clearCurrentTicketCache(state);
            }
            if (branch === 'c') {
                const previousTicket = state.current_ticket;
                const redirectedTicket = resolveAddedCurrentTicket(state, addedSet);
                state.current_ticket = redirectedTicket;
                // R-CNAR-8: redirect-current-ticket transition MUST clear cache fields.
                clearCurrentTicketCache(state);
                appendActivity(state, {
                    event: 'current_ticket_redirected_to_new',
                    from_ticket_id: previousTicket,
                    to_ticket_id: redirectedTicket,
                    ticket_id: redirectedTicket,
                    timestamp: nowIso,
                });
            }
            const currentVersion = typeof state.tickets_version === 'number' && Number.isFinite(state.tickets_version)
                ? state.tickets_version
                : 0;
            ticketsVersion = currentVersion + 1;
            state.tickets_version = ticketsVersion;
            state.last_course_correction = {
                proposal_path: input.proposalPath,
                applied_iso: nowIso,
                restart_ticket_id: input.restartTicketId,
                before_count: beforeTickets.length,
                after_count: collectTicketDirectoryIds(sessionRoot).length,
            };
            appendActivity(state, {
                event: 'course_corrected',
                timestamp: nowIso,
                proposal_path: input.proposalPath,
                killed_ticket_ids: killedTicketIds,
                added_ticket_ids: [...addedSet],
                branch,
                tickets_version: ticketsVersion,
            });
            appendActivity(state, {
                event: 'readiness_delta_requested',
                timestamp: nowIso,
                reason: 'course_corrected',
                tickets_version: ticketsVersion,
            });
        });
        return { ledgerPath, branch, ticketsVersion, appliedSteps };
    }
    catch (error) {
        if (fs.existsSync(ledgerPath))
            replayReverseLedger(ledgerPath, sessionRoot);
        const failedEntry = latestFailedEntry(ledgerPath);
        if (input.autoApply && failedEntry) {
            const haltPath = writeHaltFile(sessionRoot, ledgerPath, failedEntry.step, failedEntry.error ?? safeErrorMessage(error), nowIso);
            appendStateActivity(sessionRoot, stateManager, {
                event: 'course_correct_apply_failed',
                timestamp: nowIso,
                failed_step: failedEntry.step,
                cause: failedEntry.error ?? safeErrorMessage(error),
                ledger_path: ledgerPath,
                halt_path: haltPath,
            });
        }
        throw error;
    }
    finally {
        releaseRestructureLock();
    }
}
