import * as fs from 'node:fs';
import * as path from 'node:path';
import { StateManager, acquireLockFile, reclaimDeadLock, releaseLockFile, } from './state-manager.js';
import { isRecord } from '../lib/is-record.js';
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
/**
 * The wrapper fields `ReverseLedger` declares. `satisfies` makes the compiler the
 * owner of this list: a field added to the interface without being added here is a
 * type error, so it cannot silently become the one shape the parser fails to see.
 */
const REVERSE_LEDGER_WRAPPER_KEYS = ['entries', 'actions', 'steps'];
/**
 * AP-EXT-ITER197-01: `null` means "this text is NOT a ledger container", which is
 * a different fact from "this container is empty". Returning `[]` for a
 * non-container is what let a one-entry ledger resolve to zero entries.
 */
function resolveLedgerEntries(parsed) {
    if (Array.isArray(parsed))
        return parsed;
    if (!isRecord(parsed))
        return null;
    const key = REVERSE_LEDGER_WRAPPER_KEYS.find(candidate => Array.isArray(parsed[candidate]));
    if (key !== undefined)
        return parsed[key];
    // Carries a wrapper field but no usable array: an EMPTY container, never a record.
    return REVERSE_LEDGER_WRAPPER_KEYS.some(candidate => candidate in parsed) ? [] : null;
}
function parseJsonDocumentOrNull(trimmed) {
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return null;
    }
}
/**
 * AP-EXT-ITER197-01: the container-vs-JSONL decision reads the PARSED STRUCTURE,
 * never the text's shape. The prior discriminator asked whether the trimmed text
 * started with `{` and held no newline — a LINE COUNT, which a one-entry JSONL
 * apply ledger satisfies exactly. It then resolved that lone entry as a wrapper,
 * found no `entries`/`actions`/`steps` key, and returned `[]`, so the
 * single-step crash window reversed NOTHING and reported success.
 */
