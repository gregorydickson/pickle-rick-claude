#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildJudgeInvocation, resolveBackendFromStateFile } from '../services/backend-spawn.js';
import { isoCompactStamp } from '../services/pickle-utils.js';
import { recoverCourseCorrectionFromLedger } from '../services/transaction-ticket-ops.js';
const MAX_DISCOVERY_LENGTH = 2_000;
const DEFAULT_MODEL = 'sonnet';
const SECTION_HEADING_PATTERN = /^#{2,3}\s+(.+?)\s*$/gm;
const CORRECTOR_SYSTEM_PROMPT = [
    'You are morty-course-corrector.',
    'Use only read-only analysis. Do not edit files, write files, execute shell commands, or mutate session state.',
    'Return proposal markdown only.',
].join(' ');
function usage() {
    process.stderr.write('Usage: node correct-course.js "<discovery>" --session-dir <dir> [--repo-root <dir>] [--dry-run] [--auto-apply] [--force] [--recover-from-ledger] [--recover] [--ledger <path>]\n');
    process.exit(1);
}
export function parseArgs(argv) {
    const sessionDir = readFlag(argv, '--session-dir');
    if (!sessionDir)
        usage();
    const repoRoot = readFlag(argv, '--repo-root') ?? process.cwd();
    const discovery = readDiscovery(argv);
    const recoverFromLedger = argv.includes('--recover-from-ledger');
    const recover = argv.includes('--recover');
    if (!recoverFromLedger && !recover)
        validateDiscovery(discovery);
    return {
        sessionDir: path.resolve(sessionDir),
        repoRoot: path.resolve(repoRoot),
        discovery,
        dryRun: argv.includes('--dry-run'),
        autoApply: argv.includes('--auto-apply'),
        force: argv.includes('--force'),
        recoverFromLedger,
        recover,
        ledgerPath: readFlag(argv, '--ledger'),
    };
}
function readFlag(argv, flag) {
    const index = argv.indexOf(flag);
    if (index < 0)
        return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
        usage();
    return value;
}
function readDiscovery(argv) {
    const values = [];
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value.startsWith('--')) {
            if (flagTakesValue(value))
                index += 1;
            continue;
        }
        values.push(value);
    }
    return values.join(' ').trim();
}
function flagTakesValue(flag) {
    return flag === '--session-dir' || flag === '--repo-root' || flag === '--ledger';
}
export function validateDiscovery(discovery) {
    if (discovery.trim().length === 0) {
        throw new Error('Discovery statement is required.');
    }
    if (discovery.length > MAX_DISCOVERY_LENGTH) {
        throw new Error(`Discovery statement must be ${MAX_DISCOVERY_LENGTH} characters or fewer.`);
    }
}
export function buildCorrectCourseBrief(args, createdAt) {
    validateDiscovery(args.discovery);
    return [
        '# Course Correction Brief',
        '',
        `Generated: ${createdAt.toISOString()}`,
        `Session root: ${args.sessionDir}`,
        `Repository root: ${args.repoRoot}`,
        '',
        '## Discovery Statement',
        '',
        args.discovery,
        '',
        '## Mode Flags',
        '',
        `- dry_run: ${args.dryRun}`,
        `- auto_apply: ${args.autoApply}`,
        `- force: ${args.force}`,
        `- recover_from_ledger: ${args.recoverFromLedger}`,
        `- recover: ${args.recover}`,
        '',
        '## Corrector Contract',
        '',
        '- Read-only analysis only.',
        '- Use the morty-course-corrector agent instructions.',
        '- The corrector produces proposal content only; the manager performs any later apply, ledger, ticket, or state changes.',
        '- Actual worker invocation must use buildJudgeInvocation(backend, ...) so codex runs with `-s read-only` and Claude runs with `--allowedTools Read,Glob,Grep`.',
        '',
        '## Expected Proposal Sections',
        '',
        '1. Discovery Summary',
        '2. Impact Map',
        '3. Artifact Diffs',
        '4. Restart Point',
        '5. Confidence Metadata',
        '',
    ].join('\n');
}
function normalizeHeading(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function readSection(markdown, heading) {
    const matches = [...markdown.matchAll(SECTION_HEADING_PATTERN)];
    const target = normalizeHeading(heading);
    for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        if (normalizeHeading(match[1]) !== target)
            continue;
        const start = match.index === undefined ? 0 : match.index + match[0].length;
        const next = matches[index + 1];
        const end = next?.index ?? markdown.length;
        return markdown.slice(start, end).trim();
    }
    return '';
}
function collectSessionTicketIds(sessionRoot) {
    const ids = new Set();
    if (!fs.existsSync(sessionRoot))
        return ids;
    for (const entry of fs.readdirSync(sessionRoot, { withFileTypes: true })) {
        if (entry.isDirectory())
            ids.add(entry.name);
    }
    return ids;
}
function extractTicketReferences(impactMap) {
    const refs = new Set();
    const patterns = [
        /\bticket(?:_id| id)?\s*[:=]\s*`?([A-Za-z0-9][A-Za-z0-9_-]{2,})`?/gi,
        /\b(?:kept|killed|added|modified|affected|restart)\s*[- ]?ticket\s*[:=]\s*`?([A-Za-z0-9][A-Za-z0-9_-]{2,})`?/gi,
        /`([A-Za-z0-9][A-Za-z0-9_-]{2,})`/g,
    ];
    for (const pattern of patterns) {
        for (const match of impactMap.matchAll(pattern)) {
            refs.add(match[1]);
        }
    }
    return [...refs].sort();
}
function restartPointIsDocumentedNull(restartPoint) {
    return /\bnull\b/i.test(restartPoint) && /\b(reason|because|documented)\b/i.test(restartPoint);
}
export function validateCourseCorrectionProposal(input) {
    const killedSet = new Set(input.killedTicketIds ?? []);
    const currentTicketIds = collectSessionTicketIds(input.sessionRoot);
    const impactMap = readSection(input.proposalContent, 'Impact Map');
    const discoverySummary = readSection(input.proposalContent, 'Discovery Summary');
    const restartPoint = readSection(input.proposalContent, 'Restart Point');
    const referencedTicketIds = extractTicketReferences(impactMap);
    const failures = [];
    if (referencedTicketIds.length === 0) {
        failures.push('impact_map must enumerate at least one ticket');
    }
    const unresolved = referencedTicketIds.filter(ticketId => !currentTicketIds.has(ticketId) && !killedSet.has(ticketId));
    if (unresolved.length > 0) {
        failures.push(`impact_map references unresolved ticket ids: ${unresolved.join(', ')}`);
    }
    const discovery = input.discoveryStatement.trim();
    const hasVerbatimDiscovery = discovery.length > 0 && discoverySummary.includes(discovery);
    const hasDocumentedDerivation = /\b(derived from|derivation|documented derivation)\b/i.test(discoverySummary);
    if (!hasVerbatimDiscovery && !hasDocumentedDerivation) {
        failures.push('discovery_summary must contain the user statement verbatim or document derivation');
    }
    const restartRefs = extractTicketReferences(restartPoint);
    const restartResolves = restartRefs.some(ticketId => currentTicketIds.has(ticketId));
    if (!restartResolves && !restartPointIsDocumentedNull(restartPoint)) {
        failures.push('restart_point must resolve to a current ticket id or null with documented reason');
    }
    return { passed: failures.length === 0, referencedTicketIds, failures };
}
function planCorrectCourse(args, now) {
    const backend = resolveBackendFromStateFile(path.join(args.sessionDir, 'state.json'));
    const briefPath = path.join(args.sessionDir, `change_proposal_${isoCompactStamp(now)}_brief.md`);
    const briefContent = buildCorrectCourseBrief(args, now);
    const invocation = buildJudgeInvocation(backend, {
        prompt: briefContent,
        addDirs: [args.repoRoot, args.sessionDir],
        model: DEFAULT_MODEL,
        systemPrompt: CORRECTOR_SYSTEM_PROMPT,
    });
    return { backend, briefPath, briefContent, invocation };
}
export function runCorrectCourse(input, opts = {}) {
    const now = opts.now ?? (() => new Date());
    const out = opts.stdout ?? ((message) => process.stdout.write(`${message}\n`));
    if (input.recoverFromLedger || input.recover) {
        if (input.recoverFromLedger && input.recover) {
            throw new Error('Choose either --recover-from-ledger or --recover, not both.');
        }
        if (input.recover && !input.force) {
            throw new Error('--recover requires --force.');
        }
        const recovery = recoverCourseCorrectionFromLedger({
            sessionRoot: input.sessionDir,
            ledgerPath: input.ledgerPath,
            mode: input.recoverFromLedger ? 'reverse' : 'forward',
            force: input.force,
            now: now(),
        });
        out(`RECOVERY_LEDGER=${recovery.ledgerPath}`);
        out(`RECOVERY_MODE=${recovery.mode}`);
        out(`RECOVERED_STEPS=${recovery.recoveredSteps.join(',')}`);
        const backend = resolveBackendFromStateFile(path.join(input.sessionDir, 'state.json'));
        return { exitCode: 0, backend, recovery };
    }
    // The plan path resolves the backend once inside planCorrectCourse (via
    // plan.backend); no separate read here keeps state.json a single-read per call.
    const plan = planCorrectCourse(input, now());
    if (input.dryRun) {
        out(JSON.stringify({
            brief_path: plan.briefPath,
            backend: plan.backend,
            invocation: plan.invocation,
            brief: plan.briefContent,
        }, null, 2));
        return { exitCode: 0, briefPath: plan.briefPath, backend: plan.backend, invocation: plan.invocation };
    }
    fs.mkdirSync(path.dirname(plan.briefPath), { recursive: true });
    fs.writeFileSync(plan.briefPath, plan.briefContent, 'utf8');
    out(`BRIEF_PATH=${plan.briefPath}`);
    return { exitCode: 0, briefPath: plan.briefPath, backend: plan.backend, invocation: plan.invocation };
}
export function main(argv = process.argv.slice(2)) {
    try {
        const result = runCorrectCourse(parseArgs(argv));
        process.exitCode = result.exitCode;
    }
    catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'correct-course.js') {
    main();
}
