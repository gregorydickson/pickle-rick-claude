import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveExtensionDir } from '../services/forward-ref-annotation.js';
const MANIFEST_SCHEMA_VERSION = 1;
const TICKET_HASH_RE = /^[0-9a-f]{8}$/;
const SHA_TOKEN_RE = /\b[0-9a-f]{7,40}\b/g;
const VERSION_TOKEN_RE = /\bv?(\d+\.\d+\.\d+)\b/g;
const PATH_BACKTICK_RE = /`([^`\n]+)`/g;
const PATH_LIKELY_RE = /^(?:extension|src|tests|prds|scripts|services|hooks|bin|types|\.claude)\//;
const PATH_HAS_EXT_RE = /\/[^\s/]+\.[a-zA-Z][a-zA-Z0-9]+$/;
const DISPOSITION_FILE_REL = path.join('src', 'data', 'bundle-disposition-2026-05-04.json');
const DISPOSITION_FILE_REL_2 = path.join('src', 'data', 'bundle-disposition-2026-05-07-deferred-slots.json');
const DISPOSITION_FILE_REL_3 = path.join('src', 'data', 'bundle-disposition-2026-05-08-mega.json');
const EXEMPT_DISPOSITIONS = new Set(['REGRESSION-TEST-ONLY', 'DROP', 'IMPLEMENT-but-no-source-PRD-for-K-L', 'DIAGNOSE']);
function readFileOrNull(p) {
    try {
        return fs.readFileSync(p, 'utf-8');
    }
    catch {
        return null;
    }
}
function readJsonOrNull(p) {
    const raw = readFileOrNull(p);
    if (raw === null)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function splitFrontmatter(raw) {
    if (!raw.startsWith('---\n'))
        return null;
    const end = raw.indexOf('\n---\n', 4);
    if (end === -1)
        return null;
    return { frontmatter: raw.slice(4, end), body: raw.slice(end + 5) };
}
function frontmatterValue(frontmatter, key) {
    const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
    const m = re.exec(frontmatter);
    if (!m)
        return '';
    return m[1].trim().replace(/^["']|["']$/g, '');
}
function parseMappedRequirements(frontmatter) {
    const raw = frontmatterValue(frontmatter, 'mapped_requirements');
    if (raw.length > 0) {
        const inner = raw.replace(/^\[|\]$/g, '');
        return inner
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    }
    // YAML block-list form: mapped_requirements:\n  - AC-X\n  - AC-Y
    const lines = frontmatter.split('\n');
    const keyIdx = lines.findIndex((l) => /^mapped_requirements:\s*$/.test(l));
    if (keyIdx === -1)
        return [];
    const items = [];
    for (let i = keyIdx + 1; i < lines.length; i++) {
        const m = /^\s+-\s+(.+)$/.exec(lines[i]);
        if (!m)
            break;
        items.push(m[1].trim());
    }
    return items;
}
function extractSection(body, heading) {
    const lines = body.split('\n');
    const startIdx = lines.findIndex((l) => l.trim() === heading);
    if (startIdx === -1)
        return '';
    const out = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
        if (/^#{1,6}\s/.test(lines[i]))
            break;
        out.push(lines[i]);
    }
    return out.join('\n');
}
function extractDependenciesLine(body) {
    const re = /^\*\*Dependencies\*\*:\s*(.*)$/m;
    const m = re.exec(body);
    return m ? m[1] : '';
}
function parseTicket(filePath, sessionDir) {
    const raw = readFileOrNull(filePath);
    if (raw === null)
        return null;
    const split = splitFrontmatter(raw);
    if (split === null)
        return null;
    const id = frontmatterValue(split.frontmatter, 'id');
    if (!TICKET_HASH_RE.test(id))
        return null;
    return {
        id,
        title: frontmatterValue(split.frontmatter, 'title'),
        filePath,
        relPath: path.relative(sessionDir, filePath),
        mappedRequirements: parseMappedRequirements(split.frontmatter),
        body: split.body,
        problemSection: extractSection(split.body, '## Problem'),
        dependenciesLine: extractDependenciesLine(split.body),
    };
}
function loadDispositions(scriptDir) {
    // WS3 (#120 R-ATPR): extension-relative resolution comes ONLY from the shared resolver.
    const ext = resolveExtensionDir(scriptDir);
    if (ext === null)
        return { table: {}, loaded: false };
    const data1 = readJsonOrNull(path.join(ext, DISPOSITION_FILE_REL));
    const data2 = readJsonOrNull(path.join(ext, DISPOSITION_FILE_REL_2));
    const data3 = readJsonOrNull(path.join(ext, DISPOSITION_FILE_REL_3));
    if (data1 === null && data2 === null && data3 === null)
        return { table: {}, loaded: false };
    const merged = {};
    if (data1 !== null && typeof data1 === 'object')
        Object.assign(merged, data1);
    if (data2 !== null && typeof data2 === 'object')
        Object.assign(merged, data2);
    if (data3 !== null && typeof data3 === 'object')
        Object.assign(merged, data3);
    return { table: merged, loaded: true };
}
function gitListFiles(workingDir) {
    const res = spawnSync('git', ['ls-files'], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0)
        return new Set();
    return new Set(res.stdout.split('\n').filter((l) => l.length > 0));
}
function gitVerifySha(sha, workingDir) {
    const res = spawnSync('git', ['cat-file', '-e', sha], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 5_000,
    });
    return res.status === 0;
}
function gitIsAncestor(ancestor, descendant, workingDir) {
    const res = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 5_000,
    });
    return res.status === 0;
}
function looksLikePath(token) {
    if (token.length < 3 || token.length > 200)
        return false;
    if (/\s/.test(token))
        return false;
    return PATH_LIKELY_RE.test(token) || PATH_HAS_EXT_RE.test(token);
}
function extractBacktickedPaths(text) {
    const out = [];
    let m;
    PATH_BACKTICK_RE.lastIndex = 0;
    while ((m = PATH_BACKTICK_RE.exec(text)) !== null) {
        const tok = m[1].trim();
        if (looksLikePath(tok))
            out.push(tok);
    }
    return out;
}
function extractFencedPaths(text) {
    const out = [];
    const fenceRe = /^```[^\n]*\n([\s\S]*?)^```/gm;
    let m;
    fenceRe.lastIndex = 0;
    while ((m = fenceRe.exec(text)) !== null) {
        for (const word of m[1].split(/\s+/)) {
            const tok = word.replace(/^["'([]+|["'\]);,]+$/g, '');
            if (looksLikePath(tok))
                out.push(tok);
        }
    }
    return [...new Set(out)];
}
export function detectCrossDocNamingDrift(ticketPaths, workingDir) {
    if (ticketPaths.length === 0)
        return [];
    const basenameMap = new Map();
    for (const p of ticketPaths) {
        const base = path.basename(p);
        let s = basenameMap.get(base);
        if (!s) {
            s = new Set();
            basenameMap.set(base, s);
        }
        s.add(p);
    }
    const knownBasenames = new Set(basenameMap.keys());
    // Doc-side extraction: accept standard path tokens AND bare filenames that
    // match a known basename (e.g. `pickle_settings.json` alongside the ticket's
    // `extension/pickle_settings.json`).
    function extractDocTokens(text) {
        const out = [];
        const btRe = /`([^`\n]+)`/g;
        let m;
        btRe.lastIndex = 0;
        while ((m = btRe.exec(text)) !== null) {
            const tok = m[1].trim();
            if (tok.length >= 3 && !/\s/.test(tok) &&
                (looksLikePath(tok) || knownBasenames.has(path.basename(tok)))) {
                out.push(tok);
            }
        }
        const fenceRe = /^```[^\n]*\n([\s\S]*?)^```/gm;
        fenceRe.lastIndex = 0;
        while ((m = fenceRe.exec(text)) !== null) {
            for (const word of m[1].split(/\s+/)) {
                const tok = word.replace(/^["'([]+|["'\]);,]+$/g, '');
                if (tok.length >= 3 && !/\s/.test(tok) &&
                    (looksLikePath(tok) || knownBasenames.has(path.basename(tok)))) {
                    out.push(tok);
                }
            }
        }
        return [...new Set(out)];
    }
    const res = spawnSync('git', ['ls-files'], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
    });
    const mdFiles = res.status === 0
        ? res.stdout.split('\n').filter((l) => l.endsWith('.md'))
        : [];
    const drifts = [];
    const seen = new Set();
    // AC-ATBG-2: cap to one finding per ticketPath — first doc-pair wins
    const seenTicketPaths = new Set();
    for (const mdFile of mdFiles) {
        const content = readFileOrNull(path.join(workingDir, mdFile));
        if (content === null)
            continue;
        for (const docPath of extractDocTokens(content)) {
            const base = path.basename(docPath);
            const variants = basenameMap.get(base);
            if (!variants)
                continue;
            for (const ticketPath of variants) {
                if (ticketPath === docPath)
                    continue;
                const key = `${ticketPath}|${mdFile}|${docPath}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                if (seenTicketPaths.has(ticketPath))
                    continue;
                seenTicketPaths.add(ticketPath);
                drifts.push({ ticketPath, docFile: mdFile, docPath });
            }
        }
    }
    return drifts;
}
export function checkPathDrift(t, gitFiles) {
    const findings = [];
    const seen = new Set();
    // Pre-convert for suffix-match (R-RTRC-4 parity); built once, not per token.
    const gitFilesArr = Array.from(gitFiles);
    for (const tok of extractBacktickedPaths(t.body)) {
        if (seen.has(tok))
            continue;
        seen.add(tok);
        if (tok.endsWith('/'))
            continue; // bare directory — git ls-files lists files not dirs
        if (tok.includes('*'))
            continue; // glob — no literal * path exists
        // Strip trailing :<line>[,<line>][-<line>] suffix (mirrors R-RTRC-4).
        const stripped = tok.replace(/:\d[\d,-]*$/, '');
        const escapedStripped = stripped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const suffixRe = new RegExp(`(?:^|/)${escapedStripped}$`);
        if (gitFiles.has(stripped) || gitFilesArr.some((f) => suffixRe.test(f)))
            continue;
        findings.push({
            ticket_id: t.id,
            ticket_path: t.relPath,
            defect_class: 'path-drift',
            severity: 'fatal',
            evidence: `cited path \`${tok}\` not found in git ls-files`,
            remediation_hint: 'verify the cited path resolves at HEAD',
        });
    }
    return findings;
}
function checkSelfReference(t) {
    const re = new RegExp(`\`[^\`]*${t.id}[^\`]*\``, 'g');
    const hits = t.body.match(re) ?? [];
    const offending = hits.filter((h) => !h.includes(`linear_ticket_${t.id}.md`));
    if (offending.length === 0)
        return [];
    return [
        {
            ticket_id: t.id,
            ticket_path: t.relPath,
            defect_class: 'self-reference',
            severity: 'warning',
            evidence: `body cites own hash in: ${offending.slice(0, 3).join(', ')}`,
            remediation_hint: 'remove self-reference or rephrase without ticket hash',
        },
    ];
}
function extractTicketHashes(text) {
    const tokens = text.match(/\b[0-9a-f]{8}\b/g) ?? [];
    return [...new Set(tokens)];
}
function checkMissingDeps(t, knownHashes) {
    if (t.dependenciesLine.length === 0)
        return [];
    const hashes = extractTicketHashes(t.dependenciesLine);
    const findings = [];
    for (const h of hashes) {
        if (h === t.id)
            continue;
        if (knownHashes.has(h))
            continue;
        findings.push({
            ticket_id: t.id,
            ticket_path: t.relPath,
            defect_class: 'missing-deps',
            severity: 'fatal',
            evidence: `Dependencies cite unknown ticket hash \`${h}\``,
            remediation_hint: 'remove dep or add the missing ticket to the bundle',
        });
    }
    return findings;
}
function isPlausibleSha(token) {
    if (TICKET_HASH_RE.test(token))
        return false;
    return token.length >= 7 && token.length <= 40 && /^[0-9a-f]+$/.test(token);
}
function extractCandidateShas(t, knownHashes) {
    const tokens = t.body.match(SHA_TOKEN_RE) ?? [];
    const filtered = tokens.filter((tok) => !knownHashes.has(tok) && isPlausibleSha(tok));
    return [...new Set(filtered)];
}
function checkWrongHead(t, ctx) {
    if (ctx.startCommit === null)
        return [];
    const findings = [];
    const candidates = extractCandidateShas(t, ctx.knownTicketHashes);
    for (const sha of candidates) {
        if (!gitVerifySha(sha, ctx.workingDir))
            continue;
        if (gitIsAncestor(sha, ctx.startCommit, ctx.workingDir))
            continue;
        if (sha === ctx.startCommit)
            continue;
        findings.push({
            ticket_id: t.id,
            ticket_path: t.relPath,
            defect_class: 'wrong-HEAD-assumptions',
            severity: 'warning',
            evidence: `cited commit \`${sha}\` is not an ancestor of start_commit \`${ctx.startCommit.slice(0, 12)}\``,
            remediation_hint: 'rebase the ticket reference onto the bundle start_commit or strike the SHA citation',
        });
    }
    return findings;
}
function checkCrossDocNaming(t) {
    const findings = [];
    const dirHash = path.basename(path.dirname(t.filePath));
    if (dirHash !== t.id) {
        findings.push({
            ticket_id: t.id,
            ticket_path: t.relPath,
            defect_class: 'cross-doc-naming',
            severity: 'fatal',
            evidence: `frontmatter id \`${t.id}\` does not match containing dir \`${dirHash}\``,
            remediation_hint: 'rename ticket dir or fix frontmatter id',
        });
    }
    if (t.mappedRequirements.length === 0)
        return findings;
    const titleHasReq = t.mappedRequirements.some((req) => t.title.includes(req));
    if (!titleHasReq) {
        findings.push({
            ticket_id: t.id,
            ticket_path: t.relPath,
            defect_class: 'cross-doc-naming',
            severity: 'info',
            evidence: `title \`${t.title}\` mentions none of mapped_requirements ${JSON.stringify(t.mappedRequirements)}`,
            remediation_hint: 'optionally reflect the requirement ID in the title for cross-doc traceability',
        });
    }
    return findings;
}
function isExemptFromHallucinatedPremise(t, dispositions) {
    if (t.mappedRequirements.length === 0)
        return false;
    return t.mappedRequirements.every((req) => {
        const d = dispositions[req];
        if (typeof d !== 'string')
            return false;
        const head = d.split(/\s+/)[0];
        return EXEMPT_DISPOSITIONS.has(head);
    });
}
function checkHallucinatedPremise(t, ctx) {
    if (ctx.dispositionsLoaded && isExemptFromHallucinatedPremise(t, ctx.dispositions))
        return [];
    const findings = [];
    const seen = new Set();
    // Pre-convert for suffix-match (R-RTRC-4 parity with checkPathDrift); built once, not per token.
    const gitFilesArr = Array.from(ctx.gitFiles);
    for (const tok of extractBacktickedPaths(t.problemSection)) {
        if (seen.has(tok))
            continue;
        seen.add(tok);
        // Mirror the R-RTRC-4 suffix-symmetric resolution from checkPathDrift:
        // strip trailing :<line>[,<line>] suffix, then test exact AND suffix-pattern match.
        const stripped = tok.replace(/:\d[\d,-]*$/, '');
        const escapedStripped = stripped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const suffixRe = new RegExp(`(?:^|/)${escapedStripped}$`);
        if (ctx.gitFiles.has(stripped) || gitFilesArr.some((f) => suffixRe.test(f)))
            continue;
        findings.push({
            ticket_id: t.id,
            ticket_path: t.relPath,
            defect_class: 'hallucinated-premise',
            severity: 'fatal',
            evidence: `Problem section cites nonexistent code path \`${tok}\``,
            remediation_hint: 'rewrite premise against a real path, or add disposition exemption',
        });
    }
    return findings;
}
function extractVersions(text) {
    const out = [];
    let m;
    VERSION_TOKEN_RE.lastIndex = 0;
    while ((m = VERSION_TOKEN_RE.exec(text)) !== null) {
        out.push(m[1]);
    }
    return [...new Set(out)];
}
function checkLiteralValueDrift(t, packageVersion) {
    if (packageVersion === null)
        return [];
    const versions = extractVersions(t.body);
    const drift = versions.filter((v) => v !== packageVersion);
    if (drift.length === 0)
        return [];
    return [
        {
            ticket_id: t.id,
            ticket_path: t.relPath,
            defect_class: 'literal-value-drift',
            severity: 'info',
            evidence: `version literal(s) ${JSON.stringify(drift)} differ from package.json version \`${packageVersion}\``,
            remediation_hint: 'update cited version or confirm the literal references a different artifact',
        },
    ];
}
function checkCrossDocNamingDrift(t, ctx) {
    const ticketPaths = [...extractBacktickedPaths(t.body), ...extractFencedPaths(t.body)];
    const drifts = detectCrossDocNamingDrift(ticketPaths, ctx.workingDir);
    return drifts.map(({ ticketPath, docFile, docPath }) => ({
        ticket_id: t.id,
        ticket_path: t.relPath,
        defect_class: 'cross-doc-naming-drift',
        severity: 'info',
        evidence: `ticket cites \`${ticketPath}\` but \`${docFile}\` uses \`${docPath}\` (same basename, path differs)`,
        remediation_hint: 'align path references across documents to the canonical full path',
    }));
}
// R-TAQ-4 / AC-TAQ-04-3 — decomposition agents must append a single-line
// `<!-- audit: 7-class checked YYYY-MM-DD -->` comment to each ticket body.
// Missing or malformed comment emits a `missing-audit-comment` info finding.
const AUDIT_COMMENT_RE = /<!--\s*audit:\s*7-class\s+checked\s+\d{4}-\d{2}-\d{2}\s*-->/;
export function checkMissingAuditComment(t) {
    if (AUDIT_COMMENT_RE.test(t.body))
        return [];
    return [
        {
            ticket_id: t.id,
            ticket_path: t.relPath,
            defect_class: 'missing-audit-comment',
            severity: 'info',
            evidence: 'ticket body missing `<!-- audit: 7-class checked YYYY-MM-DD -->` (R-TAQ-4)',
            remediation_hint: 'append `<!-- audit: 7-class checked YYYY-MM-DD -->` after the body completes',
        },
    ];
}
function auditTicket(t, ctx) {
    return [
        ...checkPathDrift(t, ctx.gitFiles),
        ...checkSelfReference(t),
        ...checkMissingDeps(t, ctx.knownTicketHashes),
        ...checkWrongHead(t, ctx),
        ...checkCrossDocNaming(t),
        ...checkCrossDocNamingDrift(t, ctx),
        ...checkHallucinatedPremise(t, ctx),
        ...checkLiteralValueDrift(t, ctx.packageVersion),
        ...checkMissingAuditComment(t),
    ];
}
function listTicketDirs(sessionDir) {
    let entries;
    try {
        entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot read session dir: ${msg}`);
    }
    return entries
        .filter((e) => e.isDirectory() && TICKET_HASH_RE.test(e.name))
        .map((e) => e.name)
        .sort();
}
function loadSessionState(sessionDir) {
    const state = readJsonOrNull(path.join(sessionDir, 'state.json'));
    return {
        workingDir: state?.working_dir ?? process.cwd(),
        startCommit: typeof state?.start_commit === 'string' && state.start_commit.length > 0
            ? state.start_commit
            : null,
    };
}
function loadPackageVersion(workingDir) {
    const pkg = readJsonOrNull(path.join(workingDir, 'extension', 'package.json'));
    return typeof pkg?.version === 'string' ? pkg.version : null;
}
function buildContext(sessionDir, scriptDir) {
    const { workingDir, startCommit } = loadSessionState(sessionDir);
    const ticketDirs = listTicketDirs(sessionDir);
    const { table, loaded } = loadDispositions(scriptDir);
    if (!loaded) {
        process.stderr.write(`[audit-ticket-bundle] WARN: no disposition tables found at ${DISPOSITION_FILE_REL} or ${DISPOSITION_FILE_REL_2}; running without exemption\n`);
    }
    return {
        sessionDir,
        workingDir,
        startCommit,
        gitFiles: gitListFiles(workingDir),
        packageVersion: loadPackageVersion(workingDir),
        knownTicketHashes: new Set(ticketDirs),
        dispositions: table,
        dispositionsLoaded: loaded,
    };
}
function findTicketFiles(sessionDir, ticketDirs) {
    const out = [];
    for (const dir of ticketDirs) {
        const file = path.join(sessionDir, dir, `linear_ticket_${dir}.md`);
        if (fs.existsSync(file))
            out.push(file);
    }
    return out;
}
export function auditSession(sessionDir, scriptDir) {
    const absSession = path.resolve(sessionDir);
    const ctx = buildContext(absSession, scriptDir);
    const ticketDirs = [...ctx.knownTicketHashes].sort();
    const files = findTicketFiles(absSession, ticketDirs);
    const parsed = files.map((f) => parseTicket(f, absSession)).filter((t) => t !== null);
    const findings = [];
    for (const t of parsed) {
        findings.push(...auditTicket(t, ctx));
    }
    const exit_code = findings.some((f) => f.severity === 'fatal' || f.severity === 'warning') ? 1 : 0;
    return {
        schema_version: MANIFEST_SCHEMA_VERSION,
        session_hash: path.basename(absSession),
        audited_at: new Date().toISOString(),
        ticket_count: files.length,
        findings,
        exit_code,
    };
}
function writeManifest(manifest, target) {
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
    fs.renameSync(tmp, target);
}
function usage() {
    process.stdout.write('Usage: audit-ticket-bundle.js <session-dir> [--manifest <path>]\n\n' +
        'Walks <session>/<hash>/linear_ticket_<hash>.md files and runs 9 defect-class checks:\n' +
        '  path-drift, self-reference, missing-deps, wrong-HEAD-assumptions,\n' +
        '  cross-doc-naming, cross-doc-naming-drift, hallucinated-premise, literal-value-drift,\n' +
        '  missing-audit-comment.\n\n' +
        'Reads R-BUNDLE-DISPO disposition tables (bundle-disposition-2026-05-04.json,\n' +
        'bundle-disposition-2026-05-07-deferred-slots.json, and bundle-disposition-2026-05-08-mega.json)\n' +
        'from extension/src/data/ and merges them (later files win on key collision).\n' +
        'Tickets whose mapped_requirements are all REGRESSION-TEST-ONLY, DROP,\n' +
        'IMPLEMENT-but-no-source-PRD-for-K-L, or DIAGNOSE are EXEMPT from the hallucinated-premise check.\n\n' +
        'Writes manifest to <session-dir>/audit-ticket-bundle.json (R-TAQ-2b schema v1).\n\n' +
        'Exit codes:\n' +
        '  0  No findings\n' +
        '  1  Findings present\n' +
        '  2  Operational error\n');
}
function parseArgs(argv) {
    let sessionDir = null;
    let manifestPath = null;
    let help = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h')
            help = true;
        else if (a === '--manifest') {
            manifestPath = argv[i + 1] ?? null;
            i += 1;
        }
        else if (!a.startsWith('--') && sessionDir === null) {
            sessionDir = a;
        }
    }
    return { sessionDir, manifestPath, help };
}
function printSummary(manifest, manifestPath) {
    process.stdout.write(`[audit-ticket-bundle] tickets=${manifest.ticket_count} findings=${manifest.findings.length} exit=${manifest.exit_code}\n`);
    const blocking = manifest.findings.filter((f) => f.severity === 'fatal' || f.severity === 'warning');
    const info = manifest.findings.filter((f) => f.severity === 'info');
    // AC-ATBG-2: always print every blocking finding first regardless of info volume
    for (const f of blocking) {
        process.stdout.write(`  ${f.severity.padEnd(7)} ${f.defect_class.padEnd(24)} ${f.ticket_id} — ${f.evidence}\n`);
    }
    for (const f of info.slice(0, 50)) {
        process.stdout.write(`  ${f.severity.padEnd(7)} ${f.defect_class.padEnd(24)} ${f.ticket_id} — ${f.evidence}\n`);
    }
    if (info.length > 50) {
        process.stdout.write(`  ... (${info.length - 50} more info findings; see ${manifestPath})\n`);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'audit-ticket-bundle.js') {
    const { sessionDir, manifestPath, help } = parseArgs(process.argv.slice(2));
    if (help || (sessionDir === null && process.argv.length <= 2)) {
        usage();
        process.exit(0);
    }
    if (sessionDir === null) {
        process.stderr.write('Error: session-dir is required\n');
        usage();
        process.exit(2);
    }
    try {
        const scriptDir = path.dirname(fileURLToPath(import.meta.url));
        const manifest = auditSession(sessionDir, scriptDir);
        const target = manifestPath ?? path.join(path.resolve(sessionDir), 'audit-ticket-bundle.json');
        writeManifest(manifest, target);
        printSummary(manifest, target);
        process.exit(manifest.exit_code);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${msg}\n`);
        process.exit(2);
    }
}
