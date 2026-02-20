#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { printMinimalPanel, getExtensionRoot } from '../services/pickle-utils.js';
function main() {
    const args = process.argv.slice(2);
    let sessionPath = '';
    // Find session path from args or map
    const resumeIndex = args.indexOf('--resume');
    if (resumeIndex !== -1 && args[resumeIndex + 1]) {
        sessionPath = args[resumeIndex + 1];
    }
    if (!sessionPath || !fs.existsSync(sessionPath)) {
        const SESSIONS_MAP = path.join(getExtensionRoot(), 'current_sessions.json');
        if (fs.existsSync(SESSIONS_MAP)) {
            const map = JSON.parse(fs.readFileSync(SESSIONS_MAP, 'utf-8'));
            sessionPath = map[process.cwd()] || '';
        }
    }
    if (!sessionPath || !fs.existsSync(sessionPath)) {
        console.error('Worker Error: No session path found.');
        process.exit(1);
    }
    const stateFile = path.join(sessionPath, 'state.json');
    if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        state.worker = true;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    }
    printMinimalPanel('Morty Worker Initialized', {
        Session: path.basename(sessionPath),
        CWD: process.cwd(),
    }, 'BLUE', '👶');
}
main();
