#!/usr/bin/env node
import { spawn } from 'child_process';
import { existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { safeErrorMessage } from '../services/pickle-utils.js';
const EXTENSION_DIR = process.env.EXTENSION_DIR || join(os.homedir(), '.claude/pickle-rick');
const HANDLERS_DIR = join(EXTENSION_DIR, 'extension', 'hooks', 'handlers');
const LOG_PATH = join(EXTENSION_DIR, 'debug.log');
let activeChild = null;
let watchdogTriggered = false;
// Prevent EPIPE errors from crashing the dispatcher when Claude Code closes the pipe
const handleEpipe = (err) => {
    if (err.code === 'EPIPE')
        process.exit(0);
};
process.stdout.on('error', handleEpipe);
process.stderr.on('error', handleEpipe);
function log(message) {
    try {
        const timestamp = new Date().toISOString();
        appendFileSync(LOG_PATH, `[${timestamp}] [dispatcher] ${message}\n`);
    }
    catch {
        /* ignore */
    }
}
function logError(message) {
    console.error(`Dispatcher Error: ${message}`);
    log(`ERROR: ${message}`);
}
function approve() {
    console.log(JSON.stringify({ decision: 'approve' }));
}
function findExecutable(name) {
    const pathEnv = process.env.PATH || '';
    const paths = pathEnv.split(process.platform === 'win32' ? ';' : ':');
    const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
    for (const p of paths) {
        for (const ext of extensions) {
            const fullPath = join(p, name + ext);
            if (existsSync(fullPath))
                return fullPath;
        }
    }
    return null;
}
function armWatchdog() {
    const WATCHDOG_MS = Number(process.env.PICKLE_DISPATCH_TIMEOUT_MS) || 10_000;
    const watchdog = setTimeout(() => {
        log('Watchdog timeout — approving and exiting');
        watchdogTriggered = true;
        if (activeChild && activeChild.exitCode === null && !activeChild.killed) {
            log('Watchdog timeout — killing hung hook child before exit');
            killHookChild(activeChild, 'SIGKILL');
        }
        approve();
        const exitTimer = setTimeout(() => process.exit(0), 250);
        exitTimer.unref();
    }, WATCHDOG_MS);
    watchdog.unref();
}
function readHookArgs() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        approve();
        process.exit(0);
    }
    const [hookName, ...extraArgs] = args;
    if (hookName.includes('/') || hookName.includes('\\') || hookName.includes('..')) {
        logError(`Invalid hook name (path traversal rejected): ${hookName}`);
        approve();
        process.exit(0);
    }
    log(`Dispatching hook: ${hookName} (cwd: ${process.cwd()})`);
    return { hookName, extraArgs };
}
function resolveHookCommand(hookName, extraArgs) {
    const jsPath = join(HANDLERS_DIR, `${hookName}.js`);
    if (existsSync(jsPath)) {
        return { scriptPath: jsPath, cmd: 'node', cmdArgs: [jsPath, ...extraArgs] };
    }
    if (process.platform === 'win32') {
        const scriptPath = join(HANDLERS_DIR, `${hookName}.ps1`);
        const exe = findExecutable('pwsh') || findExecutable('powershell');
        if (!exe) {
            logError('PowerShell not found.');
            approve();
            process.exit(0);
        }
        return { scriptPath, cmd: exe, cmdArgs: ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extraArgs] };
    }
    const scriptPath = join(HANDLERS_DIR, `${hookName}.sh`);
    return { scriptPath, cmd: 'bash', cmdArgs: [scriptPath, ...extraArgs] };
}
function ensureScriptExists(scriptPath) {
    if (!existsSync(scriptPath)) {
        logError(`Hook script not found: ${scriptPath}`);
        approve();
        process.exit(0);
    }
}
async function readInputData() {
    let inputData = '';
    if (!process.stdin.isTTY) {
        try {
            const chunks = [];
            for await (const chunk of process.stdin) {
                chunks.push(chunk);
            }
            inputData = Buffer.concat(chunks).toString();
            log(`Input received: ${inputData.length} bytes`);
        }
        catch (e) {
            log(`Error reading stdin: ${safeErrorMessage(e)}`);
        }
    }
    return inputData;
}
function writeChildInput(child, inputData) {
    child.stdin?.on('error', (err) => {
        if (err.code === 'EPIPE') {
            killHookChild(child, 'SIGKILL');
            return;
        }
        logError(`Child stdin error: ${safeErrorMessage(err)}`);
    });
    if (inputData) {
        try {
            child.stdin?.write(inputData);
        }
        catch (err) {
            if (err instanceof Error && err.code === 'EPIPE') {
                killHookChild(child, 'SIGKILL');
            }
            else {
                throw err;
            }
        }
    }
    child.stdin?.end();
}
function killHookChild(child, signal) {
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
        try {
            process.kill(-child.pid, signal);
            return;
        }
        catch { /* fall through to direct kill */ }
    }
    try {
        child.kill(signal);
    }
    catch { /* child already gone */ }
}
function parseHandlerDecision(stdout) {
    const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const obj = JSON.parse(lines[i]);
            if (obj.decision === 'approve' || obj.decision === 'block')
                return obj;
        }
        catch { /* not JSON, try previous line */ }
    }
    return null;
}
function handleChildClose(hookName, stdout, stderr, code) {
    if (stderr)
        process.stderr.write(stderr);
    if (stderr.trim())
        log(`Hook ${hookName} stderr: ${stderr.trim()}`);
    if (!stdout.trim()) {
        if (code !== 0 && code !== null) {
            logError(`Hook ${hookName} exited with code ${code} and no output. stderr: ${stderr.trim() || '(none)'}`);
        }
        approve();
        process.exit(code ?? 0);
    }
    const parsed = parseHandlerDecision(stdout);
    if (parsed) {
        console.log(JSON.stringify(parsed));
    }
    else {
        log(`Hook ${hookName} stdout contained no valid decision JSON — falling back to approve`);
        approve();
    }
    process.exit(code ?? 0);
}
function runHookProcess(hookName, command, inputData) {
    try {
        const child = spawn(command.cmd, command.cmdArgs, {
            detached: process.platform !== 'win32',
            env: { ...process.env, EXTENSION_DIR },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        activeChild = child;
        let stdout = '';
        let stderr = '';
        writeChildInput(child, inputData);
        child.stdout?.on('data', (data) => (stdout += data.toString()));
        child.stderr?.on('data', (data) => (stderr += data.toString()));
        child.on('close', (code) => {
            activeChild = null;
            if (watchdogTriggered)
                return;
            handleChildClose(hookName, stdout, stderr, code);
        });
        child.on('error', (err) => {
            activeChild = null;
            logError(`Failed to start child process: ${safeErrorMessage(err)}`);
            approve();
            process.exit(0);
        });
    }
    catch (e) {
        logError(`Unexpected execution error: ${safeErrorMessage(e)}`);
        approve();
        process.exit(0);
    }
}
async function main() {
    // Watchdog: if the hook hangs for any reason, approve and exit.
    // This prevents Claude Code from deadlocking on a stuck handler.
    armWatchdog();
    const hookArgs = readHookArgs();
    const command = resolveHookCommand(hookArgs.hookName, hookArgs.extraArgs);
    ensureScriptExists(command.scriptPath);
    const inputData = await readInputData();
    runHookProcess(hookArgs.hookName, command, inputData);
}
main().catch((err) => {
    try {
        log(`FATAL: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    }
    catch { /* ignore */ }
    approve();
    process.exit(0);
});
