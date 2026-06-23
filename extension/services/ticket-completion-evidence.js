/**
 * R-AFCC-DEEP-4A: Unified ticket completion-evidence module.
 *
 * Single conceptual entity for "is this ticket attributably done?".
 * Supersedes the divergent invariants that were split across
 * hasCompletionCommit (pickle-utils), the inlined guardCompletionCommitBeforeDone
 * upsert, and the collapsed phantom-done batch loop.
 *
 * R-AFCC-STAGE: non-repo workingDir is a legitimate state, NOT an exception.
 * R-AFCC-STALE: first-class 'inferred-stale' return variant for stored-but-
 *   unverifiable SHAs (e.g. completion_commit_inferred field present but
 *   gitCommitExists returns false because workingDir is non-repo or commit
 *   was dropped after a branch switch).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFrontmatterField, upsertFrontmatterField, normalizeCompletionCommitField, ticketFilePath, } from './pickle-utils.js';
import { readDeclaredFiles } from './ticket-declared-files.js';
// ---------------------------------------------------------------------------
// Private helpers (inlined from pickle-utils private scope)
// ---------------------------------------------------------------------------
function resolveTicketPath(ctx) {
    if (typeof ctx.ticketPath === 'string' && ctx.ticketPath.length > 0)
        return ctx.ticketPath;
    if (typeof ctx.sessionDir === 'string' && ctx.sessionDir.length > 0 &&
        typeof ctx.ticketId === 'string' && ctx.ticketId.length > 0) {
        return ticketFilePath(ctx.sessionDir, ctx.ticketId);
    }
    return null;
}
/**
 * 3-way git cat-file probe (R-AFCC-DEEP-3C pattern).
 * Returns 'exists' (exit 0), 'not-exists' (exit 1), or 'git-could-not-run'
 * (exit 128, ENOENT, ETIMEDOUT, SIGTERM — git produced no definitive answer).
 */
