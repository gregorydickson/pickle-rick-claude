import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
async function main() {
    const extensionDir = process.env.EXTENSION_DIR || path.join(os.homedir(), '.claude/pickle-rick');
    const debugLog = path.join(extensionDir, 'debug.log');
    const log = (msg) => {
        const ts = new Date().toISOString();
        try {
            fs.appendFileSync(debugLog, `[${ts}] [ReinforcePersonaJS] ${msg}\n`);
        }
        catch {
            /* ignore */
        }
    };
    // 1. Determine State File
    let stateFile = process.env.PICKLE_STATE_FILE;
    if (!stateFile) {
        const sessionsMapPath = path.join(extensionDir, 'current_sessions.json');
        if (fs.existsSync(sessionsMapPath)) {
            const map = JSON.parse(fs.readFileSync(sessionsMapPath, 'utf8'));
            const sessionPath = map[process.cwd()];
            if (sessionPath)
                stateFile = path.join(sessionPath, 'state.json');
        }
    }
    if (!stateFile || !fs.existsSync(stateFile)) {
        process.exit(0);
        return;
    }
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // 2. Check Context
    if (state.working_dir && path.resolve(state.working_dir) !== path.resolve(process.cwd())) {
        process.exit(0);
        return;
    }
    if (!state.active) {
        process.exit(0);
        return;
    }
    // 3. Reinforce Persona
    // Note: Claude Code has no systemMessage hook output — persona is enforced via CLAUDE.md.
    // This file is kept for reference only; it is not registered as a hook.
    log('Persona active via CLAUDE.md — no hook action needed');
    process.exit(0);
}
main().catch(() => process.exit(0));
