import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
function statusSymbol(status) {
    if (status === 'done') return '[x]';
    if (status === 'in progress') return '[~]';
    return '[ ]';
}
function parseTicketFrontmatter(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) return null;
        const fm = fmMatch[1];
        const get = (field) => {
            const m = fm.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
            return m ? m[1].trim() : null;
        };
        return {
            id: get('id'),
            title: get('title'),
            status: get('status'),
            order: parseInt(get('order') || '0', 10),
        };
    } catch {
        return null;
    }
}
function collectTickets(sessionDir) {
    try {
        const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
        const tickets = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const subDir = path.join(sessionDir, entry.name);
            try {
                const files = fs.readdirSync(subDir);
                for (const file of files) {
                    if (!file.startsWith('linear_ticket_') || !file.endsWith('.md')) continue;
                    const parsed = parseTicketFrontmatter(path.join(subDir, file));
                    if (parsed) tickets.push(parsed);
                }
            } catch {
                /* skip */
            }
        }
        return tickets.sort((a, b) => a.order - b.order);
    } catch {
        return [];
    }
}
function buildHandoffSummary(state, sessionDir) {
    const task = state.original_prompt || '';
    const truncatedTask = task.length > 300 ? task.slice(0, 300) + ' [truncated]' : task;
    const prdPath = path.join(sessionDir, 'prd.md');
    const prdExists = fs.existsSync(prdPath);
    const tickets = collectTickets(sessionDir);
    const iterLine = state.max_iterations > 0
        ? `${state.iteration} of ${state.max_iterations}`
        : `${state.iteration}`;
    const lines = [
        '=== PICKLE RICK LOOP CONTEXT ===',
        `Phase: ${state.step || 'unknown'}`,
        `Iteration: ${iterLine}`,
        `Session: ${sessionDir}`,
        `Ticket: ${state.current_ticket || 'none'}`,
        `Task: ${truncatedTask}`,
        `PRD: ${prdExists ? 'exists' : 'not yet created'}`,
    ];
    if (tickets.length > 0) {
        lines.push('Tickets:');
        for (const t of tickets) {
            const sym = statusSymbol(t.status || '');
            const title = (t.title || '').length > 60
                ? (t.title || '').slice(0, 60) + '...'
                : (t.title || '');
            lines.push(`  ${sym} ${t.id || '?'}: ${title}`);
        }
    }
    lines.push(
        '',
        'NEXT ACTION: Resume from current phase. Read state.json for context.',
        'Do NOT restart from PRD. Continue where you left off.',
    );
    return lines.join('\n');
}
async function main() {
    const extensionDir = process.env.EXTENSION_DIR || path.join(os.homedir(), '.claude/pickle-rick');
    const globalDebugLog = path.join(extensionDir, 'debug.log');
    let sessionHooksLog = null;
    const log = (msg) => {
        const ts = new Date().toISOString();
        const formatted = `[${ts}] [StopHookJS] ${msg}\n`;
        try {
            fs.appendFileSync(globalDebugLog, formatted);
        }
        catch {
            /* ignore */
        }
        if (sessionHooksLog) {
            try {
                fs.appendFileSync(sessionHooksLog, formatted);
            }
            catch {
                /* ignore */
            }
        }
    };
    // 1. Read Input
    let inputData = '';
    try {
        inputData = fs.readFileSync(0, 'utf8');
    }
    catch {
        log('Failed to read stdin');
        process.exit(0);
        return;
    }
    const input = JSON.parse(inputData || '{}');
    log(`Processing Stop hook. Input size: ${inputData.length}`);
    // 2. Determine State File — use input.cwd (confirmed available) not process.cwd()
    const cwd = input.cwd || process.cwd();
    let stateFile = process.env.PICKLE_STATE_FILE;
    if (!stateFile) {
        const sessionsMapPath = path.join(extensionDir, 'current_sessions.json');
        log(`Checking sessions map at: ${sessionsMapPath}`);
        if (fs.existsSync(sessionsMapPath)) {
            const map = JSON.parse(fs.readFileSync(sessionsMapPath, 'utf8'));
            const sessionPath = map[cwd];
            log(`Found session path for ${cwd}: ${sessionPath}`);
            if (sessionPath)
                stateFile = path.join(sessionPath, 'state.json');
        }
    }
    if (!stateFile || !fs.existsSync(stateFile)) {
        log(`No state file found. (stateFile: ${stateFile})`);
        process.exit(0);
        return;
    }
    // Initialize session-specific hook log
    sessionHooksLog = path.join(path.dirname(stateFile), 'hooks.log');
    log(`State file found: ${stateFile}`);
    // 3. Read State
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // 4. Check CWD — use cwd (from input) not process.cwd()
    if (state.working_dir && path.resolve(state.working_dir) !== path.resolve(cwd)) {
        log(`CWD Mismatch: ${cwd} !== ${state.working_dir}`);
        process.exit(0);
        return;
    }
    // 5. Inactive check
    if (!state.active) {
        log('Decision: ALLOW (Session inactive)');
        process.exit(0);
        return;
    }
    // 6. jar_complete guard (prevents infinite loop from prior Gemini jar sessions)
    if (state.jar_complete) {
        log('Decision: ALLOW (jar_complete)');
        process.exit(0);
        return;
    }
    // 7. Determine worker role
    const role = process.env.PICKLE_ROLE;
    const isWorker = role === 'worker' || state.worker;
    log(`State: active=${state.active}, iteration=${state.iteration}/${state.max_iterations}`);
    log(`Context: role=${role}, isWorker=${isWorker}, cwd=${cwd}`);
    // 8. Increment iteration — GUARDED for workers (workers share Rick's state file)
    if (!isWorker) {
        state.iteration = (state.iteration || 0) + 1;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        log(`Incremented iteration to ${state.iteration}`);
    }
    // 9. stop_hook_active safety guard — prevents unbounded loops if other limits fail
    if (input.stop_hook_active && state.max_iterations > 0 && state.iteration >= state.max_iterations) {
        log('Decision: ALLOW (stop_hook_active safety guard — iteration at max)');
        state.active = false;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        process.exit(0);
        return;
    }
    // 10. Check Completion Promises
    const responseText = input.last_assistant_message || '';
    log(`Agent response preview: ${responseText.slice(0, 100).replace(/\n/g, ' ')}...`);
    const hasPromise = state.completion_promise &&
        responseText.includes(`<promise>${state.completion_promise}</promise>`);
    // Stop Tokens (Full Exit)
    const isEpicDone = responseText.includes('<promise>EPIC_COMPLETED</promise>');
    const isTaskFinished = responseText.includes('<promise>TASK_COMPLETED</promise>');
    // Continue Tokens (Checkpoint)
    const isWorkerDone = isWorker && responseText.includes('<promise>I AM DONE</promise>');
    const isPrdDone = !isWorker && responseText.includes('<promise>PRD_COMPLETE</promise>');
    const isBreakdownDone = !isWorker && responseText.includes('<promise>BREAKDOWN_COMPLETE</promise>');
    const isTicketSelected = !isWorker && responseText.includes('<promise>TICKET_SELECTED</promise>');
    const isTicketDone = !isWorker && responseText.includes('<promise>TICKET_COMPLETE</promise>');
    const isTaskDone = !isWorker && responseText.includes('<promise>TASK_COMPLETE</promise>');
    log(`Promises: hasPromise=${hasPromise}, isEpicDone=${isEpicDone}, isTaskFinished=${isTaskFinished}, isWorkerDone=${isWorkerDone}, isPrdDone=${isPrdDone}, isBreakdownDone=${isBreakdownDone}, isTicketSelected=${isTicketSelected}, isTicketDone=${isTicketDone}, isTaskDone=${isTaskDone}`);
    // EXIT CONDITIONS: Full Exit
    if (hasPromise || isEpicDone || isTaskFinished || isWorkerDone) {
        log(`Decision: ALLOW (Task/Worker complete)`);
        if (!isWorker) {
            state.active = false;
            fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        }
        process.exit(0);
        return;
    }
    // CONTINUE CONDITIONS: Block exit to force next iteration
    if (isTaskDone || isTicketDone || isBreakdownDone || isPrdDone || isTicketSelected) {
        log(`Decision: BLOCK (Checkpoint reached)`);
        let feedback = '🥒 **Pickle Rick Loop Active** - ';
        if (isPrdDone)
            feedback += 'PRD finished, moving to breakdown...';
        if (isBreakdownDone)
            feedback += 'Breakdown finished, moving to implementation...';
        if (isTicketSelected)
            feedback += 'Ticket selected, starting research...';
        if (isTaskDone || isTicketDone)
            feedback += 'Ticket finished, moving to next...';
        let summary;
        try {
            summary = buildHandoffSummary(state, path.dirname(stateFile));
        } catch (e) {
            log(`buildHandoffSummary failed: ${e}`);
            const fp = state.original_prompt || '';
            summary = `🥒 Pickle Rick Loop Active (Iteration ${state.iteration})\nTask: ${fp.length > 300 ? fp.slice(0, 300) + ' [truncated]' : fp}`;
        }
        console.log(JSON.stringify({
            decision: 'block',
            reason: `${feedback}\n\n${summary}`,
        }));
        return;
    }
    // 11. Check Limits (Final Guard)
    const now = Math.floor(Date.now() / 1000);
    const elapsedSeconds = now - state.start_time_epoch;
    if (state.max_iterations > 0 && state.iteration >= state.max_iterations) {
        log(`Decision: ALLOW (Max iterations reached: ${state.iteration}/${state.max_iterations})`);
        state.active = false;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        process.exit(0);
        return;
    }
    if (state.max_time_minutes > 0 && elapsedSeconds >= state.max_time_minutes * 60) {
        log(`Decision: ALLOW (Time limit reached: ${elapsedSeconds}s)`);
        state.active = false;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        process.exit(0);
        return;
    }
    // 12. Default: Continue Loop (Prevent Exit)
    log('Decision: BLOCK (Default continuation)');
    let summary;
    try {
        summary = buildHandoffSummary(state, path.dirname(stateFile));
    } catch (e) {
        log(`buildHandoffSummary failed: ${e}`);
        summary = `🥒 Pickle Rick Loop Active (Iteration ${state.iteration})\nTask: ${state.original_prompt || ''}`;
    }
    console.log(JSON.stringify({
        decision: 'block',
        reason: summary,
    }));
}
main().catch((err) => {
    try {
        const extensionDir = process.env.EXTENSION_DIR || path.join(os.homedir(), '.claude/pickle-rick');
        const debugLog = path.join(extensionDir, 'debug.log');
        fs.appendFileSync(debugLog, `[FATAL] ${err.stack}\n`);
    }
    catch {
        /* ignore */
    }
    // Fails open (allows exit) — correct safe default on fatal error
    process.exit(0);
});
