#!/usr/bin/env node
// CLI shim — R-AFCC-DEEP-3A.
// The core 4-line inferred→explicit upsert now lives inline at each runtime
// callsite in mux-runner.ts (guardCompletionCommitBeforeDone, line ~3107) and
// spawn-morty.ts (post-updateTicketFrontmatter belt-and-suspenders, line ~1163).
// This module is preserved for backwards-compat CLI invocations and as the
// target of the path-2 characterization test in
// extension/tests/characterization/completion-commit-cluster/.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFrontmatterField, ticketFilePath, upsertFrontmatterField } from '../services/pickle-utils.js';
import { evaluateCompletionEvidence } from '../services/ticket-completion-evidence.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { writeActivityEntry } from '../services/state-manager.js';
const EMPTY_BASELINE = { startTimeEpoch: null, startCommit: null, pinnedSha: null };
function parseStartEpoch(statePath) {
    if (!statePath)
        return EMPTY_BASELINE;
    try {
        const raw = readRecoverableJsonObject(statePath);
        const parsed = Number(raw?.start_time_epoch);
        return {
            startTimeEpoch: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
            startCommit: typeof raw?.start_commit === 'string' && raw.start_commit ? raw.start_commit : null,
            pinnedSha: typeof raw?.pinned_sha === 'string' && raw.pinned_sha ? raw.pinned_sha : null,
        };
    }
    catch {
        return EMPTY_BASELINE;
    }
}
function targetIds(sessionDir, ticketId) {
    if (ticketId)
        return [ticketId];
    try {
        return fs.readdirSync(sessionDir).filter((entry) => fs.existsSync(path.join(sessionDir, entry, `rick_ticket_${entry}.md`)));
    }
    catch {
        return [];
    }
}
export function autoFillCompletionCommit(input) {
    const { startTimeEpoch, startCommit, pinnedSha } = parseStartEpoch(input.statePath);
    const results = [];
    for (const id of targetIds(input.sessionDir, input.ticketId)) {
        const filePath = ticketFilePath(input.sessionDir, id);
        let content;
        try {
            content = fs.readFileSync(filePath, 'utf8');
        }
        catch {
            results.push({ ticketId: id, sha: null, action: 'unreadable' });
            continue;
        }
        if ((readFrontmatterField(content, 'status') ?? '').toLowerCase() !== 'done') {
            results.push({ ticketId: id, sha: null, action: 'not_done' });
            continue;
        }
        if (readFrontmatterField(content, 'completion_commit')) {
            results.push({ ticketId: id, sha: readFrontmatterField(content, 'completion_commit'), action: 'already_present' });
            continue;
        }
        // R-AFCC-DEEP-4A evidence read, routed through the ONE completion
        // predicate (B-1SEAM WS-1): { decision: 'attribution' } — full ladder
        // minus the R-CWGE done-flip verdict, PLUS the R-CXOR-2 baseline
        // rejection this site never had (start_commit/pinned_sha stamps refuse).
        // Post-hoc CLI is not racing a done-promise flush: rereadBackoffMs 0.
        const decision = evaluateCompletionEvidence({
            sessionDir: input.sessionDir,
            ticketId: id,
            ticketPath: filePath,
            workingDir: input.workingDir,
            startTimeEpoch,
            startCommit,
            pinnedSha,
            decision: 'attribution',
            rereadBackoffMs: 0,
        });
        if (!decision.ok) {
            results.push({ ticketId: id, sha: null, action: 'no_evidence' });
            continue;
        }
        const updated = upsertFrontmatterField(content, 'completion_commit', decision.sha);
        if (!updated) {
            results.push({ ticketId: id, sha: null, action: 'unreadable' });
            continue;
        }
        fs.writeFileSync(filePath, updated);
        execFileSync('git', ['-C', input.workingDir, 'add', '--', filePath], {
            timeout: 5000,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        if (input.statePath) {
            writeActivityEntry(input.statePath, {
                event: 'completion_commit_auto_filled',
                source: 'pickle',
                session: path.basename(input.sessionDir),
                ticket_id: id,
                sha: decision.sha,
                helper: 'auto_fill',
                ts: new Date().toISOString(),
            });
        }
        results.push({ ticketId: id, sha: decision.sha, action: 'filled' });
    }
    return results;
}
function parseCliArgs(argv) {
    const args = new Map();
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || value === undefined)
            continue;
        args.set(key.slice(2), value);
    }
    const sessionDir = args.get('session-dir');
    const workingDir = args.get('working-dir');
    if (!sessionDir || !workingDir) {
        throw new Error('Usage: auto-fill-completion-commit --session-dir <dir> --working-dir <dir> [--ticket-id <id>] [--state-path <path>]');
    }
    return {
        sessionDir,
        workingDir,
        ticketId: args.get('ticket-id') ?? null,
        statePath: args.get('state-path') ?? null,
    };
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    process.stderr.write('[auto-fill-completion-commit] DEPRECATED: runtime callsites now inline the upsert. See R-AFCC-DEEP-3A.\n');
    const result = autoFillCompletionCommit(parseCliArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
