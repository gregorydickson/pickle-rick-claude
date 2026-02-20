#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { printMinimalPanel, Style, getExtensionRoot } from '../services/pickle-utils.js';
async function runTask(sessionDir, repoCwd, extensionRoot) {
    const statePath = path.join(sessionDir, 'state.json');
    // Re-activate session
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.active = true;
    state.completion_promise = null;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    // Load the pickle.md prompt and substitute --resume
    const picklePromptPath = path.join(os.homedir(), '.claude/commands/pickle.md');
    let prompt = `You are Pickle Rick. Resume the session.\n\nRun:\nnode "$HOME/.claude/pickle-rick/extension/bin/setup.js" --resume ${sessionDir}\n\nThen continue the manager lifecycle from the current phase.`;
    try {
        if (fs.existsSync(picklePromptPath)) {
            prompt = fs.readFileSync(picklePromptPath, 'utf-8').replace(/\$ARGUMENTS/g, `--resume ${sessionDir}`);
        }
    }
    catch { /* use fallback */ }
    // Load max turns from settings
    const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
    let managerMaxTurns = 50;
    try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.default_manager_max_turns) managerMaxTurns = settings.default_manager_max_turns;
    }
    catch { /* ignore */ }
    printMinimalPanel(`Running Jarred Task`, {
        Session: path.basename(sessionDir),
        Repo: repoCwd,
        MaxTurns: managerMaxTurns,
    }, 'MAGENTA', '🥒');
    const cmdArgs = [
        '--dangerously-skip-permissions',
        '--add-dir', sessionDir,
        '--no-session-persistence',
        '--max-turns', String(managerMaxTurns),
        '-p', prompt,
    ];
    const env = {
        ...process.env,
        PICKLE_STATE_FILE: statePath,
    };
    return new Promise((resolve) => {
        const proc = spawn('claude', cmdArgs, {
            cwd: repoCwd,
            env,
            stdio: 'inherit',
        });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', (err) => {
            console.error(`${Style.RED}Failed to spawn claude: ${err.message}${Style.RESET}`);
            resolve(false);
        });
    });
}
async function main() {
    const ROOT_DIR = getExtensionRoot();
    const JAR_ROOT = path.join(ROOT_DIR, 'jar');
    const SESSIONS_ROOT = path.join(ROOT_DIR, 'sessions');
    if (!fs.existsSync(JAR_ROOT)) {
        console.log('🥒 Pickle Jar is empty. No tasks to run.');
        console.log('Signal: Jar Complete');
        return;
    }
    // Collect all marinating tasks across all dates (oldest first)
    const tasks = [];
    for (const day of fs.readdirSync(JAR_ROOT).sort()) {
        const dayPath = path.join(JAR_ROOT, day);
        if (!fs.statSync(dayPath).isDirectory()) continue;
        for (const taskId of fs.readdirSync(dayPath).sort()) {
            const metaPath = path.join(dayPath, taskId, 'meta.json');
            if (!fs.existsSync(metaPath)) continue;
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            if (meta.status === 'marinating') {
                tasks.push({ taskId, metaPath, meta });
            }
        }
    }
    if (tasks.length === 0) {
        console.log('🥒 No marinating tasks in the Jar.');
        console.log('Signal: Jar Complete');
        return;
    }
    console.log(`\n🥒 Pickle Jar Night Shift — ${tasks.length} task(s) queued\n`);
    let succeeded = 0;
    let failed = 0;
    for (const { taskId, metaPath, meta } of tasks) {
        const sessionDir = path.join(SESSIONS_ROOT, taskId);
        if (!fs.existsSync(sessionDir)) {
            console.error(`${Style.RED}⚠️  Session dir not found for ${taskId}${Style.RESET}`);
            meta.status = 'failed';
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
            failed++;
            continue;
        }
        const ok = await runTask(sessionDir, meta.repo_path, ROOT_DIR);
        meta.status = ok ? 'consumed' : 'failed';
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        if (ok) {
            succeeded++;
            console.log(`\n${Style.GREEN}✅ Task ${taskId} complete${Style.RESET}`);
        } else {
            failed++;
            console.log(`\n${Style.RED}❌ Task ${taskId} failed${Style.RESET}`);
        }
    }
    console.log(`\n🥒 Jar complete. ${succeeded} succeeded, ${failed} failed.`);
    console.log('Signal: Jar Complete');
}
main().catch((err) => {
    console.error(`${Style.RED}Error: ${err.message}${Style.RESET}`);
    process.exit(1);
});
