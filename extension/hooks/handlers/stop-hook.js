import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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
    // Truncate original_prompt in reason to ~500 chars to avoid token waste
    const originalPrompt = state.original_prompt || '';
    const truncatedPrompt = originalPrompt.length > 500
        ? originalPrompt.slice(0, 500) + ' [truncated]'
        : originalPrompt;
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
        console.log(JSON.stringify({
            decision: 'block',
            reason: `${feedback}\n\nOriginal Task: ${truncatedPrompt}`,
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
    let defaultFeedback = `🥒 **Pickle Rick Loop Active** (Iteration ${state.iteration}`;
    if (state.max_iterations > 0)
        defaultFeedback += ` of ${state.max_iterations}`;
    defaultFeedback += ')';
    console.log(JSON.stringify({
        decision: 'block',
        reason: `${defaultFeedback}\n\nOriginal Task: ${truncatedPrompt}`,
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
