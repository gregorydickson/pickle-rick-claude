import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isoCompactStamp, safeErrorMessage } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { isBackend } from '../services/backend-spawn.js';
import { acquireLockFile, inspectLockFile, isDeadPidPayload, releaseLockFile, stealLockFile, withStealRight, writeActivityEntry, } from '../services/state-manager.js';
import { FOM_EVIDENCE_RULES, FOM_HONEST_REPORTING_RULES } from '../services/fom-blocks.js';
const USAGE = 'Usage: spawn-gate-remediator --gate-result <path> --session-root <path> --reason strict|per-iteration';
const LOCKFILE_NAME = 'remediator.lockfile';
const MAX_FILE_BYTES = 50_000;
const VALID_REASONS = new Set(['strict', 'per-iteration']);
function parseFlag(argv, flag) {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx + 1 >= argv.length)
        return undefined;
    return argv[idx + 1];
}
const VALID_GATE_STATUSES = new Set(['green', 'red', 'green-with-known-flake-warnings']);
const VALID_FAILURE_CHECKS = new Set(['typecheck', 'lint', 'tests']);
const VALID_FAILURE_SEVERITIES = new Set(['error', 'warning']);
export function isGateFailure(v) {
    if (!v || typeof v !== 'object')
        return false;
    const f = v;
    return (typeof f['check'] === 'string' && VALID_FAILURE_CHECKS.has(f['check']) &&
        typeof f['file'] === 'string' &&
        typeof f['line'] === 'number' &&
        typeof f['ruleOrCode'] === 'string' &&
        typeof f['message'] === 'string' &&
        typeof f['severity'] === 'string' && VALID_FAILURE_SEVERITIES.has(f['severity']) &&
        typeof f['occurrence_index'] === 'number');
}
export function isGateResult(v) {
    if (!v || typeof v !== 'object')
        return false;
    const obj = v;
    return (typeof obj['status'] === 'string' && VALID_GATE_STATUSES.has(obj['status']) &&
        Array.isArray(obj['failures']) && obj['failures'].every(isGateFailure) &&
        typeof obj['elapsed_ms'] === 'number');
}
function formatFailuresTable(failures) {
    if (failures.length === 0)
        return '_No failures._\n';
    const rows = failures.map(f => `| ${f.check} | ${f.file} | ${f.line} | ${f.ruleOrCode} | ${f.severity} | ${f.message.replace(/\|/g, '\\|')} |`);
    return [
        '| Check | File | Line | Rule/Code | Severity | Message |',
        '|:------|:-----|-----:|:----------|:---------|:--------|',
        ...rows,
    ].join('\n') + '\n';
}
function buildBriefContent(opts) {
    const { gateResult, sessionRoot, reason, iso, failingFileContents, trapDoorSection } = opts;
    const sections = [];
    sections.push(`# Gate Remediation Brief`);
    sections.push(`\n**Generated**: ${iso}  \n**Session root**: ${sessionRoot}  \n**Reason**: ${reason}  \n**Gate status**: ${gateResult.status}  \n**Failures**: ${gateResult.failures.length}\n`);
    sections.push(`## Section 1: Gate Failures (verbatim)\n`);
    sections.push(formatFailuresTable(gateResult.failures));
    sections.push(`## Section 2: Failing File Contents\n`);
    if (failingFileContents.size === 0) {
        sections.push('_No failing files to display._\n');
    }
    else {
        for (const [filePath, content] of failingFileContents) {
            sections.push(`### \`${filePath}\`\n`);
            if (content === '__UNREADABLE__') {
                sections.push(`_Could not read file (unreadable or not found). Read it fresh before editing._\n`);
            }
            else if (content === '__OVERSIZED__') {
                sections.push(`_File exceeds ${MAX_FILE_BYTES} bytes. Read path directly: \`${filePath}\`_\n`);
            }
            else {
                const ext = path.extname(filePath).slice(1) || 'text';
                sections.push(`\`\`\`${ext}\n${content}\n\`\`\`\n`);
            }
        }
    }
    sections.push(`## Section 3: Relevant CLAUDE.md Trap Doors\n`);
    sections.push(trapDoorSection + '\n');
    sections.push(`## Section 4: Hard Rule and Abort Grammar\n`);
    sections.push(`### Hard Rule

**Fix ONLY the failures listed in Section 1. Do not edit any other lines. Do not change behavior.**

You may ONLY hand-edit for these five failure classes. Anything outside → abort immediately.

- **(a)** Regex character class ranges: \`\\xNN\` → \`\\uNNNN\`. Rule: \`no-control-regex\`. Character escape in range only — no logic changes.
- **(b)** async-generator require-await: \`async function*\` without \`await\` → wrap with typed \`AsyncIterable\` helper per trap-door section (see Section 3). No new behavior.
- **(c)** Unnecessary type assertions: Remove \`as Type\` where TypeScript already infers (\`no-unnecessary-type-assertion\`). Removal only.
- **(d)** Spec-file type-only mock alignment: Fix only for \`TS2741\`, \`TS2345\`, \`TS2352\`, \`TS2739\` where change is purely additive AND a production covering test exists.
- **(e)** CLAUDE.md banned-construct wrap: Restricted to finding id \`banned-construct:brace-free-if\` ONLY. Wrap the cited line's brace-free \`if\` statement in \`{ }\`. Abort on any change touching MORE than the single cited line. Purely syntactic — no semantic refactor. \`nested-ternary\` and \`orphan-*\` are NOT in this class. Snapshot-and-revert still applies: a wrap that reddens a previously-green test is auto-reverted.

### Abort Grammar

Write \`\${SESSION_ROOT}/gate/remediation_aborted_<reason>_<iso>.md\` and exit cleanly when:

- A fix outside classes (a)-(e) is required
- Class (d) fix but no covering test exists → filename: \`remediation_aborted_unverified_production_change_<iso>.md\`
- A fix would require changing behavior
- The brief is missing, malformed, or has no SESSION_ROOT
- The failing-files list is empty
- A concurrent remediator lockfile exists at \`\${SESSION_ROOT}/gate/remediator.lockfile\`

The abort file must contain: reason, affected file:line, what fix was requested, why it was refused.

### Invariants

- Edit ONLY files listed in Section 1's failing-files set. Zero exceptions.
- Do not change indentation, whitespace, or comments outside the failing line(s).
- Do not rename symbols, extract helpers, or reorganize imports.
- Do not run \`pnpm install\`, \`npm install\`, or any package manager mutation.
- Do not write to \`state.json\`, \`microverse.json\`, or any orchestrator-owned file.
- Write your outcome to \`\${SESSION_ROOT}/gate/remediation_<iso>_result.json\` only.
`);
    sections.push(`## Section 5: Evidence & Reporting\n`);
    sections.push(FOM_EVIDENCE_RULES + '\n');
    sections.push(FOM_HONEST_REPORTING_RULES + '\n');
    return sections.join('\n');
}
function resolveInheritedBackend() {
    const envBackend = process.env.PICKLE_BACKEND;
    if (isBackend(envBackend))
        return { backend: envBackend, source: 'env' };
    return { backend: 'claude', source: 'default' };
}
function resolveDeps(opts) {
    return {
        hasInjectedReadFile: typeof opts.readFileFn === 'function',
        readFile: opts.readFileFn ?? ((p, enc) => fs.readFileSync(p, enc)),
        writeFile: opts.writeFileFn ?? ((p, data, enc) => fs.writeFileSync(p, data, enc)),
        mkdirSync: opts.mkdirSyncFn ?? ((p, o) => fs.mkdirSync(p, o)),
    };
}
function parseRemediatorFlags(argv) {
    const gateResultPath = parseFlag(argv, '--gate-result');
    const sessionRoot = parseFlag(argv, '--session-root');
    const reason = parseFlag(argv, '--reason');
    if (!gateResultPath || !sessionRoot || !reason) {
        return { ok: false, error: `Missing required flags.\n${USAGE}` };
    }
    if (!VALID_REASONS.has(reason)) {
        return { ok: false, error: `--reason must be strict|per-iteration, got: ${reason}` };
    }
    return { ok: true, flags: { gateResultPath, sessionRoot, reason } };
}
function loadGateResult(gateResultPath, deps) {
    try {
        const raw = !deps.hasInjectedReadFile
            ? readRecoverableJsonObject(gateResultPath)
            : JSON.parse(deps.readFile(gateResultPath, 'utf-8'));
        if (raw === null) {
            throw new Error('gate-result JSON is missing, malformed, or not an object');
        }
        if (!isGateResult(raw)) {
            return { ok: false, error: `gate-result JSON at ${gateResultPath} is not a valid GateResult` };
        }
        return { ok: true, gateResult: raw };
    }
    catch (e) {
        return { ok: false, error: `Failed to read --gate-result ${gateResultPath}: ${safeErrorMessage(e)}` };
    }
}
function ensureGateDir(gateDir, deps) {
    try {
        deps.mkdirSync(gateDir, { recursive: true });
        return null;
    }
    catch (e) {
        return `Failed to create gate dir ${gateDir}: ${safeErrorMessage(e)}`;
    }
}
/**
 * Reclaim a remediator lock stranded by an abrupt death (SIGKILL/SIGTERM/OOM), which skips the
 * `process.on('exit')` release. Positive proof of death is the ONLY licence to evict: a remediator
 * legitimately holds for minutes (it drives a full worker turn), so the age-based arm `withRetryLock`
 * carries would evict a LIVE holder here. Empty, unparseable and live payloads defer.
 */