function probeCatFile(workingDir, sha) {
    try {
        execFileSync('git', ['-C', workingDir, 'cat-file', '-e', `${sha}^{commit}`], {
            timeout: 5000,
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        return 'exists';
    }
    catch (err) {
        const e = err;
        if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM' || e.status === 128 || e.code === 'ENOENT') {
            return 'git-could-not-run';
        }
        return 'not-exists';
    }
}
/** Boolean commit-reachability check; false for both "not found" and "git error". */
function commitExists(workingDir, sha) {
    return probeCatFile(workingDir, sha) === 'exists';
}
function extractRCodeTokens(title) {
    if (!title)
        return [];
    return [...new Set(Array.from(title.matchAll(/\bR-[A-Z0-9-]+\b/gi), m => m[0].toLowerCase()))];
}
function readFirstHeading(content) {
    const m = content.match(/^#\s+(.+)$/m);
    return m?.[1]?.trim() || null;
}
/** R-CXOR-2: true when sha is a session baseline (start_commit or pinned_sha). */
function isBaselineSha(sha, ctx) {
    return (ctx.startCommit != null && sha === ctx.startCommit) ||
        (ctx.pinnedSha != null && sha === ctx.pinnedSha);
}
/**
 * Probes whether an explicit SHA is git-reachable, falling back to fallbackDir on
 * 'git-could-not-run'. Returns the EvidenceResult on success, or null when the
 * SHA is not reachable (caller maps null → absent).
 */
function probeExplicitSha(sha, workingDir, fallbackDir) {
    const primary = probeCatFile(workingDir, sha);
    if (primary === 'exists')
        return { kind: 'explicit', sha };
    if (primary !== 'git-could-not-run')
        return null;
    if (!fallbackDir || fallbackDir === workingDir)
        return null;
    if (probeCatFile(fallbackDir, sha) === 'exists')
        return { kind: 'explicit', sha, usedFallback: true };
    return null;
}
function parseGitLog(raw) {
    return raw
        .split('\n---pickle-commit-boundary---\n')
        .map(e => e.trim())
        .filter(Boolean)
        .map(e => {
        const [sha = '', epochRaw = '0', ...parts] = e.split('\n');
        return { sha: sha.trim(), epoch: Number(epochRaw.trim()) || 0, message: parts.join('\n').trim() };
    })
        .filter(e => /^[0-9a-f]{40}$/i.test(e.sha));
}
/**
 * R-CECB: the files a commit touched, via `git show --name-only`. Best-effort —
 * any git failure yields `[]` (commit not attributable by file-touch).
 */
function commitTouchedFiles(workingDir, sha) {
    try {
        const raw = execFileSync('git', ['-C', workingDir, 'show', '--name-only', '--format=', sha], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return raw.split('\n').map(l => l.trim()).filter(Boolean);
    }
    catch {
        return [];
    }
}
/**
 * True when a git-tracked path in `touched` matches a declared path. `declared`
 * is already `./`-normalized by `readDeclaredFiles`; `git show --name-only` emits
 * repo-relative paths with no `./` prefix, so an exact set membership suffices.
 */
function touchesDeclared(touched, declared) {
    if (declared.length === 0)
        return false;
    const set = new Set(declared);
    return touched.some(t => set.has(t));
}
/**
 * R-CECB: declared in-scope files for every OTHER ticket under `sessionDir`,
 * read directly via `fs` (inlined dir walk; importing `collectTickets` from
 * pickle-utils would create an import cycle — pickle-utils imports this module).
 * Best-effort → `[]`.
 */
function enumerateSiblingDeclaredFiles(sessionDir, selfTicketId) {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        if (selfTicketId && entry.name === selfTicketId)
            continue;
        const subDir = path.join(sessionDir, entry.name);
        let files;
        try {
            files = fs.readdirSync(subDir);
        }
        catch {
            continue;
        }
        for (const file of files) {
            if (!file.startsWith('linear_ticket_') || !file.endsWith('.md'))
                continue;
            try {
                const content = fs.readFileSync(path.join(subDir, file), 'utf8');
                const declared = readDeclaredFiles(content);
                if (declared.length > 0)
                    out.push({ ticketId: entry.name, files: declared });
            }
            catch {
                /* skip unreadable sibling */
            }
        }
    }
    return out;
}
/**
 * R-CECB: declared-file-touch attribution. A post-startTimeEpoch commit attributes
 * to the ticket iff it touches ≥1 declared in-scope file AND it is green. Ref
 * tokens (id/r_code) are CORROBORATING via the existing scan, never required here.
 * Ambiguity (the commit also touches a DIFFERENT ticket's declared files) →
 * attribute to NEITHER. Newest green wins (entries iterate newest-first).
 */
function scanGitLogByFileTouch(entries, args) {
    const startEpoch = Number(args.startTimeEpoch);
    for (const e of entries) {
        if (Number.isFinite(startEpoch) && startEpoch > 0 && e.epoch < startEpoch)
            continue;
        const touched = commitTouchedFiles(args.workingDir, e.sha);
        if (!touchesDeclared(touched, args.declaredFiles))
            continue;
        // Ambiguity: a DIFFERENT ticket also declares one of the touched files.
        const ambiguous = args.siblingDeclared.some(s => touchesDeclared(touched, s.files));
        if (ambiguous)
            continue;
        // Greenness — reuse the salvage GateVerdict oracle (lazy).
        if (args.greenGate() !== 'passing')
            continue;
        return { sha: e.sha };
    }
    return null;
}
function scanGitLog(args) {
    const matchers = [
        ...(args.ticketId ? [args.ticketId.toLowerCase()] : []),
        ...extractRCodeTokens(args.title),
    ];
    const rCodeRe = (() => {
        if (!args.rCode)
            return null;
        const code = args.rCode.trim().toLowerCase();
        if (!code)
            return null;
        const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`);
    })();
    const declaredFiles = args.declaredFiles ?? [];
    // No id/r_code matcher AND no declared-file-touch path → nothing to scan.
    if (matchers.length === 0 && !rCodeRe && declaredFiles.length === 0)
        return null;
    const commands = [];
    if (args.ticketPath) {
        commands.push(['-C', args.workingDir, 'log', '-n', '20', '--format=%H%n%ct%n%B%n---pickle-commit-boundary---', '--', args.ticketPath]);
    }
    commands.push(['-C', args.workingDir, 'log', '-n', '50', '--format=%H%n%ct%n%B%n---pickle-commit-boundary---', 'HEAD']);
    // Pass 1: existing ref-token scan (ticket-id substring + word-boundary r_code).
    // This preserves all current behavior and stays the highest-precedence match.
    // Caches the HEAD pass entries for the Pass-2 file-touch fallback.
    const headEntries = [];
    const refHit = scanGitLogByRefToken(commands, {
        workingDir: args.workingDir,
        matchers,
        rCodeRe,
        startTimeEpoch: args.startTimeEpoch,
        headEntriesOut: headEntries,
    });
    if (refHit)
        return refHit;
    // Pass 2 (R-CECB): declared-file-touch attribution — file-touch primary, ref
    // token corroborating (already tried above), greenness via the salvage gate,
    // ambiguity → neither, newest green wins. Only when the ticket declares files.
    if (declaredFiles.length > 0 && headEntries.length > 0) {
        return scanGitLogByFileTouch(headEntries, {
            workingDir: args.workingDir,
            startTimeEpoch: args.startTimeEpoch,
            declaredFiles,
            siblingDeclared: args.siblingDeclared ?? [],
            greenGate: args.greenGate ?? (() => 'errored'),
        });
    }
    return null;
}
/**
 * Pass 1 of the git-log scan: the existing ref-token attribution (ticket-id
 * substring + word-boundary r_code). Captures the HEAD-pass entries into
 * `headEntriesOut` so the caller can reuse them for the file-touch fallback.
 */
function scanGitLogByRefToken(commands, args) {
    const startEpoch = Number(args.startTimeEpoch);
    const lastCmd = commands[commands.length - 1];
    const checkEntry = (e) => {
        if (Number.isFinite(startEpoch) && startEpoch > 0 && e.epoch < startEpoch)
            return null;
        const lower = e.message.toLowerCase();
        if (args.matchers.some(t => lower.includes(t)))
            return { sha: e.sha };
        if (args.rCodeRe && args.rCodeRe.test(lower))
            return { sha: e.sha };
        return null;
    };
    for (const gitArgs of commands) {
        let parsed;
        try {
            const raw = execFileSync('git', gitArgs, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            parsed = parseGitLog(raw);
        }
        catch {
            continue;
        }
        if (gitArgs === lastCmd)
            args.headEntriesOut.push(...parsed);
        for (const entry of parsed) {
            const matched = checkEntry(entry);
            if (matched)
                return matched;
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// Entry point 1: readEvidence
// ---------------------------------------------------------------------------
/**
 * Reads completion evidence for a ticket and returns a 4-state EvidenceKind.
 *
 * Key differences from legacy hasCompletionCommit:
 *   - 'explicit-reachable' → 'explicit'
 *   - 'inferred' (from field or scan) → 'inferred-fresh'
 *   - NEW 'inferred-stale': completion_commit_inferred field present but
 *     gitCommitExists returned false (R-AFCC-STALE)
 *   - 'unreachable' (explicit SHA present, not git-reachable) → 'absent'
 */
export function readEvidence(ctx) {
    const tPath = resolveTicketPath(ctx);
    if (!tPath)
        return { kind: 'absent' };
    let content;
    try {
        content = fs.readFileSync(tPath, 'utf8');
    }
    catch {
        return { kind: 'absent' };
    }
    // --- Explicit completion_commit field ---
    const explicit = normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit'));
    if (explicit) {
        // R-CXOR-2: reject baseline SHAs — a ticket whose only "commit" is the session
        // start_commit or pinned_sha did no real work; treat it as absent evidence.
        if (isBaselineSha(explicit, ctx)) {
            process.stderr.write(`[ticket-completion-evidence] baseline sha ${explicit} rejected as completion evidence — ticket did no work beyond session start\n`);
            return { kind: 'absent' };
        }
        const r = probeExplicitSha(explicit, ctx.workingDir, ctx.fallbackDir);
        if (r)
            return r;
        // Explicit SHA present but not reachable → no usable evidence.
        return { kind: 'absent' };
    }
    // --- Inferred field (completion_commit_inferred) ---
    const inferredField = normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit_inferred'));
    if (inferredField) {
        if (commitExists(ctx.workingDir, inferredField)) {
            return { kind: 'inferred-fresh', sha: inferredField };
        }
        // R-AFCC-STALE: field present but git can't verify → inferred-stale rather
        // than falling through to scan (which would also fail for the same reason).
        return { kind: 'inferred-stale', sha: inferredField };
    }
    // --- Git log scan (ref token + R-CECB declared-file-touch) ---
    const selfId = readFrontmatterField(content, 'id') ?? ctx.ticketId ?? null;
    const declaredFiles = readDeclaredFiles(content);
    const scan = scanGitLog({
        workingDir: ctx.workingDir,
        ticketId: selfId,
        title: readFrontmatterField(content, 'title') ?? readFirstHeading(content),
        startTimeEpoch: ctx.startTimeEpoch,
        ticketPath: tPath,
        rCode: readFrontmatterField(content, 'r_code'),
        declaredFiles,
        siblingDeclared: ctx.sessionDir ? enumerateSiblingDeclaredFiles(ctx.sessionDir, selfId) : [],
        greenGate: ctx.greenGate,
    });
    if (scan)
        return { kind: 'inferred-fresh', sha: scan.sha };
    return { kind: 'absent' };
}
// ---------------------------------------------------------------------------
// Entry point 2: persistEvidence
// ---------------------------------------------------------------------------
/**
 * Writes sha into the ticket's completion_commit frontmatter field and
 * optionally git-stages the file.
 *
 * R-AFCC-STAGE: stage:'best-effort' means git-staging failure is non-fatal.
 * A non-repo workingDir is a legitimate state and MUST NOT throw.
 */
export function persistEvidence(ctx, sha, opts) {
    const tPath = resolveTicketPath(ctx);
    if (!tPath)
        return { action: 'no_file' };
    let content;
    try {
        content = fs.readFileSync(tPath, 'utf8');
    }
    catch {
        return { action: 'no_file' };
    }
    if (readFrontmatterField(content, 'completion_commit')) {
        return { action: 'already_present', sha: readFrontmatterField(content, 'completion_commit') ?? sha };
    }
    const updated = upsertFrontmatterField(content, 'completion_commit', sha);
    if (!updated)
        return { action: 'unwritable' };
    try {
        fs.writeFileSync(tPath, updated);
    }
    catch {
        return { action: 'unwritable' };
    }
    // Git-stage
    let staged = false;
    try {
        execFileSync('git', ['-C', ctx.workingDir, 'add', '--', tPath], {
            timeout: 5000,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        staged = true;
    }
    catch {
        if (opts.stage === 'required')
            throw new Error(`persistEvidence: git add failed for ${tPath}`);
        // best-effort: staged stays false
    }
    return { action: 'written', sha, staged };
}
// ---------------------------------------------------------------------------
// Entry point 3: gateForPhantomDoneRevert
// ---------------------------------------------------------------------------
/**
 * Decides whether a Done ticket should be reverted (phantom-Done watcher) or
 * kept, and if kept, whether its inferred SHA should be persisted.
 *
 * R-AFCC-STAGE: inferred-stale → action:'keep' (non-repo workingDir is
 * legitimate; a stored SHA exists even if currently unverifiable).
 *
 * Callers do all file writes based on the returned action — this function
 * only reads evidence and returns a decision.
 */
export function gateForPhantomDoneRevert(ctx, _policy) {
    const evidence = readEvidence(ctx);
    switch (evidence.kind) {
        case 'explicit':
            return { action: 'keep', kind: 'explicit', sha: evidence.sha, fallbackFired: evidence.usedFallback };
        case 'inferred-fresh':
            return { action: 'persist-inferred', kind: 'inferred-fresh', sha: evidence.sha };
        case 'inferred-stale':
            // R-AFCC-STAGE: non-repo workingDir is legitimate; keep Done rather than
            // reverting a ticket that has a stored (but currently unverifiable) SHA.
            return { action: 'keep', kind: 'inferred-stale', sha: evidence.sha };
        case 'absent':
            return { action: 'revert', kind: 'absent' };
    }
}