function parseLedgerContent(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return [];
    const wrapped = resolveLedgerEntries(parseJsonDocumentOrNull(trimmed));
    return wrapped ?? trimmed
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
/**
 * AP-EXT-ITER8-02: the reversal decision comes from the entry's `action`
 * discriminant, NEVER from "prior content is null/absent". Only an entry that
 * says the apply CREATED the file may delete it; everything else restores, and
 * a non-create entry with no recorded content is unrestorable — leave it alone
 * rather than destroying a file that pre-dated the transaction.
 */
function planReversal(entry) {
    if (entry.action === 'create' || entry.action === 'created')
        return { kind: 'delete' };
    const priorContent = restoreContent(entry);
    if (typeof priorContent === 'string')
        return { kind: 'restore', content: priorContent };
    return { kind: 'unrestorable' };
}
function warnUnrestorable(targetPath) {
    process.stderr.write(`[transaction-ticket-ops] ledger entry for ${targetPath} records no prior content under a non-create action; leaving the file in place\n`);
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
        const reversal = planReversal(entry);
        if (reversal.kind === 'delete') {
            if (fs.existsSync(targetPath))
                fs.rmSync(targetPath, { force: true, recursive: true });
            removeEmptyParents(path.dirname(targetPath), sessionRoot);
            continue;
        }
        if (reversal.kind === 'unrestorable') {
            warnUnrestorable(targetPath);
            continue;
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, reversal.content);
        restored.push({ path: targetPath, content: reversal.content });
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
/**
 * Reclaims the restructure lock from a holder we can PROVE is dead — never an age verdict: a
 * restructure legitimately holds while it rewrites every ticket in the session, so an age arm
 * (the one `withRetryLock` carries) would evict a LIVE holder mid-transaction. Both rules live in
 * the shared `reclaimDeadLock` composition this delegates to.
 */
function reclaimDeadRestructureLock(lockFile) {
    reclaimDeadLock(lockFile);
}
function acquireFileLock(lockFile) {
    // Payload is the BARE holder pid — the one encoding `isDeadPidPayload` reads. The prior
    // `{pid,ts}` JSON parsed to NaN there, so any steal bolted onto it would silently never fire.
    let acquired = acquireLockFile(lockFile, String(process.pid));
    if (acquired === null) {
        reclaimDeadRestructureLock(lockFile);
        acquired = acquireLockFile(lockFile, String(process.pid));
    }
    if (acquired === null) {
        const err = new Error(`EEXIST: restructure lock is held, open '${lockFile}'`);
        err.code = 'EEXIST';
        err.path = lockFile;
        throw err;
    }
    // Release is identity-bound: a lock we no longer own (ours was stolen) is left for its new holder.
    const held = acquired;
    return () => { releaseLockFile(lockFile, held); };
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
    let beforeReadError = null;
    if (existed) {
        try {
            beforeContent = fs.readFileSync(file.path, 'utf-8');
        }
        catch (error) {
            beforeReadError = safeErrorMessage(error);
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
    // AP-EXT-ITER8-02: an existing file we could not read has no recoverable prior
    // content, so overwriting it is unreversible. Refuse the write instead of
    // recording a `beforeContent: null` the reversal cannot honor.
    if (beforeReadError !== null) {
        const message = `Refusing to overwrite ${file.path}: prior content is unreadable (${beforeReadError})`;
        appendApplyLedger(ledgerPath, ledgerEntry('failed', message));
        throw new Error(message);
    }
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
function reverseAppliedEntries(entries, sessionRoot) {
    const reversedSteps = [];
    for (const entry of [...selectForwardEntries(entries)].reverse()) {
        const targetPath = resolveLedgerPath(sessionRoot, entry.path);
        const reversal = planReversal(entry);
        if (reversal.kind === 'delete') {
            if (fs.existsSync(targetPath))
                fs.rmSync(targetPath, { force: true, recursive: true });
            removeEmptyParents(path.dirname(targetPath), sessionRoot);
        }
        else if (reversal.kind === 'unrestorable') {
            warnUnrestorable(targetPath);
            continue;
        }
        else {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, reversal.content, 'utf-8');
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
            ? reverseAppliedEntries(entries, sessionRoot)
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
function buildApplyContext(input) {
    const sessionRoot = path.resolve(input.sessionRoot);
    const killedTicketIds = input.killedTicketIds ?? [];
    const addedTickets = input.addedTickets ?? [];
    return {
        sessionRoot,
        ledgerPath: assertWithinRoot(input.ledgerPath ? path.resolve(input.ledgerPath) : proposalApplyLedgerPath(sessionRoot, input.proposalPath), sessionRoot),
        nowIso: timestampForLedger(input.now),
        proposalPath: input.proposalPath,
        restartTicketId: input.restartTicketId,
        killedTicketIds,
        addedTickets,
        killedSet: new Set(killedTicketIds),
        addedSet: new Set(addedTickets.map(ticket => ticket.ticketId)),
    };
}
/** Kills then adds, numbering every ledger step from one running counter. Returns the step count. */
function applyTicketFileWrites(ctx) {
    const { sessionRoot, ledgerPath, nowIso } = ctx;
    let step = 0;
    for (const ticketId of ctx.killedTicketIds) {
        step += 1;
        const planned = updateTicketStatusInTransaction(ticketId, 'Killed', sessionRoot, { now: nowIso });
        applyPlannedWrite(ledgerPath, step, 'kill_ticket', ticketId, planned, nowIso);
    }
    for (const ticket of ctx.addedTickets) {
        const plan = materializeNewTicket({ ...ticket, sessionRoot });
        for (const file of plan.files) {
            step += 1;
            applyPlannedWrite(ledgerPath, step, 'add_ticket', ticket.ticketId, file, nowIso);
        }
    }
    return step;
}
function applyBranchCurrentTicket(state, branch, ctx) {
    // R-CNAR-8: every course-correct current_ticket transition MUST clear the cache
    // fields. Pre-fix, the new ticket inherited tier/budget/max-iter from the killed
    // ticket and skewed budget calculations.
    if (branch === 'a') {
        state.current_ticket = ctx.restartTicketId ?? null;
        clearCurrentTicketCache(state);
        return;
    }
    if (branch !== 'c')
        return;
    const previousTicket = state.current_ticket;
    const redirectedTicket = resolveAddedCurrentTicket(state, ctx.addedSet);
    state.current_ticket = redirectedTicket;
    clearCurrentTicketCache(state);
    appendActivity(state, {
        event: 'current_ticket_redirected_to_new',
        from_ticket_id: previousTicket,
        to_ticket_id: redirectedTicket,
        ticket_id: redirectedTicket,
        timestamp: ctx.nowIso,
    });
}
/** Bumps tickets_version and records the correction. Call AFTER the writes — after_count reads the new tree. */
function recordCourseCorrectionApplied(state, branch, beforeCount, ctx) {
    const currentVersion = typeof state.tickets_version === 'number' && Number.isFinite(state.tickets_version)
        ? state.tickets_version
        : 0;
    const ticketsVersion = currentVersion + 1;
    state.tickets_version = ticketsVersion;
    state.last_course_correction = {
        proposal_path: ctx.proposalPath,
        applied_iso: ctx.nowIso,
        restart_ticket_id: ctx.restartTicketId,
        before_count: beforeCount,
        after_count: collectTicketDirectoryIds(ctx.sessionRoot).length,
    };
    appendActivity(state, {
        event: 'course_corrected',
        timestamp: ctx.nowIso,
        proposal_path: ctx.proposalPath,
        killed_ticket_ids: ctx.killedTicketIds,
        added_ticket_ids: [...ctx.addedSet],
        branch,
        tickets_version: ticketsVersion,
    });
    appendActivity(state, {
        event: 'readiness_delta_requested',
        timestamp: ctx.nowIso,
        reason: 'course_corrected',
        tickets_version: ticketsVersion,
    });
    return ticketsVersion;
}
function rollbackAndHaltApply(error, ctx, stateManager, autoApply) {
    const { sessionRoot, ledgerPath, nowIso } = ctx;
    if (fs.existsSync(ledgerPath))
        replayReverseLedger(ledgerPath, sessionRoot);
    const failedEntry = latestFailedEntry(ledgerPath);
    if (!autoApply || !failedEntry)
        return;
    const cause = failedEntry.error ?? safeErrorMessage(error);
    const haltPath = writeHaltFile(sessionRoot, ledgerPath, failedEntry.step, cause, nowIso);
    appendStateActivity(sessionRoot, stateManager, {
        event: 'course_correct_apply_failed',
        timestamp: nowIso,
        failed_step: failedEntry.step,
        cause,
        ledger_path: ledgerPath,
        halt_path: haltPath,
    });
}
export function applyCourseCorrectionRestructure(input) {
    const ctx = buildApplyContext(input);
    const stateManager = input.stateManager ?? new StateManager();
    const statePath = path.join(ctx.sessionRoot, 'state.json');
    let branch = 'b';
    let ticketsVersion = 0;
    let appliedSteps = 0;
    const releaseRestructureLock = acquireFileLock(path.join(ctx.sessionRoot, 'restructure.lock'));
    try {
        stateManager.transaction([statePath], ([state]) => {
            const beforeCount = collectTicketDirectoryIds(ctx.sessionRoot).length;
            branch = resolveCurrentTicketBranch(state, ctx.killedSet, ctx.addedSet);
            appliedSteps = applyTicketFileWrites(ctx);
            applyBranchCurrentTicket(state, branch, ctx);
            ticketsVersion = recordCourseCorrectionApplied(state, branch, beforeCount, ctx);
        });
        return { ledgerPath: ctx.ledgerPath, branch, ticketsVersion, appliedSteps };
    }
    catch (error) {
        rollbackAndHaltApply(error, ctx, stateManager, input.autoApply === true);
        throw error;
    }
    finally {
        releaseRestructureLock();
    }
}