function reclaimDeadRemediatorLock(lockfilePath) {
    withStealRight(lockfilePath, () => {
        const snapshot = inspectLockFile(lockfilePath);
        if (!snapshot || !isDeadPidPayload(snapshot.payload))
            return false;
        return stealLockFile(lockfilePath, snapshot);
    });
}
function acquireLockfile(lockfilePath, flags, iso, deps, stdout) {
    try {
        // Payload is the BARE holder pid — the one encoding `isDeadPidPayload` reads. The prior
        // create-then-close published an EMPTY payload, which parses to NaN there, so any steal
        // bolted onto it would have silently never fired.
        let held = acquireLockFile(lockfilePath, String(process.pid));
        if (held === null) {
            reclaimDeadRemediatorLock(lockfilePath);
            held = acquireLockFile(lockfilePath, String(process.pid));
        }
        if (held !== null)
            return { ok: true, held };
        // Still held after a reclaim attempt => a provably LIVE remediator owns it. Defer to it.
        const lockoutPath = path.join(path.dirname(lockfilePath), `remediator_concurrent_lockout_${iso}.md`);
        const lockoutContent = [
            `# Concurrent Remediator Lockout`,
            ``,
            `A live remediator is already running (lockfile held at \`${lockfilePath}\`).`,
            ``,
            `**Timestamp**: ${iso}`,
            `**Session root**: ${flags.sessionRoot}`,
            `**Reason requested**: ${flags.reason}`,
            ``,
            `This invocation exited cleanly without performing any work. The active remediator will complete and release the lock.`,
        ].join('\n');
        try {
            deps.writeFile(lockoutPath, lockoutContent, 'utf-8');
            stdout(`LOCKOUT_PATH=${lockoutPath}`);
        }
        catch { /* best-effort */ }
        return { ok: false, exitCode: 0 };
    }
    catch (e) {
        return { ok: false, exitCode: 1, error: `Failed to acquire lockfile ${lockfilePath}: ${safeErrorMessage(e)}` };
    }
}
function loadFailingFileContents(gateResult, readFile) {
    const failingFiles = [...new Set(gateResult.failures.map(f => f.file))];
    const failingFileContents = new Map();
    for (const filePath of failingFiles) {
        try {
            const raw = readFile(filePath, 'utf-8');
            failingFileContents.set(filePath, raw.length > MAX_FILE_BYTES ? '__OVERSIZED__' : raw);
        }
        catch {
            failingFileContents.set(filePath, '__UNREADABLE__');
        }
    }
    return failingFileContents;
}
function loadTrapDoorSection(extensionClaudeMdContent, readFile) {
    if (extensionClaudeMdContent)
        return extensionClaudeMdContent;
    const claudeMdPath = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'CLAUDE.md');
    try {
        return readFile(claudeMdPath, 'utf-8');
    }
    catch {
        return '_CLAUDE.md trap-door section not available at brief-prep time. Read extension/CLAUDE.md before editing._';
    }
}
function writeBriefFile(gateDir, iso, briefContent, writeFile) {
    const briefFileName = `remediation_${iso}_brief.md`;
    const briefPath = path.join(gateDir, briefFileName);
    writeFile(briefPath, briefContent, 'utf-8');
    return briefPath;
}
export async function spawnGateRemediatorMain(opts) {
    const { argv, isoOverride, extensionClaudeMdContent, stdout = (msg) => process.stdout.write(msg + '\n'), stderr = (msg) => process.stderr.write(msg + '\n'), } = opts;
    const deps = resolveDeps(opts);
    const parsedFlags = parseRemediatorFlags(argv);
    if (!parsedFlags.ok) {
        stderr(parsedFlags.error);
        return 1;
    }
    const { gateResultPath, sessionRoot, reason } = parsedFlags.flags;
    const gateResultLoad = loadGateResult(gateResultPath, deps);
    if (!gateResultLoad.ok) {
        stderr(gateResultLoad.error);
        return 1;
    }
    const iso = isoOverride ?? isoCompactStamp();
    const gateDir = path.join(sessionRoot, 'gate');
    const gateDirError = ensureGateDir(gateDir, deps);
    if (gateDirError) {
        stderr(gateDirError);
        return 1;
    }
    const lockfilePath = path.join(gateDir, LOCKFILE_NAME);
    const lock = acquireLockfile(lockfilePath, { sessionRoot, reason }, iso, deps, stdout);
    if (!lock.ok) {
        if (lock.error)
            stderr(lock.error);
        return lock.exitCode;
    }
    // Release is identity-bound (inode AND payload bytes): a lock we no longer own — ours was reclaimed
    // by a contender after an abrupt death — is left for its new holder, never unlinked out from under it.
    const cleanup = () => {
        try {
            releaseLockFile(lockfilePath, lock.held);
        }
        catch { /* already gone */ }
    };
    process.on('exit', cleanup);
    try {
        const { backend, source } = resolveInheritedBackend();
        try {
            writeActivityEntry(path.join(sessionRoot, 'state.json'), {
                event: 'worker_spawn_backend_resolved',
                ts: new Date().toISOString(),
                backend,
                source,
                pid: process.pid,
                session: path.basename(sessionRoot),
            });
        }
        catch {
            /* best-effort telemetry */
        }
        const failingFileContents = loadFailingFileContents(gateResultLoad.gateResult, deps.readFile);
        const trapDoorSection = loadTrapDoorSection(extensionClaudeMdContent, deps.readFile);
        const briefContent = buildBriefContent({
            gateResult: gateResultLoad.gateResult,
            sessionRoot,
            reason,
            iso,
            failingFileContents,
            trapDoorSection,
        });
        const briefPath = writeBriefFile(gateDir, iso, briefContent, deps.writeFile);
        stdout(`BRIEF_PATH=${briefPath}`);
        return 0;
    }
    catch (e) {
        stderr(`spawn-gate-remediator error: ${safeErrorMessage(e)}`);
        return 1;
    }
    finally {
        cleanup();
        process.off('exit', cleanup);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'spawn-gate-remediator.js') {
    spawnGateRemediatorMain({ argv: process.argv.slice(2) })
        .then(code => process.exit(code))
        .catch(e => {
        process.stderr.write(`spawn-gate-remediator fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(1);
    });
}
