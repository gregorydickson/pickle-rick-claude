import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractFrontmatter, safeErrorMessage } from '../services/pickle-utils.js';
const emittedRegressionComments = new Set();
function getLinearCommand() {
    const command = process.env.PICKLE_LINEAR_COMMAND?.trim();
    return command ? command : undefined;
}
function splitCommand(command) {
    const tokens = [];
    let current = '';
    let quote = null;
    for (let i = 0; i < command.length; i += 1) {
        const ch = command[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            }
            else if (ch === '\\' && i + 1 < command.length) {
                current += command[++i];
            }
            else {
                current += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        if (ch === '\\' && i + 1 < command.length) {
            current += command[++i];
            continue;
        }
        current += ch;
    }
    if (quote)
        throw new Error('PICKLE_LINEAR_COMMAND has an unterminated quote');
    if (current)
        tokens.push(current);
    const bin = tokens.shift();
    if (!bin)
        throw new Error('PICKLE_LINEAR_COMMAND is empty');
    return { bin, args: tokens };
}
function findTicketPath(sessionDir, ticketId) {
    return path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
}
function readFrontmatterField(body, field) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = body.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : undefined;
}
function readTicketLinearFields(ticketPath, fallbackId) {
    if (!fs.existsSync(ticketPath))
        return null;
    const content = fs.readFileSync(ticketPath, 'utf8');
    const fm = extractFrontmatter(content);
    if (!fm)
        return null;
    return {
        id: readFrontmatterField(fm.body, 'id') ?? fallbackId,
        title: readFrontmatterField(fm.body, 'title') ?? fallbackId,
        status: readFrontmatterField(fm.body, 'status') ?? 'Done',
        linear_issue_id: readFrontmatterField(fm.body, 'linear_issue_id'),
        linear_issue_key: readFrontmatterField(fm.body, 'linear_issue_key'),
        linear_issue_url: readFrontmatterField(fm.body, 'linear_issue_url'),
    };
}
function buildCommentBody(priorTicketId, regressedTicketId, failingTests) {
    const listedFailures = failingTests.slice(0, 10);
    const lines = [
        `Cross-ticket regression detected after ticket ${priorTicketId} landed.`,
        '',
        `Regressed ticket: ${regressedTicketId}`,
        'Failing tests:',
        ...listedFailures.map((failure) => `- ${failure.name}${failure.file ? ` (${failure.file})` : ''}`),
    ];
    if (failingTests.length > listedFailures.length) {
        lines.push(`- ...and ${failingTests.length - listedFailures.length} more`);
    }
    lines.push('', 'Full detail: state.json.last_between_ticket_gate');
    return lines.join('\n');
}
function buildDedupKey(input) {
    return JSON.stringify({
        sessionDir: input.sessionDir,
        priorTicketId: input.priorTicketId,
        regressedTicketId: input.regressedTicketId,
        failingTests: input.failingTests,
    });
}
function callBridge(payload) {
    const command = getLinearCommand();
    if (!command)
        return;
    const invocation = splitCommand(command);
    execFileSync(invocation.bin, invocation.args, {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
    });
}
export function emitCrossTicketRegressionLinearComment(input) {
    const dedupKey = buildDedupKey(input);
    if (emittedRegressionComments.has(dedupKey))
        return;
    const ticketPath = findTicketPath(input.sessionDir, input.priorTicketId);
    const ticket = readTicketLinearFields(ticketPath, input.priorTicketId);
    if (!ticket?.linear_issue_id) {
        input.log(`linear_comment_skipped: no linear_id for ticket ${input.priorTicketId}`);
        return;
    }
    const command = getLinearCommand();
    if (!command)
        return;
    const payload = {
        action: 'commentTicket',
        session: {
            id: path.basename(input.sessionDir),
            dir: input.sessionDir,
        },
        ticket: {
            id: ticket.id,
            title: ticket.title,
            status: ticket.status,
            path: ticketPath,
        },
        issue: {
            id: ticket.linear_issue_id,
            key: ticket.linear_issue_key,
            url: ticket.linear_issue_url,
        },
        comment: {
            body: buildCommentBody(input.priorTicketId, input.regressedTicketId, input.failingTests),
            sessionLogPath: path.join(input.sessionDir, 'state.json'),
        },
    };
    try {
        callBridge(payload);
        emittedRegressionComments.add(dedupKey);
    }
    catch (error) {
        input.log(`linear_comment_failed: ticket ${input.priorTicketId}: ${safeErrorMessage(error)}`);
    }
}
